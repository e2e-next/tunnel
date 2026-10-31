/** The sessions, and how much each one holds. */
import { EllipsisVerticalIcon } from '@heroicons/react/16/solid'
import { useState } from 'react'
import { Badge } from '../../components/badge'
import { Button } from '../../components/button'
import { Dropdown, DropdownButton, DropdownItem, DropdownLabel, DropdownMenu } from '../../components/dropdown'
import { Heading } from '../../components/heading'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/table'
import { Code, Text } from '../../components/text'
import { relative } from '../../lib/format'
import { go } from '../../router'
import { NewSessionDialog } from '../session/new-session-dialog'
import { useSessions } from '../session/use-sessions'
import { useRun } from '../run/use-run'
import { DeleteSessionAlert } from './delete-session-alert'

export function RecordingsPage() {
  const { sessions, recordings, current, recordingInto, countOf, use, remove } = useSessions()
  const { toggleRecording } = useRun()
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Heading>Recordings</Heading>
          <Text className="!mt-1 !text-sm/6">
            What the real server said, kept per session so replay can hand it back
          </Text>
        </div>
        <Button onClick={() => setCreating(true)}>New session</Button>
      </div>

      <Table className="mt-8 [--gutter:--spacing(6)] lg:[--gutter:--spacing(10)]">
        <TableHead>
          <TableRow>
            <TableHeader className="w-full">Session</TableHeader>
            <TableHeader className="text-right">Recordings</TableHeader>
            <TableHeader>Last recorded</TableHeader>
            <TableHeader className="w-0"><span className="sr-only">Actions</span></TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          {Object.keys(sessions).map((name) => {
            const rows = recordings[name] ?? []
            const last = rows[rows.length - 1]
            const isCurrent = name === current
            const isRecording = recordingInto === name
            return (
              <TableRow
                key={name}
                className="cursor-pointer"
                onClick={() => go(`/recordings/${encodeURIComponent(name)}`)}
              >
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm/6 text-zinc-950 dark:text-white">{name}</span>
                    {isCurrent && <Badge color="lime">Current</Badge>}
                    {isRecording && <Badge color="rose">Recording</Badge>}
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums text-zinc-500">{countOf(name)}</TableCell>
                <TableCell className="text-zinc-500">{last ? relative(last.time) : '—'}</TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <Dropdown>
                    <DropdownButton plain aria-label="Actions" className="!-my-1.5 !px-1">
                      <EllipsisVerticalIcon />
                    </DropdownButton>
                    <DropdownMenu anchor="bottom end">
                      {!isCurrent && (
                        <DropdownItem onClick={() => use(name)}>
                          <DropdownLabel>Use for this run</DropdownLabel>
                        </DropdownItem>
                      )}
                      <DropdownItem onClick={() => toggleRecording(name)}>
                        <DropdownLabel>
                          {isRecording ? 'Stop recording' : 'Record into this session'}
                        </DropdownLabel>
                      </DropdownItem>
                      <DropdownItem onClick={() => setDeleting(name)}>
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

      <Text className="!mt-8 !text-xs/6 text-zinc-500">
        A session moves between machines through the CLI:{' '}
        <Code className="!text-xs">tunnel export --session acct_a</Code> and{' '}
        <Code className="!text-xs">tunnel import acct_a.zip</Code>.
      </Text>

      <NewSessionDialog open={creating} onClose={() => setCreating(false)} />
      <DeleteSessionAlert
        name={deleting}
        count={deleting ? countOf(deleting) : 0}
        isCurrent={deleting === current}
        onConfirm={() => deleting && remove(deleting)}
        onClose={() => setDeleting(null)}
      />
    </>
  )
}
