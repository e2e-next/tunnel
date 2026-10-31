// The clients a device would be, for the proxy port's tests: viaProxy sends one request the way
// a client set up with a proxy sends it, absolute-form over a connection of its own, and
// RawConnection writes requests on one socket by hand, so that a test can watch one connection
// carry several.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import http from 'node:http'
import net, { type Socket } from 'node:net'
import { performance } from 'node:perf_hooks'
import type { Duplex } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import tls, { type TLSSocket } from 'node:tls'
import type { Exchange } from '../../src/exchanges.ts'

/** What came back: the status, the headers with their names lower-cased and repeats joined with
 *  ', ', and the body */
export interface Answer {
  status: number
  headers: Record<string, string>
  body: Buffer
  /** The body read as JSON */
  json(): unknown
}

function answer(status: number, pairs: [string, string][], body: Buffer): Answer {
  const headers = new Map<string, string>()
  for (const [name, value] of pairs) {
    const key = name.toLowerCase()
    const seen = headers.get(key)
    headers.set(key, seen === undefined ? value : `${seen}, ${value}`)
  }
  return {
    status,
    headers: Object.fromEntries(headers),
    body,
    json: () => JSON.parse(body.toString('utf8')) as unknown,
  }
}

/** How long a read waits for the proxy. node:test sets no limit of its own, so a proxy that never
 *  answers would otherwise hang npm test rather than fail the test that asked */
const READ_TIMEOUT_MS = 5000

/** Reads until `size` says how many of the bytes so far make what is wanted, and hands those
 *  back. The listener comes off and the socket is paused once it has them, and whatever came
 *  with them is put back, so the next reader of this socket, tls.connect included, starts where
 *  this one stopped. Rejects when the proxy closes the connection first, or sends no more for
 *  READ_TIMEOUT_MS */
function readUntil(socket: Duplex, size: (buffered: Buffer) => number | null): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0)
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      const length = size(buffered)
      if (length === null) return
      stop()
      if (buffered.length > length) socket.unshift(buffered.subarray(length))
      resolve(buffered.subarray(0, length))
    }
    const onEnd = () => {
      stop()
      reject(new Error('the proxy closed the connection'))
    }
    const timer = setTimeout(() => {
      stop()
      reject(new Error(`the proxy had not answered after ${READ_TIMEOUT_MS} ms`))
    }, READ_TIMEOUT_MS)
    const stop = () => {
      clearTimeout(timer)
      socket.pause()
      socket.off('data', onData)
      socket.off('end', onEnd)
      socket.off('close', onEnd)
      socket.off('error', onEnd)
    }
    socket.on('data', onData)
    socket.on('end', onEnd)
    socket.on('close', onEnd)
    socket.on('error', onEnd)
    // A paused socket stays paused when a data listener is added
    socket.resume()
  })
}

/** The status line and the headers, up to and with the empty line that ends them, as latin1
 *  text */
export async function readHeaders(socket: Duplex): Promise<string> {
  const head = await readUntil(socket, (buffered) => {
    const end = buffered.indexOf('\r\n\r\n')
    return end === -1 ? null : end + 4
  })
  return head.toString('latin1')
}

/** Exactly `count` bytes */
export function readExactly(socket: Duplex, count: number): Promise<Buffer> {
  if (count === 0) return Promise.resolve(Buffer.alloc(0))
  return readUntil(socket, (buffered) => (buffered.length >= count ? count : null))
}

/** Everything until the proxy closes the connection. A reset ends it as well */
export function readToEnd(socket: Duplex, timeoutMs = READ_TIMEOUT_MS): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const onData = (chunk: Buffer) => chunks.push(chunk)
    const onClose = () => {
      stop()
      resolve(Buffer.concat(chunks))
    }
    const timer = setTimeout(() => {
      stop()
      reject(new Error(`the proxy still held the connection after ${timeoutMs} ms`))
    }, timeoutMs)
    const stop = () => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('close', onClose)
    }
    socket.on('data', onData)
    socket.on('close', onClose)
    socket.resume()
    if (socket.closed) onClose()
  })
}

/** A socket connected to the proxy port. A reset from the proxy is for the reading to notice:
 *  unlistened, its error would take the test process down */
export async function rawSocket(port: number): Promise<Socket> {
  const socket = net.connect(port, '127.0.0.1')
  socket.on('error', () => {})
  await once(socket, 'connect')
  return socket
}

export interface RequestOptions {
  headers?: [string, string][]
  body?: Buffer
  chunked?: boolean
}

/** One socket with requests written on it by hand, so that keep-alive is something a test can
 *  see. Any Duplex, so that it works inside a tunnel as well */
export class RawConnection {
  readonly socket: Duplex
  readonly host: string

  constructor(socket: Duplex, host: string) {
    this.socket = socket
    this.host = host
  }

  /** The Host header first, then the headers given, then a framing header for a body: chunked
   *  or content-length. The answer's body is read by its content-length, except where none
   *  follows: the answer to HEAD, a 1xx, 204 or 304, which Node sends with the content-length
   *  it was given and no body */
  async request(method: string, target: string, options: RequestOptions = {}): Promise<Answer> {
    const { headers = [], body = Buffer.alloc(0), chunked = false } = options
    let head = `${method} ${target} HTTP/1.1\r\nhost: ${this.host}\r\n`
    for (const [name, value] of headers) head += `${name}: ${value}\r\n`
    if (body.length > 0) {
      head += chunked ? 'transfer-encoding: chunked\r\n' : `content-length: ${body.length}\r\n`
    }
    const framed =
      chunked && body.length > 0
        ? [Buffer.from(`${body.length.toString(16)}\r\n`), body, Buffer.from('\r\n0\r\n\r\n')]
        : [body]
    this.socket.write(Buffer.concat([Buffer.from(`${head}\r\n`, 'latin1'), ...framed]))

    const [statusLine = '', ...lines] = (await readHeaders(this.socket)).split('\r\n')
    const status = Number(statusLine.split(' ')[1])
    const pairs = lines
      .filter((line) => line !== '')
      .map((line): [string, string] => {
        const colon = line.indexOf(':')
        return [line.slice(0, colon), line.slice(colon + 1).trim()]
      })
    const silent = method === 'HEAD' || status < 200 || status === 204 || status === 304
    const length = pairs.find(([name]) => name.toLowerCase() === 'content-length')?.[1]
    const payload = silent ? Buffer.alloc(0) : await readExactly(this.socket, Number(length ?? 0))
    return answer(status, pairs, payload)
  }

