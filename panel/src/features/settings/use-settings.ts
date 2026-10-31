/** The settings form: a draft, what is wrong with it, and saving it. */
import { useCallback, useEffect, useState } from 'react'
import type { Config } from '../../api/types'
import { usePanelState } from '../../state/panel-state'
import { useToasts } from '../notifications/use-toasts'

export function useSettings() {
  const { api, config, health, ca, refresh } = usePanelState()
  const { notify, failed } = useToasts()
  const [draft, setDraft] = useState<Config>(config)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!dirty) setDraft(config)
  }, [config, dirty])

  const edit = useCallback((patch: Partial<Config>) => {
    setDraft((d) => ({ ...d, ...patch }))
    setDirty(true)
  }, [])

  const kept = Number(draft.max_requests_history)
  const errors = {
    max_requests_history:
      !Number.isInteger(kept) || kept < 1 || kept > 100000
        ? 'A whole number between 1 and 100000.'
        : null,
  }
  const valid = Object.values(errors).every((e) => e === null)

  const save = useCallback(async () => {
    if (!valid) return
    setSaving(true)
    try {
      await api.patchConfig(draft)
      await refresh({ config: true })
      setDirty(false)
      notify({ tone: 'success', title: 'Settings saved' })
    } catch (e) {
      failed('Could not save the settings', e)
    } finally {
      setSaving(false)
    }
  }, [api, draft, valid, refresh, notify, failed])

  return {
    draft, edit, errors, valid, dirty, saving, save,
    reset: () => { setDraft(config); setDirty(false) },
    health, ca,
  }
}
