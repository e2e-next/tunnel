/**
 * The mode switch and the recording toggle. Neither belongs to a page: both
 * describe the whole run, so they live in the sidebar under "This run" and stay
 * readable from wherever you are. Replay is the mode that can silently refuse
 * calls, so the count of what it refused rides along with it.
 */
import { CheckIcon, ChevronDownIcon } from '@heroicons/react/16/solid'
import { ArrowPathIcon, SignalIcon } from '@heroicons/react/20/solid'
import { Badge } from '../../components/badge'
import {
  Dropdown, DropdownButton, DropdownDescription, DropdownDivider, DropdownItem,
  DropdownLabel, DropdownMenu,
} from '../../components/dropdown'
import { SidebarItem, SidebarLabel } from '../../components/sidebar'
import { useSessions } from '../session/use-sessions'
import { useRun } from './use-run'

export function ModeSwitch() {
  const { replaying, unmatchedCount, setMode } = useRun()
  const showCount = replaying && unmatchedCount > 0

  return (
    <Dropdown>
      <DropdownButton as={SidebarItem}>
        <SignalIcon />
        <SidebarLabel>{replaying ? 'Replay' : 'Live'}</SidebarLabel>
        {showCount && <Badge color="amber" className="ml-auto">{unmatchedCount} unmatched</Badge>}
        <ChevronDownIcon className={showCount ? '' : 'ml-auto'} />
      </DropdownButton>
      <DropdownMenu className="min-w-80" anchor="bottom start">
        <DropdownItem onClick={() => setMode('passthrough')}>
          {!replaying ? <CheckIcon /> : <span data-slot="icon" className="size-4" />}
          <DropdownLabel>Live</DropdownLabel>
          <DropdownDescription>Endpoints without a rule reach the real server.</DropdownDescription>
        </DropdownItem>
        <DropdownItem onClick={() => setMode('replay')}>
          {replaying ? <CheckIcon /> : <span data-slot="icon" className="size-4" />}
          <DropdownLabel>Replay</DropdownLabel>
          <DropdownDescription>
            Endpoints without a rule answer from this session's recordings, and anything
            unrecorded is refused.
          </DropdownDescription>
        </DropdownItem>
        {showCount && (
          <>
            <DropdownDivider />
            <DropdownItem href="#/traffic?unmatched=1">
              <DropdownLabel>Show {unmatchedCount} unmatched calls</DropdownLabel>
            </DropdownItem>
          </>
        )}
      </DropdownMenu>
    </Dropdown>
  )
}

export function RecordingToggle() {
  const { recording, toggleRecording } = useRun()
  const { current } = useSessions()

  return (
    <SidebarItem onClick={() => toggleRecording()}>
      {recording.active ? (
        <span
          data-slot="icon"
          aria-hidden="true"
          className="size-5 animate-pulse self-center rounded-full bg-rose-500 p-1.5"
        />
      ) : (
        <ArrowPathIcon />
      )}
      <SidebarLabel>
        {recording.active ? `Recording · ${recording.count}` : 'Start recording'}
        <span className="block text-xs/5 text-zinc-500 dark:text-zinc-400">
          into {recording.active ? recording.session : current}
        </span>
      </SidebarLabel>
    </SidebarItem>
  )
}
