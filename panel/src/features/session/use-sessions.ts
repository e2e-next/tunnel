/**
 * Sessions: the scope of one run. Recordings are written into the current one
 * and replay reads from it, so switching is a first-class action.
 *
 * Two sets, and keeping them apart is the point. The pickers — the switcher,
 * the recordings table, ⌘K, the replay rule's Session field — want every
 * session the panel can name, which `namedSessions` widens out of what the
 * server said; nobody can switch to a name that is not offered. `hasRecordings`
 * is a different question, asked only by the New session dialog, and it stays
 * on the narrow table: widening it would start refusing a name that a replay
 * rule pins but nobody has recorded into, and filling that session is the most
 * ordinary thing you do with a replay rule.
 */
import { useCallback, useMemo } from 'react'
import { usePanelState } from '../../state/panel-state'
import { useToasts } from '../notifications/use-toasts'
import { namedSessions } from './named-sessions'

/** A session name becomes a directory, so it is held to directory characters. */
export const SESSION_NAME = /^[A-Za-z0-9._-]+$/

export function useSessions() {
  const { api, config, health, sessions: recorded, recordings, rules, refresh } = usePanelState()
  const { notify, failed } = useToasts()

  // Off `config.session`, not the `.session` that came with the sessions table,
  // because switching re-reads the config and not that table: the set is right
  // the moment the switch lands, with no second request and nothing to drift.
  const sessions = useMemo(
    () => namedSessions(recorded, config.session, rules),
    [recorded, config.session, rules]
  )

  const use = useCallback(
    async (name: string) => {
      try {
        await api.patchConfig({ session: name })
        await refresh({ config: true, health: true })
        notify({ tone: 'success', title: `This run uses ${name}` })
      } catch (e) {
        failed('Could not switch session', e)
      }
    },
    [api, refresh, notify, failed]
  )

  const remove = useCallback(
    async (name: string) => {
      try {
        const count = await api.deleteRecordings(name)
        await refresh({ sessions: true })
        notify({
          tone: 'success',
          title: `Deleted ${count} recording${count === 1 ? '' : 's'} from ${name}`,
        })
      } catch (e) {
        failed('Could not delete the recordings', e)
      }
    },
    [api, refresh, notify, failed]
  )

  return {
    current: config.session,
    sessions,
    recordings,
    recordingInto: health.recording.active ? health.recording.session : null,
    countOf: (name: string) => recordings[name]?.length ?? sessions[name] ?? 0,
    hasRecordings: (name: string) => recorded[name] !== undefined,
    use,
    remove,
  }
}
