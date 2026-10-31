// src/config.ts, for what tests/config-loading.test.ts and tests/state-dir.test.ts leave out.
//
// Every directory here comes from a context isolatedHome(t) gives, or is an absolute path in
// a temp dir, so that nothing reads the real home or walks up from the real cwd. The one
// exception is the test of resolvePaths() with no arguments, which finds the TUNNEL_CONFIG_DIR
// tests/support/setup.ts pinned to a throwaway directory.
import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { Paths, TunnelConfigManager, resolvePaths, upgradeOldConfig } from '../src/config.ts'
import { ValidationError } from '../src/errors.ts'
import { parseJson } from '../src/json.ts'
import type { LogRecord } from '../src/log.ts'
import { makeTunnelConfig, parseTunnelConfig, type TunnelConfig } from '../src/models.ts'
import { isolatedHome } from './support/home.ts'
import { captureLogs } from './support/logs.ts'
import { tmpDir } from './support/tmp.ts'

/** The text of a golden file in tests/fixtures/config/ */
function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/config/${name}`, import.meta.url), 'utf8')
}

/** What was logged at info and above, as [level, message]: the shape of old-format.log.json */
function logged(records: readonly LogRecord[]): string[][] {
  return records
    .filter((record) => record.level !== 'debug')
    .map((record) => [record.level, record.message])
}

// ---- The three directories

test('the CA and config.json live in config_dir; the request log, pid and log files in state_dir', (t) => {
  const { tmp, context } = isolatedHome(t)

  // Three different directories, so that a file put in the wrong one shows
  const paths = resolvePaths({
    ...context,
    env: {
      XDG_CONFIG_HOME: join(tmp, 'config'),
      XDG_STATE_HOME: join(tmp, 'state'),
      XDG_DATA_HOME: join(tmp, 'data'),
    },
  })

  assert.equal(paths.configFile, join(tmp, 'config/tunnel/config.json'))
  assert.equal(paths.caFile, join(tmp, 'config/tunnel/ca.pem'))
  assert.equal(paths.caKeyFile, join(tmp, 'config/tunnel/ca-key.pem'))
  assert.equal(paths.exchangesFile, join(tmp, 'state/tunnel/requests.jsonl'))
  assert.equal(paths.pidFile, join(tmp, 'state/tunnel/tunnel.pid'))
  assert.equal(paths.logFile, join(tmp, 'state/tunnel/tunnel.log'))
  assert.equal(paths.data_dir, join(tmp, 'data/tunnel'))

  // create() makes all three, parents included. The tests that make a manager have the three
  // in one directory, so this is the one place the other two are checked
  paths.create()
  for (const directory of [paths.config_dir, paths.state_dir, paths.data_dir]) {
    assert.ok(statSync(directory, { throwIfNoEntry: false })?.isDirectory(), directory)
  }
})

test('describe() reports the three directories as config_dir, state_dir and data_dir', (t) => {
  const { tmp, context } = isolatedHome(t)
  const paths = resolvePaths({
    ...context,
    env: {
      XDG_CONFIG_HOME: join(tmp, 'config'),
      XDG_STATE_HOME: join(tmp, 'state'),
      XDG_DATA_HOME: join(tmp, 'data'),
    },
  })

  const described = paths.describe()

  assert.deepStrictEqual(described, {
    config_dir: join(tmp, 'config/tunnel'),
    state_dir: join(tmp, 'state/tunnel'),
    data_dir: join(tmp, 'data/tunnel'),
  })
  // In the order health and `tunnel ls` show them
  assert.deepStrictEqual(Object.keys(described), ['config_dir', 'state_dir', 'data_dir'])
  // Frozen: what it reports cannot change under the reader
  assert.ok(Object.isFrozen(paths))
})

test('inOneDirectory resolves symlinks, makes a relative path absolute against cwd, and expands ~', (t) => {
  const { tmp, home } = isolatedHome(t)
  mkdirSync(join(tmp, 'real'))
  symlinkSync(join(tmp, 'real'), join(tmp, 'link'))

  // x does not exist: the part that does is resolved, and x is put back on the end
  const linked = join(tmp, 'real', 'x')
  assert.deepStrictEqual(Paths.inOneDirectory(join(tmp, 'link', 'x')).describe(), {
    config_dir: linked,
    state_dir: linked,
    data_dir: linked,
  })
  assert.equal(Paths.inOneDirectory('rel', { cwd: tmp }).config_dir, join(tmp, 'rel'))
  assert.equal(Paths.inOneDirectory('~', { cwd: tmp, home }).config_dir, home)
  assert.equal(Paths.inOneDirectory('~/x', { cwd: tmp, home }).config_dir, join(home, 'x'))
  // ~user is not looked up in the password database, so it is a relative path like any other
  assert.equal(
    Paths.inOneDirectory('~user/x', { cwd: tmp, home }).config_dir,
    join(tmp, '~user', 'x'),
  )
})

test('inOneDirectory keeps the letter case it was given', (t) => {
  const tmp = tmpDir(t)
  mkdirSync(join(tmp, 'CaseDir'))

  // On a disk that ignores case, as macOS's does by default, casedir is CaseDir, and realpath(3),
  // which realpathSync.native calls, answers with the case on disk; the JS realpathSync keeps the
  // case it was given. On a disk that minds case, casedir is not there, and is kept as given all
  // the same
  assert.equal(Paths.inOneDirectory(join(tmp, 'casedir')).config_dir, join(tmp, 'casedir'))
})

test('configDir comes before TUNNEL_CONFIG_DIR', (t) => {
  const { tmp, context } = isolatedHome(t)
  const env = { TUNNEL_CONFIG_DIR: join(tmp, 'from-env') }

  assert.equal(
    resolvePaths({ ...context, env, configDir: join(tmp, 'given') }).config_dir,
    join(tmp, 'given'),
  )
  // An empty one counts as not given
  assert.equal(resolvePaths({ ...context, env, configDir: '' }).config_dir, join(tmp, 'from-env'))
  // Resolving makes no directories: the manager does, when it is made
  assert.ok(!existsSync(join(tmp, 'given')))
  assert.ok(!existsSync(join(tmp, 'from-env')))
})

test('an empty variable counts as unset', (t) => {
  const { tmp, home, context } = isolatedHome(t)
  const userConfig = join(home, '.config/tunnel')

  assert.equal(resolvePaths({ ...context, env: { TUNNEL_CONFIG_DIR: '' } }).config_dir, userConfig)
  assert.equal(resolvePaths({ ...context, env: { XDG_CONFIG_HOME: '' } }).config_dir, userConfig)

  // On Windows: no APPDATA means the XDG directories, whatever LOCALAPPDATA says
  const local = join(tmp, 'AppData/Local')
  const roaming = join(tmp, 'AppData/Roaming')
  assert.equal(
    resolvePaths({ ...context, platform: 'win32', env: { APPDATA: '', LOCALAPPDATA: local } })
      .config_dir,
    userConfig,
  )
  // and no LOCALAPPDATA means state goes in APPDATA, next to the config
  const split = resolvePaths({
    ...context,
    platform: 'win32',
    env: { APPDATA: roaming, LOCALAPPDATA: '' },
  })
  assert.equal(split.config_dir, join(roaming, 'tunnel'))
  assert.equal(split.state_dir, join(roaming, 'tunnel'))
})

test('a relative XDG variable is left relative', (t) => {
  const { context } = isolatedHome(t)

  // Only ~ is expanded there, where TUNNEL_CONFIG_DIR is made absolute and resolved
  const paths = resolvePaths({
    ...context,
    env: { XDG_CONFIG_HOME: 'rel-config', XDG_STATE_HOME: 'rel-state', XDG_DATA_HOME: 'rel-data' },
  })

  assert.deepStrictEqual(paths.describe(), {
    config_dir: join('rel-config', 'tunnel'),
    state_dir: join('rel-state', 'tunnel'),
    data_dir: join('rel-data', 'tunnel'),
  })
})

test('a file named .tunnel is not a project directory; a symlink to a directory is', (t) => {
  const { tmp, home, context } = isolatedHome(t)

  // A file: not the project's, so the walk goes on up, finds none and settles on the user level
  const withFile = join(tmp, 'with-file')
  mkdirSync(withFile)
  writeFileSync(join(withFile, '.tunnel'), '')
  assert.equal(resolvePaths({ ...context, cwd: withFile }).config_dir, join(home, '.config/tunnel'))

  // A symlink to a directory: the project's, reported as the directory it points to
  const target = join(tmp, 'elsewhere')
  mkdirSync(target)
  const withLink = join(tmp, 'with-link')
  mkdirSync(withLink)
  symlinkSync(target, join(withLink, '.tunnel'))
  assert.equal(resolvePaths({ ...context, cwd: withLink }).config_dir, target)
})

test('resolvePaths() with no arguments reads the real process', () => {
  // tests/support/setup.ts pinned TUNNEL_CONFIG_DIR to a throwaway directory before any test
  // file loaded. It is made with mkdtemp and not resolved, so on macOS the answer is its
  // /private/... form
  const pinned = process.env.TUNNEL_CONFIG_DIR
  assert.ok(pinned)
  const dir = realpathSync(pinned)

  assert.deepStrictEqual(resolvePaths().describe(), {
    config_dir: dir,
    state_dir: dir,
    data_dir: dir,
  })
})

// ---- Upgrading a config.json an older tunnel wrote

test('upgrading old-format.json gives old-format.loaded.json and logs old-format.log.json', (t) => {
  const logs = captureLogs(t)
  const data = JSON.parse(fixture('old-format.json')) as Record<string, unknown>

  upgradeOldConfig(data)

  assert.deepStrictEqual(parseTunnelConfig(data), JSON.parse(fixture('old-format.loaded.json')))
  assert.deepStrictEqual(logged(logs.records), JSON.parse(fixture('old-format.log.json')))
  // All under the module's own logger
  assert.deepStrictEqual(
    [...new Set(logs.records.map((record) => record.logger))],
    ['tunnel.config'],
  )
})

test('custom_proxy_target moves to target only when target is empty, [] and {} included', (t) => {
  const logs = captureLogs(t)
  // [a rule's fields, the same rule upgraded]. [] and {} are empty, where JS takes them as true
  const cases: [given: Record<string, unknown>, upgraded: Record<string, unknown>][] = [
    [{ custom_proxy_target: 'https://a' }, { target: 'https://a' }],
    [{ custom_proxy_target: 'https://a', target: '' }, { target: 'https://a' }],
    [{ custom_proxy_target: 'https://a', target: null }, { target: 'https://a' }],
    [{ custom_proxy_target: 'https://a', target: [] }, { target: 'https://a' }],
    [{ custom_proxy_target: 'https://a', target: {} }, { target: 'https://a' }],
    [{ custom_proxy_target: 'https://a', target: 'https://b' }, { target: 'https://b' }],
    // Nothing worth moving; the old field goes all the same
    [{ custom_proxy_target: '' }, {}],
    [{ custom_proxy_target: [] }, {}],
    [{ custom_proxy_target: {} }, {}],
    [{ custom_proxy_target: 0 }, {}],
    [{ custom_proxy_target: null }, {}],
  ]

  for (const [given, upgraded] of cases) {
    const rule = { ...given }
    upgradeOldConfig({ request_configs: { 'GET:/x': rule } })
    assert.deepStrictEqual(rule, upgraded, JSON.stringify(given))
  }

  // None of it is logged
  assert.deepStrictEqual(logs.records, [])
})

test('request_configs or entries that are not objects are left for the model to refuse', (t) => {
  const logs = captureLogs(t)

  for (const text of [
    '{"request_configs": []}',
    '{"request_configs": {"GET:/x": "notadict"}}',
    '{"recording": "x"}',
    // null, and an array holding what would be a rule: a test for typeof 'object' lets them in
    '{"request_configs": null}',
    '{"request_configs": {"GET:/x": null}}',
    '{"recording": null}',
    '{"request_configs": [{"request_key": "GET:/x", "mode": "file"}]}',
  ]) {
    const data = JSON.parse(text) as Record<string, unknown>
    upgradeOldConfig(data)
    assert.deepStrictEqual(data, JSON.parse(text), text)
  }

  assert.deepStrictEqual(logs.records, [])
})

test('a default_mode that is not a string is shown as JSON in the warning', (t) => {
  const logs = captureLogs(t)

  for (const mode of [5, true, ['a'], parseJson('12345678901234567890')]) {
    const data: Record<string, unknown> = { default_mode: mode }
    upgradeOldConfig(data)
    // Taken out, so that the model's default answers
    assert.deepStrictEqual(data, {})
  }
  // An integer past 2^53 comes out as its digits
  const fallingBack = (shown: string) => [
    'warning',
    `Global default_mode "${shown}" is no longer offered; falling back to "passthrough"`,
  ]
  assert.deepStrictEqual(logged(logs.records), [
    fallingBack('5'),
    fallingBack('true'),
    fallingBack('["a"]'),
    fallingBack('12345678901234567890'),
  ])

  // null gets through along with the two modes on offer: kept, nothing logged. It is then the
  // model's to refuse
  for (const mode of [null, 'passthrough', 'replay']) {
    const data: Record<string, unknown> = { default_mode: mode }
    upgradeOldConfig(data)
    assert.deepStrictEqual(data, { default_mode: mode })
  }
  assert.equal(logs.records.length, 4)
})

test("the recording switch's session does not replace a session already at the top", (t) => {
  const logs = captureLogs(t)
  const data = { session: 'mine', recording: { active: true, session: 'acct_a' } }

  upgradeOldConfig(data)

  assert.deepStrictEqual(data, { session: 'mine', recording: { active: true } })
  // Logged all the same
  assert.deepStrictEqual(logged(logs.records), [
    [
      'info',
      `Session "acct_a" was the recording switch's; it is the current session now, which replay reads as well`,
    ],
  ])

  // Nor a null one: what counts is whether the key is there, where ??= would ask what it holds.
  // The model then refuses the null
  const empty = { session: null, recording: { active: true, session: 'acct_a' } }
  upgradeOldConfig(empty)
  assert.deepStrictEqual(empty, { session: null, recording: { active: true } })

  // A switch with no session in it: nothing moves, nothing is logged
  const plain = { recording: { active: true } }
  upgradeOldConfig(plain)
  assert.deepStrictEqual(plain, { recording: { active: true } })
  assert.equal(logs.records.length, 2)
})

