// The management API: patching one field at a time, applying a scenario,
// canonical keys, and resetting script state.
//
// The API configures; the core answers. Where a test has to see a rule actually
// take effect it asks the core directly, the way the proxy port will.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test, type TestContext } from 'node:test'
import { createAdminApp } from '../src/app.ts'
import type { Response as TunnelResponse } from '../src/messages.ts'
import { VERSION } from '../src/package-info.ts'
import { makeAdminEnv } from './support/admin-env.ts'
import { jsonAnswer } from './support/fake-upstream.ts'
import { testRoutes } from './support/routes.ts'

/** The API and the core it configures, so a test can configure and then ask */
const makeEnv = (t: TestContext) =>
  // Nothing here may reach a network: passthrough, which is what answers a request with no rule,
  // goes to a stand-in that reports the URL instead
  makeAdminEnv(t, { upstream: (request) => jsonAnswer({ upstream: request.url }, 599) })

const payload = (response: TunnelResponse) => JSON.parse(response.body.toString())

/** A script that fails to compile on line 1. Only "syntax error" and "line 1" are asserted on: the
 *  rest of the message is V8's, which changes between Node versions */
const BROKEN_SCRIPT = 'function handler(ctx {\n  return {}\n}\n'

test('health reports counts and directories', async (t) => {
  const env = await makeEnv(t)
  await env.json('PATCH', '/__admin__/mocks', {
    key: 'GET:/api/feed',
    mode: 'json',
    json_response: { a: 1 },
  })

  const data = (await env.json('GET', '/__admin__/health')).body

  assert.equal(data.status, 'ok')
  assert.equal(data.mocks, 1)
  // Which tunnel this is: a client's test setup checks it before it trusts
  // the answers it gets.
  assert.equal(data.version, VERSION)
  // "where did my mocks go" has to be answerable from the server itself
  assert.equal(data.config_dir, env.manager.paths.config_dir)
  assert.equal(data.state_dir, env.manager.paths.state_dir)
  assert.equal(data.data_dir, env.manager.paths.data_dir)
})

// `exchanges` is a count; the window is what a cached row is checked against.
//
// A client holding rows of its own — the panel, or a test that listed them —
// drops everything below `first_seq`, because the server no longer has it.
test('health reports which seqs the log holds', async (t) => {
  const env = await makeEnv(t)
  for (let number = 0; number < 3; number++) await env.send({ path: `/api/${number}` })

  const data = (await env.json('GET', '/__admin__/health')).body

  assert.equal(data.exchanges, 3)
  assert.equal(data.first_seq, env.core.exchanges.firstSeq)
  assert.equal(env.core.exchanges.firstSeq, 1)
  assert.equal(data.last_seq, env.core.exchanges.lastSeq)
  assert.equal(env.core.exchanges.lastSeq, 3)
})

test('patch creates mock and the core answers with it', async (t) => {
  const env = await makeEnv(t)
  const resp = await env.json('PATCH', '/__admin__/mocks', {
    key: 'GET:/api/feed',
    mode: 'json',
    json_response: { code: 0, list: [] },
    status_code: 201,
  })
  assert.equal(resp.status, 200)
  assert.equal(resp.body.mock.key, 'GET:/api/feed')

  const served = await env.send({ path: '/api/feed' })
  assert.equal(served.status, 201)
  assert.deepEqual(payload(served), { code: 0, list: [] })
})

// status_code on its own must not reset the script or the description
test('patch is incremental', async (t) => {
  const env = await makeEnv(t)
  const script = 'function handler(ctx) {\n  return { ok: true }\n}\n'
  await env.json('PATCH', '/__admin__/mocks', {
    key: 'GET:/api/feed',
    mode: 'script',
    script,
    description: 'feed mock',
    response_delay: 0.5,
  })

  await env.json('PATCH', '/__admin__/mocks', { key: 'GET:/api/feed', status_code: 418 })

  const mock = (await env.json('GET', '/__admin__/mocks?key=GET:/api/feed')).body.mocks[0]
  assert.equal(mock.status_code, 418)
  assert.equal(mock.script, script)
  assert.equal(mock.description, 'feed mock')
  assert.equal(mock.response_delay, 0.5)
})

