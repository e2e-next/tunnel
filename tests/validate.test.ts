// src/validate.ts: validation in lax mode, written by hand. Every type the admin
// API and the models validate with is held to tests/fixtures/config/lax.json;
// the tests after those cover what the fixture cannot hold (non-finite numbers,
// RawJson inputs, undefined) and the pieces the admin API builds 422s from.
// Nothing here imports src/models.ts: validate.ts sits below it.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { ValidationIssue } from '../src/errors.ts'
import { parseJson } from '../src/json.ts'
import {
  anyValue,
  atLeast,
  bool,
  check,
  dictOf,
  dictOrList,
  float,
  int,
  issue,
  listOf,
  model,
  nullable,
  oneOf,
  optional,
  required,
  str,
  validationErrorBody,
  withDefault,
  type IssueType,
  type Schema,
} from '../src/validate.ts'

interface LaxRow {
  schema: string
  input: unknown
  value?: unknown
  errors?: ValidationIssue[]
}
interface LaxFixture {
  enums: Record<'TunnelMode' | 'ReplayStrategy' | 'Fault' | 'DefaultMode', string[]>
  rows: LaxRow[]
}

const lax = JSON.parse(
  readFileSync(new URL('./fixtures/config/lax.json', import.meta.url), 'utf8'),
) as LaxFixture

/** The schemas lax.json has rows for, under the names it gives them */
const SCHEMAS: Record<string, Schema<unknown>> = {
  str,
  int,
  float,
  bool,
  TunnelMode: oneOf(lax.enums.TunnelMode),
  ReplayStrategy: oneOf(lax.enums.ReplayStrategy),
  Fault: oneOf(lax.enums.Fault),
  DefaultMode: oneOf(lax.enums.DefaultMode),
  'list[str]': listOf(str),
  'dict[str,str]': dictOf(str),
  'dict[str,any]': dictOf(anyValue),
  'dict|list': dictOrList,
  'int|None': nullable(int),
  'int>=1': atLeast(int, 1),
  'float>=0': atLeast(float, 0),
}

for (const [name, schema] of Object.entries(SCHEMAS)) {
  test(`every lax.json row for ${name}`, () => {
    for (const row of lax.rows.filter((r) => r.schema === name)) {
      assert.deepStrictEqual(
        check(schema, row.input),
        'value' in row ? { ok: true, value: row.value } : { ok: false, issues: row.errors },
        JSON.stringify(row.input),
      )
    }
  })
}

test('lax.json has rows for exactly the fifteen schemas checked here', () => {
  assert.equal(Object.keys(SCHEMAS).length, 15)
  assert.deepStrictEqual(new Set(lax.rows.map((row) => row.schema)), new Set(Object.keys(SCHEMAS)))
})

test('non-finite numbers, and strings that spell one, get finite_number', () => {
  // inf, infinity and nan are read in any case (in_f too, once the underscore is
  // gone), and refused like NaN and the infinities: config.json would otherwise
  // hold NaN or Infinity, which JSON.parse cannot read back
  const cases: [Schema<unknown>, unknown][] = [
    ...[NaN, Infinity, -Infinity, 'inf', ' -Infinity ', 'nan', '1e400', 'in_f'].map(
      (input): [Schema<unknown>, unknown] => [float, input],
    ),
    [int, NaN],
    [int, Infinity],
    [atLeast(float, 0), 'inf'],
  ]
  for (const [schema, input] of cases) {
    assert.deepStrictEqual(
      check(schema, input),
      {
        ok: false,
        issues: [{ type: 'finite_number', loc: [], msg: 'Input should be a finite number', input }],
      },
      String(input),
    )
  }
})

