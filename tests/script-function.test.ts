// Function rules: a rule answered by a function held in memory, with the ctx and the return values
// of a script.
//
// The ctx and the return values are script-context.ts's, which the script worker imports and so
// does the main thread, where a function handler runs.
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { isMainThread } from 'node:worker_threads'
import { Paths, TunnelConfigManager } from '../src/config.ts'
import { TunnelCore } from '../src/core.ts'
import { reasonOf } from '../src/errors.ts'
import { parseJson, type JsonValue } from '../src/json.ts'
import { makeRequest, type Request, type Response } from '../src/messages.ts'
import { makeTunnelRequestConfig, type TunnelRequestConfig } from '../src/models.ts'
import { RecordingStore } from '../src/recordings.ts'
import {
  parseScriptJson,
  Recorded,
  Reply,
  stringifyScriptJson,
  toReturn,
} from '../src/script-context.ts'
import {
  FunctionRunner,
  type FunctionContext,
  type FunctionHandler,
} from '../src/script-function.ts'
import { SCRIPT_TIMEOUT_MS } from '../src/script.ts'
import { UpstreamError } from '../src/upstream.ts'
import { fakeUpstream } from './support/fake-upstream.ts'
import { captureLogs } from './support/logs.ts'
import { tmpDir } from './support/tmp.ts'

const BIG = 12345678901234567890n

// The worker gives BigInt.prototype a toJSON in its own realm (script-worker.ts); this module is
// for the main thread too, which is the caller's process when tunnel runs as a library, so it
// writes a BigInt without that patch
test('script-context.ts loads on the main thread and leaves BigInt.prototype alone', () => {
  assert.equal(isMainThread, true)
  assert.equal(typeof toReturn, 'function')
  assert.equal(Object.hasOwn(BigInt.prototype, 'toJSON'), false)
  assert.throws(() => JSON.stringify({ id: BIG }), TypeError)
})

test('on the main thread, toReturn and stringifyScriptJson write a BigInt as its digits and parseScriptJson reads it back as one', () => {
  // An object returned: stringifySpaced's separators, the digits as they are
  assert.deepEqual(toReturn({ id: BIG, n: 1 }), {
    status: null,
    headers: null,
    body: { kind: 'json', text: '{"id": 12345678901234567890, "n": 1}' },
  })
  assert.deepEqual(toReturn(new Reply([BIG], 201, { 'x-a': 'b' })), {
    status: 201,
    headers: { 'x-a': 'b' },
    body: { kind: 'json', text: '[12345678901234567890]' },
  })
  // A Recorded returned: its JSON, with the BigInt a handler put in its body
  const recorded = new Recorded({
    seq: 1,
    status: 200,
    headers: {},
    body: { id: BIG },
    request: null,
    body_encoding: null,
  })
  assert.deepEqual(toReturn(recorded), {
    status: null,
    headers: null,
    body: {
      kind: 'recorded',
      json: '{"seq":1,"status":200,"headers":{},"body":{"id":12345678901234567890},"request":null,"body_encoding":null}',
      bodyBytes: null,
    },
  })

  const text = stringifyScriptJson({ id: BIG, n: 1, list: [-BIG] })
  assert.equal(text, '{"id":12345678901234567890,"n":1,"list":[-12345678901234567890]}')
  const back = parseScriptJson(text) as { id: unknown; n: unknown; list: unknown[] }
  assert.equal(back.id, BIG)
  assert.equal(back.n, 1)
  assert.equal(back.list[0], -BIG)
})

// ---------------------------------------------------------------- function rules in the core

/** A core of its own, its config in a temporary directory, as script-mode.test.ts's env makes one,
 *  with a FunctionRunner made here and handed to it, so that a test can call the very one the core
 *  uses. Its upstream throws: nothing here may reach the network, where the machine's system proxy
 *  could lead to a tunnel somebody is using */
