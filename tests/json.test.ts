// src/json.ts: user JSON keeps its integers past 2^53 digit for digit, and comes out as
// JSON.parse gives it in every other way.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isJsonObject, isRawJson, parseJson, stringifySpaced } from '../src/json.ts'

test('integers past 2^53 keep every digit through parseJson and JSON.stringify', () => {
  const text =
    '{"id":12345678901234567890,"neg":-12345678901234567890,"list":[18446744073709551615,{"deep":98765432109876543210}]}'
  const value = parseJson(text)
  assert.equal(JSON.stringify(value), text)
  assert.match(JSON.stringify(value, null, 2), /"id": 12345678901234567890,/)
})

test('2^53 − 1 is still a number; from 2^53 on the digits are kept', () => {
  assert.equal(parseJson('9007199254740991'), Number.MAX_SAFE_INTEGER)
  assert.equal(parseJson('-9007199254740991'), -Number.MAX_SAFE_INTEGER)
  assert.ok(isRawJson(parseJson('9007199254740992')))
  assert.ok(isRawJson(parseJson('-9007199254740992')))
  // JSON.parse alone makes this one 9007199254740992
  assert.equal(JSON.stringify(parseJson('9007199254740993')), '9007199254740993')
})

test('fractions, exponents and long digit runs inside strings come out as JSON.parse gives them', () => {
  // The first two hold runs of 16 digits or more, but after a '.', so they take
  // the fast path. The two strings take the slow path for nothing and come out the
  // same. The last one takes it for the digits before its '.', so the reviver sees
  // a fraction and exponents there too, and has to leave them numbers.
  for (const text of [
    '1.3333333333333333',
    '[0.12345678901234567890]',
    '1e20',
    '-1.5e-7',
    '-0',
    '"12345678901234567890"',
    '{"a":"x 12345678901234567890 y"}',
    '[12345678901234567890.5,1e20,-1.5e-7,1.5]',
  ]) {
    assert.deepEqual(parseJson(text), JSON.parse(text), text)
  }
})

test('isJsonObject is true for plain objects only', () => {
  // A user's object with a rawJSON key is a plain object all the same, not a RawJson
  const lookalike = parseJson('{"rawJSON": "1"}')
  assert.equal(isRawJson(lookalike), false)
  for (const value of [{}, lookalike]) {
    assert.equal(isJsonObject(value), true, JSON.stringify(value))
  }
  // The messages come from JSON.stringify because String() throws on a RawJson
  for (const value of [null, [], 'x', 1, true, parseJson('12345678901234567890')]) {
    assert.equal(isJsonObject(value), false, JSON.stringify(value))
  }
})

test('a "__proto__" key stays an ordinary own key', () => {
  // The second takes the slow path, where the reviver hands every value back
  for (const text of ['{"__proto__": {"x": 1}}', '{"__proto__": 12345678901234567890}']) {
    const value = parseJson(text)
    assert.ok(isJsonObject(value), text)
    assert.ok(Object.hasOwn(value, '__proto__'), text)
    assert.equal(Object.getPrototypeOf(value), Object.prototype, text)
    assert.equal(JSON.stringify(value), text.replaceAll(' ', ''))
  }
})

test('invalid JSON throws SyntaxError on both paths', () => {
  // The last one holds a run of 16 digits, so it fails on the slow path
  for (const text of ['{', '{"a": NaN}', '{"a": 12345678901234567890,']) {
    assert.throws(() => parseJson(text), SyntaxError, text)
  }
})

// stringifySpaced: JSON that puts a space after each ',' and ':' between items, where
// JSON.stringify puts none. A replayed body, and what a q_body search looks through, are
// those bytes.
//
// The right-hand sides are what it has to write for the values parsed from the left-hand sides
// (compared on Node 22.18.0, 24.2.0 and 26.11.1: no difference). They cover nested and empty
// containers, a string at the top, ',' ':' escaped quotes and a closing backslash inside strings,
// U+2028, control characters, integers past 2^53, non-ASCII keys and values, fractions and
// exponents.
const CASES: [string, string][] = [
  ['{"a":[1,{"b":null}],"c":"x, y: z"}', '{"a": [1, {"b": null}], "c": "x, y: z"}'],
  ['[]', '[]'],
  ['{}', '{}'],
  ['[[],{},[{}]]', '[[], {}, [{}]]'],
  ['"a, b: c"', '"a, b: c"'],
  [
    '{"q":"say \\"hi\\", ok","esc":"\\\\","k:":"v,","end":"x\\\\\\""}',
    '{"q": "say \\"hi\\", ok", "esc": "\\\\", "k:": "v,", "end": "x\\\\\\""}',
  ],
  [
    '{"u":"\u2028\u2029","c":"\\u0001\\u001f\u007f","w":"\\n\\t\\b\\f\\r"}',
    '{"u": "\u2028\u2029", "c": "\\u0001\\u001f\u007f", "w": "\\n\\t\\b\\f\\r"}',
  ],
  [
    '{"id":12345678901234567890,"neg":-98765432109876543210,"ok":true,"no":false,"none":null}',
    '{"id": 12345678901234567890, "neg": -98765432109876543210, "ok": true, "no": false, "none": null}',
  ],
  ['{"名字":"值","é":"日本","":""}', '{"名字": "值", "é": "日本", "": ""}'],
  ['{"f":[2.5,-0.5,0.1,1e+21,123456.789]}', '{"f": [2.5, -0.5, 0.1, 1e+21, 123456.789]}'],
  ['[[[["deep"]]],{"x":{"y":{"z":[1,2,3]}}}]', '[[[["deep"]]], {"x": {"y": {"z": [1, 2, 3]}}}]'],
]

test('stringifySpaced writes JSON with a space after each separator', () => {
  for (const [text, spaced] of CASES) {
    assert.equal(stringifySpaced(parseJson(text)), spaced, text)
  }
})

// Once parsed, 1.0 is the number 1 and nothing says how it was written.
test('numbers are written the JS way, not as they were spelled', () => {
  assert.equal(stringifySpaced(parseJson('[1.0, 1e16, 1e-05]')), '[1, 10000000000000000, 0.00001]')
})