test('integers JSON.parse could not hold count as the number they spell for int, float and bool, and keep their digits everywhere else', () => {
  const big = parseJson('12345678901234567890')
  // 12345678901234567000 is the double nearest 12345678901234567890
  assert.deepStrictEqual(check(int, big), { ok: true, value: 12345678901234567000 })
  assert.deepStrictEqual(check(float, big), { ok: true, value: 12345678901234567000 })

  /** The issue types check() reports, each issue's input checked to be the RawJson itself */
  function refused(schema: Schema<unknown>, input: unknown): string[] {
    const result = check(schema, input)
    assert.ok(!result.ok, JSON.stringify(input))
    for (const reported of result.issues) assert.equal(reported.input, input)
    return result.issues.map((reported) => reported.type)
  }
  // Past i64 there is no integer to compare with 0 and 1; within it the number is just not 0 or 1
  assert.deepStrictEqual(refused(bool, big), ['bool_type'])
  assert.deepStrictEqual(refused(bool, parseJson('9007199254740993')), ['bool_parsing'])
  assert.deepStrictEqual(refused(str, big), ['string_type'])
  assert.deepStrictEqual(refused(listOf(str), big), ['list_type'])
  assert.deepStrictEqual(refused(dictOf(str), big), ['dict_type'])
  assert.deepStrictEqual(refused(model<{ a: number }>('M', { a: required(int) }), big), [
    'model_type',
  ])
  assert.deepStrictEqual(refused(dictOrList, big), ['dict_type', 'list_type'])

  // The 422 shows the digits the client sent
  const result = check(str, big, { at: ['body', 'id'] })
  assert.ok(!result.ok)
  assert.match(
    JSON.stringify(validationErrorBody(result.issues)),
    /"loc":\["body","id"\],"msg":"Input should be a valid string","input":12345678901234567890\}/,
  )

  const kept = check(dictOf(anyValue), parseJson('{"a": 12345678901234567890}'))
  assert.ok(kept.ok)
  assert.equal(JSON.stringify(kept.value), '{"a":12345678901234567890}')
})

test('issue() words every type with its fixed msg', () => {
  const WORDING: [IssueType, string, Record<string, unknown>?][] = [
    ['missing', 'Field required'],
    ['extra_forbidden', 'Extra inputs are not permitted'],
    ['string_type', 'Input should be a valid string'],
    ['int_type', 'Input should be a valid integer'],
    ['int_parsing', 'Input should be a valid integer, unable to parse string as an integer'],
    ['int_from_float', 'Input should be a valid integer, got a number with a fractional part'],
    ['finite_number', 'Input should be a finite number'],
    ['float_type', 'Input should be a valid number'],
    ['float_parsing', 'Input should be a valid number, unable to parse string as a number'],
    ['bool_type', 'Input should be a valid boolean'],
    ['bool_parsing', 'Input should be a valid boolean, unable to interpret input'],
    ['enum', "Input should be 'a' or 'b'", { expected: "'a' or 'b'" }],
    ['list_type', 'Input should be a valid list'],
    ['dict_type', 'Input should be a valid dictionary'],
    ['model_type', 'Input should be a valid dictionary or instance of M', { class_name: 'M' }],
    [
      'model_attributes_type',
      'Input should be a valid dictionary or object to extract fields from',
    ],
    ['greater_than_equal', 'Input should be greater than or equal to 1', { ge: 1 }],
    ['json_invalid', 'JSON decode error', { error: 'Expecting value' }],
  ]
  assert.equal(new Set(WORDING.map(([type]) => type)).size, 18)
  for (const [type, msg, ctx] of WORDING) {
    const made = issue(type, ['body'], 'x', ctx)
    assert.deepStrictEqual(
      made,
      ctx === undefined
        ? { type, loc: ['body'], msg, input: 'x' }
        : { type, loc: ['body'], msg, input: 'x', ctx },
      type,
    )
    assert.equal('ctx' in made, ctx !== undefined, type)
  }

  // An enum's values are listed the way English lists things
  const EXPECTED: [string[], string][] = [
    [['a'], "'a'"],
    [['a', 'b'], "'a' or 'b'"],
    [['a', 'b', 'c'], "'a', 'b' or 'c'"],
  ]
  for (const [values, expected] of EXPECTED) {
    assert.deepStrictEqual(check(oneOf(values), 'z'), {
      ok: false,
      issues: [
        {
          type: 'enum',
          loc: [],
          msg: `Input should be ${expected}`,
          input: 'z',
          ctx: { expected },
        },
      ],
    })
  }
})

test('forbid reports each extra field after the declared ones, in input order; ignore drops them', () => {
  const forbid = model<{ a: number }>('M', { a: required(int) }, { extra: 'forbid' })
  assert.deepStrictEqual(check(forbid, { zzz: 1, a: 'x', aaa: 2 }), {
    ok: false,
    issues: [
      {
        type: 'int_parsing',
        loc: ['a'],
        msg: 'Input should be a valid integer, unable to parse string as an integer',
        input: 'x',
      },
      { type: 'extra_forbidden', loc: ['zzz'], msg: 'Extra inputs are not permitted', input: 1 },
      { type: 'extra_forbidden', loc: ['aaa'], msg: 'Extra inputs are not permitted', input: 2 },
    ],
  })

  const ignore = model<{ a: number }>('M', { a: required(int) }, { extra: 'ignore' })
  assert.deepStrictEqual(check(ignore, { zzz: 1, a: '1' }), { ok: true, value: { a: 1 } })
  // The default, as in every model of src/models.ts
  assert.equal(model<{ a: number }>('M', { a: required(int) }).extra, 'ignore')
})

