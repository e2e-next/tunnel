// src/upstream-route.ts: which way a request for the real server leaves tunnel, straight there or through an
// HTTP proxy. Every UpstreamRoutes here reads only the RouteSources the test gives it: no socket, no
// process, and neither the developer's environment variables nor this Mac's proxy settings.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  parseScutilProxy,
  type DirectReason,
  type Route,
  type RouteSources,
  type RouteTarget,
  type UpstreamRoutes,
} from '../src/upstream-route.ts'
import { captureLogs } from './support/logs.ts'
import { SCUTIL_PROXY_OFF, SCUTIL_PROXY_ON, testRoutes } from './support/routes.ts'

const https = (host: string, port = 443): RouteTarget => ({ scheme: 'https', host, port })
const http = (host: string, port = 80): RouteTarget => ({ scheme: 'http', host, port })
const direct = (reason: DirectReason): Route => ({ kind: 'direct', reason })
const viaSystem = (host: string, port: number): Route => ({
  kind: 'proxy',
  proxy: { host, port, authorization: null, source: 'system proxy', label: `${host}:${port}` },
})
const viaVariable = (
  source: string,
  host: string,
  port: number,
  authorization: string | null = null,
): Route => ({
  kind: 'proxy',
  proxy: { host, port, authorization, source, label: `http://${host}:${port}` },
})

/** macOS with this `scutil --proxy` output: the routes, and how many times the output has been read */
function mac(
  text: string,
  sources?: Partial<RouteSources>,
): { routes: UpstreamRoutes; reads: () => number } {
  let reads = 0
  const routes = testRoutes({
    platform: 'darwin',
    readSystemProxy: async () => {
      reads += 1
      return text
    },
    ...sources,
  })
  return { routes, reads: () => reads }
}

/** `scutil --proxy` with the Web proxy and the secure Web proxy both at host:port, and these exceptions */
function systemProxyAt(host: string, port: number, exceptions: string[] = []): string {
  const list = exceptions.map((item, index) => `    ${index} : ${item}`)
  return [
    '<dictionary> {',
    ...(list.length === 0 ? [] : ['  ExceptionsList : <array> {', ...list, '  }']),
    '  HTTPEnable : 1',
    `  HTTPPort : ${port}`,
    `  HTTPProxy : ${host}`,
    '  HTTPSEnable : 1',
    `  HTTPSPort : ${port}`,
    `  HTTPSProxy : ${host}`,
    '}',
    '',
  ].join('\n')
}