test('the method is normalized to upper case', async (t) => {
  const env = await makeEnv(t)
  await env.json('PATCH', '/__admin__/mocks', {
    key: 'get:/api/feed',
    mode: 'json',
    json_response: { x: 1 },
  })

  assert.deepEqual(payload(await env.send({ path: '/api/feed' })), { x: 1 })
})

test('a host key is stored lower case and answers for that host', async (t) => {
  const env = await makeEnv(t)
  await env.json('PATCH', '/__admin__/mocks', {
    key: 'GET:API.Example.com/api/feed',
    mode: 'json',
    json_response: { x: 1 },
  })

  const mocks = (await env.json('GET', '/__admin__/mocks')).body.mocks
  const keys = mocks.map((m: { key: string }) => m.key)
  assert.deepEqual(keys, ['GET:api.example.com/api/feed'])
  assert.deepEqual(payload(await env.send({ path: '/api/feed', host: 'api.example.com' })), {
    x: 1,
  })
  // Another host has no rule, so the default mode passes it through untouched
  const elsewhere = await env.send({ path: '/api/feed', host: 'other.example.com' })
  assert.deepEqual(payload(elsewhere), { upstream: 'http://other.example.com/api/feed' })
})

test('bad key and unknown field are rejected', async (t) => {
  const env = await makeEnv(t)
  const bad = await env.json('PATCH', '/__admin__/mocks', { key: 'api/feed', mode: 'json' })

  assert.equal(bad.status, 400)
  assert.ok(bad.body.detail.includes('METHOD:[host[:port]]/path'))
  const unknown = await env.json('PATCH', '/__admin__/mocks', { key: 'GET:/a', stat_code: 200 })
  assert.equal(unknown.status, 422)
})

test('script syntax error rejected with line', async (t) => {
  const env = await makeEnv(t)
  const resp = await env.json('PATCH', '/__admin__/mocks', {
    key: 'GET:/api/feed',
    mode: 'script',
    script: BROKEN_SCRIPT,
  })
  assert.equal(resp.status, 400)
  assert.ok(resp.body.detail.includes('syntax error'))
  assert.ok(resp.body.detail.includes('line 1'))
})

test('deleting a mock', async (t) => {
  const env = await makeEnv(t)
  await env.json('PATCH', '/__admin__/mocks', {
    key: 'GET:/api/feed',
    mode: 'json',
    json_response: { a: 1 },
  })

  assert.equal((await env.json('DELETE', '/__admin__/mocks?key=GET:/api/feed')).status, 200)
  assert.equal((await env.json('DELETE', '/__admin__/mocks?key=GET:/api/feed')).status, 404)
  assert.deepEqual((await env.json('GET', '/__admin__/mocks')).body.mocks, [])
})

test('wildcard matching with exact priority', async (t) => {
  const env = await makeEnv(t)
  await env.json('POST', '/__admin__/mocks/apply', {
    mocks: [
      { key: 'GET:/api/user/*', mode: 'json', json_response: { who: 'wildcard' } },
      { key: 'GET:/api/user/me', mode: 'json', json_response: { who: 'exact' } },
    ],
  })

  assert.deepEqual(payload(await env.send({ path: '/api/user/123' })), { who: 'wildcard' })
  assert.deepEqual(payload(await env.send({ path: '/api/user/me' })), { who: 'exact' })
})

test('longer wildcard wins', async (t) => {
  const env = await makeEnv(t)
  await env.json('POST', '/__admin__/mocks/apply', {
    mocks: [
      { key: 'GET:/api/*', mode: 'json', json_response: { level: 'broad' } },
      { key: 'GET:/api/user/*', mode: 'json', json_response: { level: 'specific' } },
    ],
  })

  assert.deepEqual(payload(await env.send({ path: '/api/user/123' })), { level: 'specific' })
  assert.deepEqual(payload(await env.send({ path: '/api/other' })), { level: 'broad' })
})

test('apply is all or nothing', async (t) => {
  const env = await makeEnv(t)
  await env.json('PATCH', '/__admin__/mocks', {
    key: 'GET:/api/feed',
    mode: 'json',
    json_response: { v: 1 },
  })

  const resp = await env.json('POST', '/__admin__/mocks/apply', {
    mocks: [
      { key: 'GET:/api/a', mode: 'json', json_response: { v: 2 } },
      { key: 'GET:/api/b', mode: 'script', script: BROKEN_SCRIPT },
    ],
  })

  assert.equal(resp.status, 400)
  const mocks = (await env.json('GET', '/__admin__/mocks')).body.mocks
  const keys = mocks.map((m: { key: string }) => m.key)
  assert.deepEqual(keys, ['GET:/api/feed'])
})

