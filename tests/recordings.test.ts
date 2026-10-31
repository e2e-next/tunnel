// Recording: the calls that reached the real server, kept to be replayed later.
//
// Recording is a global switch over passthrough traffic, so the tests drive the
// core the way the proxy port does with a stand-in backend, then read the tree
// back — from the directory itself, through the admin API and through
// `tunnel recordings`, because those are the three things anyone uses.
import assert from 'node:assert/strict'
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createAdminApp } from '../src/app.ts'
import { CertificateAuthority } from '../src/certs.ts'
import { Paths, TunnelConfigManager } from '../src/config.ts'
import { TunnelCore } from '../src/core.ts'
import { UserError } from '../src/errors.ts'
import {
  MAX_BODY_BYTES,
  makeExchangeResponse,
  parseExchange,
  type Exchange,
  type ExchangeLog,
} from '../src/exchanges.ts'
import { isJsonObject, parseJson, type JsonValue } from '../src/json.ts'
import { makeRequest, makeResponse, type Request, type Response } from '../src/messages.ts'
import {
  REPLAY_STRATEGIES,
  type ReplayStrategy,
  type TunnelConfig,
  type TunnelRequestConfig,
} from '../src/models.ts'
import {
  RecordingReader,
  RecordingStore,
  chooseSample,
  filePath,
  formatRecording,
  pathSegments,
  recordedBytes,
  recordedCallOf,
  recordedCallRow,
  safeSegment,
  sessionName,
  type Recorded,
  type RecordedCall,
  type RecordingFilters,
  type RecordingRow,
  type RecordingStatus,
} from '../src/recordings.ts'
import { adminClient, type AdminClient } from './support/admin-env.ts'
import { cliRunner } from './support/cli.ts'
import { fakeUpstream } from './support/fake-upstream.ts'
import { captureLogs } from './support/logs.ts'
import { testRoutes } from './support/routes.ts'
import { tmpDir } from './support/tmp.ts'

/** The golden files the store is held to: tree/, loaded.json and layout.json */
const FIXTURES = new URL('./fixtures/recordings/', import.meta.url)

/** Every file under dir, as its path relative to dir with '/' between the parts, sorted */
function treeFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort()
}

/**
 * One exchange as the log keeps it, read back the way a recording is read: GET
 * https://api.example.com/x, answered 200 with the JSON body {"seq": seq}. fields.host and
 * fields.path are where it went instead, fields.query is the request's query, fields.body is the
 * JSON body instead, and fields.response null leaves the call without an answer.
 */
function exchange(
  seq: number,
  fields: {
    host?: string
    path?: string
    query?: Record<string, string>
    body?: JsonValue
    response?: null
  } = {},
): Exchange {
  const host = fields.host ?? 'api.example.com'
  const path = fields.path ?? '/x'
  return parseExchange({
    seq,
    time: '2026-10-11T09:30:00.007',
    request: {
      method: 'GET',
      scheme: 'https',
      host,
      port: 443,
      path,
      query: fields.query ?? {},
      url: `https://${host}${path}`,
    },
    response:
      fields.response === null
        ? null
        : {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: fields.body === undefined ? { seq } : fields.body,
            body_encoding: 'json',
            elapsed_ms: 12,
            size: 9,
          },
    mode: 'passthrough',
  })
}

/** exchange(seq) with that query, as the index of session s knows it, filed as /f/<seq> */
function call(seq: number, query?: Record<string, string>): RecordedCall {
  return recordedCallOf('s', exchange(seq, { query }), `/f/${seq}`)
}

// ---------------------------------------------------------------- env

// env: a core that records, the admin API over it, and `tunnel` pointed at both. The core is the
// real one, with the stand-in backend below as its upstream, and so is the admin API: start, stop,
// record, health, getConfig, patchConfig, sessions, index and deleteRecordings go through its
// routes, in process, and client hands back its answers whole, status code and all.

/** What the stand-in backend answers /api/image with */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff])

/** The stand-in backend: the path asks for the kind of body it wants back */
function upstream(request: Pick<Request, 'path'>): Response {
  if (request.path === '/api/text') {
    return makeResponse({
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: Buffer.from('plain words'),
    })
  }
  if (request.path === '/api/image') {
    return makeResponse({ headers: { 'content-type': 'image/png' }, body: PNG })
  }
  if (request.path === '/api/huge') {
    return makeResponse({ body: Buffer.alloc(MAX_BODY_BYTES + 10, 'x') })
  }
  return makeResponse({
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ path: request.path })),
  })
}

/** What POST /__admin__/record/start and /stop answer */
type Switched = { success: boolean } & RecordingStatus

interface Env {
  manager: TunnelConfigManager
  log: ExchangeLog
  store: RecordingStore
  /** The recordings directory */
  root: string
  /** One request through the core, exactly as the proxy port asks it: GET / on api.example.com
   *  unless told otherwise */
  send(fields?: Partial<Request>): Promise<Response>
  /** The rule for this key, made or changed */
  configure(key: string, fields: Partial<Omit<TunnelRequestConfig, 'request_key'>>): void
  /** POST /__admin__/record/start, with no session in the body when none or '' is given */
  start(session?: string): Promise<Switched>
  /** POST /__admin__/record/stop */
  stop(): Promise<Switched>
  /** GET /__admin__/record */
  record(): Promise<RecordingStatus>
  /** GET /__admin__/health: session and recording, which are all the tests read */
  health(): Promise<{ session: string; recording: RecordingStatus }>
  /** GET /__admin__/config */
  getConfig(): Promise<TunnelConfig>
  /** PATCH /__admin__/config */
  patchConfig(fields: Partial<TunnelConfig>): Promise<unknown>
  /** GET /__admin__/sessions */
  sessions(): Promise<{ session: string; sessions: Record<string, number> }>
  /** GET /__admin__/recordings: its recordings */
  index(params?: { session?: string; key?: string; host?: string }): Promise<RecordingRow[]>
  /** DELETE /__admin__/recordings: one session's, or every session's when none or '' is given */
  deleteRecordings(params?: {
    session?: string
  }): Promise<{ success: boolean; deleted: number; session: string | null }>
  /** Every recording on disk, as paths relative to the recordings directory with '/' between the
   *  parts, sorted. Going by name alone, a directory whose name ends in .json is one of them */
  files(): Promise<string[]>
  /** One file of the recordings directory, read as JSON */
  read(relative: string): Promise<JsonValue>
  /** The admin app itself, for a test that wants an answer's status code */
  client: AdminClient
  /** The tunnel command over this admin app, resolving with its exit code */
  run(...argv: string[]): Promise<number>
  /** What the command has printed */
  takeOutput(): { out: string; err: string }
}

async function makeEnv(t: TestContext): Promise<Env> {
  // Added before tmpDir(t) adds the removal of the directory, so that the core is closed, and the
  // last writes of its log and store done, before the directory goes: t.after hooks run in the
  // order they were added. On Node 22.18 a write still in flight failed the removal with ENOTEMPTY
  let core: TunnelCore | undefined
  t.after(() => core?.close())
  const dir = tmpDir(t)
  const manager = new TunnelConfigManager(Paths.inOneDirectory(dir))
  core = new TunnelCore(manager, {
    upstream: fakeUpstream((request) => upstream({ path: new URL(request.url).pathname })),
    routes: testRoutes(),
  })
  const log = core.exchanges
  const store = core.recordings
  const { root } = store
  const app = createAdminApp({ manager, core, ca: new CertificateAuthority(manager.paths) })
  const client = adminClient(app)
  // The command over the same app, run in env's own directory
  const cli = cliRunner({ fetch: (url, init) => app.request(url, init), cwd: dir })

  return {
    manager,
    log,
    store,
    root,
    send: (fields) =>
      core.resolve(makeRequest({ method: 'GET', path: '/', host: 'api.example.com', ...fields })),
    configure: (key, fields) => manager.updateRequestConfig(key, fields),
    start: async (session) =>
      (await client.post('/__admin__/record/start', { json: session ? { session } : {} })).json(),
    stop: async () => (await client.post('/__admin__/record/stop')).json(),
    record: async () => (await client.get('/__admin__/record')).json(),
    health: async () => (await client.get('/__admin__/health')).json(),
    getConfig: async () => (await client.get('/__admin__/config')).json(),
    patchConfig: async (fields) =>
      (await client.patch('/__admin__/config', { json: fields })).json(),
    sessions: async () => (await client.get('/__admin__/sessions')).json(),
    index: async (params) =>
      (await client.get('/__admin__/recordings', { params: { ...params } })).json().recordings,
    deleteRecordings: async (params) =>
      (await client.delete('/__admin__/recordings', { params: { ...params } })).json(),
    files: async () => {
      await store.flush()
      if (!existsSync(root)) return []
      return readdirSync(root, { encoding: 'utf8', recursive: true })
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.split(sep).join('/'))
        .sort()
    },
    read: async (relative) => {
      await store.flush()
      return parseJson(readFileSync(join(root, relative), 'utf8'))
    },
    client,
    run: cli.run,
    takeOutput: cli.takeOutput,
  }
}

