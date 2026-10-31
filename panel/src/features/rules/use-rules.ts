/**
 * Rules: the endpoints tunnel answers itself. Hit counts are derived from the
 * log rather than stored, because the server counts nothing the panel can read.
 */
import { useCallback, useMemo } from 'react'
import { ApiError } from '../../api/client'
import type { Rule } from '../../api/types'
import { usePanelState } from '../../state/panel-state'
import { useToasts } from '../notifications/use-toasts'

export const BLANK_RULE: Rule = {
  key: '', mode: 'json', json_response: {}, status_code: 200, enabled: true, description: '',
  merge_json: {}, headers: {}, target: '', response_delay: 0, script: '',
  replay_session: '', replay_strategy: 'match', fault: 'none', fault_seconds: 0,
}

export function useRules() {
  const { api, rules, calls, refresh } = usePanelState()
  const { notify, failed } = useToasts()

  const hitCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const call of calls) {
      if (call.matched_by) counts.set(call.matched_by, (counts.get(call.matched_by) ?? 0) + 1)
    }
    return counts
  }, [calls])

  /**
   * Saves, and hands back what the server refused with instead of reporting it:
   * a script's syntax error belongs under the Handler field, and only the caller
   * knows which field it is looking at. Null means it was saved.
   */
  const save = useCallback(
    async (rule: Rule, message = 'Rule saved'): Promise<ApiError | null> => {
      try {
        await api.saveRule(rule)
        await refresh({ rules: true })
        notify({ tone: 'success', title: message, body: rule.key })
        return null
      } catch (e) {
        return e instanceof ApiError ? e : new ApiError(e instanceof Error ? e.message : String(e), 0)
      }
    },
    [api, refresh, notify]
  )

  const remove = useCallback(
    async (key: string) => {
      try {
        await api.deleteRule(key)
        await refresh({ rules: true })
        notify({ tone: 'success', title: 'Rule deleted', body: key })
      } catch (e) {
        failed('Could not delete the rule', e)
      }
    },
    [api, refresh, notify, failed]
  )

  const removeAll = useCallback(async () => {
    try {
      await api.deleteAllRules()
      await refresh({ rules: true })
      notify({ tone: 'success', title: 'Every rule deleted' })
    } catch (e) {
      failed('Could not delete the rules', e)
    }
  }, [api, refresh, notify, failed])

  const resetState = useCallback(
    async (key: string) => {
      try {
        await api.resetRuleState(key)
        notify({ tone: 'success', title: 'Rule state reset', body: 'Its counter and saved state start over.' })
      } catch (e) {
        failed('Could not reset the rule', e)
      }
    },
    [api, notify, failed]
  )

  return {
    rules,
    find: (key: string) => rules.find((r) => r.key === key),
    hits: (key: string) => hitCounts.get(key) ?? 0,
    save,
    remove,
    removeAll,
    resetState,
  }
}
