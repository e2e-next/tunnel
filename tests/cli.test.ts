// The CLI: parsing arguments, inferring the mode, expanding a scenario file.
//
// main() is handed the admin app's request() as its fetch (makeAdminEnv and cliRunner), so no
// server has to be running and no socket is opened.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'
import { ANDROID_REMOTE_PATH } from '../src/cli-ca.ts'
import { type CliDeps, defaultBase } from '../src/cli-common.ts'
import { buildParser, main } from '../src/cli.ts'
import { Paths, TunnelConfigManager } from '../src/config.ts'
import { makeRequest } from '../src/messages.ts'
import { VERSION } from '../src/package-info.ts'
import { type AdminEnv, makeAdminEnv } from './support/admin-env.ts'
import { captureIo, type CliRunner, cliRunner } from './support/cli.ts'
import { freePort } from './support/ports.ts'
import { tmpDir } from './support/tmp.ts'

/** The fetch of a test that only parses: a request would be a bug */
function noRequest(url: string): never {
  throw new Error(`no request was expected, and one went to ${url}`)
}

/** The CLI pointed at the admin app over a fresh configuration (env, whose manager the tests
 *  read), and a directory to work in. These tests name their files by absolute path */
async function run(t: TestContext): Promise<{ cli: CliRunner; env: AdminEnv; cwd: string }> {
  const env = await makeAdminEnv(t)
  const cwd = tmpDir(t)
  const cli = cliRunner({ fetch: env.fetch, cwd })
  return { cli, env, cwd }
}

/** The handler a scenario or `set --script` hands over in these tests */
const GEN_JS = 'function handler(ctx) {\n  return { ok: 1 }\n}\n'

test('global flags work before and after the subcommand', (t) => {
  // The trap: a subcommand writing its own default back over the value the top level read
  const { deps } = cliRunner({ fetch: noRequest, cwd: tmpDir(t) })
  const before = buildParser(deps).parse(['--base', 'http://x', '--json', 'ls'])
  const after = buildParser(deps).parse(['ls', '--base', 'http://x', '--json'])
  assert.ok(before.kind === 'run' && after.kind === 'run')
  assert.deepEqual([before.args.base, before.args.json], ['http://x', true])
  assert.deepEqual([after.args.base, after.args.json], ['http://x', true])
  const plain = buildParser(deps).parse(['ls'])
  assert.ok(plain.kind === 'run')
  assert.equal(plain.args.base, defaultBase(deps))
})

test('set normalizes method and path', async (t) => {
  const { cli, env } = await run(t)

  assert.equal(await cli.run('set', 'get', 'api/feed', '-d', '{"a": 1}'), 0)

  assert.ok(Object.hasOwn(env.manager.getConfig().request_configs, 'GET:/api/feed'))
  assert.ok(cli.takeOutput().out.includes('GET:/api/feed'))
})

test('set infers mode from source flag', async (t) => {
  const { cli, env, cwd } = await run(t)
  writeFileSync(join(cwd, 'gen.js'), 'function handler(ctx) {\n  return {}\n}\n')

  await cli.run('set', 'GET', '/a', '-d', '{"x": 1}')
  await cli.run('set', 'GET', '/b', '--script', join(cwd, 'gen.js'))
  await cli.run('set', 'GET', '/d', '--target', 'http://backend')

  const configs = env.manager.getConfig().request_configs
  assert.equal(configs['GET:/a']?.mode, 'json')
  assert.equal(configs['GET:/b']?.mode, 'script')
  assert.equal(configs['GET:/d']?.mode, 'passthrough')
  assert.equal(configs['GET:/d']?.target, 'http://backend')
})

