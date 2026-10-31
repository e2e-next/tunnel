// Recorded traffic: every passthrough call kept as a file of its own.
//
// Recording is a global switch rather than a response mode: while it is on, each
// decrypted call that went to the real server is written under the data directory
// as well as to the request log. The tree says what the call was — session, host,
// method, then the path — so a directory listing is already an index, one endpoint
// is easy to find, and a copy committed to a client's repository reads the same
// way there. The file holds the exchange exactly as the log keeps it, header
// values and all, because a recording exists to be replayed.
//
// Writing is a queue's job, as it is for the request log: a write is queued at once
// and reaches the disk after the ones queued before it, so the event loop answering a
// device never waits for a disk, and a read waits until the queue is empty, so it sees
// every write queued before it. The index over the files is walked once per session
// and then kept, because replay asks it which recording answers this call on every
// single request; every write and every delete goes through this store, so the walk
// is redone exactly when the directory changed. The tree `tunnel recordings export`
// writes is the tree `tunnel recordings import` reads back.
import { readFileSync, readdirSync, rmSync, statSync, type Dirent } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { TunnelConfigManager } from './config.ts'
import { UserError, ValidationError, reasonOf, repr } from './errors.ts'
import {
  decodeBody,
  exchangeKey,
  hostMatches,
  parseExchange,
  type BodyEncoding,
  type Exchange,
  type ExchangeRequest,
} from './exchanges.ts'
import { isJsonObject, parseJson, stringifySpaced, type JsonValue } from './json.ts'
import { getLogger } from './log.ts'
import type { Request } from './messages.ts'
import { DEFAULT_SESSION, type ReplayStrategy, type TunnelRequestConfig } from './models.ts'
import { keyMatches, parseKey, type Key } from './rule-keys.ts'

const log = getLogger('recordings')

/** Where recordings live inside the data directory */
export const RECORDINGS_DIR = 'recordings'
/** A request for "/" has no path segments to be filed under */
export const ROOT_SEGMENT = '_root'

// ---------------------------------------------------------------- the layout

// What may stand in a directory name here. Everything else becomes an
// underscore: a host or a path segment is not a file name until it has been
// through this. The u flag cannot go: with it the pattern goes by code point, so
// an emoji is one character and becomes one underscore; without it, it is two
// UTF-16 code units and becomes two.
const UNSAFE = /[^A-Za-z0-9._-]/gu

// What stripSpace takes for whitespace, written as the inside of a character class:
// the code points with Unicode's White_Space property and the four information
// separators, U+001C to U+001F, 29 in all. Not String.prototype.trim, which strips
// another set: this one holds U+001C to U+001F and U+0085, which trim leaves, and
// not U+FEFF, which trim strips.
const SPACE_CHARS = String.raw`\t-\r\x1c-\x20\x85\xa0\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}`
const EDGE_SPACE = new RegExp(`^[${SPACE_CHARS}]+|[${SPACE_CHARS}]+$`, 'gu')

/** text without the SPACE_CHARS at either end */
function stripSpace(text: string): string {
  return text.replace(EDGE_SPACE, '')
}

/** The seq a file is named by: six digits at the least, a minus sign counting as one of the six */
function formatSeq(seq: number): string {
  return seq < 0 ? '-' + String(-seq).padStart(5, '0') : String(seq).padStart(6, '0')
}

/** One host, method or path segment as a directory name: every code point outside [A-Za-z0-9._-]
 *  becomes "_", and "", "." or ".." become "_" */
export function safeSegment(name: string): string {
  const cleaned = name.replace(UNSAFE, '_')
  // "" is not a name, and "." and ".." are directions rather than names: a
  // path built out of them would climb out of the recordings directory.
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? '_' : cleaned
}

/**
 * A session name, checked, since it becomes a directory. null, undefined and blank are
 * DEFAULT_SESSION. Throws UserError when cleaning it would change it.
 *
 * The admin API turns that UserError into a 400: silently rewriting the name would file the
 * recordings somewhere the caller never asked for.
 */
