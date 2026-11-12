// Which way a request for the real server leaves tunnel: straight there, or through the HTTP proxy this Mac
// is set to. nodeUpstream asks for every request it forwards, the proxy port for every tunnel it does not
// decrypt, and the banner, `tunnel status` and health print describe(). Sending everything to the proxy would
// send the loopback and the LAN there too, and a request back to tunnel itself, in a loop, when the proxy is
// tunnel, which is how docs/devices.md has the iOS Simulator's Mac set up.
//
// The order is the environment variables, lower-case first; macOS's own settings (scutil --proxy) when
// they name no proxy; then straight there. Two guards stand around it: a local target never goes through a
// proxy, and a proxy that is tunnel's own proxy port counts as none. The environment, the system proxy and
// this machine's addresses are read together and used for ROUTE_CACHE_MS, so a proxy app switched on or off
// shows within that time, and a burst of requests costs one scutil.
import { execFile } from 'node:child_process'
import { BlockList, isIP, isIPv6 } from 'node:net'
import { networkInterfaces } from 'node:os'
import { performance } from 'node:perf_hooks'
import { reasonOf } from './errors.ts'
import { getLogger } from './log.ts'

const log = getLogger('upstream')

/** How long one reading of the environment, macOS's proxy settings and this machine's addresses is used */
export const ROUTE_CACHE_MS = 5_000

/** What is about to be sent: a CONNECT tunnel asks as 'https'. `host` may carry brackets, a zone, a trailing dot */
export interface RouteTarget {
  scheme: 'http' | 'https'
  host: string
  port: number
}

/** An HTTP proxy to go through */
export interface ProxyEndpoint {
  host: string // a name or an IP, no brackets
  port: number
  authorization: string | null // `Basic …` when the proxy URL carried credentials
  source: string // the variable as spelled ('https_proxy', 'HTTPS_PROXY', 'ALL_PROXY'…) or 'system proxy'
  label: string // `127.0.0.1:3128` for the system proxy, the URL without credentials for a variable
}
export type DirectReason =
  | 'local' // loopback, a private network, link-local, *.local, localhost
  | 'no proxy' // nothing configured for this scheme
  | 'bypassed' // no_proxy (`*` included), the macOS exception list, a simple host name
  | 'ignored' // a proxy URL tunnel cannot use: socks5://, https://, unparsable
  | 'tunnel itself' // the proxy is tunnel's own proxy port
export type Route =
  { kind: 'direct'; reason: DirectReason } | { kind: 'proxy'; proxy: ProxyEndpoint }

/** Everything the routes read from outside; the defaults are the real ones, tests hand in their own */
export interface RouteSources {
  env: Readonly<Record<string, string | undefined>> // process.env, read again on every refresh
  platform: string // process.platform: only 'darwin' reads a system proxy
  readSystemProxy: () => Promise<string> // stdout of /usr/sbin/scutil --proxy, 2 s timeout
  localAddresses: () => readonly string[] // every address in os.networkInterfaces()
  now: () => number // performance.now()
}

/** The top level of `scutil --proxy`: values as strings, <array>s as string lists; nested dictionaries such as
 *  __SCOPED__ are left out, the way SCDynamicStoreCopyProxies' callers only read the top level */
