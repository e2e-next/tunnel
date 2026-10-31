// The library entry, src/index.ts: startTunnel() runs tunnel in the test's own process and hands
// back a handle whose methods call the admin API's own routes there. These tests are a black box:
// everything goes through what the entry exports, and what it did is looked at from outside, on the
// ports and on disk.
//
// Every tunnel here listens on 127.0.0.1, on ports the system picks, and is stopped once its test
// is over. One CA is made for the whole file and copied into the tunnels with caDir, which saves
// each of them a new RSA key.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { connect, createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { performance } from 'node:perf_hooks'
import { test, type TestContext } from 'node:test'
import { pathToFileURL } from 'node:url'
import { CertificateAuthority } from '../src/certs.ts'
import { Paths } from '../src/config.ts'
import {
  setLogSink,
  startTunnel,
  TunnelError,
  type CheckAnswer,
  type FunctionRulePatch,
  type Handler,
  type HandlerContext,
  type LogRecord,
  type LogSink,
  type Recorded,
  type RequestFilters,
  type Rule,
  type RulePatch,
  type StartOptions,
  type Tunnel,
} from '../src/index.ts'
import { PACKAGE_ROOT } from '../src/package-info.ts'
import { cliRunner } from './support/cli.ts'
import { freePort } from './support/ports.ts'
import { tmpDir } from './support/tmp.ts'
import { startUpstream } from './support/upstream.ts'

const NODE_MAJOR = Number(process.versions.node.split('.')[0])

// The CA the tunnels here start with, made once, in the directory setup.ts pinned for this process
const CA_DIR = join(process.env.TUNNEL_CONFIG_DIR!, 'library-ca')
mkdirSync(CA_DIR)
const CA = new CertificateAuthority(Paths.inOneDirectory(CA_DIR))
CA.ensure()

/** A tunnel for this test, stopped once it is over: on the loopback, and with the CA above unless
 *  the test gives a configDir, which has a CA of its own. Under replay: a request no rule answers
 *  is a 404 there, where passthrough would send it on to the real server, through this machine's
 *  system proxy if it has one, which may be a tunnel somebody is using */
async function start(t: TestContext, options: StartOptions = {}): Promise<Tunnel> {
  const tunnel = await startTunnel({
    proxyHost: '127.0.0.1',
    ...(options.configDir === undefined ? { caDir: CA_DIR } : {}),
    ...options,
  })
  t.after(() => tunnel.stop())
  await tunnel.setConfig({ default_mode: 'replay' })
  return tunnel
}

/** Points os.tmpdir() at a fresh directory for the rest of the test, and returns it: a tunnel
 *  makes its temporary directory there, so the test can tell whether one was left behind. Not
 *  os.tmpdir() itself, where the test files that node --test runs alongside this one write too */
function inTmpdir(t: TestContext): string {
  const dir = tmpDir(t)
  const previous = process.env.TMPDIR
  process.env.TMPDIR = dir
  t.after(() => {
    if (previous === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previous
  })
  return dir
}

/** That nothing listens on 127.0.0.1:<port>: a connection to it is refused */
async function refused(port: number): Promise<void> {
  const socket = connect(port, '127.0.0.1')
  const outcome = await new Promise<string | undefined>((resolve) => {
    socket.once('connect', () => resolve('connected'))
    socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code))
  })
  socket.destroy()
  assert.equal(outcome, 'ECONNREFUSED', `something listens on 127.0.0.1:${port}`)
}

/** assert.rejects' check for a TunnelError with this status and detail, which is its message too */
function tunnelError(status: number, detail: string): (error: unknown) => true {
  return (error) => {
    assert.ok(error instanceof TunnelError, `not a TunnelError: ${String(error)}`)
    const { name, message } = error
    assert.deepEqual(
      { name, status: error.status, detail: error.detail, message },
      { name: 'TunnelError', status, detail, message: detail },
    )
    return true
  }
}

/** A file's bytes, mode and modification time, to tell whether anything touched it */
function fileState(path: string): { bytes: Buffer; mode: number; mtimeMs: number } {
  const { mode, mtimeMs } = statSync(path)
  return { bytes: readFileSync(path), mode, mtimeMs }
}

test('startTunnel listens on two free ports, and stop() closes both and removes its temporary directory', async (t) => {
  // No caDir: the default, a new directory with a new CA in it
  const tunnel = await startTunnel({ proxyHost: '127.0.0.1' })
  t.after(() => tunnel.stop())
  const { proxyPort, adminPort, configDir } = tunnel
  assert.ok(proxyPort > 0 && adminPort > 0 && proxyPort !== adminPort)
  assert.equal(tunnel.proxyUrl, `http://127.0.0.1:${proxyPort}`)
  assert.equal(tunnel.adminUrl, `http://127.0.0.1:${adminPort}`)
  // A new tunnel-XXXXXX under os.tmpdir(), its symlinks resolved, as a given one's would be
  assert.equal(dirname(configDir), realpathSync(tmpdir()))
  assert.match(basename(configDir), /^tunnel-/)
  assert.equal(tunnel.caFile, join(configDir, 'ca.pem'))

  // The admin port answers, over that directory; the proxy port too, with its own page: the
  // certificate a device installs
  const health = await fetch(`${tunnel.adminUrl}/__admin__/health`)
  assert.equal(health.status, 200)
  assert.equal(((await health.json()) as { config_dir: string }).config_dir, configDir)
  const pem = await fetch(`${tunnel.proxyUrl}/ca.pem`)
  assert.equal(await pem.text(), readFileSync(tunnel.caFile, 'utf8'))

  await tunnel.stop()
  assert.equal(existsSync(configDir), false)
  await refused(proxyPort)
  await refused(adminPort)
})

test("stop() hands back the first call's promise, and Symbol.asyncDispose is stop", async (t) => {
  const tunnel = await start(t)
  const stopping = tunnel.stop()
  assert.equal(tunnel.stop(), stopping)
  assert.equal(tunnel[Symbol.asyncDispose](), stopping)
  assert.equal(await stopping, undefined)
  // And once it is over
  assert.equal(tunnel.stop(), stopping)
})

test(
  'await using stops the tunnel when its block ends',
  { skip: NODE_MAJOR < 24 ? 'await using is a SyntaxError before Node 24' : false },
  async (t) => {
    // Imported only here, where it parses
    const { heldForABlock } = await import('./support/await-using.ts')
    const { tunnel, inside } = await heldForABlock(() => start(t))
    assert.equal(inside.config_dir, tunnel.configDir)
    await assert.rejects(tunnel.status(), tunnelError(503, 'the tunnel is stopped'))
    assert.equal(existsSync(tunnel.configDir), false)
  },
)

test('a given configDir is used as it is and kept, and no tunnel.pid is written', async (t) => {
  const dir = tmpDir(t)
  // Relative to process.cwd(), as `tunnel serve --config-dir` reads one
  const tunnel = await start(t, { configDir: relative(process.cwd(), dir) })
  // Stopped at once, so that nothing is left writing to the directory when tmpDir removes it;
  // what the handle says of itself is there to read all the same
  await tunnel.stop()
  assert.equal(tunnel.configDir, dir)
  assert.equal(tunnel.caFile, join(dir, 'ca.pem'))
  // Kept, with what serve would have written into it, its own new CA among them; and no record of
  // a server in the background, which `tunnel stop` would find and signal
  for (const file of ['config.json', 'ca.pem', 'ca-key.pem']) {
    assert.ok(existsSync(join(dir, file)), file)
  }
  assert.equal(existsSync(join(dir, 'tunnel.pid')), false)
})

test('caDir copies that CA into the temporary directory and leaves the source as it was', async (t) => {
  // A CA of this test's own, its key readable by anyone, as a careless copy would leave it
  const source = tmpDir(t)
  for (const file of ['ca.pem', 'ca-key.pem']) copyFileSync(join(CA_DIR, file), join(source, file))
  chmodSync(join(source, 'ca-key.pem'), 0o644)
  const before = ['ca.pem', 'ca-key.pem'].map((file) => fileState(join(source, file)))

  const tunnel = await start(t, { caDir: source })
  const key = join(tunnel.configDir, 'ca-key.pem')
  assert.deepEqual(readFileSync(tunnel.caFile), before[0]!.bytes)
  assert.deepEqual(readFileSync(key), before[1]!.bytes)
  assert.equal(statSync(key).mode & 0o777, 0o600)
  // That CA is the one it signs with
  assert.equal((await tunnel.status()).ca_fingerprint, CA.fingerprint())

  await tunnel.stop()
  const after = ['ca.pem', 'ca-key.pem'].map((file) => fileState(join(source, file)))
  assert.deepEqual(after, before)
})

