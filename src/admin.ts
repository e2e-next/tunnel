// The JSON management API, for the CLI, for coding agents and for a client's own test cases.
//
// It is the first class contract; `tunnel` is a thin wrapper around it. PATCH updates only the
// fields it is given, and a whole set of mocks can be applied or exported at once as a scenario. It
// answers on the admin port only, which stays bound to the loopback address: it configures scripts
// that run on this machine.
//
// The router is handed the manager, the core and the CA (AdminDeps) and keeps nothing of its own,
// so two of them in one process never meet. A body is read with parseJson and checked with check()
// (json.ts, validate.ts), not with Hono's validator(): that one rounds an integer past 2^53,
// answers bad JSON with a 400 and takes a body of another content type for {}.
import { performance } from 'node:perf_hooks'
import { Hono, type Context } from 'hono'
import { stream } from 'hono/streaming'
import type { CertificateAuthority } from './certs.ts'
import type { TunnelConfigManager } from './config.ts'
import type { TunnelCore } from './core.ts'
import { repr, UserError, type ValidationIssue } from './errors.ts'
import { aggregate, exchangeSummary, type Exchange, type ExchangeLog } from './exchanges.ts'
import { parseJson, stringifySpaced, type JsonValue } from './json.ts'
import { getLogger } from './log.ts'
import {
  DEFAULT_SESSION,
  TUNNEL_CONFIG_SCHEMA,
  TUNNEL_REQUEST_CONFIG_SCHEMA,
  type TunnelConfig,
  type TunnelRequestConfig,
} from './models.ts'
import { VERSION } from './package-info.ts'
import { sessionName } from './recordings.ts'
import { normaliseKey } from './rule-keys.ts'
import { compileScript } from './script.ts'
import {
  anyValue,
  atLeast,
  bool,
  check,
  dictOf,
  float,
  int,
  issue,
  listOf,
  model,
  nullable,
  optional,
  required,
  str,
  validationErrorBody,
  withDefault,
  type ModelSchema,
  type Run,
  type Schema,
} from './validate.ts'

const logger = getLogger('admin')

/** How long the event stream stays silent before it sends a window as a keep-alive. An idle
 *  connection is dropped somewhere between the browser and here sooner or later, and a panel that
 *  quietly stopped updating is worse than one that reconnects */
export const HEARTBEAT_MS = 15_000

/** What health reports under `proxy`: the shape of ProxyServer.describe() (proxy.ts) */
export interface ProxyInfo {
  host: string
  port: number
  lan_ips: string[]
}

/** The services the admin port works on. One set per process, built by `tunnel serve` or by a test */
export interface AdminDeps {
  manager: TunnelConfigManager
  core: TunnelCore // its .exchanges and .recordings are what the log and recording routes use
  ca: CertificateAuthority
  /** Asked on every health call. Absent, or returning null, means the proxy port is not listening (health.proxy: null) */
  proxy?: () => ProxyInfo | null
}

export interface AdminOptions {
  /** The event stream's keep-alive interval. The test 'the stream says it is alive with a window'
   *  passes 50 */
  heartbeatMs?: number // default HEARTBEAT_MS
  /** Aborted by the server's close(): every event stream ends, every wait answers 503 */
  closing?: AbortSignal
}

// ---- Request bodies
//
// Every field takes the schema the stored model has for it, so a patch converts a value exactly as
// storing it would ("201" and 201.0 are 201). A field left out stays out of the result. A null is
// refused with a 422 for a field the model cannot hold null in: only the four fields that give null
// a meaning take it.

const RULE = TUNNEL_REQUEST_CONFIG_SCHEMA.fields
const CONFIG = TUNNEL_CONFIG_SCHEMA.fields

/** A patch for one mock: a field that is not sent keeps the value it has.
 *
 *  The key is `METHOD:[host[:port]]/path`: `GET:/api/feed` answers for any host,
 *  `GET:api.example.com/api/feed` for one, and `*` is a wildcard in both the host and the path
 *  (`GET:*.example.com/api/user/*`). */
interface MockPatch extends Partial<Omit<TunnelRequestConfig, 'request_key'>> {
  key: string
}

const MOCK_PATCH = model<MockPatch>(
  'MockPatch',
  {
    key: required(str),
    mode: optional(RULE.mode.schema),
    json_response: optional(RULE.json_response.schema),
    status_code: optional(RULE.status_code.schema),
    enabled: optional(RULE.enabled.schema),
    description: optional(RULE.description.schema),
    merge_json: optional(RULE.merge_json.schema),
    headers: optional(RULE.headers.schema),
    target: optional(RULE.target.schema),
    response_delay: optional(RULE.response_delay.schema),
    script: optional(RULE.script.schema),
    replay_session: optional(RULE.replay_session.schema),
    replay_strategy: optional(RULE.replay_strategy.schema),
    fault: optional(RULE.fault.schema),
    fault_seconds: optional(RULE.fault_seconds.schema),
  },
  // A misspelt field name is an error, not something quietly ignored
  { extra: 'forbid' },
)

