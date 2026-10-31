/**
 * Fake rows for the prototype, in the admin API's own shapes: four hosts, the
 * four rule modes, a replayed call, three unmatched calls, three CONNECT
 * tunnels and a spread of status codes.
 */
import type { CaInfo, Config, Exchange, Health, RecordingRow, Rule, Summary } from './types'

const TODAY = '2026-09-25T'

export const health: Health = {
  status: 'ok',
  version: '1.0.0',
  config_dir: '/Users/you/.tunnel',
  state_dir: '/Users/you/.tunnel/state',
  data_dir: '/Users/you/.tunnel/data',
  mocks: 13,
  exchanges: 41,
  last_seq: 41,
  ca_fingerprint: '9F:2C:41:AE:0B:77:D3:58:6E:19:C4:52:8A:31:FD:60:B2:74:E9:05',
  proxy: { host: '0.0.0.0', port: 8890, lan_ips: ['192.168.1.23', '10.37.129.2'] },
  session: 'acct_a',
  recording: { active: false, session: 'acct_a', count: 3 },
}

export const config: Config = {
  max_requests_history: 2000,
  auto_record_requests: false,
  default_mode: 'passthrough',
  ssl_proxying: { enabled: true, include: ['api.acme.test', '*.stripe.test'], exclude: ['*.apple.com'] },
  allow_clients: ['127.0.0.1', '192.168.0.0/24'],
  redact_headers: ['authorization', 'cookie', 'x-api-key'],
  recording: { active: false },
  session: 'acct_a',
  replay_marker: true,
}

export const ca: CaInfo = {
  subject: 'tunnel local CA',
  fingerprint: health.ca_fingerprint,
  not_before: '2026-09-01T00:00:00',
  not_after: '2027-09-01T00:00:00',
  ca_file: '/Users/you/.tunnel/ca.pem',
  ca_key_file: '/Users/you/.tunnel/ca.key',
}

const FEED_BODY = JSON.stringify(
  {
    page: 1,
    per_page: 20,
    total: 128,
    items: [
      { id: 'user_8871', name: 'Ada', age: 31, photos: 4, liked: false },
      { id: 'user_8872', name: 'Grace', age: 29, photos: 6, liked: true },
      { id: 'user_8873', name: 'Alan', age: 34, photos: 3, liked: false },
    ],
  },
  null,
  2
)

const PROFILE_BODY = JSON.stringify(
  { id: 'user_5512', name: 'Ada Lovelace', email: 'ada@acme.test', plan: 'premium', beans: 1240 },
  null,
  2
)

function row(o: Partial<Summary> & { seq: number; time: string; method: string; host: string; path: string }): Summary {
  return {
    kind: 'http',
    key: `${o.method}:${o.host}${o.path}`,
    scheme: 'https',
    port: 443,
    query: {},
    url: `https://${o.host}${o.path}`,
    status: 200,
    elapsed_ms: 40,
    size: 512,
    matched_by: null,
    mode: null,
    replay_seq: null,
    unmatched: false,
    encrypted: true,
    truncated: false,
    client: '192.168.1.42',
    bytes_up: 0,
    bytes_down: 0,
    ...o,
  } as Summary
}