test('the rules that stored the default session are named in one info line, a dropped file rule not among them', (t) => {
  const logs = captureLogs(t)
  const data = {
    request_configs: {
      'GET:/a': { request_key: 'GET:/a', replay_session: 'default' },
      // Dropped before its session is looked at
      'GET:/b': { request_key: 'GET:/b', mode: 'file', replay_session: 'default' },
      'GET:/c': { request_key: 'GET:/c', replay_session: 'default' },
    },
  }

  upgradeOldConfig(data)

  assert.deepStrictEqual(data, {
    request_configs: {
      'GET:/a': { request_key: 'GET:/a', replay_session: '' },
      'GET:/c': { request_key: 'GET:/c', replay_session: '' },
    },
  })
  // old-format.json has one rule of each kind, so it shows neither the ', ' between the keys nor
  // the file rule left out
  assert.deepStrictEqual(logged(logs.records), [
    [
      'warning',
      'Skipping GET:/b: response mode "file" was removed. Serve the payload with `tunnel set -d @file` instead.',
    ],
    [
      'info',
      'These rules replayed the default session because that is what was stored in them; they follow the current session now, and `--session default` pins one back: GET:/a, GET:/c',
    ],
  ])
})

// ---- Loading, saving and updateConfig

test('an empty directory gets defaults.json, byte for byte', (t) => {
  const dir = tmpDir(t)
  const logs = captureLogs(t)

  const manager = new TunnelConfigManager(Paths.inOneDirectory(dir))

  // Written out straight away, so that the file is there to find and edit
  assert.equal(readFileSync(manager.paths.configFile, 'utf8'), fixture('defaults.json'))
  assert.deepStrictEqual(manager.getConfig(), makeTunnelConfig())
  // A file not there yet is no trouble to report
  assert.deepStrictEqual(logs.records, [])
})

