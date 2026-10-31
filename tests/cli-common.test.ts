// The small functions of src/cli-common.ts that no other test reaches on its own.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFileSync, writeFileSync } from 'node:fs'
import { type AddressInfo, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import * as common from '../src/cli-common.ts'
import {
  answerText,
  call,
  CannotConnect,
  checkRequest,
  CliError,
  defaultBase,
  FALLBACK_BASE,
  processAlive,
  compareCodePoints,
  joinPath,
  parentPath,
  displayPath,
  detailText,
  readPidFile,
  type CliDeps,
  type Fetch,
} from '../src/cli-common.ts'
import { Paths } from '../src/config.ts'
import { UserError } from '../src/errors.ts'
import { parseJson } from '../src/json.ts'
import { tmpDir } from './support/tmp.ts'

/** Where these tests point call(). The fetch they give it never leaves the process */
const MOCKS_URL = 'http://tunnel.test/__admin__/mocks'

/** deps for call(): the fetch given. call() reads neither env nor cwd, and runs nothing */
function depsWith(fetch: Fetch): CliDeps {
  return {
    fetch,
    env: {},
    cwd: tmpdir(),
    run: () => {
      throw new Error('a test ran a command')
    },
  }
}

test('a pid record is only one with a pid the kernel could signal, and the base follows it', (t) => {
  const dir = tmpDir(t)
  const paths = Paths.inOneDirectory(dir)
  // What defaultBase reads is the pid file in the directory TUNNEL_CONFIG_DIR names
  const deps = { env: { TUNNEL_CONFIG_DIR: dir }, cwd: dir }
  const write = (text: string): void => writeFileSync(paths.pidFile, text)

  assert.equal(readPidFile(paths), null, 'no file')
  assert.equal(defaultBase(deps), FALLBACK_BASE)
  // 0 would signal the whole process group, a negative pid worse, and past 2^31 - 1
  // process.kill throws rather than answering
  for (const pid of ['0', '-1', '1.5', '"x"', 'true', '2147483648', '3000000000']) {
    write(`{"pid": ${pid}, "admin_port": 9000}`)
    assert.equal(readPidFile(paths), null, pid)
  }
  for (const text of ['{"admin_port": 9000}', '[]', 'not JSON']) {
    write(text)
    assert.equal(readPidFile(paths), null, text)
  }
  // No proxy_port, as tests/lifecycle.test.ts writes one by hand
  write('{"pid": 123, "admin_port": 9000}')
  assert.deepEqual(readPidFile(paths), { pid: 123, admin_port: 9000 })

  // TUNNEL_BASE first, where an empty one counts as not set
  const told = { ...deps, env: { ...deps.env, TUNNEL_BASE: 'http://elsewhere:1' } }
  assert.equal(defaultBase(told), 'http://elsewhere:1')
  // Then a record whose process is alive: this one
  write(`{"pid": ${process.pid}, "admin_port": 9000}`)
  assert.equal(
    defaultBase({ ...deps, env: { ...deps.env, TUNNEL_BASE: '' } }),
    'http://127.0.0.1:9000',
  )
  write(`{"pid": ${process.pid}}`)
  assert.equal(defaultBase(deps), 'http://127.0.0.1:8000')
  // Then the fallback, when the process is gone: no macOS or Linux hands out a pid this high, so
  // signal 0 finds nobody (ESRCH)
  write('{"pid": 2147483647, "admin_port": 9000}')
  assert.equal(defaultBase(deps), FALLBACK_BASE)
})

test('call tells nothing answering from a broken answer', async () => {
  const failing = (error: unknown): CliDeps => depsWith(() => Promise.reject(error))
  const failed = (code: string): Error => Object.assign(new Error(`connect ${code}`), { code })
  const nothingAnswers = `nothing answers at ${MOCKS_URL}; start the server with \`tunnel serve\`, or point --base at the one that is running`

  // Nobody listening on 127.0.0.1, and on localhost, where each stack refuses once and the cause is
  // an AggregateError with the code on it; undici giving up on the connect after its 10 s; and
  // AbortSignal.timeout running out, which may come first at a black hole. All exit 2, and the last
  // one also when the server took the connection and then said nothing for 10 s
  const refused = new AggregateError([failed('ECONNREFUSED'), failed('ECONNREFUSED')], '')
  for (const error of [
    new TypeError('fetch failed', { cause: failed('ECONNREFUSED') }),
    new TypeError('fetch failed', { cause: Object.assign(refused, { code: 'ECONNREFUSED' }) }),
    new TypeError('fetch failed', { cause: failed('UND_ERR_CONNECT_TIMEOUT') }),
    new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
  ]) {
    await assert.rejects(call(failing(error), 'GET', MOCKS_URL), (thrown) => {
      assert.ok(thrown instanceof CannotConnect, String(thrown))
      assert.equal(thrown.exitCode, 2)
      assert.equal(thrown.message, nothingAnswers)
      return true
    })
  }

  // An answer cut off once the connection was made is not nothing answering: it goes on as it is,
  // a stack trace and 1
  for (const error of [
    new TypeError('terminated', { cause: failed('ECONNRESET') }),
    new TypeError('fetch failed', { cause: failed('UND_ERR_SOCKET') }),
  ]) {
    await assert.rejects(call(failing(error), 'GET', MOCKS_URL), (thrown) => thrown === error)
  }
  // Nor is a base that is not a URL (TUNNEL_BASE=abc): the real fetch, which gives up on the URL
  // before it opens anything
  await assert.rejects(
    call(depsWith(fetch), 'GET', 'abc/__admin__/mocks'),
    (thrown) => thrown instanceof TypeError,
  )
})

test("call prints an error answer's detail, or its text when it has none", async () => {
  const answering = (status: number, body: string): CliDeps =>
    depsWith(async () => new Response(body, { status }))
  const answered = (status: number, body: string): Promise<unknown> =>
    call(answering(status, body), 'PATCH', MOCKS_URL, { json: {} })

  // The detail of an error answer, a string as it is, and exit 1
  await assert.rejects(answered(404, '{"detail": "x"}'), (thrown) => {
    assert.ok(thrown instanceof CliError && !(thrown instanceof CannotConnect), String(thrown))
    assert.equal(thrown.exitCode, 1)
    assert.equal(thrown.message, 'the server answered 404: x')
    return true
  })
  // A list as detailText writes it: this 422's detail as JSON on one line
  const issues =
    '[{"type": "extra_forbidden", "loc": ["body", "mocks", 0, "nope"], "msg": "Extra inputs are not permitted", "input": 1}]'
  await assert.rejects(answered(422, `{"detail": ${issues}}`), {
    message: `the server answered 422: ${issues}`,
  })
  // No detail to take, in an object without one, in JSON that is no object or in an answer that is
  // no JSON: the text of the answer
  for (const body of ['{"error": "x"}', '[1]', 'Internal Server Error']) {
    await assert.rejects(answered(500, body), { message: `the server answered 500: ${body}` })
  }
})

test('detailText writes a string as it is and anything else as JSON on one line', () => {
  // The detail of a 422 from the admin API
  const issues =
    '[{"type": "extra_forbidden", "loc": ["body", "mocks", 0, "nope"], "msg": "Extra inputs are not permitted", "input": 1}]'
  assert.equal(detailText(parseJson(issues)), issues)
  // A string as it is at the top, and in JSON's quotes inside a list or an object, keys included;
  // the three literals as JSON spells them; an integer past 2^53 with all its digits
  assert.equal(detailText("it's"), "it's")
  assert.equal(
    detailText(
      parseJson(
        '{"a": true, "b": false, "c": null, "d": [1, "x\'y", {"k\\n": 12345678901234567890}]}',
      ),
    ),
    `{"a": true, "b": false, "c": null, "d": [1, "x'y", {"k\\n": 12345678901234567890}]}`,
  )
  assert.equal(detailText(null), 'null')
  assert.equal(detailText(true), 'true')
  assert.equal(detailText([]), '[]')
  assert.equal(detailText({}), '{}')
})

test('call sends repeated query keys and JSON with its big integers', async () => {
  const sent: { url: string; init: RequestInit | undefined }[] = []
  const deps = depsWith(async (url, init) => {
    sent.push({ url, init })
    return new Response('{"id": 12345678901234567890}')
  })
  const answer = await call(deps, 'PATCH', MOCKS_URL, {
    params: { key: 'GET:/a', q: ['a=1', 'b c'] },
    json: parseJson('{"id": 12345678901234567890}'),
  })

  // A list is the key once per item, in order, and a space is a +
  assert.equal(sent.length, 1)
  const { url, init } = sent[0]!
  assert.equal(url, `${MOCKS_URL}?key=GET%3A%2Fa&q=a%3D1&q=b+c`)
  assert.equal(init?.method, 'PATCH')
  assert.equal(init?.body, '{"id":12345678901234567890}')
  assert.equal(new Headers(init?.headers).get('content-type'), 'application/json')
  // The answer is user JSON as well, read with parseJson
  assert.equal(JSON.stringify(answer), '{"id":12345678901234567890}')
})

test("call's params replace the query the url came with", async () => {
  const sent: string[] = []
  const deps = depsWith(async (url) => {
    sent.push(url)
    return new Response('{}')
  })
  const given: (Record<string, string> | null)[] = [{ c: '2' }, {}, null]
  for (const params of given) await call(deps, 'GET', `${MOCKS_URL}?b=1`, { params })
  // The params in place of its query, no query at all for params with nothing in them, and the url
  // as it is without params
  assert.deepEqual(sent, [`${MOCKS_URL}?c=2`, MOCKS_URL, `${MOCKS_URL}?b=1`])
})

test('processAlive takes a process it may not signal for alive, and passes on what it cannot judge', () => {
  // pid 1 is init, which signal 0 is refused for, with EPERM, to anyone but root: still a process,
  // someone else's. No process has the highest pid: ESRCH
  if (process.getuid?.() !== 0) assert.throws(() => process.kill(1, 0), { code: 'EPERM' })
  assert.equal(processAlive(1), true)
  assert.equal(processAlive(2 ** 31 - 1), false)
  // Any other error is no answer, and goes on as it is: process.kill refuses a pid past 2^31 - 1
  // before it asks the kernel (readPidFile never hands it one)
  assert.throws(() => processAlive(2 ** 31), { code: 'ERR_INVALID_ARG_TYPE' })
})

test('compareCodePoints orders strings by code point', () => {
  // sort() goes by UTF-16 code unit, which puts U+1F600 (the code units D83D DE00) before U+E000
  const strings = ['\u{1F600}', '', 'ab', 'a', '']
  assert.deepEqual([...strings].sort(compareCodePoints), ['', 'a', 'ab', '', '\u{1F600}'])
  assert.deepEqual([...strings].sort(), ['', 'a', 'ab', '\u{1F600}', ''])
  assert.equal(compareCodePoints('x', 'x'), 0)
})

test('displayPath, joinPath and parentPath print a path the way the CLI shows it', () => {
  // ./ and a trailing / go, // inside one becomes /, .. stays, a leading // is kept and /// is /,
  // and nothing at all is .
  for (const [text, printed] of [
    ['./x.json', 'x.json'],
    ['x//y.json', 'x/y.json'],
    ['out/', 'out'],
    ['./out/', 'out'],
    ['a/../b', 'a/../b'],
    ['//a/b', '//a/b'],
    ['///a', '/a'],
    ['', '.'],
    ['.', '.'],
    ['a/./b', 'a/b'],
    ['~/x', '~/x'],
  ]) {
    assert.equal(displayPath(text!), printed, JSON.stringify(text))
  }
  // The scenario's directory and a name: a name next to a scenario in the cwd is the name alone,
  // an absolute one is itself, and .. is not folded away
  assert.equal(joinPath(parentPath('s.json'), 'gen.js'), 'gen.js')
  assert.equal(joinPath(parentPath('./d/s.json'), '../g.js'), 'd/../g.js')
  assert.equal(joinPath('d', '/abs/g.js'), '/abs/g.js')
  assert.equal(joinPath('tree', 'a', 'b.json'), 'tree/a/b.json')
  // No / is added after one there already is, so the root stays what it was
  assert.equal(joinPath('/', 'x'), '/x')
  assert.equal(joinPath('//', 'x'), '//x')
  assert.equal(parentPath('/a'), '/')
  assert.equal(parentPath(''), '.')
})

test('answerText decodes an answer in its charset, else in UTF-8', () => {
  // The charset the answer names, else UTF-8, a byte that does not decode as U+FFFD, and UTF-8
  // again for a charset nobody knows
  for (const [contentType, hex, text] of [
    ['text/html; charset=gbk', 'd6d0cec4d2b3c3e6', '中文页面'],
    ['text/plain', '6f6b20fffe20656e64', 'ok \ufffd\ufffd end'],
    ['text/plain; charset=no-such-thing', 'c3a9', 'é'],
    [null, 'e9', '\ufffd'],
  ] as const) {
    assert.equal(answerText(Buffer.from(hex, 'hex'), contentType), text, String(contentType))
  }
})

test('cli-common exports the sixteen names src/mcp.ts builds on', () => {
  // A name that went missing or changed fails here, before src/mcp.ts fails to compile
  for (const name of [
    'api',
    'call',
    'keyFor',
    'readJsonArg',
    'responseHeaders',
    'requestParams',
    'redactNames',
    'redact',
    'expandScenario',
    'sslPolicy',
    'saveSslPolicy',
    'sslPatch',
    'checkRequest',
  ] as const) {
    assert.equal(typeof common[name], 'function', name)
  }
  assert.equal(common.TIMEOUT_MS, 10_000)
  const error = new common.CannotConnect('nothing answers')
  assert.ok(error instanceof common.CliError)
  assert.ok(error instanceof UserError)
  assert.equal(error.exitCode, 2)
  assert.equal(new common.CliError('no').exitCode, 1)
})

test('checkRequest gives up on a TLS handshake that has not finished in TIMEOUT_MS', async (t) => {
  // A proxy that answers the CONNECT and then says nothing. Without a timer of its own the
  // handshake would run on until 20 s in. The clock is node:test's, ticked once the ClientHello has
  // arrived, so the test takes no 10 s
  const hello = Promise.withResolvers<void>()
  const held: Socket[] = []
  const proxy = createServer((socket) => {
    held.push(socket)
    socket.on('error', () => {})
    socket.once('data', () => {
      socket.write('HTTP/1.1 200 Connection established\r\n\r\n')
      socket.once('data', () => hello.resolve())
    })
  })
  t.after(() => {
    for (const socket of held) socket.destroy()
    proxy.close()
  })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  const { port } = proxy.address() as AddressInfo
  const health = JSON.stringify({ proxy: { host: '127.0.0.1', port } })
  const ca = readFileSync(new URL('./fixtures/certs/ca.pem', import.meta.url))
  const deps = depsWith(async (url) => new Response(url.endsWith('/health') ? health : ca))
  t.mock.timers.enable({ apis: ['setTimeout'] })

  const checked = checkRequest(deps, 'http://tunnel.test', 'GET', 'https://h.test/x', null, null)
  const outcome = checked.then(
    () => 'answered',
    (error: Error) => error.message,
  )
  await hello.promise
  t.mock.timers.tick(common.TIMEOUT_MS)
  t.mock.timers.reset()

  assert.equal(
    await Promise.race([outcome, delay(1000).then(() => 'still waiting')]),
    `The request through http://127.0.0.1:${port} failed: The handshake operation timed out`,
  )
})
