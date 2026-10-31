// The admin port, assembled: adminRouter is the JSON management
// API used by the CLI and by automated tests, /ca.pem hands out the CA certificate, and the panel
// page lives at /. No traffic is answered here: that is the proxy port's job, through TunnelCore.
import { once } from 'node:events'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { createAdaptorServer } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { adminRouter, type AdminDeps, type AdminOptions } from './admin.ts'
import { getLogger } from './log.ts'
import type { TunnelConfig } from './models.ts'
import { PANEL_STATIC_DIR, VERSION } from './package-info.ts'

const log = getLogger('app')

/** How long close() waits for the requests it is already holding before it drops them. It has to
 *  be bounded: the panel keeps an event stream open and `tunnel wait` keeps a long poll open, and a
 *  server left to itself waits for both to end, so a SIGTERM would never finish the process */
export const GRACEFUL_SHUTDOWN_MS = 3_000

/** The whole admin port as a Hono app: adminRouter, the panel page at /, the built panel under /static/, and
 *  the 404 / 405 / 500 answers. Pure: opens no socket, reads no environment */
export function createAdminApp(deps: AdminDeps, options?: AdminOptions): Hono {
  const app = new Hono()
  app.route('/', adminRouter(deps, options))
  // Any method but GET and HEAD is a 405 that names none, before the file is looked for.
  // serveStatic takes every method for a GET, and an OPTIONS for a HEAD: the file's length and no
  // body, which leaves a client waiting for one
  app.use('/static/*', async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') return next()
    return c.json({ detail: 'Method Not Allowed' }, 405)
  })
  // The built panel, found by the package's path rather than the working directory, so an
  // installed tunnel serves it too. A file that is not there, a directory, and a path that would
  // climb out with .. or hide it in a % escape all go on to the 404 below
  app.use(
    '/static/*',
    serveStatic({
      root: PANEL_STATIC_DIR,
      rewriteRequestPath: (path) => path.replace(/^\/static/, ''),
    }),
  )
  /**
   * The management panel: the shell page the built panel mounts into.
   *
   * It sits on the admin port, which is bound to the loopback address: the panel
   * edits scripts that run on this machine. Clients reach tunnel through the
   * proxy port instead, and never see any of this.
   *
   * The page carries one JSON object for the panel to start from. Everything in
   * it is read again over /__admin__ once the script runs, so it is a head start
   * and not a second source of truth.
   */
  app.get('/', (c) => {
    // The panel pulls the rules when it needs them
    const { request_configs, ...config } = deps.manager.getConfig()
    return c.html(
      shellPage({
        config,
        // The panel is where a human picks the certificate up, and the
        // fingerprint is what a device shows to be checked against.
        ca_fingerprint: deps.ca.fingerprint(),
      }),
    )
  })
  // Any other method on /: a 405, naming GET. A HEAD is not one of them: Hono answers it from the
  // GET above, without the body
  app.all('/', (c) => c.json({ detail: 'Method Not Allowed' }, 405, { allow: 'GET' }))
  // The answer for a path nothing is at; a method a path does not have is adminRouter's 405
  app.notFound((c) => c.json({ detail: 'Not Found' }, 404))
  app.onError((error, c) => {
    // Hono's own, should one ever be thrown on the way to a route: its status and its sentence
    if (error instanceof HTTPException) return c.json({ detail: error.message }, error.status)
    // A bug: the caller gets a plain 500, the log gets the stack
    log.error(`${c.req.method} ${c.req.path} failed: ${error.stack ?? error}`)
    return c.text('Internal Server Error', 500)
  })
  return app
}

/** The page the panel boots from, with the bootstrap JSON and the fingerprint filled in */
export function shellPage(bootstrap: {
  config: Omit<TunnelConfig, 'request_configs'>
  ca_fingerprint: string
}): string {
  return `<!DOCTYPE html>
<html lang="en" class="text-zinc-950 antialiased lg:bg-zinc-100">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <!-- No icon to fetch: the browser would ask for /favicon.ico and log the 404 -->
    <link rel="icon" href="data:,">
    <title>tunnel</title>
    <link href="/static/panel.css" rel="stylesheet">
</head>
<body>
<div id="panel"></div>
<!-- The panel's head start: the settings this server is running with, so the
     first paint does not wait for a round trip whose answer is already here,
     and the fingerprint a device is checked against. escapeForScript writes <, >
     and & as \\u sequences, so no value in here can end this element early. -->
<script type="application/json" id="bootstrap">${escapeForScript(JSON.stringify(bootstrap))}</script>
<script type="module" src="/static/panel.js"></script>
<noscript>
    <!-- The panel is a script; the certificate is the one thing worth having without it -->
    <p>The panel needs JavaScript. To install the certificate:
        <a href="/ca.pem">ca.pem</a>, fingerprint ${bootstrap.ca_fingerprint}</p>
</noscript>
</body>
</html>`
}