test('full.json loads as parseJson reads it and is written back byte for byte, but for 2.0 → 2', (t) => {
  const dir = tmpDir(t)
  const full = fixture('full.json')
  writeFileSync(join(dir, 'config.json'), full)

  const manager = new TunnelConfigManager(Paths.inOneDirectory(dir))
  // The two integers past 2^53 included, digit for digit
  assert.deepStrictEqual(manager.getConfig(), parseJson(full))

  // updateConfig() with nothing in it saves all the same
  manager.updateConfig({})

  // A float holding a whole number is written 2 where full.json has 2.0. The rest is the same
  // byte for byte: the order of the keys, the escapes, U+2028 and the emoji, the big integers
  assert.equal(
    readFileSync(manager.paths.configFile, 'utf8'),
    full.replace(/(?<=\d)\.0(?=,?\n)/g, ''),
  )
})

test('full.json with CRLF line ends loads the same and is written back with LF', (t) => {
  const dir = tmpDir(t)
  const full = fixture('full.json')
  // Each \n as \r\n, as on Windows. A JSON string holds no line break of its own, so every one
  // in the file is between the tokens
  writeFileSync(join(dir, 'config.json'), full.replaceAll('\n', '\r\n'))

  const manager = new TunnelConfigManager(Paths.inOneDirectory(dir))
  assert.deepStrictEqual(manager.getConfig(), parseJson(full))

  // The bytes differ, what is read does not: saved, it is written as anywhere else, \n alone
  manager.updateConfig({})
  assert.equal(
    readFileSync(manager.paths.configFile, 'utf8'),
    full.replace(/(?<=\d)\.0(?=,?\n)/g, ''),
  )
})

