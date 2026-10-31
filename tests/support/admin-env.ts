// makeAdminEnv(t): the admin port in process, for the tests of the admin API, the event stream, the
// long poll and the panel: a config manager over a temporary directory, a core over that whose
// passthrough reaches a stand-in rather than a network, a CA, and the admin app over the three. The
// app is handed its services, and app.request() drives it, which opens no socket. adminClient(app)
// hands back each answer already read, with status, text and json(). startAdminEnv(t) is the
// same services on a real socket, for the few tests of what only exists past @hono/node-server.
import type { TestContext } from 'node:test'
import type { Hono } from 'hono'
import {
  createAdminApp,
  startAdminServer,
  type AdminServer,
  type StartOptions,
} from '../../src/app.ts'
import { CertificateAuthority } from '../../src/certs.ts'
import { Paths, TunnelConfigManager } from '../../src/config.ts'
import { TunnelCore } from '../../src/core.ts'
import {
  makeRequest,
  type Request as TunnelRequest,
  type Response as TunnelResponse,
} from '../../src/messages.ts'
import type { UpstreamRoutes } from '../../src/upstream-route.ts'
import type { UpstreamRequest, UpstreamResponse } from '../../src/upstream.ts'
import { fakeUpstream, jsonAnswer } from './fake-upstream.ts'
import { testRoutes } from './routes.ts'
import { tmpDir } from './tmp.ts'

/** Query parameters as a test writes them: a list is the parameter repeated, once per item */
export type Params = Record<string, string | number | readonly string[]>

/** An answer whose body has been read by the time it is handed back, so json() is synchronous */
export interface AdminResponse {
  status: number
  text: string
  json(): any
}

/** get, post, patch and delete, over app.request() */
export interface AdminClient {
  get(path: string, options?: { params?: Params }): Promise<AdminResponse>
  post(path: string, options?: { json?: unknown }): Promise<AdminResponse>
  patch(path: string, options?: { json?: unknown }): Promise<AdminResponse>
  delete(path: string, options?: { params?: Params }): Promise<AdminResponse>
}

export interface AdminEnv {
  manager: TunnelConfigManager
  core: TunnelCore
  ca: CertificateAuthority
  app: Hono
  /** What a server's close() aborts, for the tests of how it ends what it is holding open */
  closing: AbortController
  /** app.request(path, init) */
  fetch(path: string, init?: RequestInit): Promise<Response>
  /** The body, when given, sent as JSON; the answer's status and its body parsed as JSON */
  json(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }>
  /** One request through the core, as the proxy port asks it: GET / on api.example.com unless
   *  told otherwise */
  send(fields?: Partial<TunnelRequest>): Promise<TunnelResponse>
  client: AdminClient
}

/** One request, made with app.request(), and its answer read to the end */
async function call(
  app: Hono,
  method: string,
  path: string,
  options: { params?: Params; json?: unknown },
): Promise<AdminResponse> {
  const params = new URLSearchParams()
  for (const [name, value] of Object.entries(options.params ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) params.append(name, String(item))
  }
  const query = params.toString()
  const init: RequestInit = { method }
  if (options.json !== undefined) {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(options.json)
  }
  const response = await app.request(query === '' ? path : `${path}?${query}`, init)
  const text = await response.text()
  return { status: response.status, text, json: () => JSON.parse(text) }
}

/** A client over the app, whose answers are read as (await env.client.get(path)).status */
export function adminClient(app: Hono): AdminClient {
  return {
    get: (path, options = {}) => call(app, 'GET', path, options),
    post: (path, options = {}) => call(app, 'POST', path, options),
    patch: (path, options = {}) => call(app, 'PATCH', path, options),
    delete: (path, options = {}) => call(app, 'DELETE', path, options),
  }
}

/**
 * The admin app over a fresh configuration in a directory of its own, and what it works on.
 *
 * upstream is what answers a passthrough, 200 {"upstream": <url>} unless given (admin-api.test.ts's
 * answers 599). routes are what health describes, testRoutes() unless given: real ones would read
 * the developer's proxy variables and run scutil. heartbeatMs is the event stream's keep-alive
 * interval.
 */
export async function makeAdminEnv(
  t: TestContext,
  options: {
    upstream?: (request: UpstreamRequest) => UpstreamResponse
    heartbeatMs?: number
    routes?: UpstreamRoutes
  } = {},
): Promise<AdminEnv> {
  // Added before tmpDir(t) adds the removal of the directory: t.after hooks run in the order they
  // were added, and the core's exchange log and recording store write into that directory
  // asynchronously, so their last write has to be done before it goes
  let opened: TunnelCore | undefined
  t.after(() => opened?.close())
  const manager = new TunnelConfigManager(Paths.inOneDirectory(tmpDir(t)))
  // Nothing here may reach a network: passthrough, which answers anything with no rule, goes to a
  // stand-in that reports the URL it was given
  const upstream = options.upstream ?? ((request) => jsonAnswer({ upstream: request.url }, 200))
  const core = new TunnelCore(manager, {
    upstream: fakeUpstream(upstream),
    routes: options.routes ?? testRoutes(),
  })
  opened = core
  const ca = new CertificateAuthority(manager.paths)
  const closing = new AbortController()
  const app = createAdminApp(
    { manager, core, ca },
    { heartbeatMs: options.heartbeatMs, closing: closing.signal },
  )
  return {
    manager,
    core,
    ca,
    app,
    closing,
    fetch: async (path, init) => app.request(path, init),
    json: async (method, path, body) => {
      const response = await call(app, method, path, body === undefined ? {} : { json: body })
      return { status: response.status, body: response.json() }
    },
    send: (fields = {}) =>
      core.resolve(makeRequest({ method: 'GET', path: '/', host: 'api.example.com', ...fields })),
    client: adminClient(app),
  }
}

/** The admin port on a socket, and what it works on */
export interface ServedAdminEnv {
  manager: TunnelConfigManager
  core: TunnelCore
  ca: CertificateAuthority
  admin: AdminServer
  /** http://127.0.0.1:<port>, no slash at the end */
  base: string
  /** One request through the core, as makeAdminEnv's send */
  send(fields?: Partial<TunnelRequest>): Promise<TunnelResponse>
}

/**
 * startAdminServer on 127.0.0.1 and a port of its own, over services made as makeAdminEnv makes
 * them, for the tests of what only exists past @hono/node-server: binding, shutting down, the event
 * stream's frames and the static files on the wire.
 *
 * The server's close(), which closes the core too, is added before tmpDir(t) adds the removal of
 * the directory, for the reason makeAdminEnv gives; a test that closes it itself gets the same
 * promise back from this one.
 */
export async function startAdminEnv(
  t: TestContext,
  options: Omit<StartOptions, 'port'> = {},
): Promise<ServedAdminEnv> {
  let admin: AdminServer | undefined
  t.after(() => admin?.close())
  const manager = new TunnelConfigManager(Paths.inOneDirectory(tmpDir(t)))
  const core = new TunnelCore(manager, {
    upstream: fakeUpstream((request) => jsonAnswer({ upstream: request.url }, 200)),
    routes: testRoutes(),
  })
  const ca = new CertificateAuthority(manager.paths)
  admin = await startAdminServer({ manager, core, ca }, { ...options, port: 0 })
  return {
    manager,
    core,
    ca,
    admin,
    base: `http://127.0.0.1:${admin.port}`,
    send: (fields = {}) =>
      core.resolve(makeRequest({ method: 'GET', path: '/', host: 'api.example.com', ...fields })),
  }
}
