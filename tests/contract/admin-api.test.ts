// Black-box tests of the admin port. They run against a real `tunnel serve`, started by
// tests/support/target.ts, and look only at what comes back over the wire.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startServer } from '../support/target.ts'

test('the admin API over the wire [slow]', async (t) => {
  // One server for all seven, rather than one each
  const { adminBase, proxyPort } = await startServer(t)

  await t.test('health has its keys in their order, and the proxy port it listens on', async () => {
    const response = await fetch(`${adminBase}/__admin__/health`)
    assert.equal(response.status, 200)
    const health = (await response.json()) as Record<string, unknown>
    // The keys, not their values
    assert.deepEqual(Object.keys(health).slice(0, 13), [
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
    ])
    // Last, the way out for what tunnel does not answer itself
    assert.deepEqual(Object.keys(health).slice(13), ['upstream'])
    assert.equal(typeof health.upstream, 'string')

    const proxy = health.proxy as { host: unknown; port: unknown; lan_ips: unknown }
    assert.deepEqual(Object.keys(proxy), ['host', 'port', 'lan_ips'])
    assert.equal(proxy.host, '127.0.0.1')
    assert.equal(proxy.port, proxyPort)
    assert.ok(Array.isArray(proxy.lan_ips))
  })

  await t.test('a field a rule does not have is a 422 naming the field', async () => {
    const response = await fetch(`${adminBase}/__admin__/mocks`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'GET:/a', mode: 'json', nope: 1 }),
    })
    assert.equal(response.status, 422)
    // Byte for byte: JSON.stringify puts no space in
    assert.equal(
      await response.text(),
      '{"detail":[{"type":"extra_forbidden","loc":["body","nope"],' +
        '"msg":"Extra inputs are not permitted","input":1}]}',
    )
  })

  await t.test('a key that is not one is a 400 saying what the shape is', async () => {
    const response = await fetch(`${adminBase}/__admin__/mocks`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'nonsense', mode: 'json' }),
    })
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), {
      detail:
        "'nonsense' is not a valid request key (no method and path separated by ':'); the shape " +
        'is METHOD:[host[:port]]/path, for example GET:/api/feed or GET:api.example.com/api/feed',
    })
  })

  await t.test('a method a path does not have is a 405 naming the one it has', async () => {
    const response = await fetch(`${adminBase}/__admin__/health`, { method: 'POST' })
    assert.equal(response.status, 405)
    assert.deepEqual(await response.json(), { detail: 'Method Not Allowed' })
    assert.equal(response.headers.get('allow'), 'GET')
  })

  await t.test('a path nothing is at is a 404 in JSON', async () => {
    const response = await fetch(`${adminBase}/nope`)
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { detail: 'Not Found' })
    assert.equal(response.headers.get('content-type'), 'application/json')
  })

  await t.test('the certificate comes as a file to save', async () => {
    const response = await fetch(`${adminBase}/ca.pem`)
    await response.arrayBuffer()
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/x-x509-ca-cert')
    assert.equal(
      response.headers.get('content-disposition'),
      'attachment; filename="tunnel-ca.pem"',
    )
  })

  await t.test('the panel loads nothing from anywhere but the admin port', async () => {
    const response = await fetch(`${adminBase}/`)
    const html = await response.text()
    assert.equal(response.status, 200)
    // Not the charset's case: a charset name is case-insensitive
    const type = response.headers.get('content-type') ?? ''
    assert.ok(type.toLowerCase().startsWith('text/html'), type)
    const links = [...html.matchAll(/\b(?:src|href)="([^"]*)"/g)].map((match) => match[1]!)
    // Some, so that none of them being absolute says something
    assert.ok(links.length > 0, html)
    assert.deepEqual(
      links.filter((link) => /^https?:\/\//.test(link)),
      [],
    )
  })
})
