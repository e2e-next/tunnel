// Edge cases of the tunnel command that no other test reaches, run in process against the admin
// app.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { caCall } from '../src/cli-common.ts'
import { getLogger } from '../src/log.ts'
import { makeAdminEnv } from './support/admin-env.ts'
import { cliRunner } from './support/cli.ts'
import { captureLogs } from './support/logs.ts'
import { freePort } from './support/ports.ts'
import { tmpDir } from './support/tmp.ts'

test('an integer past 2^53 goes in and comes out as written', async (t) => {
  // The CLI is where user JSON comes in and goes out: a plain JSON.parse anywhere on the way,
  // reading the admin API's answers included, would round it
  const env = await makeAdminEnv(t)
  const cli = cliRunner({ fetch: env.fetch, cwd: tmpDir(t) })
  assert.equal(await cli.run('set', 'GET', '/a', '-d', '{"id": 12345678901234567890}'), 0)
  cli.takeOutput()

  assert.equal(await cli.run('export'), 0)
  assert.ok(cli.takeOutput().out.includes('"id": 12345678901234567890'))

  // Out to a file, gone from the server, and back in from the file
  assert.equal(await cli.run('export', '-o', 's.json'), 0)
  assert.equal(await cli.run('rm', 'GET', '/a'), 0)
  assert.equal(await cli.run('apply', 's.json'), 0)
  const rule = env.manager.getConfig().request_configs['GET:/a']
  assert.equal(JSON.stringify(rule?.json_response), '{"id":12345678901234567890}')
})

test("a JSON body's float is printed as JS writes it by requests show, recordings show and check, and an integer past 2^53 as written", async (t) => {
  // JSON.stringify writes 1.0 and 1e3 as 1 and 1000, as it does for --json and the files the CLI
  // writes. The integer comes out exactly as it went in
  const body = '{"v": 1.0, "e": 1e3, "big": 12345678901234567890}'
  const printed = '{\n  "v": 1,\n  "e": 1000,\n  "big": 12345678901234567890\n}'
  const env = await makeAdminEnv(t)
  const cli = cliRunner({ fetch: env.fetch, cwd: tmpDir(t) })
  assert.equal(await cli.run('record', 'start'), 0)
  await env.send({ method: 'POST', path: '/f', body: Buffer.from(body) })
  cli.takeOutput()

  assert.equal(await cli.run('requests', 'show', '1'), 0)
  assert.ok(cli.takeOutput().out.includes(`request body:\n${printed}\n`))
  assert.equal(await cli.run('recordings', 'show', '1'), 0)
  assert.ok(cli.takeOutput().out.includes(`request body:\n${printed}\n`))

  // check, through a proxy port that answers with that body
  const proxy = createServer((_request, response) => response.end(body))
  t.after(() => proxy.close())
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  const { port } = proxy.address() as AddressInfo
  const health = JSON.stringify({ proxy: { host: '127.0.0.1', port } })
  const checker = cliRunner({
    fetch: (url) => new Response(url.endsWith('/health') ? health : 'not used for http:'),
    cwd: tmpDir(t),
  })
  assert.equal(await checker.run('check', 'GET', 'http://h.test/x'), 0)
  assert.ok(checker.takeOutput().out.endsWith(`\n${printed}\n`))
})

test('check refuses a query parameter that has no =, as a user error', async (t) => {
  // Nothing listens on the proxy port named here: the refusal comes before the request is sent
  const health = JSON.stringify({ proxy: { host: '127.0.0.1', port: 9 } })
  const checker = cliRunner({
    fetch: (url) => new Response(url.endsWith('/health') ? health : 'not used'),
    cwd: tmpDir(t),
  })
  assert.equal(await checker.run('check', '-q', 'a=1', '-q', 'K', 'GET', 'http://h.test/x'), 1)
  assert.equal(checker.takeOutput().err, "error: query parameter 'K' has no '=': give it as K=V\n")
})

test('wait sets a client deadline only where AbortSignal.timeout can keep it', async (t) => {
  // The deadline is --timeout plus TIMEOUT_MS, rounded up. AbortSignal.timeout throws on one that
  // is negative, infinite or NaN, and past 2^31 - 1 ms it aborts within milliseconds or throws, so
  // outside 1 to 2^31 - 1 there is none and the admin API judges the timeout. The answer is the
  // admin API's when the wait runs out
  const seen: { timeout: string | null; signal: AbortSignal | null | undefined }[] = []
  const timedOut = (url: string, init?: RequestInit): Response => {
    seen.push({ timeout: new URL(url).searchParams.get('timeout'), signal: init?.signal })
    return new Response('{"seqs": [], "count": 0, "wanted": 1, "timed_out": true, "last_seq": 0}', {
      headers: { 'content-type': 'application/json' },
    })
  }
  const cli = cliRunner({ fetch: timedOut, cwd: tmpDir(t) })
  // 15000, 10001 and 9000 ms; then 3,000,010,000 ms, -10000 ms, and two that are no number
  const timeouts = ['5', '0.0001', '-1', '3000000', '-20', 'inf', 'nan']

  for (const timeout of timeouts) {
    assert.equal(await cli.run('wait', 'GET', '/a', '--timeout', timeout), 3, timeout)
  }

  assert.deepEqual(
    seen.map(({ timeout }) => timeout),
    ['5', '0.0001', '-1', '3000000', '-20', 'Infinity', 'NaN'],
  )
  assert.deepEqual(
    seen.map(({ signal }) => signal !== undefined),
    [true, true, true, false, false, false, false],
  )
})