test('caDir is refused with a configDir, and without ca.pem or ca-key.pem, leaving no directory behind', async (t) => {
  const certificateOnly = tmpDir(t)
  copyFileSync(join(CA_DIR, 'ca.pem'), join(certificateOnly, 'ca.pem'))
  const keyOnly = tmpDir(t)
  copyFileSync(join(CA_DIR, 'ca-key.pem'), join(keyOnly, 'ca-key.pem'))
  const configDir = join(tmpDir(t), 'config')
  // Last: the directories above are not the tunnel's to leave behind
  const tmp = inTmpdir(t)

  await assert.rejects(
    startTunnel({ configDir, caDir: CA_DIR }),
    tunnelError(
      400,
      'caDir goes with the temporary configDir: a given configDir has a CA of its own',
    ),
  )
  await assert.rejects(startTunnel({ caDir: keyOnly }), tunnelError(400, `no ca.pem in ${keyOnly}`))
  await assert.rejects(
    startTunnel({ caDir: certificateOnly }),
    tunnelError(400, `no ca-key.pem in ${certificateOnly}`),
  )
  assert.equal(existsSync(configDir), false)
  assert.deepEqual(readdirSync(tmp), [])
})

// configDir is read as --config-dir is, where an empty one is none (resolvePaths): then a temporary
// directory, which stop() removes, and nothing written where the process runs, a CA's private key
// least of all. null, which only a caller without types can pass, is none as well, and for caDir
// both are too
test('an empty or null configDir or caDir is none given, as an empty --config-dir is', async (t) => {
  // Back before the directory goes
  const previous = process.cwd()
  t.after(() => process.chdir(previous))
  const cwd = tmpDir(t)
  process.chdir(cwd)
  const tmp = inTmpdir(t)
  const given = [
    { configDir: '', caDir: CA_DIR },
    { configDir: null, caDir: CA_DIR },
    { configDir: '', caDir: '' },
    { configDir: null, caDir: null },
  ]
  for (const options of given) {
    const tunnel = await startTunnel({ proxyHost: '127.0.0.1', ...options } as never)
    t.after(() => tunnel.stop())
    assert.equal(dirname(tunnel.configDir), realpathSync(tmp), JSON.stringify(options))
    await tunnel.stop()
    assert.deepEqual(readdirSync(tmp), [], JSON.stringify(options))
  }
  assert.deepEqual(readdirSync(cwd), [])
})

test('startTunnel refuses an option it does not know with TunnelError 400', async () => {
  // The types refuse it too, but a test is not always type-checked
  // @ts-expect-error proxyport is not an option: proxyPort is
  const starting = startTunnel({ proxyHost: '127.0.0.1', proxyport: 0 })
  await assert.rejects(
    starting,
    tunnelError(
      400,
      "unknown option 'proxyport'; the options are configDir, caDir, proxyHost, proxyPort, adminPort",
    ),
  )
})

test('a proxy port in use rejects with EADDRINUSE and leaves nothing listening or on disk', async (t) => {
  const taken = createServer()
  taken.listen(0, '127.0.0.1')
  await once(taken, 'listening')
  t.after(() => new Promise<void>((resolve) => taken.close(() => resolve())))
  const proxyPort = (taken.address() as AddressInfo).port
  const adminPort = await freePort()
  const tmp = inTmpdir(t)

  // Node's own error, as it came: not an answer of the admin API's
  await assert.rejects(
    startTunnel({ proxyHost: '127.0.0.1', proxyPort, adminPort, caDir: CA_DIR }),
    { name: 'Error', code: 'EADDRINUSE' },
  )
  // The admin port, which comes next, never listened, and the directory made first is gone
  await refused(adminPort)
  assert.deepEqual(readdirSync(tmp), [])
})

test('status() is GET /health and GET /sessions in one object', async (t) => {
  const tunnel = await start(t)
  const answer = async (path: string): Promise<Record<string, unknown>> =>
    (await fetch(`${tunnel.adminUrl}/__admin__/${path}`)).json() as Promise<Record<string, unknown>>
  const health = await answer('health')
  const sessions = await answer('sessions')

  const status = await tunnel.status()
  assert.deepEqual(status, { ...health, ...sessions })
  // health's fields in health's order, session among them, then the sessions on disk
  assert.deepEqual(Object.keys(status), [...Object.keys(health), 'sessions'])
  assert.equal(status.config_dir, tunnel.configDir)
  assert.equal(status.proxy?.host, '127.0.0.1')
  assert.equal(status.proxy?.port, tunnel.proxyPort)
})

test('two tunnels in one process run side by side, and stopping one leaves the other answering', async (t) => {
  const first = await start(t)
  const second = await start(t)
  assert.notEqual(first.proxyPort, second.proxyPort)
  assert.notEqual(first.adminPort, second.adminPort)
  assert.notEqual(first.configDir, second.configDir)
  // Each its own admin API, over its own directory
  assert.equal((await first.status()).config_dir, first.configDir)
  assert.equal((await second.status()).config_dir, second.configDir)

  await first.stop()
  await refused(first.proxyPort)
  await refused(first.adminPort)
  assert.equal((await second.status()).config_dir, second.configDir)
  const health = await fetch(`${second.adminUrl}/__admin__/health`)
  assert.equal(((await health.json()) as { config_dir: string }).config_dir, second.configDir)
  const pem = await fetch(`${second.proxyUrl}/ca.pem`)
  assert.equal(await pem.text(), readFileSync(second.caFile, 'utf8'))
})

test('every method of a stopped tunnel rejects with TunnelError 503', async (t) => {
  const tunnel = await start(t)
  // A function rule, which the handle holds itself rather than asking the admin API: its key is
  // refused all the same
  const held = 'GET:api.example.test/v1/held'
  await tunnel.setRule({ key: held, handler: () => null })
  const properties = () => ({
    proxyPort: tunnel.proxyPort,
    adminPort: tunnel.adminPort,
    proxyUrl: tunnel.proxyUrl,
    adminUrl: tunnel.adminUrl,
    configDir: tunnel.configDir,
    caFile: tunnel.caFile,
  })
  const before = properties()
  // From the moment stop() is called, not only once it is over
  const stopping = tunnel.stop()
  await assert.rejects(tunnel.status(), tunnelError(503, 'the tunnel is stopped'))
  await stopping

  const calls: [string, () => Promise<unknown>][] = [
    ['status', () => tunnel.status()],
    ['getConfig', () => tunnel.getConfig()],
    ['setConfig', () => tunnel.setConfig({ default_mode: 'passthrough' })],
    ['decrypt', () => tunnel.decrypt('api.example.test')],
    ['listRules', () => tunnel.listRules()],
    ['listRules of a function rule', () => tunnel.listRules(held)],
    ['setRule', () => tunnel.setRule({ key: 'GET:api.example.test/v1/a', mode: 'json' })],
    ['setRule with a handler', () => tunnel.setRule({ key: held, handler: () => null })],
    ['deleteRule of a function rule', () => tunnel.deleteRule(held)],
    ['applyScenario', () => tunnel.applyScenario({ mocks: [] })],
    // Refused before the file is looked for
    ['applyScenario of a file', () => tunnel.applyScenario('no-such-scenario.json')],
    ['resetState', () => tunnel.resetState()],
    ['listRequests', () => tunnel.listRequests()],
    ['getRequest', () => tunnel.getRequest(1)],
    ['waitForRequest', () => tunnel.waitForRequest()],
    ['clearRequests', () => tunnel.clearRequests()],
    ['check', () => tunnel.check('GET', 'http://api.example.test/v1/held')],
    ['startRecording', () => tunnel.startRecording()],
    ['stopRecording', () => tunnel.stopRecording()],
    ['listRecordings', () => tunnel.listRecordings()],
    ['getRecording', () => tunnel.getRecording('default', 1)],
    ['importRecordings', () => tunnel.importRecordings([])],
    // Refused before the directory is looked for
    ['importRecordings of a directory', () => tunnel.importRecordings('no-such-directory')],
    ['deleteRecordings', () => tunnel.deleteRecordings()],
  ]
  for (const [name, call] of calls) {
    await assert.rejects(call(), tunnelError(503, 'the tunnel is stopped'), name)
  }
  // What it was is still there to read
  assert.deepEqual(properties(), before)
})

