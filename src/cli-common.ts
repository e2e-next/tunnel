// What the tunnel command's modules share: the outside world they are handed (CliIo, CliDeps),
// the two errors a command ends with, printing, finding the server that a pid file describes,
// calling its admin API, reading the files a user names, and sending check's request through the
// proxy port with the CA it is checked against. The command modules import it rather than one
// another, and src/mcp.ts builds its tools on it.
//
// Nothing here reads process.stdout, process.env or process.cwd() but defaultDeps(), which the
// entry points call once: every other function is handed io and deps.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import * as http from 'node:http'
import { isIP } from 'node:net'
import { isAbsolute } from 'node:path'
import type { Duplex, Readable, Writable } from 'node:stream'
import * as tls from 'node:tls'
import { CertificateAuthority } from './certs.ts'
import type { Args } from './cli-args.ts'
import { type Paths, resolvePaths } from './config.ts'
import { reasonOf, repr, UserError } from './errors.ts'
import { redactHeaders } from './exchanges.ts'
import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
  parseJson,
  stringifySpaced,
} from './json.ts'
import { type LogSink, setLogSink } from './log.ts'
// Types alone, and as a whole `import type` statement, which is erased: mcp.ts imports this
// module, and the inline `import { type … }` would leave an import of mcp.ts behind at run time
import type { buildTools, serveStdio } from './mcp.ts'
import { urlencode } from './messages.ts'
import { DEFAULT_REDACT_HEADERS, type TunnelConfig } from './models.ts'

/** How the CLI reaches the admin port. The global fetch is one; a test passes the admin app's
 *  request() (makeAdminEnv(t)'s fetch) */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>
/** What ca install reads of spawnSync's result. For a command that is not there, stdout and
 *  stderr are undefined, which the type does not say: read them with `?? ''` */
export type RunResult = Pick<
  SpawnSyncReturns<string>,
  'status' | 'signal' | 'stdout' | 'stderr' | 'error'
>
export interface CliIo {
  stdin: Readable
  stdout: Writable
  stderr: Writable
}
export interface CliDeps {
  fetch: Fetch // the one way to the admin port (check's request through the proxy port aside)
  env: Readonly<Record<string, string | undefined>> // TUNNEL_BASE, TUNNEL_CONFIG_DIR, XDG_*,
  // COLUMNS; also the environment of a server started in the background
  cwd: string // where relative paths, the walk up to .tunnel/ and init start; also the cwd of a
  // server started in the background
  run: (command: readonly string[]) => RunResult // ca install's platform tools
  /** tunnel mcp's two functions: cmdMcp uses the ones cli.ts imports when not given, and
   *  defaultDeps() does not give them, since this module importing mcp.ts at run time would be a
   *  cycle. A test swaps them */
  mcp?: { buildTools: typeof buildTools; serveStdio: typeof serveStdio }
  /** How check's request goes through the proxy port: sendThroughProxy when not given, and
   *  defaultDeps() does not give it. A test swaps it */
  throughProxy?: (request: ProxiedRequest) => Promise<ProxiedAnswer>
}

/** The real ones: the global fetch, process.env, process.cwd() and spawnSync. Called only at the
 *  edge: main() fills in what it was not given with them, and so does tunnel mcp's entry */
export function defaultDeps(): CliDeps {
  return {
    fetch: (url, init) => fetch(url, init),
    env: process.env,
    cwd: process.cwd(),
    run: (command) => spawnSync(command[0]!, command.slice(1), { encoding: 'utf8' }),
  }
}

/** A command's handler. Returning nothing is exit code 0 */
export type CommandHandler = (
  args: Args,
  io: CliIo,
  deps: CliDeps,
) => Promise<number | void> | number | void

/**
 * An error a command expects: one line on stderr, no stack, and exitCode as the exit code, so
 * that a script can tell the failures apart: 1 for a user error, 2 for a server that is not
 * there (CannotConnect). main() prints any other UserError from the modules below the same way,
 * with 1.
 */
export class CliError extends UserError {
  override name = 'CliError'
  readonly exitCode: number = 1
}

/** Nothing is answering where the admin API was expected */
export class CannotConnect extends CliError {
  override name = 'CannotConnect'
  override readonly exitCode: number = 2
}

/** Whether error is one the operating system gave, which a command turns into one line: a system
 *  error carries the errno's code and the call that failed. Node's own errors carry a code
 *  (ERR_…) but no syscall, and stay a stack trace */
export function isSystemError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    typeof (error as NodeJS.ErrnoException).code === 'string' &&
    typeof (error as NodeJS.ErrnoException).syscall === 'string'
  )
}

export const TIMEOUT_MS = 10_000
export const HEALTH_TIMEOUT_MS = 2_000 // health()'s timeout
export const DEFAULT_ADMIN_PORT = 8000
export const FALLBACK_BASE = `http://127.0.0.1:${DEFAULT_ADMIN_PORT}`

