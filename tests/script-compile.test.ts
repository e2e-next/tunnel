// src/script-compile.ts: how a handler(ctx) script is type-stripped and compiled, and where the
// line of a syntax error comes from.
// compileScript, in src/script.ts, refuses a script that will not compile. A message is the
// parser's own words, and those differ between Node versions (got 'def' on 22 and 24, got 'ident'
// on 26), so the tests hold the line rather than the words. Of the messages they ask only that the
// enum one says enum, and hold word for word only the one sentence V8 words the same on all three.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { UserError } from '../src/errors.ts'
import {
  CAN_STRIP_TYPES,
  looksLikePython,
  prepareScript,
  ScriptSyntaxError,
} from '../src/script-compile.ts'
import { compileScript } from '../src/script.ts'

const require = createRequire(import.meta.url)

/** What prepareScript throws for `source`, which has to be a ScriptSyntaxError */
function syntaxErrorOf(source: string, filename = 'script:GET:/api/feed'): ScriptSyntaxError {
  try {
    prepareScript(source, filename)
  } catch (error) {
    assert.ok(
      error instanceof ScriptSyntaxError,
      `${JSON.stringify(source)} threw ${String(error)}`,
    )
    return error
  }
  assert.fail(`${JSON.stringify(source)} compiled`)
}

// First in the file so that it makes the thread's first stripTypeScriptTypes call, the
// one Node warns about, itself. Placed later it still catches a leak today, since emitWarning
// delivers on a later tick and node:test runs the synchronous tests before it without letting that
// tick through, but a test before it that waited for a macrotask would let the warning out before
// this listener is on. npm test's --disable-warning=ExperimentalWarning stops the printing, not
// the event, so the listener sees the warning whenever stripTypes lets it through
test('stripping types does not emit an ExperimentalWarning', async (t) => {
  const seen: string[] = []
  const onWarning = (warning: Error) => seen.push(warning.name)
  process.on('warning', onWarning)
  t.after(() => process.off('warning', onWarning))
  const original = process.emitWarning
  prepareScript('const a: number = 1\nfunction handler(ctx) { return a }\n', 'x')
  prepareScript('const a: number = 1\nfunction handler(ctx) { return a }\n', 'x')
  // process.emitWarning emits on the next tick
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(!seen.includes('ExperimentalWarning'), `warned: ${seen.join(', ')}`)
  assert.equal(process.emitWarning, original)
})

test('the line of a syntax error is the line the script wrote it on', () => {
  // Both found by the type stripper, which parses the whole script before V8 sees any of it
  const missingComma = syntaxErrorOf(
    'function handler(ctx) {\n  return {page: 1 has_more: true}\n}\n',
  )
  assert.equal(missingComma.line, 2)
  const anEnum = syntaxErrorOf('const a = 1\nconst b = 2\nenum Color { Red }\n')
  assert.equal(anEnum.line, 3)
  assert.match(anEnum.message, /enum/)
  for (const [error, line] of [
    [missingComma, 2],
    [anEnum, 3],
  ] as const) {
    assert.notEqual(error.message, '')
    // The parser's stack without Node's frames: where, the source line, the caret, the message
    const lines = error.detail.split('\n')
    assert.equal(lines[0], `script:GET:/api/feed:${line}`)
    assert.ok(!lines.some((each) => each.startsWith('    at ')), error.detail)
    const last = lines.at(-1) ?? ''
    assert.ok(last.startsWith('SyntaxError'), error.detail)
    assert.ok(last.includes(error.message), error.detail)
  }
})

test('an error only V8 reports still has its line', () => {
  // The type stripper lets a second `let a` through; V8 refuses it as it compiles
  const error = syntaxErrorOf('let a = 1\nlet a = 2\nfunction handler(ctx) { return {} }\n')
  assert.equal(error.line, 2)
  assert.equal(
    error.detail.split('\n').at(-1),
    "SyntaxError: Identifier 'a' has already been declared",
  )
})

