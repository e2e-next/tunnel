// `GET /__admin__/requests/wait`: what a test case blocks on instead of sleeping.
//
// The endpoint holds its connection open until enough matching requests have been
// answered, so the tests here have to make traffic happen while a request is in
// flight. The application is driven in process with app.request(), and the traffic
// that wakes the wait is set off on a timer before the wait is made, to arrive while
// it is held open: in a real run it comes from the client being tested, somewhere
// else entirely, and here the timer's turn of the event loop stands in for it.
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { makeAdminEnv, type AdminEnv, type Params } from './support/admin-env.ts'

/** `tunnel wait`, as the HTTP call it is */
const wait = (env: AdminEnv, params: Params) =>
  env.client.get('/__admin__/requests/wait', { params })

// The point of the endpoint: no polling, and no sleep long enough to be safe
test('a request made while waiting wakes the wait', async (t) => {
  const env = await makeAdminEnv(t)
  const clientUnderTest = async () => {
    await delay(100)
    // The traffic is answered on the loop that is holding the wait open,
    // which is what a request arriving over the proxy port does too.
    await env.send({ method: 'POST', path: '/api/pay' })
  }

  const later = clientUnderTest()
  const started = performance.now()
  const answer = await wait(env, { key: 'POST:/api/pay', timeout: 10 })
  const waited = performance.now() - started
  await later

  assert.equal(answer.status, 200)
  assert.deepEqual(answer.json(), {
    seqs: [1],
    count: 1,
    wanted: 1,
    timed_out: false,
    last_seq: 1,
  })
  // Woken by the request rather than by the deadline
  assert.ok(waited < 5000)
})

test('what already arrived counts and comes back at once', async (t) => {
  const env = await makeAdminEnv(t)
  await env.send({ method: 'POST', path: '/api/pay' })
  await env.send({ method: 'POST', path: '/api/pay' })

  const answer = await wait(env, { key: 'POST:/api/pay', count: 2, timeout: 10 })

  assert.deepEqual(answer.json().seqs, [1, 2])
})

test('waiting for more than arrives times out and says how many', async (t) => {
  const env = await makeAdminEnv(t)
  await env.send({ method: 'POST', path: '/api/pay' })

  const answer = (await wait(env, { key: 'POST:/api/pay', count: 2, timeout: 0.2 })).json()

  // An answer, not an error: the count seen so far is what a caller asserts on
  assert.equal(answer.timed_out, true)
  assert.deepEqual([answer.count, answer.wanted], [1, 2])
  assert.deepEqual(answer.seqs, [1])
})

test('only the requests the key names count', async (t) => {
  const env = await makeAdminEnv(t)
  await env.send({ method: 'GET', path: '/api/feed' })
  await env.send({ method: 'POST', path: '/api/pay', host: 'other.example.com' })

  const answer = await wait(env, { key: 'POST:api.example.com/api/pay', timeout: 0.2 })

  assert.deepEqual(answer.json(), {
    seqs: [],
    count: 0,
    wanted: 1,
    timed_out: true,
    last_seq: 2,
  })
})

test('since ignores what was there before', async (t) => {
  const env = await makeAdminEnv(t)
  await env.send({ method: 'POST', path: '/api/pay' })

  const answer = await wait(env, { key: 'POST:/api/pay', since: 1, timeout: 0.2 })

  assert.equal(answer.json().timed_out, true)
})

test('a query filter counts only the call that carried it', async (t) => {
  const env = await makeAdminEnv(t)
  await env.send({ method: 'POST', path: '/api/pay', query: { amount: '10' } })
  await env.send({ method: 'POST', path: '/api/pay', query: { amount: '99', from: 'a' } })

  const answer = await wait(env, { key: 'POST:/api/pay', q: ['amount=99'], timeout: 10 })

  // Every pair given has to be the one in the query; the rest of the query is
  // free, since a client adds tokens and page sizes of its own.
  assert.deepEqual(answer.json().seqs, [2])
})

test('a filter that is not a pair is refused', async (t) => {
  const env = await makeAdminEnv(t)

  const answer = await wait(env, { key: 'POST:/api/pay', q: ['amount'], timeout: 0 })

  assert.equal(answer.status, 400)
  assert.ok(answer.json().detail.includes('name=value'))
})

// Every wait subscribes to the log; twenty test cases must not leave twenty
test('a wait that ends lets go of the log', async (t) => {
  const env = await makeAdminEnv(t)

  await wait(env, { key: 'POST:/api/pay', timeout: 0 })

  assert.equal(env.core.exchanges.broadcaster.subscribers, 0)
})

// Somebody emptying the log must not make a wait say the request came.
//
// A clear goes onto the same queue the arrivals do, so it wakes the wait — the
// guard is that what matched is counted from the log rather than taken from
// the queue, which leaves the wake with nothing to report. Without that, a
// `tunnel reset --requests` from another terminal would hand a passing answer
// to a test case whose request never happened.
test('a clear does not count as an arrival', async (t) => {
  const env = await makeAdminEnv(t)
  await env.send({ method: 'GET', path: '/api/feed' })
  const somebodyElse = async () => {
    await delay(150)
    // Cleared on the loop that is holding the wait open, the way the
    // admin port does it while a wait is in flight.
    env.core.exchanges.clear()
  }

  const later = somebodyElse()
  const started = performance.now()
  const answer = await wait(env, { key: 'POST:/api/pay', timeout: 0.6 })
  const waited = performance.now() - started
  await later

  assert.equal(answer.json().timed_out, true)
  assert.equal(answer.json().count, 0)
  // Ended on its own deadline rather than when the clear woke it at 0.15s
  assert.ok(waited >= 500)
})

