// Validation in lax mode, written by hand: the conversions the models and
// request bodies get, and the errors, with the type, loc, msg, input and ctx
// the admin API puts in a 422. No library does this. Zod, Valibot and the rest
// convert with Number() and word their own errors, so every scalar, every
// message and the union's pair of errors would be written by hand all the
// same, on top of a package the install budget has no room for.
//
// tests/fixtures/config/lax.json is the reference: tests/validate.test.ts
// holds every schema here to it. NaN and the infinities get finite_number, as
// config.json would otherwise hold a NaN that JSON.parse cannot read back.
//
// A RawJson, an integer past 2^53 that parseJson kept as its digits, counts as
// the number it spells (the nearest double) for int, float and bool. Every
// other schema takes it as neither a string nor an object nor an array, and Any
// keeps it as it is. An issue's input is the RawJson itself, so a 422 shows the
// digits the client sent.
import type { ValidationIssue } from './errors.ts'
import { isJsonObject, isRawJson, type JsonObject, type JsonValue } from './json.ts'

export type Loc = (string | number)[]
/** What Schema.check returns once it has recorded in run.issues why the input does not fit */
export const INVALID: unique symbol = Symbol('INVALID')
export type Invalid = typeof INVALID
/** One validation in progress. Exported only so that a hand-written Schema can be added; callers use check(). */
export interface Run {
  readonly issues: ValidationIssue[]
  /** For request bodies: a model that is not an object is model_attributes_type instead of model_type */
  readonly fromAttributes: boolean
}
/** Turns an input into a T, or records why not in run.issues and returns INVALID.
 *  A container is INVALID exactly when checking what it holds recorded an issue. */
export interface Schema<T> {
  check(input: unknown, at: Loc, run: Run): T | Invalid
}

// ---- Entry points ----

export type IssueType =
  | 'missing'
  | 'extra_forbidden'
  | 'string_type'
  | 'int_type'
  | 'int_parsing'
  | 'int_from_float'
  | 'finite_number'
  | 'float_type'
  | 'float_parsing'
  | 'bool_type'
  | 'bool_parsing'
  | 'enum'
  | 'list_type'
  | 'dict_type'
  | 'model_type'
  | 'model_attributes_type'
  | 'greater_than_equal'
  | 'json_invalid'

/** Each type's msg, fixed word for word; a {name} is filled in from the issue's ctx */
const MESSAGES: Readonly<Record<IssueType, string>> = {
  missing: 'Field required',
  extra_forbidden: 'Extra inputs are not permitted',
  string_type: 'Input should be a valid string',
  int_type: 'Input should be a valid integer',
  int_parsing: 'Input should be a valid integer, unable to parse string as an integer',
  int_from_float: 'Input should be a valid integer, got a number with a fractional part',
  finite_number: 'Input should be a finite number',
  float_type: 'Input should be a valid number',
  float_parsing: 'Input should be a valid number, unable to parse string as a number',
  bool_type: 'Input should be a valid boolean',
  bool_parsing: 'Input should be a valid boolean, unable to interpret input',
  enum: 'Input should be {expected}',
  list_type: 'Input should be a valid list',
  dict_type: 'Input should be a valid dictionary',
  model_type: 'Input should be a valid dictionary or instance of {class_name}',
  model_attributes_type: 'Input should be a valid dictionary or object to extract fields from',
  greater_than_equal: 'Input should be greater than or equal to {ge}',
  json_invalid: 'JSON decode error',
}

/** An issue's keys in the order type, loc, msg, input, ctx; ctx only when there is one */
function inOrder({ type, loc, msg, input, ctx }: ValidationIssue): ValidationIssue {
  return ctx === undefined ? { type, loc, msg, input } : { type, loc, msg, input, ctx }
}

/** An issue with the msg for its type, for the ones the admin API raises itself (a missing body, bad JSON) */
export function issue(
  type: IssueType,
  loc: Loc,
  input: unknown,
  ctx?: Record<string, unknown>,
): ValidationIssue {
  const msg = MESSAGES[type].replace(/\{(\w+)\}/g, (_, name: string) => String(ctx?.[name]))
  return inOrder({ type, loc, msg, input, ctx })
}

