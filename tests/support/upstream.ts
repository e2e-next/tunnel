// startUpstream(t, listener): a real HTTP server on the loopback, for the tests that need a socket after
// all. A test that only wants the core to forward somewhere uses fakeUpstream from ./fake-upstream.ts
// instead, which opens none.
// startHttpProxy(t, options): an HTTP proxy on the loopback, for the way out through a proxy.
import { once } from 'node:events'
import { createServer, type RequestListener, type Server } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import type { TestContext } from 'node:test'
import tls from 'node:tls'
import { ALPN_PROTOCOLS, type CertificateAuthority } from '../../src/certs.ts'

/** Listens on a free port of 127.0.0.1 and stops once the test is over (t.after), its connections with it: a
 *  keep-alive connection some client left open would otherwise hold the server, and so the test process, for
 *  the five seconds of Node's keepAliveTimeout. `base` is `http://127.0.0.1:<port>`, no slash at the end */
export async function startUpstream(
  t: TestContext,
  listener: RequestListener,
): Promise<{ base: string; port: number; server: Server }> {
  const server = createServer(listener)
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  )
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  return { base: `http://127.0.0.1:${port}`, port, server }
}

/** An HTTP proxy on 127.0.0.1:0. Answers an absolute-form request itself: 200, text/plain,
 *  `via proxy: <request line>`. A CONNECT is answered 407 unless `require` is absent or the request's
 *  Proxy-Authorization equals it; otherwise `200 Connection established` and the bytes are piped to `connectTo`
 *  (default: the host and port asked for). `seen` gets every request line with its raw headers, in order */
export async function startHttpProxy(
  t: TestContext,
  options?: { connectTo?: { host: string; port: number }; require?: string },
): Promise<{ port: number; seen: { line: string; headers: string[] }[]; server: Server }> {
  const seen: { line: string; headers: string[] }[] = []
  // Both ends of every tunnel: a socket a CONNECT took is out of the server's hands, and
  // closeAllConnections() does not see it
  const tunnels = new Set<Duplex>()
  const server = createServer((req, res) => {
    const line = `${req.method} ${req.url} HTTP/${req.httpVersion}`
    seen.push({ line, headers: req.rawHeaders })
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(`via proxy: ${line}`)
  })
  server.on('connect', (req, socket, head) => {
    seen.push({ line: `CONNECT ${req.url} HTTP/${req.httpVersion}`, headers: req.rawHeaders })
    tunnels.add(socket)
    // An end that fails closes, and takes the other end with it: a client that lets go first is no failure
    // of the proxy's
    socket.on('error', () => {})
    if (options?.require !== undefined && req.headers['proxy-authorization'] !== options.require) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
      return
    }
    const to = options?.connectTo ?? splitAuthority(req.url ?? '')
    const upstream = connect(to.port, to.host)
    tunnels.add(upstream)
    upstream.on('error', () => {})
    upstream.on('close', () => socket.destroy())
    socket.on('close', () => upstream.destroy())
    upstream.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection established\r\n\r\n')
      upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
  })
  t.after(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of tunnels) socket.destroy()
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  )
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  return { port, seen, server }
}

/** `origin.test:443` or `[::1]:443` as the host and port to connect to */
function splitAuthority(authority: string): { host: string; port: number } {
  const colon = authority.lastIndexOf(':')
  const host = authority.slice(0, colon)
  return {
    host: host.startsWith('[') ? host.slice(1, -1) : host,
    port: Number(authority.slice(colon + 1)),
  }
}

/** What the origin startTlsUpstream starts answers, whatever it is asked */
const ORIGIN_BODY = Buffer.from('{"who": "the real origin"}')

/**
 * A real HTTPS server on 127.0.0.1:0, holding a certificate for `host` from the CA given.
 *
 * It stands in for the server a client was calling: when the proxy does not decrypt a host, this
 * is what answers, and what it says is proof the bytes went through untouched. It reads one
 * request, up to the empty line, answers 200 `{"who": "the real origin"}` with `connection: close`
 * and ends the connection. The certificate is handed out from SNICallback, for `host` whatever name
 * the client sent: tls.createServer({ secureContext }) ignores the context. Stops once the test is
 * over, the connections still open with it.
 */
export async function startTlsUpstream(
  t: TestContext,
  ca: Pick<CertificateAuthority, 'tlsOptionsFor'>,
  host = 'localhost',
): Promise<{ port: number; server: tls.Server }> {
  const sockets = new Set<tls.TLSSocket>()
  const server = tls.createServer({
    SNICallback: (_servername, callback) => callback(null, ca.tlsOptionsFor(host).secureContext),
    ALPNProtocols: [...ALPN_PROTOCOLS],
  })
  server.on('secureConnection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    // A client that goes away halfway is no failure of the origin's
    socket.on('error', () => {})
    let received = Buffer.alloc(0)
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk])
      if (!received.includes('\r\n\r\n')) return
      socket.off('data', onData)
      const head =
        'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n' +
        `connection: close\r\ncontent-length: ${ORIGIN_BODY.length}\r\n\r\n`
      socket.end(Buffer.concat([Buffer.from(head), ORIGIN_BODY]))
    }
    socket.on('data', onData)
  })
  t.after(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  )
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  return { port, server }
}