test('apply replace clears existing', async (t) => {
  const env = await makeEnv(t)
  await env.json('PATCH', '/__admin__/mocks', {
    key: 'GET:/api/old',
    mode: 'json',
    json_response: { v: 1 },
  })

  await env.json('POST', '/__admin__/mocks/apply', {
    replace: true,
    config: { max_requests_history: 42 },
    mocks: [{ key: 'GET:/api/new', mode: 'json', json_response: { v: 2 } }],
  })

  const mocks = (await env.json('GET', '/__admin__/mocks')).body.mocks
  const keys = mocks.map((m: { key: string }) => m.key)
  assert.deepEqual(keys, ['GET:/api/new'])
  assert.equal((await env.json('GET', '/__admin__/config')).body.max_requests_history, 42)
})

// passthrough or replay — never a mode that needs a rule of its own
test('default_mode takes only the modes that answer unconfigured endpoints', async (t) => {
  const env = await makeEnv(t)
  const patch = (fields: object) => env.json('PATCH', '/__admin__/config', fields)

  assert.equal((await patch({ default_mode: 'passthrough' })).status, 200)
  assert.equal((await patch({ default_mode: 'replay' })).status, 200)
  assert.equal((await patch({ default_mode: 'json' })).status, 422)
})

// A scenario is applied per test case; it has no business moving the global mode
test('export leaves the global settings out by default', async (t) => {
  const env = await makeEnv(t)
  await env.json('PATCH', '/__admin__/mocks', {
    key: 'GET:/api/feed',
    mode: 'json',
    json_response: { v: 1 },
  })

  const byDefault = (await env.json('GET', '/__admin__/export')).body
  const withConfig = (await env.json('GET', '/__admin__/export?config=true')).body

  assert.ok(!('config' in byDefault))
  assert.deepEqual(withConfig.config, { default_mode: 'passthrough', session: 'default' })
})

// Which recordings this run replays, for the panel's header and for a scenario
test('health and export report the current session', async (t) => {
  const env = await makeEnv(t)

  await env.json('PATCH', '/__admin__/config', { session: 'acct_a' })

  assert.equal((await env.json('GET', '/__admin__/health')).body.session, 'acct_a')
  const exported = (await env.json('GET', '/__admin__/export?config=true')).body
  assert.equal(exported.config.session, 'acct_a')
})

test('export round trips through apply', async (t) => {
  const env = await makeEnv(t)
  await env.json('PATCH', '/__admin__/mocks', {
    key: 'GET:api.example.com/api/feed',
    mode: 'json',
    json_response: { v: 1 },
    description: 'feed',
  })
  const exported = (await env.json('GET', '/__admin__/export')).body

  await env.json('POST', '/__admin__/mocks/apply', { replace: true, ...exported })

  assert.deepEqual((await env.json('GET', '/__admin__/export')).body, exported)
})

test('state reset', async (t) => {
  const env = await makeEnv(t)
  await env.json('PATCH', '/__admin__/mocks', {
    key: 'GET:/api/poll',
    mode: 'script',
    script:
      'function handler(ctx) {\n  ctx.state.n = (ctx.state.n ?? 0) + 1\n  return { n: ctx.state.n }\n}\n',
  })

  assert.equal(payload(await env.send({ path: '/api/poll' })).n, 1)
  assert.equal(payload(await env.send({ path: '/api/poll' })).n, 2)

  const cleared = (await env.json('POST', '/__admin__/state/reset', { key: 'GET:/api/poll' })).body
  assert.deepEqual(cleared.cleared, ['GET:/api/poll'])
  assert.equal(payload(await env.send({ path: '/api/poll' })).n, 1)
})

