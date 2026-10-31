// src/messages.ts: Request and Response, with DEFAULT_PORTS and what is worked
// out from a request. urlencode is held to the spelling of each query in the
// golden file tests/fixtures/requests/urlencode.json.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { parseJson, stringifySpaced } from '../src/json.ts'
import {
  DEFAULT_PORTS,
  effectivePort,
  errorResponse,
  jsonResponse,
  makeRequest,
  makeResponse,
  origin,
  overrideHeaders,
  requestKey,
  requestUrl,
  textResponse,
  urlencode,
} from '../src/messages.ts'

test('makeRequest fills in the defaults and lower-cases the host', () => {
  const request = makeRequest()
  // The fields in the order Request declares them
  assert.deepEqual(Object.keys(request), [
    'method',
    'scheme',
    'host',
    'port',
    'path',
    'query',
    'headers',
    'body',
    'client',
    'gave_up',
  ])
  const { gave_up, ...fields } = request
  assert.deepEqual(fields, {
    method: 'GET',
    scheme: 'http',
    host: '',
    port: null,
    path: '/',
    query: {},
    headers: {},
    body: Buffer.alloc(0),
    client: '',
  })
  assert.equal(gave_up(), false)

  assert.equal(makeRequest({ host: 'API.Example.com' }).host, 'api.example.com')

  // Every request gets a query, headers and body of its own, and keeps the query and headers
  // it is given
  const other = makeRequest()
  assert.notEqual(other.query, request.query)
  assert.notEqual(other.headers, request.headers)
  assert.notEqual(other.body, request.body)
  const query = { page: '2' }
  const headers = { accept: '*/*' }
  const given = makeRequest({ query, headers })
  assert.equal(given.query, query)
  assert.equal(given.headers, headers)

  // A field given as undefined is a field not given
  const { gave_up: stillWaiting, ...defaults } = makeRequest({
    method: undefined,
    host: undefined,
    port: undefined,
    query: undefined,
    body: undefined,
    gave_up: undefined,
  })
  assert.deepEqual(defaults, fields)
  assert.equal(stillWaiting(), false)
})

test('makeResponse fills in the defaults', () => {
  const response = makeResponse()
  assert.deepEqual(Object.keys(response), [
    'status',
    'headers',
    'body',
    'close',
    'replay_seq',
    'unmatched',
  ])
  assert.deepEqual(response, {
    status: 200,
    headers: {},
    body: Buffer.alloc(0),
    close: false,
    replay_seq: null,
    unmatched: false,
  })
  const other = makeResponse()
  assert.notEqual(other.headers, response.headers)
  assert.notEqual(other.body, response.body)
  assert.deepEqual(makeResponse({ status: undefined, replay_seq: undefined }), response)
  assert.deepEqual(makeResponse({ status: 404, unmatched: true }), {
    ...response,
    status: 404,
    unmatched: true,
  })
})

test("effectivePort falls back to the scheme's default port, and to 80 for a scheme it does not know", () => {
  assert.deepEqual(DEFAULT_PORTS, { http: 80, https: 443 })
  assert.ok(Object.isFrozen(DEFAULT_PORTS))
  for (const port of [null, 0]) {
    assert.equal(effectivePort(makeRequest({ scheme: 'https', port })), 443)
    assert.equal(effectivePort(makeRequest({ scheme: 'http', port })), 80)
    assert.equal(effectivePort(makeRequest({ scheme: 'ftp', port })), 80)
    // Not the constructor that Object.prototype holds under that name
    assert.equal(effectivePort(makeRequest({ scheme: 'constructor', port })), 80)
  }
  assert.equal(effectivePort(makeRequest({ scheme: 'https', port: 8443 })), 8443)
})

test("origin writes the port only when it is not the scheme's default", () => {
  const at = (scheme: string, host: string, port: number | null) =>
    origin(makeRequest({ scheme, host, port }))
  assert.equal(at('https', 'api.example.com', 443), 'https://api.example.com')
  assert.equal(at('http', 'api.example.com', 8080), 'http://api.example.com:8080')
  // A scheme with no default port gets its port written, even 80
  assert.equal(at('ftp', 'files.example.com', 21), 'ftp://files.example.com:21')
  assert.equal(at('ftp', 'files.example.com', 80), 'ftp://files.example.com:80')
  // No port, or 0, is whatever the scheme implies
  assert.equal(at('https', 'api.example.com', null), 'https://api.example.com')
  assert.equal(at('ftp', 'files.example.com', 0), 'ftp://files.example.com')
})

