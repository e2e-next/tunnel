/**
 * Every session the panel can name, which is more than the ones on disk.
 *
 * A session is a directory only once something has been recorded into it, so
 * `GET /sessions` answers "what is on disk" and leaves the one in hand to the
 * caller — its docstring says so, and `tunnel session` does exactly that. The
 * panel did not, so on a server nobody has recorded into, the switcher offered
 * no session at all and there was no way back to `default` once you left it.
 *
 * Four sources, each of them something the server has already said:
 * `GET /sessions` for what is on disk, `default` because that is where every
 * run starts and `tunnel session default` always lands, `GET /config`'s
 * `.session` for the one in hand, and `GET /mocks` for the ones replay rules
 * pin. Not a fifth: the panel remembering names it has seen go by would be
 * state no API ever returned, and it would not survive a reload.
 *
 * Outside React for the same reason as state/log-window.ts: the panel has no
 * test runner, and a function taking plain values and returning plain values
 * can be exercised with `node` directly.
 */
import type { Rule } from '../../api/types'

/** The server's models.ts DEFAULT_SESSION, repeated here rather than fetched. */
const DEFAULT_SESSION = 'default'

/**
 * The names on disk widened by the three that are not, counts intact.
 *
 * `recorded` is merged last so the count is the one the server gave; a name
 * arriving from two sources is one key either way.
 */
export function namedSessions(
  recorded: Record<string, number>,
  current: string,
  rules: Rule[]
): Record<string, number> {
  const named: Record<string, number> = {}
  // `mode === 'replay'` because `replay_session` survives a rule being switched
  // to another mode: a json rule can still carry the name it replayed from last
  // time, and nothing replays from that, so it is not a session anybody wants
  // to switch to.
  const pinned = rules.filter((r) => r.mode === 'replay').map((r) => r.replay_session)
  // An empty name is not a name — the server's own sessionName() agrees — and a
  // row with no label is worse than no row.
  for (const name of [DEFAULT_SESSION, current, ...pinned]) if (name) named[name] = 0
  const all = { ...named, ...recorded }
  // Sorted because the server's table already arrives sorted, and a `default`
  // merged in ahead of it would otherwise sit wherever insertion put it.
  return Object.fromEntries(Object.keys(all).sort().map((name) => [name, all[name]]))
}