/** A store over a data directory of its own, and its manager. Closed before the directory is
 *  removed, as makeEnv's is */
function makeStore(t: TestContext): { manager: TunnelConfigManager; store: RecordingStore } {
  let store: RecordingStore | undefined
  t.after(() => store?.close())
  const manager = new TunnelConfigManager(Paths.inOneDirectory(tmpDir(t)))
  store = new RecordingStore(manager)
  return { manager, store }
}

/** What these keys lead to in JSON read back with env.read(): field(recorded, 'response',
 *  'body') is recorded.response.body. A key that is not there fails the test */
function field(value: JsonValue, ...keys: string[]): JsonValue {
  let found = value
  for (const key of keys) {
    const next = isJsonObject(found) && Object.hasOwn(found, key) ? found[key] : undefined
    if (next === undefined) assert.fail(`no ${keys.join('.')} in this JSON`)
    found = next
  }
  return found
}

// ---------------------------------------------------------------- what lands where

test('a call is filed under session, host, method and path', async (t) => {
  const env = await makeEnv(t)
  await env.start('acct_a')

  await env.send({ path: '/v5/suggestions', query: { page: '1' } })
  await env.send({ path: '/' })

  assert.deepEqual(await env.files(), [
    'acct_a/api.example.com/GET/_root/000002.json',
    'acct_a/api.example.com/GET/v5/suggestions/000001.json',
  ])
  const recorded = await env.read('acct_a/api.example.com/GET/v5/suggestions/000001.json')
  // The file is the exchange the request log keeps, seq and all
  assert.equal(field(recorded, 'seq'), 1)
  assert.deepEqual(field(recorded, 'request', 'query'), { page: '1' })
  assert.deepEqual(field(recorded, 'response', 'body'), { path: '/v5/suggestions' })
  assert.equal(field(recorded, 'mode'), 'passthrough')
})

// A path is not a directory until it has been cleaned: `..` climbs
test('a path segment that is not a file name becomes one', async (t) => {
  const env = await makeEnv(t)
  await env.start()

  await env.send({ path: '/v5/a b/../secrets' })

  assert.deepEqual(await env.files(), ['default/api.example.com/GET/v5/a_b/_/secrets/000001.json'])
})

test('a session that is not a directory name is refused', async (t) => {
  const env = await makeEnv(t)
  for (const session of ['../etc', 'a/b', 'an account']) {
    const answer = await env.client.post('/__admin__/record/start', { json: { session } })
    assert.equal(answer.status, 400, session)
  }

  assert.equal((await env.client.get('/__admin__/record')).json().active, false)
  // Nothing given is the default session, not an error
  assert.equal((await env.start('')).session, 'default')
})

// JSON stays an object so a script can edit it; bytes have to be encoded
test('a body is recorded the way the log encodes it', async (t) => {
  const env = await makeEnv(t)
  await env.start()

  await env.send({ path: '/api/json' })
  await env.send({ path: '/api/text' })
  await env.send({ path: '/api/image' })
  await env.send({ path: '/api/huge' })

  const recorded: JsonValue[] = []
  for (const name of await env.files()) recorded.push(await env.read(name))
  const bySeq = new Map(recorded.map((entry) => [field(entry, 'seq'), entry]))
  const entry = (seq: number): JsonValue => {
    const found = bySeq.get(seq)
    if (found === undefined) assert.fail(`no recording with seq ${seq}`)
    return found
  }
  assert.deepEqual(
    [1, 2, 3, 4].map((seq) => field(entry(seq), 'response', 'body_encoding')),
    ['json', 'text', 'base64', 'text'],
  )
  assert.deepEqual(field(entry(1), 'response', 'body'), { path: '/api/json' })
  assert.equal(field(entry(2), 'response', 'body'), 'plain words')
  // Cut at the cap, and the file says so
  assert.equal(field(entry(4), 'truncated'), true)
  const huge = field(entry(4), 'response', 'body')
  assert.equal(typeof huge === 'string' ? huge.length : huge, MAX_BODY_BYTES)
})

// ---------------------------------------------------------------- the switch

test('nothing is recorded before start or after stop', async (t) => {
  const env = await makeEnv(t)
  await env.send({ path: '/api/before' })
  await env.start()
  await env.send({ path: '/api/during' })
  await env.stop()
  await env.send({ path: '/api/after' })

  assert.deepEqual(await env.files(), ['default/api.example.com/GET/api/during/000002.json'])
})

// A mocked answer is already written down in the rule that produced it
test('only passthrough calls are recorded', async (t) => {
  const env = await makeEnv(t)
  await env.start()
  env.configure('GET:/api/mocked', { mode: 'json', json_response: { v: 1 } })
  env.configure('GET:/api/scripted', {
    mode: 'script',
    script: 'function handler(ctx) { return { v: 2 } }',
  })
  // A disabled rule answers 503 without asking anybody upstream
  env.configure('GET:/api/off', { mode: 'passthrough', enabled: false })

  await env.send({ path: '/api/mocked' })
  await env.send({ path: '/api/scripted' })
  await env.send({ path: '/api/off' })
  await env.send({ path: '/api/real' })
  // A tunnel nobody decrypted has nothing to record
  env.log.recordConnect('pinned.example.com', 443, '127.0.0.1', 10, 20)

  assert.deepEqual(await env.files(), ['default/api.example.com/GET/api/real/000004.json'])
})

test('the switch is reported by record and by health', async (t) => {
  const env = await makeEnv(t)
  const off = await env.record()
  await env.start('acct_b')
  await env.send({ path: '/api/feed' })
  await env.store.flush()

  const on = await env.record()
  const health = await env.health()

  assert.deepEqual(off, { active: false, session: 'default', count: 0 })
  assert.deepEqual(on, { active: true, session: 'acct_b', count: 1 })
  // The panel's header reads this one
  assert.deepEqual(health.recording, on)
  assert.equal((await env.stop()).active, false)
})

// `record start` files the calls where replay is reading from
test('recording without a session writes into the current one', async (t) => {
  const env = await makeEnv(t)
  await env.patchConfig({ session: 'acct_a' })

  await env.start()
  await env.send({ path: '/api/feed' })

  assert.deepEqual(await env.files(), ['acct_a/api.example.com/GET/api/feed/000001.json'])
})

// Recording and replay read one session, so `--session` moves both
test('recording into a session switches the current one', async (t) => {
  const env = await makeEnv(t)
  const started = await env.start('acct_b')

  assert.equal(started.session, 'acct_b')
  assert.equal((await env.getConfig()).session, 'acct_b')
  assert.equal((await env.health()).session, 'acct_b')
})

// What `tunnel session` lists: every session there is, and how much it holds
test('the sessions on disk are counted', async (t) => {
  const env = await makeEnv(t)
  await env.start('acct_a')
  await env.send({ path: '/api/feed' })
  await env.send({ path: '/api/other' })
  await env.start('acct_b')
  await env.send({ path: '/api/feed' })

  assert.deepEqual(await env.store.sessions(), { acct_a: 2, acct_b: 1 })
  assert.deepEqual(await env.sessions(), {
    session: 'acct_b',
    sessions: { acct_a: 2, acct_b: 1 },
  })
})

// ---------------------------------------------------------------- the index

test('the index is rebuilt by walking the directory', async (t) => {
  const env = await makeEnv(t)
  await env.start()
  await env.send({ path: '/v5/suggestions', query: { page: '2' } })
  await env.store.flush()

  // A store that has never written anything finds the same call
  const fresh = await new RecordingStore(env.manager).index()

  assert.deepEqual(await env.index(), fresh)
  const row = fresh[0]
  assert.ok(row)
  assert.equal(row.session, 'default')
  assert.equal(row.seq, 1)
  assert.equal(row.key, 'GET:api.example.com/v5/suggestions')
  assert.deepEqual(row.query, { page: '2' })
  assert.equal(row.status, 200)
  assert.ok(row.size > 0)
  assert.ok(row.time)
})

test('the index narrows by session, key and host', async (t) => {
  const env = await makeEnv(t)
  await env.start('acct_a')
  await env.send({ path: '/api/feed', host: 'api.example.com' })
  await env.send({ path: '/api/feed', host: 'cdn.example.com' })
  await env.start('acct_b')
  await env.send({ path: '/api/other', host: 'api.example.com' })

  const seqs = async (params?: Parameters<Env['index']>[0]) =>
    (await env.index(params)).map((row) => [row.session, row.seq])

  assert.deepEqual(await seqs(), [
    ['acct_a', 1],
    ['acct_a', 2],
    ['acct_b', 3],
  ])
  assert.deepEqual(await seqs({ session: 'acct_b' }), [['acct_b', 3]])
  // A key with no host selects that path on every host, as a rule would
  assert.deepEqual(await seqs({ key: 'GET:/api/feed' }), [
    ['acct_a', 1],
    ['acct_a', 2],
  ])
  assert.deepEqual(await seqs({ key: 'GET:api.example.com/api/feed' }), [['acct_a', 1]])
  assert.deepEqual(await seqs({ host: 'cdn.*' }), [['acct_a', 2]])
  assert.equal(
    (await env.client.get('/__admin__/recordings', { params: { key: 'nonsense' } })).status,
    400,
  )
})