function env(t: TestContext, options?: { timeoutMs?: number }) {
  // Registered before tmpDir(t) registers its own hook, so that the core has closed the log and
  // the store, and their last writes are done, before the directory goes (script-mode.test.ts)
  let core: TunnelCore | undefined
  t.after(() => core?.close())
  const manager = new TunnelConfigManager(Paths.inOneDirectory(tmpDir(t)))
  const store = new RecordingStore(manager)
  const functions = new FunctionRunner(store, options)
  core = new TunnelCore(manager, {
    recordings: store,
    functions,
    upstream: fakeUpstream(() => {
      throw new UpstreamError('no network in this test')
    }),
  })
  return { manager, store, functions, core }
}
type Env = ReturnType<typeof env>

/** A function rule as the library will make one: the key, script mode, and the defaults */
const functionRule = (key: string): TunnelRequestConfig =>
  makeTunnelRequestConfig({ request_key: key, mode: 'script' })

/** The whole core, the way the proxy port asks it */
const answer = (e: Env, fields: Partial<Request>): Promise<Response> =>
  e.core.resolve(makeRequest(fields))

/** GET x<path>, which a rule for that path on any host answers */
const get = (e: Env, path: string, query: Record<string, string> = {}) =>
  answer(e, { method: 'GET', host: 'x', path, query })

const payload = (response: Response): JsonValue => parseJson(response.body.toString('utf8'))

/** A gate a handler waits at, made when it gets there and opened by the test, by name */
function gates() {
  const made = new Map<string, PromiseWithResolvers<void>>()
  return {
    at(name: string): Promise<void> {
      const gate = Promise.withResolvers<void>()
      made.set(name, gate)
      return gate.promise
    },
    open(name: string): void {
      made.get(name)!.resolve()
    },
  }
}

// A call has a script's limit, ten seconds unless the runner is given another, counted
// from when its handler is called, and a script's 500 when it outlives it. Nothing stops the
// handler, though: what its promise does once that 500 has gone is dropped, a value, or logged, a
// failure
test('a function handler that outlives timeoutMs is answered 500, and what it does later is only logged', async (t) => {
  const e = env(t, { timeoutMs: 100 })
  // A runner given no limit has a script's
  assert.equal(new FunctionRunner(e.store).timeoutMs, SCRIPT_TIMEOUT_MS)
  assert.equal(SCRIPT_TIMEOUT_MS, 10_000)
  const logs = captureLogs(t)
  const resolvesLate = Promise.withResolvers<unknown>()
  const rejectsLate = Promise.withResolvers<unknown>()
  e.functions.set(functionRule('GET:/api/resolves-late'), () => resolvesLate.promise)
  e.functions.set(functionRule('GET:/api/rejects-late'), () => rejectsLate.promise)

  for (const path of ['/api/resolves-late', '/api/rejects-late']) {
    const response = await get(e, path)
    assert.equal(response.status, 500)
    assert.equal(response.body.toString('utf8'), 'The script timed out after 0.1 seconds')
  }
  const lines = () =>
    logs.records
      .filter((record) => record.logger === 'tunnel.script-function')
      .map(({ level, message }): [string, string] => [level, message])
  assert.deepEqual(lines(), [
    ['error', 'Script timed out: GET:/api/resolves-late'],
    ['error', 'Script timed out: GET:/api/rejects-late'],
  ])

  resolvesLate.resolve({ too: 'late' })
  rejectsLate.reject(new Error('too late'))
  // The runner hears of both in microtasks, which have all run by the time setImmediate's has
  await new Promise((resolve) => setImmediate(resolve))
  const later = lines().slice(2)
  assert.equal(later.length, 1, logs.text())
  const [level, message] = later[0]!
  assert.equal(level, 'error')
  assert.ok(
    message.startsWith(
      'Script failed after it timed out: GET:/api/rejects-late\nError: too late\n',
    ),
    message,
  )
})

