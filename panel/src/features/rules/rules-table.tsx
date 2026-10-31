/**
 * The rule list. The enable switch stays in the row because turning one rule
 * off and on again is the most repeated action in a debugging session; every
 * other action is in the row menu, and the row itself opens the rule.
 */
import { EllipsisVerticalIcon } from '@heroicons/react/16/solid'
import { Badge } from '../../components/badge'
import { Dropdown, DropdownButton, DropdownItem, DropdownLabel, DropdownMenu } from '../../components/dropdown'
import { Switch } from '../../components/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/table'
import type { Rule } from '../../api/types'
import { modeColor, splitKey } from '../../lib/format'
import { go, ruleHref } from '../../router'

export interface RuleActions {
  toggle: (rule: Rule, on: boolean) => void
  duplicate: (rule: Rule) => void
  resetState: (rule: Rule) => void
  remove: (rule: Rule) => void
}

export function RulesTable({
  rules,
  hits,
  actions,
}: {
  rules: Rule[]
  hits: (key: string) => number
  actions: RuleActions
}) {
  return (
    <Table className="mt-6 [--gutter:--spacing(6)] lg:[--gutter:--spacing(10)]">
      <TableHead>
        <TableRow>
          <TableHeader className="w-full">Rule</TableHeader>
          <TableHeader>Mode</TableHeader>
          <TableHeader className="text-right">Status</TableHeader>
          <TableHeader className="text-right">Hits</TableHeader>
          <TableHeader>Enabled</TableHeader>
          <TableHeader className="w-0"><span className="sr-only">Actions</span></TableHeader>
        </TableRow>
      </TableHead>
      <TableBody>
        {rules.map((rule) => {
          const { method, host, path } = splitKey(rule.key)
          return (
            <TableRow
              key={rule.key}
              className="cursor-pointer"
              onClick={() => go(ruleHref(rule.key).slice(1))}
            >
              <TableCell className="max-w-0">
                <div className="flex items-center gap-2">
                  <Badge color="zinc" className="!font-mono !text-[0.6875rem]">{method}</Badge>
                  <span className="truncate font-mono text-xs/5 text-zinc-950 dark:text-white">{path}</span>
                </div>
                <div className="truncate text-xs/5 text-zinc-500">
                  {host || 'Any host'}
                  {rule.description && ` · ${rule.description}`}
                </div>
              </TableCell>

              <TableCell>
                <Badge color={modeColor[rule.mode]}>{rule.mode}</Badge>
                {rule.fault !== 'none' && <Badge color="rose" className="ml-1.5">{rule.fault}</Badge>}
              </TableCell>

              <TableCell className="text-right tabular-nums text-zinc-500">
                {rule.mode === 'passthrough' ? '—' : rule.status_code}
              </TableCell>

              <TableCell className="text-right tabular-nums text-zinc-500">{hits(rule.key)}</TableCell>

              <TableCell onClick={(e) => e.stopPropagation()}>
                <Switch
                  checked={rule.enabled}
                  aria-label={`Enable ${rule.key}`}
                  onChange={(on) => actions.toggle(rule, on)}
                />
              </TableCell>

              <TableCell onClick={(e) => e.stopPropagation()}>
                <Dropdown>
                  <DropdownButton plain aria-label="Actions" className="!-my-1.5 !px-1">
                    <EllipsisVerticalIcon />
                  </DropdownButton>
                  <DropdownMenu anchor="bottom end">
                    <DropdownItem href={ruleHref(rule.key)}>
                      <DropdownLabel>Edit</DropdownLabel>
                    </DropdownItem>
                    <DropdownItem onClick={() => actions.duplicate(rule)}>
                      <DropdownLabel>Duplicate</DropdownLabel>
                    </DropdownItem>
                    <DropdownItem onClick={() => actions.resetState(rule)}>
                      <DropdownLabel>Reset state</DropdownLabel>
                    </DropdownItem>
                    <DropdownItem onClick={() => actions.remove(rule)}>
                      <DropdownLabel>Delete</DropdownLabel>
                    </DropdownItem>
                  </DropdownMenu>
                </Dropdown>
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