// A wildcard rule buckets its state under the configured key, so reset clears it
test('wildcard script shares one state bucket', async (t) => {
  const env = await makeEnv(t)
  await env.json('PATCH', '/__admin__/mocks', {
    key: 'GET:/api/task/*',
    mode: 'script',
    script:
      'function handler(ctx) {\n  ctx.state.n = (ctx.state.n ?? 0) + 1\n  return { n: ctx.state.n, path: ctx.path }\n}\n',
  })

  assert.equal(payload(await env.send({ path: '/api/task/1' })).n, 1)
  assert.deepEqual(payload(await env.send({ path: '/api/task/2' })), { n: 2, path: '/api/task/2' })

  await env.json('POST', '/__admin__/state/reset', {})
  assert.equal(payload(await env.send({ path: '/api/task/9' })).n, 1)
})

test('requests listing and clear', async (t) => {
  const env = await makeEnv(t)
  await env.json('PATCH', '/__admin__/mocks', {
    key: 'GET:/api/feed',
    mode: 'json',
    json_response: { v: 1 },
  })
  await env.send({ path: '/api/feed', host: 'api.example.com' })
  await env.send({ path: '/api/other', host: 'api.example.com' })

  const records = (await env.json('GET', '/__admin__/requests')).body.requests
  const byKey = Object.fromEntries(records.map((r: { key: string }) => [r.key, r]))

  // The key a request is recorded under carries the host it was going to
  assert.equal(byKey['GET:api.example.com/api/feed'].host, 'api.example.com')
  assert.equal(byKey['GET:api.example.com/api/feed'].configured, true)
  assert.equal(byKey['GET:api.example.com/api/feed'].matched_by, 'GET:/api/feed')
  assert.equal(byKey['GET:api.example.com/api/other'].configured, false)

  await env.json('POST', '/__admin__/requests/clear')
  assert.deepEqual((await env.json('GET', '/__admin__/requests')).body.requests, [])
})

// ---------------------------------------------------------------- the CA

// Which CA the devices on this network should be trusting right now
test('health reports the ca_fingerprint', async (t) => {
  const env = await makeEnv(t)

  const fingerprint = (await env.json('GET', '/__admin__/health')).body.ca_fingerprint

  assert.equal(fingerprint, (await env.json('GET', '/__admin__/ca')).body.fingerprint)
  assert.ok(existsSync(env.manager.paths.caFile))
})

// The content type is what makes iOS and Android offer to install the file
test('/ca.pem downloads as a certificate', async (t) => {
  const env = await makeEnv(t)

  const resp = await env.fetch('/ca.pem')
  const content = Buffer.from(await resp.arrayBuffer())

  assert.equal(resp.status, 200)
  assert.ok(resp.headers.get('content-type')?.startsWith('application/x-x509-ca-cert'))
  assert.deepEqual(content, readFileSync(env.manager.paths.caFile))
  assert.ok(content.toString('utf8').startsWith('-----BEGIN CERTIFICATE-----'))
})

test('the CA endpoint reports the fingerprint, validity and paths', async (t) => {
  const env = await makeEnv(t)

  const info = (await env.json('GET', '/__admin__/ca')).body

  assert.equal(info.ca_file, env.manager.paths.caFile)
  assert.equal(info.ca_key_file, env.manager.paths.caKeyFile)
  assert.ok(info.subject.includes('tunnel CA '))
  assert.ok(info.not_after > info.not_before)
})

// Resetting the files alone would leave the server signing with the old CA
test('a CA reset replaces the certificate in the running server', async (t) => {
  const env = await makeEnv(t)
  const before = (await env.json('GET', '/__admin__/ca')).body.fingerprint

  const after = (await env.json('POST', '/__admin__/ca/reset')).body

  assert.equal(after.success, true)
  assert.notEqual(after.fingerprint, before)
  const pem = Buffer.from(await (await env.fetch('/ca.pem')).arrayBuffer())
  assert.deepEqual(pem, readFileSync(env.manager.paths.caFile))
  assert.equal((await env.json('GET', '/__admin__/health')).body.ca_fingerprint, after.fingerprint)
})

// ---------------------------------------------------------------- refusals, edge cases and health

/** One bad request and the one issue it is answered with */
interface BadInput {
  name: string
  send: (env: Awaited<ReturnType<typeof makeEnv>>) => Promise<Response>
  issue: { type: string; loc: (string | number)[]; msg: string; input: unknown; ctx?: object }
}

