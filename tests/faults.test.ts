// Faults: an endpoint going wrong on purpose.
//
// Asked of the core, which is where the three of them are decided — the dropped
// connection is asked of the proxy port as well, in proxy.test.ts, because a
// client only meets it as a socket that closed.
//
// `response_delay` is here too, though it is not a fault: it is the core's other
// wait on a caller, it is cut short the same way, and one rule can hold both.
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { test, type TestContext } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { Paths, TunnelConfigManager } from '../src/config.ts'
import { GARBAGE_BODY, TunnelCore, type TunnelCoreOptions } from '../src/core.ts'
import { exchangeKey } from '../src/exchanges.ts'
import { parseJson, type JsonValue } from '../src/json.ts'
import { makeRequest, type Request, type Response } from '../src/messages.ts'
import type { TunnelRequestConfig } from '../src/models.ts'
import { UpstreamError, type UpstreamClient } from '../src/upstream.ts'
import { fakeUpstream, jsonAnswer } from './support/fake-upstream.ts'
import { captureLogs } from './support/logs.ts'
import { tmpDir } from './support/tmp.ts'

/** A core over a config in a temporary directory. Nothing here passes through, so the core
 *  needs no stand-in upstream unless a test gives it one in `options` */
function env(t: TestContext, options?: TunnelCoreOptions) {
  // Registered before tmpDir(t): node:test runs after hooks in registration order, and the core's
  // log and store flush asynchronously into that directory
  let core: TunnelCore | undefined
  t.after(() => core?.close())
  const manager = new TunnelConfigManager(Paths.inOneDirectory(tmpDir(t)))
  core = new TunnelCore(manager, options)
  return { core, manager }
}

const FEED = { method: 'GET', host: 'api.example.com', path: '/api/feed' } as const

/** Ask the core one question, GET api.example.com/api/feed unless told otherwise */
const answer = (core: TunnelCore, fields: Partial<Request> = {}) =>
  core.resolve(makeRequest({ ...FEED, ...fields }))

/** One request whose caller gives up a tenth of a second in.
 *
 *  The proxy port fills `gave_up` in with a look at a real socket; a flag flipped from the test
 *  asks the core the same question without needing one. */
async function answerWhileTheCallerLeaves(
  core: TunnelCore,
  fields: Partial<Request> = {},
): Promise<Response> {
  let left = false
  const answering = core.resolve(makeRequest({ ...FEED, gave_up: () => left, ...fields }))
  await sleep(100)
  left = true
  return answering
}

const configure = (
  manager: TunnelConfigManager,
  fields: Partial<Omit<TunnelRequestConfig, 'request_key'>>,
) =>
  manager.updateRequestConfig('GET:/api/feed', {
    mode: 'json',
    json_response: { cards: [] },
    ...fields,
  })

const payload = (response: Response): JsonValue => parseJson(response.body.toString('utf8'))

const detail = (response: Response): string => (payload(response) as { detail: string }).detail

// What a client's timeout is written against: an answer that takes too long
test('hang answers 504 once it has waited', async (t) => {
  const { core, manager } = env(t)
  configure(manager, { fault: 'hang', fault_seconds: 0.2 })

  const started = performance.now()
  const response = await answer(core)

  assert.ok(performance.now() - started >= 200)
  assert.equal(response.status, 504)
  assert.ok(detail(response).includes('hung for 0.2 seconds'))
})

// An hour is the default hang; nobody should be held to it after they left.
//
// The wait is what the fault is for, but it is a wait on somebody — once that somebody has hung
// up there is nothing left to hold, and the connection task would otherwise sit there until the
// full `fault_seconds` ran out.
test('a hang lets go once the caller has given up', async (t) => {
  const { core, manager } = env(t)
  configure(manager, { fault: 'hang', fault_seconds: 30 })
  let left = false

  const ask = async () => {
    const answering = core.resolve(makeRequest({ ...FEED, gave_up: () => left }))
    await sleep(100)
    left = true
    return answering
  }

  const started = performance.now()
  const response = await ask()

  assert.ok(performance.now() - started < 5000, 'it waited out fault_seconds anyway')
  // Nothing is written to a socket nobody is holding: the same shape `close` has
  assert.equal(response.close, true)
  assert.equal(response.status, 0)
})

// The other half of it: a caller that is still there gets the whole wait
test('a hang nobody walked away from still waits', async (t) => {
  const { core, manager } = env(t)
  configure(manager, { fault: 'hang', fault_seconds: 0.3 })

  const started = performance.now()
  const response = await answer(core)

  assert.ok(performance.now() - started >= 300)
  assert.equal(response.status, 504)
})

