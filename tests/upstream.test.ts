// src/upstream.ts, the half of forwarding that talks to the real server: nodeUpstream against real servers
// on the loopback, straight there and through a proxy, openTunnel, decodeContent, and the one a TunnelCore
// builds for itself. Every route is a testRoutes(): what a test hands it, never the environment or macOS's
// proxy settings. origin.test, the name behind the proxy, is never looked up: the proxy connects to a
// server on 127.0.0.1 in its place.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, type RequestListener } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { performance } from 'node:perf_hooks'
import type { Duplex } from 'node:stream'
import { test, type TestContext } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import {
  brotliCompressSync,
  deflateRawSync,
  deflateSync,
  gzipSync,
  zstdCompressSync,
} from 'node:zlib'
import { CertificateAuthority } from '../src/certs.ts'
import { Paths, TunnelConfigManager } from '../src/config.ts'
import { TunnelCore } from '../src/core.ts'
import { makeRequest } from '../src/messages.ts'
import {
  decodeContent,
  nodeUpstream,
  openTunnel,
  UpstreamError,
  type UpstreamClient,
  type UpstreamRequest,
} from '../src/upstream.ts'
import { testRoutes } from './support/routes.ts'
import { tmpDir } from './support/tmp.ts'
import { startHttpProxy, startUpstream } from './support/upstream.ts'

const payload = Buffer.from('{"compressed": true}')

// One server for every test, routed by path
const listener: RequestListener = (req, res) => {
  switch (new URL(req.url ?? '/', 'http://x').pathname) {
    case '/':
      res.end('ok')
      return
    case '/dups':
      res.writeHead(200, [
        ...['Set-Cookie', 'a=1', 'Set-Cookie', 'b=2'],
        ...['X-Dup', 'one', 'x-dup', 'two'],
        ...['Content-Type', 'text/plain', 'content-type', 'text/html'],
      ])
      res.end('dups')
      return
    case '/gzip': {
      const gzipped = gzipSync(payload)
      res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': gzipped.length })
      res.end(gzipped)
      return
    }
    case '/redirect':
      res.writeHead(302, { location: '/landed' })
      res.end('go there')
      return
    case '/echo': {
      // What arrived: the headers as they came over the wire and as Node files them, and the body
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString()
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ rawHeaders: req.rawHeaders, headers: req.headers, body }))
      })
      return
    }
    case '/hang':
      return // never answers
    case '/head':
      res.writeHead(200, { 'content-length': 5 })
      if (req.method === 'HEAD') res.end()
      else res.end('hello')
      return
    case '/204':
      res.writeHead(204)
      res.end()
      return
    case '/304':
      res.writeHead(304)
      res.end()
      return
    case '/1xx':
      res.writeProcessing()
      res.end('after 102')
      return
    case '/abort-mid-body':
      res.writeHead(200, { 'content-length': 100 })
      res.write('first half')
      setTimeout(() => res.socket?.destroy(), 30)
      return
    default:
      res.writeHead(404)
      res.end()
  }
}

function send(client: UpstreamClient, url: string, fields?: Partial<UpstreamRequest>) {
  return client.send({ method: 'GET', headers: {}, body: Buffer.alloc(0), ...fields, url })
}

/** For assert.rejects: the error is an UpstreamError, and `check` asserts the rest about it */
function upstreamError(check: (error: UpstreamError) => void) {
  return (error: unknown) => {
    assert.ok(error instanceof UpstreamError, `not an UpstreamError: ${String(error)}`)
    check(error)
    return true
  }
}

/** us@er:p:ss as a proxy URL carries it, percent-encoded, and the Proxy-Authorization it makes */
const CREDENTIALS = 'us%40er:p%3Ass'
const AUTHORIZATION = 'Basic dXNAZXI6cDpzcw=='

/** A raw header list as [name, value] pairs */
function pairs(raw: readonly string[]): [string, string][] {
  const found: [string, string][] = []
  for (let i = 0; i + 1 < raw.length; i += 2) found.push([raw[i]!, raw[i + 1]!])
  return found
}

