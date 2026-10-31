// The forward proxy listener: the port a device points its proxy setting at.
//
// Everything a client sends arrives here. Plain HTTP arrives as an absolute-form
// request line (`GET http://api.example.com/feed HTTP/1.1`) and is answered
// through the same core the admin API configures. HTTPS arrives as
// `CONNECT api.example.com:443`, and what happens next is decided by the SSL
// Proxying Locations: a host that is listed gets a certificate minted on the spot
// and its requests are read and answered one by one, while every other host is
// tunnelled through byte for byte — the row Charles shows as `<encrypted>`.
//
// The admin port keeps the management API and stays on the loopback address. This
// port has to be reachable from a phone on the same Wi-Fi, so it binds every
// interface and hands out nothing but answers: it only accepts connections from
// the private ranges a device on that Wi-Fi comes from, and it never carries one
// of them to this machine's own loopback, where the admin port is listening.
import { createSocket } from 'node:dgram'
import {
  createServer,
  STATUS_CODES,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { BlockList, isIP, type AddressInfo, type IPVersion, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { TLSSocket } from 'node:tls'
import { gunzipSync } from 'node:zlib'
import type { CertificateAuthority } from './certs.ts'
import type { TunnelConfigManager } from './config.ts'
import type { TunnelCore } from './core.ts'
import { reasonOf, repr } from './errors.ts'
import { matchGlob } from './glob.ts'
import { getLogger } from './log.ts'
import {
  DEFAULT_PORTS,
  errorResponse,
  makeRequest,
  makeResponse,
  type Request,
  type Response,
} from './messages.ts'
import type { SslProxying } from './models.ts'
import { parseQuery, splitAuthority, splitTarget } from './proxy-url.ts'
import { openTunnel, UpstreamError } from './upstream.ts'

const log = getLogger('proxy')

// Every interface, because a phone reaches this port over Wi-Fi. 8890 rather
// than the 8888 people already have typed in from Charles, and for exactly that
// reason: the audience for this is the audience that has Charles installed, and
// Charles holds 8888 whenever it is open, not only while it is capturing. A
// port somebody has to type once beats a server that will not start.
export const DEFAULT_PROXY_HOST = '0.0.0.0'
export const DEFAULT_PROXY_PORT = 8890

// The magic host a proxied device opens to install the certificate, the way
// Charles answers chls.pro/ssl and Fiddler answers ipv4.fiddler. It never leaves
// this machine: the Host header is matched here, before anything looks a name up.
//
// `.tunnel` is not a top-level domain, and that is the requirement. A name in a
// real one — this used to be tunnel.ca — sends a device that is *not* proxied to
// whoever owns it, and tunnel.ca resolves to a live site today. `.test` would
// never resolve publicly either, but local setups routinely wildcard *.test to
// their own loopback and the panel's sample data already uses it for fake hosts.
export const MAGIC_HOST = 'ca.tunnel'
export const CA_PATH = '/ca.pem'

// Who may connect when `allow_clients` is left empty: this machine, and the
// private ranges a device on the same network comes from.
export const DEFAULT_ALLOW_CLIENTS: readonly string[] = Object.freeze([
  '127.0.0.0/8',
  '::1/128',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  'fc00::/7',
])

// What a CONNECT is answered with, written to the socket itself: the server has handed it over, and
// there is no response object to write with. The tunnel is open; the target is this machine's
// loopback; the target could not be reached
const CONNECT_ESTABLISHED = Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n')
const RAW_403 = Buffer.from(
  'HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n',
)
const RAW_502 = Buffer.from(
  'HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n',
)

// Headers addressed to one hop, which a proxy is: they say something about the
// connection to us, not about the request, so they are not passed on.
export const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

// Framing is decided again on every hop; we write our own content-length.
export const FRAMING_HEADERS: ReadonlySet<string> = new Set(['content-length', 'transfer-encoding'])

// Styled with inline attributes only: a phone opens this page through the proxy
// port, which serves nothing else, so there is no stylesheet to fetch. The
// backslash at the end of the <body> line joins the two lines in a template literal.
function installPage(fingerprint: string): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Install the tunnel certificate</title>
<body style="font-family: -apple-system, system-ui, sans-serif; line-height: 1.5; \
margin: 2em auto; max-width: 38em; padding: 0 1em; color: #222;">
<h1>Install the tunnel certificate</h1>
<p><a href="${CA_PATH}" style="font-size: 1.2em;">Download tunnel-ca.pem</a></p>
<p>Fingerprint (SHA-256):<br><code style="word-break: break-all;">${fingerprint}</code><br>
It is the one <code>tunnel ca info</code> prints on the machine running tunnel.</p>
<h2>iOS and iPadOS</h2>
<ol>
<li>Open the link above in Safari and allow the profile to download.</li>
<li>Settings &gt; General &gt; VPN &amp; Device Management, then install the profile.</li>
<li>Settings &gt; General &gt; About &gt; Certificate Trust Settings, and switch tunnel on.
Until that switch is on, nothing trusts the certificate.</li>
</ol>
<h2>Android</h2>
<ol>
<li>Download the file, then Settings &gt; Security &gt; Encryption &amp; credentials &gt;
Install a certificate &gt; CA certificate.</li>
<li>Android 7 and later ignore user certificates unless the app opts in: the test build
needs <code>&lt;certificates src="user"/&gt;</code> in its network security configuration.</li>
</ol>
<h2>macOS</h2>
<ol>
<li>Download the file and open it in Keychain Access, or run
<code>tunnel ca install --macos</code> on this machine.</li>
<li>Open the certificate and set it to "Always Trust".</li>
</ol>
<p>An app that pins its server's certificate rejects this one however it was installed,
so pinning has to be off in the build you are testing.</p>
</body>
</html>
`
}

// ---------------------------------------------------------------- addresses

/**
 * The addresses a device on the same network can reach this machine at.
 *
 * Asked of the routing table rather than of a name server: connecting a UDP socket sends no packet,
 * it only picks the source address this machine would leave by, which is the one to type into a
 * phone's proxy settings.
 */
export function lanIps(): Promise<string[]> {
  const probe = createSocket('udp4')
  return new Promise<string[]>((resolve) => {
    // No callback for connect(): it would be handed a failure in place of the error event, and
    // address() would then read the 0.0.0.0 the socket is bound to. A machine with no route out
    // fails here
    probe.once('error', () => resolve([]))
    probe.once('connect', () => {
      const { address } = probe.address()
      resolve(address.startsWith('127.') ? [] : [address])
    })
    probe.connect(9, '192.0.2.1') // TEST-NET-1: reserved, never routed
  }).finally(() => probe.close())
}

// ---------------------------------------------------------------- who may connect, and where to

// Addresses and ranges are read by Node's BlockList. It reads a range with host
// bits set as the range they are in (192.168.1.5/24). A dual stack listener
// reports an IPv4 peer as ::ffff:192.168.1.23, and a request can be addressed that
// way too: BlockList checks such a mapped address against the IPv4 rules itself.
// A zone id (fe80::1%en0) it reads and leaves out.

/** 'ipv4' or 'ipv6' when address is an IP literal, as BlockList names the two; null
 *  when it is a name */
function familyOf(address: string): IPVersion | null {
  const version = isIP(address)
  return version === 4 ? 'ipv4' : version === 6 ? 'ipv6' : null
}

/** Puts one allow_clients entry, an address or a CIDR range, on the list. False
 *  when it is neither */
function addEntry(list: BlockList, entry: string): boolean {
  const slash = entry.indexOf('/')
  const address = slash === -1 ? entry : entry.slice(0, slash)
  const prefix = slash === -1 ? null : entry.slice(slash + 1)
  const family = familyOf(address)
  // A prefix length is ASCII digits. Number() would take '' for 0, and 10.0.0.0/
  // would let every address in. A netmask in its place (10.0.0.0/255.0.0.0) is
  // unreadable here
  if (family === null || (prefix !== null && !/^[0-9]+$/.test(prefix))) return false
  try {
    if (prefix === null) list.addAddress(address, family)
    else list.addSubnet(address, Number(prefix), family)
  } catch {
    // ERR_OUT_OF_RANGE: a prefix longer than the address, 10.0.0.0/33
    return false
  }
  return true
}

// Every connection is checked against allow_clients, read again each time so that
// a change holds from the next connection on. Making a BlockList of it every time
// would be wasted work, so one is kept for each list, keyed by the array itself:
// getConfig() hands out the same config, and the same array, until the config is
// updated, and an update makes a new one. So an unreadable entry is logged once for
// the list, not for every connection. Module-level state, but not the kind the rule
// against module-level singletons is about: nobody sees it from outside, it changes
// no answer, and the WeakMap lets a list go with the config that held it.
const BLOCK_LISTS = new WeakMap<readonly string[], BlockList>()

function blockListFor(patterns: readonly string[]): BlockList {
  let list = BLOCK_LISTS.get(patterns)
  if (list === undefined) {
    list = new BlockList()
    for (const entry of patterns) {
      if (!addEntry(list, entry)) {
        log.warning(`Ignoring an unreadable allow_clients entry: ${repr(entry)}`)
      }
    }
    BLOCK_LISTS.set(patterns, list)
  }
  return list
}

/** Whether a connection from this address is accepted on the proxy port */
export function clientIsAllowed(address: string, patterns: readonly string[]): boolean {
  const family = familyOf(address)
  if (family === null) return false
  return blockListFor(patterns.length > 0 ? patterns : DEFAULT_ALLOW_CLIENTS).check(address, family)
}

// This machine's loopback is more than 127.0.0.0/8 and ::1: a connection to the
// unspecified 0.0.0.0/8 or :: reaches this machine's listeners as well, so they
// are counted too. BlockList checks an IPv4-mapped address (::ffff:0.0.0.0)
// against the IPv4 ranges itself
const LOOPBACK = new BlockList()
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4')
LOOPBACK.addSubnet('::1', 128, 'ipv6')
LOOPBACK.addSubnet('0.0.0.0', 8, 'ipv4')
LOOPBACK.addSubnet('::', 128, 'ipv6')

/** A host as a connection reads it. One that is not an IP literal goes through the
 *  URL host parser, which the URL the core sends upstream goes through too:
 *  127.1, 2130706433, 0x7f000001 and 0x7f.1 are 127.0.0.1, 0 is 0.0.0.0, and in
 *  user@127.0.0.1 the part before the @ is a user name. getaddrinfo reads the
 *  numeric spellings the same way. A host the parser cannot read is kept as it
 *  came */
function asConnected(host: string): string {
  if (familyOf(host) !== null) return host
  let hostname: string
  try {
    hostname = new URL(`http://${host}/`).hostname
  } catch {
    return host
  }
  // An IPv6 hostname keeps its brackets: user@[::1] is [::1]
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

function isLoopback(host: string): boolean {
  const address = asConnected(host)
  const family = familyOf(address)
  if (family !== null) return LOOPBACK.check(address, family)
  // A trailing dot only says the name is complete: localhost. is localhost
  const name = (address.endsWith('.') ? address.slice(0, -1) : address).toLowerCase()
  return name === 'localhost' || name.endsWith('.localhost')
}

/**
 * Whether a request from this client may be carried to this host.
 *
 * This port is on the network so that a device can send its own traffic
 * through it, not so that it can borrow this machine's loopback: the admin
 * API, the panel and the scripts they run are bound there and have no
 * business being reachable over Wi-Fi through the port next to them. A client
 * that is itself on the loopback — `tunnel check`, or a simulator running
 * here — is already inside it. The host is read the way a connection reads
 * it, so 127.1 and 0.0.0.0 are this machine as much as 127.0.0.1 is, and so
 * is no host at all, which is what CONNECT :8000 names: a connection to ''
 * reaches localhost. But a name that resolves to 127.0.0.1 is not chased.
 */
export function mayReach(client: string, host: string): boolean {
  // '' is this machine only as a target. As a client it is an address that could not be
  // read, and isLoopback, which judges both, must not let that in
  return !(host === '' || isLoopback(host)) || isLoopback(client)
}

// ---------------------------------------------------------------- SSL Proxying Locations

/** A location is `host[:port]`: `*` is a wildcard, and no port means any port */
function locationMatches(pattern: string, host: string, port: number): boolean {
  let location: [host: string, port: number]
  try {
    location = splitAuthority(pattern, 0)
  } catch {
    // [::1]:abc, whose port is not a number: a location like that holds nowhere
    return false
  }
  const [patternHost, patternPort] = location
  if (patternPort !== 0 && patternPort !== port) return false
  return matchGlob(host.toLowerCase(), patternHost)
}

/**
 * Whether this CONNECT is terminated here or tunnelled through untouched.
 *
 * Nothing is decrypted unless it was listed, and an excluded location wins
 * over an including one — the way Charles reads the same two lists.
 */
export function shouldDecrypt(policy: SslProxying, host: string, port: number): boolean {
  if (!policy.enabled) return false
  if (policy.exclude.some((pattern) => locationMatches(pattern, host, port))) return false
  return policy.include.some((pattern) => locationMatches(pattern, host, port))
}

// ---------------------------------------------------------------- HTTP/1.1 bits

/** The request's headers with lower-case names, and repeats joined with ', '. Made from
 *  rawHeaders: req.headers keeps the first of two content-types only and joins cookies with
 *  '; '. Built in a Map, so that a header named __proto__ stays a header. The values are as
 *  Node read them, latin1 */
function headerDict(rawHeaders: readonly string[]): Record<string, string> {
  const headers = new Map<string, string>()
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i]!.toLowerCase()
    const value = rawHeaders[i + 1]!
    const seen = headers.get(name)
    headers.set(name, seen === undefined ? value : `${seen}, ${value}`)
  }
  return Object.fromEntries(headers)
}

