// The commands that configure what the endpoints answer (ls, set, rm, apply, export, pack, reset,
// mode, session and ssl): each is a call or two to the admin API and the lines that say what came
// of it. cli.ts's command table names each handler, which takes (args, io, deps); the admin API,
// the files a user names and printing come from cli-common.ts.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Args } from './cli-args.ts'
import {
  api,
  call,
  type CliDeps,
  CliError,
  type CliIo,
  expandScenario,
  isSystemError,
  keyFor,
  print,
  compareCodePoints,
  displayPath,
  readJsonArg,
  readUserText,
  responseHeaders,
  saveSslPolicy,
  sessions,
  type SslPolicy,
  sslPatch,
  sslPolicy,
  userPath,
} from './cli-common.ts'
import { isJsonObject, type JsonObject, type JsonValue } from './json.ts'

/** A rule as the admin API answers with it: what ls and set print of one */
interface Mock {
  key: string
  mode: string
  status_code: number
  enabled: boolean
  fault?: string
  description: string
}

/** tunnel ls: every rule configured, one line each, under the line that says where the server
 *  keeps its config, state and data */
export async function cmdLs(args: Args, io: CliIo, deps: CliDeps): Promise<void> {
  const base = args.base as string
  const data = await call(deps, 'GET', api(base, '/mocks'))
  const { mocks } = data as unknown as { mocks: Mock[] }
  if (args.json !== true) {
    const health = (await call(deps, 'GET', api(base, '/health'))) as JsonObject
    io.stdout.write(
      `config: ${health.config_dir}  state: ${health.state_dir}  data: ${health.data_dir}\n`,
    )
  }
  const lines = mocks.map(
    (mock) =>
      `${mock.key.padEnd(40)} ${mock.mode.padEnd(7)} ${String(mock.status_code).padEnd(4)}` +
      (mock.enabled ? '' : ' [disabled]') +
      // A rule that answers with a fault answers nothing else, so the listing has to say so: its
      // mode alone would be a lie
      ((mock.fault ?? 'none') === 'none' ? '' : `  [fault: ${mock.fault}]`) +
      (mock.description ? `  ${mock.description}` : ''),
  )
  print(io, data, args.json === true, lines.length > 0 ? lines : ['(no mock is configured yet)'])
}

/**
 * tunnel set: one rule, with only the fields given changed. At most one source says where the
 * answer comes from (-d, --script, --target, --replay), and it implies the mode unless --mode says
 * otherwise. The script is sent as text: the admin API compiles it, the CLI does not.
 */
export async function cmdSet(args: Args, io: CliIo, deps: CliDeps): Promise<void> {
  const fields: JsonObject = { key: keyFor(args.method as string, args.path as string) }
  const jsonBody = args.json_body as string | null
  const script = args.script as string | null
  const target = args.target as string | null
  const sources = [jsonBody, script, target].filter((source) => source !== null).length
  if (sources + (args.replay === true ? 1 : 0) > 1) {
    throw new CliError('give only one of -d/--data, --script, --target and --replay')
  }

  // What the first source implies; an explicit --mode, written below, wins over it
  const imply = (mode: string): void => {
    if (!Object.hasOwn(fields, 'mode')) fields.mode = mode
  }
  if (jsonBody !== null) {
    fields.json_response = readJsonArg(deps, jsonBody)
    imply('json')
  }
  if (script !== null) {
    if (!existsSync(userPath(deps, script))) {
      throw new CliError(`no such script file: ${displayPath(script)}`)
    }
    fields.script = readUserText(deps, script)
    imply('script')
  }
  if (target !== null) {
    fields.target = target
    imply('passthrough')
  }
  if (args.replay === true) imply('replay')

  // Both are replay's, but neither implies it: a rule already in replay mode can have its strategy
  // or its session changed without saying so again
  if (args.strategy !== null) fields.replay_strategy = args.strategy as string
  if (args.session !== null) fields.replay_session = args.session as string

  // None of these picks a mode either: they shape whatever the mode answers
  if (args.merge !== null) {
    const patch = readJsonArg(deps, args.merge as string)
    if (!isJsonObject(patch)) {
      throw new CliError(
        '--merge takes a JSON object, since it is merged field by field into the one that comes back',
      )
    }
    fields.merge_json = patch
  }
  const headers = responseHeaders(
    args.header as readonly string[] | null,
    args.content_type as string | null,
  )
  if (headers !== null) fields.headers = headers
  if (args.fault !== null) fields.fault = args.fault as string
  // Hang's own, but it does not imply it: a rule already hanging can be retimed without saying
  // --fault again, the way --strategy works for replay
  if (args.fault_seconds !== null) fields.fault_seconds = args.fault_seconds as number

  if (args.mode !== null) fields.mode = args.mode as string
  if (args.status !== null) fields.status_code = args.status as number
  if (args.delay !== null) fields.response_delay = args.delay as number
  if (args.desc !== null) fields.description = args.desc as string
  if (args.enabled !== null) fields.enabled = args.enabled as boolean

  if (Object.keys(fields).length === 1) {
    throw new CliError(
      'nothing to change: pass at least one of -d, --script, --target, --replay, --merge, -H, ' +
        '--content-type, --fault, --fault-seconds, --mode, --status, --delay, --desc',
    )
  }

  const data = await call(deps, 'PATCH', api(args.base as string, '/mocks'), { json: fields })
  const { mock } = data as unknown as { mock: Mock }
  print(io, data, args.json === true, [
    `Configured ${mock.key}  mode=${mock.mode} status=${mock.status_code}`,
  ])
}

