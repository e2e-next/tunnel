// The protocol layer is driven with plain JSON-RPC messages against a registry of fake tools; the
// real tools against the admin app in process, the way tests/cli.test.ts drives the CLI. The one
// exception is marked slow: a real child process, because an entry point and a pair of pipes are
// not things a stream in memory can vouch for.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough, Readable, Writable } from 'node:stream'
import { test, type TestContext } from 'node:test'
import { createAdminApp } from '../src/app.ts'
import {
  type CliDeps,
  CliError,
  FALLBACK_BASE,
  type Fetch,
  type ProxiedRequest,
} from '../src/cli-common.ts'
import { buildParser, main } from '../src/cli.ts'
import type { TunnelConfigManager } from '../src/config.ts'
import type { ExchangeLog } from '../src/exchanges.ts'
import { isJsonObject, type JsonObject, type JsonValue, parseJson } from '../src/json.ts'
// As a namespace: an export the module does not have yet is undefined rather than a file that
// fails to load
import * as mcp from '../src/mcp.ts'
import { makeRequest, makeResponse, type Request } from '../src/messages.ts'
import type { TunnelRequestConfig } from '../src/models.ts'
import { AGENTS_GUIDE, VERSION } from '../src/package-info.ts'
import { makeAdminEnv } from './support/admin-env.ts'
import { BASE, captureIo } from './support/cli.ts'
import { runTunnel } from './support/target.ts'
import { tmpDir } from './support/tmp.ts'

/** A line of what tunnel mcp answers, as these tests read it: a result or an error */
interface Reply {
  jsonrpc: string
  id: number | null
  result?: any
  error?: any
}

// A registry that does nothing useful on purpose. The protocol layer only ever reads name,
// description and inputSchema out of it and calls run, so a fake pair of tools tests it exactly as
// well as the real sixteen would
const FAKE_TOOLS: mcp.McpTools = [
  {
    name: 'echo',
    description: 'Send back whatever was passed in',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    run: async (args) => ({ echoed: args.text ?? null }),
  },
  {
    name: 'nothing',
    description: 'Answer with an empty object',
    inputSchema: { type: 'object', properties: {} },
    run: async () => ({}),
  },
]

/** What mcp.dispatch answers over FAKE_TOOLS, read loosely */
async function dispatch(message: JsonValue): Promise<Reply> {
  return (await mcp.dispatch(message, FAKE_TOOLS)) as unknown as Reply
}

function initialize(params: JsonObject = {}): JsonObject {
  return { jsonrpc: '2.0', id: 1, method: 'initialize', params }
}

// Verbatim, whatever it is: echoing is what keeps a revision bump from reaching this code at all,
// since a tools-only surface has never changed
test("initialize echoes the client's protocol version", async () => {
  const reply = await dispatch(initialize({ protocolVersion: '1999-01-01' }))

  assert.equal(reply.result.protocolVersion, '1999-01-01')
})

test('initialize names its own version when the client names none', async () => {
  const reply = await dispatch(initialize())

  assert.equal(reply.result.protocolVersion, mcp.PROTOCOL_VERSION)
})

test('initialize reports the package version and the tools capability', async () => {
  const reply = (await dispatch(initialize())).result

  assert.deepEqual(reply.serverInfo, { name: 'tunnel', version: VERSION })
  assert.ok('tools' in reply.capabilities)
})

// The schema goes out under MCP's name for it, inputSchema
test('tools/list names every tool in the registry', async () => {
  const reply = await dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list' })

  assert.deepEqual(reply.result.tools, [
    {
      name: 'echo',
      description: 'Send back whatever was passed in',
      inputSchema: FAKE_TOOLS[0]!.inputSchema,
    },
    {
      name: 'nothing',
      description: 'Answer with an empty object',
      inputSchema: FAKE_TOOLS[1]!.inputSchema,
    },
  ])
})

// MCP puts tool level failure inside a normal result, so that the model reads what went wrong and
// corrects itself
test('an unknown tool name is a tool error, not a protocol error', async () => {
  const reply = await dispatch({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'nope', arguments: {} },
  })

  assert.ok(!('error' in reply))
  assert.equal(reply.result.isError, true)
  assert.ok(reply.result.content[0].text.includes('nope'))
})

test('ping is answered with an empty result', async () => {
  const reply = await dispatch({ jsonrpc: '2.0', id: 4, method: 'ping' })

  assert.deepEqual(reply, { jsonrpc: '2.0', id: 4, result: {} })
})

test('an unknown method is a method-not-found error', async () => {
  const reply = await dispatch({ jsonrpc: '2.0', id: 5, method: 'resources/list' })

  assert.equal(reply.error.code, mcp.METHOD_NOT_FOUND)
  assert.equal(reply.id, 5)
})

// There is no id to answer under when the message is not even a request
test('a message that is not an object is an invalid request', async () => {
  const reply = await dispatch([1, 2, 3])

  assert.equal(reply.error.code, mcp.INVALID_REQUEST)
  assert.equal(reply.id, null)
})

test('a message without a method is an invalid request', async () => {
  const reply = await dispatch({ jsonrpc: '2.0', id: 6 })

  assert.equal(reply.error.code, mcp.INVALID_REQUEST)
  assert.equal(reply.id, 6)
})

// A notification carries no id; answering one is itself a protocol error
test('a notification is not answered', async () => {
  assert.equal(
    await mcp.dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' }, FAKE_TOOLS),
    null,
  )
})

