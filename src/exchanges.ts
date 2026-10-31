// The exchange log: one entry per request, the request and its response together.
//
// An exchange is the one shape the request log, the panel and later the recordings
// all read, so it is kept whole — what the client asked for, what went back, which
// rule decided it and how long it took. Bodies are kept in the form that is
// easiest to work with afterwards: JSON stays an object so a script can edit it,
// text stays text, anything else is base64, and past a cap the entry says it was
// truncated.
//
// Entries live in a ring buffer sized by `max_requests_history` and are appended
// to `state/requests.jsonl` by a queue of writes of their own, one at a time, so
// answering a device's traffic never waits for the disk. On start the tail of
// that file is read back, which is how `seq` keeps counting where the last run
// left off.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { appendFile, writeFile } from 'node:fs/promises'
import type { TunnelConfigManager } from './config.ts'
import { ValidationError, reasonOf } from './errors.ts'
import { matchGlob } from './glob.ts'
import { isJsonObject, parseJson, stringifySpaced, type JsonValue } from './json.ts'
import { getLogger } from './log.ts'
import { effectivePort, requestUrl, type Request, type Response } from './messages.ts'
import { keyMatches, parseKey } from './rule-keys.ts'
import {
  anyValue,
  bool,
  check,
  dictOf,
  int,
  make,
  model,
  nullable,
  oneOf,
  str,
  withDefault,
} from './validate.ts'

const log = getLogger('exchanges')

/** Past this much, a body is cut and the entry says so. Two megabytes is far more
 *  than any API response worth reading and far less than a video download, which
 *  is the thing that would otherwise fill the log. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024

/** The response headers that described the bytes on the wire rather than the
 *  body: it has been decompressed by the time we see it, and its length and
 *  framing are decided again by whoever sends it on. */
export const DROPPED_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  'content-length',
  'content-encoding',
  'transfer-encoding',
])

export const EXCHANGE_KINDS = ['http', 'connect'] as const
export type ExchangeKind = (typeof EXCHANGE_KINDS)[number]
export const BODY_ENCODINGS = ['json', 'text', 'base64'] as const
export type BodyEncoding = (typeof BODY_ENCODINGS)[number]

export const REDACTED = '[REDACTED]'

// ---------------------------------------------------------------- bodies

/** What encodeBody gives: the body as it is stored, its encoding, and whether it was cut */
export interface EncodedBody {
  body: JsonValue // json: the value parsed; text: the string; base64: the base64; no body: null
  body_encoding: BodyEncoding | null
  truncated: boolean
}

/** Strict UTF-8: a byte that is not UTF-8, a character cut in two, a surrogate written as UTF-8
 *  (CESU-8) or an overlong form throws rather than becoming U+FFFD. ignoreBOM keeps a BOM at the
 *  start in the string, where TextDecoder would otherwise drop it unasked. */
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/**
 * How deep a JSON body may nest, in arrays and objects, and still be kept as JSON. A deeper one is
 * kept as the text it came as, as JSON the parser cannot read is.
 *
 * Nothing would stop one at parsing: JSON.parse does not recurse and reads 200,000 levels, and
 * parseJson takes its reviver, which does, only for text with a run of 16 digits in it. But
 * JSON.stringify gives up at a depth that depends on the Node version (on 22 and 24, between 5,000
 * and 10,000 levels), and so would whether such an exchange is recorded; and a restart that reads
 * its line through the reviver fails from about 2,500 levels. Hence a limit of our own, the same on
 * every version: what is kept as JSON is written out and read back on any of them.
 */
const MAX_JSON_DEPTH = 1000

/** Whether a value nests arrays and objects more than `levels` deep; a RawJson is a number, not an
 *  object. It stops at the first branch that goes too deep, so it never recurses more than
 *  `levels` calls deep itself */
function deeperThan(value: JsonValue, levels: number): boolean {
  const items = Array.isArray(value) ? value : isJsonObject(value) ? Object.values(value) : null
  if (items === null) return false
  if (levels === 0) return true
  for (const item of items) if (deeperThan(item, levels - 1)) return true
  return false
}

/**
 * A body as it is stored: `{ body, body_encoding, truncated }`.
 *
 * JSON becomes the value itself, so a script that reads a recording can edit
 * fields rather than parse a string; other text stays a string; anything else
 * is base64. A body over the cap is cut first, and a cut body is never offered
 * as JSON — half an object is not the object it claimed to be.
 */
export function encodeBody(raw: Buffer): EncodedBody {
  if (raw.length === 0) return { body: null, body_encoding: null, truncated: false }

  const truncated = raw.length > MAX_BODY_BYTES
  const data = truncated ? raw.subarray(0, MAX_BODY_BYTES) : raw
  let text: string | null
  try {
    text = UTF8.decode(data)
  } catch {
    text = null
  }

  if (!truncated && text !== null) {
    try {
      // A BOM at the start is left out of the JSON; a text body keeps it
      const json = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
      const body = parseJson(json)
      // Deeper than MAX_JSON_DEPTH, it goes on to be kept as text, as JSON that does not parse does
      if (!deeperThan(body, MAX_JSON_DEPTH)) {
        return { body, body_encoding: 'json', truncated: false }
      }
    } catch {
      // Not JSON, or JSON the parser cannot get to the bottom of (a RangeError, from the reviver
      // parseJson takes for a big integer): it is kept as the text it arrived as, like any other
      // body we cannot read
    }
  }
  if (text !== null) return { body: text, body_encoding: 'text', truncated }
  return { body: data.toString('base64'), body_encoding: 'base64', truncated }
}

