// Starting and stopping the server (serve, status and stop): `tunnel serve` puts the proxy port
// and the admin port in this one process, `serve --background` starts that same command as a
// process of its own and leaves its pid where `status`, `stop` and every command's default --base
// find it. The only command module that builds the server's objects, and so the only one that
// imports core.ts, proxy.ts and app.ts.
import { type ChildProcess, spawn } from 'node:child_process'
import { closeSync, fstatSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { type AdminServer, startAdminServer } from './app.ts'
import { CertificateAuthority } from './certs.ts'
import type { Args } from './cli-args.ts'
import {
  CannotConnect,
  type CliDeps,
  CliError,
  type CliIo,
  health,
  isSystemError,
  print,
  processAlive,
  stripSpace,
  readPidFile,
  recordBase,
} from './cli-common.ts'
import { resolvePaths, TunnelConfigManager } from './config.ts'
import { TunnelCore } from './core.ts'
import { type JsonObject, stringifySpaced } from './json.ts'
import { VERSION } from './package-info.ts'
import { type ProxyInfo, ProxyServer } from './proxy.ts'

/** How long `serve --background` gives the child to answer, and `stop` gives it to go. Both are
 *  generous: the first run signs a CA before it listens */
export const STARTUP_TIMEOUT_MS = 30_000
export const SHUTDOWN_TIMEOUT_MS = 10_000

/** Where a line breaks: \r\n, and each of these alone */
const LINE_BREAK = /\r\n|[\n\v\f\r\x1c-\x1e\x85\u2028\u2029]/

/**
 * The line that says why the child is not running.
 *
 * Only what this child wrote, from offset, where the log stood when it was started: the file is
 * kept across starts, and an earlier run's last words are not the reason this one is not up. Its
 * last complaint rather than its last line: a server that could not bind a port says so and then
 * goes on to log an orderly shutdown, and the shutdown is not the news. Bytes that are not UTF-8
 * read as U+FFFD, and a log that cannot be read as an empty one; lines are cut at LINE_BREAK and
 * stripped with stripSpace.
 */
export function logTail(path: string, offset: number): string {
  let written: string
  try {
    written = readFileSync(path).subarray(offset).toString('utf8')
  } catch (error) {
    if (!isSystemError(error)) throw error
    written = ''
  }
  const lines = written
    .split(LINE_BREAK)
    .map(stripSpace)
    .filter((line) => line !== '')
  if (lines.length === 0) return `nothing in ${path}`
  const complaints = lines.filter((line) => line.toLowerCase().includes('error'))
  return complaints.length > 0 ? complaints.at(-1)! : lines.at(-1)!
}

/**
 * What to type into a device, where the person starting the server sees it; the foreground serve,
 * `serve --background` and `status` print it. proxy is what describe() or health reports, and a
 * key that is not there prints as unknown. upstream is the way out for what tunnel does not answer
 * itself, after the proxy port and the device lines; null leaves the line out, for a server that
 * does not report it.
 */
function serveBanner(
  headline: string,
  adminPort: number,
  proxy: Partial<ProxyInfo>,
  fingerprint: string,
  upstream: string | null,
): string[] {
  const addresses = proxy.lan_ips ?? []
  const port = proxy.port ?? 'unknown'
  const lines = [
    headline,
    `  panel:  http://127.0.0.1:${adminPort}/`,
    `  proxy:  ${proxy.host ?? 'unknown'}:${port}`,
  ]
  for (const address of addresses) {
    lines.push(`    set the device's HTTP proxy to ${address} port ${port}`)
  }
  if (upstream !== null) lines.push(`  upstream: ${upstream}`)
  let certificate = 'http://ca.tunnel/ once the device is proxied'
  if (addresses.length > 0) certificate += `, or http://${addresses[0]}:${port}/ca.pem`
  lines.push(`  CA:     ${certificate}`)
  lines.push(`          ${fingerprint}`)
  return lines
}

/** health's proxy, or {} when it has none. A server reports it whenever it answers, since serve
 *  listens on the proxy port first */
function proxyOf(health: JsonObject): Partial<ProxyInfo> {
  return (health.proxy || {}) as Partial<ProxyInfo>
}

/** health's upstream: how the server leaves for what it does not answer itself, or null when
 *  health says nothing of it */
function upstreamOf(health: JsonObject): string | null {
  return typeof health.upstream === 'string' ? health.upstream : null
}

/**
 * tunnel serve: the proxy devices point at and the admin port, in this process until a SIGTERM
 * or a Ctrl-C; with --background, the same command started as a process of its own. entry is the
 * file that command runs, cli.ts's own.
 */
export function cmdServe(args: Args, io: CliIo, deps: CliDeps, entry: string): Promise<number> {
  return args.background === true
    ? serveBackground(args, io, deps, entry)
    : serveForeground(args, io, deps)
}

/**
 * Both ports, the proxy port first: health then answers only once both listen, so that a parent
 * waiting on health never catches the server without its proxy. A port that cannot be listened on
 * is one line, and what was started before it is closed again.
 *
 * A SIGTERM or a Ctrl-C then closes the proxy port, then the admin port, which gives the requests
 * it is still holding GRACEFUL_SHUTDOWN_MS, and the process is ended by that same signal. A second
 * Ctrl-C meanwhile finds no listener and ends it at once.
 */
async function serveForeground(args: Args, io: CliIo, deps: CliDeps): Promise<number> {
  const paths = resolvePaths({
    configDir: (args.config_dir as string | null) ?? undefined,
    env: deps.env,
    cwd: deps.cwd,
  })
  // One of each in the process, which both ports share
  const manager = new TunnelConfigManager(paths)
  const core = new TunnelCore(manager)
  const ca = new CertificateAuthority(manager.paths)
  const proxy = new ProxyServer(core, manager, ca, {
    host: args.proxy_host as string,
    port: args.proxy_port as number,
  })
  try {
    await proxy.start()
  } catch (error) {
    await core.close()
    // Almost always the port being in use: one line saying which port and why, for a system error
    // of listen or getaddrinfo. Anything else is a bug
    if (!isSystemError(error)) throw error
    throw new CliError(
      `could not listen on the proxy port ${args.proxy_host}:${args.proxy_port}: ${error.message}`,
    )
  }
  let admin: AdminServer
  try {
    admin = await startAdminServer(
      { manager, core, ca, proxy: () => proxy.describe() },
      { port: args.admin_port as number },
    )
  } catch (error) {
    await proxy.close()
    await core.close()
    if (!isSystemError(error)) throw error
    throw new CliError(
      `could not listen on the admin port 127.0.0.1:${args.admin_port}: ${error.message}`,
    )
  }

  // Before the banner: once it is out, a Ctrl-C always goes through the shutdown
  const stopped = new Promise<NodeJS.Signals>((resolve) => {
    const on = (signal: NodeJS.Signals): void => {
      process.off('SIGTERM', on)
      process.off('SIGINT', on)
      resolve(signal)
    }
    process.once('SIGTERM', on)
    process.once('SIGINT', on)
  })
  // Asked once both listen: the proxy port has told the routes which port is tunnel's own
  const upstream = await core.routes.describe()
  const banner = serveBanner(
    `tunnel ${VERSION}`,
    args.admin_port as number,
    proxy.describe(),
    ca.fingerprint(),
    upstream,
  )
  io.stdout.write(`${banner.join('\n')}\n`)

  const signal = await stopped
  await proxy.close()
  await admin.close()
  process.kill(process.pid, signal)
  // Reached only where a process that signals itself is not ended by it
  return 0
}

/**
 * serve --background: the same serve, started as a process of its own that outlives this command,
 * with its output appended to tunnel.log in the state directory, so that whatever it says about a
 * port it could not bind is still there to read. Returns once it answers, having left its pid
 * where `status`, `stop` and every command's default --base find it.
 */
async function serveBackground(
  args: Args,
  io: CliIo,
  deps: CliDeps,
  entry: string,
): Promise<number> {
  const configDir = args.config_dir as string | null
  const paths = resolvePaths({ configDir: configDir ?? undefined, env: deps.env, cwd: deps.cwd })
  paths.create()

  const base = `http://127.0.0.1:${args.admin_port}`
  // Asked before the child is started, because afterwards the two are indistinguishable: the
  // health that answers would be the other server's, and this one would have died of the port
  // while we called it started.
  if ((await health(deps, base)) !== null) {
    throw new CliError(
      `something is already answering on ${base}; \`tunnel status\` says whether that is ` +
        'tunnel, or start this one on another --admin-port',
    )
  }

  // The file this command runs from, not process.argv[1], which in a test is the test file; and
  // none of this process's execArgv, which in a test would hand the child the test setup. A
  // source entry has type stripping's warning switched off, so that it stays out of the log
  const command = [
    ...(entry.endsWith('.ts') ? ['--disable-warning=ExperimentalWarning'] : []),
    entry,
    'serve',
    '--admin-port',
    String(args.admin_port),
    '--proxy-port',
    String(args.proxy_port),
    '--proxy-host',
    args.proxy_host as string,
  ]
  if (configDir) command.push('--config-dir', configDir)

  const log = openSync(paths.logFile, 'a')
  let offset: number
  let child: ChildProcess
  try {
    // Where this child's output begins; the log keeps what earlier ones said
    offset = fstatSync(log).size
    // A session of its own, so that a Ctrl-C in this terminal or the shell hanging up does not
    // take the server with it
    child = spawn(process.execPath, command, {
      detached: true,
      stdio: ['ignore', log, log],
      env: deps.env as NodeJS.ProcessEnv,
      cwd: deps.cwd,
    })
  } finally {
    closeSync(log)
  }
  // A child that could not be started at all says so as an event rather than a throw, and one
  // nobody listens for would end this process
  let spawnError: Error | undefined
  child.once('error', (error) => {
    spawnError = error
  })
  child.unref()

  const answer = await awaitHealth(child, () => spawnError !== undefined, deps, base, {
    path: paths.logFile,
    offset,
  })
  // What it actually bound, which is the one to type into a device: a --proxy-port of 0 asked
  // the operating system to pick one
  const proxy = proxyOf(answer)
  const record = {
    pid: child.pid!,
    admin_port: args.admin_port as number,
    proxy_port: proxy.port ?? (args.proxy_port as number),
  }
  // One line: the record as JSON with ', ' and ': ' separators
  writeFileSync(paths.pidFile, `${stringifySpaced(record)}\n`)

  const banner = serveBanner(
    `tunnel ${VERSION} started in the background, pid ${record.pid}`,
    record.admin_port,
    proxy,
    answer.ca_fingerprint as string,
    upstreamOf(answer),
  )
  print(io, { success: true, ...record }, args.json === true, [
    ...banner,
    `  log:    ${paths.logFile}`,
  ])
  return 0
}

/** Wait for the child to answer, or say what it died of, from what it wrote to the log since
 *  offset */
async function awaitHealth(
  child: ChildProcess,
  failedToStart: () => boolean,
  deps: CliDeps,
  base: string,
  log: { path: string; offset: number },
): Promise<JsonObject> {
  const deadline = performance.now() + STARTUP_TIMEOUT_MS
  while (performance.now() < deadline) {
    if (failedToStart() || child.exitCode !== null || child.signalCode !== null) {
      throw new CliError(`the server stopped at once: ${logTail(log.path, log.offset)}`)
    }
    const answer = await health(deps, base)
    if (answer !== null) return answer
    await sleep(100)
  }

  child.kill('SIGTERM')
  throw new CliError(
    `the server did not answer on ${base} within ${STARTUP_TIMEOUT_MS / 1000}s: ` +
      logTail(log.path, log.offset),
  )
}

/** tunnel status: whether a server started in the background is still up, and what it reports.
 *  It goes by the pid file here alone, whatever --base says */
export async function cmdStatus(args: Args, io: CliIo, deps: CliDeps): Promise<void> {
  const paths = resolvePaths({ env: deps.env, cwd: deps.cwd })
  const record = readPidFile(paths)
  if (record === null) {
    throw new CliError(
      `no server was started in the background here (${paths.pidFile} does not exist)`,
    )
  }

  const base = recordBase(record)
  const answer = await health(deps, base)
  if (answer === null || !processAlive(record.pid)) {
    throw new CannotConnect(
      `pid ${record.pid} is not answering on ${base}; the record in ${paths.pidFile} is stale ` +
        '— `tunnel stop` clears it',
    )
  }

  // A record without an admin_port fails here, with a stack trace
  if (record.admin_port === undefined) throw new Error(`${paths.pidFile} has no admin_port`)
  const lines = serveBanner(
    `tunnel is running, pid ${record.pid}`,
    record.admin_port,
    proxyOf(answer),
    answer.ca_fingerprint as string,
    upstreamOf(answer),
  )
  lines.push(`  config: ${answer.config_dir}  state: ${answer.state_dir}  data: ${answer.data_dir}`)
  lines.push(`  log:    ${paths.logFile}`)
  // Which recordings this run replays and records into: what a test run switches, and the first
  // thing to check when a replay answers 404
  lines.push(`  session: ${answer.session}`)
  print(io, { running: true, ...record, health: answer }, args.json === true, lines)
}

/** tunnel stop: ask a background server to stop, wait for it, and clear the pid file */
export async function cmdStop(args: Args, io: CliIo, deps: CliDeps): Promise<number> {
  const paths = resolvePaths({ env: deps.env, cwd: deps.cwd })
  const record = readPidFile(paths)
  if (record === null) {
    throw new CliError(
      `no server was started in the background here (${paths.pidFile} does not exist)`,
    )
  }

  const { pid } = record
  const base = recordBase(record)
  // A pid file is not proof that the pid is still tunnel's: a server that went without clearing
  // it leaves a number the operating system hands to somebody else, which after a reboot it will
  // have done. Nothing answering means the record outlived its server, so it is cleared rather
  // than signalled: a SIGTERM to whatever holds that pid now is not ours to send.
  if ((await health(deps, base)) === null) {
    rmSync(paths.pidFile, { force: true })
    print(io, { success: true, stopped: false, ...record }, args.json === true, [
      `Nothing answers on ${base}; removed the stale ${paths.pidFile} without signalling pid ${pid}`,
    ])
    return 0
  }

  try {
    process.kill(pid, 'SIGTERM')
  } catch (error) {
    const { code, message } = error as NodeJS.ErrnoException
    if (code === 'ESRCH') {
      rmSync(paths.pidFile, { force: true })
      print(io, { success: true, stopped: false, ...record }, args.json === true, [
        `pid ${pid} was already gone; removed ${paths.pidFile}`,
      ])
      return 0
    }
    if (code === 'EPERM') throw new CliError(`cannot stop pid ${pid}: ${message}`)
    throw error
  }

  const deadline = performance.now() + SHUTDOWN_TIMEOUT_MS
  while (performance.now() < deadline && !(await ended(deps, pid, base))) await sleep(100)
  if (!(await ended(deps, pid, base))) {
    // The record is the only handle on a process that is still holding both ports, so it stays
    // until the process is really gone.
    throw new CliError(
      `pid ${pid} has not stopped ${SHUTDOWN_TIMEOUT_MS / 1000}s after SIGTERM; ` +
        `${paths.pidFile} is kept, so \`tunnel stop\` can be tried again`,
    )
  }

  rmSync(paths.pidFile, { force: true })
  print(io, { success: true, stopped: true, ...record }, args.json === true, [
    `Stopped tunnel, pid ${pid}; removed ${paths.pidFile}`,
  ])
  return 0
}

/**
 * Whether the server ended, rather than only stopped answering. The process itself is the answer
 * wherever it can be asked: a server that has closed its listening socket but is still finishing
 * off a connection is still holding both ports, and saying it stopped would be a lie. Windows
 * cannot be asked (processAlive), so there the port it answered on is the next best thing.
 */
async function ended(deps: CliDeps, pid: number, base: string): Promise<boolean> {
  if (process.platform === 'win32') return (await health(deps, base)) === null
  return !processAlive(pid)
}
