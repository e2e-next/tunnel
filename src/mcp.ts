// `tunnel mcp`: MCP on stdin and stdout, so a coding agent drives tunnel with typed tools.
// serveStdio reads the lines and writes the answers, dispatch answers one message, and buildTools
// makes the sixteen tools. buildTools and serveStdio keep the signatures cli.ts calls them by, and
// a change to either goes with the lines of cmdMcp in cli.ts that call them. At run time it may
// import only cli-common.ts and what cli-common.ts may import, so that cli.ts → mcp.ts →
// cli-common.ts stays one way.
import { existsSync, readFileSync } from 'node:fs'
import type { Readable, Writable } from 'node:stream'
import {
  api,
  call,
  CannotConnect,
  checkRequest,
  CliError,
  type CliDeps,
  expandScenario,
  keyFor,
  displayPath,
  detailText,
  readJsonArg,
  readUserText,
  redact,
  redactNames,
  saveSslPolicy,
  sslPatch,
  sslPolicy,
  TIMEOUT_MS,
  userPath,
} from './cli-common.ts'
import { repr } from './errors.ts'
import { isJsonObject, isRawJson, type JsonObject, type JsonValue, parseJson } from './json.ts'
import { AGENTS_GUIDE, VERSION } from './package-info.ts'

// Every revision this server answers for, newest first. It is what server/discover reports and
// what an incoming request is checked against, so it is the modern era's whole half of version
// negotiation. An answer gets a copy of it, never the array itself
export const SUPPORTED_VERSIONS: readonly string[] = ['2026-07-28', '2025-11-25']

// The legacy era's half. initialize echoes back whatever revision the client asked for and reaches
// for this only when the client named none: echoing is safe exactly there, because the shapes a
// tools-only server deals in never moved across the handshake-based revisions. This string is the
// last of those, the newest thing a client can mean by opening with a handshake at all; anything
// newer arrives through server/discover instead
export const PROTOCOL_VERSION = '2025-11-25'

// MCP's reverse-DNS _meta keys. The modern era hangs both the revision a request is speaking and
// the server's identity off _meta rather than off named fields of their own, so these strings are
// load bearing
export const PROTOCOL_VERSION_KEY = 'io.modelcontextprotocol/protocolVersion'
export const SERVER_INFO_KEY = 'io.modelcontextprotocol/serverInfo'

// The free text server/discover hands the model alongside the machine readable part. A schema can
// say that a field is called script and takes a string; it cannot say what handler(ctx) is given,
// how a rule key is matched or how replay picks a recording. The tool that can is guide, so the one
// sentence available here is spent sending the model there
export const INSTRUCTIONS =
  "Call the guide tool before writing rules: it returns tunnel's AGENTS.md, which covers the handler(ctx) API, how a rule key is matched and how replay chooses a recording — the things these schemas cannot say."

// The JSON-RPC errors this layer can raise. Every one is a failure of the protocol itself: the
// message was not a request, or named a method that does not exist, or declared a revision this
// server does not speak. A tool that runs and fails is another matter: it comes back as a
// successful response carrying isError, so the model reads the failure and corrects itself instead
// of the client taking it for a broken transport
export const PARSE_ERROR = -32700
export const INVALID_REQUEST = -32600
export const METHOD_NOT_FOUND = -32601
// MCP's own code, outside the range JSON-RPC reserves. Its data carries the list this server does
// speak, so one round trip is all a client needs to retry correctly
export const UNSUPPORTED_PROTOCOL_VERSION = -32022

/** One entry in the registry: what the client is told, and what to run. inputSchema is the whole
 *  reason to prefer MCP to a shell: the agent is told which fields exist and which values they
 *  take, rather than finding out from a rejection */
export interface McpTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonObject // sent as it is, as the tool's inputSchema in tools/list
  /** args is always a JSON object: arguments that are not one have become {}. Only guide returns a
   *  string, which is the text as it is; any other answer goes out as JSON.stringify(answer, null,
   *  2). Whatever it throws becomes a result with isError, never a protocol error */
  run(args: JsonObject): Promise<JsonValue | string>
}
/** The tools `tunnel mcp` offers, in the order tools/list lists them */
export type McpTools = readonly McpTool[]

/** A response carrying a result */
function result(id: JsonValue, value: JsonObject): JsonObject {
  return { jsonrpc: '2.0', id, result: value }
}

/** A response carrying an error. data is optional in JSON-RPC and is left out rather than sent as
 *  null, so a client that does not read it sees exactly what it saw before */
function error(id: JsonValue, code: number, message: string, data?: JsonObject): JsonObject {
  const body: JsonObject = { code, message }
  if (data !== undefined) body.data = data
  return { jsonrpc: '2.0', id, error: body }
}

/** The shape MCP wants a tool's answer in, successful or not */
function content(text: string, isError: boolean): JsonObject {
  return { content: [{ type: 'text', text }], isError }
}

// What an agent is told on top of what call says when nothing answers. call words it for somebody
// at a shell prompt, who can reach for --base; an agent cannot, so it is told the one thing it can
// do instead. The command named is the background one, because this process is an editor's child
// and a server started in its foreground would go when the editor does
const NEVER_STARTS =
  'tunnel mcp only connects, never starts a server: run `tunnel serve --background` and call again'

// What a tool's failure says when what it threw is no Error and String() cannot write it either:
// an object with no prototype, which has no toString to call
const UNWRITABLE = 'the tool failed, and what it threw cannot be written as text'

/** The answer as JSON indented by two, the JSON `--json` prints, so that the two clients of the
 *  admin API show the same thing. JSON.stringify throws a TypeError of its own on a BigInt or a
 *  cycle, but writes a function, undefined or a symbol as nothing at all: that is made a TypeError
 *  as well, naming the type it cannot take */
function resultText(answer: JsonValue): string {
  const text: string | undefined = JSON.stringify(answer, null, 2)
  if (text === undefined) {
    throw new TypeError(`${typeof answer} cannot be written as JSON`)
  }
  return text
}

/** Run one tool and shape its answer, letting nothing at all escape. What got out would reject
 *  dispatch's promise, which nothing catches, and take the server down with every call in flight.
 *  Every failure leaves as a result instead, which is what MCP asks for anyway: a tool that failed
 *  is a successful call carrying isError, and a model shown the failure corrects itself where a
 *  client shown a broken transport can only give up */
