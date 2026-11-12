# Using tunnel from TypeScript tests

📖 [中文](zh-CN/typescript-tests.md)

The test cases in [Calling tunnel from a test case](in-app-tests.md) run inside the app and reach a tunnel somebody started.
A suite that runs in Node — the one that seeds the data, drives the app on a
simulator, an emulator or a device, and checks what it called — can start
tunnel inside its own process instead: nothing to start first, no port to
agree on, no HTTP of its own to the admin port. The package that holds the
command holds the library too, an ES module with its types:

```bash
npm install --save-dev tunnel-use
```

```ts
import assert from 'node:assert/strict'
import { startTunnel } from 'tunnel-use'

// A simulator, an emulator and CI reach 127.0.0.1; a device on the network needs the default, 0.0.0.0
const tunnel = await startTunnel({ proxyHost: '127.0.0.1' })
try {
  await tunnel.setRule({ key: 'GET:api.example.test/v5/feed', mode: 'json', json_response: { cards: [] } })
  await tunnel.setRule({
    key: 'POST:api.example.test/v5/pay',
    handler: (ctx) => ctx.reply({ paid: ctx.json?.amount ?? 0 }, 201),
  })
  // ... drive the app through tunnel.proxyUrl; here one request stands in for it
  const answer = await tunnel.check('POST', 'http://api.example.test/v5/pay', {
    body: '{"amount": 100}',
    contentType: 'application/json',
  })
  assert.equal(answer.status, 201)
  const wait = await tunnel.waitForRequest({ key: 'POST:api.example.test/v5/pay', timeout: 5 })
  assert.equal(wait.timed_out, false)
  const exchange = await tunnel.getRequest(wait.seqs[0]!)
  assert.deepEqual(exchange.request.body, { amount: 100 })
} finally {
  await tunnel.stop()
}
```

`startTunnel()` starts what `tunnel serve` starts — the proxy port, the admin
port, the core and the script worker — and resolves with a handle that says
where it all ended up: `proxyPort` and `proxyUrl` for the app's proxy setting,
`caFile` for the certificate a device installs, `configDir` for its files, and
`adminUrl`, which is the panel and the `--base` for the CLI while you debug a
test.

Every method is an admin API endpoint, run in this process by the same code
that answers on the admin port, so the defaults, the checks and the messages
are the ones the [Admin API v1](admin-api.md) table describes. Data keeps the
API's field names — `status_code`, `json_response`, `default_mode`,
`timed_out`, `last_seq` — so a rule out of a scenario file goes into
`setRule()` as it is; only the methods and their own options are camelCase.

| Method | Admin API, under `/__admin__` | Resolves with |
| --- | --- | --- |
| `status()` | `GET /health` and `GET /sessions`, in one object | that object, whose `mocks` counts the function rules too |
| `getConfig()`, `setConfig(patch)` | `GET`, `PATCH /config` | the settings |
| `decrypt(hosts, { exclude, remove })` | the SSL Proxying lists, edited as `tunnel ssl add` and `ssl rm` edit them | `ssl_proxying` |
| `listRules(key?)` | `GET /mocks`, then the function rules | the rules; with a key, that one, or a 404 |
| `setRule(rule)` | `PATCH /mocks`, or with a `handler` a function rule | the rule as it now stands |
| `deleteRule(key)` | the function rule with that key, else `DELETE /mocks` | the key, normalized |
| `applyScenario(scenario, { replace })` | `POST /mocks/apply`; a string is a scenario file, read as `tunnel apply` reads one | `{ applied, replaced }` |
| `resetState(key?)` | `POST /state/reset` | the keys it cleared |
| `listRequests(filters)` | `GET /requests`: `qBody` is `q_body`, and `each: true` one row per request | `{ requests, last_seq, unmatched_count }` |
| `getRequest(seq)` | `GET /requests/{seq}` | one exchange, its headers unredacted |
| `waitForRequest({ key, count, since, timeout, query })` | `GET /requests/wait`, with a `q=name=value` for each entry of `query` | `{ seqs, count, wanted, timed_out, last_seq }`; running out of time is not an error |
| `clearRequests()` | `POST /requests/clear` | `last_seq`, the `since` for what comes next |
| `check(method, url, { body, contentType })` | one request through this tunnel's proxy port, trusting its CA alone, as `tunnel check` sends it | `{ status, contentType, body }`, the body a `Buffer` |
| `startRecording(session?)`, `stopRecording()` | `POST /record/start`, `POST /record/stop` | `{ active, session, count }` |
| `listRecordings({ session, key, host })` | `GET /recordings` | its `recordings` |
| `getRecording(session, seq)` | `GET /recordings/{session}/{seq}` | one exchange |
| `importRecordings(from, { session, replace })` | `POST /recordings/import`: an array of exchanges into `session`, or a directory `tunnel recordings export` wrote, read as `tunnel recordings import` reads it and put in a session at a time, so the sessions before one that fails stay in | `{ imported, sessions, replaced }` |
| `deleteRecordings(session?)` | `DELETE /recordings`, one session's or every one's | how many went |

`check()` sends its request the way a device would: an https URL is decrypted
only once its host has been through `decrypt()`, and goes on to the real server
otherwise. A test that must not reach the network calls only hosts it has rules
for, or runs under `setConfig({ default_mode: 'replay' })`, where a request no
rule answers is a 404. Like `tunnel check`, it waits ten seconds for an answer:
a function handler that runs into its own ten seconds makes it reject with
`timed out`, and the 500 that answered the request is in the log.

## Function rules

