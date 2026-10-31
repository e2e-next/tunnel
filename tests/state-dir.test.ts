// Where tunnel keeps its files: config, state and data.
//
// Resolution order is explicit > the project's .tunnel/ > user level, and only the
// user-level case splits the three kinds across platform directories. Defaulting
// to the user level means the same mocks are found wherever the server is started;
// `tunnel init` is the one-time opt-in that gives a project its own set.
//
// Every test calls isolatedHome(t) first, and passes resolvePaths a context rather
// than changing the process; a manager is handed what resolvePaths gives.
// The exceptions are 'explicit paths win over env', which sets the real
// TUNNEL_CONFIG_DIR to show that a manager given its directories does not read it,
// and the three init tests, which point the real HOME at the temp dir, as
// main() hands resolvePaths no home of its own.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { type TestContext, test } from 'node:test'
import { main } from '../src/cli.ts'
import { Paths, TunnelConfigManager, resolvePaths } from '../src/config.ts'
import { ExchangeLog } from '../src/exchanges.ts'
import { captureIo } from './support/cli.ts'
import { isolatedHome } from './support/home.ts'

// ---------------------------------------------------------------- user level

// No marker anywhere: config, state and data are three XDG directories
test('defaults to the three user directories', (t) => {
  const { tmp, home, context } = isolatedHome(t)
  const workdir = join(tmp, 'somewhere')
  mkdirSync(workdir)

  // No platform given: the real one
  const paths = resolvePaths({ ...context, cwd: workdir })

  assert.equal(paths.config_dir, join(home, '.config/tunnel'))
  assert.equal(paths.state_dir, join(home, '.local/state/tunnel'))
  assert.equal(paths.data_dir, join(home, '.local/share/tunnel'))
  assert.ok(!existsSync(join(workdir, '.tunnel')))
})

test('each XDG variable is respected', (t) => {
  const { tmp, context } = isolatedHome(t)

  const paths = resolvePaths({
    ...context,
    cwd: tmp,
    env: {
      XDG_CONFIG_HOME: join(tmp, 'xdg-config'),
      XDG_STATE_HOME: join(tmp, 'xdg-state'),
      XDG_DATA_HOME: join(tmp, 'xdg-data'),
    },
  })

  assert.equal(paths.config_dir, join(tmp, 'xdg-config/tunnel'))
  assert.equal(paths.state_dir, join(tmp, 'xdg-state/tunnel'))
  assert.equal(paths.data_dir, join(tmp, 'xdg-data/tunnel'))
})

// macOS keeps out of ~/Library/Application Support: that is for GUI apps
test('macOS and Linux use XDG, not Library', (t) => {
  const { tmp, home, context } = isolatedHome(t)

  assert.equal(
    resolvePaths({ ...context, cwd: tmp, platform: 'darwin' }).config_dir,
    join(home, '.config/tunnel'),
  )
})

// Windows has its own split: %APPDATA% roams between machines, %LOCALAPPDATA% does not
test('Windows splits roaming config from local state', (t) => {
  const { tmp, context } = isolatedHome(t)

  // The expected paths are joined the host's way, as resolvePaths joins them
  const paths = resolvePaths({
    ...context,
    cwd: tmp,
    platform: 'win32',
    env: { APPDATA: join(tmp, 'AppData/Roaming'), LOCALAPPDATA: join(tmp, 'AppData/Local') },
  })

  assert.equal(paths.config_dir, join(tmp, 'AppData/Roaming/tunnel'))
  assert.equal(paths.state_dir, join(tmp, 'AppData/Local/tunnel'))
  assert.equal(paths.data_dir, join(tmp, 'AppData/Local/tunnel'))
})

// ---------------------------------------------------------------- project and explicit

// A project's .tunnel/ is one directory to delete, so everything goes in it
test('project dir holds all three and wins over user dir', (t) => {
  const { tmp, home, context } = isolatedHome(t)
  const project = join(tmp, 'project')
  mkdirSync(join(project, '.tunnel'), { recursive: true })

  const paths = resolvePaths({ ...context, cwd: project })
  new TunnelConfigManager(resolvePaths({ ...context, cwd: project }))

  assert.equal(paths.config_dir, join(project, '.tunnel'))
  assert.equal(paths.state_dir, join(project, '.tunnel'))
  assert.equal(paths.data_dir, join(project, '.tunnel'))
  assert.ok(existsSync(join(project, '.tunnel/config.json')))
  assert.ok(!existsSync(join(home, '.config/tunnel')))
})

// Started in a subdirectory it still finds the project's, not a second set
test('project dir is found from a subdirectory', (t) => {
  const { tmp, context } = isolatedHome(t)
  const project = join(tmp, 'project')
  mkdirSync(join(project, '.tunnel'), { recursive: true })
  const deep = join(project, 'src', 'nested')
  mkdirSync(deep, { recursive: true })

  assert.equal(resolvePaths({ ...context, cwd: deep }).config_dir, join(project, '.tunnel'))
})

test('env var overrides everything', (t) => {
  const { tmp, context } = isolatedHome(t)
  const project = join(tmp, 'project')
  mkdirSync(join(project, '.tunnel'), { recursive: true })
  const where = { ...context, cwd: project, env: { TUNNEL_CONFIG_DIR: join(tmp, 'elsewhere') } }

  const paths = resolvePaths(where)
  new TunnelConfigManager(resolvePaths(where))

  assert.equal(paths.config_dir, join(tmp, 'elsewhere'))
  assert.equal(paths.state_dir, join(tmp, 'elsewhere'))
  assert.equal(paths.data_dir, join(tmp, 'elsewhere'))
  assert.ok(existsSync(join(tmp, 'elsewhere/config.json')))
  assert.ok(!existsSync(join(project, '.tunnel/config.json')))
})