/** A patch for the global settings: a field that is not sent keeps its value.
 *
 *  `ssl_proxying` and `allow_clients` are replaced whole rather than merged: `tunnel ssl add` reads
 *  the current lists, edits them and sends them back. */
interface ConfigPatch extends Partial<
  Pick<
    TunnelConfig,
    | 'default_mode'
    | 'max_requests_history'
    | 'auto_record_requests'
    | 'ssl_proxying'
    | 'allow_clients'
    | 'redact_headers'
    | 'replay_marker'
  >
> {
  /** null is the default session, as sessionName(null) is */
  session?: string | null
}

const CONFIG_PATCH = model<ConfigPatch>(
  'ConfigPatch',
  {
    default_mode: optional(CONFIG.default_mode.schema),
    session: optional(nullable(str)),
    max_requests_history: optional(CONFIG.max_requests_history.schema),
    auto_record_requests: optional(CONFIG.auto_record_requests.schema),
    ssl_proxying: optional(CONFIG.ssl_proxying.schema),
    allow_clients: optional(CONFIG.allow_clients.schema),
    redact_headers: optional(CONFIG.redact_headers.schema),
    replay_marker: optional(CONFIG.replay_marker.schema),
  },
  { extra: 'forbid' },
)

/** A set of mocks applied in one go */
interface Scenario {
  config?: ConfigPatch | null
  mocks: MockPatch[]
  /** True clears every mock that is configured, then applies this scenario */
  replace: boolean
}

const SCENARIO = model<Scenario>(
  'Scenario',
  {
    config: optional(nullable(CONFIG_PATCH)),
    mocks: withDefault(listOf(MOCK_PATCH), () => []),
    replace: withDefault(bool, () => false),
  },
  { extra: 'forbid' },
)

interface StateReset {
  key?: string | null
}

const STATE_RESET = model<StateReset>(
  'StateReset',
  { key: optional(nullable(str)) },
  { extra: 'forbid' },
)

/** Which session `POST /record/start` writes into.
 *
 *  null is the session in hand: it is the one a replay reads too, so recording into it is what an
 *  ordinary `tunnel record start` means. A name switches the current session first. */
interface RecordStart {
  session?: string | null
}

const RECORD_START = model<RecordStart>(
  'RecordStart',
  { session: optional(nullable(str)) },
  { extra: 'forbid' },
)

/** Recordings made elsewhere, on their way back in.
 *
 *  `exchanges` are the files a `tunnel recordings export` tree holds, in the shape
 *  `GET /requests/{seq}` returns; `replace` empties the session first, which is what a CI run wants
 *  so that nothing from a previous run survives. */
interface RecordingImport {
  exchanges: Record<string, JsonValue>[]
  session: string
  replace: boolean
}

const RECORDING_IMPORT = model<RecordingImport>(
  'RecordingImport',
  {
    exchanges: required(listOf(dictOf(anyValue))),
    session: withDefault(str, () => DEFAULT_SESSION),
    replace: withDefault(bool, () => false),
  },
  { extra: 'forbid' },
)

// ---- Reading a request

/** What readBody hands a route: the body as its model made it, or the 422 to answer with */
type Body<T> = { ok: true; value: T } | { ok: false; response: Response }

/** A content type whose body is parsed as JSON: application/json or application/<something>+json,
 *  any parameters after it */
const JSON_CONTENT_TYPE = /^application\/([a-z0-9.-]+\+)?json\b/i

/** A route's handler. Every one goes through guard() */
type Handler = (c: Context) => Response | Promise<Response>

/** The 422 for these issues, with the validation error body */
function invalid(c: Context, issues: ValidationIssue[]): Response {
  return c.json(validationErrorBody(issues), 422)
}

/**
 * The request body checked against schema. No body, an empty one and JSON's null all count as none
 * sent: a 422 `missing` when the route needs one, null when it does not. A body whose content type
 * is not JSON is not parsed: the model refuses its text as model_attributes_type. Bad JSON is
 * json_invalid at ['body', <position>], where V8's message gives the position and the words.
 */