test('the proxy variables are read lower-case first, one for each scheme, all_proxy behind both', async () => {
  // Both spellings set: the lower-case one wins, as in curl
  const both = testRoutes({
    env: { https_proxy: 'http://lower.test:1', HTTPS_PROXY: 'http://upper.test:2' },
  })
  assert.deepEqual(
    await both.route(https('example.com')),
    viaVariable('https_proxy', 'lower.test', 1),
  )

  // A lower-case one set to nothing switches the item off: the upper-case one is not looked at any more,
  // all_proxy still is
  const off = testRoutes({ env: { https_proxy: '', HTTPS_PROXY: 'http://upper.test:2' } })
  assert.deepEqual(await off.route(https('example.com')), direct('no proxy'))
  const offButAll = testRoutes({
    env: { https_proxy: '', HTTPS_PROXY: 'http://upper.test:2', ALL_PROXY: 'http://all.test:3' },
  })
  assert.deepEqual(
    await offButAll.route(https('example.com')),
    viaVariable('ALL_PROXY', 'all.test', 3),
  )

  // https targets take https_proxy and http targets http_proxy, each with all_proxy behind it
  const perScheme = testRoutes({
    env: { HTTPS_PROXY: 'http://secure.test:1', HTTP_PROXY: 'http://plain.test:2' },
  })
  assert.deepEqual(
    await perScheme.route(https('example.com')),
    viaVariable('HTTPS_PROXY', 'secure.test', 1),
  )
  assert.deepEqual(
    await perScheme.route(http('example.com')),
    viaVariable('HTTP_PROXY', 'plain.test', 2),
  )
  const fallback = testRoutes({
    env: { HTTP_PROXY: 'http://plain.test:2', all_proxy: 'http://all.test:3' },
  })
  assert.deepEqual(
    await fallback.route(https('example.com')),
    viaVariable('all_proxy', 'all.test', 3),
  )
  assert.deepEqual(
    await fallback.route(http('example.com')),
    viaVariable('HTTP_PROXY', 'plain.test', 2),
  )

  // No scheme means http://. URL.canParse would take localhost:3128 for a URL whose scheme is
  // localhost:, so that one is here too; the blanks around a value do not count
  const bare = testRoutes({
    env: { HTTPS_PROXY: '127.0.0.1:3128', HTTP_PROXY: ' localhost:3128 ' },
  })
  assert.deepEqual(
    await bare.route(https('example.com')),
    viaVariable('HTTPS_PROXY', '127.0.0.1', 3128),
  )
  assert.deepEqual(
    await bare.route(http('example.com')),
    viaVariable('HTTP_PROXY', 'localhost', 3128),
  )

  // No port means 80
  const port80 = testRoutes({ env: { HTTP_PROXY: 'http://proxy.test' } })
  assert.deepEqual(
    await port80.route(http('example.com')),
    viaVariable('HTTP_PROXY', 'proxy.test', 80),
  )

  // Credentials are percent-decoded into the Proxy-Authorization (us@er:p:ss) and kept out of the label
  const credentials = testRoutes({ env: { HTTPS_PROXY: 'http://us%40er:p%3Ass@proxy.test:3128' } })
  assert.deepEqual(
    await credentials.route(https('example.com')),
    viaVariable('HTTPS_PROXY', 'proxy.test', 3128, 'Basic dXNAZXI6cDpzcw=='),
  )
})

test('a proxy URL tunnel cannot use is ignored, and describe() says so without its credentials', async () => {
  const unusable = [
    'socks5://127.0.0.1:7890',
    'socks5h://127.0.0.1:7890',
    'socks://127.0.0.1:1080',
    'https://127.0.0.1:3128',
    '::nonsense',
  ]
  for (const value of unusable) {
    const routes = testRoutes({ env: { ALL_PROXY: value } })
    assert.deepEqual(await routes.route(https('example.com')), direct('ignored'), value)
    assert.deepEqual(await routes.route(http('example.com')), direct('ignored'), value)
    assert.equal(
      await routes.describe(),
      `direct (ALL_PROXY=${value} ignored: only http:// proxies are supported)`,
    )
  }

  const withSecret = testRoutes({ env: { HTTPS_PROXY: 'socks5://user:secret@127.0.0.1:7890' } })
  assert.deepEqual(await withSecret.route(https('example.com')), direct('ignored'))
  assert.equal(
    await withSecret.describe(),
    'direct (HTTPS_PROXY=socks5://127.0.0.1:7890 ignored: only http:// proxies are supported)',
  )
})

