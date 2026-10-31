// Replay: the recordings answering instead of the real server.
//
// The recordings are made the way they are made in earnest — `record start`, then
// calls through the core with a stand-in backend — and then replayed through the
// same core, because the question worth asking is whether what was recorded comes
// back. The global mode, the three strategies and the 404 for what nobody
// recorded are all driven from the admin API and the `tunnel` command line, since
// those are what a test run actually uses.
import assert from 'node:assert/strict'
import { renameSync } from 'node:fs'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { createAdminApp } from '../src/app.ts'
import { CertificateAuthority } from '../src/certs.ts'
import { Paths, TunnelConfigManager } from '../src/config.ts'
import { TunnelCore } from '../src/core.ts'
import type { Exchange } from '../src/exchanges.ts'
import { parseJson, type JsonValue } from '../src/json.ts'
import { makeRequest, type Request, type Response } from '../src/messages.ts'
import {
  DEFAULT_SESSION,
  type DefaultMode,
  type TunnelConfig,
  type TunnelRequestConfig,
} from '../src/models.ts'
import { filePath, type RecordedCall } from '../src/recordings.ts'
import type { UpstreamRequest, UpstreamResponse } from '../src/upstream.ts'
import { adminClient, type AdminClient, type AdminResponse } from './support/admin-env.ts'
import { cliRunner } from './support/cli.ts'
import { fakeUpstream, jsonAnswer } from './support/fake-upstream.ts'
import { captureLogs } from './support/logs.ts'
import { testRoutes } from './support/routes.ts'
import { tmpDir } from './support/tmp.ts'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff])

/** The stand-in backend: it answers with what it was asked for */
function upstream(request: UpstreamRequest): UpstreamResponse {
  const url = new URL(request.url)
  if (url.pathname === '/api/image') {
    return { status: 200, headers: { 'content-type': 'image/png' }, body: PNG }
  }
  const status = url.pathname === '/api/created' ? 201 : 200
  return jsonAnswer({ path: url.pathname, page: url.searchParams.get('page') }, status, {
    'x-from': 'backend',
  })
}

// ---------------------------------------------------------------- env

// env: a core that records and replays, the admin API over it, and the CLI. The core is the real
// one, with the stand-in backend above as its upstream, so nothing here reaches a network: what is
// recorded comes from the backend, and replay must not want a network at all. The admin API is the
// real one too: record, mode, switch, patchConfig, importRecordings and last go through its routes,
// in process, and client hands back its answers whole, status code and all.

interface Env {
  manager: TunnelConfigManager
  core: TunnelCore
  /** One request through the core, exactly as the proxy port asks it: GET /v5/suggestions on
   *  api.example.com unless told otherwise */
  send(fields?: Partial<Request>): Promise<Response>
  /** The rule for this key, made or changed */
  configure(key: string, fields: Partial<Omit<TunnelRequestConfig, 'request_key'>>): void
  /** One recording per page, so the samples differ by query and by seq: POST
   *  /__admin__/record/start, a call per page, then /__admin__/record/stop */
  record(session: string, pages: number[], where?: { path?: string; host?: string }): Promise<void>
  /** The global mode, set with PATCH /__admin__/config */
  mode(value: DefaultMode): Promise<void>
  /** Switch the current session, the way `tunnel session NAME` does: PATCH /__admin__/config */
  switch(name: string): Promise<AdminResponse>
  /** PATCH /__admin__/config */
  patchConfig(fields: Partial<TunnelConfig>): Promise<void>
  /** POST /__admin__/recordings/import */
  importRecordings(body: {
    session?: string
    exchanges: unknown[]
    replace?: boolean
  }): Promise<void>
  /** The exchange the log wrote for the request just answered */
  last(): Promise<Exchange>
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
  // order they were added
  let core: TunnelCore | undefined
  t.after(() => core?.close())
  const dir = tmpDir(t)
  const manager = new TunnelConfigManager(Paths.inOneDirectory(dir))
  core = new TunnelCore(manager, { upstream: fakeUpstream(upstream), routes: testRoutes() })
  const app = createAdminApp({ manager, core, ca: new CertificateAuthority(manager.paths) })
  const client = adminClient(app)
  // The command over the same app, run in env's own directory
  const cli = cliRunner({ fetch: (url, init) => app.request(url, init), cwd: dir })

