import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { tmpDir } from './tmp.ts'

/**
 * A home of its own, no directory variables at all, and a cwd inside the temp dir, so that
 * nothing walks up into the checkout's own .tunnel/.
 *
 * tmp is tmpDir(t), symlinks already resolved; home is tmp/home, made here. Pass context to
 * resolvePaths in place of changing the process: `{ ...context, cwd, env, platform }` stands for
 * a working directory, an environment and a platform of the test's own. home is the home
 * directory resolvePaths sees, and an env with nothing in it has no TUNNEL_CONFIG_DIR, none of
 * the three XDG variables, and no APPDATA or LOCALAPPDATA.
 *
 * The cwd is in the temp dir too. With env empty, TUNNEL_CONFIG_DIR is not in it, so a test that
 * forgot to give a cwd would have resolvePaths walk up from the real one: the repository root,
 * where npm test runs, which has a .tunnel/ of its own (the one the server uses in development,
 * ignored by .gitignore). The test would then read and write that.
 */
export function isolatedHome(t: TestContext): {
  tmp: string
  home: string
  context: { env: Record<string, string | undefined>; home: string; cwd: string }
} {
  const tmp = tmpDir(t)
  const home = join(tmp, 'home')
  mkdirSync(home)
  return { tmp, home, context: { env: {}, home, cwd: tmp } }
}
