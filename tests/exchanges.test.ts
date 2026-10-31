// The exchange log: every request kept one by one, and the views over it.
//
// The point of this: the second call to an endpoint has its own query, its own
// body and its own answer. The tests drive the core the way the proxy port does,
// then read the log back through the admin API and through `tunnel requests`,
// because those are the two things anyone uses.
//
// After them, under "part by part", each part of the log is tested on its own.
import assert from 'node:assert/strict'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createAdminApp } from '../src/app.ts'
import { CertificateAuthority } from '../src/certs.ts'
import { Paths, TunnelConfigManager } from '../src/config.ts'
import { TunnelCore } from '../src/core.ts'
import { UserError, ValidationError } from '../src/errors.ts'
import {
  Broadcaster,
  ExchangeLog,
  MAX_BODY_BYTES,
  aggregate,
  bodyText,
  decodeBody,
  encodeBody,
  exchangeKey,
  exchangeSummary,
  makeExchange,
  makeExchangeRequest,
  makeExchangeResponse,
  parseExchange,
  redactHeaders,
  type AggregateRow,
  type BodyEncoding,
  type Exchange,
  type ExchangeFilters,
  type ExchangeSummary,
} from '../src/exchanges.ts'
import { isJsonObject, parseJson, type JsonObject, type JsonValue } from '../src/json.ts'
import { setLogSink } from '../src/log.ts'
import { makeRequest, makeResponse, type Request, type Response } from '../src/messages.ts'
import type { TunnelRequestConfig } from '../src/models.ts'
import { adminClient, type AdminClient } from './support/admin-env.ts'
import { cliRunner } from './support/cli.ts'
import { fakeUpstream, jsonAnswer } from './support/fake-upstream.ts'
import { captureLogs } from './support/logs.ts'
import { testRoutes } from './support/routes.ts'
import { tmpDir } from './support/tmp.ts'

// ---------------------------------------------------------------- env

// The env: a core with its log, the admin API over it, and `tunnel` pointed at both, all three the
// real ones. resolve is core.resolve, whose passthrough reaches a stand-in upstream rather than a
// network, and requests, getRequest and clearRequests go through the admin app, in process.

/** The query parameters of GET /__admin__/requests, written as they are sent: a flag is 1, as in
 *  `{ each: 1, since: 2, q_body: 1 }` */
interface RequestsParams {
  each?: 1
  key?: string
  host?: string
  since?: number
  last?: number
  unmatched?: 1
  encrypted?: 1
  q?: string
  q_body?: 1
}

/** What GET /__admin__/requests answers */
interface Listing<Row> {
  requests: Row[]
  last_seq: number
  unmatched_count: number
}

interface Env {
  manager: TunnelConfigManager
  /** core.exchanges */
  log: ExchangeLog
  /** core.resolve */
  resolve(request: Request): Promise<Response>
  /** One request through resolve, exactly as the proxy port asks it: GET / on api.example.com
   *  unless told otherwise */
  send(fields?: Partial<Request>): Promise<Response>
  /** GET /__admin__/requests: a row per request with each, the aggregate without */
  requests(params: RequestsParams & { each: 1 }): Promise<Listing<ExchangeSummary>>
  requests(params?: RequestsParams): Promise<Listing<AggregateRow>>
  /** GET /__admin__/requests/{seq}: the exchange in full */
  getRequest(seq: number): Promise<Exchange>
  /** POST /__admin__/requests/clear */
  clearRequests(): Promise<{ success: boolean; last_seq: number }>
  /** The admin app, through a client: for a status code */
  client: AdminClient
  /** A rule stored for key */
  configure(key: string, fields: Partial<Omit<TunnelRequestConfig, 'request_key'>>): void
  /** The tunnel command over this admin app, resolving with its exit code */
  run(...argv: string[]): Promise<number>
  /** What the command has printed since the last takeOutput(), taken away */
  takeOutput(): { out: string; err: string }
}

async function makeEnv(t: TestContext): Promise<Env> {
  // Added before tmpDir(t) adds the removal of the directory, so the log is closed, and its last
  // write done, before the directory goes: t.after hooks run in the order they were added. On
  // Node 22.18 a truncate still in flight failed the removal with ENOTEMPTY
  let opened: TunnelCore | undefined
  t.after(() => opened?.close())
  const dir = tmpDir(t)
  const manager = new TunnelConfigManager(Paths.inOneDirectory(dir))
  // Nothing here may reach a network: passthrough, which answers anything with no rule, goes to a
  // stand-in that reports the URL it was given
  const core = new TunnelCore(manager, {
    upstream: fakeUpstream((request) => jsonAnswer({ upstream: request.url }, 200)),
    routes: testRoutes(),
  })
  opened = core
  const app = createAdminApp({ manager, core, ca: new CertificateAuthority(manager.paths) })
  const client = adminClient(app)
  // The command over the same app, run in the env's directory
  const cli = cliRunner({ fetch: (url, init) => app.request(url, init), cwd: dir })

  const resolve = (request: Request): Promise<Response> => core.resolve(request)
  const requests = async (params: RequestsParams = {}) =>
    (await client.get('/__admin__/requests', { params: { ...params } })).json()
  return {
    manager,
    log: core.exchanges,
    resolve,
    send: (fields) =>
      resolve(makeRequest({ method: 'GET', path: '/', host: 'api.example.com', ...fields })),
    requests: requests as Env['requests'],
    getRequest: async (seq) => (await client.get(`/__admin__/requests/${seq}`)).json(),
    clearRequests: async () => (await client.post('/__admin__/requests/clear')).json(),
    client,
    configure: (key, fields) => {
      manager.updateRequestConfig(key, fields)
    },
    run: cli.run,
    takeOutput: cli.takeOutput,
  }
}

/** The seq of every line in the log file, oldest first; a blank line is not one */
function seqsWritten(env: Env): number[] {
  return readFileSync(env.manager.paths.exchangesFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const entry = parseJson(line)
      assert.ok(isJsonObject(entry) && typeof entry.seq === 'number', line)
      return entry.seq
    })
}

// ---------------------------------------------------------------- what is kept

test('every call is kept with its own query and body', async (t) => {
  const env = await makeEnv(t)
  env.configure('POST:/api/search', { mode: 'json', json_response: { ok: 1 } })

  await env.send({
    method: 'POST',
    path: '/api/search',
    query: { page: '1' },
    body: Buffer.from('{"term": "a"}'),
  })
  await env.send({
    method: 'POST',
    path: '/api/search',
    query: { page: '2' },
    body: Buffer.from('{"term": "b"}'),
  })

  const rows = (await env.requests({ each: 1 })).requests
  assert.deepEqual(
    rows.map((row) => row.query),
    [{ page: '1' }, { page: '2' }],
  )
  assert.deepEqual(
    rows.map((row) => row.seq),
    [1, 2],
  )

  const second = (await env.client.get(`/__admin__/requests/${rows[1]?.seq}`)).json()
  assert.deepEqual(second.request.body, { term: 'b' })
  assert.equal(second.request.body_encoding, 'json')
  assert.equal(second.request.url, 'http://api.example.com/api/search?page=2')
  assert.deepEqual(second.response.body, { ok: 1 })
  assert.ok(second.response.elapsed_ms >= 0)
})

test('the rule that answered is recorded with the request', async (t) => {
  const env = await makeEnv(t)
  env.configure('GET:/api/feed', { mode: 'json', json_response: { v: 1 } })

  await env.send({ path: '/api/feed' })
  await env.send({ path: '/api/other' })

  // Exactly two rows, one for each name below
  const rows = (await env.requests({ each: 1 })).requests
  assert.equal(rows.length, 2)
  const [matched, unmatched] = rows
  // A wildcard host rule reports itself, not the key the request came in under
  assert.deepEqual(
    [matched?.key, matched?.matched_by, matched?.mode],
    ['GET:api.example.com/api/feed', 'GET:/api/feed', 'json'],
  )
  assert.deepEqual([unmatched?.matched_by, unmatched?.mode], [null, 'passthrough'])
})

test('an unknown seq is a 404', async (t) => {
  const env = await makeEnv(t)
  assert.equal((await env.client.get('/__admin__/requests/99')).status, 404)
})

// ---------------------------------------------------------------- bodies

// JSON stays an object so a script can edit it; bytes have to be encoded
test('a body is kept as JSON text or base64', () => {
  assert.deepEqual(encodeBody(Buffer.from('{"a": 1}')), {
    body: { a: 1 },
    body_encoding: 'json',
    truncated: false,
  })
  assert.deepEqual(encodeBody(Buffer.from('héllo', 'utf8')), {
    body: 'héllo',
    body_encoding: 'text',
    truncated: false,
  })

  const raw = Buffer.from('\x89PNG\r\n\x1a\n\x00\xff', 'latin1')
  const { body, body_encoding, truncated } = encodeBody(raw)
  assert.equal(typeof body, 'string')
  assert.deepEqual(
    [Buffer.from(body as string, 'base64'), body_encoding, truncated],
    [raw, 'base64', false],
  )

  assert.deepEqual(encodeBody(Buffer.alloc(0)), {
    body: null,
    body_encoding: null,
    truncated: false,
  })
})

test('a body over the cap is cut and says so', () => {
  const { body, body_encoding, truncated } = encodeBody(Buffer.alloc(MAX_BODY_BYTES + 10, 'x'))

  assert.equal(typeof body, 'string')
  assert.deepEqual(
    [(body as string).length, body_encoding, truncated],
    [MAX_BODY_BYTES, 'text', true],
  )
  // Half an object is not the object it claimed to be, so it is never offered
  // as JSON once it has been cut
  const { body_encoding: cutEncoding } = encodeBody(
    Buffer.concat([Buffer.from('{"a": "'), Buffer.alloc(MAX_BODY_BYTES, 'x'), Buffer.from('"}')]),
  )
  assert.notEqual(cutEncoding, 'json')
})

test('a long body marks the exchange as truncated', async (t) => {
  const env = await makeEnv(t)
  await env.send({
    method: 'POST',
    path: '/api/upload',
    body: Buffer.alloc(MAX_BODY_BYTES + 1, 'x'),
  })

  assert.equal(env.log.all().at(-1)?.truncated, true)
  assert.equal((await env.requests({ each: 1 })).requests.at(-1)?.truncated, true)
})

// Logging is not worth a dropped request: a body too deep to write out is
// kept as text if it can be, and otherwise not kept at all.
test('a body nothing can encode never costs the client its answer', async (t) => {
  const env = await makeEnv(t)
  // Too deep to keep as JSON
  const deep = Buffer.from('['.repeat(5000) + ']'.repeat(5000))
  // Deeper still: not even the parser reaches the bottom of it
  assert.equal(
    encodeBody(Buffer.from('['.repeat(200000) + ']'.repeat(200000))).body_encoding,
    'text',
  )

  const answer = await env.send({ method: 'POST', path: '/api/deep', body: deep })

  assert.equal(answer.status, 200)
  // Whatever the log could keep of it, the log itself stays readable and goes
  // on recording what comes next
  assert.equal((await env.client.get('/__admin__/requests', { params: { each: 1 } })).status, 200)
  await env.send({ path: '/api/feed' })
  assert.equal((await env.requests({ each: 1 })).requests.at(-1)?.path, '/api/feed')
})