test('one recording is fetched by session and seq', async (t) => {
  const env = await makeEnv(t)
  await env.start('acct_a')
  await env.send({ path: '/api/feed' })
  await env.store.flush()

  const found = await env.client.get('/__admin__/recordings/acct_a/1')
  const missing = await env.client.get('/__admin__/recordings/acct_a/99')
  const otherSession = await env.client.get('/__admin__/recordings/default/1')

  assert.deepEqual(found.json().response.body, { path: '/api/feed' })
  assert.equal(missing.status, 404)
  assert.equal(otherSession.status, 404)
})

test('recordings are deleted by session or altogether', async (t) => {
  const env = await makeEnv(t)
  await env.start('acct_a')
  await env.send({ path: '/api/feed' })
  await env.start('acct_b')
  await env.send({ path: '/api/feed' })
  await env.store.flush()

  const deleted = await env.deleteRecordings({ session: 'acct_a' })

  assert.equal(deleted.deleted, 1)
  assert.deepEqual(
    (await env.index()).map((row) => row.session),
    ['acct_b'],
  )
  assert.equal((await env.deleteRecordings()).deleted, 1)
  assert.deepEqual(await env.index(), [])
})

// ---------------------------------------------------------------- the CLI

// A test that writes a tree of its own takes a directory for it with tmpDir(t), apart from env's,
// and gives the CLI its absolute path

test('tunnel record starts, stops and reports', async (t) => {
  const env = await makeEnv(t)
  assert.equal(await env.run('record', 'start', '--session', 'acct_a'), 0)
  const started = env.takeOutput().out
  await env.send({ path: '/api/feed' })
  assert.equal(await env.run('record', 'status'), 0)
  const status = env.takeOutput().out
  assert.equal(await env.run('record', 'stop'), 0)
  const stopped = env.takeOutput().out

  assert.ok(started.includes('acct_a'))
  assert.ok(status.includes('Recording is on') && status.includes('1 calls'))
  assert.ok(stopped.includes('Recording stopped'))
  assert.equal((await env.client.get('/__admin__/record')).json().active, false)
})

// The field is left out of the call, or a plain start would move the run back
test('tunnel record start without a session keeps the current one', async (t) => {
  const env = await makeEnv(t)
  await env.client.patch('/__admin__/config', { json: { session: 'acct_a' } })

  assert.equal(await env.run('record', 'start'), 0)

  assert.equal((await env.client.get('/__admin__/config')).json().session, 'acct_a')
  assert.ok(env.takeOutput().out.includes('acct_a'))
})

test('tunnel recordings lists and shows the session being recorded', async (t) => {
  const env = await makeEnv(t)
  await env.run('record', 'start', '--session', 'acct_a')
  await env.send({ path: '/v5/suggestions', query: { page: '2' } })

  assert.equal(await env.run('recordings', 'ls'), 0)
  const listed = env.takeOutput().out
  // No --session: the one being recorded is the one to show
  assert.equal(await env.run('recordings', 'show', '1'), 0)
  const shown = env.takeOutput().out

  assert.ok(listed.includes('GET:api.example.com/v5/suggestions?page=2'))
  assert.ok(listed.includes('acct_a'))
  assert.ok(shown.includes('response 200') && shown.includes('"path": "/v5/suggestions"'))
})

test('tunnel recordings export hides the headers that carry a session', async (t) => {
  const env = await makeEnv(t)
  const tmp = tmpDir(t)
  await env.start()
  await env.send({
    path: '/api/feed',
    headers: { authorization: 'Bearer secret-token', 'user-agent': 'ExampleApp/1.0' },
  })

  assert.equal(await env.run('recordings', 'export', '-o', join(tmp, 'hidden')), 0)
  assert.equal(await env.run('recordings', 'export', '-o', join(tmp, 'raw'), '--raw'), 0)

  const layout = 'default/api.example.com/GET/api/feed/000001.json'
  const hidden = readFileSync(join(tmp, 'hidden', layout), 'utf8')
  const raw = readFileSync(join(tmp, 'raw', layout), 'utf8')

  assert.ok(hidden.includes('[REDACTED]') && !hidden.includes('secret-token'))
  assert.ok(hidden.includes('ExampleApp/1.0')) // only the listed names are hidden
  assert.ok(raw.includes('secret-token'))
  // What the server keeps for itself stays as it arrived, or it would not replay
  assert.ok(JSON.stringify(await env.read(layout)).includes('secret-token'))
})

test('tunnel recordings import puts back what export wrote', async (t) => {
  const env = await makeEnv(t)
  const tmp = tmpDir(t)
  await env.start('acct_a')
  await env.send({ path: '/api/feed', query: { page: '1' } })
  await env.send({ path: '/api/pay', method: 'POST', body: Buffer.from('{"amount": 12}') })
  const before = await env.index()

  await env.run('recordings', 'export', '-o', join(tmp, 'committed'))
  await env.run('recordings', 'rm')
  env.takeOutput()
  assert.equal(await env.run('recordings', 'import', join(tmp, 'committed')), 0)

  assert.ok(env.takeOutput().out.includes('Imported 2 recordings'))
  assert.deepEqual(await env.index(), before)
  // The tree on disk is the tree that was exported
  assert.deepEqual(await env.files(), [
    'acct_a/api.example.com/GET/api/feed/000001.json',
    'acct_a/api.example.com/POST/api/pay/000002.json',
  ])
})

// `/api/feed.json` is filed under a directory named `feed.json`, not a call
test('tunnel recordings import reads back an endpoint whose path ends in .json', async (t) => {
  const env = await makeEnv(t)
  const tmp = tmpDir(t)
  await env.start('acct_a')
  await env.send({ path: '/api/feed.json' })
  const before = await env.index()

  await env.run('recordings', 'export', '-o', join(tmp, 'committed'))
  env.takeOutput()
  assert.equal(await env.run('recordings', 'rm'), 0)
  assert.ok(env.takeOutput().out.includes('Deleted 1 recordings'))
  assert.equal(await env.run('recordings', 'import', join(tmp, 'committed')), 0)

  assert.ok(env.takeOutput().out.includes('Imported 1 recordings'))
  assert.deepEqual(await env.index(), before)
})

test('tunnel recordings import replace empties the session first', async (t) => {
  const env = await makeEnv(t)
  const tmp = tmpDir(t)
  await env.start('acct_a')
  await env.send({ path: '/api/feed' })
  await env.run('recordings', 'export', '-o', join(tmp, 'committed'))
  await env.run('recordings', 'rm')
  await env.send({ path: '/api/stale' })

  await env.run('recordings', 'import', join(tmp, 'committed'), '--replace')

  assert.deepEqual(await env.files(), ['acct_a/api.example.com/GET/api/feed/000001.json'])
})

// A .json that lies outside a session directory has no session of its own
test('tunnel recordings import files a loose call in the current session', async (t) => {
  const env = await makeEnv(t)
  const tmp = tmpDir(t)
  await env.start('acct_a')
  await env.send({ path: '/api/feed' })
  await env.run('recordings', 'export', '-o', join(tmp, 'committed'))
  const loose = join(tmp, 'loose')
  mkdirSync(loose)
  writeFileSync(
    join(loose, 'call.json'),
    readFileSync(
      join(tmp, 'committed', 'acct_a', 'api.example.com', 'GET', 'api', 'feed', '000001.json'),
      'utf8',
    ),
  )
  await env.run('recordings', 'rm')
  await env.client.patch('/__admin__/config', { json: { session: 'acct_b' } })

  assert.equal(await env.run('recordings', 'import', loose), 0)

  assert.deepEqual(await env.files(), ['acct_b/api.example.com/GET/api/feed/000001.json'])
})

test('tunnel recordings rm clears one session or all', async (t) => {
  const env = await makeEnv(t)
  await env.start('acct_a')
  await env.send({ path: '/api/feed' })
  await env.start('acct_b')
  await env.send({ path: '/api/feed' })

  assert.equal(await env.run('recordings', 'rm', '--session', 'acct_a'), 0)
  assert.ok(env.takeOutput().out.includes('Deleted 1 recordings from session acct_a'))
  assert.equal(await env.run('recordings', 'rm'), 0)
  assert.deepEqual(await env.index(), [])
})

