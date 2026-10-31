// Script mode: how what handler(ctx) returns becomes the response.
//
// Asked of the core directly, so a script is exercised exactly as the proxy port will exercise it,
// without a server or a socket.
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Paths, TunnelConfigManager } from '../src/config.ts'
import { TunnelCore } from '../src/core.ts'
import { UserError } from '../src/errors.ts'
import { parseJson, type JsonValue } from '../src/json.ts'
import { makeRequest, type Request, type Response } from '../src/messages.ts'
import type { TunnelRequestConfig } from '../src/models.ts'
import { RecordingStore } from '../src/recordings.ts'
import { compileScript, ScriptRunner, type ScriptRunnerOptions } from '../src/script.ts'
import { captureLogs } from './support/logs.ts'
import { tmpDir } from './support/tmp.ts'

/** A core of its own, with its config file in a temporary directory. Its store and runner are made
 *  here and handed to it, so that a test can call the very ones it uses: record() fills the store,
 *  and the tests of resetState and close() call the runner */
function env(t: TestContext, options?: ScriptRunnerOptions) {
  // Registered before tmpDir(t) registers its own hook: node:test runs t.after hooks in
  // registration order, so the directory must not go before the core has closed the runner, the
  // log and the store, and their last writes are done
  let core: TunnelCore | undefined
  t.after(() => core?.close())
  const manager = new TunnelConfigManager(Paths.inOneDirectory(tmpDir(t)))
  const store = new RecordingStore(manager)
  const runner = new ScriptRunner(store, options)
  core = new TunnelCore(manager, { recordings: store, scripts: runner })
  return { manager, store, runner, core }
}
type Env = ReturnType<typeof env>

/** The whole core, the way the proxy port asks it */
function answer(e: Env, fields: Partial<Request>): Promise<Response> {
  return e.core.resolve(makeRequest(fields))
}

const payload = (response: Response): JsonValue => parseJson(response.body.toString('utf8'))

const setScript = (
  e: Env,
  key: string,
  script: string,
  fields: Partial<TunnelRequestConfig> = {},
) => e.manager.updateRequestConfig(key, { mode: 'script', script, ...fields })

test('an object returned with query pagination', async (t) => {
  const e = env(t)
  const script = `function handler(ctx) {
  const page = Number(ctx.query.page ?? 1)
  return { page, has_more: page < 3 }
}
`
  setScript(e, 'GET:/api/feed', script)

  const feed = async (page?: string) =>
    payload(
      await answer(e, {
        method: 'GET',
        host: 'api.example.com',
        path: '/api/feed',
        query: page ? { page } : {},
      }),
    )

  assert.deepEqual(await feed('2'), { page: 2, has_more: true })
  assert.deepEqual(await feed('3'), { page: 3, has_more: false })
  assert.deepEqual(await feed(), { page: 1, has_more: true })
})

test('headers are read with lower-case keys', async (t) => {
  const e = env(t)
  const script = `function handler(ctx) {
  return { cursor: ctx.headers['x-cursor'] }
}
`
  setScript(e, 'GET:/api/list', script)

  const response = await answer(e, {
    method: 'GET',
    host: 'x',
    path: '/api/list',
    headers: { 'x-cursor': 'abc' },
  })

  assert.deepEqual(payload(response), { cursor: 'abc' })
})

test('reply with a status', async (t) => {
  const e = env(t)
  const script = `function handler(ctx) {
  return ctx.reply('oops', 404)
}
`
  setScript(e, 'GET:/api/miss', script)

  const response = await answer(e, { method: 'GET', host: 'x', path: '/api/miss' })

  assert.equal(response.status, 404)
  assert.deepEqual(response.body, Buffer.from('oops'))
  assert.match(response.headers['content-type'] ?? '', /^text\/plain/)
})

test('reply with a status and headers', async (t) => {
  const e = env(t)
  const script = `function handler(ctx) {
  return ctx.reply({ err: 1 }, 503, { 'x-next-cursor': '40' })
}
`
  setScript(e, 'GET:/api/cursor', script)

  const response = await answer(e, { method: 'GET', host: 'x', path: '/api/cursor' })

  assert.equal(response.status, 503)
  assert.deepEqual(payload(response), { err: 1 })
  assert.equal(response.headers['x-next-cursor'], '40')
})

test('bare return uses configured status_code', async (t) => {
  const e = env(t)
  const script = `function handler(ctx) {
  return { ok: true }
}
`
  setScript(e, 'GET:/api/created', script, { status_code: 201 })

  const response = await answer(e, { method: 'GET', host: 'x', path: '/api/created' })

  assert.equal(response.status, 201)
  assert.deepEqual(payload(response), { ok: true })
})

test('state persists across requests', async (t) => {
  const e = env(t)
  const script = `function handler(ctx) {
  const n = (ctx.state.n ?? 0) + 1
  ctx.state.n = n
  return { seq: n }
}
`
  setScript(e, 'GET:/api/seq', script)

  assert.deepEqual(payload(await answer(e, { method: 'GET', host: 'x', path: '/api/seq' })), {
    seq: 1,
  })
  assert.deepEqual(payload(await answer(e, { method: 'GET', host: 'x', path: '/api/seq' })), {
    seq: 2,
  })
})

test('ctx.json reads the request body', async (t) => {
  const e = env(t)
  const script = `function handler(ctx) {
  return { page: ctx.json.page, method: ctx.method }
}
`
  setScript(e, 'POST:/api/search', script)

  const response = await answer(e, {
    method: 'POST',
    host: 'x',
    path: '/api/search',
    body: Buffer.from('{"page": 5}'),
  })

  assert.deepEqual(payload(response), { page: 5, method: 'POST' })
})

test('a runtime error returns 500 with its stack', async (t) => {
  const e = env(t)
  const script = `function handler(ctx) {
  throw new Error('boom')
}
`
  setScript(e, 'GET:/api/boom', script)

  const response = await answer(e, { method: 'GET', host: 'x', path: '/api/boom' })

  assert.equal(response.status, 500)
  // What the stack says: the error, and the line of the script it was thrown on
  const text = response.body.toString('utf8')
  assert.ok(text.startsWith('The script failed:\n'), text)
  assert.ok(text.includes('Error: boom'), text)
  assert.ok(text.includes('script:GET:/api/boom:2'), text)
})

