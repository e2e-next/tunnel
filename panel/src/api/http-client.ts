/**
 * PanelApi against the real server: one fetch per method, on the same admin API
 * the CLI drives. Nothing above api/ knows this file exists.
 *
 * Three places the wire differs from what the panel reads, all bridged here so
 * that no component has to know:
 *
 * 1. Most answers are wrapped — `{mocks: […]}`, `{requests: […]}`,
 *    `{success, config}` — so each method unwraps to the bare value the
 *    interface promises.
 * 2. `GET /requests/{seq}` is nested where a row is flat, and a JSON body comes
 *    back parsed rather than as text. `normalise()` derives the flat fields the
 *    way `exchangeSummary()` does in `src/exchanges.ts`, and turns
 *    a parsed body back into the string the views print.
 * 3. `PATCH /config` forbids a field it does not own, and `GET /config` answers
 *    with more than it takes back, so a patch is filtered to what it accepts.
 */
import type { CaInfo, Config, Exchange, Health, LogWindow, RecordingRow, Rule, Summary } from './types'
import type { PanelApi, RequestQuery } from './client'

/** Relative, because the panel is served by the same app that answers here. */
const ADMIN = '/__admin__'

/**
 * Why a write did not happen, with the server's own sentence in it: the admin
 * API refuses a script it cannot compile with the line number in `detail`, and
 * that line number is the whole point of showing the message on the field.
 */
export class ApiError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

/** Whatever came back: parsed JSON when it is JSON, the raw text when it is not. */
async function read(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * The reason a refusal gives. The admin API puts a sentence in `detail` for the
 * errors it raises itself, and a list of field errors there for a 422, so both
 * are turned into one line.
 */
function detailOf(body: unknown): string | null {
  if (typeof body === 'string') return body || null
  if (!body || typeof body !== 'object') return null
  const detail = (body as { detail?: unknown }).detail
  if (typeof detail === 'string') return detail || null
  if (!Array.isArray(detail)) return null
  return detail
    .map((item) => {
      const one = item as { loc?: unknown[]; msg?: unknown }
      const where = Array.isArray(one.loc) ? one.loc.slice(1).join('.') : ''
      const what = String(one.msg ?? 'is not valid')
      return where ? `${where}: ${what}` : what
    })
    .join('; ')
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, init)
  } catch (error) {
    // A refused connection is an ApiError too, so that no caller has to tell a
    // transport failure from a refusal to be able to report either.
    throw new ApiError(`Could not reach the server: ${(error as Error).message}`, 0)
  }
  const body = await read(response)
  if (!response.ok) {
    throw new ApiError(detailOf(body) ?? `${response.status} ${response.statusText}`, response.status)
  }
  return body as T
}

const get = <T,>(path: string) => call<T>(ADMIN + path)

const send = <T,>(method: string, path: string, body?: unknown) =>
  call<T>(ADMIN + path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })

/** A GET whose 404 means "there is no such thing", not "something went wrong". */
async function maybe<T>(work: Promise<T>): Promise<T | null> {
  try {
    return await work
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null
    throw error
  }
}

/** The exchange as the server keeps it: nested, and with the body still parsed. */
interface RawExchange {
  seq: number
  time: string
  kind: 'http' | 'connect'
  request: Omit<Exchange['request'], 'body'> & { body: unknown }
  response: (Omit<NonNullable<Exchange['response']>, 'body'> & { body: unknown }) | null
  matched_by: string | null
  mode: Summary['mode']
  replay_seq: number | null
  unmatched: boolean
  client: string
  truncated: boolean
  encrypted: boolean
  bytes_up: number
  bytes_down: number
}

/**
 * A body as the string that gets printed. `body_encoding: 'json'` means the
 * body arrived as an object or an array, while CodeBlock and the curl builder
 * both take a string — so it is serialised here, once, rather than in each.
 */
function bodyText(body: unknown, encoding: string | null): string | null {
  if (body === null || body === undefined) return null
  if (encoding === 'json') return JSON.stringify(body, null, 2)
  return String(body)
}

/**
 * The flat fields a detail view reads, derived from the nested exchange exactly
 * as `exchangeSummary()` in `src/exchanges.ts` derives them, so that a row and
 * its detail never disagree about the key, the size or the status.
 */
function normalise(raw: RawExchange): Exchange {
  const { request: req, response: res } = raw
  const tunnel = raw.kind === 'connect'
  return {
    seq: raw.seq,
    time: raw.time,
    kind: raw.kind,
    key: tunnel ? `CONNECT:${req.host}:${req.port}` : `${req.method}:${req.host}${req.path}`,
    method: req.method,
    scheme: req.scheme,
    host: req.host,
    port: req.port,
    path: req.path,
    query: req.query ?? {},
    url: req.url,
    status: res ? res.status : null,
    elapsed_ms: res ? res.elapsed_ms : null,
    // One column whichever kind of row this is: the answer's size, or what a
    // tunnel nobody read carried in both directions.
    size: tunnel ? raw.bytes_up + raw.bytes_down : res ? res.size : 0,
    matched_by: raw.matched_by,
    mode: raw.mode,
    replay_seq: raw.replay_seq,
    unmatched: raw.unmatched,
    encrypted: raw.encrypted,
    truncated: raw.truncated,
    client: raw.client,
    bytes_up: raw.bytes_up,
    bytes_down: raw.bytes_down,
    request: { ...req, query: req.query ?? {}, body: bodyText(req.body, req.body_encoding) },
    response: res ? { ...res, body: bodyText(res.body, res.body_encoding) } : null,
  }
}

