// The commands that read the traffic (requests, requests show, wait, record, recordings and
// check): what the client called, one call in full, a wait for one to arrive, and the recordings
// made of them. cli.ts's command table names each handler, which takes (args, io, deps); the
// admin API, the redaction and printing come from cli-common.ts.
import { type Dirent, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Args } from './cli-args.ts'
import {
  api,
  call,
  checkRequest,
  type CliDeps,
  CliError,
  type CliIo,
  isSystemError,
  keyFor,
  print,
  compareCodePoints,
  joinPath,
  displayPath,
  readUserText,
  redact,
  redactNames,
  type RequestFilters,
  requestParams,
  sessions,
  TIMEOUT_MS,
  userPath,
} from './cli-common.ts'
import { type AggregateRow, bodyText, type Exchange, type ExchangeSummary } from './exchanges.ts'
import { reasonOf } from './errors.ts'
import { type JsonObject, type JsonValue, parseJson } from './json.ts'
import { getLogger } from './log.ts'
import { urlencode } from './messages.ts'
import { formatG } from './number-format.ts'
import { filePath, formatRecording, type RecordingRow, type RecordingStatus } from './recordings.ts'

const log = getLogger('cli-traffic')

/** What ruleNote reads of a row or an exchange: an aggregate row has no unmatched, and an
 *  exchange no key */
interface Answered {
  unmatched?: boolean
  matched_by: string | null
  key?: string
  mode: string | null
}

/** What answered this request, the rule it matched or the mode that stood in */
function ruleNote(row: Answered): string {
  if (row.unmatched) return '  [unmatched]'
  const matched = row.matched_by
  if (matched && matched !== row.key) return `  [${matched}]`
  if (matched) return '  [configured]'
  return row.mode ? `  [${row.mode}]` : ''
}

/** An endpoint, how often it was called and how it was last answered */
function aggregateLine(row: AggregateRow): string {
  const status = row.status !== null ? `  ${row.status}` : ''
  let flags = row.encrypted ? '  <encrypted>' : ''
  if (row.unmatched_count) flags += `  ${row.unmatched_count} unmatched`
  return (
    `${String(row.request_count).padStart(5)}x  ${row.last_seen.slice(0, 19)}  ${row.key}` +
    `${status}${flags}${ruleNote(row)}`
  )
}

/** One request, or one tunnel nobody decrypted */
function eachLine(row: ExchangeSummary): string {
  // HH:MM:SS.mmm, out of the time as the log writes it
  const when = row.time.slice(11, 23)
  const seq = String(row.seq).padStart(5)
  if (row.kind === 'connect') {
    return (
      `${seq}  ${when}  CONNECT ${row.host}:${row.port}` +
      `  <encrypted>  ${row.bytes_up} up / ${row.bytes_down} down`
    )
  }
  return (
    `${seq}  ${when}  ${row.method} ${row.url}` +
    `  ${row.status}  ${row.elapsed_ms}ms${ruleNote(row)}`
  )
}

/** tunnel requests: what the client called, an endpoint a line, or a request a line with --each.
 *  No --raw here: neither view prints a header or a body */
export async function cmdRequests(args: Args, io: CliIo, deps: CliDeps): Promise<void> {
  const params = requestParams(args as RequestFilters)
  const data = await call(deps, 'GET', api(args.base as string, '/requests'), { params })
  const lines =
    args.each === true
      ? (data as unknown as { requests: ExchangeSummary[] }).requests.map(eachLine)
      : (data as unknown as { requests: AggregateRow[] }).requests.map(aggregateLine)
  // Whether a filter other than --each narrowed what came back
  const filtered = Object.keys(params).some((name) => name !== 'each')
  const empty = filtered ? '(nothing matches)' : '(nothing recorded yet)'
  print(io, data, args.json === true, lines.length > 0 ? lines : [empty])
}

/** A title, then a line per header */
function headersLines(title: string, headers: Readonly<Record<string, string>>): string[] {
  return [title, ...Object.entries(headers).map(([name, value]) => `  ${name}: ${value}`)]
}