test('explicit paths win over env', (t) => {
  const { tmp } = isolatedHome(t)
  // The one test that changes the process: with the variable really set, the manager given its
  // directories reads no variable of its own. Put back afterwards, and deleted if it was not
  // there: assigning undefined would leave the string "undefined"
  const saved = process.env.TUNNEL_CONFIG_DIR
  t.after(() => {
    if (saved === undefined) delete process.env.TUNNEL_CONFIG_DIR
    else process.env.TUNNEL_CONFIG_DIR = saved
  })
  process.env.TUNNEL_CONFIG_DIR = join(tmp, 'ignored')

  const manager = new TunnelConfigManager(Paths.inOneDirectory(join(tmp, 'given')))
  manager.updateConfig({ max_requests_history: 42 })

  assert.ok(existsSync(join(tmp, 'given/config.json')))
  assert.ok(!existsSync(join(tmp, 'ignored')))
})

// `tunnel ls` runs elsewhere than the server, so a bare name means nothing there
test('a relative directory is reported as an absolute one', (t) => {
  const { tmp, context } = isolatedHome(t)

  const paths = resolvePaths({ ...context, cwd: tmp, env: { TUNNEL_CONFIG_DIR: 'relative-dir' } })

  assert.equal(paths.config_dir, join(tmp, 'relative-dir'))
  assert.ok(Object.values(paths.describe()).every((value) => isAbsolute(value)))
})

test('nested directories are created', (t) => {
  const { tmp, context } = isolatedHome(t)

  new TunnelConfigManager(
    resolvePaths({ ...context, cwd: tmp, env: { TUNNEL_CONFIG_DIR: join(tmp, 'a/b/c') } }),
  )

  assert.ok(existsSync(join(tmp, 'a/b/c/config.json')))
})

// ---------------------------------------------------------------- file placement

// The request log is throwaway runtime state and must not sit next to the CA
test('requests are state not config', async (t) => {
  const { home, context } = isolatedHome(t)
  const log = new ExchangeLog(new TunnelConfigManager(resolvePaths(context)))

  log.recordConnect('api.example.com', 443, '127.0.0.1', 10, 20)
  await log.flush()
  await log.close()

  assert.ok(existsSync(join(home, '.local/state/tunnel/requests.jsonl')))
  assert.ok(!existsSync(join(home, '.config/tunnel/requests.jsonl')))
})

// The CA is a long lived identity: config, not state, so wiping state keeps it
test('the CA files live next to the config', (t) => {
  const { tmp } = isolatedHome(t)

  const paths = Paths.inOneDirectory(tmp)

  assert.equal(paths.caFile, join(tmp, 'ca.pem'))
  assert.equal(paths.caKeyFile, join(tmp, 'ca-key.pem'))
})

// Has to be queryable, or "where did my mocks go" has nowhere to start
test('manager reports where it writes', (t) => {
  const { tmp, context } = isolatedHome(t)

  const manager = new TunnelConfigManager(
    resolvePaths({ ...context, cwd: tmp, env: { TUNNEL_CONFIG_DIR: join(tmp, 'state') } }),
  )

  assert.deepStrictEqual(manager.paths.describe(), {
    config_dir: join(tmp, 'state'),
    state_dir: join(tmp, 'state'),
    data_dir: join(tmp, 'state'),
  })
})

// ---------------------------------------------------------------- tunnel init

/**
 * Points the real HOME at home: main() hands resolvePaths no home, so the user directories come
 * from os.homedir(), which follows process.env.HOME. Put back afterwards, and deleted if it was
 * not there
 */
function pointHomeAt(t: TestContext, home: string): void {
  const saved = process.env.HOME
  t.after(() => {
    if (saved === undefined) delete process.env.HOME
    else process.env.HOME = saved
  })
  process.env.HOME = home
}

// The directory ignores itself, so captured traffic and the CA private key
// cannot be committed by accident.
test('init creates a self-ignoring project dir', async (t) => {
  const { tmp, home, context } = isolatedHome(t)
  pointHomeAt(t, home)
  const io = captureIo()

  assert.equal(await main(['init'], io, { cwd: tmp, env: context.env }), 0)

  assert.ok(statSync(join(tmp, '.tunnel')).isDirectory())
  const gitignore = readFileSync(join(tmp, '.tunnel/.gitignore'), 'utf8')
  assert.ok(gitignore.split(/\s+/).includes('*'))
  // The whole file, byte for byte
  assert.equal(gitignore, '# Created by tunnel. Everything here is local state.\n*\n')
  assert.ok(io.takeOutput().out.includes(join(tmp, '.tunnel')))
})

test('init is idempotent and restores the gitignore', async (t) => {
  const { tmp, home, context } = isolatedHome(t)
  pointHomeAt(t, home)
  mkdirSync(join(tmp, '.tunnel'))
  writeFileSync(join(tmp, '.tunnel/config.json'), '{}')

  assert.equal(await main(['init'], captureIo(), { cwd: tmp, env: context.env }), 0)

  assert.ok(existsSync(join(tmp, '.tunnel/.gitignore')))
  assert.equal(readFileSync(join(tmp, '.tunnel/config.json'), 'utf8'), '{}')
})

test('init makes the project dir take over', async (t) => {
  const { tmp, home, context } = isolatedHome(t)
  pointHomeAt(t, home)

  await main(['init'], captureIo(), { cwd: tmp, env: context.env })

  assert.equal(resolvePaths({ ...context, cwd: tmp }).config_dir, join(tmp, '.tunnel'))
})