// One bad entry must not empty a session that `--replace` was aimed at
test('an import that cannot be written leaves the session alone', async (t) => {
  const env = await makeEnv(t)
  await env.start('acct_a')
  await env.send({ path: '/api/feed' })
  const before = await env.files()
  const good = await env.read(before[0]!)

  // A seq that is not a number, and a field that is not the shape it has to be
  for (const bad of [
    { seq: 'not a number' },
    { request: 'not an object' },
    { seq: 2, request: { method: ['GET'] } },
  ]) {
    const answer = await env.client.post('/__admin__/recordings/import', {
      json: { session: 'acct_a', replace: true, exchanges: [good, bad] },
    })

    assert.equal(answer.status, 400, JSON.stringify(bad))
    assert.ok('detail' in answer.json(), JSON.stringify(bad))
    assert.deepEqual(await env.files(), before)
  }
})

test('tunnel recordings import says what is wrong with a directory', async (t) => {
  const env = await makeEnv(t)
  const tmp = tmpDir(t)
  const empty = join(tmp, 'empty')
  mkdirSync(empty)

  assert.equal(await env.run('recordings', 'import', join(tmp, 'gone')), 1)
  assert.equal(await env.run('recordings', 'import', empty), 1)
})

// ---------------------------------------------------------------- the store, called directly

// formatRecording writes each file of the golden tree, tests/fixtures/recordings/tree/, back byte
// for byte, but for two spellings that are allowed to differ: a float is written the JS way (1.0
// as 1, 1e+16 as 10000000000000000, 1e-05 as 0.00001), and keys that look like integers come
// first, smallest first. One recording holds both on purpose. Its values are compared as the text
// JSON.stringify makes of them, not with deepStrictEqual: the file's 1e+16 reads back as a number,
// but the 10000000000000000 written in its place is past 2^53 and reads back as a RawJson, the
// same value as another type.
test('formatRecording writes the golden tree back byte for byte, but for floats and integer-like keys', () => {
  const FLOATS = 'acct_a/api.example.com/GET/v5/a_b/_/secrets/000006.json'
  const tree = fileURLToPath(new URL('tree/', FIXTURES))
  const files = treeFiles(tree)
  assert.equal(files.length, 9, files.join('\n'))
  assert.ok(files.includes(FLOATS), files.join('\n'))
  for (const file of files) {
    const text = readFileSync(join(tree, file), 'utf8')
    const written = formatRecording(parseExchange(parseJson(text)))
    if (file !== FLOATS) {
      assert.equal(written, text, file)
      continue
    }
    assert.equal(JSON.stringify(parseJson(written)), JSON.stringify(parseJson(text)))
    const golden = text.split('\n')
    const ours = written.split('\n')
    assert.equal(ours.length, golden.length)
    const changed = golden.filter((line, i) => line !== ours[i]).map((line) => line.trim())
    assert.deepEqual(changed, [
      '"10": "x",',
      '"2": "y"',
      '"10": 1,',
      '"2": 2,',
      '"f": 1.0,',
      '"g": 1e+16,',
      '"h": 1e-05',
    ])
  }
})

/** tests/fixtures/recordings/loaded.json: what a store that wrote none of tree/ reads back */
interface Loaded {
  rows: RecordingRow[]
  sessions: Record<string, number>
  /** get(session, seq), once for each (session, seq) of rows */
  exchanges: { session: string; seq: number; exchange: JsonValue }[]
  /** samples(...args), each call found as the path of its file under the recordings directory */
  samples: { args: [string, string, string, string, string | null]; files: string[] }[]
}

// The golden tree, read by a store that wrote none of it. Two calls in acct_b share seq 1, filed
// under the hosts a and a-b, and keep the order of a sort that compares paths part by part;
// GET:*.example.com/* meets seqs 4 and 5 in acct_a before 1 and 3 and finds them oldest first; an
// endpoint whose path ends in .json is a directory, and / is _root. An exchange is compared as the
// text JSON.stringify makes of it, key order included, so that a RawJson needs nothing of its own
test('the golden tree reads back as loaded.json says', async (t) => {
  const { store } = makeStore(t)
  cpSync(fileURLToPath(new URL('tree/', FIXTURES)), store.root, { recursive: true })
  const text = readFileSync(new URL('loaded.json', FIXTURES), 'utf8')
  const loaded = parseJson(text) as unknown as Loaded
  // So that a fixture read as empty, or cut short, cannot pass
  assert.deepEqual([loaded.rows.length, loaded.exchanges.length, loaded.samples.length], [9, 8, 9])

  assert.deepEqual(await store.index(), loaded.rows)
  assert.deepEqual(await store.sessions(), loaded.sessions)
  for (const { session, seq, exchange: expected } of loaded.exchanges) {
    assert.equal(
      JSON.stringify(await store.get(session, seq)),
      JSON.stringify(expected),
      `${session} ${seq}`,
    )
  }
  for (const { args, files } of loaded.samples) {
    const found = await store.samples(...args)
    assert.deepEqual(
      found.map((call) => relative(store.root, call.file).split(sep).join('/')),
      files,
      JSON.stringify(args),
    )
  }
})

/** tests/fixtures/recordings/layout.json: what the layout functions make of each input */
interface Layout {
  safe_segment: [string, string][]
  path_segments: [string, string[]][]
  file_path: [[string, string, string, string, number], string][]
  session_name: [string | null, { value: string } | { error: string }][]
}

// Cleaned code point by code point; the path joined with the platform's separator
test('safeSegment, pathSegments and filePath name things as layout.json says', () => {
  const layout: Layout = JSON.parse(readFileSync(new URL('layout.json', FIXTURES), 'utf8'))
  // So that a table read as empty, or cut short, cannot pass
  assert.deepEqual(
    [layout.safe_segment.length, layout.path_segments.length, layout.file_path.length],
    [13, 9, 7],
  )
  for (const [name, cleaned] of layout.safe_segment) {
    assert.equal(safeSegment(name), cleaned, JSON.stringify(name))
  }
  for (const [path, segments] of layout.path_segments) {
    assert.deepEqual(pathSegments(path), segments, JSON.stringify(path))
  }
  for (const [args, written] of layout.file_path) {
    assert.equal(filePath(...args), written.split('/').join(sep), JSON.stringify(args))
  }
})

// sessionName takes U+001C and U+0085 for whitespace and U+FEFF for none, the other way round from
// trim(); a name it refuses is quoted as it was given, in the quotes and escapes of repr()
test('sessionName takes, strips and refuses names as layout.json says, in its words', () => {
  const layout: Layout = JSON.parse(readFileSync(new URL('layout.json', FIXTURES), 'utf8'))
  assert.equal(layout.session_name.length, 18)
  for (const [name, result] of layout.session_name) {
    const which = JSON.stringify(name)
    if ('error' in result) {
      assert.throws(
        () => sessionName(name),
        (error) => {
          assert.ok(error instanceof UserError, `${which} threw ${String(error)}`)
          assert.equal(error.message, result.error, which)
          return true
        },
        which,
      )
    } else {
      assert.equal(sessionName(name), result.value, which)
    }
  }
  assert.equal(sessionName(undefined), 'default')
})

// The other tests reach these two only through the store, and the rows the admin API sends the
// panel are what recordedCallRow makes
test('recordedCallOf and recordedCallRow: fields in order, query copied, no response is status null and size 0', () => {
  const recorded = exchange(3, { query: { page: '2' } })
  const found = recordedCallOf('s', recorded, '/f/3')
  assert.deepEqual(Object.keys(found), [
    'session',
    'seq',
    'time',
    'key',
    'method',
    'host',
    'port',
    'path',
    'query',
    'status',
    'size',
    'file',
  ])
  assert.deepEqual(found, {
    session: 's',
    seq: 3,
    time: '2026-10-11T09:30:00.007',
    key: 'GET:api.example.com/x',
    method: 'GET',
    host: 'api.example.com',
    port: 443,
    path: '/x',
    query: { page: '2' },
    status: 200,
    size: 9,
    file: '/f/3',
  })
  assert.notEqual(found.query, recorded.request.query)

  const unanswered = recordedCallOf('s', exchange(4, { response: null }), '/f/4')
  assert.equal(unanswered.status, null)
  assert.equal(unanswered.size, 0)

  const row = recordedCallRow(found)
  assert.deepEqual(Object.keys(row), ['session', 'seq', 'time', 'key', 'query', 'status', 'size'])
  assert.deepEqual(row, {
    session: 's',
    seq: 3,
    time: '2026-10-11T09:30:00.007',
    key: 'GET:api.example.com/x',
    query: { page: '2' },
    status: 200,
    size: 9,
  })
  assert.notEqual(row.query, found.query)
})