  const send = (fields: Partial<Request> = {}) =>
    core.resolve(
      makeRequest({ method: 'GET', path: '/v5/suggestions', host: 'api.example.com', ...fields }),
    )

  return {
    manager,
    core,
    send,
    configure: (key, fields) => manager.updateRequestConfig(key, fields),
    record: async (session, pages, { path = '/v5/suggestions', host = 'api.example.com' } = {}) => {
      await client.post('/__admin__/record/start', { json: { session } })
      for (const page of pages) await send({ path, host, query: { page: String(page) } })
      await client.post('/__admin__/record/stop')
    },
    mode: async (value) => {
      await client.patch('/__admin__/config', { json: { default_mode: value } })
    },
    switch: (name) => client.patch('/__admin__/config', { json: { session: name } }),
    patchConfig: async (fields) => {
      await client.patch('/__admin__/config', { json: fields })
    },
    importRecordings: async (body) => {
      await client.post('/__admin__/recordings/import', { json: body })
    },
    last: async () => (await client.get(`/__admin__/requests/${core.exchanges.lastSeq}`)).json(),
    client,
    run: cli.run,
    takeOutput: cli.takeOutput,
  }
}

const payload = (response: Response): JsonValue => parseJson(response.body.toString('utf8'))

/** What the stand-in backend answers with, recorded and replayed */
type Echo = { path: string; page: string | null }

/** The detail of an answer tunnel made itself */
const detail = (response: Response) => (payload(response) as { detail: string }).detail

// ---------------------------------------------------------------- what comes back

test('a replay answers with the recorded status, headers and body', async (t) => {
  const env = await makeEnv(t)
  await env.record('acct_a', [1], { path: '/api/created' })
  env.configure('GET:api.example.com/api/created', { mode: 'replay', replay_session: 'acct_a' })

  const replayed = await env.send({ path: '/api/created' })

  assert.equal(replayed.status, 201)
  assert.deepEqual(payload(replayed), { path: '/api/created', page: '1' })
  assert.equal(replayed.headers['x-from'], 'backend')
  // Which recording answered, for whoever is reading the traffic
  assert.equal(replayed.headers['x-tunnel-replay'], '1')
  // And the log says it too, so the panel and `requests show` can
  assert.equal((await env.last()).replay_seq, 1)
  assert.equal((await env.last()).unmatched, false)
})

// A body that was not text was stored base64; it has to come back as bytes
test('a recorded binary body is replayed byte for byte', async (t) => {
  const env = await makeEnv(t)
  await env.record('acct_a', [1], { path: '/api/image' })
  env.configure('GET:api.example.com/api/image', { mode: 'replay', replay_session: 'acct_a' })

  assert.deepEqual((await env.send({ path: '/api/image' })).body, PNG)
})

// The CI path: recordings arrive from a repository and answer from there.
//
// A committed file can carry the headers that described the bytes it was sent as, and sending
// those on would have the client read a length that is no longer true.
test('an imported recording is replayed without its transport headers', async (t) => {
  const env = await makeEnv(t)
  await env.importRecordings({
    session: 'acct_a',
    exchanges: [
      {
        seq: 7,
        kind: 'http',
        request: { method: 'GET', host: 'api.example.com', path: '/v5/suggestions', query: {} },
        response: {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-length': '999',
            'transfer-encoding': 'chunked',
          },
          body: { cards: [] },
          body_encoding: 'json',
        },
      },
    ],
  })
  env.configure('GET:api.example.com/v5/suggestions', { mode: 'replay', replay_session: 'acct_a' })

  const replayed = await env.send()

  assert.deepEqual(payload(replayed), { cards: [] })
  assert.equal(replayed.headers['x-tunnel-replay'], '7')
  assert.ok(!('content-length' in replayed.headers))
  assert.ok(!('transfer-encoding' in replayed.headers))
})

