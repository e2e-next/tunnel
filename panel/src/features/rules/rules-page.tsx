/**
 * The set of endpoints tunnel answers itself. A rule persists and gets edited,
 * so the list links to a page per rule rather than opening a dialog.
 */
import { MagnifyingGlassIcon } from '@heroicons/react/16/solid'
import { BoltSlashIcon } from '@heroicons/react/24/outline'
import { useMemo, useState } from 'react'
import { Alert, AlertActions, AlertDescription, AlertTitle } from '../../components/alert'
import { Button } from '../../components/button'
import { Heading } from '../../components/heading'
import { Input, InputGroup } from '../../components/input'
import { Select } from '../../components/select'
import { Code, Text } from '../../components/text'
import type { Rule } from '../../api/types'
import { splitKey } from '../../lib/format'
import { EmptyState, NoMatches } from '../../ui/empty-state'
import { useToasts } from '../notifications/use-toasts'
import { RulesTable } from './rules-table'
import { useRules } from './use-rules'

export function RulesPage() {
  const { rules, hits, save, remove, removeAll, resetState } = useRules()
  const { failed } = useToasts()
  const [q, setQ] = useState('')
  const [mode, setMode] = useState('')
  const [host, setHost] = useState('')
  const [deleting, setDeleting] = useState<Rule | null>(null)
  const [clearing, setClearing] = useState(false)

  const hosts = useMemo(
    () => [...new Set(rules.map((r) => splitKey(r.key).host))].filter(Boolean).sort(),
    [rules]
  )

  const rows = rules.filter((r) => {
    if (mode && r.mode !== mode) return false
    if (host && splitKey(r.key).host !== host) return false
    if (!q) return true
    const needle = q.toLowerCase()
    return r.key.toLowerCase().includes(needle) || r.description.toLowerCase().includes(needle)
  })

  const filtering = !!(q || mode || host)

  // save() hands the refusal back rather than reporting it, and from the list
  // there is no field to put it on, so it goes in the error toast.
  const actions = {
    toggle: async (rule: Rule, on: boolean) => {
      const err = await save({ ...rule, enabled: on }, on ? 'Rule enabled' : 'Rule disabled')
      if (err) failed('Could not save the rule', err)
    },
    duplicate: async (rule: Rule) => {
      const copy = { ...rule, key: `${rule.key}.copy`, description: `Copy of ${rule.key}` }
      const err = await save(copy, 'Rule duplicated')
      if (err) failed('Could not save the rule', err)
    },
    resetState: (rule: Rule) => resetState(rule.key),
    remove: (rule: Rule) => setDeleting(rule),
  }

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Heading>Rules</Heading>
          <Text className="!mt-1 !text-sm/6">
            {rules.length} rule{rules.length === 1 ? '' : 's'} answer before the real server does
          </Text>
        </div>
        <div className="flex gap-3">
          {rules.length > 0 && <Button plain onClick={() => setClearing(true)}>Delete all</Button>}
          <Button href="#/rules/new">New rule</Button>
        </div>
      </div>

      {rules.length === 0 ? (
        <EmptyState
          icon={BoltSlashIcon}
          title="No rule yet"
          action={{ label: 'New rule', href: '#/rules/new' }}
        >
          Every call goes to the real server. Add a rule to answer one endpoint yourself, or
          make one from a call on Traffic.
        </EmptyState>
      ) : (
        <>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <InputGroup className="!w-72">
              <MagnifyingGlassIcon />
              <Input
                type="search"
                aria-label="Search rules"
                placeholder="Search key or note"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </InputGroup>
            <Select aria-label="Mode" className="!w-40" value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="">Any mode</option>
              {['passthrough', 'json', 'script', 'replay'].map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </Select>
            <Select aria-label="Host" className="!w-56" value={host} onChange={(e) => setHost(e.target.value)}>
              <option value="">Any host</option>
              {hosts.map((h) => (
                <option key={h} value={h}>{h}</option>
              ))}
            </Select>
          </div>

          {rows.length === 0 ? (
            <NoMatches what="rule" onClear={() => { setQ(''); setMode(''); setHost('') }} />
          ) : (
            <RulesTable rules={rows} hits={hits} actions={actions} />
          )}

          <Text className="!mt-8 !text-xs/6 text-zinc-500">
            A whole set of rules goes in and out through the CLI:{' '}
            <Code className="!text-xs">tunnel apply scenarios/checkout.json</Code> and{' '}
            <Code className="!text-xs">tunnel export -o rules.json</Code>.
          </Text>
        </>
      )}

      <Alert open={!!deleting} onClose={() => setDeleting(null)}>
        <AlertTitle>Delete this rule?</AlertTitle>
        <AlertDescription>
          <span className="font-mono text-xs">{deleting?.key}</span> stops answering, and calls to
          it go wherever the current mode sends them.
        </AlertDescription>
        <AlertActions>
          <Button plain onClick={() => setDeleting(null)}>Cancel</Button>
          <Button color="red" onClick={() => { if (deleting) remove(deleting.key); setDeleting(null) }}>
            Delete rule
          </Button>
        </AlertActions>
      </Alert>

      <Alert open={clearing} onClose={() => setClearing(false)}>
        <AlertTitle>Delete every rule?</AlertTitle>
        <AlertDescription>
          All {rules.length} rules go. Recordings are untouched, and every endpoint falls back to
          the current mode.
        </AlertDescription>
        <AlertActions>
          <Button plain onClick={() => setClearing(false)}>Cancel</Button>
          <Button color="red" onClick={() => { removeAll(); setClearing(false) }}>
            Delete every rule
          </Button>
        </AlertActions>
      </Alert>
    </>
  )
}
