import { mkdtempSync, realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'

/**
 * Makes a fresh tunnel-test-* directory under os.tmpdir() and removes it, with
 * everything in it, once the test is over (t.after).
 *
 * The path it returns is the real one, symlinks resolved. On macOS os.tmpdir()
 * lies under a symlink (/var/folders/… is /private/var/folders/…, /tmp is
 * /private/tmp), and after process.chdir() into the unresolved path,
 * process.cwd() answers with the /private one, so a test comparing the two
 * would fail.
 *
 * t.after hooks run in the order they were added. A test with something that
 * writes to disk asynchronously (an ExchangeLog, a RecordingStore) adds that
 * object's close before it calls tmpDir(t), so the last write is done before
 * the directory goes. The removal is asynchronous and retried as well, in case
 * one is still in flight: a synchronous removal can fail with ENOTEMPTY when a
 * write lands in the middle of it (seen on Node 22.18).
 */
export function tmpDir(t: TestContext): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tunnel-test-')))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }))
  return dir
}