async function runTool(tool: McpTool, args: JsonObject): Promise<JsonObject> {
  try {
    // A run that throws before it has a promise to reject throws in here as well. A string is
    // prose, guide's Markdown: quoted into JSON, every newline would become a backslash and an n,
    // which the model pays for and nobody reads
    const answer = await tool.run(args)
    return content(typeof answer === 'string' ? answer : resultText(answer), false)
  } catch (error) {
    if (error instanceof CannotConnect) return content(`${error.message}\n${NEVER_STARTS}`, true)
    // Everything expected to go wrong, in the words it was given in: an admin API 4xx, whose
    // detail call has already folded into the message, a file the arguments named that is not
    // there, two fields that cannot both be set. That sentence is all the model has to go on
    if (error instanceof CliError) return content(error.message, true)
    // A bug in a tool, an argument JS itself chokes on, an answer JSON cannot take: naming the type
    // is what lets the model say what happened. And JS can throw what is not an Error at all
    if (error instanceof Error) return content(`${error.name}: ${error.message}`, true)
    // String() throws in turn on a value it has no way to write (Object.create(null)), and what it
    // threw would escape after all
    try {
      return content(String(error), true)
    } catch {
      return content(UNWRITABLE, true)
    }
  }
}

/** A value as the sentences that show a client what it sent write it: a string in quotes, a value
 *  that is missing or null as null, anything else as detailText writes it */
function shown(value: JsonValue | undefined): string {
  return typeof value === 'string' ? repr(value) : value == null ? 'null' : detailText(value)
}

/** Find the named tool and run it. An unknown name is deliberately not a JSON-RPC error: MCP puts
 *  a tool's failure inside an ordinary result, which lets a model see it named a tool that is not
 *  there and pick a real one, instead of the client deciding the connection is broken. The
 *  registry is searched and nothing else, so a name every object has, constructor or __proto__, is
 *  as unknown as any other */
async function callTool(params: JsonObject, tools: McpTools): Promise<JsonObject> {
  const name = params.name
  const args = isJsonObject(params.arguments) ? params.arguments : {}
  const tool = tools.find((each) => each.name === name)
  if (tool === undefined) return content(`there is no tool called ${shown(name)}`, true)
  return runTool(tool, args)
}

/** The revision a request says it is speaking, if it says anything at all. Saying nothing is not
 *  a fault and is never treated as one: that is a client from the handshake era, which named its
 *  revision once at initialize and nothing per request afterwards */
function declaredVersion(params: JsonObject): string | null {
  const meta = params._meta
  if (!isJsonObject(meta)) return null
  const version = meta[PROTOCOL_VERSION_KEY]
  return typeof version === 'string' ? version : null
}

/** One decoded message in, the response out, or null to stay silent, which is how a notification
 *  is honoured. Nothing is remembered from one message to the next, so the two eras' opening moves
 *  can come in any order. Only tools/call awaits anything: every other answer is settled by the
 *  time this returns, which is what keeps serveStdio's answers in the order the lines came in. A
 *  tool's failure becomes a result, so the promise rejects only on a bug in dispatch itself */
export async function dispatch(message: JsonValue, tools: McpTools): Promise<JsonObject | null> {
  // Not even an object, so there is no id it could be answered under: JSON-RPC says to report it
  // against a null id and move on. A batch is one of these, and is not taken apart
  if (!isJsonObject(message)) return error(null, INVALID_REQUEST, 'Invalid Request')

  // A request without an id is answered under null rather than without the key, which is what
  // JSON.stringify would make of undefined
  const id = message.id ?? null
  const method = message.method
  if (typeof method !== 'string') return error(id, INVALID_REQUEST, 'Invalid Request')

  // Every MCP notification lives under this one prefix, and a notification is exactly the thing
  // that must go unanswered, including the ones there is nothing to do about, such as a
  // cancellation
  if (method.startsWith('notifications/')) return null

  const params = isJsonObject(message.params) ? message.params : {}

  // The modern era settles the version once per request rather than once per connection, so this
  // is checked on everything that gets an answer, server/discover included, where a refusal still
  // tells the client what it came to ask, because data names the revisions this server does speak
  const declared = declaredVersion(params)
  if (declared !== null && !SUPPORTED_VERSIONS.includes(declared)) {
    return error(id, UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', {
      supported: [...SUPPORTED_VERSIONS],
      requested: declared,
    })
  }

  // Each answer below is made afresh, so a caller that changes one changes nothing after it
  if (method === 'server/discover') {
    // The modern era's opening move, and a mandatory one: a client that speaks only 2026-07-28
    // asks this first and gives up on a server that cannot answer it. Everything it needs comes
    // back in the one reply
    return result(id, {
      resultType: 'complete',
      supportedVersions: [...SUPPORTED_VERSIONS],
      capabilities: { tools: {} },
      _meta: { [SERVER_INFO_KEY]: { name: 'tunnel', version: VERSION } },
      instructions: INSTRUCTIONS,
    })
  }
  if (method === 'initialize') {
    // The legacy era's opening move, left exactly as it was: opening with a handshake is how a
    // client says which era it wants, so the two entry points sit side by side rather than one
    // replacing the other
    return result(id, {
      // Echoed verbatim; ours only when the client offered none, which a missing, empty, 0 or null
      // version is taken for. Anything else, [] and {} included, is echoed
      protocolVersion: params.protocolVersion || PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'tunnel', version: VERSION },
    })
  }
  if (method === 'tools/list') {
    // What the client is told of each tool, under MCP's name for the schema; run stays here
    return result(id, {
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    })
  }
  if (method === 'tools/call') return result(id, await callTool(params, tools))
  if (method === 'ping') return result(id, {})
  return error(id, METHOD_NOT_FOUND, 'Method not found')
}

// What a tool that takes nothing says for itself. Every tool owes MCP an inputSchema, and an object
// with no properties is how one says there is nothing to pass, which is not the same claim as
// leaving the schema out
const NO_ARGUMENTS: JsonObject = { type: 'object', properties: {} }

// How long wait_for_request may be asked to hold. The admin API will wait as long as it is told to,
// but this process sits behind a client with a timeout of its own that nothing here can see, and a
// wait that outlives the client that asked for it reports to nobody. Five minutes is longer than a
// test run should ever need and short enough that a mistyped number is not a lost hour
const MAX_WAIT_SECONDS = 300

// Which source a rule was given, and the mode that follows from it. Exactly one may be passed, so
// this settles the mode on its own; mode passed outright is applied afterwards and wins, which is
// how a rule keeps a script it is not currently running. The same inference `tunnel set` makes
const SOURCE_MODES: Readonly<Record<string, string>> = {
  json_response: 'json',
  json_file: 'json',
  script: 'script',
  script_file: 'script',
  target: 'passthrough',
  replay: 'replay',
}

