// Starts the tunnel command in this checkout as a child process, for the
// black-box tests in tests/contract/, which look only at its exit code and
// output, and for the test in tests/mcp.test.ts that runs `tunnel mcp` over
// real pipes.
import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { PACKAGE_ROOT } from '../../src/package-info.ts'
import { freePort } from './ports.ts'
import { tmpDir } from './tmp.ts'

/**
 * How to start `tunnel <args>`: the program, its arguments and its
 * environment, for spawn() as they are. runTunnel starts every command this
 * way; a test that needs the child process itself, to close its stdout early or
 * to stop it, starts it from here too.
 *
 * The environment is this process's, then no_proxy=*, then env, so what the
 * caller gives wins over both.
 */
export function tunnelCommand(
  args: readonly string[],
  env?: Record<string, string>,
): { command: string; args: string[]; env: Record<string, string | undefined> } {
  // The Node running the tests, not whichever node comes first on PATH. The
  // source runs as it is, the build being check-install's business. Without
  // the flag, some versions (24.2.0 for one) print an ExperimentalWarning to
  // stderr as they strip the types, and the tests read stderr
  return {
    command: process.execPath,
    args: ['--disable-warning=ExperimentalWarning', join(PACKAGE_ROOT, 'src', 'cli.ts'), ...args],
    // no_proxy=*, so that a server a black-box test starts sends the traffic it
    // does not intercept straight upstream, whatever proxies the developer's
    // shell or the Mac is set to: tunnel then takes the direct route without
    // even asking macOS for its system proxy. Lower case, because tunnel reads
    // no_proxy before NO_PROXY, so a NO_PROXY in the developer's shell cannot
    // change it
    env: { ...process.env, no_proxy: '*', ...env },
  }
}

/**
 * Runs `tunnel <args>` once and resolves with its exit code (null when a
 * signal ended it) and both outputs. It rejects only when the command cannot
 * start at all, or when it is still running after options.timeoutMs, which
 * kills it. The arguments go to the process as an array, never through a shell.
 *
 * The child's command and environment are tunnelCommand's, with options.env
 * last. Its stdin is always closed, after options.input if there is one, so a
 * command that reads stdin gets EOF rather than waiting for it.
 */
export function runTunnel(
  args: string[],
  options?: { env?: Record<string, string>; cwd?: string; input?: string; timeoutMs?: number },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const { command, args: argv, env } = tunnelCommand(args, options?.env)
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { cwd: options?.cwd, env })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    // A command that hangs is a failure rather than a result, and without a limit
    // it would hold the whole run up
    const timeoutMs = options?.timeoutMs
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            child.kill('SIGKILL')
            const what = `tunnel ${args.join(' ')} did not finish within ${timeoutMs} ms`
            reject(new Error(`${what}\nstdout: ${stdout}\nstderr: ${stderr}`))
          }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    // A command that exits before reading all of options.input breaks the pipe
    // (EPIPE). Unhandled, that would fail whichever test is running, though the
    // exit code and output it is judged by are fine
    child.stdin.on('error', () => {})
    child.stdin.end(options?.input)
  })
}

/**
 * Starts a real server, as tunnelCommand has it:
 * `tunnel serve --admin-port <freePort()> --proxy-port 0 --proxy-host 127.0.0.1
 * --config-dir <tmpDir(t)>`. It resolves once GET /__admin__/health answers 200, asked every
 * 100 ms for up to 30 s. proxyPort is the port that health reports the proxy listening on: serve
 * opens the proxy port before the admin port, so the first health to answer has it. It rejects
 * when the server cannot start or ends first, with what it wrote to stderr, when it answers
 * without a proxy port, and when it is still not answering after 30 s, killing it.
 *
 * Once the test is over (t.after) the server gets a SIGTERM, and a SIGKILL if it has not ended
 * 10 s later: the foreground serve rather than --background, so that it is this process's child,
 * to signal and to wait for.
 */
export async function startServer(
  t: TestContext,
): Promise<{ adminBase: string; proxyPort: number; configDir: string }> {
  let child: ChildProcess | undefined
  // Before tmpDir(t): after hooks run in the order they were added, and the server stops before
  // its directory goes
  t.after(() => child && stopChild(child))
  const configDir = tmpDir(t)
  const port = await freePort()
  const adminBase = `http://127.0.0.1:${port}`
  const { command, args, env } = tunnelCommand([
    'serve',
    '--admin-port',
    String(port),
    '--proxy-port',
    '0',
    '--proxy-host',
    '127.0.0.1',
    '--config-dir',
    configDir,
  ])
  const server = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  child = server
  // Both read for as long as it runs: a pipe nobody empties fills up, and the server would hang
  // writing its log into it
  let stdout = ''
  let stderr = ''
  server.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
  server.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
  let failed: Error | undefined
  server.on('error', (error) => {
    failed = error
  })
  // On close rather than on exit: by then all it wrote has been read
  server.on('close', (code, signal) => {
    const how = `exit code ${code}, signal ${signal}`
    failed ??= new Error(`tunnel serve ended before it answered (${how})\nstderr: ${stderr}`)
  })

  const deadline = performance.now() + 30_000
  while (performance.now() < deadline) {
    if (failed) throw failed
    const health = await askHealth(adminBase)
    if (health !== undefined) {
      const proxy = health.proxy as { port: number } | null
      if (!proxy) {
        throw new Error(`${adminBase} answered without the proxy port, which serve opens first`)
      }
      return { adminBase, proxyPort: proxy.port, configDir }
    }
    await sleep(100)
  }
  server.kill('SIGKILL')
  const what = `tunnel serve did not answer on ${adminBase} within 30 s`
  throw new Error(`${what}\nstdout: ${stdout}\nstderr: ${stderr}`)
}

/** GET /__admin__/health's answer once it is a 200, and undefined while nothing answers yet */
async function askHealth(adminBase: string): Promise<Record<string, unknown> | undefined> {
  try {
    // A port that takes the connection and never answers is asked again rather than waited on
    const response = await fetch(`${adminBase}/__admin__/health`, {
      signal: AbortSignal.timeout(2000),
    })
    const body = await response.text()
    if (response.status === 200) return JSON.parse(body) as Record<string, unknown>
  } catch {
    // Not listening yet
  }
  return undefined
}

/** Stops what startServer started: a SIGTERM, which a server answers by closing both ports and
 *  ending, and a SIGKILL if it has not ended 10 s later */
async function stopChild(child: ChildProcess): Promise<void> {
  // One that never started, or has ended already, has no exit left to wait for
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  const late = setTimeout(() => child.kill('SIGKILL'), 10_000)
  await exited
  clearTimeout(late)
}
