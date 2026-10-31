/**
 * What the panel knows about the server, in one place, and the only caller of
 * the API client.
 *
 * Features do not read this directly: each has its own hook in
 * features/<name>/use-*.ts that takes the slice it needs and offers it in that
 * feature's own terms. That keeps a page from depending on state it never uses,
 * while the whole panel still holds one copy of the truth.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createHttpApi, type PanelApi } from '../api/client'
import type { CaInfo, Config, Health, LogWindow, RecordingRow, Rule, Summary } from '../api/types'
import { trimToWindow } from './log-window'

export interface PanelState {
  api: PanelApi
  health: Health
  config: Config
  ca: CaInfo
  rules: Rule[]
  calls: Summary[]
  /** The oldest seq the log still holds; anything under it is gone. */
  oldest: number
  /**
   * What `GET /sessions` holds: the sessions on disk and their counts, so a
   * name absent here has nothing recorded in it. The set of sessions the panel
   * can name is wider — features/session/named-sessions.ts.
   */
  sessions: Record<string, number>
  recordings: Record<string, RecordingRow[]>
  connected: boolean
  loading: boolean
  /** Re-reads whatever a write just changed. */
  refresh: (what?: Partial<Record<'rules' | 'calls' | 'sessions' | 'config' | 'health', true>>) => Promise<void>
  setRecordings: (session: string, rows: RecordingRow[]) => void
}

const Context = createContext<PanelState | null>(null)

/**
 * Built once for the life of the page. A default parameter would build a new
 * one on every render, and since the effects below depend on it, that is an
 * endless render loop.
 *
 * The real server, not the fake rows: main.tsx passes the api it built, and
 * anything that forgets to should still show the truth rather than a fiction.
 */
const defaultApi = createHttpApi()

/**
 * The settings the shell page embedded, read once — at module scope, not in a
 * render — so the panel starts with the config the server already handed it
 * instead of an empty slot. A head start, nothing more: the load below re-reads
 * the config along with everything else.
 *
 * There may be nothing to read: `npm run dev` serves panel/index.html, which
 * has no bootstrap. That, and anything unparseable, means no head start.
 */
const bootstrappedConfig = ((): Config | null => {
  try {
    const embedded = document.getElementById('bootstrap')?.textContent
    return embedded ? ((JSON.parse(embedded).config as Config) ?? null) : null
  } catch {
    return null
  }
})()

