// What handler(ctx) is handed and what becomes of what it returns, for both places a handler runs:
// the script worker (script-worker.ts), and the main thread, which runs a function rule's handler
// itself, so that a script and a function are answered by one set of rules.
//
// It touches neither worker_threads nor BigInt.prototype: on the main thread the realm is the
// caller's when tunnel runs as a library. The worker writes a BigInt as its digits through the
// toJSON it gives BigInt.prototype in its own realm; this module writes one with a replacer,
// bigIntsAsDigits, which sees a value after its toJSON has run, so both threads write the same
// bytes.
import { reasonOf, repr } from './errors.ts'
import { stringifySpaced, type JsonValue } from './json.ts'
import { looksLikePython, PYTHON_HINT, ScriptSyntaxError } from './script-compile.ts'
import type { ScriptBody, ScriptRequest, ScriptReturn } from './script.ts'

/** JSON with what Node has had since 22.18 and TypeScript's lib does not declare yet: the
 *  reviver's third argument and JSON.rawJSON (json.ts makes the same view of them) */
export const RAW_JSON = JSON as unknown as {
  parse(
    text: string,
    reviver: (key: string, value: unknown, context: { source?: string }) => unknown,
  ): unknown
  rawJSON(text: string): object
}

/** UTF-8 that refuses bytes that are not */
const UTF8 = new TextDecoder('utf-8', { fatal: true })

/** Where an integer past 2^53 could start: json.ts's fast path, for the same reason */
const MIGHT_HOLD_A_BIG_INTEGER = /(?<![\d.eE])\d{16}/

/** parseScriptJson's reviver: an integer literal that is not a safe integer becomes a BigInt of
 *  its digits. Fractions and exponents stay numbers, as in json.ts */
function toBigInt(_key: string, value: unknown, context: { source?: string }): unknown {
  if (
    typeof value === 'number' &&
    !Number.isSafeInteger(value) &&
    context.source !== undefined &&
    /^-?\d+$/.test(context.source)
  ) {
    return BigInt(context.source)
  }
  return value
}

/** json.ts's parseJson for a script: an integer past 2^53 comes back as a BigInt, which a script
 *  can compare, print and keep in ctx.state, where a RawJson would be an object it could do
 *  nothing with. Text that is not JSON throws JSON.parse's SyntaxError */
export function parseScriptJson(text: string): unknown {
  if (!MIGHT_HOLD_A_BIG_INTEGER.test(text)) return JSON.parse(text)
  return RAW_JSON.parse(text, toBigInt)
}

/** JSON.stringify's replacer for what a handler hands back: a BigInt is written as its digits, which
 *  parseScriptJson reads back as one. In the worker, the toJSON it gives BigInt.prototype has
 *  already made a BigInt its digits by the time a replacer sees it; on the main thread nothing has */
export function bigIntsAsDigits(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? RAW_JSON.rawJSON(value.toString()) : value
}

/** JSON.stringify for a handler's values, BigInts among them, on either thread */
export function stringifyScriptJson(value: unknown): string {
  return JSON.stringify(value, bigIntsAsDigits)
}

/** ctx.json: the body read as JSON, or null when there is none or it is not UTF-8 JSON. A UTF-8 BOM
 *  is read past */
export function parseBody(body: Uint8Array): unknown {
  if (body.length === 0) return null
  try {
    return parseScriptJson(UTF8.decode(body))
  } catch {
    return null
  }
}

/** Whether this is an object such as a literal, JSON.parse() or Object.create(null) makes: what
 *  ctx.reply takes for headers, and what a function handler may put in ctx.state's place */
export function isPlainObject(value: unknown): value is object {
  if (typeof value !== 'object' || value === null) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** What ctx.reply() makes: a body, a status and headers in one value, which as an array would be no
 *  different from a list. This throws a TypeError in the script for a status Node's http would
 *  refuse or a header that is not a string, so the script's 500 names the line that called it.
 *  undefined and null are "none given" */
export class Reply {
  readonly body: unknown
  readonly status: number | null = null
  readonly headers: Record<string, string> | null = null
  constructor(body: unknown, status: unknown, headers: unknown) {
    this.body = body
    if (status != null) {
      // Node's http writes a status of 100 to 999 and refuses any other
      if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 999) {
        // A string quoted, so that '200' is told from 200
        const shown = typeof status === 'string' ? repr(status) : String(status)
        throw new TypeError(
          `ctx.reply: status must be an integer between 100 and 999, not ${shown}`,
        )
      }
      this.status = status
    }
    if (headers != null) {
      // As an object literal, ctx.headers or JSON.parse() makes one. A Map or a Headers keeps its
      // entries where Object.entries does not look, so it would be no headers at all
      if (!isPlainObject(headers)) throw new TypeError('ctx.reply: headers must be a plain object')
      for (const [name, value] of Object.entries(headers)) {
        if (typeof value !== 'string') {
          throw new TypeError(`ctx.reply: header ${name} must be a string`)
        }
      }
      this.headers = headers as Record<string, string>
    }
  }
}