// Only the waiting is cut short, which is the whole of this behaviour.
//
// A delay, unlike a hang, has a real answer behind it, and that answer is worth producing even
// once nobody is there to read it: it is what the request log reports and what a recording would
// keep. Letting go the way a hang does — nothing at all — would write that nothing down instead.
test('a delay stops waiting but still answers what it was holding', async (t) => {
  const { core, manager } = env(t)
  configure(manager, { response_delay: 30 })

  const started = performance.now()
  const response = await answerWhileTheCallerLeaves(core)

  assert.ok(performance.now() - started < 5000, 'it waited out the whole delay anyway')
  assert.equal(response.status, 200)
  assert.deepEqual(payload(response), { cards: [] })
  // And the log says what the mode said, not what a hang leaves behind
  assert.equal(core.exchanges.all().at(-1)!.response!.status, 200)
})

// Both waits on one rule: the delay runs first, so it could sit out the hang.
//
// A hang lets go as soon as the caller does, but a delay in front of it used to be waited out in
// full before the hang's own wait began — the one shape where letting go never happened.
test('a delay does not hold a hang past the hangup', async (t) => {
  const { core, manager } = env(t)
  configure(manager, { response_delay: 30, fault: 'hang', fault_seconds: 30 })

  const started = performance.now()
  const response = await answerWhileTheCallerLeaves(core)

  assert.ok(performance.now() - started < 5000, 'the delay held it for the hang to wait out')
  assert.equal(response.status, 0)
  assert.equal(response.close, true)
})

// The parse-error branch, which a well behaved backend never reaches
test('garbage is not the JSON it says it is', async (t) => {
  const { core, manager } = env(t)
  configure(manager, { fault: 'garbage' })

  const response = await answer(core)

  assert.equal(response.headers['content-type'], 'application/json')
  assert.throws(() => parseJson(response.body.toString('utf8')), SyntaxError)
})

test('close answers nothing at all', async (t) => {
  const { core, manager } = env(t)
  configure(manager, { fault: 'close' })

  const response = await answer(core)

  assert.equal(response.close, true)
  assert.deepEqual(response.body, Buffer.alloc(0))
})

// The mode is left configured; the fault is what answers while it is set
test('a fault replaces what the mode would have said', async (t) => {
  const { core, manager } = env(t)
  configure(manager, { fault: 'garbage' })

  assert.notDeepEqual((await answer(core)).body, Buffer.from('{"cards": []}'))

  manager.updateRequestConfig('GET:/api/feed', { fault: 'none' })

  assert.deepEqual(payload(await answer(core)), { cards: [] })
})

// A test run has to see what happened, especially when nothing came back
test('a faulted request is still logged', async (t) => {
  const { core, manager } = env(t)
  configure(manager, { fault: 'close' })

  await answer(core)

  const exchange = core.exchanges.all().at(-1)!
  assert.equal(exchangeKey(exchange), 'GET:api.example.com/api/feed')
  assert.equal(exchange.response!.status, 0)
})

// ---------------------------------------------------------------- in detail

// A fault answers in place of the upstream, which is never asked: the 504 is tunnel's own, and kept
// in the session it would come back from the next replay as what the real server said, over the
// answer recorded before it
test('a passthrough that hangs records nothing', async (t) => {
  const { core, manager } = env(t, { upstream: fakeUpstream(() => jsonAnswer({ real: true })) })
  await core.recordings.start('default')
  configure(manager, { mode: 'passthrough', fault: 'hang', fault_seconds: 0.2 })

  const response = await answer(core)

  assert.equal(response.status, 504)
  assert.deepEqual(await core.recordings.index(), [])
  // The request log still says what happened
  const logged = core.exchanges.all().at(-1)!
  assert.equal(logged.mode, 'passthrough')
  assert.equal(logged.response!.status, 504)
})

test('a passthrough hang the client walked out on records nothing', async (t) => {
  const { core, manager } = env(t, { upstream: fakeUpstream(() => jsonAnswer({ real: true })) })
  await core.recordings.start('default')
  configure(manager, { mode: 'passthrough', fault: 'hang', fault_seconds: 30 })

  const response = await answerWhileTheCallerLeaves(core)

  assert.equal(response.status, 0)
  assert.equal(response.close, true)
  assert.deepEqual(await core.recordings.index(), [])
})

