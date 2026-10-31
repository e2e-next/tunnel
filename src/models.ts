// The data models: what one endpoint rule holds, and what the global
// configuration holds.
//
// A model is an interface whose fields have the names and the order that
// config.json and the admin API use. There are two ways to get one:
//
// - makeX(fields), for values the code puts together itself: the fields given
//   and the defaults for the rest. Nothing is checked, and what is given is
//   used as it is.
// - X_SCHEMA, for input that has to be checked (config.json, request bodies):
//   the lax conversions and the errors of validate.ts. parseX throws the
//   errors as one ValidationError.
//
// Each default is written once, in its schema, and makeX takes it from there.
// It is a function, so that every model gets objects and arrays of its own.
// Every model drops the fields it does not know.
import { ValidationError } from './errors.ts'
import type { JsonObject, JsonValue } from './json.ts'
import {
  anyValue,
  bool,
  check,
  dictOf,
  dictOrList,
  float,
  int,
  listOf,
  make,
  model,
  oneOf,
  required,
  str,
  withDefault,
  type ModelSchema,
} from './validate.ts'

/** Header values hidden when the log is printed. They are the ones that carry a
 *  session: a request log is pasted into a bug report far more often than it is
 *  replayed, and `--raw` is there for when the real value is the point. */
export const DEFAULT_REDACT_HEADERS: readonly string[] = Object.freeze([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'proxy-authorization',
])

/** The session recordings are filed under until another one is asked for */
export const DEFAULT_SESSION = 'default'

// ---- Enums ----
//
// An enum is a union of string literals, with an `as const` array of its values
// for the schemas to check against. The values are plain strings: a saved
// config file reads as plain JSON, and a field can be compared with the string
// it came from.

/** How one endpoint is answered */
export const TUNNEL_MODES = ['json', 'passthrough', 'script', 'replay'] as const
export type TunnelMode = (typeof TUNNEL_MODES)[number]

/** Which recording answers a call, when several were made to one endpoint.
 *
 *  `match` is the default because two calls to the same endpoint differ by
 *  their query more often than by anything else; `sequence` walks the
 *  recordings in order, which is what a polling endpoint needs; `last` always
 *  takes the newest. */
export const REPLAY_STRATEGIES = ['match', 'sequence', 'last'] as const
export type ReplayStrategy = (typeof REPLAY_STRATEGIES)[number]

/** What goes wrong on purpose, so a client's error branches can be tested.
 *
 *  A fault replaces whatever the endpoint's mode would have answered: `hang`
 *  holds the request for `fault_seconds` and then answers 504, `garbage` sends
 *  a JSON content type over a body that is not JSON, and `close` drops the
 *  connection without writing anything at all. */
export const FAULTS = ['none', 'hang', 'garbage', 'close'] as const
export type Fault = (typeof FAULTS)[number]

/** How endpoints with no rule of their own are answered.
 *
 *  `passthrough` forwards to the server the client was calling, which is what
 *  everyday work and recording want. `replay` answers from the recordings
 *  instead and refuses what it has none for, so an automated test cannot
 *  quietly reach the real backend. */
export const DEFAULT_MODES = ['passthrough', 'replay'] as const
export type DefaultMode = (typeof DEFAULT_MODES)[number]

// ---- SslProxying ----

/** Which hosts the proxy port decrypts — Charles calls these SSL Proxying Locations.
 *
 *  An entry is `host[:port]`, `*` is a wildcard in the host, and no port means
 *  any port. `exclude` wins over `include`, and `include` starts out empty: by
 *  default nothing is decrypted, so a third party SDK that pins its
 *  certificate keeps working and the log stays readable. */
export interface SslProxying {
  enabled: boolean
  include: string[]
  exclude: string[]
}

export const SSL_PROXYING_SCHEMA = model<SslProxying>('SslProxying', {
  enabled: withDefault(bool, () => true),
  include: withDefault(listOf(str), () => []),
  exclude: withDefault(listOf(str), () => []),
})

/** An SslProxying from the fields given and the defaults for the rest, nothing checked */
export function makeSslProxying(fields?: Partial<SslProxying>): SslProxying {
  return make(SSL_PROXYING_SCHEMA, fields)
}

// ---- Recording ----

/** The global recording switch, as `tunnel record start` leaves it.
 *
 *  Recording is not a per-endpoint mode: while it is active every decrypted
 *  passthrough call is written to the data directory as well as to the request
 *  log. Which session they are filed under is the global one, the same that
 *  replay reads. */
export interface Recording {
  active: boolean
}

export const RECORDING_SCHEMA = model<Recording>('Recording', {
  active: withDefault(bool, () => false),
})

/** A Recording from the fields given and the defaults for the rest, nothing checked */
export function makeRecording(fields?: Partial<Recording>): Recording {
  return make(RECORDING_SCHEMA, fields)
}

// ---- TunnelRequestConfig ----