test('missing handler returns 500', async (t) => {
  const e = env(t)
  setScript(e, 'GET:/api/nohandler', 'const x = 1\n')

  const response = await answer(e, { method: 'GET', host: 'x', path: '/api/nohandler' })

  assert.equal(response.status, 500)
  const text = response.body.toString('utf8')
  assert.ok(text.includes('must define handler(ctx)'), text)
})

test('empty script returns 500', async (t) => {
  const e = env(t)
  setScript(e, 'GET:/api/empty', '')

  const response = await answer(e, { method: 'GET', host: 'x', path: '/api/empty' })

  assert.equal(response.status, 500)
  const { detail } = payload(response) as { detail: string }
  assert.ok(detail.includes('no script'), detail)
})

// A blocked script must cost its own request only, not the whole server
test('a script that never returns times out', async (t) => {
  // A timeout of 0.1 seconds, which the runner takes as an option
  const e = env(t, { timeoutMs: 100 })
  // A loop that waits, which blocks the thread it runs in
  const script = `function handler(ctx) {
  const end = Date.now() + 500
  while (Date.now() < end) {}
  return {}
}
`
  setScript(e, 'GET:/api/slow', script)

  const response = await answer(e, { method: 'GET', host: 'x', path: '/api/slow' })

  assert.equal(response.status, 500)
  const text = response.body.toString('utf8')
  assert.ok(text.includes('timed out'), text)
})

// ---------------------------------------------------------------- the recordings

/** One recorded call, as sample() makes it */
type Sample = [
  seq: number,
  host: string,
  path: string,
  query: Record<string, string>,
  status: number,
  body: JsonValue,
]

/** One recorded call of GET api.example.com/v5/suggestions unless told otherwise */
const sample = (
  seq: number,
  body: JsonValue,
  o: { query?: Record<string, string>; status?: number; host?: string; path?: string } = {},
): Sample => [
  seq,
  o.host ?? 'api.example.com',
  o.path ?? '/v5/suggestions',
  o.query ?? {},
  o.status ?? 200,
  body,
]

/** The exchange record() imports for one Sample */
const toExchange = ([seq, host, path, query, status, body]: Sample) => ({
  seq,
  kind: 'http',
  request: { method: 'GET', host, path, query },
  response: {
    status,
    headers: { 'content-type': 'application/json', 'x-from': 'backend' },
    body,
    body_encoding: 'json',
  },
})

/** Put recordings in the store the way a CI run does, with no backend at all */
const record = (e: Env, calls: Sample[], session = 'default') =>
  e.store.importExchanges(calls.map(toExchange), session)

test('ctx says where the request was going', async (t) => {
  const e = env(t)
  const script = `function handler(ctx) {
  return { scheme: ctx.scheme, host: ctx.host, port: ctx.port, url: ctx.url, client: ctx.client }
}
`
  setScript(e, 'GET:/v5/suggestions', script)

  const response = await answer(e, {
    method: 'GET',
    scheme: 'https',
    host: 'api.example.com',
    port: 443,
    path: '/v5/suggestions',
    query: { page: '2' },
    client: '192.168.1.23',
  })

  assert.deepEqual(payload(response), {
    scheme: 'https',
    host: 'api.example.com',
    port: 443,
    url: 'https://api.example.com/v5/suggestions?page=2',
    client: '192.168.1.23',
  })
})

// The same choice replay's `match` makes, so a script starts from that answer
test('ctx.recorded picks the sample the query asks for', async (t) => {
  const e = env(t)
  await record(e, [
    sample(1, { page: 1 }, { query: { page: '1' } }),
    sample(2, { page: 2 }, { query: { page: '2' } }),
  ])
  const script = `function handler(ctx) {
  const rec = ctx.recorded()
  return { seq: rec.seq, status: rec.status, body: rec.body, from: rec.headers['x-from'], query: rec.request.query }
}
`
  setScript(e, 'GET:/v5/suggestions', script)

  const body = payload(
    await answer(e, {
      method: 'GET',
      host: 'api.example.com',
      path: '/v5/suggestions',
      query: { page: '2' },
    }),
  )

  assert.deepEqual(body, {
    seq: 2,
    status: 200,
    body: { page: 2 },
    from: 'backend',
    query: { page: '2' },
  })
})

test('ctx.recorded takes a query, key and session of its own', async (t) => {
  const e = env(t)
  await record(e, [
    sample(1, { page: 1 }, { query: { page: '1' } }),
    sample(2, { page: 2 }, { query: { page: '2' } }),
    sample(3, { other: true }, { path: '/v5/other' }),
  ])
  await record(e, [sample(4, { account: 'b' })], 'acct_b')
  const script = `function handler(ctx) {
  return {
    query: ctx.recorded({ query: { page: '1' } }).seq,
    key: ctx.recorded({ key: 'GET:api.example.com/v5/other' }).seq,
    session: ctx.recorded({ session: 'acct_b' }).seq,
  }
}
`
  setScript(e, 'GET:/v5/suggestions', script)

  const body = payload(
    await answer(e, {
      method: 'GET',
      host: 'api.example.com',
      path: '/v5/suggestions',
      query: { page: '2' },
    }),
  )

  assert.deepEqual(body, { query: 1, key: 3, session: 4 })
})

test('ctx.recorded is null when nothing was recorded', async (t) => {
  const e = env(t)
  const script = `function handler(ctx) {
  return { found: ctx.recorded() !== null }
}
`
  setScript(e, 'GET:/v5/suggestions', script)

  const response = await answer(e, {
    method: 'GET',
    host: 'api.example.com',
    path: '/v5/suggestions',
  })

  assert.deepEqual(payload(response), { found: false })
})

test('ctx.recordings lists them oldest first', async (t) => {
  const e = env(t)
  await record(e, [sample(3, { page: 3 }), sample(1, { page: 1 }), sample(2, { page: 2 })])
  const script = `function handler(ctx) {
  return ctx.recordings().map((rec) => [rec.seq, rec.body.page])
}
`
  setScript(e, 'GET:/v5/suggestions', script)

  const response = await answer(e, {
    method: 'GET',
    host: 'api.example.com',
    path: '/v5/suggestions',
  })

  assert.deepEqual(payload(response), [
    [1, 1],
    [2, 2],
    [3, 3],
  ])
})

