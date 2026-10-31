// The static response modes, asked of the core directly.
//
// resolve() is transport independent — the proxy port hands it exactly these Request
// objects — so a test can put one in and read the Response that comes out. Passthrough
// reaches a fake upstream that opens no socket (tests/support/fake-upstream.ts), so
// nothing leaves the machine and no server has to be running.
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { test, type TestContext } from 'node:test'
import { gzipSync } from 'node:zlib'
import { Paths, TunnelConfigManager } from '../src/config.ts'
import { deepMerge, mergeIntoJson, TunnelCore, type TunnelCoreOptions } from '../src/core.ts'
import { ExchangeLog } from '../src/exchanges.ts'
import { parseJson, stringifySpaced, type JsonObject, type JsonValue } from '../src/json.ts'
import { makeRequest, type Request, type Response } from '../src/messages.ts'
import type { TunnelRequestConfig } from '../src/models.ts'
import { RecordingStore } from '../src/recordings.ts'
import { ScriptRunner } from '../src/script.ts'
import { UpstreamRoutes } from '../src/upstream-route.ts'
import { UpstreamError, type UpstreamRequest, type UpstreamResponse } from '../src/upstream.ts'
import { fakeUpstream, jsonAnswer } from './support/fake-upstream.ts'
import { captureLogs } from './support/logs.ts'
import { testRoutes } from './support/routes.ts'
import { tmpDir } from './support/tmp.ts'

const BACKEND = 'http://backend'

/** A stand-in backend: it echoes the request, plus a few fixed endpoints. Routes on the path of
 *  the URL it was sent */
function backend(request: UpstreamRequest): UpstreamResponse {
  const url = new URL(request.url)
  switch (url.pathname) {
    case '/text':
      return {
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body: Buffer.from('plain body'),
      }
    case '/gzipped': {
      // The length of the compressed bytes, as the wire carries it
      const gzipped = gzipSync(JSON.stringify({ compressed: true }))
      return {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-encoding': 'gzip',
          'content-length': String(gzipped.length),
        },
        body: gzipped,
      }
    }
    case '/array':
      return jsonAnswer({ items: [1, 2, 3], meta: { total: 3, page: 1 } })
    case '/fixed/path':
      return jsonAnswer({ hit: 'fixed', query: Object.fromEntries(url.searchParams) })
    default:
      // The headers are the ones fakeUpstream filled in host and content-length on, as the
      // wire would have carried them; the body as text, or null when it is empty
      return jsonAnswer({
        method: request.method,
        url: request.url,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: request.headers,
        body: request.body.length > 0 ? request.body.toString('utf8') : null,
        code: 0,
      })
  }
}

/** A core over a config in a temporary directory, whose upstream is the backend above, so
 *  passthrough never opens a socket. A test that wants another upstream gives it in `options` */
function env(t: TestContext, options?: TunnelCoreOptions) {
  // Registered before tmpDir(t): node:test runs after hooks in registration order, and the core's
  // log and store flush asynchronously into that directory
  let core: TunnelCore | undefined
  t.after(() => core?.close())
  const manager = new TunnelConfigManager(Paths.inOneDirectory(tmpDir(t)))
  core = new TunnelCore(manager, { upstream: fakeUpstream(backend), ...options })
  return { core, manager }
}

/** Ask the core one question, the way the proxy port will */
const answer = (core: TunnelCore, fields: Partial<Request>) => core.resolve(makeRequest(fields))

const payload = (response: Response): JsonValue => parseJson(response.body.toString('utf8'))

const configure = (
  manager: TunnelConfigManager,
  key: string,
  fields: Partial<Omit<TunnelRequestConfig, 'request_key'>>,
) => manager.updateRequestConfig(key, fields)

/** What the backend's echo answers with */
type Echo = {
  method: string
  url: string
  path: string
  query: Record<string, string>
  headers: Record<string, string>
  body: string | null
  code: number
}

/** The detail of an answer tunnel made itself */
const detail = (response: Response) => (payload(response) as { detail: string }).detail

// ---------------------------------------------------------------- passthrough

