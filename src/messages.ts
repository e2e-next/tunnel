// What a request is and what it is answered with, whichever transport carried
// it: Request and Response, with DEFAULT_PORTS and what is worked out from a
// request. The proxy port builds a Request, the core answers it with a
// Response, and the request log and the recordings keep both. They sit below
// every module that uses them and import only json.ts, which sits lower still.
//
// A Request or a Response is a plain object that makeRequest or makeResponse
// fills in with the defaults. What is worked out from a request is a function:
// effectivePort, origin, requestUrl and requestKey.
import { stringifySpaced, type JsonValue } from './json.ts'

/** One request to answer, whichever transport carried it.
 *
 *  Header keys are lower-case and query values are strings — the same shape a script's `ctx`
 *  sees, and the shape the recorded exchange keeps. */
export interface Request {
  method: string // 'GET'; the proxy port gives it in upper case
  scheme: string // 'http' or 'https'
  host: string // lower-case, which makeRequest sees to
  /** null means "whatever the scheme implies", so that a request built by hand does not have to
   *  spell out 80 or 443. 0 means the same. */
  port: number | null
  path: string
  query: Record<string, string> // decoded, every value a string
  headers: Record<string, string> // names lower-case, repeats joined with ', ', both by the proxy port
  body: Buffer // decompressed
  client: string // the client's address
  /** Whether whoever asked has stopped waiting for the answer. Only a transport holding the
   *  socket can tell, so the proxy port fills this in and nobody else does: a request built by
   *  hand, or by a test, has nobody to walk away from it, and its gave_up always answers false.
   *  Only an answer that waits — the `hang` fault — has reason to ask. */
  gave_up: () => boolean
}

/** The answer, still as bytes: no transport has been chosen yet. */
export interface Response {
  status: number
  headers: Record<string, string>
  body: Buffer
  /** The `close` fault: the proxy port drops the connection instead of writing a response at
   *  all, so the client meets a network error rather than a status. */
  close: boolean
  // What the log should say about this answer rather than anything that goes on the wire: the
  // recording it was replayed from, and whether nothing at all was configured or recorded for
  // the request.
  replay_seq: number | null
  unmatched: boolean
}

/** The port each scheme implies, frozen */
export const DEFAULT_PORTS: Readonly<Record<string, number>> = Object.freeze({
  http: 80,
  https: 443,
})

/** The port DEFAULT_PORTS gives a scheme, from the table's own entries only, so that a scheme
 *  named `constructor` does not find what Object.prototype holds under that name */
function defaultPort(scheme: string): number | undefined {
  return Object.hasOwn(DEFAULT_PORTS, scheme) ? DEFAULT_PORTS[scheme] : undefined
}

/** What Request.gave_up answers when no transport filled it in */
function stillWaiting(): boolean {
  return false
}

/** A Request from the fields given and the defaults for the rest: GET, http, '', null, '/',
 *  {}, {}, an empty Buffer, '' and a gave_up that always answers false. A field given as
 *  undefined counts as not given. Every call makes a query, headers and body of its own; a query
 *  or headers given are kept as they are, not copied. */
export function makeRequest(fields?: Partial<Request>): Request {
  const { method, scheme, host, port, path, query, headers, body, client, gave_up } = fields ?? {}
  return {
    method: method ?? 'GET',
    scheme: scheme ?? 'http',
    // Host names are case insensitive, and matching a rule already treats them that way.
    // Normalising here as well keeps the key this request is recorded under equal to the key a
    // rule is stored under, so a client that spells the Host header `API.Example.com` does not
    // show up as a second endpoint in the request log.
    host: (host ?? '').toLowerCase(),
    port: port ?? null,
    path: path ?? '/',
    query: query ?? {},
    headers: headers ?? {},
    body: body ?? Buffer.alloc(0),
    client: client ?? '',
    gave_up: gave_up ?? stillWaiting,
  }
}

/** A Response from the fields given and the defaults for the rest: 200, {}, an empty Buffer,
 *  false, null, false. A field given as undefined counts as not given. */
export function makeResponse(fields?: Partial<Response>): Response {
  const { status, headers, body, close, replay_seq, unmatched } = fields ?? {}
  return {
    status: status ?? 200,
    headers: headers ?? {},
    body: body ?? Buffer.alloc(0),
    close: close ?? false,
    replay_seq: replay_seq ?? null,
    unmatched: unmatched ?? false,
  }
}

/** The port this request goes to: its port, or else the one the scheme implies, or else 80. A
 *  port of 0 falls back as null does. */
