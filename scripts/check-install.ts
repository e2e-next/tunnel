// The install budget. 3 packages = tunnel itself + hono + @hono/node-server, the
// admin port's two packages. Raising either number is a decision: make it in the
// change that needs it, and give the reason there.
const BUDGET = { bytes: 4_000_000, packages: 3 }

// Checks that the package works once packed and installed:
//
//   npm run check-install
//
// It builds and packs the package and installs the tarball into a throwaway
// directory, the way a user will get it. The installed tunnel --version has to
// print this version, what the install put in node_modules has to fit in
// BUDGET, and the built panel has to have come along. It prints a line for each
// check and exits 1 if one fails. It needs the network only to fetch the
// runtime dependencies, hono and @hono/node-server.
//
// Before it installs anything, the tarball has to hold exactly the files a
// release ships, no more and no fewer: package.json's files names whole
// directories, so a stray file in assets/ would otherwise go out unnoticed.
//
// The installed tunnel serve --help has to work as well, and tunnel agents has
// to print the guide for coding agents, which has to have come along too.
//
// So does the library entry: a script in the throwaway directory imports it
// from the installed package as a test would and has a script rule and a
// function rule answer, and a consumer that uses every name it exports has to
// type-check against the installed declarations.
//
// POSIX only: it runs .bin/tunnel through its shebang.
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { AGENTS_GUIDE, PACKAGE_ROOT, PANEL_STATIC_DIR, VERSION } from '../src/package-info.ts'

/** What `make panel` writes into PANEL_STATIC_DIR */
const PANEL_FILES = ['panel.js', 'panel.css', 'panel-InterVariable-latin.woff2']

/** All the smoke run of the library entry prints, when everything in it went right */
const SMOKE_PASSED =
  'tunnel-use: a script rule and a function rule answered, and stop() removed the directory'