// The body was decompressed before we saw it; its length and framing move on
test('response headers lose what described the bytes on the wire', async (t) => {
  const env = await makeEnv(t)
  env.log.recordHttp(
    makeRequest({ method: 'GET', host: 'api.example.com', path: '/api/feed' }),
    makeResponse({
      status: 200,
      body: Buffer.from('{}'),
      headers: {
        'content-type': 'application/json',
        'content-length': '2',
        'content-encoding': 'gzip',
        'transfer-encoding': 'chunked',
      },
    }),
    { elapsed_ms: 1 },
  )

  const headers = (await env.getRequest(1)).response?.headers
  assert.deepEqual(headers, { 'content-type': 'application/json' })
})

// The panel's Size column, counted where the bytes still are
test('a row carries the size of what went back', async (t) => {
  const env = await makeEnv(t)
  env.log.recordHttp(
    makeRequest({ method: 'GET', host: 'api.example.com', path: '/api/feed' }),
    makeResponse({ status: 200, body: Buffer.from('{"a": 1}') }),
    { elapsed_ms: 1 },
  )
  env.log.recordConnect('pinned.example.com', 443, '127.0.0.1', 120, 4096)

  // Exactly two rows, one for each name below
  const rows = (await env.requests({ each: 1 })).requests
  assert.equal(rows.length, 2)
  const [answered, tunnelled] = rows
  assert.equal(answered?.size, 8)
  // Nothing was read of the tunnel, so its size is what crossed it either way
  assert.equal(tunnelled?.size, 4216)
})

// ---------------------------------------------------------------- the ring buffer

test('the buffer keeps the newest and the seq keeps climbing', async (t) => {
  const env = await makeEnv(t)
  env.manager.updateConfig({ max_requests_history: 3 })

  for (let number = 0; number < 5; number++) await env.send({ path: `/api/${number}` })

  const data = await env.requests({ each: 1 })
  assert.deepEqual(
    data.requests.map((row) => row.path),
    ['/api/2', '/api/3', '/api/4'],
  )
  assert.equal(data.last_seq, 5)
})

// `firstSeq` is `lastSeq + 1` when nothing is held, not null and not 0.
//
// It reads as "the next one will be this number, so I hold nothing", which is
// what lets a consumer throw away everything below `firstSeq` without a
// special case for the empty log.
test('an empty log says its window starts after the last_seq', async (t) => {
  const env = await makeEnv(t)
  assert.deepEqual([env.log.firstSeq, env.log.lastSeq], [1, 0])
})

test('the window starts at the oldest entry still held', async (t) => {
  const env = await makeEnv(t)
  for (let number = 0; number < 3; number++) await env.send({ path: `/api/${number}` })

  assert.deepEqual([env.log.firstSeq, env.log.lastSeq], [1, 3])
})

test('the window moves forward as the buffer drops the oldest', async (t) => {
  const env = await makeEnv(t)
  env.manager.updateConfig({ max_requests_history: 3 })

  for (let number = 0; number < 5; number++) await env.send({ path: `/api/${number}` })

  // Seqs 1 and 2 were pushed out, so the window is the three that are left
  assert.deepEqual([env.log.firstSeq, env.log.lastSeq], [3, 5])
  assert.deepEqual(
    env.log.all().map((exchange) => exchange.seq),
    [3, 4, 5],
  )
})

test('clearing puts the window back past the last_seq', async (t) => {
  const env = await makeEnv(t)
  await env.send({ path: '/api/a' })
  await env.send({ path: '/api/b' })

  env.log.clear()

  // The counter is untouched, so the window is empty rather than reset
  assert.deepEqual([env.log.firstSeq, env.log.lastSeq], [3, 2])
})

// A restart must not hand out a seq that is already in the file
test('the seq continues where the log file left off', async (t) => {
  const manager = new TunnelConfigManager(Paths.inOneDirectory(tmpDir(t)))
  const log = new ExchangeLog(manager)
  log.recordConnect('api.example.com', 443, '127.0.0.1', 1, 2)
  log.recordConnect('api.example.com', 443, '127.0.0.1', 3, 4)
  await log.flush()
  await log.close()

  const again = new ExchangeLog(manager)
  try {
    assert.deepEqual(
      again.all().map((exchange) => exchange.seq),
      [1, 2],
    )
    assert.equal(again.lastSeq, 2)
    assert.equal(again.recordConnect('api.example.com', 443, '127.0.0.1', 5, 6)?.seq, 3)
  } finally {
    await again.close()
  }
})

test('clearing says where it stopped and the count carries on', async (t) => {
  const env = await makeEnv(t)
  await env.send({ path: '/api/a' })
  await env.send({ path: '/api/b' })

  const cleared = await env.clearRequests()

  assert.equal(cleared.last_seq, 2)
  assert.deepEqual((await env.requests()).requests, [])
  await env.send({ path: '/api/c' })
  assert.deepEqual(
    (await env.requests({ each: 1 })).requests.map((row) => row.seq),
    [3],
  )

  // The file was emptied too, so a restart reads back only what came after
  await env.log.flush()
  const written = readFileSync(env.manager.paths.exchangesFile, 'utf8')
    .replace(/\n$/, '')
    .split('\n')
  assert.deepEqual(
    written.map((line) => JSON.parse(line).seq),
    [3],
  )
})

// ---------------------------------------------------------------- filtering

test('since and last page through the log', async (t) => {
  const env = await makeEnv(t)
  for (let number = 0; number < 4; number++) await env.send({ path: `/api/${number}` })

  const after = (await env.requests({ each: 1, since: 2 })).requests
  const tail = (await env.requests({ each: 1, last: 1 })).requests

  assert.deepEqual(
    after.map((row) => row.seq),
    [3, 4],
  )
  assert.deepEqual(
    tail.map((row) => row.path),
    ['/api/3'],
  )
})

test('key and host select the way a rule would', async (t) => {
  const env = await makeEnv(t)
  await env.send({ path: '/api/feed', host: 'api.example.com' })
  await env.send({ path: '/api/feed', host: 'other.example.com' })
  await env.send({ path: '/api/other', host: 'api.example.com' })

  // A key with no host answers for every host, and selects the same way
  const anyHost = (await env.requests({ each: 1, key: 'GET:/api/feed' })).requests
  const oneHost = (await env.requests({ each: 1, key: 'GET:api.example.com/api/feed' })).requests
  const wildcard = (await env.requests({ each: 1, host: '*.example.com' })).requests

  assert.deepEqual(
    anyHost.map((row) => row.host),
    ['api.example.com', 'other.example.com'],
  )
  assert.deepEqual(
    oneHost.map((row) => row.seq),
    [1],
  )
  assert.equal(wildcard.length, 3)
  assert.equal(
    (await env.client.get('/__admin__/requests', { params: { key: 'nonsense' } })).status,
    400,
  )
})

test('a keyword matches host, path, query, status and rule', async (t) => {
  const env = await makeEnv(t)
  env.configure('GET:/api/feed', {
    mode: 'json',
    json_response: { secret: 'in the body' },
    status_code: 201,
  })
  await env.send({ path: '/api/feed', query: { page: '7' } })
  await env.send({ path: '/api/other', host: 'cdn.example.com' })

  const seqs = async (params: RequestsParams) =>
    (await env.requests({ ...params, each: 1 })).requests.map((row) => row.seq)

  assert.deepEqual(await seqs({ q: 'cdn' }), [2])
  assert.deepEqual(await seqs({ q: '/api/feed' }), [1])
  assert.deepEqual(await seqs({ q: 'page=7' }), [1])
  assert.deepEqual(await seqs({ q: '201' }), [1])
  assert.deepEqual(await seqs({ q: 'GET:/api/feed' }), [1])
  // The body is only searched when asked for: it is the expensive half
  assert.deepEqual(await seqs({ q: 'in the body' }), [])
  assert.deepEqual(await seqs({ q: 'in the body', q_body: 1 }), [1])
})

// The seam replay uses: an entry that nothing was configured for
test('unmatched entries are counted and can be listed alone', async (t) => {
  const env = await makeEnv(t)
  await env.send({ path: '/api/feed' })
  env.log.recordHttp(
    makeRequest({ method: 'GET', host: 'api.example.com', path: '/api/gone' }),
    makeResponse({ status: 404 }),
    { elapsed_ms: 1, unmatched: true },
  )

  const everything = await env.requests({ each: 1 })
  const onlyUnmatched = (await env.requests({ each: 1, unmatched: 1 })).requests

  assert.equal(everything.unmatched_count, 1)
  assert.deepEqual(
    onlyUnmatched.map((row) => row.path),
    ['/api/gone'],
  )
})

// ---------------------------------------------------------------- CONNECT rows

test('a tunnel nobody decrypted is its own kind of row', async (t) => {
  const env = await makeEnv(t)
  await env.send({ path: '/api/feed' })
  env.log.recordConnect('secure.example.com', 443, '192.168.1.23', 1200, 3400)

  const encrypted = (await env.requests({ each: 1, encrypted: 1 })).requests
  const row = encrypted[0]

  assert.equal(encrypted.length, 1)
  assert.deepEqual([row?.kind, row?.host, row?.port], ['connect', 'secure.example.com', 443])
  assert.deepEqual([row?.bytes_up, row?.bytes_down], [1200, 3400])
  assert.deepEqual([row?.status, row?.client], [null, '192.168.1.23'])
  // It aggregates under a key of its own, so the panel can show it as a row
  const keys = (await env.requests()).requests.map((entry) => entry.key)
  assert.ok(keys.includes('CONNECT:secure.example.com:443'), String(keys))
})

// ---------------------------------------------------------------- the aggregate

test('the aggregate counts calls and reports the last answer', async (t) => {
  const env = await makeEnv(t)
  env.configure('GET:/api/feed', { mode: 'json', json_response: { v: 1 }, status_code: 201 })
  await env.send({ path: '/api/feed' })
  await env.send({ path: '/api/feed' })
  await env.send({ path: '/api/other' })

  const data = await env.requests()
  const byKey = new Map(data.requests.map((row) => [row.key, row]))

  assert.equal(data.last_seq, 3)
  assert.equal(data.unmatched_count, 0)
  const feed = byKey.get('GET:api.example.com/api/feed')
  assert.deepEqual([feed?.request_count, feed?.status, feed?.mode], [2, 201, 'json'])
  assert.deepEqual([feed?.matched_by, feed?.configured], ['GET:/api/feed', true])
  assert.equal(byKey.get('GET:api.example.com/api/other')?.configured, false)
})

