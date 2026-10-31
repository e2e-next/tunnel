// `serve --background`, `status` and `stop`: a server that outlives the command.
//
// These are the tests that start a real second Node process, and those are marked
// slow, their titles ending in " [slow]": the child signs a CA before it listens.
// Everything they touch is a temporary directory and a loopback port the operating
// system handed out, and the child is killed in teardown whatever the test made of
// it. The checks that need no child are left unmarked, so `npm run test:fast`,
// which skips the slow ones, still runs them.
//
// The child runs src/cli.ts itself, the entry main() hands `serve --background`,
// so what it runs is the source under test, with nothing to build first.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { type AddressInfo, connect, createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'
import { setImmediate as nextTurn, setTimeout as sleep } from 'node:timers/promises'
import { defaultBase, processAlive, readPidFile } from '../src/cli-common.ts'
import { logTail } from '../src/cli-server.ts'
import { main } from '../src/cli.ts'
import { Paths } from '../src/config.ts'
import { captureIo } from './support/cli.ts'
import { freePort } from './support/ports.ts'
import { tmpDir } from './support/tmp.ts'

/** Waits for the child to be gone for good. Node collects its own children, so there is no
 *  waitpid here: a child is gone once signal 0 no longer finds its pid */
async function reaped(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (!processAlive(pid)) return true
    await sleep(100)
  }
  return false
}

/**
 * A directory of its own for the child, and no stray process left behind. The environment is
 * this process's, which the child inherits, with TUNNEL_CONFIG_DIR set to that directory and
 * TUNNEL_BASE taken out, since one in the developer's shell would decide where defaultBase()
 * looks. fetch and run are main()'s own, the real ones.
 */
function background(t: TestContext) {
  let paths: Paths | undefined
  // Before tmpDir(t): after hooks run in the order they were added, and the server goes before
  // its directory does. Never this process, whose pid the stale-record test writes into the
  // record: had that test failed, the kill would take the test run with it and hide the result
  t.after(async () => {
    const record = paths && readPidFile(paths)
    if (record && record.pid !== process.pid) {
      try {
        process.kill(record.pid, 'SIGKILL')
      } catch {
        // Gone already
      }
      await reaped(record.pid)
    }
  })
  const dir = tmpDir(t)
  paths = Paths.inOneDirectory(dir)
  const env: Record<string, string | undefined> = { ...process.env, TUNNEL_CONFIG_DIR: dir }
  delete env.TUNNEL_BASE
  const io = captureIo()
  const deps = { env, cwd: dir }
  return { dir, paths, io, deps, run: (...argv: string[]) => main(argv, io, deps) }
}

/** A port that is taken: something listens on 127.0.0.1 and answers nothing, so that a health
 *  check there waits out its 2 s. release() closes it, and whatever connected to it */
async function takePort(): Promise<{ port: number; release: () => Promise<void> }> {
  const held = new Set<Socket>()
  const server = createServer((socket) => {
    // Held open and never answered; a client that gives up may reset it
    socket.on('error', () => {})
    held.add(socket)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    port: (server.address() as AddressInfo).port,
    release: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        for (const socket of held) socket.destroy()
      }),
  }
}

/** How many listening TCP servers this process holds */
function listeners(): number {
  return process.getActiveResourcesInfo().filter((name) => name === 'TCPServerWrap').length
}

/** A line of a stack trace: what a CliError must never come with */
const STACK_FRAME = /^\s+at /m

