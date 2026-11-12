// The proxy port: what a device's traffic actually meets.
//
// A real listener on a random loopback port, with real clients going through it —
// Node's HTTP client sending the absolute-form for the everyday path, and a socket
// written to by hand where a test has to watch one connection carry several
// requests. Upstream is a fake in-process upstream, and the one host the proxy ever
// dials for real is a TLS server this file starts on 127.0.0.1, so nothing leaves
// the machine. The tests that need no listener call the module's functions directly.
import assert from 'node:assert/strict'
import { subscribe, unsubscribe } from 'node:diagnostics_channel'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { createServer, isIPv4, type AddressInfo } from 'node:net'
import { performance } from 'node:perf_hooks'
import type { Duplex } from 'node:stream'
import { test, type TestContext } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { connect as tlsConnect } from 'node:tls'
import { gzipSync } from 'node:zlib'
import { createAdminApp } from '../src/app.ts'
import { CertificateAuthority } from '../src/certs.ts'
import { Paths, TunnelConfigManager } from '../src/config.ts'
import { TunnelCore } from '../src/core.ts'
import { exchangeKey, type Exchange } from '../src/exchanges.ts'
import { makeSslProxying, type SslProxying, type TunnelRequestConfig } from '../src/models.ts'
import {
  DEFAULT_ALLOW_CLIENTS,
  ProxyServer,
  clientIsAllowed,
  decodeRequestBody,
  lanIps,
  mayReach,
  routeRequest,
  shouldDecrypt,
  type OnConnect,
} from '../src/proxy.ts'
import { splitAuthority } from '../src/proxy-url.ts'
import type { UpstreamRoutes } from '../src/upstream-route.ts'
import type { UpstreamRequest, UpstreamResponse } from '../src/upstream.ts'
import { cliRunner } from './support/cli.ts'
import { fakeUpstream, jsonAnswer } from './support/fake-upstream.ts'
import { captureLogs } from './support/logs.ts'
import {
  abandonedRow,
  connectTunnel,
  eventually,
  plain,
  RawConnection,
  rawSocket,
  readExactly,
  readHeaders,
  readToEnd,
  viaProxy,
  type Answer,
} from './support/proxy-client.ts'
import { testRoutes } from './support/routes.ts'
import { tmpDir } from './support/tmp.ts'
import { startHttpProxy, startTlsUpstream, startUpstream } from './support/upstream.ts'

// ---------------------------------------------------------------- the listener under test

/** What reached the upstream, as echo answers it */
interface Echoed {
  method: string
  url: string
  query: Record<string, string>
  headers: Record<string, string>
  body: string | null
}

/** The upstream a passthrough reaches: it echoes what arrived */
function echo(request: UpstreamRequest): UpstreamResponse {
  const echoed: Echoed = {
    method: request.method,
    url: request.url,
    query: Object.fromEntries(new URL(request.url).searchParams),
    headers: request.headers,
    body: request.body.length > 0 ? request.body.toString() : null,
  }
  return jsonAnswer(echoed)
}

const echoed = (answer: Answer) => answer.json() as Echoed

/**
 * A listening proxy, the core behind it, and the ways in.
 *
 * Upstream is in-process: a passthrough opens no socket of its own. The core's routes read only
 * what a test gives them, never the developer's proxy variables or system proxy. Every path here
 * is absolute, and nothing reads the working directory.
 */
async function makeProxyEnv(t: TestContext, { routes }: { routes?: UpstreamRoutes } = {}) {
  let proxy: ProxyServer | undefined
  let core: TunnelCore | undefined
  // Registered before tmpDir(t): node:test runs after hooks in registration order, and the core's
  // log and store flush asynchronously into that directory
  t.after(async () => {
    await proxy?.close()
    await core?.close()
  })
  const manager = new TunnelConfigManager(Paths.inOneDirectory(tmpDir(t)))
  const ca = new CertificateAuthority(manager.paths)
  core = new TunnelCore(manager, { upstream: fakeUpstream(echo), routes: routes ?? testRoutes() })
  const exchanges = core.exchanges
  const tunnelled: Parameters<OnConnect>[] = []
  // The listener already writes the log's connect row; the test watches the same call rather
  // than taking the hook away from it
  const onConnect: OnConnect = (...row) => {
    exchanges.recordConnect(...row)
    tunnelled.push(row)
  }
  proxy = new ProxyServer(core, manager, ca, { host: '127.0.0.1', port: 0, onConnect })
  await proxy.start()
  return {
    proxy,
    core,
    manager,
    ca,
    tunnelled,
    port: proxy.port,
    caPem: readFileSync(ca.paths.caFile),
    /** The exchange log this listener writes into */
    recorded: () => exchanges.all(),
    configure: (key: string, fields: Partial<Omit<TunnelRequestConfig, 'request_key'>>) =>
      manager.updateRequestConfig(key, fields),
    decrypt: ({ include = [], exclude = [], enabled = true }: Partial<SslProxying> = {}) =>
      manager.updateConfig({ ssl_proxying: { enabled, include, exclude } }),
  }
}

/** A port on 127.0.0.1 that nobody listens on: one the system handed out a moment ago, closed
 *  again. The same race as freePort() in support/ports.ts, which a test can live with */
async function deadPort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

// ---------------------------------------------------------------- plain HTTP

// absolute-form in, the configured JSON out — the whole point of the port
test('a plain request is answered by the rule that matches', async (t) => {
  const env = await makeProxyEnv(t)
  env.configure('GET:api.example.com/api/feed', {
    mode: 'json',
    json_response: { code: 0, list: [] },
    status_code: 201,
  })

  const response = await viaProxy(env.port, 'GET', 'http://api.example.com/api/feed')

  assert.equal(response.status, 201)
  assert.deepEqual(response.json(), { code: 0, list: [] })
})

// The default mode forwards it to where the client was going anyway
test('a plain request with no rule reaches the host it named', async (t) => {
  const env = await makeProxyEnv(t)

  const response = await viaProxy(env.port, 'GET', 'http://api.example.com/api/other?page=2')

  assert.equal(echoed(response).url, 'http://api.example.com/api/other?page=2')
  assert.deepEqual(echoed(response).query, { page: '2' })
})

test('the request is recorded under the host it named', async (t) => {
  const env = await makeProxyEnv(t)
  env.configure('GET:/api/feed', { mode: 'json', json_response: {} })

  await viaProxy(env.port, 'GET', 'http://api.example.com/api/feed')

  assert.deepEqual(env.recorded().map(exchangeKey), ['GET:api.example.com/api/feed'])
})

// The whole point of a test run: no rule, no backend, and still an answer.
//
// End to end over the real socket, because the marker headers are what a client's own test case
// reads, and they only count once they are on the wire.
test('replay mode answers a device from the recordings', async (t) => {
  const env = await makeProxyEnv(t)
  await env.core.recordings.importExchanges(
    [
      {
        seq: 4,
        kind: 'http',
        request: { method: 'GET', host: 'api.example.com', path: '/v5/suggestions' },
        response: {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: { cards: [] },
          body_encoding: 'json',
        },
      },
    ],
    'default',
  )
  env.manager.updateConfig({ default_mode: 'replay' })

  const replayed = await viaProxy(env.port, 'GET', 'http://api.example.com/v5/suggestions')
  const missing = await viaProxy(env.port, 'GET', 'http://api.example.com/v5/nothing')

  assert.deepEqual(replayed.json(), { cards: [] })
  assert.equal(replayed.headers['x-tunnel-replay'], '4')
  assert.equal(missing.status, 404)
  assert.equal(missing.headers['x-tunnel-unmatched'], '1')
  assert.equal((missing.json() as { key: string }).key, 'GET:api.example.com/v5/nothing')
})

// They were addressed to this hop; a proxy is the hop they meant
test('hop-by-hop headers are not forwarded', async (t) => {
  const env = await makeProxyEnv(t)

  const { headers } = echoed(
    await viaProxy(env.port, 'GET', 'http://api.example.com/api/echo', {
      headers: { 'proxy-connection': 'keep-alive', 'x-keep': 'me' },
    }),
  )

  assert.equal('proxy-connection' in headers, false)
  assert.equal(headers['x-keep'], 'me')
})

