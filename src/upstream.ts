// The client for the real server, as little of one as a proxy needs: carry a request on to it and hand back what
// came back, as the wire carried it. The core builds the request, decodes the answer with decodeContent and turns
// an UpstreamError into a 502. Which way a request leaves, straight there or through the HTTP proxy this Mac is
// set to, is upstream-route.ts's to say; this module goes the way it is told, and opens the tunnels the proxy
// port does not decrypt the same way (openTunnel).
//
// node:http and node:https rather than fetch, which was made for scripts in a browser: nearly everything it
// does for its caller a proxy would have to undo. It follows redirects; adds sec-fetch-mode,
// accept-language, user-agent, accept and accept-encoding to every request; refuses a list of ports outright
// (6000 and 10080 among them, a browser's safety rule); decompresses the body but leaves content-encoding
// and a content-length that no longer holds; does zstd on some Node versions and not on others; and its
// timeout is one deadline for the whole exchange, not a limit on each wait. With all of that turned off, what
// is left is what http.request does anyway.
import { Buffer } from 'node:buffer'
import * as http from 'node:http'
import * as https from 'node:https'
import * as net from 'node:net'
import * as tls from 'node:tls'
import * as zlib from 'node:zlib'
import { UpstreamRoutes, type ProxyEndpoint, type Route } from './upstream-route.ts'

/** How long the upstream may stay silent, connecting included */
export const UPSTREAM_TIMEOUT_MS = 30_000

/** One request on its way to the real server. `url` is the whole address, query included; `headers` have
 *  already lost host, content-length and transfer-encoding (the core drops them), names as the proxy gave them */
export interface UpstreamRequest {
  method: string
  url: string
  headers: Record<string, string>
  body: Buffer
}
/** What came back, as the wire carried it: headers lower-cased and joined with ', ' when repeated, body still
 *  content-encoded. The core decodes it and drops the framing headers */
export interface UpstreamResponse {
  status: number
  headers: Record<string, string>
  body: Buffer
}
/** The upstream, not tunnel, failed: unreachable, timed out, refused the TLS handshake, spoke something that is
 *  not HTTP, or was given an address with no http(s) scheme; or the proxy on the way could not be reached or said
 *  no to the CONNECT. The core answers 502 with its message */
export class UpstreamError extends Error {
  override name = 'UpstreamError'
  /** The proxy the request went through, the way people see it — `the proxy 127.0.0.1:3128 (system proxy)` —
   *  or null when it went straight to the server. The core puts it into the 502's detail */
  readonly via: string | null

  constructor(message: string, options?: ErrorOptions & { via?: string | null }) {
    super(message, options)
    this.via = options?.via ?? null
  }
}
/** The injection point for tests: a fake opens no socket at all */
export interface UpstreamClient {
  send(request: UpstreamRequest): Promise<UpstreamResponse>
  /** Release keep-alive sockets. Idempotent */
  close(): Promise<void>
}
/** The real one: node:http / node:https with keep-alive agents of its own, TLS verified against Node's CA store.
 *  Each request asks `routes` which way to go: straight there, or through an HTTP proxy (absolute form for http,
 *  CONNECT then TLS for https), always on an agent of its own so NODE_USE_ENV_PROXY cannot wrap it */