/** The body of a 422: {"detail": [{type, loc, msg, input, ctx?}, …]}, keys in that order */
export function validationErrorBody(issues: readonly ValidationIssue[]): {
  detail: ValidationIssue[]
} {
  return { detail: issues.map(inOrder) }
}

/** Validates input against schema, collecting every issue rather than stopping at the first. Nested
 *  issues come depth first, each loc the whole path: options.at (the source, as ['body']) and below. */
export function check<T>(
  schema: Schema<T>,
  input: unknown,
  options?: { at?: Loc; fromAttributes?: boolean },
): { ok: true; value: T } | { ok: false; issues: ValidationIssue[] } {
  const run: Run = { issues: [], fromAttributes: options?.fromAttributes ?? false }
  const value = schema.check(input, options?.at ?? [], run)
  return value === INVALID ? { ok: false, issues: run.issues } : { ok: true, value }
}

/** Records an issue for a schema, and gives it INVALID to return */
function fail(
  run: Run,
  type: IssueType,
  at: Loc,
  input: unknown,
  ctx?: Record<string, unknown>,
): Invalid {
  run.issues.push(issue(type, at, input, ctx))
  return INVALID
}

// ---- Strings read as numbers and booleans ----
//
// Parsed step by step rather than approximated with a regular expression,
// quirks included: "0-1" is the int -1, "1_." is the float 1, and " 2_00 " is
// the int 200 but not a float. lax.json holds each of them.

/** A character of Unicode's White_Space, what Rust's str::trim takes off: U+0085 is one and U+FEFF
 *  is not, the other way round from String.prototype.trim */
const WHITESPACE = /[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/

/** Rust's str::trim. A loop rather than /…+$/, which would take time quadratic in a run of whitespace
 *  that something else follows. */
function trim(s: string): string {
  let start = 0
  let end = s.length
  while (start < end && WHITESPACE.test(s.charAt(start))) start++
  while (end > start && WHITESPACE.test(s.charAt(end - 1))) end--
  return s.slice(start, end)
}

/** An integer in JSON's grammar */
const JSON_INT = /^-?(?:0|[1-9]\d*)$/

/** What Rust's f64::from_str reads, inf, infinity and nan in any case included. Number() reads
 *  all of these the way Rust does, but for those three: it makes NaN of them, or ±Infinity of
 *  Infinity, which float refuses as finite_number all the same. \d+(?:\.\d*)? matches the strings
 *  \d+\.?\d* does, but that one backtracks in time quadratic in a run of digits that fails. */
const RUST_F64 = /^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|inf|infinity|nan)$/i

/** A string as a boolean: 0 and 1, and the words in ASCII case only (Rust's eq_ignore_ascii_case);
 *  nothing is trimmed */
function strAsBool(s: string): boolean | undefined {
  const lower = s.replace(/[A-Z]+/g, (letters) => letters.toLowerCase())
  if (['0', 'f', 'n', 'no', 'off', 'false'].includes(lower)) return false
  if (['1', 't', 'y', 'on', 'yes', 'true'].includes(lower)) return true
  return undefined
}

/** A string as an integer: the trimmed string as a JSON integer; failing that, what cleanIntStr
 *  leaves of it. Past 309 digits Number() gives Infinity, which int refuses as finite_number. */
function strAsInt(s: string): number | undefined {
  const trimmed = trim(s)
  if (JSON_INT.test(trimmed)) return Number(trimmed)
  const cleaned = cleanIntStr(trimmed)
  return cleaned !== undefined && JSON_INT.test(cleaned) ? Number(cleaned) : undefined
}

/** Takes off whitespace, a sign, leading zeros, a fraction of zeros only and underscores, for
 *  strAsInt to try what is left; undefined when it can already tell that no integer will be. */
