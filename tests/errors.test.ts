// repr in src/errors.ts, which quotes a value in an error or a log line.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reasonOf, repr } from '../src/errors.ts'

test('repr quotes a string and escapes what is not printable', () => {
  // [input, what repr makes of it]
  const table: [value: string, quoted: string][] = [
    ['GET', "'GET'"],
    ["it's", `"it's"`], // a ' and no ", so in double quotes
    ['say "hi"', `'say "hi"'`],
    [`it's "x"`, `'it\\'s "x"'`], // both, so in single quotes, and the ' inside escaped
    ['a\\b', "'a\\\\b'"],
    ['tab\there', "'tab\\there'"],
    ['line\nbreak', "'line\\nbreak'"],
    ['cr\rx', "'cr\\rx'"],
    ['\x00', "'\\x00'"],
    ['\x7f', "'\\x7f'"],
    ['\u{A0}', "'\\xa0'"], // no-break space
    ['\u{200B}', "'\\u200b'"], // zero width space
    ['\u{2028}', "'\\u2028'"], // line separator
    ['\u{1F600}', "'\u{1F600}'"], // an emoji is printable, so it stays as it is
    ['\u{E0001}', "'\\U000e0001'"], // language tag, a format character past U+FFFF
    ['caf\u{E9}', "'caf\u{E9}'"],
    [' ', "' '"], // a separator, but the one printed as it is
    ['\u{D800}', "'\\ud800'"], // a lone surrogate, which an escape in JSON can carry into a key
  ]
  for (const [value, quoted] of table) {
    assert.equal(repr(value), quoted, JSON.stringify(value))
  }
})

// reasonOf words a log line's reason, so whatever was thrown has to come out as text, even a value
// String() cannot convert, such as an object with no prototype
test('reasonOf gives the message, the string, or a word for what String() cannot write', () => {
  assert.equal(reasonOf(new Error('disk full')), 'disk full')
  assert.equal(reasonOf('plain'), 'plain')
  assert.equal(reasonOf(5), '5')
  assert.equal(reasonOf(Object.create(null)), '[object Object]')
})