/** An https server on 127.0.0.1:0 that holds a certificate for whatever name a client asks for, from a CA in a
 *  fresh directory, and answers with the SNI it was asked by and the path. Closed in t.after */
async function startTlsOrigin(t: TestContext): Promise<{ ca: CertificateAuthority; port: number }> {
  const ca = new CertificateAuthority(Paths.inOneDirectory(tmpDir(t)))
  const server = createHttpsServer(
    { SNICallback: (name, callback) => callback(null, ca.tlsOptionsFor(name).secureContext) },
    (req, res) => {
      const body = JSON.stringify({ sni: (req.socket as TLSSocket).servername, path: req.url })
      // A length rather than chunks, so that the answer read off a raw tunnel ends with the body itself
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      })
      res.end(body)
    },
  )
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  )
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { ca, port: (server.address() as AddressInfo).port }
}

/** The port of a proxy that takes a CONNECT and never answers it: startUpstream's server, with a 'connect'
 *  listener that keeps the socket. Those are let go of before the server closes, as t.after runs in the
 *  order it was given */
async function startSilentProxy(t: TestContext): Promise<number> {
  const held = new Set<Duplex>()
  t.after(() => {
    for (const socket of held) socket.destroy()
  })
  const { port, server } = await startUpstream(t, listener)
  server.on('connect', (_req, socket) => {
    socket.on('error', () => {})
    held.add(socket)
  })
  return port
}

test('decodeContent decodes every encoding zlib knows, right to left, and leaves the rest alone', () => {
  const gzipped = gzipSync(payload)
  for (const encoding of ['gzip', 'x-gzip', ' GZIP ']) {
    assert.deepEqual(decodeContent(gzipped, encoding), payload, encoding)
  }
  // deflate is zlib-wrapped by the book and raw from some servers: both come back
  assert.deepEqual(decodeContent(deflateSync(payload), 'deflate'), payload)
  assert.deepEqual(decodeContent(deflateRawSync(payload), 'deflate'), payload)
  assert.deepEqual(decodeContent(brotliCompressSync(payload), 'br'), payload)
  assert.deepEqual(decodeContent(zstdCompressSync(payload), 'zstd'), payload)
  // Applied in the order listed, so undone from the right: the gzip on the outside first, then the br
  assert.deepEqual(decodeContent(gzipSync(brotliCompressSync(payload)), 'br, gzip'), payload)
  for (const encoding of ['identity', '', undefined, 'foo', '__proto__']) {
    assert.deepEqual(decodeContent(gzipped, encoding), gzipped, String(encoding))
  }
  // The gzip on the outside comes off; foo underneath it cannot, so what is left is passed on
  assert.deepEqual(decodeContent(gzipped, 'foo, gzip'), payload)
  // A name with no decoder is passed over and the rest are undone all the same: foo on the outside does
  // not stop the gzip under it from coming off
  assert.deepEqual(decodeContent(gzipped, 'gzip, foo'), payload)
  // No bytes, nothing to undo: a HEAD, 204 or 304 may name the encoding its body would have had. zlib
  // throws Z_BUF_ERROR on an empty input, here and where an outer layer comes off empty
  const empty = Buffer.alloc(0)
  for (const encoding of ['gzip', 'x-gzip', 'deflate', 'br', 'zstd', 'br, gzip']) {
    assert.deepEqual(decodeContent(empty, encoding), empty, encoding)
  }
  assert.deepEqual(decodeContent(gzipSync(empty), 'br, gzip'), empty)
  assert.throws(() => decodeContent(Buffer.from('not gzip'), 'gzip'), { code: 'Z_DATA_ERROR' })
})