// The fields that shape whatever the mode answers; not one of them picks a mode. Four are spelled
// the way the command line spells them, because that is the name the guide and every example use;
// the value still goes out under the API's own name, which is what the right hand side of this
// table is
const SHAPING_FIELDS: Readonly<Record<string, string>> = {
  status_code: 'status_code',
  delay: 'response_delay',
  merge: 'merge_json',
  fault: 'fault',
  fault_seconds: 'fault_seconds',
  strategy: 'replay_strategy',
  session: 'replay_session',
  enabled: 'enabled',
  description: 'description',
}

// Everything GET /requests filters on, passed the way requestParams passes the command line's: a
// flag that is on as 1, anything else as its own text, and whatever truthy calls false left out so
// that the server keeps its own default
const REQUEST_FILTERS: readonly string[] = [
  'each',
  'key',
  'host',
  'since',
  'last',
  'unmatched',
  'encrypted',
  'q',
  'q_body',
]

// Everything PATCH /config takes. No renaming table this time, unlike the rule fields: these are
// the settings a whole run is set by, and the command line, the panel and the API have always
// called them the same things
const CONFIG_FIELDS: readonly string[] = [
  'default_mode',
  'session',
  'max_requests_history',
  'auto_record_requests',
  'allow_clients',
  'redact_headers',
  'replay_marker',
]

// What GET /recordings narrows on: the three `tunnel recordings ls` takes
const RECORDING_FILTERS: readonly string[] = ['session', 'key', 'host']

// What set_mock says when it is handed two answers to one question. Worded as the command line
// words it, and naming all six rather than the two that collided: the model is being told what the
// choice is, not only that it got it wrong once
const ONE_SOURCE =
  'give only one of json_response, json_file, script, script_file, target and replay'

/** One property of a tool's schema: what it takes, and what it is for. Every field gets a
 *  sentence, because the schema is the whole of what the model is told before it calls. A field
 *  with a type and no description is one it has to guess the meaning of, and guessing is the thing
 *  this server exists to end */
function field(type: string | string[], description: string, extra: JsonObject = {}): JsonObject {
  return { type, description, ...extra }
}

/** An arguments object, with required left off when there is none */
function schema(properties: JsonObject, required: string[] = []): JsonObject {
  return required.length > 0
    ? { type: 'object', properties, required }
    : { type: 'object', properties }
}

/** What a value is, in the words of the TypeError that refuses it. A number past 2^53, which
 *  parseJson keeps as its digits, is a number like any other */
function kind(value: JsonValue): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return 'a boolean'
  if (typeof value === 'number' || isRawJson(value)) return 'a number'
  if (typeof value === 'string') return 'a string'
  return Array.isArray(value) ? 'a list' : 'an object'
}

/** value, which has to be a JSON object to be taken apart. Anything else is a TypeError, where a
 *  spread would quietly make {} of 5 and {"0": "a", "1": "b"} of "ab". name is what the TypeError
 *  calls it */
function asObject(value: JsonValue, name: string): JsonObject {
  if (!isJsonObject(value)) throw new TypeError(`${name} must be an object, not ${kind(value)}`)
  return value
}

/** value, which has to be a number to be done arithmetic with: a number (one past 2^53 by its
 *  digits), a boolean as 1 or 0, or a string that is a number once its blanks are trimmed. Anything
 *  else is a TypeError, where JS's Number() would quietly make 0 of '' and [] and 5 of [5]. name is
 *  what the TypeError calls it */
function toNumber(value: JsonValue, name: string): number {
  if (typeof value === 'number') return value
  if (isRawJson(value)) return Number(value.rawJSON)
  if (typeof value === 'boolean') return Number(value)
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
    return Number(value)
  }
  throw new TypeError(`${name} must be a number, not ${kind(value)}`)
}

/** value, which has to be a string: a method, a path or a URL, which JS would quietly make one of
 *  (['x'] as 'x'), or the name of a file. name is what the TypeError calls it */