// One field of yesterday's answer changed, the rest of it exactly as recorded
test('a replayed body can be merged into', async (t) => {
  const env = await makeEnv(t)
  await env.record('acct_a', [1])
  env.configure('GET:api.example.com/v5/suggestions', {
    mode: 'replay',
    replay_session: 'acct_a',
    merge_json: { page: '9' },
    headers: { 'x-from': 'the rule' },
  })

  const replayed = await env.send({ query: { page: '1' } })

  assert.deepEqual(payload(replayed), { path: '/v5/suggestions', page: '9' })
  // The rule's headers are the last word, over the recorded ones
  assert.equal(replayed.headers['x-from'], 'the rule')
  assert.equal(replayed.headers['x-tunnel-replay'], '1')
})

// A client that is strict about the headers it sees should not have to see it
test('the replay_marker can be turned off', async (t) => {
  const env = await makeEnv(t)
  await env.record('acct_a', [1])
  env.configure('GET:api.example.com/v5/suggestions', { mode: 'replay', replay_session: 'acct_a' })
  await env.patchConfig({ replay_marker: false })

  const replayed = await env.send()

  assert.ok(!('x-tunnel-replay' in replayed.headers))
  // The log still knows which recording answered; only the wire is quiet
  assert.equal((await env.last()).replay_seq, 1)
})

// ---------------------------------------------------------------- the strategies

test('match takes the newest recording with the same query', async (t) => {
  const env = await makeEnv(t)
  await env.record('acct_a', [1, 2, 1])
  env.configure('GET:api.example.com/v5/suggestions', { mode: 'replay', replay_session: 'acct_a' })

  const seqFor = async (page: string) =>
    (await env.send({ query: { page } })).headers['x-tunnel-replay']

  assert.equal(await seqFor('2'), '2')
  // Two recordings were made with page=1; the newer one is the answer
  assert.equal(await seqFor('1'), '3')
})

test('match falls back to the newest when no query is equal', async (t) => {
  const env = await makeEnv(t)
  await env.record('acct_a', [1, 2])
  env.configure('GET:api.example.com/v5/suggestions', { mode: 'replay', replay_session: 'acct_a' })

  const replayed = await env.send({ query: { page: '9' } })

  assert.equal(replayed.headers['x-tunnel-replay'], '2')
  assert.equal((payload(replayed) as Echo).page, '2')
})

// What a polling endpoint needs: call after call, then no further change
test('sequence walks the recordings and stays on the last', async (t) => {
  const env = await makeEnv(t)
  await env.record('acct_a', [1, 2])
  env.configure('GET:api.example.com/v5/suggestions', {
    mode: 'replay',
    replay_session: 'acct_a',
    replay_strategy: 'sequence',
  })

  const seqs: (string | undefined)[] = []
  for (let call = 0; call < 4; call++) seqs.push((await env.send()).headers['x-tunnel-replay'])

  assert.deepEqual(seqs, ['1', '2', '2', '2'])
})

// A counter left over from one test case must not answer the next one
test('tunnel reset puts a sequence replay back at the first recording', async (t) => {
  const env = await makeEnv(t)
  await env.record('acct_a', [1, 2])
  env.configure('GET:api.example.com/v5/suggestions', {
    mode: 'replay',
    replay_session: 'acct_a',
    replay_strategy: 'sequence',
  })
  await env.send()

  assert.equal(await env.run('reset'), 0)

  assert.equal((await env.send()).headers['x-tunnel-replay'], '1')
})

test('last always takes the newest recording', async (t) => {
  const env = await makeEnv(t)
  await env.record('acct_a', [1, 2])
  env.configure('GET:api.example.com/v5/suggestions', {
    mode: 'replay',
    replay_session: 'acct_a',
    replay_strategy: 'last',
  })

  const seqs: (string | undefined)[] = []
  for (const page of ['1', '2', '3']) {
    seqs.push((await env.send({ query: { page } })).headers['x-tunnel-replay'])
  }

  assert.deepEqual(seqs, ['2', '2', '2'])
})