/** A PATCH /__admin__/mocks with this body, as JSON unless another content type is given */
const patchMocks = (
  body?: string,
  contentType: string | null = 'application/json',
): RequestInit => ({
  method: 'PATCH',
  headers: contentType === null ? {} : { 'content-type': contentType },
  body,
})

const BAD_INPUTS: BadInput[] = [
  {
    name: 'no body',
    send: (env) => env.fetch('/__admin__/mocks', patchMocks(undefined, null)),
    issue: { type: 'missing', loc: ['body'], msg: 'Field required', input: null },
  },
  {
    name: 'a JSON null',
    send: (env) => env.fetch('/__admin__/mocks', patchMocks('null')),
    issue: { type: 'missing', loc: ['body'], msg: 'Field required', input: null },
  },
  {
    name: 'a body that is not JSON by its content type',
    send: (env) => env.fetch('/__admin__/mocks', patchMocks('{"key": "GET:/a"}', 'text/plain')),
    issue: {
      type: 'model_attributes_type',
      loc: ['body'],
      msg: 'Input should be a valid dictionary or object to extract fields from',
      input: '{"key": "GET:/a"}',
    },
  },
  {
    name: 'JSON that is not an object',
    send: (env) => env.fetch('/__admin__/mocks', patchMocks('[1]')),
    issue: {
      type: 'model_attributes_type',
      loc: ['body'],
      msg: 'Input should be a valid dictionary or object to extract fields from',
      input: [1],
    },
  },
  {
    name: 'a field the model does not have',
    send: (env) => env.fetch('/__admin__/mocks', patchMocks('{"key": "GET:/a", "stat_code": 200}')),
    issue: {
      type: 'extra_forbidden',
      loc: ['body', 'stat_code'],
      msg: 'Extra inputs are not permitted',
      input: 200,
    },
  },
  {
    // The issue is the one validate.ts's int gives a null
    name: 'a null for a field that cannot be null',
    send: (env) =>
      env.fetch('/__admin__/mocks', patchMocks('{"key": "GET:/a", "status_code": null}')),
    issue: {
      type: 'int_type',
      loc: ['body', 'status_code'],
      msg: 'Input should be a valid integer',
      input: null,
    },
  },
  {
    name: 'a mode there is not',
    send: (env) => env.fetch('/__admin__/mocks', patchMocks('{"key": "GET:/a", "mode": "nope"}')),
    issue: {
      type: 'enum',
      loc: ['body', 'mode'],
      msg: "Input should be 'json', 'passthrough', 'script' or 'replay'",
      input: 'nope',
      ctx: { expected: "'json', 'passthrough', 'script' or 'replay'" },
    },
  },
  {
    name: 'a path parameter that is not an integer',
    send: (env) => env.fetch('/__admin__/requests/abc'),
    issue: {
      type: 'int_parsing',
      loc: ['path', 'seq'],
      msg: 'Input should be a valid integer, unable to parse string as an integer',
      input: 'abc',
    },
  },
  {
    name: 'a query parameter below its minimum',
    send: (env) => env.fetch('/__admin__/requests/wait?count=0'),
    issue: {
      type: 'greater_than_equal',
      loc: ['query', 'count'],
      msg: 'Input should be greater than or equal to 1',
      input: '0',
      ctx: { ge: 1 },
    },
  },
  {
    // An empty value is still a value, not a missing one
    name: 'a flag left empty',
    send: (env) => env.fetch('/__admin__/requests?each='),
    issue: {
      type: 'bool_parsing',
      loc: ['query', 'each'],
      msg: 'Input should be a valid boolean, unable to interpret input',
      input: '',
    },
  },
  {
    name: 'a required query parameter left out',
    send: (env) => env.fetch('/__admin__/mocks', { method: 'DELETE' }),
    issue: { type: 'missing', loc: ['query', 'key'], msg: 'Field required', input: null },
  },
]