test("on macOS, with no proxy in the environment, the system's Web and secure Web proxies are used", async () => {
  const { routes, reads } = mac(SCUTIL_PROXY_ON)
  assert.deepEqual(await routes.route(https('example.net')), viaSystem('127.0.0.1', 3128))
  assert.deepEqual(await routes.route(http('example.net')), viaSystem('127.0.0.1', 3128))
  assert.equal(reads(), 1)

  // An IPv6 proxy: the host bare, the label in brackets
  const v6 = mac(systemProxyAt('::1', 3128))
  assert.deepEqual(await v6.routes.route(https('example.net')), {
    kind: 'proxy',
    proxy: {
      host: '::1',
      port: 3128,
      authorization: null,
      source: 'system proxy',
      label: '[::1]:3128',
    },
  })

  // A proxy that is switched off is not there, whatever host it still names
  const httpOff = mac(SCUTIL_PROXY_ON.replace('HTTPEnable : 1', 'HTTPEnable : 0'))
  assert.deepEqual(await httpOff.routes.route(http('example.net')), direct('no proxy'))
  assert.deepEqual(await httpOff.routes.route(https('example.net')), viaSystem('127.0.0.1', 3128))

  // A proxy in the environment, or another platform: the system's settings are never read. The environment
  // is the whole answer, so a scheme it names no proxy for goes straight there
  const env = mac(SCUTIL_PROXY_ON, { env: { HTTPS_PROXY: 'http://env.test:8080' } })
  assert.deepEqual(
    await env.routes.route(https('example.net')),
    viaVariable('HTTPS_PROXY', 'env.test', 8080),
  )
  assert.deepEqual(await env.routes.route(http('example.net')), direct('no proxy'))
  assert.equal(env.reads(), 0)
  const linux = mac(SCUTIL_PROXY_ON, { platform: 'linux' })
  assert.deepEqual(await linux.routes.route(https('example.net')), direct('no proxy'))
  assert.equal(linux.reads(), 0)
})

test('parseScutilProxy reads the top level only, cutting each line at its first " : "', () => {
  assert.deepEqual(parseScutilProxy(SCUTIL_PROXY_OFF), { HTTPEnable: '0', HTTPSEnable: '0' })
  // The list keeps its empty item; nothing of __SCOPED__ shows, neither its keys nor its values for the
  // keys the top level has too
  assert.deepEqual(parseScutilProxy(SCUTIL_PROXY_ON), {
    ExceptionsList: [
      '127.0.0.1',
      'localhost',
      '*.local',
      '169.254/16',
      '',
      '*.example.com',
      'example.org',
    ],
    ExcludeSimpleHostnames: '1',
    FTPPassive: '1',
    HTTPEnable: '1',
    HTTPPort: '3128',
    HTTPProxy: '127.0.0.1',
    HTTPSEnable: '1',
    HTTPSPort: '3128',
    HTTPSProxy: '127.0.0.1',
    ProxyAutoConfigEnable: '0',
    SOCKSEnable: '1',
    SOCKSPort: '1081',
    SOCKSProxy: '127.0.0.1',
  })
  // A value may hold colons, ' : ' among them; a line it cannot read is passed over
  const text = [
    '<dictionary> {',
    '  HTTPSProxy : ::1',
    '  ProxyAutoConfigURLString : http://pac.test/a : b',
    '  not a key and a value',
    '}',
    '',
  ].join('\n')
  assert.deepEqual(parseScutilProxy(text), {
    HTTPSProxy: '::1',
    ProxyAutoConfigURLString: 'http://pac.test/a : b',
  })
})

test('a local target goes straight there without reading any setting', async () => {
  const { routes, reads } = mac(systemProxyAt('127.0.0.1', 3128))
  const local = [
    ...['127.0.0.1', '127.9.9.9', '::1', '[::1]', '::ffff:127.0.0.1', '0.0.0.0'],
    ...['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.5', '169.254.1.1'],
    ...['fe80::1%en0', 'fd12::1', 'localhost', 'a.localhost', 'printer.local', 'Printer.Local.'],
  ]
  for (const host of local) {
    assert.deepEqual(await routes.route(https(host)), direct('local'), host)
    assert.deepEqual(await routes.route(http(host)), direct('local'), host)
  }
  assert.equal(reads(), 0)
  for (const host of ['172.32.0.1', '100.64.0.1', '8.8.8.8', 'example.com']) {
    assert.deepEqual(await routes.route(https(host)), viaSystem('127.0.0.1', 3128), host)
  }
  assert.equal(reads(), 1)
})