function cleanIntStr(s: string): string | undefined {
  s = trim(s)
  // A '+' goes, unless a '-' follows it
  if (s.startsWith('+')) {
    s = s.slice(1)
    if (s.startsWith('-')) return undefined
  }
  // A '-' goes, to be put back at the end, unless another sign follows it
  const negative = s.startsWith('-')
  if (negative) {
    s = s.slice(1)
    if (s.startsWith('-') || s.startsWith('+')) return undefined
  }
  const rest = stripLeadingZeros(s)
  if (rest === undefined) return undefined
  // 200.0 and 200.00, but not 200.
  s = rest.replace(/\.0+$/, '')
  s = stripUnderscores(s) ?? s
  return negative ? `-${s}` : s
}

/** Leading zeros go, and underscores among them, but one zero stays before a '.' and a string of
 *  zeros keeps its last character. It hands on what follows the zeros from the first other digit
 *  or '-', which is why "0-1" reads as -1 and "0__1" as 1. */
function stripLeadingZeros(s: string): string | undefined {
  const first = s.charAt(0)
  // Another digit, or a '-': the string as it is. Anything else is no number
  if (first !== '0') return isNonZeroDigit(first) || first === '-' ? s : undefined
  for (let i = 1; i < s.length; i++) {
    const c = s.charAt(i)
    if (c === '0' || c === '_') continue
    if (isNonZeroDigit(c) || c === '-') return s.slice(i)
    if (c === '.') return s.slice(i - 1)
    return undefined
  }
  // Zeros and underscores only: the last character, a '0', or an '_' that fails later
  return s.slice(-1)
}

/** For one character: is it 1 to 9 */
function isNonZeroDigit(c: string): boolean {
  return c >= '1' && c <= '9'
}

/** The string without its underscores, or undefined when one starts or ends it or two stand
 *  together. One need not stand between two digits: "1_." and "._5" read as floats. */
function stripUnderscores(s: string): string | undefined {
  if (s.startsWith('_') || s.endsWith('_') || s.includes('__')) return undefined
  return s.replaceAll('_', '')
}

/** A string as a float: the trimmed string as Rust's f64 reads it; failing that, the string as it
 *  was given, untrimmed, without its underscores. So " 2_00 " is no float. */
function strAsFloat(s: string): number | undefined {
  const trimmed = trim(s)
  if (RUST_F64.test(trimmed)) return Number(trimmed)
  const stripped = stripUnderscores(s)
  return stripped !== undefined && RUST_F64.test(stripped) ? Number(stripped) : undefined
}

// ---- Scalars, in lax mode ----

/** A number as it is, a boolean as 1 or 0, a RawJson as the double nearest its digits */
function numeric(input: unknown): number | undefined {
  if (typeof input === 'number') return input
  if (typeof input === 'boolean') return input ? 1 : 0
  if (isRawJson(input)) return Number(input.rawJSON)
  return undefined
}

/** A string and nothing else. Lax mode turns no number into one */
export const str: Schema<string> = {
  check: (input, at, run) =>
    typeof input === 'string' ? input : fail(run, 'string_type', at, input),
}

/** An integer, true or false as 1 or 0, a number without a fraction, or a string strAsInt reads */
export const int: Schema<number> = {
  check(input, at, run) {
    const n = typeof input === 'string' ? strAsInt(input) : numeric(input)
    if (n === undefined) {
      return fail(run, typeof input === 'string' ? 'int_parsing' : 'int_type', at, input)
    }
    if (!Number.isFinite(n)) return fail(run, 'finite_number', at, input)
    if (!Number.isInteger(n)) return fail(run, 'int_from_float', at, input)
    // + 0 makes -0 a 0
    return n + 0
  },
}

/** A finite number, true or false as 1 or 0, or a string strAsFloat reads */
export const float: Schema<number> = {
  check(input, at, run) {
    const n = typeof input === 'string' ? strAsFloat(input) : numeric(input)
    if (n === undefined) {
      return fail(run, typeof input === 'string' ? 'float_parsing' : 'float_type', at, input)
    }
    return Number.isFinite(n) ? n : fail(run, 'finite_number', at, input)
  },
}

