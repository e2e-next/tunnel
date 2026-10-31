// Rule keys: `METHOD:[host[:port]]/path`, and which rule wins when several match.
//
// A key with no host answers for any host, and a host only ever narrows one down.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Paths, TunnelConfigManager } from '../src/config.ts'
import { TunnelCore } from '../src/core.ts'
import { UserError } from '../src/errors.ts'
import { exchangeKey } from '../src/exchanges.ts'
import { parseJson } from '../src/json.ts'
import { makeRequest } from '../src/messages.ts'
import { keyMatches, normaliseKey, parseKey, selectRule } from '../src/rule-keys.ts'
import { captureLogs } from './support/logs.ts'
import { tmpDir } from './support/tmp.ts'

// What selectRule reads of a rule is its key
type Rule = { request_key: string }

/** A config dict keyed the way the admin API stores it */
function rules(...keys: string[]): Record<string, Rule> {
  return Object.fromEntries(keys.map((key) => [key, { request_key: key }]))
}

/** The key of the rule chosen, for GET api.example.com:443/api/feed unless told otherwise */
function matched(
  configs: Record<string, Rule>,
  {
    method = 'GET',
    host = 'api.example.com',
    port = 443,
    path = '/api/feed',
  }: { method?: string; host?: string; port?: number | null; path?: string } = {},
): string | null {
  const rule = selectRule(configs, method, host, port, path)
  return rule !== null ? rule.request_key : null
}

// ---- spelling

test('the method is upper-cased and the host lower-cased', () => {
  assert.equal(normaliseKey('get:API.Example.COM/api/feed'), 'GET:api.example.com/api/feed')
})

// A `*` host and no host mean the same, so they must not be two rules
test('a star host is the same as no host', () => {
  assert.equal(normaliseKey('GET:*/api/feed'), 'GET:/api/feed')
})

test('a port is kept', () => {
  assert.equal(
    normaliseKey('GET:api.example.com:8443/api/feed'),
    'GET:api.example.com:8443/api/feed',
  )
})

for (const key of [
  '/api/feed', // no method
  'GET', // nothing after the method
  'GET:api.example.com', // no path
  'GET:api.example.com:https/x', // port is not a number
  '1:/api/feed', // not a method
]) {
  test(`a malformed key says what it should look like: ${key}`, () => {
    assert.throws(
      () => parseKey(key),
      (error) => error instanceof UserError && error.message.includes('METHOD:[host[:port]]/path'),
    )
  })
}

// ---- matching

test('a key without a host answers for any host', () => {
  const configs = rules('GET:/api/feed')

  assert.equal(matched(configs, { host: 'api.example.com' }), 'GET:/api/feed')
  assert.equal(matched(configs, { host: 'staging.example.com' }), 'GET:/api/feed')
})

test('an exact host only answers for that host', () => {
  const configs = rules('GET:api.example.com/api/feed')

  assert.equal(matched(configs, { host: 'api.example.com' }), 'GET:api.example.com/api/feed')
  assert.equal(matched(configs, { host: 'staging.example.com' }), null)
})

test('exact host beats any host', () => {
  const configs = rules('GET:/api/feed', 'GET:api.example.com/api/feed')

  assert.equal(matched(configs, { host: 'api.example.com' }), 'GET:api.example.com/api/feed')
  assert.equal(matched(configs, { host: 'other.example.com' }), 'GET:/api/feed')
})

test('a wildcard host matches a family and loses to an exact one', () => {
  const configs = rules('GET:*.example.com/api/feed', 'GET:api.example.com/api/feed')

  assert.equal(matched(configs, { host: 'api.example.com' }), 'GET:api.example.com/api/feed')
  assert.equal(matched(configs, { host: 'staging.example.com' }), 'GET:*.example.com/api/feed')
  assert.equal(matched(configs, { host: 'example.org' }), null)
})

test('an exact path beats a wildcard path', () => {
  const configs = rules('GET:/api/user/*', 'GET:/api/user/me')

  assert.equal(matched(configs, { path: '/api/user/me' }), 'GET:/api/user/me')
  assert.equal(matched(configs, { path: '/api/user/123' }), 'GET:/api/user/*')
})