const tmp = mkdtempSync(join(tmpdir(), 'tunnel-check-install-'))
try {
  // build empties dist/ before it compiles, so nothing a deleted source file
  // left there gets packed. tsc names each file it writes, on a TSFILE:
  // <absolute path> line, and those are the files of dist/ the tarball has to
  // hold, however many modules there are
  const built = build()
  const emitted = built
    .split('\n')
    .filter((line) => line.startsWith('TSFILE: '))
    .map((line) => relative(PACKAGE_ROOT, line.slice('TSFILE: '.length)))
  console.log(`🔨 tsc emitted ${emitted.length} files`)

  // Packed into tmp, so that no .tgz is left in the repository, and without
  // running prepack: it would only build again what was built just above, and
  // whatever a script writes to stdout comes out ahead of the --json result,
  // where JSON.parse would choke on it (npm's own > banner goes to stderr)
  const packed = execFileSync(
    'npm',
    ['pack', '--json', '--ignore-scripts', '--pack-destination', tmp],
    { cwd: PACKAGE_ROOT, encoding: 'utf8' },
  )
  const tarball: { filename: string; files: { path: string }[] } = JSON.parse(packed)[0]
  console.log(`📦 ${tarball.filename}: ${tarball.files.length} files`)

  // A tarball with a file too many or one too few is not worth installing
  const paths = tarball.files.map((file) => file.path)
  if (holdsExpectedFiles(paths, emitted)) {
    // npm installs into the nearest directory, this one or one above it, that
    // has a package.json or a node_modules, so without a package.json of its own
    // here it would install into whatever project it found above. --no-audit and
    // --no-fund keep it off the network but for fetching the runtime dependencies
    const install = join(tmp, 'install')
    mkdirSync(install)
    writeFileSync(join(install, 'package.json'), '{"private": true}\n')
    const args = ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock']
    execFileSync('npm', [...args, join(tmp, tarball.filename)], { cwd: install, stdio: 'inherit' })

    // The installed tunnel runs from the throwaway directory, where a tunnel that
    // looked for its package.json through the working directory would not find
    // the repository's. It gets an empty config directory of its own and no
    // TUNNEL_BASE: every command, --version and --help included, first works out
    // where the server is, which without TUNNEL_CONFIG_DIR walks up from the
    // working directory to a .tunnel/ and signals the pid in its tunnel.pid
    const config = join(tmp, 'config')
    mkdirSync(config)
    const env: NodeJS.ProcessEnv = { ...process.env, TUNNEL_CONFIG_DIR: config }
    delete env.TUNNEL_BASE
    const runInstalled = (args: string[]) =>
      spawnSync(join(install, 'node_modules', '.bin', 'tunnel'), args, {
        cwd: install,
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
      })

    const tunnel = runInstalled(['--version'])
    const expected = `tunnel ${VERSION}\n`
    if (tunnel.error) {
      fail(`the installed tunnel would not start: ${tunnel.error.message}`)
    } else if (tunnel.status !== 0 || tunnel.stdout !== expected) {
      const got = `${JSON.stringify(tunnel.stdout)} and exited ${tunnel.status}`
      fail(`the installed tunnel --version printed ${got}, not ${JSON.stringify(expected)} and 0`)
    } else {
      pass(`the installed tunnel --version printed ${expected.trimEnd()}`)
    }

    const nodeModules = join(install, 'node_modules')
    const bytes = bytesIn(nodeModules)
    const packages = packagesIn(nodeModules).sort()
    const s = packages.length === 1 ? '' : 's'
    budget(`${formatCount(bytes)} bytes installed`, bytes, BUDGET.bytes)
    budget(
      `${packages.length} package${s} installed (${packages.join(', ')})`,
      packages.length,
      BUDGET.packages,
    )

    // The built panel the admin port serves under /static/, packed through package.json's files
    // and found below the installed package, node_modules/<package.json's name>, where
    // PANEL_STATIC_DIR is below the repository
    const { name: packageName } = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'),
    )
    const panel = relative(PACKAGE_ROOT, PANEL_STATIC_DIR)
    for (const name of PANEL_FILES) {
      const file = join(panel, name)
      const installed = join(nodeModules, packageName, file)
      const size = existsSync(installed) ? lstatSync(installed).size : 0
      if (size > 0) pass(`the installed package has ${file}, ${formatCount(size)} bytes`)
      else fail(`the installed package has ${existsSync(installed) ? 'an empty' : 'no'} ${file}`)
    }

    // Every module the command line loads, built and installed; what the page
    // says is the golden files' business
    const help = runInstalled(['serve', '--help'])
    if (help.error) fail(`the installed tunnel would not start: ${help.error.message}`)
    else if (help.status !== 0)
      fail(`the installed tunnel serve --help exited ${help.status}, not 0`)
    else pass('the installed tunnel serve --help exited 0')

    // The guide for coding agents, packed through package.json's files and found
    // below the installed package where AGENTS_GUIDE is below the repository
    const agents = runInstalled(['agents'])
    if (agents.error) {
      fail(`the installed tunnel would not start: ${agents.error.message}`)
    } else {
      const first = agents.stdout.split('\n')[0] ?? ''
      if (agents.status === 0 && first.startsWith('# AGENTS.md')) {
        pass(`the installed tunnel agents printed ${first}`)
      } else {
        const got = `${JSON.stringify(first)} first and exited ${agents.status}`
        fail(`the installed tunnel agents printed ${got}, not a line starting # AGENTS.md and 0`)
      }
    }

    // The library entry, imported by the package's name as a test imports it, which goes through
    // package.json's exports: startTunnel() makes its temporary directory in a TMPDIR of this
    // run's own, and the script rule runs in the installed script-worker.js. What went wrong it
    // prints on stderr, which comes straight through
    const smokeTmp = join(tmp, 'smoke-tmp')
    mkdirSync(smokeTmp)
    writeFileSync(join(install, 'smoke.mjs'), smokeScript())
    const smoke = spawnSync(process.execPath, ['smoke.mjs'], {
      cwd: install,
      env: { ...env, TMPDIR: smokeTmp },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      timeout: 30_000,
    })
    if (smoke.error) {
      fail(`the smoke run of the installed entry did not finish: ${smoke.error.message}`)
    } else if (smoke.status === 0 && smoke.stdout === `${SMOKE_PASSED}\n`) {
      pass(SMOKE_PASSED)
    } else {
      const got = `${JSON.stringify(smoke.stdout)} and exited ${smoke.status ?? smoke.signal}`
      fail(`the smoke run of the installed entry printed ${got}, not the line it prints and 0`)
    }

    // The installed declarations, as a TypeScript project that depends on the package reads them,
    // with this repository's tsc and @types/node: no skipLibCheck, so every .d.ts the consumer
    // reaches is checked too. tsc prints what it finds wrong
    writeFileSync(join(install, 'consumer.mts'), consumerSource())
    const compilerOptions = {
      target: 'es2022',
      lib: ['es2022'],
      module: 'nodenext',
      moduleResolution: 'nodenext',
      strict: true,
      noEmit: true,
      types: ['node'],
      typeRoots: [join(PACKAGE_ROOT, 'node_modules', '@types')],
    }
    const tsconfig = { compilerOptions, files: ['consumer.mts'] }
    writeFileSync(join(install, 'tsconfig.json'), `${JSON.stringify(tsconfig, null, 2)}\n`)
    const tsc = join(PACKAGE_ROOT, 'node_modules', '.bin', 'tsc')
    const checked = spawnSync(tsc, ['-p', 'tsconfig.json'], { cwd: install, stdio: 'inherit' })
    if (checked.error) {
      fail(`this repository's tsc would not start: ${checked.error.message}`)
    } else if (checked.status !== 0) {
      fail(`a consumer of every exported name does not type-check: tsc exited ${checked.status}`)
    } else {
      pass('a consumer of every exported name type-checks against the installed declarations')
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

/**
 * npm run build with tsc's --listEmittedFiles, and what it wrote on stdout, where the TSFILE: lines
 * are. When the build fails, what tsc said about it is in that output too, among the TSFILE: lines
 * of the files it wrote all the same: that is printed without them, as a build on its own prints
 * it, and the run stops there.
 */
function build(): string {
  try {
    return execFileSync('npm', ['run', 'build', '--', '--listEmittedFiles'], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    })
  } catch (error) {
    const { stdout, status, signal } = error as {
      stdout?: string | null
      status?: number | null
      signal?: string | null
    }
    // npm never ran: nothing to show but the error itself
    if (typeof stdout !== 'string') throw error
    const said = stdout.split('\n').filter((line) => !line.startsWith('TSFILE: '))
    process.stdout.write(said.join('\n'))
    throw new Error(`npm run build exited ${status ?? signal}`)
  }
}

/**
 * Whether the tarball holds exactly the files a release ships, given its paths as npm pack lists
 * them: the three npm adds by itself, the guide, the built panel, and every file the build emitted,
 * relative to the package root: a dist/<name>.js and a dist/<name>.d.ts for each module. Worked out
 * from the constants and from what tsc reported, never written out by hand. It prints a ❌ line,
 * which fails the run, for each path over and each one missing, or a ✅ line when there is neither.
 */
function holdsExpectedFiles(packed: string[], emitted: string[]): boolean {
  const panel = relative(PACKAGE_ROOT, PANEL_STATIC_DIR)
  const expected = [
    'package.json',
    'README.md',
    'LICENSE',
    relative(PACKAGE_ROOT, AGENTS_GUIDE),
    ...PANEL_FILES.map((name) => `${panel}/${name}`),
    ...emitted,
  ].sort()
  const over = [...packed].sort().filter((path) => !expected.includes(path))
  const missing = expected.filter((path) => !packed.includes(path))
  for (const path of over) fail(`in the tarball but not expected: ${path}`)
  for (const path of missing) fail(`expected in the tarball but missing: ${path}`)
  if (over.length > 0 || missing.length > 0) return false
  pass(`the tarball holds exactly the ${expected.length} expected files`)
  return true
}

/**
 * The bytes of the regular files below node_modules, by lstat: what the files
 * hold rather than du's blocks, which vary with the file system. Symlinks, the
 * ones in .bin, are neither counted nor followed, and neither is
 * .package-lock.json, npm's own record of the install.
 */
function bytesIn(nodeModules: string): number {
  const record = join(nodeModules, '.package-lock.json')
  let bytes = 0
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && path !== record) bytes += lstatSync(path).size
    }
  }
  walk(nodeModules)
  return bytes
}

