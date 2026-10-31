/**
 * The shell, and which feature the fragment points at.
 *
 * Traffic lays out its own full-width list and detail column, so it takes the
 * card whole; the other four sit in the centred column the rest of the panel
 * reads in. Each page owns its padding and its scrolling, because only the page
 * knows whether it scrolls as a document or as a list inside a frame.
 */
import { SidebarLayout } from '../components/sidebar-layout'
import { ConnectPage } from '../features/connect/connect-page'
import { ToastList } from '../features/notifications/toast-list'
import { CommandPalette } from '../features/palette/command-palette'
import { RecordingsPage } from '../features/recordings/recordings-page'
import { SessionPage } from '../features/recordings/session-page'
import { RulePage } from '../features/rules/rule-page'
import { RulesPage } from '../features/rules/rules-page'
import { SettingsPage } from '../features/settings/settings-page'
import { TrafficPage } from '../features/traffic/traffic-page'
import { useRoute, type Route } from '../router'
import { PanelNavbar } from './panel-navbar'
import { PanelSidebar } from './panel-sidebar'

/** The centred column the reading pages share. */
function Page({ width = 'max-w-6xl', children }: { width?: string; children: React.ReactNode }) {
  return <div className={`mx-auto w-full ${width} overflow-y-auto p-6 lg:p-10`}>{children}</div>
}

function CurrentPage({ route }: { route: Route }) {
  switch (route.page) {
    case 'traffic':
      return <TrafficPage route={route} />
    case 'rules':
      return <Page>{route.param ? <RulePage param={route.param} /> : <RulesPage />}</Page>
    case 'recordings':
      return (
        <Page>{route.param ? <SessionPage param={route.param} /> : <RecordingsPage />}</Page>
      )
    case 'connect':
      return <Page width="max-w-4xl"><ConnectPage /></Page>
    case 'settings':
      return <Page width="max-w-4xl"><SettingsPage /></Page>
  }
}

export function AppShell() {
  const route = useRoute()
  return (
    <>
      <SidebarLayout navbar={<PanelNavbar />} sidebar={<PanelSidebar route={route} />}>
        <CurrentPage route={route} />
      </SidebarLayout>
      <CommandPalette />
      <ToastList />
    </>
  )
}