// core.close(), which stop() comes to, answers what is still running, as
// ScriptRunner.close() does, and stops its timers: a handler that never settles would otherwise
// keep the process for the rest of its ten seconds after stop()
test('close() answers the calls still running with 500 and leaves no timer behind', async (t) => {
  const e = env(t)
  const timers = () => process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length
  e.functions.set(functionRule('GET:/api/never'), () => new Promise(() => {}))
  const before = timers()

  const running = [get(e, '/api/never'), get(e, '/api/never')]
  // One for each, from the moment its handler handed back a promise
  assert.equal(timers(), before + 2)
  e.functions.close()

  for (const response of await Promise.all(running)) {
    assert.equal(response.status, 500)
    assert.equal(response.body.toString('utf8'), 'The script runner was closed')
  }
  assert.equal(timers(), before)
})

/** The comparison's request: a JSON body with an integer past 2^53 in it, to the endpoint of the
 *  recording below */
const ECHO: Partial<Request> = {
  method: 'POST',
  host: 'api.example.com',
  path: '/v5/echo',
  headers: { 'content-type': 'application/json' },
  body: Buffer.from('{"id": 12345678901234567890}'),
}

/** What ctx.recorded() hands the comparison's handlers: a body with a big integer in it, and a
 *  framing header among the headers, which a returned recording leaves behind */
const ECHO_RECORDING = {
  seq: 1,
  kind: 'http',
  request: { method: 'POST', host: 'api.example.com', path: '/v5/echo', query: {} },
  response: {
    status: 201,
    headers: { 'content-type': 'application/json', 'content-length': '64', 'x-from': 'backend' },
    body: parseJson('{"cards": [{"id": 7}], "total": 98765432109876543210}'),
    body_encoding: 'json',
  },
}

/** The body of a handler(ctx), async when it awaits, and the status its script answers with: the
 *  ctx itself, every kind of value script-context.ts tells apart, returned and through ctx.reply,
 *  and the three ways a handler fails, a value JSON cannot write among them */
const RETURNS: [body: string, status: number][] = [
  // Every field of the ctx, in its order: one ctx on both threads
  [
    "const { body, recorded, recordings, reply, ...fields } = ctx\n  return { names: Object.keys(ctx), fields, body: body.toString('base64'), calls: [typeof recorded, typeof recordings, typeof reply] }",
    200,
  ],
  ["return { ok: true, list: [1, 'two', null] }", 200],
  ['return { id: 12345678901234567890n, list: [-12345678901234567890n] }', 200],
  ['return { echo: ctx.json, type: typeof ctx.json.id }', 200],
  ["return 'plain'", 200],
  ['return 42', 200],
  ['return Buffer.from([0, 1, 2])', 200],
  ['return new Uint8Array([7, 8]).buffer', 200],
  ['return null', 200],
  ['', 200], // nothing returned
  ["return ctx.reply({ err: 1 }, 503, { 'x-next-cursor': '40' })", 503],
  ["return ctx.reply('oops', 404)", 404],
  [
    "return ctx.reply(Buffer.from('raw'), null, { 'content-type': 'application/octet-stream' })",
    200,
  ],
  ['return ctx.reply(null, 204)', 204],
  ['return ctx.reply(await ctx.recorded(), 299)', 299],
  ['return await ctx.recorded()', 201],
  [
    "const rec = await ctx.recorded()\n  rec.status = 202\n  rec.headers['x-edited'] = 'yes'\n  rec.body.cards.push({ id: 8 })\n  return rec",
    202,
  ],
  ['const rec = await ctx.recorded()\n  rec.body = Buffer.from([0, 1])\n  return rec', 201],
  ["throw new Error('boom')", 500],
  ['return ctx.reply({}, 0)', 500],
  ['const loop = {}\n  loop.self = loop\n  return loop', 500],
]