/**
 * Unpack a gzipped request body, and drop the header that described it.
 *
 * Everything downstream — a script's `ctx.json`, the rule that matches, the
 * body forwarded upstream — then sees what the client meant to send, the same
 * way the core is handed responses from upstream already decompressed.
 */
export function decodeRequestBody(headers: Record<string, string>, body: Buffer): Buffer {
  // An empty body is left as it is: gunzipSync would throw Z_BUF_ERROR on it
  const encoding = headers['content-encoding'] ?? ''
  if (!encoding.toLowerCase().includes('gzip') || body.length === 0) return body
  let decoded: Buffer
  try {
    decoded = gunzipSync(body)
  } catch (error) {
    log.warning(
      `A request body claimed gzip but did not decompress (${reasonOf(error)}); passing it on as it came`,
    )
    return body
  }
  delete headers['content-encoding']
  return decoded
}

// ---------------------------------------------------------------- answering

/** What the proxy port answers for itself: the install page and the CA */
function ownPage(
  path: string,
  ca: Pick<CertificateAuthority, 'fingerprint' | 'certificatePem'>,
): Response {
  if (path === '/') {
    return makeResponse({
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: Buffer.from(installPage(ca.fingerprint()), 'utf8'),
    })
  }
  if (path === CA_PATH) {
    return makeResponse({
      status: 200,
      headers: {
        'content-type': 'application/x-x509-ca-cert',
        'content-disposition': 'attachment; filename="tunnel-ca.pem"',
      },
      body: ca.certificatePem(),
    })
  }
  return errorResponse(
    400,
    `This is tunnel's proxy port. It serves / and ${CA_PATH}; everything else has to arrive as a proxied request.`,
  )
}