// What the panel's detailOf, the CLI and the MCP tools read out of a 422, kind by kind. Bad JSON is
// asserted apart: where it stopped and why are V8's words
test('the 422 body is {detail: [issue]} for each kind of bad input', async (t) => {
  const env = await makeEnv(t)

  for (const { name, send, issue } of BAD_INPUTS) {
    const response = await send(env)
    assert.equal(response.status, 422, name)
    assert.deepEqual(await response.json(), { detail: [issue] }, name)
  }

  const broken = await env.fetch('/__admin__/mocks', patchMocks('{"key": "GET:/a",}'))
  assert.equal(broken.status, 422)
  const [issue, ...more] = ((await broken.json()) as { detail: any[] }).detail
  assert.deepEqual(more, [])
  assert.deepEqual(Object.keys(issue), ['type', 'loc', 'msg', 'input', 'ctx'])
  assert.equal(issue.type, 'json_invalid')
  assert.equal(issue.loc.length, 2)
  assert.equal(issue.loc[0], 'body')
  assert.equal(typeof issue.loc[1], 'number')
  assert.equal(issue.msg, 'JSON decode error')
  assert.deepEqual(issue.input, {})
  assert.deepEqual(Object.keys(issue.ctx), ['error'])
  assert.equal(typeof issue.ctx.error, 'string')
})

// The patch's own model refuses these, and says which field
test('a null in a patch is a 422, not a 500', async (t) => {
  const env = await makeEnv(t)
  const nulls: [string, string, object][] = [
    ['/__admin__/mocks', 'status_code', { key: 'GET:/a', status_code: null }],
    ['/__admin__/config', 'max_requests_history', { max_requests_history: null }],
    ['/__admin__/config', 'ssl_proxying', { ssl_proxying: null }],
  ]

  for (const [path, field, body] of nulls) {
    const resp = await env.json('PATCH', path, body)
    assert.equal(resp.status, 422, field)
    assert.deepEqual(
      resp.body.detail.map((issue: { loc: unknown }) => issue.loc),
      [['body', field]],
    )
  }
  assert.deepEqual((await env.json('GET', '/__admin__/mocks')).body.mocks, [])
})

// JSON.parse would round it to 12345678901234567000
test('an integer past 2^53 in json_response comes back with the same digits', async (t) => {
  const env = await makeEnv(t)
  const sent = await env.fetch(
    '/__admin__/mocks',
    patchMocks(
      '{"key": "GET:/api/big", "mode": "json", "json_response": {"id": 12345678901234567890}}',
    ),
  )
  assert.equal(sent.status, 200)

  for (const path of ['/__admin__/mocks', '/__admin__/export']) {
    const text = await (await env.fetch(path)).text()
    assert.ok(text.includes('{"id":12345678901234567890}'), `${path}: ${text}`)
  }
})

// validate.ts's int reads a seq into the double nearest it, which rounds past 2^53: the 404 names
// the seq with every digit of what was sent, written as an integer
test('a seq past 2^53 is named in the 404 with every digit it was sent with', async (t) => {
  const env = await makeEnv(t)

  for (const [sent, named] of [
    ['99999999999999999999', '99999999999999999999'],
    ['9007199254740993', '9007199254740993'],
    ['-99999999999999999999', '-99999999999999999999'],
    ['+099_999_999_999_999_999_999.00', '99999999999999999999'],
    ['0-99999999999999999999', '-99999999999999999999'],
    ['2.0', '2'],
    ['-1', '-1'],
  ]) {
    const request = await env.json('GET', `/__admin__/requests/${sent}`)
    assert.equal(request.status, 404, sent)
    assert.deepEqual(request.body, { detail: `No request with seq ${named} is in the log` }, sent)
    const recording = await env.json('GET', `/__admin__/recordings/default/${sent}`)
    assert.equal(recording.status, 404, sent)
    assert.deepEqual(
      recording.body,
      { detail: `No recording with seq ${named} in session default` },
      sent,
    )
  }
})