// One handler, written once, stored as a script and set as a function, answers every kind of return
// value with the same status, headers and bytes, the ctx it was handed among them, which is what
// makes the two one set of rules. A failure's stack says where each was compiled, so of those 500s
// the first two lines are compared: the sentence and the error
test('a handler written as a script and as a function answers every return value byte for byte alike', async (t) => {
  const e = env(t)
  await e.store.importExchanges([ECHO_RECORDING], 'default')
  const key = 'POST:api.example.com/v5/echo'
  const firstTwoLines = (response: Response) =>
    response.body.toString('utf8').split('\n').slice(0, 2)

  for (const [body, status] of RETURNS) {
    const source = `${body.includes('await') ? 'async ' : ''}function handler(ctx) {\n  ${body}\n}\n`
    e.manager.updateRequestConfig(key, { mode: 'script', script: source })
    const script = await answer(e, ECHO)
    // The same source, its handler made on this thread
    const handler = new Function(`${source}\nreturn handler`)() as FunctionHandler
    e.functions.set(functionRule(key), handler)
    const fn = await answer(e, ECHO)
    // Out of the way of the next row's script
    e.functions.delete(key)

    assert.equal(script.status, status, source)
    assert.equal(fn.status, script.status, source)
    assert.deepEqual(fn.headers, script.headers, source)
    if (status === 500) {
      const thrown = /^(Error: boom|TypeError: ctx\.reply|TypeError: Converting circular structure)/
      assert.match(firstTwoLines(script)[1] ?? '', thrown, source)
      assert.deepEqual(firstTwoLines(fn), firstTwoLines(script), source)
    } else {
      assert.deepEqual(fn.body, script.body, source)
    }
  }
})

// A handler that throws, or whose promise rejects, fails as a script does, a 500 with the
// stack, which names the file the handler was written in, and the error line a script's failure
// is logged with
test("a function handler that throws or rejects is answered 500 with its stack, logged as a script's failure is", async (t) => {
  const e = env(t)
  const logs = captureLogs(t)
  e.functions.set(functionRule('GET:/api/throws'), () => {
    throw new Error('boom')
  })
  e.functions.set(functionRule('GET:/api/rejects'), async () => {
    await Promise.resolve()
    throw new Error('later')
  })

  for (const [path, thrown] of [
    ['/api/throws', 'Error: boom'],
    ['/api/rejects', 'Error: later'],
  ] as const) {
    const response = await get(e, path)
    assert.equal(response.status, 500)
    assert.match(response.headers['content-type'] ?? '', /^text\/plain/)
    const text = response.body.toString('utf8')
    const failure = 'The script failed:\n'
    assert.ok(text.startsWith(`${failure}${thrown}\n`), text)
    assert.ok(text.includes('script-function.test.ts:'), text)

    const failed = logs.records.find((record) =>
      record.message.startsWith(`Script failed: GET:${path}\n`),
    )
    assert.ok(failed, logs.text())
    assert.equal(failed.level, 'error')
    assert.equal(failed.logger, 'tunnel.script-function')
    assert.equal(failed.message, `Script failed: GET:${path}\n${text.slice(failure.length)}`)
  }
})

// A value String() cannot write, such as an object with no prototype, thrown or rejected with, is a
// failure like any other, written as Object.prototype.toString writes it, and the same 500 from a
// script: never an error in the middle of reporting one, which in a promise's rejection handler
// would end the process the handler runs in, the test's own
test('a function handler that throws or rejects with a value String() cannot write is answered 500, as a script is', async (t) => {
  const e = env(t)
  const bare = () => Object.create(null) as object
  e.functions.set(functionRule('GET:/api/throws'), () => {
    throw bare()
  })
  e.functions.set(functionRule('GET:/api/rejects'), async () => {
    await Promise.resolve()
    throw bare()
  })
  const script = 'function handler(ctx) {\n  throw Object.create(null)\n}\n'
  e.manager.updateRequestConfig('GET:/api/script', { mode: 'script', script })

  for (const path of ['/api/throws', '/api/rejects', '/api/script']) {
    const response = await get(e, path)
    assert.equal(response.status, 500, path)
    assert.equal(response.body.toString('utf8'), 'The script failed:\n[object Object]', path)
  }
})