test('a path keeps its leading slash and a host is kept as one', async (t) => {
  // `tunnel set GET api/feed` is still a path; a host needs a dot to be one
  const { cli, env } = await run(t)

  await cli.run('set', 'GET', 'api/feed', '-d', '{}')
  await cli.run('set', 'GET', 'api.example.com/api/feed', '-d', '{}')
  await cli.run('set', 'GET', '*.example.com/api/*', '-d', '{}')

  assert.deepEqual(Object.keys(env.manager.getConfig().request_configs).sort(), [
    'GET:*.example.com/api/*',
    'GET:/api/feed',
    'GET:api.example.com/api/feed',
  ])
})

test('the proxy mode is gone under its old name', async (t) => {
  // `proxy` became `passthrough` when the reverse proxy became a forward one
  const env = await makeAdminEnv(t)
  const cli = cliRunner({ fetch: env.fetch, cwd: tmpDir(t) })
  for (const argv of [
    ['set', 'GET', '/a', '--proxy', 'http://backend'],
    ['set', 'GET', '/a', '--mode', 'proxy'],
  ]) {
    // A usage error: the parser ends it, with exit code 1
    assert.equal(await cli.run(...argv), 1, argv.join(' '))
    assert.match(cli.takeOutput().err, /^usage: /)
  }
})

test('file mode flags are gone', async (t) => {
  // The server reads no user files: --file / --base-file must fail as unknown arguments
  const env = await makeAdminEnv(t)
  const cli = cliRunner({ fetch: env.fetch, cwd: tmpDir(t) })
  for (const argv of [
    ['set', 'GET', '/a', '--file', 'data/a.json'],
    ['set', 'GET', '/a', '--base-file', 'data/base.json'],
    ['set', 'GET', '/a', '--mode', 'file'],
  ]) {
    assert.equal(await cli.run(...argv), 1, argv.join(' '))
    assert.match(cli.takeOutput().err, /^usage: /)
  }
})

test('version is single sourced', async () => {
  const io = captureIo()
  assert.equal(await main(['--version'], io), 0)
  const { out, err } = io.takeOutput()
  assert.equal(out, `tunnel ${VERSION}\n`)
  assert.equal(err, '')
})

test('ls first line reports the three directories', async (t) => {
  const { cli, env } = await run(t)

  await cli.run('ls')

  const firstLine = cli.takeOutput().out.split('\n')[0]!
  assert.ok(firstLine.includes(env.manager.paths.config_dir))
  assert.ok(firstLine.startsWith('config:'))
  assert.ok(firstLine.includes('state:') && firstLine.includes('data:'))
})

test('set only touches given fields', async (t) => {
  const { cli, env } = await run(t)
  await cli.run('set', 'GET', '/a', '-d', '{"x": 1}', '--desc', 'a note', '--delay', '0.5')

  await cli.run('set', 'GET', '/a', '--status', '503')

  const config = env.manager.getConfig().request_configs['GET:/a']
  assert.deepEqual(
    [config?.status_code, config?.description, config?.response_delay],
    [503, 'a note', 0.5],
  )
  assert.deepEqual(config?.json_response, { x: 1 })
})

test('set leaves a pinned session alone unless it is named', async (t) => {
  // Without --session nothing is sent, so a later patch does not unpin the rule
  const { cli, env } = await run(t)
  await cli.run('set', 'GET', '/a', '--replay', '--session', 'acct_a')

  await cli.run('set', 'GET', '/a', '--replay', '--strategy', 'last')
  assert.equal(env.manager.getConfig().request_configs['GET:/a']?.replay_session, 'acct_a')

  // An empty name is how a rule is put back on whatever session is in hand
  await cli.run('set', 'GET', '/a', '--replay', '--session', '')
  assert.equal(env.manager.getConfig().request_configs['GET:/a']?.replay_session, '')
})