// The answers around the routes: a JSON 404 where nothing is, /docs, /redoc and /openapi.json
// included, and a JSON 405 naming the methods the path has. A HEAD on a GET route is answered
// without a body, and a trailing slash is a 404
test('an unknown path, a known path with the wrong method, and the docs paths', async (t) => {
  const env = await makeEnv(t)

  for (const path of [
    '/__admin__/nope',
    '/nope',
    '/favicon.ico',
    '/docs',
    '/redoc',
    '/openapi.json',
    '/__admin__/health/',
  ]) {
    const response = await env.fetch(path)
    assert.equal(response.status, 404, path)
    assert.equal(response.headers.get('content-type'), 'application/json', path)
    assert.deepEqual(await response.json(), { detail: 'Not Found' }, path)
  }

  for (const [method, path, allow] of [
    ['POST', '/__admin__/health', 'GET'],
    ['PUT', '/__admin__/mocks', 'GET, PATCH, DELETE'],
  ] as const) {
    const response = await env.fetch(path, { method })
    assert.equal(response.status, 405, `${method} ${path}`)
    assert.equal(response.headers.get('allow'), allow, `${method} ${path}`)
    assert.deepEqual(await response.json(), { detail: 'Method Not Allowed' }, `${method} ${path}`)
  }

  const head = await env.fetch('/__admin__/health', { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')
})

// Otherwise a bad session name would take every rule with it
test('apply checks the session before it clears anything', async (t) => {
  const env = await makeEnv(t)
  await env.json('PATCH', '/__admin__/mocks', {
    key: 'GET:/api/feed',
    mode: 'json',
    json_response: { v: 1 },
  })

  const resp = await env.json('POST', '/__admin__/mocks/apply', {
    replace: true,
    config: { session: 'bad name' },
    mocks: [{ key: 'GET:/api/new', mode: 'json', json_response: { v: 2 } }],
  })

  assert.equal(resp.status, 400)
  assert.ok(resp.body.detail.includes('is not a session name'))
  const mocks = (await env.json('GET', '/__admin__/mocks')).body.mocks
  assert.deepEqual(
    mocks.map((m: { key: string }) => m.key),
    ['GET:/api/feed'],
  )
  assert.equal((await env.json('GET', '/__admin__/config')).body.session, 'default')
})

// The keys in their order, the way out last. testRoutes() reads no environment variable and no
// system proxy, so the way is direct
test('health ends with the route the upstream traffic takes', async (t) => {
  const env = await makeAdminEnv(t)

  const data = (await env.json('GET', '/__admin__/health')).body

  assert.deepEqual(Object.keys(data), [
    'status',
    'version',
    'config_dir',
    'state_dir',
    'data_dir',
    'mocks',
    'exchanges',
    'first_seq',
    'last_seq',
    'ca_fingerprint',
    'proxy',
    'session',
    'recording',
    'upstream',
  ])
  assert.equal(data.upstream, 'direct')
})

// ALL_PROXY sends http and https the same way, so describe() says it once. Only the route is read:
// nothing connects to port 3128
test('health names the proxy when one is set', async (t) => {
  const env = await makeAdminEnv(t, {
    routes: testRoutes({ env: { ALL_PROXY: 'http://127.0.0.1:3128' } }),
  })

  const data = (await env.json('GET', '/__admin__/health')).body

  assert.equal(data.upstream, 'via http://127.0.0.1:3128 (ALL_PROXY)')
})

// Where devices point their proxy setting: what `tunnel serve` hands the admin port, the shape of
// ProxyServer.describe(), passed on as it is; null for the admin port alone, as in these tests
test('health says where the proxy port listens, and null without one', async (t) => {
  const env = await makeAdminEnv(t)
  const proxy = { host: '0.0.0.0', port: 8888, lan_ips: ['192.168.1.20'] }
  const served = createAdminApp({ ...env, proxy: () => proxy })

  const alone = (await env.json('GET', '/__admin__/health')).body
  const listening = (await (await served.request('/__admin__/health')).json()) as { proxy: unknown }

  assert.equal(alone.proxy, null)
  assert.deepEqual(listening.proxy, proxy)
})

/** The 422 with the one issue a query or path parameter, or a body, was refused for */
const refusedAs = (type: string, loc: string[], msg: string, input: unknown) => ({
  detail: [{ type, loc, msg, input }],
})
const NOT_AN_INT = 'Input should be a valid integer, unable to parse string as an integer'
const NOT_A_BOOL = 'Input should be a valid boolean, unable to interpret input'
const NOT_A_DICT = 'Input should be a valid dictionary or object to extract fields from'
const NOTHING_LOGGED = { requests: [], last_seq: 0, unmatched_count: 0 }
const NOT_A_SESSION = {
  detail:
    "'acct a' is not a session name; a session is a directory, so letters, digits, dot, " +
    'dash and underscore are what it can hold',
}

// Edge cases that no test above reaches: the settings patch with nothing in it, a mock not there,
// the parameters that are refused, ignored or taken as they are, the bodies that are not objects on
// the routes that have no other test of one, a session name that is no directory name, and what a
// body may leave out
test('the edge cases around the routes answer as listed', async (t) => {
  const env = await makeEnv(t)
  const cases: [string, string, unknown, number, unknown][] = [
    ['PATCH', '/__admin__/config', {}, 400, { detail: 'No fields to update' }],
    [
      'GET',
      '/__admin__/mocks?key=GET:/zzz',
      undefined,
      404,
      {
        detail: 'No mock is configured for GET:/zzz',
      },
    ],
    ['GET', '/__admin__/mocks?key=', undefined, 200, { mocks: [] }],
    [
      'POST',
      '/__admin__/mocks/apply',
      { mocks: [], config: null },
      200,
      {
        success: true,
        applied: [],
        replaced: false,
      },
    ],
    ['GET', '/__admin__/requests?last=-1', undefined, 200, NOTHING_LOGGED],
    ['GET', '/__admin__/requests?nope=1', undefined, 200, NOTHING_LOGGED],
    [
      'GET',
      '/__admin__/requests?each=maybe',
      undefined,
      422,
      refusedAs('bool_parsing', ['query', 'each'], NOT_A_BOOL, 'maybe'),
    ],
    [
      'GET',
      '/__admin__/requests/wait?count=1.5&timeout=0',
      undefined,
      422,
      refusedAs('int_parsing', ['query', 'count'], NOT_AN_INT, '1.5'),
    ],
    [
      'GET',
      '/__admin__/requests/wait?timeout=0',
      undefined,
      200,
      {
        seqs: [],
        count: 0,
        wanted: 1,
        timed_out: true,
        last_seq: 0,
      },
    ],
    [
      'GET',
      '/__admin__/events?since=x',
      undefined,
      422,
      refusedAs('int_parsing', ['query', 'since'], NOT_AN_INT, 'x'),
    ],
    [
      'GET',
      '/__admin__/export?config=maybe',
      undefined,
      422,
      refusedAs('bool_parsing', ['query', 'config'], NOT_A_BOOL, 'maybe'),
    ],
    [
      'POST',
      '/__admin__/state/reset',
      [1],
      422,
      refusedAs('model_attributes_type', ['body'], NOT_A_DICT, [1]),
    ],
    [
      'POST',
      '/__admin__/record/start',
      [1],
      422,
      refusedAs('model_attributes_type', ['body'], NOT_A_DICT, [1]),
    ],
    [
      'POST',
      '/__admin__/recordings/import',
      [1],
      422,
      refusedAs('model_attributes_type', ['body'], NOT_A_DICT, [1]),
    ],
    [
      'POST',
      '/__admin__/mocks/apply',
      [1],
      422,
      refusedAs('model_attributes_type', ['body'], NOT_A_DICT, [1]),
    ],
    [
      'GET',
      '/__admin__/recordings/default/1x',
      undefined,
      422,
      refusedAs('int_parsing', ['path', 'seq'], NOT_AN_INT, '1x'),
    ],
    ['GET', '/__admin__/recordings/acct%20a/1', undefined, 400, NOT_A_SESSION],
    // A rule's replay_session is held to a directory name as the current session is
    ['PATCH', '/__admin__/mocks', { key: 'GET:/a', replay_session: 'acct a' }, 400, NOT_A_SESSION],
    // What a body may leave out: a scenario's mocks, an import's session
    ['POST', '/__admin__/mocks/apply', {}, 200, { success: true, applied: [], replaced: false }],
    [
      'POST',
      '/__admin__/recordings/import',
      { exchanges: [] },
      200,
      { success: true, imported: 0, session: 'default', replaced: false },
    ],
  ]

  for (const [method, path, body, status, answer] of cases) {
    const response = await env.json(method, path, body)
    assert.equal(response.status, status, `${method} ${path}`)
    assert.deepEqual(response.body, answer, `${method} ${path}`)
  }
  // A session of null is the default one, as sessionName(null) has it
  await env.json('PATCH', '/__admin__/config', { session: 'other' })
  const patched = await env.json('PATCH', '/__admin__/config', { session: null })
  assert.equal(patched.status, 200)
  assert.equal(patched.body.config.session, 'default')
})