/** With --json the data as JSON, else the lines meant for a person (none when null) */
export function print(
  io: CliIo,
  data: JsonValue,
  asJson: boolean,
  lines?: readonly string[] | null,
): void {
  if (asJson) io.stdout.write(`${JSON.stringify(data, null, 2)}\n`)
  else if (lines != null) io.stdout.write(lines.map((line) => `${line}\n`).join(''))
}

/** Errors go out the way the output does, a line of JSON for a script and a line of text for a
 *  person, on stderr either way */
export function printError(io: CliIo, error: UserError, asJson: boolean): void {
  if (asJson) {
    const exitCode = error instanceof CliError ? error.exitCode : 1
    io.stderr.write(`${stringifySpaced({ error: error.message, exit_code: exitCode })}\n`)
  } else {
    io.stderr.write(`error: ${error.message}\n`)
  }
}

/** What `serve --background` writes to tunnel.pid; a record written by hand may lack the ports */
export interface PidRecord {
  pid: number
  admin_port?: number
  proxy_port?: number
}

/**
 * What `serve --background` left here, or null when nothing was started (no file, not JSON, not
 * an object with a pid). tunnel writes the file itself and puts no user data in it, so it is read
 * with plain JSON.parse.
 *
 * A pid that is not a whole number from 1 to 2^31 - 1 is no record either: 0 would signal the
 * whole process group of whoever runs `tunnel stop`, and past 2^31 - 1 process.kill throws, from
 * every command, since every command reads this file.
 */
export function readPidFile(paths: Paths): PidRecord | null {
  let record: unknown
  try {
    record = JSON.parse(readFileSync(paths.pidFile, 'utf8'))
  } catch {
    // Not there or not readable, or not JSON
    return null
  }
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return null
  const { pid } = record as { pid?: unknown }
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 1 || pid > 2 ** 31 - 1) {
    return null
  }
  return record as PidRecord
}

/** Where the server a pid record describes answers */
export function recordBase(record: PidRecord): string {
  // Only a missing key falls back
  const port = record.admin_port === undefined ? DEFAULT_ADMIN_PORT : record.admin_port
  return `http://127.0.0.1:${port}`
}

/**
 * Whether that process is still there. Signal 0 asks without sending anything. EPERM means it is
 * someone else's, which is still a process. Windows has no signal 0, so there it counts as alive
 * and the health check has the last word. There is no waitpid here: Node collects its own
 * children.
 */
export function processAlive(pid: number): boolean {
  if (process.platform === 'win32') return true
  try {
    process.kill(pid, 0)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    throw error
  }
  return true
}

/**
 * Where the CLI looks for the admin API when --base is not given. TUNNEL_BASE when it is not
 * empty; else the server `serve --background` left a record of in the state directory, if that
 * process is alive, so that one started on another port is found without --base; else 8000.
 */
export function defaultBase(deps: Pick<CliDeps, 'env' | 'cwd'>): string {
  const explicit = deps.env.TUNNEL_BASE
  if (explicit) return explicit
  const record = readPidFile(resolvePaths({ env: deps.env, cwd: deps.cwd }))
  if (record !== null && processAlive(record.pid)) return recordBase(record)
  return FALLBACK_BASE
}

// ---- The admin API ----