  /** Closes the socket. destroy(), not end(): ending a TLS socket that wraps another leaves
   *  the one underneath open */
  close(): void {
    this.socket.destroy()
  }
}

/** A connection of its own to the proxy port, written to by hand */
export async function plain(port: number, host: string): Promise<RawConnection> {
  return new RawConnection(await rawSocket(port), host)
}

/**
 * CONNECT, then TLS, the way a phone opens an HTTPS connection. The certificate is checked against
 * `caPem` and the name `host`, sent as SNI; `alpn` is what the client offers. Resolves once the
 * handshake is done, and rejects with its error when it fails. Close what it gives with destroy():
 * end() closes the TLS but leaves the socket under it open.
 */
export async function connectTunnel(
  proxyPort: number,
  host: string,
  port: number,
  caPem: Buffer,
  alpn: string[] = ['http/1.1'],
): Promise<TLSSocket> {
  const raw = await rawSocket(proxyPort)
  raw.write(`CONNECT ${host}:${port} HTTP/1.1\r\nhost: ${host}:${port}\r\n\r\n`)
  const reply = await readHeaders(raw)
  if (!reply.startsWith('HTTP/1.1 200')) {
    raw.destroy()
    assert.fail(reply)
  }
  const secure = tls.connect({ socket: raw, servername: host, ca: caPem, ALPNProtocols: alpn })
  // A reset later on is for the reading to notice, as on the socket underneath
  secure.on('error', () => {})
  try {
    await once(secure, 'secureConnect')
  } catch (error) {
    raw.destroy()
    throw error
  }
  return secure
}

/** What `get` gives once it gives something, asked every 10 ms. A tunnel reports its byte counts
 *  when both its sockets close, a moment later */
export async function eventually<T>(
  get: () => T | undefined,
  what = 'the proxy reported no tunnel',
  timeoutMs = 5000,
): Promise<T> {
  const until = performance.now() + timeoutMs
  for (;;) {
    const value = get()
    if (value !== undefined) return value
    if (performance.now() >= until) assert.fail(what)
    await sleep(10)
  }
}

export interface ViaProxyOptions {
  headers?: Record<string, string>
  body?: Buffer
  /** The CA an https: URL's certificate is checked against */
  caPem?: Buffer
}

/**
 * One request through the proxy port: an http: URL goes as the absolute-form request line, with
 * the URL's host in the Host header. Node's fetch goes through no proxy, so node:http writes it.
 * agent: false gives every request a connection of its own, closed after the answer; no test that
 * uses this looks at keep-alive ('several requests share one decrypted connection' checks it
 * with RawConnection). A dropped connection rejects.
 *
 * An https: URL goes the way a client sends one through a proxy: a CONNECT to its host and port
 * (connectTunnel, the certificate checked against caPem), then the request in origin-form over
 * that TLS, with the URL's host in the Host header, and the connection closed once the answer is
 * in.
 */
export async function viaProxy(
  proxyPort: number,
  method: string,
  url: string,
  options: ViaProxyOptions = {},
): Promise<Answer> {
  const { headers = {}, body, caPem } = options
  const target = new URL(url)
  if (target.protocol === 'https:') {
    if (caPem === undefined) throw new Error(`${url} needs caPem, the CA to check it against`)
    const port = Number(target.port) || 443
    const secure = await connectTunnel(proxyPort, target.hostname, port, caPem)
    const connection = new RawConnection(secure, target.host)
    try {
      const path = target.pathname + target.search
      return await connection.request(method, path, { headers: Object.entries(headers), body })
    } finally {
      connection.close()
    }
  }
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        method,
        path: url,
        headers: { host: target.host, ...headers },
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('error', reject)
        response.on('end', () => {
          const pairs: [string, string][] = []
          const raw = response.rawHeaders
          for (let i = 0; i + 1 < raw.length; i += 2) pairs.push([raw[i]!, raw[i + 1]!])
          resolve(answer(response.statusCode ?? 0, pairs, Buffer.concat(chunks)))
        })
      },
    )
    request.on('error', reject)
    request.end(body)
  })
}

/**
 * One request over a real socket whose client hangs up, and its log row.
 *
 * The row only reaches the log once the server has let go of the request, so waiting for it is
 * waiting for exactly that — and nothing is what comes back from a server that is still holding
 * on.
 */
export async function abandonedRow(env: {
  port: number
  recorded: () => Exchange[]
}): Promise<Exchange | null> {
  const socket = await rawSocket(env.port)
  socket.write('GET http://api.example.com/api/feed HTTP/1.1\r\nhost: api.example.com\r\n\r\n')
  await sleep(200) // the server has read it and is now holding the answer back
  socket.destroy() // ... and the client gives up

  const until = performance.now() + 5000
  while (performance.now() < until) {
    const last = env
      .recorded()
      .filter((exchange) => exchange.kind === 'http')
      .at(-1)
    if (last !== undefined) return last
    await sleep(20)
  }
  return null
}