export function parseScutilProxy(text: string): Record<string, string | string[]> {
  // Gathered in a Map and made an object by fromEntries, so that a key named __proto__ is a key like any other
  const top = new Map<string, string | string[]>()
  let depth = 0 // 1 inside the outer <dictionary>
  let list: string[] | null = null // the top-level <array> being read
  for (const line of text.split('\n').map((raw) => raw.trim())) {
    if (line === '}') {
      depth -= 1
      if (depth < 2) list = null
      continue
    }
    // A key and its value meet at the first ' : ', since a value may hold colons (an IPv6 proxy, ::1). An
    // empty value, which an item of a list may be, leaves the line ending in ' :' once its blank is trimmed
    const at = line.indexOf(' : ')
    const key = at !== -1 ? line.slice(0, at) : line.endsWith(' :') ? line.slice(0, -2) : null
    const value = at !== -1 ? line.slice(at + 3) : ''
    if (/<(array|dictionary)> \{$/.test(line)) {
      depth += 1
      if (depth === 2 && key !== null && value === '<array> {') {
        list = []
        top.set(key, list)
      }
      continue
    }
    if (key === null) continue // a line of some other shape
    if (depth === 1) top.set(key, value)
    else if (depth === 2 && list !== null) list.push(value)
  }
  return Object.fromEntries(top)
}

export class UpstreamRoutes {
  /** The port tunnel's own proxy listens on: ProxyServer sets it once it listens. While it is null nothing is
   *  taken for tunnel itself */
  ownProxyPort: number | null = null
  readonly #sources: RouteSources
  readonly #cacheMs: number
  #settings: Settings | null = null
  #readAt = 0
  // The reading under way, which callers that come meanwhile wait for rather than start one of their own
  #reading: Promise<Settings> | null = null
  // The last reading of scutil that worked, kept for when one does not
  #system: Record<string, string | string[]> | null = null
  // This machine's addresses as last read, kept the same way
  #addresses: ReadonlySet<string> = new Set<string>()
  // The warnings given for readings that failed, each given once
  readonly #warned = new Set<string>()
  #lastLine: string | null = null

  constructor(sources?: Partial<RouteSources>, options?: { cacheMs?: number }) {
    this.#sources = { ...REAL_SOURCES, ...sources }
    this.#cacheMs = options?.cacheMs ?? ROUTE_CACHE_MS
  }

  /** The way out for one request. Never rejects: a reading that fails counts as no system proxy */
  async route(target: RouteTarget): Promise<Route> {
    const host = normalized(target.host)
    // Settled before anything is read: a development server on this Mac or a test machine on the LAN is no
    // business of a proxy's, and its answer should not wait for scutil
    if (isLocal(host)) return direct('local')
    const settings = await this.#current()
    if (settings.noProxyAll !== null) return direct('bypassed')
    const way = settings[target.scheme]
    if (way.kind === 'none') return direct('no proxy')
    if (way.kind === 'ignored') return direct('ignored')
    const bypassed =
      matches(settings.noProxy, host, target.port) ||
      matches(way.exceptions, host, target.port) ||
      (way.excludeSimple && !host.includes('.') && isIP(host) === 0)
    if (bypassed) return direct('bypassed')
    // A proxy that is tunnel itself would hand every request back to tunnel, again and again
    if (this.#isItself(way.proxy, settings.addresses)) return direct('tunnel itself')
    return { kind: 'proxy', proxy: way.proxy }
  }

  /** One line for people, no prefix: `via 127.0.0.1:3128 (system proxy)`, `direct`, `direct (system proxy points
   *  at tunnel itself, ignored)`. Banner, status and health print `upstream: …` */
  async describe(): Promise<string> {
    return this.#lineFor(await this.#current())
  }

  /** The reading in use: the one held while it is fresh, else a new one, shared with whoever asks meanwhile */
  async #current(): Promise<Settings> {
    if (this.#settings !== null && this.#sources.now() - this.#readAt < this.#cacheMs) {
      return this.#settings
    }
    this.#reading ??= this.#refresh().finally(() => {
      this.#reading = null
    })
    return this.#reading
  }

  async #refresh(): Promise<Settings> {
    const settings = await this.#read()
    this.#settings = settings
    this.#readAt = this.#sources.now()
    // Logged when it changes, so that tunnel.log shows when a proxy app was switched on or off
    const line = this.#lineFor(settings)
    if (line !== this.#lastLine) {
      this.#lastLine = line
      log.info(`Upstream route: ${line}`)
    }
    return settings
  }

  /** One reading of everything a route depends on but the target */
  async #read(): Promise<Settings> {
    const { env } = this.#sources
    const noProxy = variable(env, 'no_proxy')
    const items = noProxy === null ? [] : noProxy.value.split(',')
    const noProxyAll =
      noProxy !== null && items.some((item) => item.trim() === '*') ? noProxy.name : null
    const https = variable(env, 'https_proxy')
    const http = variable(env, 'http_proxy')
    const all = variable(env, 'all_proxy')
    let ways: { http: Way; https: Way }
    if (https !== null || http !== null || all !== null) {
      // A proxy named in the environment makes the environment the whole answer: a scheme it names no proxy
      // for goes straight there, not to the system's proxy. NO_PROXY alone names none, so the system's is read
      ways = { http: fromVariable(http ?? all), https: fromVariable(https ?? all) }
    } else if (this.#sources.platform === 'darwin' && noProxyAll === null) {
      ways = await this.#readSystem()
    } else {
      ways = { http: NONE, https: NONE }
    }
    return { ...ways, noProxy: rules(items), noProxyAll, addresses: this.#readAddresses() }
  }

  /** The system's proxies, from scutil. A reading that fails leaves the last one that worked in use; with none
   *  to fall back on, both schemes go straight there and describe() says why */
  async #readSystem(): Promise<{ http: Way; https: Way }> {
    let system = this.#system
    try {
      system = parseScutilProxy(await this.#sources.readSystemProxy())
      this.#system = system
    } catch (error) {
      const reason = oneLineReason(error)
      this.#warnOnce(`Could not read the system proxy: ${reason}`)
      if (system === null) {
        const none: Way = { kind: 'none', why: `could not read the system proxy: ${reason}` }
        return { http: none, https: none }
      }
    }
    return systemWays(system)
  }

  /** This machine's addresses, which tell tunnel's own proxy port on one of them. os.networkInterfaces()
   *  throws a SystemError when libuv cannot list them; then the last list read stays in use, none before
   *  the first, as with scutil, so that route() still never rejects. The loopback, 0.0.0.0 and :: are this
   *  machine's whatever the list says */
  #readAddresses(): ReadonlySet<string> {
    try {
      this.#addresses = new Set(this.#sources.localAddresses().map(normalized))
    } catch (error) {
      this.#warnOnce(`Could not read this machine's addresses: ${oneLineReason(error)}`)
    }
    return this.#addresses
  }

  /** A warning for a reading that failed, given the first time only, however often it fails that way */
  #warnOnce(message: string): void {
    if (this.#warned.has(message)) return
    this.#warned.add(message)
    log.warning(message)
  }

  /** describe() for a reading: how an ordinary host on the internet is reached, said once when http and https
   *  are reached the same way, else for each, http first */
  #lineFor(settings: Settings): string {
    if (settings.noProxyAll !== null) return `direct (${settings.noProxyAll}=*)`
    const http = this.#told(settings.http, settings.addresses)
    const https = this.#told(settings.https, settings.addresses)
    if (http.way !== https.way) return `${spelled(http)} for http; ${spelled(https)} for https`
    // Said once, with what each scheme gave for it: one proxy from two variables names both
    const whys = [...new Set([http.why, https.why])].filter((why) => why !== null)
    return spelled({ way: http.way, why: whys.length === 0 ? null : whys.join('; ') })
  }

  /** One scheme's way out for describe(), and what to say in brackets after it */
  #told(way: Way, addresses: ReadonlySet<string>): { way: string; why: string | null } {
    switch (way.kind) {
      case 'none':
        return { way: 'direct', why: way.why }
      case 'ignored':
        return { way: 'direct', why: `${way.setting} ignored: only http:// proxies are supported` }
      case 'proxy':
        if (this.#isItself(way.proxy, addresses)) {
          return { way: 'direct', why: `${way.proxy.source} points at tunnel itself, ignored` }
        }
        return { way: `via ${way.proxy.label}`, why: way.proxy.source }
    }
  }

  /** Whether the proxy is tunnel's own proxy port: that port on the loopback, on every address (0.0.0.0, ::),
   *  or on an address of this machine. Only as written: no name but localhost counts, none is looked up */
  #isItself(proxy: ProxyEndpoint, addresses: ReadonlySet<string>): boolean {
    if (proxy.port !== this.ownProxyPort) return false
    const host = normalized(proxy.host)
    return host === 'localhost' || isAddressIn(THIS_MACHINE, host) || addresses.has(host)
  }
}