/**
 * The part of answering that touches no socket: what one request that arrived on the proxy port
 * is. One of the port's own pages, or a refusal, is a response to write back as it is; anything
 * else is the Request core answers.
 *
 * `authority` is the host and port a CONNECT named, which is what the requests on a decrypted
 * stream belong to; without one the requests carry their own address and this stream is the
 * plain proxy port. `headers` are as headerDict reads them.
 */
export function routeRequest(input: {
  method: string
  target: string
  headers: Record<string, string>
  body: Buffer
  client: string
  scheme: 'http' | 'https'
  authority: { host: string; port: number } | null
  gaveUp: () => boolean
  ca: Pick<CertificateAuthority, 'fingerprint' | 'certificatePem'>
}): { kind: 'response'; response: Response } | { kind: 'request'; request: Request } {
  const { method, target, headers, body, client, authority, gaveUp, ca } = input
  // Not new URL(): proxy-url.ts says why
  const split = splitTarget(target)

  let scheme: string = input.scheme
  let address: [host: string, port: number]
  if (authority !== null) {
    // A decrypted stream belongs to the host its CONNECT named, whatever
    // the request line and the Host header go on to say.
    address = [authority.host, authority.port]
  } else if (split.absolute) {
    scheme = split.scheme
    // DEFAULT_PORTS.get(scheme, 80), from the table's own entries: a scheme named constructor
    // would otherwise find what Object.prototype holds under that name
    const defaultPort = Object.hasOwn(DEFAULT_PORTS, scheme) ? DEFAULT_PORTS[scheme]! : 80
    address = splitAuthority(split.netloc, defaultPort)
  } else {
    address = splitAuthority(headers.host ?? '', DEFAULT_PORTS[scheme]!)
  }
  const [host, port] = address

  // The proxy port serves two pages of its own: the install page a device
  // opens at http://ca.tunnel/, and the certificate it links to. A request
  // that names no host at all can only be meant for us as well.
  if (authority === null && (host === MAGIC_HOST || !split.absolute)) {
    return { kind: 'response', response: ownPage(split.path || '/', ca) }
  }

  if (!mayReach(client, host)) {
    log.warning(
      `Refused ${target} from ${client}: this port does not carry the network to this machine's loopback`,
    )
    const detail =
      "tunnel's proxy port does not reach this machine's loopback address; its management API is there"
    return { kind: 'response', response: errorResponse(403, detail) }
  }

  if (headers.upgrade !== undefined) {
    log.info(`Refused an upgrade to ${headers.upgrade} on ${target}: tunnel speaks HTTP/1.1 only`)
    const detail = `tunnel does not carry ${headers.upgrade} connections on a host it decrypts`
    return { kind: 'response', response: errorResponse(501, detail) }
  }

  // It takes content-encoding out of these same headers, so it comes before they are copied
  const decoded = decodeRequestBody(headers, body)
  const request = makeRequest({
    method,
    scheme,
    host,
    port,
    path: split.path || '/',
    query: parseQuery(split.query),
    headers: Object.fromEntries(
      Object.entries(headers).filter(([name]) => !HOP_BY_HOP_HEADERS.has(name)),
    ),
    body: decoded,
    client,
    gave_up: gaveUp,
  })
  return { kind: 'request', request }
}