test('recordings import follows a link to a file and does not go into a link to a directory', async (t) => {
  // A symlink to a file is read, and a symlink to a directory is not walked into, which
  // readdirSync({ recursive: true }) would do
  const env = await makeAdminEnv(t)
  const cwd = tmpDir(t)
  const cli = cliRunner({ fetch: env.fetch, cwd })
  assert.equal(await cli.run('record', 'start', '--session', 'acct_a'), 0)
  for (const path of ['/api/a', '/api/b', '/api/c', '/api/d']) await env.send({ path })
  assert.equal(await cli.run('recordings', 'export', '-o', 'tree'), 0)
  // d's file goes out of the tree and a link to it takes its place; so does c's directory
  const calls = join(cwd, 'tree', 'acct_a', 'api.example.com', 'GET', 'api')
  mkdirSync(join(cwd, 'outside'))
  renameSync(join(calls, 'd', '000004.json'), join(cwd, 'outside', 'd.json'))
  symlinkSync(join(cwd, 'outside', 'd.json'), join(calls, 'd', '000004.json'))
  renameSync(join(calls, 'c'), join(cwd, 'outside', 'c'))
  symlinkSync(join(cwd, 'outside', 'c'), join(calls, 'c'))
  assert.equal(await cli.run('recordings', 'rm'), 0)
  cli.takeOutput()

  assert.equal(await cli.run('recordings', 'import', 'tree'), 0)

  // a's and b's files, and the link to d's; not c's, under the linked directory
  assert.deepEqual(cli.takeOutput(), { out: 'Imported 3 recordings\n  acct_a: 3\n', err: '' })
  const { body } = await env.json('GET', '/__admin__/recordings')
  assert.deepEqual(
    body.recordings.map((row: { seq: number }) => row.seq),
    [1, 2, 4],
  )
})

test('a relative path is read from deps.cwd and printed without its ./, an -o as given', async (t) => {
  // Most sentences print the path as displayPath does, which drops a ./, and so does joinPath for
  // ./gone.js next to ./s.json; the -o of export and of pack is printed as it was given
  const env = await makeAdminEnv(t)
  const cwd = tmpDir(t)
  const cli = cliRunner({ fetch: env.fetch, cwd })
  writeFileSync(join(cwd, 'feed.json'), '{"v": 1}')
  writeFileSync(
    join(cwd, 's.json'),
    '{"mocks": [{"key": "GET:/b", "mode": "script", "script_file": "./gone.js"}]}',
  )

  assert.equal(await cli.run('set', 'GET', '/a', '-d', '@feed.json'), 0)
  assert.deepEqual(cli.takeOutput(), { out: 'Configured GET:/a  mode=json status=200\n', err: '' })

  assert.equal(await cli.run('set', 'GET', '/a', '-d', '@./nope.json'), 1)
  assert.deepEqual(cli.takeOutput(), { out: '', err: 'error: no such file: nope.json\n' })

  assert.equal(await cli.run('apply', './s.json'), 1)
  assert.deepEqual(cli.takeOutput(), { out: '', err: 'error: no such script file: gone.js\n' })

  assert.equal(await cli.run('export', '-o', './out/x.json'), 0)
  assert.deepEqual(cli.takeOutput(), { out: 'Exported 1 mocks to ./out/x.json\n', err: '' })
  assert.ok(existsSync(join(cwd, 'out', 'x.json')))

  assert.equal(await cli.run('pack', './out/x.json', '-o', './bundle/p.json'), 0)
  assert.deepEqual(cli.takeOutput(), { out: 'Packed 1 mocks to ./bundle/p.json\n', err: '' })
  assert.ok(existsSync(join(cwd, 'bundle', 'p.json')))
})

