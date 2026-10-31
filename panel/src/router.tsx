/**
 * A hash router, because the panel is one page served at / and every
 * route has to survive a reload and the back button without a server round trip.
 *
 * Routes: #/traffic · #/traffic/40 · #/rules · #/rules/new · #/rules/<key>
 *         #/recordings · #/recordings/<session> · #/connect · #/settings
 */
import { useEffect, useState } from 'react'

export interface Route {
  page: 'traffic' | 'rules' | 'recordings' | 'connect' | settings_
  param: string | null
  query: URLSearchParams
}
type settings_ = 'settings'

function parse(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '')
  const [path, search] = raw.split('?')
  const [page, ...rest] = path.split('/')
  const known = ['traffic', 'rules', 'recordings', 'connect', 'settings'] as const
  const name = (known as readonly string[]).includes(page) ? (page as Route['page']) : 'traffic'
  return {
    page: name,
    param: rest.length ? decodeURIComponent(rest.join('/')) : null,
    query: new URLSearchParams(search ?? ''),
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.hash))
  useEffect(() => {
    const onHash = () => setRoute(parse(location.hash))
    addEventListener('hashchange', onHash)
    return () => removeEventListener('hashchange', onHash)
  }, [])
  return route
}

export function go(to: string) {
  location.hash = to.startsWith('#') ? to : `#${to}`
}

/** A rule key goes in the fragment, so its slashes have to be escaped. */
export function ruleHref(key: string) {
  return `#/rules/${encodeURIComponent(key)}`
}
