// testRoutes(): UpstreamRoutes that read only what a test hands them, never the developer's environment
// variables or macOS's proxy settings. Every test that
// builds a TunnelCore, or a nodeUpstream, that could reach route() or describe() gives it one of these.
import { UpstreamRoutes, type RouteSources } from '../../src/upstream-route.ts'

/** env {}, platform 'linux', readSystemProxy that rejects, no local addresses, the real clock — unless given */
export function testRoutes(
  sources?: Partial<RouteSources>,
  options?: { cacheMs?: number },
): UpstreamRoutes {
  return new UpstreamRoutes(
    {
      env: {},
      platform: 'linux',
      readSystemProxy: () => Promise.reject(new Error('no scutil in tests')),
      localAddresses: () => [],
      ...sources,
    },
    options,
  )
}

/** `scutil --proxy` with the Web proxy, the secure Web proxy and SOCKS on, an exception list and __SCOPED__.
 *  The layout is scutil's, the values made up:
 *  an item of the list may be empty, and __SCOPED__ repeats the keys for each network interface */
export const SCUTIL_PROXY_ON = [
  '<dictionary> {',
  '  ExceptionsList : <array> {',
  '    0 : 127.0.0.1',
  '    1 : localhost',
  '    2 : *.local',
  '    3 : 169.254/16',
  '    4 : ',
  '    5 : *.example.com',
  '    6 : example.org',
  '  }',
  '  ExcludeSimpleHostnames : 1',
  '  FTPPassive : 1',
  '  HTTPEnable : 1',
  '  HTTPPort : 3128',
  '  HTTPProxy : 127.0.0.1',
  '  HTTPSEnable : 1',
  '  HTTPSPort : 3128',
  '  HTTPSProxy : 127.0.0.1',
  '  ProxyAutoConfigEnable : 0',
  '  SOCKSEnable : 1',
  '  SOCKSPort : 1081',
  '  SOCKSProxy : 127.0.0.1',
  '  __SCOPED__ : <dictionary> {',
  '    en0 : <dictionary> {',
  '      ExceptionsList : <array> {',
  '        0 : 10.9.9.9',
  '      }',
  '      HTTPEnable : 0',
  '      HTTPProxy : 10.0.0.1',
  '      HTTPSEnable : 0',
  '    }',
  '  }',
  '}',
  '',
].join('\n')

/** `scutil --proxy` with nothing switched on (what this Mac printed on 2026-10-22) */
export const SCUTIL_PROXY_OFF = [
  '<dictionary> {',
  '  HTTPEnable : 0',
  '  HTTPSEnable : 0',
  '}',
  '',
].join('\n')