// A query is equal to another with the same keys and values, in whatever order they came
test('chooseSample: sequence walks and stays on the last, match takes the newest equal query, last the newest', () => {
  for (const strategy of REPLAY_STRATEGIES) {
    assert.equal(chooseSample([], strategy), null, strategy)
  }
  const samples = [call(1, { page: '1' }), call(2, { page: '2' }), call(3, { page: '1' }), call(4)]
  const chosen = (
    strategy: ReplayStrategy,
    query?: Record<string, string> | null,
    position?: number,
  ) => chooseSample(samples, strategy, query, position)?.seq
  // position is how many calls the rule has answered: past the last sample it stays on the last,
  // and a negative one counts from the end
  assert.deepEqual(
    [0, 1, 3, 9, -1].map((position) => chosen('sequence', null, position)),
    [1, 2, 4, 4, 4],
  )
  assert.equal(chosen('match', { page: '1' }), 3)
  assert.equal(chosen('match', { page: '9' }), 4)
  // null is {}, which is the query of call 4
  assert.equal(chosen('match', null), 4)
  const ordered = [call(5, { a: '1', b: '2' }), call(6)]
  assert.equal(chooseSample(ordered, 'match', { b: '2', a: '1' })?.seq, 5)
  assert.equal(chosen('last'), 4)
})

// A bad name changes nothing, the file included; start without a session records into the one in
// hand, and start('') goes back to default, since only null or undefined means no session
test('the switch: save only while on, write regardless, and start, stop and status, keys in order', async (t) => {
  const logs = captureLogs(t)
  const { manager, store } = makeStore(t)

  assert.equal(store.save(exchange(1)), null)
  const elsewhere = store.write(exchange(2), 'elsewhere')
  assert.equal(
    elsewhere,
    join(store.root, filePath('elsewhere', 'GET', 'api.example.com', '/x', 2)),
  )
  assert.ok(isAbsolute(elsewhere))

  const before = readFileSync(manager.paths.configFile)
  await assert.rejects(store.start('an account'), UserError)
  assert.equal(manager.getConfig().recording.active, false)
  assert.equal(manager.getConfig().session, 'default')
  assert.deepEqual(readFileSync(manager.paths.configFile), before)

  const started = await store.start('acct_a')
  assert.deepEqual(started, { active: true, session: 'acct_a', count: 0 })
  assert.deepEqual(Object.keys(started), ['active', 'session', 'count'])
  assert.equal(
    store.save(exchange(3)),
    join(store.root, filePath('acct_a', 'GET', 'api.example.com', '/x', 3)),
  )
  assert.deepEqual(await store.start(), { active: true, session: 'acct_a', count: 1 })
  const stopped = await store.stop()
  assert.deepEqual(stopped, { active: false, session: 'acct_a', count: 1 })
  assert.deepEqual(Object.keys(stopped), ['active', 'session', 'count'])
  assert.equal(store.save(exchange(4)), null)
  const status = await store.status()
  assert.deepEqual(status, { active: false, session: 'acct_a', count: 1 })
  assert.deepEqual(Object.keys(status), ['active', 'session', 'count'])
  assert.deepEqual(await store.start(''), { active: true, session: 'default', count: 0 })

  assert.deepEqual(
    logs.records.filter((record) => record.level === 'info').map((record) => record.message),
    [
      'Recording passthrough traffic into session acct_a',
      'Recording passthrough traffic into session acct_a',
      'Recording stopped',
      'Recording passthrough traffic into session default',
    ],
  )
})

// Paths.inOneDirectory puts all three in one place, so they are told apart here
test('recordings live in the data directory', async (t) => {
  const tmp = tmpDir(t)
  const configDir = join(tmp, 'config')
  const stateDir = join(tmp, 'state')
  const dataDir = join(tmp, 'data')
  const paths = new Paths({ config_dir: configDir, state_dir: stateDir, data_dir: dataDir })
  const store = new RecordingStore(new TunnelConfigManager(paths))

  assert.equal(store.root, join(dataDir, 'recordings'))
  store.write(exchange(1), 's')
  await store.close()
  assert.ok(
    existsSync(join(dataDir, 'recordings', 's', 'api.example.com', 'GET', 'x', '000001.json')),
  )
  assert.ok(!existsSync(join(configDir, 'recordings')))
  assert.ok(!existsSync(join(stateDir, 'recordings')))
})

// A read waits until the queue is empty and then reads in the same synchronous stretch of code.
// Waiting with `await flush()` and reading after it would leave a microtask between the two, in
// which a writer that waited for the queue as well (as an import does) can queue a write and drop
// the session's index; the read would then walk the directory before that write is on disk and
// keep what it found, and the call would stay unseen until this store next changed the session.
// Of the ten races below, that way of reading loses the one where the writer goes first with no
// hops in between, on every Node version (race-0-false). A read with nothing queued waits for
// nothing and is done as it is called, so to make one wait while another write is queued, a write
// has to be in flight before it
test('a read sees every write queued before it, and every write queued while it waited', async (t) => {
  const { store } = makeStore(t)
  const seqs = (rows: readonly RecordingRow[]) => rows.map((row) => row.seq)

  store.write(exchange(1), 's')
  assert.equal(await store.count('s'), 1)
  store.write(exchange(2), 's')
  store.write(exchange(3), 's')
  assert.deepEqual(seqs(await store.index({ session: 's' })), [1, 2, 3])

  store.write(exchange(4), 's')
  const reading = store.index({ session: 's' })
  store.write(exchange(5), 's')
  assert.deepEqual(seqs(await reading), [1, 2, 3, 4, 5])

  for (let hops = 0; hops <= 4; hops++) {
    for (const readerFirst of [false, true]) {
      const session = `race-${hops}-${readerFirst}`
      store.write(exchange(1), session)
      const reader = () => store.count(session)
      const writer = () => {
        let waited: Promise<unknown> = store.flush()
        for (let hop = 0; hop < hops; hop++) waited = waited.then(() => undefined)
        return waited.then(() => void store.write(exchange(11), session))
      }
      await Promise.all(readerFirst ? [reader(), writer()] : [writer(), reader()])
      await store.flush()
      assert.equal(await store.count(session), 2, session)
    }
  }
})

// Each session is walked once and kept; only this store's own writes drop what it kept
test('a file put there behind the store is not seen until the store changes that session', async (t) => {
  const { store } = makeStore(t)
  store.write(exchange(1), 's')
  assert.equal((await store.index()).length, 1)

  const behind = join(store.root, filePath('s', 'GET', 'api.example.com', '/other', 2))
  mkdirSync(dirname(behind), { recursive: true })
  writeFileSync(behind, formatRecording(exchange(2, { path: '/other' })))
  assert.equal((await store.index()).length, 1)

  store.write(exchange(3), 's')
  assert.deepEqual(
    (await store.index()).map((row) => row.seq),
    [1, 2, 3],
  )
})

// Every entry is checked before any is written, so one bad entry leaves the session it was aimed
// at as it was, replace or not. An entry is read the way parseExchange reads any exchange,
// leniently: "seq": "5" is filed as 5
test('an import checks every entry before it writes any, and is on disk once it resolves', async (t) => {
  const { store } = makeStore(t)
  const session = join(store.root, 's')
  assert.equal(await store.importExchanges([JSON.parse(formatRecording(exchange(1)))], 's'), 1)
  const before = treeFiles(session)
  assert.deepEqual(before, ['api.example.com/GET/x/000001.json'])
  const good: Record<string, unknown> = JSON.parse(formatRecording(exchange(2)))

  await assert.rejects(
    store.importExchanges([good, 'x'], 's', true),
    (error) =>
      error instanceof UserError && error.message === 'each entry has to be an exchange object',
  )
  await store.flush()
  assert.deepEqual(treeFiles(session), before)
  await assert.rejects(
    store.importExchanges([good, { request: { method: ['GET'] } }], 's', true),
    (error) =>
      error instanceof UserError &&
      error.message.startsWith('an exchange field has the wrong shape: '),
  )
  // Not even replace emptied it
  await store.flush()
  assert.deepEqual(treeFiles(session), before)

  // Not flushed: the files are there once it resolves
  assert.equal(await store.importExchanges([good, { ...good, seq: '5' }], 's', true), 2)
  assert.deepEqual(treeFiles(session), [
    'api.example.com/GET/x/000002.json',
    'api.example.com/GET/x/000005.json',
  ])
  const five = readFileSync(join(session, 'api.example.com', 'GET', 'x', '000005.json'), 'utf8')
  assert.equal(field(parseJson(five), 'seq'), 5)

  assert.equal(await store.importExchanges([good]), 1)
  assert.deepEqual(treeFiles(join(store.root, 'default')), ['api.example.com/GET/x/000002.json'])
  await assert.rejects(store.importExchanges([good], '../etc'), UserError)
})