// Each of them is an answer tunnel made in place of the upstream's
test('garbage, close, an unreachable upstream and an undecodable answer on a passthrough rule record nothing', async (t) => {
  /** One request to a passthrough rule with these fields over this upstream, while recording:
   *  the answer, and what the session holds after it */
  const passThrough = async (
    upstream: UpstreamClient,
    fields: Partial<Omit<TunnelRequestConfig, 'request_key'>> = {},
  ) => {
    const { core, manager } = env(t, { upstream })
    await core.recordings.start('default')
    configure(manager, { mode: 'passthrough', ...fields })
    const response = await answer(core)
    return { response, recorded: await core.recordings.index() }
  }
  const real = () => fakeUpstream(() => jsonAnswer({ real: true }))

  const garbage = await passThrough(real(), { fault: 'garbage' })
  assert.equal(garbage.response.status, 200)
  assert.deepEqual(garbage.response.body, GARBAGE_BODY)
  assert.deepEqual(garbage.recorded, [])

  const closed = await passThrough(real(), { fault: 'close' })
  assert.equal(closed.response.status, 0)
  assert.deepEqual(closed.recorded, [])

  // A 502: the upstream was asked, and could not be reached
  const unreachable = await passThrough(
    fakeUpstream(() => {
      throw new UpstreamError('down')
    }),
  )
  assert.equal(unreachable.response.status, 502)
  assert.deepEqual(unreachable.recorded, [])

  // A 500: the upstream answered, in something that could not be decoded
  const undecodable = await passThrough(
    fakeUpstream(() => ({
      status: 200,
      headers: { 'content-encoding': 'gzip' },
      body: Buffer.from('not gzip'),
    })),
  )
  assert.equal(undecodable.response.status, 500)
  assert.deepEqual(undecodable.recorded, [])
})

// What a delay holds back is the upstream's own answer, so the caller walking out cuts the waiting
// short and nothing else: the answer is still fetched, and kept for the next replay. Held here at
// the core; proxy.test.ts holds it over a real socket
test('a delayed passthrough the client walked out on is still answered and recorded', async (t) => {
  const { core, manager } = env(t, { upstream: fakeUpstream(() => jsonAnswer({ real: true })) })
  await core.recordings.start('default')
  configure(manager, { mode: 'passthrough', response_delay: 30 })

  const started = performance.now()
  const response = await answerWhileTheCallerLeaves(core)

  assert.ok(performance.now() - started < 5000, 'it waited out the whole delay anyway')
  assert.equal(response.status, 200)
  assert.deepEqual(payload(response), { real: true })
  const recorded = await core.recordings.index()
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0]!.status, 200)
  assert.equal(core.exchanges.all().at(-1)!.response!.status, 200)
})

// The seconds in the 504's detail are written the way printf's %g writes them, six significant
// digits, where String() would write every digit there is
test("a hang's detail writes its seconds the way printf's %g does", async (t) => {
  const { core, manager } = env(t)
  configure(manager, { fault: 'hang', fault_seconds: 0.123456789 })

  const response = await answer(core)

  assert.equal(response.status, 504)
  assert.equal(detail(response), 'GET:/api/feed hung for 0.123457 seconds')
})

// A fault's answer is an answer like any other, so the rule's headers are written over it; a
// disabled rule answers before any of that, and its 503 is left as it is
test("a rule's headers are written over a fault's answer, but not over a 503", async (t) => {
  const { core, manager } = env(t)
  configure(manager, { fault: 'garbage', headers: { 'x-flag': '1' } })

  const garbage = await answer(core)

  assert.equal(garbage.headers['x-flag'], '1')
  assert.equal(garbage.headers['content-type'], 'application/json')
  assert.deepEqual(garbage.body, GARBAGE_BODY)

  configure(manager, { enabled: false, headers: { 'x-flag': '1' } })

  const disabled = await answer(core)

  assert.equal(disabled.status, 503)
  assert.ok(!('x-flag' in disabled.headers))
})

test('the waits say what they did in the log', async (t) => {
  const logs = captureLogs(t)
  const said = () =>
    logs.records
      .filter((record) => record.level === 'info' && record.logger === 'tunnel.core')
      .map((record) => record.message)

  // A hang waited out
  const waited = env(t)
  configure(waited.manager, { fault: 'hang', fault_seconds: 0.2 })
  assert.equal((await answer(waited.core)).status, 504)
  assert.ok(said().includes('Answering GET:/api/feed with the hang fault'), said().join('\n'))

  // A hang the caller walked out on: how long it held on, then what it was told to do
  const leftHang = env(t)
  configure(leftHang.manager, { fault: 'hang', fault_seconds: 30 })
  assert.equal((await answerWhileTheCallerLeaves(leftHang.core)).status, 0)
  const lettingGo = said().filter((message) => message.startsWith('Letting go of '))
  assert.equal(lettingGo.length, 1, said().join('\n'))
  assert.match(
    lettingGo[0]!,
    /^Letting go of GET:\/api\/feed after \d+\.\ds: it was told to hang for 30, and the client stopped waiting$/,
  )

  // A delay the caller walked out on
  const leftDelay = env(t)
  configure(leftDelay.manager, { response_delay: 30 })
  assert.equal((await answerWhileTheCallerLeaves(leftDelay.core)).status, 200)
  assert.ok(
    said().includes(
      'Not holding GET:/api/feed for the rest of its 30s delay: the client stopped waiting',
    ),
    said().join('\n'),
  )
})