// A test that forgets stop() must not hold node --test up: the ports and the connections to them
// are unref'd, and the temporary directory goes with the process. The child leaves a connection
// open to each port, idle, as a device or a browser would; keepAliveTimeout is 0 on the proxy port,
// so that one would be held open for good
test('a tunnel never stopped does not hold the process open, and its directory goes when the process exits [slow]', (t) => {
  const tmp = tmpDir(t)
  const entry = pathToFileURL(join(PACKAGE_ROOT, 'src', 'index.ts')).href
  const code = [
    `import { once } from 'node:events'`,
    `import { Agent, get } from 'node:http'`,
    `import { setLogSink, startTunnel } from ${JSON.stringify(entry)}`,
    `setLogSink(() => {})`,
    `const tunnel = await startTunnel({ proxyHost: '127.0.0.1', caDir: ${JSON.stringify(CA_DIR)} })`,
    `const agent = new Agent({ keepAlive: true })`,
    `for (const url of [tunnel.proxyUrl + '/ca.pem', tunnel.adminUrl + '/__admin__/health']) {`,
    `  const [response] = await once(get(url, { agent }), 'response')`,
    `  response.resume()`,
    `  await once(response, 'end')`,
    `}`,
    `process.stdout.write(tunnel.configDir)`,
  ].join('\n')
  const child = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code],
    {
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: tmp },
      timeout: 10_000,
      killSignal: 'SIGKILL',
    },
  )
  assert.equal(child.signal, null, `still running after 10 s: ${child.stderr}`)
  assert.equal(child.status, 0, child.stderr)
  const configDir = child.stdout
  assert.equal(dirname(configDir), tmp)
  assert.equal(existsSync(configDir), false)
  assert.deepEqual(readdirSync(tmp), [])
})

// ---------------------------------------------------------------- rules, settings and check()
//
// Requests go through the proxy port with check() to hosts the rules answer, never anywhere else:
// start() puts the tunnel under replay, so that one no rule answers is a 404 rather than a trip
// to the real server.

const BIG = 12345678901234567890n

/** What a script's handler(ctx) is handed, in its order (script-worker.ts, onRun) */
const SCRIPT_CTX = [
  'method',
  'path',
  'query',
  'headers',
  'body',
  'json',
  'state',
  'scheme',
  'host',
  'port',
  'url',
  'client',
  'recorded',
  'recordings',
  'reply',
]

/** What the admin API answers this request with over HTTP, on the admin port: what the handle's
 *  methods are held to */
async function overHttp(
  tunnel: Tunnel,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
    init.headers = { 'content-type': 'application/json' }
  }
  const response = await fetch(`${tunnel.adminUrl}/__admin__${path}`, init)
  return { status: response.status, json: await response.json() }
}

/** assert.rejects' check for a TunnelError holding what the admin API answered over HTTP */
function answeredAs(http: { status: number; json: any }): (error: unknown) => true {
  return (error) => {
    assert.ok(error instanceof TunnelError, `not a TunnelError: ${String(error)}`)
    assert.deepEqual(
      { status: error.status, detail: error.detail },
      { status: http.status, detail: http.json.detail },
    )
    return true
  }
}

/** An answer's body as text */
const text = (answer: CheckAnswer): string => answer.body.toString('utf8')

// setRule is PATCH /mocks run in process, so a bad rule is refused with the status and detail the
// route answers it with over HTTP: the 422's issues, the 400 of a key that does not read, a field
// nobody declared. A rule with a handler is checked by the route's own two steps (checkMockPatch),
// so it is refused alike, and it has three refusals of its own
test('setRule refuses a bad rule with the very status and detail PATCH /__admin__/mocks answers', async (t) => {
  const tunnel = await start(t)
  const bad: Record<string, unknown>[] = [
    { key: 'GET:api.example.test/v1/a', status_code: 'abc' },
    { key: 'nonsense key' },
    { key: 'GET:api.example.test/v1/a', misspelt: true },
  ]
  const statuses: number[] = []
  for (const body of bad) {
    const http = await overHttp(tunnel, 'PATCH', '/mocks', body)
    statuses.push(http.status)
    await assert.rejects(tunnel.setRule(body as unknown as RulePatch), answeredAs(http))
    const withHandler = { ...body, handler: () => null } as unknown as FunctionRulePatch
    await assert.rejects(tunnel.setRule(withHandler), answeredAs(http))
  }
  assert.deepEqual(statuses, [422, 400, 422])
  // A 422's message is its issues, where they were and what is wrong
  await assert.rejects(tunnel.setRule(bad[2] as unknown as RulePatch), {
    message: 'misspelt: Extra inputs are not permitted',
  })

  const handler = () => null
  const own: [Record<string, unknown>, string][] = [
    [{ handler: 'handler' }, 'handler must be a function, not string'],
    [{ handler, mode: 'json' }, "a rule with a handler is in script mode, not 'json'"],
    [
      { handler, script: 'function handler(ctx) {}' },
      'a rule with a handler answers with it, not with a script',
    ],
  ]
  for (const [fields, detail] of own) {
    const rule = { key: 'GET:api.example.test/v1/a', ...fields } as unknown as FunctionRulePatch
    await assert.rejects(tunnel.setRule(rule), tunnelError(400, detail))
  }
  // None of it set anything
  assert.deepEqual(await tunnel.listRules(), [])
})

// getConfig and setConfig are GET and PATCH /config, and listRules is GET /mocks, with the routes'
// answers: the settings, an empty patch's 400, a bad value's 422, and the 404 of a key no rule has,
// which names it normalised
test('getConfig, setConfig and listRules answer as GET and PATCH /config and GET /mocks do', async (t) => {
  const tunnel = await start(t)
  const settings = await tunnel.getConfig()
  assert.deepEqual(settings, (await overHttp(tunnel, 'GET', '/config')).json)
  // As start() left it
  assert.equal(settings.default_mode, 'replay')

  const changed = await tunnel.setConfig({ max_requests_history: 50, session: 'acct_a' })
  assert.deepEqual([changed.max_requests_history, changed.session], [50, 'acct_a'])
  assert.deepEqual(changed, (await overHttp(tunnel, 'GET', '/config')).json)
  await assert.rejects(tunnel.setConfig({}), tunnelError(400, 'No fields to update'))
  const wrong = { default_mode: 'sometimes' }
  const http = await overHttp(tunnel, 'PATCH', '/config', wrong)
  assert.equal(http.status, 422)
  await assert.rejects(tunnel.setConfig(wrong as never), answeredAs(http))

  const first = await tunnel.setRule({
    key: 'get:api.example.test/v1/a',
    mode: 'json',
    json_response: { a: 1 },
  })
  await tunnel.setRule({ key: 'GET:api.example.test/v1/b', mode: 'json' })
  const { mocks } = (await overHttp(tunnel, 'GET', '/mocks')).json as { mocks: Rule[] }
  assert.deepEqual(
    mocks.map((rule) => rule.key),
    ['GET:api.example.test/v1/a', 'GET:api.example.test/v1/b'],
  )
  assert.deepEqual(first, mocks[0])
  assert.deepEqual(await tunnel.listRules(), mocks)
  // A key is read as the route reads it
  assert.deepEqual(await tunnel.listRules('get:api.example.test/v1/a'), [mocks[0]])
  await assert.rejects(
    tunnel.listRules('get:/nope'),
    tunnelError(404, 'No mock is configured for GET:/nope'),
  )
})

// A stored rule goes into config.json, as the CLI's does, where a given configDir keeps it; a
// function rule lives in memory only, and one that replaces a stored rule takes it out of the file,
// as the route's DELETE does
test('with a configDir, stored rules are written to config.json and function rules never are', async (t) => {
  const dir = tmpDir(t)
  const tunnel = await start(t, { configDir: dir })
  const handler = () => ({ from: 'memory' })
  await tunnel.setRule({ key: 'GET:api.example.test/v1/stored', mode: 'json' })
  await tunnel.setRule({ key: 'GET:api.example.test/v1/replaced', mode: 'json' })
  await tunnel.setRule({ key: 'GET:api.example.test/v1/function', handler })
  await tunnel.setRule({ key: 'GET:api.example.test/v1/replaced', handler })
  const inTheFile = () => {
    const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as {
      request_configs: Record<string, unknown>
    }
    return Object.keys(config.request_configs)
  }
  assert.deepEqual(inTheFile(), ['GET:api.example.test/v1/stored'])
  for (const path of ['/v1/function', '/v1/replaced']) {
    assert.equal(
      text(await tunnel.check('GET', `http://api.example.test${path}`)),
      '{"from": "memory"}',
    )
  }

  // Stopped here, so that nothing is left writing to the directory when tmpDir removes it; what
  // was written stays
  await tunnel.stop()
  assert.deepEqual(inTheFile(), ['GET:api.example.test/v1/stored'])
})

