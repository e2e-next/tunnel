# The panel's source

The panel at <http://127.0.0.1:8000/> is a React app, built ahead of time by
`make panel` into `assets/panel/`. This directory is the source; the
repository's own README describes what the panel *does*, page by page. This one
is for whoever changes it next.

## What is where

```
src/
  api/                 the only layer that knows a server exists
    types.ts           the admin API's shapes, field for field
    client.ts          the PanelApi interface, createHttpApi() and createFakeApi()
    http-client.ts     fetch and EventSource against /__admin__
    fake-data.ts       invented rows, in the same shapes, for offline UI work
  state/
    panel-state.tsx    the one holder of server state; hands the api and refresh() to the feature hooks
  features/            one directory per feature: its data hook next to its UI
    traffic/           use-traffic · traffic-page · traffic-filters · traffic-table · traffic-row
    exchange/          use-exchange · exchange-detail · code-block · header-list
    rules/             use-rules · rules-page · rules-table · rule-page · mock-this-dialog
      rule-form/       use-rule-draft · mode-fields · response-fields
    recordings/        recordings-page · session-page · delete-session-alert
    session/           use-sessions · session-switcher · new-session-dialog
    run/               use-run · run-controls (the mode switch and the record button)
    connect/           use-connect · connect-page · connect-step · device-steps
    settings/          use-settings · settings-page
    notifications/     use-toasts · toast-list
    palette/           use-commands · command-palette (⌘K)
  ui/                  the panel's own general parts: form-section · copy-button · empty-state · chip-list
  components/          the Catalyst kit
  shell/               app-shell · panel-sidebar · panel-navbar
  lib/                 format · media (pure functions, and one media-query hook)
  fonts/               InterVariable-latin.woff2 and its licence
  router.tsx           the hash router
tools/                 subset-inter.sh · smoke.mjs (neither is part of the build)
```

## Three rules

1. **The UI does no I/O.** `fetch` and `EventSource` appear in `api/` and
   nowhere else — `grep -rn 'fetch(\|EventSource' src` must name no file outside
   it. A component does not even call `usePanelState()` directly.
2. **A feature takes its data through its own hook.** `features/<x>/use-<x>.ts`
   selects the slice that feature needs and exposes it in that feature's own
   words. Traffic does not know rules exist; it knows the rows `use-traffic`
   hands it.
3. **Cohesion first; no pre-emptive decoupling.** What belongs to one feature
   lives in one directory, and what two features share becomes a feature of its
   own (the exchange detail is shared by Traffic and Recordings). Features do
   reference each other where the product really relates them — that is the
   result of cohesion, not a leak, and it does not want another layer of
   indirection. No package splitting, and no abstraction for a state library
   nobody has proposed.

## Running it

```bash
npm ci
TUNNEL_ADMIN=http://127.0.0.1:8020 npm run dev   # against a tunnel that is running
npm run typecheck                                # tsc --noEmit
```

`npm run dev` serves the panel from Vite and proxies `/__admin__` and `/ca.pem`
through to the tunnel named by `TUNNEL_ADMIN` (`http://127.0.0.1:8000` when it
is unset). It talks to the real server, in dev as in the build: pointing it at a
running tunnel is the only way to see the panel work.

`VITE_FAKE=1 npm run dev` swaps in `api/fake-data.ts` instead, for shaping UI
with no server. That path is dev-only by construction — the condition in
`main.tsx` tests `import.meta.env.DEV`, which the build replaces with `false`, so
the fake rows are dropped from the bundle rather than shipped inside it.

## Building it

`make panel` (from the repository root) runs `npm ci && npm run build`, and Vite
writes three files straight into the directory the npm package ships:

```
assets/panel/panel.js
assets/panel/panel.css
assets/panel/panel-InterVariable-latin.woff2
```

**Those three are committed.** A local mock server that fetched its own panel
over the network would contradict itself, and `npm install -g tunnel-use` must not
need a build or a network. So the build is part of the change that caused it: run
`make panel` and commit what it wrote. `make panel-check` type-checks the
sources and then rebuilds into a temporary directory and compares — the build is
byte-reproducible, so a mismatch means the committed files are stale, not that
the comparison is flaky. `make panel-smoke` opens every page in the installed
Chrome against a throwaway server and fails on anything the browser logged; it
needs Playwright (`npm i --no-save playwright`), which is why it is not part of
`make test`.

Names are fixed and unhashed, `cssCodeSplit` is off and `assetsInlineLimit` is
`0`, so the output is always those three files and the font stays a real file
rather than a base64 blob.

## The font

`src/fonts/InterVariable-latin.woff2` is **Inter Variable 4.001**
(`git-9221beed3`), copyright The Inter Project Authors, under the **SIL Open
Font License 1.1** — the licence text sits next to it in `src/fonts/OFL.txt`,
which is all redistribution asks for.

Catalyst's look is built on Inter, and the kit's own demo fetches it from
`rsms.me`, which the offline promise rules out. So the font is carried here,
subset to latin: 352 KB down to 105 KB, both variable axes (opsz 14–32,
wght 100–900) and the `cv11` feature Catalyst asks for all kept.
`tools/subset-inter.sh` is the one command that produced it, from the official
release at <https://github.com/rsms/inter/releases> rather than a copy inside
some template — anyone can fetch the same input, and the licence chain stays
plainly OFL. It is deliberately **not** wired into the build: it needs
fonttools, and the build must not need Python.

## Catalyst

`src/components/` is the Catalyst kit, copied in. Treat it as this app's code,
not as a vendored library to be upgraded: change a component when the product
needs it. Two are already changed on purpose, each with a comment saying why:

- `link.tsx` — the kit leaves a TODO for your router; this is the hash router's
  plain `<a>`.
- `sidebar-layout.tsx` — the kit hard-codes `p-10` and `mx-auto max-w-6xl` into
  the content card. Both are handed to each page instead, and the shell is held
  to one screen, because Traffic needs a full-width list with a detail column
  beside it and the list has to scroll inside the card rather than scrolling the
  page.
