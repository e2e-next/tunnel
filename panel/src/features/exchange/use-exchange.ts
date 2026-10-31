/**
 * One call in full, fetched on demand. Traffic and Recordings both open the
 * same view, so the fetch lives with that view rather than in either page.
 *
 * A session numbers its recordings itself, so a recorded seq is a different call
 * from the live one wearing the same number: naming the session is what tells
 * the two apart.
 */
import { useEffect, useState } from 'react'
import type { Exchange } from '../../api/types'
import { usePanelState } from '../../state/panel-state'

export function useExchange(seq: number | null, session?: string) {
  const { api, oldest } = usePanelState()
  const [exchange, setExchange] = useState<Exchange | null>(null)
  const [missing, setMissing] = useState(false)

  /**
   * Whether the log has moved out from under a live call that is already on
   * screen. The fetch below is keyed on the seq, and the seq does not change
   * when somebody else clears the log, so without this the detail would go on
   * showing a call the server no longer has — the one case the row list cannot
   * cover, because the row is gone from it by then.
   *
   * A recording is not in that window: a session numbers its own recordings and
   * keeps them on disk, so `oldest` says nothing about them.
   */
  const gone = session === undefined && seq !== null && seq < oldest

  useEffect(() => {
    if (seq === null || gone) {
      setExchange(null)
      setMissing(gone)
      return
    }
    let live = true
    const wanted = session ? api.recordedExchange(session, seq) : api.exchange(seq)
    wanted.then((x) => {
      if (!live) return
      setExchange(x)
      setMissing(x === null)
    })
    return () => {
      live = false
    }
  }, [api, seq, session, gone])

  return { exchange, missing }
}