export function sessionName(name: string | null | undefined): string {
  const session = stripSpace(name ?? '') || DEFAULT_SESSION
  if (safeSegment(session) !== session) {
    // name is a string that is not blank by now: null, undefined and blank all became
    // DEFAULT_SESSION, which is a name. The ?? '' is for the type checker
    throw new UserError(
      `${repr(name ?? '')} is not a session name; a session is a directory, so ` +
        'letters, digits, dot, dash and underscore are what it can hold',
    )
  }
  return session
}

/** The directories a request path is filed under; "/" is ["_root"] */
export function pathSegments(path: string): string[] {
  const segments = path
    .split('/')
    .filter((part) => part !== '')
    .map(safeSegment)
  return segments.length > 0 ? segments : [ROOT_SEGMENT]
}

/**
 * Where one exchange belongs, relative to the recordings directory, joined with the platform's
 * separator. `tunnel recordings export` writes the same tree, which is what makes an exported
 * directory something `tunnel recordings import` reads straight back.
 */
export function filePath(
  session: string,
  method: string,
  host: string,
  path: string,
  seq: number,
): string {
  return join(
    safeSegment(session),
    safeSegment(host),
    safeSegment(method.toUpperCase()),
    ...pathSegments(path),
    `${formatSeq(seq)}.json`,
  )
}

/**
 * The text of a recording file: indented two spaces, one trailing newline. The store and the CLI's
 * export write this.
 *
 * Indented, because these files are read by people and committed to a client's repository, where
 * a one-line diff should stay one line. Text outside ASCII is written as it is. A float is spelled
 * the JavaScript way, and keys that look like integers come first, as a JavaScript object keeps
 * them.
 */
export function formatRecording(exchange: Exchange | JsonValue): string {
  return JSON.stringify(exchange, null, 2) + '\n'
}

// ---------------------------------------------------------------- the index

/**
 * One recording as the index knows it without opening the file again.
 *
 * Enough to answer "which recording answers this call" — the key parts of the request and where
 * the file is — and enough to be the row the index prints.
 */
export interface RecordedCall {
  readonly session: string // the session directory's name
  readonly seq: number
  readonly time: string
  readonly key: string // exchangeKey(exchange)
  readonly method: string
  readonly host: string
  readonly port: number
  readonly path: string
  readonly query: Readonly<Record<string, string>>
  readonly status: number | null // null when the exchange has no response
  readonly size: number // 0 when the exchange has no response
  readonly file: string // absolute path of the file
}

/** What the index keeps of an exchange read from file in a session's directory, with a copy of
 *  its query */
export function recordedCallOf(session: string, exchange: Exchange, file: string): RecordedCall {
  const { request, response } = exchange
  return {
    session,
    seq: exchange.seq,
    time: exchange.time,
    key: exchangeKey(exchange),
    method: request.method,
    host: request.host,
    port: request.port,
    path: request.path,
    query: { ...request.query },
    status: response?.status ?? null,
    size: response?.size ?? 0,
    file,
  }
}

/** One row of GET /recordings and `tunnel recordings ls`, keys in this order */
export interface RecordingRow {
  session: string
  seq: number
  time: string
  key: string
  query: Record<string, string> // a copy
  status: number | null
  size: number
}

/** A call as a row: the shape `GET /__admin__/recordings` and `tunnel recordings ls` print */
export function recordedCallRow(call: RecordedCall): RecordingRow {
  return {
    session: call.session,
    seq: call.seq,
    time: call.time,
    key: call.key,
    query: { ...call.query },
    status: call.status,
    size: call.size,
  }
}

/** Two queries are the same: the same keys with the same values, whatever their order */
function sameQuery(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  const keys = Object.keys(a)
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key])
  )
}

/**
 * Which of these recordings answers this call, by the strategy given. samples are oldest first, so
 * the newest is the last of them. sequence takes samples[position] and stays on the last; match
 * takes the newest whose query equals `query` (null is {}), else the newest; last the newest.
 *
 * sequence walks them by position, the count of calls this rule has already answered, and stays
 * on the last one once they run out, which is what a client that polls until something changes
 * needs.
 */