/**
 * The bytes a stored body was made of — what `encodeBody` kept, put back.
 *
 * This is what replay sends: a recording is only as good as the bytes it
 * gives back, so each of the three encodings is reversed rather than printed.
 */
export function decodeBody(
  body: JsonValue | undefined,
  bodyEncoding: string | null | undefined,
): Buffer {
  if (bodyEncoding === 'base64' && typeof body === 'string') return Buffer.from(body, 'base64')
  return Buffer.from(bodyText(body, bodyEncoding), 'utf8')
}

/** The body as something to search or print; base64 is left as it is stored */
export function bodyText(
  body: JsonValue | undefined,
  bodyEncoding: string | null | undefined,
): string {
  // A JSON body that was null is the text null, so replay sends null back as the
  // upstream did
  if (body === null || body === undefined) return bodyEncoding === 'json' ? 'null' : ''
  if (bodyEncoding !== 'json' && typeof body === 'string') return body
  // JSON; or, under any other encoding, a body that is not a string, which only data edited
  // by hand can hold. It is written as JSON too: String() throws on a RawJson, and in a
  // search that would be a 500.
  return stringifySpaced(body)
}

/**
 * The headers, with the values of those named replaced by `[REDACTED]`, whatever the
 * case of either. A new object, with every name spelt as it was and where it was.
 *
 * Used on the way out — the CLI prints through this — never on the way in: the
 * files on disk keep the real values so that a recording still replays.
 */
export function redactHeaders(
  headers: Readonly<Record<string, string>>,
  names: readonly string[],
): Record<string, string> {
  const hidden = new Set(names.map((name) => name.toLowerCase()))
  // fromEntries makes a header named "__proto__" a key like any other, where assigning it
  // would set the prototype instead
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      hidden.has(name.toLowerCase()) ? REDACTED : value,
    ]),
  )
}

// ---------------------------------------------------------------- the entry
//
// The order of the fields is the order of the keys on disk, which the golden files in
// tests/fixtures/requests/ pin.

/** What the client asked for, as the log keeps it */
export interface ExchangeRequest {
  method: string
  scheme: string
  host: string
  port: number
  path: string
  query: Record<string, string>
  url: string
  headers: Record<string, string>
  body: JsonValue
  body_encoding: BodyEncoding | null
}

/** What went back, after any decompression */
export interface ExchangeResponse {
  status: number
  headers: Record<string, string>
  body: JsonValue
  body_encoding: BodyEncoding | null
  elapsed_ms: number
  /** How many bytes of body the client got. Kept as it was counted rather than measured from
   *  `body` later: the stored body is a parsed object by then, and a list view should not
   *  re-serialise every entry to fill one column. */
  size: number
}

/**
 * One request and its answer, or one tunnel that was never decrypted.
 *
 * `kind` is `http` for a request we read and answered, and `connect` for a
 * CONNECT that was carried through untouched — the row Charles shows as
 * `<encrypted>`, which knows only the host, the port, the client and how many
 * bytes went each way.
 */
export interface Exchange {
  seq: number
  time: string
  kind: ExchangeKind
  request: ExchangeRequest
  response: ExchangeResponse | null
  /** The key of the rule that answered it, as it was written; null when the global mode did */
  matched_by: string | null
  /** Not narrowed to a TunnelMode: an old file may hold a mode that has since been renamed */
  mode: string | null
  replay_seq: number | null
  unmatched: boolean
  client: string
  truncated: boolean
  /** A tunnel nobody decrypted: there is nothing to show but its size */
  encrypted: boolean
  bytes_up: number
  bytes_down: number
}

// The three models: what parseExchange checks a line of the log, a recording or an import
// against, and where makeExchange* take their defaults from. They drop the fields they do not
// know.
const EXCHANGE_REQUEST_SCHEMA = model<ExchangeRequest>('ExchangeRequest', {
  method: withDefault(str, () => ''),
  scheme: withDefault(str, () => ''),
  host: withDefault(str, () => ''),
  port: withDefault(int, () => 0),
  path: withDefault(str, () => ''),
  query: withDefault(dictOf(str), () => ({})),
  url: withDefault(str, () => ''),
  headers: withDefault(dictOf(str), () => ({})),
  body: withDefault(anyValue, () => null),
  body_encoding: withDefault(nullable(oneOf(BODY_ENCODINGS)), () => null),
})

