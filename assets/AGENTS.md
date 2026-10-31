# AGENTS.md — tunnel for coding agents

tunnel is a local HTTP proxy and mock server. A client points its HTTP proxy at
this machine, and every call it makes arrives here: you decide what each
endpoint answers, watch what was actually called, and replay what a real server
once said. The usual job is feeding a client's automated tests.

**Configure everything through the `tunnel` command or the admin API — never by
editing `config.json`.** The server holds its config in memory and overwrites
that file on the next save, so an outside edit is lost. A change through the
CLI or the API takes effect on the next request, with no restart.

Every command talks to `http://127.0.0.1:8000/__admin__`. `--base URL` or
`TUNNEL_BASE` points somewhere else, `--json` prints raw JSON — an error too,
as `{"error": "…", "exit_code": 2}` on stderr — and both can be written before
or after the subcommand. Exit codes: 0 fine, 1 a user error, 2 nothing
answering at `--base`, 3 `tunnel wait` timed out.

## Starting it

```bash
npm install -g tunnel-use             # the package; the command is `tunnel`. Node 22.18+
tunnel serve                          # admin API on 127.0.0.1:8000, proxy on 0.0.0.0:8890
tunnel serve --admin-port 8001 --proxy-port 8889   # both ports can move
tunnel serve --background             # a process of its own; returns once it answers
tunnel status                         # pid, ports, the CA, the directories, the session
tunnel stop                           # SIGTERM, wait for it, clear the record
tunnel init                           # optional: give this project its own .tunnel/
```

A background server writes `tunnel.pid` and `tunnel.log` into the state
directory: everything it would have printed is in the log, and a command with
no `--base` and no `TUNNEL_BASE` reads the admin port out of the pid file, so a
server on another port needs no `--base` at all.

`tunnel serve` prints the LAN address to set as the device's proxy and the CA
fingerprint; `GET /__admin__/health` reports the same under `proxy`, along with
the version and the three directories. The panel at <http://127.0.0.1:8000/>
(five pages: Connect, Traffic, Rules, Recordings, Settings) is for people; you
do not need it.

## Commands

```bash
tunnel requests                                    # what the client actually called
tunnel requests --each --last 20                   # the last twenty calls, one row each
tunnel requests --each --unmatched                 # what no rule answered
tunnel requests show 17                            # one call in full: headers, body, answer
tunnel set GET /v5/feed -d '{"code": 0, "cards": []}'   # answer with this JSON
tunnel set GET /v5/feed -d @feed.json              # ... or JSON from a file
tunnel set GET /v5/feed --script gen.js            # ... or a handler(ctx) script
tunnel set GET /v5/feed --status 500 --delay 1.5   # change only these two fields
tunnel set GET api.example.com/v5/feed -d '{}'     # only this host answers this way
tunnel set GET /v5/feed --target http://localhost:3000   # pass through somewhere else
tunnel set GET /v5/feed --replay                   # answer from what was recorded
tunnel set GET /v5/feed --merge '{"total": 0}'     # change one field of the real answer
tunnel set GET /v5/feed -H 'Set-Cookie: sid=1'     # response headers, repeatable
tunnel set POST /v5/pay --fault hang --fault-seconds 30   # hang, garbage, close, none
tunnel mode replay                                 # ... and so for every endpoint with no rule
tunnel session acct_a                              # which recordings this run replays
tunnel ls / tunnel rm GET /v5/feed
tunnel ssl add api.example.com                     # decrypt HTTPS for this host
tunnel ssl ls                                      # what is decrypted, and what is not
tunnel check GET https://api.example.com/v5/feed   # one request through the proxy port
tunnel wait POST /v5/pay --timeout 30              # block until the client calls it
tunnel reset                                       # clear script state between test cases
```

`tunnel set` only touches the fields it is given. `tunnel check` sends one
request through the proxy port, verifying with tunnel's own CA, and exits
non-zero on a status of 400 or more — the quickest way to confirm a rule before
driving the client.

Nothing is decrypted until its host is on the SSL Proxying list: `tunnel ssl
add HOST` puts it there, `tunnel ssl exclude add HOST` wins over the include
list, and everything else is tunnelled through untouched and shows up as a
`connect` row with a size and nothing to read.