/** A title and the body, a JSON one laid out as JSON; nothing when there is none */
function bodyLines(
  title: string,
  part: { body: JsonValue; body_encoding: string | null },
): string[] {
  // A body that is missing or null
  if (part.body == null) return []
  if (part.body_encoding === 'json') return [title, JSON.stringify(part.body, null, 2)]
  return [title, bodyText(part.body, part.body_encoding)]
}

/** One call in full, which `requests show` and `recordings show` both print. A tunnel nobody
 *  decrypted has nothing to show but its ends and how much went each way */
function exchangeLines(exchange: Exchange): string[] {
  const { request, response } = exchange
  const lines = [`seq ${exchange.seq}  ${exchange.time}  from ${exchange.client || '-'}`]
  if (exchange.kind === 'connect') {
    return [
      ...lines,
      `CONNECT ${request.host}:${request.port}  not decrypted`,
      `${exchange.bytes_up} bytes up, ${exchange.bytes_down} bytes down`,
    ]
  }

  lines.push(`${request.method} ${request.url}${ruleNote(exchange)}`)
  lines.push(...headersLines('request headers:', request.headers))
  lines.push(...bodyLines('request body:', request))
  if (response) {
    lines.push(`response ${response.status}  ${response.elapsed_ms}ms`)
    lines.push(...headersLines('response headers:', response.headers))
    lines.push(...bodyLines('response body:', response))
  }
  if (exchange.truncated) lines.push('(a body was longer than the limit and was cut)')
  return lines
}

/** tunnel requests show: one request and its answer in full, the header values that carry a
 *  session hidden unless --raw, in what --json prints as well */
export async function cmdRequestsShow(args: Args, io: CliIo, deps: CliDeps): Promise<void> {
  const base = args.base as string
  const exchange = (await call(deps, 'GET', api(base, `/requests/${args.seq}`))) as JsonObject
  if (args.raw !== true) redact(exchange, await redactNames(deps, base))
  print(io, exchange, args.json === true, exchangeLines(exchange as unknown as Exchange))
}

/**
 * tunnel wait: blocks until the client has made this request, instead of sleeping and hoping.
 * The server holds the connection open and answers as soon as enough matching requests have
 * arrived, so the exit code is the assertion: 0 when they did, 3 when the wait ran out.
 */
export async function cmdWait(args: Args, io: CliIo, deps: CliDeps): Promise<number> {
  const count = args.count as number
  const timeout = args.timeout as number
  // In this order. A number goes in as String() writes it, 5 for 5.0, which the admin API reads
  // as the same float
  const params: Record<string, string | readonly string[]> = {
    key: keyFor(args.method as string, args.path as string),
    count: String(count),
    timeout: String(timeout),
  }
  if (args.since !== null) params.since = String(args.since)
  // -q given twice is q twice in the query string
  if (args.query !== null) params.q = args.query as readonly string[]

  // The server answers at its own deadline; the client waits past it, or it would be the one
  // giving up first. One that AbortSignal.timeout cannot keep is no deadline at all (call())
  const data = await call(deps, 'GET', api(args.base as string, '/requests/wait'), {
    params,
    timeoutMs: Math.ceil(timeout * 1000) + TIMEOUT_MS,
  })

  const answer = data as { seqs: number[]; count: number; timed_out: boolean }
  const seqs = answer.seqs.map(String).join(', ') || 'none'
  if (answer.timed_out) {
    print(io, data, args.json === true, [
      `Timed out after ${formatG(timeout)}s with ${answer.count} of ${count} requests: ${seqs}`,
    ])
    return 3
  }
  print(io, data, args.json === true, [`${answer.count} matched: ${seqs}`])
  return 0
}

// ---- Recording ----

/** tunnel record start: every passthrough call from here on is kept. No --session is no field at
 *  all: an ordinary start records into the session the run is on, rather than moving it back to
 *  the default one */
