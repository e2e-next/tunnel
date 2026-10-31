// The tunnel command's argument parser: parsing, the usage line and the help page, and the usage
// error. Users, scripts and the README read their wording and layout, so they stay exactly as they
// are: tests/cli-args.test.ts holds the parser to the 44 help pages and the 92 command lines in
// tests/fixtures/cli-help/.
//
// Only what the command table uses is here: the actions store, store_true, store_false,
// store_const, append, version and help; nargs of one, '?' and '+'; subcommands under
// subcommands; one mutually exclusive group; no colour.
//
// It knows none of tunnel's commands: src/cli.ts hands it the command table. At run time it
// imports errors.ts alone.
import type { Writable } from 'node:stream'
import { repr } from './errors.ts'

/** A parsed value: a string, an int or a float, a flag, what append or nargs='+' collected, or
 *  null */
export type ArgValue = string | number | boolean | readonly string[] | null
/** The parsed arguments, keyed by dest (admin_port, json_body, requests_command,
 *  _base_default…) */
export type Args = Readonly<Record<string, ArgValue>>

export interface OptionSpec {
  flags: readonly string[] // ['-d', '--data'], ['--admin-port', '--port']
  dest?: string // when not given: the first long flag less its dashes, - as _
  action?: 'store' | 'store_true' | 'store_false' | 'store_const' | 'append' | 'version'
  type?: 'int' | 'float' // a string when not given; read with parseIntArg() and parseFloatArg()
  choices?: readonly string[]
  /** When not given: null for store and append, false for store_true, true for store_false */
  default?: ArgValue
  const?: ArgValue // store_const's value
  required?: boolean
  metavar?: string
  help?: string // what the help page says of it; --enable and --disable have none
  version?: string // what action 'version' prints
  /** On the root: an option every level takes, with its default on the root alone */
  everyLevel?: boolean
}

export interface PositionalSpec {
  dest: string
  nargs?: '?' | '+' // exactly one when not given
  type?: 'int' | 'float'
  choices?: readonly string[]
  metavar?: string
  default?: ArgValue
  help?: string
}

export interface CommandSpec<H> {
  /** 'tunnel' for the root; a level's prog is the path from it ('tunnel ssl exclude add') */
  name: string
  help?: string // its line on the parent's page
  description?: string
  options?: readonly OptionSpec[]
  positionals?: readonly PositionalSpec[]
  exclusive?: readonly { required: boolean; options: readonly OptionSpec[] }[]
  subcommands?: { dest: string; required: boolean; commands: readonly CommandSpec<H>[] }
  /** The level's defaults: ssl on / off's enabled, the root's _base_default */
  defaults?: Readonly<Record<string, ArgValue>>
  /** The command the level runs: a leaf has one, and so has requests, which runs without its
   *  subcommand too */
  handler?: H
}

/** A usage error: the parser's error, which goes to stderr with exit code 1 */
export class UsageError extends Error {
  override name = 'UsageError'
  /** The level that failed, as its usage names it ('tunnel set'); the top level for an
   *  unrecognized argument */
  readonly prog: string
  /** That level's usage, "usage: …\n" */
  readonly usage: string
  constructor(prog: string, usage: string, message: string) {
    super(message)
    this.prog = prog
    this.usage = usage
  }

  /** What goes to stderr: the usage, then `{prog}: error: {message}` */
  text(): string {
    return `${this.usage}${this.prog}: error: ${this.message}\n`
  }
}

export type Parsed<H> =
  | { kind: 'run'; args: Args; handler: H }
  | { kind: 'help'; text: string } // the whole page of the level -h or --help was given at
  | { kind: 'version'; text: string } // `tunnel ${VERSION}\n`

export interface Parser<H> {
  /** Throws a UsageError for a usage error; reads and writes no stream */
  parse(argv: readonly string[]): Parsed<H>
  /** The top level's help page */
  formatHelp(): string
  /** The subcommand path of every level, [] for the top one: the help pages there are */
  paths(): string[][]
}

/** The Unicode white space outside ASCII. parseIntArg() and parseFloatArg() read these as a space; inside
 *  ASCII they take ' \t\n\v\f\r' alone, not \x1c to \x1f */