/** How one scheme leaves according to a reading, before the target is looked at */
type Way =
  // why: for describe(), when something tunnel does not do is switched on, or scutil could not be read
  | { kind: 'none'; why: string | null }
  // setting: the variable and its value, the credentials taken out
  | { kind: 'ignored'; setting: string }
  // exceptions, excludeSimple: macOS's own, for its own proxy only
  | { kind: 'proxy'; proxy: ProxyEndpoint; exceptions: readonly Rule[]; excludeSimple: boolean }

const NONE: Way = { kind: 'none', why: null }

/** One reading: everything a route depends on but the target */
interface Settings {
  http: Way
  https: Way
  noProxy: readonly Rule[]
  /** The no_proxy variable, as spelled, when one of its items is a lone *: nothing goes through a proxy */
  noProxyAll: string | null
  addresses: ReadonlySet<string>
}

/** The real sources: this process's environment and platform, scutil, this machine's network interfaces */
const REAL_SOURCES: RouteSources = {
  env: process.env,
  platform: process.platform,
  readSystemProxy: () =>
    new Promise<string>((resolve, reject) => {
      execFile('/usr/sbin/scutil', ['--proxy'], { timeout: 2000 }, (error, stdout) => {
        if (error === null) resolve(stdout)
        else reject(error)
      })
    }),
  localAddresses: () =>
    Object.values(networkInterfaces()).flatMap((list) =>
      (list ?? []).map(({ address }) => address),
    ),
  now: () => performance.now(),
}