## Through MCP

`tunnel mcp` speaks MCP on stdin and stdout, so an editor can hand you these
same operations as typed tools — `set_mock` for `tunnel set`, `list_requests`
for `tunnel requests`, `wait_for_request` for `tunnel wait`, and so on down the
list. What comes back is the JSON `--json` prints, and nothing else in this
guide changes: a key matches the same way, `ctx` is the same surface, replay
picks its recording by the same rule. What the schemas buy you is a wrong field
coming back as a complaint about that field, rather than as a 400 to read your
way out of.

It connects and never starts. The server has to be up already; a tool call with
nothing answering says so and names `tunnel serve --background`. Starting it
stays a person's job, because they are the one who needs the LAN address and the
CA fingerprint off the banner.

The `guide` tool returns this file, so an agent given the MCP server and nothing
else still gets here.

## Keys

A rule key is `METHOD:[host[:port]]/path`. **Query strings and headers take no
part in matching** — let a script branch on those. `*` is a wildcard in both
the host and the path, and in the path it crosses `/`:

```bash
tunnel set GET '/api/user/*' -d '{"id": 1}'             # any host, /api/user/42 and below
tunnel set GET 'api.example.com/v5/feed' -d '{"v": 1}'  # one host only
tunnel set GET '*.example.com/api/*' -d '{"v": 1}'      # a family of hosts
```

A key with no host answers for every host. The most specific rule wins: an
exact path beats a wildcard path, an exact host beats a wildcard host beats any
host, and between two equally specific patterns the longer one wins.
`tunnel requests` shows which rule answered each call, in square brackets.

## The request log

Every call is kept on its own, so the second call to an endpoint has its own
query, body and answer. `tunnel requests` aggregates by endpoint; `--each`
lists them one by one, narrowed with `--key`, `--host`, `--since SEQ`,
`--last N`, `--unmatched`, `--encrypted` or `-q KEYWORD`; `tunnel requests show
SEQ` prints one in full. Printed headers hide `authorization`, `cookie` and the
rest of `redact_headers`; `show --raw` shows them. `tunnel reset --requests`
clears the log and prints the seq it stopped at, which is what `--since` takes
next.

## Scenario files

A group of rules in one JSON file, committed next to the tests and applied as a
unit:

```json
{
  "replace": true,
  "config": {"default_mode": "replay"},
  "mocks": [
    {"key": "GET:/v5/feed", "mode": "json", "json_file": "feed_empty.json",
     "description": "empty state"},
    {"key": "GET:/v5/user/*", "mode": "script", "script_file": "user.js"},
    {"key": "POST:/v5/pay", "mode": "json", "json_response": {"code": 500},
     "status_code": 500}
  ]
}
```

```bash
tunnel apply scenarios/empty_feed.json      # --replace also works on the command line
tunnel export -o scenarios/current.json     # the rules as they stand, in the same shape
tunnel pack scenarios/empty_feed.json -o bundle/empty_feed.json
```

`script_file` and `json_file` are resolved against the directory the scenario
file is in; the CLI reads them and sends the content, because **the server
reads no files of yours**. One invalid entry (a malformed key, a script that
does not compile) rejects the whole batch.

`tunnel pack` writes the same scenario with those two fields replaced by the
content they pointed at. That is what a test case running on a device applies
through the admin API, since it can reach neither your checkout nor the CLI.

`tunnel export` leaves the global settings out unless `--with-config` is given,
which writes the default mode and the current session: a scenario is applied per
test case and has no business flipping how every other endpoint of the run is
answered, or which recordings they answer from.

## Script mode

A script is a piece of JavaScript or TypeScript, run as the body of a function,
that defines `handler` at its top level; it runs once per request:

```js
function handler(ctx) { /* … */ }
// or: const handler = (ctx) => …
// or: async function handler(ctx) { … }
```

