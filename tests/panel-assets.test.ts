// The panel has to be entirely self-contained.
//
// The point of a local mock server is working without the real backend, so a
// panel that loads its JavaScript over the network contradicts itself: offline,
// on a closed network or with the Wi-Fi off, it would come up blank.
//
// The panel is a React app built ahead of time by `make panel`; what ships is
// three committed files in assets/panel/ and the shell page that links two of
// them. These tests are about those four things, and say nothing about the
// panel's own markup: it is minified JavaScript, so grepping it for a field name
// would be both fragile and no evidence of anything. `make panel-check`
// (`tsc --noEmit`) and `make panel-smoke` cover that instead.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { request, type IncomingMessage } from 'node:http'
import { join } from 'node:path'
import { buffer } from 'node:stream/consumers'
import { test } from 'node:test'
import { PACKAGE_ROOT, PANEL_STATIC_DIR } from '../src/package-info.ts'
import { makeAdminEnv, startAdminEnv } from './support/admin-env.ts'

const STATIC = PANEL_STATIC_DIR
const FONT = 'panel-InterVariable-latin.woff2'

// Every host named in the built bundle, with why it is not the panel reaching
// out to the internet. Anything else, and the panel stopped being offline.
const EXPECTED_HOSTS: Record<string, string> = {
  'www.w3.org': 'the XML, SVG and MathML namespace names React writes into the DOM',
  'react.dev': "the error-decoder page React's production build points at in a crash",
  'ca.tunnel': 'the certificate page tunnel itself answers, through the proxy',
  '127.0.0.1': 'loopback: the target placeholder in the rule form',
}
// The fake rows the panel can be run against with VITE_FAKE=1 are deliberately
// not in this list. They name api.acme.test, so if the build ever stops dropping
// them this test fails — which is the point: a released panel.js has no business
// carrying an invented feed and a string shaped like a bearer token.

// Each test has an admin app of its own, which serves the same page and files as `tunnel serve`

// The page the admin port renders asks for two local files and nothing else
test('the shell page loads nothing from the internet', async (t) => {
  const env = await makeAdminEnv(t)
  const html = await (await env.fetch('/')).text()

  const external = Array.from(html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g), (m) => m[1])
  assert.deepEqual(external, [], `external resources break the panel offline: ${external}`)

  assert.ok(html.includes('href="/static/panel.css"'))
  assert.ok(html.includes('src="/static/panel.js"'))
})

for (const [path, contentType] of [
  ['/static/panel.js', 'text/javascript'],
  ['/static/panel.css', 'text/css'],
  [`/static/${FONT}`, 'font/woff2'],
] as const) {
  // The three committed artifacts, at the paths the page and the CSS ask for
  test(`the built panel is served: ${path}, ${contentType}`, async (t) => {
    const env = await makeAdminEnv(t)
    const response = await env.fetch(path)
    await response.arrayBuffer()

    assert.equal(response.status, 200, path)
    assert.ok(response.headers.get('content-type')?.startsWith(contentType), path)
  })
}