export function chooseSample(
  samples: readonly RecordedCall[],
  strategy: ReplayStrategy,
  query?: Readonly<Record<string, string>> | null,
  position = 0,
): RecordedCall | null {
  if (samples.length === 0) return null
  if (strategy === 'sequence') {
    // at(), so that a negative position counts from the end. Below -length it gives null; core
    // never passes one
    return samples.at(Math.min(position, samples.length - 1)) ?? null
  }
  if (strategy === 'match') {
    const asked = query ?? {}
    const equal = samples.findLast((call) => sameQuery(call.query, asked))
    if (equal !== undefined) return equal
  }
  return samples.at(-1) ?? null
}

// ---------------------------------------------------------------- the store

/** Strict UTF-8: bytes that are not UTF-8 throw rather than become U+FFFD. A BOM at the start is
 *  dropped, as TextDecoder does unless told otherwise */
const UTF8 = new TextDecoder('utf-8', { fatal: true })

/** A directory, or a symlink to one. Anything that goes wrong is a no */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** A file, or a symlink to one. Anything that goes wrong is a no */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** For sort: by name, in code point order but for an astral character against one from U+E000 to
 *  U+FFFF, which < puts the other way round, going by UTF-16 code unit. The names tunnel writes
 *  are all ASCII */
function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/**
 * Every recording file under dir: a name ending in .json, in that case, that is a file or a
 * symlink to one. A name that starts with a dot is taken like any other. A directory is walked
 * into, but not a symlink to one, and one that cannot be listed is passed over.
 *
 * Depth first, each directory's entries by name, which compares paths part by part, so a/x.json
 * comes before a-b/x.json, where comparing the whole strings would put a-b first, '-' (0x2D)
 * being less than '/' (0x2F). Only two calls under the same seq can tell, and match and last take
 * the second of them.
 */
function jsonFiles(dir: string, found: string[] = []): string[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries.sort(byName)) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) jsonFiles(path, found)
    // A directory named x.json, an endpoint whose own path ends in `.json`, is walked into above
    // and is no recording; nor is a symlink to one, which isFile follows
    else if (entry.name.endsWith('.json') && isFile(path)) found.push(path)
  }
  return found
}

/** One file the queue is to write */
interface WriteOp {
  path: string
  text: string
}

/** What GET /record, health's `recording` and the panel's header report, keys in this order */
export interface RecordingStatus {
  active: boolean
  session: string
  count: number
}

/** The filters of GET /recordings, named after its query parameters */
export interface RecordingFilters {
  session?: string | null // null or undefined: every session; any string is looked up through safeSegment
  key?: string | null // a rule key; '' is not given; a bad one rejects with UserError
  host?: string | null // `*` is a wildcard; '' is not given
}

/** The recordings directory: the switch, the files, and the index over them */
export class RecordingStore {
  /** <data_dir>/recordings */
  readonly root: string
  readonly #manager: TunnelConfigManager
  // One session's recordings, walked once and kept until this store changes them. Replay asks for
  // a sample per request, and reading every file again each time would put the whole directory on
  // the event loop. A Map, not an object: __proto__ is a session name like any other
  readonly #index = new Map<string, RecordedCall[]>()
  /** The writes queued and not started yet, in the order they were queued */
  readonly #ops: WriteOp[] = []
  /** The round of writing under way, if there is one: it takes from #ops until they run out */
  #draining: Promise<void> | null = null

  /** Whether recording is on and the session in hand are read from the manager each time, so a
   *  change made through it takes hold at once */
  constructor(configManager: TunnelConfigManager) {
    this.#manager = configManager
    this.root = join(configManager.paths.data_dir, RECORDINGS_DIR)
  }

  // ------------------------------------------------------------ the switch

  /** config.recording.active */
  get active(): boolean {
    return this.#manager.getConfig().recording.active
  }