// Every call runs as it comes, with no queue: a handler that awaits a promise the test
// holds keeps its own request waiting and no other, of another rule or of its own
test('function handlers run concurrently: one held back does not hold up another', async (t) => {
  const e = env(t)
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  e.functions.set(functionRule('GET:/api/held'), async (ctx) => {
    const hold = ctx.query.hold !== undefined
    if (hold) {
      started.resolve()
      await release.promise
    }
    return { held: hold }
  })
  e.functions.set(functionRule('GET:/api/quick'), () => ({ quick: true }))

  let answered = false
  const held = get(e, '/api/held', { hold: '1' }).then((response) => {
    answered = true
    return response
  })
  await started.promise

  assert.deepEqual(payload(await get(e, '/api/quick')), { quick: true })
  assert.deepEqual(payload(await get(e, '/api/held')), { held: false })
  assert.equal(answered, false)
  release.resolve()
  assert.deepEqual(payload(await held), { held: true })
})

// One rule's calls are handed its ctx.state, the very object, overlapping or not, so that
// a count made on both sides of an await loses nothing. A plain object a handler puts in its place
// is the bucket from then on; anything else is not, as with a script, whose state must stay an
// object to put things on. The core's resetState names these buckets with the scripts' and clears
// them
test('the calls of one function rule share one live ctx.state, a plain object put in its place is kept, and resetState clears it', async (t) => {
  const e = env(t)
  const gate = Promise.withResolvers<void>()
  const handed: unknown[] = []
  e.functions.set(functionRule('GET:/api/count'), async (ctx) => {
    handed.push(ctx.state)
    const state = ctx.state as { n?: number }
    state.n = (state.n ?? 0) + 1
    await gate.promise
    return { n: state.n }
  })

  // Both have counted before either is let through
  const overlapping = [get(e, '/api/count'), get(e, '/api/count')]
  gate.resolve()
  for (const response of await Promise.all(overlapping)) {
    assert.deepEqual(payload(response), { n: 2 })
  }
  assert.equal(handed[0], handed[1])
  assert.deepEqual(payload(await get(e, '/api/count')), { n: 3 })

  /** What the handler below puts in ctx.state's place, by the request's ?to= */
  const replacements: Record<string, () => unknown> = {
    object: () => ({ kept: 'object' }),
    bare: () => Object.assign(Object.create(null) as object, { kept: 'bare' }),
    array: () => ['array'],
    null: () => null,
    map: () => new Map([['kept', 'map']]),
    date: () => new Date(0),
  }
  e.functions.set(functionRule('GET:/api/swap'), (ctx) => {
    const found = { ...(ctx.state as object) }
    const to = ctx.query.to
    if (to !== undefined) ctx.state = replacements[to]!()
    return found
  })
  const swap = async (to?: string) =>
    payload(await get(e, '/api/swap', to === undefined ? {} : { to }))
  assert.deepEqual(await swap('object'), {})
  for (const to of ['array', 'null', 'map', 'date']) {
    assert.deepEqual(await swap(to), { kept: 'object' }, to)
  }
  assert.deepEqual(await swap('bare'), { kept: 'object' })
  assert.deepEqual(await swap(), { kept: 'bare' })

  // A script's bucket as well, which the core names beside theirs
  const script = 'function handler(ctx) {\n  return {}\n}\n'
  e.manager.updateRequestConfig('GET:/api/script', { mode: 'script', script })
  assert.equal((await get(e, '/api/script')).status, 200)
  assert.deepEqual(e.core.resetState(), ['GET:/api/count', 'GET:/api/script', 'GET:/api/swap'])
  assert.deepEqual(payload(await get(e, '/api/count')), { n: 1 })
  assert.deepEqual(await swap(), {})
  assert.deepEqual(e.core.resetState('GET:/api/count'), ['GET:/api/count'])
  assert.deepEqual(e.core.resetState('GET:/api/count'), [])
})