/**
 * What `PATCH /config` accepts. `ConfigPatch` in admin.ts forbids anything else
 * with a 422, and `GET /config` answers with fields it does not take back —
 * `recording` is read there but set through `/record/start` — so the settings
 * form, which patches with the whole config it was given, is filtered here.
 */
const PATCHABLE = [
  'default_mode',
  'session',
  'max_requests_history',
  'auto_record_requests',
  'ssl_proxying',
  'allow_clients',
  'redact_headers',
  'replay_marker',
] as const

function configPatch(patch: Partial<Config>): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  for (const name of PATCHABLE) {
    const value = patch[name]
    if (value === undefined) continue
    // A text input hands its value back as a string; the server wants a number.
    fields[name] = name === 'max_requests_history' ? Number(value) : value
  }
  return fields
}

/**
 * The query string for `GET /requests`. `each=1` is the log itself, oldest first
 * — already the order the list wants — and `last` caps what a page will hold.
 *
 * Built with URLSearchParams rather than by hand because a search term is
 * whatever was typed: `?`, `&` and `=` are exactly the characters people look
 * for in a URL, and each of them would otherwise change the query it is in.
 */
function requestQuery(query: RequestQuery): string {
  const params = new URLSearchParams({ each: '1', last: String(query.last ?? 2000) })
  if (query.q) params.set('q', query.q)
  if (query.q_body) params.set('q_body', '1')
  if (query.host) params.set('host', query.host)
  if (query.unmatched) params.set('unmatched', '1')
  if (query.encrypted) params.set('encrypted', '1')
  return params.toString()
}

export function createHttpApi(): PanelApi {
  return {
    health: () => get<Health>('/health'),
    config: () => get<Config>('/config'),
    ca: () => get<CaInfo>('/ca'),
    rules: () => get<{ mocks: Rule[] }>('/mocks').then((d) => d.mocks),
    requests: (query = {}) =>
      get<{ requests: Summary[] }>(`/requests?${requestQuery(query)}`).then((d) => d.requests),
    exchange: (seq) => maybe(get<RawExchange>(`/requests/${seq}`)).then((x) => (x ? normalise(x) : null)),
    recordedExchange: (session, seq) =>
      maybe(get<RawExchange>(`/recordings/${encodeURIComponent(session)}/${seq}`)).then((x) =>
        x ? normalise(x) : null
      ),
    sessions: () => get<{ sessions: Record<string, number> }>('/sessions').then((d) => d.sessions),
    recordings: (session) =>
      get<{ recordings: RecordingRow[] }>(`/recordings?session=${encodeURIComponent(session)}`).then(
        (d) => d.recordings
      ),

    patchConfig: (patch) =>
      send<{ config: Config }>('PATCH', '/config', configPatch(patch)).then((d) => d.config),
    saveRule: (rule) => send<{ mock: Rule }>('PATCH', '/mocks', rule).then((d) => d.mock),
    deleteRule: (key) => send<void>('DELETE', `/mocks?key=${encodeURIComponent(key)}`).then(() => undefined),
    // One call that replaces the set with nothing, rather than a delete per rule:
    // a loop would leave half the rules gone if it failed in the middle.
    deleteAllRules: () => send<void>('POST', '/mocks/apply', { replace: true, mocks: [] }).then(() => undefined),
    resetRuleState: (key) => send<void>('POST', '/state/reset', { key }).then(() => undefined),
    clearRequests: () => send<void>('POST', '/requests/clear').then(() => undefined),
    // No body at all when no session is named: that is what "the session in
    // hand" means to /record/start, and `{session: null}` is not the same thing.
    startRecording: (session) =>
      send<Health['recording']>('POST', '/record/start', session === undefined ? undefined : { session }).then(
        pickRecording
      ),
    stopRecording: () => send<Health['recording']>('POST', '/record/stop').then(pickRecording),
    deleteRecordings: (session) =>
      send<{ deleted: number }>('DELETE', `/recordings?session=${encodeURIComponent(session)}`).then(
        (d) => d.deleted
      ),

    subscribe(since, onCall, onWindow, onConnected) {
      // `since` is the last seq the caller already holds, so the stream starts
      // where its snapshot ended rather than replaying the log.
      const stream = new EventSource(`${ADMIN}/events?since=${since}`)
      stream.onopen = () => onConnected(true)
      stream.onmessage = (event) => onCall(JSON.parse(event.data) as Summary)
      // `window` is a named event, and a named event never reaches onmessage —
      // which is what makes it safe to add: no other consumer of this stream
      // sees it. The listener is the only way to hear one.
      stream.addEventListener('window', (event) =>
        onWindow(JSON.parse((event as MessageEvent).data) as LogWindow)
      )
      // No reconnect loop of our own. The browser retries by itself and sends
      // back Last-Event-ID — the seq of the last row it actually saw — which
      // `/events` uses in preference to `since`. A hand-rolled retry could
      // only reopen with the stale `since` this call was given, so it would
      // fight the one thing SSE was chosen for.
      stream.onerror = () => onConnected(false)
      return () => stream.close()
    },
  }
}

/** `{success, active, session, count}` is the recording, plus a flag nobody reads. */
function pickRecording(body: Health['recording'] & { success?: boolean }): Health['recording'] {
  return { active: body.active, session: body.session, count: body.count }
}