/** What one endpoint answers, and how */
export interface TunnelRequestConfig {
  request_key: string // METHOD:[host[:port]]/path
  mode: TunnelMode
  json_response: JsonObject | JsonValue[]
  status_code: number
  enabled: boolean
  description: string
  /** Deep merged into the JSON a passthrough or replay response carries */
  merge_json: JsonObject
  /** Written over the response headers last, whichever mode produced them */
  headers: Record<string, string>
  /** Passthrough somewhere other than the origin the client asked for: a base
   *  URL keeps the request's path, a URL with a path of its own replaces it */
  target: string
  /** Seconds to wait before answering; 0 answers straight away */
  response_delay: number
  /** The source script mode runs; it has to define handler(ctx). Kept as text: script mode, not
   *  this module, reads it, and decides what to make of one written in Python by mistake */
  script: string
  /** Which recordings replay mode reads, and which of them it picks. An empty
   *  session follows the current one, so that a rule written once moves with
   *  `tunnel session`; a name pins this endpoint to that session whatever the
   *  run is otherwise replaying. */
  replay_session: string
  replay_strategy: ReplayStrategy
  /** What this endpoint does wrong instead of answering, and for how long. An
   *  hour is the default hang: a client that gives up after thirty seconds is
   *  what the fault is there to prove, so the wait only has to outlast it. */
  fault: Fault
  fault_seconds: number
}

export const TUNNEL_REQUEST_CONFIG_SCHEMA = model<TunnelRequestConfig>('TunnelRequestConfig', {
  request_key: required(str),
  mode: withDefault(oneOf(TUNNEL_MODES), () => 'passthrough'),
  json_response: withDefault(dictOrList, () => ({ message: 'Tunnel response' })),
  status_code: withDefault(int, () => 200),
  enabled: withDefault(bool, () => true),
  description: withDefault(str, () => ''),
  merge_json: withDefault(dictOf(anyValue), () => ({})),
  headers: withDefault(dictOf(str), () => ({})),
  target: withDefault(str, () => ''),
  response_delay: withDefault(float, () => 0),
  script: withDefault(str, () => ''),
  replay_session: withDefault(str, () => ''),
  replay_strategy: withDefault(oneOf(REPLAY_STRATEGIES), () => 'match'),
  fault: withDefault(oneOf(FAULTS), () => 'none'),
  fault_seconds: withDefault(float, () => 3600),
})

/** A rule from fields the code trusts: request_key, whichever others are given, and the defaults
 *  for the rest, nothing checked. Input goes through parseTunnelRequestConfig instead */
export function makeTunnelRequestConfig(
  fields: Pick<TunnelRequestConfig, 'request_key'> & Partial<TunnelRequestConfig>,
): TunnelRequestConfig {
  return make(TUNNEL_REQUEST_CONFIG_SCHEMA, fields)
}

/** A rule from input, checked and converted; throws ValidationError when it does not fit */
export function parseTunnelRequestConfig(input: unknown): TunnelRequestConfig {
  return parse(TUNNEL_REQUEST_CONFIG_SCHEMA, input)
}

// ---- TunnelConfig ----

/** The settings that hold for every endpoint */
export interface TunnelConfig {
  max_requests_history: number
  auto_record_requests: boolean
  default_mode: DefaultMode
  ssl_proxying: SslProxying
  /** Which clients the proxy port accepts, as IP addresses or CIDR ranges.
   *  Empty means the default: this machine and the private network ranges a
   *  device on the same Wi-Fi comes from. */
  allow_clients: string[]
  /** Header names whose values are hidden when the log is printed */
  redact_headers: string[]
  /** Whether passthrough traffic is being written to the data directory */
  recording: Recording
  /** The session in hand: where recording writes, and where replay and the
   *  scripts read, unless a rule names one of its own. One switch is what
   *  moves a whole test run onto another account's traffic. */
  session: string
  /** Whether a replayed answer says so, with `x-tunnel-replay: <seq>`. On by
   *  default because it is the quickest way to tell a replay from the real
   *  thing; turn it off when a client is strict about what headers it sees. */
  replay_marker: boolean
  request_configs: Record<string, TunnelRequestConfig>
}

export const TUNNEL_CONFIG_SCHEMA = model<TunnelConfig>('TunnelConfig', {
  // No lower bound: a negative number is taken
  max_requests_history: withDefault(int, () => 1000),
  auto_record_requests: withDefault(bool, () => true),
  default_mode: withDefault(oneOf(DEFAULT_MODES), () => 'passthrough'),
  ssl_proxying: withDefault(SSL_PROXYING_SCHEMA, () => makeSslProxying()),
  allow_clients: withDefault(listOf(str), () => []),
  redact_headers: withDefault(listOf(str), () => [...DEFAULT_REDACT_HEADERS]),
  recording: withDefault(RECORDING_SCHEMA, () => makeRecording()),
  session: withDefault(str, () => DEFAULT_SESSION),
  replay_marker: withDefault(bool, () => true),
  request_configs: withDefault(dictOf(TUNNEL_REQUEST_CONFIG_SCHEMA), () => ({})),
})

/** A TunnelConfig from the fields given and the defaults for the rest, nothing checked */
export function makeTunnelConfig(fields?: Partial<TunnelConfig>): TunnelConfig {
  return make(TUNNEL_CONFIG_SCHEMA, fields)
}

/** A TunnelConfig from input, checked and converted; throws ValidationError when it does not fit */
export function parseTunnelConfig(input: unknown): TunnelConfig {
  return parse(TUNNEL_CONFIG_SCHEMA, input)
}

// ---- Reading a model from input ----

/** parseX: check(), with what it finds thrown as one ValidationError titled with the model's name */
function parse<T>(schema: ModelSchema<T>, input: unknown): T {
  const result = check(schema, input)
  if (!result.ok) throw new ValidationError(schema.name, result.issues)
  return result.value
}