export function nodeUpstream(options?: {
  timeoutMs?: number
  /** Which way each request leaves. Default `new UpstreamRoutes()`: the real environment and system proxy */
  routes?: UpstreamRoutes
  /** Trust this CA instead of Node's store, for the end to the real server. Tests only */
  ca?: string | Buffer
}): UpstreamClient {
  const timeoutMs = options?.timeoutMs ?? UPSTREAM_TIMEOUT_MS
  const routes = options?.routes ?? new UpstreamRoutes()
  const ca = options?.ca
  // Agents of its own rather than Node's global ones, so that close() can let go of the sockets they keep
  // alive: an idle one holds the server's end open, and with it a test process, for seconds. With one named
  // on every request (and agent: false on a CONNECT), NODE_USE_ENV_PROXY has no global agent to put a proxy
  // of Node's choosing under it. Verification stays on: passthrough talks to the real server, and a device
  // trusting tunnel's CA is no reason for tunnel to trust anyone.
  const httpAgent = new http.Agent({ keepAlive: true })
  const httpsAgent = new https.Agent({ keepAlive: true, ca })
  // Each proxy's own pair, made when it is first used. One the routes stopped naming stays until close().
  // By the setting that named it as well: an UpstreamError says which, and HTTP_PROXY and HTTPS_PROXY
  // often name the same proxy
  const proxyAgents = new Map<string, { http: http.Agent; https: TunnelAgent }>()
  const agentsOf = (proxy: ProxyEndpoint) => {
    const key = `${proxy.host}:${proxy.port}:${proxy.authorization ?? ''}:${proxy.source}`
    let agents = proxyAgents.get(key)
    if (agents === undefined) {
      agents = {
        http: new http.Agent({ keepAlive: true }),
        https: new TunnelAgent(proxy, timeoutMs, ca),
      }
      proxyAgents.set(key, agents)
    }
    return agents
  }

  return {
    async send(request) {
      if (!URL.canParse(request.url)) throw new UpstreamError(`Invalid URL: ${request.url}`)
      const url = new URL(request.url)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        const message = `Unsupported protocol in ${request.url}: only http and https can be forwarded`
        throw new UpstreamError(message)
      }
      const secure = url.protocol === 'https:'
      const hostname = unbracketed(url.hostname)
      const route = await routes.route({
        scheme: secure ? 'https' : 'http',
        host: hostname,
        port: Number(url.port) || (secure ? 443 : 80),
      })
      const proxy = route.kind === 'proxy' ? route.proxy : null
      const via = proxy === null ? null : viaOf(proxy)

      const { body } = request
      const headers = { ...request.headers }
      // Every body is given its length. Node does so only for the methods that usually carry one
      // (POST, PUT, PATCH…): a GET, DELETE or OPTIONS body would go out with no length and no chunking,
      // and the server would read it as the next request. An empty body is left to Node, which then
      // sends 0 for POST, PUT and PATCH and nothing for GET and DELETE.
      if (body.length > 0) headers['content-length'] = String(body.length)
      let where: http.RequestOptions
      if (proxy !== null && !secure) {
        // To the proxy, with the whole address on the request line (absolute form): the target the direct
        // way sends, its scheme and host in front. Node would put the proxy's own address in the Host
        // header, and adds none when one is given: the target's goes there
        const path = url.origin + url.pathname + url.search
        where = { host: proxy.host, port: proxy.port, path, agent: agentsOf(proxy).http }
        headers.host = url.host
        if (proxy.authorization !== null) {
          for (const name of Object.keys(headers)) {
            if (name.toLowerCase() === 'proxy-authorization') delete headers[name]
          }
          headers['proxy-authorization'] = proxy.authorization
        }
      } else {
        // An https target through a proxy goes as it would straight there, on the proxy's TunnelAgent: each
        // connection that agent opens is a CONNECT to the proxy and TLS to the server over it
        const agent = proxy !== null ? agentsOf(proxy).https : secure ? httpsAgent : httpAgent
        where = { hostname, port: url.port || undefined, path: url.pathname + url.search, agent }
      }
      const requestOptions: http.RequestOptions = {
        ...where,
        method: request.method,
        headers,
        // How long the socket may stay idle, connecting included: a timeout for each wait, not one
        // deadline for the whole exchange
        timeout: timeoutMs,
      }

      return new Promise<UpstreamResponse>((resolve, reject) => {
        const fail = (error: unknown) => reject(asUpstreamError(error, via))
        let req: http.ClientRequest
        try {
          req = secure ? https.request(requestOptions) : http.request(requestOptions)
        } catch (error) {
          // A header Node will not send (ERR_INVALID_CHAR, ERR_INVALID_HTTP_TOKEN) throws right here,
          // and counts as the upstream's failure too
          fail(error)
          return
        }
        // destroy(error) makes the 'error' event carry it, so a timeout rejects down the same path
        req.on('timeout', () => {
          req.destroy(new UpstreamError(`timed out after ${timeoutMs / 1000} seconds`, { via }))
        })
        req.on('error', fail)
        req.on('response', (res) => {
          readBody(res).then((received) => {
            const status = res.statusCode ?? 0
            resolve({ status, headers: joinedHeaders(res.rawHeaders), body: received })
          }, fail)
        })
        if (body.length > 0) req.end(body)
        else req.end()
      })
    },
    async close() {
      httpAgent.destroy()
      httpsAgent.destroy()
      for (const agents of proxyAgents.values()) {
        agents.http.destroy()
        agents.https.destroy()
      }
    },
  }
}