// What ctx.recorded() is for: take the real answer, change one field, hand it back
test('returning what ctx.recorded gave sends its status, headers and edited body', async (t) => {
  const e = env(t)
  await record(e, [sample(1, { cards: [{ id: 7 }], total: 1 }, { status: 201 })])
  const script = `function handler(ctx) {
  const rec = ctx.recorded()
  rec.body.cards = []
  rec.body.total = 0
  return rec
}
`
  setScript(e, 'GET:/v5/suggestions', script)

  const response = await answer(e, {
    method: 'GET',
    host: 'api.example.com',
    path: '/v5/suggestions',
  })

  assert.equal(response.status, 201)
  assert.equal(response.headers['x-from'], 'backend')
  assert.deepEqual(payload(response), { cards: [], total: 0 })
})

// One request's edits must not be what the next request starts from
test('what a script edits is a copy of the recording', async (t) => {
  const e = env(t)
  await record(e, [sample(1, { cards: [] })])
  const script = `function handler(ctx) {
  const rec = ctx.recorded()
  rec.body.cards.push('one more')
  return rec
}
`
  setScript(e, 'GET:/v5/suggestions', script)

  const call = async () =>
    payload(await answer(e, { method: 'GET', host: 'api.example.com', path: '/v5/suggestions' }))

  const first = await call()
  const second = await call()

  assert.deepEqual(first, { cards: ['one more'] })
  assert.deepEqual(second, { cards: ['one more'] })
})

// A recording imported from elsewhere may still carry the headers that described the bytes the
// real server sent; those bytes are gone, so a client must not be told to decompress what is no
// longer compressed
test('a returned recording leaves the framing headers behind', async (t) => {
  const e = env(t)
  await e.store.importExchanges(
    [
      {
        seq: 1,
        kind: 'http',
        request: { method: 'GET', host: 'api.example.com', path: '/v5/suggestions', query: {} },
        response: {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'content-encoding': 'gzip',
            'transfer-encoding': 'chunked',
            'content-length': '9999',
          },
          body: { cards: [] },
          body_encoding: 'json',
        },
      },
    ],
    'default',
  )
  const script = `function handler(ctx) {
  return ctx.reply(ctx.recorded(), 200, { 'content-type': 'application/problem+json' })
}
`
  setScript(e, 'GET:/v5/suggestions', script)

  const response = await answer(e, {
    method: 'GET',
    host: 'api.example.com',
    path: '/v5/suggestions',
  })

  // A header the handler named replaces the recorded one, whatever the recording spelled it;
  // nothing about the old framing is left.
  assert.deepEqual(Object.keys(response.headers), ['content-type'])
  assert.equal(response.headers['content-type'], 'application/problem+json')
  assert.deepEqual(payload(response), { cards: [] })
})

// A script follows the switch a test run makes, like a replay rule does
test('ctx.recorded reads the current session', async (t) => {
  const e = env(t)
  await record(e, [sample(1, { account: 'a' })], 'acct_a')
  await record(e, [sample(2, { account: 'b' })], 'acct_b')
  e.manager.updateConfig({ session: 'acct_b' })
  const script = `function handler(ctx) {
  return { seq: ctx.recorded().seq }
}
`
  setScript(e, 'GET:/v5/suggestions', script)

  const response = await answer(e, {
    method: 'GET',
    host: 'api.example.com',
    path: '/v5/suggestions',
  })

  assert.deepEqual(payload(response), { seq: 2 })
})

// Explicit argument, then the rule's own session, then the current one
test('a session named by the rule or by the script wins over the current one', async (t) => {
  const e = env(t)
  await record(e, [sample(1, { account: 'a' })], 'acct_a')
  await record(e, [sample(2, { account: 'b' })], 'acct_b')
  await record(e, [sample(3, { account: 'c' })], 'acct_c')
  e.manager.updateConfig({ session: 'acct_c' })
  const script = `function handler(ctx) {
  return { rule: ctx.recorded().seq, argument: ctx.recorded({ session: 'acct_a' }).seq }
}
`
  setScript(e, 'GET:/v5/suggestions', script, { replay_session: 'acct_b' })

  const response = await answer(e, {
    method: 'GET',
    host: 'api.example.com',
    path: '/v5/suggestions',
  })

  assert.deepEqual(payload(response), { rule: 2, argument: 1 })
})

// ---------------------------------------------------------------- the script runner

/** The script of 'state persists across requests': counts its rule's requests in ctx.state */
const counter = `function handler(ctx) {
  const n = (ctx.state.n ?? 0) + 1
  ctx.state.n = n
  return { seq: n }
}
`

/** A handler that never gives the worker back */
const loop = `function handler(ctx) {
  while (true) {}
}
`

// The worker is stopped, whatever it is doing, and the next request starts another
test('a script stuck in a loop is stopped, and the next request is answered', async (t) => {
  const e = env(t, { timeoutMs: 100 })
  setScript(e, 'GET:/api/loop', loop)
  setScript(e, 'GET:/api/ok', 'function handler(ctx) {\n  return { ok: true }\n}\n')
  const ask = (path: string) => answer(e, { method: 'GET', host: 'x', path })

  const stuck = await ask('/api/loop')

  assert.equal(stuck.status, 500)
  assert.equal(stuck.body.toString('utf8'), 'The script timed out after 0.1 seconds')
  const next = await ask('/api/ok')
  assert.equal(next.status, 200)
  assert.deepEqual(payload(next), { ok: true })
})

// Two more ways never to give the worker back: a run that waits on a promise nothing will
// settle, and a thread blocked in Atomics.wait, as an unanswered ctx.recorded() would block it
test('a promise that never settles and an Atomics.wait are stopped too', async (t) => {
  const e = env(t, { timeoutMs: 100 })
  const never = `async function handler() {
  await new Promise(() => {})
}
`
  const blocked = `function handler() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
}
`
  setScript(e, 'GET:/api/never', never)
  setScript(e, 'GET:/api/blocked', blocked)
  setScript(e, 'GET:/api/ok', 'function handler(ctx) {\n  return { ok: true }\n}\n')
  const ask = (path: string) => answer(e, { method: 'GET', host: 'x', path })

  for (const path of ['/api/never', '/api/blocked']) {
    const response = await ask(path)
    assert.equal(response.status, 500, path)
    assert.equal(response.body.toString('utf8'), 'The script timed out after 0.1 seconds')
  }
  const next = await ask('/api/ok')
  assert.equal(next.status, 200)
  assert.deepEqual(payload(next), { ok: true })
})