function readBody<T>(
  c: Context,
  schema: ModelSchema<T>,
  options: { required: true },
): Promise<Body<T>>
function readBody<T>(
  c: Context,
  schema: ModelSchema<T>,
  options: { required: false },
): Promise<Body<T | null>>
async function readBody<T>(
  c: Context,
  schema: ModelSchema<T>,
  options: { required: boolean },
): Promise<Body<T | null>> {
  const text = await c.req.text()
  let value: unknown = null
  if (!JSON_CONTENT_TYPE.test(c.req.header('content-type') ?? '')) {
    if (text !== '') value = text
  } else if (text !== '') {
    try {
      value = parseJson(text)
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      const position = Number(/at position (\d+)/.exec(error.message)?.[1] ?? 0)
      const response = invalid(c, [
        issue('json_invalid', ['body', position], {}, { error: error.message }),
      ])
      return { ok: false, response }
    }
  }
  if (value === null) {
    if (!options.required) return { ok: true, value: null }
    return { ok: false, response: invalid(c, [issue('missing', ['body'], null)]) }
  }
  const result = check(schema, value, { at: ['body'], fromAttributes: true })
  return result.ok
    ? { ok: true, value: result.value }
    : { ok: false, response: invalid(c, result.issues) }
}

/** A query parameter: the last of a repeated one (Hono's query() gives the first), null when it is
 *  not there. A string goes on as it is, an empty one included: what '' means is for the code below
 *  to say */
function queryParam(c: Context, name: string): string | null {
  return c.req.queries(name)?.at(-1) ?? null
}

/** A query parameter that has a type: fallback when it is not there, else what schema makes of it.
 *  Its issue goes into issues, so that a route reads every parameter in the order it declares them
 *  and answers one 422 with all of them */
function query<T, F>(
  c: Context,
  name: string,
  schema: Schema<T>,
  fallback: F,
  issues: ValidationIssue[],
): T | F {
  const raw = queryParam(c, name)
  if (raw === null) return fallback
  const result = check(schema, raw, { at: ['query', name] })
  if (result.ok) return result.value
  issues.push(...result.issues)
  return fallback
}

/** A UserError is the caller's mistake, a bad key or session name or script: a 400 with its
 *  sentence, said once here rather than in every route. Anything else is a bug, left to
 *  createAdminApp's onError and its 500 */
function guard(handler: Handler): Handler {
  return async (c) => {
    try {
      return await handler(c)
    } catch (error) {
      if (error instanceof UserError) return c.json({ detail: error.message }, 400)
      throw error
    }
  }
}

// ---- Rules and settings

/** One mock checked, its canonical key and the fields to update.
 *
 *  Nothing is written here, so a whole batch can be checked before any of it is applied. */
function validatePatch(
  patch: MockPatch,
): [string, Partial<Omit<TunnelRequestConfig, 'request_key'>>] {
  const { key: given, ...fields } = patch
  const key = normaliseKey(given)
  if (fields.script) compileScript(fields.script, key)
  if (fields.replay_session) {
    // A session is a directory, and the store refuses a name it would have to rewrite rather than
    // file the recordings somewhere nobody asked for. A rule that names a session is held to that
    // too, or `--session 'acct a'` would quietly replay whatever is in `acct_a`. An empty one is
    // not a name at all: it says to follow the current session.
    fields.replay_session = sessionName(fields.replay_session)
  }
  return [key, fields]
}

/** What PATCH /mocks makes of its body, for a body no request brought: the library's function
 *  rules, which never reach the route. The
 *  two steps the route takes: the model's issues come back, its 422, and validatePatch's
 *  UserError is thrown, its 400 */
export function checkMockPatch(
  value: unknown,
):
  | { ok: true; key: string; fields: Partial<Omit<TunnelRequestConfig, 'request_key'>> }
  | { ok: false; issues: ValidationIssue[] } {
  const checked = check(MOCK_PATCH, value, { at: ['body'], fromAttributes: true })
  if (!checked.ok) return checked
  const [key, fields] = validatePatch(checked.value)
  return { ok: true, key, fields }
}

/** The shape /mocks/apply takes back: request_key becomes key, and leads */
export function mockToDict(
  config: TunnelRequestConfig,
): { key: string } & Omit<TunnelRequestConfig, 'request_key'> {
  const { request_key, ...rest } = config
  return { key: request_key, ...rest }
}

/** The settings a patch changes, with the session held to a directory name; none for no patch */
function configFields(patch: ConfigPatch | null | undefined): Partial<TunnelConfig> {
  if (!patch) return {}
  const { session, ...fields } = patch
  return session === undefined ? fields : { ...fields, session: sessionName(session) }
}

/** The global settings without the rules, which are /mocks */
function settingsOf(config: TunnelConfig): Omit<TunnelConfig, 'request_configs'> {
  const { request_configs, ...settings } = config
  return settings
}

// ---- The long poll

/** A float read from a query parameter, inf and nan included. validate.ts's float refuses both as
 *  finite_number, for config.json's sake; a query string spoils no file. As the wait's timeout, nan
 *  and -inf are no more at least 0 than -1 is, and inf is the longest wait there is */
