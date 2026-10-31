// matchGlob: shell-style wildcards (*, ?, [seq], [!seq]), case-sensitive. The
// rule keys (rule-keys.ts) match with it, and so do the request log's host
// filter and the proxy's SSL Proxying Locations. It translates the pattern into
// a regular expression: translateParts reads the pattern into pieces, translate
// joins them. tests/glob.test.ts holds it to 2,932 cases, down to the corners
// of a bracket expression.
//
// Every star but the last becomes an atomic group: a minimal .*? and the fixed
// run after it, which the match never backtracks into. JS has no atomic groups,
// but it never backtracks into a lookahead that has matched either, so
// (?=(?<g1>.*?FIXED))\k<g1> means (?>.*?FIXED). A plain .* for each star
// would backtrack: /*a*a*a*b against a few hundred characters takes seconds. The
// patterns are the user's and the values are whatever a device sends, so one
// long path could block the event loop, and both ports with it.
//
// Every literal character but an ASCII letter or digit is written as a code point
// escape, \u{…}. The u flag makes JS strict about escapes (\- only inside a
// class, \& and \~ nowhere), so a backslash in front of one could throw a
// SyntaxError. A code point escape is the same character anywhere.
//
// The compiled expressions are cached. Without the cache, filtering a thousand
// logged requests by a wildcard key translates and compiles the pattern anew
// for each of them, and /requests/wait filters the log again for every request
// that comes in. The cache is module-level state, but not what the rule against
// module-level mutable singletons is about: that rule is for services a test has to swap, and this one is
// bounded, invisible from outside and changes no answer.

/** What translateParts puts in place of one run of stars in the pattern */
const STAR = Symbol('*')

/** One character of the pattern, to be matched as it is */
function literal(char: string): string {
  return /^[A-Za-z0-9]$/.test(char) ? char : `\\u{${char.codePointAt(0)!.toString(16)}}`
}

/** Where char first is in chars, at or after `from` and before `to`, or -1 */
function indexOf(chars: string[], char: string, from: number, to: number): number {
  for (let k = from; k < to; k++) {
    if (chars[k] === char) return k
  }
  return -1
}

/**
 * The pattern as the pieces of an expression, in order, with STAR for each run
 * of stars. The pattern is read by code point, so a character beyond U+FFFF is
 * one character, in a set or a range as anywhere else.
 */
function translateParts(pattern: string): (string | typeof STAR)[] {
  const pat = [...pattern]
  const res: (string | typeof STAR)[] = []
  const n = pat.length
  let i = 0
  while (i < n) {
    const c = pat[i]!
    i += 1
    if (c === '*') {
      res.push(STAR)
      // compress consecutive `*` into one
      while (i < n && pat[i] === '*') i += 1
    } else if (c === '?') {
      res.push('.')
    } else if (c === '[') {
      let j = i
      if (j < n && pat[j] === '!') j += 1
      if (j < n && pat[j] === ']') j += 1
      while (j < n && pat[j] !== ']') j += 1
      if (j >= n) {
        res.push(literal('['))
      } else {
        // The set in chunks: a - between two chunks is a range, from the last
        // character of the one before to the first of the one after
        let chunks: string[][]
        if (!pat.slice(i, j).includes('-')) {
          chunks = [pat.slice(i, j)]
        } else {
          chunks = []
          let k = indexOf(pat, '-', pat[i] === '!' ? i + 2 : i + 1, j)
          while (k >= 0) {
            chunks.push(pat.slice(i, k))
            i = k + 1
            k = indexOf(pat, '-', k + 3, j)
          }
          const chunk = pat.slice(i, j)
          if (chunk.length > 0) chunks.push(chunk)
          else chunks.at(-1)!.push('-')
          // Remove empty ranges -- invalid in RE. Compared by code point: > between JS
          // strings compares UTF-16 units
          for (let k = chunks.length - 1; k > 0; k--) {
            const before = chunks[k - 1]!
            const after = chunks[k]!
            if (before.at(-1)!.codePointAt(0)! > after[0]!.codePointAt(0)!) {
              chunks[k - 1] = [...before.slice(0, -1), ...after.slice(1)]
              chunks.splice(k, 1)
            }
          }
        }
        i = j + 1
        // The set as written, before anything is escaped
        const stuff = chunks.map((chunk) => chunk.join('')).join('-')
        if (stuff === '') {
          // Empty range: never match.
          res.push('(?!)')
        } else if (stuff === '!') {
          // Negated empty range: match any character.
          res.push('.')
        } else {
          // A ! that comes first negates the set. Every other character is a
          // literal, and only the - between two chunks is left bare, as a range
          const negated = chunks[0]![0] === '!'
          if (negated) chunks[0] = chunks[0]!.slice(1)
          const set = chunks.map((chunk) => chunk.map(literal).join('')).join('-')
          res.push(`[${negated ? '^' : ''}${set}]`)
        }
      }
    } else {
      res.push(literal(c))
    }
  }
  return res
}

/**
 * The source of the expression for a pattern: ^(?:…)$, which without the m flag
 * ends only at the very end, and the s flag goes on the RegExp (compile).
 */
function translate(pattern: string): string {
  const out: string[] = []
  // The fixed pieces since the last star; null until the first star
  let fixed: string[] | null = null
  let groups = 0
  for (const part of translateParts(pattern)) {
    if (part === STAR) {
      if (fixed !== null) {
        // For an interior `STAR fixed` pairing, we want to do a minimal .*? match
        // followed by `fixed`, with no possibility of backtracking. That is an
        // atomic group, (?>.*?fixed); a lookahead and a backreference to what it
        // matched mean the same
        groups += 1
        out.push(`(?=(?<g${groups}>.*?${fixed.join('')}))\\k<g${groups}>`)
      }
      fixed = []
    } else if (fixed === null) {
      out.push(part) // fixed pieces at the start
    } else {
      fixed.push(part)
    }
  }
  // The last star, and all that comes after it
  if (fixed !== null) out.push('.*' + fixed.join(''))
  return `^(?:${out.join('')})$`
}

/** How many compiled expressions are kept */
const CACHE_SIZE = 1024
/** The compiled expression for each pattern, in the order they went in */
const compiled = new Map<string, RegExp>()

/** The expression for a pattern, from the cache if it is there */
function compile(pattern: string): RegExp {
  let regex = compiled.get(pattern)
  if (regex === undefined) {
    // When full, the pattern that went in first makes room
    if (compiled.size >= CACHE_SIZE) compiled.delete(compiled.keys().next().value!)
    // s: . matches a newline too. u: . and the sets work by code point, and \u{…}
    // is a code point escape only with it. Neither g nor y, so test() keeps no
    // state and one RegExp serves every call
    regex = new RegExp(translate(pattern), 'su')
    compiled.set(pattern, regex)
  }
  return regex
}

/**
 * Whether a value matches a shell-style pattern, the arguments in that order:
 * the value first, then the pattern. * matches any run of characters, across /
 * and newlines too; ? matches one character (one code point); [seq], [!seq] and
 * ranges such as [a-z] match one character in the set or out of it. Case counts,
 * the whole value has to match, and there is no escape character.
 */
export function matchGlob(name: string, pattern: string): boolean {
  return compile(pattern).test(name)
}
