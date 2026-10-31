/** Formatting the panel does over and over: bytes, milliseconds, clock time. */

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} kB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function ms(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  if (n < 1000) return `${Math.round(n)} ms`
  return `${(n / 1000).toFixed(2)} s`
}

/** "2026-09-25T12:06:02.123" → "12:06:02" — the panel only ever shows today. */
export function clock(iso: string): string {
  const t = iso.split('T')[1] ?? iso
  return t.slice(0, 8)
}

export function relative(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime()
  const secs = Math.max(0, Math.round((now - then) / 1000))
  if (secs < 60) return `${secs}s ago`
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`
  return `${Math.round(secs / 86400)}d ago`
}

/** The colour a status code gets, as a Catalyst Badge colour. */
export function statusColor(status: number | null): 'lime' | 'sky' | 'amber' | 'rose' | 'zinc' {
  if (status === null) return 'zinc'
  if (status < 300) return 'lime'
  if (status < 400) return 'sky'
  if (status < 500) return 'amber'
  return 'rose'
}

export const modeColor = {
  passthrough: 'zinc',
  json: 'blue',
  script: 'teal',
  replay: 'amber',
} as const

/** A rule key is "METHOD:[host[:port]]/path" — split it for display. */
export function splitKey(key: string): { method: string; host: string; path: string } {
  const colon = key.indexOf(':')
  const method = colon === -1 ? 'GET' : key.slice(0, colon)
  const rest = colon === -1 ? key : key.slice(colon + 1)
  const slash = rest.indexOf('/')
  if (slash === -1) return { method, host: rest, path: '/' }
  return { method, host: rest.slice(0, slash), path: rest.slice(slash) }
}