test('a value that is not ASCII survives the config file', async (t) => {
  // Real answers carry accents and emoji, and config.json is read back as UTF-8
  const { cli, env } = await run(t)
  await cli.run('set', 'GET', '/a', '-d', '{"name": "café ☕"}', '--desc', 'a café note')

  const reloaded = new TunnelConfigManager(
    Paths.inOneDirectory(env.manager.paths.config_dir),
  ).getConfig()

  const rule = reloaded.request_configs['GET:/a']
  assert.deepEqual(rule?.json_response, { name: 'café ☕' })
  assert.equal(rule?.description, 'a café note')
})

test('set rejects multiple sources', async (t) => {
  const { cli } = await run(t)
  assert.equal(await cli.run('set', 'GET', '/a', '-d', '{}', '--target', 'http://x'), 1)
  assert.ok(cli.takeOutput().err.includes('only one of'))
})

test('set shapes the answer without choosing a mode', async (t) => {
  // --merge, -H, --content-type and --fault say how an answer looks, not where
  // it comes from, so they go with a mode that was set before or somewhere else
  const { cli, env } = await run(t)
  await cli.run('set', 'GET', '/a', '--target', 'http://backend')

  const shaped = await cli.run(
    'set',
    'GET',
    '/a',
    '--merge',
    '{"data": {"total": 0}}',
    '-H',
    'Set-Cookie: sid=1',
    '-H',
    'X-Flag: 1',
    '--content-type',
    'application/problem+json',
    '--fault',
    'hang',
  )
  assert.equal(shaped, 0)

  const config = env.manager.getConfig().request_configs['GET:/a']
  assert.equal(config?.mode, 'passthrough')
  assert.deepEqual(config?.merge_json, { data: { total: 0 } })
  assert.deepEqual(config?.headers, {
    'Set-Cookie': 'sid=1',
    'X-Flag': '1',
    'content-type': 'application/problem+json',
  })
  assert.equal(config?.fault, 'hang')

  assert.equal(await cli.run('set', 'GET', '/a', '--fault', 'none'), 0)
  assert.equal(env.manager.getConfig().request_configs['GET:/a']?.fault, 'none')
})

test('set times the hang fault', async (t) => {
  // How long `hang` holds the request, without reaching for the API or a file
  const { cli, env } = await run(t)

  assert.equal(await cli.run('set', 'GET', '/a', '--fault', 'hang', '--fault-seconds', '5'), 0)

  const config = env.manager.getConfig().request_configs['GET:/a']
  assert.equal(config?.fault, 'hang')
  assert.equal(config?.fault_seconds, 5)
})

test('the hang seconds are a change of their own', async (t) => {
  // Retiming a rule that is already hanging should not need --fault said again
  const { cli, env } = await run(t)
  await cli.run('set', 'GET', '/a', '--fault', 'hang')

  assert.equal(await cli.run('set', 'GET', '/a', '--fault-seconds', '0.5'), 0)

  const config = env.manager.getConfig().request_configs['GET:/a']
  assert.equal(config?.fault_seconds, 0.5)
  assert.equal(config?.fault, 'hang')
})

test('ls says when a rule answers with a fault', async (t) => {
  // Its mode alone would not explain what the client is getting
  const { cli } = await run(t)
  await cli.run('set', 'GET', '/a', '-d', '{}', '--fault', 'close')

  cli.takeOutput()
  await cli.run('ls')

  assert.ok(cli.takeOutput().out.includes('[fault: close]'))
})

test('set refuses a header that is not one', async (t) => {
  const { cli, env } = await run(t)

  assert.equal(await cli.run('set', 'GET', '/a', '-H', 'no colon here'), 1)

  assert.ok(cli.takeOutput().err.includes('Name: value'))
  assert.ok(!Object.hasOwn(env.manager.getConfig().request_configs, 'GET:/a'))
})

test('set refuses a merge that is not an object', async (t) => {
  const { cli } = await run(t)

  assert.equal(await cli.run('set', 'GET', '/a', '--merge', '[1, 2]'), 1)

  assert.ok(cli.takeOutput().err.includes('JSON object'))
})