export function effectivePort(request: Request): number {
  return request.port || (defaultPort(request.scheme) ?? 80)
}

/** `scheme://host[:port]`, where this request was really going. The port is left out when it is
 *  null, 0 or the scheme's default; a scheme with no default port gets any other port written,
 *  80 included. */
export function origin(request: Request): string {
  const { scheme, host, port } = request
  if (port && port !== defaultPort(scheme)) return `${scheme}://${host}:${port}`
  return `${scheme}://${host}`
}

/** The whole address that was asked for, query and all: origin and path, then '?' and
 *  urlencode(query) when the query is not empty */
export function requestUrl(request: Request): string {
  const url = `${origin(request)}${request.path}`
  return Object.keys(request.query).length > 0 ? `${url}?${urlencode(request.query)}` : url
}

/** METHOD:host/path, the key this request is recorded and matched under */
export function requestKey(request: Request): string {
  return `${request.method}:${request.host}${request.path}`
}

/** The bytes quotePlus writes as they are: RFC 3986's unreserved characters */
const ALWAYS_SAFE = new Set(
  Buffer.from('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-~'),
)

/** The text's UTF-8 bytes: a letter, a digit or one of `_.-~` as it is, a space as '+', and every
 *  other byte as %XX in upper case */
function quotePlus(text: string): string {
  let quoted = ''
  for (const byte of Buffer.from(text, 'utf8')) {
    if (ALWAYS_SAFE.has(byte)) quoted += String.fromCharCode(byte)
    else if (byte === 0x20) quoted += '+'
    else quoted += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return quoted
}

/** The query as a URL spells it: each key and each value through quotePlus, written as key=value
 *  and joined with '&'.
 *
 *  URLSearchParams would not do: it writes '~' as %7E and leaves '*' alone, the opposite of what
 *  tests/fixtures/requests/urlencode.json pins (q=a+b%26c%7E* where this writes q=a+b%26c~%2A).
 *  Nor would encodeURIComponent, which leaves !'()* alone and throws URIError on a lone
 *  surrogate. Here a lone surrogate is written as U+FFFD, %EF%BF%BD; the proxy port has replaced
 *  it by the time a query gets this far. A key that looks like an integer ("10") comes first,
 *  where a JS object puts it, not in the order the query came in. */
export function urlencode(query: Readonly<Record<string, string>>): string {
  return Object.entries(query)
    .map(([key, value]) => `${quotePlus(key)}=${quotePlus(value)}`)
    .join('&')
}

/** `overrides` written over `headers`, matching names whatever their case. A header the answer
 *  already carries is replaced rather than joined by a second copy of itself: `Content-Type` and
 *  `content-type` are one header, and two of them on one answer is one more than a client will
 *  read. null, undefined and {} return `headers` itself; anything else gives a new object, the
 *  headers kept in their order and then the overrides in theirs. */
export function overrideHeaders(
  headers: Record<string, string>,
  overrides: Readonly<Record<string, string>> | null | undefined,
): Record<string, string> {
  if (!overrides || Object.keys(overrides).length === 0) return headers
  const replaced = new Set(Object.keys(overrides).map((name) => name.toLowerCase()))
  // fromEntries makes a header named "__proto__" a key like any other, where Object.assign
  // would set the prototype instead
  return Object.fromEntries([
    ...Object.entries(headers).filter(([name]) => !replaced.has(name.toLowerCase())),
    ...Object.entries(overrides),
  ])
}

/** JSON with ', ' and ': ' separators and non-ASCII as it is (stringifySpaced), content-type
 *  application/json unless `headers` names another */
export function jsonResponse(
  payload: JsonValue,
  status = 200,
  headers: Readonly<Record<string, string>> | null = null,
): Response {
  return makeResponse({
    status,
    headers: overrideHeaders({ 'content-type': 'application/json' }, headers),
    body: Buffer.from(stringifySpaced(payload), 'utf8'),
  })
}

/** UTF-8 text, content-type text/plain; charset=utf-8 unless `headers` names another */
export function textResponse(
  text: string,
  status = 200,
  headers: Readonly<Record<string, string>> | null = null,
): Response {
  return makeResponse({
    status,
    headers: overrideHeaders({ 'content-type': 'text/plain; charset=utf-8' }, headers),
    body: Buffer.from(text, 'utf8'),
  })
}

/** Every error tunnel itself produces has the same {"detail": ...} shape */
export function errorResponse(status: number, detail: string): Response {
  return jsonResponse({ detail }, status)
}
