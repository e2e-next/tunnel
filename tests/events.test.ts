// The event stream the panel's Monitor watches.
//
// `GET /__admin__/events` is Server-Sent Events over the same exchange log the
// admin API reads: what is already buffered when `since` asks for it, then every
// exchange as it is answered, with a `window` event in between saying which seqs
// the log still holds, which is also what keeps a quiet connection looking alive.
//
// The endpoint is driven here in process with app.request(), which hands the
// response back as soon as the handler returns it, its body still being written:
// a live stream never completes, so the body is read as it is sent, and the
// disconnect a browser makes by closing its tab is a cancel of that body.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { get, type IncomingMessage } from 'node:http'
import { performance } from 'node:perf_hooks'
import { test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { makeAdminEnv, startAdminEnv, type AdminEnv } from './support/admin-env.ts'

/** The payload of a frame: what follows its first `data:` */
const dataOf = (frame: string): any => JSON.parse(frame.slice(frame.indexOf('data:') + 5).trim())

/** One open connection to `/__admin__/events`, read frame by frame */
class EventStream {
  readonly status: number
  readonly contentType: string
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>
  /** Frames read and not yet taken, each with the blank line that ended it */
  readonly #frames: string[] = []
  /** What frame() is waiting on: called when a frame arrives or the stream ends */
  #wake: () => void = () => {}
  #ended = false
  #error: unknown
  readonly #reading: Promise<void>

  /** Opens the connection. It is closed when the test is over, if the test has not closed it */
  static async open(
    t: TestContext,
    env: AdminEnv,
    query = '',
    headers: Record<string, string> = {},
  ): Promise<EventStream> {
    const stream = new EventStream(await env.fetch('/__admin__/events?' + query, { headers }))
    t.after(() => stream.close())
    return stream
  }

  private constructor(response: Response) {
    this.status = response.status
    this.contentType = response.headers.get('content-type') ?? ''
    if (response.body === null) throw new Error('the event stream has no body')
    this.#reader = response.body.getReader()
    this.#reading = this.#read()
  }

  /** Reads the body as it is sent and cuts it into frames at the blank line that ends each one,
   *  rather than taking each chunk for a frame: Node 26 hands two writes over as one chunk */
  async #read(): Promise<void> {
    const decoder = new TextDecoder()
    let buffered = ''
    try {
      for (;;) {
        const { done, value } = await this.#reader.read()
        if (done) return
        buffered += decoder.decode(value, { stream: true })
        for (let end = buffered.indexOf('\n\n'); end !== -1; end = buffered.indexOf('\n\n')) {
          this.#frames.push(buffered.slice(0, end + 2))
          buffered = buffered.slice(end + 2)
        }
        this.#wake()
      }
    } catch (error) {
      this.#error = error
    } finally {
      this.#ended = true
      this.#wake()
    }
  }

  /** The next frame exactly as it was sent, windows and comments included */
  async frame(timeoutMs = 5000): Promise<string> {
    const deadline = performance.now() + timeoutMs
    while (this.#frames.length === 0) {
      if (this.#ended) throw new Error('the event stream ended', { cause: this.#error })
      const left = deadline - performance.now()
      if (left <= 0) throw new Error(`no frame arrived within ${timeoutMs} ms`)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left)
        this.#wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
    }
    return this.#frames.shift()!
  }

  /**
   * The next frame about an exchange, reading past the windows.
   *
   * A window is a different subject from a row and goes out on its own
   * occasions — on connect, on a clear, on a heartbeat — so a test that is
   * about rows reads past them. `frame()` is the stream as it was sent.
   */
  async chunk(timeoutMs = 5000): Promise<string> {
    for (;;) {
      const frame = await this.frame(timeoutMs)
      if (!frame.startsWith('event: window')) return frame
    }
  }

  /** The next `window` event's payload, reading past the rows */
  async window(timeoutMs = 5000): Promise<any> {
    for (;;) {
      const frame = await this.frame(timeoutMs)
      if (frame.startsWith('event: window')) return dataOf(frame)
    }
  }

  /** The next `data:` payload, skipping the comment lines */
  async event(timeoutMs = 5000): Promise<any> {
    for (;;) {
      const chunk = await this.chunk(timeoutMs)
      if (chunk.startsWith('data:') || chunk.includes('\ndata:')) return dataOf(chunk)
    }
  }

  /** Goes away, as a browser closing its tab does: the cancel reaches the handler, which lets go
   *  of the log; one turn of the event loop then lets its cleanup run */
  async close(): Promise<void> {
    await this.#reader.cancel()
    await this.#reading
    await delay(0)
  }
}