const floatInfNan: Schema<number> = {
  check(input, at, run) {
    const tried: Run = { issues: [], fromAttributes: run.fromAttributes }
    const value = float.check(input, at, tried)
    if (tried.issues[0]?.type !== 'finite_number') {
      run.issues.push(...tried.issues)
      return value
    }
    // float read a number that is not finite. Number(), which it reads with, makes NaN of the
    // words inf and infinity, so the text tells nan from an infinity, and the sign is the first
    // thing in it that is not white space
    const text = String(input).replaceAll('_', '')
    if (/nan/i.test(text)) return NaN
    return /^[^+\-.\dA-Za-z]*-/.test(text) ? -Infinity : Infinity
  },
}

/** `q=page=2` repeated, as the values a request has to carry; a name given twice keeps its last
 *  value. A Map, so that __proto__ is a name like any other */
function queryFilter(pairs: readonly string[]): Map<string, string> {
  const wanted = new Map<string, string>()
  for (const pair of pairs) {
    const separator = pair.indexOf('=')
    // No '=', or no name before it
    if (separator <= 0) {
      throw new UserError(`${repr(pair)} is not a query filter; the shape is name=value`)
    }
    wanted.set(pair.slice(0, separator), pair.slice(separator + 1))
  }
  return wanted
}

/** The seqs of the requests a wait is counting, oldest first */
function matching(
  log: ExchangeLog,
  key: string | null,
  since: number | null,
  wanted: Map<string, string>,
): number[] {
  const pairs = [...wanted]
  return log
    .select({ key, since })
    .filter(({ request }) => pairs.every(([name, value]) => request.query[name] === value))
    .map((exchange) => exchange.seq)
}

/** A seq from the path, every digit of it, for a 404 to name. validate.ts's int reads it into the
 *  double nearest it, which keeps 53 bits, so past those the digits come from what was sent. int
 *  has found that to be an integer already: a sign, zeros and underscores around its digits, and
 *  zeros alone after a '.'; a '-' is a minus wherever it stands, int reading "0-1" as -1 */
function seqText(sent: unknown, read: number): string {
  if (Number.isSafeInteger(read)) return String(read)
  const text = String(sent)
  const digits = text.replace(/\..*/, '').replace(/\D/g, '')
  return String(BigInt(`${text.includes('-') ? '-' : ''}${digits}`))
}

// ---- The event stream

/** One exchange as a server-sent event: the summary, without the bodies.
 *
 *  The bodies are left out on purpose — a row is a line in a list, and the panel fetches
 *  `requests/{seq}` for the one row somebody opened. */
function sseEvent(exchange: Exchange): string {
  // Spread into an object literal: an interface has no index signature, so TypeScript takes
  // ExchangeSummary for a JsonValue only this way, field by field, with no cast
  const data = stringifySpaced({ ...exchangeSummary(exchange) })
  // The id is what the browser sends back as Last-Event-ID when it reconnects, which is how a
  // reconnect picks up where the stream stopped.
  return `id: ${exchange.seq}\ndata: ${data}\n\n`
}

/** Which seqs the log still holds, as a named server-sent event.
 *
 *  A client holding rows of its own drops everything below `first_seq`, which is how a clear and
 *  a buffer that overflowed come to the same thing for it. This is a state and not a step: sending
 *  it again is harmless, and missing one costs nothing because the next one corrects it.
 *
 *  No `id:` line, deliberately. The id is what a browser hands back as Last-Event-ID, so it has to
 *  stay the seq of the last exchange the client actually saw; one on a window would have a
 *  reconnect resume from a position that is not an exchange. The event is named for the same
 *  reason adding it is safe at all: EventSource gives `onmessage` the unnamed events only, so
 *  nothing that has not asked for this one ever sees it. */
function sseWindow(log: ExchangeLog): string {
  const data = stringifySpaced({ first_seq: log.firstSeq, last_seq: log.lastSeq })
  return `event: window\ndata: ${data}\n\n`
}

// ---- The routes

/** A method a route answers. HEAD comes with GET: Hono answers it from the GET handler, bodiless */
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'

/** The JSON management API under /__admin__ and the CA download at /ca.pem, as one Hono app;
 *  createAdminApp() mounts it. No module state: everything comes in through deps */