// No target configured: a forward proxy sends the request where it was going
test('passthrough goes to the origin the client asked for', async (t) => {
  const { core, manager } = env(t)
  configure(manager, 'GET:/api/feed', { mode: 'passthrough' })

  const body = payload(
    await answer(core, {
      method: 'GET',
      scheme: 'https',
      host: 'api.example.com',
      port: 443,
      path: '/api/feed',
      query: { page: '2' },
    }),
  ) as Echo

  assert.equal(body.url, 'https://api.example.com/api/feed?page=2')
  assert.equal(body.method, 'GET')
  assert.equal(body.path, '/api/feed')
  assert.deepEqual(body.query, { page: '2' })
})

test('passthrough keeps a non-default port', async (t) => {
  const { core, manager } = env(t)
  configure(manager, 'GET:/api/feed', { mode: 'passthrough' })

  const body = payload(
    await answer(core, { method: 'GET', host: 'api.example.com', port: 8080, path: '/api/feed' }),
  ) as Echo

  assert.equal(body.url, 'http://api.example.com:8080/api/feed')
})

test('passthrough forwards the request body', async (t) => {
  const { core, manager } = env(t)
  configure(manager, 'POST:/api/users', { mode: 'passthrough' })

  const body = payload(
    await answer(core, {
      method: 'POST',
      host: 'api.example.com',
      path: '/api/users',
      body: Buffer.from('{"name": "x"}'),
    }),
  ) as Echo

  assert.equal(body.method, 'POST')
  assert.deepEqual(parseJson(body.body!), { name: 'x' })
})

// Map Remote with a base URL: same path, different server
test('target replaces the origin and keeps the path', async (t) => {
  const { core, manager } = env(t)
  configure(manager, 'GET:/api/feed', { mode: 'passthrough', target: 'http://other' })

  const body = payload(
    await answer(core, { method: 'GET', host: 'api.example.com', path: '/api/feed' }),
  ) as Echo

  assert.equal(body.url, 'http://other/api/feed')
})

// A target with a path of its own is used as it is, not joined to the request's
test('full URL target is used as is', async (t) => {
  const { core, manager } = env(t)
  configure(manager, 'GET:/whatever', { mode: 'passthrough', target: `${BACKEND}/fixed/path` })

  const response = await answer(core, { method: 'GET', host: 'api.example.com', path: '/whatever' })

  assert.equal((payload(response) as { hit: string }).hit, 'fixed')
})

test('query is appended to full URL target', async (t) => {
  const { core, manager } = env(t)
  configure(manager, 'GET:/whatever', {
    mode: 'passthrough',
    target: `${BACKEND}/fixed/path?from=config`,
  })

  const { query } = payload(
    await answer(core, {
      method: 'GET',
      host: 'api.example.com',
      path: '/whatever',
      query: { page: '3' },
    }),
  ) as { query: Record<string, string> }

  assert.deepEqual(query, { from: 'config', page: '3' })
})

test('transport headers are stripped before forwarding', async (t) => {
  const { core, manager } = env(t)
  configure(manager, 'POST:/api/users', { mode: 'passthrough' })

  const { headers } = payload(
    await answer(core, {
      method: 'POST',
      host: 'api.example.com',
      path: '/api/users',
      headers: {
        host: 'somewhere.else',
        'transfer-encoding': 'chunked',
        'content-length': '999',
        'x-keep': 'me',
      },
      body: Buffer.from('{"name": "x"}'),
    }),
  ) as Echo

  // The host belongs to the address we are sending to, and the length is the upstream client's
  // to work out again now that the body is a Buffer.
  assert.equal(headers['host'], 'api.example.com')
  assert.ok(!('transfer-encoding' in headers))
  assert.equal(headers['content-length'], '13')
  assert.equal(headers['x-keep'], 'me')
})

test('merge_json deep-merges the upstream response', async (t) => {
  const { core, manager } = env(t)
  configure(manager, 'GET:/api/feed', {
    mode: 'passthrough',
    merge_json: { code: 42, query: { injected: true } },
  })

  const body = payload(
    await answer(core, {
      method: 'GET',
      host: 'api.example.com',
      path: '/api/feed',
      query: { page: '1' },
    }),
  ) as Echo

  assert.equal(body.code, 42)
  assert.deepEqual(body.query, { page: '1', injected: true }) // an object is merged
  assert.equal(body.method, 'GET') // and the rest survives
})