test('an exchange reaches the stream as it is answered', async (t) => {
  const env = await makeAdminEnv(t)
  const stream = await EventStream.open(t, env)
  await env.send({ method: 'POST', path: '/api/search', query: { page: '2' } })
  const event = await stream.event()
  await stream.close()

  assert.equal(stream.status, 200)
  assert.ok(stream.contentType.startsWith('text/event-stream'))
  assert.equal(event.seq, 1)
  assert.equal(event.key, 'POST:api.example.com/api/search')
  assert.equal(event.method, 'POST')
  assert.equal(event.host, 'api.example.com')
  assert.equal(event.path, '/api/search')
  assert.deepEqual(event.query, { page: '2' })
  assert.equal(event.status, 200)
  assert.ok(event.size > 0)
  // A row is a line in a list: the bodies are fetched per seq when one is opened
  assert.ok(!JSON.stringify(event).includes('body'))
})

test('since sends what is already buffered before going live', async (t) => {
  const env = await makeAdminEnv(t)
  for (let number = 0; number < 3; number++) await env.send({ path: `/api/${number}` })

  const stream = await EventStream.open(t, env, 'since=1')
  const backfilled = [await stream.event(), await stream.event()]
  await env.send({ path: '/api/live' })
  const events = [...backfilled, await stream.event()]
  await stream.close()

  assert.deepEqual(
    events.map((event) => event.seq),
    [2, 3, 4],
  )
  assert.deepEqual(
    events.map((event) => event.path),
    ['/api/1', '/api/2', '/api/live'],
  )
})

// The `id:` line is what EventSource hands back as Last-Event-ID.
//
// Without it a reconnect has nothing newer to offer than the `since` the
// first connection was opened with, and replays from there every time.
test('every frame is numbered so a browser can say where it stopped', async (t) => {
  const env = await makeAdminEnv(t)
  const stream = await EventStream.open(t, env)
  await env.send({ path: '/api/feed' })
  const frame = await stream.chunk()
  await stream.close()

  assert.ok(frame.startsWith('id: 1\ndata: '))
  // One event, terminated: SSE reads a frame when the blank line arrives
  assert.ok(frame.endsWith('\n\n'))
})

// EventSource sends this by itself, and it beats the `since` in the URL.
//
// The URL is the one the panel opened the first time; the header is the seq
// the browser actually saw last, so it is the newer of the two.
test('a reconnecting browser resumes from its last event id', async (t) => {
  const env = await makeAdminEnv(t)
  for (let number = 0; number < 3; number++) await env.send({ path: `/api/${number}` })

  const stream = await EventStream.open(t, env, 'since=0', { 'last-event-id': '2' })
  const event = await stream.event()
  await stream.close()

  assert.equal(event.seq, 3)
})

// A client holds rows of its own, and the server's oldest seq moves.
//
// Said on connect and not only when it next moves, because a panel that was
// open through somebody else's clear has nothing to trim against until then.
test('connecting says which seqs the log holds', async (t) => {
  const env = await makeAdminEnv(t)
  for (let number = 0; number < 3; number++) await env.send({ path: `/api/${number}` })

  const stream = await EventStream.open(t, env)
  const window = await stream.window()
  await stream.close()

  assert.deepEqual(window, { first_seq: 1, last_seq: 3 })
  assert.deepEqual(window, {
    first_seq: env.core.exchanges.firstSeq,
    last_seq: env.core.exchanges.lastSeq,
  })
})