// ctx.state stays on the main thread, so a worker stopped for one rule's run takes no
// other rule's state with it
test('a timeout costs its own rule only', async (t) => {
  const e = env(t, { timeoutMs: 100 })
  setScript(e, 'GET:/api/seq', counter)
  setScript(e, 'GET:/api/loop', loop)
  const ask = (path: string) => answer(e, { method: 'GET', host: 'x', path })
  const seq = async () => payload(await ask('/api/seq'))

  assert.deepEqual(await seq(), { seq: 1 })
  assert.deepEqual(await seq(), { seq: 2 })
  assert.equal((await ask('/api/loop')).status, 500)
  assert.deepEqual(await seq(), { seq: 3 })
})

// A handler may be async, as fetch() and every other promise in JS ask it to be
test('an async handler is awaited', async (t) => {
  const e = env(t)
  const script = `async function handler(ctx) {
  await null
  return { ok: true }
}
`
  setScript(e, 'GET:/api/async', script)

  const response = await answer(e, { method: 'GET', host: 'x', path: '/api/async' })

  assert.equal(response.status, 200)
  assert.deepEqual(payload(response), { ok: true })
})

// The types are erased before the script compiles, so it runs as the JS it would be without them
test('a handler written in TypeScript runs', async (t) => {
  const e = env(t)
  const script = `function handler(ctx: { query: Record<string, string> }): object {
  const page: number = Number(ctx.query.page ?? 1)
  return { page }
}
`
  setScript(e, 'GET:/api/typed', script)

  const response = await answer(e, {
    method: 'GET',
    host: 'x',
    path: '/api/typed',
    query: { page: '4' },
  })

  assert.deepEqual(payload(response), { page: 4 })
})

// JSON.parse makes 12345678901234567890 into 12345678901234567000. A script sees a
// BigInt, which goes back out as the digits it came in as, from the request body, from ctx.state
// and from a recording alike
test('integers past 2^53 survive the body, the state, a recording and the return value', async (t) => {
  const e = env(t)
  const keeps = `function handler(ctx) {
  ctx.state.id = ctx.json.id
  return { id: ctx.json.id, type: typeof ctx.json.id }
}
`
  setScript(e, 'POST:/api/big', keeps)
  const big = () =>
    answer(e, {
      method: 'POST',
      host: 'x',
      path: '/api/big',
      body: Buffer.from('{"id": 12345678901234567890}'),
    })

  const returned = await big()
  const text = returned.body.toString('utf8')
  assert.ok(text.includes('12345678901234567890'), text)
  assert.ok(!text.includes('567000'), text)
  assert.equal((payload(returned) as { type: string }).type, 'bigint')

  // The same rule, so the same bucket, which the first run left the BigInt in
  const compares = `function handler(ctx) {
  return { same: ctx.state.id === 12345678901234567890n }
}
`
  setScript(e, 'POST:/api/big', compares)
  assert.deepEqual(payload(await big()), { same: true })

  // Read with parseJson, so that it is recorded as the digits
  await record(e, [sample(1, parseJson('{"id": 98765432109876543210}'))])
  setScript(e, 'GET:/v5/suggestions', 'function handler(ctx) {\n  return ctx.recorded()\n}\n')
  const replayed = await answer(e, {
    method: 'GET',
    host: 'api.example.com',
    path: '/v5/suggestions',
  })
  assert.equal(replayed.body.toString('utf8'), '{"id": 98765432109876543210}')
})

// A handler's return value is told by its type: bytes, a Uint8Array or an ArrayBuffer, go out as
// they are, null is nothing, any other object is JSON as JSON.stringify writes it, an array a JSON
// list whatever it holds, and the rest is text
test('every shape a handler can return', async (t) => {
  const e = env(t)
  /** The answer of a rule of its own, whose handler returns `expression` */
  const returning = (name: string, expression: string) => {
    setScript(e, `GET:/api/${name}`, `function handler(ctx) {\n  return ${expression}\n}\n`)
    return answer(e, { method: 'GET', host: 'x', path: `/api/${name}` })
  }

  const text = await returning('text', "'plain'")
  assert.equal(text.status, 200)
  assert.deepEqual(text.body, Buffer.from('plain'))
  assert.match(text.headers['content-type'] ?? '', /^text\/plain/)

  const bytes = await returning('bytes', 'Buffer.from([0, 1])')
  assert.deepEqual(bytes.body, Buffer.from([0, 1]))
  assert.deepEqual(bytes.headers, {})

  const arrayBuffer = await returning('arraybuffer', 'new Uint8Array([7]).buffer')
  assert.deepEqual(arrayBuffer.body, Buffer.from([7]))

  const none = await returning('none', 'null')
  assert.equal(none.body.length, 0)
  assert.deepEqual(none.headers, {})

  const number = await returning('number', '42')
  assert.equal(number.body.toString('utf8'), '42')
  assert.match(number.headers['content-type'] ?? '', /^text\/plain/)

  // A list, not a (body, status) pair
  const list = await returning('list', '[1, 2]')
  assert.deepEqual(payload(list), [1, 2])
  assert.equal(list.headers['content-type'], 'application/json')

  // Its entries are not properties, so JSON.stringify writes none of them
  const map = await returning('map', "new Map([['a', 1]])")
  assert.equal(map.body.toString('utf8'), '{}')
})

// ctx.reply refuses a status Node's http would not write and a header that is not a string, in the
// script, so that the 500's stack names the line of the script that called it
test('ctx.reply checks its status and headers', async (t) => {
  const e = env(t)
  /** The answer of a rule of its own, whose handler returns ctx.reply(`args`) */
  const replying = (name: string, args: string) => {
    setScript(e, `GET:/api/${name}`, `function handler(ctx) {\n  return ctx.reply(${args})\n}\n`)
    return answer(e, { method: 'GET', host: 'x', path: `/api/${name}` })
  }
  const refused = async (name: string, args: string, words: string) => {
    const response = await replying(name, args)
    assert.equal(response.status, 500)
    const text = response.body.toString('utf8')
    assert.ok(text.startsWith('The script failed:\nTypeError: '), text)
    assert.ok(text.includes(words), text)
    assert.ok(text.includes(`script:GET:/api/${name}:2`), text)
  }

  await refused('zero', '{}, 0', 'ctx.reply: status must be an integer between 100 and 999, not 0')
  // Quoted, so that it is told from the number
  await refused('string', "{}, '200'", "not '200'")
  await refused('header', '{}, 200, { a: 1 }', 'ctx.reply: header a must be a string')
  // A Map's entries are not properties: taken as an object, it would be no headers at all
  await refused(
    'map',
    "{}, 200, new Map([['a', 'b']])",
    'ctx.reply: headers must be a plain object',
  )

  const ok = await replying('ok', '{ ok: 1 }')
  assert.equal(ok.status, 200)
  assert.deepEqual(payload(ok), { ok: 1 })
})