test('set reads JSON from file', async (t) => {
  const { cli, env, cwd } = await run(t)
  const payload = join(cwd, 'feed.json')
  writeFileSync(payload, JSON.stringify({ list: [1, 2] }))

  await cli.run('set', 'GET', '/a', '-d', `@${payload}`)

  assert.deepEqual(env.manager.getConfig().request_configs['GET:/a']?.json_response, {
    list: [1, 2],
  })
})

test('apply expands file references', async (t) => {
  const { cli, env, cwd } = await run(t)
  writeFileSync(join(cwd, 'gen.js'), GEN_JS)
  writeFileSync(join(cwd, 'user.json'), '{"id": 7}')
  const scenario = join(cwd, 'scenario.json')
  writeFileSync(
    scenario,
    JSON.stringify({
      config: { max_requests_history: 42 },
      mocks: [
        { key: 'GET:/api/feed', mode: 'script', script_file: 'gen.js' },
        { key: 'GET:/api/user/*', mode: 'json', json_file: 'user.json', status_code: 201 },
      ],
    }),
  )

  assert.equal(await cli.run('apply', scenario), 0)

  const configs = env.manager.getConfig().request_configs
  assert.ok(configs['GET:/api/feed']?.script.includes('return { ok: 1 }'))
  assert.deepEqual(configs['GET:/api/user/*']?.json_response, { id: 7 })
  assert.equal(configs['GET:/api/user/*']?.status_code, 201)
  assert.equal(env.manager.getConfig().max_requests_history, 42)
})

test('apply replace clears previous', async (t) => {
  const { cli, env, cwd } = await run(t)
  await cli.run('set', 'GET', '/old', '-d', '{}')
  const scenario = join(cwd, 's.json')
  writeFileSync(
    scenario,
    JSON.stringify({ mocks: [{ key: 'GET:/new', mode: 'json', json_response: {} }] }),
  )

  await cli.run('apply', scenario, '--replace')

  assert.deepEqual(Object.keys(env.manager.getConfig().request_configs), ['GET:/new'])
})

test('apply reports missing file', async (t) => {
  const { cli, cwd } = await run(t)
  const scenario = join(cwd, 's.json')
  writeFileSync(
    scenario,
    JSON.stringify({ mocks: [{ key: 'GET:/a', mode: 'script', script_file: 'nope.js' }] }),
  )

  assert.equal(await cli.run('apply', scenario), 1)
  assert.ok(cli.takeOutput().err.includes('no such script file'))
})

test('pack inlines the files a scenario points at', async (t) => {
  // A test case on a device applies the scenario itself, and the server reads
  // no files: what it needs has to travel inside it
  const { cli, env, cwd } = await run(t)
  writeFileSync(join(cwd, 'gen.js'), GEN_JS)
  writeFileSync(join(cwd, 'user.json'), '{"id": 7}')
  const scenario = join(cwd, 'scenario.json')
  writeFileSync(
    scenario,
    JSON.stringify({
      replace: true,
      mocks: [
        { key: 'GET:/api/feed', mode: 'script', script_file: 'gen.js' },
        { key: 'GET:/api/user/*', mode: 'json', json_file: 'user.json' },
      ],
    }),
  )
  const packed = join(cwd, 'packed.json')

  assert.equal(await cli.run('pack', scenario, '-o', packed), 0)

  const bundled = JSON.parse(readFileSync(packed, 'utf8'))
  assert.equal(bundled.replace, true)
  assert.ok(!('script_file' in bundled.mocks[0]))
  assert.ok(bundled.mocks[0].script.includes('return { ok: 1 }'))
  assert.deepEqual(bundled.mocks[1].json_response, { id: 7 })
  // And what came out is a scenario the server takes as it stands
  assert.equal(await cli.run('apply', packed), 0)
  const configured = Object.keys(env.manager.getConfig().request_configs).sort()
  assert.deepEqual(configured, ['GET:/api/feed', 'GET:/api/user/*'])
})