// Somebody else's `tunnel reset --requests`, seen from an open panel.
//
// Empty is `first_seq == last_seq + 1` — the seq that would be handed out
// next — so a client dropping everything below it is left with nothing, and a
// clear needs no event type of its own.
test('a clear says so without waiting for the next beat', async (t) => {
  const env = await makeAdminEnv(t)
  for (let number = 0; number < 2; number++) await env.send({ path: `/api/${number}` })

  const stream = await EventStream.open(t, env)
  await stream.window()
  env.core.exchanges.clear()
  const window = await stream.window()
  await stream.close()

  assert.deepEqual(window, { first_seq: 3, last_seq: 2 })
  assert.equal(window.first_seq, window.last_seq + 1)
})

// The other way the oldest seq moves: the buffer filled up, nobody cleared.
//
// The correction rides along with the arrival that caused it, and only then —
// a window after every exchange would be most of the traffic on a busy
// stream, and the oldest seq holds still for all but one row in a thousand.
test('an arrival that pushes a row out says the window moved', async (t) => {
  const env = await makeAdminEnv(t)
  env.core.configManager.updateConfig({ max_requests_history: 2 })

  const stream = await EventStream.open(t, env)
  for (let number = 0; number < 3; number++) {
    // Two rows fit, so the third pushes the first one out
    await env.send({ path: `/api/${number}` })
  }
  const opening = await stream.window()
  const moved = await stream.window()
  await stream.close()

  assert.deepEqual(opening, { first_seq: 1, last_seq: 0 })
  assert.deepEqual(moved, { first_seq: 2, last_seq: 3 })
})

// `id:` is what EventSource hands back as Last-Event-ID when it reconnects.
//
// It has to stay the seq of the last exchange the client actually saw: an id
// on a window would have the browser ask to resume from a position that is
// not an exchange at all, and the header beats the `since` in the URL, so
// nothing downstream would correct it.
test('a window carries no id so a reconnect resumes at an exchange', async (t) => {
  const env = await makeAdminEnv(t)
  await env.send({ path: '/api/feed' })

  const stream = await EventStream.open(t, env)
  env.core.exchanges.clear()
  // The one the connection opens with, then the one the clear sends
  const frames = [await stream.frame(), await stream.frame()]
  await stream.close()

  assert.deepEqual(
    frames.map((frame) => frame.split('\n')[0]),
    ['event: window', 'event: window'],
  )
  assert.ok(!frames.join('').includes('id:'))
})

// The other half of the test above: the id still has to flow.
//
// A window sits in front of the first row, and that must not cost the row the
// `id:` a reconnect resumes from.
test('a row keeps its id with a window sent before it', async (t) => {
  const env = await makeAdminEnv(t)

  const stream = await EventStream.open(t, env)
  const opening = await stream.frame()
  await env.send({ path: '/api/feed' })
  const row = await stream.frame()
  await stream.close()

  assert.ok(opening.startsWith('event: window\ndata: '))
  assert.ok(row.startsWith('id: 1\ndata: '))
})

// The heartbeat is a window rather than a `: keep-alive` comment.
//
// It holds the connection open the way a comment would, and it carries
// something: a client that missed a window is corrected within a beat.
test('the stream says it is alive with a window', async (t) => {
  const env = await makeAdminEnv(t, { heartbeatMs: 50 })

  const stream = await EventStream.open(t, env)
  // The first is the one the connection opens with; the second can
  // only be the heartbeat, because nothing arrived in between.
  const opening = await stream.frame()
  const heartbeat = await stream.frame()
  await stream.close()

  assert.ok(opening.startsWith('event: window\ndata: '))
  assert.ok(heartbeat.startsWith('event: window\ndata: '))
})

// A panel left open in twenty tabs and closed again must not leak queues
test('a watcher that goes away is let go of', async (t) => {
  const env = await makeAdminEnv(t)

  const stream = await EventStream.open(t, env)
  const subscribed = env.core.exchanges.broadcaster.subscribers
  await stream.close()

  assert.equal(subscribed, 1)
  assert.equal(env.core.exchanges.broadcaster.subscribers, 0)
})

// ---------------------------------------------------------------- edge cases and the wire