// The main thread reads the key, as replay would, and what that throws is thrown in the script,
// where it called ctx.recorded()
test("a bad key in ctx.recorded is the script's own error", async (t) => {
  const e = env(t)
  const script = `function handler(ctx) {
  return ctx.recorded({ key: 'bad key' })
}
`
  setScript(e, 'GET:/api/badkey', script)

  const response = await answer(e, { method: 'GET', host: 'x', path: '/api/badkey' })

  assert.equal(response.status, 500)
  const text = response.body.toString('utf8')
  assert.ok(text.startsWith('The script failed:\n'), text)
  // The start of parseKey's sentence; the rest is parseKey's to word
  assert.ok(text.includes("'bad key' is not a valid request key"), text)
  assert.ok(text.includes('script:GET:/api/badkey:2'), text)
})

// Bytes a script put in a recording's body go out as they are, under the recorded headers, where
// JSON would have made them an object
test('a returned recording whose body the script made bytes sends those bytes', async (t) => {
  const e = env(t)
  await record(e, [sample(1, { cards: [] })])
  const script = `function handler(ctx) {
  const rec = ctx.recorded()
  rec.body = Buffer.from([0, 1])
  return rec
}
`
  setScript(e, 'GET:/v5/suggestions', script)

  const response = await answer(e, {
    method: 'GET',
    host: 'api.example.com',
    path: '/v5/suggestions',
  })

  assert.equal(response.status, 200)
  assert.deepEqual(response.body, Buffer.from([0, 1]))
  assert.equal(response.headers['x-from'], 'backend')
})

// The main thread reads what a returned recording holds after the script is done with it, so a
// recording the script broke must fail there as a 500 like any other script's failure, rather
// than as an exception that leaves the request unanswered and takes the server down with it
test('a returned recording the script broke is a 500 rather than a crash', async (t) => {
  const e = env(t)
  await record(e, [sample(1, { cards: [] })])
  const script = `function handler(ctx) {
  const rec = ctx.recorded()
  rec.headers = null
  return rec
}
`
  setScript(e, 'GET:/v5/suggestions', script)

  const response = await answer(e, {
    method: 'GET',
    host: 'api.example.com',
    path: '/v5/suggestions',
  })

  assert.equal(response.status, 500)
  const text = response.body.toString('utf8')
  assert.ok(text.startsWith('The script failed:\nTypeError: '), text)
})

// The main thread reads the recordings with the reader of the request being
// answered, so a lookup for any other has nothing to answer it. A ctx kept on globalThis and used
// by a later request would wait for good, and every script request after it with it; the worker
// throws in the script instead
test('ctx.recorded() on a ctx kept from an earlier request throws rather than holding up the runner', async (t) => {
  const e = env(t)
  const keeps = `function handler(ctx) {
  if (globalThis.kept) return globalThis.kept.recorded()
  globalThis.kept = ctx
  return { first: true }
}
`
  setScript(e, 'GET:/api/kept', keeps)
  setScript(e, 'GET:/api/ok', 'function handler(ctx) {\n  return { ok: true }\n}\n')
  const ask = (path: string) => answer(e, { method: 'GET', host: 'x', path })

  assert.deepEqual(payload(await ask('/api/kept')), { first: true })
  const later = await ask('/api/kept')

  assert.equal(later.status, 500)
  const text = later.body.toString('utf8')
  const sentence =
    'ctx.recorded() and ctx.recordings() work only while their own request is being answered'
  assert.ok(text.startsWith(`The script failed:\nError: ${sentence}\n`), text)
  assert.ok(text.includes('script:GET:/api/kept:2'), text)
  assert.deepEqual(payload(await ask('/api/ok')), { ok: true })
})

/** Whether the log has a line for an error no script caught that starts `Uncaught error in a
 *  script:\n<first>\n`, and none of the runner crashing */
const uncaught = (logs: ReturnType<typeof captureLogs>, first: string) =>
  logs.records.some((record) =>
    record.message.startsWith(`Uncaught error in a script:\n${first}\n`),
  ) && !logs.text().includes('The script runner crashed')

// In a callback a handler left behind, ctx.recorded() throws as it does on a kept
// ctx, and nothing catches it there. The worker logs it and goes on, so it costs no request
test('ctx.recorded() in a callback a handler left behind throws there, and is logged rather than costing a request', async (t) => {
  const e = env(t)
  const logs = captureLogs(t)
  // A listener this test sets off once the request has been answered, rather than a timer, so that
  // it goes off when no run is in the worker
  const leaves = `function handler(ctx) {
  new BroadcastChannel('script-mode leftover').onmessage = () => ctx.recorded()
  return { left: true }
}
`
  setScript(e, 'GET:/api/leaves', leaves)
  setScript(e, 'GET:/api/ok', 'function handler(ctx) {\n  return { ok: true }\n}\n')
  const ask = (path: string) => answer(e, { method: 'GET', host: 'x', path })

  assert.deepEqual(payload(await ask('/api/leaves')), { left: true })
  const channel = new BroadcastChannel('script-mode leftover')
  channel.postMessage('now')
  channel.close()
  const sentence =
    'ctx.recorded() and ctx.recordings() work only while their own request is being answered'
  const logged = () => uncaught(logs, `Error: ${sentence}`)
  for (let waited = 0; !logged() && waited < 2000; waited += 10) await delay(10)
  assert.ok(logged(), logs.text())

  assert.deepEqual(payload(await ask('/api/ok')), { ok: true })
  assert.ok(!logs.text().includes('The script runner crashed'), logs.text())
})

// A promise a handler rejects and leaves behind fails once its request has been
// answered, by when the next request is most often posted to the worker. Node's default would end
// the worker, and the runner would answer that next request with the crash; the worker logs the
// error instead, and each request gets its own answer
test('a rejected promise a handler leaves behind is logged and costs no request', async (t) => {
  const e = env(t)
  const logs = captureLogs(t)
  const leaves = `function handler(ctx) {
  Promise.reject(new Error('left behind'))
  return { left: true }
}
`
  setScript(e, 'GET:/api/leaves', leaves)
  setScript(e, 'GET:/api/ok', 'function handler(ctx) {\n  return { ok: true }\n}\n')
  const ask = (path: string) => answer(e, { method: 'GET', host: 'x', path })

  // Asked together, so the second is posted the moment the first is answered
  const [left, ok] = await Promise.all([ask('/api/leaves'), ask('/api/ok')])

  assert.deepEqual(payload(left), { left: true })
  assert.equal(ok.status, 200, ok.body.toString('utf8'))
  assert.deepEqual(payload(ok), { ok: true })
  const logged = () => uncaught(logs, 'Error: left behind')
  for (let waited = 0; !logged() && waited < 2000; waited += 10) await delay(10)
  assert.ok(logged(), logs.text())
})