// A delete waits for the writes queued before it, and for those queued while it waits, and takes
// them with the rest; a write after it resolves stays. '' is every session, and every session's
// index goes with them. Only a lookup by session can tell: index() without one lists the
// directories on disk, and there are none left
test('delete counts the files of one session or all of them, after the writes queued before it', async (t) => {
  const { store } = makeStore(t)
  const rows = async () => (await store.index()).map((row) => `${row.session} ${row.seq}`)
  store.write(exchange(1), 'a')
  store.write(exchange(2), 'b')
  assert.equal(await store.delete('nobody'), 0)

  store.write(exchange(3), 'a')
  assert.equal(await store.delete('a'), 2)
  assert.ok(!existsSync(join(store.root, 'a')))
  store.write(exchange(4), 'a')
  assert.deepEqual(await rows(), ['a 4', 'b 2'])
  assert.equal(await store.count('a'), 1)
  assert.equal(await store.count('b'), 1)

  assert.equal(await store.delete(''), 2)
  assert.equal(await store.count('a'), 0)
  assert.equal(await store.count('b'), 0)
  assert.deepEqual(await store.index({ session: 'b' }), [])
  assert.equal(await store.delete(), 0)

  // A write queued while the delete waits lands, and goes with the rest
  store.write(exchange(5), 'c')
  const deleting = store.delete('c')
  store.write(exchange(6), 'c')
  assert.equal(await deleting, 2)
  assert.equal(await store.count('c'), 0)
})

// A key with no host stands for every host, as a rule's does; the key is read before the queue is
// waited for, so a bad one rejects without a single file being walked
test('index narrows by session, key and host, and refuses a bad key before it walks anything', async (t) => {
  const { manager, store } = makeStore(t)
  store.write(exchange(1, { host: 'api.example.com', path: '/api/feed' }), 'acct_a')
  store.write(exchange(2, { host: 'cdn.example.com', path: '/api/feed' }), 'acct_a')
  store.write(exchange(3, { path: '/api/other' }), 'acct_b')
  const found = async (filters?: RecordingFilters) =>
    (await store.index(filters)).map((row) => `${row.session} ${row.seq}`)

  assert.deepEqual(await found(), ['acct_a 1', 'acct_a 2', 'acct_b 3'])
  assert.deepEqual(await found({ session: 'acct_b' }), ['acct_b 3'])
  assert.deepEqual(await found({ key: 'GET:/api/feed' }), ['acct_a 1', 'acct_a 2'])
  assert.deepEqual(await found({ key: 'GET:api.example.com/api/feed' }), ['acct_a 1'])
  assert.deepEqual(await found({ key: 'GET:api.example.com:443/api/feed' }), ['acct_a 1'])
  assert.deepEqual(await found({ key: 'GET:api.example.com:8080/api/feed' }), [])
  assert.deepEqual(await found({ host: 'cdn.*' }), ['acct_a 2'])
  assert.deepEqual(await found({ host: 'CDN.example.COM' }), ['acct_a 2'])
  assert.deepEqual(await found({ session: 'acct_a', key: 'GET:*/api/*', host: 'api.*' }), [
    'acct_a 1',
  ])
  assert.deepEqual(await found({ key: '', host: '' }), await found())
  const [row] = await store.index({ session: 'acct_b' })
  assert.ok(row)
  assert.deepEqual(Object.keys(row), ['session', 'seq', 'time', 'key', 'query', 'status', 'size'])

  // A store that has walked nothing yet, over a session holding a file it cannot read: walking it
  // would say so in a warning
  writeFileSync(join(store.root, 'acct_a', 'broken.json'), '{')
  const fresh = new RecordingStore(manager)
  const logs = captureLogs(t)
  await assert.rejects(fresh.index({ key: 'nonsense' }), UserError)
  assert.equal(logs.records.length, 0, logs.text())
  await fresh.index({ session: 'acct_a' })
  assert.equal(logs.records.filter((record) => record.level === 'warning').length, 1)
})

// The host and path being called come first: a rule written GET:*.example.com/v5/feed answers for
// a family of hosts, and what was recorded for the one being called is the better answer; only
// when that finds nothing does the key's pattern stand in. A key that is not a rule key, as core
// builds for a request no rule answers (M-SEARCH:h/x), finds nothing and does not reject. What the
// pattern finds comes oldest first, not in the order the walk met it
test('samples: exactly first, then the key pattern, and a key that is not a rule key gives no fallback', async (t) => {
  const { store } = makeStore(t)
  const KEY = 'GET:*.example.com/v5/feed'
  const found = async (host: string, key?: string) =>
    (await store.samples('s', 'GET', host, '/v5/feed', key)).map((call) => call.seq)
  // Not flushed: a read waits for both
  store.write(exchange(1, { path: '/v5/feed' }), 's')
  store.write(exchange(2, { host: 'b.example.com', path: '/v5/feed' }), 's')

  assert.deepEqual(await found('b.example.com', KEY), [2])
  assert.deepEqual(await found('c.example.com', KEY), [1, 2])
  assert.deepEqual(await found('c.example.com'), [])
  assert.deepEqual(await found('c.example.com', 'GET:*.example.org/v5/feed'), [])
  // Not a rule key, as index says
  await assert.rejects(store.index({ key: 'M-SEARCH:h/x' }), UserError)
  assert.deepEqual(await store.samples('s', 'M-SEARCH', 'h', '/x', 'M-SEARCH:h/x'), [])

  // The walk meets a.example.com, and so seq 9, first
  store.write(exchange(9, { host: 'a.example.com', path: '/v5/feed' }), 's')
  store.write(exchange(8, { host: 'z.example.com', path: '/v5/feed' }), 's')
  assert.deepEqual(await found('c.example.com', KEY), [1, 2, 8, 9])
})

// load reads the file again, so a file gone since the walk is null and a warning, not an error
test('get and load: the full exchange, or null and a warning for a file that is gone', async (t) => {
  const { store } = makeStore(t)
  // Not flushed: a read waits for it
  store.write(exchange(1), 'acct_a')

  const got = await store.get('acct_a', 1)
  assert.deepEqual(got?.response?.body, { seq: 1 })
  assert.deepEqual(got, exchange(1))
  assert.equal(await store.get('acct_a', 2), null)
  assert.equal(await store.get('acct_b', 1), null)

  const [sample] = await store.samples('acct_a', 'GET', 'api.example.com', '/x')
  assert.ok(sample)
  rmSync(sample.file)
  const logs = captureLogs(t)
  assert.equal(await store.load(sample), null)
  const warnings = logs.records.filter((record) => record.level === 'warning')
  assert.equal(warnings.length, 1, logs.text())
  assert.ok(warnings[0]?.message.startsWith('Skipping an unreadable recording '), logs.text())
})

// A session is any directory under the root, a symlink to one included
test('sessions: every directory under the root and its count, a symlinked one included', async (t) => {
  const { store } = makeStore(t)
  assert.deepEqual(await store.sessions(), {})

  store.write(exchange(1), 'zeta')
  store.write(exchange(2), 'alpha')
  store.write(exchange(3), 'alpha')
  await store.flush()
  symlinkSync('zeta', join(store.root, 'linked'))

  assert.deepEqual(Object.entries(await store.sessions()), [
    ['alpha', 2],
    ['linked', 1],
    ['zeta', 1],
  ])
})

// A file that is JSON but not an exchange is skipped like any other, and one that starts with a
// BOM is read, the BOM dropped
test('an unreadable recording is skipped with one warning, and the rest of its session still lists', async (t) => {
  const { manager, store } = makeStore(t)
  store.write(exchange(1), 's')
  await store.flush()
  const session = join(store.root, 's')
  writeFileSync(join(session, 'not-json.json'), '{')
  writeFileSync(join(session, 'not-utf-8.json'), Buffer.from([0x7b, 0xff, 0x7d]))
  writeFileSync(join(session, 'an-array.json'), '[1, 2]')
  writeFileSync(join(session, 'response-x.json'), '{"response": "x"}')
  writeFileSync(join(session, 'method-list.json'), '{"request": {"method": ["GET"]}}')
  writeFileSync(join(session, 'bom.json'), '\u{feff}' + formatRecording(exchange(2)))

  const logs = captureLogs(t)
  const rows = await new RecordingStore(manager).index()

  assert.deepEqual(
    rows.map((row) => row.seq),
    [1, 2],
  )
  const warnings = logs.records.filter((record) => record.level === 'warning')
  assert.equal(warnings.length, 5, logs.text())
  for (const warning of warnings) {
    assert.ok(warning.message.startsWith('Skipping an unreadable recording '), warning.message)
  }
})