// Only a seq beats the since in the URL: anything else in the header is no place to resume from,
// and the stream starts where it would without it
test('a non-numeric Last-Event-ID is ignored', async (t) => {
  const env = await makeAdminEnv(t)
  for (let number = 0; number < 3; number++) await env.send({ path: `/api/${number}` })

  const stream = await EventStream.open(t, env, 'since=1', { 'last-event-id': 'abc' })
  const backfilled = [await stream.event(), await stream.event()]
  await stream.close()

  assert.deepEqual(
    backfilled.map((event) => event.seq),
    [2, 3],
  )
})

// Hono answers a HEAD from the GET handler and throws the body away unread: a stream begun for
// one would be neither read nor cancelled, and would hold its subscription until the server closed
test('a HEAD on the event stream answers the headers alone and holds no subscription', async (t) => {
  const env = await makeAdminEnv(t)
  t.after(() => env.closing.abort())

  const answer = await env.fetch('/__admin__/events', { method: 'HEAD' })

  assert.equal(answer.status, 200)
  assert.equal(answer.headers.get('content-type'), 'text/event-stream; charset=utf-8')
  assert.equal(answer.body, null)
  assert.equal(env.core.exchanges.broadcaster.subscribers, 0)
})

// A stream can begin after close() has, on a connection kept alive through it, and gets what one
// open at the time gets: its window, then the end, terminator and all. An abort listener added to
// a signal already aborted is never called, so the stream would otherwise stay open until the
// connection was cut
test('a stream that begins once the server is closing sends its window and ends', async (t) => {
  const env = await makeAdminEnv(t)
  env.closing.abort()

  const stream = await EventStream.open(t, env)
  const opening = await stream.window()

  assert.deepEqual(opening, { first_seq: 1, last_seq: 0 })
  await assert.rejects(stream.frame(1000), /the event stream ended/)
  assert.equal(env.core.exchanges.broadcaster.subscribers, 0)
})

/** The frames arriving on a socket, cut as EventStream cuts them: a function that hands over the
 *  next one, waiting up to five seconds for it */
function framesOf(response: IncomingMessage): () => Promise<string> {
  const frames: string[] = []
  let buffered = ''
  response.setEncoding('utf8').on('data', (chunk: string) => {
    buffered += chunk
    for (let end = buffered.indexOf('\n\n'); end !== -1; end = buffered.indexOf('\n\n')) {
      frames.push(buffered.slice(0, end + 2))
      buffered = buffered.slice(end + 2)
    }
  })
  return async () => {
    const deadline = performance.now() + 5000
    while (frames.length === 0) {
      if (performance.now() > deadline) throw new Error('no frame arrived within 5000 ms')
      await delay(5)
    }
    return frames.shift()!
  }
}

// The stream as it leaves @hono/node-server, where the tests above read what app.request() hands
// back: the three headers as they are sent, every frame ended by its blank line however the
// writes are cut into chunks, and a connection that drops letting go of the log as a cancel does
test("the event stream's headers and frames on the wire", async (t) => {
  const env = await startAdminEnv(t)
  const [response] = (await once(get(`${env.base}/__admin__/events`), 'response')) as [
    IncomingMessage,
  ]
  const frame = framesOf(response)
  const opening = await frame()
  await env.send({ path: '/api/0' })
  await env.send({ path: '/api/1' })
  const rows = [await frame(), await frame()]
  const subscribed = env.core.exchanges.broadcaster.subscribers
  response.socket.destroy()
  const gone = performance.now() + 100
  while (env.core.exchanges.broadcaster.subscribers > 0 && performance.now() < gone) await delay(5)

  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['content-type'], 'text/event-stream; charset=utf-8')
  assert.equal(response.headers['cache-control'], 'no-cache')
  assert.equal(response.headers['x-accel-buffering'], 'no')
  assert.equal(opening, 'event: window\ndata: {"first_seq": 1, "last_seq": 0}\n\n')
  assert.deepEqual(
    rows.map((row) => [row.slice(0, row.indexOf('data:')), dataOf(row).path, row.endsWith('\n\n')]),
    [
      ['id: 1\n', '/api/0', true],
      ['id: 2\n', '/api/1', true],
    ],
  )
  assert.equal(subscribed, 1)
  assert.equal(env.core.exchanges.broadcaster.subscribers, 0)
})