test('plain JS and erasable TS compile; import, export and top-level await do not', () => {
  const compiles = [
    'function handler(ctx) { return {} }',
    'const handler = (ctx: { q: Record<string, string> }): object => ({ q: ctx.q })',
    'const n = (1 as number); function handler<T>(ctx: T): T { return ctx }',
  ]
  for (const source of compiles) {
    assert.equal(typeof prepareScript(source, 'x'), 'function', source)
  }
  // A script is the body of a function, so V8 refuses what only a module may hold; and require is
  // that function's parameter, which the script cannot declare again
  const refused = [
    "import fs from 'node:fs'\n",
    'export function handler(ctx) {}\n',
    'await null\n',
    'const require = 1\n',
  ]
  for (const source of refused) {
    assert.equal(syntaxErrorOf(source).line, 1, source)
  }
})

test('looksLikePython tells a def handler from a function handler', () => {
  const python = [
    'def handler(ctx):\n    return {}\n',
    'import time\n\ndef handler(ctx):\n    pass\n',
    '\tdef handler (ctx):',
  ]
  for (const source of python) {
    assert.equal(looksLikePython(source), true, source)
  }
  const notPython = [
    'function handler(ctx) {}',
    // The line starts with //, so the def in it is not at the start of a line
    '// def handler(ctx): in a comment\nfunction handler(ctx) {}',
    '',
  ]
  for (const source of notPython) {
    assert.equal(looksLikePython(source), false, source)
  }
})

test('the compiled script runs its top level again on every call', (t) => {
  t.after(() => {
    delete (globalThis as { __t2?: number }).__t2
  })
  const compiled = prepareScript(
    'globalThis.__t2 = (globalThis.__t2 ?? 0) + 1\nconst handler = () => globalThis.__t2\n',
    'x',
  )
  // Each call runs the whole script and hands back the handler that run defined
  assert.equal((compiled(require) as () => number)(), 1)
  assert.equal((compiled(require) as () => number)(), 2)
  // A script that defines no handler hands back nothing
  assert.equal(prepareScript('const x = 1\n', 'x')(require), undefined)
})

test('CAN_STRIP_TYPES is true on a Node built with TypeScript support', () => {
  assert.equal(CAN_STRIP_TYPES, process.features.typescript !== false)
})

// The script and the check admin-api.test.ts's 'script syntax error rejected with line' uses,
// through PATCH /mocks: the 400's detail has "line 1" in it. The type stripper finds the missing )
// on line 1
test('compileScript refuses a script that will not compile, naming its key and line', () => {
  assert.throws(
    () => compileScript('function handler(ctx {\n  return {}\n}\n', 'GET:/api/feed'),
    (error: unknown) => {
      assert.ok(error instanceof UserError, String(error))
      assert.match(error.message, /^GET:\/api\/feed has a script syntax error on line 1: .+/)
      assert.doesNotMatch(error.message, /This looks like Python/)
      return true
    },
  )
  assert.equal(compileScript('function handler(ctx) { return {} }', 'GET:/api/feed'), undefined)
})

test('compileScript says so when the script is Python', () => {
  assert.throws(
    () => compileScript('def handler(ctx):\n    return {}\n', 'GET:/api/feed'),
    (error: unknown) => {
      assert.ok(error instanceof UserError, String(error))
      assert.ok(
        error.message.startsWith('GET:/api/feed has a script syntax error on line 1: '),
        error.message,
      )
      assert.ok(
        error.message.endsWith(
          '. This looks like Python; tunnel runs handler(ctx) as JavaScript, see `tunnel agents`.',
        ),
        error.message,
      )
      return true
    },
  )
})

// TypeScript that erasing alone cannot run is refused before it is written, at its
// line, as an enum is
test('a namespace and a parameter property are refused at their line', () => {
  assert.equal(syntaxErrorOf('const a = 1\nnamespace N {\n  export const x = 1\n}\n').line, 2)
  assert.equal(syntaxErrorOf('class A {\n  constructor(public x: number) {}\n}\n').line, 2)
})

// A script saved with Windows line endings has the lines its editor shows
test('a line that ends in \\r\\n is one line', () => {
  // The type stripper's error, then V8's
  assert.equal(syntaxErrorOf('const a = 1\r\nconst b = {c: 1 d: 2}\r\n').line, 2)
  assert.equal(syntaxErrorOf('let a = 1\r\nlet b = 2\r\nlet a = 3\r\n').line, 3)
})