// Editing one element of an array is a script's job, not a merge's
test('merge replaces an array whole and recurses into objects', async (t) => {
  const { core, manager } = env(t)
  configure(manager, 'GET:/array', {
    mode: 'passthrough',
    merge_json: { items: [9], meta: { total: 0 } },
  })

  const body = payload(
    await answer(core, { method: 'GET', host: 'api.example.com', path: '/array' }),
  ) as { items: number[]; meta: Record<string, number> }

  assert.deepEqual(body.items, [9])
  assert.deepEqual(body.meta, { total: 0, page: 1 })
})

test('merge is skipped for a non-JSON response', async (t) => {
  const { core, manager } = env(t)
  configure(manager, 'GET:/text', { mode: 'passthrough', merge_json: { code: 42 } })

  const response = await answer(core, { method: 'GET', host: 'api.example.com', path: '/text' })

  assert.deepEqual(response.body, Buffer.from('plain body'))
})

// The core decompresses the body, so content-encoding has to go with it. A client that still saw
// the header would decode what is already decoded.
test('compressed response is decoded and encoding header dropped', async (t) => {
  const { core, manager } = env(t)
  configure(manager, 'GET:/gzipped', { mode: 'passthrough' })

  const response = await answer(core, { method: 'GET', host: 'api.example.com', path: '/gzipped' })

  assert.deepEqual(payload(response), { compressed: true })
  assert.ok(!('content-encoding' in response.headers))
  assert.ok(!('content-length' in response.headers))
})

test('unconfigured endpoint falls back to the default_mode', async (t) => {
  const { core } = env(t)

  const body = payload(
    await answer(core, { method: 'GET', host: 'api.example.com', path: '/api/never-configured' }),
  ) as Echo

  assert.equal(body.path, '/api/never-configured')
})

// The upstream failed, not tunnel: the status says which, and the detail is one line
test('an upstream that cannot be reached is a 502', async (t) => {
  // This core is built with an upstream that refuses every connection
  const refuse = fakeUpstream(() => {
    throw new UpstreamError('All connection attempts failed')
  })
  const { core, manager } = env(t, { upstream: refuse })
  configure(manager, 'GET:/api/feed', { mode: 'passthrough' })

  const response = await answer(core, {
    method: 'GET',
    scheme: 'https',
    host: 'api.example.com',
    path: '/api/feed',
  })

  assert.equal(response.status, 502)
  assert.ok(detail(response).startsWith('Could not reach https://api.example.com'))
})

// A request built without a host has nowhere to go and must not crash the core
test('passthrough without a host says so', async (t) => {
  const { core, manager } = env(t)
  configure(manager, 'GET:/api/feed', { mode: 'passthrough' })

  const response = await answer(core, { method: 'GET', path: '/api/feed' })

  assert.equal(response.status, 500)
  assert.ok(detail(response).includes('no host'))
})

// ---------------------------------------------------------------- JSON mode

test('JSON mode returns literal JSON', async (t) => {
  const { core, manager } = env(t)
  configure(manager, 'GET:/api/feed', {
    mode: 'json',
    json_response: { code: 0, list: [] },
    status_code: 202,
  })

  const response = await answer(core, { method: 'GET', host: 'api.example.com', path: '/api/feed' })

  assert.equal(response.status, 202)
  assert.deepEqual(payload(response), { code: 0, list: [] })
  assert.equal(response.headers['content-type'], 'application/json')
})

test('JSON mode supports arrays', async (t) => {
  const { core, manager } = env(t)
  configure(manager, 'GET:/api/feed', { mode: 'json', json_response: [1, 2, 3] })

  assert.deepEqual(
    payload(await answer(core, { method: 'GET', host: 'x', path: '/api/feed' })),
    [1, 2, 3],
  )
})