test('recording can be switched off', async (t) => {
  const env = await makeEnv(t)
  env.manager.updateConfig({ auto_record_requests: false })

  await env.send({ path: '/api/feed' })

  assert.deepEqual((await env.requests()).requests, [])
})

// ---------------------------------------------------------------- watching

// What the SSE endpoint subscribes to
test('every new exchange reaches a watcher', async (t) => {
  const env = await makeEnv(t)
  const subscription = env.log.broadcaster.subscribe()
  await env.resolve(makeRequest({ method: 'GET', host: 'api.example.com', path: '/api/feed' }))
  const exchange = await subscription.next(2000)

  assert.ok(typeof exchange === 'object' && exchange !== null, String(exchange))
  assert.equal(exchangeKey(exchange), 'GET:api.example.com/api/feed')
  assert.equal(env.log.broadcaster.subscribers, 1)
})

// null is how the broadcaster says the window moved but nothing arrived
test('a change with no new exchange reaches every watcher as none', async (t) => {
  const env = await makeEnv(t)
  const subscriptions = [env.log.broadcaster.subscribe(), env.log.broadcaster.subscribe()]
  env.log.broadcaster.publishChange()

  const entries = []
  for (const subscription of subscriptions) entries.push(await subscription.next(2000))
  assert.deepEqual(entries, [null, null])
})

// A clear is the one window move that no arriving exchange will announce
test('clearing tells the watchers at once', async (t) => {
  const env = await makeEnv(t)
  const subscription = env.log.broadcaster.subscribe()
  env.log.clear()

  assert.equal(await subscription.next(2000), null)
})

// ---------------------------------------------------------------- the CLI

test('tunnel requests prints the aggregate and each', async (t) => {
  const env = await makeEnv(t)
  env.configure('GET:/api/feed', { mode: 'json', json_response: { v: 1 } })
  await env.send({ path: '/api/feed', query: { page: '2' } })
  await env.send({ path: '/api/feed' })

  assert.equal(await env.run('requests'), 0)
  const aggregated = env.takeOutput().out
  assert.equal(await env.run('requests', '--each'), 0)
  const each = env.takeOutput().out

  assert.ok(aggregated.includes('2x') && aggregated.includes('GET:api.example.com/api/feed'))
  assert.ok(aggregated.includes('[GET:/api/feed]'))
  assert.ok(each.includes('http://api.example.com/api/feed?page=2'))
  assert.equal(each.split('\n')[0]!.trim().split(/\s+/)[0], '1')
})

test('tunnel requests passes its filters to the server', async (t) => {
  const env = await makeEnv(t)
  await env.send({ path: '/api/feed', host: 'api.example.com' })
  await env.send({ path: '/api/other', host: 'cdn.example.com' })

  assert.equal(await env.run('requests', '--each', '--host', 'cdn.example.com'), 0)
  const printed = env.takeOutput().out

  assert.ok(printed.includes('cdn.example.com') && !printed.includes('api.example.com/api/feed'))
})

test('tunnel requests show hides the headers that carry a session', async (t) => {
  const env = await makeEnv(t)
  await env.send({
    path: '/api/feed',
    headers: { authorization: 'Bearer secret-token', 'user-agent': 'ExampleApp/1.0' },
  })

  assert.equal(await env.run('requests', 'show', '1'), 0)
  const redacted = env.takeOutput().out
  assert.equal(await env.run('requests', 'show', '1', '--raw'), 0)
  const raw = env.takeOutput().out

  assert.ok(redacted.includes('[REDACTED]') && !redacted.includes('secret-token'))
  assert.ok(redacted.includes('ExampleApp/1.0')) // only the listed names are hidden
  assert.ok(raw.includes('secret-token'))

  // What is on disk stays as it arrived, or a recording would not replay
  await env.log.flush()
  assert.ok(readFileSync(env.manager.paths.exchangesFile, 'utf8').includes('secret-token'))
})

test('the redaction list is configurable', async (t) => {
  const env = await makeEnv(t)
  env.manager.updateConfig({ redact_headers: ['user-agent'] })
  await env.send({
    path: '/api/feed',
    headers: { authorization: 'Bearer secret-token', 'user-agent': 'ExampleApp/1.0' },
  })

  await env.run('requests', 'show', '1')

  let printed = env.takeOutput().out
  assert.ok(!printed.includes('ExampleApp/1.0') && printed.includes('Bearer secret-token'))

  // An empty list is a choice, not a missing setting: it hides nothing
  env.manager.updateConfig({ redact_headers: [] })
  await env.run('requests', 'show', '1')

  printed = env.takeOutput().out
  assert.ok(printed.includes('ExampleApp/1.0') && printed.includes('Bearer secret-token'))
})

test('tunnel requests show prints the bodies as JSON', async (t) => {
  const env = await makeEnv(t)
  env.configure('POST:/api/pay', { mode: 'json', json_response: { paid: true } })
  await env.send({ method: 'POST', path: '/api/pay', body: Buffer.from('{"amount": 12}') })

  await env.run('requests', 'show', '1')

  const printed = env.takeOutput().out
  assert.ok(printed.includes('"amount": 12') && printed.includes('"paid": true'))
  assert.ok(printed.includes('response 200'))
})

test('tunnel requests --json is the raw payload', async (t) => {
  const env = await makeEnv(t)
  await env.send({ path: '/api/feed' })

  await env.run('requests', '--each', '--json')

  const data = JSON.parse(env.takeOutput().out)
  assert.equal(data.last_seq, 1)
  assert.equal(data.requests[0].path, '/api/feed')
})

// ---------------------------------------------------------------- part by part

// The golden file tests/fixtures/requests/requests.jsonl: five exchanges, then a line without kind,
// size and most other fields, a blank line and a line written halfway; loaded.json, beside it,
// holds the exchanges, summaries and aggregate the log reads back from it
test('requests.jsonl reads back as the exchanges, summaries and aggregate loaded.json holds', async (t) => {
  const { records } = captureLogs(t)
  const manager = new TunnelConfigManager(Paths.inOneDirectory(tmpDir(t)))
  const file = manager.paths.exchangesFile
  copyFileSync(new URL('./fixtures/requests/requests.jsonl', import.meta.url), file)
  const log = new ExchangeLog(manager)

  // parseJson: an exchange holds 12345678901234567890
  const loaded = parseJson(
    readFileSync(new URL('./fixtures/requests/loaded.json', import.meta.url), 'utf8'),
  ) as { exchanges: JsonValue[]; summaries: JsonValue[]; aggregate: JsonValue[] }
  // The five exchanges and the line without kind and size, which reads with the defaults for what
  // it lacks
  assert.deepEqual(
    log.all().map((exchange) => exchange.seq),
    [1, 2, 3, 4, 5, 6],
  )
  // Compared as strings, so the keys must come in the same order too
  assert.equal(JSON.stringify(log.all()), JSON.stringify(loaded.exchanges))
  assert.equal(JSON.stringify(log.all().map(exchangeSummary)), JSON.stringify(loaded.summaries))
  assert.equal(JSON.stringify(aggregate(log.all())), JSON.stringify(loaded.aggregate))
  assert.equal(log.firstSeq, 1)
  // The line written halfway starts {"seq": 7, and that 7 counts even though the line cannot be
  // read, so a restart does not hand 7 out a second time: 7, not the last_seq of 6 in loaded.json
  assert.equal(log.lastSeq, 7)

  // The one warning is the line written halfway's: the blank line is passed over without a word
  const warnings = records.filter((record) => record.level === 'warning')
  assert.equal(warnings.length, 1)
  assert.ok(
    warnings[0]?.message.startsWith(`Skipping an unreadable line in ${file}: `),
    warnings[0]?.message,
  )

  assert.equal(log.recordConnect('pinned.example.com', 443, '127.0.0.1', 1, 2)?.seq, 8)
  await log.close()
})

// Compact, where the golden requests.jsonl has a space after each ',' and ':', which reads back the
// same; the keys in the order the golden loaded.json has them
test('the log file is one compact JSON object a line, each line ending in a newline, its keys in the order loaded.json has them', async (t) => {
  const env = await makeEnv(t)
  env.log.recordHttp(
    makeRequest({
      method: 'POST',
      scheme: 'https',
      host: 'api.example.com',
      path: '/v5/search',
      query: { page: '2' },
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{"term": "é", "id": 12345678901234567890}'),
    }),
    makeResponse({
      status: 201,
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from('{"ok": 1}'),
    }),
    { elapsed_ms: 12, matched_by: 'POST:/v5/search', mode: 'json' },
  )
  env.log.recordConnect('pinned.example.com', 443, '192.168.1.23', 1200, 3400)
  await env.log.flush()

  const written = readFileSync(env.manager.paths.exchangesFile, 'utf8')
  assert.ok(written.endsWith('\n'), written)
  const lines = written.slice(0, -1).split('\n')
  assert.equal(lines.length, 2)
  for (const line of lines) {
    assert.ok(isJsonObject(parseJson(line)), line)
    assert.equal(line, JSON.stringify(parseJson(line)))
  }

  // The first exchange in loaded.json, to hold the order of the keys to
  const loaded = parseJson(
    readFileSync(new URL('./fixtures/requests/loaded.json', import.meta.url), 'utf8'),
  ) as { exchanges: JsonObject[] }
  const golden = loaded.exchanges[0]
  assert.ok(golden && isJsonObject(golden.request) && isJsonObject(golden.response))
  const [http, connect] = lines.map((line) => parseJson(line) as JsonObject)
  assert.ok(http && isJsonObject(http.request) && isJsonObject(http.response))
  assert.deepEqual(Object.keys(http), Object.keys(golden))
  assert.deepEqual(Object.keys(http.request), Object.keys(golden.request))
  assert.deepEqual(Object.keys(http.response), Object.keys(golden.response))
  assert.deepEqual(Object.keys(connect ?? {}), Object.keys(golden))
})

// The local time, to the millisecond, with no zone, unlike toISOString(). The CLI cuts
// time.slice(11, 23) and last_seen.slice(0, 19) out of it
test('time is the local time to the millisecond, with no zone', async (t) => {
  const zone = process.env.TZ
  // Deleted if it was not there: assigning undefined would leave the string "undefined"
  t.after(() => {
    if (zone === undefined) delete process.env.TZ
    else process.env.TZ = zone
  })
  // 01:30:00.007 UTC on 11 October 2026
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 11, 1, 30, 0, 7) })
  const env = await makeEnv(t)

  process.env.TZ = 'Asia/Shanghai'
  assert.equal(
    env.log.recordConnect('a.example.com', 443, '', 0, 0)?.time,
    '2026-10-11T09:30:00.007',
  )
  process.env.TZ = 'America/Los_Angeles'
  assert.equal(
    env.log.recordConnect('a.example.com', 443, '', 0, 0)?.time,
    '2026-10-10T18:30:00.007',
  )
})