export async function cmdRecordStart(args: Args, io: CliIo, deps: CliDeps): Promise<void> {
  const payload: JsonObject = args.session === null ? {} : { session: args.session as string }
  const data = await call(deps, 'POST', api(args.base as string, '/record/start'), {
    json: payload,
  })
  const started = data as unknown as RecordingStatus
  print(io, data, args.json === true, [
    'Recording passthrough traffic into session ' +
      `${started.session} (${started.count} calls there already)`,
  ])
}

/** tunnel record stop: what is on disk stays */
export async function cmdRecordStop(args: Args, io: CliIo, deps: CliDeps): Promise<void> {
  const data = await call(deps, 'POST', api(args.base as string, '/record/stop'))
  const stopped = data as unknown as RecordingStatus
  print(io, data, args.json === true, [
    `Recording stopped; session ${stopped.session} holds ${stopped.count} calls`,
  ])
}

/** tunnel record status: whether recording is on, into which session, and how much it holds */
export async function cmdRecordStatus(args: Args, io: CliIo, deps: CliDeps): Promise<void> {
  const data = await call(deps, 'GET', api(args.base as string, '/record'))
  const status = data as unknown as RecordingStatus
  const state = status.active ? 'on' : 'off'
  print(io, data, args.json === true, [
    `Recording is ${state}; session ${status.session} holds ${status.count} calls`,
  ])
}

/** Which session to read, the one asked for, else the one being recorded */
async function session(args: Args, deps: CliDeps): Promise<string> {
  if (args.session) return args.session as string
  const data = await call(deps, 'GET', api(args.base as string, '/record'))
  return (data as unknown as RecordingStatus).session
}

/** The filters of the recordings as the admin API takes them, each only when it is given and not
 *  empty; no session means all of them. export has no --key or --host */
function recordingParams(args: Args): Record<string, string> {
  const params: Record<string, string> = {}
  for (const name of ['session', 'key', 'host'] as const) {
    const value = args[name]
    if (value) params[name] = value as string
  }
  return params
}

/** One recorded call, a line of `tunnel recordings ls` */
function recordingLine(row: RecordingRow): string {
  const query = Object.keys(row.query).length > 0 ? `?${urlencode(row.query)}` : ''
  const status = row.status !== null ? row.status : '-'
  return (
    `${String(row.seq).padStart(6)}  ${row.time.slice(0, 19)}  ${row.session}  ` +
    `${row.key}${query}  ${status}  ${row.size}B`
  )
}

/** tunnel recordings ls: one row per recorded call */
export async function cmdRecordingsLs(args: Args, io: CliIo, deps: CliDeps): Promise<void> {
  const params = recordingParams(args)
  const data = await call(deps, 'GET', api(args.base as string, '/recordings'), { params })
  const empty = Object.keys(params).length > 0 ? '(nothing matches)' : '(nothing recorded yet)'
  const lines = (data as unknown as { recordings: RecordingRow[] }).recordings.map(recordingLine)
  print(io, data, args.json === true, lines.length > 0 ? lines : [empty])
}

/** tunnel recordings show: one recorded call in full, the header values that carry a session
 *  hidden unless --raw */
export async function cmdRecordingsShow(args: Args, io: CliIo, deps: CliDeps): Promise<void> {
  const base = args.base as string
  const url = api(base, `/recordings/${await session(args, deps)}/${args.seq}`)
  const exchange = (await call(deps, 'GET', url)) as JsonObject
  if (args.raw !== true) redact(exchange, await redactNames(deps, base))
  print(io, exchange, args.json === true, exchangeLines(exchange as unknown as Exchange))
}

/**
 * tunnel recordings export: the recordings written out as the same tree the server keeps them in,
 * under out, relative to deps.cwd. Header values are hidden unless --raw is given: an export is
 * meant to be committed to a client's repository, and a session token in there outlives every
 * test that needed it. The directory is printed as displayPath prints it.
 */