// ---------------------------------------------------------------- finding the samples

// One rule for a family of hosts, but each host's own answer
test('a wildcard rule replays the host that was called', async (t) => {
  const env = await makeEnv(t)
  await env.record('acct_a', [1], { host: 'api.example.com' })
  await env.record('acct_a', [1], { host: 'cdn.example.com' })
  env.configure('GET:*.example.com/v5/suggestions', { mode: 'replay', replay_session: 'acct_a' })

  assert.equal((await env.send({ host: 'api.example.com' })).headers['x-tunnel-replay'], '1')
  assert.equal((await env.send({ host: 'cdn.example.com' })).headers['x-tunnel-replay'], '2')
})

// Nothing recorded for this host: the pattern's own samples stand in
test('a wildcard rule falls back to what was recorded under the pattern', async (t) => {
  const env = await makeEnv(t)
  await env.record('acct_a', [1], { host: 'api.example.com' })
  env.configure('GET:*.example.com/v5/*', { mode: 'replay', replay_session: 'acct_a' })

  const replayed = await env.send({ host: 'other.example.com' })

  assert.equal(replayed.headers['x-tunnel-replay'], '1')
  assert.equal((payload(replayed) as Echo).path, '/v5/suggestions')
})

test('a rule that names a session with nothing in it says so', async (t) => {
  const env = await makeEnv(t)
  await env.record('acct_a', [1])
  env.configure('GET:api.example.com/v5/suggestions', { mode: 'replay', replay_session: 'acct_b' })

  const answered = await env.send()

  assert.equal(answered.status, 404)
  assert.ok(detail(answered).includes('acct_b'))
  // A rule did answer it, so this is not a missing rule
  assert.equal((await env.last()).unmatched, false)
  assert.ok(!('x-tunnel-unmatched' in answered.headers))
})

// A config file can leave the field empty, and empty means the default one
test('a rule with no session of its own says which one was searched', async (t) => {
  const env = await makeEnv(t)
  env.configure('GET:api.example.com/v5/suggestions', { mode: 'replay', replay_session: '' })

  const answered = await env.send()

  assert.equal(answered.status, 404)
  assert.ok(detail(answered).endsWith(`in session ${DEFAULT_SESSION}`))
})

// `--session 'acct a'` would otherwise quietly replay whatever is in acct_a
test('a rule cannot name a session the recordings could not be filed under', async (t) => {
  const env = await makeEnv(t)
  const refused = await env.client.patch('/__admin__/mocks', {
    json: { key: 'GET:api.example.com/v5/suggestions', mode: 'replay', replay_session: 'acct a' },
  })

  assert.equal(refused.status, 400)
  assert.ok(refused.json().detail.includes('session'))
  // Refused whole: the mode did not take effect either
  assert.ok(
    !Object.hasOwn(env.manager.getConfig().request_configs, 'GET:api.example.com/v5/suggestions'),
  )

  assert.equal(
    await env.run(
      'set',
      'GET',
      'api.example.com/v5/suggestions',
      '--replay',
      '--session',
      'acct a',
    ),
    1,
  )
})

// ---------------------------------------------------------------- the global mode

test('replay mode answers an unconfigured endpoint from the recordings', async (t) => {
  const env = await makeEnv(t)
  await env.record('default', [1])
  await env.mode('replay')

  const replayed = await env.send({ query: { page: '1' } })

  assert.deepEqual(payload(replayed), { path: '/v5/suggestions', page: '1' })
  assert.equal(replayed.headers['x-tunnel-replay'], '1')
  assert.equal((await env.last()).mode, 'replay')
  assert.equal((await env.last()).unmatched, false)
})

// The point of the mode: a test case cannot quietly reach the real backend
test('replay mode refuses what was never recorded', async (t) => {
  const env = await makeEnv(t)
  await env.mode('replay')

  const answered = await env.send({ path: '/api/x' })

  assert.equal(answered.status, 404)
  assert.deepEqual(payload(answered), {
    detail: 'no rule or recording for GET:api.example.com/api/x',
    key: 'GET:api.example.com/api/x',
  })
  assert.equal(answered.headers['x-tunnel-unmatched'], '1')
  assert.equal((await env.last()).unmatched, true)
})