test('old-format.json loads upgraded, logs old-format.log.json, and stays as it was on disk', (t) => {
  const dir = tmpDir(t)
  const file = join(dir, 'config.json')
  writeFileSync(file, fixture('old-format.json'))
  const before = readFileSync(file)
  const logs = captureLogs(t)

  const config = new TunnelConfigManager(Paths.inOneDirectory(dir)).getConfig()

  assert.deepStrictEqual(config, JSON.parse(fixture('old-format.loaded.json')))
  assert.deepStrictEqual(logged(logs.records), JSON.parse(fixture('old-format.log.json')))
  // Upgraded in memory only: the file changes when something is next saved
  assert.deepStrictEqual(readFileSync(file), before)
})

test('an unreadable config.json: one warning, the defaults, and the file left alone', (t) => {
  const tmp = tmpDir(t)
  const logs = captureLogs(t)
  // What config.json holds; null makes it a directory. Whatever goes wrong between the bytes and
  // the model counts
  const cases: [name: string, content: string | Buffer | null][] = [
    ['broken JSON', '{'],
    ['not an object', '[]'],
    ['a field the model refuses', '{"max_requests_history":"many"}'],
    ['bytes that are not UTF-8', Buffer.from([0x7b, 0xff, 0x7d])],
    // Inside a string, where a lenient decoder's U+FFFD would load, and be saved next time
    [
      'bytes that are not UTF-8, in a string',
      Buffer.concat([Buffer.from('{"session":"'), Buffer.from([0xff]), Buffer.from('"}')]),
    ],
    // Not JSON: JSON.parse cannot read them
    ['NaN', '{"x": NaN}'],
    ['Infinity', '{"fault_seconds": Infinity}'],
    ['a directory', null],
  ]

  // Each in a directory of its own, and only the records it adds looked at
  for (const [index, [name, content]] of cases.entries()) {
    const dir = join(tmp, String(index))
    const file = join(dir, 'config.json')
    mkdirSync(dir)
    if (content === null) mkdirSync(file)
    else writeFileSync(file, content)
    const before = content === null ? null : readFileSync(file)
    const seen = logs.records.length

    const manager = new TunnelConfigManager(Paths.inOneDirectory(dir))

    assert.deepStrictEqual(manager.getConfig(), makeTunnelConfig(), name)
    const added = logs.records.slice(seen)
    assert.equal(added.length, 1, name)
    assert.equal(added[0]?.level, 'warning', name)
    // The reason follows, in JS's words
    assert.match(added[0]?.message ?? '', /^Could not read the config file: \S/, name)
    // Not written over with the defaults: what was there is still there
    if (before === null) assert.ok(statSync(file).isDirectory(), name)
    else assert.deepStrictEqual(readFileSync(file), before, name)
  }
})