test("a GET brings back the status, the raw bytes, and the headers lower-cased and joined with ', '", async (t) => {
  const { base } = await startUpstream(t, listener)
  const client = nodeUpstream({ routes: testRoutes() })

  const dups = await send(client, `${base}/dups`)
  assert.equal(dups.status, 200)
  assert.equal(dups.headers['set-cookie'], 'a=1, b=2')
  // Node's res.headers keeps only the first of the two: this one says they come from rawHeaders
  assert.equal(dups.headers['content-type'], 'text/plain, text/html')
  assert.equal(dups.headers['x-dup'], 'one, two')
  for (const name of Object.keys(dups.headers)) assert.equal(name, name.toLowerCase())

  // zlib writes 0 for the gzip header's time, so the same payload gzips to the same bytes here
  const gzipped = gzipSync(payload)
  const answer = await send(client, `${base}/gzip`)
  assert.deepEqual(answer.body, gzipped)
  assert.equal(answer.headers['content-encoding'], 'gzip')
  assert.equal(answer.headers['content-length'], String(gzipped.length))
  await client.close()
})

test('a 3xx is handed back as it is, not followed', async (t) => {
  const { base } = await startUpstream(t, listener)
  const client = nodeUpstream({ routes: testRoutes() })
  const answer = await send(client, `${base}/redirect`)
  assert.equal(answer.status, 302)
  assert.equal(answer.headers.location, '/landed')
  assert.equal(answer.body.toString(), 'go there')
  await client.close()
})

test('request headers reach the server as given, and nothing is added beyond Host, Connection and Content-Length', async (t) => {
  const { base } = await startUpstream(t, listener)
  const client = nodeUpstream({ routes: testRoutes() })
  const headers = { 'X-Keep': 'Me', 'accept-language': 'zh' }
  const answer = await send(client, `${base}/echo`, { headers })
  const { rawHeaders } = JSON.parse(answer.body.toString()) as { rawHeaders: string[] }
  // Names as given, case and all; no accept, accept-encoding, user-agent or sec-fetch-mode
  const names = rawHeaders.filter((_, i) => i % 2 === 0)
  assert.deepEqual(names, ['X-Keep', 'accept-language', 'Host', 'Connection'])
  await client.close()
})

test("content-length is the body's length whatever the method, and 0 only where Node puts it", async (t) => {
  const { base } = await startUpstream(t, listener)
  const client = nodeUpstream({ routes: testRoutes() })
  const echo = async (method: string, body: string) => {
    const answer = await send(client, `${base}/echo`, { method, body: Buffer.from(body) })
    return JSON.parse(answer.body.toString()) as { headers: Record<string, string>; body: string }
  }
  // Node frames a GET or DELETE body with nothing at all, and the server would take it for the next
  // request: the length on these two is nodeUpstream's own
  for (const [method, body] of [
    ['POST', 'thirteen byte'],
    ['GET', 'seven b'],
    ['DELETE', 'xx'],
  ] as const) {
    const seen = await echo(method, body)
    assert.equal(seen.headers['content-length'], String(Buffer.byteLength(body)), method)
    assert.equal(seen.body, body, method)
  }
  for (const method of ['POST', 'PUT']) {
    assert.equal((await echo(method, '')).headers['content-length'], '0', method)
  }
  for (const method of ['GET', 'DELETE']) {
    assert.equal((await echo(method, '')).headers['content-length'], undefined, method)
  }
  await client.close()
})

