/**
 * The log, and the filters over it.
 *
 * Filtering happens here rather than in the table so that the page, the empty
 * state and the counts all read the same numbers, and so the table stays a
 * component that renders rows it is handed.
 *
 * One filter cannot be answered here at all. A row holds no bodies, so
 * "Search bodies" is a question only the server can answer: it runs the search
 * over the stored exchanges and this hook shows what comes back in place of the
 * rows it has.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Summary } from '../../api/types'
import { usePanelState } from '../../state/panel-state'
import { useToasts } from '../notifications/use-toasts'

export interface TrafficFilters {
  q: string
  searchBodies: boolean
  host: string
  method: string
  statusBand: string
  unmatchedOnly: boolean
  encryptedOnly: boolean
}

export const NO_FILTERS: TrafficFilters = {
  q: '', searchBodies: false, host: '', method: '', statusBand: '',
  unmatchedOnly: false, encryptedOnly: false,
}

/** How long the typing has to stop before the server is asked. */
const DEBOUNCE_MS = 300

/**
 * The two filters the server has no parameter for: `GET /requests` takes `key`,
 * `host`, `since`, `last`, `unmatched`, `encrypted`, `q` and `q_body`, and
 * neither a method nor a status class. So these two are applied here, to
 * whichever rows are on show — the log, or a body search's answer.
 */
function narrows(call: Summary, f: TrafficFilters): boolean {
  if (f.method && call.method !== f.method) return false
  if (f.statusBand && String(call.status ?? '').charAt(0) !== f.statusBand) return false
  return true
}

function matches(call: Summary, f: TrafficFilters): boolean {
  if (!narrows(call, f)) return false
  if (f.host && call.host !== f.host) return false
  if (f.unmatchedOnly && !call.unmatched) return false
  if (f.encryptedOnly && !call.encrypted) return false
  if (!f.q) return true
  const needle = f.q.toLowerCase()
  return (
    call.host.toLowerCase().includes(needle) ||
    call.url.toLowerCase().includes(needle) ||
    String(call.status ?? '').includes(needle) ||
    (call.matched_by ?? '').toLowerCase().includes(needle)
  )
}

export function useTraffic(initial: Partial<TrafficFilters> = {}) {
  const { api, calls: log, refresh } = usePanelState()
  const { notify, failed } = useToasts()
  const [filters, setFilters] = useState<TrafficFilters>({ ...NO_FILTERS, ...initial })
  const [frozen, setFrozen] = useState<Summary[] | null>(null)

  /**
   * A body search's answer, kept here rather than in `panel-state.calls`.
   * `calls` is the live log the event stream appends to; this is a snapshot the
   * server assembled for one question. Putting the answer there would drop the
   * rows it does not contain and let later arrivals dribble into it.
   */
  const [found, setFound] = useState<Summary[] | null>(null)

  /**
   * The term once the typing has stopped. Filtering rows already in the browser
   * can happen on every keystroke; asking the server cannot — that would be a
   * request per letter.
   */
  const [term, setTerm] = useState(filters.q)
  useEffect(() => {
    const timer = setTimeout(() => setTerm(filters.q), DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [filters.q])

  /**
   * A search is out and has not come back. Real state rather than
   * `searching && found === null`, because that is also true of a search that
   * failed — and the page would then wait for an answer that is never coming.
   */
  const [pending, setPending] = useState(false)

  const searching = filters.searchBodies && term.trim() !== ''
  useEffect(() => {
    if (!searching) {
      setFound(null)
      setPending(false)
      return
    }
    let ignore = false
    setPending(true)
    api
      .requests({
        q: term,
        q_body: true,
        // The filters the endpoint does understand go with the term, so the
        // server narrows what it reads rather than sending rows to be thrown
        // away. `narrows()` above says what is left for this side.
        host: filters.host || undefined,
        unmatched: filters.unmatchedOnly,
        encrypted: filters.encryptedOnly,
      })
      .then((rows) => {
        if (ignore) return
        setFound(rows)
        setPending(false)
      })
      .catch((error) => {
        if (ignore) return
        // Back to the rows in hand: a failed search must not leave the previous
        // answer on screen as though it were this one's.
        setFound(null)
        setPending(false)
        failed('Could not search the bodies', error)
      })
    // A slow answer to an older term must not land on top of a newer one.
    return () => {
      ignore = true
    }
  }, [api, failed, searching, term, filters.host, filters.unmatchedOnly, filters.encryptedOnly])

  /**
   * Pause freezes this view, not the run: panel-state keeps collecting, so the
   * sidebar's unmatched count, a rule's hits and the devices on Connect stay
   * true about what is happening. This page goes on showing the log as it was
   * when Pause was pressed — the whole point of pausing is that nothing moves —
   * and Resume drops the snapshot, so everything that arrived is there.
   */
  const calls = frozen ?? log
  const togglePause = useCallback(() => setFrozen((f) => (f ? null : log)), [log])

  const setFilter = useCallback(
    <K extends keyof TrafficFilters>(key: K, value: TrafficFilters[K]) =>
      setFilters((f) => ({ ...f, [key]: value })),
    []
  )

  const clearFilters = useCallback(() => setFilters(NO_FILTERS), [])

  const hosts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const call of calls) counts.set(call.host, (counts.get(call.host) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [calls])

  const rows = useMemo(
    () =>
      found ? found.filter((c) => narrows(c, filters)) : calls.filter((c) => matches(c, filters)),
    [found, calls, filters]
  )

  const clearLog = useCallback(async () => {
    try {
      await api.clearRequests()
      await refresh({ calls: true })
      // A snapshot of rows the server no longer has would be a lie, so clearing
      // the log resumes, and drops a body search's answer for the same reason.
      setFrozen(null)
      setFound(null)
      notify({ tone: 'success', title: 'Log cleared' })
    } catch (e) {
      failed('Could not clear the log', e)
    }
  }, [api, refresh, notify, failed])

  return {
    calls,
    rows,
    hosts,
    filters,
    setFilter,
    clearFilters,
    filtering: JSON.stringify(filters) !== JSON.stringify(NO_FILTERS),
    unmatchedCount: calls.filter((c) => c.unmatched).length,
    encryptedCount: calls.filter((c) => c.encrypted).length,
    paused: frozen !== null,
    /**
     * True while the rows are the server's answer to a body search rather than
     * the log. The page reads it to stop following: there is nothing to follow.
     */
    bodySearch: found !== null,
    /**
     * A body search is out and has not answered yet. The rows on show are the
     * local ones, which for a word that appears only in a body match nothing —
     * so the page waits rather than saying "no call matches these filters" about
     * a question it has not had the answer to.
     */
    searchPending: pending,
    togglePause,
    clearLog,
  }
}