test(
  'a config.json without read permission: one warning, the defaults, and the file left alone',
  // Not one of the cases above, as root reads a file whatever its mode
  { skip: process.getuid?.() === 0 },
  (t) => {
    const dir = tmpDir(t)
    const file = join(dir, 'config.json')
    writeFileSync(file, '{"session":"unread"}')
    const before = readFileSync(file)
    chmodSync(file, 0o000)
    const logs = captureLogs(t)

    const config = new TunnelConfigManager(Paths.inOneDirectory(dir)).getConfig()
    chmodSync(file, 0o644)

    assert.deepStrictEqual(config, makeTunnelConfig())
    assert.equal(logs.records.length, 1)
    assert.equal(logs.records[0]?.level, 'warning')
    assert.match(logs.records[0]?.message ?? '', /^Could not read the config file: \S/)
    assert.deepStrictEqual(readFileSync(file), before)
  },
)

test('a BOM at the start is skipped', (t) => {
  const dir = tmpDir(t)
  // Read on purpose: refused, the file would load as the defaults, and the next save would write
  // the rules away
  const bom = Buffer.from([0xef, 0xbb, 0xbf])
  writeFileSync(join(dir, 'config.json'), Buffer.concat([bom, Buffer.from('{"session":"bom"}')]))

  const config = new TunnelConfigManager(Paths.inOneDirectory(dir)).getConfig()

  assert.equal(config.session, 'bom')
})