export const summaries: Summary[] = [
  row({ seq: 23, time: TODAY + '12:05:41.220', method: 'POST', host: 'api.acme.test', path: '/v5/auth/login', status: 200, elapsed_ms: 132, size: 318, matched_by: 'POST:api.acme.test/v5/auth/login', mode: 'json', client: '192.168.1.42' }),
  row({ seq: 24, time: TODAY + '12:05:41.902', method: 'GET', host: 'api.acme.test', path: '/v5/profile', status: 200, elapsed_ms: 28, size: 214, matched_by: 'GET:api.acme.test/v5/profile', mode: 'json' }),
  row({ seq: 25, time: TODAY + '12:05:43.118', method: 'CONNECT', host: 'telemetry.acme.test', path: '', status: null, elapsed_ms: 1804, size: 4212, kind: 'connect', key: 'CONNECT:telemetry.acme.test:443', bytes_up: 1180, bytes_down: 3032, url: 'telemetry.acme.test:443' }),
  row({ seq: 26, time: TODAY + '12:05:44.330', method: 'GET', host: 'api.acme.test', path: '/v5/feed', query: { page: '1', per_page: '20' }, url: 'https://api.acme.test/v5/feed?page=1&per_page=20', status: 200, elapsed_ms: 61, size: 1184, matched_by: 'GET:api.acme.test/v5/feed', mode: 'script' }),
  row({ seq: 27, time: TODAY + '12:05:45.001', method: 'GET', host: 'cdn.acme.test', path: '/img/avatar/8871.jpg', status: 200, elapsed_ms: 22, size: 18422, matched_by: null, mode: 'passthrough' }),
  row({ seq: 28, time: TODAY + '12:05:46.774', method: 'POST', host: 'api.acme.test', path: '/v5/likes', status: 201, elapsed_ms: 96, size: 88, matched_by: 'POST:api.acme.test/v5/likes', mode: 'json' }),
  row({ seq: 29, time: TODAY + '12:05:48.210', method: 'GET', host: 'api.acme.test', path: '/v5/matches', status: 200, elapsed_ms: 18, size: 642, matched_by: 'GET:api.acme.test/v5/matches', mode: 'replay', replay_seq: 23 }),
  row({ seq: 30, time: TODAY + '12:05:49.560', method: 'GET', host: 'api.stripe.test', path: '/v1/customers/cus_991', status: 402, elapsed_ms: 74, size: 196, matched_by: 'GET:api.stripe.test/v1/customers/*', mode: 'json' }),
  row({ seq: 31, time: TODAY + '12:05:50.882', method: 'CONNECT', host: 'ocsp.apple.com', path: '', status: null, elapsed_ms: 212, size: 1420, kind: 'connect', key: 'CONNECT:ocsp.apple.com:443', bytes_up: 520, bytes_down: 900, url: 'ocsp.apple.com:443', client: '192.168.1.42' }),
  row({ seq: 32, time: TODAY + '12:05:52.117', method: 'GET', host: 'api.acme.test', path: '/v5/settings', status: 404, elapsed_ms: 9, size: 74, unmatched: true, mode: null }),
  row({ seq: 33, time: TODAY + '12:05:53.640', method: 'PUT', host: 'api.acme.test', path: '/v5/profile', status: 500, elapsed_ms: 1008, size: 122, matched_by: 'PUT:api.acme.test/v5/profile', mode: 'json' }),
  row({ seq: 34, time: TODAY + '12:05:55.200', method: 'GET', host: 'api.acme.test', path: '/v5/feed', query: { page: '2', per_page: '20' }, url: 'https://api.acme.test/v5/feed?page=2&per_page=20', status: 200, elapsed_ms: 58, size: 1170, matched_by: 'GET:api.acme.test/v5/feed', mode: 'script' }),
  row({ seq: 35, time: TODAY + '12:05:56.470', method: 'GET', host: 'assets.acme.test', path: '/config.json', status: 304, elapsed_ms: 14, size: 0, matched_by: null, mode: 'passthrough' }),
  row({ seq: 36, time: TODAY + '12:05:58.030', method: 'DELETE', host: 'api.acme.test', path: '/v5/likes/8873', status: 204, elapsed_ms: 41, size: 0, unmatched: true, mode: null }),
  row({ seq: 37, time: TODAY + '12:05:59.512', method: 'CONNECT', host: 'graph.facebook.test', path: '', status: null, elapsed_ms: 640, size: 2210, kind: 'connect', key: 'CONNECT:graph.facebook.test:443', bytes_up: 810, bytes_down: 1400, url: 'graph.facebook.test:443' }),
  row({ seq: 38, time: TODAY + '12:06:00.884', method: 'GET', host: 'api.acme.test', path: '/v5/notifications', status: 200, elapsed_ms: 33, size: 402, unmatched: true, mode: null }),
  row({ seq: 39, time: TODAY + '12:06:01.340', method: 'POST', host: 'api.acme.test', path: '/v5/events/batch', status: 202, elapsed_ms: 2004, size: 46, matched_by: 'POST:api.acme.test/v5/events/*', mode: 'script' }),
  row({ seq: 40, time: TODAY + '12:06:02.123', method: 'GET', host: 'api.acme.test', path: '/v5/feed', query: { page: '1', per_page: '20', refresh: 'true' }, url: 'https://api.acme.test/v5/feed?page=1&per_page=20&refresh=true', status: 200, elapsed_ms: 64, size: 1184, matched_by: 'GET:api.acme.test/v5/feed', mode: 'script' }),
  row({ seq: 41, time: TODAY + '12:06:03.559', method: 'GET', host: 'api.acme.test', path: '/v5/profile', status: 200, elapsed_ms: 26, size: 214, matched_by: 'GET:api.acme.test/v5/profile', mode: 'json', client: '127.0.0.1' }),
]