test('a background server starts, reports itself and stops [slow]', async (t) => {
  const { paths, io, deps, run } = background(t)
  const adminPort = await freePort()

  assert.equal(
    await run(
      'serve',
      '--background',
      '--admin-port',
      String(adminPort),
      // A port of 0 is the operating system's to pick, which is what the pid file has to end up
      // holding.
      '--proxy-port',
      '0',
      '--proxy-host',
      '127.0.0.1',
    ),
    0,
  )
  const started = io.takeOutput().out

  const written = readFileSync(paths.pidFile, 'utf8')
  // The record byte for byte, as stringifySpaced writes it
  assert.match(written, /^\{"pid": \d+, "admin_port": \d+, "proxy_port": \d+\}\n$/)
  const record = JSON.parse(written) as { pid: number; admin_port: number; proxy_port: number }
  assert.equal(record.admin_port, adminPort)
  assert.ok(![0, null].includes(record.proxy_port), String(record.proxy_port))
  assert.ok(processAlive(record.pid))
  assert.ok(started.includes(`pid ${record.pid}`), started)
  assert.ok(started.includes(`127.0.0.1:${record.proxy_port}`), started)
  // Whatever the child printed is in the state directory, not on this terminal
  const log = readFileSync(paths.logFile, 'utf8')
  assert.ok(log.includes('tunnel'), log)
  // The child runs src/cli.ts, and type stripping's warning is left out of the log
  assert.ok(!log.includes('ExperimentalWarning'), log)

  assert.equal(await run('status'), 0)
  const status = io.takeOutput().out
  assert.ok(status.includes(`tunnel is running, pid ${record.pid}`), status)
  assert.ok(status.includes(paths.config_dir), status)
  // Which recordings this run replays, since that is what a test run switches
  assert.ok(status.includes('session: default'), status)

  // Starting a second one on that port would leave a pid file describing a child that died of the
  // port while the first server answered for it
  assert.equal(
    await run(
      'serve',
      '--background',
      '--admin-port',
      String(adminPort),
      '--proxy-port',
      '0',
      '--proxy-host',
      '127.0.0.1',
    ),
    1,
  )
  assert.ok(io.takeOutput().err.includes('already answering'))

  // The admin port is found through the pid file: no --base, no TUNNEL_BASE
  assert.equal(defaultBase(deps), `http://127.0.0.1:${adminPort}`)
  assert.equal(await run('ls'), 0)
  assert.ok(io.takeOutput().out.includes(paths.data_dir))

  assert.equal(await run('stop'), 0)
  assert.ok(io.takeOutput().out.includes('Stopped tunnel'))
  assert.ok(await reaped(record.pid))
  assert.ok(!existsSync(paths.pidFile))
})

test('status and stop say so when nothing was started', async (t) => {
  const { io, run } = background(t)
  assert.equal(await run('status'), 1)
  assert.equal(await run('stop'), 1)
  assert.equal(io.takeOutput().err.split('does not exist').length - 1, 2)
})

test('a port already taken is one line and no stack trace [slow]', async (t) => {
  const { paths, io, run } = background(t)
  const taken = await takePort()
  try {
    assert.equal(
      await run(
        'serve',
        '--background',
        '--admin-port',
        String(taken.port),
        '--proxy-port',
        '0',
        '--proxy-host',
        '127.0.0.1',
      ),
      1,
    )
  } finally {
    await taken.release()
  }

  const error = io.takeOutput().err
  assert.ok(error.includes('the server stopped at once'), error)
  assert.ok(error.toLowerCase().includes('address already in use'), error)
  assert.doesNotMatch(error, STACK_FRAME)
  assert.ok(!existsSync(paths.pidFile))
})

test('a foreground serve on a taken admin port exits one', async (t) => {
  // In process: the serve fails before it sets up its signal handlers. The proxy port is up by
  // then, since it is started first, so this also holds that what was started is closed again,
  // the proxy port and the core: a handle left open would hold this test file's process rather
  // than fail a test
  const { dir, io, run } = background(t)
  const taken = await takePort()
  try {
    const before = listeners()
    assert.equal(
      await run(
        'serve',
        '--admin-port',
        String(taken.port),
        '--proxy-port',
        '0',
        '--proxy-host',
        '127.0.0.1',
        '--config-dir',
        dir,
      ),
      1,
    )
    // A server closed leaves the list a turn or two after its close() has called back
    const deadline = performance.now() + 1000
    while (listeners() !== before && performance.now() < deadline) await nextTurn()
    assert.equal(listeners(), before)
  } finally {
    await taken.release()
  }

  const error = io.takeOutput().err
  assert.ok(error.includes('could not listen on the admin port'), error)
  assert.ok(!error.includes('Traceback'), error)
  assert.doesNotMatch(error, STACK_FRAME)
})