// The network-error branch: the client gets no status, only a dead socket
test('the close fault drops the connection without an answer', async (t) => {
  const env = await makeProxyEnv(t)
  env.configure('GET:api.example.com/api/feed', { mode: 'json', fault: 'close' })

  // Node's client says socket hang up, or ECONNRESET
  await assert.rejects(viaProxy(env.port, 'GET', 'http://api.example.com/api/feed'))

  // And it is in the log, so the run can still see what the client asked for
  const answered = env.recorded().filter((exchange) => exchange.kind === 'http')
  const last = answered.at(-1)
  assert.ok(last !== undefined)
  assert.equal(exchangeKey(last), 'GET:api.example.com/api/feed')
  assert.equal(last.response?.status, 0)
})

// The connection task must not be held for the rest of the hour after a hang-up.
//
// Over a real socket, because the server only learns that a client gave up from the socket: it is
// reading nothing while it hangs, so nothing else can tell it.
test('a hang lets go when the client stops waiting', async (t) => {
  const env = await makeProxyEnv(t)
  env.configure('GET:api.example.com/api/feed', { mode: 'json', fault: 'hang', fault_seconds: 30 })

  const socket = await rawSocket(env.port)
  socket.write('GET http://api.example.com/api/feed HTTP/1.1\r\nhost: api.example.com\r\n\r\n')
  await sleep(200) // the server has read it and is now hanging
  const started = performance.now()
  socket.destroy() // ... and the client gives up

  // The row only reaches the log once the hang has let go, so waiting for it is waiting for
  // exactly that. Unfixed, this waits out the 30 and fails here.
  const deadline = performance.now() + 5000
  let answered: Exchange[] = []
  while (answered.length === 0 && performance.now() < deadline) {
    answered = env.recorded().filter((exchange) => exchange.kind === 'http')
    await sleep(20)
  }

  assert.ok(answered.length > 0, 'the hang held the connection after the client had gone')
  assert.ok(performance.now() - started < 5000)
  const last = answered.at(-1)
  assert.ok(last !== undefined)
  assert.equal(exchangeKey(last), 'GET:api.example.com/api/feed')
  assert.equal(last.response?.status, 0)
})

// The hang's shape with a real answer behind it, asked over a real socket.
//
// The core's own tests hand gave_up a flag of their own, so this is the only place that can show
// the closure the port fills in for every request reaching the delay as well as the fault.
// Unfixed, it waits out the 30.
test('a delay lets go when the client stops waiting', async (t) => {
  const env = await makeProxyEnv(t)
  env.configure('GET:api.example.com/api/feed', {
    mode: 'json',
    json_response: { cards: [] },
    response_delay: 30,
  })

  const answered = await abandonedRow(env)

  assert.ok(answered !== null, 'the delay held on after the client had gone')
  // Only the waiting was cut short: what the delay was holding back is what the log reports,
  // where a hang that let go reports a status of 0.
  assert.equal(answered.response?.status, 200)
  assert.deepEqual(answered.response?.body, { cards: [] })
})

// The call that was given up on is still the call the session needs.
//
// Recording is a switch over passthrough traffic: what the real server said is what a later
// replay gives back. A delay that let go without asking upstream would file nothing under the
// session in its place — or worse, the status of 0 a hang ends with, which is not even an HTTP
// status.
test('a delay the client walked out on is still recorded', async (t) => {
  const env = await makeProxyEnv(t)
  env.configure('GET:api.example.com/api/feed', { mode: 'passthrough', response_delay: 30 })
  await env.core.recordings.start()

  const answered = await abandonedRow(env)

  assert.ok(answered !== null, 'the delay held on after the client had gone')
  const kept = await env.core.recordings.samples('default', 'GET', 'api.example.com', '/api/feed')
  assert.deepEqual(
    kept.map((call) => call.status),
    [200],
  )
  // The upstream was asked, and what it said is what went into the session
  const [call] = kept
  assert.ok(call !== undefined)
  const recorded = JSON.parse(readFileSync(call.file, 'utf8')) as {
    response: { body: Echoed }
  }
  assert.equal(recorded.response.body.url, 'http://api.example.com/api/feed')
})

test('an upgrade is refused rather than half carried', async (t) => {
  const env = await makeProxyEnv(t)
  const connection = await plain(env.port, 'api.example.com')

  const answer = await connection.request('GET', 'http://api.example.com/socket', {
    headers: [
      ['upgrade', 'websocket'],
      ['connection', 'upgrade'],
    ],
  })

  assert.equal(answer.status, 501)
  assert.ok((answer.json() as { detail: string }).detail.includes('websocket'))
  connection.close()
})

// ---------------------------------------------------------------- HTTPS

test('an included host is decrypted and answered by a rule', async (t) => {
  const env = await makeProxyEnv(t)
  env.decrypt({ include: ['api.example.com'] })
  env.configure('GET:api.example.com/v5/likes', { mode: 'json', json_response: { cards: [] } })

  const response = await viaProxy(env.port, 'GET', 'https://api.example.com/v5/likes', {
    caPem: env.caPem,
  })

  assert.equal(response.status, 200)
  assert.deepEqual(response.json(), { cards: [] })
})

// Decrypted and forwarded: the client's own server answers, over our TLS
test('an included host can be passed through to the upstream', async (t) => {
  const env = await makeProxyEnv(t)
  env.decrypt({ include: ['*.example.com'] })

  const answer = await viaProxy(env.port, 'POST', 'https://api.example.com/v5/like', {
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ id: 7 })),
    caPem: env.caPem,
  })

  const { url, body } = echoed(answer)
  assert.equal(url, 'https://api.example.com/v5/like')
  assert.ok(body !== null)
  assert.deepEqual(JSON.parse(body), { id: 7 })
})

// No location listed: the bytes go through and the rule is never consulted
test('a host that is not included is tunnelled untouched', async (t) => {
  const env = await makeProxyEnv(t)
  const origin = await startTlsUpstream(t, env.ca)
  env.configure('GET:localhost/probe', { mode: 'json', json_response: { who: 'the mock' } })

  const response = await viaProxy(env.port, 'GET', `https://localhost:${origin.port}/probe`, {
    caPem: env.caPem,
  })

  assert.deepEqual(response.json(), { who: 'the real origin' })
  // Nothing was read, so there is no request to log; the tunnel itself is
  // logged as a `connect` row once both sockets close.
  assert.deepEqual(
    env.recorded().filter((exchange) => exchange.kind === 'http'),
    [],
  )
  const [host, port, client, up, down] = await eventually(() => env.tunnelled[0])
  assert.deepEqual([host, port, client], ['localhost', origin.port, '127.0.0.1'])
  assert.ok(up > 0 && down > 0)
})

// Charles's <encrypted> line: the host, how much went through, nothing to read
test('a tunnel that was not decrypted is logged as a connect row', async (t) => {
  const env = await makeProxyEnv(t)
  const origin = await startTlsUpstream(t, env.ca)

  await viaProxy(env.port, 'GET', `https://localhost:${origin.port}/probe`, { caPem: env.caPem })

  await eventually(() => env.tunnelled[0]) // the row is written when both sockets close
  const row = env.recorded().at(-1)
  assert.ok(row !== undefined)
  assert.deepEqual([row.kind, row.encrypted, row.response], ['connect', true, null])
  assert.deepEqual([row.request.host, row.request.port], ['localhost', origin.port])
  assert.equal(exchangeKey(row), `CONNECT:localhost:${origin.port}`)
  assert.ok(row.bytes_up > 0 && row.bytes_down > 0)
  assert.equal(row.client, '127.0.0.1')
})

test('exclude wins over include', async (t) => {
  const env = await makeProxyEnv(t)
  const origin = await startTlsUpstream(t, env.ca)
  env.decrypt({ include: ['*'], exclude: ['localhost'] })
  env.configure('GET:localhost/probe', { mode: 'json', json_response: { who: 'the mock' } })

  const response = await viaProxy(env.port, 'GET', `https://localhost:${origin.port}/probe`, {
    caPem: env.caPem,
  })

  assert.deepEqual(response.json(), { who: 'the real origin' })
})

test('switching ssl_proxying off leaves every host encrypted', async (t) => {
  const env = await makeProxyEnv(t)
  const origin = await startTlsUpstream(t, env.ca)
  env.decrypt({ include: ['localhost'], enabled: false })

  const response = await viaProxy(env.port, 'GET', `https://localhost:${origin.port}/probe`, {
    caPem: env.caPem,
  })

  assert.equal((response.json() as { who: string }).who, 'the real origin')
})