test(
  'a config.json that cannot be written: an error logged, the change kept',
  // root writes to a read-only file all the same
  { skip: process.getuid?.() === 0 },
  (t) => {
    const manager = new TunnelConfigManager(Paths.inOneDirectory(tmpDir(t)))
    chmodSync(manager.paths.configFile, 0o444)
    const logs = captureLogs(t)

    const config = manager.updateConfig({ session: 'x' })

    // The change holds in memory and the caller is answered as if it were saved
    assert.equal(config.session, 'x')
    assert.equal(manager.getConfig().session, 'x')
    assert.equal(logs.records.length, 1)
    assert.equal(logs.records[0]?.level, 'error')
    assert.match(logs.records[0]?.message ?? '', /^Could not write the config file: \S/)
  },
)

test('a config.json that is a symlink is read and written through, and stays a link', (t) => {
  const tmp = tmpDir(t)
  // Kept elsewhere, in a dotfiles repository say, and linked in
  const target = join(tmp, 'dotfiles', 'tunnel.json')
  mkdirSync(join(tmp, 'dotfiles'))
  writeFileSync(target, '{"session":"linked"}')
  const dir = join(tmp, 'project')
  mkdirSync(dir)
  const link = join(dir, 'config.json')
  symlinkSync(target, link)

  const manager = new TunnelConfigManager(Paths.inOneDirectory(dir))
  assert.equal(manager.getConfig().session, 'linked')
  const config = manager.updateConfig({ max_requests_history: 7 })

  // Written over in place rather than replaced by a rename, which would leave a plain file where
  // the link was
  assert.ok(lstatSync(link).isSymbolicLink())
  assert.equal(readlinkSync(link), target)
  assert.equal(readFileSync(target, 'utf8'), JSON.stringify(config, null, 2))
})

test('a manager whose directories cannot be made throws what mkdir threw', (t) => {
  const tmp = tmpDir(t)
  // A file where config_dir should be
  writeFileSync(join(tmp, 'taken'), '')

  // Not caught: there is nowhere to keep the configuration
  assert.throws(() => new TunnelConfigManager(Paths.inOneDirectory(join(tmp, 'taken'))), {
    code: 'EEXIST',
  })
})

test('updateConfig replaces ssl_proxying whole and converts the values it is given', (t) => {
  const dir = tmpDir(t)
  const manager = new TunnelConfigManager(Paths.inOneDirectory(dir))
  manager.updateConfig({ ssl_proxying: { enabled: false, include: ['a'], exclude: ['b'] } })

  // Not merged into what was there: the fields left out take their defaults again, as the nested
  // model is built afresh
  const replaced = manager.updateConfig({ ssl_proxying: { include: ['c'] } as never })
  assert.deepStrictEqual(replaced.ssl_proxying, { enabled: true, include: ['c'], exclude: [] })

  // A string where a number belongs, converted by the lax rules
  const converted = manager.updateConfig({ max_requests_history: '42' as never })
  assert.equal(converted.max_requests_history, 42)

  // and saved as converted: the next start reads what the last change made
  assert.deepStrictEqual(new TunnelConfigManager(Paths.inOneDirectory(dir)).getConfig(), converted)
})

