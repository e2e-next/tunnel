// Rule keys, METHOD:[host[:port]]/path: reading one, the one canonical way to spell
// it, whether one answers for a request, and which rule wins when several do.
//
// A key with no host answers for any host.
//
// A key that does not read throws a UserError, the key quoted the way repr() quotes
// it: the admin API answers with its message as the detail of a 400, and the panel,
// the CLI and MCP show that detail as it comes. Choosing a rule is the exception:
// it skips such a key with a warning.
import { repr, UserError } from './errors.ts'
import { matchGlob } from './glob.ts'
import { getLogger } from './log.ts'

const log = getLogger('rule-keys')

/** What a rule key looks like, as the error for one that does not read spells it out */
export const KEY_FORMAT = 'METHOD:[host[:port]]/path'

/** A parsed rule key. An empty host answers for any host. */
export interface Key {
  /** Upper-cased */
  readonly method: string
  /** Lower-cased. '' for any host, whether the key named none or `*`; may hold a `*` */
  readonly host: string
  /** null for any port */
  readonly port: number | null
  /** Starts with a /, keeps its case, may hold a `*` */
  readonly path: string
}

/** One character or more, every one of them a letter, in any script */
const LETTERS = /^\p{L}+$/u
/** A port, in ASCII digits only (splitPort says why) */
const DIGITS = /^[0-9]+$/
/** The longest a port can be, in digits, leading zeros and all */
const MAX_PORT_DIGITS = 4300

/** METHOD:host[:port]path, with the port only when the key has one */
function formatKey(key: Key): string {
  return `${key.method}:${key.host}${key.port !== null ? `:${key.port}` : ''}${key.path}`
}

/** One shape of complaint, whatever is wrong: what was given, and what is expected */
function invalid(key: string, reason: string): UserError {
  return new UserError(
    `${repr(key)} is not a valid request key (${reason}); the shape is ${KEY_FORMAT}, ` +
      'for example GET:/api/feed or GET:api.example.com/api/feed',
  )
}

/**
 * The host before the last colon and the port after it, or the whole authority
 * and no port when it has no colon; null when what follows the colon is not a
 * port, which parseKey turns into the error.
 *
 * A port is in ASCII digits only, and at or below 2^53 - 1 so that the canonical
 * spelling reads back as the same key: past it a number is rounded
 * (99999999999999999999 would be spelled 100000000000000000000), and from 10^21
 * on it is written as 1e+21, which does not read at all. Nobody writes a port
 * in other digits or past that.
 *
 * A port of more than 4,300 digits, leading zeros and all, is refused too, in
 * the words used for any port that does not read.
 */
function splitPort(authority: string): { host: string; port: number | null } | null {
  const colon = authority.lastIndexOf(':')
  if (colon < 0) return { host: authority, port: null }
  const digits = authority.slice(colon + 1)
  if (!DIGITS.test(digits) || digits.length > MAX_PORT_DIGITS) return null
  const port = Number(digits)
  return Number.isSafeInteger(port) ? { host: authority.slice(0, colon), port } : null
}

/**
 * Read a rule key, or say what is wrong with it: a UserError.
 *
 * GET:/api/feed means any host, GET:api.example.com/api/feed one host,
 * GET:*.example.com/api/* a family of them.
 */
export function parseKey(key: string): Key {
  // The method is all before the first colon, and something has to follow that colon
  const colon = key.indexOf(':')
  if (colon < 0 || colon === key.length - 1) {
    throw invalid(key, "no method and path separated by ':'")
  }
  const method = key.slice(0, colon)
  if (!LETTERS.test(method)) throw invalid(key, `${repr(method)} is not an HTTP method`)

  // The authority runs up to the first /, so it is empty when the rest starts with
  // one; the path is all from that / on, colons and all
  const rest = key.slice(colon + 1)
  const slash = rest.indexOf('/')
  if (slash < 0) throw invalid(key, 'no path')
  const authority = rest.slice(0, slash)
  const path = rest.slice(slash)

  const split = splitPort(authority)
  if (split === null) throw invalid(key, `${repr(authority)} is not a host or host:port`)
  const { host, port } = split

  // A `*` host is the same thing as leaving the host off.
  return { method: method.toUpperCase(), host: host === '*' ? '' : host.toLowerCase(), port, path }
}