/** A row of bodies.json: what encodeBody, decodeBody and bodyText make of raw */
type BodyRow = {
  raw: string // base64
  body: JsonValue
  body_encoding: string | null
  truncated: boolean
  decoded: string // base64 of decodeBody(body, body_encoding)
  text: string // bodyText(body, body_encoding)
}

test('encodeBody, decodeBody and bodyText give what bodies.json holds for every body in it', () => {
  // parseJson: one of the bodies holds 12345678901234567890
  const rows = parseJson(
    readFileSync(new URL('./fixtures/requests/bodies.json', import.meta.url), 'utf8'),
  ) as BodyRow[]
  // So that a file read as empty, or cut short, cannot pass
  assert.equal(rows.length, 19)
  for (const row of rows) {
    const encoded = encodeBody(Buffer.from(row.raw, 'base64'))
    // Compared as JSON text, so that the order of the keys counts and a RawJson is its digits
    assert.equal(
      JSON.stringify(encoded),
      JSON.stringify({
        body: row.body,
        body_encoding: row.body_encoding,
        truncated: row.truncated,
      }),
      row.raw,
    )
    assert.deepEqual(
      decodeBody(encoded.body, encoded.body_encoding),
      Buffer.from(row.decoded, 'base64'),
      row.raw,
    )
    assert.equal(bodyText(encoded.body, encoded.body_encoding), row.text, row.raw)
  }
})

// Only UTF-8 is read as JSON, and only JSON that JSON.parse reads, with no NaN: each of these four
// is kept as text or base64, and replay sends back every byte that came.
test('a body that is JSON in UTF-16, with a NaN or in CESU-8 is kept as text or base64, bytes and all', () => {
  const BOM = String.fromCharCode(0xfeff)
  const bodies: [Buffer, BodyEncoding][] = [
    // UTF-16 with its BOM: 0xff 0xfe is not UTF-8
    [Buffer.from(`${BOM}{"a": 1}`, 'utf16le'), 'base64'],
    // ASCII in UTF-16LE happens to be UTF-8, a NUL after every character
    [Buffer.from('{"a":1}', 'utf16le'), 'text'],
    // JSON.parse knows no NaN
    [Buffer.from('{"a": NaN}'), 'text'],
    // A surrogate written out as UTF-8 (CESU-8) is not UTF-8
    [Buffer.from([0x22, 0xed, 0xa0, 0x80, 0x22]), 'base64'],
  ]
  for (const [raw, encoding] of bodies) {
    const encoded = encodeBody(raw)
    assert.equal(encoded.body_encoding, encoding, raw.toString('hex'))
    assert.equal(encoded.truncated, false, raw.toString('hex'))
    assert.deepEqual(decodeBody(encoded.body, encoded.body_encoding), raw, raw.toString('hex'))
  }
})

test('a body of exactly MAX_BODY_BYTES is kept whole, a byte more is cut, and a cut inside a character makes it base64', () => {
  const whole = encodeBody(Buffer.alloc(MAX_BODY_BYTES, 'x'))
  assert.deepEqual(
    [(whole.body as string).length, whole.body_encoding, whole.truncated],
    [MAX_BODY_BYTES, 'text', false],
  )

  const over = encodeBody(Buffer.alloc(MAX_BODY_BYTES + 1, 'x'))
  assert.deepEqual(
    [(over.body as string).length, over.body_encoding, over.truncated],
    [MAX_BODY_BYTES, 'text', true],
  )

  // 3 MiB of a character three bytes long. 2 MiB is not a multiple of 3, so the cut
  // keeps the first two bytes of one, and what is kept is not UTF-8.
  const euros = Buffer.from('€'.repeat(MAX_BODY_BYTES / 2))
  const cut = encodeBody(euros)
  assert.deepEqual([cut.body_encoding, cut.truncated], ['base64', true])
  assert.deepEqual(decodeBody(cut.body, cut.body_encoding), euros.subarray(0, MAX_BODY_BYTES))
})

test('a body that was JSON null is put back as null', () => {
  assert.deepEqual(encodeBody(Buffer.from('null')), {
    body: null,
    body_encoding: 'json',
    truncated: false,
  })
  for (const body of [null, undefined]) {
    assert.deepEqual(decodeBody(body, 'json'), Buffer.from('null'))
    assert.equal(bodyText(body, 'json'), 'null')
    // Under any other encoding, or none, no body is no bytes
    for (const encoding of [null, undefined, 'text']) {
      assert.deepEqual(decodeBody(body, encoding), Buffer.alloc(0))
      assert.equal(bodyText(body, encoding), '')
    }
  }
})

test("decodeBody and bodyText write JSON with ', ' and ': ' separators, and leave base64 as it is stored", () => {
  const body = parseJson('{"a":[1,{"b":null}],"c":"x, y: z","id":12345678901234567890}')
  const written = '{"a": [1, {"b": null}], "c": "x, y: z", "id": 12345678901234567890}'
  assert.equal(bodyText(body, 'json'), written)
  assert.deepEqual(decodeBody(body, 'json'), Buffer.from(written))

  assert.equal(bodyText('iVBORw0KGgoA/w==', 'base64'), 'iVBORw0KGgoA/w==')
  assert.deepEqual(
    decodeBody('iVBORw0KGgoA/w==', 'base64'),
    Buffer.from('\x89PNG\r\n\x1a\n\x00\xff', 'latin1'),
  )

  // A body that is not a string under any other encoding can only come from data edited
  // by hand. String() throws on a RawJson, so it is written as JSON.
  const id = parseJson('12345678901234567890')
  assert.equal(bodyText(id, 'text'), '12345678901234567890')
  assert.deepEqual(decodeBody(id, 'text'), Buffer.from('12345678901234567890'))
  assert.equal(bodyText({ a: [1, 2] }, null), '{"a": [1, 2]}')
})

test('redactHeaders hides the headers named, whatever their case, and keeps every name as it was spelt and where it was', () => {
  // Parsed rather than written as a literal, where "__proto__" would set the prototype
  const headers: Record<string, string> = JSON.parse(
    '{"Authorization": "Bearer abc", "x-trace": "1", "COOKIE": "session=1", "__proto__": "x"}',
  )
  const given = Object.entries(headers)

  const redacted = redactHeaders(headers, ['authorization', 'Cookie', 'x-absent'])
  assert.deepEqual(Object.entries(redacted), [
    ['Authorization', '[REDACTED]'],
    ['x-trace', '1'],
    ['COOKIE', '[REDACTED]'],
    ['__proto__', 'x'],
  ])
  // An empty list hides nothing
  const shown = redactHeaders(headers, [])
  assert.deepEqual(Object.entries(shown), given)
  // Always a new object; the headers given are left as they were
  assert.notEqual(redacted, headers)
  assert.notEqual(shown, headers)
  assert.deepEqual(Object.entries(headers), given)
})

test('recordHttp keeps a copy of the request with its port and url worked out, and the response without the headers that described the wire', async (t) => {
  const env = await makeEnv(t)
  const request = makeRequest({
    method: 'GET',
    scheme: 'https',
    host: 'api.example.com',
    port: null,
    path: '/v5/x',
    query: { page: '2', q: 'a b' },
    headers: { authorization: 'Bearer secret-token', 'user-agent': 'ExampleApp/1.0' },
  })
  const exchange = env.log.recordHttp(
    request,
    makeResponse({
      headers: {
        'Content-Length': String(MAX_BODY_BYTES + 10),
        'CONTENT-ENCODING': 'gzip',
        'transfer-Encoding': 'chunked',
        'X-Kept': 'yes',
      },
      body: Buffer.alloc(MAX_BODY_BYTES + 10, 'x'),
    }),
    { elapsed_ms: 3 },
  )
  assert.ok(exchange)

  // Whatever the case they come in; the one kept keeps its spelling
  assert.deepEqual(exchange.response?.headers, { 'X-Kept': 'yes' })
  // What the client got, the part cut off included
  assert.equal(exchange.response?.size, MAX_BODY_BYTES + 10)
  assert.equal(exchange.truncated, true)
  assert.equal(exchange.request.port, 443)
  assert.equal(exchange.request.url, 'https://api.example.com/v5/x?page=2&q=a+b')

  // A copy: the request changed afterwards leaves the log as it was
  request.query.page = '3'
  request.headers.authorization = 'changed'
  assert.deepEqual(env.log.get(1)?.request.query, { page: '2', q: 'a b' })
  assert.deepEqual(env.log.get(1)?.request.headers, {
    authorization: 'Bearer secret-token',
    'user-agent': 'ExampleApp/1.0',
  })

  // The file keeps the real value; only what prints it hides it (redactHeaders)
  await env.log.flush()
  assert.ok(readFileSync(env.manager.paths.exchangesFile, 'utf8').includes('Bearer secret-token'))
})

test('with auto_record_requests off nothing is recorded, kept, written or sent, and no seq is spent', async (t) => {
  const env = await makeEnv(t)
  env.manager.updateConfig({ auto_record_requests: false })
  const subscription = env.log.broadcaster.subscribe()

  assert.equal(env.log.recordHttp(makeRequest(), makeResponse(), { elapsed_ms: 0 }), null)
  assert.equal(env.log.recordConnect('pinned.example.com', 443, '127.0.0.1', 1, 2), null)

  assert.deepEqual(env.log.all(), [])
  assert.equal(env.log.lastSeq, 0)
  assert.equal(await subscription.next(20), 'timeout')
  await env.log.flush()
  assert.ok(!existsSync(env.manager.paths.exchangesFile))

  // Switched back on, the count starts where it would have
  env.manager.updateConfig({ auto_record_requests: true })
  assert.equal(env.log.recordConnect('pinned.example.com', 443, '127.0.0.1', 1, 2)?.seq, 1)
})

test('the log holds max(1, max_requests_history) entries, and a new size takes hold when the next exchange arrives', async (t) => {
  const env = await makeEnv(t)
  const seqs = () => env.log.all().map((exchange) => exchange.seq)

  // 0, or less, holds one
  env.manager.updateConfig({ max_requests_history: 0 })
  for (let number = 0; number < 3; number++) await env.send({ path: `/api/${number}` })
  assert.deepEqual(seqs(), [3])
  assert.equal(env.log.size, 1)

  // The new size takes hold as the next exchange is kept
  env.manager.updateConfig({ max_requests_history: 5 })
  assert.deepEqual([seqs(), env.log.firstSeq], [[3], 3])
  await env.send({ path: '/api/3' })
  assert.deepEqual([seqs(), env.log.firstSeq], [[3, 4], 3])

  env.manager.updateConfig({ max_requests_history: 1 })
  assert.deepEqual([seqs(), env.log.firstSeq], [[3, 4], 3])
  await env.send({ path: '/api/4' })
  assert.deepEqual([seqs(), env.log.firstSeq], [[5], 5])

  // A negative number holds one as well: nothing refuses one
  env.manager.updateConfig({ max_requests_history: -5 })
  await env.send({ path: '/api/5' })
  await env.send({ path: '/api/6' })
  assert.deepEqual([seqs(), env.log.size], [[7], 1])
})