// Keep-alive: a phone opens one tunnel and sends everything down it
test('several requests share one decrypted connection', async (t) => {
  const env = await makeProxyEnv(t)
  env.decrypt({ include: ['api.example.com'] })
  env.configure('GET:api.example.com/api/poll', {
    mode: 'script',
    script:
      'function handler(ctx) {\n' +
      '  ctx.state.n = (ctx.state.n ?? 0) + 1\n' +
      '  return { n: ctx.state.n }\n' +
      '}\n',
  })

  const connection = new RawConnection(
    await connectTunnel(env.port, 'api.example.com', 443, env.caPem),
    'api.example.com:443',
  )
  const answers: Answer[] = []
  for (let i = 0; i < 3; i++) answers.push(await connection.request('GET', '/api/poll'))
  connection.close()

  assert.deepEqual(
    answers.map((answer) => answer.status),
    [200, 200, 200],
  )
  assert.deepEqual(
    answers.map((answer) => (answer.json() as { n: number }).n),
    [1, 2, 3],
  )
})

// ---------------------------------------------------------------- request bodies

// Node's parser undoes the framing, so the upstream sees one body and no chunking
test('a chunked request body arrives whole', async (t) => {
  const env = await makeProxyEnv(t)
  const connection = await plain(env.port, 'api.example.com')

  const answer = await connection.request('POST', 'http://api.example.com/api/users', {
    headers: [['content-type', 'application/json']],
    body: Buffer.from('{"name": "x"}'),
    chunked: true,
  })
  connection.close()

  const { body, headers } = echoed(answer)
  assert.ok(body !== null)
  assert.deepEqual(JSON.parse(body), { name: 'x' })
  assert.equal('transfer-encoding' in headers, false)
})

// A client that announces Expect holds its body back until it is told to go ahead
test('a client that waits for 100-continue is told to go ahead', async (t) => {
  const env = await makeProxyEnv(t)
  env.configure('POST:api.example.com/api/echo', {
    mode: 'script',
    script: 'function handler(ctx) {\n  return { seen: ctx.json }\n}\n',
  })
  const socket = await rawSocket(env.port)
  socket.write(
    'POST http://api.example.com/api/echo HTTP/1.1\r\n' +
      'host: api.example.com\r\ncontent-type: application/json\r\n' +
      'content-length: 11\r\nexpect: 100-continue\r\n\r\n',
  )

  assert.ok((await readHeaders(socket)).startsWith('HTTP/1.1 100 '))
  socket.write('{"page": 2}')
  const head = await readHeaders(socket)
  const length = Number(head.split('content-length: ')[1]?.split('\r\n')[0])
  const body = await readExactly(socket, length)
  socket.destroy()

  assert.ok(head.startsWith('HTTP/1.1 200 '), head)
  assert.deepEqual(JSON.parse(body.toString()), { seen: { page: 2 } })
})

// A script's ctx.json and the upstream both want the bytes the client meant
test('a gzipped request body is unpacked before it is answered', async (t) => {
  const env = await makeProxyEnv(t)
  env.configure('POST:api.example.com/api/echo', {
    mode: 'script',
    script:
      'function handler(ctx) {\n' +
      "  return { seen: ctx.json, encoding: ctx.headers['content-encoding'] ?? null }\n" +
      '}\n',
  })
  const connection = await plain(env.port, 'api.example.com')

  const answer = await connection.request('POST', 'http://api.example.com/api/echo', {
    headers: [
      ['content-type', 'application/json'],
      ['content-encoding', 'gzip'],
    ],
    body: gzipSync('{"page": 2}'),
  })
  connection.close()

  assert.deepEqual(answer.json(), { seen: { page: 2 }, encoding: null })
})

// ---------------------------------------------------------------- who may connect

// The port carries traffic for the network it was told to, and nobody else
test('a client outside allow_clients is dropped', async (t) => {
  const env = await makeProxyEnv(t)
  env.manager.updateConfig({ allow_clients: ['10.0.0.0/8'] })

  const socket = await rawSocket(env.port)
  socket.write('GET http://api.example.com/api/feed HTTP/1.1\r\nhost: api.example.com\r\n\r\n')
  // A reset counts as the end as well: the connection was closed before our bytes landed
  const answer = await readToEnd(socket)

  assert.equal(answer.length, 0)
  assert.deepEqual(env.recorded(), [])
})

// The admin port is bound to 127.0.0.1; the proxy port must not lend it out
test("the network cannot borrow this machine's loopback", () => {
  assert.equal(mayReach('192.168.1.23', '127.0.0.1'), false)
  assert.equal(mayReach('192.168.1.23', 'localhost'), false)
  assert.equal(mayReach('192.168.1.23', '::ffff:127.0.0.1'), false)
  // A client on this machine is already inside it: `tunnel check` sends from here
  assert.equal(mayReach('127.0.0.1', '127.0.0.1'), true)
  assert.equal(mayReach('192.168.1.23', 'api.example.com'), true)
})

// A device could otherwise configure scripts on this machine through the proxy. Asked of
// routeRequest, the part of answering that touches no socket
test('a request from the network for the admin port is refused', async (t) => {
  const env = await makeProxyEnv(t)

  const routed = routeRequest({
    method: 'GET',
    target: 'http://127.0.0.1:8000/__admin__/config',
    headers: { host: '127.0.0.1:8000' },
    body: Buffer.alloc(0),
    client: '192.168.1.23',
    scheme: 'http',
    authority: null,
    gaveUp: () => false,
    ca: env.ca,
  })

  assert.ok(routed.kind === 'response')
  assert.equal(routed.response.status, 403)
  // It never reached the core, so it was neither forwarded nor recorded
  assert.deepEqual(env.recorded(), [])
})

// ---------------------------------------------------------------- the port's own pages

// A device with no proxy set yet still has to be able to fetch the certificate
test('the install page is served to a device that asks this port directly', async (t) => {
  const env = await makeProxyEnv(t)
  const connection = await plain(env.port, `127.0.0.1:${env.port}`)

  const page = await connection.request('GET', '/')
  const certificate = await connection.request('GET', '/ca.pem')
  const other = await connection.request('GET', '/__admin__/config')
  connection.close()

  assert.equal(page.status, 200)
  assert.ok(page.headers['content-type']?.startsWith('text/html'))
  assert.ok(page.body.toString().includes('/ca.pem'))
  assert.ok(page.body.toString().includes(env.ca.fingerprint()))
  assert.equal(certificate.headers['content-type'], 'application/x-x509-ca-cert')
  assert.deepEqual(certificate.body, readFileSync(env.ca.paths.caFile))
  // The proxy port has no management API on it; that stays on the admin port
  assert.equal(other.status, 400)
})

// http://ca.tunnel/ is Charles's chls.pro/ssl: it never leaves this machine.
//
// `.tunnel` is not a top-level domain, which is the point: a device that is *not* proxied fails to
// resolve the name instead of reaching a real site. tunnel.ca, which this used to be, belongs to
// somebody else and answers on the internet today. `.test` would also never resolve publicly, but
// local setups routinely wildcard *.test to their own loopback, and the fake hosts in the panel's
// own sample data already live there. Fiddler does the same thing with ipv4.fiddler.
test('the magic host serves the same page to a proxied device', async (t) => {
  const env = await makeProxyEnv(t)

  const page = await viaProxy(env.port, 'GET', 'http://ca.tunnel/')
  const certificate = await viaProxy(env.port, 'GET', 'http://ca.tunnel/ca.pem')

  assert.equal(page.status, 200)
  assert.ok(page.body.toString().includes('Install the tunnel certificate'))
  assert.deepEqual(certificate.body, readFileSync(env.ca.paths.caFile))
  // A page of our own is not traffic to mock, so it is not recorded either
  assert.deepEqual(env.recorded(), [])
})

// ---------------------------------------------------------------- shutting down

// A phone holds its connection open for the next request it has not sent yet
test('closing the listener does not wait for a device to hang up', async (t) => {
  const env = await makeProxyEnv(t)
  const connection = await plain(env.port, 'api.example.com')
  await connection.request('GET', 'http://api.example.com/api/feed')

  const started = performance.now()
  await env.proxy.close()

  // It comes back at once
  assert.ok(performance.now() - started < 1000)
  connection.close()
})

// ---------------------------------------------------------------- tunnel check

/** `tunnel check` against this proxy, with the admin API of this proxy's manager, core and CA on
 *  an app of its own. Only the admin calls stay in the process; the request that is checked goes
 *  out for real, through the listening proxy port */