test('updateConfig given null throws ValidationError and changes nothing, in memory or on disk', (t) => {
  const manager = new TunnelConfigManager(Paths.inOneDirectory(tmpDir(t)))
  const config = manager.getConfig()
  const saved = readFileSync(manager.paths.configFile)

  // What the admin API's patch models let through
  assert.throws(
    () => manager.updateConfig({ max_requests_history: null as never }),
    ValidationError,
  )

  assert.equal(manager.getConfig(), config)
  assert.deepStrictEqual(readFileSync(manager.paths.configFile), saved)
})

test('updateConfig ignores keys whose value is undefined', (t) => {
  const manager = new TunnelConfigManager(Paths.inOneDirectory(tmpDir(t)))
  manager.updateConfig({ session: 's' })

  // Left out, rather than handed to the model, which would take undefined as not given and put
  // the default back
  const config = manager.updateConfig({ session: undefined, replay_marker: false })

  assert.equal(config.session, 's')
  assert.equal(config.replay_marker, false)
})

test("keys that look like integers keep their values (their order is JS's)", (t) => {
  const dir = tmpDir(t)
  // Written out as text: a JS object literal would have reordered the keys already
  writeFileSync(
    join(dir, 'config.json'),
    '{"request_configs": {"GET:/x": {"request_key": "GET:/x", "json_response": {"10": 1, "2": 2}}}}',
  )

  const manager = new TunnelConfigManager(Paths.inOneDirectory(dir))
  manager.updateConfig({})

  const written = readFileSync(manager.paths.configFile, 'utf8')
  const rule = (JSON.parse(written) as TunnelConfig).request_configs['GET:/x']
  assert.deepStrictEqual(rule?.json_response, { '10': 1, '2': 2 })
  // A JS object puts the keys that look like integers first, in numeric order, so the file now
  // has "2" before "10"
  assert.match(written, /"json_response": \{\s*"2": 2,\s*"10": 1\s*\}/)
})

// ---- Getting, updating, deleting and clearing the rules

test('getRequestConfig: a key with no rule gets one in the global mode, and nothing is stored', (t) => {
  const dir = tmpDir(t)
  // Written by hand on one line, where a save writes the whole configuration out indented: the
  // bytes show whether anything was written
  const text = '{"default_mode": "replay"}'
  writeFileSync(join(dir, 'config.json'), text)
  const manager = new TunnelConfigManager(Paths.inOneDirectory(dir))

  const rule = manager.getRequestConfig('GET:/none')

  // The default rule, which full.json holds as GET:/10 (all defaults but mode "json"), in the
  // global mode
  const defaultRule = (JSON.parse(fixture('full.json')) as TunnelConfig).request_configs['GET:/10']
  assert.deepStrictEqual(rule, { ...defaultRule, request_key: 'GET:/none', mode: 'replay' })
  // Not stored, in memory or on disk
  assert.deepStrictEqual(manager.getConfig().request_configs, {})
  assert.equal(readFileSync(manager.paths.configFile, 'utf8'), text)
})

test('a rule created without a mode takes the default_mode of that moment', (t) => {
  const manager = new TunnelConfigManager(Paths.inOneDirectory(tmpDir(t)))
  manager.updateConfig({ default_mode: 'replay' })

  // It starts from the rule getRequestConfig hands out for a key with none
  const rule = manager.updateRequestConfig('GET:/a', { status_code: 201 })
  assert.equal(rule.mode, 'replay')
  assert.equal(rule.status_code, 201)

  // Stored with that mode, so switching the global one back no longer reaches it
  manager.updateConfig({ default_mode: 'passthrough' })
  assert.equal(manager.getRequestConfig('GET:/a').mode, 'replay')
})

test('an updated rule keeps its place, a new one goes last, and a reload keeps the order', (t) => {
  const dir = tmpDir(t)
  const manager = new TunnelConfigManager(Paths.inOneDirectory(dir))
  manager.updateRequestConfig('GET:/a', { status_code: 201, json_response: { first: 1 } })
  manager.updateRequestConfig('GET:/b', {})
  assert.deepStrictEqual(Object.keys(manager.getConfig().request_configs), ['GET:/a', 'GET:/b'])

  const updated = manager.updateRequestConfig('GET:/a', {
    description: 'changed',
    json_response: { second: 2 },
  })

  // The fields given on top of the rule there, a nested value replacing the one there whole; and
  // stored where it was
  assert.equal(updated.status_code, 201)
  assert.equal(updated.description, 'changed')
  assert.deepStrictEqual(updated.json_response, { second: 2 })
  assert.deepStrictEqual(Object.keys(manager.getConfig().request_configs), ['GET:/a', 'GET:/b'])
  // Saved as it stands: a fresh manager reads the same rules, in the same order
  const reloaded = new TunnelConfigManager(Paths.inOneDirectory(dir)).getConfig()
  assert.deepStrictEqual(Object.keys(reloaded.request_configs), ['GET:/a', 'GET:/b'])
  assert.deepStrictEqual(reloaded, manager.getConfig())
})