/** <, >, & and ' each written as a \u escape, which JSON.parse reads back as the character it was.
 *  JSON.stringify leaves all four as they are, and then a </script> in a string would end the
 *  element early, and a <!-- would change how the browser looks for its end */
function escapeForScript(json: string): string {
  return json
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll("'", '\\u0027')
}

export interface StartOptions {
  port: number // 0 in tests; `tunnel serve --admin-port` otherwise
  heartbeatMs?: number
  graceMs?: number // default GRACEFUL_SHUTDOWN_MS
}

export interface AdminServer {
  readonly port: number // the one actually bound (server.address().port)
  readonly server: Server
  /** The app the server answers with, for a caller in this process to fetch from as well (the
   *  library, src/index.ts): close() ends that caller's waits as it ends the port's */
  readonly app: Hono
  /** Ends the event streams and waits, stops accepting, gives the rest graceMs, cuts what is left, closes the core,
   *  logs "tunnel stopped". Resolves within graceMs plus a few tens of ms. A second call returns the first call's promise */
  close(): Promise<void>
}

/** ca.ensure(), then listen on 127.0.0.1:<port> (rejects with Node's error, e.g. EADDRINUSE, when it cannot), then the
 *  startup line: "tunnel <version> starting\n  config: …\n  state:  …\n  data:   …\n  CA:     <fingerprint>" */
export async function startAdminServer(
  deps: AdminDeps,
  options: StartOptions,
): Promise<AdminServer> {
  // Generated here rather than on the first CONNECT: a device that installs
  // the certificate before any traffic flows gets the one this server signs
  // with, and generating a key mid-handshake would stall it.
  deps.ca.ensure()
  const closing = new AbortController()
  const app = createAdminApp(deps, { heartbeatMs: options.heartbeatMs, closing: closing.signal })
  // Not listening yet, so the listening is this function's to wait for. Request and Response stay
  // Node's own rather than node-server's faster stand-ins: this is a quiet port on the loopback, and
  // app.request() in the same process works with the standard ones. Given no createServer, the
  // server is node:http's, of the three kinds createAdaptorServer's type allows for
  const server = createAdaptorServer({ fetch: app.fetch, overrideGlobalObjects: false }) as Server
  // server.close() closes the connections idle when it is called, and never looks again. One kept
  // alive (a browser's EventSource, the CLI's fetch) that is still answering then goes idle a
  // little later: an event stream or a wait a tick or two after closing.abort(), a request still
  // being answered once it has been. Left alone it would sit idle until the grace was up, so once
  // closing has begun, every answer that goes out closes the connections idle by then, its own
  // among them, on the next turn of the event loop, once Node has finished with it
  server.on('request', (_request, response) => {
    response.once('finish', () => {
      if (closing.signal.aborted) setImmediate(() => server.closeIdleConnections())
    })
  })
  server.listen({ host: '127.0.0.1', port: options.port })
  // An 'error' meanwhile, EADDRINUSE say, rejects with that error as it is
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  const { paths } = deps.manager
  log.info(
    `tunnel ${VERSION} starting\n  config: ${paths.config_dir}\n  state:  ${paths.state_dir}\n` +
      `  data:   ${paths.data_dir}\n  CA:     ${deps.ca.fingerprint()}`,
  )

  const graceMs = options.graceMs ?? GRACEFUL_SHUTDOWN_MS
  const shutDown = async (): Promise<void> => {
    // Every event stream ends and every wait answers 503, each within a tick or two, and each
    // connection is closed once its answer is out (the 'finish' listener above)
    closing.abort()
    // No new connections, and the idle ones closed now; the callback comes once the rest are closed
    const settled = new Promise<void>((resolve) => server.close(() => resolve()))
    // The rest get graceMs: a request still being answered, a large import say. The timer alone
    // does not hold the process
    await Promise.race([settled, sleep(graceMs, undefined, { ref: false })])
    // Then they are cut off
    server.closeAllConnections()
    await settled
    await deps.core.close()
    log.info('tunnel stopped')
  }
  let closed: Promise<void> | undefined
  return { port, server, app, close: () => (closed ??= shutDown()) }
}