// A function handler is handed what a script's handler(ctx) is (script-worker.ts, onRun): the same
// names in the same order, holding the request it answers, a big integer in its JSON a BigInt, and
// the client the proxy port saw
test('a function handler is handed the ctx a script is', async (t) => {
  const tunnel = await start(t)
  const handed: HandlerContext[] = []
  await tunnel.setRule({
    key: 'POST:api.example.test/v1/echo',
    handler: (ctx) => {
      handed.push(ctx)
      return null
    },
  })
  const body = '{"id": 12345678901234567890, "n": 1}'
  const answer = await tunnel.check('post', 'http://api.example.test/v1/echo?a=1', {
    body,
    contentType: 'application/json',
  })
  assert.equal(answer.status, 200)
  assert.equal(handed.length, 1)
  const ctx = handed[0]!
  assert.deepEqual(Object.keys(ctx), SCRIPT_CTX)
  const { body: bytes, headers, recorded, recordings, reply, ...values } = ctx
  assert.deepEqual(values, {
    method: 'POST',
    path: '/v1/echo',
    query: { a: '1' },
    json: { id: BIG, n: 1 },
    state: {},
    scheme: 'http',
    host: 'api.example.test',
    port: 80,
    url: 'http://api.example.test/v1/echo?a=1',
    client: '127.0.0.1',
  })
  assert.ok(Buffer.isBuffer(bytes))
  assert.equal(bytes.toString('utf8'), body)
  assert.deepEqual(headers, {
    host: 'api.example.test',
    'content-length': String(body.length),
    'content-type': 'application/json',
  })
  for (const method of [recorded, recordings, reply]) assert.equal(typeof method, 'function')
})

// What a handler is handed of the request is its own copy, as a script's is, so what it changes in
// ctx.query, ctx.headers or the bytes of ctx.body is not what the log keeps
test('what a function handler changes in ctx.query, ctx.headers and ctx.body is not what the log keeps', async (t) => {
  const tunnel = await start(t)
  await tunnel.setRule({
    key: 'POST:api.example.test/v1/changes',
    handler: (ctx) => {
      ctx.query.a = 'changed'
      ctx.headers['content-type'] = 'text/changed'
      ctx.body.fill('0')
      return null
    },
  })
  const answer = await tunnel.check('POST', 'http://api.example.test/v1/changes?a=1', {
    body: '{"n": 1}',
    contentType: 'application/json',
  })
  assert.equal(answer.status, 200)
  const { request } = await tunnel.getRequest(1)
  assert.deepEqual(request.query, { a: '1' })
  assert.equal(request.headers['content-type'], 'application/json')
  assert.deepEqual(request.body, { n: 1 })
})

/** handler(ctx) bodies, async where they await, and the status their answer has: return values of
 *  every kind script-context.ts tells apart, and through ctx.reply, a bad status among them */
const RETURNS: [body: string, status: number][] = [
  ["return { ok: true, id: 12345678901234567890n, list: [1, 'two', null] }", 200],
  ['return ctx.json', 200],
  ["return 'plain'", 200],
  ['return Buffer.from([0, 1, 2])', 200],
  ['return null', 200],
  ["return ctx.reply({ made: 1 }, 201, { 'content-type': 'application/vnd.test+json' })", 201],
  ["return ctx.reply('gone', 410)", 410],
  ['return await ctx.recorded()', 200],
  ['return ctx.reply({}, 0)', 500],
]

// What a function handler returns is answered by a script's rules, by the very code
// (script-context.ts, scriptResponse): each body above, written once, is set as a stored script and
// then as a function, under one key, and answers alike through the proxy port. Of a 500, whose
// stack says where each was compiled, the first two lines are compared
test("a function handler's return values are answered as a script's are", async (t) => {
  const tunnel = await start(t)
  const key = 'POST:api.example.test/v1/answer'
  const send = () =>
    tunnel.check('POST', 'http://api.example.test/v1/answer', {
      body: '{"id": 12345678901234567890}',
      contentType: 'application/json',
    })
  const firstTwoLines = (answer: CheckAnswer) => text(answer).split('\n').slice(0, 2)

  for (const [body, status] of RETURNS) {
    const source = `${body.includes('await') ? 'async ' : ''}function handler(ctx) {\n  ${body}\n}\n`
    await tunnel.setRule({ key, mode: 'script', script: source })
    const script = await send()
    // The same source, its handler made in this process
    const handler = new Function(`${source}\nreturn handler`)() as Handler
    await tunnel.setRule({ key, handler })
    const fn = await send()

    assert.equal(script.status, status, source)
    if (status === 500) {
      assert.match(firstTwoLines(script)[1] ?? '', /^TypeError: ctx\.reply/, source)
      assert.deepEqual(firstTwoLines(fn), firstTwoLines(script), source)
      assert.equal(fn.status, 500, source)
    } else {
      assert.deepEqual(fn, script, source)
    }
  }
})

// A function rule's other fields work as a stored script rule's do: status_code is the status of an
// answer that names none, headers go on the answer last, a disabled rule is a 503 its handler never
// hears of, a fault answers in its place, and response_delay holds the request before the handler
// is called
test("a function rule's other fields apply as a stored rule's do: status_code, headers, enabled, fault and response_delay", async (t) => {
  const tunnel = await start(t)
  const key = 'GET:api.example.test/v1/fields'
  const send = () => tunnel.check('GET', 'http://api.example.test/v1/fields')
  let calls = 0
  const handler = () => {
    calls += 1
    return { ok: true }
  }

  const headers = { 'content-type': 'application/vnd.test+json' }
  await tunnel.setRule({ key, handler, status_code: 201, headers })
  const answered = await send()
  assert.deepEqual(
    [answered.status, answered.contentType, text(answered)],
    [201, 'application/vnd.test+json', '{"ok": true}'],
  )
  assert.equal(calls, 1)

  await tunnel.setRule({ key, handler, enabled: false })
  const disabled = await send()
  assert.equal(disabled.status, 503)
  assert.deepEqual(JSON.parse(text(disabled)), { detail: `${key} is disabled` })
  await tunnel.setRule({ key, handler, fault: 'garbage', status_code: 202 })
  const garbage = await send()
  assert.deepEqual([garbage.status, garbage.contentType], [202, 'application/json'])
  assert.throws(() => JSON.parse(text(garbage)), SyntaxError)
  assert.equal(calls, 1)

  await tunnel.setRule({ key, handler, response_delay: 0.2 })
  const started = performance.now()
  assert.equal(text(await send()), '{"ok": true}')
  assert.ok(performance.now() - started >= 200)
  assert.equal(calls, 2)
})

// A handler that throws, or whose promise rejects, is a script that failed: a 500 with the stack,
// which points into the file the handler is written in
test('a function handler that throws or rejects is answered 500 with its stack', async (t) => {
  const tunnel = await start(t)
  await tunnel.setRule({
    key: 'GET:api.example.test/v1/throws',
    handler: () => {
      throw new Error('boom')
    },
  })
  await tunnel.setRule({
    key: 'GET:api.example.test/v1/rejects',
    handler: async () => {
      await Promise.resolve()
      throw new TypeError('later')
    },
  })
  for (const [path, thrown] of [
    ['/v1/throws', 'Error: boom'],
    ['/v1/rejects', 'TypeError: later'],
  ] as const) {
    const answer = await tunnel.check('GET', `http://api.example.test${path}`)
    assert.equal(answer.status, 500)
    assert.match(answer.contentType ?? '', /^text\/plain/)
    assert.ok(text(answer).startsWith(`The script failed:\n${thrown}\n`), text(answer))
    assert.ok(text(answer).includes('library.test.ts:'), text(answer))
  }
})

// A handler waiting on a promise the test holds keeps its own request waiting and no other: a slow
// first answer and a quick second one can be written
test("a function handler held back does not hold up another rule's request", async (t) => {
  const tunnel = await start(t)
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  await tunnel.setRule({
    key: 'GET:api.example.test/v1/held',
    handler: async () => {
      started.resolve()
      await release.promise
      return { held: true }
    },
  })
  await tunnel.setRule({ key: 'GET:api.example.test/v1/quick', handler: () => ({ quick: true }) })

  let answered = false
  const held = tunnel.check('GET', 'http://api.example.test/v1/held').then((answer) => {
    answered = true
    return answer
  })
  await started.promise
  assert.equal(
    text(await tunnel.check('GET', 'http://api.example.test/v1/quick')),
    '{"quick": true}',
  )
  assert.equal(answered, false)
  release.resolve()
  assert.equal(text(await held), '{"held": true}')
})