/** The URL of an admin route on the server at base, whatever / base ends in */
export function api(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/__admin__${path}`
}

/** The codes a fetch fails with when it never reached a server: refused, no such host, no route,
 *  and undici's own connect timeout of 10 s (measured on Node 22, 24 and 26) */
const CONNECT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EHOSTDOWN',
  'ENETDOWN',
  'EADDRNOTAVAIL',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
])

/**
 * Whether a request failed because nothing answers: fetch never connected (a TypeError whose cause
 * has one of the codes above; for localhost the cause is an AggregateError of the two stacks'
 * refusals, with the code on it as well), or AbortSignal.timeout ran out. The timeout counts
 * whether it cut short the connect or the wait for an answer: at an address that drops packets it
 * races undici's own connect timeout, either may come first, and nothing answering has to be exit
 * 2 every time. An answer cut off halfway (ECONNRESET, UND_ERR_SOCKET) is not this, nor is a base
 * that is not a URL.
 */
function connectFailed(error: unknown): boolean {
  if (error instanceof Error && error.name === 'TimeoutError') return true
  if (!(error instanceof TypeError)) return false
  const code = (error.cause as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && CONNECT_CODES.has(code)
}

/** url with params as its query string, in place of any query it came with: a list is the key
 *  once per item, in order, and a space is a +. Params with nothing in them leave no query at all;
 *  no params leave the url as it is */
function withQuery(
  url: string,
  params: Readonly<Record<string, string | readonly string[]>> | null | undefined,
): string {
  if (params == null) return url
  const query = new URLSearchParams()
  for (const [name, value] of Object.entries(params)) {
    for (const item of typeof value === 'string' ? [value] : value) query.append(name, item)
  }
  const text = query.toString()
  const question = url.indexOf('?')
  const path = question === -1 ? url : url.slice(0, question)
  return text === '' ? path : `${path}?${text}`
}

/** What call() prints of an error answer: its detail as detailText writes it, or the text of the
 *  answer when it holds none (it is no JSON, JSON but no object, or an object without one) */
function errorDetail(text: string): string {
  let answer: JsonValue
  try {
    answer = parseJson(text)
  } catch {
    return text
  }
  return isJsonObject(answer) && Object.hasOwn(answer, 'detail') ? detailText(answer.detail!) : text
}

/**
 * One request to the admin API, and the JSON it answers with. params go into the query string (a
 * list as the key repeated, for wait -q), json is the body. The answer is read as text and parsed
 * with parseJson, since the bodies of mocks and recordings in it are user JSON.
 *
 * Nothing answering is CannotConnect, exit 2 (connectFailed); an answer of 400 or more is a
 * CliError with what the server said, exit 1. Anything else goes on as it is, a stack trace and
 * 1: an answer cut off halfway, or one under 400 that is no JSON.
 *
 * timeoutMs, TIMEOUT_MS unless given, is how long to wait for the answer. One that
 * AbortSignal.timeout cannot keep, not from 1 to 2^31 - 1 once rounded up, sets no limit rather
 * than throwing: whether `tunnel wait --timeout inf` makes sense is the admin API's to say.
 */
export async function call(
  deps: CliDeps,
  method: string,
  url: string,
  options: {
    params?: Readonly<Record<string, string | readonly string[]>> | null
    json?: JsonValue
    timeoutMs?: number
  } = {},
): Promise<JsonValue> {
  const { params, json, timeoutMs = TIMEOUT_MS } = options
  const init: RequestInit = { method }
  if (json !== undefined) {
    init.body = JSON.stringify(json)
    init.headers = { 'content-type': 'application/json' }
  }
  const limit = Math.ceil(timeoutMs)
  if (limit >= 1 && limit <= 2 ** 31 - 1) init.signal = AbortSignal.timeout(limit)
  let status: number
  let text: string
  try {
    const response = await deps.fetch(withQuery(url, params), init)
    status = response.status
    text = await response.text()
  } catch (error) {
    if (connectFailed(error)) {
      throw new CannotConnect(
        `nothing answers at ${url}; start the server with \`tunnel serve\`, or point --base at the one that is running`,
      )
    }
    throw error
  }
  if (status >= 400) throw new CliError(`the server answered ${status}: ${errorDetail(text)}`)
  return parseJson(text)
}

/** What the server at base reports of itself, or null when nothing answers there within
 *  HEALTH_TIMEOUT_MS, or something that is no tunnel does: not a 200, or not a JSON object */
export async function health(deps: CliDeps, base: string): Promise<JsonObject | null> {
  try {
    const response = await deps.fetch(api(base, '/health'), {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    })
    // Read whatever the answer is, so that the connection is done with either way
    const text = await response.text()
    if (response.status !== 200) return null
    const data = parseJson(text)
    return isJsonObject(data) ? data : null
  } catch {
    return null
  }
}

/**
 * A request key out of a method and a target, (GET, /api/feed) or (GET, api.example.com/api/feed).
 * A first segment that looks like a host, with a dot, a port or a wildcard in it, is kept as the
 * host; anything else is a path, which gets the leading / it lacks, so `tunnel set GET api/feed`
 * still means /api/feed.
 */
export function keyFor(method: string, target: string): string {
  const path =
    target.startsWith('/') || /[.:*]/.test(target.split('/', 1)[0]!) ? target : `/${target}`
  return `${method.toUpperCase()}:${path}`
}

/** The filters of `tunnel requests`, named after their dests, which is how requestParams reads
 *  them off the parsed arguments */
export interface RequestFilters {
  each?: boolean | null
  key?: string | null
  host?: string | null
  since?: number | null
  last?: number | null
  unmatched?: boolean | null
  encrypted?: boolean | null
  q?: string | null
}

/** The filters as the admin API takes them, in this order. Only a truthy value goes in, so
 *  `--since 0` is no --since at all; a flag goes in as 1 */
export function requestParams(filters: RequestFilters): Record<string, string> {
  const params: Record<string, string> = {}
  const names = ['each', 'key', 'host', 'since', 'last', 'unmatched', 'encrypted', 'q'] as const
  for (const name of names) {
    const value = filters[name]
    if (value) params[name] = value === true ? '1' : String(value)
  }
  return params
}

/**
 * Which headers to hide, as the server has them. One setting covers every client of the API. An
 * empty list there means hide nothing, which is why the default only stands in when the server
 * names no list at all.
 */