/** Core's answer, on the wire: only the headers it gave, less the ones about this hop and its
 *  framing, and a content-length of our own */
function writeResponse(
  req: IncomingMessage,
  res: ServerResponse,
  response: Response,
  client: string,
): void {
  if (response.close) {
    // Nothing at all is written, and the socket is closed here.
    // The `close` fault asks for this, so that the client meets a
    // dropped connection. A hang the client walked away from ends
    // here too, and there the reason is the opposite one, so the
    // core logs which it was.
    log.info(`Dropping the connection from ${client}: nothing goes back for ${req.url ?? ''}`)
    req.socket.destroy()
    return
  }
  // Node adds a Date header, and Connection and Keep-Alive ones, to what it is given.
  // removeHeader('connection') leaves no Connection or Keep-Alive header, while Node still
  // closes the connection where the request asked for that. It only marks the response, and
  // writeHead reads the mark, so it comes first: after writeHead it throws
  res.sendDate = false
  res.removeHeader('connection')
  const headers: string[] = []
  for (const [name, value] of Object.entries(response.headers)) {
    const lower = name.toLowerCase()
    if (!HOP_BY_HOP_HEADERS.has(lower) && !FRAMING_HEADERS.has(lower)) headers.push(name, value)
  }
  headers.push('content-length', String(response.body.length))
  // Node knows the answers to HEAD, and 204 and 304, carry no body, and leaves it out
  res.writeHead(response.status, headers)
  res.end(response.body)
}

