// Logging: each module gets a named logger, tunnel.<name>, and every record goes
// to one process-wide sink. The default sink writes to stderr, one line each, in
// the format LEVEL:logger:message. An error record's line starts with ERROR, so a
// reader that looks for the last line mentioning an error finds it, as the CLI's
// logTail does with tunnel.log.
//
// The sink is the one exception to "no module-level mutable singletons": tests
// swap it with captureLogs (tests/support/logs.ts) and swap it back afterwards,
// and test processes start out silent (tests/support/setup.ts).
//
// Logs never go to stdout, which belongs to command output. To log a stack,
// put error.stack into the message. There is no setting for the log level.

export type LogLevel = 'debug' | 'info' | 'warning' | 'error'

export interface LogRecord {
  level: LogLevel
  /** The full name, tunnel.<name> */
  logger: string
  message: string
}

export type LogSink = (record: LogRecord) => void

export interface Logger {
  debug(message: string): void
  info(message: string): void
  warning(message: string): void
  error(message: string): void
}

/**
 * The line the default sink prints for a record, without the newline:
 * LEVEL:logger:message. captureLogs uses it too, so the format is written down
 * once.
 */
export function formatRecord(record: LogRecord): string {
  return `${record.level.toUpperCase()}:${record.logger}:${record.message}`
}

/**
 * The default sink: writes to stderr, one line per record
 * (LEVEL:tunnel.<name>:message), and drops debug.
 */
export const stderrSink: LogSink = (record) => {
  if (record.level === 'debug') return
  // Looked up on every call, so a test that mocks process.stderr.write sees the line
  process.stderr.write(`${formatRecord(record)}\n`)
}

let sink: LogSink = stderrSink

/** Swaps where logs go and returns the previous sink, which tests use to restore it */
export function setLogSink(next: LogSink): LogSink {
  const previous = sink
  sink = next
  return previous
}

/** name is the module's file name: getLogger('core') prints as tunnel.core */
export function getLogger(name: string): Logger {
  const logger = `tunnel.${name}`
  // The sink is read on every call rather than kept here, because modules make
  // their loggers as they load, before a test has had the chance to swap it
  const write = (level: LogLevel) => (message: string) => sink({ level, logger, message })
  return {
    debug: write('debug'),
    info: write('info'),
    warning: write('warning'),
    error: write('error'),
  }
}
