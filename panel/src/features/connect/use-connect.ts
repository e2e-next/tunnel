/**
 * Connecting a device: the proxy addresses, the certificate, and which hosts
 * get decrypted. The three ticks are read out of the log, so the page reports
 * what actually happened rather than what was configured.
 */
import { useCallback, useMemo } from 'react'
import { usePanelState } from '../../state/panel-state'
import { useToasts } from '../notifications/use-toasts'

export function useConnect() {
  const { api, health, config, ca, calls, refresh } = usePanelState()
  const { notify, failed } = useToasts()
  const ssl = config.ssl_proxying

  const clients = useMemo(() => {
    const seen = new Map<string, { client: string; last_seen: string; calls: number; tunnels: number }>()
    for (const call of calls) {
      const row = seen.get(call.client) ?? { client: call.client, last_seen: call.time, calls: 0, tunnels: 0 }
      row.calls += 1
      if (call.kind === 'connect') row.tunnels += 1
      if (call.time > row.last_seen) row.last_seen = call.time
      seen.set(call.client, row)
    }
    return [...seen.values()].sort((a, b) => b.last_seen.localeCompare(a.last_seen))
  }, [calls])

  const encryptedHosts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const call of calls) {
      if (call.kind === 'connect') counts.set(call.host, (counts.get(call.host) ?? 0) + 1)
    }
    return [...counts.entries()].map(([host, tunnels]) => ({ host, tunnels }))
  }, [calls])

  const write = useCallback(
    async (next: typeof ssl, title: string) => {
      try {
        await api.patchConfig({ ssl_proxying: next })
        await refresh({ config: true })
        notify({ tone: 'success', title })
      } catch (e) {
        failed('Could not change SSL proxying', e)
      }
    },
    [api, refresh, notify, failed]
  )

  return {
    ssl,
    ca,
    proxy: health.proxy,
    clients,
    encryptedHosts,
    // Each step is true because the log says so, not because a box is ticked.
    steps: {
      pointed: clients.some((c) => c.client !== '127.0.0.1'),
      trusted: calls.some((c) => c.encrypted && c.kind === 'http'),
      chosen: ssl.enabled && ssl.include.length > 0,
    },
    setEnabled: (on: boolean) => write({ ...ssl, enabled: on }, on ? 'SSL proxying on' : 'SSL proxying off'),
    include: (host: string) => write({ ...ssl, include: [...ssl.include, host] }, `Decrypting ${host}`),
    unInclude: (host: string) => write({ ...ssl, include: ssl.include.filter((h) => h !== host) }, `No longer decrypting ${host}`),
    unExclude: (host: string) => write({ ...ssl, exclude: ssl.exclude.filter((h) => h !== host) }, `${host} removed`),
  }
}
