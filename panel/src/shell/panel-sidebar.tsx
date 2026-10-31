/**
 * The sidebar is the panel's spine: the five pages, and everything that is true
 * of the whole run rather than of one page. Each of those globals is a feature
 * component, so this file is only the arrangement and the reasons for it.
 */
import { ChevronDownIcon } from '@heroicons/react/16/solid'
import {
  ArrowDownTrayIcon, BoltIcon, BookOpenIcon, ClipboardIcon, Cog6ToothIcon,
  DevicePhoneMobileIcon, FilmIcon, QueueListIcon,
} from '@heroicons/react/20/solid'
import {
  Dropdown, DropdownButton, DropdownDivider, DropdownItem, DropdownLabel, DropdownMenu,
} from '../components/dropdown'
import {
  Sidebar, SidebarBody, SidebarFooter, SidebarHeader, SidebarHeading, SidebarItem,
  SidebarLabel, SidebarSection, SidebarSpacer,
} from '../components/sidebar'
import { useToasts } from '../features/notifications/use-toasts'
import { ModeSwitch, RecordingToggle } from '../features/run/run-controls'
import { useRun } from '../features/run/use-run'
import { SessionSwitcher } from '../features/session/session-switcher'
import type { Route } from '../router'

export function PanelSidebar({ route }: { route: Route }) {
  return (
    <Sidebar>
      <SidebarHeader>
        <SessionSwitcher />
      </SidebarHeader>

      <SidebarBody>
        {/* The three pages a test run keeps coming back to. */}
        <SidebarSection>
          <SidebarItem href="#/traffic" current={route.page === 'traffic'}>
            <QueueListIcon />
            <SidebarLabel>Traffic</SidebarLabel>
          </SidebarItem>
          <SidebarItem href="#/rules" current={route.page === 'rules'}>
            <BoltIcon />
            <SidebarLabel>Rules</SidebarLabel>
          </SidebarItem>
          <SidebarItem href="#/recordings" current={route.page === 'recordings'}>
            <FilmIcon />
            <SidebarLabel>Recordings</SidebarLabel>
          </SidebarItem>
        </SidebarSection>

        {/* The switches that belong to no page. */}
        <SidebarSection>
          <SidebarHeading>This run</SidebarHeading>
          <ModeSwitch />
          <RecordingToggle />
        </SidebarSection>

        <SidebarSpacer />

        {/* Set up once, then rarely opened. */}
        <SidebarSection>
          <SidebarItem href="#/connect" current={route.page === 'connect'}>
            <DevicePhoneMobileIcon />
            <SidebarLabel>Connect a device</SidebarLabel>
          </SidebarItem>
          <SidebarItem href="#/settings" current={route.page === 'settings'}>
            <Cog6ToothIcon />
            <SidebarLabel>Settings</SidebarLabel>
          </SidebarItem>
        </SidebarSection>
      </SidebarBody>

      <SidebarFooter className="max-lg:hidden">
        <ServerStatus />
      </SidebarFooter>
    </Sidebar>
  )
}

/**
 * The server's identity, where Catalyst puts the account: is it still talking to
 * us, what version, and the address a device needs. The panel goes quiet rather
 * than wrong when the event stream drops, so the dot has to be on screen.
 */
function ServerStatus() {
  const { connected, version, proxy } = useRun()
  const { notify } = useToasts()
  const address = proxy ? `${proxy.lan_ips[0]}:${proxy.port}` : 'proxy off'

  return (
    <Dropdown>
      <DropdownButton as={SidebarItem}>
        <span
          data-slot="icon"
          aria-hidden="true"
          className={`size-5 self-center rounded-full p-1.5 ${connected ? 'bg-lime-500' : 'bg-zinc-400'}`}
        />
        <SidebarLabel>
          tunnel {version}
          <span className="block font-mono text-xs/5 text-zinc-500 dark:text-zinc-400">
            {connected ? address : 'reconnecting…'}
          </span>
        </SidebarLabel>
        <ChevronDownIcon className="ml-auto" />
      </DropdownButton>
      <DropdownMenu className="min-w-64" anchor="top start">
        <DropdownItem
          onClick={() => {
            navigator.clipboard?.writeText(address).catch(() => {})
            notify({ tone: 'success', title: 'Proxy address copied' })
          }}
        >
          <ClipboardIcon />
          <DropdownLabel>Copy proxy address</DropdownLabel>
        </DropdownItem>
        <DropdownItem href="/ca.pem">
          <ArrowDownTrayIcon />
          <DropdownLabel>Download ca.pem</DropdownLabel>
        </DropdownItem>
        <DropdownDivider />
        <DropdownItem href="#/connect">
          <BookOpenIcon />
          <DropdownLabel>How to connect a device</DropdownLabel>
        </DropdownItem>
      </DropdownMenu>
    </Dropdown>
  )
}
