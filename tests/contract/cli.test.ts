// Black-box tests of the tunnel command. They run it as a child process
// (tests/support/target.ts) and look only at its exit code and output. Each
// checks stderr first, so a failure shows what the command said.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { PACKAGE_ROOT } from '../../src/package-info.ts'
import { freePort } from '../support/ports.ts'
import { runTunnel, tunnelCommand } from '../support/target.ts'
import { tmpDir } from '../support/tmp.ts'

test('tunnel --version prints "tunnel X.Y.Z" and exits 0', async () => {
  const { code, stdout, stderr } = await runTunnel(['--version'])
  assert.equal(stderr, '')
  assert.equal(code, 0)
  // Only the format, not which version
  assert.match(stdout, /^tunnel \d+\.\d+\.\d+\n$/)
})

test('an unknown argument is a usage error: "tunnel: error:" on stderr, exit 1', async () => {
  const { code, stdout, stderr } = await runTunnel(['--no-such-flag'])
  // Only the prefix, not the sentence
  assert.match(stderr, /^tunnel: error: /m)
  // 1 rather than 2, which this command keeps for a server it cannot reach
  assert.equal(code, 1)
  assert.equal(stdout, '')
})

/** A line of tests/fixtures/cli-help/probes.jsonl: what the parser makes of argv */
interface Probe {
  argv: string[]
  exit?: number
  stdout?: string
  stderr?: string
}

// The golden lines tests/cli-args.test.ts holds the parser to as well
const probes: Probe[] = readFileSync(
  join(PACKAGE_ROOT, 'tests', 'fixtures', 'cli-help', 'probes.jsonl'),
  'utf8',
)
  .split('\n')
  .filter((line) => line !== '')
  .map((line) => JSON.parse(line) as Probe)

test("a usage error is the usage of the level that failed and the parser's sentence", async () => {
  for (const argv of [
    [], // "the following arguments are required: command"
    ['record'], // "… required: record_command", said by tunnel record
    ['set', 'GET', '/a', '--nonsense'], // "unrecognized arguments", said by the top level
    ['serve', '--p', '1'], // "ambiguous option"
    ['set', 'GET', '/a', '--status', '0x10'], // "invalid int value"
    ['ca', 'install', '--android', '--macos'], // "not allowed with argument --android"
  ]) {
    const expected = probes.find((probe) => JSON.stringify(probe.argv) === JSON.stringify(argv))
    assert.ok(expected?.stderr, `probes.jsonl has no usage error for ${JSON.stringify(argv)}`)
    // The width of the usage follows COLUMNS, which a developer's shell may have
    // set: 80 columns is what the fixture was written at
    const { code, stdout, stderr } = await runTunnel(argv, {
      env: { COLUMNS: '80', NO_COLOR: '1' },
      timeoutMs: 10_000,
    })
    assert.equal(stderr, expected.stderr, `tunnel ${argv.join(' ')}`)
    assert.equal(code, 1, `tunnel ${argv.join(' ')}`)
    assert.equal(stdout, '', `tunnel ${argv.join(' ')}`)
  }
})

test('a reader that leaves early does not turn into a stack trace', async () => {
  // The child process itself rather than runTunnel's result, to close its stdout
  const { command, args, env } = tunnelCommand(['agents'])
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  // Gone before the guide is written, as `tunnel agents | head -1` is soon after:
  // writing to stdout now fails with EPIPE
  child.stdout.destroy()
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`tunnel agents did not finish within 10000 ms\nstderr: ${stderr}`))
    }, 10_000)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (exitCode) => {
      clearTimeout(timer)
      resolve(exitCode)
    })
  })
  assert.equal(stderr, '')
  assert.equal(code, 0)
})

test('status and stop say so when nothing was started', async (t) => {
  // A directory of its own, with no tunnel.pid in it
  const env = { TUNNEL_CONFIG_DIR: tmpDir(t) }
  for (const command of ['status', 'stop']) {
    const { code, stderr } = await runTunnel([command], { env, timeoutMs: 10_000 })
    assert.ok(stderr.includes('does not exist'), `tunnel ${command}: ${stderr}`)
    assert.equal(code, 1, `tunnel ${command}`)
  }
})

test('serve --background leaves the same pid file on both, and status and stop read it [slow]', async (t) => {
  let pidFile: string | undefined
  // Before tmpDir(t), since after hooks run in the order they were added: a server this test
  // leaves running, having failed before its stop, is killed before its directory goes
  t.after(() => {
    let record: { pid: number }
    try {
      record = JSON.parse(readFileSync(pidFile!, 'utf8')) as { pid: number }
    } catch {
      // No record, so nothing left running
      return
    }
    try {
      process.kill(record.pid, 'SIGKILL')
    } catch {
      // Gone already
    }
  })
  const dir = tmpDir(t)
  pidFile = join(dir, 'tunnel.pid')
  const env = { TUNNEL_CONFIG_DIR: dir }
  const adminPort = await freePort()

  // The command waits up to 30 s for the server to answer before it gives up
  const started = await runTunnel(
    [
      'serve',
      '--background',
      '--admin-port',
      String(adminPort),
      '--proxy-port',
      '0',
      '--proxy-host',
      '127.0.0.1',
    ],
    { env, timeoutMs: 45_000 },
  )
  assert.equal(started.code, 0, started.stderr)
  const written = readFileSync(pidFile, 'utf8')
  // One line of JSON, with ', ' and ': ' between its parts
  assert.match(written, /^\{"pid": \d+, "admin_port": \d+, "proxy_port": \d+\}\n$/)
  const record = JSON.parse(written) as { pid: number; admin_port: number }
  assert.equal(record.admin_port, adminPort)

  const status = await runTunnel(['status'], { env, timeoutMs: 10_000 })
  assert.equal(status.code, 0, status.stderr)
  assert.ok(status.stdout.includes(`tunnel is running, pid ${record.pid}`), status.stdout)

  // The way out for what the server does not answer itself: direct, since tunnelCommand hands
  // the server no_proxy=*. The rest of the line is UpstreamRoutes.describe()'s wording, and not
  // compared
  for (const output of [started.stdout, status.stdout]) {
    const lines = output.split('\n')
    assert.ok(
      lines.some((line) => line.startsWith('  upstream: direct')),
      output,
    )
  }

  // It waits up to 10 s for the server to go
  const stopped = await runTunnel(['stop'], { env, timeoutMs: 30_000 })
  assert.equal(stopped.code, 0, stopped.stderr)
  assert.ok(stopped.stdout.includes('Stopped tunnel'), stopped.stdout)
  assert.ok(!existsSync(pidFile))
})