// Absorbing the clear must not cost the wait the arrival that follows it
test('a request after a clear still wakes the wait', async (t) => {
  const env = await makeAdminEnv(t)
  await env.send({ method: 'POST', path: '/api/pay' })
  const clientUnderTest = async () => {
    await delay(100)
    env.core.exchanges.clear()
    await delay(100)
    await env.send({ method: 'POST', path: '/api/pay' })
  }

  const later = clientUnderTest()
  const started = performance.now()
  // `since` so that the call already in the log is not the answer
  const answer = await wait(env, { key: 'POST:/api/pay', since: 1, timeout: 10 })
  const waited = performance.now() - started
  await later

  // Seq 1 was cleared away; seq 2 arrived afterwards and is what matched
  assert.deepEqual(answer.json(), {
    seqs: [2],
    count: 1,
    wanted: 1,
    timed_out: false,
    last_seq: 2,
  })
  assert.ok(waited < 5000)
})

// ---------------------------------------------------------------- edge cases

// Hono's query() would give the first
test('the last of a repeated query parameter wins', async (t) => {
  const env = await makeAdminEnv(t)

  const answer = await wait(env, { count: ['1', '2'], timeout: 0 })

  assert.deepEqual(answer.json(), {
    seqs: [],
    count: 0,
    wanted: 2,
    timed_out: true,
    last_seq: 0,
  })
})

test('a wait whose client goes away is let go of', async (t) => {
  const env = await makeAdminEnv(t)
  const client = new AbortController()
  const started = performance.now()

  const answer = env.fetch('/__admin__/requests/wait?timeout=30', { signal: client.signal })
  await delay(0)
  assert.equal(env.core.exchanges.broadcaster.subscribers, 1)
  client.abort()
  await answer

  assert.equal(env.core.exchanges.broadcaster.subscribers, 0)
  assert.ok(performance.now() - started < 1000)
})

// A wait can come in after close() has begun, on a connection kept alive through it. It is told
// the server is going, as one held open at the time is, rather than held to its deadline: an abort
// listener added to a signal already aborted is never called
test('a wait that comes in once the server is closing answers 503 at once', async (t) => {
  const env = await makeAdminEnv(t)
  env.closing.abort()
  const started = performance.now()

  const answer = await wait(env, { timeout: 5 })

  assert.equal(answer.status, 503)
  assert.deepEqual(answer.json(), { detail: 'The server is shutting down' })
  assert.ok(performance.now() - started < 1000)
  assert.equal(env.core.exchanges.broadcaster.subscribers, 0)
})

// The same for a client gone before its wait began: there is nobody to hold it open for
test('a wait whose client is gone before it begins is let go of at once', async (t) => {
  const env = await makeAdminEnv(t)
  const started = performance.now()

  await env.fetch('/__admin__/requests/wait?timeout=5', { signal: AbortSignal.abort() })

  assert.ok(performance.now() - started < 1000)
  assert.equal(env.core.exchanges.broadcaster.subscribers, 0)
})

// The timeout takes inf and nan, which validate.ts's float refuses: nan is not at least 0, nor is
// -inf, so both are refused as -1 is, and inf is a wait with no end but the arrival. A NaN must
// never reach the loop: the time left would be NaN, which is never at most 0, and the wait would go
// round and round
test('a timeout of nan, -inf or -1 is refused, and one of inf waits', async (t) => {
  const env = await makeAdminEnv(t)
  const atLeastZero = (input: string) => ({
    type: 'greater_than_equal',
    loc: ['query', 'timeout'],
    msg: 'Input should be greater than or equal to 0',
    input,
    ctx: { ge: 0 },
  })
  const refused = {
    nan: atLeastZero('nan'),
    '-inf': atLeastZero('-inf'),
    '-1': atLeastZero('-1'),
    abc: {
      type: 'float_parsing',
      loc: ['query', 'timeout'],
      msg: 'Input should be a valid number, unable to parse string as a number',
      input: 'abc',
    },
  }
  for (const [timeout, issue] of Object.entries(refused)) {
    const answer = await wait(env, { timeout })
    assert.equal(answer.status, 422, timeout)
    assert.deepEqual(answer.json(), { detail: [issue] }, timeout)
  }

  const clientUnderTest = async () => {
    await delay(100)
    await env.send({ method: 'POST', path: '/api/pay' })
  }
  const later = clientUnderTest()
  const answer = await wait(env, { key: 'POST:/api/pay', timeout: 'inf' })
  await later

  // Held open until the request came, rather than refused or given up on at once
  assert.deepEqual(answer.json(), {
    seqs: [1],
    count: 1,
    wanted: 1,
    timed_out: false,
    last_seq: 1,
  })
})

// A timer longer than 2^31 - 1 ms fires after 1 ms instead, with a TimeoutOverflowWarning, and a
// wait given one would go round its loop once a millisecond: a timeout that long is held to 24.8
// days, and the arrival is what ends this one
test('a timeout longer than a timer can hold waits without a warning', async (t) => {
  const env = await makeAdminEnv(t)
  const overflows: Error[] = []
  const onWarning = (warning: Error) => {
    if (warning.name === 'TimeoutOverflowWarning') overflows.push(warning)
  }
  process.on('warning', onWarning)
  t.after(() => process.off('warning', onWarning))
  const clientUnderTest = async () => {
    await delay(100)
    await env.send({ method: 'POST', path: '/api/pay' })
  }

  const later = clientUnderTest()
  const answer = await wait(env, { key: 'POST:/api/pay', timeout: '1e12' })
  await later
  // A warning is emitted on the next tick
  await delay(0)

  assert.equal(answer.json().timed_out, false)
  assert.deepEqual(overflows, [])
})
