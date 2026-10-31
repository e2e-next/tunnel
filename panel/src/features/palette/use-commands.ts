/**
 * What ⌘K can reach. Built from the features rather than hard-coded, so a rule
 * added on Rules is findable here without anything being registered twice.
 */
import { useMemo } from 'react'
import { go, ruleHref } from '../../router'
import { useRules } from '../rules/use-rules'
import { useRun } from '../run/use-run'
import { useSessions } from '../session/use-sessions'

export interface Command {
  id: string
  label: string
  hint: string
  run: () => void
}

export function useCommands(): Command[] {
  const { rules } = useRules()
  const { sessions, use } = useSessions()
  const { replaying, recording, unmatchedCount, setMode, toggleRecording } = useRun()

  return useMemo(() => {
    const commands: Command[] = [
      { id: 'traffic', label: 'Traffic', hint: 'Page', run: () => go('/traffic') },
      { id: 'rules', label: 'Rules', hint: 'Page', run: () => go('/rules') },
      { id: 'recordings', label: 'Recordings', hint: 'Page', run: () => go('/recordings') },
      { id: 'connect', label: 'Connect a device', hint: 'Page', run: () => go('/connect') },
      { id: 'settings', label: 'Settings', hint: 'Page', run: () => go('/settings') },
      { id: 'new-rule', label: 'New rule', hint: 'Action', run: () => go('/rules/new') },
      {
        id: 'mode',
        label: replaying ? 'Switch to Live' : 'Switch to Replay',
        hint: 'Action',
        run: () => setMode(replaying ? 'passthrough' : 'replay'),
      },
      {
        id: 'record',
        label: recording.active ? 'Stop recording' : 'Start recording',
        hint: 'Action',
        run: () => toggleRecording(),
      },
    ]

    if (unmatchedCount > 0) {
      commands.push({
        id: 'unmatched',
        label: `Show ${unmatchedCount} unmatched calls`,
        hint: 'Action',
        run: () => go('/traffic?unmatched=1'),
      })
    }

    for (const name of Object.keys(sessions)) {
      commands.push({
        id: `session-${name}`,
        label: `Use session ${name}`,
        hint: 'Session',
        run: () => use(name),
      })
    }

    for (const rule of rules) {
      commands.push({
        id: `rule-${rule.key}`,
        label: rule.key,
        hint: `Rule · ${rule.mode}`,
        run: () => go(ruleHref(rule.key).slice(1)),
      })
    }

    return commands
  }, [rules, sessions, replaying, recording.active, unmatchedCount, setMode, toggleRecording, use])
}
