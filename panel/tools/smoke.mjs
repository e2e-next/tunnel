// smoke.mjs — open every page of the panel in this machine's Chrome and fail on
// anything the browser complained about. The one test that runs the real bundle
// in a real browser against a real server; `make panel-smoke` is how it is run.
//
//   node panel/tools/smoke.mjs [http://127.0.0.1:8000]
//
// Anything logged is a failure: a console error or warning, an uncaught
// exception, a request that failed, a response of 400 or worse, or a page that
// never showed what it is supposed to show. Exit 0 only if nothing was logged.
//
// It needs a rule and a call to have two details to open, so it makes them
// itself: one JSON rule on GET:/__smoke__ and one call to it through the proxy.
// The rule is deleted afterwards; the call stays in the log, because a log is
// a record of what happened. Point this at a throwaway server, not at one you
// are in the middle of using.
//
// Playwright is not a dependency of anything here — it drives the installed
// Chrome, it is not shipped with the panel, and `make test` must not need a
// browser. Install it where this script can find it:
//   cd panel && npm i --no-save playwright
import { createRequire } from 'node:module'
import http from 'node:http'

const base = (process.argv[2] ?? 'http://127.0.0.1:8000').replace(/\/+$/, '')
const RULE_KEY = 'GET:/__smoke__'
const WAIT = 10_000

let chromium
try {
  ;({ chromium } = createRequire(import.meta.url)('playwright'))
} catch {
  console.error('❌ Playwright is not installed: cd panel && npm i --no-save playwright')
  process.exit(2)
}

/** The pages, in the order a person meets them, and what each has to show. */
const STEPS = [
  { name: 'Traffic', hash: '#/traffic', shows: ['h1:text-is("Traffic")', 'table tbody tr'] },
  { name: 'Traffic detail', click: 'table tbody tr:first-child td:first-child', shows: ['text=Answered by'] },
  { name: 'Rules', hash: '#/rules', shows: ['h1:text-is("Rules")', 'table tbody tr'] },
  { name: 'Rule detail', click: 'table tbody tr:first-child td:first-child', shows: ['text=Which calls this rule answers'] },
  // A session is a directory only once something is in it, so the server names
  // no session on a run nobody has recorded into — but the panel still has to
  // offer `default`, or there is no way back to it once you have switched away.
  // The row is the assertion that matters here: without it this page listed
  // nothing on a fresh server and the smoke test called that a pass.
  { name: 'Recordings', hash: '#/recordings', shows: ['h1:text-is("Recordings")', 'text=A session moves between machines', 'table tbody tr'] },
  { name: 'Connect a device', hash: '#/connect', shows: ['h1:text-is("Connect a device")', 'text=Install the certificate'] },
  { name: 'Settings', hash: '#/settings', shows: ['h1:text-is("Settings")', 'text=Default mode'] },
]

async function admin(method, path, body) {
  const response = await fetch(`${base}/__admin__${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${await response.text()}`)
  return response.json()
}

/** One call through the proxy, in the absolute form a proxy is asked in. */
function callThroughProxy(port) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, method: 'GET', path: `http://smoke.test/__smoke__`, headers: { host: 'smoke.test' } },
      (response) => {
        response.resume()
        response.on('end', () => resolve(response.statusCode))
      }
    )
    request.on('error', reject)
    request.end()
  })
}

let health
try {
  health = await admin('GET', '/health')
} catch (e) {
  console.error(`❌ no panel at ${base}: ${e.message}`)
  console.error('   start one first: make run')
  process.exit(1)
}
if (!health.proxy) {
  console.error(`❌ the proxy port is off on ${base}, so no call can be made to open on Traffic`)
  process.exit(1)
}

await admin('PATCH', '/mocks', {
  key: RULE_KEY,
  mode: 'json',
  json_response: { ok: true },
  description: 'panel smoke test',
})
await callThroughProxy(health.proxy.port)

const found = []
let step = 'startup'
const log = (what) => found.push(`[${step}] ${what}`)

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') log(`console.${m.type()}: ${m.text()}`)
})
page.on('pageerror', (e) => log(`uncaught: ${e.message}`))
page.on('requestfailed', (r) => {
  // The event stream is a request that stays open; navigating away or closing
  // the browser aborts it, which is how it ends rather than a failure.
  if (!r.url().includes('/__admin__/events')) log(`request failed: ${r.method()} ${r.url()} ${(r.failure() ?? {}).errorText}`)
})
page.on('response', (r) => {
  if (r.status() >= 400) log(`http ${r.status()}: ${r.request().method()} ${r.url()}`)
})

try {
  await page.goto(`${base}/#/traffic`, { waitUntil: 'load', timeout: WAIT })
  for (const it of STEPS) {
    step = it.name
    const before = found.length
    if (it.hash) await page.evaluate((h) => { location.hash = h }, it.hash)
    else await page.click(it.click, { timeout: WAIT })
    for (const selector of it.shows) {
      await page.waitForSelector(selector, { timeout: WAIT }).catch(() => log(`never showed ${selector}`))
    }
    console.log(`   ${found.length === before ? '✓' : '✗'} ${it.name}`)
  }
} catch (e) {
  log(`step threw: ${e.message.split('\n')[0]}`)
}

await browser.close()
await admin('DELETE', `/mocks?key=${encodeURIComponent(RULE_KEY)}`).catch(() => {})

if (found.length) {
  console.error(`\n❌ the panel logged ${found.length} problem${found.length === 1 ? '' : 's'} on ${base}:`)
  for (const line of found) console.error(`   ${line}`)
  process.exit(1)
}
console.log(`\n✅ the panel is clean: ${STEPS.length} pages opened on ${base}, no console errors, no failed requests, nothing over 400`)