  /** The session in hand, which is the one replay reads as well: config.session, or
   *  DEFAULT_SESSION when it is empty */
  get session(): string {
    return this.#manager.getConfig().session || DEFAULT_SESSION
  }

  /**
   * Record from here on. A session given (any string, '' included) is checked and becomes the
   * current one first; null or undefined keeps the current one. A bad name rejects with
   * UserError and changes nothing.
   *
   * A session given switches the current one first, so that what is being recorded is what a
   * replay started afterwards reads back; without one the calls are filed under the session
   * already in hand.
   */
  async start(session?: string | null): Promise<RecordingStatus> {
    const chosen = session === null || session === undefined ? null : sessionName(session)
    this.#manager.updateConfig(
      chosen === null
        ? { recording: { active: true } }
        : { recording: { active: true }, session: chosen },
    )
    log.info(`Recording passthrough traffic into session ${this.session}`)
    return this.status()
  }

  /** Stop recording. The session stays where it is, for replay to read */
  async stop(): Promise<RecordingStatus> {
    this.#manager.updateConfig({ recording: { active: false } })
    log.info('Recording stopped')
    return this.status()
  }

  /** What `GET /__admin__/record`, health and the panel's header report */
  async status(): Promise<RecordingStatus> {
    const session = this.session
    return { active: this.active, session, count: await this.count(session) }
  }

  // ------------------------------------------------------------ writing

  /** Queue the exchange's file if recording is on: the absolute path, or null when off or
   *  unwritable. The switch is read here only */
  save(exchange: Exchange): string | null {
    return this.active ? this.write(exchange, this.session) : null
  }

  /**
   * Queue the exchange's file whatever the switch says: the absolute path, or null.
   *
   * It never throws. An exchange nothing can write is logged and dropped rather than thrown: the
   * request it belongs to has already been answered, and a recording is never worth costing a
   * client its reply.
   */
  write(exchange: Exchange, session: string): string | null {
    let op: WriteOp
    try {
      op = this.#prepare(exchange, session)
    } catch (error) {
      const { method, host, path } = exchange.request
      log.warning(`Could not record ${method} ${host}${path}: ${reasonOf(error)}`)
      return null
    }
    this.#enqueue(op)
    this.#forget(session)
    return op.path
  }

  /**
   * Write exchanges recorded elsewhere into a session (default DEFAULT_SESSION), as CI does, each
   * under its own seq. Resolves with the count once the files are on disk. Rejects with
   * UserError: a bad session name, or a bad entry.
   *
   * Every entry becomes a file before any of them is written, so one malformed entry leaves the
   * session it was aimed at exactly as it was: replace empties the session only once every entry
   * has passed. An entry is read the way parseExchange reads any exchange, leniently, so what
   * imports is what replays.
   */
  async importExchanges(
    exchanges: readonly unknown[],
    session?: string | null,
    replace = false,
  ): Promise<number> {
    const chosen = sessionName(session)
    const prepared: WriteOp[] = []
    for (const data of exchanges) {
      if (!isJsonObject(data)) throw new UserError('each entry has to be an exchange object')
      let exchange: Exchange
      try {
        exchange = parseExchange(data)
      } catch (error) {
        // A field of the wrong type — `request` as a string, or a method that is a list — is the
        // caller's mistake like any other here, so it has to be told in the same terms rather
        // than thrown at them
        if (error instanceof ValidationError) {
          throw new UserError(`an exchange field has the wrong shape: ${error.message}`)
        }
        throw error
      }
      // What this throws goes out as it is, with nothing written: only a body nested thousands
      // deep, made by hand, makes JSON.stringify throw, and that is a bug to answer with a 500
      prepared.push(this.#prepare(exchange, chosen))
    }

    await this.#whenIdle(() => {
      if (replace) this.#deleteNow(chosen)
      for (const op of prepared) this.#enqueue(op)
      this.#forget(chosen)
    })
    await this.flush()
    return prepared.length
  }

  /**
   * Remove one session's recordings, or every session's when session is null, undefined or ''.
   * Resolves with how many files there were.
   *
   * It waits for the queue as a read does, so the writes queued before it, and those queued while
   * it waits, land and go with the rest; a write after it resolves stays. '' is every session, and
   * so every session's index is dropped.
   */
  delete(session?: string | null): Promise<number> {
    return this.#whenIdle(() => this.#deleteNow(session || null))
  }

  // ------------------------------------------------------------ reading

  /**
   * One row per recorded call, from the index over the directory, sorted by session then seq.
   *
   * `key` is a rule key, so `GET:/api/feed` selects that path on every host the way a rule
   * written that way would answer it. A bad key rejects with a UserError, which the API turns
   * into a 400. `session: ''` is the directory named `_`: only null or undefined means every
   * session.
   */
  async index(filters: RecordingFilters = {}): Promise<RecordingRow[]> {
    const { session, key, host } = filters
    // Read before the queue is waited for, so that a bad key is refused before anything is
    // walked
    const parsed = key ? parseKey(key) : null
    return this.#whenIdle(() =>
      this.#entries(session ?? null)
        .filter(
          (call) =>
            (!host || hostMatches(host, call.host)) &&
            (parsed === null || keyMatches(parsed, call.method, call.host, call.port, call.path)),
        )
        .map(recordedCallRow)
        .sort((a, b) => (a.session < b.session ? -1 : a.session > b.session ? 1 : a.seq - b.seq)),
    )
  }

  /**
   * The recordings a replay may choose from, oldest first: by method, host and path exactly;
   * only when that finds nothing, by `key`'s pattern. A key that is not a rule key gives no
   * fallback, and never rejects. What comes back is a new array of the index's own calls, to be
   * read only.
   *
   * Located by the host and path actually being called: a rule written
   * `GET:*.example.com/api/feed` answers for a family of hosts, and what was recorded for the one
   * being called is the better answer. Only when that finds nothing does the rule's own pattern
   * stand in, which is what makes a wildcard rule replay at all.
   */
  samples(
    session: string,
    method: string,
    host: string,
    path: string,
    key?: string | null,
  ): Promise<RecordedCall[]> {
    return this.#whenIdle(() => {
      const entries = this.#entries(session)
      const found = entries.filter(
        (call) => call.method === method && call.host === host && call.path === path,
      )
      if (found.length > 0 || !key) return found
      // The one key that does not read here is the one core builds from a request no rule
      // answers, whose method is not all letters (M-SEARCH:h/x): a rule's key was normalised as
      // it was stored, and RecordingReader reads a script's own key before it gets here. Such a
      // key is no pattern, so nothing stands in: no recording, which core answers with a 404
      let parsed: Key
      try {
        parsed = parseKey(key)
      } catch (error) {
        if (error instanceof UserError) return found
        throw error
      }
      return entries.filter((call) =>
        keyMatches(parsed, call.method, call.host, call.port, call.path),
      )
    })
  }

  /** The full exchange behind an index row — the answer replay sends back. null, with a warning,
   *  when the file is gone or unreadable */
  load(call: RecordedCall): Promise<Exchange | null> {
    return this.#whenIdle(() => this.#read(call.file))
  }

  /** One recorded call in full, by the seq it was answered under: the first in the index's order
   *  when two endpoints share that seq; null when the session has no such call */
  get(session: string, seq: number): Promise<Exchange | null> {
    return this.#whenIdle(() => {
      const call = this.#entries(session).find((entry) => entry.seq === seq)
      return call === undefined ? null : this.#read(call.file)
    })
  }

  /** How many calls this session holds */
  count(session: string): Promise<number> {
    return this.#whenIdle(() => this.#entries(session).length)
  }

  /**
   * Every session on disk and how many calls it holds, sorted by name, for `tunnel session`.
   *
   * A session nobody has recorded into yet is not a directory, so it is not here; the one in
   * hand is worth naming anyway, which the caller does. A directory made by hand whose name is
   * not a session name is listed too, with what the session its name cleans to holds.
   */
  sessions(): Promise<Record<string, number>> {
    // fromEntries makes a session named __proto__ a key like any other
    return this.#whenIdle(() =>
      Object.fromEntries(this.#sessionNames().map((name) => [name, this.#entries(name).length])),
    )
  }

  // ------------------------------------------------------------ the writer

  /**
   * Resolves once every queued write is on disk, those queued while it waits included: the wait
   * before every read, and on shutdown.
   *
   * A call recorded a moment ago has to be one the index shows. Replay reads the index as well,
   * so unlike the admin port's reads this wait sits on the path a device's request takes; only
   * recording and replaying at the same time gives it anything to wait for.
   */
  flush(): Promise<void> {
    return this.#whenIdle(() => undefined)
  }

  /** For shutdown: flush, waiting 5 seconds at most. What is recorded after it is written all the
   *  same */
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

  /**
   * fn, once no write is queued: every read, delete and import goes through this, so whatever was
   * queued before it is on disk by the time fn looks.
   *
   * The check and fn are one stretch of synchronous code, with no await in between. Written as
   * `await this.flush(); return fn()`, a microtask would separate the moment the queue was found
   * empty from fn: another caller waiting for the same queue, a writer that waits for it as an
   * import does, could queue a write in it and drop the session's index, and fn would walk the
   * directory before that write was on disk and keep what it found. The call would stay unseen
   * until this store next changed the session.
   *
   * With nothing queued fn runs as this is called, and sees the disk as it is then. What fn throws
   * rejects the promise, as this is async.
   */
  async #whenIdle<T>(fn: () => T): Promise<T> {
    while (this.#draining !== null) await this.#draining
    return fn()
  }

  /**
   * Where this exchange goes and what goes in it; throws on anything that cannot be written.
   *
   * The text is made now, as the call is recorded, rather than when the queue gets to it: the
   * exchange is the very object the request log keeps, and nothing done to it afterwards should
   * reach the file. A lone surrogate is written as its escape, which parseJson reads back, rather
   * than refused.
   */
  #prepare(exchange: Exchange, session: string): WriteOp {
    const { method, host, path } = exchange.request
    return {
      path: join(this.root, filePath(session, method, host, path, exchange.seq)),
      text: formatRecording(exchange),
    }
  }

  #enqueue(op: WriteOp): void {
    this.#ops.push(op)
    // Started only right after a push, never with the queue empty: its first round always awaits,
    // so the promise assigned here is still pending, and its finally, which sets #draining back
    // to null, comes after the assignment. Started with nothing queued, the finally would come
    // first and leave #draining holding a settled promise, which #whenIdle would wait on forever
    this.#draining ??= this.#drain()
  }

  /**
   * Writes what is queued, in order, until nothing is: each file opened afresh, through a symlink
   * if it is one, and written over if it is there. A write that fails is a warning, and the next
   * one is tried all the same; the promise this returns never rejects.
   *
   * Nothing may stop it: every read waits for it to be done, so a queue that died of one
   * recording would leave the admin port waiting over all the rest.
   */
  async #drain(): Promise<void> {
    try {
      for (let op = this.#ops.shift(); op !== undefined; op = this.#ops.shift()) {
        try {
          await mkdir(dirname(op.path), { recursive: true })
          await writeFile(op.path, op.text)
        } catch (error) {
          log.warning(`Could not write the recording ${op.path}: ${reasonOf(error)}`)
        }
      }
    } finally {
      this.#draining = null
    }
  }

  /** A session removed, or every session (null), once nothing is queued, for delete and for an
   *  import with replace: drop its index, count the files the walk finds there, and remove the
   *  directory. What cannot be removed stays and is counted all the same */
  #deleteNow(session: string | null): number {
    this.#forget(session)
    const base = session === null ? this.root : join(this.root, safeSegment(session))
    if (!isDirectory(base)) return 0
    const removed = jsonFiles(base).length
    try {
      // A session that is itself a symlink loses the link and keeps what it points to
      rmSync(base, { recursive: true, force: true })
    } catch {
      // Swallowed: what cannot be removed stays
    }
    return removed
  }

  /** Drop the index for a session this store just changed, or for all of them (null) */
  #forget(session: string | null): void {
    if (session === null) this.#index.clear()
    else this.#index.delete(safeSegment(session))
  }

  /** The names under root that are directories, or symlinks to one, sorted: the sessions */
  #sessionNames(): string[] {
    if (!isDirectory(this.root)) return []
    return readdirSync(this.root)
      .filter((name) => isDirectory(join(this.root, name)))
      .sort()
  }

  /**
   * One session's recordings, or every session's (null), from the index; the cached array
   * itself, for the caller to read only.
   *
   * The walk happens once per session: whoever calls this does so inside #whenIdle, so nothing is
   * still being written, and every write and delete here drops what it changed, so what comes
   * back is what is on disk.
   */
  #entries(session: string | null): RecordedCall[] {
    if (session === null) return this.#sessionNames().flatMap((name) => this.#entries(name))
    const name = safeSegment(session)
    let cached = this.#index.get(name)
    if (cached === undefined) {
      cached = this.#scan(name)
      this.#index.set(name, cached)
    }
    return cached
  }

  /** Read one session's files into index rows, oldest call first; calls under the same seq stay
   *  in the order of the walk, as sort is stable */
  #scan(name: string): RecordedCall[] {
    const base = join(this.root, name)
    if (!isDirectory(base)) return []
    const calls: RecordedCall[] = []
    for (const file of jsonFiles(base)) {
      const exchange = this.#read(file)
      if (exchange !== null) calls.push(recordedCallOf(name, exchange, file))
    }
    return calls.sort((a, b) => a.seq - b.seq)
  }

  /** The exchange in this file, or null and a warning when any step of reading it fails: the
   *  bytes, UTF-8, JSON, or the shape of an exchange. One bad file costs only itself */
  #read(file: string): Exchange | null {
    try {
      return parseExchange(parseJson(UTF8.decode(readFileSync(file))))
    } catch (error) {
      log.warning(`Skipping an unreadable recording ${file}: ${reasonOf(error)}`)
      return null
    }
  }
}