test("a path's .. is left to the system, so one after a directory that is not there fails", async (t) => {
  // sub/.. is kept, and the system call fails on the sub that is not there. A file written makes
  // the directories on its way, sub among them, as a recursive mkdirSync does
  const env = await makeAdminEnv(t)
  const cwd = tmpDir(t)
  const cli = cliRunner({ fetch: env.fetch, cwd })
  writeFileSync(join(cwd, 'body.json'), '{"v": 1}')
  writeFileSync(join(cwd, 'x.js'), 'function handler(ctx) {\n  return { ok: 1 }\n}\n')
  writeFileSync(join(cwd, 's.json'), '{"mocks": []}')
  writeFileSync(
    join(cwd, 's2.json'),
    '{"mocks": [{"key": "GET:/c", "json_file": "sub/../body.json"}]}',
  )
  writeFileSync(
    join(cwd, 's3.json'),
    '{"mocks": [{"key": "GET:/c", "mode": "script", "script_file": "sub/../x.js"}]}',
  )
  mkdirSync(join(cwd, 'rec'))

  await assert.rejects(cli.run('ca', 'export', '-o', './sub/../x.pem'), {
    code: 'ENOENT',
    syscall: 'open',
  })
  assert.ok(!existsSync(join(cwd, 'x.pem')))
  const refused: [string[], string][] = [
    [['set', 'GET', '/a', '-d', '@sub/../body.json'], 'no such file: sub/../body.json'],
    [['set', 'GET', '/a', '--script', 'sub/../x.js'], 'no such script file: sub/../x.js'],
    [['apply', 'sub/../s.json'], 'no such scenario file: sub/../s.json'],
    [['apply', 's2.json'], 'no such JSON file: sub/../body.json'],
    [['apply', 's3.json'], 'no such script file: sub/../x.js'],
    [['recordings', 'import', 'sub/../rec'], 'not a directory: sub/../rec'],
  ]
  for (const [argv, error] of refused) {
    assert.equal(await cli.run(...argv), 1, argv.join(' '))
    assert.deepEqual(cli.takeOutput(), { out: '', err: `error: ${error}\n` })
  }

  assert.equal(await cli.run('export', '-o', 'sub/../out.json'), 0)
  assert.deepEqual(cli.takeOutput(), { out: 'Exported 0 mocks to sub/../out.json\n', err: '' })
  assert.ok(existsSync(join(cwd, 'sub')) && existsSync(join(cwd, 'out.json')))
})

test("a path's .. after a symlink is taken from where the link points", async (t) => {
  // link/.. is elsewhere, not cwd: every one of these is read or written there
  const env = await makeAdminEnv(t)
  const cwd = tmpDir(t)
  const cli = cliRunner({ fetch: env.fetch, cwd })
  const elsewhere = join(cwd, 'elsewhere')
  mkdirSync(join(elsewhere, 'inner'), { recursive: true })
  writeFileSync(join(elsewhere, 'body.json'), '{"w": 2}')
  writeFileSync(
    join(elsewhere, 's.json'),
    '{"mocks": [{"key": "GET:/e", "mode": "json", "json_response": {"e": 1}}]}',
  )
  symlinkSync(join(elsewhere, 'inner'), join(cwd, 'link'))

  assert.equal(await cli.run('set', 'GET', '/b', '-d', '@link/../body.json'), 0)
  assert.equal(await cli.run('apply', 'link/../s.json'), 0)
  assert.equal(await cli.run('export', '-o', 'link/../out.json'), 0)
  assert.equal(await cli.run('ca', 'export', '-o', 'link/../ca.pem'), 0)
  assert.equal(await cli.run('record', 'start'), 0)
  await env.send({ path: '/a' })
  assert.equal(await cli.run('recordings', 'export', '-o', 'link/../rec'), 0)
  assert.equal(await cli.run('recordings', 'rm'), 0)
  cli.takeOutput()
  assert.equal(await cli.run('recordings', 'import', 'link/../rec'), 0)

  assert.deepEqual(cli.takeOutput(), { out: 'Imported 1 recordings\n  default: 1\n', err: '' })
  const rules = env.manager.getConfig().request_configs
  assert.deepEqual(
    [rules['GET:/b']?.json_response, rules['GET:/e']?.json_response],
    [{ w: 2 }, { e: 1 }],
  )
  for (const name of ['out.json', 'ca.pem', 'rec/default/api.example.com/GET/a/000001.json']) {
    assert.ok(existsSync(join(elsewhere, name)), name)
  }
  assert.deepEqual(readdirSync(cwd).sort(), ['elsewhere', 'link'])
})

test('init takes a .tunnel it cannot stat for no directory', async (t) => {
  // Whatever stat fails with, it is no directory, so what ends init is the mkdir after it, a stack
  // trace and 1. A link to itself is such a .tunnel: stat fails with ELOOP
  const cwd = tmpDir(t)
  symlinkSync(join(cwd, '.tunnel'), join(cwd, '.tunnel'))
  const cli = cliRunner({
    fetch: () => {
      throw new Error('init asked the admin API')
    },
    cwd,
  })

  await assert.rejects(cli.run('init'), { syscall: 'mkdir' })
})

