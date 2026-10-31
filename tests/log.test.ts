// src/log.ts, and captureLogs from tests/support/logs.ts.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getLogger, setLogSink, stderrSink, type LogSink } from '../src/log.ts'
import { captureLogs } from './support/logs.ts'

// Made before any test swaps the sink, the way a module makes its logger as it
// loads, so these tests pass only if a logger looks the sink up on every call
const log = getLogger('core')

/** The sink in use right now. Swapping it is the only way to read it */
function currentSink(): LogSink {
  const sink = setLogSink(stderrSink)
  setLogSink(sink)
  return sink
}

test('the default sink writes LEVEL:tunnel.<name>:message to stderr and drops debug', (t) => {
  const write = t.mock.method(process.stderr, 'write', () => true)
  // Test processes are silent (tests/support/setup.ts), so bring the default back for this test
  const previous = setLogSink(stderrSink)
  t.after(() => setLogSink(previous))
  log.debug('zero')
  log.info('one')
  log.warning('two')
  log.error('three')
  assert.deepEqual(
    write.mock.calls.map((call) => call.arguments[0]),
    ['INFO:tunnel.core:one\n', 'WARNING:tunnel.core:two\n', 'ERROR:tunnel.core:three\n'],
  )
})

test('captureLogs collects every record; text() is what the default sink would print', (t) => {
  const logs = captureLogs(t)
  log.debug('zero')
  log.info('one')
  log.warning('two')
  log.error('three')
  assert.deepEqual(logs.records, [
    { level: 'debug', logger: 'tunnel.core', message: 'zero' },
    { level: 'info', logger: 'tunnel.core', message: 'one' },
    { level: 'warning', logger: 'tunnel.core', message: 'two' },
    { level: 'error', logger: 'tunnel.core', message: 'three' },
  ])
  assert.equal(
    logs.text(),
    'INFO:tunnel.core:one\nWARNING:tunnel.core:two\nERROR:tunnel.core:three',
  )
})

test('the sink captureLogs replaced is back once the test is over', (t) => {
  const before = currentSink()
  captureLogs(t)
  assert.notEqual(currentSink(), before)
  // Checked in a t.after hook added after the one captureLogs adds, as hooks
  // run in the order they were added. Not after an awaited t.test(): on Node
  // 24.2.0 that returns before the subtest's t.after hooks have run
  t.after(() => assert.equal(currentSink(), before))
})

test('test processes are silent unless TUNNEL_TEST_LOGS=1', () => {
  assert.equal(currentSink() === stderrSink, process.env.TUNNEL_TEST_LOGS === '1')
})