// A call that ends makes the plain object it put in ctx.state's place its rule's
// ctx.state, so of two that overlap and each put one there, the one that ends last has the last
// word. A call that was running when a reset came puts nothing back: the calls after the reset
// start on a new {} and keep to it
test("of a function rule's overlapping calls that each put an object in ctx.state's place, the one that ends last is kept, and none from before a reset", async (t) => {
  const e = env(t)
  const gate = gates()
  e.functions.set(functionRule('GET:/api/swap'), async (ctx) => {
    const { name } = ctx.query
    if (name === undefined) return ctx.state
    await gate.at(name)
    ctx.state = { from: name }
    return null
  })
  const call = (name: string) => get(e, '/api/swap', { name })
  const read = async () => payload(await get(e, '/api/swap'))

  // Both start on the one {}; a ends first, b last
  const [a, b] = [call('a'), call('b')]
  gate.open('a')
  await a
  assert.deepEqual(await read(), { from: 'a' })
  gate.open('b')
  await b
  assert.deepEqual(await read(), { from: 'b' })

  const c = call('c')
  assert.deepEqual(e.core.resetState('GET:/api/swap'), ['GET:/api/swap'])
  assert.deepEqual(await read(), {})
  gate.open('c')
  await c
  assert.deepEqual(await read(), {})
})

// A call that timed out goes on, and what it does to ctx.state still counts, where a script's run
// takes its changes with it. An object it puts in ctx.state's place is kept when its promise
// settles, either way, as it would have been had it ended in time; one it put there before its
// timer went off was kept then, and does not come back over a newer one when the promise settles
// later
test("a function call that timed out keeps the object it puts in ctx.state's place once its promise settles", async (t) => {
  const e = env(t, { timeoutMs: 100 })
  const gate = gates()
  const late = async (ctx: FunctionContext, what: () => void) => {
    if (ctx.query.read !== undefined) return ctx.state
    await gate.at(ctx.path)
    what()
    return null
  }
  e.functions.set(functionRule('GET:/api/resolves'), (ctx) =>
    late(ctx, () => {
      ctx.state = { resolved: true }
    }),
  )
  e.functions.set(functionRule('GET:/api/rejects'), (ctx) =>
    late(ctx, () => {
      ctx.state = { rejected: true }
      throw new Error('too late')
    }),
  )
  e.functions.set(functionRule('GET:/api/early'), async (ctx) => {
    if (ctx.query.read !== undefined) return ctx.state
    ctx.state = { early: true }
    if (ctx.query.now !== undefined) ctx.state = { now: true }
    else await gate.at(ctx.path)
    return null
  })
  const read = async (path: string) => payload(await get(e, path, { read: '1' }))

  for (const path of ['/api/resolves', '/api/rejects', '/api/early']) {
    const response = await get(e, path)
    assert.equal(response.body.toString('utf8'), 'The script timed out after 0.1 seconds', path)
  }
  assert.deepEqual(await read('/api/resolves'), {})
  assert.deepEqual(await read('/api/rejects'), {})
  // Put in place before the timer went off, and then a newer one, by a call that ended at once
  assert.deepEqual(await read('/api/early'), { early: true })
  assert.equal((await get(e, '/api/early', { now: '1' })).status, 200)
  assert.deepEqual(await read('/api/early'), { now: true })

  for (const path of ['/api/resolves', '/api/rejects', '/api/early']) gate.open(path)
  // The handlers go on, and the runner hears of them, in microtasks
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(await read('/api/resolves'), { resolved: true })
  assert.deepEqual(await read('/api/rejects'), { rejected: true })
  assert.deepEqual(await read('/api/early'), { now: true })
})

/** One recorded call of GET api.example.com/v5/feed, as an exchange to import */
const feedExchange = (seq: number, query: Record<string, string>, body: string) => ({
  seq,
  kind: 'http',
  request: { method: 'GET', host: 'api.example.com', path: '/v5/feed', query },
  response: {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: parseJson(body),
    body_encoding: 'json',
  },
})

/** What one call's handler got from the recordings */
interface Lookups {
  pending: unknown
  own: Recorded | null
  asked: Recorded | null
  none: Recorded | null
  all: Recorded[]
  badKey: unknown
}