function check(t: TestContext, env: Awaited<ReturnType<typeof makeProxyEnv>>) {
  const app = createAdminApp({
    manager: env.manager,
    core: env.core,
    ca: env.ca,
    proxy: () => env.proxy.describe(),
  })
  return cliRunner({ fetch: (url, init) => app.request(url, init), cwd: tmpDir(t) })
}

test('check sends the request through the proxy port', async (t) => {
  const env = await makeProxyEnv(t)
  const cli = check(t, env)
  env.decrypt({ include: ['api.example.com'] })
  env.configure('GET:api.example.com/api/feed', { mode: 'json', json_response: { code: 0 } })

  assert.equal(await cli.run('check', 'GET', 'https://api.example.com/api/feed', '-q', 'page=2'), 0)

  const printed = cli.takeOutput().out
  assert.ok(printed.includes('HTTP 200') && printed.includes('"code": 0'), printed)
  const recorded = env.recorded()[0]
  assert.ok(recorded !== undefined)
  assert.deepEqual(
    [exchangeKey(recorded), recorded.request.query],
    ['GET:api.example.com/api/feed', { page: '2' }],
  )
})

test('check exits non-zero when the answer is an error', async (t) => {
  const env = await makeProxyEnv(t)
  const cli = check(t, env)
  env.configure('POST:api.example.com/api/pay', {
    mode: 'json',
    json_response: { detail: 'no' },
    status_code: 500,
  })

  assert.equal(
    await cli.run('check', 'POST', 'http://api.example.com/api/pay', '-d', '{"amount": 1}'),
    1,
  )
})

// ---------------------------------------------------------------- edge cases

test('clientIsAllowed accepts the private ranges by default and skips entries it cannot read', (t) => {
  const logs = captureLogs(t)
  assert.deepEqual(DEFAULT_ALLOW_CLIENTS, [
    '127.0.0.0/8',
    '::1/128',
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    'fc00::/7',
  ])

  // An empty list is the default one: this machine and the private ranges
  for (const address of [
    '127.0.0.1',
    '::1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.23',
    'fc00::1',
    'fd12::1',
  ]) {
    assert.equal(clientIsAllowed(address, []), true, address)
  }
  for (const address of ['172.32.0.1', '8.8.8.8', '2001:db8::1']) {
    assert.equal(clientIsAllowed(address, []), false, address)
  }
  // A dual stack listener reports an IPv4 peer this way
  assert.equal(clientIsAllowed('::ffff:192.168.1.23', []), true)
  // Only an address is let in: a name is not looked up
  assert.equal(clientIsAllowed('', []), false)
  assert.equal(clientIsAllowed('localhost', []), false)

  // A list that is given takes the place of the default one
  assert.equal(clientIsAllowed('127.0.0.1', ['10.0.0.0/8']), false)
  assert.equal(clientIsAllowed('10.0.0.1', ['10.0.0.0/8']), true)
  // An address on its own lets in that address and no other
  assert.equal(clientIsAllowed('192.168.1.23', ['192.168.1.23']), true)
  assert.equal(clientIsAllowed('192.168.1.24', ['192.168.1.23']), false)
  // A range with host bits set is the range they are in
  assert.equal(clientIsAllowed('192.168.1.200', ['192.168.1.5/24']), true)
  assert.equal(logs.records.length, 0)

  // An entry that is neither an address nor a range is logged and skipped, and the
  // rest of the list still counts. A netmask in place of a prefix length is one of
  // them, and so is an empty prefix length, which is not a /0 that lets everyone in.
  // A zone id is read
  const patterns = ['nonsense', '10.0.0.0/255.0.0.0', '10.0.0.0/', 'fe80::1%en0', '10.0.0.0/8']
  assert.equal(clientIsAllowed('10.0.0.1', patterns), true)
  assert.equal(clientIsAllowed('8.8.8.8', patterns), false)
  assert.equal(clientIsAllowed('fe80::1', patterns), true)
  // Once for the list rather than once for every connection: a list is read once
  assert.deepEqual(
    logs.records,
    ['nonsense', '10.0.0.0/255.0.0.0', '10.0.0.0/'].map((entry) => ({
      level: 'warning',
      logger: 'tunnel.proxy',
      message: `Ignoring an unreadable allow_clients entry: '${entry}'`,
    })),
  )
})

test('decodeRequestBody unpacks gzip and leaves what it cannot read alone', (t) => {
  const logs = captureLogs(t)
  const text = '{"page": 2}'
  const packed = gzipSync(text)

  // Unpacked, and the header that described it goes; content-length stays as it came
  for (const encoding of ['gzip', 'x-gzip', 'GZIP']) {
    const headers = { 'content-encoding': encoding, 'content-length': String(packed.length) }
    assert.equal(decodeRequestBody(headers, packed).toString(), text, encoding)
    assert.deepEqual(headers, { 'content-length': String(packed.length) }, encoding)
  }
  assert.equal(logs.records.length, 0)

  // Not gzip after all: passed on as it came, headers and all, with a warning
  const notGzip = Buffer.from('not gzip')
  const claimed = { 'content-encoding': 'gzip' }
  assert.equal(decodeRequestBody(claimed, notGzip), notGzip)
  assert.deepEqual(claimed, { 'content-encoding': 'gzip' })
  assert.equal(logs.records.length, 1)
  const warning = logs.records[0]
  assert.ok(warning !== undefined)
  assert.deepEqual([warning.level, warning.logger], ['warning', 'tunnel.proxy'])
  assert.match(
    warning.message,
    /^A request body claimed gzip but did not decompress \(.+\); passing it on as it came$/,
  )

  // An empty body is not touched, and nothing is logged for it
  const empty = Buffer.alloc(0)
  const emptyHeaders = { 'content-encoding': 'gzip' }
  assert.equal(decodeRequestBody(emptyHeaders, empty), empty)
  assert.deepEqual(emptyHeaders, { 'content-encoding': 'gzip' })
  assert.equal(logs.records.length, 1)

  // No content-encoding, or one that is not gzip: left as it is
  const plain = Buffer.from(text)
  assert.equal(decodeRequestBody({}, plain), plain)
  const brotli = { 'content-encoding': 'br' }
  assert.equal(decodeRequestBody(brotli, packed), packed)
  assert.deepEqual(brotli, { 'content-encoding': 'br' })
  assert.equal(logs.records.length, 1)
})

test('shouldDecrypt honours include, exclude, ports and the switch', () => {
  const listed = makeSslProxying({ include: ['api.example.com'] })
  assert.equal(shouldDecrypt(listed, 'api.example.com', 443), true)
  // The host a CONNECT names is compared in lower case
  assert.equal(shouldDecrypt(listed, 'API.EXAMPLE.COM', 443), true)
  assert.equal(shouldDecrypt(listed, 'cdn.example.com', 443), false)

  // * is a wildcard
  const subdomains = makeSslProxying({ include: ['*.example.com'] })
  assert.equal(shouldDecrypt(subdomains, 'api.example.com', 443), true)
  assert.equal(shouldDecrypt(subdomains, 'example.com', 443), false)
  const everything = makeSslProxying({ include: ['*'] })
  for (const host of ['api.example.com', 'localhost', '10.0.0.1']) {
    assert.equal(shouldDecrypt(everything, host, 443), true, host)
  }

  // A location with a port holds on that port only; one without, on any
  const onePort = makeSslProxying({ include: ['api.example.com:8443'] })
  assert.equal(shouldDecrypt(onePort, 'api.example.com', 443), false)
  assert.equal(shouldDecrypt(onePort, 'api.example.com', 8443), true)

  // An excluded location wins over an including one
  const excluded = makeSslProxying({ include: ['*'], exclude: ['localhost'] })
  assert.equal(shouldDecrypt(excluded, 'localhost', 443), false)
  assert.equal(shouldDecrypt(excluded, 'api.example.com', 443), true)

  // Switched off, or with nothing included, nothing is decrypted
  const off = makeSslProxying({ enabled: false, include: ['*'] })
  assert.equal(shouldDecrypt(off, 'api.example.com', 443), false)
  assert.equal(shouldDecrypt(makeSslProxying({ include: [] }), 'api.example.com', 443), false)

  // A location whose port is not a number holds nowhere
  const badPort = makeSslProxying({ include: ['[::1]:abc'] })
  assert.equal(shouldDecrypt(badPort, '::1', 443), false)
})