test('the longest wildcard wins', () => {
  const configs = rules('GET:/api/*', 'GET:/api/user/*')

  assert.equal(matched(configs, { path: '/api/user/123' }), 'GET:/api/user/*')
  assert.equal(matched(configs, { path: '/api/other' }), 'GET:/api/*')
})

// Adding a catch-all for one host must not shadow a rule written for one path
test('a path rule is not swallowed by a host-wide wildcard', () => {
  const configs = rules('GET:/api/user/me', 'GET:api.example.com/api/*')

  assert.equal(matched(configs, { path: '/api/user/me' }), 'GET:/api/user/me')
  assert.equal(matched(configs, { path: '/api/user/123' }), 'GET:api.example.com/api/*')
})

test('a key with a port only answers on that port', () => {
  const configs = rules('GET:api.example.com:8443/api/feed')

  assert.equal(matched(configs, { port: 8443 }), 'GET:api.example.com:8443/api/feed')
  assert.equal(matched(configs, { port: 443 }), null)
})

test('the method has to match', () => {
  const configs = rules('POST:/api/feed')

  assert.equal(matched(configs, { method: 'GET' }), null)
  assert.equal(matched(configs, { method: 'POST' }), 'POST:/api/feed')
})

// ---- through the core

// Two hosts, one path, two different answers — what a forward proxy is for
test('the core answers per host', async (t) => {
  // Registered before tmpDir(t): the core's request log flushes into that directory
  let core: TunnelCore | undefined
  t.after(() => core?.close())
  const manager = new TunnelConfigManager(Paths.inOneDirectory(tmpDir(t)))
  core = new TunnelCore(manager)
  for (const [host, who] of [
    ['api.example.com', 'live'],
    ['staging.example.com', 'staging'],
  ] as const) {
    manager.updateRequestConfig(`GET:${host}/api/feed`, { mode: 'json', json_response: { who } })
  }

  const who = async (host: string) => {
    const response = await core.resolve(makeRequest({ method: 'GET', host, path: '/api/feed' }))
    return (parseJson(response.body.toString('utf8')) as { who: string }).who
  }

  assert.equal(await who('api.example.com'), 'live')
  assert.equal(await who('staging.example.com'), 'staging')
})

// One endpoint, however the client spells the host: one rule and one log line
test('a host is matched and recorded case-insensitively', async (t) => {
  let core: TunnelCore | undefined
  t.after(() => core?.close())
  const manager = new TunnelConfigManager(Paths.inOneDirectory(tmpDir(t)))
  core = new TunnelCore(manager)
  manager.updateRequestConfig('GET:api.example.com/api/feed', {
    mode: 'json',
    json_response: { who: 'live' },
  })

  for (const host of ['API.Example.COM', 'api.example.com']) {
    const response = await core.resolve(makeRequest({ method: 'GET', host, path: '/api/feed' }))
    assert.deepEqual(parseJson(response.body.toString('utf8')), { who: 'live' })
  }

  const recorded = core.exchanges.all().map(exchangeKey)
  assert.deepEqual(recorded, ['GET:api.example.com/api/feed', 'GET:api.example.com/api/feed'])
})

// ---- in detail

// The half of 'a host is matched and recorded case-insensitively' that is this
// module's: the rule is chosen however the client spells the host.
test('a host is matched whatever case the request spells it in', () => {
  const configs = rules('GET:api.example.com/api/feed')

  assert.equal(matched(configs, { host: 'API.Example.COM' }), 'GET:api.example.com/api/feed')

  // A path keeps its case, with a * or without
  assert.equal(matched(configs, { path: '/API/feed' }), null)
  assert.equal(matched(rules('GET:/api/*'), { path: '/API/feed' }), null)

  // The brackets of an IPv6 host stay part of it: GET:[::1]:8080/x reads as host
  // [::1], and the proxy fills in ::1 for the request, so the key never answers.
  const ipv6 = { host: '::1', port: 8080, path: '/x' }
  assert.equal(matched(rules('GET:[::1]:8080/x'), ipv6), null)
})