// The walk does not follow a symlink to a directory, reads one to a file, takes a name that starts
// with a dot, and walks into a directory whose name ends in .json, which is an endpoint's path,
// without taking it for a file
test('the walk: no symlinked directories, symlinked files read, a directory named x.json is no file', async (t) => {
  const { manager, store } = makeStore(t)
  const outside = tmpDir(t)
  writeFileSync(join(outside, '000005.json'), formatRecording(exchange(5)))
  mkdirSync(join(outside, 'GET'))
  writeFileSync(join(outside, 'GET', '000006.json'), formatRecording(exchange(6)))

  store.write(exchange(1, { path: '/api/feed.json' }), 's')
  store.write(exchange(2, { path: '/hidden' }), 's')
  await store.flush()
  const links = join(store.root, 's', 'links')
  mkdirSync(links)
  symlinkSync(outside, join(links, 'outside'))
  symlinkSync(join(outside, '000005.json'), join(links, '000005.json'))
  writeFileSync(join(links, '.000007.json'), formatRecording(exchange(7)))

  assert.deepEqual(
    (await new RecordingStore(manager).index()).map((row) => row.seq),
    [1, 2, 5, 7],
  )
})

// Passed over without a word; chmod stops nobody running as root
test('the walk skips a directory it cannot list', { skip: process.getuid?.() === 0 }, async (t) => {
  // Added before makeStore(t) adds the removal of the directory, which a directory nobody may list
  // would fail
  let locked: string | undefined
  t.after(() => {
    if (locked !== undefined) chmodSync(locked, 0o755)
  })
  const { manager, store } = makeStore(t)
  store.write(exchange(1, { host: 'open.example.com' }), 's')
  store.write(exchange(2, { host: 'locked.example.com' }), 's')
  await store.flush()
  locked = join(store.root, 's', 'locked.example.com')
  chmodSync(locked, 0o000)

  assert.deepEqual(
    (await new RecordingStore(manager).index()).map((row) => row.seq),
    [1],
  )
})

// Nothing may stop the queue: every read waits for it to empty, so a queue that died of one
// recording would leave every later read waiting
test('a write that fails is logged, and the writes after it still land', async (t) => {
  const logs = captureLogs(t)
  const { store } = makeStore(t)
  // A file where the write needs a directory
  mkdirSync(join(store.root, 's'), { recursive: true })
  writeFileSync(join(store.root, 's', 'blocked.example.com'), 'not a directory')

  store.write(exchange(1, { host: 'blocked.example.com' }), 's')
  store.write(exchange(2), 's')
  await store.flush()

  const warnings = logs.records.filter((record) => record.level === 'warning')
  assert.equal(warnings.length, 1, logs.text())
  assert.ok(warnings[0]?.message.startsWith('Could not write the recording '), logs.text())
  assert.deepEqual(
    (await store.index()).map((row) => row.seq),
    [2],
  )
})

// JSON.stringify writes a lone surrogate as its escape, which parseJson reads back
test('a lone surrogate is written as its escape, reads back, and imports', async (t) => {
  const { store } = makeStore(t)
  const file = store.write(exchange(1, { body: { s: '\u{d800}' } }), 's')
  await store.flush()

  assert.ok(file !== null)
  assert.ok(readFileSync(file, 'utf8').includes('"s": "\\ud800"'), readFileSync(file, 'utf8'))
  assert.deepEqual((await store.get('s', 1))?.response?.body, { s: '\u{d800}' })

  assert.equal(await store.importExchanges([exchange(2, { body: '\u{dfff}' })], 's'), 1)
  assert.deepEqual(await store.get('s', 2), exchange(2, { body: '\u{dfff}' }))
})

// Plain JSON data, its keys in the order Recorded declares them, so it crosses a thread as the text
// JSON.stringify makes of it, read back with parseJson: structured clone throws on a RawJson. Each
// read is a fresh copy, so what a script does to one stays its own: load() reads the file again.
// A JSON null goes as the four bytes null
test('Recorded: plain data in a fixed order, a fresh copy per read, and its bytes as they go on the wire', async (t) => {
  const { store } = makeStore(t)
  const BODY = '{"id": 12345678901234567890, "names": ["é"]}'
  const written = exchange(1, { body: parseJson(BODY) })
  store.write(written, 's')
  const reader = new RecordingReader(
    store,
    { method: 'GET', host: 'api.example.com', path: '/x' },
    { request_key: 'GET:/x', replay_session: '' },
    's',
  )

  const recorded = await reader.one()
  assert.ok(recorded !== null)
  assert.deepEqual(Object.keys(recorded), [
    'seq',
    'status',
    'headers',
    'body',
    'request',
    'body_encoding',
  ])
  assert.deepEqual(recorded, {
    seq: 1,
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: parseJson(BODY),
    request: written.request,
    body_encoding: 'json',
  })
  // What crosses a thread: the text, read back to the same data, the big integer included
  assert.deepEqual(parseJson(JSON.stringify(recorded)), recorded)
  assert.equal(recordedBytes(recorded).toString(), BODY)

  // What a script does to it is its own: the next read is the file's again
  assert.ok(isJsonObject(recorded.body))
  recorded.body.id = 1
  recorded.headers['x-edited'] = 'yes'
  const again = await reader.one()
  assert.ok(again !== null)
  assert.equal(JSON.stringify(field(again.body, 'id')), '12345678901234567890')
  assert.equal(Object.hasOwn(again.headers, 'x-edited'), false)

  // The other bodies a script can leave in it
  const bytes = (body: JsonValue | Uint8Array, encoding: string | null) =>
    recordedBytes({ body, body_encoding: encoding })
  assert.equal(bytes([1, { a: null }], 'json').toString(), '[1, {"a": null}]')
  assert.equal(bytes('plain words', 'text').toString(), 'plain words')
  assert.deepEqual(bytes(PNG.toString('base64'), 'base64'), PNG)
  assert.deepEqual(bytes(new Uint8Array([1, 2]), 'json'), Buffer.from([1, 2]))
  assert.equal(bytes(null, 'json').toString(), 'null')
  // A JSON body swapped for a string goes as that JSON string, quotes and all
  assert.equal(bytes('swapped', 'json').toString(), '"swapped"')
  assert.equal(bytes(null, null).length, 0)
})

// ctx.recorded() and ctx.recordings() find what replay would: in the session asked for, else the
// rule's replay_session, else the one in hand, else default; at this request's endpoint, else by
// the rule key's pattern; or, given a key, at the host and path it names, else by its pattern. A
// key that is not a rule key rejects, for the script to see. A call that went unanswered is never
// handed over
test('RecordingReader finds what replay finds: whose session, which endpoint, and only calls that were answered', async (t) => {
  const { store } = makeStore(t)
  store.write(exchange(1, { path: '/feed', query: { page: '1' } }), 'mine')
  store.write(exchange(2, { path: '/feed', query: { page: '2' } }), 'mine')
  store.write(exchange(3, { path: '/feed' }), 'pinned')
  store.write(exchange(4, { path: '/feed' }), 'current')
  store.write(exchange(5, { path: '/feed' }), 'default')
  store.write(exchange(6, { host: 'other.example.com', path: '/feed' }), 'mine')
  store.write(exchange(7, { path: '/silent', response: null }), 'mine')
  /** The reader of a call to GET <host>/feed under a rule with this key and replay_session */
  const reader = (host: string, request_key: string, replay_session: string, current: string) =>
    new RecordingReader(
      store,
      { method: 'GET', host, path: '/feed' },
      { request_key, replay_session },
      current,
    )
  const seq = async (found: Promise<Recorded | null>) => (await found)?.seq ?? null
  const seqs = async (found: Promise<Recorded[]>) => (await found).map((recorded) => recorded.seq)

  // Whose session: the one asked for, the rule's, the one in hand, then default. '' is not given
  const feed = reader('api.example.com', 'GET:/feed', '', 'current')
  const pinned = reader('api.example.com', 'GET:/feed', 'pinned', 'current')
  assert.equal(await seq(feed.one({ session: 'mine', query: { page: '1' } })), 1)
  assert.equal(await seq(feed.one({ session: 'mine' })), 2)
  assert.equal(await seq(pinned.one({ session: 'mine' })), 2)
  assert.equal(await seq(pinned.one()), 3)
  assert.equal(await seq(feed.one()), 4)
  assert.equal(await seq(feed.one({ session: '', key: '' })), 4)
  assert.equal(await seq(reader('api.example.com', 'GET:/feed', '', '').one()), 5)
  assert.deepEqual(await seqs(feed.all({ session: 'mine' })), [1, 2])

  // Which endpoint: this request's, else the rule key's pattern; or the key given, at the host and
  // path it names, else by its pattern
  const nowhere = reader('nowhere.example.com', 'GET:*.example.com/feed', '', 'mine')
  assert.deepEqual(await seqs(nowhere.all()), [1, 2, 6])
  assert.deepEqual(await seqs(nowhere.all({ key: 'GET:other.example.com/feed' })), [6])
  assert.deepEqual(await seqs(nowhere.all({ key: 'GET:/feed' })), [1, 2, 6])
  await assert.rejects(nowhere.one({ key: 'nonsense' }), UserError)

  // Only calls that were answered
  assert.equal(await nowhere.one({ key: 'GET:/silent' }), null)
  assert.deepEqual(await nowhere.all({ key: 'GET:/silent' }), [])
})

