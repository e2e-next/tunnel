/**
 * Below lg the sidebar folds into a drawer, which would hide the two switches
 * that have to stay reachable. They come back here as icons whose colour says
 * what state they are in.
 */
import { SignalIcon } from '@heroicons/react/20/solid'
import { Navbar, NavbarItem, NavbarSection, NavbarSpacer } from '../components/navbar'
import { useRun } from '../features/run/use-run'

export function PanelNavbar() {
  const { replaying, recording, setMode, toggleRecording } = useRun()

  return (
    <Navbar>
      <NavbarSpacer />
      <NavbarSection>
        <NavbarItem
          aria-label={replaying ? 'Replaying, switch to Live' : 'Live, switch to Replay'}
          onClick={() => setMode(replaying ? 'passthrough' : 'replay')}
        >
          <SignalIcon className={replaying ? 'fill-amber-500' : 'fill-lime-600'} />
        </NavbarItem>
        <NavbarItem
          aria-label={recording.active ? 'Recording, stop' : 'Start recording'}
          onClick={() => toggleRecording()}
        >
          <span
            data-slot="icon"
            aria-hidden="true"
            className={`size-4 self-center rounded-full ${
              recording.active ? 'animate-pulse bg-rose-500' : 'bg-zinc-400'
            }`}
          />
        </NavbarItem>
      </NavbarSection>
    </Navbar>
  )
}
