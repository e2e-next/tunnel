/** The list itself: headers, rows, and nothing else. */
import clsx from 'clsx'
import { Table, TableBody, TableHead, TableHeader, TableRow } from '../../components/table'
import type { Summary } from '../../api/types'
import { TrafficRow, type RowActions } from './traffic-row'

/**
 * The column names stay put while the rows scroll. A log is read by scrolling
 * through it, and a column you can no longer name is a column you have to
 * count across.
 *
 * Two things have to be undone for it to work. The Catalyst wrapper's own
 * `overflow-x-auto` makes that div a scroll container in both axes, and a
 * sticky cell pins to its nearest one — so the header would pin to a box that
 * never scrolls vertically and nothing would happen; `STILL` hands both axes
 * back to the list's own scroller outside. And with `border-collapse: collapse`
 * a cell's bottom border is painted by the table rather than by the cell, so it
 * scrolls away underneath the pinned row: an inset shadow draws that line
 * instead, on the cell, where it stays.
 */
const STILL = 'overflow-x-visible!'
const PINNED =
  'sticky top-0 z-10 bg-white dark:bg-zinc-900 ' +
  'shadow-[inset_0_-1px_0_rgb(9_9_11/0.1)] dark:shadow-[inset_0_-1px_0_rgb(255_255_255/0.1)]'

export function TrafficTable({
  rows,
  selected,
  actions,
}: {
  rows: Summary[]
  selected: number | null
  actions: RowActions
}) {
  return (
    <Table dense className={clsx('mt-4 [--gutter:--spacing(0)]', STILL)}>
      <TableHead>
        <TableRow>
          <TableHeader className={PINNED}>Time</TableHeader>
          <TableHeader className={PINNED}>Method</TableHeader>
          <TableHeader className={clsx(PINNED, 'w-full')}>Request</TableHeader>
          <TableHeader className={PINNED}>Status</TableHeader>
          <TableHeader className={clsx(PINNED, 'text-right')}>Size</TableHeader>
          <TableHeader className={clsx(PINNED, 'text-right')}>Took</TableHeader>
          <TableHeader className={PINNED}>Answered by</TableHeader>
          <TableHeader className={clsx(PINNED, 'w-0')}>
            <span className="sr-only">Actions</span>
          </TableHeader>
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map((call) => (
          <TrafficRow key={call.seq} call={call} selected={call.seq === selected} actions={actions} />
        ))}
      </TableBody>
    </Table>
  )
}