test('recordings export and import print their directory without ./ or a trailing /', async (t) => {
  // The directory as displayPath prints it, rec for ./rec/ in what --json reports too, and gone for
  // ./gone/
  const env = await makeAdminEnv(t)
  const cli = cliRunner({ fetch: env.fetch, cwd: tmpDir(t) })

  assert.equal(await cli.run('--json', 'recordings', 'export', '-o', './rec/'), 0)
  assert.deepEqual(cli.takeOutput(), {
    out: '{\n  "exported": 0,\n  "directory": "rec"\n}\n',
    err: '',
  })

  assert.equal(await cli.run('recordings', 'import', './gone/'), 1)
  assert.deepEqual(cli.takeOutput(), { out: '', err: 'error: not a directory: gone\n' })
})

test('the ca commands log no info when no server answers', async (t) => {
  // The info the CA logs on making one in the config directory goes nowhere, and a warning or an
  // error still reaches stderr. caCall drops info for its offline half, and only for that
  const logs = captureLogs(t)
  const tmp = tmpDir(t)
  const closed = `http://127.0.0.1:${await freePort()}`
  const cli = cliRunner({
    fetch: globalThis.fetch,
    base: closed,
    env: { TUNNEL_CONFIG_DIR: join(tmp, 'config') },
    cwd: tmp,
  })

  // info makes the CA, reset makes another, and export reads it
  assert.equal(await cli.run('ca', 'info'), 0)
  assert.equal(await cli.run('ca', 'reset'), 0)
  assert.equal(await cli.run('ca', 'export'), 0)
  assert.deepEqual(logs.records, [])

  const log = getLogger('cli-edges')
  const offline = () => {
    log.info('dropped')
    log.warning('kept')
    log.error('kept too')
    return 'offline'
  }
  const online = () => Promise.resolve('online')
  assert.equal(await caCall(cli.deps, 'GET', `${closed}/ca.pem`, online, offline), 'offline')
  log.info('after')
  assert.deepEqual(
    logs.records.map(({ level, message }) => `${level}: ${message}`),
    ['warning: kept', 'error: kept too', 'info: after'],
  )
})

test('recordings import skips a recording with NaN or Infinity in it, with a warning, and imports the rest', async (t) => {
  // A file with NaN, Infinity or -Infinity in it is skipped with one warning, as the recordings
  // store skips it. A file that is no JSON, a NaN in it or not, still ends the import
  const logs = captureLogs(t)
  const env = await makeAdminEnv(t)
  const cwd = tmpDir(t)
  const cli = cliRunner({ fetch: env.fetch, cwd })
  const calls: [string, string][] = [
    ['a', '/one'],
    ['b', '/two'],
    ['b', '/three'],
    ['c', '/four'],
  ]
  for (const [session, path] of calls) {
    assert.equal(await cli.run('record', 'start', '--session', session), 0)
    await env.send({ path })
  }
  assert.equal(await cli.run('recordings', 'export', '-o', 'tree'), 0)
  assert.equal(await cli.run('recordings', 'rm'), 0)
  const replaceUpstream = (file: string, value: string) => {
    const path = join(cwd, 'tree', file)
    writeFileSync(path, readFileSync(path, 'utf8').replace(/"upstream": "[^"]*"/, value))
  }
  replaceUpstream('b/api.example.com/GET/two/000002.json', '"upstream": NaN')
  replaceUpstream('c/api.example.com/GET/four/000004.json', '"upstream": [Infinity, -Infinity]')
  mkdirSync(join(cwd, 'bad', 'd'), { recursive: true })
  writeFileSync(join(cwd, 'bad', 'd', 'x.json'), '{"upstream": NaN')
  cli.takeOutput()

  assert.equal(await cli.run('recordings', 'import', 'tree'), 0)
  assert.deepEqual(cli.takeOutput(), { out: 'Imported 2 recordings\n  a: 1\n  b: 1\n', err: '' })
  const { body } = await env.json('GET', '/__admin__/recordings')
  assert.deepEqual(
    body.recordings.map((row: { session: string; seq: number }) => `${row.session} ${row.seq}`),
    ['a 1', 'b 3'],
  )
  // The in-process server logs its info lines into the same capture
  const warnings = () => logs.records.filter((record) => record.level !== 'info')
  assert.deepEqual(
    warnings().map(({ level, message }) => [level, message.replace(/: .*/s, '')]),
    [
      ['warning', 'Skipping an unreadable recording tree/b/api.example.com/GET/two/000002.json'],
      ['warning', 'Skipping an unreadable recording tree/c/api.example.com/GET/four/000004.json'],
    ],
  )

  assert.equal(await cli.run('recordings', 'import', 'bad'), 1)
  assert.match(cli.takeOutput().err, /^error: bad\/d\/x\.json is not a recorded exchange: /)
  assert.equal(warnings().length, 2)
})
