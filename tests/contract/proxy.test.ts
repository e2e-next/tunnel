// Black-box tests of the proxy port. They run against a real `tunnel serve` and look only at
// what comes back over the wire, from its proxy port and its admin port.
//
// The server comes from startServer().
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { viaProxy } from '../support/proxy-client.ts'
import { startServer } from '../support/target.ts'

/** What GET /__admin__/health says, as far as these tests read it */
interface Health {
  ca_fingerprint: string
  proxy: { host: string; port: number; lan_ips: unknown }
}

test('a plain request through the proxy port is answered by the rule that matches [slow]', async (t) => {
  const { adminBase, proxyPort } = await startServer(t)
  const patched = await fetch(`${adminBase}/__admin__/mocks`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      key: 'GET:api.example.com/api/feed',
      mode: 'json',
      json_response: { cards: [] },
      status_code: 201,
    }),
  })
  assert.equal(patched.status, 200)

  const answer = await viaProxy(proxyPort, 'GET', 'http://api.example.com/api/feed')
  assert.equal(answer.status, 201)
  assert.deepEqual(answer.json(), { cards: [] })

  // The proxy's part of health is describe() as it goes out on the wire
  const health = (await (await fetch(`${adminBase}/__admin__/health`)).json()) as Health
  assert.deepEqual(Object.keys(health.proxy), ['host', 'port', 'lan_ips'])
  assert.equal(health.proxy.host, '127.0.0.1')
  assert.equal(health.proxy.port, proxyPort)
  assert.ok(Array.isArray(health.proxy.lan_ips))
})

test("ca.tunnel through the proxy port serves the install page and the admin port's certificate [slow]", async (t) => {
  const { adminBase, proxyPort } = await startServer(t)
  const health = (await (await fetch(`${adminBase}/__admin__/health`)).json()) as Health

  const page = await viaProxy(proxyPort, 'GET', 'http://ca.tunnel/')
  assert.equal(page.status, 200)
  assert.ok(page.headers['content-type']?.startsWith('text/html'), page.headers['content-type'])
  const html = page.body.toString('utf8')
  assert.ok(html.includes('Install the tunnel certificate'))
  assert.ok(html.includes(health.ca_fingerprint))

  // The certificate's bytes are at the admin port's /ca.pem: /__admin__/ca answers with the
  // CA's details as JSON
  const pem = await viaProxy(proxyPort, 'GET', 'http://ca.tunnel/ca.pem')
  const fromAdmin = Buffer.from(await (await fetch(`${adminBase}/ca.pem`)).arrayBuffer())
  assert.deepEqual(pem.body, fromAdmin)
})
