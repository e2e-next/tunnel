// The three ways the proxy port takes a request apart: splitTarget on the target
// of a request line, splitAuthority on a host and port, and parseQuery on a
// query. They import nothing, and tests/proxy-url.test.ts holds them to the
// answers in tests/fixtures/proxy/url-cases.json.
//
// Not new URL(): it normalises what it parses, and the core has to see what the
// device sent. It resolves /a/../b to /b, percent-encodes /ü and spaces, keeps
// the brackets of an IPv6 hostname and drops a default port that was written
// out; each would change the path the rules are matched on and the key a
// recording is filed under. Nor URLSearchParams for the query: it drops a
// leading ?, which parseQuery keeps as part of the first name.

/** A request target as scheme, netloc, path and query, the fragment dropped.
 *  absolute is true when there is both a scheme and a netloc, as in the
 *  absolute-form a proxy is sent: http://api.example.com/feed */
export function splitTarget(target: string): {
  scheme: string
  netloc: string
  path: string
  query: string
  absolute: boolean
} {
  let rest = target
  // A scheme is what comes before the first colon, when it starts with a letter
  // and holds only letters, digits, +, - and dots. What follows the colon does
  // not matter: inner.example.com:443 is the scheme inner.example.com and the
  // path 443
  let scheme = ''
  const prefix = /^[A-Za-z][A-Za-z0-9+.-]*:/.exec(rest)
  if (prefix !== null) {
    scheme = prefix[0].slice(0, -1).toLowerCase()
    rest = rest.slice(prefix[0].length)
  }
  // A netloc is there only after //, and runs to the first /, ? or #
  let netloc = ''
  const authority = /^\/\/([^/?#]*)/.exec(rest)
  if (authority !== null) {
    netloc = authority[1] ?? ''
    rest = rest.slice(authority[0].length)
  }
  // The fragment comes off first, so a ? after the # starts no query
  const hash = rest.indexOf('#')
  if (hash !== -1) rest = rest.slice(0, hash)
  const question = rest.indexOf('?')
  const path = question === -1 ? rest : rest.slice(0, question)
  const query = question === -1 ? '' : rest.slice(question + 1)
  return { scheme, netloc, path, query, absolute: scheme !== '' && netloc !== '' }
}

/** `api.example.com:443`, `api.example.com` or `[::1]:443` → host and port
 *
 *  The host goes on to name a certificate, so the port and the brackets of an
 *  IPv6 literal come off here rather than ending up in a SAN.
 *
 *  Throws when what follows `]:` is not a number: `[::1]:abc` names no port
 *  that could be connected to. */
export function splitAuthority(
  authority: string,
  defaultPort: number,
): [host: string, port: number] {
  const trimmed = authority.trim()
  let host = trimmed
  let port = ''
  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']')
    if (close === -1) {
      host = trimmed.slice(1)
    } else {
      host = trimmed.slice(1, close)
      if (trimmed[close + 1] === ':') port = trimmed.slice(close + 2)
      // ASCII digits, as in a bare host:port below
      if (port !== '' && !/^[0-9]+$/.test(port)) {
        throw new Error(`the port in ${JSON.stringify(trimmed)} is not a number`)
      }
    }
  } else {
    // Only ASCII digits after the last colon make a port: host:abc is all host
    const colon = trimmed.lastIndexOf(':')
    if (colon !== -1 && /^[0-9]+$/.test(trimmed.slice(colon + 1))) {
      host = trimmed.slice(0, colon)
      port = trimmed.slice(colon + 1)
    }
  }
  return [host.toLowerCase(), port === '' ? defaultPort : parseInt(port, 10)]
}

/** The fields between the &s, each a name, =, and a value. A field with no = is
 *  a name with an empty value, an empty field is skipped, and a name given twice
 *  keeps its last value */
export function parseQuery(query: string): Record<string, string> {
  const fields = new Map<string, string>()
  for (const field of query.split('&')) {
    if (field === '') continue
    const equals = field.indexOf('=')
    const name = equals === -1 ? field : field.slice(0, equals)
    const value = equals === -1 ? '' : field.slice(equals + 1)
    fields.set(unquotePlus(name), unquotePlus(value))
  }
  // fromEntries makes each name an own property, __proto__ too, where assigning
  // to an object would call the __proto__ setter and lose the field
  return Object.fromEntries(fields)
}

// Not fatal: bytes that are not UTF-8 become U+FFFD. ignoreBOM keeps a byte order
// mark that a name or value starts with, which a TextDecoder would otherwise drop
const UTF8 = new TextDecoder('utf-8', { ignoreBOM: true })

/** A name or value of a query, decoded: + is a space, and %XX is a byte when both
 *  X are hex digits; any other % stays as it was written */
function unquotePlus(text: string): string {
  const spaced = text.replaceAll('+', ' ')
  if (!spaced.includes('%')) return spaced
  const bytes: Buffer[] = []
  let from = 0
  for (const escape of spaced.matchAll(/%[0-9A-Fa-f]{2}/g)) {
    bytes.push(Buffer.from(spaced.slice(from, escape.index), 'utf8'))
    bytes.push(Buffer.of(parseInt(escape[0].slice(1), 16)))
    from = escape.index + 3
  }
  bytes.push(Buffer.from(spaced.slice(from), 'utf8'))
  return UTF8.decode(Buffer.concat(bytes))
}