const HEADERS_REQ: Record<string, string> = {
  host: 'api.acme.test',
  accept: 'application/json',
  'accept-encoding': 'gzip, deflate, br',
  authorization: '<redacted>',
  'user-agent': 'Acme/5.12.0 (iPhone; iOS 18.2)',
  'x-device-id': '8F21C0B4-91AE-4E17-9C2D-77A0E1F35B62',
}

const HEADERS_RES: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'content-length': '1184',
  'cache-control': 'no-store',
  'x-answered-by': 'tunnel',
  'x-tunnel-replay': '23',
}

/** The full exchange behind one row. Only the rows the prototype opens need one. */
export const exchanges: Record<number, Exchange> = {
  40: {
    ...summaries[summaries.length - 2],
    request: {
      method: 'GET',
      scheme: 'https',
      host: 'api.acme.test',
      port: 443,
      path: '/v5/feed',
      query: { page: '1', per_page: '20', refresh: 'true' },
      url: 'https://api.acme.test/v5/feed?page=1&per_page=20&refresh=true',
      headers: HEADERS_REQ,
      body: null,
      body_encoding: null,
    },
    response: {
      status: 200,
      headers: HEADERS_RES,
      body: FEED_BODY,
      body_encoding: 'json',
      elapsed_ms: 64,
      size: 1184,
    },
  },
  41: {
    ...summaries[summaries.length - 1],
    request: {
      method: 'GET', scheme: 'https', host: 'api.acme.test', port: 443, path: '/v5/profile',
      query: {}, url: 'https://api.acme.test/v5/profile', headers: HEADERS_REQ,
      body: null, body_encoding: null,
    },
    response: {
      status: 200, headers: { 'content-type': 'application/json', 'content-length': '214' },
      body: PROFILE_BODY, body_encoding: 'json', elapsed_ms: 26, size: 214,
    },
  },
  32: {
    ...summaries[9],
    request: {
      method: 'GET', scheme: 'https', host: 'api.acme.test', port: 443, path: '/v5/settings',
      query: {}, url: 'https://api.acme.test/v5/settings', headers: HEADERS_REQ,
      body: null, body_encoding: null,
    },
    response: {
      status: 404,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ detail: 'no rule and no recording for GET:api.acme.test/v5/settings' }, null, 2),
      body_encoding: 'json', elapsed_ms: 9, size: 74,
    },
  },
  25: {
    ...summaries[2],
    request: {
      method: 'CONNECT', scheme: 'https', host: 'telemetry.acme.test', port: 443, path: '',
      query: {}, url: 'telemetry.acme.test:443', headers: {}, body: null, body_encoding: null,
    },
    response: null,
  },
}

const SCRIPT = `function handler(ctx) {
  // Page the feed, and fail the third call so the client's retry is exercised.
  const page = Number(ctx.query.page ?? '1')
  ctx.state.calls = (ctx.state.calls ?? 0) + 1
  if (ctx.state.calls === 3) return ctx.reply({ error: 'rate_limited' }, 429)
  const items = ['Ada', 'Grace', 'Alan'].map((name, i) => ({ id: 'user_' + (8870 + page * 3 + i), name, liked: false }))
  return { page, per_page: 20, total: 128, items }
}
`

function rule(o: Partial<Rule> & { key: string; mode: Rule['mode'] }): Rule {
  return {
    json_response: null, status_code: 200, enabled: true, description: '',
    merge_json: {}, headers: {}, target: '', response_delay: 0, script: '',
    replay_session: '', replay_strategy: 'match', fault: 'none', fault_seconds: 0,
    ...o,
  }
}