// A host is read the way a connection reads it, so every other spelling of this
// machine's loopback is refused to the network as well
test("mayReach refuses the network every other spelling of this machine's loopback", () => {
  for (const host of [
    // The unspecified addresses reach this machine's listeners too
    '0.0.0.0',
    '0',
    '::',
    '::ffff:0.0.0.0',
    // The numeric spellings of 127.0.0.1 that a connection reads
    '127.1',
    '2130706433',
    '0x7f000001',
    '0x7f.1',
    '::ffff:127.0.0.1',
    // A trailing dot only says the name is complete
    'localhost.',
    'a.localhost.',
    // What comes before an @ is a user name, as the URL to upstream reads it
    'user@127.0.0.1',
    'user@[::1]',
    // No host at all, as CONNECT :8000 and http://:8000/ name it: a connection to ''
    // reaches localhost
    '',
  ]) {
    assert.equal(mayReach('192.168.1.5', host), false, host)
    assert.equal(mayReach('127.0.0.1', host), true, host)
  }
  // Names are still not looked up
  for (const host of ['10.0.0.1', '8.8.8.8', 'example.com', '127.example.com']) {
    assert.equal(mayReach('192.168.1.5', host), true, host)
  }

  // And so is a plain request that names no host. It is not for one of the port's own pages, so
  // no certificate authority is asked
  const routed = routeRequest({
    method: 'GET',
    target: 'http://:8000/__admin__/config',
    headers: { host: ':8000' },
    body: Buffer.alloc(0),
    client: '192.168.1.5',
    scheme: 'http',
    authority: null,
    gaveUp: () => false,
    ca: { fingerprint: () => '', certificatePem: () => Buffer.alloc(0) },
  })
  assert.ok(routed.kind === 'response')
  assert.equal(routed.response.status, 403)

  // CONNECT :8000 names no host either, the way the connect handler reads its authority. Only the
  // reading can be shown: a test's client is on the loopback, which mayReach lets through
  const [host, port] = splitAuthority(':8000', 443)
  assert.deepEqual([host, port], ['', 8000])
  assert.equal(mayReach('192.168.1.5', host), false)
})

test('the wire carries only the headers core gave plus content-length, and no body on HEAD, 204 or 304', async (t) => {
  const env = await makeProxyEnv(t)
  const cards: Partial<TunnelRequestConfig> = { mode: 'json', json_response: { cards: [] } }
  env.configure('GET:api.example.com/api/feed', cards)
  env.configure('HEAD:api.example.com/api/feed', cards)
  env.configure('GET:api.example.com/api/empty', { ...cards, status_code: 204 })
  env.configure('GET:api.example.com/api/unchanged', { ...cards, status_code: 304 })

  /** One request on a connection of its own, and everything that came back until the proxy
   *  closed it: the header lines, lower-cased, and the bytes after them */
  const ask = async (method: string, path: string) => {
    const socket = await rawSocket(env.port)
    socket.write(
      `${method} http://api.example.com${path} HTTP/1.1\r\n` +
        'host: api.example.com\r\nconnection: close\r\n\r\n',
    )
    const wire = await readToEnd(socket)
    const end = wire.indexOf('\r\n\r\n')
    const lines = wire.subarray(0, end).toString('latin1').toLowerCase().split('\r\n')
    return { lines, body: wire.subarray(end + 4) }
  }

  // Node adds a date, and a connection or keep-alive header, unless told not to
  const full = await ask('GET', '/api/feed')
  assert.ok(full.lines.includes('content-length: 13'), full.lines.join('\n'))
  assert.ok(full.lines.includes('content-type: application/json'), full.lines.join('\n'))
  for (const name of ['date', 'connection', 'keep-alive']) {
    assert.ok(!full.lines.some((line) => line.startsWith(`${name}:`)), full.lines.join('\n'))
  }
  assert.equal(full.body.toString(), '{"cards": []}')

  // The content-length is what the body would have been; the body itself never comes
  for (const [method, path] of [
    ['HEAD', '/api/feed'],
    ['GET', '/api/empty'],
    ['GET', '/api/unchanged'],
  ] as const) {
    const silent = await ask(method, path)
    assert.ok(silent.lines.includes('content-length: 13'), `${method} ${path}`)
    assert.equal(silent.body.length, 0, `${method} ${path}`)
  }
})

// req.headers would keep the first of two content-types only
test('repeated request headers reach core joined with ", ", content-type included', async (t) => {
  const env = await makeProxyEnv(t)
  const connection = await plain(env.port, 'api.example.com')

  const answer = await connection.request('GET', 'http://api.example.com/api/echo', {
    headers: [
      ['x-dup', 'a'],
      ['x-dup', 'b'],
      ['content-type', 'a/b'],
      ['content-type', 'c/d'],
    ],
  })
  connection.close()

  assert.equal(echoed(answer).headers['x-dup'], 'a, b')
  assert.equal(echoed(answer).headers['content-type'], 'a/b, c/d')
})

// With requireHostHeader left on, Node answers such a request 400 itself
test('an HTTP/1.1 request with no Host header gets the install page', async (t) => {
  const env = await makeProxyEnv(t)
  const socket = await rawSocket(env.port)

  socket.write('GET / HTTP/1.1\r\n\r\n')
  const head = await readHeaders(socket)
  assert.ok(head.startsWith('HTTP/1.1 200 '), head)
  const length = Number(/\r\ncontent-length: (\d+)\r\n/i.exec(head)?.[1])
  const body = await readExactly(socket, length)
  socket.destroy()

  assert.ok(body.toString().includes('Install the tunnel certificate'))
})

// Core answers a CONNECT on a decrypted stream as it answers any other request there. An answer
// that is a 2xx is written whole, and the stream goes on
test('a CONNECT inside a decrypted stream is answered by core, and the stream goes on', async (t) => {
  const env = await makeProxyEnv(t)
  env.decrypt({ include: ['api.example.com'] })
  env.configure('GET:api.example.com/after', { mode: 'json', json_response: { after: true } })
  const connection = new RawConnection(
    await connectTunnel(env.port, 'api.example.com', 443, env.caPem),
    'api.example.com',
  )

  // No rule: core passes it on, and the echo answers
  const nested = await connection.request('CONNECT', 'inner.example.com:443')

  assert.equal(nested.status, 200)
  assert.equal(echoed(nested).method, 'CONNECT')
  const row = env.recorded().at(-1)
  assert.ok(row !== undefined)
  // The host and port are the outer CONNECT's; the path is what splitTarget makes of the target
  const { method, scheme, host, port, path } = row.request
  assert.deepEqual(
    [method, scheme, host, port, path],
    ['CONNECT', 'https', 'api.example.com', 443, '443'],
  )
  // The parser is back on the stream: the next request on it is answered
  const after = await connection.request('GET', '/after')
  assert.deepEqual(after.json(), { after: true })
  connection.close()
})

test('a request line llhttp cannot parse closes the connection with one INFO line and no 400', async (t) => {
  const env = await makeProxyEnv(t)
  const logs = captureLogs(t)
  const socket = await rawSocket(env.port)

  socket.write('FOO http://api.example.com/x HTTP/1.1\r\nhost: api.example.com\r\n\r\n')
  const answer = await readToEnd(socket)

  assert.equal(answer.length, 0)
  assert.equal(logs.records.length, 1, logs.text())
  const [line] = logs.records
  assert.ok(line !== undefined)
  assert.deepEqual([line.level, line.logger], ['info', 'tunnel.proxy'])
  assert.ok(line.message.startsWith('Dropping a connection from 127.0.0.1: '), line.message)
  assert.deepEqual(env.recorded(), [])
})

// Node's ALPN has no way to choose no protocol and carry on, so the handshake fails
test('a client that offers only h2 fails the handshake, and the proxy says so in one INFO line', async (t) => {
  const env = await makeProxyEnv(t)
  const logs = captureLogs(t)
  env.decrypt({ include: ['api.example.com'] })

  await assert.rejects(connectTunnel(env.port, 'api.example.com', 443, env.caPem, ['h2']), {
    code: 'ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL',
  })

  const line = await eventually(
    () => logs.records.find((record) => record.message.startsWith('TLS with ')),
    'the proxy logged no TLS failure',
  )
  assert.deepEqual([line.level, line.logger], ['info', 'tunnel.proxy'])
  const prefix = 'TLS with 127.0.0.1 for api.example.com failed: '
  assert.ok(line.message.startsWith(prefix), line.message)
  // OpenSSL's text, which is all that follows, ends in a newline; a log record is one line
  assert.ok(!line.message.endsWith('\n'), JSON.stringify(line.message))
  const decrypting = logs.records.filter((record) => record.message.startsWith('Decrypting '))
  assert.deepEqual(decrypting, [])
  assert.deepEqual(env.recorded(), [])
})