// One rule's calls share its ctx.state, the very object, so two that overlap count to two and lose
// nothing; resetState names the rule among the keys it cleared, and the next call starts on a
// new {}
test('two overlapping calls of one function rule share ctx.state, and resetState names the rule and clears it', async (t) => {
  const tunnel = await start(t)
  const key = 'GET:api.example.test/v1/count'
  const send = () => tunnel.check('GET', 'http://api.example.test/v1/count')
  const bothCounted = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  let calls = 0
  await tunnel.setRule({
    key,
    handler: async (ctx) => {
      ctx.state.n = (ctx.state.n ?? 0) + 1
      calls += 1
      if (calls === 2) bothCounted.resolve()
      if (calls <= 2) await gate.promise
      return { n: ctx.state.n }
    },
  })

  const overlapping = [send(), send()]
  await bothCounted.promise
  gate.resolve()
  for (const answer of await Promise.all(overlapping)) assert.equal(text(answer), '{"n": 2}')
  assert.equal(text(await send()), '{"n": 3}')

  assert.deepEqual(await tunnel.resetState(), [key])
  assert.equal(text(await send()), '{"n": 1}')
  // One key, read as the route reads it
  assert.deepEqual(await tunnel.resetState('get:api.example.test/v1/count'), [key])
  assert.deepEqual(await tunnel.resetState(key), [])
  assert.equal(text(await send()), '{"n": 1}')
})

/** Each rule's key and kind, in the order listRules gives them */
async function kinds(tunnel: Tunnel): Promise<[string, string][]> {
  const rules = await tunnel.listRules()
  return rules.map((rule) => [rule.key, rule.handler === undefined ? 'stored' : 'function'])
}

// One rule to a key. A function rule takes the stored rule with its key away, out of the admin
// API's sight too, as the route's DELETE would; a stored rule set after it takes the function rule
// away; deleteRule takes whichever there is, and with neither is the route's 404
test('a function rule replaces the stored rule with its key, and a stored rule replaces the function rule', async (t) => {
  const tunnel = await start(t)
  const key = 'GET:api.example.test/v1/one'
  const from = async () => text(await tunnel.check('GET', 'http://api.example.test/v1/one'))
  const storedOverHttp = async () => (await overHttp(tunnel, 'GET', '/mocks')).json.mocks.length

  await tunnel.setRule({ key, mode: 'json', json_response: { from: 'stored' } })
  assert.equal(await from(), '{"from": "stored"}')
  // The key as the route normalises it
  const handler = () => ({ from: 'function' })
  await tunnel.setRule({ key: 'get:api.example.test/v1/one', handler })
  assert.equal(await from(), '{"from": "function"}')
  assert.deepEqual(await kinds(tunnel), [[key, 'function']])
  assert.equal(await storedOverHttp(), 0)

  await tunnel.setRule({ key, mode: 'json', json_response: { from: 'stored again' } })
  assert.equal(await from(), '{"from": "stored again"}')
  assert.deepEqual(await kinds(tunnel), [[key, 'stored']])
  assert.equal(await storedOverHttp(), 1)

  assert.equal(await tunnel.deleteRule('get:api.example.test/v1/one'), key)
  assert.deepEqual(await tunnel.listRules(), [])
  await tunnel.setRule({ key, handler })
  assert.equal(await tunnel.deleteRule('get:api.example.test/v1/one'), key)
  assert.deepEqual(await tunnel.listRules(), [])
  await assert.rejects(tunnel.deleteRule(key), tunnelError(404, `No mock is configured for ${key}`))
  // No rule at all: replay's 404
  assert.equal((await tunnel.check('GET', 'http://api.example.test/v1/one')).status, 404)
})

// A scenario holds stored rules only. Applying one takes away the function rules with the keys it
// applies, and with replace every one of them, as it clears the stored rules; one that holds a rule
// with a handler is refused whole, before anything is sent: JSON would drop the function, and the
// rule would go in as a passthrough
test('applyScenario drops the function rules it overrides, every one with replace, and refuses a handler in a scenario', async (t) => {
  const tunnel = await start(t)
  const handler = () => ({ from: 'function' })
  const keyOf = (name: string) => `GET:api.example.test/v1/${name}`
  for (const name of ['a', 'b', 'c']) await tunnel.setRule({ key: keyOf(name), handler })

  const applied = await tunnel.applyScenario({
    mocks: [
      { key: 'get:api.example.test/v1/a', mode: 'json', json_response: { from: 'scenario' } },
    ],
  })
  assert.deepEqual(applied, { applied: [keyOf('a')], replaced: false })
  const afterA: [string, string][] = [
    [keyOf('a'), 'stored'],
    [keyOf('b'), 'function'],
    [keyOf('c'), 'function'],
  ]
  assert.deepEqual(await kinds(tunnel), afterA)
  assert.equal(
    text(await tunnel.check('GET', 'http://api.example.test/v1/a')),
    '{"from": "scenario"}',
  )

  const holdingAHandler = {
    mocks: [
      { key: keyOf('d'), mode: 'json' },
      { key: keyOf('b'), handler },
    ],
  }
  await assert.rejects(
    tunnel.applyScenario(holdingAHandler as never),
    tunnelError(
      400,
      'a scenario holds stored rules only; a rule with a handler goes in with setRule()',
    ),
  )
  assert.deepEqual(await kinds(tunnel), afterA)

  const replaced = await tunnel.applyScenario(
    { mocks: [{ key: keyOf('d'), mode: 'json' }] },
    { replace: true },
  )
  assert.deepEqual(replaced, { applied: [keyOf('d')], replaced: true })
  assert.deepEqual(await kinds(tunnel), [[keyOf('d'), 'stored']])
  // The scenario's own replace, as the route reads it, does as much
  await tunnel.setRule({ key: keyOf('e'), handler })
  assert.deepEqual(await tunnel.applyScenario({ mocks: [], replace: true }), {
    applied: [],
    replaced: true,
  })
  assert.deepEqual(await tunnel.listRules(), [])
})

// A string is a scenario file, read as `tunnel apply` reads one, by its very function
// (cli-common.ts, expandScenario): relative to process.cwd(), script_file and json_file next to it,
// a big integer kept; a file that is not there is that function's sentence, as a 400
test('applyScenario reads a scenario file as tunnel apply reads one', async (t) => {
  const tunnel = await start(t)
  const dir = tmpDir(t)
  const script = 'function handler(ctx) {\n  return { from: "script_file", id: ctx.json.id }\n}\n'
  writeFileSync(join(dir, 'handler.js'), script)
  writeFileSync(join(dir, 'feed.json'), '{"from": "json_file", "id": 12345678901234567890}')
  const mocks = [
    { key: 'POST:api.example.test/v1/script', mode: 'script', script_file: 'handler.js' },
    { key: 'GET:api.example.test/v1/feed', mode: 'json', json_file: 'feed.json' },
  ]
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify({ mocks }))

  const answer = await tunnel.applyScenario(relative(process.cwd(), join(dir, 'scenario.json')))
  assert.deepEqual(answer, { applied: mocks.map((mock) => mock.key), replaced: false })
  const fromScript = await tunnel.check('POST', 'http://api.example.test/v1/script', {
    body: '{"id": 12345678901234567890}',
    contentType: 'application/json',
  })
  assert.equal(text(fromScript), '{"from": "script_file", "id": 12345678901234567890}')
  const fromFile = await tunnel.check('GET', 'http://api.example.test/v1/feed')
  assert.equal(text(fromFile), '{"from": "json_file", "id": 12345678901234567890}')

  const missing = join(dir, 'missing.json')
  await assert.rejects(
    tunnel.applyScenario(missing),
    tunnelError(400, `no such scenario file: ${missing}`),
  )
})

// listRules hands out the stored rules as GET /mocks gives them, then the function rules in the
// same shape, whole from the defaults, with their handlers: copies, which a test may change without
// changing a rule. status().mocks counts both kinds, where the admin API, which knows only the
// stored ones, counts those
test('listRules lists the function rules with their handler, and status().mocks counts them where health does not', async (t) => {
  const tunnel = await start(t)
  const first: Handler = () => ({ n: 1 })
  const second: Handler = () => ({ n: 2 })
  const stored = await tunnel.setRule({ key: 'GET:api.example.test/v1/stored', mode: 'json' })
  const set = await tunnel.setRule({
    key: 'GET:api.example.test/v1/first',
    handler: first,
    status_code: 201,
    description: 'the first',
  })
  await tunnel.setRule({ key: 'GET:api.example.test/v1/second', handler: second })
  const expected: Rule = {
    key: 'GET:api.example.test/v1/first',
    mode: 'script',
    json_response: { message: 'Tunnel response' },
    status_code: 201,
    enabled: true,
    description: 'the first',
    merge_json: {},
    headers: {},
    target: '',
    response_delay: 0,
    script: '',
    replay_session: '',
    replay_strategy: 'match',
    fault: 'none',
    fault_seconds: 3600,
    handler: first,
  }
  assert.deepEqual(set, expected)
  assert.deepEqual(Object.keys(set), [...Object.keys(stored), 'handler'])

  const rules = await tunnel.listRules()
  assert.deepEqual(
    rules.map((rule) => [rule.key, rule.handler]),
    [
      ['GET:api.example.test/v1/stored', undefined],
      ['GET:api.example.test/v1/first', first],
      ['GET:api.example.test/v1/second', second],
    ],
  )
  assert.deepEqual(rules[1], expected)
  // Copies: the rule stays as it was set
  rules[1]!.status_code = 500
  rules[1]!.headers.changed = 'yes'
  set.status_code = 500
  assert.deepEqual(await tunnel.listRules('get:api.example.test/v1/first'), [expected])
  assert.equal((await tunnel.check('GET', 'http://api.example.test/v1/first')).status, 201)

  assert.equal((await tunnel.status()).mocks, 3)
  assert.equal((await overHttp(tunnel, 'GET', '/health')).json.mocks, 1)
  assert.equal(await tunnel.deleteRule('GET:api.example.test/v1/first'), expected.key)
  assert.equal((await tunnel.status()).mocks, 2)
  await assert.rejects(
    tunnel.listRules(expected.key),
    tunnelError(404, `No mock is configured for ${expected.key}`),
  )
})