const direct = (reason: DirectReason): Route => ({ kind: 'direct', reason })

/** Targets by address that never go through a proxy: the loopback, the private networks, link-local, and the
 *  unspecified addresses */
const LOCAL = new BlockList()
LOCAL.addSubnet('127.0.0.0', 8, 'ipv4')
LOCAL.addSubnet('10.0.0.0', 8, 'ipv4')
LOCAL.addSubnet('172.16.0.0', 12, 'ipv4')
LOCAL.addSubnet('192.168.0.0', 16, 'ipv4')
LOCAL.addSubnet('169.254.0.0', 16, 'ipv4')
LOCAL.addAddress('0.0.0.0', 'ipv4')
LOCAL.addAddress('::1', 'ipv6')
LOCAL.addAddress('::', 'ipv6')
LOCAL.addSubnet('fc00::', 7, 'ipv6')
LOCAL.addSubnet('fe80::', 10, 'ipv6')

/** Addresses that are this machine whatever its interfaces: the loopback, and every address (0.0.0.0, ::) */
const THIS_MACHINE = new BlockList()
THIS_MACHINE.addSubnet('127.0.0.0', 8, 'ipv4')
THIS_MACHINE.addAddress('::1', 'ipv6')
THIS_MACHINE.addAddress('0.0.0.0', 'ipv4')
THIS_MACHINE.addAddress('::', 'ipv6')

/** A host the way the rules compare it: lower case, no brackets, no IPv6 zone, no dot at the end */
function normalized(host: string): string {
  let name = host.toLowerCase()
  if (name.startsWith('[') && name.endsWith(']')) name = name.slice(1, -1)
  const zone = name.indexOf('%')
  if (zone !== -1) name = name.slice(0, zone)
  return name.endsWith('.') ? name.slice(0, -1) : name
}

/** Local by the address or the name as written: no name is looked up, so one that /etc/hosts, or a proxy
 *  app's fake IP, points at 127.0.0.1 is not local */
function isLocal(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  return isAddressIn(LOCAL, host)
}

/** Whether host is an address, and one the list holds. An IPv4-mapped IPv6 address counts as the IPv4 one */
function isAddressIn(list: BlockList, host: string): boolean {
  const family = isIP(host)
  return family !== 0 && list.check(host, family === 6 ? 'ipv6' : 'ipv4')
}

/** A variable by its lower-case name if that is set at all, else by its upper-case one: a lower-case one set
 *  to nothing switches the other off. Null when it says nothing */