// An endpoint with no rule is normal while the real server is answering
test('passthrough mode never marks a request unmatched', async (t) => {
  const env = await makeEnv(t)

  const answered = await env.send({ path: '/api/x' })

  assert.equal(answered.status, 200)
  assert.equal((await env.last()).unmatched, false)
})

// The missing-rule list: what replay could not answer, and nothing else
test('tunnel requests unmatched lists what replay refused', async (t) => {
  const env = await makeEnv(t)
  await env.record('default', [1])
  await env.mode('replay')
  await env.send({ query: { page: '1' } }) // replayed, so not missing anything
  await env.send({ path: '/api/x' })
  await env.send({ path: '/api/y' })

  assert.equal(await env.run('requests', '--unmatched'), 0)
  const listed = (
    await env.client.get('/__admin__/requests', { params: { each: '1', unmatched: '1' } })
  ).json()

  assert.deepEqual(
    listed.requests.map((row: { key: string }) => row.key),
    ['GET:api.example.com/api/x', 'GET:api.example.com/api/y'],
  )
  assert.equal(listed.unmatched_count, 2)
})

test('tunnel mode prints the mode and switches it', async (t) => {
  const env = await makeEnv(t)
  assert.equal(await env.run('mode'), 0)
  assert.ok(env.takeOutput().out.startsWith('passthrough ·'))

  assert.equal(await env.run('mode', 'replay'), 0)
  assert.ok(env.takeOutput().out.startsWith('replay ·'))

  assert.equal((await env.client.get('/__admin__/config')).json().default_mode, 'replay')
  await env.run('mode')
  assert.ok(env.takeOutput().out.startsWith('replay ·'))
})

test('tunnel set replay configures the rule', async (t) => {
  const env = await makeEnv(t)
  assert.equal(
    await env.run(
      'set',
      'GET',
      'api.example.com/v5/suggestions',
      '--replay',
      '--strategy',
      'sequence',
      '--session',
      'acct_b',
    ),
    0,
  )

  const rule = env.manager.getConfig().request_configs['GET:api.example.com/v5/suggestions']
  assert.equal(rule?.mode, 'replay')
  assert.equal(rule?.replay_strategy, 'sequence')
  assert.equal(rule?.replay_session, 'acct_b')
})

test('tunnel set refuses two sources at once', async (t) => {
  const env = await makeEnv(t)
  assert.equal(await env.run('set', 'GET', '/a', '--replay', '-d', '{}'), 1)
})

// ---------------------------------------------------------------- the current session

// One switch moves a whole test run onto another batch of recordings
test('replay mode reads the current session', async (t) => {
  const env = await makeEnv(t)
  await env.record('acct_a', [1])
  await env.record('acct_b', [2])
  await env.mode('replay')

  await env.switch('acct_a')
  const fromA = await env.send({ query: { page: '1' } })
  await env.switch('acct_b')
  const fromB = await env.send({ query: { page: '2' } })

  assert.equal((payload(fromA) as Echo).page, '1')
  assert.equal(fromA.headers['x-tunnel-replay'], '1')
  assert.equal((payload(fromB) as Echo).page, '2')
  assert.equal(fromB.headers['x-tunnel-replay'], '2')
})

// `--replay` without `--session` is the rule that a switch carries along
test('a rule with no session of its own follows the current one', async (t) => {
  const env = await makeEnv(t)
  await env.record('acct_a', [1])
  await env.record('acct_b', [2])
  env.configure('GET:api.example.com/v5/suggestions', { mode: 'replay' })

  await env.switch('acct_a')
  assert.equal((await env.send({ query: { page: '1' } })).headers['x-tunnel-replay'], '1')

  await env.switch('acct_b')
  assert.equal((await env.send({ query: { page: '2' } })).headers['x-tunnel-replay'], '2')
})