// keyMatches is called on its own as well: the request log and the recordings filter
// by a key with it, passing the port they wrote down, which is 0 for a line that has
// none. So 0 is a port like any other, and only null means the request is not held
// to the key's port.
test("a request with no port is not held to the key's port; port 0 is a port", () => {
  const on8443 = parseKey('GET:api.example.com:8443/api/feed')
  assert.equal(keyMatches(on8443, 'GET', 'api.example.com', null, '/api/feed'), true)
  assert.equal(keyMatches(on8443, 'GET', 'api.example.com', 0, '/api/feed'), false)

  const on0 = parseKey('GET:api.example.com:0/api/feed')
  assert.equal(on0.port, 0)
  assert.equal(keyMatches(on0, 'GET', 'api.example.com', 0, '/api/feed'), true)
  assert.equal(keyMatches(on0, 'GET', 'api.example.com', 443, '/api/feed'), false)
  assert.equal(keyMatches(on0, 'GET', 'api.example.com', null, '/api/feed'), true)
})

// Only a rank strictly higher than the best so far takes over, so of two rules that
// rank the same, the one that comes first in config.json wins. Both of these are a
// wildcard path seven characters long, and both match /ab.
test('between two rules of the same rank the one that comes first wins', () => {
  assert.equal(matched(rules('GET:/a*', 'GET:/*b'), { path: '/ab' }), 'GET:/a*')
  assert.equal(matched(rules('GET:/*b', 'GET:/a*'), { path: '/ab' }), 'GET:/*b')
})

// The length in a rank counts code points: GET:/ with an emoji and a * after it is
// 7 long, GET:/*xy is 8, so GET:/*xy wins in either order. In UTF-16 units the emoji
// counts twice, the two tie at 8, and the first would win.
test('the length that breaks a tie counts code points, not UTF-16 units', () => {
  const path = '/\u{1F600}xy'
  assert.equal(matched(rules('GET:/\u{1F600}*', 'GET:/*xy'), { path }), 'GET:/*xy')
  assert.equal(matched(rules('GET:/*xy', 'GET:/\u{1F600}*'), { path }), 'GET:/*xy')

  // It is the length of the canonical spelling, port and all: GET::443/x* is 11 long
  // and GET:/x* is 7, so where both match, the one with the port wins in either order
  const on443 = { path: '/xy', port: 443 }
  assert.equal(matched(rules('GET:/x*', 'GET::443/x*'), on443), 'GET::443/x*')
  assert.equal(matched(rules('GET::443/x*', 'GET:/x*'), on443), 'GET::443/x*')
})

// A hand-edited config.json can hold a key that does not read. Choosing a rule skips
// it with a warning under this module's logger, and goes on to the rules that do read.
test('a rule whose key cannot be read is skipped, with a warning', (t) => {
  const logs = captureLogs(t)

  assert.equal(matched(rules('nonsense', 'GET:/api/feed')), 'GET:/api/feed')
  assert.equal(
    logs.text(),
    "WARNING:tunnel.rule-keys:Ignoring a rule with an unreadable key: 'nonsense'",
  )

  // A key named __proto__ is skipped the same way: JSON.parse, which reads config.json,
  // makes it an own property like any other. With no rule left, as with none at all,
  // no rule is chosen
  const parsed: Record<string, Rule> = JSON.parse('{"__proto__": {"request_key": "__proto__"}}')
  assert.equal(matched(parsed), null)
  assert.equal(matched({}), null)
  assert.equal(
    logs.text(),
    [
      "WARNING:tunnel.rule-keys:Ignoring a rule with an unreadable key: 'nonsense'",
      "WARNING:tunnel.rule-keys:Ignoring a rule with an unreadable key: '__proto__'",
    ].join('\n'),
  )
})

// A pattern goes to matchGlob only when it has a *, so without one a ? and a [...]
// are just those characters, and with one they are wildcards as well. * is the only
// wildcard the docs promise.
test('? and [...] are wildcards only in a pattern that has a *', () => {
  const cases: [key: string, path: string, answers: boolean][] = [
    ['GET:/v?/users', '/v1/users', false],
    ['GET:/v?/users', '/v?/users', true],
    ['GET:/v?/*', '/v1/x', true],
    ['GET:/v[12]/*', '/v2/x', true],
    ['GET:/a[1]/*', '/a1/x', true],
    ['GET:/a[1]/*', '/a[1]/x', false], // [1] is a set, of the one character 1
    ['GET:/a[1]', '/a[1]', true],
  ]
  for (const [key, path, answers] of cases) {
    assert.equal(matched(rules(key), { path }), answers ? key : null, `${key} against ${path}`)
  }
})