/** A raw connection to host:port for a CONNECT that tunnel does not decrypt: straight there, or through
 *  the HTTP proxy `routes` picks for an https target, with a CONNECT of our own. `host` is a name or an address as
 *  net.connect takes it, an IPv6 one without its brackets (`[::1]:443` comes as `::1` and 443). Resolves once bytes
 *  can flow, the timeout (connecting only, default UPSTREAM_TIMEOUT_MS) cleared. A network failure, a proxy that
 *  cannot be reached or answers the CONNECT with anything but 2xx rejects with UpstreamError (`via` set when a proxy
 *  was used); what Node throws for a bad argument (ERR_SOCKET_BAD_PORT) is rejected as it is */
export async function openTunnel(
  routes: UpstreamRoutes,
  host: string,
  port: number,
  options?: { timeoutMs?: number },
): Promise<{ socket: net.Socket; route: Route }> {
  const timeoutMs = options?.timeoutMs ?? UPSTREAM_TIMEOUT_MS
  const route = await routes.route({ scheme: 'https', host, port })
  const socket =
    route.kind === 'proxy'
      ? await connectThrough(route.proxy, host, port, timeoutMs)
      : await connectStraight(host, port, timeoutMs)
  return { socket, route }
}

/** The body with its content-encoding undone: gzip, x-gzip (which RFC 9110 has a recipient read as gzip),
 *  deflate (zlib-wrapped or raw), br, zstd. Several are undone right to left; a name with no decoder (identity, or
 *  one zlib cannot do) is skipped and the others undone all the same; an empty body comes back as it is. Throws
 *  zlib's error on a body that does not decode (the core turns that into a 500) */
export function decodeContent(body: Buffer, contentEncoding: string | undefined): Buffer {
  if (!contentEncoding) return body
  let decoded = body
  // Applied in the order listed, so undone from the right
  const names = contentEncoding.split(',').map((name) => name.trim().toLowerCase())
  for (const name of names.reverse()) {
    const decode = decoders.get(name)
    // A name with no decoder is passed over and the others still come off. No bytes is nothing to undo: a
    // HEAD, 204 or 304 may name the encoding its body would have had, and zlib throws Z_BUF_ERROR (unexpected
    // end of file) on no bytes
    if (decode !== undefined && decoded.length > 0) decoded = decode(decoded)
  }
  return decoded
}

// By the name content-encoding gives. A Map, so that a name such as __proto__ finds nothing
const decoders = new Map<string, (body: Buffer) => Buffer>([
  ['gzip', (body) => zlib.gunzipSync(body)],
  ['x-gzip', (body) => zlib.gunzipSync(body)],
  // zlib-wrapped is what the name means and raw is what some servers send under it: the one is tried and
  // then the other
  [
    'deflate',
    (body) => {
      try {
        return zlib.inflateSync(body)
      } catch {
        return zlib.inflateRawSync(body)
      }
    },
  ],
  ['br', (body) => zlib.brotliDecompressSync(body)],
])
// zlib has zstd from Node 22.15 on; to one without it, zstd is an encoding it cannot do
if (typeof zlib.zstdDecompressSync === 'function') {
  decoders.set('zstd', (body) => zlib.zstdDecompressSync(body))
}

/** Any failure on the way as an UpstreamError, the original as its cause, `via` the proxy it went through.
 *  Where every address of a name refused (localhost: ::1 and 127.0.0.1), Node's error is an AggregateError
 *  with an empty message, and its code (ECONNREFUSED) says what happened instead. One of ours is made with
 *  its `via` already and stays as it is */
function asUpstreamError(error: unknown, via: string | null): UpstreamError {
  if (error instanceof UpstreamError) return error
  const { message, code } = error as NodeJS.ErrnoException
  return new UpstreamError(message || code || String(error), { cause: error, via })
}

/** A proxy the way an UpstreamError's via names it: `the proxy 127.0.0.1:3128 (system proxy)` */
function viaOf(proxy: ProxyEndpoint): string {
  return `the proxy ${proxy.label} (${proxy.source})`
}

/** One proxy's agent for https targets: each connection it opens is a CONNECT to the proxy and then TLS to
 *  the server over that socket, and Node keeps these alive and reuses them per server as it does its own:
 *  two requests to a server, one CONNECT */
class TunnelAgent extends https.Agent {
  readonly #proxy: ProxyEndpoint
  readonly #timeoutMs: number

  constructor(proxy: ProxyEndpoint, timeoutMs: number, ca: string | Buffer | undefined) {
    super({ keepAlive: true, ca })
    this.#proxy = proxy
    this.#timeoutMs = timeoutMs
  }