const EXCHANGE_RESPONSE_SCHEMA = model<ExchangeResponse>('ExchangeResponse', {
  status: withDefault(int, () => 0),
  headers: withDefault(dictOf(str), () => ({})),
  body: withDefault(anyValue, () => null),
  body_encoding: withDefault(nullable(oneOf(BODY_ENCODINGS)), () => null),
  elapsed_ms: withDefault(int, () => 0),
  size: withDefault(int, () => 0),
})

const EXCHANGE_SCHEMA = model<Exchange>('Exchange', {
  seq: withDefault(int, () => 0),
  time: withDefault(str, () => ''),
  kind: withDefault(oneOf(EXCHANGE_KINDS), () => 'http'),
  request: withDefault(EXCHANGE_REQUEST_SCHEMA, () => makeExchangeRequest()),
  response: withDefault(nullable(EXCHANGE_RESPONSE_SCHEMA), () => null),
  matched_by: withDefault(nullable(str), () => null),
  mode: withDefault(nullable(str), () => null),
  replay_seq: withDefault(nullable(int), () => null),
  unmatched: withDefault(bool, () => false),
  client: withDefault(str, () => ''),
  truncated: withDefault(bool, () => false),
  encrypted: withDefault(bool, () => false),
  bytes_up: withDefault(int, () => 0),
  bytes_down: withDefault(int, () => 0),
})

/** An ExchangeRequest from the fields given and the defaults for the rest, a new object every
 *  time; nothing is checked */
export function makeExchangeRequest(fields?: Partial<ExchangeRequest>): ExchangeRequest {
  return make(EXCHANGE_REQUEST_SCHEMA, fields)
}

/** An ExchangeResponse from the fields given and the defaults for the rest, a new object every
 *  time; nothing is checked */
export function makeExchangeResponse(fields?: Partial<ExchangeResponse>): ExchangeResponse {
  return make(EXCHANGE_RESPONSE_SCHEMA, fields)
}

/** An Exchange from the fields given and the defaults for the rest, a new object every time, its
 *  request included; nothing is checked */
export function makeExchange(fields?: Partial<Exchange>): Exchange {
  return make(EXCHANGE_SCHEMA, fields)
}

/**
 * One line of the log, a recording or an exchange being imported, read back. A field it leaves
 * out is the default, one it does not know is dropped, and the fields come in their order. Throws
 * ValidationError('Exchange', issues) when the shape is wrong, "request": null included;
 * "response": {} is a response of defaults.
 */
export function parseExchange(input: unknown): Exchange {
  const result = check(EXCHANGE_SCHEMA, input)
  if (!result.ok) throw new ValidationError(EXCHANGE_SCHEMA.name, result.issues)
  return result.value
}

/** The key this exchange is aggregated under, and rules are written in: CONNECT:host:port for a
 *  tunnel, METHOD:host/path for the rest */
export function exchangeKey(exchange: Exchange): string {
  const { method, host, port, path } = exchange.request
  return exchange.kind === 'connect' ? `CONNECT:${host}:${port}` : `${method}:${host}${path}`
}

/** The flat row a list view shows: everything but the headers and bodies. It is what SSE sends
 *  and a row of /requests?each=1, with the fields in this order. */
export interface ExchangeSummary {
  seq: number
  time: string
  kind: ExchangeKind
  key: string
  method: string
  scheme: string
  host: string
  port: number
  path: string
  query: Record<string, string>
  url: string
  status: number | null
  elapsed_ms: number | null
  size: number
  matched_by: string | null
  mode: string | null
  replay_seq: number | null
  unmatched: boolean
  encrypted: boolean
  truncated: boolean
  client: string
  bytes_up: number
  bytes_down: number
}

/** The flat row a list view shows: everything but the headers and bodies */
export function exchangeSummary(exchange: Exchange): ExchangeSummary {
  const { request, response } = exchange
  return {
    seq: exchange.seq,
    time: exchange.time,
    kind: exchange.kind,
    key: exchangeKey(exchange),
    method: request.method,
    scheme: request.scheme,
    host: request.host,
    port: request.port,
    path: request.path,
    query: { ...request.query },
    url: request.url,
    status: response?.status ?? null,
    elapsed_ms: response?.elapsed_ms ?? null,
    // One column, whichever kind of row this is: the answer's size, or what a tunnel nobody
    // read carried in both directions
    size:
      exchange.kind === 'connect' ? exchange.bytes_up + exchange.bytes_down : (response?.size ?? 0),
    matched_by: exchange.matched_by,
    mode: exchange.mode,
    replay_seq: exchange.replay_seq,
    unmatched: exchange.unmatched,
    encrypted: exchange.encrypted,
    truncated: exchange.truncated,
    client: exchange.client,
    bytes_up: exchange.bytes_up,
    bytes_down: exchange.bytes_down,
  }
}