export function adminRouter(deps: AdminDeps, options?: AdminOptions): Hono {
  const { manager, core, ca } = deps
  const log = core.exchanges
  const recordings = core.recordings
  const closing = options?.closing
  const heartbeatMs = options?.heartbeatMs ?? HEARTBEAT_MS

  // Path by path, in the order Hono matches them, which is the order they are added in. That
  // order matters in one place: /requests/clear and /requests/wait come before /requests/:seq,
  // or "wait" would be read as a seq. A path's methods are listed in the order allow names them
  const routes: Record<string, Partial<Record<Method, Handler>>> = {
    '/__admin__/health': {
      /** Liveness: how the CLI tells whether the server is up */
      GET: async (c) => {
        const config = manager.getConfig()
        return c.json({
          status: 'ok',
          // Which tunnel this is: a client's test setup reads it to tell whether the server it
          // found is the one it needs.
          version: VERSION,
          // Where this server reads and writes: the answer to "where did my mocks go"
          ...manager.paths.describe(),
          mocks: Object.keys(config.request_configs).length,
          // How much of the request log is in memory, which seqs that is, and how far the count
          // got. A caller holding rows of its own drops the ones below `first_seq`: the server
          // has let go of them.
          exchanges: log.size,
          first_seq: log.firstSeq,
          last_seq: log.lastSeq,
          // Which CA the devices on this network should be trusting right now
          ca_fingerprint: ca.fingerprint(),
          // Where devices point their proxy setting; null when this process runs the admin port
          // alone, without the listener.
          proxy: deps.proxy?.() ?? null,
          // Which recordings this run reads and writes — the panel's header and `tunnel status`
          // both say it, because it is what a replay answers from.
          session: config.session,
          // Whether traffic is being recorded, into which session, and how much of it is there —
          // the panel's header reads this.
          recording: await recordings.status(),
          // Which way the traffic tunnel does not answer itself leaves, as one line: `direct`, or
          // `via 127.0.0.1:3128 (system proxy)`
          upstream: await core.routes.describe(),
        })
      },
    },
    // The CA download sits at the root instead: /ca.pem is short enough to type on a phone, and it
    // is the same path the proxy port answers.
    '/ca.pem': {
      /** The CA certificate, as the content type that makes a device offer to install it. Copied
       *  into a Uint8Array of its own: c.body() takes one over an ArrayBuffer, and a Buffer's type
       *  allows a SharedArrayBuffer */
      GET: (c) =>
        c.body(new Uint8Array(ca.certificatePem()), 200, {
          'content-type': 'application/x-x509-ca-cert',
          'content-disposition': 'attachment; filename="tunnel-ca.pem"',
        }),
    },
    '/__admin__/ca': {
      /** Fingerprint, validity and where the CA lives; `tunnel ca info` prints this */
      GET: (c) => c.json(ca.info()),
    },
    '/__admin__/ca/reset': {
      /** Generate a new CA. Every device that trusted the old one must install this one.
       *
       *  It has to go through the running server rather than the files alone: the server holds the
       *  CA and the certificates minted from it in memory. */
      POST: (c) => {
        ca.reset()
        logger.warning('The CA was reset; every device has to install the new certificate')
        return c.json({ success: true, ...ca.info() })
      },
    },
    '/__admin__/config': {
      /** The global settings, without the per-endpoint rules; those are /mocks */
      GET: (c) => c.json(settingsOf(manager.getConfig())),
      /** Update the global settings, leaving the fields not sent alone */
      PATCH: async (c) => {
        const body = await readBody(c, CONFIG_PATCH, { required: true })
        if (!body.ok) return body.response
        const fields = configFields(body.value)
        if (Object.keys(fields).length === 0) return c.json({ detail: 'No fields to update' }, 400)
        return c.json({ success: true, config: settingsOf(manager.updateConfig(fields)) })
      },
    },
    '/__admin__/mocks': {
      /** Every configured mock, whole: edit what comes back and apply it again. `key` is only the
       *  mock with this key */
      GET: (c) => {
        const configs = manager.getConfig().request_configs
        const key = queryParam(c, 'key')
        if (key) {
          const normalized = normaliseKey(key)
          const config = configs[normalized]
          if (config === undefined) {
            return c.json({ detail: `No mock is configured for ${normalized}` }, 404)
          }
          return c.json({ mocks: [mockToDict(config)] })
        }
        return c.json({ mocks: Object.values(configs).map(mockToDict) })
      },
      /** Update one mock, leaving the fields not sent alone */
      PATCH: async (c) => {
        const body = await readBody(c, MOCK_PATCH, { required: true })
        if (!body.ok) return body.response
        const [key, fields] = validatePatch(body.value)
        return c.json({ success: true, mock: mockToDict(manager.updateRequestConfig(key, fields)) })
      },
      /** Delete one mock, the one with the request key `key`; the request log is left alone */
      DELETE: (c) => {
        const key = queryParam(c, 'key')
        if (key === null) return invalid(c, [issue('missing', ['query', 'key'], null)])
        const normalized = normaliseKey(key)
        if (!manager.deleteRequestConfig(normalized)) {
          return c.json({ detail: `No mock is configured for ${normalized}` }, 404)
        }
        return c.json({ success: true, deleted: normalized })
      },
    },
    '/__admin__/mocks/apply': {
      /** Apply a set of mocks; if one of them is invalid, none of them lands */
      POST: async (c) => {
        const body = await readBody(c, SCENARIO, { required: true })
        if (!body.ok) return body.response
        const scenario = body.value
        // The settings are checked along with the mocks, before anything is cleared, so that a bad
        // session name cannot take every rule with it
        const validated = scenario.mocks.map((patch) => validatePatch(patch))
        const fields = configFields(scenario.config)
        if (scenario.replace) manager.clearConfiguredRequests()
        if (Object.keys(fields).length > 0) manager.updateConfig(fields)
        for (const [key, patch] of validated) manager.updateRequestConfig(key, patch)
        return c.json({
          success: true,
          applied: validated.map(([key]) => key),
          replaced: scenario.replace,
        })
      },
    },
    '/__admin__/export': {
      /** The mocks as they stand, in the shape /mocks/apply takes back; `config` also exports the
       *  global settings.
       *
       *  The global settings are left out unless asked for: a scenario file is applied per test
       *  case, and it has no business flipping how every other endpoint of the run is answered. */
      GET: (c) => {
        const issues: ValidationIssue[] = []
        const withConfig = query(c, 'config', bool, false, issues)
        if (issues.length > 0) return invalid(c, issues)
        const current = manager.getConfig()
        const mocks = Object.values(current.request_configs).map(mockToDict)
        if (!withConfig) return c.json({ mocks })
        const config = { default_mode: current.default_mode, session: current.session }
        return c.json({ config, mocks })
      },
    },
    '/__admin__/state/reset': {
      /** Clear what one test case leaves for the next: script `ctx.state` and the counters a
       *  `sequence` replay walks. No key clears every rule's. */
      POST: async (c) => {
        const body = await readBody(c, STATE_RESET, { required: false })
        if (!body.ok) return body.response
        const key = body.value?.key ? normaliseKey(body.value.key) : null
        return c.json({ success: true, cleared: core.resetState(key) })
      },
    },
    '/__admin__/requests': {
      /** What the client actually called: aggregated by key, or one row per request.
       *
       *  The aggregate is the everyday view — which endpoints were hit, how often and what
       *  answered them. `each=1` is the log itself, oldest first, which is what `--since` and
       *  `--last` page through. */
      GET: (c) => {
        const issues: ValidationIssue[] = []
        const each = query(c, 'each', bool, false, issues)
        const key = queryParam(c, 'key')
        const host = queryParam(c, 'host')
        const since = query(c, 'since', int, null, issues)
        const last = query(c, 'last', int, null, issues)
        const unmatched = query(c, 'unmatched', bool, false, issues)
        const encrypted = query(c, 'encrypted', bool, false, issues)
        const q = queryParam(c, 'q')
        const q_body = query(c, 'q_body', bool, false, issues)
        if (issues.length > 0) return invalid(c, issues)
        const selected = log.select({ key, host, since, last, unmatched, encrypted, q, q_body })
        return c.json({
          requests: each ? selected.map(exchangeSummary) : aggregate(selected),
          // The highest seq the log has handed out, filters or no filters: what to pass as
          // `since` next time round.
          last_seq: log.lastSeq,
          unmatched_count: selected.filter((exchange) => exchange.unmatched).length,
        })
      },
    },
    '/__admin__/requests/clear': {
      /** Empty the request log, leaving the mocks alone.
       *
       *  The seq before clearing comes back, so that a test case can say "everything after this"
       *  rather than "everything". */
      POST: (c) => c.json({ success: true, last_seq: log.clear() }),
    },
    '/__admin__/requests/wait': {
      /** Hold the connection until the client has made this request, or time out.
       *
       *  This is what a test case waits on instead of sleeping: the log wakes it as soon as an
       *  exchange arrives, and the answer says which seqs matched and whether the wait gave up.
       *  `timed_out` rather than an error status — the count seen so far is an answer, and it is
       *  what the caller asserts on. */
      GET: async (c) => {
        const issues: ValidationIssue[] = []
        const key = queryParam(c, 'key')
        const count = query(c, 'count', atLeast(int, 1), 1, issues)
        const since = query(c, 'since', int, null, issues)
        // NaN never gets past this: the time left would be NaN, never at most 0, and the loop
        // below would go round for ever
        const timeout = query(c, 'timeout', atLeast(floatInfNan, 0), 10, issues)
        const q = c.req.queries('q') ?? []
        if (issues.length > 0) return invalid(c, issues)
        const wanted = queryFilter(q)
        const normalized = key ? normaliseKey(key) : null
        const answer = (seqs: number[]) =>
          c.json({
            seqs,
            count: seqs.length,
            wanted: count,
            timed_out: seqs.length < count,
            last_seq: log.lastSeq,
          })

        // No timer waits longer than 2^31 - 1 ms (past it, Node fires at once and warns), so a
        // longer timeout, inf included, gives up after 24.8 days
        const deadline = performance.now() + Math.min(timeout * 1000, 2 ** 31 - 1)
        // Subscribed before the first look, so a request answered while this is being set up
        // wakes the wait instead of slipping between the two.
        const arrivals = log.broadcaster.subscribe()
        // A client that goes away lets go of the wait at once, and so does the server closing.
        // Either way the next() waiting gets 'closed'
        const letGo = () => log.broadcaster.unsubscribe(arrivals)
        const { signal } = c.req.raw
        signal.addEventListener('abort', letGo, { once: true })
        closing?.addEventListener('abort', letGo, { once: true })
        // A listener added after the abort never hears it: a wait that comes in once the server
        // is closing (on a connection kept alive through it), or whose client is already gone, is
        // let go of here, and its first next() answers 'closed' as the abort would have made it
        if (signal.aborted || closing?.aborted) letGo()
        try {
          for (;;) {
            const seqs = matching(log, normalized, since, wanted)
            const remaining = deadline - performance.now()
            if (seqs.length >= count || remaining <= 0) return answer(seqs)
            // The queue is the wake-up, not the source: what matched is read
            // from the log itself, so a dropped entry costs nothing. The entry
            // is thrown away unread for the same reason, and that is what makes
            // a clear harmless here — it comes down this queue as a null, so the
            // loop wakes, counts the log again, finds the same answer or fewer
            // and goes back to waiting for its own deadline. Counting the wakes
            // instead would let somebody else's `tunnel reset --requests` tell a
            // waiting test case that its request had arrived.
            if ((await arrivals.next(remaining)) === 'closed') {
              if (closing?.aborted) return c.json({ detail: 'The server is shutting down' }, 503)
              // The client is gone: nobody reads this
              return answer(seqs)
            }
          }
        } finally {
          letGo()
          signal.removeEventListener('abort', letGo)
          closing?.removeEventListener('abort', letGo)
        }
      },
    },
    '/__admin__/requests/:seq': {
      /** One exchange in full: headers and bodies, request and response */
      GET: (c) => {
        const sent = c.req.param('seq')
        const seq = check(int, sent, { at: ['path', 'seq'] })
        if (!seq.ok) return invalid(c, seq.issues)
        const exchange = log.get(seq.value)
        if (exchange === null) {
          const named = seqText(sent, seq.value)
          return c.json({ detail: `No request with seq ${named} is in the log` }, 404)
        }
        return c.json(exchange)
      },
    },
    '/__admin__/events': {
      /** Every exchange as it is answered, as Server-Sent Events.
       *
       *  The panel's Monitor reads this with the browser's own `EventSource`. A `window` event
       *  says which seqs the log still holds: on connect, whenever a clear or an overflow moves
       *  them, and every heartbeatMs while nothing arrives — which is also what keeps the browser,
       *  and whatever is between it and here, from taking the silence for a dead connection. */
      GET: (c) => {
        const issues: ValidationIssue[] = []
        let since = query(c, 'since', int, null, issues)
        if (issues.length > 0) return invalid(c, issues)
        // A browser that lost the connection knows better than the `since` its first connection
        // carried: EventSource sends back the seq of the last event it actually saw, so a
        // reconnect resumes there instead of replaying the lot.
        const lastEventId = c.req.header('last-event-id')
        if (lastEventId && /^\d+$/.test(lastEventId)) since = Number(lastEventId)

        // No caching anywhere along the way, and no buffering: an event is worth nothing once it
        // is held back until the next one. Set before stream(), which keeps them
        c.header('content-type', 'text/event-stream; charset=utf-8')
        c.header('cache-control', 'no-cache')
        c.header('x-accel-buffering', 'no')
        // Hono answers a HEAD from this handler too and throws the body away unread: a stream
        // begun for one would hold its subscription until the server closed
        if (c.req.method === 'HEAD') return c.body(null)
        return stream(
          c,
          async (out) => {
            // Subscribed before the backfill is read, so an exchange that arrives between the
            // two is delivered rather than lost; one that lands in both is dropped by its seq
            // below.
            const arrivals = log.broadcaster.subscribe()
            // The client going away ends the stream at once, and so does the server closing. Either
            // way the next() waiting gets 'closed'
            const letGo = () => log.broadcaster.unsubscribe(arrivals)
            out.onAbort(letGo)
            closing?.addEventListener('abort', letGo, { once: true })
            // A listener added after the abort never hears it: a stream begun once the server is
            // closing (on a connection kept alive through it) sends its window and ends, as one
            // open at the time does
            if (closing?.aborted) letGo()
            try {
              const backfill = since === null ? [] : log.select({ since })
              let sent = backfill.at(-1)?.seq ?? since ?? 0
              for (const exchange of backfill) await out.write(sseEvent(exchange))
              // Once on connect: a panel that was open through somebody else's clear has
              // nothing to trim its own rows against until then.
              await out.write(sseWindow(log))
              // Which window the client has been told about, so that a row going out is
              // followed by a correction only when the oldest seq has really moved. One after
              // every exchange would be most of the traffic on a busy stream.
              let told = log.firstSeq
              for (;;) {
                const entry = await arrivals.next(heartbeatMs)
                if (entry === 'closed') break
                // The window is the keep-alive: it holds the connection open the way a comment
                // would, and it carries something, so a client that missed a window is right
                // again within a beat. A clear puts a change with no exchange behind it on the
                // queue, a null: the window the log holds has moved, nothing arrived, so the
                // window goes out alone.
                if (entry === 'timeout' || entry === null) {
                  told = log.firstSeq
                  await out.write(sseWindow(log))
                  continue
                }
                if (entry.seq <= sent) continue
                sent = entry.seq
                await out.write(sseEvent(entry))
                if (log.firstSeq !== told) {
                  // This arrival pushed the oldest row out of the buffer, and the client may be
                  // holding that row.
                  told = log.firstSeq
                  await out.write(sseWindow(log))
                }
              }
            } finally {
              letGo()
              closing?.removeEventListener('abort', letGo)
            }
          },
          // A bug in the loop: the stream ends and the log says why. stream() writes no
          // `event: error` into it, where streamSSE() would
          async (error) => logger.error(`event stream failed: ${error.stack ?? error}`),
        )
      },
    },
    // Recording. A session name is a directory name, so a bad one is a 400 (sessionName's
    // UserError, through guard), not a stray path
    '/__admin__/record/start': {
      /** Record every passthrough call from here on, into `session`.
       *
       *  A global switch rather than a response mode: nothing about the rules changes, the calls
       *  that reach the real server are simply kept. */
      POST: async (c) => {
        const body = await readBody(c, RECORD_START, { required: false })
        if (!body.ok) return body.response
        let session = body.value?.session ?? null
        if (session !== null) session = sessionName(session)
        return c.json({ success: true, ...(await recordings.start(session)) })
      },
    },
    '/__admin__/record/stop': {
      /** Stop recording. What is on disk stays there. */
      POST: async (c) => c.json({ success: true, ...(await recordings.stop()) }),
    },
    '/__admin__/record': {
      /** Whether recording is on, which session, and how many calls it holds */
      GET: async (c) => c.json(await recordings.status()),
    },
    '/__admin__/sessions': {
      /** The session in hand, and what every session on disk holds.
       *
       *  What `tunnel session` prints: the current one is named even when nothing has been
       *  recorded into it, since a session is a directory only once it has something in it. */
      GET: async (c) =>
        c.json({ session: manager.getConfig().session, sessions: await recordings.sessions() }),
    },
    '/__admin__/recordings': {
      /** The index, read from the directory itself: one row per recorded call. The session is
       *  passed on as it is, unchecked */
      GET: async (c) => {
        const session = queryParam(c, 'session')
        const key = queryParam(c, 'key')
        const host = queryParam(c, 'host')
        const rows = await recordings.index({ session, key, host })
        return c.json({ recordings: rows, count: rows.length })
      },
      /** Throw recordings away — one session's, or every session's */
      DELETE: async (c) => {
        const session = queryParam(c, 'session')
        // An empty one is every session
        const chosen = session ? sessionName(session) : null
        return c.json({ success: true, deleted: await recordings.delete(chosen), session: chosen })
      },
    },
    '/__admin__/recordings/import': {
      /** Put a committed copy of the recordings back, the way CI starts a run */
      POST: async (c) => {
        const body = await readBody(c, RECORDING_IMPORT, { required: true })
        if (!body.ok) return body.response
        const { exchanges, replace } = body.value
        const session = sessionName(body.value.session)
        let imported: number
        try {
          imported = await recordings.importExchanges(exchanges, session, replace)
        } catch (error) {
          // A bad entry; anything else is a bug, and its 500 is onError's
          if (!(error instanceof UserError)) throw error
          return c.json({ detail: `Not a recorded exchange: ${error.message}` }, 400)
        }
        return c.json({ success: true, imported, session, replaced: replace })
      },
    },
    '/__admin__/recordings/:session/:seq': {
      /** One recorded call in full: headers and bodies, request and response */
      GET: async (c) => {
        // The seq's 422 comes before the session's 400: the parameters are checked first
        const sent = c.req.param('seq')
        const seq = check(int, sent, { at: ['path', 'seq'] })
        if (!seq.ok) return invalid(c, seq.issues)
        const session = c.req.param('session')
        const exchange = await recordings.get(sessionName(session), seq.value)
        if (exchange === null) {
          const named = seqText(sent, seq.value)
          return c.json({ detail: `No recording with seq ${named} in session ${session}` }, 404)
        }
        return c.json(exchange)
      },
    },
  }

  const app = new Hono()
  for (const [path, handlers] of Object.entries(routes)) {
    for (const [method, handler] of Object.entries(handlers)) app.on(method, path, guard(handler))
    // Any other method on a path that is there: a 405 whose allow names every method the path has
    const allow = Object.keys(handlers).join(', ')
    app.all(path, (c) => c.json({ detail: 'Method Not Allowed' }, 405, { allow }))
  }
  return app
}