// The claim the one above cannot make: not a shorter answer, no answer
test('a notification puts nothing on stdout', async () => {
  const io = captureIo(
    `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
  )

  assert.equal(await mcp.serveStdio(FAKE_TOOLS, io.stdin, io.stdout), 0)

  assert.equal(io.takeOutput().out, '')
})

// The nail for the discipline the whole module is built around: one stray byte on stdout desyncs
// the stream, so every line it ever writes has to be a JSON-RPC message — including the one
// answering a line that was garbage
test('stdout carries nothing but JSON-RPC', async () => {
  const io = captureIo(
    [
      JSON.stringify(initialize({ protocolVersion: '2025-06-18' })),
      '{ this line is not JSON',
      JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' }),
    ].join('\n') + '\n',
  )

  assert.equal(await mcp.serveStdio(FAKE_TOOLS, io.stdin, io.stdout), 0)

  const written: Reply[] = []
  for (const line of io.takeOutput().out.split('\n').slice(0, -1)) {
    const message = parseJson(line) as unknown as Reply // anything that is not JSON fails right here
    assert.equal(message.jsonrpc, '2.0')
    written.push(message)
  }

  assert.equal(written.length, 3)
  assert.equal(written[0]!.id, 1)
  // The garbage line was answered and then forgotten, rather than ending the loop: the ping behind
  // it still came back
  assert.equal(written[1]!.error.code, mcp.PARSE_ERROR)
  assert.deepEqual(written[2], { jsonrpc: '2.0', id: 9, result: {} })
})

// Every wait in the tests below is bounded, and a slow tool's own wait is the longest of them. What
// is being guarded against is a loop that serialises, and an unbounded wait would turn that from a
// test that fails into a suite that hangs — a hang says nothing, while a failure says which line
// came back first
const PATIENCE = 10_000

/** The promise, or a rejection once ms have gone by without it settling. The timer neither keeps
 *  the process alive nor outlives the wait */
async function within<T>(promise: Promise<T>, ms = PATIENCE): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms).unref()
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * A stdout that hands each line to whoever is waiting for the next one.
 *
 * What captureIo collects is enough for a loop that has already finished. This one is read while
 * the loop is still running, and the question asked of it is which line arrived first — which a
 * queue answers exactly, with no sleeping and no guess at how long to sleep for. writes keeps every
 * chunk as it was written, for the tests that count the writes or read the raw text.
 */
class LineSink extends Writable {
  readonly writes: string[] = []
  readonly lines: string[] = []
  #partial = ''
  #handedOut = 0
  readonly #waiting: ((line: string) => void)[] = []

  constructor() {
    // The strings as they were written, not turned into Buffers on the way
    super({ decodeStrings: false })
  }

  override _write(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const text = String(chunk)
    this.writes.push(text)
    const parts = (this.#partial + text).split('\n')
    this.#partial = parts.pop()!
    this.lines.push(...parts)
    this.#handOut()
    callback()
  }

  /** The next line not yet handed out, once it has been written */
  next(): Promise<string> {
    return new Promise((resolve) => {
      this.#waiting.push(resolve)
      this.#handOut()
    })
  }

  #handOut(): void {
    while (this.#waiting.length > 0 && this.#handedOut < this.lines.length) {
      this.#waiting.shift()!(this.lines[this.#handedOut++]!)
    }
  }
}

/** A tool that holds its call until the test lets it go, the way wait_for_request holds one until
 *  a device makes the request it waits for. running resolves once it has started */
function slowTool(): { tool: mcp.McpTool; running: Promise<void>; release: () => void } {
  const started = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  return {
    tool: {
      name: 'slow',
      description: 'Blocks until it is let go',
      inputSchema: { type: 'object', properties: {} },
      run: async () => {
        started.resolve()
        // Let go by the test, and bounded anyway: it outlasts every wait the test makes, so a
        // failure is the test's to report, and it still ends
        await within(released.promise, PATIENCE * 2)
        return { waited: true }
      },
    },
    running: started.promise,
    release: () => released.resolve(),
  }
}

// wait_for_request holds its call for as long as a device takes to make the request, and a client
// whose ping goes unanswered for those thirty seconds has every reason to decide the server has
// died. serveStdio awaits no answer before it reads the next line, so ping, and initialize,
// tools/list and server/discover with it, are answered while a tool is still running.
test('a ping is answered while a slow tool is still running', async () => {
  const slow = slowTool()
  const stdin = Readable.from([
    [
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'slow', arguments: {} },
      }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
    ].join('\n') + '\n',
  ])
  const stdout = new LineSink()

  const loop = mcp.serveStdio([slow.tool], stdin, stdout)
  let first: string
  try {
    // In flight, not merely queued: the tool is running at the moment the ping behind it gets its
    // answer
    await within(slow.running)
    first = await within(stdout.next())
  } finally {
    // However that went, the tool is let go so the loop can reach its end
    slow.release()
  }

  assert.deepEqual(parseJson(first), { jsonrpc: '2.0', id: 2, result: {} })
  // And nothing was lost by going second: the end of stdin waits for what is in flight
  const answered = parseJson(await within(stdout.next())) as unknown as Reply
  assert.equal(answered.id, 1)
  assert.equal(answered.result.isError, false)
  assert.equal(await within(loop), 0)
})

/** The same message, declaring a protocol version the modern way */
function withVersion(message: JsonObject, version: JsonValue): JsonObject {
  message.params = {
    ...(message.params as JsonObject | undefined),
    _meta: { [mcp.PROTOCOL_VERSION_KEY]: version },
  }
  return message
}

// The modern entry point: a client that opens with this instead of a handshake has to be able to
// learn everything from the one answer
test('server/discover names both eras and the tools capability', async () => {
  const reply = (await dispatch({ jsonrpc: '2.0', id: 7, method: 'server/discover' })).result

  assert.equal(reply.resultType, 'complete')
  assert.deepEqual(reply.supportedVersions, ['2026-07-28', '2025-11-25'])
  assert.ok('tools' in reply.capabilities)
})

// serverInfo moved under _meta in the modern era, and instructions is the one place to say the
// things a schema cannot
test('server/discover carries the server info and instructions', async () => {
  const reply = (await dispatch({ jsonrpc: '2.0', id: 8, method: 'server/discover' })).result

  assert.deepEqual(reply._meta[mcp.SERVER_INFO_KEY], { name: 'tunnel', version: VERSION })
  assert.ok(reply.instructions.trim())
})

// Checked on a real method, not just on discover: the modern era settles the version per request,
// so every request is a place this can go wrong
test('a request naming an unsupported version is refused', async () => {
  const reply = await dispatch(
    withVersion({ jsonrpc: '2.0', id: 10, method: 'tools/list' }, '1900-01-01'),
  )

  assert.equal(reply.error.code, mcp.UNSUPPORTED_PROTOCOL_VERSION)
  assert.deepEqual(reply.error.data, {
    supported: ['2026-07-28', '2025-11-25'],
    requested: '1900-01-01',
  })
})

test('a request naming a supported version is served normally', async () => {
  const reply = await dispatch(
    withVersion({ jsonrpc: '2.0', id: 11, method: 'tools/list' }, '2026-07-28'),
  )

  assert.deepEqual(
    reply.result.tools.map((tool: { name: string }) => tool.name),
    ['echo', 'nothing'],
  )
})

// A legacy client declares nothing per request; that is not an error, and the whole legacy path has
// to keep working exactly as it did
test('a request with no meta at all is served normally', async () => {
  const reply = await dispatch({ jsonrpc: '2.0', id: 12, method: 'tools/list' })

  assert.ok(!('error' in reply))
  assert.deepEqual(
    reply.result.tools.map((tool: { name: string }) => tool.name),
    ['echo', 'nothing'],
  )
})

// ------------------------------------------------------------ the `tunnel mcp` subcommand

/** A fetch that fails as fetch does when nothing listens: a TypeError whose cause is the refused
 *  connection, which call takes for a server that is not there (CannotConnect) */
function refuse(): never {
  throw new TypeError('fetch failed', {
    cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
  })
}

/** deps of the test's own, around the fetch given: the directories are a new one, so nothing of
 *  the person running the tests is found (no TUNNEL_BASE, no .tunnel/ above the cwd), and an
 *  external command is a bug */
function fakeDeps(t: TestContext, fetch: Fetch): CliDeps {
  const dir = tmpDir(t)
  return {
    fetch,
    env: { TUNNEL_CONFIG_DIR: dir },
    cwd: dir,
    run: () => {
      throw new Error('no external commands here')
    },
  }
}

/** What capturedResolve keeps of one run of `tunnel mcp` */
interface Captured {
  resolve: () => string // the resolver cmdMcp built
  deps: CliDeps // the deps it handed buildTools along with it, which the resolver reads too
  served: number // how many times serveStdio was called
}

/**
 * Run `tunnel mcp` far enough to get hold of the resolver it built. Nothing hands the resolver
 * back: it is passed to buildTools and closed over by every tool, which is precisely the point. So
 * the way to look at one is to stand in for buildTools and keep what it was given, and to stand in
 * for serveStdio so that no read loop starts; both go in through deps.mcp. The directories are a
 * new one, so neither a TUNNEL_BASE nor a pid file of the person running the tests is found, and
 * no request is made
 */
async function capturedResolve(t: TestContext, argv: readonly string[]): Promise<Captured> {
  const dir = tmpDir(t)
  let built: { resolve: () => string; deps: CliDeps } | undefined
  let served = 0
  const deps: CliDeps = {
    fetch: refuse,
    env: { TUNNEL_CONFIG_DIR: dir },
    cwd: dir,
    run: refuse,
    mcp: {
      buildTools: (resolve, given) => {
        built = { resolve, deps: given }
        return []
      },
      serveStdio: async () => {
        served += 1
        return 0
      },
    },
  }

  assert.equal(await main(argv, captureIo(), deps), 0)
  assert.ok(built, 'buildTools was not reached through deps.mcp')
  return { ...built, served }
}

// Pinned means pinned: whatever the pid file starts saying afterwards, a --base on the command
// line is what every tool call talks to. Unpinned, these deps would give FALLBACK_BASE
test('an explicit base is the address every time', async (t) => {
  const { resolve } = await capturedResolve(t, ['--base', 'http://127.0.0.1:9999', 'mcp'])

  assert.equal(resolve(), 'http://127.0.0.1:9999')
  assert.equal(resolve(), 'http://127.0.0.1:9999')
})

// What looking the address up per call exists for. The editor and this server routinely start
// before anybody runs `tunnel serve`, and a server that comes up afterwards, on a port of its own,
// has to be found without the editor being restarted. The second answer is put in the deps the
// resolver reads, the ones buildTools was handed
test('with no base the address is worked out again on every call', async (t) => {
  const captured = await capturedResolve(t, ['mcp'])

  assert.equal(captured.resolve(), FALLBACK_BASE)
  // `tunnel serve --background --admin-port 8099` happened in between, and the next tool call
  // finds it without anything being restarted
  captured.deps.env = { ...captured.deps.env, TUNNEL_BASE: 'http://127.0.0.1:8099' }
  assert.equal(captured.resolve(), 'http://127.0.0.1:8099')
})

// That `tunnel mcp` reaches its command: it ends in the serveStdio of deps.mcp, called once
test('tunnel mcp starts the MCP server and is in the help', async (t) => {
  const captured = await capturedResolve(t, ['mcp'])

  assert.equal(captured.served, 1)
  assert.ok(buildParser(captured.deps).formatHelp().includes('mcp'))
})

// What is pinned is the shape rather than the count, along with the one thing that has to stay
// true however long the registry gets: building it resolves no address. That happens when a tool
// runs, which is why a function is passed at all. An interface is nothing to check against at run
// time, so each of McpTool's four fields is checked instead
test('buildTools returns the tools and resolves nothing by itself', (t) => {
  const resolved: boolean[] = []
  const resolve = (): string => {
    resolved.push(true)
    return BASE
  }

  const tools = mcp.buildTools(resolve, fakeDeps(t, refuse))

  for (const tool of tools) {
    assert.equal(typeof tool.name, 'string')
    assert.equal(typeof tool.description, 'string')
    assert.ok(isJsonObject(tool.inputSchema), tool.name)
    assert.equal(typeof tool.run, 'function')
  }
  assert.deepEqual(resolved, [])
})

// ------------------------------------------------------------------------------ the tools

/** What a tools/call answers with, as these tests read it */
interface ToolResult {
  content: { type: string; text: string }[]
  isError: boolean
}

/** One tools/call, driven as a client drives it, down to the result object */
async function toolCall(tools: mcp.McpTools, name: string, args?: JsonObject): Promise<ToolResult> {
  const reply = (await mcp.dispatch(
    { jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name, arguments: args ?? {} } },
    tools,
  )) as unknown as Reply
  return reply.result
}

function text(result: ToolResult): string {
  return result.content[0]!.text
}

/**
 * The registry `tunnel mcp` builds, over the admin app in process, with the manager, the request
 * log and the recordings beside it. A tool is a third client of the admin API, after the CLI and a
 * client's own test setup, so the honest thing to run it against is the real app. Nothing listens
 * and nothing is started. The fetch takes BASE and nothing else, so no request can leave the
 * process, and calls is every request the tools made, in order.
 */
async function mcpEnv(t: TestContext) {
  const env = await makeAdminEnv(t)
  const calls: { method: string; url: string }[] = []
  // After makeAdminEnv, which adds the core's close() first among the t.after hooks: that has to
  // run before the directory fakeDeps makes is removed
  const deps = fakeDeps(t, (url, init) => {
    if (!url.startsWith(`${BASE}/`)) throw new Error(`only ${BASE} answers here, not ${url}`)
    calls.push({ method: init?.method ?? 'GET', url })
    return env.fetch(url.slice(BASE.length), init)
  })
  return {
    env,
    deps,
    calls,
    dir: deps.cwd,
    tools: mcp.buildTools(() => BASE, deps),
    manager: env.manager,
    log: env.core.exchanges,
    recordings: env.core.recordings,
  }
}

/** A tool as tools/list describes it */
interface ListedTool {
  name: string
  description: string
  inputSchema: {
    type: string
    properties: Record<string, { description?: string }>
    required?: string[]
  }
}

/** What tools/list answers over tools, as these tests read it */
async function listTools(tools: mcp.McpTools, id: number): Promise<ListedTool[]> {
  const reply = (await mcp.dispatch(
    { jsonrpc: '2.0', id, method: 'tools/list' },
    tools,
  )) as unknown as Reply
  return reply.result.tools
}

// One tool for what the server is, one for what tunnel knows
test('the registry offers status and guide', async (t) => {
  const { tools } = await mcpEnv(t)

  const listed = await listTools(tools, 21)

  // Offered, not the whole of what is offered: pinning the exact table is the next test's job
  const names = new Set(listed.map((tool) => tool.name))
  assert.ok(names.has('status') && names.has('guide'), [...names].join(', '))
  for (const tool of listed) {
    assert.ok(tool.description.trim(), tool.name)
    assert.equal(tool.inputSchema.type, 'object', tool.name)
  }
})

// The table of tools, in the order tools/list gives them. Writing it out a second time is the
// point: a tool added to the registry and not to this list fails here, so the table grows by a
// decision somebody took rather than by something that happened, and the checks below are what a
// new entry is held to
const TOOL_TABLE = [
  // What this server is, and what tunnel knows
  'status',
  'guide',
  // The rules
  'list_mocks',
  'set_mock',
  'delete_mock',
  'apply_scenario',
  // What the client was seen doing
  'list_requests',
  'get_request',
  'wait_for_request',
  'reset',
  // The switches a whole run is set by
  'set_config',
  'decrypt',
  // Recording, and reading back what was recorded
  'record',
  'list_recordings',
  'get_recording',
  // Proving a rule from outside, through the port a device points at
  'check',
]

// The health check for the table as a whole, and the one test a new tool has to come through.
// Nothing here is about what a tool does: the round trips around it cover that, one tool at a time.
// This is about what a model is handed before it calls anything: sixteen names to pick between,
// and for each one a schema saying which fields exist and what each of them is for. A field with a
// type and no sentence is a field the model guesses the meaning of, and guessing is the thing this
// server was written to put an end to
test('the table is sixteen tools and every schema is one a model can use', async (t) => {
  const listed = await listTools(
    mcp.buildTools(() => BASE, fakeDeps(t, refuse)),
    22,
  )

  const names = listed.map((tool) => tool.name)
  // Sixteen is a count the README commits to, so it is asserted as a count rather than left to be
  // read off the list
  assert.equal(names.length, 16)
  assert.deepEqual(names, TOOL_TABLE)
  // Two tools under one name would be a tool the client cannot reach
  assert.equal(new Set(names).size, names.length)
  for (const tool of listed) {
    const where = tool.name
    assert.ok(tool.description.trim(), where)
    // A client validates the arguments against this before it sends them, so it has to be a
    // schema rather than a note about one
    assert.equal(tool.inputSchema.type, 'object', where)
    const properties = tool.inputSchema.properties
    for (const field of tool.inputSchema.required ?? []) {
      // Demanding a field the schema never declares leaves a client nothing it can send
      assert.ok(Object.hasOwn(properties, field), `${where}.${field}`)
    }
    for (const [field, described] of Object.entries(properties)) {
      assert.ok((described.description ?? '').trim(), `${where}.${field}`)
    }
  }
})

// The first call an agent makes, and it answers two questions at once: what this server is, and
// which recordings it has to choose between
test('status merges the health report and the sessions on disk', async (t) => {
  const { tools } = await mcpEnv(t)

  const result = await toolCall(tools, 'status')

  assert.equal(result.isError, false, text(result))
  const reported = parseJson(text(result)) as JsonObject
  // From /health: which tunnel this is, and what a device would point at
  assert.equal(reported.version, VERSION)
  assert.ok(reported.ca_fingerprint)
  assert.equal(reported.session, 'default')
  // From /sessions: nothing has been recorded into this one yet, which is a different statement
  // from the session not existing
  assert.deepEqual(reported.sessions, {})
})

// The knowledge face, and the copy that matches this server's behaviour: not a summary of it, and
// not whatever is on the default branch. It comes back as the Markdown itself rather than quoted
// into JSON: every newline in 23 KB would otherwise be a backslash and an n that the model pays for
// and nobody reads
test('guide hands over the packaged agents file', async (t) => {
  const { tools } = await mcpEnv(t)

  const result = await toolCall(tools, 'guide')

  assert.equal(result.isError, false, text(result))
  assert.equal(text(result), readFileSync(AGENTS_GUIDE, 'utf8'))
})

// It reads a file out of the package, so it must not go through the address resolver: the moment
// an agent most needs the guide is the one before anything has been started
test('guide answers with nothing running at all', async (t) => {
  const tools = mcp.buildTools(
    () => assert.fail('guide must not ask where the server is'),
    fakeDeps(t, refuse),
  )

  const result = await toolCall(tools, 'guide')

  assert.equal(result.isError, false, text(result))
  assert.ok(text(result).includes('handler(ctx)'))
})

// This server connects and never starts anything, so what comes back has to be a command the agent
// can run itself
test('a tool that finds no server says how to start one', async (t) => {
  const { deps } = await mcpEnv(t)
  const tools = mcp.buildTools(() => BASE, { ...deps, fetch: refuse })

  const result = await toolCall(tools, 'status')

  assert.equal(result.isError, true)
  assert.ok(text(result).includes('tunnel serve --background'), text(result))
})

// The hole this guards. An exception that got out of a tool would reject a promise nothing
// catches, and take the server down with every call in flight
test('a tool that throws answers rather than going quiet', async () => {
  class RuntimeError extends Error {
    override name = 'RuntimeError'
  }
  const tools: mcp.McpTools = [
    {
      name: 'boom',
      description: 'Raises',
      inputSchema: { type: 'object', properties: {} },
      run: async () => {
        throw new RuntimeError('this tool is broken')
      },
    },
  ]

  const result = await toolCall(tools, 'boom')

  assert.equal(result.isError, true)
  assert.ok(text(result).includes('RuntimeError'))
  assert.ok(text(result).includes('this tool is broken'))
})

// Encoding the answer is as much part of running the tool as the call itself, so it sits inside
// the same guard. A BigInt is a value JSON cannot take: JSON.stringify throws a TypeError on it
test('an answer that will not serialise is an error too', async () => {
  const tools: mcp.McpTools = [
    {
      name: 'odd',
      description: 'Answers with something JSON cannot take',
      inputSchema: { type: 'object', properties: {} },
      run: async () => 1n as unknown as JsonValue,
    },
  ]

  const result = await toolCall(tools, 'odd')

  assert.equal(result.isError, true)
  assert.ok(text(result).includes('TypeError'))
})

// What an admin API 4xx becomes: call has already folded the server's detail into the message, and
// the model needs it verbatim — that sentence is the whole of what it has to work out its next call
// from
test("an expected failure keeps the server's own words", async () => {
  const tools: mcp.McpTools = [
    {
      name: 'strict',
      description: 'Always refuses',
      inputSchema: { type: 'object', properties: {} },
      run: async () => {
        throw new CliError('the server answered 400: key must be METHOD:/path')
      },
    },
  ]

  const result = await toolCall(tools, 'strict')

  assert.equal(result.isError, true)
  assert.equal(text(result), 'the server answered 400: key must be METHOD:/path')
})

// Both eras' opening moves and the list of tools, one message a line
const OPENING = [
  {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'fixture', version: '0' },
    },
  },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  { jsonrpc: '2.0', id: 3, method: 'server/discover', params: {} },
]
  .map((message) => `${JSON.stringify(message)}\n`)
  .join('')

// The one thing no in-process test can claim: that `tunnel mcp` is a program an editor can start,
// and that a message put into its stdin comes back out of its stdout as JSON-RPC.
//
// Both eras are asked, because an editor is only ever going to open with one of them and neither
// is allowed to be the one that fails.
test('a real process speaks the protocol over real pipes [slow]', async (t) => {
  // Nothing of the person running the tests is read or written. Closing stdin after the three
  // lines is how the child is told to stop, so this both drives it and ends it; the timeout is
  // what keeps a wedged child off the suite
  const dir = tmpDir(t)
  const { code, stdout, stderr } = await runTunnel(['mcp'], {
    env: { TUNNEL_CONFIG_DIR: dir },
    cwd: dir,
    input: OPENING,
    timeoutMs: 60_000,
  })
  // EOF on stdin is a clean end, and nothing was said on the way out
  assert.equal(code, 0, stderr)
  // The three answers and nothing else: this is the whole process's stdout, so a byte that any
  // module cli.ts loads wrote there would show up here
  assert.match(stdout, /^(?:[^\n]+\n){3}$/)
  const replies = stdout
    .split('\n')
    .slice(0, -1)
    .map((line) => parseJson(line) as unknown as Reply)
  assert.deepEqual(
    replies.map((reply) => reply.jsonrpc),
    ['2.0', '2.0', '2.0'],
  )
  assert.deepEqual(
    replies.map((reply) => reply.id),
    [1, 2, 3],
  )
  const [initialize, list, discover] = replies as [Reply, Reply, Reply]
  // The legacy handshake, answered by the version that is actually installed: this package's
  const info = initialize.result.serverInfo
  assert.deepEqual(info, { name: 'tunnel', version: VERSION })
  assert.equal(initialize.result.protocolVersion, '2025-06-18')
  // How many tools there are is the registry's business; that there is a list is what matters
  // here
  assert.ok(Array.isArray(list.result.tools))
  // The modern entry point, over the same pipes
  assert.deepEqual(discover.result.supportedVersions, mcp.SUPPORTED_VERSIONS)
})

// ------------------------------------------------------------------------- the rule tools

/** The rule the server holds under key, read off its configuration rather than off a tool's
 *  answer: that the rule really is there, and not only in a reply that said so. One that is not
 *  there fails here */
function ruleAt(manager: TunnelConfigManager, key: string): TunnelRequestConfig {
  const rule = manager.getConfig().request_configs[key]
  assert.ok(rule, `there is no rule at ${key}`)
  return rule
}

// The workhorse. json_response is the source, so json is the mode without anybody saying so: the
// same inference `tunnel set -d` makes
test('set_mock lands a rule in the mode its source implies', async (t) => {
  const { tools, manager } = await mcpEnv(t)

  const result = await toolCall(tools, 'set_mock', {
    method: 'get',
    path: '/api/feed',
    json_response: { items: [] },
    status_code: 201,
    delay: 0.25,
    description: 'an empty feed',
  })

  assert.equal(result.isError, false, text(result))
  const rule = ruleAt(manager, 'GET:/api/feed')
  assert.equal(rule.mode, 'json')
  assert.deepEqual(rule.json_response, { items: [] })
  // delay and description went out under the API's own names
  assert.deepEqual([rule.status_code, rule.response_delay], [201, 0.25])
  assert.equal(rule.description, 'an empty feed')
})

// strategy and session are the command line's words for two fields the API calls replay_strategy
// and replay_session; the rule holds the API's
test("set_mock sends the replay fields under the API's names", async (t) => {
  const { tools, manager } = await mcpEnv(t)

  await toolCall(tools, 'set_mock', {
    method: 'GET',
    path: '/api/feed',
    replay: true,
    strategy: 'sequence',
    session: 'acct_a',
  })

  const rule = ruleAt(manager, 'GET:/api/feed')
  assert.equal(rule.mode, 'replay')
  assert.equal(rule.replay_strategy, 'sequence')
  assert.equal(rule.replay_session, 'acct_a')
})

// What `tunnel set --script x.js --mode passthrough` does: a source only settles the mode when
// nothing else did, so a rule can hold a script it is not currently running
test('an explicit mode beats the one a source implies', async (t) => {
  const { tools, manager } = await mcpEnv(t)

  await toolCall(tools, 'set_mock', {
    method: 'GET',
    path: '/api/feed',
    mode: 'passthrough',
    script: 'function handler(ctx) {\n  return {}\n}\n',
  })

  const rule = ruleAt(manager, 'GET:/api/feed')
  assert.equal(rule.mode, 'passthrough')
  assert.ok(rule.script.includes('function handler'))
})

// The fold -H and --content-type do between them: one answer carries one content type, whichever
// spelling the headers had already used for it
test('headers and content_type arrive as the one headers field', async (t) => {
  const { tools, manager } = await mcpEnv(t)

  await toolCall(tools, 'set_mock', {
    method: 'GET',
    path: '/api/feed',
    json_response: {},
    headers: { 'X-Trace': '1', 'Content-Type': 'text/plain' },
    content_type: 'application/json',
  })

  assert.deepEqual(ruleAt(manager, 'GET:/api/feed').headers, {
    'X-Trace': '1',
    'content-type': 'application/json',
  })
})

// The tunnel server reads no files of yours. This process is a local client of its API exactly as
// the CLI is, so what a path names travels inside the call rather than as the path itself
test('a file source is read here and sent inline', async (t) => {
  const { tools, manager, dir } = await mcpEnv(t)
  const script = join(dir, 'feed.js')
  writeFileSync(script, 'function handler(ctx) { return { ok: 1 } }\n')

  await toolCall(tools, 'set_mock', { method: 'GET', path: '/api/feed', script_file: script })

  const rule = ruleAt(manager, 'GET:/api/feed')
  assert.equal(rule.mode, 'script')
  assert.equal(rule.script, readFileSync(script, 'utf8'))
})

// A local user error, caught before anything is sent: the model can only fix the path if it is
// told which path
test('a script_file that is not there names the path', async (t) => {
  const { tools, dir } = await mcpEnv(t)
  const missing = join(dir, 'nowhere', 'feed.js')

  const result = await toolCall(tools, 'set_mock', {
    method: 'GET',
    path: '/api/feed',
    script_file: missing,
  })

  assert.equal(result.isError, true)
  assert.ok(text(result).includes(missing), text(result))
})

// One rule answers one way. Which way is what the sources pick between, so two of them is a
// question with no answer rather than a merge
test("two sources at once is refused in the command line's words", async (t) => {
  const { tools } = await mcpEnv(t)

  const result = await toolCall(tools, 'set_mock', {
    method: 'GET',
    path: '/api/feed',
    json_response: {},
    target: 'https://api.example.com',
  })

  assert.equal(result.isError, true)
  assert.ok(text(result).startsWith('give only one of '), text(result))
})

// The key is built here and judged there, and what comes back is the server's sentence rather
// than a paraphrase of it
test("a malformed key comes back as the server's own 400", async (t) => {
  const { tools } = await mcpEnv(t)

  const result = await toolCall(tools, 'set_mock', {
    method: 'GET FEED',
    path: '/api/feed',
    json_response: {},
  })

  assert.equal(result.isError, true)
  assert.ok(text(result).startsWith('the server answered 400: '), text(result))
  assert.ok(text(result).includes('is not an HTTP method'), text(result))
})

// The admin API compiles a script before it stores one, so the complaint is already exact:
// passing it on unchanged is the whole job here. The line is all that is asserted: what Node says
// about the error after it is its own, and moves between versions
test('a script that will not compile keeps its line number', async (t) => {
  const { tools } = await mcpEnv(t)

  const result = await toolCall(tools, 'set_mock', {
    method: 'GET',
    path: '/api/feed',
    script: 'function handler(ctx) {\n  return )\n}\n',
  })

  assert.equal(result.isError, true)
  assert.ok(text(result).includes('line 2'), text(result))
})

/** What list_mocks answers, as these tests read it */
interface Mocks {
  mocks: { key: string; json_response: JsonValue }[]
}

// It stands in for `tunnel export` too: /mocks and /export return the same shape, so what comes
// back is a scenario's worth of rules
test('list_mocks reads back what set_mock wrote', async (t) => {
  const { tools } = await mcpEnv(t)
  await toolCall(tools, 'set_mock', {
    method: 'GET',
    path: '/api/feed',
    json_response: { items: [] },
  })
  await toolCall(tools, 'set_mock', { method: 'GET', path: '/api/user', json_response: { id: 1 } })

  const everything = await toolCall(tools, 'list_mocks')
  const one = await toolCall(tools, 'list_mocks', { key: 'GET:/api/feed' })

  assert.equal(everything.isError, false, text(everything))
  assert.deepEqual(
    (parseJson(text(everything)) as unknown as Mocks).mocks.map((mock) => mock.key),
    ['GET:/api/feed', 'GET:/api/user'],
  )
  const mocks = (parseJson(text(one)) as unknown as Mocks).mocks
  assert.deepEqual(
    mocks.map((mock) => mock.key),
    ['GET:/api/feed'],
  )
  assert.deepEqual(mocks[0]!.json_response, { items: [] })
})

test('delete_mock takes the rule away', async (t) => {
  const { tools, manager } = await mcpEnv(t)
  await toolCall(tools, 'set_mock', { method: 'GET', path: '/api/feed', json_response: {} })

  const result = await toolCall(tools, 'delete_mock', { key: 'GET:/api/feed' })

  assert.equal(result.isError, false, text(result))
  assert.deepEqual(manager.getConfig().request_configs, {})
})

// A scenario's script_file is resolved against the scenario file's own directory and read here,
// for the same reason set_mock reads one
test('apply_scenario sends the script a file names and not the path', async (t) => {
  const { tools, manager, dir } = await mcpEnv(t)
  writeFileSync(join(dir, 'feed.js'), 'function handler(ctx) {\n  return { a: 1 }\n}\n')
  const scenario = join(dir, 'case.json')
  writeFileSync(
    scenario,
    JSON.stringify({
      mocks: [{ key: 'GET:/api/feed', mode: 'script', script_file: 'feed.js' }],
    }),
  )

  const result = await toolCall(tools, 'apply_scenario', { file: scenario })

  assert.equal(result.isError, false, text(result))
  assert.equal(
    ruleAt(manager, 'GET:/api/feed').script,
    'function handler(ctx) {\n  return { a: 1 }\n}\n',
  )
})

// An agent that worked the rules out in its head has nothing to write to disk first, so the
// scenario itself is a second way in. isError is asserted first, so that a failure shows what the
// tool said
test('apply_scenario takes the scenario inline as well', async (t) => {
  const { tools, manager } = await mcpEnv(t)

  const result = await toolCall(tools, 'apply_scenario', {
    replace: true,
    scenario: {
      mocks: [{ key: 'GET:/api/feed', mode: 'json', json_response: { items: [] } }],
    },
  })

  assert.equal(result.isError, false, text(result))
  assert.equal((parseJson(text(result)) as JsonObject).replaced, true)
  assert.ok(Object.hasOwn(manager.getConfig().request_configs, 'GET:/api/feed'))
})

test('apply_scenario takes a file or a scenario but never both', async (t) => {
  const { tools, dir } = await mcpEnv(t)

  const result = await toolCall(tools, 'apply_scenario', {
    file: join(dir, 'case.json'),
    scenario: { mocks: [] },
  })

  assert.equal(result.isError, true)
  assert.ok(text(result).includes('file') && text(result).includes('scenario'), text(result))
})

// More than isError, which any failure at all would pass: that the error is this one, naming the
// two ways in, as the test before this one asks of its own
test('apply_scenario with neither says so rather than applying nothing', async (t) => {
  const { tools } = await mcpEnv(t)

  const result = await toolCall(tools, 'apply_scenario', { replace: true })

  assert.equal(result.isError, true)
  assert.ok(text(result).includes('file') && text(result).includes('scenario'), text(result))
})

// ------------------------------------------------------------------ the request log tools

// Each test of this section asserts isError before it reads the answer, so that a failure shows
// what the tool said

/** One answered call, recorded the way a real one through the proxy is */
function seed(
  log: ExchangeLog,
  {
    method = 'GET',
    path = '/api/feed',
    unmatched = false,
    ...fields
  }: Partial<Request> & { unmatched?: boolean } = {},
): void {
  log.recordHttp(
    makeRequest({ method, host: 'api.example.com', path, ...fields }),
    makeResponse({ status: 200, body: Buffer.from('{}') }),
    { elapsed_ms: 1, unmatched },
  )
}

/** What list_requests answers, as these tests read it: a row per key, or with each a row per call */
interface Requests {
  requests: { key: string; request_count: number; seq: number; path: string }[]
}

/** What get_request answers, as these tests read it */
interface Logged {
  request: { headers: Record<string, string> }
}

// The everyday view: which endpoints were called and how often, which is what an agent reads to
// find out what it has not mocked yet
test('list_requests aggregates by key by default', async (t) => {
  const { tools, log } = await mcpEnv(t)
  seed(log)
  seed(log)
  seed(log, { path: '/api/user' })

  const result = await toolCall(tools, 'list_requests')

  assert.equal(result.isError, false, text(result))
  const rows = (parseJson(text(result)) as unknown as Requests).requests
  assert.deepEqual(Object.fromEntries(rows.map((row) => [row.key, row.request_count])), {
    'GET:api.example.com/api/feed': 2,
    'GET:api.example.com/api/user': 1,
  })
})

test('list_requests each gives one row per call', async (t) => {
  const { tools, log } = await mcpEnv(t)
  seed(log)
  seed(log, { path: '/api/user' })

  const result = await toolCall(tools, 'list_requests', { each: true })

  assert.equal(result.isError, false, text(result))
  const rows = (parseJson(text(result)) as unknown as Requests).requests
  assert.deepEqual(
    rows.map((row) => [row.seq, row.path]),
    [
      [1, '/api/feed'],
      [2, '/api/user'],
    ],
  )
})

// since is how a test case says "everything after I reset", and unmatched is how it asks what
// nothing answered
test('list_requests filters by since and by unmatched', async (t) => {
  const { tools, log } = await mcpEnv(t)
  seed(log)
  seed(log, { path: '/api/user', unmatched: true })
  seed(log, { path: '/api/pay' })

  const since = await toolCall(tools, 'list_requests', { each: true, since: 1 })
  const unmatched = await toolCall(tools, 'list_requests', { each: true, unmatched: true })

  for (const result of [since, unmatched]) assert.equal(result.isError, false, text(result))
  assert.deepEqual(
    (parseJson(text(since)) as unknown as Requests).requests.map((row) => row.seq),
    [2, 3],
  )
  assert.deepEqual(
    (parseJson(text(unmatched)) as unknown as Requests).requests.map((row) => row.path),
    ['/api/user'],
  )
})

// A request log is pasted into a report far more often than it is replayed, and the server's own
// redact_headers says which ones to hide
test('get_request hides the headers that carry a session', async (t) => {
  const { tools, log } = await mcpEnv(t)
  seed(log, { headers: { authorization: 'Bearer a-real-token' } })

  const result = await toolCall(tools, 'get_request', { seq: 1 })

  assert.equal(result.isError, false, text(result))
  const headers = (parseJson(text(result)) as unknown as Logged).request.headers
  assert.equal(headers.authorization, '[REDACTED]')
})

// For when the real value is the point: a token an agent has to reuse
test('get_request raw keeps the header values', async (t) => {
  const { tools, log } = await mcpEnv(t)
  seed(log, { headers: { authorization: 'Bearer a-real-token' } })

  const result = await toolCall(tools, 'get_request', { seq: 1, raw: true })

  assert.equal(result.isError, false, text(result))
  const headers = (parseJson(text(result)) as unknown as Logged).request.headers
  assert.equal(headers.authorization, 'Bearer a-real-token')
})

// The most important assertion of this section, and the same judgement as the CLI exiting 3 with
// its data intact: the wait gave up, and what it saw before it did is precisely what the caller
// came to assert on. An isError would throw that away and tell the model its call was wrong
test('wait_for_request running out of time is an answer, not an error', async (t) => {
  const { tools } = await mcpEnv(t)

  const result = await toolCall(tools, 'wait_for_request', {
    method: 'POST',
    path: '/api/pay',
    timeout: 0.05,
  })

  assert.equal(result.isError, false, text(result))
  const answer = parseJson(text(result)) as JsonObject
  assert.equal(answer.timed_out, true)
  assert.deepEqual(answer.seqs, [])
})

test('wait_for_request answers at once for a call already made', async (t) => {
  const { tools, log } = await mcpEnv(t)
  seed(log, { method: 'POST', path: '/api/pay' })

  const result = await toolCall(tools, 'wait_for_request', {
    method: 'POST',
    path: '/api/pay',
    timeout: 0.05,
  })

  assert.equal(result.isError, false, text(result))
  const answer = parseJson(text(result)) as JsonObject
  assert.equal(answer.timed_out, false)
  assert.deepEqual(answer.seqs, [1])
})

// The seq it stopped at is what list_requests({since}) picks up from
test('reset empties the request log and says where it stopped', async (t) => {
  const { tools, log } = await mcpEnv(t)
  seed(log)
  seed(log)

  const result = await toolCall(tools, 'reset', { requests: true })

  assert.equal(result.isError, false, text(result))
  assert.equal((parseJson(text(result)) as JsonObject).last_seq, 2)
  assert.equal(log.size, 0)
})

// The same judgement as `tunnel reset` with no flags: between test cases it is the script state
// that has to go, and the log far more rarely
test('reset with neither flag clears the script state alone', async (t) => {
  const { tools, log } = await mcpEnv(t)
  seed(log)

  const result = await toolCall(tools, 'reset')

  assert.equal(result.isError, false, text(result))
  assert.ok(Object.hasOwn(parseJson(text(result)) as JsonObject, 'cleared'), text(result))
  assert.equal(log.size, 1)
})

// ----------------------------------------------------------------- the run-level switches

// The switches a test run throws before it throws any rule: what answers the endpoints nobody
// wrote a rule for, and which recordings that reads
test('set_config moves the whole run at once', async (t) => {
  const { tools, manager } = await mcpEnv(t)

  const result = await toolCall(tools, 'set_config', { default_mode: 'replay', session: 'acct_a' })

  assert.equal(result.isError, false, text(result))
  const config = manager.getConfig()
  assert.deepEqual([config.default_mode, config.session], ['replay', 'acct_a'])
})

// Nothing HTTPS is decrypted until its host is on this list, so this is the step before any of the
// other tools can see a single request body
test('decrypt puts a host on the list that is read', async (t) => {
  const { tools, manager } = await mcpEnv(t)

  const result = await toolCall(tools, 'decrypt', { hosts: ['api.example.com'] })

  assert.equal(result.isError, false, text(result))
  assert.deepEqual((parseJson(text(result)) as JsonObject).include, ['api.example.com'])
  assert.deepEqual(manager.getConfig().ssl_proxying.include, ['api.example.com'])
})

// Why this is a tool and not a note telling the agent to PATCH /config itself: a read-modify-write
// it does by hand is a chance to drop the entries somebody else put there
test('decrypt remove takes one host off and leaves the rest', async (t) => {
  const { tools, manager } = await mcpEnv(t)
  await toolCall(tools, 'decrypt', { hosts: ['api.example.com', 'cdn.example.com'] })

  const result = await toolCall(tools, 'decrypt', { hosts: ['api.example.com'], remove: true })

  assert.equal(result.isError, false, text(result))
  assert.deepEqual(manager.getConfig().ssl_proxying.include, ['cdn.example.com'])
})

// The list that wins: an SDK that pins its certificate goes here and keeps working, while
// everything else is still read
test('decrypt exclude edits the other list', async (t) => {
  const { tools, manager } = await mcpEnv(t)

  await toolCall(tools, 'decrypt', { hosts: ['cdn.example.com'], exclude: true })

  const policy = manager.getConfig().ssl_proxying
  assert.deepEqual([policy.include, policy.exclude], [[], ['cdn.example.com']])
})

// The CLI's own sentence, word for word. Nothing is saved: the model is told what it got wrong
// before any list is written back
test('removing a host that was never there names the list', async (t) => {
  const { tools, manager } = await mcpEnv(t)

  const result = await toolCall(tools, 'decrypt', { hosts: ['api.example.com'], remove: true })

  assert.equal(result.isError, true)
  assert.equal(text(result), 'api.example.com is not in the include list')
  assert.deepEqual(manager.getConfig().ssl_proxying.include, [])
})

// Off means nothing is decrypted however long the include list is, and the list is still there
// when it goes back on. isError is asserted first, so that a failure shows what the tool said
test('decrypt enabled is the master switch over both lists', async (t) => {
  const { tools, manager } = await mcpEnv(t)
  await toolCall(tools, 'decrypt', { hosts: ['api.example.com'] })

  const result = await toolCall(tools, 'decrypt', { enabled: false })

  assert.equal(result.isError, false, text(result))
  assert.equal((parseJson(text(result)) as JsonObject).enabled, false)
  const policy = manager.getConfig().ssl_proxying
  assert.deepEqual([policy.enabled, policy.include], [false, ['api.example.com']])
})

// ------------------------------------------------------------------- recording and replay

/** One recorded call, in the shape the store writes and reads back */
function recorded(seq: number, host = 'api.example.com', path = '/api/feed'): JsonObject {
  return {
    seq,
    time: '2026-09-28T09:00:00',
    kind: 'http',
    request: {
      method: 'GET',
      host,
      port: 443,
      path,
      headers: { accept: 'application/json' },
      body: null,
    },
    response: { status: 200, headers: {}, body: { items: [] }, elapsed_ms: 3, size: 12 },
  }
}

/** What list_recordings answers, as these tests read it: a row per recorded call */
interface Recordings {
  recordings: { key: string }[]
}

/** What get_recording answers, as these tests read it */
interface Recorded {
  request: { headers: Record<string, string> }
  response: { body: JsonValue }
}

// One switch over passthrough traffic, not a per-endpoint mode: start with a session moves the run
// onto it, so that a replay started afterwards reads back what was just kept. Both statuses are
// asserted to be no error before they are read
test('record start names the session and stop leaves it there', async (t) => {
  const { tools } = await mcpEnv(t)

  const started = await toolCall(tools, 'record', { action: 'start', session: 'acct_a' })
  const on = await toolCall(tools, 'record', { action: 'status' })
  await toolCall(tools, 'record', { action: 'stop' })
  const off = await toolCall(tools, 'record', { action: 'status' })

  for (const result of [started, on, off]) assert.equal(result.isError, false, text(result))
  const [now, then] = [on, off].map((result) => parseJson(text(result)) as JsonObject)
  assert.deepEqual([now!.active, now!.session], [true, 'acct_a'])
  assert.deepEqual([then!.active, then!.session], [false, 'acct_a'])
})

test('an action that is not one of the three says which they are', async (t) => {
  const { tools } = await mcpEnv(t)

  const result = await toolCall(tools, 'record', { action: 'pause' })

  assert.equal(result.isError, true)
  assert.ok(text(result).includes('start') && text(result).includes('pause'), text(result))
})

// Which of them replay has to choose between, narrowed the way the rule that will replay them is
// written
test('list_recordings filters by host', async (t) => {
  const { tools, recordings } = await mcpEnv(t)
  await recordings.importExchanges([recorded(1), recorded(2, 'cdn.example.com')], 'default')

  const result = await toolCall(tools, 'list_recordings', { host: 'cdn.example.com' })

  assert.equal(result.isError, false, text(result))
  const rows = (parseJson(text(result)) as unknown as Recordings).recordings
  assert.deepEqual(
    rows.map((row) => row.key),
    ['GET:cdn.example.com/api/feed'],
  )
})

// What a script's ctx.recorded() is going to be handed, read before the script that reshapes it is
// written: so headers and bodies, unabridged
test('get_recording hands back one recorded call whole', async (t) => {
  const { tools, recordings } = await mcpEnv(t)
  await recordings.importExchanges([recorded(1)], 'default')

  const result = await toolCall(tools, 'get_recording', { session: 'default', seq: 1 })

  assert.equal(result.isError, false, text(result))
  const exchange = parseJson(text(result)) as unknown as Recorded
  assert.deepEqual(exchange.request.headers, { accept: 'application/json' })
  assert.deepEqual(exchange.response.body, { items: [] })
})

// ---------------------------------------------------------------------------------- check

// The admin application answers every other tool without a listener in front of it; this is the
// one that has nowhere to send a real request
test('check says so when there is no proxy port to send through', async (t) => {
  const { tools } = await mcpEnv(t)

  const result = await toolCall(tools, 'check', {
    method: 'GET',
    url: 'https://api.example.com/v5/feed',
  })

  assert.equal(result.isError, true)
  assert.ok(text(result).includes('this server has no proxy port'), text(result))
})

// The one tool that is not a wrapper over an admin endpoint: it proves a rule from the outside,
// through the port a device points at and against the CA a device installed, which is the only way
// to be sure of either. The admin app is made with a proxy port for health to name, and
// deps.throughProxy keeps what it is handed. The seconds are checkRequest's own, so elapsed_ms is
// any whole number, and the CA is compared by its PEM
test('check sends a real request through the proxy port', async (t) => {
  const env = await makeAdminEnv(t)
  const app = createAdminApp({
    manager: env.manager,
    core: env.core,
    ca: env.ca,
    proxy: () => ({ host: '0.0.0.0', port: 8888, lan_ips: [] }),
  })
  const sent: ProxiedRequest[] = []
  const deps: CliDeps = {
    ...fakeDeps(t, async (url, init) => {
      if (!url.startsWith(`${BASE}/`)) throw new Error(`only ${BASE} answers here, not ${url}`)
      return app.request(url.slice(BASE.length), init)
    }),
    throughProxy: async (request) => {
      sent.push(request)
      return { status: 200, contentType: 'application/json', body: Buffer.from('{"items": []}') }
    },
  }
  const tools = mcp.buildTools(() => BASE, deps)

  const result = await toolCall(tools, 'check', {
    method: 'get',
    url: 'https://api.example.com/v5/feed',
    query: ['page=2'],
    data: '{"id": 1}',
  })

  assert.equal(result.isError, false, text(result))
  const answer = parseJson(text(result)) as JsonObject
  assert.equal(answer.status, 200)
  assert.ok(Number.isInteger(answer.elapsed_ms) && Number(answer.elapsed_ms) >= 0, text(result))
  assert.deepEqual(parseJson(String(answer.body)), { items: [] })
  // Through the proxy port the health report named, verified against the CA this very server signs
  // with: the two things a device is set up with
  assert.equal(sent.length, 1)
  const [request] = sent as [ProxiedRequest]
  assert.equal(request.proxy, 'http://tunnel.test:8888')
  assert.equal(request.ca.toString('utf8'), await (await app.request('/ca.pem')).text())
  assert.equal(request.method, 'GET')
  const url = new URL(request.url)
  assert.equal(url.origin + url.pathname, 'https://api.example.com/v5/feed')
  assert.equal(url.searchParams.get('page'), '2')
  assert.deepEqual(parseJson(String(request.body)), { id: 1 })
  assert.equal(request.contentType, 'application/json')
})

// ----------------------------------------------------------------------------- edge cases

/** A message as the one line a client sends it in */
function line(message: JsonValue): string {
  return `${JSON.stringify(message)}\n`
}

/** A tools/call of FAKE_TOOLS' echo, which answers {echoed: text} */
function echo(id: number, text: string): JsonObject {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'echo', arguments: { text } } }
}

/** What echo's answer says it was given */
function echoed(reply: Reply): JsonValue {
  return parseJson(reply.result.content[0].text)
}

/** What a line that is not a JSON-RPC message at all is answered with, whole */
const UNPARSED = {
  jsonrpc: '2.0',
  id: null,
  error: { code: mcp.PARSE_ERROR, message: 'Parse error' },
}

/** One turn of the event loop, by the end of which whatever the streams had queued has happened */
function turn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * serveStdio with a stdin of bytes, as process.stdin is, fed the chunks given and then ended, and a
 * LineSink for its stdout. Each chunk is a write of its own and is read before the next one is
 * written: writes made in the same turn reach the loop as a single chunk, so a turn goes by between
 * them, and a test decides exactly where one chunk ends.
 */
function serve(
  chunks: readonly (string | Uint8Array)[],
  tools: mcp.McpTools = FAKE_TOOLS,
): { stdin: PassThrough; stdout: LineSink; served: Promise<number> } {
  const stdin = new PassThrough()
  const stdout = new LineSink()
  const served = mcp.serveStdio(tools, stdin, stdout)
  void (async () => {
    for (const chunk of chunks) {
      stdin.write(chunk)
      await turn()
    }
    stdin.end()
  })()
  return { stdin, stdout, served }
}

/** Every line written so far, parsed */
function replies(stdout: LineSink): Reply[] {
  return stdout.lines.map((text) => parseJson(text) as unknown as Reply)
}

// JSON.stringify leaves U+2028 and U+2029 as they are, so a client written in JS sends them raw,
// and readline on Node 24 ends a line at either. They stay inside the line on the way in, and go
// out as escapes, which parse to the same string
test('U+2028 and U+2029 inside a string end no line on the way in and go out as escapes', async () => {
  const request = line(echo(1, 'a\u2028b\u2029c'))
  assert.ok(request.includes('\u2028') && request.includes('\u2029'))

  const { stdout, served } = serve([Buffer.from(request)])
  assert.equal(await within(served), 0)

  assert.equal(stdout.writes.length, 1)
  const written = stdout.writes[0]!
  assert.ok(!written.includes('\u2028') && !written.includes('\u2029'), written)
  assert.ok(written.includes('\\u2028') && written.includes('\\u2029'), written)
  const [reply] = replies(stdout)
  assert.equal(reply!.id, 1)
  assert.deepEqual(echoed(reply!), { echoed: 'a\u2028b\u2029c' })
})

// Bytes that are not UTF-8 cost their own line and nothing more. They are not made U+FFFD, which
// would put a json_response nobody wrote into the config, and they are not the end of the session.
// ED A0 80 is a surrogate encoded as if it were a character
test('a line that is not UTF-8 is a parse error, and the line after it is answered', async () => {
  const echoing = (bytes: number[]): Buffer =>
    Buffer.concat([
      Buffer.from(
        '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo","arguments":{"text":"',
      ),
      Buffer.from(bytes),
      Buffer.from('"}}}\n'),
    ])

  const { stdout, served } = serve([
    echoing([0xff]),
    echoing([0xed, 0xa0, 0x80]),
    line({ jsonrpc: '2.0', id: 3, method: 'ping' }),
  ])
  assert.equal(await within(served), 0)

  assert.deepEqual(replies(stdout), [UNPARSED, UNPARSED, { jsonrpc: '2.0', id: 3, result: {} }])
})

// A line is decoded once all of it has come in, so a character cut in two by the chunks it arrived
// in is put back together
test('a character split between two chunks comes back whole', async () => {
  const bytes = Buffer.from(line(echo(1, 'a😀b')))
  const cut = bytes.indexOf(Buffer.from('😀')) + 2

  const { stdout, served } = serve([bytes.subarray(0, cut), bytes.subarray(cut)])
  assert.equal(await within(served), 0)

  assert.equal(stdout.lines.length, 1)
  assert.deepEqual(echoed(replies(stdout)[0]!), { echoed: 'a😀b' })
})

// A line ends at \n and nowhere else. One \r before it is taken off, as a client on Windows ends a
// line; a \r anywhere else is part of the line, where JSON reads it as whitespace
test('a line ends at a line feed alone, with one carriage return before it taken off', async () => {
  const ping = (id: number): string => JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' })

  const { stdout, served } = serve([
    `${ping(1)}\r\n`,
    `${ping(2)}\r${ping(3)}\n`,
    `${ping(4)}\r\r\n`,
  ])
  assert.equal(await within(served), 0)

  assert.deepEqual(replies(stdout), [
    { jsonrpc: '2.0', id: 1, result: {} },
    UNPARSED,
    { jsonrpc: '2.0', id: 4, result: {} },
  ])
})

test('an empty line, a line of blanks and a leading BOM are parse errors, a last line without its newline is answered, and an empty stdin is answered with nothing', async () => {
  const { stdout, served } = serve([
    '\n',
    ' \t \n',
    `\uFEFF${line({ jsonrpc: '2.0', id: 1, method: 'ping' })}`,
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
  ])
  assert.equal(await within(served), 0)

  assert.deepEqual(replies(stdout), [
    UNPARSED,
    UNPARSED,
    UNPARSED,
    { jsonrpc: '2.0', id: 2, result: {} },
  ])

  // stdin is /dev/null
  const empty = serve([])
  assert.equal(await within(empty.served), 0)
  assert.deepEqual(empty.stdout.writes, [])
})

// dispatch has settled every answer but a tools/call's by the time it returns, and each line's
// answer is queued in the order the lines were read, so those go out in line order, a parse error's
// included; a tool's goes out when the tool is done. Where 3 lands among 4 and 6 is not asserted:
// that is the tool's business
test("answers other than a tool's go out in the order their lines came in, and a slow tool's goes out when it is done", async () => {
  const slow = slowTool()
  const lines = [
    line(initialize()),
    '{ this line is not JSON\n',
    line({ jsonrpc: '2.0', id: 9, method: 'ping' }),
    line({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slow', arguments: {} } }),
    line(echo(3, 'quick')),
    line({ jsonrpc: '2.0', id: 4, method: 'tools/list' }),
    line({ jsonrpc: '2.0', id: 6, method: 'server/discover' }),
  ]

  const { stdout, served } = serve([lines.join('')], [slow.tool, ...FAKE_TOOLS])
  const first: Reply[] = []
  try {
    await within(slow.running)
    for (let n = 0; n < 6; n++) {
      first.push(parseJson(await within(stdout.next())) as unknown as Reply)
    }
  } finally {
    slow.release()
  }

  const others = first.filter((reply) => reply.id !== 3)
  assert.deepEqual(
    others.map((reply) => reply.id),
    [1, null, 9, 4, 6],
  )
  assert.equal(others[1]!.error.code, mcp.PARSE_ERROR)
  assert.equal((parseJson(await within(stdout.next())) as unknown as Reply).id, 2)
  assert.equal(await within(served), 0)
})

// One write for each message is what keeps two of them from being interleaved on the way out;
// JSON.stringify escapes every control character, so that write holds one line feed, its last. And
// a line is as long as it is: the last request and its answer are 3,000,000 bytes or so
test('every answer is one write of one line, one of 3,000,000 bytes included', async () => {
  const big = 'x'.repeat(3_000_000)

  const { stdout, served } = serve([
    line(initialize()) + line({ jsonrpc: '2.0', id: 2, method: 'ping' }),
    line(echo(3, 'two\nlines')),
    line(echo(4, big)),
  ])
  assert.equal(await within(served), 0)

  assert.equal(stdout.writes.length, 4)
  for (const written of stdout.writes) assert.match(written, /^[^\n]+\n$/)
  assert.ok(stdout.writes[3]!.length > 3_000_000)
  const answers = replies(stdout)
  assert.deepEqual(
    answers.map((reply) => reply.id),
    [1, 2, 3, 4],
  )
  assert.deepEqual(echoed(answers[2]!), { echoed: 'two\nlines' })
  assert.deepEqual(echoed(answers[3]!), { echoed: big })
})

// The end of stdin is how an editor says it has gone, and a tool it called just before still gets
// to answer: serveStdio resolves once that answer is written, not before
test('at the end of stdin, serveStdio waits for the answer of a tool still running', async () => {
  const slow = slowTool()
  const { stdin, stdout, served } = serve(
    [
      line({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'slow', arguments: {} },
      }),
    ],
    [slow.tool],
  )
  // How much had been written when serveStdio resolved
  let writtenAtTheEnd: number | undefined
  void served.then(() => {
    writtenAtTheEnd = stdout.writes.length
  })

  try {
    await within(slow.running)
    // stdin has ended and the loop has had a turn to see it: only the tool can be holding
    // serveStdio up now
    if (!stdin.readableEnded) await within(once(stdin, 'end'))
    await turn()
    assert.equal(writtenAtTheEnd, undefined)
  } finally {
    slow.release()
  }

  assert.equal(await within(served), 0)
  assert.equal(writtenAtTheEnd, 1)
  assert.equal(replies(stdout)[0]!.id, 1)
  assert.equal(replies(stdout)[0]!.result.isError, false)
})

// parseJson keeps an id past 2^53 as its digits, which JSON.stringify writes back as they came;
// JSON.parse would have made it 12345678901234567000
test('an id past 2^53 is answered under the digits it came with', async () => {
  const { stdout, served } = serve([
    '{"jsonrpc":"2.0","id":12345678901234567890,"method":"ping"}\n',
  ])
  assert.equal(await within(served), 0)

  assert.equal(stdout.writes.length, 1)
  assert.match(stdout.writes[0]!, /"id":12345678901234567890[,}]/)
})

// JSON.stringify leaves out a key whose value is undefined, so a request without an id is answered
// under a null one, and the key is there in the text
test('a request without an id is answered with "id":null', async () => {
  const { stdout, served } = serve([line({ jsonrpc: '2.0', method: 'ping' })])
  assert.equal(await within(served), 0)

  assert.equal(stdout.writes.length, 1)
  assert.match(stdout.writes[0]!, /"id":null[,}]/)
})

// jsonrpc is not checked: a message without it, or with "1.0", is answered, and as "2.0". An id of
// any JSON type goes back as it came, and one of 1.0 as 1, which is what JSON.parse makes of it
test('jsonrpc is answered as "2.0" whatever it was, and an id goes back as the value it came as', async () => {
  const unchecked: JsonObject[] = [
    { id: 1, method: 'ping' },
    { jsonrpc: '1.0', id: 1, method: 'ping' },
  ]
  for (const message of unchecked) {
    assert.deepEqual(await dispatch(message), { jsonrpc: '2.0', id: 1, result: {} })
  }
  for (const id of [{ a: 1 }, [1, 'x'], true, false]) {
    assert.deepEqual(await dispatch({ jsonrpc: '2.0', id, method: 'ping' }), {
      jsonrpc: '2.0',
      id,
      result: {},
    })
  }
  const { stdout, served } = serve(['{"jsonrpc":"2.0","id":1.0,"method":"ping"}\n'])
  assert.equal(await within(served), 0)
  assert.deepEqual(stdout.writes, ['{"jsonrpc":"2.0","id":1,"result":{}}\n'])
})

// A batch is not taken apart: JSON-RPC's array of requests is one more message that is not an
// object. The error objects are compared whole, so a data key that should not be there, even as
// undefined, shows
test('a message that is not an object is refused under a null id, and an error says no more than its code and message', async () => {
  for (const message of [5, 'ping', null, [{ jsonrpc: '2.0', id: 1, method: 'ping' }]]) {
    assert.deepEqual(await mcp.dispatch(message, FAKE_TOOLS), {
      jsonrpc: '2.0',
      id: null,
      error: { code: mcp.INVALID_REQUEST, message: 'Invalid Request' },
    })
  }
  // A response sent by the client has no method, and is refused under its own id
  assert.deepEqual(await mcp.dispatch({ jsonrpc: '2.0', id: 6, result: {} }, FAKE_TOOLS), {
    jsonrpc: '2.0',
    id: 6,
    error: { code: mcp.INVALID_REQUEST, message: 'Invalid Request' },
  })
  assert.deepEqual(
    await mcp.dispatch({ jsonrpc: '2.0', id: 5, method: 'resources/list' }, FAKE_TOOLS),
    {
      jsonrpc: '2.0',
      id: 5,
      error: { code: mcp.METHOD_NOT_FOUND, message: 'Method not found' },
    },
  )
  // And a line that is not JSON at all, which only the transport can answer: UNPARSED is the whole
  // of it
  const { stdout, served } = serve(['{ this line is not JSON\n'])
  assert.equal(await within(served), 0)
  assert.deepEqual(replies(stdout), [UNPARSED])
})

// The order a message is judged in: whether it is a notification before the version it declares,
// the version before the method
test('a notification goes unanswered whatever version it declares, and a version is judged before the method', async () => {
  // Not even to refuse it
  const notification = withVersion(
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    '1900-01-01',
  )
  assert.equal(await mcp.dispatch(notification, FAKE_TOOLS), null)
  // Refused for the version, not for the method
  const unknown = await dispatch(
    withVersion({ jsonrpc: '2.0', id: 1, method: 'resources/list' }, '1900-01-01'),
  )
  assert.equal(unknown.error.code, mcp.UNSUPPORTED_PROTOCOL_VERSION)
  // An empty string is a version declared, and not one spoken here
  const empty = await dispatch(withVersion({ jsonrpc: '2.0', id: 2, method: 'ping' }, ''))
  assert.deepEqual(empty.error, {
    code: mcp.UNSUPPORTED_PROTOCOL_VERSION,
    message: 'Unsupported protocol version',
    data: { supported: mcp.SUPPORTED_VERSIONS, requested: '' },
  })
  // _meta that is not an object, or a version that is not a string, declares nothing: that is a
  // client of the handshake era, answered as one
  const undeclared: JsonObject[] = [
    { _meta: 'x' },
    { _meta: [mcp.PROTOCOL_VERSION_KEY] },
    { _meta: { [mcp.PROTOCOL_VERSION_KEY]: 5 } },
  ]
  for (const params of undeclared) {
    assert.deepEqual(await dispatch({ jsonrpc: '2.0', id: 3, method: 'ping', params }), {
      jsonrpc: '2.0',
      id: 3,
      result: {},
    })
  }
  // A handshake that declares a version of the modern era is still answered as a handshake
  const handshake = await dispatch(withVersion(initialize(), '2026-07-28'))
  assert.equal(handshake.result.protocolVersion, mcp.PROTOCOL_VERSION)
})

// The fallback is ||: a missing, empty, 0 or null version is replaced, and anything else is echoed
// as it came, [] and {} included
test('initialize falls back to its own version for a missing, empty, 0 or null protocolVersion and echoes 5 or a list', async () => {
  const unnamed: JsonObject[] = [
    { protocolVersion: 0 },
    { protocolVersion: null },
    { protocolVersion: '' },
    {},
  ]
  for (const params of unnamed) {
    const reply = await dispatch(initialize(params))
    assert.equal(reply.result.protocolVersion, mcp.PROTOCOL_VERSION)
  }
  for (const version of [5, ['x']]) {
    const reply = await dispatch(initialize({ protocolVersion: version }))
    assert.deepEqual(reply.result.protocolVersion, version)
  }
})

// A tool is looked for in the registry and nowhere else, so a name every object has anyway is as
// unknown as any other. The name is shown quoted if it is a string, as null if missing or null.
// Arguments that are not an object are taken as none at all
test('a tools/call finds its tool by name alone, names one it cannot find whatever its type, and takes arguments that are not an object as {}', async () => {
  const unknown: [JsonObject, string][] = [
    [{}, 'null'],
    [{ name: null }, 'null'],
    [{ name: 5 }, '5'],
    [{ name: 'constructor' }, "'constructor'"],
    [{ name: '__proto__' }, "'__proto__'"],
    [{ name: 'toString' }, "'toString'"],
  ]
  for (const [params, shown] of unknown) {
    const reply = await dispatch({ jsonrpc: '2.0', id: 20, method: 'tools/call', params })
    assert.deepEqual(reply.result, {
      content: [{ type: 'text', text: `there is no tool called ${shown}` }],
      isError: true,
    })
  }

  const given: JsonObject[] = []
  const tools: mcp.McpTools = [
    {
      name: 'look',
      description: 'Keeps what it was given',
      inputSchema: { type: 'object', properties: {} },
      run: async (args) => {
        given.push(args)
        return {}
      },
    },
  ]
  const calls: JsonObject[] = [
    { name: 'look' },
    { name: 'look', arguments: null },
    { name: 'look', arguments: [1] },
  ]
  for (const params of calls) {
    const reply = await mcp.dispatch(
      { jsonrpc: '2.0', id: 21, method: 'tools/call', params },
      tools,
    )
    assert.deepEqual(reply, {
      jsonrpc: '2.0',
      id: 21,
      result: { content: [{ type: 'text', text: '{}' }], isError: false },
    })
  }
  assert.deepEqual(given, [{}, {}, {}])
})

// Changed the way a caller might change what it was handed. The list to compare with is taken
// before anything is changed: compared with mcp.SUPPORTED_VERSIONS itself, an answer that shared
// it would change along with it and still look right
test('an answer is made afresh each time, so changing one changes neither the next nor SUPPORTED_VERSIONS', async () => {
  const supported = [...mcp.SUPPORTED_VERSIONS]
  const discovered = await dispatch({ jsonrpc: '2.0', id: 7, method: 'server/discover' })
  discovered.result.supportedVersions.push('1900-01-01')
  const refused = await dispatch(
    withVersion({ jsonrpc: '2.0', id: 10, method: 'ping' }, '1900-01-01'),
  )
  refused.error.data.supported.splice(0)

  const again = await dispatch({ jsonrpc: '2.0', id: 7, method: 'server/discover' })
  assert.deepEqual(again.result.supportedVersions, supported)
  const refusedAgain = await dispatch(
    withVersion({ jsonrpc: '2.0', id: 10, method: 'ping' }, '1900-01-01'),
  )
  assert.deepEqual(refusedAgain.error.data.supported, supported)
  assert.deepEqual(mcp.SUPPORTED_VERSIONS, supported)
})

// A lone surrogate is no character at all, and JSON.stringify writes it as the escape it came in
test('an id that is a lone surrogate is answered under the escape it came in', async () => {
  const { stdout, served } = serve(['{"jsonrpc":"2.0","id":"\\ud800","method":"ping"}\n'])
  assert.equal(await within(served), 0)

  assert.equal(stdout.writes.length, 1)
  assert.match(stdout.writes[0]!, /"id":"\\ud800"/)
  assert.equal(replies(stdout)[0]!.id, '\ud800')
})

// A tool can throw a value that is not an Error, one String() cannot write either among them (an
// object with no prototype has no toString to call), answer with a value JSON.stringify writes as
// nothing at all rather than refusing it, and throw from run before there is a promise to reject.
// Each comes back as a result, and dispatch's promise never rejects
test('a throw of what is not an Error, an answer JSON writes as nothing and a run that throws at once are results too', async () => {
  const tool = (name: string, run: mcp.McpTool['run']): mcp.McpTool => ({
    name,
    description: 'Fails in a way of its own',
    inputSchema: { type: 'object', properties: {} },
    run,
  })
  const tools: mcp.McpTools = [
    tool('shout', async () => {
      throw 'boom'
    }),
    tool('bare', async () => {
      throw Object.create(null)
    }),
    tool('blank', async () => undefined as unknown as JsonValue),
    tool('callable', async () => (() => null) as unknown as JsonValue),
    tool('sudden', () => {
      throw new Error('thrown before there was a promise')
    }),
  ]

  assert.deepEqual(await toolCall(tools, 'shout'), {
    content: [{ type: 'text', text: 'boom' }],
    isError: true,
  })
  assert.deepEqual(await toolCall(tools, 'bare'), {
    content: [
      { type: 'text', text: 'the tool failed, and what it threw cannot be written as text' },
    ],
    isError: true,
  })
  for (const name of ['blank', 'callable']) {
    const result = await toolCall(tools, name)
    assert.equal(result.isError, true)
    assert.match(text(result), /^TypeError: /)
  }
  assert.deepEqual(await toolCall(tools, 'sudden'), {
    content: [{ type: 'text', text: 'Error: thrown before there was a promise' }],
    isError: true,
  })
})

/** A request as recordingFetch was handed it, its body parsed */
interface Sent {
  method: string
  url: URL
  body: JsonValue | undefined
}

/** A fetch with no admin API behind it, for what a tool sends rather than what comes of it: every
 *  request is kept in sent and answered with a 200 and answer */
function recordingFetch(answer: JsonValue = {}): { fetch: Fetch; sent: Sent[] } {
  const sent: Sent[] = []
  const fetch: Fetch = async (url, init) => {
    sent.push({
      method: init?.method ?? 'GET',
      url: new URL(url),
      body: init?.body == null ? undefined : parseJson(String(init.body)),
    })
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetch, sent }
}

/** A request as the tables below write one: its method, its path, every name in its query string
 *  with all of its values, and its body when it has one. The order of the names is not kept, as
 *  the admin API reads them by name */
function described(request: Sent): JsonObject {
  const query: JsonObject = {}
  for (const name of request.url.searchParams.keys()) {
    query[name] = request.url.searchParams.getAll(name)
  }
  const { method, body } = request
  const seen: JsonObject = { method, path: request.url.pathname, query }
  if (body !== undefined) seen.body = body
  return seen
}

/** What the tool named answers to args over a recordingFetch answering every request with answer,
 *  and every request it sent */
async function sending(
  t: TestContext,
  name: string,
  args: JsonObject,
  answer: JsonValue = {},
): Promise<{ result: ToolResult; sent: JsonObject[] }> {
  const { fetch, sent } = recordingFetch(answer)
  const result = await toolCall(
    mcp.buildTools(() => BASE, fakeDeps(t, fetch)),
    name,
    args,
  )
  return { result, sent: sent.map(described) }
}

/** A row of a table of what is sent: a tool, its arguments, and the requests they make, in order */
type Sends = readonly [name: string, args: JsonObject, requests: JsonObject[]]

/** Each row's tool answers with no error and sends exactly the row's requests, each of which is
 *  answered with answer */
async function assertSends(
  t: TestContext,
  rows: readonly Sends[],
  answer: JsonValue = {},
): Promise<void> {
  for (const [name, args, requests] of rows) {
    const { result, sent } = await sending(t, name, args, answer)
    assert.equal(result.isError, false, `${name}: ${text(result)}`)
    assert.deepEqual(sent, requests, name)
  }
}

/** The call the wait_for_request rows below wait for */
const PAY: JsonObject = { method: 'POST', path: '/api/pay' }

/** The one request a wait_for_request for PAY sends: its key, a count of 1 and a timeout of 10
 *  unless query says otherwise, and whatever else query adds */
function waitsFor(query: JsonObject = {}): JsonObject[] {
  return [
    {
      method: 'GET',
      path: '/__admin__/requests/wait',
      query: { key: ['POST:/api/pay'], count: ['1'], timeout: ['10'], ...query },
    },
  ]
}

/** SSL Proxying Locations with nothing on them */
const NO_LOCATIONS: JsonObject = { enabled: false, include: [], exclude: [] }

/** An answer decrypt can take from both of the requests it makes: GET /config, where the locations
 *  are ssl_proxying, and PATCH /config, where they are what the saved config holds */
const LOCATIONS_ANSWER: JsonObject = {
  ssl_proxying: NO_LOCATIONS,
  config: { ssl_proxying: NO_LOCATIONS },
}

/** The read and the save a decrypt makes, the save sending policy */
function readThenSave(policy: JsonObject): JsonObject[] {
  return [
    { method: 'GET', path: '/__admin__/config', query: {} },
    { method: 'PATCH', path: '/__admin__/config', query: {}, body: { ssl_proxying: policy } },
  ]
}

/** A row of a table of what is refused: a tool, its arguments, and the whole of the error text */
type Refuses = readonly [name: string, args: JsonObject, said: string]

/** Each row's tool answers with the row's error, and nothing has been sent by then */
async function assertRefuses(t: TestContext, rows: readonly Refuses[]): Promise<void> {
  for (const [name, args, said] of rows) {
    const { result, sent } = await sending(t, name, args)
    assert.deepEqual(result, { content: [{ type: 'text', text: said }], isError: true }, name)
    assert.deepEqual(sent, [], name)
  }
}

// A missing field that a schema lists as required is refused with a sentence naming it, one at a
// time: the second is named once the first is there. Each is missed before any request is made.
// record's action is the one required field not looked up this way, so a missing action is null
test('a field a tool requires is named when it is missing, and nothing is sent', async (t) => {
  await assertRefuses(t, [
    ['set_mock', {}, "missing required argument 'method'"],
    ['set_mock', { method: 'GET' }, "missing required argument 'path'"],
    ['delete_mock', {}, "missing required argument 'key'"],
    ['get_request', {}, "missing required argument 'seq'"],
    ['wait_for_request', {}, "missing required argument 'method'"],
    ['wait_for_request', { method: 'POST' }, "missing required argument 'path'"],
    ['get_recording', {}, "missing required argument 'session'"],
    ['get_recording', { session: 'default' }, "missing required argument 'seq'"],
    ['check', {}, "missing required argument 'method'"],
    ['check', { method: 'GET' }, "missing required argument 'url'"],
    ['record', {}, 'action is one of start, stop and status, not null'],
  ])
})

// Where a tool asks only whether a value is missing or null, a value that is false is still given;
// where it asks whether the value is true, it is not
test("'' is given where a tool asks whether a value is null, and not given where it asks whether it is true", async (t) => {
  await assertSends(t, [
    [
      'set_mock',
      { method: 'GET', path: '/api/feed', mode: '' },
      [
        {
          method: 'PATCH',
          path: '/__admin__/mocks',
          query: {},
          body: { key: 'GET:/api/feed', mode: '' },
        },
      ],
    ],
    [
      'apply_scenario',
      { scenario: {} },
      [{ method: 'POST', path: '/__admin__/mocks/apply', query: {}, body: {} }],
    ],
    ['list_mocks', { key: '' }, [{ method: 'GET', path: '/__admin__/mocks', query: {} }]],
    [
      'list_requests',
      { since: 0, last: 2, each: false, q: 'x', q_body: true },
      [
        {
          method: 'GET',
          path: '/__admin__/requests',
          query: { last: ['2'], q: ['x'], q_body: ['1'] },
        },
      ],
    ],
    ['wait_for_request', { ...PAY, since: 0 }, waitsFor({ since: ['0'] })],
    [
      'reset',
      { key: '' },
      [{ method: 'POST', path: '/__admin__/state/reset', query: {}, body: {} }],
    ],
    [
      'record',
      { action: 'start', session: '' },
      [{ method: 'POST', path: '/__admin__/record/start', query: {}, body: { session: '' } }],
    ],
    [
      'list_recordings',
      { session: '' },
      [{ method: 'GET', path: '/__admin__/recordings', query: {} }],
    ],
  ])
  await assertRefuses(t, [
    [
      'apply_scenario',
      { file: '', scenario: { mocks: [] } },
      'give a file or a scenario, not both: a path to a scenario file, or the scenario itself',
    ],
  ])
})

// An integer past 2^53, which parseJson keeps as its digits, goes into a path as those digits; as
// a timeout it is a number like any other, and the wait is held to the 300 seconds any wait is
test('an integer past 2^53 goes into a path as its digits, and as a timeout is held to 300 seconds', async (t) => {
  await assertSends(t, [
    [
      'get_request',
      parseJson('{"seq": 12345678901234567890, "raw": true}') as JsonObject,
      [{ method: 'GET', path: '/__admin__/requests/12345678901234567890', query: {} }],
    ],
    [
      'wait_for_request',
      parseJson(
        '{"method": "POST", "path": "/api/pay", "timeout": 12345678901234567890}',
      ) as JsonObject,
      waitsFor({ timeout: ['300'] }),
    ],
  ])
})

// A timeout or a count of null is the default, as null is for every other field; "30" and true are
// the numbers 30 and 1; a timeout that is no whole number of milliseconds still goes out; and q is
// the name once for each of its items, none for none
test('wait_for_request takes null for its defaults, "30" and true as numbers, a timeout of no whole number of milliseconds, and q as the name repeated', async (t) => {
  await assertSends(t, [
    ['wait_for_request', { ...PAY, timeout: null, count: null }, waitsFor()],
    ['wait_for_request', { ...PAY, timeout: '30' }, waitsFor({ timeout: ['30'] })],
    ['wait_for_request', { ...PAY, timeout: true }, waitsFor({ timeout: ['1'] })],
    ['wait_for_request', { ...PAY, timeout: 0.0505 }, waitsFor({ timeout: ['0.0505'] })],
    ['wait_for_request', { ...PAY, q: ['a b', 'c'] }, waitsFor({ q: ['a b', 'c'] })],
    ['wait_for_request', { ...PAY, q: [] }, waitsFor()],
  ])
})

// A value of the wrong type for what a tool does with it is refused, before anything is sent,
// rather than made into something by JS. What matters most is scenario: spread, 5 is {}, and with
// replace that is every rule replaced by none
test('a value of a type that cannot be used is a TypeError, and nothing is sent', async (t) => {
  const feed = { method: 'GET', path: '/api/feed' }
  await assertRefuses(t, [
    [
      'set_mock',
      { method: 5, path: '/api/feed' },
      'TypeError: method must be a string, not a number',
    ],
    ['set_mock', { ...feed, json_file: 5 }, 'TypeError: json_file must be a string, not a number'],
    [
      'set_mock',
      { ...feed, json_file: ['case.json'] },
      'TypeError: json_file must be a string, not a list',
    ],
    [
      'set_mock',
      { ...feed, script_file: 5 },
      'TypeError: script_file must be a string, not a number',
    ],
    ['set_mock', { ...feed, headers: 'ab' }, 'TypeError: headers must be an object, not a string'],
    ['apply_scenario', { scenario: 5 }, 'TypeError: scenario must be an object, not a number'],
    ['apply_scenario', { scenario: 'ab' }, 'TypeError: scenario must be an object, not a string'],
    [
      'apply_scenario',
      { scenario: 5, replace: true },
      'TypeError: scenario must be an object, not a number',
    ],
    ['apply_scenario', { file: ['case.json'] }, 'TypeError: file must be a string, not a list'],
    [
      'wait_for_request',
      { ...feed, timeout: '' },
      'TypeError: timeout must be a number, not a string',
    ],
    [
      'wait_for_request',
      { ...feed, timeout: 'abc' },
      'TypeError: timeout must be a number, not a string',
    ],
    [
      'wait_for_request',
      { ...feed, timeout: [5] },
      'TypeError: timeout must be a number, not a list',
    ],
    [
      'wait_for_request',
      { ...feed, timeout: {} },
      'TypeError: timeout must be a number, not an object',
    ],
    [
      'decrypt',
      { hosts: 'api.example.com' },
      'TypeError: hosts must be a list of strings, not a string',
    ],
    [
      'check',
      { method: 'GET', url: 'https://api.example.com/', query: 'page=2' },
      'TypeError: query must be a list of strings, not a string',
    ],
    [
      'check',
      { method: 'GET', url: ['https://api.example.com/'] },
      'TypeError: url must be a string, not a list',
    ],
  ])
})

/** What wait_for_request says of a timeout that is a string toNumber cannot read */
const NOT_A_NUMBER = 'TypeError: timeout must be a number, not a string'

// A timeout given as a string is read as Number() reads it: a 0x or 0b prefix is a number, and an
// underscore or infinity spelled in lower case is refused. A string is no timeout the schema allows
test('a timeout given as a string is read as Number() reads it', async (t) => {
  await assertSends(t, [
    ['wait_for_request', { ...PAY, timeout: '0x10' }, waitsFor({ timeout: ['16'] })],
    ['wait_for_request', { ...PAY, timeout: '0b11' }, waitsFor({ timeout: ['3'] })],
  ])
  await assertRefuses(t, [
    ['wait_for_request', { ...PAY, timeout: '1_000' }, NOT_A_NUMBER],
    ['wait_for_request', { ...PAY, timeout: 'infinity' }, NOT_A_NUMBER],
  ])
})

// A negative timeout is the server's to refuse, and it does, with a 422. Below -10 the HTTP layer's
// deadline is negative as well; call() then sets none, so it is the same 422
test('a negative timeout is sent, and the server refuses it with a 422', async (t) => {
  const { tools, calls } = await mcpEnv(t)

  for (const timeout of [-5, -11]) {
    const result = await toolCall(tools, 'wait_for_request', { ...PAY, timeout })
    assert.equal(result.isError, true, String(timeout))
    assert.match(text(result), /^the server answered 422: /)
  }
  assert.equal(calls.length, 2)
})

// Two decrypts at once both land. Each reads the locations, edits them and saves them whole, so the
// second has to read what the first saved: read before that save, it saves the list back without
// the first's host
test('two decrypts at once both land, the second reading what the first saved', async (t) => {
  const { tools, manager } = await mcpEnv(t)

  const results = await Promise.all([
    toolCall(tools, 'decrypt', { hosts: ['a.example'] }),
    toolCall(tools, 'decrypt', { hosts: ['b.example'] }),
  ])

  for (const result of results) assert.equal(result.isError, false, text(result))
  assert.deepEqual(manager.getConfig().ssl_proxying.include, ['a.example', 'b.example'])
})

// A decrypt that fails, taking off a host that was never on, fails alone: the one queued behind it
// runs as it would have, and lands
test('a decrypt that fails holds up none of the ones queued behind it', async (t) => {
  const { tools, manager } = await mcpEnv(t)

  const [refused, added] = await Promise.all([
    toolCall(tools, 'decrypt', { hosts: ['a.example'], remove: true }),
    toolCall(tools, 'decrypt', { hosts: ['b.example'] }),
  ])

  assert.deepEqual(refused, {
    content: [{ type: 'text', text: 'a.example is not in the include list' }],
    isError: true,
  })
  assert.equal(added.isError, false, text(added))
  assert.deepEqual(manager.getConfig().ssl_proxying.include, ['b.example'])
})

// A run asks where the server is when it starts, and then not again however many requests it
// makes: status makes two, as get_request does (the call, then the names to hide), and each asks
// once. The next run asks afresh, which is how a server started in between is found
test('every run asks where the server is once, however many requests it makes, and the next run asks again', async (t) => {
  const { deps, calls, log } = await mcpEnv(t)
  seed(log)
  let asked = 0
  const tools = mcp.buildTools(() => {
    asked += 1
    return BASE
  }, deps)

  const runs: [string, JsonObject][] = [
    ['status', {}],
    ['get_request', { seq: 1 }],
    ['status', {}],
    ['get_request', { seq: 1 }],
  ]
  for (const [index, [name, args]] of runs.entries()) {
    const result = await toolCall(tools, name, args)
    assert.equal(result.isError, false, `${name}: ${text(result)}`)
    assert.equal(asked, index + 1, name)
  }
  assert.equal(calls.length, 8)
})

// A script file is read strictly as UTF-8: bytes that are not UTF-8 are an error, not U+FFFD
// stored in a rule, and a BOM at the start stays in the text
test('a script file that is not UTF-8 is an error and stores nothing, and a BOM at its start is kept', async (t) => {
  const { tools, manager, dir } = await mcpEnv(t)
  const broken = join(dir, 'broken.js')
  writeFileSync(
    broken,
    Buffer.concat([
      Buffer.from("function handler(ctx) {\n  return { a: '"),
      Buffer.from([0xff]),
      Buffer.from("' }\n}\n"),
    ]),
  )

  const refused = await toolCall(tools, 'set_mock', {
    method: 'GET',
    path: '/api/feed',
    script_file: broken,
  })

  assert.equal(refused.isError, true)
  assert.match(text(refused), /^TypeError: /)
  assert.deepEqual(manager.getConfig().request_configs, {})

  const marked = join(dir, 'marked.js')
  const source = '﻿function handler(ctx) {\n  return {}\n}\n'
  writeFileSync(marked, source)

  const result = await toolCall(tools, 'set_mock', {
    method: 'GET',
    path: '/api/feed',
    script_file: marked,
  })

  assert.equal(result.isError, false, text(result))
  assert.equal(ruleAt(manager, 'GET:/api/feed').script, source)
})

// A relative path is taken from deps.cwd, where tunnel mcp was started, as everything the CLI
// reads is, and never from the cwd of the process the tests run in
test('a relative script_file, json_file or file is found from deps.cwd', async (t) => {
  const { tools, manager, dir } = await mcpEnv(t)
  const script = 'function handler(ctx) {\n  return {}\n}\n'
  writeFileSync(join(dir, 'feed.js'), script)
  writeFileSync(join(dir, 'user.json'), '{"id": 1}')
  writeFileSync(
    join(dir, 'case.json'),
    JSON.stringify({ mocks: [{ key: 'GET:/api/cart', mode: 'json', json_response: [] }] }),
  )

  const calls: [string, JsonObject][] = [
    ['set_mock', { method: 'GET', path: '/api/feed', script_file: 'feed.js' }],
    ['set_mock', { method: 'GET', path: '/api/user', json_file: 'user.json' }],
    ['apply_scenario', { file: 'case.json' }],
  ]
  for (const [name, args] of calls) {
    const result = await toolCall(tools, name, args)
    assert.equal(result.isError, false, `${name}: ${text(result)}`)
  }

  assert.equal(ruleAt(manager, 'GET:/api/feed').script, script)
  assert.deepEqual(ruleAt(manager, 'GET:/api/user').json_response, { id: 1 })
  assert.deepEqual(ruleAt(manager, 'GET:/api/cart').json_response, [])
})

// The path is joined to deps.cwd as it is and the system resolves '..': 'sub/../feed.js' with no
// sub is not there, for a script_file as for the CLI's files
test('a script_file through a folder that is not there is not there', async (t) => {
  const { tools, dir } = await mcpEnv(t)
  writeFileSync(join(dir, 'feed.js'), 'function handler(ctx) {\n  return {}\n}\n')

  const result = await toolCall(tools, 'set_mock', {
    method: 'GET',
    path: '/api/feed',
    script_file: 'sub/../feed.js',
  })

  assert.equal(result.isError, true)
  assert.ok(text(result).includes('no such script file: sub/../feed.js'), text(result))
})

// An empty list and an empty object are true to JS, but where a tool asks whether a value is true,
// each is taken for false
test('[] and {} are false where a tool asks whether a value is true', async (t) => {
  await assertSends(t, [
    ['list_mocks', { key: {} }, [{ method: 'GET', path: '/__admin__/mocks', query: {} }]],
    [
      'apply_scenario',
      { scenario: { mocks: [] }, replace: [] },
      [{ method: 'POST', path: '/__admin__/mocks/apply', query: {}, body: { mocks: [] } }],
    ],
    ['list_requests', { each: [] }, [{ method: 'GET', path: '/__admin__/requests', query: {} }]],
    // raw is {}, which is taken for false, so the names to hide are asked for
    [
      'get_request',
      { seq: 1, raw: {} },
      [
        { method: 'GET', path: '/__admin__/requests/1', query: {} },
        { method: 'GET', path: '/__admin__/config', query: {} },
      ],
    ],
  ])
  await assertSends(
    t,
    [
      [
        'decrypt',
        { hosts: ['a.example'], exclude: [], remove: {} },
        readThenSave({ enabled: false, include: ['a.example'], exclude: [] }),
      ],
    ],
    LOCATIONS_ANSWER,
  )
})

// A switch is off only for [], {}, '', 0, false and null, so the string "false" is a switch that
// is on; and replay: false is no source at all, so the source beside it is the one the rule takes
test('a switch given the string "false" is on, and replay: false beside another source is none', async (t) => {
  await assertSends(t, [
    [
      'set_mock',
      { method: 'GET', path: '/api/feed', json_response: { a: 1 }, replay: false },
      [
        {
          method: 'PATCH',
          path: '/__admin__/mocks',
          query: {},
          body: { key: 'GET:/api/feed', json_response: { a: 1 }, mode: 'json' },
        },
      ],
    ],
    // raw is on, so the names to hide are not asked for
    [
      'get_request',
      { seq: 1, raw: 'false' },
      [{ method: 'GET', path: '/__admin__/requests/1', query: {} }],
    ],
    // requests is on and state is not asked for, so the log alone is cleared
    [
      'reset',
      { requests: 'false' },
      [{ method: 'POST', path: '/__admin__/requests/clear', query: {} }],
    ],
    [
      'apply_scenario',
      { scenario: { mocks: [] }, replace: 'false' },
      [
        {
          method: 'POST',
          path: '/__admin__/mocks/apply',
          query: {},
          body: { mocks: [], replace: true },
        },
      ],
    ],
  ])
  await assertSends(
    t,
    [
      [
        'decrypt',
        { hosts: ['a.example'], exclude: 'false' },
        readThenSave({ enabled: false, include: [], exclude: ['a.example'] }),
      ],
    ],
    LOCATIONS_ANSWER,
  )
})

// A value passed on as a query parameter goes out with true and false in lower case, null as
// nothing at all, and a list as the name repeated
test('a query parameter is written with true and false in lower case, null as nothing and a list as the name repeated', async (t) => {
  await assertSends(t, [
    [
      'delete_mock',
      { key: null },
      [{ method: 'DELETE', path: '/__admin__/mocks', query: { key: [''] } }],
    ],
    [
      'delete_mock',
      { key: ['GET:/a', 'GET:/b'] },
      [{ method: 'DELETE', path: '/__admin__/mocks', query: { key: ['GET:/a', 'GET:/b'] } }],
    ],
    [
      'list_mocks',
      { key: true },
      [{ method: 'GET', path: '/__admin__/mocks', query: { key: ['true'] } }],
    ],
    ['wait_for_request', { ...PAY, count: true }, waitsFor({ count: ['true'] })],
    ['wait_for_request', { ...PAY, since: false }, waitsFor({ since: ['false'] })],
    [
      'list_recordings',
      { host: true },
      [{ method: 'GET', path: '/__admin__/recordings', query: { host: ['true'] } }],
    ],
  ])
})

// A type is checked only where the value is used, which for these is only when it is true.
// Headers that are false are no headers, so '' with a content type is that content type alone;
// hosts that are false are none, so '' reads the locations and saves them as they were; check's
// query and data that are false are none, so '' for each goes on to ask health for the proxy port,
// which an answer of {} does not name
test('a value is checked for its type only where it is used', async (t) => {
  await assertSends(t, [
    [
      'set_mock',
      {
        method: 'GET',
        path: '/api/feed',
        json_response: {},
        headers: '',
        content_type: 'text/plain',
      },
      [
        {
          method: 'PATCH',
          path: '/__admin__/mocks',
          query: {},
          body: {
            key: 'GET:/api/feed',
            json_response: {},
            mode: 'json',
            headers: { 'content-type': 'text/plain' },
          },
        },
      ],
    ],
  ])
  await assertSends(t, [['decrypt', { hosts: '' }, readThenSave(NO_LOCATIONS)]], LOCATIONS_ANSWER)
  const { result, sent } = await sending(t, 'check', {
    method: 'GET',
    url: 'https://api.example.com/',
    query: '',
    data: '',
  })
  assert.deepEqual(result, {
    content: [
      { type: 'text', text: 'this server has no proxy port; start it with `tunnel serve`' },
    ],
    isError: true,
  })
  assert.deepEqual(sent, [{ method: 'GET', path: '/__admin__/health', query: {} }])
})

// The first of the promises docs/agents.md and AGENTS.md make for tunnel mcp: what comes back is the JSON
// `--json` prints. Each tool that does what a command does is asked what that command is asked, of
// the same admin app over the same log, rules and recordings, and its text is what the command
// writes with --json, less the newline print ends it with
test('a tool that does what a command does answers with the very JSON that command prints with --json', async (t) => {
  const { tools, deps, log, recordings } = await mcpEnv(t)
  seed(log, { headers: { authorization: 'Bearer a-real-token' } })
  seed(log, { path: '/api/user' })
  await recordings.importExchanges([recorded(1)], 'default')
  const ruled = await toolCall(tools, 'set_mock', {
    method: 'GET',
    path: '/api/feed',
    json_response: { items: [] },
  })
  assert.equal(ruled.isError, false, text(ruled))

  const pairs: [argv: string[], name: string, args: JsonObject][] = [
    [['ls'], 'list_mocks', {}],
    [['requests'], 'list_requests', {}],
    [['requests', '--each'], 'list_requests', { each: true }],
    [['requests', 'show', '1'], 'get_request', { seq: 1 }],
    [['wait', 'GET', '/api/user'], 'wait_for_request', { method: 'GET', path: '/api/user' }],
    [['record', 'status'], 'record', { action: 'status' }],
    [['recordings', 'ls'], 'list_recordings', {}],
    [
      ['recordings', 'show', '1', '--session', 'default'],
      'get_recording',
      { session: 'default', seq: 1 },
    ],
  ]
  for (const [argv, name, args] of pairs) {
    const io = captureIo()
    assert.equal(await main(['--base', BASE, ...argv, '--json'], io, deps), 0, argv.join(' '))
    const result = await toolCall(tools, name, args)
    assert.equal(result.isError, false, `${name}: ${text(result)}`)
    assert.equal(`${text(result)}\n`, io.takeOutput().out, name)
  }
})