test('urlencode writes each query as urlencode.json spells it, and requestUrl adds a query only when there is one', () => {
  const rows: { query: Record<string, string>; urlencode: string }[] = JSON.parse(
    readFileSync(new URL('./fixtures/requests/urlencode.json', import.meta.url), 'utf8'),
  )
  // So that a file read as empty, or cut short, cannot pass
  assert.equal(rows.length, 8)
  for (const row of rows) {
    assert.equal(urlencode(row.query), row.urlencode, JSON.stringify(row.query))
  }
  // A lone surrogate is written as U+FFFD. The proxy port has replaced it by the time a query
  // gets here.
  assert.equal(urlencode({ s: String.fromCharCode(0xd800) }), 's=%EF%BF%BD')

  const request = makeRequest({ host: 'cdn.example.com', port: 8080, path: '/img.png' })
  assert.equal(requestUrl(request), 'http://cdn.example.com:8080/img.png')
  request.query = { w: '64', fit: 'a b' }
  assert.equal(requestUrl(request), 'http://cdn.example.com:8080/img.png?w=64&fit=a+b')
})

test('requestKey is METHOD:host/path', () => {
  const request = makeRequest({
    method: 'POST',
    scheme: 'https',
    host: 'API.Example.com',
    port: 8443,
    path: '/v5/search',
    query: { page: '2' },
  })
  assert.equal(requestKey(request), 'POST:api.example.com/v5/search')
})

// overrideHeaders, jsonResponse, textResponse and errorResponse, which build the answers tunnel
// writes itself.

test("overrideHeaders replaces a header by its lower-cased name and keeps the override's spelling", () => {
  const headers = { 'Content-Type': 'a', 'x-a': '1' }
  const merged = overrideHeaders(headers, { 'content-type': 'b' })
  assert.deepEqual(merged, { 'x-a': '1', 'content-type': 'b' })
  // The header replaced is taken out and the override comes after the rest
  assert.deepEqual(Object.keys(merged), ['x-a', 'content-type'])
  assert.deepEqual(headers, { 'Content-Type': 'a', 'x-a': '1' })
  // Nothing to override gives back headers itself, not a copy
  const nothing: (Record<string, string> | null | undefined)[] = [null, undefined, {}]
  for (const overrides of nothing) {
    assert.equal(overrideHeaders(headers, overrides), headers)
  }
  // Parsed rather than written as a literal, where "__proto__" would set the prototype: a header
  // of that name is a header like any other
  const proto: Record<string, string> = JSON.parse('{"__proto__": "x"}')
  assert.deepEqual(Object.entries(overrideHeaders({ 'x-a': '1' }, proto)), [
    ['x-a', '1'],
    ['__proto__', 'x'],
  ])
})

test('jsonResponse writes the payload as stringifySpaced does, as application/json', () => {
  const payload = { a: [1, { b: null }], c: 'x' }
  const response = jsonResponse(payload)
  assert.equal(response.body.toString('utf8'), stringifySpaced(payload))
  // 200 by default, and makeResponse's defaults for the rest
  assert.deepEqual(
    response,
    makeResponse({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{"a": [1, {"b": null}], "c": "x"}', 'utf8'),
    }),
  )
  // A content-type given is the one sent, spelled the way it was given
  const problem = jsonResponse({}, 400, { 'Content-Type': 'application/problem+json' })
  assert.deepEqual(Object.keys(problem.headers), ['Content-Type'])
  assert.equal(problem.status, 400)
  // An integer past 2^53 keeps every digit
  const big = jsonResponse(parseJson('{"id": 12345678901234567890}'))
  assert.equal(big.body.toString('utf8'), '{"id": 12345678901234567890}')
})

test('textResponse is UTF-8 text/plain', () => {
  const response = textResponse('héllo', 404, { 'x-a': '1' })
  assert.equal(response.status, 404)
  assert.deepEqual(response.body, Buffer.from('héllo', 'utf8'))
  assert.deepEqual(response.headers, { 'content-type': 'text/plain; charset=utf-8', 'x-a': '1' })
  assert.equal(textResponse('ok').status, 200)
})

test('errorResponse has the {"detail": …} shape every tunnel error has', () => {
  const response = errorResponse(404, 'nope')
  assert.equal(response.status, 404)
  assert.equal(response.body.toString(), '{"detail": "nope"}')
  assert.deepEqual(response.headers, { 'content-type': 'application/json' })
})