export async function cmdRecordingsExport(args: Args, io: CliIo, deps: CliDeps): Promise<void> {
  const base = args.base as string
  const out = args.out as string
  const listing = await call(deps, 'GET', api(base, '/recordings'), {
    params: recordingParams(args),
  })
  const rows = (listing as unknown as { recordings: RecordingRow[] }).recordings
  const names = args.raw === true ? null : await redactNames(deps, base)
  const directory = userPath(deps, out)

  for (const row of rows) {
    const url = api(base, `/recordings/${row.session}/${row.seq}`)
    const exchange = (await call(deps, 'GET', url)) as JsonObject
    if (names !== null) redact(exchange, names)
    const request = exchange.request as { method: string; host: string; path: string }
    const seq = exchange.seq as number
    const file = filePath(row.session, request.method, request.host, request.path, seq)
    const path = `${directory}/${file}`
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, formatRecording(exchange))
  }

  const note = args.raw === true ? '' : ' (header values hidden; --raw keeps them)'
  print(io, { exported: rows.length, directory: displayPath(out) }, args.json === true, [
    `Wrote ${rows.length} recordings to ${displayPath(out)}${note}`,
  ])
}

/** Whether path is a directory, or a symlink to one. Anything that goes wrong is a no */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Whether path is a file, or a symlink to one. Anything that goes wrong is a no */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * The recordings under root, each as the names of its path below root: every *.json that isFile()
 * takes for a file. The walk goes into every directory but a symlink to one, and passes over one
 * it cannot list; isFile() follows a symlink, so one to a file is a recording, and a directory
 * named x.json is not (`/v5/feed.json` was filed as …/GET/v5/feed.json/000001.json). readdirSync's
 * recursive walk would go into a symlinked directory, so this is a walk of its own. Root and the
 * names are joined with a '/' and nothing more, so a '..' in root is left to the system
 * (userPath).
 *
 * Depth first, each directory's names in compareCodePoints's order, so that paths are compared name by
 * name: a/b.json comes before a-b/c.json, where comparing the whole strings would put '-' (0x2D)
 * before '/' (0x2F).
 */
function recordingFiles(root: string, names: string[] = [], found: string[][] = []): string[][] {
  let entries: Dirent[]
  try {
    entries = readdirSync([root, ...names].join('/'), { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries.sort((a, b) => compareCodePoints(a.name, b.name))) {
    const path = [...names, entry.name]
    if (entry.isDirectory()) recordingFiles(root, path, found)
    else if (entry.name.endsWith('.json') && isFile([root, ...path].join('/'))) found.push(path)
  }
  return found
}

/**
 * Whether text is JSON but for a NaN, Infinity or -Infinity, which parseJson refuses: with each of
 * them outside a string put back as null, it parses
 */
function jsonButForNaN(text: string): boolean {
  const words = /"(?:[^"\\]|\\.)*"|-?Infinity|NaN/g
  const replaced = text.replace(words, (word) => (word.startsWith('"') ? word : 'null'))
  if (replaced === text) return false
  try {
    parseJson(replaced)
    return true
  } catch {
    return false
  }
}

/**
 * The recordings in a directory `tunnel recordings export` wrote, dir relative to deps.cwd, by
 * session, the sessions in compareCodePoints's order: what `tunnel recordings import` and the library's
 * importRecordings() put back, one import per session. A file in a directory of its own is filed
 * under that directory's name, the session `export` wrote it from; one that lies at the top names
 * no session of its own, and goes into currentSession(), the one this run reads and writes. That is
 * asked for only once dir has been found to be a directory: a path that is not one is the user's
 * error, exit code 1, even when no server answers, which would be 2.
 *
 * A recording with NaN or Infinity in it, which JSON has no words for, is skipped with a warning,
 * as the recordings store skips it. Any other file that is no JSON ends the import.
 */