test('select narrows the log by since, last, unmatched, encrypted, host, key and keyword, and takes an empty string for no filter', async (t) => {
  const env = await makeEnv(t)
  const { log } = env
  const seqs = (filters?: ExchangeFilters) => log.select(filters).map((exchange) => exchange.seq)

  // A key that does not read is refused before anything is looked through, so on an empty log too
  assert.throws(() => log.select({ key: 'nonsense' }), UserError)

  // 1: answered by a json rule, with a query
  log.recordHttp(
    makeRequest({
      method: 'GET',
      host: 'api.example.com',
      path: '/api/feed',
      query: { page: '7' },
    }),
    makeResponse({ status: 201, body: Buffer.from('{"secret": "in the body"}') }),
    { elapsed_ms: 1, matched_by: 'GET:/api/feed', mode: 'json' },
  )
  // 2: the same path on another host
  await env.send({ host: 'other.example.com', path: '/api/feed' })
  // 3: a request with a body
  await env.send({
    host: 'cdn.example.com',
    path: '/api/other',
    body: Buffer.from('A request body'),
  })
  // 4: over https, on 443, and nothing answered it
  log.recordHttp(
    makeRequest({ method: 'GET', scheme: 'https', host: 'api.example.com', path: '/x' }),
    makeResponse({ status: 404 }),
    { elapsed_ms: 1, unmatched: true },
  )
  // 5: a tunnel nobody decrypted, its host kept as it came
  log.recordConnect('Pinned.Example.com', 443, '192.168.1.23', 1200, 3400)
  const all = [1, 2, 3, 4, 5]

  // Not given, null, undefined, false and '' all filter nothing
  assert.deepEqual(seqs(), all)
  assert.deepEqual(seqs({}), all)
  assert.deepEqual(seqs({ key: null, host: null, since: null, last: null, q: null }), all)
  assert.deepEqual(seqs({ key: undefined, host: undefined, since: undefined, q: undefined }), all)
  assert.deepEqual(seqs({ unmatched: false, encrypted: false, q_body: false }), all)
  assert.deepEqual(seqs({ key: '', host: '', q: '' }), all)

  // since: what came after it. 0 is a value like any other, and every seq is past it
  assert.deepEqual(seqs({ since: 3 }), [4, 5])
  assert.deepEqual(seqs({ since: 5 }), [])
  assert.deepEqual(seqs({ since: 0 }), all)

  // last: the last so many of what is selected. 0 is all of it, as is more than there is; a
  // negative number cuts from the front
  assert.deepEqual(seqs({ last: 2 }), [4, 5])
  assert.deepEqual(seqs({ last: 0 }), all)
  assert.deepEqual(seqs({ last: 10 }), all)
  assert.deepEqual(seqs({ last: -2 }), [3, 4, 5])
  // Taken once the other filters are done
  assert.deepEqual(seqs({ key: 'GET:/api/feed', last: 1 }), [2])

  assert.deepEqual(seqs({ unmatched: true }), [4])
  assert.deepEqual(seqs({ encrypted: true }), [5])

  // host: `*` is a wildcard, and case counts on neither side
  assert.deepEqual(seqs({ host: '*.example.com' }), all)
  assert.deepEqual(seqs({ host: '*.EXAMPLE.com' }), all)
  assert.deepEqual(seqs({ host: 'api.*' }), [1, 4])
  assert.deepEqual(seqs({ host: 'API.Example.COM' }), [1, 4])
  assert.deepEqual(seqs({ host: 'pinned.example.com' }), [5])
  // With no `*` in it, a `?` is only a question mark
  assert.deepEqual(seqs({ host: 'api.example.co?' }), [])

  // key: what a rule written that way would answer. With no host, it answers on every host
  assert.deepEqual(seqs({ key: 'GET:/api/feed' }), [1, 2])
  assert.deepEqual(seqs({ key: 'GET:api.example.com/api/feed' }), [1])
  // With a port, only on that port
  assert.deepEqual(seqs({ key: 'GET:api.example.com:443/x' }), [4])
  assert.deepEqual(seqs({ key: 'GET:api.example.com:8080/x' }), [])
  // A tunnel has no path, so no key answers for it, not even one for every path
  assert.deepEqual(seqs({ key: 'GET:/*' }), [1, 2, 3, 4])
  assert.deepEqual(seqs({ key: 'CONNECT:/*' }), [])
  assert.deepEqual(seqs({ key: 'CONNECT:pinned.example.com:443/*' }), [])
  assert.throws(() => log.select({ key: 'nonsense' }), UserError)

  // q: a keyword, in any case, in the method, host, path, query, rule, mode or status
  assert.deepEqual(seqs({ q: 'connect' }), [5])
  assert.deepEqual(seqs({ q: 'cdn' }), [3])
  assert.deepEqual(seqs({ q: '/API/FEED' }), [1, 2])
  assert.deepEqual(seqs({ q: 'page=7' }), [1])
  assert.deepEqual(seqs({ q: 'GET:/api/feed' }), [1])
  assert.deepEqual(seqs({ q: 'JSON' }), [1])
  assert.deepEqual(seqs({ q: '201' }), [1])
  // The bodies, request and response, only when asked for: they are the expensive half
  assert.deepEqual(seqs({ q: 'in the body' }), [])
  assert.deepEqual(seqs({ q: 'In The Body', q_body: true }), [1])
  assert.deepEqual(seqs({ q: 'request body' }), [])
  assert.deepEqual(seqs({ q: 'request body', q_body: true }), [3])
})

// The fields of each shape in the order they are written: an exchange, its request and its
// response, a summary row and an aggregate row. The golden file
// tests/fixtures/requests/loaded.json holds its keys in the same order
const EXCHANGE_FIELDS = [
  'seq',
  'time',
  'kind',
  'request',
  'response',
  'matched_by',
  'mode',
  'replay_seq',
  'unmatched',
  'client',
  'truncated',
  'encrypted',
  'bytes_up',
  'bytes_down',
]
const REQUEST_FIELDS = [
  'method',
  'scheme',
  'host',
  'port',
  'path',
  'query',
  'url',
  'headers',
  'body',
  'body_encoding',
]
const RESPONSE_FIELDS = ['status', 'headers', 'body', 'body_encoding', 'elapsed_ms', 'size']
const SUMMARY_FIELDS = [
  'seq',
  'time',
  'kind',
  'key',
  'method',
  'scheme',
  'host',
  'port',
  'path',
  'query',
  'url',
  'status',
  'elapsed_ms',
  'size',
  'matched_by',
  'mode',
  'replay_seq',
  'unmatched',
  'encrypted',
  'truncated',
  'client',
  'bytes_up',
  'bytes_down',
]
// The 8 a row starts with, then the 9 every exchange under its key updates
const AGGREGATE_FIELDS = [
  'key',
  'method',
  'host',
  'path',
  'kind',
  'request_count',
  'unmatched_count',
  'first_seen',
  'last_seen',
  'last_seq',
  'query',
  'status',
  'elapsed_ms',
  'matched_by',
  'configured',
  'mode',
  'encrypted',
]

/** A tunnel nobody decrypted, as recordConnect keeps it */
function tunnel(fields: Partial<Exchange> = {}): Exchange {
  return makeExchange({
    kind: 'connect',
    request: makeExchangeRequest({
      method: 'CONNECT',
      scheme: 'https',
      host: 'pinned.example.com',
      port: 443,
      url: 'pinned.example.com:443',
    }),
    encrypted: true,
    bytes_up: 1200,
    bytes_down: 3400,
    ...fields,
  })
}

// The exchanges are made by hand, each with its own seq and time: aggregate reads nothing but what
// they hold
test('aggregate gives one row per key, the latest first, with its counts and what the last call under it did', () => {
  const api = (method: string, path: string, query: Record<string, string> = {}) =>
    makeExchangeRequest({
      method,
      scheme: 'https',
      host: 'api.example.com',
      port: 443,
      path,
      query,
    })
  const exchanges = [
    makeExchange({
      seq: 1,
      time: '2026-10-11T09:30:00.123',
      request: api('GET', '/v5/feed', { page: '1' }),
      response: makeExchangeResponse({ status: 200, elapsed_ms: 5 }),
      matched_by: 'GET:/v5/feed',
      mode: 'json',
    }),
    makeExchange({
      seq: 2,
      time: '2026-10-11T09:30:01.123',
      request: api('POST', '/v5/search'),
      response: makeExchangeResponse({ status: 404 }),
      mode: 'replay',
      unmatched: true,
    }),
    tunnel({ seq: 3, time: '2026-10-11T09:30:02.123' }),
    makeExchange({
      seq: 4,
      time: '2026-10-11T09:30:03.123',
      request: api('GET', '/v5/feed', { page: '2' }),
      response: makeExchangeResponse({ status: 500, elapsed_ms: 9 }),
      mode: 'passthrough',
    }),
    makeExchange({
      seq: 5,
      time: '2026-10-11T09:30:04.123',
      request: api('POST', '/v5/search'),
      response: makeExchangeResponse({ status: 201, elapsed_ms: 7 }),
      matched_by: 'POST:/v5/search',
      mode: 'json',
    }),
  ]

  const rows = aggregate(exchanges)
  // Last seen at seq 5, 4 and 3, though first seen in the other order
  assert.deepEqual(rows, [
    {
      key: 'POST:api.example.com/v5/search',
      method: 'POST',
      host: 'api.example.com',
      path: '/v5/search',
      kind: 'http',
      request_count: 2,
      unmatched_count: 1,
      first_seen: '2026-10-11T09:30:01.123',
      last_seen: '2026-10-11T09:30:04.123',
      last_seq: 5,
      query: {},
      status: 201,
      elapsed_ms: 7,
      // The first call matched no rule; the last one did
      matched_by: 'POST:/v5/search',
      configured: true,
      mode: 'json',
      encrypted: false,
    },
    {
      key: 'GET:api.example.com/v5/feed',
      method: 'GET',
      host: 'api.example.com',
      path: '/v5/feed',
      kind: 'http',
      request_count: 2,
      unmatched_count: 0,
      first_seen: '2026-10-11T09:30:00.123',
      last_seen: '2026-10-11T09:30:03.123',
      last_seq: 4,
      // The query of the last call; and the rule that answered the first is not reported,
      // since the last call was answered without one
      query: { page: '2' },
      status: 500,
      elapsed_ms: 9,
      matched_by: null,
      configured: false,
      mode: 'passthrough',
      encrypted: false,
    },
    {
      key: 'CONNECT:pinned.example.com:443',
      method: 'CONNECT',
      host: 'pinned.example.com',
      path: '',
      kind: 'connect',
      request_count: 1,
      unmatched_count: 0,
      first_seen: '2026-10-11T09:30:02.123',
      last_seen: '2026-10-11T09:30:02.123',
      last_seq: 3,
      query: {},
      status: null,
      elapsed_ms: null,
      matched_by: null,
      configured: false,
      mode: null,
      encrypted: true,
    },
  ])
  for (const row of rows) assert.deepEqual(Object.keys(row), AGGREGATE_FIELDS)
  // A copy of the last query
  assert.notEqual(rows[1]?.query, exchanges[3]?.request.query)
})