test('no_proxy sends what it names straight there, and with a * in it everything', async () => {
  // * alone or anywhere in the list: everything, and macOS's settings are not even read. describe() names
  // the variable as it is spelled, as it does everywhere
  const everything = [
    ['NO_PROXY', '*'],
    ['NO_PROXY', 'example.com, *'],
    ['no_proxy', '*'],
  ]
  for (const [name = '', value] of everything) {
    const { routes, reads } = mac(SCUTIL_PROXY_ON, { env: { [name]: value } })
    assert.deepEqual(await routes.route(https('example.net')), direct('bypassed'), value)
    assert.deepEqual(await routes.route(http('example.net')), direct('bypassed'), value)
    assert.equal(await routes.describe(), `direct (${name}=*)`)
    assert.equal(reads(), 0)
  }

  const via = viaVariable('HTTPS_PROXY', 'proxy.test', 3128)
  const routesWith = (noProxy: string) =>
    testRoutes({ env: { HTTPS_PROXY: 'http://proxy.test:3128', NO_PROXY: noProxy } })

  // Three ways to write a name, all of them taking in the names below it; no case anywhere
  for (const item of ['example.com', '.example.com', '*.example.com', 'EXAMPLE.COM']) {
    const routes = routesWith(item)
    assert.deepEqual(await routes.route(https('example.com')), direct('bypassed'), item)
    assert.deepEqual(await routes.route(https('www.Example.com')), direct('bypassed'), item)
    assert.deepEqual(await routes.route(https('wwwexample.com')), via, item)
  }

  // A port: that one only, against the port the caller filled in from the scheme
  const port = routesWith('example.com:8443')
  assert.deepEqual(await port.route(https('example.com', 8443)), direct('bypassed'))
  assert.deepEqual(await port.route(https('example.com')), via)

  // Addresses and networks, compared with addresses as written
  const address = routesWith('203.0.113.7')
  assert.deepEqual(await address.route(https('203.0.113.7')), direct('bypassed'))
  assert.deepEqual(await address.route(https('203.0.113.8')), via)
  const network = routesWith('203.0.113.0/24')
  assert.deepEqual(await network.route(https('203.0.113.99')), direct('bypassed'))
  assert.deepEqual(await network.route(https('203.0.114.1')), via)
  const v6 = routesWith('2001:db8::/32')
  assert.deepEqual(await v6.route(https('2001:db8::1')), direct('bypassed'))
  assert.deepEqual(await v6.route(https('[2001:db8::1]')), direct('bypassed'))
  assert.deepEqual(await v6.route(https('2001:db9::1')), via)

  // Empty items and blanks are no items: they leave everything else to the proxy
  assert.deepEqual(await routesWith(' , ,a.test,').route(https('example.com')), via)

  // It holds for the system's proxy too, which an environment with nothing but NO_PROXY still reads
  const { routes, reads } = mac(systemProxyAt('127.0.0.1', 3128), {
    env: { NO_PROXY: 'example.com' },
  })
  assert.deepEqual(await routes.route(https('www.example.com')), direct('bypassed'))
  assert.deepEqual(await routes.route(https('example.net')), viaSystem('127.0.0.1', 3128))
  assert.equal(reads(), 1)
})