// The held request is what pins closeAllConnections(): the connection
// 'closing the listener does not wait for a device to hang up' closes is an idle one, and
// server.close() closes those by itself
test('close() lets go of a tunnel and of a request still being answered, at once, however often it is called', async (t) => {
  const env = await makeProxyEnv(t)
  const origin = await startTlsUpstream(t, env.ca)
  env.configure('GET:api.example.com/api/feed', { mode: 'json', fault: 'hang', fault_seconds: 30 })
  // Nothing is sent down the tunnel: the origin waits, and the tunnel stays open
  const tunnel = await connectTunnel(env.port, 'localhost', origin.port, env.caPem)
  const held = await rawSocket(env.port)
  held.write('GET http://api.example.com/api/feed HTTP/1.1\r\nhost: api.example.com\r\n\r\n')
  await sleep(200) // the core is hanging on it now
  const tunnelGone = new Promise((resolve) => tunnel.once('close', resolve))
  // The client lets go after two seconds whatever happens, so that a close() that waits on it fails
  // this test rather than hangs it: the hang ends in a 504 on a keep-alive connection, and with no
  // keep-alive timeout nothing else would ever close that
  const heldBytes = readToEnd(held, 2000).finally(() => held.destroy())

  const started = performance.now()
  await Promise.all([env.proxy.close(), env.proxy.close()])

  assert.ok(performance.now() - started < 1000)
  await tunnelGone
  assert.equal((await heldBytes).length, 0)
  await env.proxy.close()
  // The core lets go of the hang too, its client gone, within a poll. Waited for, so that the hang
  // does not outlive this test and log into the next one
  const what = 'the hang held on after close()'
  await eventually(() => env.recorded().find((exchange) => exchange.kind === 'http'), what)
  // A tunnel close() let go of is not one the device closed, and gets no row
  assert.deepEqual(env.tunnelled, [])
})

// Which address there is depends on the network this machine is on, which a test cannot choose:
// none, or one
test('lanIps() names at most one IPv4 address that is not loopback, and describe() carries it', async (t) => {
  const env = await makeProxyEnv(t)

  const ips = await lanIps()

  assert.ok(ips.length <= 1, ips.join(', '))
  for (const ip of ips) {
    assert.ok(isIPv4(ip), ip)
    assert.ok(!ip.startsWith('127.'), ip)
  }
  // The answer start() took, the same one: the routing table does not change while the test runs
  assert.deepEqual(env.proxy.describe(), { host: '127.0.0.1', port: env.port, lan_ips: ips })
})

test('a CONNECT to a port nobody listens on is answered 502, with one WARNING and no row', async (t) => {
  const env = await makeProxyEnv(t)
  const logs = captureLogs(t)
  const dead = await deadPort()
  const raw = await rawSocket(env.port)

  raw.write(`CONNECT localhost:${dead} HTTP/1.1\r\nhost: localhost:${dead}\r\n\r\n`)

  assert.equal(
    (await readToEnd(raw)).toString('latin1'),
    'HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n',
  )
  const warnings = logs.records.filter((record) => record.level === 'warning')
  assert.equal(warnings.length, 1, logs.text())
  const [warning] = warnings
  assert.ok(warning !== undefined)
  assert.equal(warning.logger, 'tunnel.proxy')
  const prefix = `Could not reach localhost:${dead} for 127.0.0.1: `
  assert.ok(warning.message.startsWith(prefix), warning.message)
  // localhost is ::1 and 127.0.0.1, both refused: openTunnel gives the code where Node's message
  // for the two together is empty
  assert.ok(warning.message.includes('ECONNREFUSED'), warning.message)
  assert.deepEqual(env.tunnelled, [])
  assert.deepEqual(env.recorded(), [])
})

// What a connect listener throws, nobody else catches: it would be an uncaught exception, and both
// ports would go down with the process. It is logged with its stack, and the connection closed
test('a CONNECT the proxy cannot carry out is closed with one ERROR line, and the port stays up', async (t) => {
  const env = await makeProxyEnv(t)
  const logs = captureLogs(t)

  // A port out of range, which net.connect throws at once (ERR_SOCKET_BAD_PORT): nothing comes back
  const outOfRange = await rawSocket(env.port)
  outOfRange.write('CONNECT localhost:70000 HTTP/1.1\r\nhost: localhost:70000\r\n\r\n')
  assert.equal((await readToEnd(outOfRange)).length, 0)

  // Only now, or localhost above would have been decrypted rather than tunnelled
  env.decrypt({ include: ['*'] })
  // No host at all, which tlsOptionsFor refuses once the 200 has gone
  const noHost = await rawSocket(env.port)
  noHost.write('CONNECT :443 HTTP/1.1\r\nhost: x\r\n\r\n')
  const established = 'HTTP/1.1 200 Connection Established\r\n\r\n'
  assert.equal((await readToEnd(noHost)).toString('latin1'), established)

  const errors = logs.records.filter((record) => record.level === 'error')
  assert.equal(errors.length, 2, logs.text())
  for (const error of errors) {
    const failed = 'The proxy connection from 127.0.0.1 failed\n'
    assert.ok(error.message.startsWith(failed), error.message)
  }
  // The process, and the port, are still there to answer
  assert.equal((await viaProxy(env.port, 'GET', 'http://api.example.com/api/feed')).status, 200)
})

// The server is a private field, so it is read where Node hands it out itself: the
// http.server.request.start diagnostics channel, a public hook, carries the server that took each
// request. Nothing else in this process answers HTTP while the test runs (the upstream is a fake
// that opens no socket), so the one seen is the proxy's
test("the proxy's http.Server has every timeout switched off", async (t) => {
  const env = await makeProxyEnv(t)
  let seen: Server | undefined
  const onStart = (message: unknown) => {
    seen ??= (message as { server: Server }).server
  }
  subscribe('http.server.request.start', onStart)
  t.after(() => unsubscribe('http.server.request.start', onStart))

  await viaProxy(env.port, 'GET', 'http://api.example.com/api/feed')

  assert.ok(seen !== undefined, 'no request reached an http.Server')
  assert.deepEqual([seen.keepAliveTimeout, seen.headersTimeout, seen.requestTimeout], [0, 0, 0])
})

// A TLS client that wraps a socket of its own sends no FIN when it is done, so the proxy's end of a
// tunnel that waited for one would stay half open, and no row would come. Each end is let go once
// it is finished
test('a tunnel ends when the origin does, though the client never closes its side', async (t) => {
  const env = await makeProxyEnv(t)
  const origin = await startTlsUpstream(t, env.ca)
  const secure = await connectTunnel(env.port, 'localhost', origin.port, env.caPem)
  t.after(() => secure.destroy())

  const answer = await new RawConnection(secure, `localhost:${origin.port}`).request(
    'GET',
    '/probe',
  )

  assert.deepEqual(answer.json(), { who: 'the real origin' })
  // secure stays open: the reading paused it once the body was in, so it sees neither the origin's
  // end nor a reason to close
  const what = 'the tunnel waited for the client to hang up'
  const row = await eventually(() => env.tunnelled[0], what, 1000)
  assert.equal(row[0], 'localhost')
})

// The way out the routes pick, here an upstream proxy
test('a tunnel that is not decrypted goes out through the proxy the routes pick', async (t) => {
  // The origin's certificate comes from a CA of its own: the routes have to know the upstream
  // proxy's port, the upstream proxy the origin's, and env.ca only exists once the env does. The
  // proxy port decrypts nothing here, so env.ca has no part in it
  const originCa = new CertificateAuthority(Paths.inOneDirectory(tmpDir(t)))
  const origin = await startTlsUpstream(t, originCa, 'origin.test')
  const upstreamProxy = await startHttpProxy(t, {
    connectTo: { host: '127.0.0.1', port: origin.port },
  })
  const env = await makeProxyEnv(t, {
    routes: testRoutes({ env: { HTTPS_PROXY: `http://127.0.0.1:${upstreamProxy.port}` } }),
  })

  // origin.test rather than localhost: a target that is local goes straight there, and the routes
  // never ask about a proxy for it
  const response = await viaProxy(env.port, 'GET', 'https://origin.test/probe', {
    caPem: originCa.certificatePem(),
  })

  assert.deepEqual(response.json(), { who: 'the real origin' })
  assert.deepEqual(
    upstreamProxy.seen.map((seen) => seen.line),
    ['CONNECT origin.test:443 HTTP/1.1'],
  )
  const [host, port, client, up, down] = await eventually(() => env.tunnelled[0])
  assert.deepEqual([host, port, client], ['origin.test', 443, '127.0.0.1'])
  assert.ok(up > 0 && down > 0)
})

