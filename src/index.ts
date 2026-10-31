// The library entry: `import { startTunnel } from 'tunnel-use'` runs tunnel inside the caller's
// process, for test code that sets rules, waits for requests and asserts on them without starting
// a CLI or writing HTTP of its own to the admin port.
//
// startTunnel() starts what `tunnel serve` starts, in its order, on free ports and in a temporary
// configuration directory unless told otherwise, and resolves with a handle. The handle's methods
// are the admin API's endpoints, called in this process on the very Hono app the admin port
// answers with, so the defaults, the checks and the words are the route's own; what the API
// refuses rejects as a TunnelError. Nothing it starts holds the process open.
//
// Exported are startTunnel, setLogSink, TunnelError and types. The handle's class is not: a test
// has no business making one, or reaching past the Tunnel interface.
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { isIP, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { checkMockPatch, mockToDict } from './admin.ts'
import { startAdminServer, type AdminServer } from './app.ts'
import { CertificateAuthority } from './certs.ts'
import { defaultDeps, expandScenario, sendThroughProxy, sslPatch } from './cli-common.ts'
import { readRecordingsTree } from './cli-traffic.ts'
import { Paths, TunnelConfigManager } from './config.ts'
import { TunnelCore } from './core.ts'
import { repr, UserError, type ValidationIssue } from './errors.ts'
import type * as exchanges from './exchanges.ts'
import type { AggregateRow, ExchangeSummary } from './exchanges.ts'
import { isJsonObject, parseJson, type RawJson } from './json.ts'
import {
  makeTunnelRequestConfig,
  type Fault,
  type ReplayStrategy,
  type TunnelConfig,
  type TunnelMode,
  type TunnelRequestConfig,
} from './models.ts'
import { DEFAULT_PROXY_HOST, ProxyServer } from './proxy.ts'
import type * as recordings from './recordings.ts'
import type { RecordingRow } from './recordings.ts'
import { normaliseKey } from './rule-keys.ts'
import { parseScriptJson, stringifyScriptJson } from './script-context.ts'
import type { FunctionHandler } from './script-function.ts'
import { validationErrorBody } from './validate.ts'

// Where tunnel's log records go, for every instance in this process: setLogSink(sink) returns the
// sink it replaced. Default: stderr, one LEVEL:tunnel.<module>:message line per record from INFO up
export { setLogSink } from './log.ts'
export type { LogRecord, LogSink } from './log.ts'
export type { ValidationIssue } from './errors.ts'
export type { DefaultMode, Fault, ReplayStrategy, TunnelMode } from './models.ts'
export type { AggregateRow, ExchangeSummary } from './exchanges.ts'
export type { RecordingRow } from './recordings.ts'

/** Where startTunnel() puts tunnel, and on which ports */
export interface StartOptions {
  /** config.json, the CA, requests.jsonl and recordings/, all in this one directory, as
   *  `tunnel serve --config-dir` puts them (~ expanded, relative to process.cwd()); kept.
   *  Default, as when it is empty: a new <os.tmpdir()>/tunnel-XXXXXX with a new CA, removed by
   *  stop(), or when the process exits if stop() was never called */
  configDir?: string
  /** With the default configDir only: ca.pem and ca-key.pem are copied from this directory, so that
   *  a simulator or device that trusts that CA keeps decrypting. Default, as when it is empty: a
   *  new CA */
  caDir?: string
  proxyHost?: string // default '0.0.0.0', as tunnel serve; the admin port is always on 127.0.0.1
  proxyPort?: number // default 0: a free port
  adminPort?: number // default 0: a free port
}

/** StartOptions' names, in its order, which is the order a misspelt one is told them in */
const START_OPTIONS: readonly (keyof StartOptions)[] = [
  'configDir',
  'caDir',
  'proxyHost',
  'proxyPort',
  'adminPort',
]

/** A tunnel running in this process. Once stop() has been called, every method but stop() and
 *  [Symbol.asyncDispose]() rejects with TunnelError 503; the properties stay, a record of where it
 *  ran */
export interface Tunnel {
  readonly proxyPort: number // the ports actually listened on
  readonly adminPort: number
  /** Where this process reaches the proxy port: http://127.0.0.1:<proxyPort> when it listens on
   *  every interface, else http://<proxyHost>:<proxyPort>, an IPv6 address in brackets */
  readonly proxyUrl: string
  readonly adminUrl: string // http://127.0.0.1:<adminPort>: the panel, and --base for the CLI
  readonly configDir: string // absolute
  readonly caFile: string // <configDir>/ca.pem, the certificate a device installs

  /** GET /health and GET /sessions as one object; mocks counts the function rules too */
  status(): Promise<Status>
  /** GET /config */
  getConfig(): Promise<Settings>
  /** PATCH /config: the fields given; an empty patch is TunnelError 400 'No fields to update' */
  setConfig(patch: SettingsPatch): Promise<Settings>
  /** The SSL Proxying Locations, edited as `tunnel ssl add` / `ssl rm` edit them: the hosts go on
   *  the include list (exclude: true, the exclude list), or come off it (remove: true) */
  decrypt(
    hosts: string | readonly string[],
    options?: { exclude?: boolean; remove?: boolean },
  ): Promise<SslProxying>

  /** Every rule, the stored ones first, then the function rules; with key, only that one
   *  (TunnelError 404 when there is none) */
  listRules(key?: string): Promise<Rule[]>
  /** Without handler: PATCH /mocks, the fields not given keep their values, written to config.json.
   *  With handler: a function rule, made whole from the defaults and the fields given, in memory
   *  only, replacing any rule with that key. Either way it replaces a function rule with that key */
  setRule(rule: RulePatch | FunctionRulePatch): Promise<Rule>
  /** The rule with this key, of either kind (TunnelError 404 when there is none); resolves with
   *  the key as it is stored */
  deleteRule(key: string): Promise<string>
  /** POST /mocks/apply, all of it or none of it; a string is a scenario file, read as `tunnel
   *  apply` reads one (script_file and json_file relative to it). Drops the function rules with
   *  the keys it applies, and with replace every function rule */
  applyScenario(
    scenario: Scenario | string,
    options?: { replace?: boolean },
  ): Promise<{ applied: string[]; replaced: boolean }>
  /** POST /state/reset: ctx.state of scripts and function rules, and the sequence counters; the
   *  keys that had something, sorted */
  resetState(key?: string): Promise<string[]>

  /** GET /requests: one aggregate row per key, or with each one summary per request */
  listRequests(filters: RequestFilters & { each: true }): Promise<RequestList<ExchangeSummary>>
  listRequests(filters?: RequestFilters & { each?: false }): Promise<RequestList<AggregateRow>>
  /** GET /requests/{seq}: one exchange in full, headers unredacted (TunnelError 404 when gone) */
  getRequest(seq: number): Promise<Exchange>
  /** GET /requests/wait: resolves once `count` matching requests are in the log, or when
   *  `timeout` seconds are up (timed_out: true, not an error); TunnelError 503 if the tunnel
   *  stops meanwhile */
  waitForRequest(options?: WaitOptions): Promise<WaitResult>
  /** POST /requests/clear; resolves with the last seq handed out, the `since` for what follows */
  clearRequests(): Promise<number>
  /** One request through this tunnel's proxy port, trusting its CA alone, as `tunnel check` sends
   *  it. An https URL is decrypted only when its host is (decrypt()); otherwise it goes on to the
   *  real server, as a device's would. Rejects with Node's error when no answer comes */
  check(method: string, url: string, options?: CheckOptions): Promise<CheckAnswer>

  /** POST /record/start: into the current session, or switch to `session` first */
  startRecording(session?: string): Promise<RecordingStatus>
  /** POST /record/stop */
  stopRecording(): Promise<RecordingStatus>
  /** GET /recordings: one row per recorded call */
  listRecordings(filters?: {
    session?: string
    key?: string
    host?: string
  }): Promise<RecordingRow[]>
  /** GET /recordings/{session}/{seq} (TunnelError 404 when there is none) */
  getRecording(session: string, seq: number): Promise<Exchange>
  /** POST /recordings/import. An array goes into options.session (default 'default'); a string is
   *  a directory `tunnel recordings export` wrote, read as `tunnel recordings import` reads it */
  importRecordings(
    from: readonly Exchange[] | string,
    options?: { session?: string; replace?: boolean },
  ): Promise<{ imported: number; sessions: string[]; replaced: boolean }>
  /** DELETE /recordings: one session's, or every session's; resolves with how many went */
  deleteRecordings(session?: string): Promise<number>

  /** Closes both ports, the script worker and the function handlers still running, and removes a
   *  temporary configDir. Every call returns the first call's promise */
  stop(): Promise<void>
  [Symbol.asyncDispose](): Promise<void> // stop()
}

/** What the admin API answered with a status of 400 or more, or the library's own refusal */
export class TunnelError extends Error {
  override readonly name = 'TunnelError'
  readonly status: number // 400, 404, 422, 503
  readonly detail: string | ValidationIssue[] // the answer's detail, as it came

  /** The message is the detail, or each issue of a 422 as `<where>: <msg>`, joined with '; ' */
  constructor(status: number, detail: string | ValidationIssue[]) {
    super(typeof detail === 'string' ? detail : detail.map(issueText).join('; '))
    this.status = status
    this.detail = detail
  }
}

/** An issue as a TunnelError's message has it: where, without the body or the query it was in,
 *  and its validation message */
function issueText(issue: ValidationIssue): string {
  const where = issue.loc[0] === 'body' || issue.loc[0] === 'query' ? issue.loc.slice(1) : issue.loc
  return where.length === 0 ? issue.msg : `${where.join('.')}: ${issue.msg}`
}

// ---- Function handlers: the same ctx and the same return values as a script's handler(ctx)

/** A function rule's handler: what it returns, or a promise of it, is answered as a script's
 *  handler(ctx) return value is */
export type Handler = (ctx: HandlerContext) => unknown

export interface HandlerContext {
  method: string
  path: string
  query: Record<string, string>
  headers: Record<string, string>
  body: Buffer
  json: any // the body as JSON, integers past 2^53 as bigint; null when it is none
  state: Record<string, any> // one live object per rule, until resetState()
  scheme: string
  host: string
  port: number
  url: string
  client: string
  /** Promises here, where a script's are synchronous: `await ctx.recorded()` suits both */
  recorded(options?: {
    query?: Record<string, string> | null
    key?: string | null
    session?: string | null
  }): Promise<Recorded | null>
  recordings(options?: { key?: string | null; session?: string | null }): Promise<Recorded[]>
  /** Throws TypeError for a status outside 100–999 or headers that are not a plain object of
   *  strings, as a script's does */
  reply(body: unknown, status?: number | null, headers?: Record<string, string> | null): Reply
}

export interface Reply {
  readonly body: unknown
  readonly status: number | null
  readonly headers: Record<string, string> | null
}

/** seq, status, headers, body, request, body_encoding */
export type Recorded = WithBigInts<recordings.Recorded>

// ---- Data, in the admin API's own field names

/** JSON as the library hands it out and takes it: an integer past 2^53 is a bigint */
export type Json = null | boolean | number | bigint | string | Json[] | { [key: string]: Json }

/** An internal type with the bigint the library hands out where it holds a RawJson, the digits of
 *  an integer past 2^53 */
type WithBigInts<T> = T extends RawJson
  ? bigint
  : T extends readonly (infer U)[]
    ? WithBigInts<U>[]
    : T extends object
      ? { [K in keyof T]: WithBigInts<T[K]> }
      : T

export interface Rule {
  key: string
  mode: TunnelMode // 'json' | 'passthrough' | 'script' | 'replay'; a function rule is 'script'
  json_response: { [key: string]: Json } | Json[]
  status_code: number
  enabled: boolean
  description: string
  merge_json: { [key: string]: Json }
  headers: Record<string, string>
  target: string
  response_delay: number
  script: string // '' on a function rule
  replay_session: string
  replay_strategy: ReplayStrategy // 'match' | 'sequence' | 'last'
  fault: Fault // 'none' | 'hang' | 'garbage' | 'close'
  fault_seconds: number
  handler?: Handler // on a function rule only
}

export type RulePatch = { key: string } & Partial<Omit<Rule, 'key' | 'handler'>>

export type FunctionRulePatch = {
  key: string
  handler: Handler
  mode?: 'script'
  script?: ''
} & Partial<Omit<Rule, 'key' | 'handler' | 'mode' | 'script'>>

export interface Scenario {
  mocks?: RulePatch[]
  config?: SettingsPatch | null
  replace?: boolean
}

export type Settings = WithBigInts<Omit<TunnelConfig, 'request_configs'>>

export type SslProxying = Settings['ssl_proxying']

export type SettingsPatch = Partial<
  Pick<
    Settings,
    | 'default_mode'
    | 'max_requests_history'
    | 'auto_record_requests'
    | 'ssl_proxying'
    | 'allow_clients'
    | 'redact_headers'
    | 'replay_marker'
  >
> & { session?: string | null }

/** GET /health and GET /sessions in one object */
export interface Status {
  status: 'ok'
  version: string
  config_dir: string
  state_dir: string
  data_dir: string
  mocks: number
  exchanges: number
  first_seq: number
  last_seq: number
  ca_fingerprint: string
  proxy: { host: string; port: number; lan_ips: string[] } | null
  session: string
  recording: RecordingStatus
  upstream: string
  sessions: Record<string, number>
}

export interface RecordingStatus {
  active: boolean
  session: string
  count: number
}

/** GET /requests' filters, each named as its query parameter is but qBody, which is q_body */
export interface RequestFilters {
  key?: string
  host?: string
  since?: number
  last?: number
  unmatched?: boolean
  encrypted?: boolean
  q?: string
  qBody?: boolean
}

export interface RequestList<Row> {
  requests: Row[]
  last_seq: number
  unmatched_count: number
}

/** One request and its answer, in full, as the log and the recordings keep it */
export type Exchange = WithBigInts<exchanges.Exchange>

export interface WaitOptions {
  key?: string // default: any request
  count?: number // default 1
  since?: number // only requests after this seq; default: the whole log
  timeout?: number // seconds, default 10
  query?: Record<string, string> // query parameters a request must carry with these values
}

export interface WaitResult {
  seqs: number[]
  count: number
  wanted: number
  timed_out: boolean
  last_seq: number
}

export interface CheckOptions {
  body?: string | Uint8Array
  contentType?: string
}

export interface CheckAnswer {
  status: number
  contentType: string | null
  body: Buffer
}

// ---- Starting and stopping

/** Starts the proxy port, the admin port, the core and the script worker in this process.
 *  Rejects with Node's own error when a port cannot be listened on (code EADDRINUSE …), and with
 *  TunnelError 400 for caDir together with configDir, or a caDir without ca.pem or ca-key.pem */
export async function startTunnel(options?: StartOptions): Promise<Tunnel> {
  refuseUnknown(options, START_OPTIONS)
  const { proxyHost, proxyPort, adminPort } = options ?? {}
  // None given when empty, as an empty --config-dir is none (resolvePaths), or null, which a caller
  // without types can pass: the temporary directory then, and a new CA
  const configDir = options?.configDir || null
  const caDir = options?.caDir || null
  // The CA to copy, checked before anything is made
  let source: Paths | null = null
  if (caDir !== null) {
    if (configDir !== null) {
      const detail =
        'caDir goes with the temporary configDir: a given configDir has a CA of its own'
      throw new TunnelError(400, detail)
    }
    source = Paths.inOneDirectory(caDir)
    for (const file of [source.caFile, source.caKeyFile]) {
      if (!existsSync(file)) {
        throw new TunnelError(400, `no ${basename(file)} in ${source.config_dir}`)
      }
    }
  }
  // Made here, and so removed by stop(), unless the caller gave one
  const directory = configDir ?? mkdtempSync(join(tmpdir(), 'tunnel-'))
  const temporary = configDir === null ? directory : null
  let core: TunnelCore | null = null
  let proxy: ProxyServer | null = null
  try {
    // Resolved as --config-dir is: under a symlinked tmpdir, the real path
    const paths = Paths.inOneDirectory(directory)
    if (source !== null) {
      copyFileSync(source.caFile, paths.caFile)
      copyFileSync(source.caKeyFile, paths.caKeyFile)
      // The private key is the copy's to keep private, whatever mode the source left it in
      chmodSync(paths.caKeyFile, 0o600)
    }
    // As serveForeground starts them: the proxy port first, whose start() makes the CA when there
    // is none to load, then the admin port
    const manager = new TunnelConfigManager(paths)
    core = new TunnelCore(manager)
    const ca = new CertificateAuthority(manager.paths)
    const listener = new ProxyServer(core, manager, ca, {
      host: proxyHost ?? DEFAULT_PROXY_HOST,
      port: proxyPort ?? 0,
    })
    proxy = listener
    await listener.start()
    const admin = await startAdminServer(
      { manager, core, ca, proxy: () => listener.describe() },
      { port: adminPort ?? 0 },
    )
    // Neither port, nor a connection to either, holds the process open: a test file that never
    // calls stop() still ends. A request being answered holds it with timers and promises of its
    // own until it is answered
    listener.unref()
    admin.server.unref()
    admin.server.on('connection', (socket: Socket) => socket.unref())
    return new TunnelHandle({ core, proxy: listener, admin, ca, paths, temporary })
  } catch (error) {
    // What did start is closed again, and the directory made is removed: the caller is left with
    // the error and nothing else
    await proxy?.close()
    await core?.close()
    if (temporary !== null) await rm(temporary, { recursive: true, force: true, maxRetries: 3 })
    throw error
  }
}

/** An option the library does not know is refused, as the admin API refuses a field it does not
 *  know, rather than ignored: a misspelt one would otherwise change nothing, silently */
function refuseUnknown(options: object | undefined, known: readonly string[]): void {
  for (const name of Object.keys(options ?? {})) {
    if (!known.includes(name)) {
      throw new TunnelError(
        400,
        `unknown option ${repr(name)}; the options are ${known.join(', ')}`,
      )
    }
  }
}

/** What tunnel's own code throws for the caller's mistake, a UserError, as the 400 the admin API
 *  answers one with (admin.ts, guard), in its words; anything else as it is */
function userErrorsAs400<T>(work: () => T): T {
  try {
    return work()
  } catch (error) {
    return rethrowAs400(error)
  }
}

/** userErrorsAs400 for work that fails later: a promise's catch */
function rethrowAs400(error: unknown): never {
  if (error instanceof UserError) throw new TunnelError(400, error.message)
  throw error
}

/** A 404 as nothing there, for a call made whether or not there is anything to find */
function unless404(error: unknown): null {
  if (error instanceof TunnelError && error.status === 404) return null
  throw error
}

/** A method's options as the route's query parameters: each one given, as its text, under the
 *  route's name for it, which is its own but for qBody's, q_body */
function queryOf(options: object | undefined): [string, string][] {
  const query: [string, string][] = []
  for (const [name, value] of Object.entries(options ?? {})) {
    if (value !== undefined) query.push([name === 'qBody' ? 'q_body' : name, String(value)])
  }
  return query
}

/** What POST /record/start and /record/stop answer, without its success */
function recordingStatus(answer: unknown): RecordingStatus {
  const { active, session, count } = answer as RecordingStatus
  return { active, session, count }
}

/** A function rule as the handle hands one out: in the shape GET /mocks gives a stored rule, a copy
 *  in which a big integer is a BigInt, with its handler */
function functionRule(rule: TunnelRequestConfig, handler: Handler): Rule {
  const copy = parseScriptJson(stringifyScriptJson(mockToDict(rule))) as Rule
  return { ...copy, handler }
}

/** The handle startTunnel() resolves with, which the Tunnel interface describes */
class TunnelHandle implements Tunnel {
  readonly proxyPort: number
  readonly adminPort: number
  readonly proxyUrl: string
  readonly adminUrl: string
  readonly configDir: string
  readonly caFile: string
  readonly #core: TunnelCore
  readonly #proxy: ProxyServer
  readonly #admin: AdminServer
  readonly #ca: CertificateAuthority
  /** A temporary configDir, and the exit listener that removes it should stop() never come */
  readonly #temporary: { dir: string; removeOnExit: () => void } | null
  /** stop()'s promise, from its first call on */
  #stopping: Promise<void> | null = null
  /** The decrypt() before this one, which this one waits for */
  #sslTurn: Promise<unknown> = Promise.resolve()

  constructor(started: {
    core: TunnelCore
    proxy: ProxyServer
    admin: AdminServer
    ca: CertificateAuthority
    paths: Paths
    temporary: string | null
  }) {
    const { core, proxy, admin, ca, paths, temporary } = started
    this.#core = core
    this.#proxy = proxy
    this.#admin = admin
    this.#ca = ca
    this.proxyPort = proxy.port
    this.adminPort = admin.port
    // A port that listens on every interface is reached on the loopback, as `tunnel check` reaches
    // it (cli-common.ts, proxyAddress). An IPv6 address goes in brackets, as a URL has one
    const everywhere = proxy.host === '0.0.0.0' || proxy.host === '::' || proxy.host === ''
    const host = everywhere ? '127.0.0.1' : proxy.host
    this.proxyUrl = `http://${isIP(host) === 6 ? `[${host}]` : host}:${proxy.port}`
    this.adminUrl = `http://127.0.0.1:${admin.port}`
    this.configDir = paths.config_dir
    this.caFile = paths.caFile
    if (temporary === null) {
      this.#temporary = null
    } else {
      // Synchronous, as whatever runs on exit has to be
      const removeOnExit = (): void => rmSync(temporary, { recursive: true, force: true })
      process.on('exit', removeOnExit)
      this.#temporary = { dir: temporary, removeOnExit }
    }
  }

  async status(): Promise<Status> {
    const health = (await this.#call('GET', '/health')) as Status
    const sessions = (await this.#call('GET', '/sessions')) as Pick<Status, 'session' | 'sessions'>
    return { ...health, ...sessions, mocks: health.mocks + this.#core.functions.size }
  }

  async getConfig(): Promise<Settings> {
    return (await this.#call('GET', '/config')) as Settings
  }

  async setConfig(patch: SettingsPatch): Promise<Settings> {
    const answer = (await this.#call('PATCH', '/config', { body: patch })) as { config: Settings }
    return answer.config
  }

  async decrypt(
    hosts: string | readonly string[],
    options?: { exclude?: boolean; remove?: boolean },
  ): Promise<SslProxying> {
    this.#live()
    refuseUnknown(options, ['exclude', 'remove'])
    const patterns = typeof hosts === 'string' ? [hosts] : hosts
    const which = options?.exclude === true ? 'exclude' : 'include'
    // From the read to the write, behind the decrypt() before this one, as the MCP decrypt tool
    // goes (mcp.ts): two at once would each save the lists without the other's host
    const turn = this.#sslTurn.then(async () => {
      const { ssl_proxying } = (await this.#call('GET', '/config')) as Settings
      const policy = userErrorsAs400(() =>
        sslPatch(ssl_proxying, which, patterns, options?.remove !== true),
      )
      const body = { ssl_proxying: policy }
      const answer = (await this.#call('PATCH', '/config', { body })) as { config: Settings }
      return answer.config.ssl_proxying
    })
    // One that failed fails alone: the next goes ahead
    this.#sslTurn = turn.catch(() => {})
    return turn
  }

  async listRules(key?: string): Promise<Rule[]> {
    this.#live()
    const functions = this.#core.functions
    // An empty key is none, as the route reads it
    if (!key) {
      const { mocks } = (await this.#call('GET', '/mocks')) as { mocks: Rule[] }
      const held = Object.keys(functions.rules()).map((name) => functions.get(name)!)
      return [...mocks, ...held.map(({ rule, handler }) => functionRule(rule, handler as Handler))]
    }
    const normalized = userErrorsAs400(() => normaliseKey(key))
    const query: [string, string][] = [['key', normalized]]
    const held = functions.get(normalized)
    if (held === null) {
      const { mocks } = (await this.#call('GET', '/mocks', { query })) as { mocks: Rule[] }
      return mocks
    }
    // A function rule has its key to itself, unless the panel or the CLI, which do not see it,
    // stored a rule with that key behind its back: then both are listed
    const stored = await this.#call('GET', '/mocks', { query }).catch(unless404)
    const mocks = stored === null ? [] : (stored as { mocks: Rule[] }).mocks
    return [...mocks, functionRule(held.rule, held.handler as Handler)]
  }

  async setRule(rule: RulePatch | FunctionRulePatch): Promise<Rule> {
    this.#live()
    const functions = this.#core.functions
    // Without a handler, a stored rule, whatever else it holds, for the route to judge
    if (!isJsonObject(rule) || !Object.hasOwn(rule, 'handler')) {
      const { mock } = (await this.#call('PATCH', '/mocks', { body: rule })) as { mock: Rule }
      // One rule to a key: a stored rule replaces the function rule with its key
      functions.delete(mock.key)
      return mock
    }
    const { handler, ...fields } = rule as Record<string, unknown>
    if (typeof handler !== 'function') {
      throw new TunnelError(400, `handler must be a function, not ${typeof handler}`)
    }
    if (fields.mode !== undefined && fields.mode !== 'script') {
      const detail = `a rule with a handler is in script mode, not ${repr(String(fields.mode))}`
      throw new TunnelError(400, detail)
    }
    if (fields.script !== undefined && fields.script !== '') {
      throw new TunnelError(400, 'a rule with a handler answers with it, not with a script')
    }
    // Checked as the route checks a body, and so as JSON first, as a body would carry the fields
    const checked = userErrorsAs400(() => checkMockPatch(parseJson(stringifyScriptJson(fields))))
    if (!checked.ok) {
      // The route's 422, as it comes back through JSON: a big integer in an input a BigInt
      const body = validationErrorBody(checked.issues)
      const { detail } = parseScriptJson(JSON.stringify(body)) as { detail: ValidationIssue[] }
      throw new TunnelError(422, detail)
    }
    // Whole, from the defaults and the fields given: no PATCH across two kinds of rule
    const { key } = checked
    const made = makeTunnelRequestConfig({
      request_key: key,
      ...checked.fields,
      mode: 'script',
      script: '',
    })
    functions.set(made, handler as FunctionHandler)
    // One rule to a key: a function rule replaces the stored rule with its key
    await this.#call('DELETE', '/mocks', { query: [['key', key]] }).catch(unless404)
    return functionRule(made, handler as Handler)
  }

  async deleteRule(key: string): Promise<string> {
    this.#live()
    const normalized = userErrorsAs400(() => normaliseKey(key))
    // The function rule first: should a stored rule have its key too, that answers from now on
    if (this.#core.functions.delete(normalized)) return normalized
    const query: [string, string][] = [['key', normalized]]
    return ((await this.#call('DELETE', '/mocks', { query })) as { deleted: string }).deleted
  }

  async applyScenario(
    scenario: Scenario | string,
    options?: { replace?: boolean },
  ): Promise<{ applied: string[]; replaced: boolean }> {
    this.#live()
    refuseUnknown(options, ['replace'])
    let body: unknown = scenario
    if (typeof scenario === 'string') {
      body = userErrorsAs400(() => expandScenario(defaultDeps(), scenario))
    } else if (isJsonObject(scenario)) {
      // The route judges the rest; a function it would never see: JSON would drop it without a
      // word, and that rule would go in as a passthrough
      const { mocks } = scenario
      if (
        Array.isArray(mocks) &&
        mocks.some((mock) => isJsonObject(mock) && Object.hasOwn(mock, 'handler'))
      ) {
        const detail =
          'a scenario holds stored rules only; a rule with a handler goes in with setRule()'
        throw new TunnelError(400, detail)
      }
      body = { ...scenario }
    }
    // As `tunnel apply --replace` puts it in
    if (options?.replace === true && isJsonObject(body)) body.replace = true
    const answer = await this.#call('POST', '/mocks/apply', { body })
    const { applied, replaced } = answer as { applied: string[]; replaced: boolean }
    // One rule to a key: what was applied replaces the function rules with its keys, and a
    // replace, which cleared every stored rule, every function rule too
    const functions = this.#core.functions
    if (replaced) functions.clear()
    else for (const key of applied) functions.delete(key)
    return { applied, replaced }
  }

  async resetState(key?: string): Promise<string[]> {
    // No key, no body: every rule's
    const body = key === undefined ? undefined : { key }
    const answer = (await this.#call('POST', '/state/reset', { body })) as { cleared: string[] }
    return answer.cleared
  }

  listRequests(filters: RequestFilters & { each: true }): Promise<RequestList<ExchangeSummary>>
  listRequests(filters?: RequestFilters & { each?: false }): Promise<RequestList<AggregateRow>>
  async listRequests(
    filters?: RequestFilters & { each?: boolean },
  ): Promise<RequestList<ExchangeSummary | AggregateRow>> {
    this.#live()
    refuseUnknown(filters, [
      'key',
      'host',
      'since',
      'last',
      'unmatched',
      'encrypted',
      'q',
      'qBody',
      'each',
    ])
    const answer = await this.#call('GET', '/requests', { query: queryOf(filters) })
    return answer as RequestList<ExchangeSummary | AggregateRow>
  }

  async getRequest(seq: number): Promise<Exchange> {
    return (await this.#call('GET', `/requests/${seq}`)) as Exchange
  }

  async waitForRequest(options?: WaitOptions): Promise<WaitResult> {
    this.#live()
    refuseUnknown(options, ['key', 'count', 'since', 'timeout', 'query'])
    const { query: wanted, ...rest } = options ?? {}
    // A q=name=value of the route's for each pair, every one of which a request has to carry
    const pairs = Object.entries(wanted ?? {}).map(([name, value]): [string, string] => [
      'q',
      `${name}=${value}`,
    ])
    const query = [...queryOf(rest), ...pairs]
    return (await this.#call('GET', '/requests/wait', { query })) as WaitResult
  }

  async clearRequests(): Promise<number> {
    return ((await this.#call('POST', '/requests/clear')) as { last_seq: number }).last_seq
  }

  async check(method: string, url: string, options?: CheckOptions): Promise<CheckAnswer> {
    this.#live()
    refuseUnknown(options, ['body', 'contentType'])
    const target = URL.canParse(url) ? new URL(url) : null
    if (target === null || (target.protocol !== 'http:' && target.protocol !== 'https:')) {
      throw new TunnelError(400, `${repr(String(url))} is not an http or https URL`)
    }
    const { body, contentType } = options ?? {}
    return sendThroughProxy({
      proxy: this.proxyUrl,
      // The CA this tunnel signs with, and no other, as `tunnel check` trusts its server's alone
      ca: this.#ca.certificatePem(),
      method: method.toUpperCase(),
      url: target.origin + target.pathname + target.search,
      body: body === undefined ? null : Buffer.from(body),
      contentType: contentType ?? null,
    })
  }

  async startRecording(session?: string): Promise<RecordingStatus> {
    // No session, no body: the session in hand
    const body = session === undefined ? undefined : { session }
    return recordingStatus(await this.#call('POST', '/record/start', { body }))
  }

  async stopRecording(): Promise<RecordingStatus> {
    return recordingStatus(await this.#call('POST', '/record/stop'))
  }

  async listRecordings(filters?: {
    session?: string
    key?: string
    host?: string
  }): Promise<RecordingRow[]> {
    this.#live()
    refuseUnknown(filters, ['session', 'key', 'host'])
    const answer = await this.#call('GET', '/recordings', { query: queryOf(filters) })
    return (answer as { recordings: RecordingRow[] }).recordings
  }

  async getRecording(session: string, seq: number): Promise<Exchange> {
    // Encoded, as app.fetch decodes a path's parameters: the route gets the name as it was given
    const path = `/recordings/${encodeURIComponent(session)}/${seq}`
    return (await this.#call('GET', path)) as Exchange
  }

  async importRecordings(
    from: readonly Exchange[] | string,
    options?: { session?: string; replace?: boolean },
  ): Promise<{ imported: number; sessions: string[]; replaced: boolean }> {
    this.#live()
    refuseUnknown(options, ['session', 'replace'])
    // As `tunnel recordings import --replace` asks for it
    const replace = options?.replace === true
    if (typeof from !== 'string') {
      // All at once, into the session given or else the route's default; what is not an array is
      // the route's to refuse
      const body = { exchanges: from, session: options?.session, replace }
      const answer = await this.#call('POST', '/recordings/import', { body })
      const { imported, session, replaced } = answer as {
        imported: number
        session: string
        replaced: boolean
      }
      return { imported, sessions: [session], replaced }
    }
    // Refused rather than ignored, as caDir is with a configDir
    if (options?.session !== undefined) {
      const detail = 'session goes with an array of exchanges: a directory names its own sessions'
      throw new TunnelError(400, detail)
    }
    // Read as `tunnel recordings import` reads it, by its very function, and put in as it puts it,
    // a session at a time
    const current = async () =>
      ((await this.#call('GET', '/sessions')) as { session: string }).session
    const tree = await readRecordingsTree(defaultDeps(), from, current).catch(rethrowAs400)
    let imported = 0
    for (const part of tree) {
      const answer = await this.#call('POST', '/recordings/import', { body: { ...part, replace } })
      imported += (answer as { imported: number }).imported
    }
    return { imported, sessions: tree.map(({ session }) => session), replaced: replace }
  }

  async deleteRecordings(session?: string): Promise<number> {
    // No session: every session's
    const query: [string, string][] = session === undefined ? [] : [['session', session]]
    return ((await this.#call('DELETE', '/recordings', { query })) as { deleted: number }).deleted
  }

  stop(): Promise<void> {
    this.#stopping ??= this.#shutDown()
    return this.#stopping
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.stop()
  }

  /** As `tunnel serve` stops: the proxy port, then the admin port, whose close() answers the waits
   *  still in progress with 503 and closes the core. Then the temporary directory */
  async #shutDown(): Promise<void> {
    await this.#proxy.close()
    await this.#admin.close()
    if (this.#temporary !== null) {
      process.off('exit', this.#temporary.removeOnExit)
      await rm(this.#temporary.dir, { recursive: true, force: true, maxRetries: 3 })
    }
  }

  /** Every call is refused from the moment stop() is called */
  #live(): void {
    if (this.#stopping !== null) throw new TunnelError(503, 'the tunnel is stopped')
  }

  /** One call of the admin API, made in this process on the app the admin port answers with, so
   *  that the defaults, the checks and the words are the route's own. Resolves with the answer, an
   *  integer past 2^53 in it a BigInt; a status of 400 or more rejects with a TunnelError that
   *  holds the answer's detail, or its text when it has none */
  async #call(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    options?: { query?: [string, string][]; body?: unknown },
  ): Promise<unknown> {
    this.#live()
    // tunnel.invalid can never resolve (RFC 6761): the request never leaves this process
    const url = new URL(`http://tunnel.invalid/__admin__${path}`)
    for (const [name, value] of options?.query ?? []) url.searchParams.append(name, value)
    const init: RequestInit = { method }
    if (options?.body !== undefined) {
      init.body = stringifyScriptJson(options.body)
      init.headers = { 'content-type': 'application/json' }
    }
    const response = await this.#admin.app.fetch(new Request(url, init))
    const text = await response.text()
    let answer: unknown = text
    try {
      answer = parseScriptJson(text)
    } catch {
      // Not JSON, such as the plain text of a 500: the text as it is
    }
    if (response.status >= 400) {
      const detail = isJsonObject(answer) && Object.hasOwn(answer, 'detail') ? answer.detail : text
      throw new TunnelError(response.status, detail as string | ValidationIssue[])
    }
    return answer
  }
}
