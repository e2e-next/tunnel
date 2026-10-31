// src/app.ts: the whole admin port as one Hono app, and the server it runs on, startAdminServer and
// its close(). The server's open real sockets on 127.0.0.1.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { Agent, get, type IncomingMessage } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { performance } from 'node:perf_hooks'
import { text } from 'node:stream/consumers'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { startAdminServer } from '../src/app.ts'
import { VERSION } from '../src/package-info.ts'
import { makeAdminEnv, startAdminEnv } from './support/admin-env.ts'
import { captureLogs } from './support/logs.ts'

/** Waits for condition() to hold, looking every few milliseconds, for up to a second */
async function until(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 1000
  while (!condition()) {
    if (performance.now() > deadline) throw new Error('still not so after a second')
    await delay(2)
  }
}

// Each app is handed its services and keeps none of its own, so two in one process never meet
test('deps are not shared between two apps', async (t) => {
  const first = await makeAdminEnv(t)
  const second = await makeAdminEnv(t)

  for (const env of [first, second]) {
    const health = (await env.json('GET', '/__admin__/health')).body
    assert.equal(health.config_dir, env.manager.paths.config_dir)
  }
  assert.notEqual(first.manager.paths.config_dir, second.manager.paths.config_dir)
})

// The loopback address and nothing else: the admin port edits scripts that run on this machine
// (AGENTS.md, "The two ports are bound on purpose"). A port somebody else holds is Node's own
// error, for the CLI to put into one line
test('the server binds the loopback address only and reports the port', async (t) => {
  const env = await startAdminEnv(t)
  const address = env.admin.server.address() as AddressInfo

  assert.equal(address.address, '127.0.0.1')
  assert.notEqual(env.admin.port, 0)
  assert.equal(env.admin.port, address.port)
  await assert.rejects(
    startAdminServer(
      { manager: env.manager, core: env.core, ca: env.ca },
      { port: env.admin.port },
    ),
    { code: 'EADDRINUSE' },
  )
})

// What is logged on the way up, after the CA was made sure of, and on the way down, after the core
// was closed
test('the startup line names the version, the three directories and the CA; close logs tunnel stopped', async (t) => {
  const logs = captureLogs(t)
  const env = await startAdminEnv(t)
  const { paths } = env.manager
  const started = logs.text()
  await env.admin.close()

  assert.ok(
    started.endsWith(
      `INFO:tunnel.app:tunnel ${VERSION} starting\n` +
        `  config: ${paths.config_dir}\n` +
        `  state:  ${paths.state_dir}\n` +
        `  data:   ${paths.data_dir}\n` +
        `  CA:     ${env.ca.fingerprint()}`,
    ),
    started,
  )
  assert.equal(logs.text(), `${started}\nINFO:tunnel.app:tunnel stopped`)
})

// What a shutdown finds open: the panel's event stream, a `tunnel wait` and a connection idle
// between two calls. The first two are told to end, so the panel sees its stream finish rather than
// break and the wait gets a sentence; the third is closed at once. The three are kept alive as a
// browser's and the CLI's are, and the first two are closed as soon as their answers are out, so
// close() is done well before the grace is up: server.close() alone closes only what is idle when
// it is called, and left these two to the grace. One test with its steps in order: on Node 24.2 a
// subtest's t.after is not awaited
test('close ends an event stream, answers a wait with 503 and drops an idle connection within the grace', async (t) => {
  const logs = captureLogs(t)
  const env = await startAdminEnv(t, { graceMs: 500 })
  const agent = new Agent({ keepAlive: true })
  t.after(() => agent.destroy())
  const subscribers = () => env.core.exchanges.broadcaster.subscribers

  // The event stream, left open once its opening window is in
  const [stream] = (await once(get(`${env.base}/__admin__/events`, { agent }), 'response')) as [
    IncomingMessage,
  ]
  let streamed = ''
  stream.setEncoding('utf8').on('data', (chunk: string) => (streamed += chunk))
  const streamEnded = once(stream, 'end')
  await until(() => streamed.includes('\n\n'))
  // A wait for a request that is not coming, left once it is listening for one
  const answered = (async () => {
    const wait = get(`${env.base}/__admin__/requests/wait?timeout=30`, { agent })
    const [answer] = (await once(wait, 'response')) as [IncomingMessage]
    return {
      status: answer.statusCode,
      contentType: answer.headers['content-type'],
      body: await text(answer),
    }
  })()
  await until(() => subscribers() === 2)
  // One call, after which its connection sits idle
  const [health] = (await once(get(`${env.base}/__admin__/health`, { agent }), 'response')) as [
    IncomingMessage,
  ]
  const idleClosed = once(health.socket, 'close')
  assert.equal(health.statusCode, 200)
  await text(health)

  const started = performance.now()
  const closed = env.admin.close()
  await closed
  const took = performance.now() - started

  // The stream ended with the chunked terminator, not with its connection cut
  await streamEnded
  assert.equal(stream.complete, true)
  assert.deepEqual(await answered, {
    status: 503,
    contentType: 'application/json',
    body: '{"detail":"The server is shutting down"}',
  })
  await idleClosed
  // Nothing was still being answered, so nothing had a use for the grace
  assert.ok(took < 500 / 2, `close() took ${took} ms`)
  // A second close() is the first one's promise, long resolved
  assert.equal(env.admin.close(), closed)
  assert.equal(env.admin.server.listening, false)
  assert.equal(subscribers(), 0)
  // Logged once the core has closed
  assert.ok(logs.text().endsWith('INFO:tunnel.app:tunnel stopped'), logs.text())
})

// What close() gives a request it finds still coming in, an import still being sent say: the grace,
// and then its connection is cut. Its connection is not idle, so neither server.close() nor the
// closing of each connection whose answer is out takes it early. A socket of its own, so that the
// request can stop halfway
test('close gives a request still coming in the grace, then cuts it', async (t) => {
  const env = await startAdminEnv(t, { graceMs: 300 })
  const socket = connect(env.admin.port, '127.0.0.1')
  t.after(() => socket.destroy())
  // Cut by the server: whether that comes as an end or a reset is not the point
  socket.on('error', () => {})
  let received = ''
  socket.setEncoding('utf8').on('data', (chunk: string) => (received += chunk))
  const cut = once(socket, 'close')
  await once(socket, 'connect')
  // The headers and the start of the body; the rest never comes
  socket.write(
    'PATCH /__admin__/config HTTP/1.1\r\nHost: 127.0.0.1\r\n' +
      'Content-Type: application/json\r\nContent-Length: 100\r\n\r\n{"session": ',
  )
  // Long enough for the server to have read it, on the loopback
  await delay(50)

  const started = performance.now()
  await env.admin.close()
  const took = performance.now() - started
  await cut

  assert.ok(took >= 300 - 10 && took < 300 + 200, `close() took ${took} ms`)
  assert.equal(received, '')
})