const UNICODE_SPACE = /[\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/

/** The value of a decimal digit outside ASCII. Unicode only assigns them in runs of ten, 0 to 9,
 *  so it is the distance from the start of the run, mod 10 */
function digitValue(char: string): number {
  const code = char.codePointAt(0)!
  let zero = code
  while (/\p{Nd}/u.test(String.fromCodePoint(zero - 1))) zero--
  return (code - zero) % 10
}

/** What parseIntArg() and parseFloatArg() make of the text before they read it: white space outside ASCII
 *  becomes a space, a decimal digit outside ASCII the ASCII one, and anything else outside ASCII
 *  a '?', which no number takes */
function toAscii(text: string): string {
  return text.replace(/[^\x00-\x7e]/gu, (char) => {
    if (UNICODE_SPACE.test(char)) return ' '
    return /\p{Nd}/u.test(char) ? String(digitValue(char)) : '?'
  })
}

const SPACE = '[ \\t\\n\\v\\f\\r]*'
const DIGITS = '\\d+(?:_\\d+)*' // single underscores between digits, as in 1_000
const INT = new RegExp(`^${SPACE}([+-]?${DIGITS})${SPACE}$`)
const FLOAT = new RegExp(
  `^${SPACE}([+-]?(?:(?:${DIGITS})?\\.${DIGITS}|${DIGITS}\\.?)(?:[eE][+-]?${DIGITS})?)${SPACE}$`,
)
const SPECIAL_FLOAT = new RegExp(`^${SPACE}([+-]?)(inf|infinity|nan)${SPACE}$`, 'i')

/** text as a whole number in base 10, or null when it is not one: ' 7 ', '+3', '007' and
 *  '1_000' are numbers, '0x10' and '1.5' are not */
export function parseIntArg(text: string): number | null {
  const match = INT.exec(toAscii(text))
  // || 0: an integer has no negative zero, so '-0' is 0
  return match === null ? null : Number(match[1]!.replaceAll('_', '')) || 0
}

/** text as a float, or null when it is not one: '1e400' is Infinity, 'nan' is NaN, '1.' and '.5'
 *  are numbers */
export function parseFloatArg(text: string): number | null {
  const ascii = toAscii(text)
  const special = SPECIAL_FLOAT.exec(ascii)
  if (special !== null) {
    if (special[2]!.toLowerCase() === 'nan') return NaN
    return special[1] === '-' ? -Infinity : Infinity
  }
  const match = FLOAT.exec(ascii)
  return match === null ? null : Number(match[1]!.replaceAll('_', ''))
}

/**
 * The width help and usage are laid out in: the terminal's columns, less 2. That is COLUMNS when
 * parseIntArg() reads a positive number in it, else the columns of stdout when it is a terminal, else
 * 80.
 */
export function helpWidth(
  env: Readonly<Record<string, string | undefined>>,
  stdout: Writable,
): number {
  const fromEnv = parseIntArg(env.COLUMNS ?? '')
  const terminal = stdout as Writable & { isTTY?: boolean; columns?: number }
  let columns = 80
  if (fromEnv !== null && fromEnv > 0) columns = fromEnv
  // A terminal that says 0 columns gets the fallback too
  else if (terminal.isTTY === true) columns = terminal.columns || 80
  return columns - 2
}

/** SUPPRESS as a default: the action puts nothing in the namespace until it is given */
const SUPPRESS: unique symbol = Symbol('SUPPRESS')
/** The nargs of a level's subcommands: a subcommand's name and everything after it */
const PARSER = 'A...'

/** One action: an option, a positional, or a level's subcommands */
interface Action<H> {
  optionStrings: readonly string[] // [] for a positional
  dest: string | null // null for -h and --version, which never reach the namespace
  kind: 'store' | 'store_const' | 'append' | 'help' | 'version' | 'parsers'
  nargs: null | '?' | '+' | 0 | typeof PARSER // null is exactly one
  type: 'int' | 'float' | null
  choices: readonly string[] | null
  default: ArgValue | typeof SUPPRESS
  const: ArgValue
  required: boolean
  help: string | null
  metavar: string | null
  version: string // what --version prints; '' for every other action
  parsers: ReadonlyMap<string, Level<H>> // the subcommands of a 'parsers' action, by name
  choicesActions: readonly Action<H>[] // their lines in the help
}

/** One level of the command: the root, or a subcommand at any depth */
interface Level<H> {
  path: readonly string[]
  prog: string
  description: string | null
  actions: readonly Action<H>[] // in the order buildLevel adds them
  optionStringActions: ReadonlyMap<string, Action<H>> // in the order the flags were added
  groups: readonly { required: boolean; actions: readonly Action<H>[] }[] // mutually exclusive
  defaults: Readonly<Record<string, ArgValue>>
  handler: H | undefined
  children: readonly Level<H>[]
}

/** An Action with the defaults for whatever fields does not set */
function makeAction<H>(fields: Partial<Action<H>> & Pick<Action<H>, 'kind'>): Action<H> {
  return {
    optionStrings: [],
    dest: null,
    nargs: null,
    type: null,
    choices: null,
    default: null,
    const: null,
    required: false,
    help: null,
    metavar: null,
    version: '',
    parsers: new Map(),
    choicesActions: [],
    ...fields,
  }
}

/** The action of an option. suppress gives it the SUPPRESS default: the copy of an every-level
 *  option below the root, which must not write a default over the root's value */
function optionAction<H>(spec: OptionSpec, suppress = false): Action<H> {
  // The dest: '--foo-bar' is foo_bar, '-x' is x
  const first = spec.flags.find((flag) => flag.startsWith('--')) ?? spec.flags[0]!
  const dest = spec.dest ?? first.replace(/^-+/, '').replaceAll('-', '_')
  const fields = {
    optionStrings: spec.flags,
    dest,
    help: spec.help ?? null,
    metavar: spec.metavar ?? null,
    required: spec.required ?? false,
  }
  const given = (fallback: ArgValue): ArgValue | typeof SUPPRESS =>
    suppress ? SUPPRESS : spec.default === undefined ? fallback : spec.default
  switch (spec.action ?? 'store') {
    case 'store':
    case 'append':
      return makeAction<H>({
        ...fields,
        kind: spec.action === 'append' ? 'append' : 'store',
        type: spec.type ?? null,
        choices: spec.choices ?? null,
        default: given(null),
      })
    case 'store_true':
      return makeAction<H>({
        ...fields,
        kind: 'store_const',
        nargs: 0,
        const: true,
        default: given(false),
      })
    case 'store_false':
      return makeAction<H>({
        ...fields,
        kind: 'store_const',
        nargs: 0,
        const: false,
        default: given(true),
      })
    case 'store_const':
      return makeAction<H>({
        ...fields,
        kind: 'store_const',
        nargs: 0,
        const: spec.const ?? null,
        default: given(null),
      })
    case 'version':
      return makeAction<H>({
        ...fields,
        kind: 'version',
        dest: null,
        nargs: 0,
        default: SUPPRESS,
        help: spec.help ?? "show program's version number and exit",
        version: spec.version ?? '',
      })
  }
}

/** The action of a positional: required unless nargs is '?' */
function positionalAction<H>(spec: PositionalSpec): Action<H> {
  return makeAction<H>({
    kind: 'store',
    dest: spec.dest,
    nargs: spec.nargs ?? null,
    type: spec.type ?? null,
    choices: spec.choices ?? null,
    default: spec.default ?? null,
    required: spec.nargs !== '?',
    help: spec.help ?? null,
    metavar: spec.metavar ?? null,
  })
}

/**
 * The level for spec and, through its subcommands, the ones below it. Every level has -h first,
 * then (below the root) the every-level options the root lists, then its own options and
 * positionals in the order the table gives them, and its subcommands last: the order the usage
 * line and the help page follow.
 */
function buildLevel<H>(
  spec: CommandSpec<H>,
  path: readonly string[],
  prog: string,
  everyLevel: readonly OptionSpec[],
): Level<H> {
  const help = makeAction<H>({
    kind: 'help',
    optionStrings: ['-h', '--help'],
    nargs: 0,
    default: SUPPRESS,
    help: 'show this help message and exit',
  })
  const actions: Action<H>[] = [help]
  if (path.length > 0) actions.push(...everyLevel.map((option) => optionAction<H>(option, true)))
  actions.push(...(spec.options ?? []).map((option) => optionAction<H>(option)))
  const groups = (spec.exclusive ?? []).map((group) => ({
    required: group.required,
    actions: group.options.map((option) => optionAction<H>(option)),
  }))
  for (const group of groups) actions.push(...group.actions)
  actions.push(...(spec.positionals ?? []).map((positional) => positionalAction<H>(positional)))

  const children: Level<H>[] = []
  if (spec.subcommands !== undefined) {
    const parsers = new Map<string, Level<H>>()
    const choicesActions: Action<H>[] = []
    for (const command of spec.subcommands.commands) {
      const child = buildLevel(
        command,
        [...path, command.name],
        `${prog} ${command.name}`,
        everyLevel,
      )
      parsers.set(command.name, child)
      children.push(child)
      // A subcommand's line on this page, which only one with help has
      if (command.help !== undefined) {
        choicesActions.push(
          makeAction<H>({
            kind: 'store',
            dest: command.name,
            metavar: command.name,
            help: command.help,
          }),
        )
      }
    }
    actions.push(
      makeAction<H>({
        kind: 'parsers',
        dest: spec.subcommands.dest,
        nargs: PARSER,
        choices: [...parsers.keys()],
        required: spec.subcommands.required,
        parsers,
        choicesActions,
      }),
    )
  }

  const optionStringActions = new Map<string, Action<H>>()
  for (const each of actions) {
    for (const optionString of each.optionStrings) optionStringActions.set(optionString, each)
  }
  return {
    path,
    prog,
    description: spec.description ?? null,
    actions,
    optionStringActions,
    groups,
    defaults: spec.defaults ?? {},
    handler: spec.handler,
    children,
  }
}

/** How an error names an argument */
function actionName<H>(argument: Action<H>): string | null {
  if (argument.optionStrings.length > 0) return argument.optionStrings.join('/')
  if (argument.metavar !== null) return argument.metavar
  return argument.dest
}

/** An error inside one level's parse, which that level reports as a usage error */
class ArgumentError<H> extends Error {
  constructor(argument: Action<H> | null, message: string) {
    const name = argument === null ? null : actionName(argument)
    super(name === null ? message : `argument ${name}: ${message}`)
  }
}

/** -h or --version: the parser prints there and stops, whatever comes after */
class ParseExit {
  readonly parsed: { kind: 'help' | 'version'; text: string }
  constructor(parsed: { kind: 'help' | 'version'; text: string }) {
    this.parsed = parsed
  }
}

/** What parseOptional finds for one argument: the action, the flag it matched, and an
 *  argument written into the same string ('--x=1', '-d1') */
interface OptionTuple<H> {
  action: Action<H> | null // null: it looks like an option, but no option of this level
  optionString: string
  sep: string | null
  explicitArg: string | null
}

/** The options an argument could be, or null for a positional */
function parseOptional<H>(level: Level<H>, argString: string): OptionTuple<H>[] | null {
  if (argString === '' || argString[0] !== '-') return null
  const exact = level.optionStringActions.get(argString)
  if (exact !== undefined) {
    return [{ action: exact, optionString: argString, sep: null, explicitArg: null }]
  }
  if (argString.length === 1) return null
  // the option string before the '=' is present
  const equals = argString.indexOf('=')
  if (equals >= 0) {
    const action = level.optionStringActions.get(argString.slice(0, equals))
    if (action !== undefined) {
      const optionString = argString.slice(0, equals)
      return [{ action, optionString, sep: '=', explicitArg: argString.slice(equals + 1) }]
    }
  }
  // every option the argument is a prefix of
  const optionTuples = getOptionTuples(level, argString)
  if (optionTuples.length > 0) return optionTuples
  // a negative number is a positional: no option of tunnel's looks like one
  if (/^-\.?\d/.test(argString)) return null
  // so is anything with a space in it
  if (argString.includes(' ')) return null
  return [{ action: null, optionString: argString, sep: null, explicitArg: null }]
}

/** A long option may be cut short where that is not ambiguous ('--js' for '--json'); a short one
 *  may have its argument written straight after it ('-dVALUE') */
function getOptionTuples<H>(level: Level<H>, optionString: string): OptionTuple<H>[] {
  const result: OptionTuple<H>[] = []
  const equals = optionString.indexOf('=')
  const optionPrefix = equals >= 0 ? optionString.slice(0, equals) : optionString
  const sep = equals >= 0 ? '=' : null
  const explicitArg = equals >= 0 ? optionString.slice(equals + 1) : null
  const short = optionString[1] !== '-'
  for (const [candidate, action] of level.optionStringActions) {
    if (short && candidate === optionString.slice(0, 2)) {
      result.push({ action, optionString: candidate, sep: '', explicitArg: optionString.slice(2) })
    } else if (candidate.startsWith(optionPrefix)) {
      result.push({ action, optionString: candidate, sep, explicitArg })
    }
  }
  return result
}

/** How many of the A (argument), O (option) and - ('--') an action takes */
function nargsPattern<H>(action: Action<H>): string {
  const option = action.optionStrings.length > 0
  switch (action.nargs) {
    case null:
      return option ? '([A])' : '(-*A-*)'
    case '?':
      return option ? '(A?)' : '(-*A?-*)'
    case '+':
      return option ? '(A+)' : '(-*A[A-]*)'
    case PARSER:
      return option ? '(A[AO]*)' : '(-*A[-AO]*)'
    case 0:
      return option ? '([AO]{0})' : '((?:-*A){0}-*)'
  }
}

/** How many of the arguments in pattern the action takes */
function matchArgument<H>(action: Action<H>, pattern: string): number {
  const match = new RegExp(`^${nargsPattern(action)}`).exec(pattern)
  if (match === null) {
    const message =
      action.nargs === '?'
        ? 'expected at most one argument'
        : action.nargs === '+'
          ? 'expected at least one argument'
          : 'expected one argument'
    throw new ArgumentError(action, message)
  }
  return match[1]!.length
}

/** As many of the positionals as can be matched, each with its count */
function matchArgumentsPartial<H>(actions: readonly Action<H>[], pattern: string): number[] {
  for (let i = actions.length; i > 0; i--) {
    const match = new RegExp(`^${actions.slice(0, i).map(nargsPattern).join('')}`).exec(pattern)
    if (match !== null) {
      const result = match.slice(1).map((group) => group!.length)
      // positionals that took nothing right before an option are left for after it
      if (match[0].length < pattern.length && pattern[match[0].length] === 'O') {
        while (result.length > 0 && result.at(-1) === 0) result.pop()
      }
      return result
    }
  }
  return []
}

/** The argument as its type reads it */
function getValue<H>(action: Action<H>, argString: string): string | number {
  if (action.type === null) return argString
  const value = action.type === 'int' ? parseIntArg(argString) : parseFloatArg(argString)
  if (value === null) {
    throw new ArgumentError(action, `invalid ${action.type} value: ${repr(argString)}`)
  }
  return value
}

/** One of the choices, when there are choices */
function checkValue<H>(action: Action<H>, value: string | number): void {
  if (action.choices === null || action.choices.includes(value as string)) return
  const choices = action.choices.map((choice) => repr(choice)).join(', ')
  throw new ArgumentError(action, `invalid choice: ${repr(String(value))} (choose from ${choices})`)
}

/** What an action is handed: one value, or a list of them */
type Values = ArgValue | readonly (string | number)[]

/** The arguments an action took, converted and checked */
function getValues<H>(action: Action<H>, argStrings: readonly string[]): Values | typeof SUPPRESS {
  // a '?' positional given nothing: its default, which no command has as a string to convert
  if (argStrings.length === 0 && action.nargs === '?') return action.default
  if (argStrings.length === 1 && (action.nargs === null || action.nargs === '?')) {
    const value = getValue(action, argStrings[0]!)
    checkValue(action, value)
    return value
  }
  // a subcommand: its name is checked, the rest is the subcommand's to read
  if (action.nargs === PARSER) {
    checkValue(action, argStrings[0]!)
    return argStrings
  }
  const values = argStrings.map((argString) => getValue(action, argString))
  for (const value of values) checkValue(action, value)
  return values
}

/** One level's parse: its namespace, what it could not place, and the handler it lands on */
interface Known<H> {
  namespace: Record<string, ArgValue>
  extras: string[]
  handler: H | undefined
}

/**
 * One level's parse. A subcommand's level is parsed in the middle of its parent's, when the parent
 * reaches the subcommand's name, so a usage error found there names the subcommand, and an
 * argument no level could place goes back up to be reported by the top one.
 */
function parseKnownArgs<H>(
  level: Level<H>,
  argStrings: readonly string[],
  width: number,
): Known<H> {
  // add any action defaults that aren't present, then the level's own
  const namespace: Record<string, ArgValue> = {}
  for (const each of level.actions) {
    if (each.dest !== null && each.default !== SUPPRESS && !Object.hasOwn(namespace, each.dest)) {
      namespace[each.dest] = each.default
    }
  }
  for (const [dest, value] of Object.entries(level.defaults)) {
    if (!Object.hasOwn(namespace, dest)) namespace[dest] = value
  }
  // the level's handler, which a subcommand's own takes over from
  const known: Known<H> = { namespace, extras: [], handler: level.handler }
  // what the subcommands could not place, after this level's own
  const unrecognized: string[] = []
  try {
    known.extras = consumeArgStrings(level, argStrings, width, known, unrecognized)
  } catch (error) {
    // an error in this level's parse is a usage error that names this level
    if (error instanceof ArgumentError) {
      throw new UsageError(level.prog, formatUsage(level, width), error.message)
    }
    throw error
  }
  known.extras.push(...unrecognized)
  return known
}

/** Options and positionals taken alternately, from left to right */
function consumeArgStrings<H>(
  level: Level<H>,
  argStrings: readonly string[],
  width: number,
  known: Known<H>,
  unrecognized: string[],
): string[] {
  // map all mutually exclusive arguments to the other arguments they can't occur with
  const actionConflicts = new Map<Action<H>, Action<H>[]>()
  for (const group of level.groups) {
    group.actions.forEach((each, i) => {
      const others = [...group.actions.slice(0, i), ...group.actions.slice(i + 1)]
      actionConflicts.set(each, [...(actionConflicts.get(each) ?? []), ...others])
    })
  }

  // find all option indices, and determine the pattern, which has an 'O' if there is an option at
  // an index, an 'A' if there is an argument, or a '-' if there is a '--'
  const optionStringIndices = new Map<number, OptionTuple<H>[]>()
  let pattern = ''
  for (const [i, argString] of argStrings.entries()) {
    // all args after -- are non-options
    if (argString === '--') {
      pattern += '-' + 'A'.repeat(argStrings.length - i - 1)
      break
    }
    const optionTuples = parseOptional(level, argString)
    if (optionTuples !== null) optionStringIndices.set(i, optionTuples)
    pattern += optionTuples === null ? 'A' : 'O'
  }

  const seenActions = new Set<Action<H>>()
  const seenNonDefaultActions = new Set<Action<H>>()
  const takeAction = (each: Action<H>, argumentStrings: readonly string[]): void => {
    seenActions.add(each)
    const argumentValues = getValues(each, argumentStrings)
    // error if this argument is not allowed with other previously seen arguments
    if (each.optionStrings.length > 0 || argumentStrings.length > 0) {
      seenNonDefaultActions.add(each)
      for (const conflict of actionConflicts.get(each) ?? []) {
        if (seenNonDefaultActions.has(conflict)) {
          throw new ArgumentError(each, `not allowed with argument ${actionName(conflict)}`)
        }
      }
    }
    // take the action if we didn't receive a SUPPRESS value (a '?' positional's default)
    if (argumentValues !== SUPPRESS) {
      perform(level, each, argumentValues, width, known, unrecognized)
    }
  }

  const extras: string[] = []
  // the option at this index and its arguments
  const consumeOptional = (startIndex: number): number => {
    const optionTuples = optionStringIndices.get(startIndex)!
    // if multiple actions match, the option string was ambiguous
    if (optionTuples.length > 1) {
      const options = optionTuples.map((tuple) => tuple.optionString).join(', ')
      const message = `ambiguous option: ${argStrings[startIndex]} could match ${options}`
      throw new ArgumentError(null, message)
    }
    let { action, optionString, sep, explicitArg } = optionTuples[0]!
    // additional single-dash options in the same string (-xyz is -x -y -z if none takes a value)
    const actionTuples: [Action<H>, string[]][] = []
    let stop: number
    for (;;) {
      // an option of no level's: kept for the top level to report
      if (action === null) {
        extras.push(argStrings[startIndex]!)
        return startIndex + 1
      }
      if (explicitArg !== null) {
        const argCount = matchArgument(action, 'A')
        if (argCount === 0 && optionString[1] !== '-' && explicitArg !== '') {
          if (sep || explicitArg[0] === '-') {
            throw new ArgumentError(action, `ignored explicit argument ${repr(explicitArg)}`)
          }
          actionTuples.push([action, []])
          const char = optionString[0]!
          optionString = char + explicitArg[0]
          const next = level.optionStringActions.get(optionString)
          if (next === undefined) {
            extras.push(char + explicitArg)
            stop = startIndex + 1
            break
          }
          action = next
          explicitArg = explicitArg.slice(1)
          if (explicitArg === '') {
            sep = explicitArg = null
          } else if (explicitArg[0] === '=') {
            sep = '='
            explicitArg = explicitArg.slice(1)
          } else {
            sep = ''
          }
        } else if (argCount === 1) {
          // the option takes exactly one argument, and was written with it
          stop = startIndex + 1
          actionTuples.push([action, [explicitArg]])
          break
        } else {
          throw new ArgumentError(action, `ignored explicit argument ${repr(explicitArg)}`)
        }
      } else {
        // the option takes what follows it, as many as it can
        const start = startIndex + 1
        const argCount = matchArgument(action, pattern.slice(start))
        stop = start + argCount
        actionTuples.push([action, argStrings.slice(start, stop)])
        break
      }
    }
    for (const [each, args] of actionTuples) takeAction(each, args)
    return stop
  }

  // the positionals left to be parsed, taken from the front as they are matched
  const positionals = level.actions.filter((each) => each.optionStrings.length === 0)
  const consumePositionals = (startIndex: number): number => {
    const argCounts = matchArgumentsPartial(positionals, pattern.slice(startIndex))
    for (const [i, argCount] of argCounts.entries()) {
      const each = positionals[i]!
      const args = argStrings.slice(startIndex, startIndex + argCount)
      // strip out the first '--': a subcommand's only when it opens what it took
      if (each.nargs === PARSER) {
        if (pattern[startIndex] === '-') args.splice(args.indexOf('--'), 1)
      } else {
        const dashes = pattern.indexOf('-', startIndex)
        if (dashes >= 0 && dashes < startIndex + argCount) args.splice(args.indexOf('--'), 1)
      }
      startIndex += argCount
      takeAction(each, args)
    }
    positionals.splice(0, argCounts.length)
    return startIndex
  }

  // consume positionals and optionals alternately, until we have passed the last option string
  let startIndex = 0
  const maxOptionStringIndex = Math.max(-1, ...optionStringIndices.keys())
  while (startIndex <= maxOptionStringIndex) {
    // consume any positionals preceding the next option
    let nextOptionStringIndex = startIndex
    while (nextOptionStringIndex <= maxOptionStringIndex) {
      if (optionStringIndices.has(nextOptionStringIndex)) break
      nextOptionStringIndex++
    }
    if (startIndex !== nextOptionStringIndex) {
      const positionalsEndIndex = consumePositionals(startIndex)
      // only try to parse the next optional if we didn't consume the option string during the
      // positionals parsing
      if (positionalsEndIndex > startIndex) {
        startIndex = positionalsEndIndex
        continue
      }
      startIndex = positionalsEndIndex
    }
    // if we consumed all the positionals we could and we're not at the index of an option
    // string, there were extra arguments
    if (!optionStringIndices.has(startIndex)) {
      extras.push(...argStrings.slice(startIndex, nextOptionStringIndex))
      startIndex = nextOptionStringIndex
    }
    startIndex = consumeOptional(startIndex)
  }
  // consume any positionals following the last option; what is left over is extra
  const stopIndex = consumePositionals(startIndex)
  extras.push(...argStrings.slice(stopIndex))

  // make sure all required actions were present. (A string default is not converted to the
  // option's type: no option of tunnel's has a type and a string default)
  const requiredActions = level.actions
    .filter((each) => !seenActions.has(each) && each.required)
    .map((each) => actionName(each))
  if (requiredActions.length > 0) {
    const names = requiredActions.join(', ')
    throw new ArgumentError(null, `the following arguments are required: ${names}`)
  }
  // make sure all required groups had one option present
  for (const group of level.groups) {
    if (group.required && !group.actions.some((each) => seenNonDefaultActions.has(each))) {
      const names = group.actions.map((each) => actionName(each)).join(' ')
      throw new ArgumentError(null, `one of the arguments ${names} is required`)
    }
  }
  return extras
}

/** The action itself */
function perform<H>(
  level: Level<H>,
  action: Action<H>,
  values: Values,
  width: number,
  known: Known<H>,
  unrecognized: string[],
): void {
  const { namespace } = known
  switch (action.kind) {
    case 'store':
      namespace[action.dest!] = values as ArgValue
      return
    case 'store_const':
      namespace[action.dest!] = action.const
      return
    case 'append': {
      const items = namespace[action.dest!]
      namespace[action.dest!] = [...(Array.isArray(items) ? items : []), values as string]
      return
    }
    case 'help':
      throw new ParseExit({ kind: 'help', text: formatHelp(level, width) })
    case 'version':
      throw new ParseExit({ kind: 'version', text: formatText(action.version, width) })
    case 'parsers': {
      const [name, ...rest] = values as readonly string[]
      namespace[action.dest!] = name!
      // The subcommand parses into a namespace of its own, which is then copied over this one, so
      // what the subcommand sets wins, its handler included
      const sub = parseKnownArgs(action.parsers.get(name!)!, rest, width)
      Object.assign(namespace, sub.namespace)
      if (sub.handler !== undefined) known.handler = sub.handler
      unrecognized.push(...sub.extras)
    }
  }
}

/** The length in code points, not UTF-16 units */
function len(text: string): number {
  return [...text].length
}

/**
 * Help text wrapped to width: runs of ASCII white space become one space, then words go onto a
 * line for as long as they fit. It does not break at hyphens: none of the 44 pages breaks a line
 * there. A word longer than the line gets a line of its own rather than being cut.
 */
function wrap(text: string, width: number): string[] {
  const lines: string[] = []
  let line = ''
  const words = text
    .replace(/[ \t\n\r\f\v]+/g, ' ')
    .trim()
    .split(' ')
  for (const word of words) {
    if (line !== '' && len(line) + 1 + len(word) > width) {
      lines.push(line)
      line = word
    } else {
      line = line === '' ? word : `${line} ${word}`
    }
  }
  if (line !== '') lines.push(line)
  return lines
}

/** Text at the top of a page (a description, or what --version prints), wrapped, with a newline
 *  after it */
function formatText(text: string, width: number): string {
  return `${wrap(text, Math.max(width, 11)).join('\n')}\n`
}

/** The metavar, or the choices as {a,b}, or the default name */
function metavarOf<H>(action: Action<H>, defaultMetavar: string): string {
  if (action.metavar !== null) return action.metavar
  if (action.choices !== null) return `{${action.choices.join(',')}}`
  return defaultMetavar
}

/** What an action takes, as the usage and the help write it */
function formatArgs<H>(action: Action<H>, defaultMetavar: string): string {
  const metavar = metavarOf(action, defaultMetavar)
  switch (action.nargs) {
    case '?':
      return `[${metavar}]`
    case '+':
      return `${metavar} [${metavar} ...]`
    case PARSER:
      return `${metavar} ...`
    default:
      return metavar
  }
}

/** An action's name in the help ('-d, --data JSON', 'method') */
function invocation<H>(action: Action<H>): string {
  if (action.optionStrings.length === 0) return metavarOf(action, action.dest ?? '')
  const flags = action.optionStrings.join(', ')
  if (action.nargs === 0) return flags
  return `${flags} ${formatArgs(action, (action.dest ?? '').toUpperCase())}`
}

/** The parts of the usage line, and where the positionals start */
function usageParts<H>(level: Level<H>): { parts: string[]; posStart: number } {
  const groupOf = new Map(
    level.actions.map((each) => [each, level.groups.find((group) => group.actions.includes(each))]),
  )
  // positional arguments keep their position (none of tunnel's is in a group)
  const positionals = level.actions.filter((each) => each.optionStrings.length === 0)
  // the optionals, a group in the place of its first member
  const optionals: [boolean | null, Action<H>[]][] = []
  const placed = new Set<Action<H>>()
  for (const each of level.actions) {
    if (each.optionStrings.length === 0 || placed.has(each)) continue
    const group = groupOf.get(each)
    const others = group?.actions.filter((other) => other !== each && !placed.has(other)) ?? []
    const members = [each, ...others]
    for (const member of members) placed.add(member)
    optionals.push([group === undefined ? null : group.required, members])
  }

  const parts: string[] = []
  for (const [required, group] of optionals) {
    const start = parts.length
    const inGroup = group.length > 1
    for (const each of group) {
      // the first way to invoke the option, and what it takes
      const optionString = each.optionStrings[0]!
      let part =
        each.nargs === 0
          ? optionString
          : `${optionString} ${formatArgs(each, each.dest!.toUpperCase())}`
      // make it look optional if it's not required or in a group
      if (!(each.required || required || inGroup)) part = `[${part}]`
      parts.push(part)
    }
    if (inGroup) {
      parts[start] = (required ? '(' : '[') + parts[start]
      for (let i = start; i < parts.length - 1; i++) parts[i] += ' |'
      parts[parts.length - 1] += required ? ')' : ']'
    }
  }
  const posStart = parts.length
  for (const each of positionals) parts.push(formatArgs(each, each.dest!))
  return { parts, posStart }
}

/** 'usage: ' and the prog with its parts, wrapped to the width, with the options and the
 *  positionals each starting a line of their own when it does not fit on one */
function usageText<H>(level: Level<H>, width: number): string {
  const prefix = 'usage: '
  const prog = level.prog
  const { parts, posStart } = usageParts(level)
  const usage = [prog, ...parts].join(' ')
  const textWidth = width
  if (len(prefix) + len(usage) <= textWidth) return `${prefix}${usage}\n\n`

  const optParts = parts.slice(0, posStart)
  const posParts = parts.slice(posStart)
  // helper for wrapping lines
  const getLines = (lineParts: readonly string[], indent: string, first?: string): string[] => {
    const lines: string[] = []
    let line: string[] = []
    const indentLength = len(indent)
    let lineLen = first !== undefined ? len(first) - 1 : indentLength - 1
    for (const part of lineParts) {
      const partLen = len(part)
      if (lineLen + 1 + partLen > textWidth && line.length > 0) {
        lines.push(indent + line.join(' '))
        line = []
        lineLen = indentLength - 1
      }
      line.push(part)
      lineLen += partLen + 1
    }
    if (line.length > 0) lines.push(indent + line.join(' '))
    if (first !== undefined) lines[0] = lines[0]!.slice(indentLength)
    return lines
  }

  let lines: string[]
  if (len(prefix) + len(prog) <= 0.75 * textWidth) {
    // if prog is short, follow it with optionals or positionals
    const indent = ' '.repeat(len(prefix) + len(prog) + 1)
    if (optParts.length > 0) {
      lines = [...getLines([prog, ...optParts], indent, prefix), ...getLines(posParts, indent)]
    } else if (posParts.length > 0) {
      lines = getLines([prog, ...posParts], indent, prefix)
    } else {
      lines = [prog]
    }
  } else {
    // if prog is long, put it on its own line
    const indent = ' '.repeat(len(prefix))
    lines = getLines([...optParts, ...posParts], indent)
    if (lines.length > 1) lines = [...getLines(optParts, indent), ...getLines(posParts, indent)]
    lines = [prog, ...lines]
  }
  return `${prefix}${lines.join('\n')}\n\n`
}

/** The usage as a usage error writes it, before its sentence: "usage: …\n" */
function formatUsage<H>(level: Level<H>, width: number): string {
  return usageText(level, width).slice(0, -1)
}

/**
 * The help page: the usage, the description, then a section of positional arguments and one of
 * options. Every invocation is two in from the margin (a subcommand's four), and the help starts
 * in the column after the longest of them, though never further than 24 in; an invocation too
 * long for that puts its help on the next line.
 */
function formatHelp<H>(level: Level<H>, width: number): string {
  const sections: [string, Action<H>[]][] = [
    ['positional arguments', level.actions.filter((each) => each.optionStrings.length === 0)],
    ['options', level.actions.filter((each) => each.optionStrings.length > 0)],
  ]
  const maxHelpPosition = Math.min(24, Math.max(width - 20, 4))
  // the longest invocation, with the indent it is printed at
  let actionMaxLength = 0
  for (const [, actions] of sections) {
    for (const each of actions) {
      actionMaxLength = Math.max(actionMaxLength, len(invocation(each)) + 2)
      for (const sub of each.choicesActions) {
        actionMaxLength = Math.max(actionMaxLength, len(invocation(sub)) + 4)
      }
    }
  }
  const helpPosition = Math.min(actionMaxLength + 2, maxHelpPosition)
  const helpTextWidth = Math.max(width - helpPosition, 11)

  const formatAction = (each: Action<H>, indent: number): string => {
    const actionWidth = helpPosition - indent - 2
    const header = invocation(each)
    let text = ' '.repeat(indent) + header
    let indentFirst = 0
    if (each.help === null || each.help === '') {
      // no help; start on same line and add a final newline
      text += '\n'
    } else if (len(header) <= actionWidth) {
      // short action name; start on the same line and pad two spaces
      text += ' '.repeat(actionWidth - len(header)) + '  '
    } else {
      // long action name; start on the next line
      text += '\n'
      indentFirst = helpPosition
    }
    if (each.help !== null && each.help.trim() !== '') {
      wrap(each.help, helpTextWidth).forEach((line, i) => {
        text += `${' '.repeat(i === 0 ? indentFirst : helpPosition)}${line}\n`
      })
    } else if (!text.endsWith('\n')) {
      text += '\n'
    }
    // if there are any sub-actions, add their help as well
    for (const sub of each.choicesActions) text += formatAction(sub, indent + 2)
    return text
  }

  let help = usageText(level, width)
  if (level.description !== null) help += `${formatText(level.description, width)}\n`
  for (const [title, actions] of sections) {
    if (actions.length === 0) continue
    help += `\n${title}:\n${actions.map((each) => formatAction(each, 2)).join('')}\n`
  }
  return `${help.replace(/\n\n\n+/g, '\n\n').replace(/^\n+|\n+$/g, '')}\n`
}

/**
 * The parser for a command table. width is what help and usage are laid out in, the one
 * helpWidth() finds.
 */
export function createParser<H>(root: CommandSpec<H>, options: { width: number }): Parser<H> {
  const { width } = options
  const everyLevel = (root.options ?? []).filter((option) => option.everyLevel === true)
  const top = buildLevel(root, [], root.name, everyLevel)
  return {
    parse(argv) {
      try {
        const known = parseKnownArgs(top, argv, width)
        // what no level could place is the top level's to report
        if (known.extras.length > 0) {
          const message = `unrecognized arguments: ${known.extras.join(' ')}`
          throw new UsageError(top.prog, formatUsage(top, width), message)
        }
        if (known.handler === undefined) throw new Error(`no handler for ${argv.join(' ')}`)
        return { kind: 'run', args: known.namespace, handler: known.handler }
      } catch (error) {
        if (error instanceof ParseExit) return error.parsed
        throw error
      }
    },
    formatHelp: () => formatHelp(top, width),
    paths() {
      const paths: string[][] = []
      const walk = (level: Level<H>): void => {
        paths.push([...level.path])
        for (const child of level.children) walk(child)
      }
      walk(top)
      return paths
    },
  }
}