test("exchangeSummary is the flat row a list view shows, its size the answer's or what a tunnel carried both ways", () => {
  const query = { page: '2' }
  const summary = exchangeSummary(
    makeExchange({
      seq: 1,
      time: '2026-10-11T09:30:00.123',
      request: makeExchangeRequest({
        method: 'GET',
        scheme: 'https',
        host: 'api.example.com',
        port: 443,
        path: '/v5/feed',
        query,
        url: 'https://api.example.com/v5/feed?page=2',
        headers: { authorization: 'Bearer abc' },
        body: { a: 1 },
        body_encoding: 'json',
      }),
      response: makeExchangeResponse({
        status: 201,
        headers: { 'content-type': 'text/plain' },
        body: 'ok',
        body_encoding: 'text',
        elapsed_ms: 12,
        size: 9,
      }),
      matched_by: 'GET:/v5/feed',
      mode: 'json',
      replay_seq: 17,
      client: '192.168.1.23',
    }),
  )
  // Everything but the headers and the bodies
  assert.deepEqual(summary, {
    seq: 1,
    time: '2026-10-11T09:30:00.123',
    kind: 'http',
    key: 'GET:api.example.com/v5/feed',
    method: 'GET',
    scheme: 'https',
    host: 'api.example.com',
    port: 443,
    path: '/v5/feed',
    query: { page: '2' },
    url: 'https://api.example.com/v5/feed?page=2',
    status: 201,
    elapsed_ms: 12,
    // The response's size as it was counted, not the length of the body kept
    size: 9,
    matched_by: 'GET:/v5/feed',
    mode: 'json',
    replay_seq: 17,
    unmatched: false,
    encrypted: false,
    truncated: false,
    client: '192.168.1.23',
    bytes_up: 0,
    bytes_down: 0,
  })
  assert.deepEqual(Object.keys(summary), SUMMARY_FIELDS)
  // A copy of the query
  assert.notEqual(summary.query, query)

  // An http row with no response has no status, no time and nothing sent back
  const unanswered = exchangeSummary(
    makeExchange({ request: makeExchangeRequest({ method: 'GET', path: '/x' }) }),
  )
  assert.deepEqual([unanswered.status, unanswered.elapsed_ms, unanswered.size], [null, null, 0])
  assert.deepEqual(Object.keys(unanswered), SUMMARY_FIELDS)

  // A tunnel's size is what it carried, up and down
  const carried = exchangeSummary(tunnel())
  assert.deepEqual(
    [carried.key, carried.status, carried.elapsed_ms, carried.size],
    ['CONNECT:pinned.example.com:443', null, null, 1200 + 3400],
  )
  assert.deepEqual(Object.keys(carried), SUMMARY_FIELDS)
})

// The last N lines of the file, a blank or unreadable line taking up its place among them like any
// other. Read from the end of the file, so that a file of gigabytes costs no more than its tail
test('on start the log reads back the last max_requests_history lines of its file, with Windows line ends or a BOM too, and starts empty with a warning on a file it cannot read', async (t) => {
  const { records } = captureLogs(t)
  const warnings = () =>
    records.filter((record) => record.level === 'warning').map((record) => record.message)
  const manager = new TunnelConfigManager(Paths.inOneDirectory(tmpDir(t)))
  const file = manager.paths.exchangesFile

  manager.updateConfig({ max_requests_history: 3 })
  writeFileSync(file, '{"seq": 1}\n{"seq": 2}\n\n{"seq": 3}\nnot json\n')
  const tail = new ExchangeLog(manager)
  // The last three lines are the blank one, seq 3 and the one that is not JSON
  assert.deepEqual(
    tail.all().map((exchange) => exchange.seq),
    [3],
  )
  assert.equal(tail.lastSeq, 3)
  assert.equal(warnings().length, 1)
  assert.ok(warnings()[0]?.startsWith(`Skipping an unreadable line in ${file}: `), warnings()[0])

  // The same with lines too long for one read of 64 KiB: it goes back read by read until it has
  // the last three whole, and the end of the first line, where it stopped, is never read as one
  const long = (seq: number) => `{"seq": ${seq}, "client": "${'x'.repeat(40_000)}"}\n`
  writeFileSync(file, [1, 2, 3, 4].map(long).join(''))
  assert.deepEqual(
    new ExchangeLog(manager).all().map((exchange) => exchange.seq),
    [2, 3, 4],
  )
  assert.equal(warnings().length, 1)

  // Lines ended by \r\n, as on Windows, and the last by a \r alone, with a blank line and one of
  // spaces between them; and a BOM on the first line, which trim() takes off. Room for all five
  // lines
  manager.updateConfig({ max_requests_history: 5 })
  const bom = String.fromCharCode(0xfeff)
  writeFileSync(file, `${bom}{"seq": 1}\r\n\r\n \t \r\n{"seq": 2}\r\n{"seq": 3}\r`)
  assert.deepEqual(
    new ExchangeLog(manager).all().map((exchange) => exchange.seq),
    [1, 2, 3],
  )
  assert.equal(warnings().length, 1)

  // A directory where the file should be: the log starts empty, as it does with no file at all
  rmSync(file)
  mkdirSync(file)
  const unreadable = new ExchangeLog(manager)
  assert.deepEqual([unreadable.all(), unreadable.lastSeq], [[], 0])
  assert.equal(warnings().length, 2)
  assert.ok(warnings()[1]?.startsWith(`Could not read the exchange log ${file}: `), warnings()[1])
})

// A line that is not an exchange is skipped with a warning, and the others are read
test('a line that is not an exchange, or not UTF-8, is skipped with a warning, and the seq it starts with still counts', async (t) => {
  const { records } = captureLogs(t)
  const manager = new TunnelConfigManager(Paths.inOneDirectory(tmpDir(t)))
  const file = manager.paths.exchangesFile
  const bad = ['[1, 2]', '"x"', 'null', '{"request": "x"}', '{"seq": "x"}']
  writeFileSync(
    file,
    Buffer.concat([
      Buffer.from(['{"seq": 1}', ...bad].map((line) => `${line}\n`).join('')),
      // int is lax, and reads "5" as 5
      Buffer.from('{"seq": "5"}\n'),
      // A byte that is not UTF-8, on a line that starts with its seq
      Buffer.from('{"seq": 9,'),
      Buffer.from([0xff]),
      Buffer.from('}\n'),
      Buffer.from('{"seq": 6}\n'),
    ]),
  )
  const log = new ExchangeLog(manager)

  assert.deepEqual(
    log.all().map((exchange) => exchange.seq),
    [1, 5, 6],
  )
  // The line that is not UTF-8 says it was seq 9, so 9 has been handed out
  assert.equal(log.lastSeq, 9)
  const warnings = records.filter((record) => record.level === 'warning')
  assert.equal(warnings.length, bad.length + 1)
  for (const warning of warnings) {
    assert.ok(
      warning.message.startsWith(`Skipping an unreadable line in ${file}: `),
      warning.message,
    )
  }
})

// A line that cannot be read was still written by someone, with the seq it starts with
test('the seq goes on past that of an unreadable last line that starts with it', async (t) => {
  const manager = new TunnelConfigManager(Paths.inOneDirectory(tmpDir(t)))
  writeFileSync(
    manager.paths.exchangesFile,
    '{"seq": 1}\n{"seq": 9, "time": "2026-10-11T09:30:00.1\n',
  )
  const log = new ExchangeLog(manager)

  assert.deepEqual(
    log.all().map((exchange) => exchange.seq),
    [1],
  )
  assert.equal(log.recordConnect('pinned.example.com', 443, '127.0.0.1', 1, 2)?.seq, 10)
  await log.close()
})

// Written onto the end of the half line, the next one could not be read either, and a restart would
// hand the half line's seq out again
test('after a file that ends in half a line the next exchange starts a line of its own, which a restart reads back, and the half line keeps its seq', async (t) => {
  const { records } = captureLogs(t)
  const manager = new TunnelConfigManager(Paths.inOneDirectory(tmpDir(t)))
  const file = manager.paths.exchangesFile
  const half = '{"seq": 2, "time": "2026-10-11T09:3'
  writeFileSync(file, `{"seq": 1}\n${half}`)
  const log = new ExchangeLog(manager)
  assert.equal(log.recordConnect('pinned.example.com', 443, '127.0.0.1', 1, 2)?.seq, 3)
  await log.close()

  // The half line is left as it was, ended now, and the new one follows it
  assert.ok(
    readFileSync(file, 'utf8').startsWith(`{"seq": 1}\n${half}\n{"seq":3,`),
    readFileSync(file, 'utf8'),
  )
  const again = new ExchangeLog(manager)
  assert.deepEqual(
    again.all().map((exchange) => exchange.seq),
    [1, 3],
  )
  assert.equal(again.lastSeq, 3)
  // The half line, once on each start, and nothing else
  assert.equal(records.filter((record) => record.level === 'warning').length, 2)
})

test('a JSON body with a lone surrogate in it is kept as JSON, written as its escape, and the log goes on writing', async (t) => {
  const env = await makeEnv(t)
  const exchange = env.log.recordHttp(
    makeRequest({ method: 'POST', path: '/x', body: Buffer.from('{"a": "\\ud800"}') }),
    makeResponse(),
    { elapsed_ms: 0 },
  )
  assert.equal(exchange?.request.body_encoding, 'json')
  assert.deepEqual(exchange?.request.body, { a: String.fromCharCode(0xd800) })

  await env.log.flush()
  // The six characters of the escape: JSON.stringify writes a lone surrogate no other way
  assert.ok(readFileSync(env.manager.paths.exchangesFile, 'utf8').includes('"a":"\\ud800"'))
  env.log.recordConnect('pinned.example.com', 443, '127.0.0.1', 1, 2)
  await env.log.flush()
  assert.deepEqual(seqsWritten(env), [1, 2])
})