test("macOS's exception list and simple host names bypass the system's proxy, not one from a variable", async () => {
  // *.example.com, example.org, an empty item, and ExcludeSimpleHostnames : 1
  const { routes } = mac(SCUTIL_PROXY_ON)
  for (const host of [
    'example.com',
    'www.example.com',
    'example.org',
    'www.example.org',
    'intranet',
  ]) {
    assert.deepEqual(await routes.route(https(host)), direct('bypassed'), host)
  }
  for (const host of ['wwwexample.com', 'example.net', 'intranet.corp']) {
    assert.deepEqual(await routes.route(https(host)), viaSystem('127.0.0.1', 3128), host)
  }

  // An address, a network the way macOS shortens it, an empty item; without ExcludeSimpleHostnames a simple
  // name goes through the proxy like any other
  const short = mac(systemProxyAt('127.0.0.1', 3128, ['203.0.113.7', '198.51/16', '']))
  for (const host of ['203.0.113.7', '198.51.100.7', '198.51.0.1']) {
    assert.deepEqual(await short.routes.route(https(host)), direct('bypassed'), host)
  }
  for (const host of ['203.0.113.8', '198.52.0.1', 'intranet', 'example.com']) {
    assert.deepEqual(await short.routes.route(https(host)), viaSystem('127.0.0.1', 3128), host)
  }

  // A proxy from a variable: the exception list is not its list
  const env = mac(SCUTIL_PROXY_ON, { env: { HTTPS_PROXY: 'http://env.test:8080' } })
  const viaEnv = viaVariable('HTTPS_PROXY', 'env.test', 8080)
  assert.deepEqual(await env.routes.route(https('www.example.com')), viaEnv)
  assert.deepEqual(await env.routes.route(https('intranet')), viaEnv)
})

test("a proxy that is tunnel's own proxy port counts as none", async () => {
  const localAddresses = () => ['192.168.1.5', 'fe80::1']

  // Until ProxyServer says which port it listens on, nothing is taken for tunnel itself; once it has, the
  // next route() knows without a new reading
  const before = mac(systemProxyAt('127.0.0.1', 8890), { localAddresses })
  assert.deepEqual(await before.routes.route(https('example.net')), viaSystem('127.0.0.1', 8890))
  assert.equal(await before.routes.describe(), 'via 127.0.0.1:8890 (system proxy)')
  before.routes.ownProxyPort = 8890
  assert.deepEqual(await before.routes.route(https('example.net')), direct('tunnel itself'))
  assert.equal(before.reads(), 1)

  // The loopback by address or by name, every address and an address of this machine, on that port
  for (const host of ['127.0.0.1', 'localhost', '::1', '0.0.0.0', '192.168.1.5']) {
    const { routes } = mac(systemProxyAt(host, 8890), { localAddresses })
    routes.ownProxyPort = 8890
    assert.deepEqual(await routes.route(https('example.net')), direct('tunnel itself'), host)
    assert.deepEqual(await routes.route(http('example.net')), direct('tunnel itself'), host)
    assert.equal(await routes.describe(), 'direct (system proxy points at tunnel itself, ignored)')
  }

  // Another port of this machine, or that port of another machine, is a proxy like any other; so is
  // that port under a name, even one that is this Mac's own: a name is not looked up
  const others: [string, number][] = [
    ['192.168.1.5', 8891],
    ['10.0.0.9', 8890],
    ['my-mac.local', 8890],
  ]
  for (const [host, port] of others) {
    const { routes } = mac(systemProxyAt(host, port), { localAddresses })
    routes.ownProxyPort = 8890
    assert.deepEqual(await routes.route(https('example.net')), viaSystem(host, port), host)
  }

  // From a variable, describe() names the variable
  const variable = testRoutes({ env: { HTTPS_PROXY: 'http://127.0.0.1:8890' } })
  variable.ownProxyPort = 8890
  assert.deepEqual(await variable.route(https('example.net')), direct('tunnel itself'))
  assert.equal(await variable.describe(), 'direct (HTTPS_PROXY points at tunnel itself, ignored)')
})