/** What a keyword search looks through: host, path, query, status, rule */
function haystack(exchange: Exchange, withBody: boolean): string {
  const { request, response } = exchange
  const parts = [
    request.method,
    request.host,
    request.path,
    Object.entries(request.query)
      .map(([name, value]) => `${name}=${value}`)
      .join(' '),
    exchange.matched_by ?? '',
    exchange.mode ?? '',
    response !== null ? String(response.status) : '',
  ]
  if (withBody) {
    parts.push(bodyText(request.body, request.body_encoding))
    if (response !== null) parts.push(bodyText(response.body, response.body_encoding))
  }
  return parts.join('\n').toLowerCase()
}

/** A row of `tunnel requests`, with the fields in this order: the 8 a row starts with, then the 9
 *  every exchange under its key updates */
export interface AggregateRow {
  key: string
  method: string
  host: string
  path: string
  kind: ExchangeKind
  request_count: number
  unmatched_count: number
  first_seen: string
  last_seen: string
  last_seq: number
  query: Record<string, string>
  status: number | null
  elapsed_ms: number | null
  matched_by: string | null
  configured: boolean
  mode: string | null
  encrypted: boolean
}

/**
 * One row per key, most recently seen first — the view `tunnel requests` prints.
 *
 * What is reported about a key is what the last exchange under it actually
 * did: the rule that matched it and the mode that answered it, rather than the
 * rule that would match it if it arrived now.
 */
export function aggregate(exchanges: readonly Exchange[]): AggregateRow[] {
  const rows = new Map<string, AggregateRow>()
  for (const exchange of exchanges) {
    const key = exchangeKey(exchange)
    // What the row is updated with. A row gets them once, after its first 8 fields, and the next
    // exchange under the key writes over them where they are
    const latest = {
      last_seen: exchange.time,
      last_seq: exchange.seq,
      query: { ...exchange.request.query },
      status: exchange.response?.status ?? null,
      elapsed_ms: exchange.response?.elapsed_ms ?? null,
      matched_by: exchange.matched_by,
      configured: exchange.matched_by !== null,
      mode: exchange.mode,
      encrypted: exchange.encrypted,
    }
    const row = rows.get(key)
    if (row === undefined) {
      rows.set(key, {
        key,
        method: exchange.request.method,
        host: exchange.request.host,
        path: exchange.request.path,
        kind: exchange.kind,
        request_count: 1,
        unmatched_count: exchange.unmatched ? 1 : 0,
        first_seen: exchange.time,
        ...latest,
      })
    } else {
      row.request_count += 1
      row.unmatched_count += exchange.unmatched ? 1 : 0
      Object.assign(row, latest)
    }
  }
  // Stable: rows with the same last_seq keep the order their keys were first seen in
  return [...rows.values()].sort((a, b) => b.last_seq - a.last_seq)
}

/**
 * `*` is a wildcard, and a host is a host whatever case it is spelled in.
 *
 * Shared with the recordings index, so that `--host` narrows the log and the
 * recordings the same way. Without a `*` the pattern is compared as it is, so a `?`
 * in it is only a question mark.
 */
export function hostMatches(pattern: string, host: string): boolean {
  return pattern.includes('*')
    ? matchGlob(host.toLowerCase(), pattern.toLowerCase())
    : host.toLowerCase() === pattern.toLowerCase()
}

// ---------------------------------------------------------------- watching

/** A new exchange, or null: the window the log holds moved with nothing new in it (only a clear
 *  does that) */
export type BroadcastEntry = Exchange | null

/** What subscribe() gives: the entries published from then on, one at a time, in their order */
export interface Subscription {
  /** The next entry: at once if one is in the backlog, otherwise when one arrives, when timeoutMs
   *  runs out ('timeout') or when the subscription is ended ('closed'). With no timeoutMs it waits
   *  for as long as that takes. Only one next() can wait on a subscription at a time; a second
   *  one throws an Error. */
  next(timeoutMs?: number): Promise<BroadcastEntry | 'timeout' | 'closed'>
}

/** The longest setTimeout waits. Past it, Node fires the timer after 1 ms and warns
 *  (TimeoutOverflowWarning), and nothing caps the timeout a wait is given: unheld, ?timeout=1e9
 *  would have the wait loop go round once a millisecond. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1

/** A subscription: its own backlog, and at most one next() waiting on it */
class Watcher implements Subscription {
  readonly #backlog: number
  readonly #queue: BroadcastEntry[] = []
  /** Settles the next() waiting, if one is, and clears its timer */
  #settle: ((outcome: BroadcastEntry | 'timeout' | 'closed') => void) | null = null
  #closed = false

  constructor(backlog: number) {
    this.#backlog = backlog
  }

  next(timeoutMs?: number): Promise<BroadcastEntry | 'timeout' | 'closed'> {
    if (this.#settle !== null) {
      throw new Error('Only one next() can wait on a subscription at a time')
    }
    if (this.#closed) return Promise.resolve('closed')
    // undefined only when the backlog is empty: an entry is an exchange or null
    const entry = this.#queue.shift()
    if (entry !== undefined) return Promise.resolve(entry)
    return new Promise((resolve) => {
      // Not unref()'d: on Node 22.18, node:test cancels a test left waiting on nothing but an
      // unref()'d timer, which is what a next(50) with nothing to come is
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(
              () => this.#settle?.('timeout'),
              // NaN is held to 0 as well, which setTimeout would take as 1 ms with a warning
              // (TimeoutNaNWarning, from Node 24 on)
              Number.isNaN(timeoutMs) ? 0 : Math.min(Math.max(timeoutMs, 0), MAX_TIMEOUT_MS),
            )
      this.#settle = (outcome) => {
        clearTimeout(timer)
        this.#settle = null
        resolve(outcome)
      }
    })
  }