// A 407 from the upstream proxy, then an upstream proxy nobody listens on
test('a proxy that will not carry the tunnel is answered 502, and the WARNING names the proxy', async (t) => {
  const refusing = await startHttpProxy(t, { require: 'Basic bm9ib2R5Om5vcGU=' })
  const dead = await deadPort()
  const throughRefusing = await makeProxyEnv(t, {
    routes: testRoutes({ env: { HTTPS_PROXY: `http://127.0.0.1:${refusing.port}` } }),
  })
  const throughDead = await makeProxyEnv(t, {
    routes: testRoutes({ env: { HTTPS_PROXY: `http://127.0.0.1:${dead}` } }),
  })
  const logs = captureLogs(t)
  const warnings = () => logs.records.filter((record) => record.level === 'warning')
  const connect = async (port: number) => {
    const raw = await rawSocket(port)
    raw.write('CONNECT origin.test:443 HTTP/1.1\r\nhost: origin.test:443\r\n\r\n')
    return (await readToEnd(raw)).toString('latin1')
  }
  const badGateway = 'HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n'
  const prefix = 'Could not reach origin.test:443 for 127.0.0.1: '

  assert.equal(await connect(throughRefusing.port), badGateway)
  assert.equal(warnings().length, 1, logs.text())
  const [refused] = warnings()
  assert.ok(refused !== undefined)
  assert.equal(refused.logger, 'tunnel.proxy')
  assert.ok(refused.message.startsWith(prefix), refused.message)
  assert.ok(refused.message.includes('407'), refused.message)
  const viaRefusing = ` through the proxy http://127.0.0.1:${refusing.port} (HTTPS_PROXY)`
  assert.ok(refused.message.endsWith(viaRefusing), refused.message)

  assert.equal(await connect(throughDead.port), badGateway)
  assert.equal(warnings().length, 2, logs.text())
  const [, unreachable] = warnings()
  assert.ok(unreachable !== undefined)
  assert.equal(unreachable.logger, 'tunnel.proxy')
  assert.ok(unreachable.message.startsWith(prefix), unreachable.message)
  assert.ok(unreachable.message.includes('ECONNREFUSED'), unreachable.message)
  const viaDead = ` through the proxy http://127.0.0.1:${dead} (HTTPS_PROXY)`
  assert.ok(unreachable.message.endsWith(viaDead), unreachable.message)

  for (const env of [throughRefusing, throughDead]) {
    assert.deepEqual(env.tunnelled, [])
    assert.deepEqual(env.recorded(), [])
  }
})

// The port it listens on, not the 0 it was given, which would be nobody's
test("start() tells the routes which port is the proxy's own, and close() takes it back", async (t) => {
  const env = await makeProxyEnv(t)

  assert.notEqual(env.port, 0)
  assert.equal(env.core.routes.ownProxyPort, env.port)
  await env.proxy.close()
  assert.equal(env.core.routes.ownProxyPort, null)
})

// It pins the wiring, that the port this listener sets is the one the routes compare; the rule
// itself is upstream-route.test.ts's. That a CONNECT is then not handed back to this port cannot be
// shown on the wire: the only targets a test can reach are on the loopback, and the routes send
// those straight there without asking about a proxy
test('a system proxy that points at the proxy port is taken for no proxy at all', async (t) => {
  let own = 0
  // Both web proxies at 127.0.0.1 and the proxy port, as docs/devices.md sets up the iOS simulator
  const readSystemProxy = async () =>
    '<dictionary> {\n' +
    `  HTTPEnable : 1\n  HTTPPort : ${own}\n  HTTPProxy : 127.0.0.1\n` +
    `  HTTPSEnable : 1\n  HTTPSPort : ${own}\n  HTTPSProxy : 127.0.0.1\n` +
    '}\n'
  // cacheMs 0: every route() reads the text again, where otherwise it is read once in 5 seconds
  const env = await makeProxyEnv(t, {
    routes: testRoutes({ platform: 'darwin', readSystemProxy }, { cacheMs: 0 }),
  })
  own = env.port
  const { routes } = env.core
  const target = { scheme: 'https', host: 'origin.test', port: 443 } as const

  assert.deepEqual(await routes.route(target), { kind: 'direct', reason: 'tunnel itself' })
  assert.equal(await routes.describe(), 'direct (system proxy points at tunnel itself, ignored)')

  own = env.port + 1
  const elsewhere = await routes.route(target)
  assert.ok(elsewhere.kind === 'proxy')
  assert.equal(elsewhere.proxy.port, env.port + 1)

  // Once the listener is closed, the port is no longer tunnel's
  own = env.port
  await env.proxy.close()
  assert.equal((await routes.route(target)).kind, 'proxy')
})

// After a bracketed IPv6 address, a port that is not a number is an error, logged with its stack,
// and the connection is closed: in an absolute-form target, a Host header and a CONNECT alike
test('a port that is not a number closes the connection with one ERROR line', async (t) => {
  const env = await makeProxyEnv(t)
  const logs = captureLogs(t)
  env.decrypt({ include: ['*'] })
  const answered = async (request: string) => {
    const socket = await rawSocket(env.port)
    socket.write(request)
    return (await readToEnd(socket)).toString('latin1')
  }

  const close = 'connection: close\r\n\r\n'
  assert.equal(await answered(`GET http://[2001:db8::1]:12ab/x HTTP/1.1\r\n${close}`), '')
  assert.equal(await answered(`GET / HTTP/1.1\r\nhost: [::1]:abc\r\n${close}`), '')
  assert.equal(await answered('CONNECT [::1]:abc HTTP/1.1\r\nhost: [::1]:abc\r\n\r\n'), '')

  const errors = logs.records.filter((record) => record.level === 'error')
  assert.equal(errors.length, 3, logs.text())
  for (const error of errors) {
    const failed = 'The proxy connection from 127.0.0.1 failed\n'
    assert.ok(error.message.startsWith(failed), error.message)
  }
  assert.deepEqual(env.recorded(), [])
  assert.equal((await viaProxy(env.port, 'GET', 'http://api.example.com/api/feed')).status, 200)
})

// Node hands over a pipelined request while the one ahead of it is still being answered. Core meets
// them one at a time all the same, in the order they came, and meets none after an answer that
// dropped the connection
test('pipelined requests reach core one at a time, in the order they came, and none after a dropped connection', async (t) => {
  const env = await makeProxyEnv(t)
  const json = (which: string) => ({ mode: 'json', json_response: { which } }) as const
  env.configure('GET:api.example.com/slow', { ...json('slow'), response_delay: 0.3 })
  env.configure('GET:api.example.com/fast', json('fast'))
  env.configure('GET:api.example.com/drop', { mode: 'json', fault: 'close' })
  const get = (target: string) => `GET ${target} HTTP/1.1\r\nhost: api.example.com\r\n\r\n`
  const paths = () => env.recorded().map((exchange) => exchange.request.path)
  /** The bodies of the next `count` answers on one connection */
  const bodies = async (socket: Duplex, count: number) => {
    const read: string[] = []
    for (let i = 0; i < count; i++) {
      const head = await readHeaders(socket)
      const length = Number(/\r\ncontent-length: (\d+)\r\n/i.exec(head)?.[1])
      read.push((await readExactly(socket, length)).toString())
    }
    return read
  }

  // Both in one write, the slow one first
  const socket = await rawSocket(env.port)
  socket.write(get('http://api.example.com/slow') + get('http://api.example.com/fast'))
  assert.deepEqual(await bodies(socket, 2), ['{"which": "slow"}', '{"which": "fast"}'])
  socket.destroy()
  assert.deepEqual(paths(), ['/slow', '/fast'])

  // On a decrypted stream a CONNECT is one more request, and waits its turn as well: its
  // answer, written on the socket by hand, would otherwise go out ahead of the one before it
  env.decrypt({ include: ['api.example.com'] })
  const secure = await connectTunnel(env.port, 'api.example.com', 443, env.caPem)
  secure.write(get('/slow') + 'CONNECT inner.example.com:443 HTTP/1.1\r\nhost: inner\r\n\r\n')
  const [slow, nested] = await bodies(secure, 2)
  secure.destroy()
  assert.equal(slow, '{"which": "slow"}')
  assert.equal((JSON.parse(nested ?? '') as Echoed).method, 'CONNECT')

  // The close fault drops the connection, and the request behind it is never read
  const dropped = await rawSocket(env.port)
  dropped.write(get('http://api.example.com/drop') + get('http://api.example.com/fast'))
  assert.equal((await readToEnd(dropped)).length, 0)
  await sleep(100) // time enough for core to have met it, had it been handed over
  assert.deepEqual(paths(), ['/slow', '/fast', '/slow', '443', '/drop'])
})