// On this thread nothing can wait for the disk blocked, as the worker does, so
// ctx.recorded() and ctx.recordings() hand back promises, of what a script gets: a Recorded, chosen
// as a script's is, made afresh for every call, a big integer in it a BigInt. A key that does not
// read rejects with the sentence a script's call throws
test('ctx.recorded() and ctx.recordings() resolve with Recorded in a function handler', async (t) => {
  const e = env(t)
  await e.store.importExchanges(
    [
      feedExchange(1, { page: '1' }, '{"page": 1, "id": 98765432109876543210}'),
      feedExchange(2, { page: '2' }, '{"page": 2}'),
    ],
    'default',
  )
  const seen: Lookups[] = []
  e.functions.set(functionRule('GET:api.example.com/v5/feed'), async (ctx) => {
    const pending = ctx.recorded()
    const own = await pending
    seen.push({
      pending,
      own,
      asked: await ctx.recorded({ query: { page: '1' } }),
      none: await ctx.recorded({ key: 'GET:api.example.com/v5/nothing' }),
      all: await ctx.recordings(),
      badKey: await ctx.recorded({ key: 'bad key' }).catch((error: unknown) => error),
    })
    // The first call changes what it was handed, which no later call is handed
    if (seen.length === 1) (own!.body as { page: number }).page = 99
    return own
  })
  const feed = () =>
    answer(e, { method: 'GET', host: 'api.example.com', path: '/v5/feed', query: { page: '2' } })

  // The recording the request's own query asks for, answered as the handler left it
  assert.deepEqual(payload(await feed()), { page: 99 })
  assert.deepEqual(payload(await feed()), { page: 2 })
  const [first, second] = seen as [Lookups, Lookups]
  assert.ok(first.pending instanceof Promise)
  assert.ok(first.own instanceof Recorded)
  assert.equal(first.own.seq, 2)
  assert.ok(first.asked instanceof Recorded)
  assert.equal(first.asked.seq, 1)
  assert.equal((first.asked.body as { id: unknown }).id, 98765432109876543210n)
  assert.equal(first.none, null)
  assert.deepEqual(
    first.all.map((recorded) => [recorded instanceof Recorded, recorded.seq]),
    [
      [true, 1],
      [true, 2],
    ],
  )
  assert.ok(first.badKey instanceof Error)
  assert.ok(reasonOf(first.badKey).startsWith("'bad key' is not a valid request key"))

  assert.notEqual(second.own, first.own)
})

// The core chooses among the stored rules and the function rules together, the most
// specific winning whatever its kind, and on a key both have, the function rule. Once that is
// deleted, the stored rule answers again
test('matchedRule chooses among stored and function rules by specificity, and a function rule wins its own key', async (t) => {
  const e = env(t)
  const request = (path: string) => makeRequest({ method: 'GET', host: 'api.example.com', path })
  const from = async (path: string) => payload(await e.core.resolve(request(path)))
  const stored = (key: string, name: string) =>
    e.manager.updateRequestConfig(key, { mode: 'json', json_response: { from: name } })
  stored('GET:api.example.com/v5/feed', 'stored feed')
  stored('GET:/v6/*', 'stored v6')
  // With no function rule, the stored rules as they are
  assert.equal(e.core.matchedRule(request('/v5/feed'))?.request_key, 'GET:api.example.com/v5/feed')

  const wildcard = functionRule('GET:/v5/*')
  e.functions.set(wildcard, () => ({ from: 'function v5' }))
  const exact = functionRule('GET:api.example.com/v6/feed')
  e.functions.set(exact, () => ({ from: 'function v6' }))
  assert.deepEqual(await from('/v5/feed'), { from: 'stored feed' })
  assert.equal(e.core.matchedRule(request('/v5/other')), wildcard)
  assert.deepEqual(await from('/v5/other'), { from: 'function v5' })
  assert.equal(e.core.matchedRule(request('/v6/feed')), exact)
  assert.deepEqual(await from('/v6/feed'), { from: 'function v6' })
  assert.deepEqual(await from('/v6/other'), { from: 'stored v6' })

  const own = functionRule('GET:api.example.com/v5/feed')
  e.functions.set(own, () => ({ from: 'function feed' }))
  assert.equal(e.core.matchedRule(request('/v5/feed')), own)
  assert.deepEqual(await from('/v5/feed'), { from: 'function feed' })
  assert.equal(e.functions.delete('GET:api.example.com/v5/feed'), true)
  assert.deepEqual(await from('/v5/feed'), { from: 'stored feed' })
})
