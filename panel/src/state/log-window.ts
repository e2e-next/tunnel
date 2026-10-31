/**
 * Converging the log in hand on the stretch the server still holds.
 *
 * The log is a window, not a list that only grows: the buffer has a cap, and
 * anybody can clear it — the CLI, an MCP call, another tab. Rows under its
 * oldest seq are gone, and the panel has to let go of them or it lists rows
 * that cannot be opened.
 *
 * The calculation lives here, outside React, for one reason: the panel has no
 * test runner (spec §Open questions 2 — and installing one is a separate
 * decision, not something to smuggle into a bug fix). Taking plain values and
 * returning plain values, it can be exercised with `node` directly, and the
 * half that is easy to get wrong is the half that needs exercising.
 */
import type { LogWindow, Summary } from '../api/types'

/**
 * The rows and the newest seq held, both converged on `window`.
 *
 * `newest` coming back with the rows is the point of this function. `append`
 * drops anything not newer than `newest`, so after a clear a `newest` still
 * sitting at the old high-water mark would silently discard the rows that
 * arrive next: the list would empty and then stay empty, which is a worse bug
 * than the ghost rows this is here to remove.
 *
 * `min`, not assignment, because the pull is only ever backwards. `last_seq`
 * can be ahead of what the panel has actually seen — the window that comes
 * with a call is read before the call itself — and moving `newest` up to meet
 * it would drop exactly the row it was announcing.
 */
export function trimToWindow(
  rows: Summary[],
  newest: number,
  window: LogWindow
): { rows: Summary[]; newest: number } {
  const kept = rows.filter((row) => row.seq >= window.first_seq)
  return {
    // The same array back when nothing was dropped, because most windows drop
    // nothing: one arrives every heartbeat. React bails out of a re-render on
    // state it is handed identically, and that is the whole list.
    rows: kept.length === rows.length ? rows : kept,
    newest: Math.min(newest, window.last_seq),
  }
}