test('a rule that names a session is left where it was pinned', async (t) => {
  const env = await makeEnv(t)
  await env.record('acct_a', [1])
  await env.record('acct_b', [2])
  env.configure('GET:api.example.com/v5/suggestions', { mode: 'replay', replay_session: 'acct_a' })

  await env.switch('acct_b')

  assert.equal((await env.send({ query: { page: '2' } })).headers['x-tunnel-replay'], '1')
})

// Another batch of recordings: a counter into the old one means nothing
test('switching the session starts a sequence replay over', async (t) => {
  const env = await makeEnv(t)
  await env.record('acct_a', [1, 2])
  await env.record('acct_b', [3, 4])
  env.configure('GET:api.example.com/v5/suggestions', {
    mode: 'replay',
    replay_strategy: 'sequence',
  })
  await env.switch('acct_a')
  assert.equal((await env.send()).headers['x-tunnel-replay'], '1')

  await env.switch('acct_b')

  assert.equal((await env.send()).headers['x-tunnel-replay'], '3')
})

// It is where recordings are filed, so a name that is not one is refused
test('the current session has to be a directory name', async (t) => {
  const env = await makeEnv(t)
  const refused = await env.switch('acct a')

  assert.equal(refused.status, 400)
  assert.ok(refused.json().detail.includes('session'))
  assert.equal((await env.client.get('/__admin__/config')).json().session, DEFAULT_SESSION)
})

// No argument: where this run reads and writes, and what else was recorded
test('tunnel session prints the one in hand and what else is on disk', async (t) => {
  const env = await makeEnv(t)
  await env.record('acct_a', [1, 2])
  await env.record('acct_b', [3])

  assert.equal(await env.run('session'), 0)

  const printed = env.takeOutput().out
  assert.ok(printed.startsWith('Session acct_b (1 recordings)'))
  assert.ok(printed.includes('acct_a: 2'))
})

// A session with nothing in it is switched to all the same, and said so
test('tunnel session switches and says when nothing is recorded there', async (t) => {
  const env = await makeEnv(t)
  await env.record('acct_a', [1])

  assert.equal(await env.run('session', 'acct_c'), 0)

  const printed = env.takeOutput().out
  assert.ok(printed.startsWith('Switched to session acct_c (0 recordings)'))
  assert.ok(printed.includes('nothing is recorded there'))
  assert.ok(printed.includes('acct_a: 1'))
  assert.equal((await env.client.get('/__admin__/config')).json().session, 'acct_c')
})

// The one command a test run needs: replay, and which recordings it reads
test('tunnel mode sets the mode and the session in one call', async (t) => {
  const env = await makeEnv(t)
  await env.record('acct_a', [1])

  assert.equal(await env.run('mode', 'replay', '--session', 'acct_a'), 0)

  assert.ok(env.takeOutput().out.startsWith('replay · session acct_a (1 recordings)'))
  const config = (await env.client.get('/__admin__/config')).json()
  assert.deepEqual([config.default_mode, config.session], ['replay', 'acct_a'])
})

// ---------------------------------------------------------------- the finer points

