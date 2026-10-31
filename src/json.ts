// JSON from users: the rules in config.json with their mock bodies, request
// bodies, recordings. JSON.parse rounds an integer past 2^53 to the nearest
// double, so 12345678901234567890 comes back as 12345678901234567000 and a
// replayed Int64 ID would be wrong. parseJson keeps such an integer as a
// RawJson holding its digits, which JSON.stringify writes back as they were.
//
// Three rules come with it. Parse user JSON with parseJson. Test for an object
// with isJsonObject: a RawJson is an object too, and code that takes it apart
// writes {"rawJSON": "…"}. Never structuredClone user JSON or post it to a
// worker, which throws DataCloneError on a RawJson; send the text and parseJson
// it on the other side. JSON that tunnel writes for itself, with no user data
// in it, can go through JSON.parse.
//
// The reviver makes parsing about eight times slower, so parseJson takes it
// only for text that might hold such an integer. An integer past 2^53 has at
// least 16 digits (2^53 is 9007199254740992), and the character before its
// first digit is never a digit, '.', 'e' or 'E': it is a '-', whitespace, '[',
// ',', ':' or the start of the text. Text without such a run of 16 digits holds
// no integer the reviver would change, so JSON.parse alone gives the same
// result. A long run of digits inside a string takes the slow path for
// nothing: slower, never wrong.
//
// Node 22.18 and later have JSON.rawJSON, JSON.isRawJSON and the reviver's
// third argument, context.source, but TypeScript's lib (7.0.2, esnext
// included) and @types/node 22 do not declare them yet. This module alone
// touches them, through the typed view of JSON below rather than a declare
// global.

/** An integer JSON.parse could not hold exactly (beyond ±(2^53 − 1)), kept as its digits.
 *  JSON.stringify writes the digits back as they were. Frozen, null prototype, never a JSON object. */
export interface RawJson {
  readonly rawJSON: string
}
export type JsonValue =
  null | boolean | number | string | RawJson | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

interface JsonWithSource {
  parse(
    text: string,
    reviver: (key: string, value: unknown, context: { source?: string }) => unknown,
  ): unknown
  rawJSON(text: string): RawJson
  isRawJSON(value: unknown): boolean
}
const NATIVE = JSON as unknown as JsonWithSource

/** Where an integer past 2^53 could start: 16 digits, not right after a digit, '.', 'e' or 'E' */
const MIGHT_HOLD_A_BIG_INTEGER = /(?<![\d.eE])\d{16}/

/** parseJson's reviver: an integer literal that is not a safe integer becomes a RawJson of its
 *  digits. Fractions and exponents stay numbers. Objects and arrays come with no source. */
function keepBigIntegers(_key: string, value: unknown, context: { source?: string }): unknown {
  if (
    typeof value === 'number' &&
    !Number.isSafeInteger(value) &&
    context.source !== undefined &&
    /^-?\d+$/.test(context.source)
  ) {
    return NATIVE.rawJSON(context.source)
  }
  return value
}

/** JSON.parse for user JSON: an integer literal past 2^53 comes back as a RawJson holding its digits.
 *  Text that is not JSON throws JSON.parse's SyntaxError. */
export function parseJson(text: string): JsonValue {
  if (!MIGHT_HOLD_A_BIG_INTEGER.test(text)) return JSON.parse(text)
  return NATIVE.parse(text, keepBigIntegers) as JsonValue
}

/** A JSON object: not null, not an array, not a RawJson */
export function isJsonObject(value: unknown): value is JsonObject {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !NATIVE.isRawJSON(value)
  )
}

/** What parseJson makes of an integer past 2^53 */
export function isRawJson(value: unknown): value is RawJson {
  return NATIVE.isRawJSON(value)
}

/** stringifySpaced's pattern: a whole JSON string, or a ',' or ':' outside every string.
 *  It runs over JSON.stringify's output from left to right, where the first '"' outside a string
 *  always opens one, so the first branch takes each string whole, up to its closing quote: an
 *  escaped quote or backslash goes by as '\\.' and never ends it early, and a ',' or ':' inside a
 *  string never reaches the second branch. Outside strings, a ',' or ':' is always a separator: no
 *  number, literal or RawJson holds one. '[^"\\]+' takes a run of plain characters at a time
 *  rather than one per round of the '*', about 25% faster (2.8 ms against 3.7 ms on a 2 MB body). */
const STRING_OR_SEPARATOR = /"(?:[^"\\]+|\\.)*"|[,:]/g

/** JSON with ', ' and ': ' between the items of a container, everything else as JSON.stringify
 *  writes it (a RawJson's digits as they are, non-ASCII as it is, control characters escaped).
 *  Numbers are written the JS way: 1.0 as 1, 1e+16 as 10000000000000000. `replacer` is
 *  JSON.stringify's, for a value it cannot write by itself: a script's BigInt
 *  (script-context.ts). */
export function stringifySpaced(
  value: JsonValue,
  replacer?: (this: unknown, key: string, value: unknown) => unknown,
): string {
  // A string comes back as it is; a separator gets the space after it
  return JSON.stringify(value, replacer).replace(STRING_OR_SEPARATOR, (match) =>
    match.startsWith('"') ? match : `${match} `,
  )
}
