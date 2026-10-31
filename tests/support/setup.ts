// Loaded with --import by the npm test scripts, so it runs first in every test
// process: node --test's own, and the one it starts for each test file.
//
// No test may touch the real directories. TUNNEL_CONFIG_DIR is pinned here,
// before any test file and so any application module is imported: code that
// falls back to the default directories because a test forgot to pass one, even
// code that reads the variable as its module loads, must end up in a throwaway
// directory rather than in the developer's own config. Overridden
// unconditionally rather than only when unset: someone who happens to have this
// variable set should not be written to either.
//
// The directory is removed when the process exits. Every test process makes its
// own, so leaving them behind would leak one directory per test file on every
// run. Only a process that exits, though: one ended by a signal runs no exit
// handlers, so a run cut short with Ctrl-C leaves its directories behind.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'tunnel-tests-'))
process.env.TUNNEL_CONFIG_DIR = dir
process.on('exit', () => rmSync(dir, { recursive: true, force: true }))

// Silent unless TUNNEL_TEST_LOGS=1: node --test prints whatever a test file
// writes to stderr in among the results. Imported only now, after the pin: a
// static import would load src/log.ts, and whatever it imports, before it.
const { setLogSink } = await import('../../src/log.ts')
if (process.env.TUNNEL_TEST_LOGS !== '1') setLogSink(() => {})