test('disabled endpoint returns 503', async (t) => {
  const { core, manager } = env(t)
  configure(manager, 'GET:/api/feed', { mode: 'json', json_response: {}, enabled: false })

  const response = await answer(core, { method: 'GET', host: 'x', path: '/api/feed' })

  assert.equal(response.status, 503)
  assert.ok((payload(response) as { detail: string }).detail.includes('disabled'))
})

test('response_delay is applied', async (t) => {
  const { core, manager } = env(t)
  configure(manager, 'GET:/api/feed', { mode: 'json', json_response: {}, response_delay: 0.2 })

  const started = performance.now()
  await answer(core, { method: 'GET', host: 'x', path: '/api/feed' })

  assert.ok(performance.now() - started >= 200)
})

// ---------------------------------------------------------------- response headers

// The last word on the answer, whichever mode produced it
test('rule headers are written over what the mode answered', async (t) => {
  const { core, manager } = env(t)
  configure(manager, 'GET:/api/feed', {
    mode: 'json',
    json_response: { a: 1 },
    headers: { 'set-cookie': 'sid=1', 'content-type': 'application/problem+json' },
  })

  const response = await answer(core, { method: 'GET', host: 'api.example.com', path: '/api/feed' })

  assert.equal(response.headers['set-cookie'], 'sid=1')
  assert.equal(response.headers['content-type'], 'application/problem+json')
  assert.deepEqual(payload(response), { a: 1 })
})

// One header, however each side capitalised it: two content types on one answer would leave the
// client reading whichever it saw first
test('a rule header replaces one the answer spelled differently', async (t) => {
  const { core, manager } = env(t)
  configure(manager, 'GET:/api/feed', {
    mode: 'json',
    json_response: { a: 1 },
    headers: { 'Content-Type': 'application/problem+json' },
  })

  const response = await answer(core, { method: 'GET', host: 'api.example.com', path: '/api/feed' })

  assert.deepEqual(
    Object.keys(response.headers).filter((name) => name.toLowerCase() === 'content-type'),
    ['Content-Type'],
  )
  assert.equal(response.headers['Content-Type'], 'application/problem+json')
})

test('rule headers beat the ones a passthrough brought back', async (t) => {
  const { core, manager } = env(t)
  configure(manager, 'GET:/api/feed', {
    mode: 'passthrough',
    merge_json: { code: 7 },
    headers: { 'content-type': 'text/plain', 'x-flag': '1' },
  })

  const response = await answer(core, { method: 'GET', host: 'api.example.com', path: '/api/feed' })

  // The merge happened while the answer still said JSON; the header is the
  // rule's afterwards, because it is applied last.
  assert.equal((payload(response) as { code: number }).code, 7)
  assert.equal(response.headers['content-type'], 'text/plain')
  assert.equal(response.headers['x-flag'], '1')
})

// ---------------------------------------------------------------- in detail

test('deepMerge recurses into objects and replaces everything else outright', () => {
  const base = { a: { b: 1, c: 2 }, d: [1, 2] }
  const patch = { a: { c: 3 }, d: [9], e: 5 }
  const merged = deepMerge(base, patch) as JsonObject
  assert.deepEqual(merged, { a: { b: 1, c: 3 }, d: [9], e: 5 })
  // The keys already there stay where they were and new ones come after them
  assert.deepEqual(Object.keys(merged), ['a', 'd', 'e'])
  assert.deepEqual(Object.keys(merged.a as JsonObject), ['b', 'c'])
  // Neither side is changed
  assert.deepEqual(base, { a: { b: 1, c: 2 }, d: [1, 2] })
  assert.deepEqual(patch, { a: { c: 3 }, d: [9], e: 5 })

  // When one side is not an object, the answer is the patch itself
  const object = { a: 1 }
  const sides: [JsonValue, JsonValue][] = [
    [[1, 2], object],
    [{ a: 1 }, [1]],
    [5, object],
    [{ a: 1 }, 'x'],
    [null, object],
    [{ a: 1 }, null],
  ]
  for (const [left, right] of sides) assert.equal(deepMerge(left, right), right)

  // A key named __proto__ is a key like any other: it does not change the prototype of the
  // result, let alone Object.prototype
  const proto = deepMerge({}, parseJson('{"__proto__": {"polluted": 1}}')) as JsonObject
  assert.ok(Object.hasOwn(proto, '__proto__'))
  assert.equal(Object.getPrototypeOf(proto), Object.prototype)
  assert.equal(({} as { polluted?: number }).polluted, undefined)

  // An integer past 2^53 is a RawJson, which is not an object to recurse into: an object
  // replaces it, and it replaces an object
  const replaced = deepMerge(parseJson('{"id": 12345678901234567890}'), { id: { n: 1 } })
  assert.deepEqual((replaced as JsonObject).id, { n: 1 })
  const kept = deepMerge({ id: { n: 1 } }, parseJson('{"id": 12345678901234567890}'))
  assert.equal(stringifySpaced(kept), '{"id": 12345678901234567890}')
})