test('a key whose value is undefined counts as not given', () => {
  // JSON has no undefined, but TS callers can spread one in: { ...rule, ...fields }
  const m = model<{ a: number; b: number; c?: number }>('M', {
    a: required(int),
    b: withDefault(int, () => 7),
    c: optional(int),
  })
  const input = { a: undefined, b: undefined, c: undefined }
  assert.deepStrictEqual(check(m, input), {
    ok: false,
    issues: [{ type: 'missing', loc: ['a'], msg: 'Field required', input }],
  })
  assert.deepStrictEqual(check(m, { a: 1, b: undefined, c: undefined }), {
    ok: true,
    value: { a: 1, b: 7 },
  })

  // The same goes for a key the model does not declare and for a dict's key: no issue whose input
  // is undefined, which a 422 would write with no input at all
  const forbid = model<{ a: number }>('M', { a: required(int) }, { extra: 'forbid' })
  assert.deepStrictEqual(check(forbid, { a: 1, zzz: undefined }), { ok: true, value: { a: 1 } })
  assert.deepStrictEqual(check(dictOf(str), { a: 'x', b: undefined }), {
    ok: true,
    value: { a: 'x' },
  })
})

test('"__proto__" is an ordinary key in dictOf and dictOrList', () => {
  const input: unknown = JSON.parse('{"__proto__": "x"}')
  const schemas: Schema<unknown>[] = [dictOf(str), dictOrList]
  for (const schema of schemas) {
    const result = check(schema, input)
    assert.ok(result.ok)
    const value = result.value as object
    assert.notEqual(value, input)
    assert.ok(Object.hasOwn(value, '__proto__'))
    assert.equal(Object.getPrototypeOf(value), Object.prototype)
    assert.equal(JSON.stringify(value), '{"__proto__":"x"}')
  }
})

test('a model given something other than an object: model_type, or model_attributes_type with fromAttributes', () => {
  const m = model<{ a: number }>('M', { a: required(int) })
  assert.deepStrictEqual(check(m, 'x'), {
    ok: false,
    issues: [
      {
        type: 'model_type',
        loc: [],
        msg: 'Input should be a valid dictionary or instance of M',
        input: 'x',
        ctx: { class_name: 'M' },
      },
    ],
  })

  // A request body is validated with fromAttributes, nested models included
  const ATTRIBUTES = 'Input should be a valid dictionary or object to extract fields from'
  assert.deepStrictEqual(check(m, 'x', { fromAttributes: true, at: ['body'] }), {
    ok: false,
    issues: [{ type: 'model_attributes_type', loc: ['body'], msg: ATTRIBUTES, input: 'x' }],
  })
  assert.deepStrictEqual(check(listOf(m), ['x'], { fromAttributes: true, at: ['body', 'mocks'] }), {
    ok: false,
    issues: [
      { type: 'model_attributes_type', loc: ['body', 'mocks', 0], msg: ATTRIBUTES, input: 'x' },
    ],
  })
})

test('validationErrorBody writes type, loc, msg, input, ctx in that order, and ctx only when there is one', () => {
  const shuffled: ValidationIssue = {
    ctx: { ge: 1 },
    input: '0',
    msg: 'Input should be greater than or equal to 1',
    loc: ['query', 'count'],
    type: 'greater_than_equal',
  }
  const plain: ValidationIssue = {
    input: 'abc',
    msg: 'Input should be a valid integer, unable to parse string as an integer',
    type: 'int_parsing',
    loc: ['query', 'since'],
  }
  assert.equal(
    JSON.stringify(validationErrorBody([shuffled, plain])),
    '{"detail":[' +
      '{"type":"greater_than_equal","loc":["query","count"],"msg":"Input should be greater than or equal to 1","input":"0","ctx":{"ge":1}},' +
      '{"type":"int_parsing","loc":["query","since"],"msg":"Input should be a valid integer, unable to parse string as an integer","input":"abc"}' +
      ']}',
  )
  // A ctx key holding undefined is no ctx either
  const [written] = validationErrorBody([{ ...plain, ctx: undefined }]).detail
  assert.ok(written)
  assert.deepStrictEqual(Object.keys(written), ['type', 'loc', 'msg', 'input'])
})