test('pack prints the scenario when no file is named', async (t) => {
  const { cli, cwd } = await run(t)
  const scenario = join(cwd, 's.json')
  writeFileSync(
    scenario,
    JSON.stringify({ mocks: [{ key: 'GET:/a', mode: 'json', json_response: { v: 1 } }] }),
  )

  assert.equal(await cli.run('pack', scenario), 0)

  assert.equal(JSON.parse(cli.takeOutput().out).mocks[0].key, 'GET:/a')
})

test('pack reports a file it cannot read', async (t) => {
  const { cli, cwd } = await run(t)
  const scenario = join(cwd, 's.json')
  writeFileSync(
    scenario,
    JSON.stringify({ mocks: [{ key: 'GET:/a', mode: 'script', script_file: 'nope.js' }] }),
  )

  assert.equal(await cli.run('pack', scenario, '-o', join(cwd, 'out.json')), 1)
  assert.ok(cli.takeOutput().err.includes('no such script file'))
})

test('pack creates the bundle directory it writes into', async (t) => {
  // `-o bundle/case.json` is how a test bundle is assembled, and in CI the
  // bundle directory is not there yet
  const { cli, cwd } = await run(t)
  const scenario = join(cwd, 's.json')
  writeFileSync(
    scenario,
    JSON.stringify({ mocks: [{ key: 'GET:/a', mode: 'json', json_response: { v: 1 } }] }),
  )
  const packed = join(cwd, 'bundle', 'case.json')

  assert.equal(await cli.run('pack', scenario, '-o', packed), 0)

  assert.equal(JSON.parse(readFileSync(packed, 'utf8')).mocks[0].key, 'GET:/a')
})

test('pack reports an output path it cannot write', async (t) => {
  // One line saying which path, the way every other user error prints
  const { cli, cwd } = await run(t)
  const scenario = join(cwd, 's.json')
  writeFileSync(scenario, JSON.stringify({ mocks: [] }))
  // A file where the output's directory would have to be
  writeFileSync(join(cwd, 'blocked'), 'not a directory')

  assert.equal(await cli.run('pack', scenario, '-o', join(cwd, 'blocked', 'x.json')), 1)

  const error = cli.takeOutput().err
  assert.ok(error.includes('could not write'))
  assert.ok(!error.includes('Traceback'))
  // What a traceback is in Node: a stack frame
  assert.doesNotMatch(error, /^\s+at /m)
})

test('export round trips into apply', async (t) => {
  const { cli, env, cwd } = await run(t)
  await cli.run('set', 'GET', '/api/feed', '-d', '{"v": 1}', '--desc', 'feed')
  const exported = join(cwd, 'export.json')

  await cli.run('export', '-o', exported)
  await cli.run('rm', 'GET', '/api/feed')
  assert.deepEqual(env.manager.getConfig().request_configs, {})
  await cli.run('apply', exported)

  assert.equal(env.manager.getConfig().request_configs['GET:/api/feed']?.description, 'feed')
})

test('export leaves the global settings out unless asked', async (t) => {
  const { cli, cwd } = await run(t)
  await cli.run('set', 'GET', '/api/feed', '-d', '{"v": 1}')

  const [plain, full] = [join(cwd, 'plain.json'), join(cwd, 'full.json')]
  await cli.run('export', '-o', plain)
  await cli.run('export', '--with-config', '-o', full)

  assert.ok(!readFileSync(plain, 'utf8').includes('default_mode'))
  assert.ok(readFileSync(full, 'utf8').includes('default_mode'))
})