// ---------------------------------------------------------------- what a script reads

/**
 * One recording as a script sees it: the answer, and the call that got it.
 *
 * Plain JSON data: it crosses a thread as JSON.stringify text read back with parseJson, never by
 * structured clone, which throws on a big integer. Every read makes one of its own from what is on
 * disk, so a handler can rewrite the body it is about to hand back without the next request seeing
 * the change. Returning the object from `handler(ctx)` sends its status, headers and body; how a
 * value a script returns is known for one is script-context.ts's to say.
 */
export interface Recorded {
  seq: number
  // 0 when there was no response, and a call with none is never handed to a script. A file edited
  // by hand to "response": {} has a response, all defaults, and is handed over with status 0
  status: number
  headers: Record<string, string>
  body: JsonValue // a JSON body is the value itself, so a script edits fields
  request: ExchangeRequest
  // How `body` was stored, which is what turns it back into bytes: a JSON body is an object a
  // script can edit, a binary one is base64 text
  body_encoding: BodyEncoding | null
}

/**
 * The Recorded of an exchange. Takes the exchange's parts as they are: pass one nobody else holds
 * (load() reads a fresh one).
 *
 * Nothing is copied, and what a script does to the body still cannot reach the next request:
 * RecordingReader reads every exchange afresh from its file with load(), and nobody else holds
 * that one, so a copy would be one more for nothing. The exchanges that are shared are the request
 * log's, kept in memory and handed to whoever asks; a recording never comes from there.
 */
