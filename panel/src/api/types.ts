/**
 * The shapes the admin API already returns, copied field for field from
 * GET /__admin__/health, /config, /mocks, /requests and /recordings, plus the
 * `window` event on /events. The prototype fills them with fake rows; the
 * product fills them from the API, and nothing above this file has to change.
 */

export type Mode = 'passthrough' | 'replay'
export type RuleMode = 'passthrough' | 'json' | 'script' | 'replay'
export type ReplayStrategy = 'match' | 'sequence' | 'last'
export type Fault = 'none' | 'hang' | 'garbage' | 'close'

export interface Health {
  status: string
  version: string
  config_dir: string
  state_dir: string
  data_dir: string
  mocks: number
  exchanges: number
  last_seq: number
  ca_fingerprint: string
  proxy: { host: string; port: number; lan_ips: string[] } | null
  session: string
  recording: { active: boolean; session: string; count: number }
}

export interface Config {
  max_requests_history: number
  auto_record_requests: boolean
  default_mode: Mode
  ssl_proxying: { enabled: boolean; include: string[]; exclude: string[] }
  allow_clients: string[]
  redact_headers: string[]
  recording: { active: boolean }
  session: string
  replay_marker: boolean
}

export interface Rule {
  key: string
  mode: RuleMode
  json_response: unknown
  status_code: number
  enabled: boolean
  description: string
  merge_json: Record<string, unknown>
  headers: Record<string, string>
  target: string
  response_delay: number
  script: string
  replay_session: string
  replay_strategy: ReplayStrategy
  fault: Fault
  fault_seconds: number
}

/** One row of GET /requests?each=1 */
export interface Summary {
  seq: number
  time: string
  kind: 'http' | 'connect'
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
  mode: RuleMode | null
  replay_seq: number | null
  unmatched: boolean
  encrypted: boolean
  truncated: boolean
  client: string
  bytes_up: number
  bytes_down: number
}

/**
 * Which stretch of the log the server still holds, as the `window` event on
 * /events reports it. A state, not a change: it is sent again on every
 * heartbeat, so one that goes missing costs nothing.
 *
 * Holding nothing is said as `first_seq === last_seq + 1` — "the next call will
 * be numbered this, so I have none" — which keeps `seq < first_seq` the one
 * test a reader needs, with no empty case of its own.
 */
export interface LogWindow {
  first_seq: number
  last_seq: number
}

/** GET /requests/{seq} — the whole call */
export interface Exchange extends Summary {
  request: {
    method: string
    scheme: string
    host: string
    port: number
    path: string
    query: Record<string, string>
    url: string
    headers: Record<string, string>
    body: string | null
    body_encoding: 'json' | 'text' | 'base64' | null
  }
  response: {
    status: number
    headers: Record<string, string>
    body: string | null
    body_encoding: 'json' | 'text' | 'base64' | null
    elapsed_ms: number
    size: number
  } | null
}

export interface RecordingRow {
  session: string
  seq: number
  time: string
  key: string
  query: Record<string, string>
  status: number
  size: number
}

export interface CaInfo {
  subject: string
  fingerprint: string
  not_before: string
  not_after: string
  ca_file: string
  ca_key_file: string
}