export async function readRecordingsTree(
  deps: Pick<CliDeps, 'cwd'>,
  dir: string,
  currentSession: () => Promise<string>,
): Promise<{ session: string; exchanges: JsonValue[] }[]> {
  const root = userPath(deps, dir)
  if (!isDirectory(root)) throw new CliError(`not a directory: ${displayPath(dir)}`)

  const current = await currentSession()

  // A Map, since a plain object would drop a session called __proto__
  const bySession = new Map<string, JsonValue[]>()
  for (const path of recordingFiles(root)) {
    const name = path.length > 1 ? path[0]! : current
    let text: string | undefined
    let exchange: JsonValue
    try {
      text = readUserText(deps, [root, ...path].join('/'))
      exchange = parseJson(text)
    } catch (error) {
      // A system error, or JSON that does not parse. Bytes that are not UTF-8 are neither, and
      // stay a stack trace
      if (!isSystemError(error) && !(error instanceof SyntaxError)) throw error
      const file = joinPath(displayPath(dir), ...path)
      if (text !== undefined && jsonButForNaN(text)) {
        log.warning(`Skipping an unreadable recording ${file}: ${reasonOf(error)}`)
        continue
      }
      throw new CliError(`${file} is not a recorded exchange: ${error.message}`)
    }
    const exchanges = bySession.get(name) ?? []
    exchanges.push(exchange)
    bySession.set(name, exchanges)
  }
  if (bySession.size === 0) throw new CliError(`no recordings found under ${displayPath(dir)}`)

  const names = [...bySession.keys()].sort(compareCodePoints)
  return names.map((session) => ({ session, exchanges: bySession.get(session)! }))
}

/** tunnel recordings import: a directory of recordings read back into the server, as CI does, one
 *  import per session (readRecordingsTree) */
export async function cmdRecordingsImport(args: Args, io: CliIo, deps: CliDeps): Promise<void> {
  const base = args.base as string
  const current = async () => (await sessions(deps, base)).session as string
  const tree = await readRecordingsTree(deps, args.dir as string, current)

  const names = tree.map(({ session }) => session)
  let imported = 0
  const lines: string[] = []
  for (const { session: name, exchanges } of tree) {
    const data = await call(deps, 'POST', api(base, '/recordings/import'), {
      json: { session: name, exchanges, replace: args.replace === true },
    })
    const answer = data as { imported: number; replaced: boolean }
    imported += answer.imported
    lines.push(
      `  ${name}: ${answer.imported}` + (answer.replaced ? ' (the session was emptied first)' : ''),
    )
  }
  print(io, { success: true, imported, sessions: names }, args.json === true, [
    `Imported ${imported} recordings`,
    ...lines,
  ])
}

/** tunnel recordings rm: one session's recordings, or every session's */
export async function cmdRecordingsRm(args: Args, io: CliIo, deps: CliDeps): Promise<void> {
  const params = args.session ? { session: args.session as string } : null
  const data = await call(deps, 'DELETE', api(args.base as string, '/recordings'), { params })
  const answer = data as { deleted: number; session: string | null }
  const where = answer.session ? `session ${answer.session}` : 'every session'
  print(io, data, args.json === true, [`Deleted ${answer.deleted} recordings from ${where}`])
}

// ---- Check ----

/**
 * tunnel check: one request through the proxy port, the way a device's request arrives. HTTPS is
 * verified against the running server's own CA, so the answer is the one a device that installed
 * the certificate would get, a host that is not in the SSL Proxying Locations included, which
 * reaches the real server. A 4xx or 5xx exits 1, so a script can just check the exit code.
 */
export async function cmdCheck(args: Args, io: CliIo, deps: CliDeps): Promise<number> {
  const { answer, address, seconds } = await checkRequest(
    deps,
    args.base as string,
    args.method as string,
    args.url as string,
    args.query as string[] | null,
    args.data as string | null,
  )
  print(io, { ...answer }, args.json === true, [
    `HTTP ${answer.status}  ${seconds.toFixed(3)}s  through ${address}`,
    answer.body,
  ])
  return answer.status < 400 ? 0 : 1
}