export function recordedOf(exchange: Exchange): Recorded {
  const answer = exchange.response
  return {
    seq: exchange.seq,
    status: answer?.status ?? 0,
    headers: answer?.headers ?? {},
    body: answer?.body ?? null,
    request: exchange.request,
    body_encoding: answer?.body_encoding ?? null,
  }
}

/**
 * A Recorded's body as it goes on the wire, however the script left it. A Uint8Array body as it
 * is; an object or array as stringifySpaced writes it; the rest through
 * decodeBody(body, body_encoding).
 *
 * The branch for an object or an array gives the very bytes decodeBody would, which writes any
 * body that is not a string the same way.
 */
export function recordedBytes(recorded: {
  body: JsonValue | Uint8Array
  body_encoding: string | null
}): Buffer {
  const { body, body_encoding } = recorded
  // Before isJsonObject, which a Uint8Array passes as well. A Buffer goes back as it is, any other
  // Uint8Array as a Buffer over the same memory
  if (body instanceof Uint8Array) {
    return Buffer.isBuffer(body) ? body : Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  }
  if (Array.isArray(body) || isJsonObject(body)) {
    return Buffer.from(stringifySpaced(body), 'utf8')
  }
  return decodeBody(body, body_encoding)
}

/** What ctx.recorded() and ctx.recordings() ask for. null, undefined and '' are "not given" */
export interface RecordedLookup {
  /** one() only; null is {}, so the caller passes the request's own */
  query?: Readonly<Record<string, string>> | null
  key?: string | null
  session?: string | null
}