export async function redactNames(deps: CliDeps, base: string): Promise<string[]> {
  const config = (await call(deps, 'GET', api(base, '/config'))) as JsonObject
  return Object.hasOwn(config, 'redact_headers')
    ? (config.redact_headers as string[])
    : [...DEFAULT_REDACT_HEADERS]
}

/** The header values that carry a session hidden, in place, in the request and in the response.
 *  A part that is no object or an empty one, such as the null response of a tunnel nobody
 *  decrypted, is left alone; `--raw` skips all of this */
export function redact(exchange: JsonObject, names: readonly string[]): void {
  for (const part of [exchange.request, exchange.response]) {
    if (isJsonObject(part) && !isEmpty(part)) {
      part.headers = redactHeaders((part.headers ?? {}) as Record<string, string>, names)
    }
  }
}

/** The session in hand, and how much every session on disk holds; mode, session and
 *  recordings import all show it */
export async function sessions(deps: CliDeps, base: string): Promise<JsonObject> {
  return (await call(deps, 'GET', api(base, '/sessions'))) as JsonObject
}

/** The SSL Proxying Locations: the config's ssl_proxying, whole */
export type SslPolicy = TunnelConfig['ssl_proxying']

/** The locations as they stand; every ssl command reads, edits and saves them */
export async function sslPolicy(deps: CliDeps, base: string): Promise<SslPolicy> {
  const config = (await call(deps, 'GET', api(base, '/config'))) as unknown as {
    ssl_proxying: SslPolicy
  }
  return config.ssl_proxying
}

/** The locations sent back whole, and what the server kept of them */
export async function saveSslPolicy(
  deps: CliDeps,
  base: string,
  policy: SslPolicy,
): Promise<SslPolicy> {
  // A copy, since TypeScript takes an object literal for JSON and an interface not
  const data = (await call(deps, 'PATCH', api(base, '/config'), {
    json: { ssl_proxying: { ...policy } },
  })) as unknown as { config: { ssl_proxying: SslPolicy } }
  return data.config.ssl_proxying
}

/**
 * One of the two lists, with these patterns put in or taken out, set on policy, which comes back.
 * The admin API replaces ssl_proxying rather than merging into it, so whoever edits one list is
 * holding the other and can drop it by accident: this is a function so that the ssl commands and
 * the MCP decrypt tool do that read, edit and save the same way. A pattern to take out that is not
 * on the list is an error, before anything is saved: a typo far more often than a no-op worth
 * doing.
 */
export function sslPatch(
  policy: SslPolicy,
  which: 'include' | 'exclude',
  patterns: readonly string[],
  add: boolean,
): SslPolicy {
  const entries = [...policy[which]]
  for (const pattern of patterns) {
    if (add) {
      if (!entries.includes(pattern)) entries.push(pattern)
    } else if (entries.includes(pattern)) {
      entries.splice(entries.indexOf(pattern), 1)
    } else {
      throw new CliError(`${pattern} is not in the ${which} list`)
    }
  }
  policy[which] = entries
  return policy
}

// ---- A detail as text, stripping, string order and paths ----

/**
 * A JSON value as text, the way call() prints a 422's detail: a string as it is, anything else as
 * JSON on one line (stringifySpaced), an integer past 2^53 with all its digits.
 */
export function detailText(value: JsonValue): string {
  return typeof value === 'string' ? value : stringifySpaced(value)
}

/** Unicode white space and U+001C to U+001F: not String.prototype.trim's set, which leaves U+001C
 *  to U+001F and U+0085 and takes U+FEFF */