export function PanelStateProvider({
  api = defaultApi,
  children,
}: {
  api?: PanelApi
  children: React.ReactNode
}) {
  const [health, setHealth] = useState<Health | null>(null)
  const [config, setConfig] = useState<Config | null>(bootstrappedConfig)
  const [ca, setCa] = useState<CaInfo | null>(null)
  const [rules, setRules] = useState<Rule[]>([])
  const [calls, setCalls] = useState<Summary[]>([])
  const [sessions, setSessions] = useState<Record<string, number>>({})
  const [recordings, setRecs] = useState<Record<string, RecordingRow[]>>({})
  const [connected, setConnected] = useState(false)

  /**
   * The newest seq held. A ref rather than state because the effect below reads
   * it once, when it opens the stream: as state it would be a dependency, and
   * the stream would be torn down and reopened on every call that arrived.
   */
  const newest = useRef(0)

  /**
   * The oldest seq the server still holds. Zero until the stream says — which
   * is a window nothing is under, so nothing is judged gone before the server
   * has spoken.
   */
  const [oldest, setOldest] = useState(0)

  /** The log as a whole — the first load, or a re-read after a write. */
  const setLog = useCallback((rows: Summary[]) => {
    newest.current = rows.reduce((max, row) => (row.seq > max ? row.seq : max), 0)
    setCalls(rows)
  }, [])

  /**
   * One call off the stream. Anything not newer than the newest row held is
   * dropped: a load and the stream's backfill are meant to overlap — `/events`
   * subscribes before it reads the buffer so that nothing falls between the two
   * — and the same row listed twice is a duplicate React key.
   */
  const append = useCallback((call: Summary) => {
    if (call.seq <= newest.current) return
    newest.current = call.seq
    setCalls((all) => [...all, call])
  }, [])

  /**
   * The stretch the server says it still holds, off the stream. Rows under it
   * are gone — cleared, or pushed out of the buffer — and `newest` comes back
   * with them; `trimToWindow` is where both halves are worked out, and why the
   * second one is not optional.
   *
   * The updater form, with `newest` read inside it, so that this depends on
   * nothing: it is a dependency of the effect that opens the stream, and a new
   * one per arriving call would tear that stream down and reopen it.
   */
  const trim = useCallback((window: LogWindow) => {
    setCalls((all) => {
      const next = trimToWindow(all, newest.current, window)
      newest.current = next.newest
      return next.rows
    })
    // Kept as state as well as applied, because a detail already on screen has
    // no other way to find out: its fetch is keyed on the seq, which does not
    // change when somebody else clears the log underneath it. React drops a set
    // to the value already held, so the window arriving every heartbeat with
    // nothing new in it re-renders nobody.
    setOldest(window.first_seq)
  }, [])

  const refresh = useCallback<PanelState['refresh']>(
    async (what) => {
      const all = !what
      const jobs: Promise<unknown>[] = []
      if (all || what?.health) jobs.push(api.health().then(setHealth))
      if (all || what?.config) jobs.push(api.config().then(setConfig))
      if (all || what?.rules) jobs.push(api.rules().then(setRules))
      if (all || what?.calls) jobs.push(api.requests().then(setLog))
      if (all || what?.sessions) jobs.push(api.sessions().then(setSessions))
      await Promise.all(jobs)
    },
    [api, setLog]
  )

  useEffect(() => {
    let live = true
    let stop: (() => void) | null = null
    // Load first, then stream. The two cannot run side by side: the stream needs
    // the seq the snapshot ended at, and without it the choice is between
    // `since=0`, which backfills a log we have just read, and no `since` at all,
    // which loses whatever arrives while the load is in flight.
    Promise.all([refresh(), api.ca().then((c) => live && setCa(c))])
      .then(() => {
        if (!live) return
        stop = api.subscribe(newest.current, append, trim, (up) => live && setConnected(up))
      })
      .catch(() => {})
    return () => {
      // Unmount can come before the load resolves, so there may be no stream
      // yet; `live` is what keeps one from being opened after this.
      live = false
      stop?.()
    }
  }, [api, refresh, append, trim])

  // Every session that has been opened keeps its rows, so going back to one is
  // instant and a delete can be reflected without a round trip.
  const sessionNames = Object.keys(sessions).sort().join(',')
  useEffect(() => {
    let live = true
    const names = sessionNames ? sessionNames.split(',') : []
    Promise.all(names.map((name) => api.recordings(name).then((rows) => [name, rows] as const))).then(
      (pairs) => live && setRecs(Object.fromEntries(pairs))
    )
    return () => {
      live = false
    }
  }, [api, sessionNames])

  const setRecordings = useCallback(
    (session: string, rows: RecordingRow[]) => setRecs((all) => ({ ...all, [session]: rows })),
    []
  )

  const value = useMemo<PanelState | null>(() => {
    if (!health || !config || !ca) return null
    return { api, health, config, ca, rules, calls, oldest, sessions, recordings, connected, loading: false, refresh, setRecordings }
  }, [api, health, config, ca, rules, calls, oldest, sessions, recordings, connected, refresh, setRecordings])

  if (!value) return <PanelSkeleton />
  return <Context.Provider value={value}>{children}</Context.Provider>
}

/** The first paint, before the server has answered. */
function PanelSkeleton() {
  return (
    <div className="flex h-svh w-full lg:bg-zinc-100">
      <div className="w-64 max-lg:hidden" />
      <div className="flex-1 p-10">
        <div className="h-8 w-48 animate-pulse rounded bg-zinc-200" />
        <div className="mt-8 space-y-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-10 animate-pulse rounded bg-zinc-100" />
          ))}
        </div>
      </div>
    </div>
  )
}

export function usePanelState(): PanelState {
  const state = useContext(Context)
  if (!state) throw new Error('usePanelState outside PanelStateProvider')
  return state
}