// A write that fails costs the file the lines it held, one or more, and nothing more
test('a write that fails is a warning, and the log goes on in memory and on disk', async (t) => {
  const { records } = captureLogs(t)
  const env = await makeEnv(t)
  const file = env.manager.paths.exchangesFile
  // Where the file should be, a directory: no write can open it
  mkdirSync(file)

  env.log.recordConnect('pinned.example.com', 443, '127.0.0.1', 1, 2)
  await env.log.flush()
  const warnings = records.filter((record) => record.level === 'warning')
  assert.equal(warnings.length, 1)
  assert.ok(
    warnings[0]?.message.startsWith(`Could not write the exchange log ${file}: `),
    warnings[0]?.message,
  )
  assert.deepEqual(
    env.log.all().map((exchange) => exchange.seq),
    [1],
  )

  // Each write opens the file afresh, so the next one gets through
  rmdirSync(file)
  env.log.recordConnect('pinned.example.com', 443, '127.0.0.1', 3, 4)
  await env.log.flush()
  assert.deepEqual(seqsWritten(env), [2])
  assert.equal(records.filter((record) => record.level === 'warning').length, 1)

  // A write that failed may have left half a line, so the next one starts with a newline: here it
  // makes a blank line, which a restart passes over without a warning
  assert.match(readFileSync(file, 'utf8'), /^\n\{"seq":2,/)
  const again = new ExchangeLog(env.manager)
  assert.deepEqual(
    again.all().map((exchange) => exchange.seq),
    [2],
  )
  assert.equal(again.lastSeq, 2)
  assert.equal(records.filter((record) => record.level === 'warning').length, 1)
})

test('a clear is written in its place among the appends, so the file is left holding what came after it', async (t) => {
  const env = await makeEnv(t)
  await env.send({ path: '/api/a' })
  await env.send({ path: '/api/b' })
  env.log.clear()
  await env.send({ path: '/api/c' })
  await env.log.flush()

  assert.deepEqual(seqsWritten(env), [3])
})

test('flush waits for every write queued, and the log goes on writing after close', async (t) => {
  const env = await makeEnv(t)
  for (let number = 0; number < 50; number++) await env.send({ path: `/api/${number}` })
  await env.log.flush()
  assert.equal(seqsWritten(env).length, 50)

  await env.log.close()
  await env.send({ path: '/api/50' })
  await env.log.flush()
  assert.equal(seqsWritten(env).length, 51)

  // Called with a write under way, flush waits as well for one queued while it does
  await env.send({ path: '/api/51' })
  const flushed = env.log.flush()
  await env.send({ path: '/api/52' })
  await flushed
  assert.equal(seqsWritten(env).length, 53)
})

test('a Broadcaster gives each subscriber every entry in order, drops what a full backlog has no room for, and lets a waiting next() go the moment it unsubscribes', async (t) => {
  const { records } = captureLogs(t)
  assert.equal(new Broadcaster().backlog, 1000)

  const broadcaster = new Broadcaster(2)
  const one = broadcaster.subscribe()
  const other = broadcaster.subscribe()
  assert.equal(broadcaster.subscribers, 2)

  // Room for two each: the third exchange and the change after it are dropped, for each of them
  const sent = [1, 2, 3].map((seq) => makeExchange({ seq }))
  for (const exchange of sent) broadcaster.publish(exchange)
  broadcaster.publishChange()
  for (const subscription of [one, other]) {
    // The very objects published, in the order they were
    assert.equal(await subscription.next(1000), sent[0])
    assert.equal(await subscription.next(1000), sent[1])
    assert.equal(await subscription.next(50), 'timeout')
  }
  assert.deepEqual(
    records.map(({ level, logger, message }) => [level, logger, message]),
    [
      ['debug', 'tunnel.exchanges', 'A watcher fell behind; dropping exchange 3'],
      ['debug', 'tunnel.exchanges', 'A watcher fell behind; dropping exchange 3'],
      ['debug', 'tunnel.exchanges', 'A watcher fell behind; dropping a window change'],
      ['debug', 'tunnel.exchanges', 'A watcher fell behind; dropping a window change'],
    ],
  )

  // An exchange and a change come through the one queue, in the order they were published
  const fourth = makeExchange({ seq: 4 })
  broadcaster.publish(fourth)
  broadcaster.publishChange()
  for (const subscription of [one, other]) {
    assert.equal(await subscription.next(1000), fourth)
    assert.equal(await subscription.next(1000), null)
  }

  // A next() already waiting is handed the entry, and its timer is cleared: a timer of 5 s
  // left behind would keep the test process from exiting
  const waiting = one.next(5000)
  const fifth = makeExchange({ seq: 5 })
  broadcaster.publish(fifth)
  assert.equal(await waiting, fifth)
  assert.equal(await other.next(1000), fifth)

  // One next() at a time
  const started = performance.now()
  const pending = one.next(5000)
  assert.throws(() => one.next(), { name: 'Error', message: /one next\(\)/ })
  await delay(20)
  broadcaster.unsubscribe(one)
  // Let go at once, rather than when its 5 s are up, and every next() after it as well
  assert.equal(await pending, 'closed')
  assert.ok(performance.now() - started < 1000)
  assert.equal(await one.next(1000), 'closed')
  assert.equal(broadcaster.subscribers, 1)

  // 'closed' too with an entry still in its backlog
  broadcaster.publish(makeExchange({ seq: 6 }))
  broadcaster.unsubscribe(other)
  assert.equal(await other.next(1000), 'closed')
  assert.equal(broadcaster.subscribers, 0)

  // Unsubscribing a second time does nothing, and so does a subscription another one made
  const elsewhere = new Broadcaster()
  const theirs = elsewhere.subscribe()
  broadcaster.unsubscribe(other)
  broadcaster.unsubscribe(theirs)
  assert.equal(broadcaster.subscribers, 0)
  assert.equal(elsewhere.subscribers, 1)
  elsewhere.publishChange()
  assert.equal(await theirs.next(1000), null)

  // No limit at 0 or below
  for (const backlog of [0, -1]) {
    const unbounded = new Broadcaster(backlog)
    const subscription = unbounded.subscribe()
    const many = Array.from({ length: 1500 }, (_, i) => makeExchange({ seq: i + 1 }))
    for (const exchange of many) unbounded.publish(exchange)
    for (const exchange of many) assert.equal(await subscription.next(1000), exchange)
  }
  // Nothing more was dropped
  assert.equal(records.length, 4)
})

// What the SSE and wait loops count on: an exchange is in the log before any watcher is told of
// it, and a clear has emptied the log before any watcher is told of that
test('a watcher woken by an exchange finds it in the log already, and one woken by a clear finds the window past the last seq', async (t) => {
  const env = await makeEnv(t)
  const subscription = env.log.broadcaster.subscribe()
  // What the watcher reads the moment next() gives it something
  const wake = async () => {
    const entry = await subscription.next(2000)
    return {
      entry,
      seqs: env.log.all().map((exchange) => exchange.seq),
      window: [env.log.firstSeq, env.log.lastSeq],
    }
  }

  const arrived = wake()
  await env.send({ path: '/api/feed' })
  const { entry, seqs, window } = await arrived
  assert.ok(typeof entry === 'object' && entry !== null, String(entry))
  assert.equal(entry.seq, 1)
  assert.deepEqual([seqs, window], [[1], [1, 1]])

  const cleared = wake()
  env.log.clear()
  assert.deepEqual(await cleared, { entry: null, seqs: [], window: [2, 1] })
})

test('parseExchange fills in what is missing, drops what it does not know and puts the fields in order, and refuses a field of the wrong type', () => {
  const parsed = parseExchange({
    bytes_down: 7,
    unknown: 1,
    seq: 3,
    request: { path: '/x', junk: true, method: 'GET' },
    response: { size: 2, status: 404 },
  })
  assert.deepEqual(parsed, {
    seq: 3,
    time: '',
    kind: 'http',
    request: {
      method: 'GET',
      scheme: '',
      host: '',
      port: 0,
      path: '/x',
      query: {},
      url: '',
      headers: {},
      body: null,
      body_encoding: null,
    },
    response: {
      status: 404,
      headers: {},
      body: null,
      body_encoding: null,
      elapsed_ms: 0,
      size: 2,
    },
    matched_by: null,
    mode: null,
    replay_seq: null,
    unmatched: false,
    client: '',
    truncated: false,
    encrypted: false,
    bytes_up: 0,
    bytes_down: 7,
  })
  assert.deepEqual(Object.keys(parsed), EXCHANGE_FIELDS)
  assert.deepEqual(Object.keys(parsed.request), REQUEST_FIELDS)
  assert.deepEqual(Object.keys(parsed.response ?? {}), RESPONSE_FIELDS)

  // A field of the wrong type is refused on the spot
  assert.throws(
    () => parseExchange({ request: 'x' }),
    (error) => {
      assert.ok(error instanceof ValidationError)
      assert.equal(error.title, 'Exchange')
      assert.deepEqual(error.issues[0]?.loc, ['request'])
      return true
    },
  )

  // The defaults, from makeExchange() and makeExchangeResponse()
  const made = makeExchange()
  assert.deepEqual(made, {
    seq: 0,
    time: '',
    kind: 'http',
    request: {
      method: '',
      scheme: '',
      host: '',
      port: 0,
      path: '',
      query: {},
      url: '',
      headers: {},
      body: null,
      body_encoding: null,
    },
    response: null,
    matched_by: null,
    mode: null,
    replay_seq: null,
    unmatched: false,
    client: '',
    truncated: false,
    encrypted: false,
    bytes_up: 0,
    bytes_down: 0,
  })
  assert.deepEqual(Object.keys(made), EXCHANGE_FIELDS)
  assert.deepEqual(Object.keys(made.request), REQUEST_FIELDS)
  const response = makeExchangeResponse()
  assert.deepEqual(response, {
    status: 0,
    headers: {},
    body: null,
    body_encoding: null,
    elapsed_ms: 0,
    size: 0,
  })
  assert.deepEqual(Object.keys(response), RESPONSE_FIELDS)
  // Objects of its own every time
  const again = makeExchange()
  assert.notEqual(made.request, again.request)
  assert.notEqual(made.request.query, again.request.query)
  // A field given as undefined counts as not given
  assert.deepEqual(makeExchange({ matched_by: undefined }), made)
})

// setTimeout takes 2^31 - 1 ms at most; past that, Node fires the timer after 1 ms and warns, and
// nothing caps the timeout a wait is given
test('next() holds a timeout too long for setTimeout to 2^31 - 1 ms rather than timing out at once', async (t) => {
  const warnings: string[] = []
  const onWarning = (warning: Error) => {
    warnings.push(warning.name)
  }
  process.on('warning', onWarning)
  t.after(() => process.off('warning', onWarning))

  const broadcaster = new Broadcaster()
  const subscription = broadcaster.subscribe()
  const waiting = subscription.next(1e12)
  assert.equal(await Promise.race([waiting, delay(60, 'still waiting')]), 'still waiting')
  // Which clears its timer too, one that would keep the test process alive for 24 days
  broadcaster.unsubscribe(subscription)
  assert.equal(await waiting, 'closed')
  assert.ok(!warnings.includes('TimeoutOverflowWarning'), warnings.join(', '))
})

// 5000 levels is past MAX_JSON_DEPTH, so the body is kept as text, on every Node version
test('a JSON body nested 5000 levels deep is recorded as text, and the log goes on recording what comes next', async (t) => {
  const { records } = captureLogs(t)
  const env = await makeEnv(t)
  await env.send({
    method: 'POST',
    path: '/api/deep',
    body: Buffer.from('['.repeat(5000) + ']'.repeat(5000)),
  })

  const kept = await env.getRequest(1)
  assert.deepEqual([kept.request.path, kept.request.body_encoding], ['/api/deep', 'text'])
  // The log itself stays readable, and goes on recording what comes next
  await env.send({ path: '/api/feed' })
  assert.equal((await env.requests({ each: 1 })).requests.at(-1)?.path, '/api/feed')
  await env.log.flush()
  assert.deepEqual(seqsWritten(env), [1, 2])
  assert.deepEqual(
    records.filter((record) => record.level === 'warning'),
    [],
  )
})

// The line is written out before the entry is kept: an exchange nothing can serialise is one the
// API could not show either, so the log says so and keeps none of it. The request has been
// answered all the same: logging never costs a client its reply.
test('an exchange that cannot be written out is a warning, kept nowhere and sent to nobody, and its seq is spent', async (t) => {
  const { records } = captureLogs(t)
  const env = await makeEnv(t)
  const subscription = env.log.broadcaster.subscribe()

  // JSON.stringify throws on a BigInt
  const exchange = env.log.recordHttp(
    makeRequest({
      method: 'GET',
      host: 'api.example.com',
      path: '/x',
      headers: { x: 1n } as never,
    }),
    makeResponse(),
    { elapsed_ms: 0 },
  )
  assert.equal(exchange?.seq, 1)
  const warnings = records.filter((record) => record.level === 'warning')
  assert.equal(warnings.length, 1)
  assert.ok(
    warnings[0]?.message.startsWith('Could not record GET api.example.com/x: '),
    warnings[0]?.message,
  )
  assert.deepEqual(env.log.all(), [])
  assert.equal(await subscription.next(20), 'timeout')

  assert.equal(env.log.recordConnect('pinned.example.com', 443, '127.0.0.1', 1, 2)?.seq, 2)
  await env.log.flush()
  assert.deepEqual(seqsWritten(env), [2])
})

// How deep JSON.stringify writes depends on the Node version, so past MAX_JSON_DEPTH, 1000
// levels, a body is kept as the text it came as, the same on every version, as JSON the parser
// cannot read is
test('encodeBody keeps JSON nested 1000 levels deep as JSON and anything deeper as text, whichever way it was parsed', () => {
  const nested = (levels: number, inside = '') => '['.repeat(levels) + inside + ']'.repeat(levels)
  const encodingOf = (text: string) => encodeBody(Buffer.from(text)).body_encoding

  const deepest = encodeBody(Buffer.from(nested(1000)))
  assert.equal(deepest.body_encoding, 'json')
  // and written back as it came
  assert.ok(decodeBody(deepest.body, deepest.body_encoding).equals(Buffer.from(nested(1000))))
  assert.equal(encodingOf(nested(1001)), 'text')
  // As in 'a body nothing can encode never costs the client its answer': JSON.parse reads
  // 200,000 levels, and the cap is what makes it text
  assert.equal(encodingOf(nested(200_000)), 'text')
  // An object is a level as an array is; a big integer, which parseJson keeps as a RawJson, is not
  assert.equal(encodingOf(`{"a": ${nested(999)}}`), 'json')
  assert.equal(encodingOf(`{"a": ${nested(1000)}}`), 'text')
  assert.equal(encodingOf(nested(1000, '12345678901234567890')), 'json')
  // A run of 16 digits sends parseJson through its reviver, which recurses
  assert.equal(encodingOf(`{"id": 12345678901234567890, "deep": ${nested(3000)}}`), 'text')

  // Kept as text, it gives back the bytes it came as
  const text = Buffer.from(nested(5000))
  assert.equal(text.length, 10_000)
  const { body, body_encoding, truncated } = encodeBody(text)
  assert.deepEqual([body_encoding, truncated], ['text', false])
  assert.ok(decodeBody(body, body_encoding).equals(text))
})

// As text, an exchange with such a body is kept and written out whatever JSON.stringify's
// limit on this Node, and a restart reads it back with the one after it
test('an exchange with a body nested 200,000 levels deep is kept, written out and read back on a restart, and so is the next one', async (t) => {
  const { records } = captureLogs(t)
  const manager = new TunnelConfigManager(Paths.inOneDirectory(tmpDir(t)))
  const deep = '['.repeat(200_000) + ']'.repeat(200_000)
  const encodings = (exchanges: Exchange[]) =>
    exchanges.map((exchange) => [exchange.seq, exchange.request.body_encoding])

  const log = new ExchangeLog(manager)
  log.recordHttp(
    makeRequest({
      method: 'POST',
      host: 'api.example.com',
      path: '/api/deep',
      body: Buffer.from(deep),
    }),
    makeResponse(),
    { elapsed_ms: 0 },
  )
  log.recordConnect('pinned.example.com', 443, '127.0.0.1', 1, 2)
  assert.deepEqual(encodings(log.all()), [
    [1, 'text'],
    [2, null],
  ])
  // Not assert.equal, whose diff of 400,000 characters would say nothing
  assert.ok(log.get(1)?.request.body === deep)
  await log.close()

  const again = new ExchangeLog(manager)
  assert.deepEqual(encodings(again.all()), [
    [1, 'text'],
    [2, null],
  ])
  assert.ok(again.get(1)?.request.body === deep)
  assert.equal(again.lastSeq, 2)
  assert.deepEqual(
    records.filter((record) => record.level === 'warning'),
    [],
  )
})

// The log goes on from the highest seq in the file plus one, whatever that is: a file whose seqs
// are all below 1, which only an edit by hand makes, goes on from there as well, and only a file
// with no seq at all starts at 1
test('the next seq is one past the highest in the file even when that is below 1', async (t) => {
  const manager = new TunnelConfigManager(Paths.inOneDirectory(tmpDir(t)))
  writeFileSync(manager.paths.exchangesFile, '{"seq": -5}\n{"seq": -3}\n')
  const log = new ExchangeLog(manager)

  assert.deepEqual(
    log.all().map((exchange) => exchange.seq),
    [-5, -3],
  )
  assert.deepEqual([log.firstSeq, log.lastSeq], [-5, -3])
  assert.equal(log.recordConnect('pinned.example.com', 443, '127.0.0.1', 1, 2)?.seq, -2)
  await log.close()
})

// The appends queued behind a write under way go out together, as one write, so a write that fails
// is one warning however many lines it held, and every one of them is missing from the file.
// Memory keeps them all
test('the appends queued behind a write go out as one, so a write that fails is one warning however many lines it held', async (t) => {
  const { records } = captureLogs(t)
  const env = await makeEnv(t)
  const file = env.manager.paths.exchangesFile
  const warnings = () => records.filter((record) => record.level === 'warning')
  mkdirSync(file)

  // The first starts a write at once; the two after it wait for that one, then go out together
  for (const bytes of [1, 2, 3]) {
    env.log.recordConnect('pinned.example.com', 443, '127.0.0.1', bytes, bytes)
  }
  await env.log.flush()
  assert.equal(warnings().length, 2)
  for (const warning of warnings()) {
    assert.ok(
      warning.message.startsWith(`Could not write the exchange log ${file}: `),
      warning.message,
    )
  }
  assert.deepEqual(
    env.log.all().map((exchange) => exchange.seq),
    [1, 2, 3],
  )

  rmdirSync(file)
  env.log.recordConnect('pinned.example.com', 443, '127.0.0.1', 4, 4)
  await env.log.flush()
  assert.deepEqual(seqsWritten(env), [4])
  assert.equal(warnings().length, 2)
})

// The writes are carried out by a promise that only flush and close wait for, so nothing that
// throws on the way, the logger included, may stop the writes after it or make flush reject. A run
// of appends too long to join into one string, after the disk has kept them waiting, is another
// way to get there
test('the writes go on, and flush resolves, even when the logger throws as it tells of a write that failed', async (t) => {
  const env = await makeEnv(t)
  const file = env.manager.paths.exchangesFile
  const told: string[] = []
  const previous = setLogSink((record) => {
    told.push(record.message)
    throw new Error('the log sink is broken')
  })
  t.after(() => setLogSink(previous))
  mkdirSync(file)

  env.log.recordConnect('pinned.example.com', 443, '127.0.0.1', 1, 2)
  await env.log.flush()
  assert.ok(told[0]?.startsWith(`Could not write the exchange log ${file}: `), told[0])

  rmdirSync(file)
  env.log.recordConnect('pinned.example.com', 443, '127.0.0.1', 3, 4)
  await env.log.flush()
  // On a line of its own, after the write that failed, though the logger threw as it said so
  assert.match(readFileSync(file, 'utf8'), /^\n\{"seq":2,/)
})

// next() holds a timeout to [0, 2^31 - 1], and NaN is at neither end of that:
// setTimeout, handed NaN, fires after 1 ms and, from Node 24 on, warns (TimeoutNaNWarning)
test('next() takes a timeout that is not a number as 0, rather than handing NaN to setTimeout', async (t) => {
  const warnings: string[] = []
  const onWarning = (warning: Error) => {
    warnings.push(warning.name)
  }
  process.on('warning', onWarning)
  t.after(() => process.off('warning', onWarning))

  const subscription = new Broadcaster().subscribe()
  assert.equal(await subscription.next(Number.NaN), 'timeout')
  assert.ok(!warnings.includes('TimeoutNaNWarning'), warnings.join(', '))
})

// The file the clear emptied is all a restart has to go by, so the seq starts at 1 again. The
// recordings, whose files are named by seq, have to live with it
test('a restart after a clear starts the seq at 1 again', async (t) => {
  const manager = new TunnelConfigManager(Paths.inOneDirectory(tmpDir(t)))
  const log = new ExchangeLog(manager)
  log.recordConnect('pinned.example.com', 443, '127.0.0.1', 1, 2)
  log.recordConnect('pinned.example.com', 443, '127.0.0.1', 3, 4)
  assert.equal(log.clear(), 2)
  await log.close()
  assert.equal(readFileSync(manager.paths.exchangesFile, 'utf8'), '')

  const again = new ExchangeLog(manager)
  assert.deepEqual([again.size, again.firstSeq, again.lastSeq], [0, 1, 0])
  assert.equal(again.recordConnect('pinned.example.com', 443, '127.0.0.1', 5, 6)?.seq, 1)
  await again.close()
})
