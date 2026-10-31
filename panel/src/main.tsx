import { createRoot } from 'react-dom/client'
import { createFakeApi, createHttpApi } from './api/client'
import { ToastProvider } from './features/notifications/use-toasts'
import { AppShell } from './shell/app-shell'
import { PanelStateProvider } from './state/panel-state'
import './index.css'

/**
 * Built once, here, for the life of the page: an api built in render would be a
 * new object every time, and the effects that depend on it never settle (spec §17.2).
 *
 * The panel talks to the real server in dev as well as in the build — pointing
 * `npm run dev` at a running tunnel is the only way to see it work, and a build
 * that could quietly fall back to invented rows would be worse than a blank page.
 * `VITE_FAKE=1 npm run dev` brings back the prototype's rows for UI work offline.
 *
 * The `DEV` half is what keeps the fake rows out of what ships. It is a constant
 * the build replaces with `false`, so the whole condition folds away and the fake
 * api and its rows are dropped from the bundle — otherwise a released panel.js
 * carries a made-up feed, an invented account and a string shaped like a bearer
 * token, which is both dead weight and the sort of thing a secret scanner stops on.
 */
const api = import.meta.env.DEV && import.meta.env.VITE_FAKE ? createFakeApi() : createHttpApi()

createRoot(document.getElementById('panel')!).render(
  <ToastProvider>
    <PanelStateProvider api={api}>
      <AppShell />
    </PanelStateProvider>
  </ToastProvider>
)