/** tunnel rm: deletes one endpoint's rule */
export async function cmdRm(args: Args, io: CliIo, deps: CliDeps): Promise<void> {
  const key = keyFor(args.method as string, args.path as string)
  const data = await call(deps, 'DELETE', api(args.base as string, '/mocks'), { params: { key } })
  print(io, data, args.json === true, [`Deleted ${key}`])
}

/** tunnel apply: a scenario file's rules, all or none, with its script_file and json_file read in
 *  here, since the server reads no files of yours */
export async function cmdApply(args: Args, io: CliIo, deps: CliDeps): Promise<void> {
  const scenario = expandScenario(deps, args.file as string)
  if (args.replace === true) scenario.replace = true
  const data = await call(deps, 'POST', api(args.base as string, '/mocks/apply'), {
    json: scenario,
  })
  const { applied, replaced } = data as unknown as { applied: string[]; replaced: boolean }
  const lines = [
    `Applied ${applied.length} mocks` + (replaced ? ' (the previous ones were cleared first)' : ''),
    ...applied.map((key) => `  ${key}`),
  ]
  print(io, data, args.json === true, lines)
}

/** tunnel export: the rules configured now as a scenario file, which apply takes back */
export async function cmdExport(args: Args, io: CliIo, deps: CliDeps): Promise<void> {
  // The global settings stay out by default: a scenario file goes into a repository, and it
  // carries a test case's mocks, not the run's settings
  const params = args.with_config === true ? { config: 'true' } : null
  const data = (await call(deps, 'GET', api(args.base as string, '/export'), {
    params,
  })) as JsonObject
  const note = `Exported ${(data.mocks as JsonValue[]).length} mocks`
  writeScenario(io, deps, data, args.out as string | null, note)
}

/**
 * tunnel pack: a scenario with its script_file and json_file inlined, so it can be shipped. A test
 * case that runs on a device applies its scenario through the admin API, and the server reads no
 * files of yours: what the scenario needs has to travel inside it. This is that scenario, ready to
 * go into the test bundle.
 */
export function cmdPack(args: Args, io: CliIo, deps: CliDeps): void {
  const scenario = expandScenario(deps, args.file as string)
  // expandScenario lets through a list, none, or an empty object or string; anything but a list
  // counts as no mocks
  const { mocks } = scenario
  const note = `Packed ${Array.isArray(mocks) ? mocks.length : 0} mocks`
  writeScenario(io, deps, scenario, args.out as string | null, note)
}

