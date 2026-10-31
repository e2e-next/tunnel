/**
 * The caller gave a bad value: a key that does not parse, a session name that
 * is not allowed, import data of the wrong shape. The message is the one
 * sentence a person reads.
 *
 * Domain code throws it whenever the user got something wrong: the admin API
 * answers it with 400 {"detail": message}, the CLI prints it as one line and
 * exits 1. Any other exception is a bug and gets a 500, so never wrap one in a
 * UserError. Wherever tests, the panel, the CLI or the docs read a message, its
 * wording is fixed word for word.
 */
export class UserError extends Error {
  override name = 'UserError'
}

/** One thing wrong with an input, in the shape a 422's `detail` holds. */
export interface ValidationIssue {
  type: string // the error type: 'missing', 'int_parsing', …
  loc: (string | number)[] // where, including the source prefix the caller gave ('body', 'query', …)
  msg: string // the type's sentence: 'Field required', …
  input: unknown // the offending input; for 'missing', the object the field was missing from
  ctx?: Record<string, unknown> // only for the types that carry one: enum, model_type, greater_than_equal, json_invalid
}

/** An input that does not fit a model: what parse* and the manager's update* throw. check() returns the issues
 *  instead of throwing. Not a UserError (that is a 400): one that escapes update* means the admin API let
 *  through a value the model refuses.
 *
 *  The message is one line, since it goes into the log: "2 validation errors for TunnelRequestConfig: ",
 *  then each issue as loc.join('.') + ': ' + msg (just msg when loc is empty), joined with '; '. That is
 *  how the panel's detailOf words an issue. */
export class ValidationError extends Error {
  override name = 'ValidationError'
  readonly title: string // the model's name: 'TunnelConfig'
  readonly issues: ValidationIssue[]
  constructor(title: string, issues: ValidationIssue[]) {
    const n = issues.length
    const each = issues.map((issue) =>
      issue.loc.length === 0 ? issue.msg : `${issue.loc.join('.')}: ${issue.msg}`,
    )
    const message = `${n} validation error${n === 1 ? '' : 's'} for ${title}: ${each.join('; ')}`
    super(message)
    this.title = title
    this.issues = issues
  }
}

/**
 * The categories C (controls, formats, surrogates, private use, unassigned) and Z
 * (separators), the space among them. repr() writes all but the space as escapes.
 */
const NOT_PRINTABLE = /^[\p{C}\p{Z}]$/u

/**
 * A string quoted for an error or a log line. Single quotes, or double ones when the
 * value has a ' and no ". A backslash goes before a backslash and before that quote;
 * a tab, a newline and a carriage return are \t, \n and \r; any other character that
 * is not printable is \xNN below U+0100, \uNNNN below U+10000 and \UNNNNNNNN above,
 * in lower case hex; the rest stays as it is.
 *
 * It takes a string and nothing else. Where a list or an object is printed this way
 * (the CLI prints a 422's detail list so), that is built on top of this.
 */
export function repr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'"
  let out = quote
  // By code point: a character past U+FFFF is one character, and so is a lone surrogate
  for (const char of value) {
    if (char === quote || char === '\\') {
      out += `\\${char}`
    } else if (char === '\t') {
      out += '\\t'
    } else if (char === '\n') {
      out += '\\n'
    } else if (char === '\r') {
      out += '\\r'
    } else if (char !== ' ' && NOT_PRINTABLE.test(char)) {
      const code = char.codePointAt(0)!
      const hex = code.toString(16)
      if (code < 0x100) out += `\\x${hex.padStart(2, '0')}`
      else if (code < 0x10000) out += `\\u${hex.padStart(4, '0')}`
      else out += `\\U${hex.padStart(8, '0')}`
    } else {
      out += char
    }
  }
  return out + quote
}

/** What went wrong, for a log line that says something could not be read, written or recorded.
 *  The words are JS's (V8's, Node's, ValidationError's), and no contract */
export function reasonOf(error: unknown): string {
  if (error instanceof Error) return error.message
  try {
    return String(error)
  } catch {
    // String() throws for a value with no way to be text, such as Object.create(null)
    return Object.prototype.toString.call(error)
  }
}