  /** Hands the entry to the next() waiting, or else puts it in the backlog. False when the
   *  backlog is full and the entry is dropped. */
  offer(entry: BroadcastEntry): boolean {
    if (this.#settle !== null) {
      // Handing it over resolves a promise, so the watcher goes on only once the code that
      // published the entry has run to its end: nothing a watcher does wrong comes back up
      // into recordHttp
      this.#settle(entry)
      return true
    }
    if (this.#backlog > 0 && this.#queue.length >= this.#backlog) return false
    this.#queue.push(entry)
    return true
  }

  /** Lets the next() waiting go with 'closed', and every next() after it */
  close(): void {
    this.#closed = true
    this.#settle?.('closed')
  }
}

/**
 * Something happened to the log, handed to whoever is watching.
 *
 * One queue per subscriber, so a slow reader cannot hold up the request that is being answered:
 * when a subscriber has fallen too far behind, its entry is dropped rather than awaited. The SSE
 * endpoint is the first subscriber.
 *
 * An entry is an exchange, or null for a change with no exchange behind it — a clear, which moves
 * the window the log holds without anything arriving. One queue carries both because the order of
 * the two is exactly what a watcher needs to get right, and two channels would have two orders.
 */
export class Broadcaster {
  /** How many entries each subscriber may fall behind by; 0 or less is no limit */
  readonly backlog: number
  readonly #watchers = new Set<Watcher>()

  constructor(backlog = 1000) {
    this.backlog = backlog
  }

  subscribe(): Subscription {
    const watcher = new Watcher(this.backlog)
    this.#watchers.add(watcher)
    return watcher
  }

