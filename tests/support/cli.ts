// The tunnel command in process, for the test files that run it. main() is handed its streams and
// its outside world rather than reaching for the process's, so these tests hand main() the admin
// app's request() as its fetch and read two strings.
import { Readable, Writable } from 'node:stream'
import type { CliDeps, CliIo } from '../../src/cli-common.ts'
import { main } from '../../src/cli.ts'

/** Where a test points the CLI. Any host would do: the fetch it is given never leaves the
 *  process */
export const BASE = 'http://tunnel.test'

export interface CapturedIo extends CliIo {
  /** What the two outputs have received so far, taken away */
  takeOutput(): { out: string; err: string }
}

/**
 * Streams for main(): stdin ends after input (at once when there is none), and what stdout and
 * stderr are written is kept as text. None of the three is a TTY, so help is laid out for 80
 * columns.
 */
export function captureIo(input?: string): CapturedIo {
  let out = ''
  let err = ''
  // The callback is called at once, so whatever a command wrote is all here by the time main()
  // resolves
  const collect = (keep: (text: string) => void): Writable =>
    new Writable({
      decodeStrings: false,
      write(chunk, _encoding, callback) {
        keep(String(chunk))
        callback()
      },
    })
  return {
    stdin: Readable.from(input === undefined ? [] : [input]),
    stdout: collect((text) => (out += text)),
    stderr: collect((text) => (err += text)),
    takeOutput() {
      const taken = { out, err }
      out = ''
      err = ''
      return taken
    },
  }
}

export interface CliRunner {
  /** main(['--base', base, ...argv], io, deps), resolving with the exit code. Every call writes
   *  to the same io */
  run(...argv: string[]): Promise<number>
  takeOutput(): { out: string; err: string }
  readonly io: CapturedIo
  readonly deps: CliDeps
}

/**
 * The CLI, ready for a test. fetch is env.fetch (the admin app's request()) or the global fetch;
 * cwd is usually tmpDir(t). env defaults to the directory setup.ts pinned and nothing else, so a
 * TUNNEL_BASE or a COLUMNS in the developer's shell does not reach the test. run defaults to
 * failing at once: no test may start the real xcrun, adb or security. base defaults to BASE; a
 * test that wants nothing to answer gives a port it has closed.
 */
export function cliRunner(options: {
  fetch: (url: string, init?: RequestInit) => Response | Promise<Response>
  cwd: string
  env?: Readonly<Record<string, string | undefined>>
  run?: CliDeps['run']
  base?: string
}): CliRunner {
  const io = captureIo()
  const deps: CliDeps = {
    fetch: (url, init) => Promise.resolve(options.fetch(url, init)),
    env: options.env ?? { TUNNEL_CONFIG_DIR: process.env.TUNNEL_CONFIG_DIR },
    cwd: options.cwd,
    run:
      options.run ??
      ((command) => {
        throw new Error(`a test ran ${command.join(' ')}; give cliRunner a run of its own`)
      }),
  }
  const base = options.base ?? BASE
  return {
    run: (...argv) => main(['--base', base, ...argv], io, deps),
    takeOutput: () => io.takeOutput(),
    io,
    deps,
  }
}