// The wait beats the departure: the round that wakes to find the time up answers, without asking
// whether anybody is still there
test('a caller who leaves exactly as the wait runs out still gets the answer', async (t) => {
  const { core, manager } = env(t)
  configure(manager, { fault: 'hang', fault_seconds: 0.2 })

  // The caller leaves 200 ms after the hang started its clock. Read once resolve() has handed
  // back its promise: everything up to the hang's first look at the clock runs before that. Read
  // before the call, it would have the caller leave a fraction of a millisecond ahead of the
  // deadline, where a timer that wakes a little early (Node counts whole milliseconds) rightly
  // lets go — 'a hang lets go once the caller has given up', not this
  let started = Infinity
  const answering = answer(core, { gave_up: () => performance.now() - started >= 200 })
  started = performance.now()
  const response = await answering

  assert.equal(response.status, 504)
  assert.ok(detail(response).includes('hung for 0.2 seconds'))
})

// No time to wait, or less than none (nothing in the configuration stops a -1): the answer is there
// at once, and a hang's 504 still says the seconds it was told
test('a delay or a hang of no time, or less, answers at once', async (t) => {
  const { core, manager } = env(t)
  const started = performance.now()

  configure(manager, { response_delay: -1 })
  const delayed = await answer(core)
  configure(manager, { response_delay: 0, fault: 'hang', fault_seconds: 0 })
  const hung = await answer(core)
  configure(manager, { fault: 'hang', fault_seconds: -5 })
  const hungLess = await answer(core)

  assert.ok(performance.now() - started < 1000)
  assert.deepEqual(payload(delayed), { cards: [] })
  assert.equal(hung.status, 504)
  assert.equal(detail(hung), 'GET:/api/feed hung for 0 seconds')
  assert.equal(hungLess.status, 504)
  assert.equal(detail(hungLess), 'GET:/api/feed hung for -5 seconds')
})

// The fault stands in for the whole of the mode: the upstream is not asked, at its target or
// anywhere, and nothing is merged into the fault's answer; the rule's headers still land on it
test('a fault on a passthrough rule asks no upstream and merges nothing into its answer', async (t) => {
  const asked: string[] = []
  const upstream = fakeUpstream((request) => {
    asked.push(request.url)
    return jsonAnswer({ real: true })
  })
  const { core, manager } = env(t, { upstream })
  configure(manager, {
    mode: 'passthrough',
    target: 'http://other.test/base',
    merge_json: { merged: true },
    headers: { 'x-flag': '1' },
    fault: 'hang',
    fault_seconds: 0,
  })

  const response = await answer(core)

  assert.deepEqual(asked, [])
  assert.equal(response.status, 504)
  assert.deepEqual(payload(response), { detail: 'GET:/api/feed hung for 0 seconds' })
  assert.equal(response.headers['x-flag'], '1')
})

// A disabled rule answers before anything else it says is looked at
test('a disabled rule answers 503 at once, without its delay or its fault', async (t) => {
  const { core, manager } = env(t)
  configure(manager, { enabled: false, response_delay: 2, fault: 'hang', fault_seconds: 2 })

  const started = performance.now()
  const response = await answer(core)

  assert.ok(performance.now() - started < 1000)
  assert.equal(response.status, 503)
  assert.equal(detail(response), 'GET:/api/feed is disabled')
})

// What is recorded is the exchange the request log kept: with auto_record_requests off there is none,
// so a passthrough is answered and nothing lands in the session
test('with auto_record_requests off a passthrough is answered and nothing is recorded', async (t) => {
  const { core, manager } = env(t, { upstream: fakeUpstream(() => jsonAnswer({ real: true })) })
  manager.updateConfig({ auto_record_requests: false })
  await core.recordings.start('default')
  configure(manager, { mode: 'passthrough' })

  const response = await answer(core)

  assert.deepEqual(payload(response), { real: true })
  assert.deepEqual(core.exchanges.all(), [])
  assert.deepEqual(await core.recordings.index(), [])
})