// A timer a handler leaves behind can go off while another request's handler
// waits on a promise. What the timer throws, or what ctx.recorded() throws in it, is the timer's:
// logged, and the run it went off during is answered as its own script says
test('an error in a timer a handler left behind does not fail the run it goes off during', async (t) => {
  const e = env(t)
  const logs = captureLogs(t)
  const throwsLater = `function handler(ctx) {
  setTimeout(() => {
    throw new Error('later')
  }, 50)
  return { left: true }
}
`
  const readsLater = `function handler(ctx) {
  setTimeout(() => ctx.recorded(), 50)
  return { left: true }
}
`
  const waits = `async function handler(ctx) {
  await new Promise((resolve) => setTimeout(resolve, 300))
  return { waited: true }
}
`
  setScript(e, 'GET:/api/throws', throwsLater)
  setScript(e, 'GET:/api/reads', readsLater)
  setScript(e, 'GET:/api/waits', waits)
  const ask = (path: string) => answer(e, { method: 'GET', host: 'x', path })

  for (const path of ['/api/throws', '/api/reads']) {
    // The second is posted when the first is answered, and is still waiting when the first one's
    // timer goes off
    const [left, waited] = await Promise.all([ask(path), ask('/api/waits')])
    assert.deepEqual(payload(left), { left: true }, path)
    assert.equal(waited.status, 200, `${path}: ${waited.body.toString('utf8')}`)
    assert.deepEqual(payload(waited), { waited: true })
  }
  const sentence =
    'ctx.recorded() and ctx.recordings() work only while their own request is being answered'
  assert.ok(uncaught(logs, 'Error: later'), logs.text())
  assert.ok(uncaught(logs, `Error: ${sentence}`), logs.text())
})

// A returned value the worker cannot hand to the main thread fails the run as a throw would, rather
// than leaving its request to its timer
test('a returned value that cannot reach the main thread is the script failing', async (t) => {
  const e = env(t)
  setScript(
    e,
    'GET:/api/proxy',
    'function handler(ctx) {\n  return ctx.reply({}, 200, new Proxy({}, {}))\n}\n',
  )

  const response = await answer(e, { method: 'GET', host: 'x', path: '/api/proxy' })

  assert.equal(response.status, 500)
  const text = response.body.toString('utf8')
  assert.ok(text.startsWith('The script failed:\nDataCloneError: '), text)
})

// process.exit() in a script ends the worker's thread, not the server. The
// request it was answering is told why, and the next request gets another worker
test('a script that calls process.exit() is a 500, and the next request gets another worker', async (t) => {
  const e = env(t)
  setScript(e, 'GET:/api/exit', 'function handler(ctx) {\n  process.exit(3)\n}\n')
  setScript(e, 'GET:/api/ok', 'function handler(ctx) {\n  return { ok: true }\n}\n')
  const ask = (path: string) => answer(e, { method: 'GET', host: 'x', path })

  const exited = await ask('/api/exit')

  assert.equal(exited.status, 500)
  const text = exited.body.toString('utf8')
  assert.equal(text, 'The script runner crashed: the worker exited with code 3')
  assert.deepEqual(payload(await ask('/api/ok')), { ok: true })
})

// require is the one parameter of the function a script is compiled into, so a script
// that declares its own at the top level declares it twice
test("require gives the script Node's built-in modules, and a top-level require of its own is refused", async (t) => {
  const e = env(t)
  const script = `function handler(ctx) {
  return { hex: require('node:crypto').createHash('sha256').update('x').digest('hex').slice(0, 8) }
}
`
  setScript(e, 'GET:/api/hash', script)

  const response = await answer(e, { method: 'GET', host: 'x', path: '/api/hash' })

  assert.deepEqual(payload(response), { hex: '2d711642' })
  assert.throws(
    () => compileScript('const require = 1\nfunction handler(ctx) { return {} }\n', 'GET:/x'),
    (error: unknown) => {
      assert.ok(error instanceof UserError, String(error))
      assert.ok(error.message.includes('on line 1'), error.message)
      return true
    },
  )
})

// admin-api.test.ts's 'state reset' and 'wildcard script shares one state bucket' ask the
// same through the admin API
test('resetState clears the buckets and names the keys that had one', async (t) => {
  const e = env(t)
  setScript(e, 'GET:/api/seq', counter)
  // No handler, so a 500; the run made the rule its bucket all the same
  setScript(e, 'GET:/api/nohandler', 'const x = 1\n')
  const seq = async () => payload(await answer(e, { method: 'GET', host: 'x', path: '/api/seq' }))

  assert.deepEqual(await seq(), { seq: 1 })
  const missing = await answer(e, { method: 'GET', host: 'x', path: '/api/nohandler' })
  assert.equal(missing.status, 500)

  assert.deepEqual(e.runner.resetState(), ['GET:/api/nohandler', 'GET:/api/seq'])
  assert.deepEqual(await seq(), { seq: 1 })
  assert.deepEqual(e.runner.resetState('GET:/api/seq'), ['GET:/api/seq'])
  assert.deepEqual(e.runner.resetState('GET:/api/seq'), [])
  assert.deepEqual(e.runner.resetState('GET:/never'), [])
})

// One worker runs one request at a time, in the order they came, so the second run
// starts from the state the first one left
test('two requests to one rule run one after the other', async (t) => {
  const e = env(t)
  setScript(e, 'GET:/api/seq', counter)
  const request = { method: 'GET', host: 'x', path: '/api/seq' }

  const [a, b] = await Promise.all([answer(e, request), answer(e, request)])

  assert.deepEqual(payload(a), { seq: 1 })
  assert.deepEqual(payload(b), { seq: 2 })
})

