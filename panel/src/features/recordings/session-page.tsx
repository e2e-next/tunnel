/**
 * One session: what it holds, and the three things done to it. A recorded call
 * opens in the same detail view Traffic uses, so what was captured and what
 * happened live are read the same way.
 */
import { ArchiveBoxXMarkIcon, FilmIcon } from '@heroicons/react/24/outline'
import { useState } from 'react'
import { Badge } from '../../components/badge'
import { Button } from '../../components/button'
import { Dialog, DialogBody } from '../../components/dialog'
import { Divider } from '../../components/divider'
import { Heading } from '../../components/heading'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/table'
import { Text } from '../../components/text'
import { bytes, clock, relative, splitKey, statusColor } from '../../lib/format'
import { go } from '../../router'
import { EmptyState } from '../../ui/empty-state'
import { ExchangeDetail } from '../exchange/exchange-detail'
import { useExchange } from '../exchange/use-exchange'
import { useRun } from '../run/use-run'
import { useSessions } from '../session/use-sessions'
import { DeleteSessionAlert } from './delete-session-alert'

export function SessionPage({ param }: { param: string }) {
  const { recordings, current, recordingInto, countOf, use, remove } = useSessions()
  const { toggleRecording } = useRun()
  const [open, setOpen] = useState<number | null>(null)
  const [deleting, setDeleting] = useState(false)
  // The session, because these seq numbers are the session's own.
  const { exchange, missing } = useExchange(open, param)

  const rows = recordings[param] ?? []
  const isCurrent = param === current
  const isRecording = recordingInto === param
  const last = rows[rows.length - 1]

  return (
    <>
      <div className="max-lg:hidden">
        <a
          href="#/recordings"
          className="inline-flex items-center gap-2 text-sm/6 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
        >
          <span aria-hidden="true">‹</span> Recordings
        </a>
      </div>

      <div className="mt-4 flex flex-wrap items-end justify-between gap-4 lg:mt-8">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <Heading className="!font-mono">{param}</Heading>
            {isCurrent && <Badge color="lime">Current</Badge>}
            {isRecording && <Badge color="rose">Recording</Badge>}
          </div>
          <Text className="!mt-1 !text-sm/6">
            {rows.length} recording{rows.length === 1 ? '' : 's'}
            {last && ` · last ${relative(last.time)}`}
          </Text>
        </div>
        <div className="flex flex-wrap gap-3">
          {!isCurrent && <Button outline onClick={() => use(param)}>Use for this run</Button>}
          {isRecording ? (
            <Button color="red" onClick={() => toggleRecording(param)}>Stop recording</Button>
          ) : (
            <Button onClick={() => toggleRecording(param)}>Record into this session</Button>
          )}
          <Button plain onClick={() => setDeleting(true)}>Delete</Button>
        </div>
      </div>

      <Divider className="my-10" />

      {rows.length === 0 ? (
        <EmptyState
          icon={FilmIcon}
          title={`Nothing recorded into ${param} yet`}
          action={{ label: 'Record into this session', onClick: () => toggleRecording(param) }}
        >
          Start recording, then drive the app so its calls reach the real server. What comes
          back is written here.
        </EmptyState>
      ) : (
        <Table dense className="[--gutter:--spacing(6)] lg:[--gutter:--spacing(10)]">
          <TableHead>
            <TableRow>
              <TableHeader>Time</TableHeader>
              <TableHeader>Method</TableHeader>
              <TableHeader className="w-full">Request</TableHeader>
              <TableHeader>Status</TableHeader>
              <TableHeader className="text-right">Size</TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row) => {
              const { method, host, path } = splitKey(row.key)
              const query = new URLSearchParams(row.query).toString()
              return (
                <TableRow key={row.seq} className="cursor-pointer" onClick={() => setOpen(row.seq)}>
                  <TableCell className="tabular-nums text-zinc-500">{clock(row.time)}</TableCell>
                  <TableCell>
                    <Badge color="zinc" className="!font-mono !text-[0.6875rem]">{method}</Badge>
                  </TableCell>
                  <TableCell className="max-w-0">
                    <div className="truncate font-mono text-xs/5 text-zinc-950 dark:text-white">
                      {path}
                      {query && <span className="text-zinc-400">?{query}</span>}
                    </div>
                    <div className="truncate text-xs/5 text-zinc-500">{host}</div>
                  </TableCell>
                  <TableCell><Badge color={statusColor(row.status)}>{row.status}</Badge></TableCell>
                  <TableCell className="text-right tabular-nums text-zinc-500">{bytes(row.size)}</TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}

      {/* Opened, and either there or not: a row the server cannot answer for
          leaves the dialog open and says so, because a click that renders
          nothing reads as a panel that has stopped working. */}
      {(exchange || missing) && (
        <Dialog open onClose={() => setOpen(null)} size="3xl">
          <DialogBody className="!mt-0 -m-6">
            {exchange ? (
              <ExchangeDetail exchange={exchange} onClose={() => setOpen(null)} />
            ) : (
              <EmptyState
                icon={ArchiveBoxXMarkIcon}
                title="That recording is gone"
                action={{ label: 'Close', onClick: () => setOpen(null) }}
              >
                {param} no longer holds this recording. It may have been deleted since this
                list was read.
              </EmptyState>
            )}
          </DialogBody>
        </Dialog>
      )}

      <DeleteSessionAlert
        name={deleting ? param : null}
        count={countOf(param)}
        isCurrent={isCurrent}
        onConfirm={() => { remove(param); go('/recordings') }}
        onClose={() => setDeleting(false)}
      />
    </>
  )
}