function asString(value: JsonValue, name: string): string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string, not ${kind(value)}`)
  return value
}

/** value, which has to be a list of strings: a string handed in instead would go through as the
 *  list of its characters. name is what the TypeError calls it, and the sentence says what the
 *  value is or, for an item that is not a string, what that item is */
function asStrings(value: JsonValue, name: string): string[] {
  const refused = (what: JsonValue) =>
    new TypeError(`${name} must be a list of strings, not ${kind(what)}`)
  if (!Array.isArray(value)) throw refused(value)
  for (const item of value) {
    if (typeof item !== 'string') throw refused(item)
  }
  return value as string[]
}

/** args[name], for the fields a schema lists as required. One that is not there is refused with a
 *  sentence naming it, missing required argument 'method'. One given as null is there, as null */
function need(args: JsonObject, name: string): JsonValue {
  if (!Object.hasOwn(args, name)) throw new CliError(`missing required argument ${repr(name)}`)
  return args[name] as JsonValue
}

/** Whether a value counts as given, for a switch or a filter: [], {}, '', 0, false and null are
 *  false, and so is a field that is missing. Boolean() takes [] and {} for true, which on a switch
 *  would quietly turn it on. A number past 2^53 is never 0 */
function truthy(value: JsonValue | undefined): boolean {
  if (Array.isArray(value)) return value.length > 0
  if (isJsonObject(value)) return Object.keys(value).length > 0
  return Boolean(value)
}

/** A value as it goes into a query string: true and false as true and false, null as nothing, a
 *  list as the name once per item (each item written the same way), and anything else as detailText
 *  writes it */
function queryValue(value: JsonValue): string | string[] {
  const one = (item: JsonValue): string =>
    item === true ? 'true' : item === false ? 'false' : item === null ? '' : detailText(item)
  return Array.isArray(value) ? value.map(one) : one(value)
}

/** headers and content_type as the one headers field a rule holds, or null when neither was given:
 *  the fold `-H` and `--content-type` make, without the 'Name: value' parsing a schema makes
 *  unnecessary. A rule's headers are replaced whole rather than added to, and whatever spelling the
 *  headers had already used for a content type gives way, because two content types on one answer
 *  is one more than a client will read. Headers that truthy calls false are none; true but no
 *  object, a TypeError */
function headersField(headers: JsonValue, contentType: JsonValue): JsonObject | null {
  if (headers === null && contentType === null) return null
  const merged: JsonObject = truthy(headers) ? { ...asObject(headers, 'headers') } : {}
  if (contentType !== null) {
    for (const name of Object.keys(merged)) {
      if (name.toLowerCase() === 'content-type') delete merged[name]
    }
    merged['content-type'] = contentType
  }
  return merged
}

/** A script read off disk here and inlined into the call. The tunnel server reads no files of
 *  yours, and that does not change because a path was passed to a tool: this process is a local
 *  client of the admin API exactly as the CLI is, so it reads the file and the source travels
 *  inside the request. What is not inlined here never arrives, which is why a path that is not
 *  there has to be said out loud rather than sent on as an empty script. A relative path is joined
 *  to deps.cwd as it is, leaving '..' for the system to resolve, and the text is read strictly as
 *  UTF-8 with its BOM kept */
function scriptFile(deps: CliDeps, path: string): string {
  if (!existsSync(userPath(deps, path))) {
    throw new CliError(`no such script file: ${displayPath(path)}`)
  }
  return readUserText(deps, path)
}

/** The request log filters that were given, as the admin API takes them: those truthy calls true,
 *  a true one as 1 and the rest as detailText writes them, not as queryValue does */
function filters(args: JsonObject): Record<string, string> {
  const given: Record<string, string> = {}
  for (const name of REQUEST_FILTERS) {
    const value = args[name]
    if (truthy(value)) given[name] = value === true ? '1' : detailText(value!)
  }
  return given
}

/**
 * Every tool this server offers, bound to a way of finding the admin API, in the order tools/list
 * lists them.
 *
 * resolveBase is a function rather than the address itself because the address is not something
 * that holds still. An editor starts its MCP servers when it opens, which is routinely before
 * anybody has run `tunnel serve`, and the server that eventually starts may be on a port of its
 * own. Each tool asks for the address at the moment it runs, never before, so TUNNEL_BASE, the pid
 * file and the 8000 fallback are consulted afresh on every call and a server that appeared in the
 * meantime is found without the editor being restarted.
 *
 * Everything goes through call, never through a command: those print, and stdout is the
 * transport. It is also why the answers come back as the admin API's own objects with the admin
 * API's own field names: a tool is a thin adapter over an endpoint, and a tool table that renames
 * things is a tool table that drifts. deps goes as it is to the functions of cli-common.ts.
 */
export function buildTools(resolveBase: () => string, deps: CliDeps): McpTools {
  // Only decrypt reads a value, edits it and writes it back, and only it needs serialising against
  // itself: every other tool here is one call. Each decrypt waits for the one before it to finish.
  // One queue to a buildTools
  let sslTurn: Promise<unknown> = Promise.resolve()

  /** /health and /sessions, as one object. Both, because the answer to "what am I talking to"
   *  spans them: health knows the version, the directories, the proxy address and the CA
   *  fingerprint, and /sessions knows what every session on disk holds, which is what a replay has
   *  to choose between. They name the same session with the same value, so the merge is flat and
   *  loses nothing. Asked one after the other */
  async function status(): Promise<JsonObject> {
    const base = resolveBase()
    return {
      ...asObject(await call(deps, 'GET', api(base, '/health')), 'the answer from /health'),
      ...asObject(await call(deps, 'GET', api(base, '/sessions')), 'the answer from /sessions'),
    }
  }

  /** The AGENTS.md this version ships, read out of the package. The copy that ships is the one
   *  that matches what this server actually does: fetching it from GitHub would hand the agent
   *  whatever is on the default branch instead. The one tool here that never asks where the server
   *  is: it reads a file, and the moment an agent most needs the guide is the one before anything
   *  has been started */
  async function guide(): Promise<string> {
    try {
      return readFileSync(AGENTS_GUIDE, 'utf8')
    } catch (error) {
      // Nothing there, or no file: only a broken install, which is said as `tunnel agents` says it
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR') {
        throw new CliError(`this install is missing ${AGENTS_GUIDE}; reinstall tunnel-use`)
      }
      throw error
    }
  }

  /** Every rule as it stands, or the one a key names. This is `tunnel export` as well: /export and
   *  /mocks hand back the same shape, and that shape is what apply_scenario takes, so a round trip
   *  through here is how a set of rules is copied or edited wholesale */
  async function listMocks(args: JsonObject): Promise<JsonValue> {
    const base = resolveBase()
    const key = args.key ?? null
    return call(deps, 'GET', api(base, '/mocks'), {
      params: truthy(key) ? { key: queryValue(key) } : null,
    })
  }

  /** PATCH /mocks: one rule, with only the fields given changed. The workhorse, and the one tool
   *  that builds a key rather than being handed one: a rule is written before there is anything to
   *  copy the key off. keyFor decides what the first segment means: something with a dot, a colon
   *  or a wildcard in it is a host, anything else is a path that is given its leading slash back */
  async function setMock(args: JsonObject): Promise<JsonValue> {
    const base = resolveBase()
    // Both looked up before either is judged
    const method = need(args, 'method')
    const path = need(args, 'path')
    const fields: JsonObject = { key: keyFor(asString(method, 'method'), asString(path, 'path')) }

    // replay is a switch rather than a value, so a false one asks for nothing, where an empty
    // object or an empty target is a real answer
    const given = Object.keys(SOURCE_MODES).filter(
      (name) => args[name] != null && !(name === 'replay' && args.replay === false),
    )
    if (given.length > 1) throw new CliError(ONE_SOURCE)

    const source = given[0]
    if (source === 'json_response') {
      fields.json_response = args.json_response!
    } else if (source === 'json_file') {
      // @path is how readJsonArg reads a file where JSON was expected, and it already refuses a
      // path that is not there by name
      fields.json_response = readJsonArg(deps, `@${asString(args.json_file!, 'json_file')}`)
    } else if (source === 'script') {
      fields.script = args.script!
    } else if (source === 'script_file') {
      fields.script = scriptFile(deps, asString(args.script_file!, 'script_file'))
    } else if (source === 'target') {
      fields.target = args.target!
    }
    if (source !== undefined) fields.mode = SOURCE_MODES[source]!

    for (const [name, apiName] of Object.entries(SHAPING_FIELDS)) {
      const value = args[name]
      if (value != null) fields[apiName] = value
    }
    const headers = headersField(args.headers ?? null, args.content_type ?? null)
    if (headers !== null) fields.headers = headers

    // Last of all, because a mode asked for outright is the last word on a question the sources
    // were only voting on
    if (args.mode != null) fields.mode = args.mode
    return call(deps, 'PATCH', api(base, '/mocks'), { json: fields })
  }

  /** DELETE /mocks: the rule goes, the request log stays */
  async function deleteMock(args: JsonObject): Promise<JsonValue> {
    const base = resolveBase()
    return call(deps, 'DELETE', api(base, '/mocks'), {
      params: { key: queryValue(need(args, 'key')) },
    })
  }

  /** POST /mocks/apply: a set of rules, all of them or none of them. Two ways in, because there are
   *  two places a scenario comes from. A file is the one a repository holds, and expandScenario
   *  reads its script_file and json_file relative to the file itself and inlines them, for the
   *  same reason set_mock reads a path. An inline scenario is the one an agent worked out in its
   *  head, which has nothing to write to disk first */
  async function applyScenario(args: JsonObject): Promise<JsonValue> {
    const base = resolveBase()
    const file = args.file ?? null
    const inline = args.scenario ?? null
    if (file !== null && inline !== null) {
      throw new CliError(
        'give a file or a scenario, not both: a path to a scenario file, or the scenario itself',
      )
    }
    let scenario: JsonObject
    if (inline !== null) {
      // Copied, so that replace below is not written into the object the caller passed in
      scenario = { ...asObject(inline, 'scenario') }
    } else if (file !== null) {
      scenario = expandScenario(deps, asString(file, 'file'))
    } else {
      throw new CliError(
        'give one of file and scenario: a path to a scenario file, or the scenario itself',
      )
    }
    if (truthy(args.replace)) scenario.replace = true
    return call(deps, 'POST', api(base, '/mocks/apply'), { json: scenario })
  }

  /** GET /requests: what the client actually called */
  async function listRequests(args: JsonObject): Promise<JsonValue> {
    const base = resolveBase()
    return call(deps, 'GET', api(base, '/requests'), { params: filters(args) })
  }

  /** GET /requests/{seq}: one call in full, headers and bodies. Hidden by default, and by the
   *  server's own list rather than one of ours: a request log is pasted into a report far more
   *  often than it is replayed, so the values that carry a session go out as [REDACTED] unless
   *  raw says the real value is the point */
  async function getRequest(args: JsonObject): Promise<JsonValue> {
    const base = resolveBase()
    const path = `/requests/${detailText(need(args, 'seq'))}`
    const exchange = await call(deps, 'GET', api(base, path))
    if (truthy(args.raw)) return exchange
    // The names are asked for once the call has come back, and what came back has to be an object
    // to hide any in
    const names = await redactNames(deps, base)
    redact(asObject(exchange, `the answer from ${path}`), names)
    return exchange
  }

  /** GET /requests/wait: block until the client has made this call. What a test run waits on
   *  instead of sleeping and hoping. Running out of time is not a failure of the call and is not
   *  reported as one: the answer carries timed_out and the seqs seen so far, which is the thing
   *  the caller came to assert on, the same judgement as the CLI exiting 3 with its data intact */
  async function waitForRequest(args: JsonObject): Promise<JsonValue> {
    const base = resolveBase()
    // Worked out before the key. A timeout or a count of null is the default, as null is for every
    // other field
    const timeout = Math.min(toNumber(args.timeout ?? 10, 'timeout'), MAX_WAIT_SECONDS)
    // Both looked up before either is judged, as set_mock does
    const method = need(args, 'method')
    const path = need(args, 'path')
    const params: Record<string, string | string[]> = {
      key: keyFor(asString(method, 'method'), asString(path, 'path')),
      count: queryValue(args.count ?? 1),
      timeout: String(timeout),
    }
    if (args.since != null) params.since = queryValue(args.since)
    // A list, which goes out as q once for each of its items
    if (truthy(args.q)) params.q = queryValue(args.q!)
    // The server answers at its own deadline, so this side has to be willing to wait past it or it
    // would be the one giving up first, and a client that gave up has nothing at all to report.
    // In whole milliseconds, rounded up, as cmdWait has it
    return call(deps, 'GET', api(base, '/requests/wait'), {
      params,
      timeoutMs: Math.ceil(timeout * 1000) + TIMEOUT_MS,
    })
  }

  /** What one test case leaves for the next, cleared. With neither flag it is the script state and
   *  the replay counters alone, which is the thing a suite clears between cases far more often
   *  than the log. The two answers are merged flat: cleared and last_seq are what the two
   *  endpoints call their own news, and neither name means anything different here */
  async function reset(args: JsonObject): Promise<JsonValue> {
    const base = resolveBase()
    const answer: JsonObject = {}
    if (truthy(args.state) || !truthy(args.requests)) {
      const key = args.key ?? null
      const cleared = await call(deps, 'POST', api(base, '/state/reset'), {
        json: truthy(key) ? { key } : {},
      })
      Object.assign(answer, asObject(cleared, 'the answer from /state/reset'))
    }
    if (truthy(args.requests)) {
      const cleared = await call(deps, 'POST', api(base, '/requests/clear'))
      Object.assign(answer, asObject(cleared, 'the answer from /requests/clear'))
    }
    return answer
  }

  /** PATCH /config: the switches a whole run is set by. One tool rather than one per switch,
   *  because they are thrown together: default_mode replay and session acct_a is the pair that
   *  puts a test run on another account's recorded traffic. A field not passed is not sent, so
   *  nothing is reset by being left out */
  async function setConfig(args: JsonObject): Promise<JsonValue> {
    const base = resolveBase()
    const fields: JsonObject = {}
    for (const name of CONFIG_FIELDS) {
      const value = args[name]
      if (value != null) fields[name] = value
    }
    return call(deps, 'PATCH', api(base, '/config'), { json: fields })
  }

  /**
   * The SSL Proxying Locations: read, edited, written back. A tool of its own because nothing
   * HTTPS is decrypted until its host is on the include list: it is the step before any other tool
   * can see a request body at all. Read, edit and write rather than a patch, because the API
   * replaces ssl_proxying whole, and that is precisely what an agent doing this by hand gets wrong:
   * it sends back the one entry it came for and drops everybody else's. sslPatch is the same edit
   * `tunnel ssl add` makes, so the two cannot come to disagree.
   */
  async function decrypt(args: JsonObject): Promise<JsonValue> {
    const base = resolveBase()
    // hosts that truthy calls true have to be a list, and one that is not is refused as asStrings
    // refuses it, before anything is queued: a string would be taken apart and each of its
    // characters saved as a host. Only whether it is a list: what is in it goes on as it is, for
    // the admin API to judge
    const hosts = args.hosts ?? null
    if (truthy(hosts) && !Array.isArray(hosts)) asStrings(hosts, 'hosts')
    // From the read to the write, behind the decrypt before this one: tool calls run concurrently,
    // and two of these overlapping is the very fault the tool exists to prevent, only moved. The
    // second reads the list before the first has saved it, and saves it back without the first's
    // host. An agent asked to decrypt two hosts has every reason to call this twice at once, and
    // the damage is quiet: a host silently missing, or a baffling "not in the include list" for
    // one just added
    const turn = sslTurn.then(async (): Promise<JsonValue> => {
      let policy = await sslPolicy(deps, base)
      if (truthy(hosts)) {
        const which = truthy(args.exclude) ? 'exclude' : 'include'
        policy = sslPatch(policy, which, hosts as string[], !truthy(args.remove))
      }
      if (args.enabled != null) policy.enabled = args.enabled as boolean
      // Spread, since TypeScript takes an object literal for JSON and an interface not
      return { ...(await saveSslPolicy(deps, base, policy)) }
    })
    // One that failed, taking off a host that was never on, fails alone: the next goes ahead
    sslTurn = turn.catch(() => {})
    return turn
  }

  /** The recording switch: start it, stop it, or ask how it stands. Three endpoints behind one
   *  tool, because they are one question, whether this run is keeping what passes through it, and
   *  three schemas would sit in the model's context forever to describe one switch */
  async function record(args: JsonObject): Promise<JsonValue> {
    const base = resolveBase()
    // Read as it is rather than with need: one that is missing is None in the sentence below
    const action = args.action
    if (action === 'start') {
      // No session is no field at all: an ordinary start records into the session the run is
      // already on rather than moving it
      const session = args.session ?? null
      return call(deps, 'POST', api(base, '/record/start'), {
        json: session === null ? {} : { session },
      })
    }
    if (action === 'stop') return call(deps, 'POST', api(base, '/record/stop'))
    if (action === 'status') return call(deps, 'GET', api(base, '/record'))
    // The schema says which three, and a client that enforces it never gets here; one that does
    // not has to be told rather than quietly given the status of something it asked to change
    throw new CliError(`action is one of start, stop and status, not ${shown(action)}`)
  }

  /** GET /recordings: the index, one row per recorded call. The filters truthy calls true go, each
   *  as queryValue writes it */
  async function listRecordings(args: JsonObject): Promise<JsonValue> {
    const base = resolveBase()
    const params: Record<string, string | string[]> = {}
    for (const name of RECORDING_FILTERS) {
      const value = args[name]
      if (truthy(value)) params[name] = queryValue(value!)
    }
    return call(deps, 'GET', api(base, '/recordings'), { params })
  }

  /** GET /recordings/{session}/{seq}: one recorded call, whole. Hidden by default and by the
   *  server's own list, exactly as get_request and `tunnel recordings show` do it. A recording
   *  holds whatever the real server was really sent, which is the one place a live token is most
   *  likely to be sitting, and it is read far more often to see the shape of an answer than to see
   *  that value. When the value is the point, a script that branches on the header it recorded,
   *  raw says so and gets it */
  async function getRecording(args: JsonObject): Promise<JsonValue> {
    const base = resolveBase()
    // The session and then the seq, which is the order a missing one is named in
    const session = need(args, 'session')
    const seq = need(args, 'seq')
    const path = `/recordings/${detailText(session)}/${detailText(seq)}`
    const exchange = await call(deps, 'GET', api(base, path))
    if (truthy(args.raw)) return exchange
    // As get_request: the names once the call has come back, and an object to hide any in
    const names = await redactNames(deps, base)
    redact(asObject(exchange, `the answer from ${path}`), names)
    return exchange
  }

  /** One real request through the proxy port, against tunnel's own CA. The only tool here that is
   *  not a wrapper over an admin endpoint, and the one that answers what the others cannot: not
   *  whether the rule is stored, but what a device actually gets. checkRequest hands back the
   *  proxy it went through and the seconds it took as well; both are for the line the CLI writes
   *  for a person, and neither is part of the answer */
  async function check(args: JsonObject): Promise<JsonValue> {
    const base = resolveBase()
    // Both looked up before either is judged
    const method = need(args, 'method')
    const url = need(args, 'url')
    const { answer } = await checkRequest(
      deps,
      base,
      asString(method, 'method'),
      asString(url, 'url'),
      // Judged only when truthy calls them true, which is when checkRequest uses them: query has to
      // be a list of strings and data a string, and here that is judged before anything is sent
      truthy(args.query) ? asStrings(args.query!, 'query') : null,
      truthy(args.data) ? asString(args.data!, 'data') : null,
    )
    // Spread, since TypeScript takes an object literal for JSON and an interface not
    return { ...answer }
  }

  // The key a rule is stored under, said the same way wherever one is named rather than built.
  // set_mock is the exception and takes method and path, because it writes a rule that has no key
  // to be copied off yet
  const keyField = field(
    'string',
    'a rule key as list_mocks reports it, METHOD:/path or METHOD:host/path',
  )

  return [
    {
      name: 'status',
      description:
        'Whether tunnel is up and how it is set right now: version, the three directories, how ' +
        'many rules and logged requests it holds, the session in hand, whether recording is on, ' +
        'the proxy address a device points at, the CA fingerprint, and what every session on ' +
        'disk holds. Make this the first call.',
      inputSchema: NO_ARGUMENTS,
      run: status,
    },
    {
      name: 'guide',
      description:
        "tunnel's AGENTS.md, the copy this version ships: the handler(ctx) API a script rule is " +
        'written against, how a request key is matched, how replay picks a recording, and the ' +
        'steps of a test run. Read it before writing rules. Needs no running server.',
      inputSchema: NO_ARGUMENTS,
      run: guide,
    },
    {
      name: 'list_mocks',
      description:
        'Every rule as it stands, whole, in the shape apply_scenario takes back — so this is ' +
        'also how a set of rules is exported. A key narrows it to one.',
      inputSchema: schema({ key: keyField }),
      run: listMocks,
    },
    {
      name: 'set_mock',
      description:
        'Configure what one endpoint answers; only the fields passed change. Give exactly one ' +
        'source — json_response, json_file, script, script_file, target or replay — and it ' +
        'settles the mode. Everything else shapes whatever that mode answers.',
      inputSchema: schema(
        {
          method: field('string', 'HTTP method, e.g. GET'),
          path: field(
            'string',
            'a path (/api/feed), or a host and path (api.example.com/api/feed); * is a wildcard ' +
              'in either',
          ),
          json_response: field(['object', 'array'], 'the JSON body to answer with; sets mode json'),
          json_file: field(
            'string',
            'a file holding that JSON, read here and sent inline; sets mode json',
          ),
          script: field(
            'string',
            'JavaScript or TypeScript defining handler(ctx), run per request; sets mode script. ' +
              'The guide tool has the ctx API',
          ),
          script_file: field(
            'string',
            'a file holding that script, read here and sent inline; sets mode script',
          ),
          target: field(
            'string',
            "pass through to this base URL or full URL instead of the request's own origin; " +
              'sets mode passthrough',
          ),
          replay: field(
            'boolean',
            'answer from the recordings instead of the real server; sets mode replay',
          ),
          mode: field('string', 'set the mode outright; wins over the one a source implies', {
            enum: ['json', 'passthrough', 'script', 'replay'],
          }),
          status_code: field('integer', 'the status code to answer with'),
          delay: field('number', 'hold the answer back this many seconds'),
          headers: field(
            'object',
            "response headers; these replace the rule's headers rather than adding to them",
            { additionalProperties: { type: 'string' } },
          ),
          content_type: field('string', 'the content type of the response, folded into headers'),
          merge: field(
            'object',
            'deep merged into the JSON that comes back, in passthrough and replay',
          ),
          fault: field(
            'string',
            'answer wrongly on purpose: hang holds the request for fault_seconds then 504, ' +
              'garbage does not parse as the JSON it claims, close drops the connection unanswered',
            { enum: ['none', 'hang', 'garbage', 'close'] },
          ),
          fault_seconds: field('number', 'how long a hang fault holds the request'),
          strategy: field(
            'string',
            'which recording replay picks: the one whose query matches, the next in order, or ' +
              'the newest',
            { enum: ['match', 'sequence', 'last'] },
          ),
          session: field(
            'string',
            'pin this rule to one recorded session; empty follows the current one',
          ),
          enabled: field('boolean', 'false parks the rule without deleting it'),
          description: field('string', 'a note, shown by list_mocks'),
        },
        ['method', 'path'],
      ),
      run: setMock,
    },
    {
      name: 'delete_mock',
      description: 'Delete one rule. The request log is left alone.',
      inputSchema: schema({ key: keyField }, ['key']),
      run: deleteMock,
    },
    {
      name: 'apply_scenario',
      description:
        'Apply a set of rules in one call, all of them or none of them: a scenario file on ' +
        'disk, or the scenario itself. Give exactly one of the two.',
      inputSchema: schema({
        file: field(
          'string',
          'a scenario file; its script_file and json_file are resolved beside it and sent inline',
        ),
        scenario: field(
          'object',
          'the scenario itself, as {"mocks": [...]} with an optional "config"',
        ),
        replace: field('boolean', 'clear the rules configured now first'),
      }),
      run: applyScenario,
    },
    {
      name: 'list_requests',
      description:
        'What the client actually called: one row per endpoint with counts, or one row per ' +
        "request with each. unmatched answers 'what have I not mocked yet', since answers 'what " +
        "arrived after that seq'.",
      inputSchema: schema({
        each: field('boolean', 'one row per request instead of the aggregate'),
        key: field('string', 'only this rule key; wildcards allowed'),
        host: field('string', 'only this host; * is a wildcard'),
        since: field('integer', 'only what arrived after this seq'),
        last: field('integer', 'only the last N entries'),
        unmatched: field('boolean', 'only requests no rule answered'),
        encrypted: field('boolean', 'only tunnels that were not decrypted'),
        q: field('string', 'keyword: host, path, query, status, rule'),
        q_body: field('boolean', 'let the keyword search the bodies too'),
      }),
      run: listRequests,
    },
    {
      name: 'get_request',
      description:
        'One call in full: headers and bodies, request and response. Header values that carry ' +
        'a session come back [REDACTED] unless raw is set.',
      inputSchema: schema(
        {
          seq: field('integer', 'the seq from list_requests with each'),
          raw: field('boolean', 'show header values instead of [REDACTED]'),
        },
        ['seq'],
      ),
      run: getRequest,
    },
    {
      name: 'wait_for_request',
      description:
        'Block until the client has made this call, instead of sleeping and hoping. Running ' +
        'out of time is not an error: the answer says timed_out and which seqs were seen.',
      inputSchema: schema(
        {
          method: field('string', 'HTTP method, e.g. POST'),
          path: field(
            'string',
            'a path (/api/pay), or a host and path (api.example.com/api/pay); * is a wildcard ' +
              'in either',
          ),
          count: field('integer', 'how many matching calls to wait for (default 1)'),
          since: field(
            'integer',
            'only count what arrived after this seq; without it the whole log counts, calls ' +
              'made before the wait included',
          ),
          timeout: field(
            'number',
            `give up after this many seconds (default 10, at most ${MAX_WAIT_SECONDS}). Your ` +
              'own client may time out sooner, so keep a long wait within whatever it allows',
          ),
          q: field(
            'array',
            'name=value, repeatable: only count calls whose query carries this value',
            { items: { type: 'string' } },
          ),
        },
        ['method', 'path'],
      ),
      run: waitForRequest,
    },
    {
      name: 'reset',
      description:
        'Clear what one test case leaves for the next: script ctx.state and the replay ' +
        'counters, and with requests the request log as well. Neither flag means the state ' +
        'alone.',
      inputSchema: schema({
        key: field('string', "only this rule's state, as a rule key; without it, every rule's"),
        state: field('boolean', 'clear ctx.state and the replay counters (the default)'),
        requests: field('boolean', 'clear the request log'),
      }),
      run: reset,
    },
    {
      name: 'set_config',
      description:
        'The switches a whole run is set by: how an endpoint with no rule is answered, which ' +
        'session recording and replay use, and what the request log keeps. Only the fields ' +
        'passed change.',
      inputSchema: schema({
        default_mode: field(
          'string',
          'how an endpoint with no rule of its own is answered: reach the server the client was ' +
            'calling, or answer from the recordings',
          { enum: ['passthrough', 'replay'] },
        ),
        session: field(
          'string',
          'which recordings this run writes and reads; one switch moves a run onto another account',
        ),
        max_requests_history: field('integer', 'how many requests the log keeps'),
        auto_record_requests: field('boolean', 'whether requests reach the log at all'),
        allow_clients: field(
          'array',
          'addresses or CIDR ranges the proxy port accepts; empty means this machine and the ' +
            'private network ranges',
          { items: { type: 'string' } },
        ),
        redact_headers: field('array', 'header names whose values get_request hides', {
          items: { type: 'string' },
        }),
        replay_marker: field(
          'boolean',
          'whether a replayed answer says so, with an x-tunnel-replay header',
        ),
      }),
      run: setConfig,
    },
    {
      name: 'decrypt',
      description:
        'Which hosts the proxy decrypts. Nothing HTTPS is read until its host is on the include ' +
        'list, so this comes before any rule for one. remove takes hosts off again, exclude ' +
        'edits the list that wins, enabled is the switch over both.',
      inputSchema: schema({
        hosts: field(
          'array',
          'host or host:port entries; * is a wildcard in the host, and no port means any port',
          { items: { type: 'string' } },
        ),
        remove: field(
          'boolean',
          'take these off the list instead of putting them on; one that is not there is an error',
        ),
        exclude: field(
          'boolean',
          'edit the exclude list rather than include. exclude wins, and is where an SDK that ' +
            'pins its certificate goes so that it keeps working',
        ),
        enabled: field(
          'boolean',
          'the master switch: off decrypts nothing, however long the include list is',
        ),
      }),
      run: decrypt,
    },
    {
      name: 'record',
      description:
        'Keep the calls that reach the real server, to replay later. One switch over all ' +
        'passthrough traffic rather than a mode a rule is in: start it, stop it, or ask how it ' +
        'stands.',
      inputSchema: schema(
        {
          action: field(
            'string',
            'start recording, stop it, or report whether it is on and how much it has',
            { enum: ['start', 'stop', 'status'] },
          ),
          session: field(
            'string',
            'record into this session, moving the run onto it; with start only',
          ),
        },
        ['action'],
      ),
      run: record,
    },
    {
      name: 'list_recordings',
      description:
        'What has been recorded: one row per call, carrying the session and seq get_recording ' +
        'takes. This is what a rule in replay mode has to choose between.',
      inputSchema: schema({
        session: field('string', 'only this session; without it, every one'),
        key: field('string', 'only this rule key; wildcards allowed'),
        host: field('string', 'only this host; * is a wildcard'),
      }),
      run: listRecordings,
    },
    {
      name: 'get_recording',
      description:
        'One recorded call in full, headers and bodies. Read one before writing a script ' +
        'around ctx.recorded(): this is the shape that hands back.',
      inputSchema: schema(
        {
          session: field('string', 'the session, as list_recordings reports it'),
          seq: field('integer', 'the seq, as list_recordings reports it'),
          raw: field('boolean', 'show header values instead of [REDACTED]'),
        },
        ['session', 'seq'],
      ),
      run: getRecording,
    },
    {
      name: 'check',
      description:
        'Send one real request through the proxy port and show what came back, verified ' +
        "against tunnel's own CA — the way a device's request arrives. How a rule or a script " +
        'is proved before anything is told to trust it.',
      inputSchema: schema(
        {
          method: field('string', 'HTTP method, e.g. GET'),
          url: field('string', 'the full URL the client would call, scheme and all'),
          query: field(
            'array',
            'name=value, repeatable: added to whatever query the URL already carries',
            { items: { type: 'string' } },
          ),
          data: field(
            'string',
            'a request body: JSON written out, @path to read it from a file here, or plain text',
          ),
        },
        ['method', 'url'],
      ),
      run: check,
    },
  ]
}

/** JSON-RPC a line at a time until stdin ends, resolving with the exit code, which is 0. The
 *  streams are arguments rather than the process's own, so that the loop this module exists for
 *  runs over a pair of streams in a test: the stdout discipline is worth nothing if it is only ever
 *  asserted about a mock. Nothing is listened for on either stream and nothing ends the process
 *  from here */
export async function serveStdio(
  tools: McpTools,
  stdin: Readable,
  stdout: Writable,
): Promise<number> {
  // The one and only place anything reaches stdout. One message is one write, and Node puts the
  // writes to a stream through in the order they were made, never one inside another.
  // JSON.stringify escapes every control character, so the one line feed is the last. U+2028 and
  // U+2029 it leaves as they are, and readline on Node 24 ends a line at either, so a
  // client reading with it would be handed half an answer: written as escapes they parse to
  // the same string
  const emit = (message: JsonObject): void => {
    const text = JSON.stringify(message)
      .replaceAll('\u2028', '\\u2028')
      .replaceAll('\u2029', '\\u2029')
    stdout.write(`${text}\n`)
  }

  // Every answer goes out through here. dispatch has settled all but a tools/call's by the time it
  // returns, and the callbacks of settled promises run in the order they were attached, so those
  // go out in the order their lines came in. A tools/call's goes out when its tool is done, which
  // may be after lines read later; the client matches it by its id. Each stays in pending until it
  // is written, for the end of stdin to wait on. A rejection would be a bug in dispatch, whose tools
  // turn every failure into a result: it is left to end the process as Node ends it, with the stack
  const pending = new Set<Promise<void>>()
  const answer = (reply: Promise<JsonObject | null>): void => {
    const written = reply.then((message) => {
      if (message !== null) emit(message)
      pending.delete(written)
    })
    pending.add(written)
  }

  // Strict, and the same for every line: bytes that are not UTF-8 cost their line rather than being
  // made U+FFFD, and a BOM stays where it is, for parseJson to refuse
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  const handle = (bytes: Buffer): void => {
    // One \r before the line feed, which is how a client on Windows ends a line. A \r anywhere else
    // belongs to the line
    const end = bytes.at(-1) === 0x0d ? bytes.length - 1 : bytes.length
    let message: JsonValue
    try {
      message = parseJson(decoder.decode(bytes.subarray(0, end)))
    } catch {
      // A line that cannot be read is answered and then forgotten. It must not end the loop: one
      // client that got its framing wrong for a moment would otherwise take the whole session
      // down. Its answer queues behind the lines before it like any other
      answer(Promise.resolve(error(null, PARSE_ERROR, 'Parse error')))
      return
    }
    answer(dispatch(message, tools))
  }

  // Bytes, cut at each line feed. A line feed never occurs inside a multibyte character, so a line
  // decodes whole although a chunk can end in the middle of one; setEncoding would have turned bad
  // bytes into U+FFFD before they got here. A line is as long as it is. No answer is awaited
  // before the next line is read, so a tool that takes its time holds up nothing but itself
  let partial: Buffer[] = []
  for await (const chunk of stdin) {
    const bytes: Buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    let start = 0
    let newline = bytes.indexOf(0x0a)
    while (newline !== -1) {
      partial.push(bytes.subarray(start, newline))
      handle(Buffer.concat(partial))
      partial = []
      start = newline + 1
      newline = bytes.indexOf(0x0a, start)
    }
    if (start < bytes.length) partial.push(bytes.subarray(start))
  }

  // EOF: the editor closed our stdin, which is how it says it has gone. Nothing to clean up, and
  // nothing went wrong. A last line without its line feed is a line all the same
  const last = Buffer.concat(partial)
  if (last.length > 0) handle(last)
  // A tool that was halfway through gets to send its answer before this resolves
  await Promise.all(pending)
  return 0
}
