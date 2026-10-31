import type { TestContext } from 'node:test'
import { formatRecord, setLogSink, type LogRecord } from '../../src/log.ts'

/**
 * Collects every log record in records for the rest of this test, then puts
 * the previous sink back (t.after). records holds every level, debug included;
 * text() is the lines the default sink would print
 * (LEVEL:tunnel.<name>:message) joined with newlines, so it leaves debug out.
 *
 * Call it once per test: t.after hooks run in the order they were added, so a
 * second call would put the first one's collector back, not the sink from
 * before the test.
 */
export function captureLogs(t: TestContext): { records: LogRecord[]; text(): string } {
  const records: LogRecord[] = []
  const previous = setLogSink((record) => {
    records.push(record)
  })
  t.after(() => setLogSink(previous))
  return {
    records,
    text: () =>
      records
        .filter((record) => record.level !== 'debug')
        .map(formatRecord)
        .join('\n'),
  }
}