test('mergeIntoJson folds the patch into a JSON answer and leaves anything else untouched', (t) => {
  const logs = captureLogs(t)
  const body = Buffer.from('{"a":1}')

  // Nothing to merge: the very same body, the headers as they were
  const json = { 'content-type': 'application/json' }
  assert.equal(mergeIntoJson(json, body, {}), body)
  assert.deepEqual(json, { 'content-type': 'application/json' })

  // No content-type, or one that does not say JSON: as it came
  assert.equal(mergeIntoJson({}, body, { b: 2 }), body)
  const text = { 'content-type': 'text/plain' }
  assert.equal(mergeIntoJson(text, body, { b: 2 }), body)
  assert.deepEqual(text, { 'content-type': 'text/plain' })

  // The content-type is found whatever the case of its name and value, and is rewritten to
  // application/json, its charset gone, under the name as it was spelled. The separators are
  // stringifySpaced's
  const mixed = { 'Content-Type': 'Application/JSON; charset=utf-8' }
  assert.equal(mergeIntoJson(mixed, body, { b: 2 }).toString(), '{"a": 1, "b": 2}')
  assert.equal(mixed['Content-Type'], 'application/json')
  assert.deepEqual(Object.keys(mixed), ['Content-Type'])

  // An answer that says JSON and does not carry it: not JSON, not UTF-8, a BOM in front of
  // the JSON, nothing at all. Each comes back as it is, its content-type as it was, and each
  // says so in a warning
  const broken = [
    Buffer.from('{'),
    Buffer.from([0x7b, 0xff, 0x7d]),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}')]),
    Buffer.alloc(0),
  ]
  for (const answer of broken) {
    const said = { 'content-type': 'application/json' }
    assert.equal(mergeIntoJson(said, answer, { b: 2 }), answer)
    assert.deepEqual(said, { 'content-type': 'application/json' })
  }
  const warnings = logs.records.filter((record) => record.level === 'warning')
  assert.equal(warnings.length, 4)
  for (const warning of warnings) {
    assert.equal(warning.logger, 'tunnel.core')
    assert.ok(
      warning.message.startsWith(
        'The answer said JSON but did not carry it, so nothing was merged into it: ',
      ),
      warning.message,
    )
  }

  // A body that is an array is not an object to merge into: the patch takes its place
  const array = mergeIntoJson({ 'content-type': 'application/json' }, Buffer.from('[1, 2]'), {
    a: 1,
  })
  assert.equal(array.toString(), '{"a": 1}')

  // An integer past 2^53 in the answer keeps every digit
  const big = Buffer.from('{"id": 12345678901234567890, "x": 1}')
  const merged = mergeIntoJson({ 'content-type': 'application/json' }, big, { x: 2 })
  assert.equal(merged.toString(), '{"id": 12345678901234567890, "x": 2}')
})