/** The same answer written on the socket by hand, for a CONNECT on a decrypted stream: the connect
 *  event leaves no response object to write it with. Header text goes out as latin1, as Node writes
 *  headers */
function writeRawResponse(socket: Socket, response: Response): void {
  let head = `HTTP/1.1 ${response.status} ${STATUS_CODES[response.status] ?? ''}\r\n`
  for (const [name, value] of Object.entries(response.headers)) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower) || FRAMING_HEADERS.has(lower)) continue
    head += `${name}: ${value}\r\n`
  }
  head += `content-length: ${response.body.length}\r\n\r\n`
  // 204 and 304 carry no body, as Node leaves it out for writeResponse; the method is CONNECT here,
  // never HEAD
  const silent = response.status === 204 || response.status === 304
  const body = silent ? Buffer.alloc(0) : response.body
  socket.write(Buffer.concat([Buffer.from(head, 'latin1'), body]))
}

// ---------------------------------------------------------------- the listener

/** health's proxy field, and what the start-up banner is made from (names as on the wire) */
export interface ProxyInfo {
  host: string
  port: number
  lan_ips: string[]
}

/** Called once for each tunnel that was not decrypted, when it closes: host, port, client and the
 *  bytes each way. The default is core.exchanges.recordConnect */
export type OnConnect = (
  host: string,
  port: number,
  client: string,
  bytesUp: number,
  bytesDown: number,
) => void

export interface ProxyServerOptions {
  host?: string // default DEFAULT_PROXY_HOST
  port?: number // default DEFAULT_PROXY_PORT; 0 asks the system for one, as the tests do
  onConnect?: OnConnect
}

/** The listener a device points its HTTP proxy setting at */
export class ProxyServer {
  readonly host: string
  /** The port given, and once start() has run, the port it listens on */
  port: number
  readonly #core: TunnelCore
  readonly #configManager: TunnelConfigManager
  readonly #certificateAuthority: CertificateAuthority
  // One http.Server reads the plain port and every decrypted stream alike; a CONNECT leaves it
  readonly #server: Server
  /** The host and port a CONNECT named, by the TLS socket of the stream it decrypts */
  readonly #authorities = new WeakMap<Socket, { host: string; port: number }>()
  // The sockets CONNECTs took off the server, and the upstream ones of their tunnels, so that close()
  // can let go of one a device is still holding: closeAllConnections() does not see them
  readonly #tunnels = new Set<Socket>()
  /** The answer each connection is busy with, which the next request on it waits for (#inTurn) */
  readonly #turns = new WeakMap<Socket, Promise<void>>()
  // Called for a tunnel that was not decrypted, once it closes. It writes the log's `connect` row,
  // which is all there is to say about a connection nobody read.
  readonly #onConnect: OnConnect
  #lanIps: string[] = []
  #closing: Promise<void> | null = null