// What a script changed before it threw is kept, and a circular body is refused by JSON.stringify
test('what a script changed before it threw stays; a circular return is a 500', async (t) => {
  const e = env(t)
  const countsThenThrows = `function handler(ctx) {
  ctx.state.n = (ctx.state.n ?? 0) + 1
  throw new Error('after')
}
`
  setScript(e, 'GET:/api/n', countsThenThrows)
  const n = () => answer(e, { method: 'GET', host: 'x', path: '/api/n' })

  assert.equal((await n()).status, 500)
  assert.equal((await n()).status, 500)
  // A 500 says nothing of the count, so another script of the same rule reads it from the bucket
  const reads = `function handler(ctx) {
  return { n: ctx.state.n }
}
`
  setScript(e, 'GET:/api/n', reads)
  assert.deepEqual(payload(await n()), { n: 2 })

  const circular = `function handler(ctx) {
  const a = {}
  a.self = a
  return a
}
`
  setScript(e, 'GET:/api/circular', circular)
  const response = await answer(e, { method: 'GET', host: 'x', path: '/api/circular' })

  assert.equal(response.status, 500)
  const text = response.body.toString('utf8')
  assert.ok(text.startsWith('The script failed:\n'), text)
  assert.ok(text.includes('circular'), text)
})

// Every test's teardown calls this, through the core's close(): a request it left unanswered would
// never be answered, and every run() after it would wait behind that one. Both places a run can be
// when it comes: waiting for a new worker to load, and posted to one
test('close() answers what was queued, and the runner works again afterwards', async (t) => {
  const e = env(t)
  // Still running when close() comes, however slow the machine
  const stuck = `function handler(ctx) {
  while (true) {}
}
`
  setScript(e, 'GET:/api/stuck', stuck)
  setScript(e, 'GET:/api/ok', 'function handler(ctx) {\n  return { ok: true }\n}\n')
  const ask = (path: string) => answer(e, { method: 'GET', host: 'x', path })
  const allClosed = async (answers: Promise<Response>[]) => {
    for (const response of await Promise.all(answers)) {
      assert.equal(response.status, 500)
      assert.equal(response.body.toString('utf8'), 'The script runner was closed')
    }
  }

  // The first waits for the worker it started to load, the second waits behind it
  const loading = [ask('/api/stuck'), ask('/api/ok')]
  await e.runner.close()
  await allClosed(loading)
  assert.deepEqual(payload(await ask('/api/ok')), { ok: true })

  // The worker that answered that one is ready, so the first is posted to it before close()
  const posted = [ask('/api/stuck'), ask('/api/ok')]
  await new Promise((resolve) => setImmediate(resolve))
  await e.runner.close()
  await allClosed(posted)
  assert.deepEqual(payload(await ask('/api/ok')), { ok: true })
})

// A rule whose script is Python, written to config.json without the admin API's check, fails when a
// request comes, and the 500 says why
test('a Python script is a 500 that says so', async (t) => {
  const e = env(t)
  setScript(e, 'GET:/api/python', 'def handler(ctx):\n    return {}\n')

  const response = await answer(e, { method: 'GET', host: 'x', path: '/api/python' })

  assert.equal(response.status, 500)
  const text = response.body.toString('utf8')
  assert.ok(text.startsWith('The script failed:\n'), text)
  assert.ok(text.includes('SyntaxError'), text)
  assert.ok(text.includes('This looks like Python'), text)
})

test('a failing script is logged as Script failed', async (t) => {
  const e = env(t)
  const logs = captureLogs(t)
  const script = `function handler(ctx) {
  throw new Error('boom')
}
`
  setScript(e, 'GET:/api/boom', script)

  await answer(e, { method: 'GET', host: 'x', path: '/api/boom' })

  const failed = logs.records.find(
    (record) =>
      record.level === 'error' &&
      record.logger === 'tunnel.script' &&
      record.message.startsWith('Script failed: GET:/api/boom\n'),
  )
  assert.ok(failed, logs.text())
  assert.ok(failed.message.includes('Error: boom'), failed.message)
})

test('a timed-out script is logged as Script timed out', async (t) => {
  const e = env(t, { timeoutMs: 100 })
  const logs = captureLogs(t)
  setScript(e, 'GET:/api/slow', loop)

  await answer(e, { method: 'GET', host: 'x', path: '/api/slow' })

  const timedOut = logs.records.find(
    (record) =>
      record.level === 'error' &&
      record.logger === 'tunnel.script' &&
      record.message === 'Script timed out: GET:/api/slow',
  )
  assert.ok(timedOut, logs.text())
})

// ---------------------------------------------------------------- edge cases

// A body that is not UTF-8 or not JSON: ctx.body is the bytes the request brought,
// in a Buffer, whatever ctx.json made of them
test('ctx.body is a Buffer of the bytes the request brought', async (t) => {
  const e = env(t)
  const script = `function handler(ctx) {
  return { buffer: Buffer.isBuffer(ctx.body), text: ctx.body.toString(), hex: ctx.body.toString('hex') }
}
`
  setScript(e, 'POST:/api/body', script)
  const sent = async (body: Buffer) => {
    const response = await answer(e, { method: 'POST', host: 'x', path: '/api/body', body })
    return payload(response) as { buffer: boolean; text: string; hex: string }
  }

  assert.deepEqual(await sent(Buffer.from('héllo')), {
    buffer: true,
    text: 'héllo',
    hex: '68c3a96c6c6f',
  })
  // Not UTF-8, so not JSON either, and there all the same
  assert.equal((await sent(Buffer.from([0xff, 0x00, 0x01]))).hex, 'ff0001')
})

// ctx.json is null for a body that is not UTF-8 JSON, a NaN included, which JSON.parse does not
// read; a UTF-8 BOM is read past; and a body that is a JSON string or number is that value
test('ctx.json is the body read as JSON, or null when it is not', async (t) => {
  const e = env(t)
  setScript(e, 'POST:/api/json', 'function handler(ctx) {\n  return { json: ctx.json }\n}\n')
  const json = async (body: Buffer) => {
    const response = await answer(e, { method: 'POST', host: 'x', path: '/api/json', body })
    return (payload(response) as { json: JsonValue }).json
  }

  assert.equal(await json(Buffer.from('{"a":')), null)
  assert.equal(await json(Buffer.from('NaN')), null)
  // A JSON string of a byte that is not UTF-8, which the decoder refuses
  assert.equal(await json(Buffer.from([0x22, 0xff, 0x22])), null)
  assert.equal(await json(Buffer.alloc(0)), null)
  assert.deepEqual(await json(Buffer.from('\ufeff{"a": 1}')), { a: 1 })
  assert.equal(await json(Buffer.from('"str"')), 'str')
  assert.equal(await json(Buffer.from('5')), 5)
})