/** A boolean, the numbers 0 and 1, or a string strAsBool reads */
export const bool: Schema<boolean> = {
  check(input, at, run) {
    if (typeof input === 'boolean') return input
    if (typeof input === 'string') return strAsBool(input) ?? fail(run, 'bool_parsing', at, input)
    const n = numeric(input)
    if (n === 0 || n === 1) return n === 1
    // An integer within i64 is compared with 0 and 1, and the answer is no. Past i64, or with a
    // fraction, there is no integer to compare
    if (n !== undefined && Number.isInteger(n) && Math.abs(n) < 2 ** 63) {
      return fail(run, 'bool_parsing', at, input)
    }
    return fail(run, 'bool_type', at, input)
  },
}

/** Anything, as it is */
export const anyValue: Schema<JsonValue> = { check: (input) => input as JsonValue }

/** One of the values, exactly. The message lists them as 'a', 'b' or 'c' */
export function oneOf<const V extends readonly string[]>(values: V): Schema<V[number]> {
  const quoted = values.map((value) => `'${value}'`)
  const expected =
    quoted.length < 2 ? quoted.join('') : `${quoted.slice(0, -1).join(', ')} or ${quoted.at(-1)}`
  return {
    check: (input, at, run) =>
      typeof input === 'string' && values.includes(input)
        ? (input as V[number])
        : fail(run, 'enum', at, input, { expected }),
  }
}

// ---- Containers ----

/** An array, each item checked at its index. The result is a new array */
export function listOf<T>(item: Schema<T>): Schema<T[]> {
  return {
    check(input, at, run) {
      if (!Array.isArray(input)) return fail(run, 'list_type', at, input)
      const before = run.issues.length
      const items: T[] = []
      for (const [index, given] of input.entries()) {
        const value = item.check(given, [...at, index], run)
        if (value !== INVALID) items.push(value)
      }
      return run.issues.length === before ? items : INVALID
    },
  }
}

/** A JSON object (not an array, not a RawJson), each value checked under its key; a key whose
 *  value is undefined counts as not given and is left out. The result is built with
 *  Object.fromEntries, so "__proto__" is an ordinary key */
export function dictOf<T>(value: Schema<T>): Schema<Record<string, T>> {
  return {
    check(input, at, run) {
      if (!isJsonObject(input)) return fail(run, 'dict_type', at, input)
      const before = run.issues.length
      const entries: [string, T][] = []
      for (const [key, given] of Object.entries(input)) {
        if (given === undefined) continue
        const checked = value.check(given, [...at, key], run)
        if (checked !== INVALID) entries.push([key, checked])
      }
      return run.issues.length === before ? Object.fromEntries(entries) : INVALID
    },
  }
}

/** A JSON object or an array, copied one level deep. Anything else fails both members of the
 *  union, and both are reported */
export const dictOrList: Schema<JsonObject | JsonValue[]> = {
  check(input, at, run) {
    if (isJsonObject(input)) return { ...input }
    if (Array.isArray(input)) return [...(input as JsonValue[])]
    fail(run, 'dict_type', [...at, 'dict[str,any]'], input)
    return fail(run, 'list_type', [...at, 'list[any]'], input)
  },
}

// ---- Modifiers ----

/** null as it is, anything else for schema to check. Its issues are schema's own, with no extra
 *  step in loc */
export function nullable<T>(schema: Schema<T>): Schema<T | null> {
  return { check: (input, at, run) => (input === null ? null : schema.check(input, at, run)) }
}

/** A lower bound: schema converts first, then the value must be at least ge. The issue's input
 *  is the input as given: a query parameter's string */
export function atLeast(schema: Schema<number>, ge: number): Schema<number> {
  return {
    check(input, at, run) {
      const value = schema.check(input, at, run)
      return value === INVALID || value >= ge
        ? value
        : fail(run, 'greater_than_equal', at, input, { ge })
    },
  }
}