test('what cannot be reached, parsed or forwarded rejects with an UpstreamError', async (t) => {
  const { base, port } = await startUpstream(t, listener)
  const client = nodeUpstream({ routes: testRoutes() })

  // A port nobody listens on any more. As localhost, both ::1 and 127.0.0.1 refuse, and Node's error
  // for the two has an empty message: the code stands in for it
  const gone = await startUpstream(t, listener)
  await new Promise<void>((resolve) => gone.server.close(() => resolve()))
  for (const url of [`${gone.base}/`, `http://localhost:${gone.port}/`]) {
    await assert.rejects(
      send(client, url),
      upstreamError((error) => assert.match(error.message, /ECONNREFUSED/)),
    )
  }

  // An upstream that never answers
  const impatient = nodeUpstream({ timeoutMs: 100, routes: testRoutes() })
  const started = performance.now()
  await assert.rejects(
    send(impatient, `${base}/hang`),
    upstreamError((error) => assert.equal(error.message, 'timed out after 0.1 seconds')),
  )
  assert.ok(performance.now() - started < 2000)
  await impatient.close()

  // TLS spoken to a server that speaks plain HTTP: OpenSSL reads its 400 as a record of a TLS version
  // that does not exist, and Node reports that as EPROTO
  await assert.rejects(
    send(client, `https://127.0.0.1:${port}/`),
    upstreamError((error) => {
      assert.equal((error.cause as NodeJS.ErrnoException).code, 'EPROTO')
      assert.match(error.message, /wrong version number/)
    }),
  )

  // Addresses that are not http(s) URLs. URL.canParse takes localhost:3000, with localhost: for scheme
  for (const [url, message] of [
    ['ftp://x/', 'Unsupported protocol in ftp://x/: only http and https can be forwarded'],
    ['nonsense', 'Invalid URL: nonsense'],
    [
      'localhost:3000',
      'Unsupported protocol in localhost:3000: only http and https can be forwarded',
    ],
  ] as const) {
    await assert.rejects(
      send(client, url),
      upstreamError((error) => assert.equal(error.message, message)),
    )
  }

  // A header Node refuses to send throws inside http.request
  await assert.rejects(
    send(client, `${base}/`, { headers: { 'x-bad': 'a\nb' } }),
    upstreamError((error) => assert.match(error.message, /Invalid character/)),
  )

  // An IPv6 address: new URL() keeps its brackets in hostname, http.request wants them off
  const server6 = createServer(listener)
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server6.closeAllConnections()
        server6.close(() => resolve())
      }),
  )
  server6.listen(0, '::1')
  const failed = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
    server6.once('listening', () => resolve(null))
    server6.once('error', resolve)
  })
  if (failed === null) {
    const { port: port6 } = server6.address() as AddressInfo
    assert.equal((await send(client, `http://[::1]:${port6}/`)).status, 200)
  } else if (failed.code === 'EADDRNOTAVAIL' || failed.code === 'EAFNOSUPPORT') {
    t.diagnostic('no IPv6 loopback, skipped')
  } else {
    throw failed
  }
  await client.close()
})

test('close() releases the keep-alive sockets and may be called twice', async (t) => {
  const { base, server } = await startUpstream(t, listener)
  const client = nodeUpstream({ routes: testRoutes() })
  const connections = () =>
    new Promise<number>((resolve, reject) =>
      server.getConnections((error, count) => (error ? reject(error) : resolve(count))),
    )
  await send(client, `${base}/`)
  assert.equal(await connections(), 1) // kept alive

  // Not server.close() as the evidence: since Node 19 it closes idle connections by itself, so it
  // resolves at once whether the client let go or not
  await client.close()
  for (let waited = 0; (await connections()) > 0; waited += 10) {
    assert.ok(waited < 500, 'the server still has the connection 500 ms after close()')
    await sleep(10)
  }
  const sockets = process.getActiveResourcesInfo().filter((name) => name === 'TCPSocketWrap')
  assert.equal(sockets.length, 0)
  await client.close()
})

test('HEAD, 204, 304 and a 1xx interim response come back with an empty body and the right status', async (t) => {
  const { base } = await startUpstream(t, listener)
  const client = nodeUpstream({ routes: testRoutes() })
  const head = await send(client, `${base}/head`, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.body.length, 0)
  assert.equal(head.headers['content-length'], '5') // the header stays, there is just no body
  for (const status of [204, 304]) {
    const answer = await send(client, `${base}/${status}`)
    assert.equal(answer.status, status)
    assert.equal(answer.body.length, 0)
  }
  const interim = await send(client, `${base}/1xx`)
  assert.equal(interim.status, 200)
  assert.equal(interim.body.toString(), 'after 102')
  await client.close()
})

test('an upstream that drops the connection mid-body rejects with an UpstreamError', async (t) => {
  const { base } = await startUpstream(t, listener)
  const client = nodeUpstream({ routes: testRoutes() })
  await assert.rejects(
    send(client, `${base}/abort-mid-body`),
    upstreamError((error) => assert.equal(error.message, 'aborted')),
  )
  await client.close()
})