test('the proxy port being taken is one line too [slow]', async (t) => {
  // The other half of "no traceback": the port a device connects to
  const { paths, io, run } = background(t)
  const taken = await takePort()
  try {
    assert.equal(
      await run(
        'serve',
        '--background',
        '--admin-port',
        String(await freePort()),
        '--proxy-port',
        String(taken.port),
        '--proxy-host',
        '127.0.0.1',
      ),
      1,
    )
  } finally {
    await taken.release()
  }

  const error = io.takeOutput().err
  assert.ok(error.includes('could not listen on the proxy port'), error)
  assert.ok(!error.includes('Traceback'), error)
  assert.doesNotMatch(error, STACK_FRAME)
  assert.ok(!existsSync(paths.pidFile))
})

test('stop ends a server that is still holding a connection [slow]', async (t) => {
  // The panel holds an event stream open, and `stop` has to end the process anyway.
  //
  // Without a bound on how long the admin server waits for the connections it is already
  // holding, SIGTERM only closes the listening socket: health stops answering while the process
  // runs on, still holding the proxy port, and `stop` would report it stopped and throw away the
  // only record of its pid.
  const { paths, io, run } = background(t)
  const adminPort = await freePort()

  assert.equal(
    await run(
      'serve',
      '--background',
      '--admin-port',
      String(adminPort),
      '--proxy-port',
      '0',
      '--proxy-host',
      '127.0.0.1',
    ),
    0,
  )
  io.takeOutput()
  const record = JSON.parse(readFileSync(paths.pidFile, 'utf8')) as { pid: number }

  const watcher = connect(adminPort, '127.0.0.1')
  // The server hangs up on it as it stops
  watcher.on('error', () => {})
  try {
    await once(watcher, 'connect')
    watcher.write(
      'GET /__admin__/events HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n\r\n',
    )
    // Read enough to know the stream is running, not merely requested
    const [first] = (await once(watcher, 'data')) as [Buffer]
    assert.ok(first.subarray(0, 64).includes('200'), first.toString())

    assert.equal(await run('stop'), 0)
    assert.ok(io.takeOutput().out.includes('Stopped tunnel'))
    // The claim `stop` just made, checked against the process itself
    assert.ok(await reaped(record.pid))
    assert.ok(!existsSync(paths.pidFile))
  } finally {
    watcher.destroy()
  }
})

test('a stale record is cleared without signalling its pid', async (t) => {
  // A pid outlives the server it belonged to, and is handed out again
  const { paths, io, run } = background(t)
  paths.create()
  // This very process: alive, and nothing of tunnel's answering for it
  writeFileSync(
    paths.pidFile,
    `${JSON.stringify({ pid: process.pid, admin_port: await freePort() })}\n`,
  )

  const signalled: boolean[] = []
  const spy = (): void => void signalled.push(true)
  process.on('SIGTERM', spy)
  t.after(() => void process.off('SIGTERM', spy))
  assert.equal(await run('stop'), 0)
  // A signal reaches its listener on a later turn of the event loop: one sent by mistake is given
  // the time to arrive
  await sleep(100)

  assert.deepEqual(signalled, [])
  assert.ok(io.takeOutput().out.includes('without signalling'))
  assert.ok(!existsSync(paths.pidFile))
})

test('only what this start wrote says why it is not up', (t) => {
  // The log is kept across starts; an old complaint is not this one's reason
  const log = join(tmpDir(t), 'tunnel.log')
  writeFileSync(
    log,
    'ERROR:    a bind that failed an hour ago\nINFO:     Finished server process\n',
  )
  const offset = statSync(log).size
  appendFileSync(log, 'could not listen on the proxy port 127.0.0.1:8888\n')

  const tail = logTail(log, offset)

  assert.ok(tail.includes('proxy port'), tail)
  assert.ok(!tail.includes('an hour ago'), tail)
})