// ---- Models ----

export type Field<T> =
  | { readonly kind: 'required'; readonly schema: Schema<T> }
  | { readonly kind: 'default'; readonly schema: Schema<T>; readonly make: () => T }
  | { readonly kind: 'optional'; readonly schema: Schema<T> }

/** A field the input has to give: 'missing' when it does not */
export function required<T>(schema: Schema<T>): Field<T> {
  return { kind: 'required', schema }
}

/** A field that is make()'s value when the input leaves it out. Nothing checks it */
export function withDefault<T>(schema: Schema<T>, make: () => T): Field<T> {
  return { kind: 'default', schema, make }
}

/** A field that stays out of the result when the input leaves it out */
export function optional<T>(schema: Schema<T>): Field<T> {
  return { kind: 'optional', schema }
}

export interface ModelSchema<T> extends Schema<T> {
  readonly name: string // 'TunnelConfig'
  readonly fields: { readonly [K in keyof T]-?: Field<Exclude<T[K], undefined>> }
  readonly extra: 'ignore' | 'forbid'
}

/** A model. Call it with T written out, model<SslProxying>('SslProxying', { … }): the type
 *  checker then catches a field whose schema has the wrong type, a field left out and a field too
 *  many, where an inferred T would let them through.
 *
 *  Given a JSON object, it goes through the fields in the order they are declared. A key the input
 *  gives, with a value that is not undefined, is checked with the field's schema; one it leaves out
 *  is 'missing' (its input the whole object) when required, make()'s value when it has a default,
 *  and not there at all when optional. Then come the keys it does not declare, in the input's
 *  order and again only those whose value is not undefined: one extra_forbidden each with extra
 *  'forbid', dropped with 'ignore', the default. The result is a new object with its keys
 *  in the declared order. */
export function model<T>(
  name: string,
  fields: ModelSchema<T>['fields'],
  options?: { extra?: 'ignore' | 'forbid' },
): ModelSchema<T> {
  const declared: [string, Field<unknown>][] = Object.entries(fields)
  const names = new Set(declared.map(([key]) => key))
  const extra = options?.extra ?? 'ignore'
  return {
    name,
    fields,
    extra,
    check(input, at, run) {
      if (!isJsonObject(input)) {
        return run.fromAttributes
          ? fail(run, 'model_attributes_type', at, input)
          : fail(run, 'model_type', at, input, { class_name: name })
      }
      const before = run.issues.length
      const entries: [string, unknown][] = []
      for (const [key, field] of declared) {
        const given = Object.hasOwn(input, key) ? input[key] : undefined
        if (given !== undefined) {
          const value = field.schema.check(given, [...at, key], run)
          if (value !== INVALID) entries.push([key, value])
        } else if (field.kind === 'required') {
          fail(run, 'missing', [...at, key], input)
        } else if (field.kind === 'default') {
          entries.push([key, field.make()])
        }
      }
      if (extra === 'forbid') {
        for (const [key, given] of Object.entries(input)) {
          if (!names.has(key) && given !== undefined) {
            fail(run, 'extra_forbidden', [...at, key], given)
          }
        }
      }
      return run.issues.length === before ? (Object.fromEntries(entries) as T) : INVALID
    },
  }
}

/** makeX: the fields given, those whose value is not undefined, and the schema's defaults for the
 *  rest, in the order the schema declares them. Nothing is checked, and nothing given is copied. */
export function make<T>(schema: ModelSchema<T>, fields: Partial<T> = {}): T {
  const given = fields as Record<string, unknown>
  const declared: [string, Field<unknown>][] = Object.entries(schema.fields)
  const entries: [string, unknown][] = []
  for (const [key, field] of declared) {
    const value = given[key]
    if (value !== undefined) entries.push([key, value])
    else if (field.kind === 'default') entries.push([key, field.make()])
  }
  return Object.fromEntries(entries) as T
}
