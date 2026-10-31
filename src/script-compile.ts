// Compiling a handler(ctx) script, for the two threads that do it: the main thread, to refuse a
// script that will not compile before it is written (compileScript in script.ts), and the worker,
// to run it.
//
// A script is the body of a function whose one parameter is require. It defines handler at its
// top level, and a line appended to it hands handler back, so a call of the compiled function runs
// the whole script from the top and returns the handler that run defined, and the worker runs the
// script afresh for every request. Before V8 compiles it, module.stripTypeScriptTypes erases its
// type annotations, so a script may be TypeScript as long as erasing is all it takes (no enum, no
// namespace). Erasing leaves spaces where the types were and every line where it was, so the line
// of a syntax error, and of a frame in a stack, is the line the script wrote it on.
import { stripTypeScriptTypes } from 'node:module'
import { compileFunction } from 'node:vm'

/** A script that will not compile: where, and what the parser said. `line` is read off the first
 *  line of the parser's stack (`<filename>:<line>`), null when it is not there */
export class ScriptSyntaxError extends Error {
  override name = 'ScriptSyntaxError'
  readonly line: number | null
  /** The parser's own stack with Node's internal frames cut off: the `<filename>:<line>` line, the
   *  source line, the caret and the `SyntaxError…: <message>` line. What a 500 shows when the
   *  script will not compile */
  readonly detail: string
  constructor(message: string, line: number | null, detail: string) {
    super(message)
    this.line = line
    this.detail = detail
  }
}

/** True when stripping is available (process.features.typescript is not false and
 *  module.stripTypeScriptTypes exists). Every Node from 22.18 on has the function; the typeof is
 *  only a guard */
export const CAN_STRIP_TYPES: boolean =
  process.features.typescript !== false && typeof stripTypeScriptTypes === 'function'

/** The compiled script: calling it runs the whole script top to bottom and returns what `handler`
 *  is bound to */
export type CompiledScript = (require: NodeJS.Require) => unknown

/** Appended to every script to hand back handler, whether function, const or let defined it. On a
 *  line of its own, so that a script ending in a // comment does not comment it out */
const TAIL = '\n;return typeof handler === "function" ? handler : undefined'

/** The line number that ends the first line of a SyntaxError's stack, `<filename>:<line>` */
const LINE = /:(\d+)$/

/** A frame of a stack. A compile error's frames point into Node and tunnel, never into the script,
 *  so its detail leaves them out */
const FRAME = /^\s+at /

/** What a syntax error adds to its message on a Node that cannot strip types, where a script with
 *  a type in it fails to compile */
const WITHOUT_TS =
  ' (this Node was built without TypeScript support, so a handler has to be plain JavaScript)'

/** Whether stripTypes has made the first call, the one Node warns about */
let stripWarned = false

/** `source` with its type annotations erased, or as it is on a Node that cannot erase them. Given
 *  a sourceUrl, stripTypeScriptTypes appends `\n\n//# sourceURL=<sourceUrl>`, which moves no line.
 *  Throws a SyntaxError when the script does not parse */
function stripTypes(source: string, sourceUrl: string): string {
  if (!CAN_STRIP_TYPES) return source
  if (stripWarned) return stripTypeScriptTypes(source, { mode: 'strip', sourceUrl })
  // The first call to stripTypeScriptTypes in a thread emits an ExperimentalWarning, which Node
  // prints on stderr among tunnel's own lines. tunnel's bin (#!/usr/bin/env node) has no command
  // line to pass --disable-warning on, so the first call runs with process.emitWarning swapped for
  // one that drops ExperimentalWarnings and passes the rest on. Node warns as the call starts, a
  // script that does not parse included, and notes that it has whether or not the warning got
  // out, so later calls are quiet without the swap. This is the one global the module touches, and
  // only for that call: it is synchronous, so nothing else runs while the swap is in place, and
  // finally puts the original back whatever the call does.
  const saved = process.emitWarning
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    // emitWarning(warning, type, code, ctor) or emitWarning(warning, { type, code, detail })
    const type =
      typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: string } | undefined)?.type
    if (type === 'ExperimentalWarning') return
    if (warning instanceof Error && warning.name === 'ExperimentalWarning') return
    Reflect.apply(saved, process, [warning, ...rest])
  }) as typeof process.emitWarning
  try {
    return stripTypeScriptTypes(source, { mode: 'strip', sourceUrl })
  } finally {
    process.emitWarning = saved
    stripWarned = true
  }
}

/** Type-strip (when available) and compile `source` as a function body with one parameter,
 *  `require`, under `filename` (`script:<key>`), with
 *  `\n;return typeof handler === "function" ? handler : undefined` appended.
 *  Throws ScriptSyntaxError. Never executes anything */
export function prepareScript(source: string, filename: string): CompiledScript {
  try {
    // Stripped before V8 sees it, not after V8 has refused it: the stripper parses the whole
    // script, so it reports a plain JS syntax error as well, where V8 given TypeScript would point
    // at the first type annotation with an Unexpected token ':'
    const code = stripTypes(source, filename) + TAIL
    return compileFunction(code, ['require'], { filename }) as CompiledScript
  } catch (error) {
    // The stripper's and V8's; anything else is a bug
    if (!(error instanceof SyntaxError)) throw error
    // Neither message has the line in it. Both stacks start with `<filename>:<line>`, then the
    // source line, a caret, a blank line and `SyntaxError: <message>` (the stripper's with its
    // code in brackets), then the frames. Should a stack not look like that, the detail is the
    // name and message alone
    const lines = (error.stack ?? '').split('\n')
    const first = lines[0] ?? ''
    const located = first.startsWith(`${filename}:`)
    const line = located ? Number(LINE.exec(first)?.[1]) || null : null
    const detail = located
      ? lines.filter((each) => !FRAME.test(each)).join('\n')
      : `${error.name}: ${error.message}`
    // On a Node that cannot strip types the hint goes on both: the message ends the 400 that
    // refuses the script, and the detail, which ends with the message, is what a request's 500 shows
    const hint = CAN_STRIP_TYPES ? '' : WITHOUT_TS
    throw new ScriptSyntaxError(error.message + hint, line, detail + hint)
  }
}

/** /^[ \t]*def[ \t]+handler[ \t]*\(/m — the line that defines a Python handler */
export function looksLikePython(source: string): boolean {
  return /^[ \t]*def[ \t]+handler[ \t]*\(/m.test(source)
}

/** The sentence both threads add when looksLikePython is true: compileScript after the 400
 *  sentence (`. ` first), the worker on a line of its own after the stack */
export const PYTHON_HINT =
  'This looks like Python; tunnel runs handler(ctx) as JavaScript, see `tunnel agents`.'