// The core's half of 'tunnel reset puts a sequence replay back at the first recording', which
// waits for the CLI: what `tunnel reset` and POST /__admin__/state/reset call
test('resetState puts a sequence replay back at the first recording and names what it cleared', async (t) => {
  const env = await makeEnv(t)
  // Both recorded before anything is replayed, so their seqs are 1, 2 and 3, 4: every call the
  // core answers takes the next seq, replayed or not
  await env.record('acct_a', [1, 2])
  await env.record('acct_a', [3, 4], { path: '/v5/other' })
  for (const path of ['/v5/suggestions', '/v5/other']) {
    env.configure(`GET:api.example.com${path}`, {
      mode: 'replay',
      replay_session: 'acct_a',
      replay_strategy: 'sequence',
    })
  }
  const seqFor = async (path = '/v5/suggestions') =>
    (await env.send({ path })).headers['x-tunnel-replay']

  assert.equal(await seqFor(), '1')
  assert.equal(await seqFor(), '2')
  assert.deepEqual(env.core.resetState(), ['GET:api.example.com/v5/suggestions'])
  assert.equal(await seqFor(), '1')

  // The script buckets and the counters are cleared together, and named in one sorted list
  assert.equal(await seqFor('/v5/other'), '3')
  env.configure('GET:/api/s', {
    mode: 'script',
    script: 'function handler(ctx) { ctx.state.n = 1; return {} }',
  })
  assert.equal((await env.send({ path: '/api/s' })).status, 200)
  assert.deepEqual(env.core.resetState(), [
    'GET:/api/s',
    'GET:api.example.com/v5/other',
    'GET:api.example.com/v5/suggestions',
  ])
  assert.equal(await seqFor(), '1')
  assert.equal(await seqFor('/v5/other'), '3')

  // A key clears that rule's counter and leaves the others where they are
  assert.deepEqual(env.core.resetState('GET:api.example.com/v5/suggestions'), [
    'GET:api.example.com/v5/suggestions',
  ])
  assert.equal(await seqFor(), '1')
  assert.equal(await seqFor('/v5/other'), '4')
  assert.deepEqual(env.core.resetState('GET:/never'), [])
})

test('replay says in the log what it answered from, or that it had nothing', async (t) => {
  const logs = captureLogs(t)
  const said = () =>
    logs.records
      .filter((record) => record.level === 'info' && record.logger === 'tunnel.core')
      .map((record) => record.message)
  const env = await makeEnv(t)
  // Recorded first: in the global replay mode nothing passes through to be recorded
  await env.record('acct_a', [1])
  await env.mode('replay')

  await env.send({ path: '/api/x' })

  assert.ok(
    said().includes('Nothing configured and nothing recorded for GET:api.example.com/api/x'),
    said().join('\n'),
  )

  env.configure('GET:api.example.com/v5/suggestions', { mode: 'replay', replay_session: 'acct_a' })

  await env.send()

  assert.ok(
    said().includes(
      'Replaying GET:api.example.com/v5/suggestions from session acct_a, recording 1',
    ),
    said().join('\n'),
  )
})

test("the replay marker is a string, and a rule's headers land on the 404 too", async (t) => {
  const env = await makeEnv(t)
  await env.record('acct_a', [1], { path: '/api/created' })
  env.configure('GET:api.example.com/api/created', { mode: 'replay', replay_session: 'acct_a' })

  const replayed = await env.send({ path: '/api/created' })

  // A header value is text: the seq a recording is filed under is written out as one
  assert.equal(typeof replayed.headers['x-tunnel-replay'], 'string')
  assert.equal(replayed.headers['x-tunnel-replay'], '1')

  // 'a rule that names a session with nothing in it says so', with a header of the rule's own
  env.configure('GET:api.example.com/api/created', {
    mode: 'replay',
    replay_session: 'acct_b',
    headers: { 'x-flag': '1' },
  })

  const answered = await env.send({ path: '/api/created' })

  assert.equal(answered.status, 404)
  assert.equal(answered.headers['x-flag'], '1')
})

test('a recorded body with an integer past 2^53 is replayed with it intact, merge_json or not', async (t) => {
  const env = await makeEnv(t)
  await env.importRecordings({
    session: 'acct_a',
    exchanges: [
      {
        seq: 1,
        kind: 'http',
        request: { method: 'GET', host: 'api.example.com', path: '/v5/suggestions', query: {} },
        response: {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: parseJson('{"id": 12345678901234567890, "n": 1}'),
          body_encoding: 'json',
        },
      },
    ],
  })
  env.configure('GET:api.example.com/v5/suggestions', { mode: 'replay', replay_session: 'acct_a' })

  const replayed = await env.send()

  assert.equal(replayed.body.toString('utf8'), '{"id": 12345678901234567890, "n": 1}')

  env.configure('GET:api.example.com/v5/suggestions', {
    mode: 'replay',
    replay_session: 'acct_a',
    merge_json: { n: 2 },
  })

  const merged = await env.send()

  assert.equal(merged.body.toString('utf8'), '{"id": 12345678901234567890, "n": 2}')
})