// decrypt() edits the include and exclude lists as `tunnel ssl add` and `ssl rm` do, with their
// function (sslPatch), one call at a time, so two at once both land; check() sends a request
// through this tunnel's proxy port as `tunnel check` sends one, trusting this tunnel's CA and no
// other, so https to a decrypted host reaches the rules. Under replay, which start() sets, a
// request no rule answers is a 404
test("decrypt() lets check() through https to a rule trusting this tunnel's CA alone, and under replay a request no rule answers is 404", async (t) => {
  const tunnel = await start(t)
  const lists = (include: string[], exclude: string[]) => ({ enabled: true, include, exclude })
  const [, both] = await Promise.all([
    tunnel.decrypt('api.example.test'),
    tunnel.decrypt(['cdn.example.test']),
  ])
  assert.deepEqual(both, lists(['api.example.test', 'cdn.example.test'], []))
  const removed = await tunnel.decrypt('cdn.example.test', { remove: true })
  assert.deepEqual(removed, lists(['api.example.test'], []))
  const excluded = await tunnel.decrypt(['ads.example.test'], { exclude: true })
  assert.deepEqual(excluded, lists(['api.example.test'], ['ads.example.test']))
  await assert.rejects(
    tunnel.decrypt('cdn.example.test', { remove: true }),
    tunnelError(400, 'cdn.example.test is not in the include list'),
  )
  assert.deepEqual((await tunnel.getConfig()).ssl_proxying, excluded)

  await tunnel.setRule({
    key: 'GET:api.example.test/v1/secure',
    mode: 'json',
    json_response: { secure: true },
  })
  const secure = await tunnel.check('GET', 'https://api.example.test/v1/secure')
  assert.deepEqual([secure.status, text(secure)], [200, '{"secure": true}'])
  for (const scheme of ['https', 'http']) {
    const none = await tunnel.check('GET', `${scheme}://api.example.test/v1/none`)
    assert.equal(none.status, 404)
    assert.deepEqual(JSON.parse(text(none)), {
      detail: 'no rule or recording for GET:api.example.test/v1/none',
      key: 'GET:api.example.test/v1/none',
    })
  }
  // What check() cannot send
  for (const url of ['ftp://api.example.test/v1/secure', 'api.example.test/v1/secure']) {
    await assert.rejects(
      tunnel.check('GET', url),
      tunnelError(400, `'${url}' is not an http or https URL`),
    )
  }
})

// An IPv6 address is written in brackets in a URL, proxyUrl's among them, which is where check()
// sends its request. Skipped where there is no IPv6 loopback to listen on
test('a proxyHost that is an IPv6 address is in brackets in proxyUrl, and check() reaches it there', async (t) => {
  let tunnel: Tunnel
  try {
    tunnel = await start(t, { proxyHost: '::1' })
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException
    if (code !== 'EADDRNOTAVAIL' && code !== 'EAFNOSUPPORT') throw error
    t.diagnostic('no IPv6 loopback, skipped')
    return
  }
  assert.equal(tunnel.proxyUrl, `http://[::1]:${tunnel.proxyPort}`)
  await tunnel.setRule({
    key: 'GET:api.example.test/v1/six',
    mode: 'json',
    json_response: { v: 6 },
  })
  const answer = await tunnel.check('GET', 'http://api.example.test/v1/six')
  assert.deepEqual([answer.status, text(answer)], [200, '{"v": 6}'])
})

// Each tunnel has a core of its own, and so function rules and ctx.state of its own: one key, a
// handler on each, each answering through its own proxy port
test('two tunnels answer the same key each with its own function handler', async (t) => {
  const tunnels = [await start(t), await start(t)]
  const key = 'GET:api.example.test/v1/who'
  for (const [index, tunnel] of tunnels.entries()) {
    await tunnel.setRule({
      key,
      handler: (ctx) => ({ who: index, calls: (ctx.state.calls = (ctx.state.calls ?? 0) + 1) }),
    })
  }
  for (const round of [1, 2]) {
    for (const [index, tunnel] of tunnels.entries()) {
      const answer = await tunnel.check('GET', 'http://api.example.test/v1/who')
      assert.equal(text(answer), `{"who": ${index}, "calls": ${round}}`)
    }
  }
})

// An integer past 2^53 is a BigInt wherever the library hands JSON out, and a BigInt it is handed
// is written as its digits: in a rule, in config.json, in a function rule's fields, in a handler's
// ctx.json and what it returns, and in the answer
test('integers past 2^53 stay BigInt through rules, handlers and answers', async (t) => {
  const tunnel = await start(t)
  const key = 'GET:api.example.test/v1/big'
  const stored = await tunnel.setRule({
    key,
    mode: 'json',
    json_response: { id: BIG, list: [-BIG] },
  })
  assert.deepEqual(stored.json_response, { id: BIG, list: [-BIG] })
  assert.deepEqual((await tunnel.listRules(key))[0]!.json_response, { id: BIG, list: [-BIG] })
  const file = readFileSync(join(tunnel.configDir, 'config.json'), 'utf8')
  assert.ok(file.includes('"id": 12345678901234567890'), file)
  const answer = await tunnel.check('GET', 'http://api.example.test/v1/big')
  assert.equal(text(answer), '{"id": 12345678901234567890, "list": [-12345678901234567890]}')

  const next = 'POST:api.example.test/v1/next'
  const rule = await tunnel.setRule({
    key: next,
    json_response: { id: BIG },
    handler: (ctx) => ({ type: typeof ctx.json.id, next: ctx.json.id + 1n }),
  })
  assert.deepEqual(rule.json_response, { id: BIG })
  assert.deepEqual((await tunnel.listRules(next))[0]!.json_response, { id: BIG })
  const answered = await tunnel.check('POST', 'http://api.example.test/v1/next', {
    body: `{"id": ${BIG}}`,
    contentType: 'application/json',
  })
  assert.equal(text(answered), '{"type": "bigint", "next": 12345678901234567891}')
})

// ---------------------------------------------------------------- the request log and recording
//
// The log holds what came through the proxy port, which check() sends to. A recording is what a
// passthrough brought back from a real server: here one on the loopback (startUpstream), which is
// reached directly, never through a system proxy.

// waitForRequest is GET /requests/wait run in process: it answers at once when the log holds the
// requests asked for, and waits on the log for the ones still to come; its key is read as the route
// reads it, and since counts only what came after
test('waitForRequest resolves with requests already logged and with ones that arrive later', async (t) => {
  const tunnel = await start(t)
  const key = 'GET:api.example.test/v1/waited'
  await tunnel.setRule({ key, mode: 'json' })
  const send = () => tunnel.check('GET', 'http://api.example.test/v1/waited')
  await send()

  // In the log already
  assert.deepEqual(await tunnel.waitForRequest({ key }), {
    seqs: [1],
    count: 1,
    wanted: 1,
    timed_out: false,
    last_seq: 1,
  })

  // One of the two still to come: the wait holds until it is in
  let settled = false
  const waiting = tunnel
    .waitForRequest({ key: 'get:api.example.test/v1/waited', count: 2 })
    .then((answer) => {
      settled = true
      return answer
    })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false)
  await send()
  assert.deepEqual(await waiting, {
    seqs: [1, 2],
    count: 2,
    wanted: 2,
    timed_out: false,
    last_seq: 2,
  })

  // Any request, after seq 2
  const next = tunnel.waitForRequest({ since: 2 })
  await send()
  assert.deepEqual(await next, { seqs: [3], count: 1, wanted: 1, timed_out: false, last_seq: 3 })
})