test('a rule whose request_key is not its key is kept as it is, and updated under its key', (t) => {
  const dir = tmpDir(t)
  // Edited by hand, so that the key and the request_key in the rule disagree
  writeFileSync(
    join(dir, 'config.json'),
    '{"request_configs": {"GET:/a": {"request_key": "GET:/b", "status_code": 201}}}',
  )
  const manager = new TunnelConfigManager(Paths.inOneDirectory(dir))
  assert.equal(manager.getRequestConfig('GET:/a').request_key, 'GET:/b')

  const rule = manager.updateRequestConfig('GET:/a', { description: 'x' })

  // Stored under the key it was asked for, with the request_key it had
  assert.equal(rule.request_key, 'GET:/b')
  assert.equal(rule.status_code, 201)
  assert.equal(manager.getRequestConfig('GET:/a'), rule)
  assert.deepStrictEqual(Object.keys(manager.getConfig().request_configs), ['GET:/a'])
  // and saved like that
  const reloaded = new TunnelConfigManager(Paths.inOneDirectory(dir)).getConfig()
  assert.deepStrictEqual(reloaded.request_configs, manager.getConfig().request_configs)
})

test('updateRequestConfig ignores undefined, and throws on null leaving the rule as it was', (t) => {
  const manager = new TunnelConfigManager(Paths.inOneDirectory(tmpDir(t)))
  manager.updateRequestConfig('GET:/a', { description: 'kept' })

  // Left out, rather than handed to the model, which would take undefined as not given and put
  // the default back
  const rule = manager.updateRequestConfig('GET:/a', { description: undefined, status_code: 201 })
  assert.equal(rule.description, 'kept')
  assert.equal(rule.status_code, 201)

  // What the admin API's patch models let through. Refused by the rule's own model, rather than
  // by the whole configuration's
  const saved = readFileSync(manager.paths.configFile)
  assert.throws(() => manager.updateRequestConfig('GET:/a', { status_code: null as never }), {
    name: 'ValidationError',
    title: 'TunnelRequestConfig',
  })

  assert.equal(manager.getRequestConfig('GET:/a'), rule)
  assert.deepStrictEqual(readFileSync(manager.paths.configFile), saved)
})

test('deleteRequestConfig says whether there was a rule; clearConfiguredRequests leaves none on disk', (t) => {
  const dir = tmpDir(t)
  const manager = new TunnelConfigManager(Paths.inOneDirectory(dir))
  const file = manager.paths.configFile
  for (const key of ['GET:/a', 'GET:/b', 'GET:/c']) manager.updateRequestConfig(key, {})
  const rules = manager.getConfig().request_configs

  // Deleted in place, so the rules getConfig() handed out lose it too; and saved
  assert.equal(manager.deleteRequestConfig('GET:/a'), true)
  assert.deepStrictEqual(Object.keys(rules), ['GET:/b', 'GET:/c'])
  const reloaded = new TunnelConfigManager(Paths.inOneDirectory(dir)).getConfig()
  assert.deepStrictEqual(Object.keys(reloaded.request_configs), ['GET:/b', 'GET:/c'])

  // Once more, with nothing left to delete: false, and nothing written. The file is put on one
  // line first, where a save writes it indented, so that a save would show in its bytes
  writeFileSync(file, JSON.stringify(manager.getConfig()))
  const before = readFileSync(file)
  assert.equal(manager.deleteRequestConfig('GET:/a'), false)
  assert.deepStrictEqual(readFileSync(file), before)

  // Every rule that is left, in place; and saved
  assert.equal(manager.clearConfiguredRequests(), true)
  assert.deepStrictEqual(rules, {})
  const cleared = new TunnelConfigManager(Paths.inOneDirectory(dir)).getConfig()
  assert.deepStrictEqual(cleared.request_configs, {})
})