  /** Hands the socket to `callback` once the proxy said yes and TLS is under way; a CONNECT that fails goes
   *  to it as the request's error. The request's own timeout takes over from there */
  override createConnection(
    options: https.RequestOptions,
    callback?: (error: Error | null, socket: net.Socket) => void,
  ): undefined {
    const host = options.host ?? 'localhost' // http.request has always filled it in
    connectThrough(this.#proxy, host, Number(options.port), this.#timeoutMs)
      // The request's options go to TLS the way Node's own agent passes them, the CA among them. The name
      // goes as SNI and is what the certificate is checked against; an address goes as no SNI
      .then((socket) =>
        tls.connect({
          ...(options as tls.ConnectionOptions),
          socket,
          servername: net.isIP(host) === 0 ? host : undefined,
        }),
      )
      .then(
        (secure) => callback?.(null, secure),
        // With the error alone, as Node's own agents call back; its types want a socket there too
        (error: Error) => callback?.(error, undefined as never),
      )
    return undefined
  }
}

/** A socket to host:port through an HTTP proxy, once it said yes to our CONNECT: what an https target goes over
 *  (TunnelAgent), and what openTunnel hands the proxy port for a CONNECT it does not decrypt. The timeout runs until
 *  the proxy answers and is cleared then. Whatever fails is an UpstreamError that names the proxy */
function connectThrough(
  proxy: ProxyEndpoint,
  host: string,
  port: number,
  timeoutMs: number,
): Promise<net.Socket> {
  const via = viaOf(proxy)
  const authority = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`
  const headers: Record<string, string> = { host: authority }
  if (proxy.authorization !== null) headers['proxy-authorization'] = proxy.authorization
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: authority,
      headers,
      agent: false,
      timeout: timeoutMs,
    })
    req.on('timeout', () => {
      req.destroy(new UpstreamError(`timed out after ${timeoutMs / 1000} seconds`, { via }))
    })
    req.on('error', (error) => reject(asUpstreamError(error, via)))
    // The proxy's answer to a CONNECT comes here whatever it is, a 407 as well as a 200
    req.on('connect', (res, socket, head) => {
      const status = res.statusCode ?? 0
      if (status < 200 || status >= 300) {
        socket.destroy()
        const message = `the proxy answered CONNECT with ${status} ${res.statusMessage}`
        reject(new UpstreamError(message, { via }))
        return
      }
      socket.setTimeout(0)
      // Bytes the proxy sent after its answer belong to the tunnel
      if (head.length > 0) socket.unshift(head)
      resolve(socket)
    })
    req.end()
  })
}

/** A socket to host:port, straight there, once it is connected: the timeout runs until then and is cleared,
 *  and the listeners put on for the connecting are taken off again */
function connectStraight(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  // Throws for a port out of range (ERR_SOCKET_BAD_PORT) right here: openTunnel rejects with it as it is
  const socket = net.connect({ host, port, timeout: timeoutMs })
  return new Promise((resolve, reject) => {
    const onTimeout = () => {
      socket.destroy(new UpstreamError(`timed out after ${timeoutMs / 1000} seconds`))
    }
    const onError = (error: Error) => reject(asUpstreamError(error, null))
    socket.once('timeout', onTimeout)
    socket.once('error', onError)
    socket.once('connect', () => {
      socket.setTimeout(0)
      socket.off('timeout', onTimeout)
      socket.off('error', onError)
      resolve(socket)
    })
  })
}

/** The whole body, as it came. One cut off halfway is 'aborted' and then an 'error' (ECONNRESET, message
 *  "aborted"); 'aborted' is deprecated, so the 'error' alone is listened to */
function readBody(res: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    res.on('data', (chunk: Buffer) => chunks.push(chunk))
    res.on('error', reject)
    res.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

/** Every name lower-cased and given once, the values of a repeated one joined with ', ', set-cookie included.
 *  From rawHeaders, because res.headers keeps only the first of two content-types and makes set-cookie an
 *  array */
function joinedHeaders(rawHeaders: readonly string[]): Record<string, string> {
  const joined = new Map<string, string>()
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i]!.toLowerCase()
    const value = rawHeaders[i + 1]!
    const earlier = joined.get(name)
    joined.set(name, earlier === undefined ? value : `${earlier}, ${value}`)
  }
  // Gathered in a Map and made an object by fromEntries, where a header named __proto__ is a key like any
  // other; assigned to a plain object it would set the prototype instead
  return Object.fromEntries(joined)
}

/** new URL('http://[::1]:8080/').hostname keeps the brackets, and http.request would look '[::1]' up as a name */
function unbracketed(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}