// query is the route's q=name=value, a pair each, every one of which a request must carry; a wait
// whose time runs out answers what it counted with timed_out, which is no error; a count the route
// refuses is its 422
test('waitForRequest times out with timed_out true, counts only the query asked for, and refuses a count of 0 with 422', async (t) => {
  const tunnel = await start(t)
  const key = 'GET:api.example.test/v1/page'
  await tunnel.setRule({ key, mode: 'json' })
  await tunnel.check('GET', 'http://api.example.test/v1/page?page=1')
  await tunnel.check('GET', 'http://api.example.test/v1/page?page=2&size=10')

  assert.deepEqual(await tunnel.waitForRequest({ key, query: { page: '2' } }), {
    seqs: [2],
    count: 1,
    wanted: 1,
    timed_out: false,
    last_seq: 2,
  })
  // Every pair, not any one of them
  assert.deepEqual(
    await tunnel.waitForRequest({ query: { page: '1', size: '10' }, timeout: 0.2 }),
    {
      seqs: [],
      count: 0,
      wanted: 1,
      timed_out: true,
      last_seq: 2,
    },
  )
  const started = performance.now()
  assert.deepEqual(
    await tunnel.waitForRequest({ key, count: 2, query: { page: '1' }, timeout: 0.2 }),
    { seqs: [1], count: 1, wanted: 2, timed_out: true, last_seq: 2 },
  )
  assert.ok(performance.now() - started >= 200)

  const http = await overHttp(tunnel, 'GET', '/requests/wait?count=0')
  assert.equal(http.status, 422)
  await assert.rejects(tunnel.waitForRequest({ count: 0 }), answeredAs(http))
  await assert.rejects(tunnel.waitForRequest({ count: 0 }), {
    message: 'count: Input should be greater than or equal to 1',
  })
})

// timeout goes to the route as its text, so Infinity is the route's inf, a wait that ends only when
// what it waits for comes, and a negative or NaN one is refused with the very 422 the route answers
// over HTTP
test('waitForRequest waits with a timeout of Infinity, and refuses a negative or NaN one as the route does', async (t) => {
  const tunnel = await start(t)
  const key = 'GET:api.example.test/v1/endless'
  await tunnel.setRule({ key, mode: 'json' })
  const waiting = tunnel.waitForRequest({ key, timeout: Infinity })
  await tunnel.check('GET', 'http://api.example.test/v1/endless')
  assert.deepEqual(await waiting, {
    seqs: [1],
    count: 1,
    wanted: 1,
    timed_out: false,
    last_seq: 1,
  })
  for (const timeout of [-1, NaN]) {
    const http = await overHttp(tunnel, 'GET', `/requests/wait?timeout=${timeout}`)
    assert.equal(http.status, 422)
    await assert.rejects(tunnel.waitForRequest({ key, timeout }), answeredAs(http))
  }
})

// A wait runs on the very app the admin port answers with, and stop(), which aborts that app's
// waits as it closes the port, answers this one too, with the route's 503
test('a wait in progress rejects with TunnelError 503 when the tunnel stops', async (t) => {
  const tunnel = await start(t)
  const waiting = tunnel.waitForRequest({ key: 'GET:api.example.test/v1/never', timeout: 60 })
  const refused = assert.rejects(waiting, tunnelError(503, 'The server is shutting down'))
  // A turn of the event loop, for the wait to look at the log and find nothing there
  await new Promise((resolve) => setImmediate(resolve))
  await tunnel.stop()
  await refused
})

// listRequests is GET /requests, the whole answer: one aggregate row per key, or with each one
// summary per request, filtered as the route filters. getRequest is one exchange in full, a big
// integer in its body a BigInt, or the route's 404; clearRequests resolves with the last seq handed
// out, the since for what follows
test('listRequests answers in both shapes, getRequest hands back the body with its big integers and 404s for a seq not in the log, and clearRequests returns the last seq', async (t) => {
  const tunnel = await start(t)
  const key = 'POST:api.example.test/v1/orders'
  const missing = 'GET:api.example.test/v1/missing'
  await tunnel.setRule({ key, mode: 'json', json_response: { ok: true } })
  await tunnel.check('POST', 'http://api.example.test/v1/orders?src=test', {
    body: '{"id": 12345678901234567890}',
    contentType: 'application/json',
  })
  // No rule: replay's 404, a request nothing was there for
  await tunnel.check('GET', 'http://api.example.test/v1/missing')

  const aggregate = await tunnel.listRequests()
  assert.deepEqual(aggregate, (await overHttp(tunnel, 'GET', '/requests')).json)
  // The key called last first
  assert.deepEqual(
    aggregate.requests.map((row) => [row.key, row.request_count, row.configured]),
    [
      [missing, 1, false],
      [key, 1, true],
    ],
  )
  assert.deepEqual([aggregate.last_seq, aggregate.unmatched_count], [2, 1])
  const each = await tunnel.listRequests({ each: true })
  assert.deepEqual(each, (await overHttp(tunnel, 'GET', '/requests?each=1')).json)
  assert.deepEqual(
    each.requests.map((row) => [row.seq, row.key, row.status]),
    [
      [1, key, 200],
      [2, missing, 404],
    ],
  )
  // The route's filters, under its own names but for qBody
  const seqs = async (filters: RequestFilters) =>
    (await tunnel.listRequests({ ...filters, each: true })).requests.map((row) => row.seq)
  assert.deepEqual(await seqs({ unmatched: true }), [2])
  assert.deepEqual(await seqs({ key: 'post:api.example.test/v1/orders' }), [1])
  assert.deepEqual(await seqs({ host: 'api.example.test', since: 1 }), [2])
  assert.deepEqual(await seqs({ last: 1 }), [2])
  assert.deepEqual(await seqs({ q: '12345678901234567890' }), [])
  assert.deepEqual(await seqs({ q: '12345678901234567890', qBody: true }), [1])

  const exchange = await tunnel.getRequest(1)
  assert.deepEqual(
    [exchange.seq, exchange.matched_by, exchange.request.query, exchange.request.body],
    [1, key, { src: 'test' }, { id: BIG }],
  )
  assert.deepEqual(exchange.response?.body, { ok: true })
  await assert.rejects(
    tunnel.getRequest(3),
    tunnelError(404, 'No request with seq 3 is in the log'),
  )

  assert.equal(await tunnel.clearRequests(), 2)
  assert.deepEqual(await tunnel.listRequests({ each: true }), {
    requests: [],
    last_seq: 2,
    unmatched_count: 0,
  })
  await assert.rejects(
    tunnel.getRequest(1),
    tunnelError(404, 'No request with seq 1 is in the log'),
  )
})

// startRecording and stopRecording are POST /record/start and /record/stop, the status without
// success; a passthrough recorded in between is listed by listRecordings as GET /recordings lists
// it, filters and all, and read back whole by getRecording, a big integer a BigInt, or the
// route's 404
test('a passthrough is recorded, and listRecordings and getRecording read it back', async (t) => {
  const tunnel = await start(t)
  const upstream = await startUpstream(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"real": true, "id": 12345678901234567890}')
  })
  await tunnel.setRule({ key: `GET:127.0.0.1:${upstream.port}/real`, mode: 'passthrough' })

  // Into a session of its own, which becomes the current one
  assert.deepEqual(await tunnel.startRecording('acct_a'), {
    active: true,
    session: 'acct_a',
    count: 0,
  })
  const answer = await tunnel.check('GET', `${upstream.base}/real?page=1`)
  assert.equal(text(answer), '{"real": true, "id": 12345678901234567890}')
  assert.deepEqual(await tunnel.stopRecording(), { active: false, session: 'acct_a', count: 1 })
  assert.equal((await tunnel.status()).session, 'acct_a')

  const rows = await tunnel.listRecordings()
  assert.deepEqual(rows, (await overHttp(tunnel, 'GET', '/recordings')).json.recordings)
  assert.deepEqual(
    rows.map(({ session, seq, key, query, status }) => ({ session, seq, key, query, status })),
    [{ session: 'acct_a', seq: 1, key: 'GET:127.0.0.1/real', query: { page: '1' }, status: 200 }],
  )
  const filters = { session: 'acct_a', key: 'get:127.0.0.1/real', host: '127.0.0.1' }
  assert.deepEqual(await tunnel.listRecordings(filters), rows)
  assert.deepEqual(await tunnel.listRecordings({ session: 'acct_b' }), [])

  const recording = await tunnel.getRecording('acct_a', 1)
  assert.deepEqual(recording.request.query, { page: '1' })
  assert.deepEqual(recording.response?.body, { real: true, id: BIG })
  await assert.rejects(
    tunnel.getRecording('acct_a', 2),
    tunnelError(404, 'No recording with seq 2 in session acct_a'),
  )
})