`setRule({ key, handler })` takes a function where a script rule takes source.
The function gets the `ctx` a script gets, and what it returns is answered by
the same rules — an object as JSON, `ctx.reply(body, status, headers)`, a
`Recorded`, bytes — with the same ten seconds and the same 500 with the stack
when it throws. It is a `script` rule whose other fields apply as they always
do (`status_code`, `headers`, `enabled`, `fault`, `response_delay`, and
`replay_session` for what `ctx.recorded()` reads), made whole from the defaults
and the fields given: to change one, set the rule again with its handler.

What sets it apart from a script comes from running in the test's own process:

- It lives in memory only: never in `config.json`, gone with `stop()`.
- Its calls run on the test's main thread, and at the same time: a handler
  that awaits a promise the test holds keeps no other request waiting.
- `ctx.state` is one live object per rule, shared by the calls running at
  once, until `resetState()`. What a call puts there after it timed out stays.
- `ctx.recorded()` and `ctx.recordings()` return promises. `await
  ctx.recorded()` in an async handler is right for both kinds, since `await`
  takes a value that is not a promise as well.
- A synchronous endless loop cannot be stopped: it holds the very thread the
  timer would fire on. A handler that might loop belongs in a script, whose
  worker is stopped after ten seconds.
- A scenario holds stored rules only. `applyScenario()` refuses one with a
  `handler` in it, which JSON would drop without a word, leaving a passthrough
  rule behind.

A key has one rule. A function rule replaces the stored rule with its key,
taking it out of `config.json`; a stored one, from `setRule()` without a
handler or from `applyScenario()`, replaces the function rule with its key, and
`applyScenario(…, { replace: true })` clears every function rule. The panel,
the CLI and the admin API do not see function rules: `GET /__admin__/mocks`
lists stored rules only and the `mocks` of `GET /__admin__/health` counts them
alone (`status().mocks` counts both), a rule stored from the panel under a
function rule's key stays behind it until `deleteRule()`, and `tunnel apply
--replace` leaves function rules alone. In the request log they are like any
other rule: `mode` is `script`, and `matched_by` the key.

## Starting and stopping

With no options, both ports are free ones the system picks, the proxy port
listens on every interface as `tunnel serve`'s does, and the files go into a
new `<os.tmpdir()>/tunnel-XXXXXX` with a new CA. `proxyHost: '127.0.0.1'` is
enough for a simulator, an emulator and CI — the iOS simulator shares the
Mac's loopback, and `10.0.2.2` is that loopback from the Android emulator — and
macOS then never asks whether to accept incoming connections; only a device on
the network needs the default. `proxyPort` and `adminPort` pin the ports.

A simulator or a device that already trusts a CA keeps decrypting when the
tunnel signs with that one: `caDir` copies `ca.pem` and `ca-key.pem` out of a
directory, a project's `.tunnel/` or `~/.config/tunnel/`, into the temporary
one, and leaves the originals as they were. `configDir` runs it in a directory
you name instead, as `--config-dir` does, and keeps it: the rules and settings
it writes land in its `config.json` as the CLI's would, a function rule taking
out the stored rule with its key included. Give it a directory that is the
test's alone — two tunnels on one directory overwrite each other's files. No
`tunnel.pid` is written, so `tunnel stop` never goes after the test process.

Nothing it starts keeps the process alive. A test file that never calls
`stop()` still ends, and its temporary directory goes when the process exits;
when a signal kills the process, the system's cleanup of temporary files takes
the directory later. A request being answered, or a wait in progress, holds
the process until it is done. The other side of it: a script that starts a
tunnel and waits for nothing exits at once, and something meant to keep running
is `tunnel serve`.

`stop()` closes both ports, the script worker and the function calls still
running, and removes the temporary directory; calling it again returns the
first call's promise. A `waitForRequest()` in progress rejects with 503 `The
server is shutting down`, and every call after `stop()` with 503 `the tunnel
is stopped`; the properties stay readable. From Node 24 on, `await using tunnel
= await startTunnel()` stops it at the end of the block — Node 22.18 knows
`Symbol.asyncDispose` but not the statement, which is why the example uses
`try`/`finally`. Several tunnels in one process run side by side, each with its
own ports, rules and directory; where the logs go is all they share.

## Errors, big integers and logs

What the admin API answers with a status of 400 or more rejects as a
`TunnelError`: `status` is that status, `detail` the answer's detail as it
came — a sentence, or a 422's list of issues — and the message is the sentence,
or each issue as `<field>: <msg>`, joined by `; `. The library's own refusals
are `TunnelError`s as well: 400 for an option it does not know — a misspelt one
is refused rather than ignored, as the API refuses a field it does not know —
and for arguments it cannot take, such as `caDir` together with `configDir`, a
handler that is not a function, or a function rule given another `mode` or a
`script`; 503 once stopped. A port that cannot be listened on rejects with
Node's own error, `code` `EADDRINUSE`.

An integer past 2^53 is a `BigInt` in whatever the library hands out — rules,
exchanges, recordings, `ctx.json` — as it is in a script, and a `BigInt` given
to it is written as its digits. `assert.deepEqual` and `console.log` take them
as they are; `JSON.stringify` throws on one, as it does on any `BigInt`.

Logs go to stderr from `INFO` up, a line per request, as `tunnel serve` writes
them in the foreground. `setLogSink(sink)` sends them elsewhere, for every
tunnel in the process, and returns the sink it replaced, to put back later:
`setLogSink(() => {})` silences them, and `setLogSink((record) => { if
(record.level === 'warning' || record.level === 'error')
console.error(record.message) })` keeps what went wrong.

The types come with the package. Checking against them needs `@types/node`, as
the declarations use `Buffer`, and TypeScript 7 includes it only when the
tsconfig says `"types": ["node"]`.