test('one reading serves for five seconds, callers that come during a reading share it, and a new route is logged', async (t) => {
  const logs = captureLogs(t)
  let clock = 0
  let reads = 0
  let text = SCUTIL_PROXY_ON
  const routes = testRoutes({
    platform: 'darwin',
    now: () => clock,
    readSystemProxy: async () => {
      reads += 1
      return text
    },
  })
  assert.deepEqual(await routes.route(https('example.net')), viaSystem('127.0.0.1', 3128))
  clock += 4999
  assert.deepEqual(await routes.route(https('example.net')), viaSystem('127.0.0.1', 3128))
  assert.equal(await routes.describe(), 'via 127.0.0.1:3128 (system proxy)')
  assert.equal(reads, 1)
  clock += 2
  assert.deepEqual(await routes.route(https('example.net')), viaSystem('127.0.0.1', 3128))
  assert.equal(reads, 2)

  // The proxy switched off: the reading that holds still says it is on, the next one sees it off
  text = SCUTIL_PROXY_OFF
  assert.deepEqual(await routes.route(https('example.net')), viaSystem('127.0.0.1', 3128))
  clock += 5000
  assert.deepEqual(await routes.route(https('example.net')), direct('no proxy'))
  assert.equal(await routes.describe(), 'direct')
  assert.equal(reads, 3)

  // Logged when first read and whenever it has changed, not at every reading
  const logged = logs.records.filter((record) => record.logger === 'tunnel.upstream')
  assert.deepEqual(
    logged.map(({ level, message }) => [level, message]),
    [
      ['info', 'Upstream route: via 127.0.0.1:3128 (system proxy)'],
      ['info', 'Upstream route: direct'],
    ],
  )

  // Three callers while one reading is under way: all three wait for it
  let release: (text: string) => void = () => {}
  let slowReads = 0
  const slow = testRoutes({
    platform: 'darwin',
    readSystemProxy: () => {
      slowReads += 1
      return new Promise<string>((resolve) => {
        release = resolve
      })
    },
  })
  const waiting = [1, 2, 3].map(() => slow.route(https('example.net')))
  release(SCUTIL_PROXY_ON)
  const answers = await Promise.all(waiting)
  assert.equal(slowReads, 1)
  for (const answer of answers) assert.deepEqual(answer, viaSystem('127.0.0.1', 3128))
})

