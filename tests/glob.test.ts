// src/glob.ts: shell-style wildcards. The rules, the request log and the proxy
// reach it through tests of their own; these hold it to the expected answers
// directly: the 2,932 cases in tests/fixtures/glob-cases.json and the two
// tables below.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { matchGlob } from '../src/glob.ts'

type Case = [pattern: string, value: string, answer: boolean]

const CASES: Case[] = JSON.parse(
  readFileSync(new URL('./fixtures/glob-cases.json', import.meta.url), 'utf8'),
)

/** Asserts each answer in turn, naming the pattern and the value of a wrong one */
function assertAnswers(cases: Case[]): void {
  for (const [pattern, value, answer] of cases) {
    const which = `${JSON.stringify(pattern)} against ${JSON.stringify(value)}`
    assert.equal(matchGlob(value, pattern), answer, which)
  }
}

test('every case in glob-cases.json gets its expected answer', () => {
  // So that a file read as empty, or cut short, cannot pass
  assert.ok(CASES.length > 2500, `only ${CASES.length} cases`)
  const wrong = []
  for (const [pattern, value, answer] of CASES) {
    let got: boolean | string
    try {
      got = matchGlob(value, pattern)
    } catch (error) {
      // A pattern translated into an expression that JS refuses
      got = String(error)
    }
    if (got !== answer) wrong.push({ pattern, value, answer, got })
  }
  // Every wrong case at once, rather than the first
  assert.deepEqual(wrong, [])
})

test('the wildcards: * runs across / and newlines, ? is one character, [seq], [!seq], ranges', () => {
  assertAnswers([
    ['/*', '/a/b\nc', true],
    ['a*b', 'a/x/b', true],
    ['?', '\u{1F600}', true], // U+1F600, one character in two UTF-16 units
    ['?', '\u{1F600}\u{1F600}', false],
    ['??', '\u{1F600}\u{1F600}', true],
    ['[abc]', 'b', true],
    ['[abc]', 'd', false],
    ['[!abc]', 'b', false],
    ['[!abc]', 'd', true],
    ['[a-z]', 'm', true],
    ['[a-z]', 'M', false],
    ['a', 'A', false],
    ['A*', 'abc', false],
    ['a*', 'xab', false],
    ['*b', 'abx', false],
    ['a?c', 'abc', true],
    ['a?c', 'ac', false],
    ['*', '', true],
    ['', '', true],
    ['', 'a', false],
  ])
})

test('the corners of a bracket expression', () => {
  assertAnswers([
    ['[]]', ']', true], // a ] that comes first is a literal
    ['[]a]', 'a', true],
    ['[!]]', ']', false],
    ['[!]]', 'a', true],
    ['[z-a]', 'm', false], // a reversed range is dropped, so this never matches
    ['[z-a]', 'z', false],
    ['[z-a]', 'a', false],
    ['[!z-a]', 'm', true], // negated, it matches any character
    ['[!z-a]', '\n', true],
    ['[!z-a]', '\u{1F600}', true],
    ['[a', '[a', true], // a [ that is never closed is a literal
    ['[a', 'a', false],
    ['x[', 'x[', true],
    ['[!]', '[!]', true], // no ] comes after [!], so all of it is literal
    ['[!]', '!', false],
    ['[]', '[]', true],
    ['[\\]', '\\', true], // there is no escape character: a backslash is a backslash
    ['a\\*', 'a\\b', true],
    ['a\\*', 'a*', false],
    ['[a-b--z]', 'M', true], // a to b, then - to z
    ['[a-b--z]', '!', false],
    ['[a-b--z]', '-', true],
    ['[a-]', '-', true],
    ['[-a]', '-', true],
    ['[\u{1F600}-\u{FF5E}]', 'm', false], // reversed by code point, though not by UTF-16 unit
    ['[\u{FF5E}-\u{1F600}]', '\u{1F5FF}', true],
  ])
})

// Were each star a plain .*, this pattern would backtrack: a few hundred characters
// take seconds, and these 16,384 would take hours. The match runs in a child process
// because a test's timeout cannot stop it: node:test's timer only gets its turn once
// the match gives the thread back, and by then the test has passed. A child process
// can be killed, so a backtracking match fails after 5 seconds instead.
test('a pattern built to backtrack still answers in linear time [slow]', () => {
  const glob = new URL('../src/glob.ts', import.meta.url).href
  const code = [
    `import { matchGlob } from ${JSON.stringify(glob)}`,
    `process.stdout.write(String(matchGlob('/' + 'a'.repeat(16_384), '/*a*a*a*b')))`,
  ].join('\n')
  const child = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code],
    { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' },
  )
  assert.equal(child.signal, null, 'still matching after 5 s: the stars are backtracking')
  assert.equal(child.stderr, '')
  assert.equal(child.stdout, 'false')
})

test('answers stay right once the compiled patterns have gone round the cache', () => {
  const cases: Case[] = []
  // 1,100 patterns, more than the 1,024 the cache keeps, so the first ones are gone by the end
  for (let i = 0; i < 1100; i++) cases.push([`/p${i}/*`, `/p${i}/x`, true])
  // Then the first ten again, compiled anew
  for (let i = 0; i < 10; i++) {
    cases.push([`/p${i}/*`, `/p${i}/x`, true], [`/p${i}/*`, `/q${i}/x`, false])
  }
  assertAnswers(cases)
})