// A reset that comes while a script runs drops the rule's bucket, and the run does not bring it
// back when it ends
test('a reset while a script runs keeps the run from writing its state back', async (t) => {
  const e = env(t)
  const countsSlowly = `async function handler(ctx) {
  ctx.state.n = (ctx.state.n ?? 0) + 1
  await new Promise((resolve) => setTimeout(resolve, 200))
  return { n: ctx.state.n }
}
`
  setScript(e, 'GET:/api/slow', countsSlowly)
  setScript(e, 'GET:/api/ok', 'function handler(ctx) {\n  return { ok: true }\n}\n')
  const ask = (path: string) => answer(e, { method: 'GET', host: 'x', path })
  // A worker loaded already, so the run below is posted to it at once
  assert.deepEqual(payload(await ask('/api/ok')), { ok: true })

  const running = ask('/api/slow')
  await delay(50)
  assert.deepEqual(e.runner.resetState('GET:/api/slow'), ['GET:/api/slow'])
  assert.deepEqual(payload(await running), { n: 1 })

  // Nothing written back: no bucket for a reset to find, and the next run counts from nothing
  assert.deepEqual(e.runner.resetState('GET:/api/slow'), [])
  assert.deepEqual(payload(await ask('/api/slow')), { n: 1 })
})

// A run that outlives its timer is stopped before it hands ctx.state back, so what
// it changed goes with it, and the rule's bucket stays as the run before it left it
test("a run that times out leaves its rule's state as it found it", async (t) => {
  const e = env(t, { timeoutMs: 100 })
  const countsThenStalls = `function handler(ctx) {
  ctx.state.n = (ctx.state.n ?? 0) + 1
  if (ctx.query.stall) while (true) {}
  return { n: ctx.state.n }
}
`
  setScript(e, 'GET:/api/n', countsThenStalls)
  const n = (query: Record<string, string> = {}) =>
    answer(e, { method: 'GET', host: 'x', path: '/api/n', query })

  assert.deepEqual(payload(await n()), { n: 1 })
  assert.equal((await n({ stall: '1' })).status, 500)
  assert.deepEqual(payload(await n()), { n: 2 })
})

// A script of nothing but whitespace is no script, and it makes no bucket, since the runner answers
// before it would make one
test('a script of nothing but whitespace is no script, and makes no state bucket', async (t) => {
  const e = env(t)
  setScript(e, 'GET:/api/blank', '  \n\t\n')

  const response = await answer(e, { method: 'GET', host: 'x', path: '/api/blank' })

  assert.equal(response.status, 500)
  assert.deepEqual(payload(response), {
    detail: 'GET:/api/blank is in script mode but has no script',
  })
  assert.deepEqual(e.runner.resetState(), [])
})

// Any other object is JSON as JSON.stringify writes it, a Date its ISO string, a class instance its
// own properties, and a key whose value is undefined left out; a function, a symbol or a BigInt is
// text, as String() writes it
test('a returned value is what JSON.stringify or String() makes of it', async (t) => {
  const e = env(t)
  /** The answer of a rule of its own, whose handler returns `expression` */
  const returning = (name: string, expression: string) => {
    setScript(e, `GET:/api/${name}`, `function handler(ctx) {\n  return ${expression}\n}\n`)
    return answer(e, { method: 'GET', host: 'x', path: `/api/${name}` })
  }
  const json = async (name: string, expression: string) => {
    const response = await returning(name, expression)
    assert.equal(response.headers['content-type'], 'application/json', name)
    return response.body.toString('utf8')
  }
  const text = async (name: string, expression: string) => {
    const response = await returning(name, expression)
    assert.match(response.headers['content-type'] ?? '', /^text\/plain/, name)
    return response.body.toString('utf8')
  }

  assert.equal(await json('date', 'new Date(0)'), '"1970-01-01T00:00:00.000Z"')
  assert.equal(await json('instance', 'new (class { constructor() { this.x = 1 } })()'), '{"x": 1}')
  assert.equal(await json('undefined', '{ a: 1, b: undefined }'), '{"a": 1}')
  assert.equal(await text('function', 'function named() {}'), 'function named() {}')
  assert.equal(await text('symbol', "Symbol('s')"), 'Symbol(s)')
  assert.equal(await text('bigint', '12345678901234567890n'), '12345678901234567890')
})

// A returned recording goes out as the script left it, a status or a header it
// changed changed and a body it made a string that string as JSON; given to ctx.reply with no
// status, it keeps the recorded one
test('a returned recording goes out as the script left it', async (t) => {
  const e = env(t)
  await record(e, [sample(1, { cards: [] }, { status: 201 })])
  const ask = (script: string) => {
    setScript(e, 'GET:/v5/suggestions', script)
    return answer(e, { method: 'GET', host: 'api.example.com', path: '/v5/suggestions' })
  }

  const edited = await ask(`function handler(ctx) {
  const rec = ctx.recorded()
  rec.status = 202
  rec.headers['x-edited'] = 'yes'
  rec.body = 'plain'
  return rec
}
`)
  assert.equal(edited.status, 202)
  assert.equal(edited.headers['x-edited'], 'yes')
  assert.equal(edited.headers['x-from'], 'backend')
  assert.equal(edited.body.toString('utf8'), '"plain"')

  const replied = await ask(`function handler(ctx) {
  return ctx.reply(ctx.recorded(), undefined, { 'x-added': '1' })
}
`)
  assert.equal(replied.status, 201)
  assert.equal(replied.headers['x-added'], '1')
  assert.deepEqual(payload(replied), { cards: [] })
})

// ctx.recordings takes the key and the session ctx.recorded takes
test('ctx.recordings takes a key and a session of its own', async (t) => {
  const e = env(t)
  await record(e, [sample(1, { page: 1 }), sample(2, { other: true }, { path: '/v5/other' })])
  await record(e, [sample(3, { account: 'b' })], 'acct_b')
  const script = `function handler(ctx) {
  const seqs = (recordings) => recordings.map((rec) => rec.seq)
  return {
    own: seqs(ctx.recordings()),
    key: seqs(ctx.recordings({ key: 'GET:api.example.com/v5/other' })),
    session: seqs(ctx.recordings({ session: 'acct_b' })),
  }
}
`
  setScript(e, 'GET:/v5/suggestions', script)

  const response = await answer(e, {
    method: 'GET',
    host: 'api.example.com',
    path: '/v5/suggestions',
  })

  assert.deepEqual(payload(response), { own: [1], key: [2], session: [3] })
})