test('a recording whose file is gone is a 404, and the sequence does not move on', async (t) => {
  const env = await makeEnv(t)
  await env.record('acct_a', [1, 2])
  env.configure('GET:api.example.com/v5/suggestions', {
    mode: 'replay',
    replay_session: 'acct_a',
    replay_strategy: 'sequence',
  })
  // Gone after the index read the session, which it did as the recording stopped (its status
  // counts the session): the sample is still offered, and the file is missed as it is loaded
  const file = join(
    env.core.recordings.root,
    filePath('acct_a', 'GET', 'api.example.com', '/v5/suggestions', 1),
  )
  renameSync(file, `${file}.away`)

  const answered = await env.send()

  assert.equal(answered.status, 404)
  assert.ok(detail(answered).includes('acct_a'))

  renameSync(`${file}.away`, file)

  assert.equal((await env.send()).headers['x-tunnel-replay'], '1')
})

// A method that is not all letters makes a key no rule could have been stored under; the store
// finds nothing for it rather than failing
test('an M-SEARCH request in replay mode with nothing recorded is a 404, not a 500', async (t) => {
  const env = await makeEnv(t)
  await env.mode('replay')

  const answered = await env.send({ method: 'M-SEARCH', path: '/x' })

  assert.equal(answered.status, 404)
  assert.equal(answered.headers['x-tunnel-unmatched'], '1')
  assert.deepEqual(payload(answered), {
    detail: 'no rule or recording for M-SEARCH:api.example.com/x',
    key: 'M-SEARCH:api.example.com/x',
  })
})

// Between reading a sequence's position and moving it on, the store is read with awaits, so
// replays that arrive together have to take turns not to share a recording
test('sequence replays that arrive together are handed one recording each, in turn', async (t) => {
  const env = await makeEnv(t)
  await env.record('acct_a', [1, 2, 3, 4])
  env.configure('GET:api.example.com/v5/suggestions', {
    mode: 'replay',
    replay_session: 'acct_a',
    replay_strategy: 'sequence',
  })

  const together = await Promise.all([env.send(), env.send(), env.send()])

  assert.deepEqual(
    together.map((response) => response.headers['x-tunnel-replay']),
    ['1', '2', '3'],
  )
  assert.equal((await env.send()).headers['x-tunnel-replay'], '4')
})

// A reset that lands while a replay is reading its recording counts as coming after it: that
// replay answers from where it was, and the sequence starts over all the same
test('a reset while a replay reads its recording still puts the sequence back at the first', async (t) => {
  const env = await makeEnv(t)
  await env.record('acct_a', [1, 2, 3])
  env.configure('GET:api.example.com/v5/suggestions', {
    mode: 'replay',
    replay_session: 'acct_a',
    replay_strategy: 'sequence',
  })
  assert.equal((await env.send()).headers['x-tunnel-replay'], '1')
  // The next recording is held as it is read, as a write the store has queued holds it
  const store = env.core.recordings
  const load = store.load.bind(store)
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  t.mock.method(store, 'load', async (call: RecordedCall) => {
    await held
    return load(call)
  })

  const answering = env.send()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(env.core.resetState(), ['GET:api.example.com/v5/suggestions'])
  release()

  assert.equal((await answering).headers['x-tunnel-replay'], '2')
  assert.equal((await env.send()).headers['x-tunnel-replay'], '1')
})

// Neither the rule nor the run names a session: replay reads the default one
test('with no session in the rule and an empty current one, replay reads the default session', async (t) => {
  const env = await makeEnv(t)
  await env.record(DEFAULT_SESSION, [1])
  await env.switch('')
  env.configure('GET:api.example.com/v5/suggestions', { mode: 'replay', replay_session: '' })

  const replayed = await env.send()

  assert.equal(replayed.status, 200)
  assert.equal(replayed.headers['x-tunnel-replay'], '1')
})