  constructor(
    core: TunnelCore,
    configManager: TunnelConfigManager,
    certificateAuthority: CertificateAuthority,
    options?: ProxyServerOptions,
  ) {
    this.#core = core
    this.#configManager = configManager
    this.#certificateAuthority = certificateAuthority
    this.host = options?.host ?? DEFAULT_PROXY_HOST
    this.port = options?.port ?? DEFAULT_PROXY_PORT
    // An arrow function, so that recordConnect keeps its this
    this.#onConnect = options?.onConnect ?? ((...row) => core.exchanges.recordConnect(...row))
    this.#server = createServer({
      // A request that names no host at all is one for the install page, not a 400
      requireHostHeader: false,
      // No timeouts. An app keeps an idle connection open for long, and would reconnect after
      // Node's 5 s; and a hang with a long fault_seconds is meant to outlast the 300 s
      // requestTimeout
      keepAliveTimeout: 0,
      headersTimeout: 0,
      requestTimeout: 0,
    })
    this.#server.on('connection', (socket: Socket) => this.#admit(socket))
    this.#server.on('request', (req, res) => {
      void this.#inTurn(req.socket, () => this.#answer(req, res))
    })
    this.#server.on('clientError', (error, socket) => this.#drop(error, socket))
    this.#server.on('connect', (req, socket, head) => void this.#connect(req, socket, head))
  }

  /** Bind the port and begin accepting; resolves once it is listening. A port that cannot be
   *  listened on rejects as Node says it (EADDRINUSE and the like) */
  async start(): Promise<this> {
    // Both RSA keys are generated here: mid-handshake the client would feel them as a stall.
    this.#certificateAuthority.warm()
    const server = this.#server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.port, this.host, () => {
        server.off('error', reject)
        resolve()
      })
    })
    // A port of 0 asked the operating system to pick one, which the tests do
    this.port = (server.address() as AddressInfo).port
    // So that the routes take a proxy on this port for tunnel itself, and go straight there rather
    // than hand traffic back to it again and again: the port listened on, not a 0 that was given
    this.#core.routes.ownProxyPort = this.port
    this.#lanIps = await lanIps()
    log.info(`Proxy listening on ${this.host}:${this.port}`)
    return this
  }

  /**
   * Stop accepting, and let go of the connections that are still open.
   *
   * server.close() waits for every connection to end, and a device holding a keep-alive
   * connection open has no reason to hang up because this process wants to stop: without
   * closing them, closing the listener waits on the device rather than the other way round.
   * Idempotent; a server that was never started has nothing to close.
   */
  close(): Promise<void> {
    this.#closing ??= (async () => {
      const server = this.#server
      if (!server.listening) return
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections()
      for (const socket of this.#tunnels) socket.destroy()
      await closed
      // The port is no longer tunnel's: a real proxy that comes to listen on it is not tunnel itself
      this.#core.routes.ownProxyPort = null
    })()
    return this.#closing
  }

  /** Lets the process end while this listens: the listener, and every connection from now on, is
   *  unref'd, a decrypted stream among them, which comes back through 'connection' too. For the
   *  library, whose caller's process is its own to end (src/index.ts); `tunnel serve` never calls it */
  unref(): void {
    this.#server.unref()
    this.#server.on('connection', (socket: Socket) => socket.unref())
  }

  /** Shape reported under `proxy` by `GET /__admin__/health` */
  describe(): ProxyInfo {
    return { host: this.host, port: this.port, lan_ips: [...this.#lanIps] }
  }

  /** Every connection is checked against allow_clients, read again each time so that a change
   *  holds from the next connection on. One that is refused is closed before a byte is read */
  #admit(socket: Socket): void {
    const client = socket.remoteAddress ?? ''
    const allowed = this.#configManager.getConfig().allow_clients
    if (!clientIsAllowed(client, allowed)) {
      const list = allowed.length > 0 ? `[${allowed.map(repr).join(', ')}]` : 'the private ranges'
      log.warning(`Refused a proxy connection from ${client}: allow_clients is ${list}`)
      socket.destroy()
      return
    }
    // A socket with no error listener turns one ECONNRESET into an uncaught exception, which
    // takes both ports down. Node listens on the sockets it reads HTTP from, but not on one a
    // CONNECT takes off it, so every socket this module touches gets a listener of its own; what
    // an error means is decided where the socket closes. The TLS socket of a decrypted stream has
    // had its own since #decrypt, and comes back here after every CONNECT on it: one more each
    // time would pile up
    if (!this.#authorities.has(socket)) socket.on('error', () => {})
  }

  /**
   * Runs `answer` once the answers ahead of it on the same connection are done.
   *
   * Core meets the requests on one connection one at a time, in the order they came. Node hands
   * over a pipelined request while the one ahead of it is still being answered, so the order is
   * kept here. Once an answer has dropped the connection (the close fault, an error), the requests
   * behind it get none. What `answer` throws is its caller's to log: the next in line only waits
   * for it to be over.
   */
  #inTurn(socket: Socket, answer: () => Promise<void>): Promise<void> {
    const ahead = this.#turns.get(socket)
    const turn =
      ahead === undefined ? answer() : ahead.then(() => (socket.destroyed ? undefined : answer()))
    this.#turns.set(
      socket,
      turn.catch(() => {}),
    )
    return turn
  }

  /** One request: read whole, then routeRequest says whether it is the port's own business or
   *  core's, and the answer goes back on the same connection */
  async #answer(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const socket = req.socket
    const client = socket.remoteAddress ?? ''
    try {
      let body: Buffer
      try {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        body = Buffer.concat(chunks)
      } catch (error) {
        // The client went away halfway through its body, which is its right
        log.info(`Dropping a connection from ${client}: ${reasonOf(error)}`)
        socket.destroy()
        return
      }
      const authority = this.#authorities.get(socket) ?? null
      // Whether the client is still on the other end of this socket.
      //
      // Nothing here reads while an answer is being produced, so this cannot ask the socket a
      // question — it reads what Node already noticed. Node goes on reading the socket by itself,
      // so a client that hangs up shows as the end of its stream without anybody calling read,
      // and one that resets destroys the socket. Between them they cover both ways of walking
      // off, and a client that is simply still waiting is neither.
      //
      // A client that half-closes and goes on waiting reads the same as one that left — TCP
      // sends the same FIN for both, so Node cannot tell them apart either. Only the waits ask
      // this, the hang fault and response_delay. http.Server ends its own side on that FIN
      // (httpAllowHalfOpen is fixed at false), so a half-close is a departure outright and gets
      // no answer.
      const gaveUp = () => socket.destroyed || socket.readableEnded
      const routed = routeRequest({
        method: req.method ?? '',
        target: req.url ?? '',
        headers: headerDict(req.rawHeaders),
        body,
        client,
        scheme: authority === null ? 'http' : 'https',
        authority,
        gaveUp,
        ca: this.#certificateAuthority,
      })
      const response =
        routed.kind === 'response' ? routed.response : await this.#core.resolve(routed.request)
      writeResponse(req, res, response, client)
    } catch (error) {
      const stack = error instanceof Error ? (error.stack ?? reasonOf(error)) : reasonOf(error)
      log.error(`The proxy connection from ${client} failed\n${stack}`)
      socket.destroy()
    }
  }

  /** What Node's parser or TLS could not read. Not answered 400: the connection is closed */
  #drop(error: Error, duplex: Duplex): void {
    const socket = duplex as Socket
    const client = socket.remoteAddress ?? ''
    const code = 'code' in error && typeof error.code === 'string' ? error.code : ''
    if (code.startsWith('ERR_SSL_')) {
      // OpenSSL ends its message with a newline; a log record is one line
      const host = this.#authorities.get(socket)?.host ?? ''
      log.info(`TLS with ${client} for ${host} failed: ${error.message.trimEnd()}`)
    } else {
      log.info(`Dropping a connection from ${client}: ${error.message}`)
    }
    socket.destroy()
  }

  /** A CONNECT, which takes its socket off the server: a refusal, or a tunnel the bytes go through
   *  untouched, or a stream decrypted here when the SSL Proxying Locations list the host; and on a
   *  stream decrypted already, one more request for core. What is thrown in here, which no one else
   *  would catch, is logged with its stack, and the connection closed */
  async #connect(req: IncomingMessage, duplex: Duplex, head: Buffer): Promise<void> {
    const socket = duplex as Socket
    const client = socket.remoteAddress ?? ''
    // On a decrypted stream the socket is the TLS one, which #authorities knows
    const authority = this.#authorities.get(socket)
    // Node takes its own error listener off a socket it hands over (#admit says why there is one,
    // and why the TLS socket needs no more)
    if (authority === undefined) socket.on('error', () => {})
    try {
      // The CONNECT is one more request on that stream, and waits its turn there
      if (authority !== undefined) {
        await this.#inTurn(socket, () => this.#answerConnect(req, socket, head, authority, client))
        return
      }
      // From here on closeAllConnections() does not see it
      this.#tunnels.add(socket)
      socket.once('close', () => this.#tunnels.delete(socket))
      // The request line alone: never the Host header
      const [host, port] = splitAuthority(req.url ?? '', 443)
      if (!mayReach(client, host)) {
        log.warning(
          `Refused CONNECT ${host}:${port} from ${client}: this port does not carry the network to this machine's loopback`,
        )
        // Let go once it is written: end() alone would wait for the client to close its side
        socket.once('finish', () => socket.destroy())
        socket.end(RAW_403)
        return
      }
      const policy = this.#configManager.getConfig().ssl_proxying
      if (!shouldDecrypt(policy, host, port)) {
        await this.#tunnel(socket, head, host, port, client)
        return
      }
      this.#decrypt(socket, head, host, port, client)
    } catch (error) {
      const stack = error instanceof Error ? (error.stack ?? reasonOf(error)) : reasonOf(error)
      log.error(`The proxy connection from ${client} failed\n${stack}`)
      socket.destroy()
    }
  }

  /**
   * A CONNECT on a stream decrypted here. Core answers it as it answers any other request on that
   * stream; the answer is written on the socket by hand, as the connect event leaves no response
   * object to write it with.
   *
   * That event also took the socket off Node's parser, so once the answer is written the socket is
   * handed to the server again as a connection of its own, which puts a parser back on it, with
   * whatever the client sent after its CONNECT: otherwise nobody would answer the requests that
   * follow on this stream. Until then the server's list of connections does not hold it, but
   * close() still reaches it through the socket under its TLS, which is in #tunnels.
   *
   * A 2xx is written whole and the stream goes on.
   */
  async #answerConnect(
    req: IncomingMessage,
    socket: Socket,
    head: Buffer,
    authority: { host: string; port: number },
    client: string,
  ): Promise<void> {
    const routed = routeRequest({
      method: 'CONNECT',
      target: req.url ?? '',
      headers: headerDict(req.rawHeaders),
      // Whatever follows a CONNECT's head is not its body: it is in head
      body: Buffer.alloc(0),
      client,
      scheme: 'https',
      authority,
      // #answer says what this reads
      gaveUp: () => socket.destroyed || socket.readableEnded,
      ca: this.#certificateAuthority,
    })
    const response =
      routed.kind === 'response' ? routed.response : await this.#core.resolve(routed.request)
    if (response.close) {
      // writeResponse says why nothing is written
      log.info(`Dropping the connection from ${client}: nothing goes back for ${req.url ?? ''}`)
      socket.destroy()
      return
    }
    // The client left while core answered: there is nobody to write to, and no parser to put back
    // (on a socket that has closed already, one would never be taken off again)
    if (socket.destroyed) return
    writeRawResponse(socket, response)
    if (head.length > 0) socket.unshift(head)
    this.#server.emit('connection', socket)
  }

  /**
   * Copy the connection through without reading it, Charles's <encrypted> row.
   *
   * It goes out the way core.routes picks: straight there, or through the proxy this Mac is set to.
   *
   * Closing the far writer at EOF is what ends the other direction too, so the two directions
   * finish together. Each end is let go once it has been ended and has written what it was given:
   * pipe() alone passes an end on and no more, and a client whose TLS wraps a socket of its own
   * sends no FIN when it is done, which would leave the tunnel half open and its row never written.
   *
   * The bytes are counted from where the pipes are joined. Those a client sent early wait in the
   * socket until then, and a data listener put on sooner would take them before a pipe could
   * carry them.
   */
  async #tunnel(
    socket: Socket,
    head: Buffer,
    host: string,
    port: number,
    client: string,
  ): Promise<void> {
    let up: Socket
    try {
      up = (await openTunnel(this.#core.routes, host, port)).socket
    } catch (error) {
      // Anything but a failure to get there, such as a port out of range (ERR_SOCKET_BAD_PORT), is
      // for #connect to log
      if (!(error instanceof UpstreamError)) throw error
      const through = error.via === null ? '' : ` through ${error.via}`
      log.warning(`Could not reach ${host}:${port} for ${client}: ${error.message}${through}`)
      socket.once('finish', () => socket.destroy())
      socket.end(RAW_502)
      return
    }
    up.on('error', () => {})
    // While openTunnel was connecting, neither a client that left nor a close() that began could
    // reach this socket
    if (socket.destroyed || this.#closing !== null) {
      up.destroy()
      return
    }
    this.#tunnels.add(up)
    up.once('close', () => this.#tunnels.delete(up))

    let bytesUp = head.length
    let bytesDown = 0
    // Not events.once, which rejects when an error comes first
    const closed = Promise.all([
      new Promise((resolve) => socket.once('close', resolve)),
      new Promise((resolve) => up.once('close', resolve)),
    ])
    // A client that is gone wants nothing more from upstream
    socket.once('close', () => up.destroy())
    up.once('close', () => socket.end())
    for (const end of [socket, up]) end.once('finish', () => end.destroy())
    socket.write(CONNECT_ESTABLISHED)
    if (head.length > 0) up.write(head)
    socket.on('data', (chunk: Buffer) => {
      bytesUp += chunk.length
    })
    up.on('data', (chunk: Buffer) => {
      bytesDown += chunk.length
    })
    socket.pipe(up)
    up.pipe(socket)
    void closed.then(() => {
      // close() let go of it
      if (this.#closing !== null) return
      log.info(
        `CONNECT ${host}:${port} from ${client}: tunnelled ${bytesUp} bytes up, ${bytesDown} down, not decrypted`,
      )
      this.#onConnect(host, port, client, bytesUp, bytesDown)
    })
  }

  /**
   * Take the TLS on here, with a certificate for the host the CONNECT named, whatever name the
   * client's TLS goes on to ask for.
   *
   * The TLS socket is handed to the server as a connection of its own: the requests on it are then
   * read and answered as the plain port's are, by #answer, which finds the host and port they
   * belong to in #authorities. A handshake that fails reaches #drop as a clientError. What
   * tlsOptionsFor throws, for a host that is empty or not ASCII, is #connect's to log, once the 200
   * has gone.
   */
  #decrypt(socket: Socket, head: Buffer, host: string, port: number, client: string): void {
    socket.write(CONNECT_ESTABLISHED)
    if (head.length > 0) {
      // Anything the client sent without waiting for our answer: the first
      // bytes of its TLS handshake, or of whatever else it is speaking.
      // Those bytes are already past the TLS layer we are about to start,
      // so the handshake would never see them.
      log.warning(
        `${client} sent ${head.length} bytes before our answer to CONNECT ${host}:${port}; the handshake may fail`,
      )
    }
    const secure = new TLSSocket(socket, {
      isServer: true,
      ...this.#certificateAuthority.tlsOptionsFor(host),
    })
    // #admit says why
    secure.on('error', () => {})
    this.#authorities.set(secure, { host, port })
    secure.once('secure', () => log.info(`Decrypting ${host}:${port} for ${client}`))
    this.#server.emit('connection', secure)
  }
}