test('a reading that fails keeps the last one that worked: a system proxy never read goes direct and says why, addresses never read are none', async (t) => {
  const logs = captureLogs(t)
  const warnings = () =>
    logs.records
      .filter((record) => record.logger === 'tunnel.upstream' && record.level === 'warning')
      .map((record) => record.message)

  // Never read: straight there, describe() says why, and one warning says it too
  const never = testRoutes({
    platform: 'darwin',
    readSystemProxy: () => Promise.reject(new Error('scutil went missing')),
  })
  assert.deepEqual(await never.route(https('example.net')), direct('no proxy'))
  assert.equal(
    await never.describe(),
    'direct (could not read the system proxy: scutil went missing)',
  )
  assert.deepEqual(warnings(), ['Could not read the system proxy: scutil went missing'])

  // execFile's message for a failed command ends in a line of stderr, maybe empty: the route is one line
  const failed = testRoutes({
    platform: 'darwin',
    readSystemProxy: () =>
      Promise.reject(new Error('Command failed: /usr/sbin/scutil --proxy\nsome\nstderr\n')),
  })
  assert.equal(
    await failed.describe(),
    'direct (could not read the system proxy: Command failed: /usr/sbin/scutil --proxy some stderr)',
  )

  // Read once: a reading that fails after that keeps the one before, and the same failure is warned about
  // once, however often it comes back
  let clock = 0
  let reads = 0
  const once = testRoutes({
    platform: 'darwin',
    now: () => clock,
    readSystemProxy: async () => {
      reads += 1
      if (reads > 1) throw new Error('scutil timed out')
      return SCUTIL_PROXY_ON
    },
  })
  assert.deepEqual(await once.route(https('example.net')), viaSystem('127.0.0.1', 3128))
  for (let failures = 0; failures < 3; failures += 1) {
    clock += 5000
    assert.deepEqual(await once.route(https('example.net')), viaSystem('127.0.0.1', 3128))
  }
  assert.equal(reads, 4)
  assert.equal(await once.describe(), 'via 127.0.0.1:3128 (system proxy)')
  assert.deepEqual(warnings(), [
    'Could not read the system proxy: scutil went missing',
    'Could not read the system proxy: Command failed: /usr/sbin/scutil --proxy some stderr',
    'Could not read the system proxy: scutil timed out',
  ])

  // This machine's addresses the same way, since os.networkInterfaces() throws when libuv cannot list
  // them: route() and describe() still answer. A list read once is kept, so the proxy at this machine's
  // address is still tunnel itself
  let listed = 0
  const kept = testRoutes({
    env: { HTTPS_PROXY: 'http://192.168.1.5:8890' },
    now: () => clock,
    localAddresses: () => {
      listed += 1
      if (listed > 1) throw new Error('uv_interface_addresses returned Unknown system error 24')
      return ['192.168.1.5']
    },
  })
  kept.ownProxyPort = 8890
  assert.deepEqual(await kept.route(https('example.net')), direct('tunnel itself'))
  for (let failures = 0; failures < 2; failures += 1) {
    clock += 5000
    assert.deepEqual(await kept.route(https('example.net')), direct('tunnel itself'))
  }
  assert.equal(listed, 3)
  assert.equal(await kept.describe(), 'direct (HTTPS_PROXY points at tunnel itself, ignored)')

  // Never read: no address is known to be this machine's but the loopback and 0.0.0.0, ::
  const unlisted = testRoutes({
    env: { HTTPS_PROXY: 'http://192.168.1.5:8890', HTTP_PROXY: 'http://127.0.0.1:8890' },
    localAddresses: () => {
      throw new Error('uv_interface_addresses returned Unknown system error 13')
    },
  })
  unlisted.ownProxyPort = 8890
  assert.deepEqual(
    await unlisted.route(https('example.net')),
    viaVariable('HTTPS_PROXY', '192.168.1.5', 8890),
  )
  assert.deepEqual(await unlisted.route(http('example.net')), direct('tunnel itself'))
  assert.equal(
    await unlisted.describe(),
    'direct (HTTP_PROXY points at tunnel itself, ignored) for http; via http://192.168.1.5:8890 (HTTPS_PROXY) for https',
  )
  assert.deepEqual(warnings(), [
    'Could not read the system proxy: scutil went missing',
    'Could not read the system proxy: Command failed: /usr/sbin/scutil --proxy some stderr',
    'Could not read the system proxy: scutil timed out',
    "Could not read this machine's addresses: uv_interface_addresses returned Unknown system error 24",
    "Could not read this machine's addresses: uv_interface_addresses returned Unknown system error 13",
  ])
})

test('describe() gives one way out when both schemes take it, and one for each when they do not', async () => {
  assert.equal(await mac(SCUTIL_PROXY_ON).routes.describe(), 'via 127.0.0.1:3128 (system proxy)')
  assert.equal(
    await testRoutes({ env: { http_proxy: 'http://a:3128' } }).describe(),
    'via http://a:3128 (http_proxy) for http; direct for https',
  )
  assert.equal(await testRoutes().describe(), 'direct')
  // The same proxy from two variables is still one way out, and both are named
  assert.equal(
    await testRoutes({
      env: { http_proxy: 'http://a:3128', https_proxy: 'http://a:3128' },
    }).describe(),
    'via http://a:3128 (http_proxy; https_proxy)',
  )

  // Only SOCKS, or a PAC file
  const socks = SCUTIL_PROXY_ON.replace('HTTPEnable : 1', 'HTTPEnable : 0').replace(
    'HTTPSEnable : 1',
    'HTTPSEnable : 0',
  )
  assert.equal(
    await mac(socks).routes.describe(),
    'direct (the system SOCKS proxy is not supported)',
  )
  const pac = [
    '<dictionary> {',
    '  HTTPEnable : 0',
    '  HTTPSEnable : 0',
    '  ProxyAutoConfigEnable : 1',
    '  ProxyAutoConfigURLString : http://wpad.test/proxy.pac',
    '}',
    '',
  ].join('\n')
  assert.equal(
    await mac(pac).routes.describe(),
    'direct (the system proxy uses a PAC file, which tunnel does not read)',
  )
})