// A key's method is upper-cased as it is read; a request's is compared as it comes.
// Node's HTTP parser only hands over upper-case methods anyway.
test('the request method is compared as it comes, not upper-cased', () => {
  assert.equal(matched(rules('GET:/api/feed'), { method: 'get' }), null)
})

// ** is not *: only a host of exactly * counts as none. ** stays a host, a wildcard
// one that matches any host, and so it ranks above a key with no host.
test('a ** host is a wildcard host: it outranks a key with no host', () => {
  assert.equal(matched(rules('GET:**/api/feed', 'GET:/api/feed')), 'GET:**/api/feed')
  assert.equal(matched(rules('GET:/api/feed', 'GET:**/api/feed')), 'GET:**/api/feed')
})

/** A line of tests/fixtures/rule-keys.json for a key that reads: how it reads */
type ReadKey = {
  key: string
  normalised: string
  method: string
  host: string
  port: number | null
  path: string
}
/** A line for a key that is refused: the words of the error */
type RefusedKey = { key: string; error: string }

// Every way of writing a key that reads, and every reason for refusing one, against
// what tests/fixtures/rule-keys.json holds for it. The words of an error count to
// the letter: the admin API answers with them as the detail of a 400, and the panel,
// the CLI and MCP show that detail as it comes.
test('every key in rule-keys.json reads, or fails, exactly as the file says', () => {
  const rows: (ReadKey | RefusedKey)[] = JSON.parse(
    readFileSync(new URL('./fixtures/rule-keys.json', import.meta.url), 'utf8'),
  )
  // So that a file read as empty, or cut short, cannot pass
  assert.ok(rows.length > 40, `only ${rows.length} keys`)
  for (const row of rows) {
    const which = JSON.stringify(row.key)
    if ('error' in row) {
      assert.throws(
        () => parseKey(row.key),
        (error) => {
          assert.ok(error instanceof UserError, `${which} threw ${String(error)}`)
          assert.equal(error.message, row.error, which)
          return true
        },
        which,
      )
    } else {
      const { method, host, port, path } = row
      assert.deepEqual(parseKey(row.key), { method, host, port, path }, which)
      assert.equal(normaliseKey(row.key), row.normalised, which)
      // The canonical spelling reads back as itself
      assert.equal(normaliseKey(row.normalised), row.normalised, which)
    }
  }
})

// A port is in ASCII digits: fullwidth, Arabic-Indic or superscript ones do not read.
// And it stops at 2^53 - 1, the largest integer a JS number holds exactly: past it the
// canonical spelling would quietly change the number, and from 10^21 on write it as
// 1e+21, which does not read back. Nobody writes a port either way, and both get the
// standard error.
//
// A port of more than 4,300 digits, leading zeros and all, is refused as well, in the
// standard words.
test('a port in other than ASCII digits, past 2^53 - 1 or of more than 4,300 digits is not a port', () => {
  for (const port of [
    '\u{FF11}\u{FF12}', // fullwidth digits
    '\u{661}\u{662}\u{663}', // Arabic-Indic digits
    '\u{B2}', // a superscript two
    '9007199254740992', // 2^53
    '1000000000000000000000', // 10^21
  ]) {
    const key = `GET:h:${port}/x`
    assert.throws(
      () => parseKey(key),
      (error) =>
        error instanceof UserError &&
        error.message.includes(`('h:${port}' is not a host or host:port)`),
      JSON.stringify(key),
    )
  }
  // The largest port there is here, spelled as it was given
  assert.equal(normaliseKey('GET:h:9007199254740991/x'), 'GET:h:9007199254740991/x')

  // 4,300 digits read; one more does not
  const longest = `GET:h:${'0'.repeat(4299)}1/x`
  assert.equal(parseKey(longest).port, 1)
  assert.equal(normaliseKey(longest), 'GET:h:1/x')
  const tooLong = `${'0'.repeat(4300)}1`
  assert.throws(
    () => parseKey(`GET:h:${tooLong}/x`),
    (error) =>
      error instanceof UserError &&
      error.message.includes(`('h:${tooLong}' is not a host or host:port)`),
    'a port of 4,301 digits',
  )
})
