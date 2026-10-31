/**
 * The only module that talks to the server.
 *
 * Every call the panel makes is a method here, shaped like the admin API it
 * stands in front of and async because the real one is. The prototype hands
 * back the rows in fake-data.ts; the product swaps in createHttpApi and nothing
 * above this file changes.
 */
import { ApiError } from './http-client'
import * as fake from './fake-data'
import type { CaInfo, Config, Exchange, Health, LogWindow, RecordingRow, Rule } from './types'

/** The two implementations of the interface below, and the error both refuse with. */
export { ApiError, createHttpApi } from './http-client'

/**
 * What `GET /requests` can narrow by, and all it can: the endpoint takes no
 * method and no status class, so those two filters stay in front of the panel.
 * `q_body` is why a query exists at all — a row carries no bodies, so the only
 * place that search can happen is the server.
 */
export interface RequestQuery {
  /** Matched against host, path, query, status and rule — and bodies with `q_body`. */
  q?: string
  q_body?: boolean
  host?: string
  unmatched?: boolean
  encrypted?: boolean
  last?: number
}

export interface PanelApi {
  health(): Promise<Health>
  config(): Promise<Config>
  ca(): Promise<CaInfo>
  rules(): Promise<Rule[]>
  /** The log, oldest first; narrowed by the server when a query is given. */
  requests(query?: RequestQuery): Promise<Summary[]>
  exchange(seq: number): Promise<Exchange | null>
  /** One recorded call. A session numbers its own recordings, so this is not requests/{seq}. */
  recordedExchange(session: string, seq: number): Promise<Exchange | null>
  sessions(): Promise<Record<string, number>>
  recordings(session: string): Promise<RecordingRow[]>

  patchConfig(patch: Partial<Config>): Promise<Config>
  saveRule(rule: Rule): Promise<Rule>
  deleteRule(key: string): Promise<void>
  deleteAllRules(): Promise<void>
  resetRuleState(key: string): Promise<void>
  clearRequests(): Promise<void>
  startRecording(session?: string): Promise<Health['recording']>
  stopRecording(): Promise<Health['recording']>
  deleteRecordings(session: string): Promise<number>

  /**
   * Calls as they happen, from the row after `since`. Returns the unsubscribe.
   *
   * The caller passes the newest seq it already listed, because a stream that
   * began at 0 would hand back the whole log the snapshot just read.
   *
   * `onWindow` is the other half: the server says on the same stream which
   * stretch of the log it still holds, so the caller can let go of the rows it
   * no longer has instead of listing calls that cannot be opened.
   */
  subscribe(
    since: number,
    onCall: (call: Summary) => void,
    onWindow: (window: LogWindow) => void,
    onConnected: (up: boolean) => void
  ): () => void
}

import type { Summary } from './types'

/**
 * A query against the fake log. The fake holds no bodies, so `q_body` widens
 * nothing here — the term is matched over the summary fields it does have,
 * which is also what the server's `q` matches without `q_body`.
 */
function fakeMatch(row: Summary, query: RequestQuery): boolean {
  if (query.host && row.host !== query.host) return false
  if (query.unmatched && !row.unmatched) return false
  if (query.encrypted && !row.encrypted) return false
  if (!query.q) return true
  const needle = query.q.toLowerCase()
  return (
    row.host.toLowerCase().includes(needle) ||
    row.url.toLowerCase().includes(needle) ||
    String(row.status ?? '').includes(needle) ||
    (row.matched_by ?? '').toLowerCase().includes(needle)
  )
}

export function createFakeApi(): PanelApi {
  // The prototype mutates these copies so the UI behaves like the real thing.
  let config: Config = { ...fake.config }
  let health: Health = { ...fake.health }
  let rules: Rule[] = fake.rules.map((r) => ({ ...r }))
  let summaries: Summary[] = [...fake.summaries]
  const sessions: Record<string, number> = { ...fake.sessions }
  const recordings: Record<string, RecordingRow[]> = { ...fake.recordings }

  const ok = <T,>(value: T) => Promise.resolve(value)

  return {
    health: () => ok({ ...health }),
    config: () => ok({ ...config }),
    ca: () => ok(fake.ca),
    rules: () => ok(rules.map((r) => ({ ...r }))),
    requests: (query) => ok(summaries.filter((row) => fakeMatch(row, query ?? {}))),
    exchange: (seq) => ok(fake.exchanges[seq] ?? null),
    // The fake has no recorded bodies of its own, so a recording opens the log
    // entry with that seq when there is one. The real one reads the session.
    recordedExchange: (_session, seq) => ok(fake.exchanges[seq] ?? null),
    sessions: () => ok({ ...sessions }),
    recordings: (session) => ok([...(recordings[session] ?? [])]),

    patchConfig(patch) {
      config = { ...config, ...patch }
      if (patch.session) health = { ...health, session: patch.session }
      return ok({ ...config })
    },
    saveRule(rule) {
      if (!/^[A-Za-z]+:/.test(rule.key)) throw new ApiError('A key starts with a method, as in GET:host/path')
      const at = rules.findIndex((r) => r.key === rule.key)
      if (at === -1) rules = [...rules, rule]
      else rules = rules.map((r) => (r.key === rule.key ? rule : r))
      return ok({ ...rule })
    },
    deleteRule(key) {
      rules = rules.filter((r) => r.key !== key)
      return ok(undefined)
    },
    deleteAllRules() {
      rules = []
      return ok(undefined)
    },
    resetRuleState: () => ok(undefined),
    clearRequests() {
      summaries = []
      return ok(undefined)
    },
    startRecording(session) {
      const name = session ?? config.session
      config = { ...config, session: name }
      health = { ...health, session: name, recording: { active: true, session: name, count: 0 } }
      return ok(health.recording)
    },
    stopRecording() {
      health = { ...health, recording: { ...health.recording, active: false } }
      return ok(health.recording)
    },
    deleteRecordings(session) {
      const count = recordings[session]?.length ?? 0
      recordings[session] = []
      if (session !== config.session) delete sessions[session]
      else sessions[session] = 0
      return ok(count)
    },

    subscribe(_since, _onCall, _onWindow, onConnected) {
      // The product opens an EventSource on /__admin__/events here and pushes
      // each summary through onCall. The prototype is simply connected.
      //
      // `_onWindow` is never called, and that is the honest fake: the rows here
      // are a fixed array that nothing ages out of, so there is no window to
      // report. Clearing them empties the array directly.
      onConnected(true)
      return () => {}
    },
  }
}