function variable(env: RouteSources['env'], lower: string): { name: string; value: string } | null {
  const name = env[lower] === undefined ? lower.toUpperCase() : lower
  const value = env[name]?.trim() ?? ''
  return value === '' ? null : { name, value }
}

/** The way out a proxy variable gives: through it, or straight there when it is no http:// proxy */
function fromVariable(found: { name: string; value: string } | null): Way {
  if (found === null) return NONE
  const proxy = proxyFromUrl(found)
  if (proxy !== null) return { kind: 'proxy', proxy, exceptions: [], excludeSimple: false }
  return { kind: 'ignored', setting: `${found.name}=${withoutCredentials(found.value)}` }
}

/** The endpoint of an http:// proxy URL, null for any other scheme (SOCKS, and TLS to the proxy, are not
 *  done) or a value that is no URL. No scheme means http://, told by the '://' alone:
 *  URL.canParse takes localhost:3128 for a URL whose scheme is localhost: */
function proxyFromUrl({ name, value }: { name: string; value: string }): ProxyEndpoint | null {
  const text = value.includes('://') ? value : `http://${value}`
  if (!URL.canParse(text)) return null
  const url = new URL(text)
  if (url.protocol !== 'http:') return null
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname
  const port = Number(url.port) || 80
  // URL keeps them percent-encoded; they are decoded before the header is built
  const user = unquote(url.username)
  const password = unquote(url.password)
  const authorization =
    user === '' && password === ''
      ? null
      : `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`
  return { host, port, authorization, source: name, label: `http://${hostPort(host, port)}` }
}