test('an integer past 2^53 survives json mode, a passthrough and merge_json', async (t) => {
  const { core, manager } = env(t, {
    upstream: fakeUpstream(() => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{"id": 12345678901234567890, "n": 1}'),
    })),
  })
  const ask = (on: TunnelCore, path: string) =>
    answer(on, { method: 'GET', host: 'api.example.com', path })

  // json mode: written to config.json by one manager, then read back by a second one on the same
  // directory, the way the next start reads it
  configure(manager, 'GET:/api/big', {
    mode: 'json',
    json_response: parseJson('{"id": 12345678901234567890}') as JsonObject,
  })
  const restarted = new TunnelCore(new TunnelConfigManager(manager.paths), {
    upstream: fakeUpstream(backend),
  })
  try {
    const response = await ask(restarted, '/api/big')
    assert.equal(response.body.toString(), '{"id": 12345678901234567890}')
  } finally {
    await restarted.close()
  }

  // A passthrough whose merge_json changes another field of the upstream's answer
  configure(manager, 'GET:/api/feed', { mode: 'passthrough', merge_json: { n: 2 } })
  const merged = await ask(core, '/api/feed')
  assert.equal(merged.body.toString(), '{"id": 12345678901234567890, "n": 2}')

  // A merge_json that carries one of its own
  configure(manager, 'GET:/api/other', {
    mode: 'passthrough',
    merge_json: parseJson('{"big": 98765432109876543210}') as JsonObject,
  })
  const added = await ask(core, '/api/other')
  assert.equal(
    added.body.toString(),
    '{"id": 12345678901234567890, "n": 1, "big": 98765432109876543210}',
  )
})

test('forwarding drops host, transfer-encoding and content-length whatever their case, and keeps the rest as spelled', async (t) => {
  const sent: UpstreamRequest[] = []
  const upstream = fakeUpstream((request) => {
    sent.push(request)
    return jsonAnswer({})
  })
  const { core, manager } = env(t, { upstream })
  configure(manager, 'PUT:/api/feed', { mode: 'passthrough' })

  await answer(core, {
    method: 'PUT',
    host: 'api.example.com',
    path: '/api/feed',
    headers: {
      Host: 'somewhere.else',
      'Content-Length': '1',
      'Transfer-Encoding': 'chunked',
      'X-Keep': 'Me',
      'x-other': 'y',
    },
    body: Buffer.from('abc'),
  })

  assert.equal(sent.length, 1)
  const request = sent[0]!
  assert.equal(request.method, 'PUT')
  assert.deepEqual(request.body, Buffer.from('abc'))
  // The rest as they were spelled, then the host and the length fakeUpstream wrote again from the
  // URL and the body, as the real client does: neither is the one the request came with
  assert.deepEqual(Object.keys(request.headers), ['X-Keep', 'x-other', 'host', 'content-length'])
  assert.equal(request.headers['X-Keep'], 'Me')
  assert.equal(request.headers['x-other'], 'y')
  assert.equal(request.headers['host'], 'api.example.com')
  assert.equal(request.headers['content-length'], '3')
})

test('the upstream answer loses content-encoding, content-length and transfer-encoding whatever their case, and keeps the rest', async (t) => {
  const upstream = fakeUpstream(() => ({
    status: 201,
    headers: {
      'Content-Encoding': 'identity',
      'CONTENT-LENGTH': '3',
      'Transfer-Encoding': 'chunked',
      'X-From': 'backend',
      'set-cookie': 'a=1, b=2',
    },
    body: Buffer.from('abc'),
  }))
  const { core, manager } = env(t, { upstream })
  configure(manager, 'GET:/api/feed', { mode: 'passthrough' })

  const response = await answer(core, { method: 'GET', host: 'api.example.com', path: '/api/feed' })

  assert.equal(response.status, 201)
  assert.deepEqual(Object.keys(response.headers), ['X-From', 'set-cookie'])
  // A repeated header arrives joined already, by the upstream client: the core leaves it as it is
  assert.equal(response.headers['set-cookie'], 'a=1, b=2')
  assert.deepEqual(response.body, Buffer.from('abc'))
})