/**
 * The packages in node_modules, each named by its path below it: every
 * directory there whose name does not start with a dot, those in an @scope
 * directory one level down instead, and the same again for the packages in
 * each package's own node_modules.
 */
function packagesIn(nodeModules: string): string[] {
  const packages: string[] = []
  for (const name of subdirectories(nodeModules)) {
    const names = name.startsWith('@')
      ? subdirectories(join(nodeModules, name)).map((inner) => `${name}/${inner}`)
      : [name]
    for (const pkg of names) {
      packages.push(pkg)
      const nested = join(nodeModules, pkg, 'node_modules')
      if (existsSync(nested)) {
        packages.push(...packagesIn(nested).map((inner) => `${pkg}/node_modules/${inner}`))
      }
    }
  }
  return packages
}

/** The directories in dir whose names do not start with a dot */
function subdirectories(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
}

/**
 * smoke.mjs: tunnel-use imported by its name from the installed package, a script rule and a
 * function rule each answering a request that check() sends through the proxy port,
 * waitForRequest() finding the function rule's, and stop() removing the temporary directory
 * startTunnel() made. It prints SMOKE_PASSED and nothing else when all of that went right, and
 * otherwise what went wrong, on stderr, and exits 1. Nothing it sends leaves the machine: a rule
 * answers each request, and under replay one no rule answers would be a 404
 */
