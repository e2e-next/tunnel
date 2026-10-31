/**
 * One call as a row. The path is what the eye scans for, so it gets the width
 * and the host goes underneath; every action that starts from a call is in the
 * row's own menu, which keeps the row itself free of buttons.
 */
import { EllipsisVerticalIcon, LockClosedIcon } from '@heroicons/react/16/solid'
import { Badge } from '../../components/badge'
import { Dropdown, DropdownButton, DropdownItem, DropdownLabel, DropdownMenu } from '../../components/dropdown'
import { TableCell, TableRow } from '../../components/table'
import type { Summary } from '../../api/types'
import { bytes, clock, ms, statusColor } from '../../lib/format'
import { ruleHref } from '../../router'

export interface RowActions {
  open: (call: Summary) => void
  mock: (call: Summary) => void
  copyCurl: (call: Summary) => void
  copyKey: (call: Summary) => void
  decrypt: (call: Summary) => void
  onlyHost: (call: Summary) => void
}

export function TrafficRow({
  call,
  selected,
  actions,
}: {
  call: Summary
  selected: boolean
  actions: RowActions
}) {
  const tunnel = call.kind === 'connect'
  const query = new URLSearchParams(call.query).toString()

  return (
    <TableRow
      className={`cursor-pointer ${selected ? 'bg-zinc-950/[3%] dark:bg-white/[3%]' : ''}`}
      onClick={() => actions.open(call)}
    >
      <TableCell className="tabular-nums text-zinc-500">{clock(call.time)}</TableCell>

      <TableCell>
        <Badge color="zinc" className="!font-mono !text-[0.6875rem]">{call.method}</Badge>
      </TableCell>

      <TableCell className="max-w-0">
        <div className={`truncate font-mono text-xs/5 ${tunnel ? 'text-zinc-400' : 'text-zinc-950 dark:text-white'}`}>
          {tunnel && <LockClosedIcon className="mr-1 inline size-3 fill-zinc-400" />}
          {tunnel ? `${call.host}:${call.port}` : call.path}
          {query && <span className="text-zinc-400">?{query}</span>}
        </div>
        {!tunnel && <div className="truncate text-xs/5 text-zinc-500">{call.host}</div>}
      </TableCell>

      <TableCell>
        {call.status === null ? (
          <Badge color="zinc">tunnel</Badge>
        ) : (
          <Badge color={statusColor(call.status)}>{call.status}</Badge>
        )}
      </TableCell>

      <TableCell className="text-right tabular-nums text-zinc-500">{bytes(call.size)}</TableCell>
      <TableCell className="text-right tabular-nums text-zinc-500">{ms(call.elapsed_ms)}</TableCell>

      <TableCell className="max-w-56">
        <AnsweredBy call={call} tunnel={tunnel} />
      </TableCell>

      <TableCell onClick={(e) => e.stopPropagation()}>
        <Dropdown>
          <DropdownButton plain aria-label="Actions" className="!-my-1.5 !px-1">
            <EllipsisVerticalIcon />
          </DropdownButton>
          <DropdownMenu anchor="bottom end">
            <DropdownItem onClick={() => actions.open(call)}>
              <DropdownLabel>Open</DropdownLabel>
            </DropdownItem>
            {!tunnel && (
              <DropdownItem onClick={() => actions.mock(call)}>
                <DropdownLabel>Mock this…</DropdownLabel>
              </DropdownItem>
            )}
            <DropdownItem onClick={() => actions.copyCurl(call)}>
              <DropdownLabel>Copy as curl</DropdownLabel>
            </DropdownItem>
            <DropdownItem onClick={() => actions.copyKey(call)}>
              <DropdownLabel>Copy key</DropdownLabel>
            </DropdownItem>
            {tunnel && (
              <DropdownItem onClick={() => actions.decrypt(call)}>
                <DropdownLabel>Decrypt this host</DropdownLabel>
              </DropdownItem>
            )}
            <DropdownItem onClick={() => actions.onlyHost(call)}>
              <DropdownLabel>Only {call.host}</DropdownLabel>
            </DropdownItem>
            {call.matched_by && (
              <DropdownItem href={ruleHref(call.matched_by)}>
                <DropdownLabel>Go to the rule</DropdownLabel>
              </DropdownItem>
            )}
          </DropdownMenu>
        </Dropdown>
      </TableCell>
    </TableRow>
  )
}

function AnsweredBy({ call, tunnel }: { call: Summary; tunnel: boolean }) {
  if (call.unmatched) return <Badge color="amber">unmatched</Badge>
  if (call.replay_seq !== null) return <Badge color="amber">replay #{call.replay_seq}</Badge>
  if (call.matched_by) {
    return (
      <span className="block truncate font-mono text-xs/5 text-zinc-500" title={call.matched_by}>
        {call.matched_by}
      </span>
    )
  }
  return <span className="text-xs/5 text-zinc-400">{tunnel ? 'tunnelled' : 'real server'}</span>
}