test("an http target through a proxy goes in absolute form, with the target's Host and the proxy's credentials", async (t) => {
  const proxy = await startHttpProxy(t)
  const env = { HTTP_PROXY: `http://${CREDENTIALS}@127.0.0.1:${proxy.port}` }
  const client = nodeUpstream({ routes: testRoutes({ env }) })
  const answer = await send(client, 'http://origin.test:8080/x?y=1', {
    headers: { 'X-Keep': 'Me' },
  })
  const line = 'GET http://origin.test:8080/x?y=1 HTTP/1.1'
  assert.equal(answer.status, 200)
  assert.equal(answer.body.toString(), `via proxy: ${line}`)
  assert.deepEqual(
    proxy.seen.map((request) => request.line),
    [line],
  )
  // The request's own headers as given; the Host is the target's, not the proxy's address, which Node
  // would have put there
  assert.deepEqual(pairs(proxy.seen[0]!.headers), [
    ['X-Keep', 'Me'],
    ['host', 'origin.test:8080'],
    ['proxy-authorization', AUTHORIZATION],
    ['Connection', 'keep-alive'],
  ])
  // A user:password@ and a #fragment in the address stay off the request line, as they do on the way
  // straight there: a target carries no userinfo (RFC 9110, 4.2.4), and a fragment is the client's own
  await send(client, 'http://someone:secret@origin.test:8080/x?y=1#part')
  assert.deepEqual(
    proxy.seen.map((request) => request.line),
    [line, line],
  )
  await client.close()
})

test('an https target through a proxy is a CONNECT, then TLS to the server, kept alive for the next request', async (t) => {
  const origin = await startTlsOrigin(t)
  const proxy = await startHttpProxy(t, {
    connectTo: { host: '127.0.0.1', port: origin.port },
    require: AUTHORIZATION,
  })
  const env = { HTTPS_PROXY: `http://${CREDENTIALS}@127.0.0.1:${proxy.port}` }
  const client = nodeUpstream({ routes: testRoutes({ env }), ca: origin.ca.certificatePem() })
  for (const path of ['/y1', '/y2']) {
    const answer = await send(client, `https://origin.test${path}`)
    assert.equal(answer.status, 200)
    // TLS to origin.test itself: its name went as SNI, and its certificate was checked against it
    assert.deepEqual(JSON.parse(answer.body.toString()), { sni: 'origin.test', path })
  }
  // One CONNECT for both: the TLS connection is kept alive per server, as any other
  assert.deepEqual(
    proxy.seen.map(({ line, headers }) => [line, pairs(headers)]),
    [
      [
        'CONNECT origin.test:443 HTTP/1.1',
        [
          ['host', 'origin.test:443'],
          ['proxy-authorization', AUTHORIZATION],
          ['Connection', 'close'],
        ],
      ],
    ],
  )
  await client.close()
})