// close gives the queue five seconds at most, and a recording after it is written all the same
test('close waits for the queue, and a write after it still lands', async (t) => {
  const { store } = makeStore(t)
  const first = store.write(exchange(1), 's')
  await store.close()
  assert.ok(first !== null && existsSync(first), String(first))

  const second = store.write(exchange(2), 's')
  await store.flush()
  assert.ok(second !== null && existsSync(second), String(second))
})

// ---------------------------------------------------------------- edge cases

// tunnel writes none of these files itself: they come from a hand or somebody else's recordings

/** A recording file put there by hand, where the store files GET api.example.com<path> under this
 *  session and seq; its path */
function writeByHand(
  store: RecordingStore,
  session: string,
  seq: number,
  text: string,
  path = '/x',
): string {
  const file = join(store.root, filePath(session, 'GET', 'api.example.com', path, seq))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
  return file
}

// A seq comes round again once the request log is cleared and tunnel restarts, or in an import of
// somebody else's recordings: the later write goes over the file
test('the same session, endpoint and seq written twice are one recording, the one written last', async (t) => {
  const { store } = makeStore(t)
  store.write(exchange(1, { body: 'first' }), 's')
  store.write(exchange(1, { body: 'second' }), 's')

  assert.deepEqual(
    (await store.index({ session: 's' })).map((row) => row.seq),
    [1],
  )
  assert.equal((await store.get('s', 1))?.response?.body, 'second')
})

// parseJson refuses NaN, Infinity and -Infinity, which JSON has no words for, and the file is
// skipped as any file that cannot be read is
test('a recording with NaN or Infinity in its body is skipped, with one warning', async (t) => {
  const { store } = makeStore(t)
  store.write(exchange(1), 's')
  await store.flush()
  const nonFinite = formatRecording(exchange(2, { path: '/nan', body: { a: 0, b: 0, c: 0 } }))
    .replace('"a": 0', '"a": NaN')
    .replace('"b": 0', '"b": Infinity')
    .replace('"c": 0', '"c": -Infinity')
  const file = writeByHand(store, 's', 2, nonFinite, '/nan')

  const logs = captureLogs(t)
  assert.deepEqual(
    (await store.index()).map((row) => row.seq),
    [1],
  )
  const warnings = logs.records.filter((record) => record.level === 'warning')
  assert.equal(warnings.length, 1, logs.text())
  assert.ok(
    warnings[0]?.message.startsWith(`Skipping an unreadable recording ${file}: `),
    logs.text(),
  )
})

// parseExchange makes "response": {} a response of defaults. So the row's status is 0 rather than
// null, and RecordingReader, which leaves out a call with no response, hands this one to a script
test('a recording edited to "response": {} has a response of defaults, status 0, read or imported', async (t) => {
  const { store } = makeStore(t)
  const edited: Record<string, unknown> = {
    ...JSON.parse(formatRecording(exchange(1))),
    response: {},
  }
  writeByHand(store, 's', 1, JSON.stringify(edited))
  const reader = new RecordingReader(
    store,
    { method: 'GET', host: 'api.example.com', path: '/x' },
    { request_key: 'GET:/x', replay_session: '' },
    's',
  )

  assert.equal((await store.index({ session: 's' }))[0]?.status, 0)
  assert.deepEqual((await store.get('s', 1))?.response, makeExchangeResponse())
  assert.equal((await reader.one())?.status, 0)
  assert.equal(await store.importExchanges([edited], 'imported'), 1)
  assert.equal((await store.index({ session: 'imported' }))[0]?.status, 0)
})

// parseExchange holds "request" to an object, so a file with "request": null is skipped with a
// warning and the import refused
test('a recording edited to "request": null is skipped with a warning, and refused as an import', async (t) => {
  const logs = captureLogs(t)
  const { store } = makeStore(t)
  const edited: Record<string, unknown> = {
    ...JSON.parse(formatRecording(exchange(1))),
    request: null,
  }
  const file = writeByHand(store, 's', 1, JSON.stringify(edited))

  assert.deepEqual(await store.index({ session: 's' }), [])
  const warnings = logs.records.filter((record) => record.level === 'warning')
  assert.equal(warnings.length, 1, logs.text())
  assert.ok(
    warnings[0]?.message.startsWith(`Skipping an unreadable recording ${file}: `),
    logs.text(),
  )
  await assert.rejects(
    store.importExchanges([edited], 's'),
    (error) =>
      error instanceof UserError &&
      error.message.startsWith('an exchange field has the wrong shape: '),
  )
})

// parseExchange holds a query or header value to a string, as tunnel writes them, and the warning
// and the refusal both name the value that is not one
test('a query or header value that is not a string: the file is skipped and the import refused, naming it', async (t) => {
  const logs = captureLogs(t)
  const { store } = makeStore(t)
  const query = formatRecording(exchange(1, { query: { page: '1' } })).replace(
    '"page": "1"',
    '"page": 1',
  )
  const header = formatRecording(exchange(2)).replace(
    '"content-type": "application/json"',
    '"content-type": 1',
  )
  writeByHand(store, 's', 1, query)
  writeByHand(store, 's', 2, header)

  assert.deepEqual(await store.index({ session: 's' }), [])
  const warnings = logs.records.filter((record) => record.level === 'warning')
  assert.equal(warnings.length, 2, logs.text())
  assert.ok(warnings[0]?.message.includes(' request.query.page: '), logs.text())
  assert.ok(warnings[1]?.message.includes(' response.headers.content-type: '), logs.text())
  for (const [text, named] of [
    [query, 'request.query.page'],
    [header, 'response.headers.content-type'],
  ] as const) {
    await assert.rejects(
      store.importExchanges([JSON.parse(text)], 's'),
      (error) =>
        error instanceof UserError &&
        error.message.startsWith('an exchange field has the wrong shape: ') &&
        error.message.includes(` ${named}: `),
      named,
    )
  }
})

// An entry is read as parseExchange reads any exchange: 2.0 is 2, and true is 1
test('an import files a seq of 2.0 as 2, and one of true as 1', async (t) => {
  const { store } = makeStore(t)
  const text = formatRecording(exchange(9))
  // Read from JSON text, as the admin API hands an import over: written in JS, 2.0 is 2 already
  const float = parseJson(text.replace('"seq": 9,', '"seq": 2.0,'))
  const flag = { ...JSON.parse(text), seq: true }

  assert.equal(await store.importExchanges([float, flag], 's'), 2)
  const session = join(store.root, 's')
  const files = treeFiles(session)
  assert.deepEqual(files, [
    'api.example.com/GET/x/000001.json',
    'api.example.com/GET/x/000002.json',
  ])
  assert.deepEqual(
    files.map((name) => field(parseJson(readFileSync(join(session, name), 'utf8')), 'seq')),
    [1, 2],
  )
})

// rmSync takes the link itself and leaves what it points to; the count is of the files behind it
test('deleting a session that is a symlink removes the link, keeps what it points to, and counts its files', async (t) => {
  const { store } = makeStore(t)
  store.write(exchange(1), 'real')
  store.write(exchange(2), 'real')
  await store.flush()
  const link = join(store.root, 'linked')
  symlinkSync('real', link)

  assert.equal(await store.delete('linked'), 2)
  assert.equal(lstatSync(link, { throwIfNoEntry: false }), undefined)
  assert.deepEqual(treeFiles(join(store.root, 'real')), [
    'api.example.com/GET/x/000001.json',
    'api.example.com/GET/x/000002.json',
  ])
})

// The reading half of a file where a directory should be; "a write that fails is logged" is the
// writing half. A recordings directory that is a file holds no session
test('a recordings directory that is a plain file reads as empty', async (t) => {
  const { store } = makeStore(t)
  writeFileSync(store.root, 'not a directory')

  assert.deepEqual(await store.index(), [])
  assert.deepEqual(await store.sessions(), {})
  assert.equal(await store.count('s'), 0)
})

// Only null and undefined are every session; '' is a name like any other, which safeSegment makes _
test("index({ session: '' }) is the session named _", async (t) => {
  const { store } = makeStore(t)
  store.write(exchange(1), '_')
  store.write(exchange(2), 's')

  assert.deepEqual(
    (await store.index({ session: '' })).map((row) => `${row.session} ${row.seq}`),
    ['_ 1'],
  )
})

// sessions() takes the names in order, and an object puts those that look like integers first,
// smallest first, which is the order the panel shows anyway once the browser has parsed the JSON
test('sessions(): the names that look like integers come first, smallest first', async (t) => {
  const { store } = makeStore(t)
  store.write(exchange(1), 'alpha')
  store.write(exchange(2), '-x')
  store.write(exchange(3), '2024')
  store.write(exchange(4), '10')
  store.write(exchange(5), '9')

  assert.deepEqual(Object.keys(await store.sessions()), ['9', '10', '2024', '-x', 'alpha'])
})