| `ctx` | Type | What it holds |
|---|---|---|
| `ctx.method` / `ctx.path` | `string` | `"GET"` / `"/v5/feed"` (no query) |
| `ctx.query` / `ctx.headers` | `Record<string, string>` | query values are all strings, header names lower-case; a key that is not there is `undefined` |
| `ctx.json` | any JSON value, or `null` | the request body parsed as JSON (strict UTF-8), `null` when it does not parse; an integer past 2^53 is a `BigInt` |
| `ctx.body` | `Buffer` | the raw bytes |
| `ctx.scheme` / `ctx.host` / `ctx.port` / `ctx.url` / `ctx.client` | `string` / `string` / `number` / `string` / `string` | where the request was really going, and where it came from |
| `ctx.state` | object | survives between requests, one bucket per rule; holds what JSON can represent (`BigInt` too); `tunnel reset` empties it |
| `ctx.recorded({ query?, key?, session? })` | `Recorded \| null` | synchronous: the recording the `match` strategy picks. `query` is this request's unless given, `key` names another endpoint, `session` another batch; a malformed `key` throws an Error |
| `ctx.recordings({ key?, session? })` | `Recorded[]` | synchronous: every recording of this endpoint, oldest first |
| `ctx.reply(body, status?, headers?)` | `Reply` | sets the status and the headers; `body` is any of the return values below |

`ctx.recorded()` and `ctx.recordings()` work only while their own request is
being answered. Called once `handler` has returned, from a timer it left behind,
or from a later request, they throw an Error with this message:
`ctx.recorded() and ctx.recordings() work only while their own request is being answered`.

`ctx.recorded()` picks its sample exactly as `--strategy match` does: the
newest recording whose query is the one being asked, falling back to the newest
of that endpoint. Pass `query` for another one, `key` for another endpoint and
`session` for another batch — **the session is settled the same way everywhere:
`session` first, then the rule's own `replay_session` when it names one, then
the current session** — so a script that should read `acct_a` either passes
`{ session: 'acct_a' }`, sits on a rule pinned there with `--session acct_a`, or
runs with `tunnel session acct_a`. What comes back is a `Recorded`, a copy, with
`seq`, `status`, `headers`, `body` (the parsed value, for a JSON recording),
`request` (`method`, `scheme`, `host`, `port`, `path`, `query`, `url`,
`headers`, `body`, `body_encoding`) and `body_encoding`. Change its `body`,
`status` or `headers` and hand the object straight back, and what goes out is
what you changed; the `body` can become a `Buffer` too:

```js
function handler(ctx) {
  const rec = ctx.recorded()              // the real answer, as it was recorded
  if (rec === null) return ctx.reply({ cards: [] }, 404)
  rec.body.cards = []                     // ... with one field changed
  return rec                              // status, headers and body go back together
}
```

What `handler` returns is the answer:

| It returns | The answer |
|---|---|
| any object, arrays, class instances and `Map`s included, but for the rows below | JSON of what `JSON.stringify` makes of it, `content-type: application/json` |
| a `Uint8Array` (a `Buffer` is one) or an `ArrayBuffer` | those bytes as they are, with no content type |
| a `Recorded` from `ctx.recorded()` or `ctx.recordings()` | the recording as it now stands, sent the way `--replay` sends one |
| `null` or `undefined` | an empty body, with no content type |
| a string, number, boolean, `BigInt`, symbol or function | `String()` of it, as text/plain |
| `ctx.reply(body, status?, headers?)` | `body` as its own row says, with that status, and those headers written over the rest |

A bare array is always a JSON list: from inside the script, a status or a
header goes through `ctx.reply`.

`handler` can be async. `require('node:…')` works; `import` and `export`
statements and a top-level `await` do not, and nothing at the top level can be
called `require`. An integer past 2^53 is a `BigInt` in the script
(`12345678901234567890n`; mixing it with a `number` throws a TypeError) and goes
back out as the same number. `console.log` goes to the server's stdout, which
is `tunnel.log` when it runs in the background.

The whole script is executed again for every request, so top-level variables
reset and anything that has to survive goes in `ctx.state`. It runs in a worker
thread with a ten second timeout: past that the request is answered 500 and the
script is stopped, stuck or not. An exception comes back as a 500 whose body is
`The script failed:` and the JavaScript stack, which is a debugging feature. Use
`--delay` rather than waiting in the script — a wait spends the timeout.

**Write it, then prove it, in three commands.** A handler is the one place here
where you are writing code rather than passing flags, so do not hand it over on
the strength of having written it:

```bash
tunnel set GET api.example.com/v5/feed --script feed.js      # a key: no scheme
tunnel check GET https://api.example.com/v5/feed -q page=2   # a URL: scheme and all
tunnel requests --each                                       # and how it was logged
```

The two take the address in different shapes, and mixing them up is a 400:
`set` names a rule key (`METHOD host/path`, host optional), while `check` sends
a real request and wants the URL a client would use.

`tunnel set` compiles the script before storing it, so a syntax error comes back
as `... has a script syntax error on line 1: Expected ',', got '{'` and nothing
on the server changes. What it cannot catch is a name that is not on `ctx`: in
JavaScript that is `undefined` rather than an error, so it shows only at request
time, as a wrong answer or as a 500 with the stack, which is what `tunnel check`
is for. The table above is the whole of `ctx`: there is no `ctx.count`, no
`ctx.json_body`, and `ctx.json` is the parsed request body, not a way to answer.
Two `check`s in a row also show `ctx.state` surviving between requests, which
is the other thing worth seeing with your own eyes before you hand it on.

## Shaping the answer

Four fields apply to whichever mode answered, so the same flag works on a
mocked, a real and a replayed response:

- `--merge '{"data": {"total": 0}}'` is deep merged into the JSON a passthrough
  or a replay brings back: objects recurse, arrays and everything else are
  replaced whole. Deleting a field, or editing one element of an array, is a
  script's job.
- `-H 'Name: value'` (repeatable) and `--content-type TYPE` set the response
  headers, written over the answer last. They set one field between them, so
  each command names every header the rule keeps.
- `--fault hang|garbage|close|none` reaches a client's error branches: `hang`
  holds the request for `--fault-seconds` (an hour by default) and then answers
  504, `garbage` sends a JSON content type over a body that stops mid-object,
  and `close` drops the connection without answering — the log shows that one
  as status 0, because nothing went back. A hang lets go the moment the client
  stops waiting, and that call is logged with status 0 too.
- `--delay SECONDS` holds the answer back, before the fault and before the mode.
  It stops holding as soon as the client stops waiting, and the mode still runs:
  the call is logged with the status it meant to answer and a passthrough is
  still recorded. A client that half-closes its socket is treated as one that
  left: the mode still runs and the call is logged with the status it was going
  to answer, but no answer reaches it.

## Replay

`tunnel record start` keeps every call that reaches the real backend; replay
gives those answers back, so a test run never has to reach it again:

```bash
tunnel record start --session acct_a       # switch to acct_a and keep what passes through
tunnel record stop
tunnel recordings ls --host api.example.com
tunnel recordings export -o tests/mocks/recordings --session acct_a   # a tree to commit
tunnel recordings import tests/mocks/recordings --replace             # what CI does
tunnel session acct_a                      # which recordings this run replays
tunnel mode replay --session acct_a        # ... and the mode, in one call
tunnel set GET api.example.com/v5/poll --replay --strategy sequence --session acct_a
```

The sample is found by the host and path being called. `match` (the default)
takes the newest recording whose query is the one being asked and falls back to
the newest of that endpoint; `sequence` walks them in order and stays on the
last, for a client that polls; `last` always takes the newest.

Which session the sample comes out of is settled the same way everywhere: an
explicit argument first, then the rule's own `--session` when it names one, then
the current session, which is `default` until `tunnel session acct_a` or
`tunnel mode replay --session acct_a` moves it. So an endpoint with no rule of
its own follows the switch, and so does a rule written without `--session`,
while `--session acct_a` pins one endpoint there whatever the run is otherwise
replaying and `--session ''` unpins it. `tunnel record start` files its calls
into the current session too, and with `--session` it switches first and then
records. Switching puts the `sequence` counters back to the start, since another
session is another set of recordings; script state is left alone.

A replayed answer carries `x-tunnel-replay: <seq>`. In `replay` mode an
endpoint with nothing recorded is answered `404 {"detail": "no rule or
recording for ..."}` with `x-tunnel-unmatched: 1`, so a test can never quietly
reach the real backend — `tunnel requests --unmatched` is the list of what is
still missing.

Recording is a global switch, not a response mode: only calls that pass through
to the real server are kept, and only while it is on. Exports hide header
values unless `--raw` is given; what the server keeps for itself is verbatim,
because a recording exists to be replayed.