/** One recording as ctx.recorded() and ctx.recordings() hand it to a script: recordings.ts's
 *  Recorded, made afresh from the main thread's JSON on every call, so that what one request's
 *  script changes in it is no other request's to see. A class rather than a plain object so that
 *  a handler that returns one is told from one that returns any other object: its status, headers
 *  and body, as the script left them, are the answer */
export class Recorded {
  seq: unknown
  status: unknown
  headers: unknown
  body: unknown // a JSON body is the value itself, so a script edits fields
  request: unknown
  body_encoding: unknown
  constructor(fields: object) {
    Object.assign(this, fields)
  }
}

/** What ctx.recorded() and ctx.recordings() take, as one options object. undefined and null are
 *  "not given" */
export interface RecordedOptions {
  query?: Record<string, string> | null // ctx.recorded() only; not given is the request's own
  key?: string | null
  session?: string | null
}

/** The ctx handler(ctx) is handed, the one ctx of both places a handler runs. `request` is what
 *  scriptRequest() (script.ts) makes of the request, copies a handler may change without changing
 *  what the log keeps; `state` is the rule's ctx.state; and ctx.recorded() and ctx.recordings() are
 *  each thread's own, since each reads the recordings its own way: the worker asks the main thread
 *  and waits for the answer blocked, and the main thread hands back promises */
export function handlerContext<One, All>(
  request: ScriptRequest,
  state: unknown,
  lookups: {
    recorded: (options?: RecordedOptions) => One
    recordings: (options?: Omit<RecordedOptions, 'query'>) => All
  },
) {
  return {
    method: request.method,
    path: request.path,
    query: request.query,
    headers: request.headers,
    // A Buffer, for its toString(), over the bytes that are the request's copy
    body: Buffer.from(request.body.buffer, request.body.byteOffset, request.body.byteLength),
    json: parseBody(request.body),
    state,
    // Where the request was really going, which a script needs as soon as one rule answers for
    // several hosts
    scheme: request.scheme,
    host: request.host,
    port: request.port,
    url: request.url,
    client: request.client,
    recorded: lookups.recorded,
    recordings: lookups.recordings,
    // An arrow function, as the two above are: a script may take any of them off ctx
    // (const { reply } = ctx) and still call it
    reply: (body: unknown, status?: unknown, headers?: unknown) => new Reply(body, status, headers),
  }
}

/** What the handler returned, the way the main thread answers it: ctx.reply's status and headers,
 *  null where it gave none, and the body by its kind. Throws what JSON.stringify throws */
export function toReturn(value: unknown): ScriptReturn {
  if (value instanceof Reply) {
    return { status: value.status, headers: value.headers, body: toBody(value.body) }
  }
  return { status: null, headers: null, body: toBody(value) }
}

/** A returned body by its kind. A Reply inside a Reply is an object like any other */
function toBody(value: unknown): ScriptBody {
  // A recording answers with its own status, headers and body, which the main thread reads from
  // this JSON. Bytes the script put in its body go beside the JSON rather than in it, copied as
  // returned bytes are, below
  if (value instanceof Recorded) {
    const bytes = value.body instanceof Uint8Array ? new Uint8Array(value.body) : null
    const { seq, status, headers, body, request, body_encoding } = value
    const json = stringifyScriptJson({
      seq,
      status,
      headers,
      body: bytes === null ? body : null,
      request,
      body_encoding,
    })
    return { kind: 'recorded', json, bodyBytes: bytes }
  }
  if (value == null) return { kind: 'none' }
  // Bytes, as they are: a Uint8Array (a Buffer is one) or an ArrayBuffer. Copied into an
  // ArrayBuffer exactly as long, which then moves to the main thread rather than being copied
  // again: a Buffer's own may be a pool its neighbours sit in, and Buffer.prototype.slice is a
  // view of it
  if (value instanceof Uint8Array) return { kind: 'bytes', bytes: new Uint8Array(value) }
  if (value instanceof ArrayBuffer) return { kind: 'bytes', bytes: new Uint8Array(value.slice(0)) }
  // Any object, arrays included, as JSON.stringify writes it
  if (typeof value === 'object') {
    return { kind: 'json', text: stringifySpaced(value as JsonValue, bigIntsAsDigits) }
  }
  // Text: a string as it is; a number, boolean, BigInt, symbol or function as String() writes it
  return { kind: 'text', text: String(value) }
}

/** What a 500 or a log line shows of what a script threw. `source` is the script's, for the Python
 *  hint, when the error is a ScriptSyntaxError */
export function stackOf(error: unknown, source = ''): string {
  // A script that does not compile: the parser's lines, which end with its SyntaxError line, and
  // for a Python script the sentence compileScript adds to its 400 as well
  if (error instanceof ScriptSyntaxError) {
    return looksLikePython(source) ? `${error.detail}\n${PYTHON_HINT}` : error.detail
  }
  // Anything thrown that is no Error as reasonOf writes it, which is String() but for what String()
  // cannot write, an object with no prototype: thrown here, that would be an error in the middle of
  // reporting one, and in a promise's rejection handler, the end of the process
  return error instanceof Error ? (error.stack ?? String(error)) : reasonOf(error)
}