function smokeScript(): string {
  return `import { existsSync } from 'node:fs'
import { setLogSink, startTunnel } from 'tunnel-use'

setLogSink(() => {})
const wrong = []
const tunnel = await startTunnel({ proxyHost: '127.0.0.1' })
try {
  await tunnel.setConfig({ default_mode: 'replay' })
  const script = 'function handler(ctx) {\\n  return { from: "script" }\\n}\\n'
  await tunnel.setRule({ key: 'GET:smoke.test/script', mode: 'script', script })
  await tunnel.setRule({ key: 'GET:smoke.test/function', handler: () => ({ from: 'function' }) })
  for (const from of ['script', 'function']) {
    const answer = await tunnel.check('GET', 'http://smoke.test/' + from)
    const body = answer.body.toString()
    if (answer.status !== 200 || body !== '{"from": "' + from + '"}') {
      wrong.push('the ' + from + ' rule answered ' + answer.status + ': ' + body)
    }
  }
  const waited = await tunnel.waitForRequest({ key: 'GET:smoke.test/function', timeout: 5 })
  if (waited.timed_out) wrong.push('waitForRequest timed out')
} finally {
  await tunnel.stop()
}
if (existsSync(tunnel.configDir)) wrong.push('stop() left ' + tunnel.configDir + ' behind')
if (wrong.length === 0) {
  console.log(${JSON.stringify(SMOKE_PASSED)})
} else {
  for (const line of wrong) console.error(line)
  process.exitCode = 1
}
`
}

/**
 * consumer.mts: test code that depends on the package, type-checked and never run. It imports
 * every name the entry exports, the types into a tuple; sets a stored rule and a function rule
 * whose handler reads ctx.json and ctx.state, awaits ctx.recorded() and calls ctx.reply(); reads
 * waitForRequest()'s timed_out and seqs and a TunnelError's status and detail; and stops with
 * await using. Its last line has to be an error: were the declarations to type an option as any,
 * its @ts-expect-error would go unused, which tsc reports
 */