export const rules: Rule[] = [
  rule({ key: 'POST:api.acme.test/v5/auth/login', mode: 'json', status_code: 200, description: 'A premium account that never expires', json_response: { token: 'tok_live_5512', user_id: 'user_5512', plan: 'premium', expires_in: 86400 } }),
  rule({ key: 'GET:api.acme.test/v5/profile', mode: 'json', description: '', json_response: JSON.parse(PROFILE_BODY) }),
  rule({ key: 'GET:api.acme.test/v5/feed', mode: 'script', description: 'Pages, and rate-limits the third call', script: SCRIPT }),
  rule({ key: 'POST:api.acme.test/v5/likes', mode: 'json', status_code: 201, json_response: { ok: true, remaining: 4 } }),
  rule({ key: 'GET:api.acme.test/v5/matches', mode: 'replay', replay_session: '', replay_strategy: 'match', description: 'Answer from whatever the current session recorded' }),
  rule({ key: 'GET:api.stripe.test/v1/customers/*', mode: 'json', status_code: 402, description: 'The payment-required branch', json_response: { error: { code: 'card_declined', message: 'Your card was declined.' } } }),
  rule({ key: 'PUT:api.acme.test/v5/profile', mode: 'json', status_code: 500, description: 'Server error, to check the retry banner', json_response: { error: 'internal' }, response_delay: 1 }),
  rule({ key: 'POST:api.acme.test/v5/events/*', mode: 'script', description: 'Accept every batch, slowly', script: 'function handler(ctx) {\n  return ctx.reply({ accepted: (ctx.json ?? []).length }, 202)\n}\n', response_delay: 2 }),
  rule({ key: 'GET:cdn.acme.test/*', mode: 'passthrough', target: 'http://127.0.0.1:9001', description: 'Images come from the local origin' }),
  rule({ key: 'GET:assets.acme.test/config.json', mode: 'passthrough', target: 'http://127.0.0.1:9001' }),
  rule({ key: 'GET:api.acme.test/v5/inbox', mode: 'json', enabled: false, description: 'Off unless the inbox case is running', json_response: { threads: [] } }),
  rule({ key: 'GET:api.acme.test/v5/slow', mode: 'json', fault: 'hang', fault_seconds: 30, description: 'Hangs, for the timeout case' }),
  rule({ key: 'GET:api.acme.test/v5/broken', mode: 'json', fault: 'garbage', description: 'Sends bytes that are not JSON' }),
]

export const sessions: Record<string, number> = { acct_a: 3, acct_b: 1, empty_cart: 0 }

export const recordings: Record<string, RecordingRow[]> = {
  acct_a: [
    { session: 'acct_a', seq: 21, time: TODAY + '11:48:02.110', key: 'GET:api.acme.test/v5/matches', query: {}, status: 200, size: 642 },
    { session: 'acct_a', seq: 22, time: TODAY + '11:48:03.470', key: 'GET:api.acme.test/v5/profile', query: {}, status: 200, size: 214 },
    { session: 'acct_a', seq: 23, time: TODAY + '11:48:05.900', key: 'GET:api.acme.test/v5/feed', query: { page: '1' }, status: 200, size: 1184 },
  ],
  acct_b: [
    { session: 'acct_b', seq: 12, time: '2026-09-24T18:20:41.002', key: 'GET:api.acme.test/v5/profile', query: {}, status: 200, size: 209 },
  ],
  empty_cart: [],
}

/** Rows the Connect page aggregates out of the log. */
export const encryptedHosts = [
  { host: 'telemetry.acme.test', tunnels: 1 },
  { host: 'graph.facebook.test', tunnels: 1 },
  { host: 'ocsp.apple.com', tunnels: 1 },
]

export const clients = [
  { client: '192.168.1.42', last_seen: TODAY + '12:06:02.123', calls: 17, tunnels: 3 },
  { client: '127.0.0.1', last_seen: TODAY + '12:06:03.559', calls: 1, tunnels: 0 },
]
