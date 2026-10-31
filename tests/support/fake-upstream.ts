// fakeUpstream(handler): an upstream for the core that opens no socket and answers for any host. A test
// that needs a real server after all uses startUpstream from ./upstream.ts.
import {
  UpstreamError,
  type UpstreamClient,
  type UpstreamRequest,
  type UpstreamResponse,
} from '../../src/upstream.ts'

/** The methods node:http sends no content-length for when the body is empty: the ones its
 *  useChunkedEncodingByDefault is false for. Every other method gets `content-length: 0` */
const NO_LENGTH_WHEN_EMPTY = new Set(['GET', 'HEAD', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT'])

/** The handler sees what the wire would have carried. The address is checked the way nodeUpstream checks it first
 *  (an unparsable URL, a scheme other than http(s): the same UpstreamError sentences), then `host` is filled in from
 *  the URL (`new URL(url).host`, default port left off) and `content-length` the way the real client sends it: the
 *  body's length when there is one; `0` for an empty body unless the method is GET, HEAD, DELETE, OPTIONS, TRACE or
 *  CONNECT (Node's own table); nothing otherwise. A header the request already carries is left alone. Throw
 *  UpstreamError from the handler to stand in for a server that cannot be reached. close() does nothing */
export function fakeUpstream(
  handler: (request: UpstreamRequest) => UpstreamResponse | Promise<UpstreamResponse>,
): UpstreamClient {
  return {
    // An async function, so that an UpstreamError the handler throws rejects, as the real one's does
    async send(request) {
      if (!URL.canParse(request.url)) throw new UpstreamError(`Invalid URL: ${request.url}`)
      const url = new URL(request.url)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        const message = `Unsupported protocol in ${request.url}: only http and https can be forwarded`
        throw new UpstreamError(message)
      }
      const headers = { ...request.headers }
      const names = new Set(Object.keys(headers).map((name) => name.toLowerCase()))
      if (!names.has('host')) headers.host = url.host
      if (!names.has('content-length')) {
        if (request.body.length > 0) headers['content-length'] = String(request.body.length)
        else if (!NO_LENGTH_WHEN_EMPTY.has(request.method.toUpperCase())) {
          headers['content-length'] = '0'
        }
      }
      return handler({ ...request, headers })
    },
    async close() {},
  }
}

/** A JSON answer, content-type application/json, keys of `headers` written over it */
export function jsonAnswer(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): UpstreamResponse {
  return {
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: Buffer.from(JSON.stringify(value)),
  }
}