// Each CONNECT on a decrypted stream hands its socket to the server again. The socket gets its
// error listener once, when the stream is decrypted: one more each time would make Node warn of a
// leak by the fifth (MaxListenersExceededWarning)
test('a decrypted stream that carries one CONNECT after another gathers no listeners', async (t) => {
  const env = await makeProxyEnv(t)
  env.decrypt({ include: ['api.example.com'] })
  const warnings: string[] = []
  const onWarning = (warning: Error) => warnings.push(warning.name)
  process.on('warning', onWarning)
  t.after(() => process.off('warning', onWarning))
  const secure = await connectTunnel(env.port, 'api.example.com', 443, env.caPem)
  const connection = new RawConnection(secure, 'api.example.com')

  for (let i = 0; i < 12; i++) {
    assert.equal((await connection.request('CONNECT', 'inner.example.com:443')).status, 200)
  }
  connection.close()

  assert.deepEqual(warnings, [])
})

// What a client sends behind its CONNECT, without waiting for the answer, goes through a tunnel
// ahead of the rest and counts as sent. Before a decryption it is dropped with a WARNING: those
// bytes are past the TLS about to start
test('bytes sent behind a CONNECT go through a tunnel first, and are dropped before a decryption', async (t) => {
  const env = await makeProxyEnv(t)
  const logs = captureLogs(t)
  const origin = await startUpstream(t, (req, res) => res.end(`origin saw ${req.url}`))
  const early = 'GET /early HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n'

  // Not decrypted: the request rides along with the CONNECT and reaches the origin
  const tunnel = await rawSocket(env.port)
  tunnel.write(`CONNECT localhost:${origin.port} HTTP/1.1\r\nhost: localhost\r\n\r\n${early}`)
  const reply = (await readToEnd(tunnel)).toString('latin1')
  const established = 'HTTP/1.1 200 Connection Established\r\n\r\nHTTP/1.1 200 OK\r\n'
  assert.ok(reply.startsWith(established), reply)
  assert.ok(reply.endsWith('origin saw /early'), reply)
  const [, , , up] = await eventually(() => env.tunnelled[0])
  assert.equal(up, early.length)

  // Decrypted: dropped with one WARNING, and the handshake that follows goes through
  env.decrypt({ include: ['api.example.com'] })
  env.configure('GET:api.example.com/after', { mode: 'json', json_response: { after: true } })
  const raw = await rawSocket(env.port)
  raw.write('CONNECT api.example.com:443 HTTP/1.1\r\nhost: api.example.com\r\n\r\nearly')
  assert.equal(await readHeaders(raw), 'HTTP/1.1 200 Connection Established\r\n\r\n')
  const secure = tlsConnect({ socket: raw, servername: 'api.example.com', ca: env.caPem })
  secure.on('error', () => {})
  await once(secure, 'secureConnect')
  const after = await new RawConnection(secure, 'api.example.com').request('GET', '/after')
  secure.destroy()
  assert.deepEqual(after.json(), { after: true })
  const warnings = logs.records.filter((record) => record.level === 'warning')
  assert.deepEqual(
    warnings.map((record) => record.message),
    [
      '127.0.0.1 sent 5 bytes before our answer to CONNECT api.example.com:443; the handshake may fail',
    ],
  )
})

// The install page is the plain port's: on a stream decrypted for ca.tunnel, a request is core's
// like any other, as the port answers its own pages only where no CONNECT has named the host
test('ca.tunnel on a decrypted stream is a request for core, not the install page', async (t) => {
  const env = await makeProxyEnv(t)
  env.decrypt({ include: ['ca.tunnel'] })

  const answer = await viaProxy(env.port, 'GET', 'https://ca.tunnel/', { caPem: env.caPem })

  assert.equal(echoed(answer).url, 'https://ca.tunnel/')
  assert.deepEqual(env.recorded().map(exchangeKey), ['GET:ca.tunnel/'])
})

// An absolute-form target names its own scheme, https here though it came in plain, and the
// default port that goes with it
test('an https:// URL sent to the plain port reaches core as https on port 443', async (t) => {
  const env = await makeProxyEnv(t)
  const connection = await plain(env.port, 'api.example.com')

  const answer = await connection.request('GET', 'https://api.example.com/api/feed')
  connection.close()

  assert.equal(echoed(answer).url, 'https://api.example.com/api/feed')
  const row = env.recorded().at(-1)
  assert.deepEqual([row?.request.scheme, row?.request.port], ['https', 443])
})

// start() rejects as Node says it, for the CLI to print, and leaves alone the routes and the
// listener that holds the port
test('start() on a port that is taken rejects with EADDRINUSE', async (t) => {
  const env = await makeProxyEnv(t)
  const second = new ProxyServer(env.core, env.manager, env.ca, {
    host: '127.0.0.1',
    port: env.port,
  })

  await assert.rejects(second.start(), { code: 'EADDRINUSE' })

  await second.close() // it never listened, so there is nothing to close
  assert.equal(env.core.routes.ownProxyPort, env.port)
  assert.equal((await viaProxy(env.port, 'GET', 'http://api.example.com/api/feed')).status, 200)
})

// Each CONNECT reads the SSL Proxying Locations again; a stream already decrypted stays decrypted
test('a change to ssl_proxying holds from the next CONNECT on and leaves an open stream as it was', async (t) => {
  const env = await makeProxyEnv(t)
  const origin = await startTlsUpstream(t, env.ca)
  env.configure('GET:localhost/probe', { mode: 'json', json_response: { who: 'the mock' } })
  env.decrypt({ include: ['localhost'] })
  const secure = await connectTunnel(env.port, 'localhost', origin.port, env.caPem)
  const open = new RawConnection(secure, `localhost:${origin.port}`)
  assert.deepEqual((await open.request('GET', '/probe')).json(), { who: 'the mock' })

  env.decrypt({ include: [] })

  const url = `https://localhost:${origin.port}/probe`
  const next = await viaProxy(env.port, 'GET', url, { caPem: env.caPem })
  assert.deepEqual(next.json(), { who: 'the real origin' })
  assert.deepEqual((await open.request('GET', '/probe')).json(), { who: 'the mock' })
  open.close()
})

// Header names from a rule or a script come in any case: the ones about this hop and its framing
// are left out whatever their case, and the rest go out as they were written
test('headers core gives in upper case are filtered as lower case and written as given', async (t) => {
  const env = await makeProxyEnv(t)
  env.configure('GET:api.example.com/api/feed', {
    mode: 'json',
    json_response: { cards: [] },
    headers: {
      'X-Custom': 'a',
      'Content-Length': '999',
      Connection: 'keep-alive',
      'Transfer-Encoding': 'chunked',
    },
  })
  const socket = await rawSocket(env.port)

  socket.write(
    'GET http://api.example.com/api/feed HTTP/1.1\r\nhost: api.example.com\r\nconnection: close\r\n\r\n',
  )
  const [head = '', body] = (await readToEnd(socket)).toString('latin1').split('\r\n\r\n')

  const lines = head.split('\r\n').slice(1)
  assert.ok(lines.includes('X-Custom: a'), head)
  const framing = /^(content-length|connection|transfer-encoding):/i
  assert.deepEqual(
    lines.filter((line) => framing.test(line)),
    ['content-length: 13'],
  )
  assert.equal(body, '{"cards": []}')
})