test('openTunnel connects straight to a local target, and through the proxy to any other, ready for TLS', async (t) => {
  // Local: straight there, nothing read
  const { port } = await startUpstream(t, listener)
  const local = await openTunnel(testRoutes(), '127.0.0.1', port)
  assert.deepEqual(local.route, { kind: 'direct', reason: 'local' })
  assert.equal(local.socket.remotePort, port)
  assert.equal(local.socket.timeout, 0) // it counted the connecting only
  local.socket.destroy()

  // Any other: a CONNECT to the proxy, and what comes back carries TLS to the server
  const origin = await startTlsOrigin(t)
  const proxy = await startHttpProxy(t, { connectTo: { host: '127.0.0.1', port: origin.port } })
  const routes = testRoutes({ env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` } })
  const tunnel = await openTunnel(routes, 'origin.test', 443)
  assert.equal(tunnel.route.kind, 'proxy')
  assert.equal(tunnel.socket.timeout, 0)
  assert.deepEqual(
    proxy.seen.map((request) => request.line),
    ['CONNECT origin.test:443 HTTP/1.1'],
  )
  const ca = origin.ca.certificatePem()
  const secure = tlsConnect({ socket: tunnel.socket, servername: 'origin.test', ca })
  await once(secure, 'secureConnect')
  secure.write('GET /z HTTP/1.1\r\nHost: origin.test\r\nConnection: close\r\n\r\n')
  const chunks: Buffer[] = []
  secure.on('data', (chunk: Buffer) => chunks.push(chunk))
  await once(secure, 'end')
  const answer = Buffer.concat(chunks).toString()
  assert.match(answer, /^HTTP\/1\.1 200 /)
  assert.ok(answer.endsWith('{"sni":"origin.test","path":"/z"}'), answer)
  secure.destroy()

  // A server that speaks first (an SMTP greeting, say), its first bytes in the same packet as the proxy's
  // 200: Node hands them over with the answer rather than leaving them on the socket, and they are still
  // the first bytes the socket gives
  const eager = await startUpstream(t, listener)
  eager.server.on('connect', (_req, socket) => {
    socket.on('error', () => {})
    socket.end('HTTP/1.1 200 Connection established\r\n\r\n220 origin.test ready\r\n')
  })
  const eagerRoutes = testRoutes({ env: { HTTPS_PROXY: `http://127.0.0.1:${eager.port}` } })
  const greeted = await openTunnel(eagerRoutes, 'origin.test', 25)
  const greeting: Buffer[] = []
  greeted.socket.on('data', (chunk: Buffer) => greeting.push(chunk))
  await once(greeted.socket, 'end')
  assert.equal(Buffer.concat(greeting).toString(), '220 origin.test ready\r\n')
  greeted.socket.destroy()

  // A port TCP does not have: what net.connect throws for it, as it is, not a failure of the network's
  await assert.rejects(openTunnel(testRoutes(), '127.0.0.1', 70000), (error: unknown) => {
    assert.ok(!(error instanceof UpstreamError), String(error))
    assert.equal((error as NodeJS.ErrnoException).code, 'ERR_SOCKET_BAD_PORT')
    return true
  })
})

test('whatever fails through a proxy rejects with an UpstreamError that names the proxy', async (t) => {
  /** The UpstreamError, through the proxy on `port` that `source` named */
  const failed = (port: number, source: string, message: string | RegExp) =>
    upstreamError((error) => {
      assert.equal(error.via, `the proxy http://127.0.0.1:${port} (${source})`)
      if (typeof message === 'string') assert.equal(error.message, message)
      else assert.match(error.message, message)
    })

  // A proxy port nobody listens on any more, for an http target as well
  const gone = await startUpstream(t, listener)
  await new Promise<void>((resolve) => gone.server.close(() => resolve()))
  const proxyUrl = `http://127.0.0.1:${gone.port}`
  const routes = testRoutes({ env: { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl } })
  const client = nodeUpstream({ routes })
  const refused = /ECONNREFUSED/
  await assert.rejects(
    send(client, 'http://origin.test/'),
    failed(gone.port, 'HTTP_PROXY', refused),
  )
  const https = failed(gone.port, 'HTTPS_PROXY', refused)
  await assert.rejects(send(client, 'https://origin.test/'), https)
  await assert.rejects(openTunnel(routes, 'origin.test', 443), https)
  await client.close()

  // A proxy that wants credentials and was given none
  const guarded = await startHttpProxy(t, { require: AUTHORIZATION })
  const guardedRoutes = testRoutes({ env: { HTTPS_PROXY: `http://127.0.0.1:${guarded.port}` } })
  const anonymous = nodeUpstream({ routes: guardedRoutes })
  const refusal = 'the proxy answered CONNECT with 407 Proxy Authentication Required'
  const answered = failed(guarded.port, 'HTTPS_PROXY', refusal)
  await assert.rejects(send(anonymous, 'https://origin.test/'), answered)
  await assert.rejects(openTunnel(guardedRoutes, 'origin.test', 443), answered)
  await anonymous.close()

  // A proxy that takes the CONNECT and never answers it
  const silent = await startSilentProxy(t)
  const silentRoutes = testRoutes({ env: { HTTPS_PROXY: `http://127.0.0.1:${silent}` } })
  const impatient = nodeUpstream({ routes: silentRoutes, timeoutMs: 100 })
  const timedOut = failed(silent, 'HTTPS_PROXY', 'timed out after 0.1 seconds')
  await assert.rejects(send(impatient, 'https://origin.test/'), timedOut)
  await assert.rejects(openTunnel(silentRoutes, 'origin.test', 443, { timeoutMs: 100 }), timedOut)
  await impatient.close()
})

test("the core's own upstream goes the way core.routes says", async (t) => {
  const proxy = await startHttpProxy(t)
  const server = await startUpstream(t, (_req, res) => res.end('straight to the server'))
  // Closed before tmpDir(t) goes: its log flushes into that directory
  let core: TunnelCore | undefined
  t.after(() => core?.close())
  const manager = new TunnelConfigManager(Paths.inOneDirectory(tmpDir(t)))
  // No upstream given: the one the core builds for itself asks these routes
  const routes = testRoutes({ env: { HTTP_PROXY: `http://127.0.0.1:${proxy.port}` } })
  core = new TunnelCore(manager, { routes })
  manager.updateRequestConfig('GET:/x', { mode: 'passthrough' })

  const proxied = await core.resolve(
    makeRequest({ method: 'GET', host: 'origin.test', path: '/x' }),
  )
  assert.equal(proxied.status, 200)
  assert.equal(proxied.body.toString(), 'via proxy: GET http://origin.test/x HTTP/1.1')

  // A local target goes straight there, past the proxy
  const local = makeRequest({ method: 'GET', host: '127.0.0.1', port: server.port, path: '/x' })
  const direct = await core.resolve(local)
  assert.equal(direct.status, 200)
  assert.equal(direct.body.toString(), 'straight to the server')
  assert.equal(proxy.seen.length, 1)
})

// An http target's answer comes from the proxy, and nothing tells the proxy's own 407 or 502 from the
// server's: it is passed on as the answer, and recorded with recording on
test("a proxy's own 407 to an http target is passed on and recorded as the answer", async (t) => {
  const proxy = await startUpstream(t, (_req, res) => {
    res.writeHead(407, { 'proxy-authenticate': 'Basic realm="proxy"' })
    res.end()
  })
  // Closed before tmpDir(t) goes: its log and store flush into that directory
  let core: TunnelCore | undefined
  t.after(() => core?.close())
  const manager = new TunnelConfigManager(Paths.inOneDirectory(tmpDir(t)))
  core = new TunnelCore(manager, { routes: testRoutes({ env: { HTTP_PROXY: proxy.base } }) })
  manager.updateRequestConfig('GET:/x', { mode: 'passthrough' })
  await core.recordings.start('default')

  const response = await core.resolve(
    makeRequest({ method: 'GET', host: 'origin.test', path: '/x' }),
  )

  assert.equal(response.status, 407)
  assert.equal(response.headers['proxy-authenticate'], 'Basic realm="proxy"')
  const recorded = await core.recordings.index()
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0]!.status, 407)
})

// An IPv6 target is written in brackets in the CONNECT's line and its host header, as an authority is
test('a CONNECT through a proxy writes an IPv6 target in brackets', async (t) => {
  const server = await startUpstream(t, listener)
  const proxy = await startHttpProxy(t, { connectTo: { host: '127.0.0.1', port: server.port } })
  const routes = testRoutes({ env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` } })

  const tunnel = await openTunnel(routes, '2001:db8::1', 443)
  tunnel.socket.destroy()

  assert.equal(tunnel.route.kind, 'proxy')
  const [connect] = proxy.seen
  assert.equal(connect?.line, 'CONNECT [2001:db8::1]:443 HTTP/1.1')
  const host = connect!.headers.findIndex((name) => name.toLowerCase() === 'host')
  assert.equal(connect!.headers[host + 1], '[2001:db8::1]:443')
})