/**
 * The recordings one scripted request may read, found the way replay finds them. One per request.
 *
 * It reads through the store as replay does: once the queue of writes is empty, on the event loop.
 * How a script asks it, from a worker or not, is script.ts's and script-function.ts's to say.
 */
export class RecordingReader {
  readonly #store: RecordingStore
  readonly #request: Pick<Request, 'method' | 'host' | 'path'>
  readonly #rule: Pick<TunnelRequestConfig, 'request_key' | 'replay_session'>
  readonly #currentSession: string

  constructor(
    store: RecordingStore,
    request: Pick<Request, 'method' | 'host' | 'path'>,
    rule: Pick<TunnelRequestConfig, 'request_key' | 'replay_session'>,
    currentSession: string, // config.session as it is ('' allowed)
  ) {
    this.#store = store
    this.#request = request
    this.#rule = rule
    this.#currentSession = currentSession
  }

  /** The sample match would choose, or null: the newest whose query is lookup.query (null is
   *  {}), else the newest. A bad key rejects with UserError, for the script to see */
  async one(lookup: RecordedLookup = {}): Promise<Recorded | null> {
    const samples = await this.#samples(lookup.key, lookup.session)
    return this.#load(chooseSample(samples, 'match', lookup.query ?? null))
  }

  /** Every recording of the endpoint, oldest first; those without a response are left out */
  async all(lookup: Omit<RecordedLookup, 'query'> = {}): Promise<Recorded[]> {
    const samples = await this.#samples(lookup.key, lookup.session)
    const loaded = await Promise.all(samples.map((call) => this.#load(call)))
    return loaded.filter((recorded) => recorded !== null)
  }

  /** The samples of one endpoint, oldest first: this request's, or the key's. async, so that a
   *  key that does not read rejects, for the script to see, rather than throws */
  async #samples(key?: string | null, session?: string | null): Promise<RecordedCall[]> {
    const where = session || this.#rule.replay_session || this.#currentSession || DEFAULT_SESSION
    if (!key) {
      const { method, host, path } = this.#request
      return this.#store.samples(where, method, host, path, this.#rule.request_key)
    }
    // A key of the script's own is looked up the same way a rule's is: by
    // the host and path it names, and by its pattern when it names none.
    const parsed = parseKey(key)
    return this.#store.samples(where, parsed.method, parsed.host, parsed.path, key)
  }

  /** What a script gets of one sample: null for none, for a file that cannot be read, and for a
   *  call that went unanswered */
  async #load(call: RecordedCall | null): Promise<Recorded | null> {
    const exchange = call === null ? null : await this.#store.load(call)
    return exchange === null || exchange.response === null ? null : recordedOf(exchange)
  }
}
