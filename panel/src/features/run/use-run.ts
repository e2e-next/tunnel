/**
 * The two switches that describe a run rather than a page: where an endpoint
 * without a rule gets its answer, and whether calls are being written down.
 */
import { useCallback } from 'react'
import type { Mode } from '../../api/types'
import { usePanelState } from '../../state/panel-state'
import { useToasts } from '../notifications/use-toasts'

export function useRun() {
  const { api, config, health, calls, connected, refresh } = usePanelState()
  const { notify, failed } = useToasts()

  const replaying = config.default_mode === 'replay'
  const recording = health.recording

  const setMode = useCallback(
    async (mode: Mode) => {
      try {
        await api.patchConfig({ default_mode: mode })
        await refresh({ config: true })
        notify({
          tone: 'success',
          title:
            mode === 'replay'
              ? 'Replaying from the recordings'
              : 'Live: endpoints without a rule reach the real server',
        })
      } catch (e) {
        failed('Could not switch mode', e)
      }
    },
    [api, refresh, notify, failed]
  )

  const toggleRecording = useCallback(
    async (session?: string) => {
      try {
        const stopping = recording.active && (session === undefined || session === recording.session)
        if (stopping) {
          await api.stopRecording()
          notify({ tone: 'success', title: 'Recording stopped' })
        } else {
          await api.startRecording(session)
          notify({ tone: 'success', title: `Recording into ${session ?? config.session}` })
        }
        await refresh({ health: true, config: true })
      } catch (e) {
        failed('Could not change recording', e)
      }
    },
    [api, recording, config.session, refresh, notify, failed]
  )

  return {
    mode: config.default_mode,
    replaying,
    recording,
    connected,
    version: health.version,
    proxy: health.proxy,
    unmatchedCount: calls.filter((c) => c.unmatched).length,
    setMode,
    toggleRecording,
  }
}