  /** Ends a subscription: a next() waiting on it gets 'closed' at once, and so does every next()
   *  after it. Ending one a second time, or one another Broadcaster made, does nothing. */
  unsubscribe(subscription: Subscription): void {
    if (subscription instanceof Watcher && this.#watchers.delete(subscription)) subscription.close()
  }

  get subscribers(): number {
    return this.#watchers.size
  }

  publish(exchange: Exchange): void {
    for (const watcher of [...this.#watchers]) {
      if (!watcher.offer(exchange)) {
        log.debug(`A watcher fell behind; dropping exchange ${exchange.seq}`)
      }
    }
  }

  /**
   * Say that the window moved, but that no new exchange came with it.
   *
   * A watcher reading this is expected to look the window up again rather than to take anything
   * from the entry itself, which is why there is nothing to put in it. Dropped when a queue is
   * full, like an exchange: the window is a state and not a step, so the next entry corrects it.
   */
  publishChange(): void {
    for (const watcher of [...this.#watchers]) {
      if (!watcher.offer(null)) log.debug('A watcher fell behind; dropping a window change')
    }
  }
}

// ---------------------------------------------------------------- the log

/** What select narrows the log by. Each is named as the admin API's query parameter is; null and
 *  undefined both mean not given */
export interface ExchangeFilters {
  /** A rule key; '' is not given. One that does not read makes parseKey throw a UserError */
  key?: string | null
  /** '' is not given */
  host?: string | null
  /** Only what came after this seq. 0 is a value too: every seq is past it */
  since?: number | null
  /** Only the last so many. 0 is not given; a negative number cuts from the front instead (-2
   *  drops the first two) */
  last?: number | null
  unmatched?: boolean
  encrypted?: boolean
  /** A keyword; '' is not given */
  q?: string | null
  /** Let the keyword search the bodies too */
  q_body?: boolean
}

/** What recordHttp writes into the exchange, each under the exchange's own field name */
export interface RecordFields {
  /** Whole milliseconds: the core rounds what it measured with Math.round. A fraction would be
   *  written to the file as it is, but int refuses it when the file is read back (int_from_float),
   *  and the line would be skipped. */
  elapsed_ms: number
  matched_by?: string | null // null when not given
  mode?: string | null // null when not given
  unmatched?: boolean // false when not given
  replay_seq?: number | null // null when not given
}

/** A write the log file is waiting for */
type WriteOp = { kind: 'append'; line: string } | { kind: 'truncate' }

/** YYYY-MM-DDTHH:MM:SS.mmm in local time, with no zone. Not toISOString(), which is UTC and ends
 *  in Z: the CLI cuts time.slice(11, 23) and last_seen.slice(0, 19) out of this */
function localTimestamp(date: Date): string {
  const two = (value: number) => String(value).padStart(2, '0')
  const year = String(date.getFullYear()).padStart(4, '0')
  const day = `${year}-${two(date.getMonth() + 1)}-${two(date.getDate())}`
  const time = `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
  return `${day}T${time}.${String(date.getMilliseconds()).padStart(3, '0')}`
}

/** The seq a line starts with, as every line of the log does. No more than 15 digits, and no
 *  digit right after them, so that it is a number a double holds exactly */
const SEQ_AT_START = /^\{\s*"seq"\s*:\s*(\d{1,15})\b/

/**
 * The last `count` lines of a file, not decoded yet: a line is what comes before a "\n", and what
 * follows the last "\n", if anything does, is one too. `endsWithNewline` is true when the last
 * byte is a "\n", and for an empty file: either way, what is appended next starts a line of its
 * own. Null when there is no file; any other error is thrown.
 *
 * Read from the end, 64 KiB at a time, until it holds `count` whole lines or reaches the start:
 * the file only grows between two clears, and days of traffic with bodies of 2 MB make gigabytes
 * of it. Read whole, it takes time in proportion and fails past about 512 MB, where one string
 * cannot hold it, and the server does not start; read a line at a time to the end, it would make
 * the constructor asynchronous. From the end it costs what the tail does.
 */
function readTail(
  path: string,
  count: number,
): { lines: Buffer[]; endsWithNewline: boolean } | null {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    const size = fstatSync(fd).size
    const chunks: Buffer[] = []
    let start = size
    // Each "\n" read has a whole line after it, the one that ends the file aside: so once there are
    // `count` of them, the last `count` lines are all in
    let newlines = 0
    while (start > 0 && newlines < count) {
      const end = start
      start = Math.max(0, end - 64 * 1024)
      const chunk = Buffer.alloc(end - start)
      readSync(fd, chunk, 0, chunk.length, start)
      chunks.unshift(chunk)
      const counted = end === size ? chunk.subarray(0, -1) : chunk
      for (let at = counted.indexOf(0x0a); at !== -1; at = counted.indexOf(0x0a, at + 1)) {
        newlines += 1
      }
    }

    const data = Buffer.concat(chunks)
    const lines: Buffer[] = []
    let from = 0
    for (let at = data.indexOf(0x0a); at !== -1; at = data.indexOf(0x0a, from)) {
      lines.push(data.subarray(from, at))
      from = at + 1
    }
    // A last line with no "\n" after it; after a "\n" that ends the file there is none
    if (from < data.length) lines.push(data.subarray(from))
    // Unless the start of the file was reached, the first line may be the end of a longer one
    if (start > 0) lines.shift()
    return { lines: lines.slice(-count), endsWithNewline: size === 0 || data.at(-1) === 0x0a }
  } finally {
    closeSync(fd)
  }
}

/**
 * The recent exchanges in memory, and every exchange on disk.
 *
 * The buffer is what the admin API reads and filters; the file is what makes the sequence survive
 * a restart. Writing it is the job of a queue of writes, one at a time, which Node carries out off
 * the main thread: recording happens while a device is being answered, and that must not stop for
 * a disk.
 */
export class ExchangeLog {
  /** requests.jsonl, in the state directory */
  readonly path: string
  readonly broadcaster: Broadcaster
  readonly #configManager: TunnelConfigManager
  /** Oldest first, and no more than the capacity once the next exchange has come */
  readonly #buffer: Exchange[] = []
  #nextSeq = 1
  /** The writes asked for and not started yet, in the order they were asked for */
  readonly #ops: WriteOp[] = []
  /** The round of writing under way, if there is one: it takes from #ops until they run out */
  #draining: Promise<void> | null = null
  /** Whether the next write starts with a newline: the file ends in half a line, or may, after a
   *  write that failed, and what comes next is not to carry that line on */
  #newlineFirst = false

  /** auto_record_requests and max_requests_history are read from the manager each time they are
   *  needed, so a change to either takes hold without a restart */
  constructor(configManager: TunnelConfigManager) {
    this.#configManager = configManager
    this.path = configManager.paths.exchangesFile
    this.broadcaster = new Broadcaster()
    this.#loadTail()
  }

  /** How many exchanges memory holds */
  get size(): number {
    return this.#buffer.length
  }

  /** The highest seq handed out, whether or not it is still in the buffer */
  get lastSeq(): number {
    return this.#nextSeq - 1
  }

  /**
   * The oldest seq still in the buffer; `lastSeq + 1` when there is none.
   *
   * With `lastSeq` it is the whole of what memory holds, which is what lets a reader throw away
   * anything it has below it. The empty answer is `lastSeq + 1` rather than null or 0 because it
   * reads as "the next one will be this number, so I hold nothing": a consumer testing
   * `seq < firstSeq` then needs no special case for the empty log, where null would make it
   * handle two types and 0 could not be told apart from holding everything since the beginning.
   */
  get firstSeq(): number {
    return this.#buffer[0]?.seq ?? this.lastSeq + 1
  }

  /** The exchanges memory holds, oldest first: a new array of the very objects, not copies */
  all(): Exchange[] {
    return [...this.#buffer]
  }

  get(seq: number): Exchange | null {
    return this.#buffer.find((exchange) => exchange.seq === seq) ?? null
  }

  /**
   * The entries a query asks for, oldest first.
   *
   * `key` is a rule key, so `GET:/api/feed` selects that path on every host the way a rule
   * written that way would answer it. A bad key throws a UserError, which the API turns into a
   * 400, and it does so before anything is looked through.
   */
  select(filters: ExchangeFilters = {}): Exchange[] {
    const { key, host, since, last, unmatched, encrypted, q, q_body } = filters
    const parsed = key ? parseKey(key) : null
    const needle = q ? q.toLowerCase() : null
    const selected: Exchange[] = []
    for (const exchange of this.#buffer) {
      const { request } = exchange
      if (since !== undefined && since !== null && exchange.seq <= since) continue
      if (unmatched && !exchange.unmatched) continue
      if (encrypted && !exchange.encrypted) continue
      if (host && !hostMatches(host, request.host)) continue
      if (
        parsed !== null &&
        !keyMatches(parsed, request.method, request.host, request.port, request.path)
      ) {
        continue
      }
      if (needle !== null && !haystack(exchange, q_body ?? false).includes(needle)) continue
      selected.push(exchange)
    }
    // slice(-last) gives what last asks for whether it is positive, negative or past the length
    return last ? selected.slice(-last) : selected
  }

  // ------------------------------------------------------------ recording

  /** Log one answered request. Returns null, and records nothing, when recording is switched off */
  recordHttp(request: Request, response: Response, fields: RecordFields): Exchange | null {
    if (!this.#configManager.getConfig().auto_record_requests) return null

    const asked = encodeBody(request.body)
    const answer = encodeBody(response.body)

    return this.#append(
      makeExchange({
        kind: 'http',
        request: makeExchangeRequest({
          method: request.method,
          scheme: request.scheme,
          host: request.host,
          port: effectivePort(request),
          path: request.path,
          query: { ...request.query },
          url: requestUrl(request),
          headers: { ...request.headers },
          body: asked.body,
          body_encoding: asked.body_encoding,
        }),
        response: makeExchangeResponse({
          status: response.status,
          headers: Object.fromEntries(
            Object.entries(response.headers).filter(
              ([name]) => !DROPPED_RESPONSE_HEADERS.has(name.toLowerCase()),
            ),
          ),
          body: answer.body,
          body_encoding: answer.body_encoding,
          elapsed_ms: fields.elapsed_ms,
          size: response.body.length,
        }),
        matched_by: fields.matched_by ?? null,
        mode: fields.mode ?? null,
        replay_seq: fields.replay_seq ?? null,
        unmatched: fields.unmatched ?? false,
        client: request.client,
        truncated: asked.truncated || answer.truncated,
      }),
    )
  }

  /** Log a tunnel that was carried through without being decrypted. Returns null, and records
   *  nothing, when recording is switched off. The host is kept as given */
  recordConnect(
    host: string,
    port: number,
    client: string,
    bytesUp: number,
    bytesDown: number,
  ): Exchange | null {
    if (!this.#configManager.getConfig().auto_record_requests) return null

    return this.#append(
      makeExchange({
        kind: 'connect',
        request: makeExchangeRequest({
          method: 'CONNECT',
          scheme: 'https',
          host,
          port,
          url: `${host}:${port}`,
        }),
        client,
        encrypted: true,
        bytes_up: bytesUp,
        bytes_down: bytesDown,
      }),
    )
  }

  /**
   * Forget every entry, and say what the last seq was.
   *
   * The sequence keeps counting: `--since` after a clear is what tells a test "everything from
   * here", and restarting the count would make it ambiguous.
   */
  clear(): number {
    const last = this.lastSeq
    this.#buffer.length = 0
    // Queued behind the appends asked for before it, so it empties the file of those and of
    // nothing that comes after
    this.#enqueue({ kind: 'truncate' })
    // Announced after the buffer is empty, so a watcher that wakes on this reads the window it
    // has been told about rather than the one before. Nothing else will announce it: a clear is
    // the one move of the window that no arriving exchange comes with, and a watcher left to find
    // out on its own would keep showing rows the log no longer has.
    this.broadcaster.publishChange()
    return last
  }

  /** Wait for the writes to catch up, those queued while it waits included — for shutdown, and
   *  for tests */
  async flush(): Promise<void> {
    while (this.#draining !== null) await this.#draining
  }

  /** For shutdown: waits for the writes to catch up, for 5 seconds at most. What is recorded after
   *  it is written all the same */
  async close(): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    const givenUp = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 5000)
    })
    try {
      await Promise.race([this.flush(), givenUp])
    } finally {
      clearTimeout(timer)
    }
  }

  // ------------------------------------------------------------ internals

  #capacity(): number {
    return Math.max(1, this.#configManager.getConfig().max_requests_history)
  }

  #append(exchange: Exchange): Exchange {
    exchange.seq = this.#nextSeq
    exchange.time = localTimestamp(new Date())
    this.#nextSeq += 1

    let line: string
    try {
      // Written out before the entry is kept, not when the file is written: an entry nothing can
      // serialise is one the API could not show either, so it is better to say so and keep none
      // of it. The request itself has already been answered — logging never costs a client its
      // reply.
      line = `${JSON.stringify(exchange)}\n`
    } catch (error) {
      const { method, host, path } = exchange.request
      log.warning(`Could not record ${method} ${host}${path}: ${reasonOf(error)}`)
      return exchange
    }

    this.#buffer.push(exchange)
    // max_requests_history can be changed while the server runs. The new size takes hold here, as
    // the next exchange is kept
    const capacity = this.#capacity()
    if (this.#buffer.length > capacity) this.#buffer.splice(0, this.#buffer.length - capacity)

    this.#enqueue({ kind: 'append', line })
    // Kept before anyone is told, so a watcher woken by it finds it in the log
    this.broadcaster.publish(exchange)
    return exchange
  }

  #enqueue(op: WriteOp): void {
    this.#ops.push(op)
    this.#draining ??= this.#drain()
  }

  /** Carries out the writes queued, in their order, until there are none left: a truncate on its
   *  own, and a run of appends as one write. A write that fails is a warning, and the next one is
   *  tried all the same; the promise this returns never rejects */
  async #drain(): Promise<void> {
    try {
      for (let op = this.#ops.shift(); op !== undefined; op = this.#ops.shift()) {
        try {
          // Awaited even when it throws at once, as it is async: so this never ends inside the
          // #enqueue that started it, where finally would clear #draining before #enqueue set it
          await this.#write(op)
        } catch (error) {
          // #write warns of a write that fails. This is for whatever else throws: the logger as it
          // does so, or appends queued behind a disk that stalled until together they are longer
          // than a string can be (about 512 MiB), which costs the first of them
          try {
            log.warning(`Could not write the exchange log ${this.path}: ${reasonOf(error)}`)
          } catch {
            // The logger is what threw: there is no one left to tell
          }
        }
      }
    } finally {
      this.#draining = null
    }
  }

  /** One write: a truncate, or this append with those queued right behind it */
  async #write(op: WriteOp): Promise<void> {
    // Each write opens the file afresh, through a symlink if it is one
    if (op.kind === 'truncate') {
      try {
        await writeFile(this.path, '')
        this.#newlineFirst = false
      } catch (error) {
        log.warning(`Could not write the exchange log ${this.path}: ${reasonOf(error)}`)
      }
      return
    }

    // This append and those queued right behind it, up to a truncate; after half a line, a
    // newline first, so that the first of them starts a line of its own
    let lines = this.#newlineFirst ? `\n${op.line}` : op.line
    let joined = 0
    for (const next of this.#ops) {
      if (next.kind !== 'append') break
      lines += next.line
      joined += 1
    }
    this.#ops.splice(0, joined)
    try {
      await appendFile(this.path, lines)
      this.#newlineFirst = false
    } catch (error) {
      // Part of it may have been written, a line cut short at the end of the file. Set before the
      // warning, in case the logger throws
      this.#newlineFirst = true
      log.warning(`Could not write the exchange log ${this.path}: ${reasonOf(error)}`)
    }
  }

  /**
   * Read back the last entries, so the panel and `seq` survive a restart.
   *
   * The last max_requests_history lines of the file, a blank or unreadable line taking up its place
   * among them like any other; read from the end of the file rather than through all of it, for the
   * reasons readTail gives. A line that cannot be read is skipped with a warning. Its seq counts
   * all the same if it starts with one: a line cut off halfway was still handed that seq, and
   * handing it out twice would give two recordings the same file.
   */
  #loadTail(): void {
    let tail: ReturnType<typeof readTail>
    try {
      tail = readTail(this.path, this.#capacity())
    } catch (error) {
      log.warning(`Could not read the exchange log ${this.path}: ${reasonOf(error)}`)
      return
    }
    if (tail === null) return

    // The highest seq of all, which the next one follows, below 1 too; with none at all the first
    // one handed out stays 1. A loop rather than Math.max(...seqs), which runs out of stack at a
    // max_requests_history of 200,000
    let highest = -Infinity
    for (const bytes of tail.lines) {
      let text: string | null = null
      try {
        // trim() takes off the \r of a \r\n, and a BOM on a first line
        text = UTF8.decode(bytes).trim()
        if (text === '') continue
        const exchange = parseExchange(parseJson(text))
        this.#buffer.push(exchange)
        if (exchange.seq > highest) highest = exchange.seq
      } catch (error) {
        log.warning(`Skipping an unreadable line in ${this.path}: ${reasonOf(error)}`)
        // A line that is not UTF-8 is read as latin1 for this: {"seq": N is ASCII, which latin1
        // reads right whatever comes after it
        const seq = SEQ_AT_START.exec(text ?? bytes.toString('latin1').trim())?.[1]
        if (seq !== undefined && Number(seq) > highest) highest = Number(seq)
      }
    }
    if (highest > -Infinity) this.#nextSeq = highest + 1
    this.#newlineFirst = !tail.endsWithNewline
  }
}