// importRecordings is POST /recordings/import. An array goes in at once, into options.session or
// else the route's default; a directory `tunnel recordings export` wrote is read by the function
// `tunnel recordings import` reads it with (readRecordingsTree), and goes in one session at a time,
// each named by its directory: a session given with it is a 400, as is a path that is no directory,
// in the CLI's words. deleteRecordings is DELETE /recordings, one session's or every session's, and
// resolves with how many went
test('importRecordings takes an array and a directory tunnel recordings export wrote, and deleteRecordings removes them', async (t) => {
  const tunnel = await start(t)
  await tunnel.setRule({
    key: 'GET:api.example.test/v1/feed',
    mode: 'json',
    json_response: { id: BIG },
  })
  for (const page of ['1', '2']) {
    await tunnel.check('GET', `http://api.example.test/v1/feed?page=${page}`)
  }
  // What the log holds is what a recording holds
  const first = await tunnel.getRequest(1)
  const second = await tunnel.getRequest(2)

  assert.deepEqual(await tunnel.importRecordings([first, second], { session: 'acct_a' }), {
    imported: 2,
    sessions: ['acct_a'],
    replaced: false,
  })
  assert.deepEqual(await tunnel.importRecordings([first]), {
    imported: 1,
    sessions: ['default'],
    replaced: false,
  })
  const listed = await tunnel.listRecordings()
  assert.deepEqual(
    listed.map((row) => [row.session, row.seq, row.query]),
    [
      ['acct_a', 1, { page: '1' }],
      ['acct_a', 2, { page: '2' }],
      ['default', 1, { page: '1' }],
    ],
  )
  assert.deepEqual((await tunnel.getRecording('acct_a', 2)).response?.body, { id: BIG })

  // Written out by the CLI, over this tunnel's admin port, and taken away
  const cwd = tmpDir(t)
  const cli = cliRunner({ fetch: (url, init) => fetch(url, init), cwd, base: tunnel.adminUrl })
  assert.equal(await cli.run('recordings', 'export', '-o', 'out'), 0)
  assert.equal(await tunnel.deleteRecordings(), 3)
  assert.deepEqual(await tunnel.listRecordings(), [])

  // Relative to process.cwd(), as `tunnel recordings import` reads it
  const out = relative(process.cwd(), join(cwd, 'out'))
  const fromTree = { imported: 3, sessions: ['acct_a', 'default'], replaced: false }
  assert.deepEqual(await tunnel.importRecordings(out), fromTree)
  assert.deepEqual(await tunnel.listRecordings(), listed)
  assert.deepEqual((await tunnel.getRecording('acct_a', 2)).response?.body, { id: BIG })
  // With replace, each session is emptied first
  await tunnel.importRecordings([second])
  assert.deepEqual(await tunnel.importRecordings(out, { replace: true }), {
    ...fromTree,
    replaced: true,
  })
  assert.deepEqual(await tunnel.listRecordings(), listed)

  assert.equal(await tunnel.deleteRecordings('acct_a'), 2)
  assert.deepEqual(await tunnel.listRecordings(), listed.slice(2))
  await assert.rejects(
    tunnel.importRecordings(out, { session: 'acct_b' }),
    tunnelError(400, 'session goes with an array of exchanges: a directory names its own sessions'),
  )
  const nowhere = join(cwd, 'nowhere')
  await assert.rejects(
    tunnel.importRecordings(nowhere),
    tunnelError(400, `not a directory: ${nowhere}`),
  )
})

// In a function handler, ctx.recorded() is a promise of what a script's hands back at once: the
// recording of this request's key and query from the rule's session, here an imported one, a big
// integer in it a BigInt. Returned, it is answered as replay would answer it, with the status, the
// headers and the body recorded
test("a function handler's await ctx.recorded() reads an imported recording and answers with it", async (t) => {
  const tunnel = await start(t)
  const key = 'GET:api.example.test/v1/feed'
  const headers = { 'content-type': 'application/vnd.test+json' }
  const json_response = { id: BIG, items: [1, 2] }
  await tunnel.setRule({ key, mode: 'json', json_response, status_code: 201, headers })
  await tunnel.check('GET', 'http://api.example.test/v1/feed?page=1')
  await tunnel.importRecordings([await tunnel.getRequest(1)])

  const found: (Recorded | null)[] = []
  await tunnel.setRule({
    key,
    handler: async (ctx) => {
      const recorded = await ctx.recorded()
      found.push(recorded)
      return recorded
    },
  })
  const answer = await tunnel.check('GET', 'http://api.example.test/v1/feed?page=1')
  assert.deepEqual(
    [answer.status, answer.contentType, text(answer)],
    [201, 'application/vnd.test+json', '{"id": 12345678901234567890, "items": [1, 2]}'],
  )
  assert.equal(found.length, 1)
  assert.deepEqual([found[0]?.seq, found[0]?.status, found[0]?.body], [1, 201, json_response])
})

// A function rule's replay_session is the session its ctx.recorded() reads, as a script rule's is,
// and without one it reads the current session
test("a function rule's replay_session is the session its handler's ctx.recorded() reads", async (t) => {
  const tunnel = await start(t)
  const key = 'GET:api.example.test/v1/feed'
  const send = () => tunnel.check('GET', 'http://api.example.test/v1/feed')
  // A recording in each of two sessions, told apart by their bodies
  for (const [seq, session] of [
    [1, 'default'],
    [2, 'acct_a'],
  ] as const) {
    await tunnel.setRule({ key, mode: 'json', json_response: { from: session } })
    await send()
    await tunnel.importRecordings([await tunnel.getRequest(seq)], { session })
  }

  const handler: Handler = (ctx) => ctx.recorded()
  await tunnel.setRule({ key, handler })
  assert.equal(text(await send()), '{"from": "default"}')
  await tunnel.setRule({ key, handler, replay_session: 'acct_a' })
  assert.equal(text(await send()), '{"from": "acct_a"}')
})

// ---------------------------------------------------------------- the log sink and options

// setLogSink is log.ts's, for every tunnel in this process: it hands back the sink it replaced, so
// that a test can put that back, and the sink it is given gets the core's records
test("setLogSink hands back the sink it replaced and receives tunnel.core's records", async (t) => {
  const tunnel = await start(t)
  await tunnel.setRule({ key: 'GET:api.example.test/v1/logged', mode: 'json' })
  const records: LogRecord[] = []
  const sink: LogSink = (record) => {
    records.push(record)
  }
  const previous = setLogSink(sink)
  t.after(() => setLogSink(previous))

  await tunnel.check('GET', 'http://api.example.test/v1/logged')
  // Put back, it hands back this test's
  assert.equal(setLogSink(previous), sink)
  const core = records.filter((record) => record.logger === 'tunnel.core')
  assert.deepEqual(core[0], {
    level: 'info',
    logger: 'tunnel.core',
    message: 'GET api.example.test/v1/logged -> json',
  })
})

// An option a method does not know is refused rather than ignored, as the admin API refuses a field
// it does not know; the sentence names the method's options in their order. It comes before
// anything is done
test('every method that takes options refuses one it does not know with TunnelError 400', async (t) => {
  const tunnel = await start(t)
  const unknown = (name: string, known: string) =>
    tunnelError(400, `unknown option '${name}'; the options are ${known}`)
  const calls: [string, () => Promise<unknown>, (error: unknown) => true][] = [
    [
      'decrypt',
      () => tunnel.decrypt('api.example.test', { excluded: true } as never),
      unknown('excluded', 'exclude, remove'),
    ],
    [
      'applyScenario',
      () =>
        tunnel.applyScenario({ mocks: [{ key: 'GET:api.example.test/v1/a' }] }, {
          replaced: true,
        } as never),
      unknown('replaced', 'replace'),
    ],
    [
      'listRequests',
      () => tunnel.listRequests({ qbody: true } as never),
      unknown('qbody', 'key, host, since, last, unmatched, encrypted, q, qBody, each'),
    ],
    [
      'waitForRequest',
      () => tunnel.waitForRequest({ tiemout: 1 } as never),
      unknown('tiemout', 'key, count, since, timeout, query'),
    ],
    [
      'check',
      () => tunnel.check('GET', 'http://api.example.test/v1/a', { content_type: 'a' } as never),
      unknown('content_type', 'body, contentType'),
    ],
    [
      'listRecordings',
      () => tunnel.listRecordings({ sesion: 'acct_a' } as never),
      unknown('sesion', 'session, key, host'),
    ],
    [
      'importRecordings',
      () => tunnel.importRecordings([], { sessions: 'acct_a' } as never),
      unknown('sessions', 'session, replace'),
    ],
  ]
  for (const [name, call, refusal] of calls) await assert.rejects(call(), refusal, name)
  // None of them did anything
  assert.deepEqual((await tunnel.getConfig()).ssl_proxying.include, [])
  assert.deepEqual(await tunnel.listRules(), [])
  assert.deepEqual(await tunnel.listRequests({ each: true }), {
    requests: [],
    last_seq: 0,
    unmatched_count: 0,
  })
})