// The bundle carries its font and its assets; it fetches nothing from a host
test('the built panel names no external host', () => {
  assert.ok(!readFileSync(join(STATIC, 'panel.css'), 'utf8').includes('url(http'))

  const javascript = readFileSync(join(STATIC, 'panel.js'), 'utf8')
  const hosts = new Set(
    Array.from(
      javascript.matchAll(/https?:\/\/([^/\s"'`)\\]*)/g),
      (match) => match[1]!.split(':')[0]!,
    ),
  )

  assert.deepEqual(
    [...hosts].filter((host) => !Object.hasOwn(EXPECTED_HOSTS, host)),
    [],
  )
})

// A human at the panel has to be able to pick the certificate up and check it
test('the shell page offers the CA certificate', async (t) => {
  const env = await makeAdminEnv(t)
  const html = await (await env.fetch('/')).text()

  assert.ok(html.includes('/ca.pem'))
  assert.ok(html.includes(env.ca.fingerprint()))
})

for (const name of ['README.md', 'README.zh-CN.md']) {
  // The offline promise is only kept if the next person knows how it works:
  // both READMEs name the committed bundle and the target that rebuilds it, and
  // neither mentions `make css` or Alpine, which the panel does not use: docs
  // describing a build target that does not exist are worse than no docs at all
  test(`the README documents what the panel loads: ${name}`, () => {
    const readme = readFileSync(join(PACKAGE_ROOT, name), 'utf8')

    assert.ok(readme.includes('panel.js'))
    assert.ok(readme.includes('make panel'))
    assert.ok(!readme.includes('make css'))
    assert.ok(!readme.includes('Alpine'))
    assert.ok(!readme.includes('alpine'))
  })
}

// ---------------------------------------------------------------- edge cases and the wire

// JSON.stringify leaves <, >, & and ' as they are, and a list of strings in the settings is all it
// takes to bring a </script> in: the bootstrap carries no rules, so no description. Unescaped, the
// element would end early and the rest run as a script of the page's own
test('the bootstrap survives a header name that tries to close the script element', async (t) => {
  const env = await makeAdminEnv(t)
  const names = ['</script><script>alert(1)</script>', "<!-- it's & -->"]
  const patched = await env.json('PATCH', '/__admin__/config', { redact_headers: names })
  assert.equal(patched.status, 200)

  const html = await (await env.fetch('/')).text()
  const element = /<script type="application\/json" id="bootstrap">(.*?)<\/script>/s.exec(html)
  assert.ok(element, html)
  const text = element[1]!

  assert.ok(text.includes('\\u003c/script\\u003e'), text)
  assert.ok(!/[<>&']/.test(text), text)
  assert.deepEqual(JSON.parse(text), {
    config: (await env.json('GET', '/__admin__/config')).body,
    ca_fingerprint: env.ca.fingerprint(),
  })
  assert.deepEqual(JSON.parse(text).config.redact_headers, names)
})

// The answers around the panel's files: no file behind a path is a JSON 404 however the path is
// written; a HEAD on / is answered without a body; and with no etag there is no 304, the file comes
// whole
test('the paths around the panel answer a JSON 404, a HEAD without a body and no 304', async (t) => {
  const env = await makeAdminEnv(t)

  for (const path of [
    '/static/',
    '/static/nope.js',
    '/static/../package.json',
    '/static/%2e%2e/package.json',
    '/static/..%2Fpackage.json',
  ]) {
    const response = await env.fetch(path)
    assert.equal(response.status, 404, path)
    assert.equal(response.headers.get('content-type'), 'application/json', path)
    assert.deepEqual(await response.json(), { detail: 'Not Found' }, path)
  }

  const head = await env.fetch('/', { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')

  const script = readFileSync(join(STATIC, 'panel.js'))
  for (const [name, value] of [
    ['if-none-match', '*'],
    ['if-modified-since', new Date(Date.now() + 86_400_000).toUTCString()],
  ] as const) {
    const response = await env.fetch('/static/panel.js', { headers: { [name]: value } })
    assert.equal(response.status, 200, name)
    assert.equal(response.headers.get('etag'), null, name)
    assert.ok(Buffer.from(await response.arrayBuffer()).equals(script), name)
  }
})

// The files as they leave @hono/node-server, where the tests above read app.request(): the three
// content types, a HEAD's length with no body, a range, and a path climbing out of /static/
test('the built panel over the wire', async (t) => {
  const env = await startAdminEnv(t)
  // The path goes out as it is written: http.request does not parse it, so nothing on this side
  // tidies a .. away
  const send = async (method: string, path: string, headers: Record<string, string> = {}) => {
    const sent = request({ host: '127.0.0.1', port: env.admin.port, method, path, headers }).end()
    const [response] = (await once(sent, 'response')) as [IncomingMessage]
    return { status: response.statusCode, headers: response.headers, body: await buffer(response) }
  }
  const script = readFileSync(join(STATIC, 'panel.js'))

  for (const [file, contentType] of [
    ['panel.js', 'text/javascript; charset=utf-8'],
    ['panel.css', 'text/css; charset=utf-8'],
    [FONT, 'font/woff2'],
  ] as const) {
    const answer = await send('GET', `/static/${file}`)
    assert.equal(answer.status, 200, file)
    assert.equal(answer.headers['content-type'], contentType, file)
    assert.ok(answer.body.equals(readFileSync(join(STATIC, file))), file)
  }

  const head = await send('HEAD', '/static/panel.js')
  assert.equal(head.status, 200)
  assert.equal(head.headers['content-length'], String(script.length))
  assert.equal(head.body.length, 0)

  const range = await send('GET', '/static/panel.js', { range: 'bytes=0-9' })
  assert.equal(range.status, 206)
  assert.equal(range.headers['content-range'], `bytes 0-9/${script.length}`)
  assert.ok(range.body.equals(script.subarray(0, 10)))

  // node-server resolves the dot segments before Hono sees the URL, so this asks for /package.json,
  // which nothing serves
  const climbing = await send('GET', '/static/../package.json')
  assert.equal(climbing.status, 404)
  assert.equal(climbing.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(climbing.body.toString()), { detail: 'Not Found' })

  // Any method but GET and HEAD is a 405: under /static/ one that names none, before the file is
  // looked for, and on / one naming GET. serveStatic takes every method for a GET, and an OPTIONS
  // for a HEAD: the file's length and no body, which leaves a client waiting for the body. That one
  // goes last, so that it cannot hold up the rest
  for (const [method, path, allow] of [
    ['POST', '/static/panel.js', undefined],
    ['PUT', '/static/panel.js', undefined],
    ['DELETE', '/static/nope.js', undefined],
    ['POST', '/', 'GET'],
    ['PUT', '/', 'GET'],
    ['OPTIONS', '/', 'GET'],
    ['OPTIONS', '/static/panel.js', undefined],
  ] as const) {
    const answer = await send(method, path)
    const label = `${method} ${path}`
    assert.equal(answer.status, 405, label)
    assert.equal(answer.headers['allow'], allow, label)
    assert.equal(answer.headers['content-type'], 'application/json', label)
    assert.deepEqual(JSON.parse(answer.body.toString()), { detail: 'Method Not Allowed' }, label)
  }
})
