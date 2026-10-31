/**
 * The session switcher sits where Catalyst puts the workspace switcher, because
 * that is what a session is: the scope everything in this run is written to and
 * read from. Switching is one click from anywhere, and the current name is
 * always on screen.
 */
import { CheckIcon, ChevronDownIcon, PlusIcon } from '@heroicons/react/16/solid'
import { FilmIcon } from '@heroicons/react/20/solid'
import { useState } from 'react'
import { Avatar } from '../../components/avatar'
import {
  Dropdown, DropdownButton, DropdownDescription, DropdownDivider, DropdownItem,
  DropdownLabel, DropdownMenu,
} from '../../components/dropdown'
import { SidebarItem, SidebarLabel } from '../../components/sidebar'
import { NewSessionDialog } from './new-session-dialog'
import { useSessions } from './use-sessions'

export function SessionSwitcher() {
  const { current, sessions, countOf, use } = useSessions()
  const [creating, setCreating] = useState(false)

  return (
    <>
      <Dropdown>
        <DropdownButton as={SidebarItem}>
          <Avatar square initials={current.slice(0, 2)} className="size-6 bg-purple-500 text-white" />
          <SidebarLabel>{current}</SidebarLabel>
          <ChevronDownIcon />
        </DropdownButton>
        <DropdownMenu className="min-w-72" anchor="bottom start">
          {Object.keys(sessions).map((name) => {
            const count = countOf(name)
            return (
              <DropdownItem key={name} onClick={() => use(name)}>
                {name === current ? <CheckIcon /> : <span data-slot="icon" className="size-4" />}
                <DropdownLabel>{name}</DropdownLabel>
                <DropdownDescription>
                  {count === 0 ? 'Nothing recorded' : `${count} recording${count === 1 ? '' : 's'}`}
                </DropdownDescription>
              </DropdownItem>
            )
          })}
          <DropdownDivider />
          <DropdownItem onClick={() => setCreating(true)}>
            <PlusIcon />
            <DropdownLabel>New session…</DropdownLabel>
          </DropdownItem>
          <DropdownItem href="#/recordings">
            <FilmIcon />
            <DropdownLabel>Manage sessions</DropdownLabel>
          </DropdownItem>
        </DropdownMenu>
      </Dropdown>
      <NewSessionDialog open={creating} onClose={() => setCreating(false)} />
    </>
  )
}