test('reset state and requests', async (t) => {
  const { cli, env, cwd } = await run(t)
  // The core the admin API was wired to, which is what `tunnel reset` resets
  const script = join(cwd, 'poll.js')
  writeFileSync(
    script,
    'function handler(ctx) {\n  ctx.state.n = (ctx.state.n ?? 0) + 1\n  return { n: ctx.state.n }\n}\n',
  )
  await cli.run('set', 'GET', '/p', '--script', script)

  const poll = async (): Promise<number> => {
    const response = await env.core.resolve(makeRequest({ method: 'GET', host: 'x', path: '/p' }))
    return JSON.parse(response.body.toString()).n
  }

  assert.equal(await poll(), 1)
  assert.equal(await poll(), 2)
  await cli.run('reset', 'GET', '/p')
  assert.equal(await poll(), 1)

  await cli.run('reset', '--requests')
  assert.deepEqual(env.core.exchanges.all(), [])
})

test('wait exits zero with the seqs that matched', async (t) => {
  const { cli, env } = await run(t)
  await env.core.resolve(makeRequest({ method: 'POST', host: 'api.example.com', path: '/api/pay' }))

  assert.equal(await cli.run('wait', 'POST', 'api.example.com/api/pay', '--timeout', '5'), 0)
  assert.ok(cli.takeOutput().out.includes('1 matched: 1'))
})

test('wait exits three on timeout and says how many it saw', async (t) => {
  // The exit code is the assertion: 3 means the client never made the call
  const { cli } = await run(t)

  assert.equal(await cli.run('wait', 'POST', '/api/pay', '--count', '2', '--timeout', '0.1'), 3)
  assert.ok(cli.takeOutput().out.includes('Timed out after 0.1s with 0 of 2 requests'))
})

// These use the real fetch on a port that was just closed, a real ECONNREFUSED, and give --base:
// without it the CLI would try 8000, where the developer's own server may be running
test('unreachable server exits two with a clean error', async (t) => {
  // 2 is "nothing is running there", which a script tells from a user error
  const closed = `http://127.0.0.1:${await freePort()}`
  const cli = cliRunner({ fetch: globalThis.fetch, base: closed, cwd: tmpDir(t) })

  assert.equal(await cli.run('ls'), 2)
  assert.ok(cli.takeOutput().err.includes('nothing answers at'))
})

test('a base that never answers exits two as well', async (t) => {
  // A --base whose packets are dropped times out instead of being refused;
  // it is the same "nothing is running there", not a traceback
  const timedOut = async (): Promise<never> => {
    // What fetch throws when undici's own connect timeout runs out: a real address that drops
    // packets would take 10 s and is not the test's to hold
    const cause = Object.assign(new Error('Connect Timeout Error'), {
      code: 'UND_ERR_CONNECT_TIMEOUT',
    })
    throw new TypeError('fetch failed', { cause })
  }
  const cli = cliRunner({ fetch: timedOut, cwd: tmpDir(t) })

  assert.equal(await cli.run('ls'), 2)
  assert.ok(cli.takeOutput().err.includes('nothing answers at'))
})

test('errors are JSON on stderr in JSON mode', async (t) => {
  // --json is for scripts, and a script should not have to parse a sentence
  const closed = `http://127.0.0.1:${await freePort()}`
  const cli = cliRunner({ fetch: globalThis.fetch, base: closed, cwd: tmpDir(t) })

  assert.equal(await cli.run('--json', 'ls'), 2)

  const captured = cli.takeOutput()
  assert.equal(captured.out, '')
  assert.equal(JSON.parse(captured.err).exit_code, 2)
  // And that one line is all there is
  assert.match(captured.err, /^[^\n]*\n$/)
})

test('a usage error exits one', async () => {
  // Not 2, which is this CLI's code for an absent server
  const io = captureIo()
  assert.equal(await main(['set', 'GET', '/a', '--nonsense'], io), 1)
  assert.ok(io.takeOutput().err.includes('--nonsense'))
})