/**
 * A scenario to the file out names, relative to deps.cwd, or to stdout when none is named. The
 * directory is created on the way, the way `recordings export` creates its tree:
 * `-o bundle/case.json` is how a test bundle is assembled, and the bundle directory is usually not
 * there yet. What still cannot be written is one line saying so, not a stack trace; the sentence
 * after the file is written names out as it was given.
 */
function writeScenario(
  io: CliIo,
  deps: CliDeps,
  scenario: JsonObject,
  out: string | null,
  note: string,
): void {
  const text = JSON.stringify(scenario, null, 2)
  if (!out) {
    io.stdout.write(`${text}\n`)
    return
  }
  const file = userPath(deps, out)
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${text}\n`)
  } catch (error) {
    // A system error is one line; anything else is a bug, and stays a stack trace
    if (!isSystemError(error)) throw error
    throw new CliError(`could not write ${displayPath(out)}: ${error.message}`)
  }
  io.stdout.write(`${note} to ${out}\n`)
}

/** tunnel reset: what one test case leaves for the next, cleared: the script state and the replay
 *  counters of every rule, or of the one endpoint named, and with --requests the request log */
export async function cmdReset(args: Args, io: CliIo, deps: CliDeps): Promise<void> {
  const base = args.base as string
  // With neither flag it is the script state alone, which is the one a test suite resets between
  // cases more often than anything else
  const resetState = args.state === true || args.requests !== true
  const lines: string[] = []
  if (resetState) {
    // One endpoint's only when both are given, and neither is empty
    const method = args.method as string | null
    const path = args.path as string | null
    const key = method && path ? keyFor(method, path) : null
    const data = await call(deps, 'POST', api(base, '/state/reset'), {
      json: key === null ? {} : { key },
    })
    const { cleared } = data as { cleared: string[] }
    lines.push(
      `Reset the script state and replay counters of: ${cleared.join(', ') || '(nothing had any)'}`,
    )
  }
  if (args.requests === true) {
    const data = await call(deps, 'POST', api(base, '/requests/clear'))
    // The seq it stopped at: `tunnel requests --since` picks up from there
    const { last_seq: lastSeq } = data as { last_seq: number }
    lines.push(`Cleared the request log at seq ${lastSeq}`)
  }
  print(io, { success: true }, args.json === true, lines)
}

// ---- The global mode and the current session ----

/** What the global mode means for an endpoint with no rule of its own. A mode not here is
 *  printed as it is */
const MODE_NOTES = new Map([
  ['passthrough', 'an endpoint with no rule of its own reaches the server the client was calling'],
  [
    'replay',
    'an endpoint with no rule of its own is answered from the ' +
      'recordings, or 404 when nothing was recorded for it',
  ],
])

/** GET /sessions' sessions: how many recordings each session on disk holds */
type Counts = Readonly<Record<string, number>>

/** How many recordings session holds, 0 for one nobody has recorded into yet: that is not a
 *  directory, and so not in the counts. Only the object's own keys count, since a session may be
 *  called constructor */
function held(counts: Counts, session: string): number {
  return Object.hasOwn(counts, session) ? counts[session]! : 0
}

/** `acct_a (12 recordings)`, a session and what it holds. One with nothing in it is still where
 *  this run reads and writes, and it says 0 */
function counted(session: string, counts: Counts): string {
  return `${session} (${held(counts, session)} recordings)`
}

/** tunnel mode: how endpoints with no rule are answered; no argument prints how they are now */
export async function cmdMode(args: Args, io: CliIo, deps: CliDeps): Promise<void> {
  const base = args.base as string
  // Both in one PATCH, so that `mode replay --session acct_a` is the single command a test run
  // needs: answer from the recordings, and from which ones
  const fields: JsonObject = {}
  if (args.mode !== null) fields.default_mode = args.mode as string
  if (args.session !== null) fields.session = args.session as string

  let config: JsonObject
  if (Object.keys(fields).length > 0) {
    const data = await call(deps, 'PATCH', api(base, '/config'), { json: fields })
    config = (data as { config: JsonObject }).config
  } else {
    config = (await call(deps, 'GET', api(base, '/config'))) as JsonObject
  }

  const { default_mode: mode, session } = config as { default_mode: string; session: string }
  const { sessions: counts } = (await sessions(deps, base)) as { sessions: Counts }
  print(io, config, args.json === true, [
    `${mode} · session ${counted(session, counts)}`,
    `  ${MODE_NOTES.get(mode) ?? mode}`,
  ])
}

/** tunnel session: which session this run records into and replays from; no name prints it, and
 *  what the other sessions on disk hold */
export async function cmdSession(args: Args, io: CliIo, deps: CliDeps): Promise<void> {
  const base = args.base as string
  const name = args.name as string | null
  if (name !== null) await call(deps, 'PATCH', api(base, '/config'), { json: { session: name } })

  const data = await sessions(deps, base)
  const { session: current, sessions: counts } = data as { session: string; sessions: Counts }
  const headline = name !== null ? 'Switched to session' : 'Session'
  const lines = [`${headline} ${counted(current, counts)}`]
  if (held(counts, current) === 0) {
    // Switching to an empty session is allowed, and in replay mode every endpoint without a rule
    // then 404s, so it is worth one line here
    lines.push('  nothing is recorded there yet; `tunnel record start` files calls into it')
  }
  // By name, in compareCodePoints's order
  for (const [other, count] of Object.entries(counts).sort(([a], [b]) => compareCodePoints(a, b))) {
    if (other !== current) lines.push(`  ${other}: ${count}`)
  }
  print(io, data, args.json === true, lines)
}

// ---- The SSL Proxying Locations ----

/** The switch and the two lists */
function sslLines(policy: SslPolicy): string[] {
  return [
    `SSL proxying is ${policy.enabled ? 'on' : 'off'}`,
    `  include: ${policy.include.join(', ') || '(empty: no HTTPS is decrypted)'}`,
    `  exclude: ${policy.exclude.join(', ') || '(none)'}`,
  ]
}

/** tunnel ssl ls: both lists and the switch, as they stand */
export async function cmdSslLs(args: Args, io: CliIo, deps: CliDeps): Promise<void> {
  const policy = await sslPolicy(deps, args.base as string)
  // A copy, as saveSslPolicy sends one: TypeScript takes an object literal for JSON and an
  // interface not
  print(io, { ...policy }, args.json === true, sslLines(policy))
}

/** Patterns added to or taken out of one of the two lists, which goes back whole with the other,
 *  then both printed */
async function sslEdit(
  args: Args,
  io: CliIo,
  deps: CliDeps,
  which: 'include' | 'exclude',
  add: boolean,
): Promise<void> {
  const base = args.base as string
  const patterns = args.patterns as readonly string[]
  const policy = sslPatch(await sslPolicy(deps, base), which, patterns, add)
  const saved = await saveSslPolicy(deps, base, policy)
  print(io, { ...saved }, args.json === true, sslLines(saved))
}

/** tunnel ssl add: decrypt these hosts */
export function cmdSslAdd(args: Args, io: CliIo, deps: CliDeps): Promise<void> {
  return sslEdit(args, io, deps, 'include', true)
}

/** tunnel ssl rm: stop decrypting these hosts */
export function cmdSslRm(args: Args, io: CliIo, deps: CliDeps): Promise<void> {
  return sslEdit(args, io, deps, 'include', false)
}

/** tunnel ssl exclude add: never decrypt these hosts */
export function cmdSslExcludeAdd(args: Args, io: CliIo, deps: CliDeps): Promise<void> {
  return sslEdit(args, io, deps, 'exclude', true)
}

/** tunnel ssl exclude rm: drop these from the exclude list */
export function cmdSslExcludeRm(args: Args, io: CliIo, deps: CliDeps): Promise<void> {
  return sslEdit(args, io, deps, 'exclude', false)
}

/** tunnel ssl on / off: the master switch over both lists, which stay as they are. Which of the
 *  two is the command table's defaults, enabled true or false */
export async function cmdSslSwitch(args: Args, io: CliIo, deps: CliDeps): Promise<void> {
  const base = args.base as string
  const policy = await sslPolicy(deps, base)
  policy.enabled = args.enabled as boolean
  const saved = await saveSslPolicy(deps, base, policy)
  print(io, { ...saved }, args.json === true, sslLines(saved))
}