/**
 * The canonical spelling of a key: upper-case method, lower-case host, a `*` host
 * left off and the port without leading zeros. A key that does not read throws,
 * as parseKey does.
 */
export function normaliseKey(key: string): string {
  return formatKey(parseKey(key))
}

/**
 * `*` is the only wildcard we promise; a pattern without one is literal.
 * A pattern with one goes to matchGlob whole, so there `?` and `[...]` are
 * wildcards as well, though not promised.
 */
function glob(pattern: string, value: string): boolean {
  return pattern.includes('*') ? matchGlob(value, pattern) : value === pattern
}

/**
 * Whether this key answers for this request. A null port is not looked at; 0 is
 * a port like any other, not "no port". The request's method is compared as it
 * comes, not upper-cased; its host is lower-cased first; its path keeps its case.
 */
export function keyMatches(
  key: Key,
  method: string,
  host: string,
  port: number | null,
  path: string,
): boolean {
  if (key.method !== method) return false
  // A key that names a port only answers on that port; a request with no port (a
  // recorded key being looked up, say) is not held to it. Both are compared with
  // null, as a test of truth would take port 0 for no port.
  if (key.port !== null && port !== null && key.port !== port) return false
  if (key.host !== '' && !glob(key.host, host.toLowerCase())) return false
  return glob(key.path, path)
}

/** How specific a key is, place by place: its path, then its host, then its length */
type Rank = readonly [path: number, host: number, length: number]

/**
 * How specific this key is; the highest rank among the matches wins.
 *
 * The path comes first: `GET:/api/user/me` beats `GET:/api/user/*`, and a broad
 * `GET:api.example.com/api/*` cannot swallow a rule written for one exact path.
 * Then an exact host beats a wildcard host beats any host, and between two
 * equally specific patterns the longer one wins.
 */
function keyRank(key: Key): Rank {
  const path = key.path.includes('*') ? 0 : 1
  const host = key.host === '' ? 0 : key.host.includes('*') ? 1 : 2
  // The length in code points. In UTF-16 units a character past U+FFFF would
  // count twice and could turn a tie the other way.
  return [path, host, [...formatKey(key)].length]
}

/**
 * a > b, place by place: the first place where they differ decides, and a rank
 * equal to the other does not outrank it.
 */
function outranks(a: Rank, b: Rank): boolean {
  if (a[0] !== b[0]) return a[0] > b[0]
  if (a[1] !== b[1]) return a[1] > b[1]
  return a[2] > b[2]
}

/**
 * The most specific configured rule for this request, or null when no rule
 * answers for it. Only the keys of configs are read and the rule comes back as it
 * is, so R can be anything. A key that does not read (a hand-edited config.json
 * can hold one) is skipped, with a warning.
 */
export function selectRule<R>(
  configs: Record<string, R>,
  method: string,
  host: string,
  port: number | null,
  path: string,
): R | null {
  let best: R | null = null
  let bestRank: Rank | null = null

  // In the order the rules went in. JS moves keys that look like integers to the
  // front, but every rule key has a colon: only one that does not read can move,
  // and only its warning comes earlier.
  for (const [raw, config] of Object.entries(configs)) {
    let key: Key
    try {
      key = parseKey(raw)
    } catch (error) {
      // Anything but a UserError is a bug, and goes on up
      if (!(error instanceof UserError)) throw error
      log.warning(`Ignoring a rule with an unreadable key: ${repr(raw)}`)
      continue
    }
    if (!keyMatches(key, method, host, port, path)) continue
    const rank = keyRank(key)
    // Strictly higher, so of two rules that rank the same the first one stays
    if (bestRank === null || outranks(rank, bestRank)) {
      best = config
      bestRank = rank
    }
  }

  return best
}