test('ssl add, rm and exclude edit the two lists', async (t) => {
  // The CLI reads the locations, edits them and sends them back; no endpoint of its own
  const { cli, env } = await run(t)

  await cli.run('ssl', 'add', 'api.example.com', '*.corp.example:443')
  await cli.run('ssl', 'add', 'api.example.com') // already there, and not added twice
  await cli.run('ssl', 'exclude', 'add', 'cdn.example.com')
  await cli.run('ssl', 'rm', '*.corp.example:443')

  const policy = env.manager.getConfig().ssl_proxying
  assert.deepEqual([policy.include, policy.exclude], [['api.example.com'], ['cdn.example.com']])
  assert.ok(cli.takeOutput().out.includes('api.example.com'))
})

test('ssl on and off leave the lists alone', async (t) => {
  const { cli, env } = await run(t)
  await cli.run('ssl', 'add', 'api.example.com')

  await cli.run('ssl', 'off')
  assert.equal(env.manager.getConfig().ssl_proxying.enabled, false)

  await cli.run('ssl', 'on')
  const policy = env.manager.getConfig().ssl_proxying
  assert.deepEqual([policy.enabled, policy.include], [true, ['api.example.com']])
})

test('removing a location that is not there is an error', async (t) => {
  const { cli } = await run(t)

  assert.equal(await cli.run('ssl', 'rm', 'api.example.com'), 1)
  assert.ok(cli.takeOutput().err.includes('not in the include list'))
})

test('serve keeps port as an alias for admin_port', (t) => {
  // The flag was --port before the proxy port existed; scripts still pass it
  const { deps } = cliRunner({ fetch: noRequest, cwd: tmpDir(t) })
  const parsed = buildParser(deps).parse(['serve', '--port', '9000'])
  assert.ok(parsed.kind === 'run')
  assert.equal(parsed.args.admin_port, 9000)
  assert.deepEqual([parsed.args.proxy_host, parsed.args.proxy_port], ['0.0.0.0', 8890])
})

/** What recordSubprocess kept of one command: the command, and the bytes of the .pem file it named
 *  as they were when it ran (null when it named none that was there) */
interface Recorded {
  command: string[]
  pem: Buffer | null
}

/** Stands in for xcrun, adb and security, none of which exist on a CI machine. The .pem file is
 *  read while the command runs, since ca install removes the directory it is in before it
 *  returns */
function recordSubprocess({ status = 0, stderr = '' }: { status?: number; stderr?: string } = {}): {
  calls: Recorded[]
  run: CliDeps['run']
} {
  const calls: Recorded[] = []
  const run: CliDeps['run'] = (command) => {
    const pem = command.find((arg) => arg.endsWith('.pem') && existsSync(arg))
    calls.push({ command: [...command], pem: pem === undefined ? null : readFileSync(pem) })
    return { status, signal: null, stdout: '', stderr, error: undefined }
  }
  return { calls, run }
}

test('ca export and info read the running server', async (t) => {
  const { cli, env, cwd } = await run(t)
  const exported = join(cwd, 'exported-ca.pem')

  assert.equal(await cli.run('ca', 'export', '-o', exported), 0)
  assert.equal(await cli.run('ca', 'info'), 0)

  assert.deepEqual(readFileSync(exported), readFileSync(env.manager.paths.caFile))
  const printed = cli.takeOutput().out
  assert.ok(printed.includes(env.manager.paths.caFile))
  assert.ok(printed.includes('fingerprint'))
})

// Like 'unreachable server exits two with a clean error', this one uses the real fetch on a port
// that was just closed, and gives --base so that nothing goes to 8000
test('ca commands work without a running server', async (t) => {
  // A device is set up before any traffic flows, so this cannot need the server
  const tmp = tmpDir(t)
  const closed = `http://127.0.0.1:${await freePort()}`
  const cli = cliRunner({
    fetch: globalThis.fetch,
    base: closed,
    env: { TUNNEL_CONFIG_DIR: join(tmp, 'config') },
    cwd: tmp,
  })
  const exported = join(tmp, 'tunnel-ca.pem')

  assert.equal(await cli.run('ca', 'export', '-o', exported), 0)
  assert.equal(await cli.run('ca', 'info'), 0)

  assert.deepEqual(readFileSync(exported), readFileSync(join(tmp, 'config', 'ca.pem')))
  assert.ok(cli.takeOutput().out.includes(join(tmp, 'config', 'ca.pem')))
})