test('the log says what passthrough did, and what went wrong', async (t) => {
  const logs = captureLogs(t)
  /** The records written since the last call, debug left out */
  const said = () => logs.records.splice(0).filter((record) => record.level !== 'debug')
  let failure: Error | null = null
  const upstream = fakeUpstream((request) => {
    if (failure !== null) throw failure
    return backend(request)
  })
  const { core, manager } = env(t, { upstream })
  configure(manager, 'GET:/api/feed', { mode: 'passthrough' })
  const ask = () =>
    answer(core, { method: 'GET', scheme: 'https', host: 'api.example.com', path: '/api/feed' })
  const passing = [
    {
      level: 'info',
      logger: 'tunnel.core',
      message: 'GET api.example.com/api/feed -> passthrough',
    },
    {
      level: 'info',
      logger: 'tunnel.core',
      message: 'Passing GET https://api.example.com/api/feed through',
    },
  ]

  // What it did
  await ask()
  assert.deepEqual(said(), passing)

  // An upstream that cannot be reached: a warning, and the 502 says the same
  failure = new UpstreamError('boom')
  const unreachable = await ask()
  const warning = 'Could not reach https://api.example.com: boom'
  assert.deepEqual(said(), [
    ...passing,
    { level: 'warning', logger: 'tunnel.core', message: warning },
  ])
  assert.equal(unreachable.status, 502)
  assert.equal(detail(unreachable), warning)

  // Anything else: an error with the stack under it, and a 500 that leaves the stack out
  failure = new Error('kaput')
  const broken = await ask()
  const records = said()
  assert.deepEqual(records.slice(0, 2), passing)
  assert.equal(records.length, 3)
  const { level, logger, message } = records[2]!
  assert.equal(level, 'error')
  assert.equal(logger, 'tunnel.core')
  assert.ok(message.startsWith('Failed to answer GET:api.example.com/api/feed: kaput\n'), message)
  assert.ok(message.includes('Error: kaput'), message)
  assert.ok(message.includes('\n    at '), message)
  assert.equal(broken.status, 500)
  assert.equal(detail(broken), 'Failed to answer GET:api.example.com/api/feed: kaput')
})

test('the upstream address: a base target, a target with a path, a target that is not an address, and the query', async (t) => {
  const { core, manager } = env(t)
  /** The answer to GET api.example.com/api/feed, passed through to `target` */
  const through = (target: string, query: Record<string, string> = {}) => {
    configure(manager, 'GET:/api/feed', { mode: 'passthrough', target })
    return answer(core, { method: 'GET', host: 'api.example.com', path: '/api/feed', query })
  }
  const urlOf = async (target: string, query?: Record<string, string>) =>
    (payload(await through(target, query)) as Echo).url

  // A base URL, with its slash or without: the request's path goes after it
  assert.equal(await urlOf('http://other/'), 'http://other/api/feed')
  assert.equal(await urlOf('http://other'), 'http://other/api/feed')
  // '//' is a path of its own, so the target is used as it is, and the query after it
  assert.equal(await urlOf('http://other//', { a: '1' }), 'http://other//?a=1')

  // An address with no http(s) scheme: the upstream client refuses it, and the 502 names the
  // origin the request was going to, not the target
  const local = await through('localhost:3000')
  assert.equal(local.status, 502)
  assert.equal(
    detail(local),
    'Could not reach http://api.example.com: Unsupported protocol in localhost:3000: only http ' +
      'and https can be forwarded',
  )
  // Not an address at all: the whole of it is taken for a path, so it goes as it is
  const nonsense = await through('nonsense')
  assert.equal(nonsense.status, 502)
  assert.equal(detail(nonsense), 'Could not reach http://api.example.com: Invalid URL: nonsense')

  // The query the way urlencode writes it: a space is '+', '~' stays as it is, '*' does
  // not, and the hex is upper case
  assert.equal(
    await urlOf('', { q: 'a b&c~*', ü: '1' }),
    'http://api.example.com/api/feed?q=a+b%26c~%2A&%C3%BC=1',
  )
})