/** A proxy URL as it was given, but for the user:password@ in it */
function withoutCredentials(url: string): string {
  return url.replace(/^([^:/?#]+:\/\/)?[^/?#]*@/, '$1')
}

/** Percent-decoded; one with a % that starts no escape is taken as it is, rather than failing the reading */
function unquote(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/** host:port, an IPv6 address in brackets */
function hostPort(host: string, port: number): string {
  return isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`
}

/** Why a reading failed, on one line: execFile's message for a failed command carries the command's stderr
 *  on lines of its own, and the system proxy's reason goes into describe(), which is one line */
function oneLineReason(error: unknown): string {
  return reasonOf(error).replace(/\s+/g, ' ').trim()
}

/** The ways out macOS's settings give: the Web proxy for http, the secure Web proxy for https (an HTTP proxy
 *  that takes CONNECT, plain HTTP up to it), each with the exception list and "Exclude simple hostnames".
 *  No authorization: macOS keeps a proxy's password in the keychain, out of tunnel's reach */
function systemWays(system: Record<string, string | string[]>): { http: Way; https: Way } {
  const exceptions = rules(Array.isArray(system.ExceptionsList) ? system.ExceptionsList : [])
  const excludeSimple = system.ExcludeSimpleHostnames === '1'
  const wayFor = (prefix: 'HTTP' | 'HTTPS'): Way => {
    const host = system[`${prefix}Proxy`]
    if (system[`${prefix}Enable`] === '1' && typeof host === 'string' && host !== '') {
      const port = Number(system[`${prefix}Port`]) || 80
      const label = hostPort(host, port)
      const proxy = { host, port, authorization: null, source: 'system proxy', label }
      return { kind: 'proxy', proxy, exceptions, excludeSimple }
    }
    // Switched on in a form tunnel does not do: describe() says so, or going straight there is a mystery
    if (system.ProxyAutoConfigEnable === '1') {
      return { kind: 'none', why: 'the system proxy uses a PAC file, which tunnel does not read' }
    }
    if (system.SOCKSEnable === '1')
      return { kind: 'none', why: 'the system SOCKS proxy is not supported' }
    return NONE
  }
  return { http: wayFor('HTTP'), https: wayFor('HTTPS') }
}

/** An item of no_proxy or of macOS's exception list, any of them with a :port to hold for that port only */
type Rule = (
  | { kind: 'all' }
  | { kind: 'net'; list: BlockList }
  | { kind: 'name'; suffix: string }
  | { kind: 'glob'; parts: string[] }
) & { port: number | null }

/** The items that can be read, blanks trimmed and case ignored; an empty one is no item */
function rules(items: readonly string[]): Rule[] {
  return items.map((item) => ruleOf(item)).filter((rule) => rule !== null)
}

/** `*`, everything. An address or a network, matched against addresses only: `203.0.113.7`, `203.0.113.0/24`,
 *  `2001:db8::/32`, `[::1]`, and macOS's short forms `169.254/16` and `10.1`. A name, which takes in the
 *  names below it however it is written: `example.com`, `.example.com`, `*.example.com`. A name with a *
 *  anywhere else, matched whole, the * spanning dots. Null for what is none of these */
function ruleOf(item: string): Rule | null {
  let host = item.trim().toLowerCase()
  let port: number | null = null
  // A port follows the ']' of an IPv6 address, or else the one colon there is: an IPv6 address has several
  const withPort = /^(\[.*\]|[^:]*):(\d+)$/.exec(host)
  if (withPort !== null) {
    host = withPort[1]!
    port = Number(withPort[2])
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (host === '') return null
  if (host === '*') return { kind: 'all', port }

  const [address = '', bits, ...more] = host.split('/')
  const v4 = /^\d+(\.\d+){0,3}$/.test(address)
  if (v4 || isIPv6(address)) {
    // macOS's short form leaves out the parts that are 0, and with no mask the parts it gives are the mask,
    // 8 bits each: 10.1 is 10.1.0.0/16
    const parts = address.split('.')
    const base = v4 ? [...parts, '0', '0', '0'].slice(0, 4).join('.') : address
    const prefix = bits ?? String(v4 ? parts.length * 8 : 128)
    if (more.length > 0 || !/^\d+$/.test(prefix)) return null
    const list = new BlockList()
    try {
      list.addSubnet(base, Number(prefix), v4 ? 'ipv4' : 'ipv6')
    } catch {
      return null // a part over 255, a mask longer than the address
    }
    return { kind: 'net', list, port }
  }
  if (bits !== undefined) return null // a / in what is not an address
  const suffix = host.replace(/^\*?\./, '')
  if (!suffix.includes('*')) return { kind: 'name', suffix, port }
  return { kind: 'glob', parts: host.split('*'), port }
}

/** Whether any of the rules takes in this host on this port */
function matches(rules: readonly Rule[], host: string, port: number): boolean {
  return rules.some((rule) => {
    if (rule.port !== null && rule.port !== port) return false
    switch (rule.kind) {
      case 'all':
        return true
      case 'net':
        return isAddressIn(rule.list, host)
      case 'name':
        return host === rule.suffix || host.endsWith(`.${rule.suffix}`)
      case 'glob':
        return globMatches(rule.parts, host)
    }
  })
}

/** Whether name is the parts in order with anything at all between them, dots included. With * the only
 *  wildcard, taking each part at its first place after the one before is enough, and takes time in
 *  proportion; a regular expression with a .* for each * backtracks, and slowly once there are a few
 *  (glob.ts tells how slowly), on a host name a device chose. glob.ts's matchGlob takes a * the same
 *  way without backtracking, but it reads ? and [...] as wildcards too, where in an item of these lists
 *  they are characters of the name: * is the only wildcard there */
function globMatches(parts: readonly string[], name: string): boolean {
  const first = parts[0] ?? ''
  const last = parts.length > 1 ? (parts[parts.length - 1] ?? '') : ''
  if (name.length < first.length + last.length) return false
  if (!name.startsWith(first) || !name.endsWith(last)) return false
  const end = name.length - last.length
  let at = first.length
  for (const part of parts.slice(1, -1)) {
    const found = name.indexOf(part, at)
    if (found === -1 || found + part.length > end) return false
    at = found + part.length
  }
  return true
}

/** A way out and what to say about it, as describe() writes them */
function spelled({ way, why }: { way: string; why: string | null }): string {
  return why === null ? way : `${way} (${why})`
}