test('ca install hands the certificate to each platform tool', async (t) => {
  const env = await makeAdminEnv(t)
  const { calls, run: tools } = recordSubprocess()
  const cli = cliRunner({ fetch: env.fetch, cwd: tmpDir(t), run: tools })

  assert.equal(await cli.run('ca', 'install', '--ios-simulator'), 0)
  assert.equal(await cli.run('ca', 'install', '--android'), 0)
  assert.equal(await cli.run('ca', 'install', '--macos'), 0)

  assert.deepEqual(
    calls.map((call) => call.command[0]),
    ['xcrun', 'adb', 'security'],
  )
  assert.deepEqual(calls[0]!.command.slice(1, 5), ['simctl', 'keychain', 'booted', 'add-root-cert'])
  assert.equal(calls[1]!.command.at(-1), ANDROID_REMOTE_PATH)
  assert.ok(calls[2]!.command.includes('add-trusted-cert'))
  // Whatever the tool is, what it received is the certificate this server signs with
  const certificate = readFileSync(env.manager.paths.caFile)
  for (const call of calls) assert.deepEqual(call.pem, certificate)
  // Android needs steps nobody can guess; they are printed rather than assumed
  assert.ok(cli.takeOutput().out.includes('network_security_config'))
})

test('ca install passes on what the tool said', async (t) => {
  const env = await makeAdminEnv(t)
  const { run: tools } = recordSubprocess({ status: 1, stderr: 'No devices are booted.' })
  const cli = cliRunner({ fetch: env.fetch, cwd: tmpDir(t), run: tools })

  assert.equal(await cli.run('ca', 'install', '--ios-simulator'), 1)
  assert.ok(cli.takeOutput().err.includes('No devices are booted.'))
})

test('ca install needs to be told where', async (t) => {
  const env = await makeAdminEnv(t)
  const cli = cliRunner({ fetch: env.fetch, cwd: tmpDir(t) })
  assert.equal(await cli.run('ca', 'install'), 1)
  assert.match(cli.takeOutput().err, /^usage: /)
})

test('ca reset warns that every device has to install it again', async (t) => {
  const { cli, env } = await run(t)
  await cli.run('ca', 'info')
  const before = readFileSync(env.manager.paths.caFile)
  cli.takeOutput()

  assert.equal(await cli.run('ca', 'reset'), 0)

  const printed = cli.takeOutput().out
  assert.notDeepEqual(readFileSync(env.manager.paths.caFile), before)
  assert.ok(printed.toLowerCase().includes('install'))
})

// `tunnel agents` is how the guide reaches a project that is not this one.
//
// An installed package has no checkout behind it, so the guide travels inside the package and
// comes back out through a command. What goes into the other project's CLAUDE.md or AGENTS.md is
// one line telling its agent to run `tunnel agents`, not a copy, which would sit in every prompt
// and freeze at the version it was pasted from; an agent that runs `tunnel --help` first has to be
// able to find the command there.
test('agents prints the guide that ships with the package', async () => {
  const io = captureIo()
  assert.equal(await main(['agents'], io), 0)
  const printed = io.takeOutput().out

  assert.ok(printed.startsWith('# AGENTS.md'))
  // The things an agent gets wrong without it, in the version it was given
  // rather than whatever is on the default branch today
  assert.ok(printed.includes('handler(ctx)'))
  assert.ok(printed.includes('ctx.state'))
  assert.ok(printed.includes('tunnel set'))

  const helpText = buildParser().formatHelp()
  assert.ok(helpText.includes('agents'))
})