function consumerSource(): string {
  return `import {
  setLogSink,
  startTunnel,
  TunnelError,
  type AggregateRow,
  type CheckAnswer,
  type CheckOptions,
  type DefaultMode,
  type Exchange,
  type ExchangeSummary,
  type Fault,
  type FunctionRulePatch,
  type Handler,
  type HandlerContext,
  type Json,
  type LogRecord,
  type LogSink,
  type Recorded,
  type RecordingRow,
  type RecordingStatus,
  type ReplayStrategy,
  type Reply,
  type RequestFilters,
  type RequestList,
  type Rule,
  type RulePatch,
  type Scenario,
  type Settings,
  type SettingsPatch,
  type SslProxying,
  type StartOptions,
  type Status,
  type Tunnel,
  type TunnelMode,
  type ValidationIssue,
  type WaitOptions,
  type WaitResult,
} from 'tunnel-use'

export type Exported = [
  StartOptions,
  Tunnel,
  Status,
  RecordingStatus,
  Handler,
  HandlerContext,
  Reply,
  Recorded,
  Json,
  Rule,
  RulePatch,
  FunctionRulePatch,
  Scenario,
  Settings,
  SslProxying,
  SettingsPatch,
  RequestFilters,
  RequestList<ExchangeSummary>,
  RequestList<AggregateRow>,
  Exchange,
  WaitOptions,
  WaitResult,
  CheckOptions,
  CheckAnswer,
  ExchangeSummary,
  AggregateRow,
  RecordingRow,
  ValidationIssue,
  LogRecord,
  LogSink,
  TunnelMode,
  ReplayStrategy,
  Fault,
  DefaultMode,
]

const previous: LogSink = setLogSink((record: LogRecord) => void record)
try {
  await using tunnel = await startTunnel({ proxyHost: '127.0.0.1' })
  const stored: Rule = await tunnel.setRule({
    key: 'GET:api.test/user',
    mode: 'json',
    json_response: { id: 12345678901234567890n },
  })
  const handler: Handler = async (ctx: HandlerContext) => {
    ctx.state.calls = (ctx.state.calls ?? 0) + 1
    const recorded: Recorded | null = await ctx.recorded()
    if (recorded !== null) return recorded
    return ctx.reply({ echo: ctx.json, calls: ctx.state.calls }, 201, { 'x-from': 'handler' })
  }
  await tunnel.setRule({ key: 'POST:api.test/echo', handler })
  const answer: CheckAnswer = await tunnel.check('POST', 'http://api.test/echo', { body: '{}' })
  const waited: WaitResult = await tunnel.waitForRequest({ key: 'POST:api.test/echo', timeout: 5 })
  const seqs: number[] = waited.timed_out ? [] : waited.seqs
  console.log(stored.key, answer.status, seqs)
} catch (error) {
  if (!(error instanceof TunnelError)) throw error
  const status: number = error.status
  const detail: string | ValidationIssue[] = error.detail
  console.log(status, detail)
} finally {
  setLogSink(previous)
}

// @ts-expect-error a port is a number
startTunnel({ proxyPort: '0' })
`
}

/**
 * A ✅ line when what was measured, used, is within limit. When it is not, a ❌
 * line that says by how much it is over, which fails the run.
 */
function budget(what: string, used: number, limit: number): void {
  if (used <= limit) pass(`${what}, within the budget of ${formatCount(limit)}`)
  else fail(`${what}, ${formatCount(used - limit)} over the budget of ${formatCount(limit)}`)
}

function pass(line: string): void {
  console.log(`✅ ${line}`)
}

/** Prints the line and fails the run */
function fail(line: string): void {
  console.log(`❌ ${line}`)
  // Set rather than passed to process.exit(), which can cut off output still on its way down a pipe
  process.exitCode = 1
}

/** 4000000 → 4,000,000 */
function formatCount(count: number): string {
  return count.toLocaleString('en-US')
}