const SPACE_CHAR = /[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/

/** text with the white space of SPACE_CHAR taken off both ends */
export function stripSpace(text: string): string {
  let start = 0
  let end = text.length
  while (start < end && SPACE_CHAR.test(text.charAt(start))) start++
  while (end > start && SPACE_CHAR.test(text.charAt(end - 1))) end--
  return text.slice(start, end)
}

/** How two strings are ordered, for sort(): by code point. JS's < goes by UTF-16 code unit,
 *  which puts a character past U+FFFF before one from U+E000 to U+FFFF */
export function compareCodePoints(a: string, b: string): number {
  let i = 0
  while (i < a.length && i < b.length) {
    const x = a.codePointAt(i)!
    const y = b.codePointAt(i)!
    if (x !== y) return x < y ? -1 : 1
    // The same code point, so the same number of code units in both
    i += x > 0xffff ? 2 : 1
  }
  return a.length - b.length
}

/** A path taken apart: its root, '', '/' or '//' (exactly two slashes are a root of their own, as
 *  POSIX allows; three or more are '/'), and the names after it, without the empty ones and the
 *  '.' ones. A '..' stays a name */
function splitPath(text: string): { root: string; names: string[] } {
  const root = !text.startsWith('/') ? '' : /^\/\/(?!\/)/.test(text) ? '//' : '/'
  const names = text
    .slice(root.length)
    .split('/')
    .filter((name) => name !== '' && name !== '.')
  return { root, names }
}

/** The path a root and names make, or '.' when there is neither */
function formatPath(root: string, names: readonly string[]): string {
  return root + names.join('/') || '.'
}

/**
 * How the CLI prints most of the paths a user gives it, which is not the text as it was given. A
 * './' and a trailing '/' go, '//' inside it is '/', and '' is '.'; '..' is kept, not folded away.
 */
export function displayPath(text: string): string {
  const { root, names } = splitPath(text)
  return formatPath(root, names)
}

/** first and the names joined, where an absolute name starts over and no '/' is added after one
 *  already there, then displayPath */
export function joinPath(first: string, ...names: readonly string[]): string {
  let joined = first
  for (const name of names) {
    if (name.startsWith('/')) joined = name
    else if (joined === '' || joined.endsWith('/')) joined += name
    else joined += `/${name}`
  }
  return displayPath(joined)
}

/** The path without its last name, as displayPath prints it. A path with no names is its own */
export function parentPath(text: string): string {
  const { root, names } = splitPath(text)
  return formatPath(root, names.slice(0, -1))
}

// ---- What the user hands the CLI ----

/**
 * Where a path the user gave is, for the I/O: under deps.cwd unless it is absolute, and joined to
 * it as it is, a '..' in it left in. The system resolves it then, so sub/../x fails where sub is
 * not there and link/.. is where the link points to, not the directory the link is in; resolve()
 * and join() would take sub/.. away first.
 */
export function userPath(deps: Pick<CliDeps, 'cwd'>, path: string): string {
  return isAbsolute(path) ? path : `${deps.cwd}/${path}`
}

/**
 * The text of a file the user named, relative to deps.cwd. Strict UTF-8: bytes that are not throw
 * TextDecoder's TypeError, a stack trace and 1. A BOM at the start stays in the text, so parseJson
 * refuses it. \r\n and \r come out as \n.
 */
export function readUserText(deps: Pick<CliDeps, 'cwd'>, path: string): string {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  return decoder.decode(readFileSync(userPath(deps, path))).replace(/\r\n?/g, '\n')
}

/** JSON written out, or @file to read it from one, kept with its big integers */
export function readJsonArg(deps: CliDeps, value: string): JsonValue {
  let text = value
  if (value.startsWith('@')) {
    const source = value.slice(1)
    if (!existsSync(userPath(deps, source))) {
      throw new CliError(`no such file: ${displayPath(source)}`)
    }
    text = readUserText(deps, source)
  }
  try {
    return parseJson(text)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    throw new CliError(`that is not valid JSON: ${error.message}`)
  }
}

/** A scenario's script_file or json_file: null when it is missing or one of '', 0, false, null,
 *  [] and {}, and a TypeError when it is anything else but a string */
function fileName(value: JsonValue | undefined): string | null {
  if (value === undefined || value === null || value === '' || value === 0 || value === false) {
    return null
  }
  if (Array.isArray(value) ? value.length === 0 : isJsonObject(value) && isEmpty(value)) {
    return null
  }
  if (typeof value !== 'string') {
    throw new TypeError(`a scenario names a file with a string, not ${JSON.stringify(value)}`)
  }
  return value
}

function isEmpty(object: JsonObject): boolean {
  return Object.keys(object).length === 0
}

/**
 * A scenario file with its script_file and json_file read in. Both are found next to the scenario
 * file, and what they hold is what goes to the server: it reads no files of yours, so what is not
 * inlined here never arrives.
 *
 * A shape it cannot read throws a TypeError, a stack trace: mocks that are no list of objects, a
 * file named with something else but a string. An empty object or string for mocks counts as
 * nothing, and goes to the server as it is.
 */
export function expandScenario(deps: CliDeps, path: string): JsonObject {
  if (!existsSync(userPath(deps, path))) {
    throw new CliError(`no such scenario file: ${displayPath(path)}`)
  }
  let scenario: JsonValue
  try {
    scenario = parseJson(readUserText(deps, path))
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    throw new CliError(`${displayPath(path)} is not valid JSON: ${error.message}`)
  }
  if (!isJsonObject(scenario)) {
    throw new CliError('a scenario file holds an object, as in {"mocks": [...]}')
  }

  const mocks = Object.hasOwn(scenario, 'mocks') ? scenario.mocks! : []
  if (!Array.isArray(mocks)) {
    if (mocks === '' || (isJsonObject(mocks) && isEmpty(mocks))) return scenario
    throw new TypeError(`a scenario's mocks are a list of objects, not ${JSON.stringify(mocks)}`)
  }
  // The scenario's directory and the name: the I/O finds it through userPath, the errors print it
  const directory = parentPath(path)
  for (const mock of mocks) {
    if (!isJsonObject(mock)) {
      throw new TypeError(`a scenario's mocks are objects, not ${JSON.stringify(mock)}`)
    }
    const scriptFile = fileName(mock.script_file)
    delete mock.script_file
    if (scriptFile !== null) {
      const source = joinPath(directory, scriptFile)
      if (!existsSync(userPath(deps, source))) {
        throw new CliError(`no such script file: ${source}`)
      }
      mock.script = readUserText(deps, source)
    }
    const jsonFile = fileName(mock.json_file)
    delete mock.json_file
    if (jsonFile !== null) {
      const source = joinPath(directory, jsonFile)
      if (!existsSync(userPath(deps, source))) {
        throw new CliError(`no such JSON file: ${source}`)
      }
      mock.json_response = readJsonArg(deps, `@${source}`)
    }
  }
  return scenario
}

/**
 * `-H 'Name: value'` and `--content-type` as the one headers field, or null when neither was
 * given. The field is replaced whole, as every other field a PATCH carries is, so the headers a
 * rule keeps are the ones named in the command that set them. A name given twice keeps its first
 * place and its last value. --content-type takes out the content-type of a -H, however it was
 * spelled: two content types on one answer are one more than a client can read.
 */
export function responseHeaders(
  headers: readonly string[] | null,
  contentType: string | null,
): Record<string, string> | null {
  if (!headers?.length && contentType === null) return null
  // A Map, since a plain object would drop a header called __proto__
  const result = new Map<string, string>()
  for (const header of headers ?? []) {
    const colon = header.indexOf(':')
    // No colon, or nothing but white space before it
    const name = colon === -1 ? '' : stripSpace(header.slice(0, colon))
    if (name === '') {
      throw new CliError(`${repr(header)} is not a header; the shape is 'Name: value'`)
    }
    result.set(name, stripSpace(header.slice(colon + 1)))
  }
  if (contentType !== null) {
    for (const name of result.keys()) if (name.toLowerCase() === 'content-type') result.delete(name)
    result.set('content-type', contentType)
  }
  return Object.fromEntries(result)
}

// ---- tunnel check, and the CA ----

/** What check reports of an answer: its status, how long it took in whole milliseconds, and its
 *  body as text, JSON laid out with an indent of 2 */
export interface CheckAnswer {
  status: number
  elapsed_ms: number
  body: string
}

/** Where to send a request so that it arrives the way a device's would. A proxy port that
 *  listens on every interface is reached where the admin port is */
function proxyAddress(base: string, health: JsonObject): string {
  const proxy = health.proxy
  if (!isJsonObject(proxy) || isEmpty(proxy)) {
    throw new CliError('this server has no proxy port; start it with `tunnel serve`')
  }
  const { port } = proxy as { port: number }
  let { host } = proxy as { host: string }
  if (host === '0.0.0.0' || host === '::' || host === '') {
    // base's hostname, else 127.0.0.1
    const hostname = URL.canParse(base) ? new URL(base).hostname : ''
    host = hostname.replace(/^\[(.*)\]$/, '$1') || '127.0.0.1'
  }
  return `http://${host}:${port}`
}

/**
 * The text of an answer's body, for what check prints that is not JSON: in the charset its
 * content-type names when TextDecoder knows that one, else in UTF-8, a byte that does not decode
 * as U+FFFD. A BOM stays in the text.
 */
export function answerText(body: Uint8Array, contentType: string | null): string {
  let label = 'utf-8'
  for (const parameter of (contentType ?? '').split(';').slice(1)) {
    const equals = parameter.indexOf('=')
    if (equals !== -1 && parameter.slice(0, equals).trim().toLowerCase() === 'charset') {
      label = parameter
        .slice(equals + 1)
        .trim()
        .replace(/^"(.*)"$/, '$1')
      break
    }
  }
  try {
    return new TextDecoder(label, { ignoreBOM: true }).decode(body)
  } catch {
    // A RangeError: a charset TextDecoder does not know
    return new TextDecoder('utf-8', { ignoreBOM: true }).decode(body)
  }
}

/** What checkRequest hands the proxy port: the request, worked out, and what to trust */
export interface ProxiedRequest {
  proxy: string // proxyAddress()
  ca: Buffer // caPem(): the only CA an https: target's certificate is checked against
  method: string
  url: string // the target, its query in it and no #fragment
  body: Buffer | null
  contentType: string | null // application/json for a JSON body
}

/** What came back, its body read to the end */
export interface ProxiedAnswer {
  status: number
  contentType: string | null
  body: Buffer
}

/**
 * The request sent through the proxy port: an http: target with the whole URL on its request line,
 * an https: one through a CONNECT to the proxy and then TLS that trusts the tunnel CA alone. No
 * socket comes from Node's global agent, which NODE_USE_ENV_PROXY would put the developer's own
 * proxy in front of.
 *
 * The headers are host, a content-length (for a body, and 0 for a POST, PUT or PATCH without one),
 * and content-type for a JSON body; the proxy drops the Connection header Node adds. A socket idle
 * for TIMEOUT_MS fails with 'timed out', and a TLS handshake not done in TIMEOUT_MS fails too. The
 * sockets and the timer are let go of once the answer is in, or anything fails.
 */
export function sendThroughProxy(request: ProxiedRequest): Promise<ProxiedAnswer> {
  const proxy = new URL(request.proxy)
  const proxyHost = proxy.hostname.replace(/^\[(.*)\]$/, '$1')
  const proxyPort = Number(proxy.port)
  const target = new URL(request.url)
  const headers: Record<string, string> = { host: target.host }
  if (request.body !== null && request.body.length > 0) {
    headers['content-length'] = String(request.body.length)
  } else if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
    headers['content-length'] = '0'
  }
  if (request.contentType !== null) headers['content-type'] = request.contentType

  return new Promise((resolve, reject) => {
    const sockets: Duplex[] = []
    let handshake: ReturnType<typeof setTimeout> | undefined
    // The error that ended it, not one that destroying the sockets sets off
    const fail = (error: Error) => {
      clearTimeout(handshake)
      reject(error)
      for (const socket of sockets) socket.destroy()
    }
    /** The request itself: to the proxy for an http: target, on the TLS a CONNECT opened else */
    const send = (options: http.RequestOptions) => {
      const req = http.request({ ...options, method: request.method, headers })
      if (headers['content-length'] === undefined) {
        // Without a body, Node gives a request of any method but GET, HEAD, DELETE, OPTIONS and
        // TRACE a content-length: 0 of its own; here only POST, PUT and PATCH get one
        req.removeHeader('content-length')
        req.removeHeader('transfer-encoding')
      }
      req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('timed out')))
      req.on('socket', (socket) => sockets.push(socket))
      req.on('error', fail)
      req.on('response', (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        // An answer cut off before its end: without a listener it would never settle
        res.on('error', fail)
        res.on('end', () => {
          for (const socket of sockets) socket.destroy()
          const contentType = res.headers['content-type'] ?? null
          resolve({ status: res.statusCode ?? 0, contentType, body: Buffer.concat(chunks) })
        })
      })
      if (request.body !== null && request.body.length > 0) req.end(request.body)
      else req.end()
    }

    if (target.protocol === 'http:') {
      const path = target.origin + target.pathname + target.search
      send({ host: proxyHost, port: proxyPort, path, agent: false })
      return
    }
    const connect = http.request({
      host: proxyHost,
      port: proxyPort,
      method: 'CONNECT',
      path: `${target.hostname}:${target.port || 443}`,
      agent: false,
    })
    connect.setTimeout(TIMEOUT_MS, () => connect.destroy(new Error('timed out')))
    connect.on('error', fail)
    // The proxy's answer to a CONNECT comes here whatever its status
    connect.on('connect', (res, socket) => {
      sockets.push(socket)
      const status = res.statusCode ?? 0
      if (status < 200 || status >= 300) {
        // The status and its reason: 502 Bad Gateway
        fail(new Error(`${status} ${res.statusMessage}`))
        return
      }
      socket.setTimeout(0)
      const hostname = target.hostname.replace(/^\[(.*)\]$/, '$1')
      try {
        // A name goes as SNI; an address goes as none, and is what the certificate names
        const secure = tls.connect({
          socket,
          host: hostname,
          servername: isIP(hostname) === 0 ? hostname : undefined,
          ca: request.ca,
          ALPNProtocols: ['http/1.1'],
        })
        // A timer of its own for the handshake: without it the handshake runs on until the
        // request's goes off, 20 s in
        handshake = setTimeout(() => {
          fail(new Error('The handshake operation timed out'))
        }, TIMEOUT_MS)
        secure.once('secureConnect', () => clearTimeout(handshake))
        send({ createConnection: () => secure, path: target.pathname + target.search })
      } catch (error) {
        // A method Node will not send (ERR_INVALID_HTTP_TOKEN) throws, here in an event handler
        fail(error as Error)
      }
    })
    connect.end()
  })
}