## In an automated test run

```bash
tunnel mode replay --session acct_a                # 0. once for the run: whose recordings
tunnel apply scenarios/empty_feed.json --replace   # 1. this case's rules
tunnel reset                                       # 2. clear what the last one left
#                                                    3. drive the client
tunnel wait POST /v5/pay --timeout 30              # 4. block until it arrives (3 on timeout)
tunnel requests --each --unmatched                 # 5. what is still unmocked
```

`tunnel reset` clears script state and the replay counters; `tunnel reset GET
/v5/poll` clears one endpoint's, `tunnel reset --requests` clears the log.
**A stateful script or a `sequence` replay must be reset between cases**, or
the previous case's counter answers this one's calls. Switching the session
clears those counters as well, because another session is another set of
recordings.

Waiting beats sleeping: `tunnel wait METHOD [host]/path` holds until the client
has made that call and exits 0 with the seqs it matched, or exits 3 with the
number seen so far when `--timeout` (10 seconds by default) runs out. `--count
N` waits for several, `-q name=value` (repeatable) counts only the calls whose
query carries that value — the rest of the query is free — and `--since SEQ`
ignores everything logged before it; the seq `tunnel reset --requests` printed
is the one to pass.

A test case that runs on a device does the same through the admin API, because
it cannot spawn a command on this machine: `POST /__admin__/mocks/apply`,
`POST /__admin__/state/reset`, `GET /__admin__/requests/wait`, `GET
/__admin__/requests?each=1`. The admin port is `127.0.0.1:8000` from an iOS
simulator, `10.0.2.2:8000` from an Android emulator, and `127.0.0.1:8000` after
`adb reverse tcp:8000 tcp:8000` on a device over USB. README.md has the full
API table and a Swift and a Kotlin example.

## From TypeScript test code

A test suite that runs in Node can start tunnel inside its own process with
`startTunnel()` from `tunnel-use`: free ports, a temporary directory, and a
handle whose methods are the admin API's. A rule set there can take a function
as its handler, with a script's `ctx` and return values, that lives in the test
process alone, unseen by the CLI, MCP and the panel. README.md has the rest,
under "Using tunnel from TypeScript tests".

## Watch out for

- **The server reads no files of yours.** Payloads and scripts are read by the
  CLI and sent over the API (`-d @file`, `--script`, `json_file`,
  `script_file`), so a server started from any directory behaves the same and
  an npm-installed tunnel with no checkout behind it does too.
- **Three kinds of files**: config (`config.json`, the CA), state
  (`requests.jsonl`, `tunnel.pid`, `tunnel.log`) and data (`recordings/`). An
  explicit `--config-dir` or `TUNNEL_CONFIG_DIR`, or a `.tunnel/` found
  upwards from the start directory, puts all three in that one directory;
  otherwise they split across `~/.config/tunnel/`, `~/.local/state/tunnel/` and
  `~/.local/share/tunnel/` (`%APPDATA%` and `%LOCALAPPDATA%` on Windows). The
  first line of `tunnel ls` and `GET /__admin__/health` both report all three.
- **The two ports are bound on purpose.** The admin port (panel, API, script
  execution) stays on 127.0.0.1; the proxy port binds every interface because a
  real device has to reach it over Wi-Fi, carries traffic only, and accepts
  connections from this machine and the private ranges, which `allow_clients`
  narrows further. A request arriving from the network addressed to this
  machine's loopback is refused, so the admin port cannot be reached through
  the proxy port — forward it instead (`adb reverse tcp:8000 tcp:8000`).
- **HTTPS needs two things**, and neither is enough alone: the CA installed and
  trusted on the device (`tunnel ca install --ios-simulator` / `--android`, or
  <http://ca.tunnel/> from the device; iOS needs the trust switch under
  Settings > General > About > Certificate Trust Settings, Android 7+ needs
  `<certificates src="user"/>` in the test build's `network_security_config`),
  and the host on the SSL Proxying list. Certificate pinning must be off in the
  build under test.
- **Recorded traffic is real data.** Recordings and request logs hold real
  hostnames, tokens and user data. `.tunnel/` ignores itself, exports hide the
  usual headers unless `--raw`, and anything committed is worth reading first.