test('an upstream that claims gzip but is not is a 500', async (t) => {
  const logs = captureLogs(t)
  const upstream = fakeUpstream(() => ({
    status: 200,
    headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
    body: Buffer.from('not gzip'),
  }))
  const { core, manager } = env(t, { upstream })
  configure(manager, 'GET:/api/feed', { mode: 'passthrough' })

  const response = await answer(core, { method: 'GET', host: 'api.example.com', path: '/api/feed' })

  // zlib's error is no UpstreamError: the answer came, and it was tunnel that could not read it
  assert.equal(response.status, 500)
  assert.ok(detail(response).startsWith('Failed to answer GET:api.example.com/api/feed: '))
  const errors = logs.records.filter((record) => record.level === 'error')
  assert.equal(errors.length, 1)
  assert.equal(errors[0]!.logger, 'tunnel.core')
})

test('the constructor takes every collaborator as an option and builds the rest itself', async (t) => {
  // Every core here is closed before the directories go, as env's is
  const cores: TunnelCore[] = []
  t.after(async () => {
    for (const core of cores) await core.close()
  })
  const manager = new TunnelConfigManager(Paths.inOneDirectory(tmpDir(t)))
  const coreWith = (options?: TunnelCoreOptions) => {
    const core = new TunnelCore(manager, options)
    cores.push(core)
    return core
  }

  // Nothing given: it builds each of them itself. Routes read nothing until a request asks them
  // for one, so building the real ones does not look at this machine's proxy settings
  const built = coreWith()
  assert.equal(typeof built.upstream.send, 'function')
  assert.equal(typeof built.upstream.close, 'function')
  assert.ok(built.exchanges instanceof ExchangeLog)
  assert.ok(built.recordings instanceof RecordingStore)
  assert.ok(built.scripts instanceof ScriptRunner)
  assert.ok(built.routes instanceof UpstreamRoutes)
  assert.equal(built.routes.ownProxyPort, null)

  // Each one given is the one it keeps
  const exchanges = new ExchangeLog(manager)
  const recordings = new RecordingStore(manager)
  const scripts = new ScriptRunner(recordings)
  const routes = testRoutes()
  const upstream = fakeUpstream(backend)
  const given = coreWith({ exchanges, recordings, scripts, routes, upstream })
  assert.equal(given.exchanges, exchanges)
  assert.equal(given.recordings, recordings)
  assert.equal(given.scripts, scripts)
  assert.equal(given.routes, routes)
  assert.equal(given.upstream, upstream)

  // Only the store given: the ScriptRunner the core builds reads the recordings through it. The
  // store files them in a directory of its own, where a store of the core's own making would find
  // nothing, so { n: 1 } can only have come through the one given
  const store = new RecordingStore(new TunnelConfigManager(Paths.inOneDirectory(tmpDir(t))))
  const core = coreWith({ recordings: store })
  const exchange = {
    seq: 1,
    kind: 'http',
    request: { method: 'GET', host: 'api.example.com', path: '/api/feed', query: {} },
    response: {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: { v: 1 },
      body_encoding: 'json',
    },
  }
  await store.importExchanges([exchange], 'default')
  configure(manager, 'GET:/api/feed', {
    mode: 'script',
    script: 'function handler(ctx) { return { n: ctx.recordings().length } }',
  })

  const response = await answer(core, { method: 'GET', host: 'api.example.com', path: '/api/feed' })

  assert.deepEqual(payload(response), { n: 1 })
})

test('a 502 through a proxy says which proxy', async (t) => {
  const logs = captureLogs(t)
  const refused = new UpstreamError('connect ECONNREFUSED 127.0.0.1:3128', {
    via: 'the proxy 127.0.0.1:3128 (system proxy)',
  })
  const upstream = fakeUpstream(() => {
    throw refused
  })
  const { core, manager } = env(t, { upstream })
  configure(manager, 'GET:/api/feed', { mode: 'passthrough' })

  const response = await answer(core, {
    method: 'GET',
    scheme: 'https',
    host: 'api.example.com',
    path: '/api/feed',
  })

  const said =
    'Could not reach https://api.example.com through the proxy 127.0.0.1:3128 (system proxy): ' +
    'connect ECONNREFUSED 127.0.0.1:3128'
  assert.equal(response.status, 502)
  assert.equal(detail(response), said)
  const warnings = logs.records.filter((record) => record.level === 'warning')
  assert.deepEqual(
    warnings.map(({ logger, message }) => [logger, message]),
    [['tunnel.core', said]],
  )
})