/**
 * One request through the proxy port, and what came back. The working half of `tunnel check`,
 * which the MCP check tool runs as well: a cmd* prints, and an MCP server's stdout is its JSON-RPC
 * transport.
 *
 * In this order: the proxy's address out of health, through call(), so nothing answering is
 * CannotConnect; then -q, which replaces the query the url came with, a name given twice keeping
 * its first place and its last value, and a K=V without its = being an Error, a stack trace and 1;
 * then -d, JSON when it starts with @, { or [ (an object or a list is a JSON body, a string is
 * text, anything else no body at all) and text otherwise; then the CA. Whatever fails from the url
 * to the end of the answer is one line, The request through … failed. The seconds are counted from
 * before the proxy port is reached to the end of the body.
 *
 * Both the answer's elapsed_ms and the seconds come back, for the line check prints: rounding to
 * a whole millisecond and toFixed(3) disagree on a half millisecond.
 */
export async function checkRequest(
  deps: CliDeps,
  base: string,
  method: string,
  url: string,
  query: readonly string[] | null,
  data: string | null,
): Promise<{ answer: CheckAnswer; address: string; seconds: number }> {
  const address = proxyAddress(base, (await call(deps, 'GET', api(base, '/health'))) as JsonObject)
  // A Map keeps a name where it first came, with its last value
  let params: Map<string, string> | null = null
  if (query !== null && query.length > 0) {
    params = new Map()
    for (const item of query) {
      const equals = item.indexOf('=')
      if (equals === -1) {
        throw new CliError(`query parameter ${repr(item)} has no '=': give it as K=V`)
      }
      params.set(item.slice(0, equals), item.slice(equals + 1))
    }
  }
  let body: Buffer | null = null
  let contentType: string | null = null
  if (data) {
    const content = /^[@{[]/.test(data) ? readJsonArg(deps, data) : data
    if (typeof content === 'string') {
      body = Buffer.from(content)
    } else if (Array.isArray(content) || isJsonObject(content)) {
      body = Buffer.from(JSON.stringify(content))
      contentType = 'application/json'
    }
  }
  const ca = await caPem(deps, base)

  const send = deps.throughProxy ?? sendThroughProxy
  const started = performance.now()
  let received: ProxiedAnswer
  try {
    const target = new URL(url)
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new Error(`Request URL has an unsupported protocol '${target.protocol}//'.`)
    }
    if (params !== null) {
      // urlencode a pair at a time: a JS object would put a name like "10" first
      target.search = [...params].map(([name, value]) => urlencode({ [name]: value })).join('&')
    }
    received = await send({
      proxy: address,
      ca,
      method: method.toUpperCase(),
      url: target.origin + target.pathname + target.search,
      body,
      contentType,
    })
  } catch (error) {
    throw new CliError(`The request through ${address} failed: ${reasonOf(error)}`)
  }
  const seconds = (performance.now() - started) / 1000

  let text: string
  try {
    // The body as JSON: UTF-8, a BOM in front let through
    const value = parseJson(new TextDecoder('utf-8', { fatal: true }).decode(received.body))
    text = JSON.stringify(value, null, 2)
  } catch {
    text = answerText(received.body, received.contentType)
  }
  const answer = { status: received.status, elapsed_ms: Math.round(seconds * 1000), body: text }
  return { answer, address, seconds }
}

/** The CA in the config directory this command resolves, for when no server answers. Its methods
 *  make one when there is none yet */
export function localCa(deps: Pick<CliDeps, 'env' | 'cwd'>): CertificateAuthority {
  return new CertificateAuthority(resolvePaths({ env: deps.env, cwd: deps.cwd }))
}

/**
 * What fn returns, with the info lines logged while it runs kept off stderr, such as the one the
 * CA logs on making one in the config directory; a warning or an error reaches stderr all the
 * same. fn is synchronous, as the CA's methods are, so nothing else logs in between.
 */
function withoutInfo<T>(fn: () => T): T {
  const previous: LogSink = setLogSink((record) => {
    if (record.level === 'warning' || record.level === 'error') previous(record)
  })
  try {
    return fn()
  } finally {
    setLogSink(previous)
  }
}

/**
 * Ask the running server, and fall back to the files when nothing answers. Both have to work: the
 * certificate is installed on a device long before any traffic flows, and it is the same
 * certificate either way. Nothing answering is what call() takes for it, a timeout included. An
 * answer of 400 or more is a CliError with its text, The with a capital T. The fallback logs no
 * info (withoutInfo).
 */
export async function caCall<T>(
  deps: CliDeps,
  method: string,
  url: string,
  parse: (response: Response) => Promise<T>,
  offline: () => T,
): Promise<T> {
  try {
    const response = await deps.fetch(url, { method, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (response.status >= 400) {
      throw new CliError(`The server answered ${response.status}: ${await response.text()}`)
    }
    return await parse(response)
  } catch (error) {
    if (connectFailed(error)) return withoutInfo(offline)
    throw error
  }
}

/** The CA certificate devices install, from the running server's /ca.pem (not under /__admin__),
 *  else from the config directory */
export function caPem(deps: CliDeps, base: string): Promise<Buffer> {
  return caCall(
    deps,
    'GET',
    `${base.replace(/\/+$/, '')}/ca.pem`,
    async (response) => Buffer.from(await response.arrayBuffer()),
    () => localCa(deps).certificatePem(),
  )
}
