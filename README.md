# tunnel

A local HTTP proxy and mock server for client tests. A phone, a simulator or
anything else points its HTTP proxy at this machine, the way it would point at
Charles; tunnel decrypts the hosts you name, shows every call as it happens,
keeps what the real server said, and answers later calls from those recordings
— or from literal JSON, or from a JavaScript handler you wrote a minute ago.

tunnel is made for a coding agent to drive. Every command takes `--json`,
`tunnel mcp` offers the same operations to an MCP client such as Claude Code or
Codex as typed tools, and `tunnel agents` prints the guide an agent reads first.
[Driving tunnel from a coding agent](#driving-tunnel-from-a-coding-agent) has
the rest.

📖 [中文文档](README.zh-CN.md)

[![Node](https://img.shields.io/badge/node-22.18%2B-brightgreen.svg)](https://nodejs.org)
[![npm](https://img.shields.io/npm/v/tunnel-use.svg)](https://www.npmjs.com/package/tunnel-use)
[![License](https://img.shields.io/badge/license-MIT-lightgrey.svg)](LICENSE)

## What it is

One process listens on two ports:

| Port | Bound to | What it carries |
| --- | --- | --- |
| proxy, 8890 | every interface | the traffic devices send; no management API of any kind |
| admin, 8000 | `127.0.0.1` | the panel, the JSON admin API, the CA download |

Every request that arrives on the proxy port is answered by one core. It is
logged whole, matched against the rules you configured — the key is
`METHOD:host/path` — and answered in that rule's mode. An endpoint with no rule
of its own falls back to the global mode: `passthrough` sends it on to the
server the client was calling, and `replay` answers it from the recordings and
refuses what it has none for, so an automated run cannot quietly reach the real
backend.

Rules change while the client keeps running: a rule takes effect on the next
request, with no restart and no rebuild of the app.

The admin API is the contract and `tunnel` is a thin wrapper around it. The
preparation a whole run shares — start the server, import the recordings, switch
the mode and the session, install the CA — is done from the host with the CLI.
A test case running on a device does the same things over HTTP, because it
cannot spawn a command on your machine. Both are described below.

## Install

```bash
npm install -g tunnel-use   # the package; the command is `tunnel`
tunnel --version
```

Node 22.18 or newer. From a checkout, `npm ci` and then `make run` starts it
straight from the sources, or `npm run build && npm link` puts the checkout's
`tunnel` on your PATH — build again after changing `src/`.

## Quick start

```bash
tunnel serve
```

It prints the address to type into a device and the CA fingerprint (the three
directories it owns go into the startup log, and `tunnel ls` prints them):

```
tunnel 3.0.0
  panel:  http://127.0.0.1:8000/
  proxy:  0.0.0.0:8890
    set the device's HTTP proxy to 192.168.1.23 port 8890
  upstream: direct
  CA:     http://ca.tunnel/ once the device is proxied, or http://192.168.1.23:8890/ca.pem
          8B:6F:...:1C
```

Point a device at it (below), open <http://127.0.0.1:8000/> to watch the calls
arrive, and then, from another terminal:

```bash
tunnel requests                                        # what the client actually called
tunnel ssl add api.example.com                         # decrypt this host's HTTPS
tunnel set GET api.example.com/v5/feed -d '{"cards": []}'   # answer it with this
tunnel check GET https://api.example.com/v5/feed       # send one request through the proxy
```

## Point a device at it

`tunnel serve` prints this machine's LAN addresses; `PORT` below is the proxy
port, 8890 unless you moved it.

| Client | How it gets there |
| --- | --- |
| iPhone or iPad | Settings > Wi-Fi > the network > Configure Proxy > Manual, with this machine's LAN address and `PORT` |
| Android phone | Wi-Fi > the network > Advanced > Proxy > Manual, same address and port |
| iOS simulator | it follows the Mac's own proxy settings: System Settings > Network > the interface > Details > Proxies > Web Proxy and Secure Web Proxy, `127.0.0.1:PORT`. Remember to switch it off afterwards — it is the whole machine's setting. tunnel sees that this proxy is itself, so what it sends on goes out directly rather than back through itself, and the banner says `upstream: direct (system proxy points at tunnel itself, ignored)` |
| Android emulator | `adb shell settings put global http_proxy 10.0.2.2:PORT`, and `adb shell settings put global http_proxy :0` to clear it. `10.0.2.2` is the host as the emulator sees it |

A device on the same Wi-Fi is accepted from the private ranges (10/8,
172.16/12, 192.168/16, fc00::/7) and from this machine; `allow_clients` in the
config narrows that to a list of addresses or CIDR ranges. Anything else is
closed and logged, and a request that arrives from the network addressed to
this machine's own loopback is refused with 403 — the admin port lives there,
and the proxy port next to it is not a way around that.

To reach the **admin port** from a device, forward it rather than exposing it:
`adb reverse tcp:8000 tcp:8000` on Android, `10.0.2.2:8000` from an emulator,
and `127.0.0.1:8000` from an iOS simulator, which shares the Mac's loopback.

### The CA certificate

tunnel signs the TLS certificates it serves with a certificate authority of its
own, kept as `ca.pem` and `ca-key.pem` in the config directory. It is generated
on first use and stays put: a device that trusts it once keeps trusting it, and
wiping the state directory cannot take it away.

```bash
tunnel ca info                          # fingerprint, expiry and file paths
tunnel ca export -o tunnel-ca.pem       # the certificate to install on a device
tunnel ca install --ios-simulator       # xcrun simctl keychain booted add-root-cert
tunnel ca install --android             # adb push, then install it from Settings
tunnel ca install --macos               # security add-trusted-cert, asks for a password
tunnel ca reset                         # start over; every device has to install it again
```

A device that is already proxied through tunnel can open <http://ca.tunnel/>
for an install page with the steps for each platform; one that is not can fetch
`http://<this machine>:8890/ca.pem` directly, and <http://127.0.0.1:8000/ca.pem>
serves the same file. The `ca` commands read the certificate from the running
server when there is one and from the config directory when there is not, so
setting a device up does not depend on the order you do things in.

Installing is not trusting. These caveats are the same ones Charles has:

- **iOS**: after the profile is installed, switch the certificate on under
  Settings > General > About > Certificate Trust Settings. A simulator needs no
  such switch — `tunnel ca install --ios-simulator` is enough.
- **Android 7 and later**: apps do not trust user-installed CAs by default. The
  test build has to opt in with `<certificates src="user"/>` (or a
  `<debug-overrides>` block) in its `network_security_config`.
- **Any platform**: an app that pins its server's certificate rejects tunnel's
  certificate however the CA was installed, so pinning has to be off in the
  build you test against.

### Which hosts get decrypted

Installing the CA is still not enough on its own: tunnel decrypts a host only
when you list it, the way Charles has SSL Proxying Locations. Nothing is listed
to begin with, so every HTTPS connection is tunnelled through byte for byte
until you say otherwise — third-party SDKs that pin their certificates keep
working, and the log stays readable.

```bash
tunnel ssl ls                                   # both lists, and whether it is on
tunnel ssl add api.example.com '*.example.com:443'
tunnel ssl rm api.example.com
tunnel ssl exclude add cdn.example.com          # never decrypt this one
tunnel ssl on / tunnel ssl off                  # the switch over both lists
```

An entry is `host[:port]`; `*` is a wildcard in the host and leaving the port
off means any port. An excluded host wins over an included one. A change takes
effect on the next connection; tunnels that are already open are left alone.
A host that was not decrypted still appears in the log as a `connect` row with
the bytes it carried each way, and the panel offers to add it to the list.

### Upstream proxy

What tunnel does not answer itself — a passthrough, and an HTTPS connection to
a host it does not decrypt — leaves this machine the way the Mac's own traffic
does:

1. The environment first: `https_proxy`, `http_proxy`, `all_proxy` and
   `no_proxy`, each read lower-case first and upper-case only when the
   lower-case one is not set. Once one of the first three is set, the
   environment is all that counts: an `https://` call and an undecrypted tunnel
   go through `https_proxy`, an `http://` call through `http_proxy`, and either
   falls back to `all_proxy`.
2. Otherwise, on macOS, the system proxy: Web Proxy for `http://`, Secure Web
   Proxy for `https://` and for tunnels, with its bypass list and "Exclude
   simple hostnames" honoured. It is read again when it is five seconds old, so
   a proxy app switched on or off is followed within five seconds, without a
   restart.
3. Otherwise straight to the server.

Loopback, the private ranges, link-local addresses and `*.local` names always
go direct, and so does everything when the proxy is tunnel itself — the iOS
simulator setting above — so tunnel never hands its own traffic back to
itself. `no_proxy` applies whichever way the proxy came, and `NO_PROXY=*`
sends everything direct.

The route is one line, printed as `upstream:` by the banner and
`tunnel status` and reported as `upstream` by `GET /__admin__/health`, and the
log (`tunnel.log`, in the background) has an `Upstream route: …` line when it
is first read and each time it changes:

```
upstream: direct
upstream: via 127.0.0.1:3128 (system proxy)
upstream: via http://proxy:3128 (HTTPS_PROXY)
upstream: via http://proxy:3128 (http_proxy) for http; direct for https
upstream: direct (system proxy points at tunnel itself, ignored)
upstream: direct (ALL_PROXY=socks5://127.0.0.1:7890 ignored: only http:// proxies are supported)
```

A call that fails at the proxy is a 502 that names it, as in
`Could not reach https://api.example.com through the proxy 127.0.0.1:3128 (system proxy): …`;
a tunnel that fails there gets a bare 502, and the log line names the proxy.

Only `http://` proxies are spoken: a `socks5://` or an `https://` one is
ignored and that traffic goes direct, as the `upstream:` line then says, and
neither a PAC file, a system SOCKS proxy nor a system proxy that wants a
password from the keychain is supported. To use another proxy, set the
variables when you start tunnel. The CLI's own calls to the admin port go
direct; with Node's `NODE_USE_ENV_PROXY=1` in your shell, add `127.0.0.1` to
`NO_PROXY` to keep them that way.

## The panel

<http://127.0.0.1:8000/> is one page, a React app built ahead of time, and
nothing is loaded from the internet: `make panel` writes
`assets/panel/panel.js`, `assets/panel/panel.css` and
`assets/panel/panel-InterVariable-latin.woff2`, and all three are committed,
so installing builds nothing and the panel comes up with the Wi-Fi off.

The sidebar holds the five pages, and with them everything that is true of the
whole run rather than of one page: the session switcher at its head; under
**This run** the default mode (**Live** or **Replay**, `tunnel mode`, with the
count of unmatched calls while replaying) and the record button
(`tunnel record`); and in its footer the proxy address a device needs, the
version, and a dot that goes grey and says `reconnecting…` when the event
stream drops. ⌘K reaches every page, both switches, every session and every
rule by key.

**Traffic** is the log as it arrives, over Server-Sent Events: the calls in a
list, one row each, and the one clicked in a pane beside it — the overview, what
answered it, then the request and the response with their headers and bodies (a
dialog rather than a pane when the window is too narrow for both). Search by
host, path, query, status or the rule that answered; narrow to one host, one
method or one status class, to **Unmatched** or to **Encrypted** rows; tick
**Search bodies** and the search goes to the server, which is where the bodies
are. **Pause** freezes the list while the run goes on underneath, **Clear**
empties the log, and every row has a menu: Open, **Mock this**, **Copy as
curl**, **Copy key**, only this host, the rule that answered — and **Decrypt
this host** for a tunnel nobody decrypted.

**Rules** lists every rule with its mode, status code, hit count and an on/off
switch, and a click opens it with every field it takes: the key — in three parts
while the rule is new, read-only afterwards, since a different endpoint is a
different rule — then the mode with only that mode's fields (a JSON body, a
JavaScript handler, a session and a strategy, or a target to forward to), the
status code, the delay, extra headers, a fault to inject, and a note for
whoever reads the rule next. New rule, Duplicate, Delete and Reset state are
`tunnel set`, `tunnel rm` and `tunnel reset` from here; a whole set at once
stays with `tunnel apply` and `tunnel export`.

**Recordings** lists the sessions on disk with how many recordings each holds,
which one this run is using and how long ago it was recorded into; a session
opens to the calls recorded into it, and a click opens one in full. A session is
made current, recorded into or deleted from here — `tunnel session`,
`tunnel record` and `tunnel recordings rm` — while export and import stay on the
command line.

**Connect a device** walks a device in, three steps, each ticked from the log
rather than from the page: the proxy addresses to set, one per network
interface, each with a copy button; the certificate — the `/ca.pem` download,
the `http://ca.tunnel/` page for the device, the fingerprint to check against
it, and the iOS and Android steps; and what to decrypt — the SSL proxying
switch, the include and exclude lists, and the hosts recently tunnelled through,
each with a **Decrypt** button (`tunnel ssl add`). Every client that has spoken
to the proxy is listed below, with when it was last seen.

**Settings** is what is set once: the default mode and the replay marker, how
many calls the log keeps and whether every run records itself, the headers
hidden in the log and in recordings, the allowed clients (read here, changed
with `tunnel config`), and where this server keeps its files, with the
certificate's fingerprint and the day it expires.

## Rules

### Keys

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

### Modes

**json** — answer with `json_response` as it stands, an object or an array.

```bash
tunnel set GET /v5/feed -d '{"code": 0, "cards": []}'
tunnel set GET /v5/feed -d @feed.json --status 201
```

**script** — run `handler(ctx)` once per request:

```js
function handler(ctx) {
  const page = Number(ctx.query.page ?? 1)         // ctx.query values are strings
  const rec = ctx.recorded()                        // what replay would have answered
  if (rec === null) return { cards: [], page }
  rec.body.cards = rec.body.cards.slice(0, 2)       // the real answer, with one field changed
  return rec                                        // status, headers and body go back together
}
```

```bash
tunnel set GET /v5/feed --script feed.js
```

A script is JavaScript; TypeScript is accepted too, its types stripped before
it runs. `ctx` carries `method`, `path`, `query`, `headers` (lower-case
names), `body` (a `Buffer`), `json` (the body parsed, or `null`), `scheme`,
`host`, `port`, `url`, `client`, a `state` object that survives between
requests, and the two recording readers
`ctx.recorded({ query, key, session })` and
`ctx.recordings({ key, session })`, which read the session they are given, or
the rule's own when it names one, or the current session; both answer at once
rather than with a promise, and only while their own request is being
answered. Return an object or an array for JSON, a string for text, a `Buffer`
for bytes, a `Recorded` for the recording itself, or
`ctx.reply(body, status, headers)` to set the status and the headers as well.
A handler can be async, `require('node:…')` reaches Node's own modules, and an
integer past 2^53 is a `BigInt` in the script and goes back out as the same
number. The whole script is executed again for every request, so top-level
variables reset and anything that has to survive goes in `ctx.state`; it runs
in a worker thread with a ten second timeout, a script still stuck past it is
stopped, and an exception comes back as a 500 with the JavaScript stack in it.
Use `--delay` rather than waiting in the script — a wait spends the timeout.

**passthrough** — let the request reach the server it was going to. `--target`
sends it somewhere else instead: a base URL replaces the origin and keeps the
path, a URL that carries a path of its own replaces the whole address (Charles
calls that Map Remote).

```bash
tunnel set GET /v5/feed --target http://localhost:3000
```

**replay** — answer from what was recorded, without touching the network:

```bash
tunnel set GET api.example.com/v5/feed --replay --session acct_a
tunnel set GET api.example.com/v5/poll --replay --strategy sequence
```

The sample is found by the host and path being called, and picked by the
strategy: `match` (the default) takes the newest recording whose query is the
one being asked and falls back to the newest of that endpoint, `sequence` walks
them in order and stays on the last, which is what a client that polls until
something changes needs, and `last` always takes the newest. A wildcard rule
looks for the host actually being called first and falls back to what was
recorded under its own pattern. `tunnel reset` puts the `sequence` counters
back to the start, as it does script state, so one test case does not answer
the next one's calls.

Which recordings a rule reads is the current session, unless the rule names one
of its own: `--session acct_a` pins this endpoint there whatever the run is
otherwise replaying, and `--session ''` puts it back on the current session.
Leaving the flag out leaves the field as it was, so a rule written once follows
the switch described next.

A replayed answer carries the recorded status, headers and body, plus
`x-tunnel-replay: <seq>` saying which recording it came from — set
`replay_marker` to `false` if the client is strict about the headers it sees.

### The global mode, and the current session

```bash
tunnel mode              # which mode is in force now
tunnel mode replay       # endpoints with no rule of their own answer from recordings
tunnel mode passthrough  # ... or reach the real server (the default)
tunnel session           # the session in hand, and what else is on disk
tunnel session acct_a    # switch to it; one command moves the whole run
tunnel mode replay --session acct_a   # the mode and the session in one call
```

The current session is where recording writes and where replay reads, and it is
`default` until you move it. Which session answers a given call is settled the
same way everywhere: an explicit argument first — a script's `session` — then
the rule's own `--session` when it names one, then the current session. So an
endpoint with no rule of its own follows the switch, and so does a rule written
without `--session`, while a pinned rule stays where it was put.

Switching puts the `sequence` counters back to the start — they walked another
set of recordings and say nothing about this one — and leaves script `ctx.state`
alone. `tunnel session` with no name prints the session in hand with how many
calls it holds and lists every other session on disk; switching to one nobody
has recorded into is allowed, and says so, because in `replay` mode every
endpoint without a rule then answers 404. Which session is in hand is reported
by `tunnel status`, by `GET /__admin__/health` and by the panel's sidebar.

In `replay` mode an endpoint with no rule and no recording is answered
`404 {"detail": "no rule or recording for <key>", "key": "<key>"}` with
`x-tunnel-unmatched: 1`, and `tunnel requests --unmatched` lists exactly those:
the endpoints still to record or to mock.

### Shaping the answer

Four fields apply to whichever mode answered, so the same flag works on a
mocked, a real and a replayed response:

```bash
tunnel set GET /v5/feed --merge '{"data": {"total": 0}}'
tunnel set GET /v5/feed -H 'Set-Cookie: sid=1' --content-type application/json
tunnel set GET /v5/pay --fault hang --fault-seconds 30   # or garbage, close, none
tunnel set GET /v5/feed --delay 1.5 --status 503
tunnel set GET /v5/feed --disable            # 503 until --enable
```

- `merge_json` is deep merged into the JSON a passthrough or a replay brings
  back: objects recurse, and anything else — an array included — is replaced
  whole. Removing a field, or editing one element of an array, is a script's
  job. A body that is not JSON is passed through untouched.
- `headers` are written over the response last, after the mode and after the
  merge. `-H` and `--content-type` set that one field between them, so each
  command names every header the rule keeps.
- `fault` is how a client's error branches are reached. `hang` holds the
  request for `--fault-seconds` (an hour by default, longer than any client's
  timeout) and then answers 504; `garbage` sends a JSON content type over a
  body that stops mid-object; `close` drops the connection without writing
  anything, which the request log shows as a status of 0 because nothing went
  back. `--fault none` puts the endpoint back to answering normally.
  A hang lets go as soon as the client stops waiting, rather than holding the
  connection for the rest of the hour; the call is still logged, with a status
  of 0, so the run can see it arrived and was abandoned.
- `response_delay` holds the answer back, whichever mode produced it. It runs
  before the fault and before the mode. It stops holding as soon as the client
  stops waiting, but the mode still runs: the call is logged with the status it
  was going to answer, and a passthrough is still recorded, because what the
  real server said is worth keeping even if nobody read it. A client that
  half-closes its socket is treated as one that left: the mode still runs and
  the call is logged with the status it was going to answer, but no answer
  reaches it.

`tunnel set` only touches the fields you pass; everything else about the
endpoint is left as it was.

## Scenario files

A group of rules can live in one JSON file, committed next to the tests and
applied as a unit. It is the same shape the admin API takes and `tunnel export`
writes:

```json
{
  "replace": true,
  "config": {"default_mode": "replay"},
  "mocks": [
    {"key": "GET:api.example.com/v5/feed", "mode": "json", "json_file": "feed_empty.json"},
    {"key": "GET:api.example.com/v5/user/*", "mode": "script", "script_file": "user.js"},
    {"key": "POST:api.example.com/v5/pay", "mode": "json", "json_response": {"code": 500},
     "status_code": 500, "description": "payment refused"}
  ]
}
```

```bash
tunnel apply scenarios/empty_feed.json      # all or nothing: one bad entry applies none
tunnel apply scenarios/empty_feed.json --replace
tunnel export -o scenarios/current.json     # the rules as they stand now
tunnel pack scenarios/empty_feed.json -o bundle/empty_feed.json
```

`script_file` and `json_file` are resolved against the directory the scenario
file is in, and the CLI reads them and sends the content: the server reads no
files of yours, wherever it was started from.

That is also why `tunnel pack` exists. A test case running on a device applies
its scenario itself, over the admin API, and it cannot reach your working
directory: `pack` writes the same scenario with `script_file` and `json_file`
replaced by the content they pointed at, ready to go into the test bundle.
Both commands print to stdout when `-o` is left out.

`tunnel export` leaves the global settings out unless `--with-config` is given,
which writes the default mode and the current session: a scenario is applied per
test case and has no business flipping how every other endpoint of the run is
answered, or which recordings they answer from.

## The request log

Every call tunnel answers is kept whole — query, headers, body, the answer that
went back, the rule that decided it and how long it took.

```bash
tunnel requests                            # aggregated by endpoint
tunnel requests --each --last 20           # the log itself, one row per call
tunnel requests --each --unmatched         # what nothing answered
tunnel requests --each --host api.example.com -q pay
tunnel requests show 17                    # one call in full
tunnel reset --requests                    # clear it; prints the seq it stopped at
```

`--each` takes `--key`, `--host`, `--since SEQ`, `--last N`, `--unmatched`,
`--encrypted` and `-q KEYWORD` (host, path, query, status and rule). A tunnel
whose host is not decrypted appears as a `connect` row: the host, the port and
the bytes each way, which is all there is to know about it.

The recent entries stay in memory (`max_requests_history` of them) and every
one is appended to `requests.jsonl` in the state directory, so `seq` carries on
where the last run left off. Printed output hides the values of
`authorization`, `cookie`, `set-cookie`, `x-api-key` and `proxy-authorization`
— `redact_headers` changes that list, and `show --raw` prints them as they
arrived. The files keep them either way, because a recording has to replay.

### Waiting for a request

`tunnel wait` is what a script blocks on instead of sleeping for a second and
hoping. The server holds the connection open and answers the moment enough
matching calls have arrived:

```bash
tunnel wait POST api.example.com/v5/pay              # one call, ten seconds
tunnel wait GET /v5/poll --count 3 --timeout 30      # three of them
tunnel wait POST /v5/pay -q amount=100 --since 41    # narrowed down
```

It exits 0 and prints the seqs that matched, or 3 with the number seen so far
when the wait runs out — so the exit code is the assertion. `--since SEQ` counts
only what arrived after that seq (`tunnel reset --requests` prints the one to
use); without it the whole log counts, calls made before the wait included.
Each `-q name=value` is a query parameter the call has to carry with that
value; the rest of its query is free.

## Record once, replay in CI

Recording is a global switch rather than a response mode: while it is on, every
call that passes through to the real server is written to the data directory as
a file of its own. Mocked answers are already written down in the rules that
produce them, and a tunnel nobody decrypted has nothing to keep.

```bash
# 1. on your machine, with the device driving the app
tunnel record start --session acct_a
tunnel record stop
tunnel recordings ls --host api.example.com
tunnel recordings show 17

# 2. into the client's repository
tunnel recordings export -o tests/mocks/recordings --session acct_a

# 3. in CI, with no device and no backend
tunnel serve --background
tunnel recordings import tests/mocks/recordings --replace
tunnel mode replay --session acct_a    # answer from acct_a's recordings
tunnel apply tests/mocks/scenarios/empty_feed.json --replace
#    ... run the test suite against it ...
tunnel wait POST api.example.com/v5/pay --timeout 30
tunnel requests --unmatched
tunnel stop
```

A call is filed as
`recordings/<session>/<host>/<METHOD>/<path>/<seq>.json`, so the directory is
already an index and the same endpoint called twice keeps both answers. The
session separates one test account, or one batch, from another:
`record start --session acct_a` switches the current session first and then
records into it, so that a replay started afterwards reads back what was just
recorded, and `record start` without it files the calls under the session
already in hand. In CI it is `tunnel session acct_a`, or the `--session` above,
that moves a whole run from one batch to another. A loose `.json` that lies
outside a session directory names no session of its own, so `import` files it
under the current one. What `export` writes is what `import` reads; header
values are hidden on the way out unless `--raw` is given, while the copy the
server keeps for itself is verbatim, because a recording exists to be replayed.
Review what you commit: these are real responses from a real backend.

### Running in the background

```bash
tunnel serve --background --admin-port 8000 --proxy-port 8890
tunnel status                       # pid, ports, the CA, the directories, the session
tunnel stop                         # SIGTERM, wait for it, clear the record
```

The child is detached — a new session, never a fork — and everything it would
have printed goes to `tunnel.log` in the state directory, so a port it could
not bind is still readable afterwards. `tunnel.pid` next to it holds its pid
and both ports; commands with no `--base` and no `TUNNEL_BASE` read the admin
port from there, so a server started on another port is found without passing
`--base` every time.

## Calling tunnel from a test case

Everything above is the host's side of the work. A test case running inside the
app does the same things over HTTP, because it cannot spawn a command on your
machine. The split that works:

- **Run level, from the host, with the CLI**: `serve --background`,
  `recordings import`, `mode replay --session acct_a`, `ssl add`, `ca install`.
- **Case level, inside the test, over the admin API**: `POST
  /__admin__/mocks/apply` with this case's scenario, `POST
  /__admin__/state/reset` between cases, `GET /__admin__/requests/wait` instead
  of sleeping, `GET /__admin__/requests?each=1` to assert on what was called.

The scenario a test case applies has to be self-contained — `tunnel pack`
writes exactly that — because the server reads no files from the device or from
your checkout.

Where the admin port is, seen from the test:

| Test runs on | Admin API base |
| --- | --- |
| iOS simulator | `http://127.0.0.1:8000` — it shares the Mac's loopback |
| Android emulator | `http://10.0.2.2:8000` |
| Android device over USB | `http://127.0.0.1:8000` after `adb reverse tcp:8000 tcp:8000` |
| iPhone or iPad | there is no reverse forward: do the preparation from the host with the CLI before the run |

### Swift, with URLSession

```swift
enum Tunnel {
    static let base = URL(string: "http://127.0.0.1:8000/__admin__")!

    static func post(_ path: String, _ body: [String: Any]) async throws -> [String: Any] {
        var request = URLRequest(url: base.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, _) = try await URLSession.shared.data(for: request)
        return try JSONSerialization.jsonObject(with: data) as! [String: Any]
    }

    /// Apply this case's scenario, replacing whatever the last one left.
    static func apply(_ scenario: [String: Any]) async throws {
        _ = try await post("mocks/apply", scenario)
        _ = try await post("state/reset", [:])
    }

    /// Block until the client has made this call; false means it never did.
    static func waitFor(_ key: String, timeout: Int = 10) async throws -> Bool {
        var components = URLComponents(url: base.appendingPathComponent("requests/wait"),
                                       resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "key", value: key),
                                 URLQueryItem(name: "timeout", value: String(timeout))]
        let (data, _) = try await URLSession.shared.data(from: components.url!)
        let answer = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        return (answer["timed_out"] as? Bool) == false
    }
}

// in the test
try await Tunnel.apply([
    "replace": true,
    "mocks": [["key": "GET:api.example.com/v5/feed",
               "mode": "json",
               "json_response": ["code": 0, "cards": []]]],
])
// ... drive the app ...
XCTAssertTrue(try await Tunnel.waitFor("POST:api.example.com/v5/pay", timeout: 30))
```

### Kotlin, with OkHttp

```kotlin
object Tunnel {
    // 10.0.2.2 is the host from an emulator; use 127.0.0.1 after `adb reverse`.
    private const val BASE = "http://10.0.2.2:8000/__admin__"
    private val client = OkHttpClient()
    private val JSON = "application/json".toMediaType()

    fun apply(scenario: String) {
        post("mocks/apply", scenario)
        post("state/reset", "{}")
    }

    fun waitFor(key: String, timeoutSeconds: Int = 10): Boolean {
        val url = "$BASE/requests/wait".toHttpUrl().newBuilder()
            .addQueryParameter("key", key)
            .addQueryParameter("timeout", timeoutSeconds.toString())
            .build()
        val body = client.newCall(Request.Builder().url(url).build())
            .execute().use { it.body!!.string() }
        return !JSONObject(body).getBoolean("timed_out")
    }

    private fun post(path: String, body: String): String =
        client.newCall(
            Request.Builder().url("$BASE/$path").post(body.toRequestBody(JSON)).build()
        ).execute().use { response ->
            check(response.isSuccessful) { "tunnel said ${response.code}: ${response.body?.string()}" }
            response.body!!.string()
        }
}

// in the test
Tunnel.apply(
    """
    {"replace": true,
     "mocks": [{"key": "GET:api.example.com/v5/feed", "mode": "json",
                "json_response": {"code": 0, "cards": []}}]}
    """.trimIndent()
)
// ... drive the app ...
assertTrue(Tunnel.waitFor("POST:api.example.com/v5/pay", timeoutSeconds = 30))
```

The app under test needs no code of its own for any of this: it is the proxy
setting and the CA that put its traffic through tunnel. Give the test build a
`network_security_config` that trusts user CAs, and turn certificate pinning
off there.

## Using tunnel from TypeScript tests

The test cases above run inside the app and reach a tunnel somebody started.
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
are the ones the [Admin API v1](#admin-api-v1) table describes. Data keeps the
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

### Function rules

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

### Starting and stopping

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

### Errors, big integers and logs

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

## Driving tunnel from a coding agent

tunnel is a command and a JSON API, so any agent that can run a shell can drive
it: set a rule, drive the client, read what actually arrived. Two things make
that work in a project that is not this one.

**`tunnel agents` prints the guide.** It covers the commands with their exact
shapes, how a rule key matches, what the request log answers, the
`handler(ctx)` surface for script mode with the three commands that prove a
script before you trust it, how replay picks a recording, what a test run does
at case level versus run level, and a closing list of the mistakes that get
made. It comes out of the installed package, so it describes the version you
have rather than whatever is on the default branch.

**Then give the agent one line**, in whichever file it reads by itself —
`CLAUDE.md` for Claude Code, `AGENTS.md` for Codex, Cursor and the rest:

```
Working with tunnel (the local mock proxy)? Run `tunnel agents` first — it prints
the command reference and the handler(ctx) API for the installed version.
```

A line rather than a copy of the guide: 23 KB pasted into a project's
instructions sits in every prompt whether it is wanted or not, and freezes at
the version it was pasted from. The line costs nothing and always resolves to
what is installed.

Nothing else is needed. Everything else an agent uses here is already in the
command: `--json` on every subcommand for output it can parse, exit codes it
can branch on (0 fine, 1 a user error, 2 nothing answering, 3 a wait timed
out), `tunnel check` to send one real request through the proxy, and `tunnel
requests --each` to see what arrived.

### Through MCP

An editor that speaks MCP can hand the agent those same operations as typed
tools instead. It spawns `tunnel mcp` and talks to it over that process's stdin
and stdout, and the agent fills in fields against a schema rather than composing
a command line — a wrong field then comes back as a complaint about that field,
not as a paragraph of 400 to read one's way out of. That, and no new
capability, is what it buys.

```bash
claude mcp add tunnel -- tunnel mcp        # Claude Code
codex mcp add tunnel -- tunnel mcp         # Codex
```

Cursor, Windsurf, Zed and the rest read a JSON file instead; the entry is the
same two fields wherever that client keeps it:

```json
{"mcpServers": {"tunnel": {"command": "tunnel", "args": ["mcp"]}}}
```

`TUNNEL_BASE` belongs in that object's `env` when the admin API answers
somewhere other than `127.0.0.1:8000` — and usually it is not needed, because a
server started with `--background` writes its admin port into the pid file and
every tool call resolves the base again, so a tunnel started after the editor,
or restarted on another port, is found without editing any of this.

**The tools are the operating face; `tunnel agents` is still the knowledge
face.** A schema can say that `strategy` is one of three words; it cannot say
how replay then picks a recording, what `ctx` holds, or why a query string
takes no part in matching a rule. So both are wanted, and an agent given
nothing but the MCP server can still get there — the `guide` tool returns that
same file. And where MCP is not configured at all, nothing is lost: `--json`
and the exit codes are the same operations, composed by hand.

**`tunnel mcp` connects to a server that is already running, and never starts
one.** It is the editor's child process and dies with the editor, while tunnel
is the proxy a phone is pointed at and outlives several editor windows — and
the person who starts it is usually the one who wants to read the LAN address
and the CA fingerprint off the banner. A tool call with nothing answering says
so, and names `tunnel serve --background`.

Sixteen tools, cut by what an agent actually does rather than one per endpoint,
because every schema sits in every prompt whether it is called or not:

| | Tool | What it does |
| --- | --- | --- |
| where you are | `status` | whether tunnel is up and how it is set: version, the directories, the session, the recording switch, the proxy address, the CA fingerprint — the first call |
| | `guide` | the guide `tunnel agents` prints, out of the installed package; the one tool that needs no running server |
| rules | `list_mocks` | every rule as it stands, in the shape `apply_scenario` takes back |
| | `set_mock` | configure one endpoint; only the fields passed change |
| | `delete_mock` | delete one rule |
| | `apply_scenario` | a scenario file or an inline scenario, applied all of it or none of it |
| what arrived | `list_requests` | what the client actually called, aggregated or one row per call; `unmatched` is what no rule answered |
| | `get_request` | one call in full, header values redacted unless `raw` |
| | `wait_for_request` | block until the client makes it; running out of time answers `timed_out` and is not an error |
| | `reset` | clear script state and the replay counters between cases, and the log with `requests` |
| run-level switches | `set_config` | the default mode, the session, the size of the log, the headers that get redacted |
| | `decrypt` | put hosts on the SSL Proxying list or take them off; nothing is decrypted until its host is on it |
| recording and replay | `record` | start, stop or ask — a global switch, not a response mode |
| | `list_recordings` | one row per recorded call |
| | `get_recording` | one recording in full, redacted like `get_request`: what a `ctx.recorded()` script will be handed |
| proving it | `check` | one real request through the proxy port, verified with tunnel's own CA — the step before handing a script on |

## CLI reference

Every command talks to the admin API; `--base URL` (or `TUNNEL_BASE`) says
where it answers, and `--json` makes any command print raw JSON, an error
included — that one goes to stderr as `{"error": "…", "exit_code": 2}`, while a
misspelt flag is still the argument parser's own usage message. Both flags can
be written before or after the subcommand.

| Command | What it does |
| --- | --- |
| `tunnel serve [--admin-port 8000] [--proxy-port 8890] [--proxy-host 0.0.0.0] [--config-dir DIR] [--background]` | start both ports; `--port` is still accepted for the admin port |
| `tunnel status` / `tunnel stop` | follow the server `serve --background` started — pid, both ports, the directories and the current session — and end it |
| `tunnel init` | create `.tunnel/` here, so this project keeps its own config, state and recordings |
| `tunnel agents` | print the guide for coding agents, out of the installed package rather than the default branch |
| `tunnel mcp` | speak MCP on stdin and stdout, so an editor's agent drives tunnel with typed tools instead of command lines |
| `tunnel ls` | the configured rules, with the directories on the first line |
| `tunnel set METHOD [host]/path ...` | configure one endpoint; the options are below |
| `tunnel rm METHOD [host]/path` | delete one rule |
| `tunnel requests [--each] [--key K] [--host H] [--since SEQ] [--last N] [--unmatched] [--encrypted] [-q TEXT]` | what the client called |
| `tunnel requests show SEQ [--raw]` | one call in full |
| `tunnel wait METHOD [host]/path [--count N] [--timeout S] [--since SEQ] [-q K=V]` | block until it arrives; exit 3 on timeout |
| `tunnel reset [METHOD path] [--state] [--requests]` | clear script state and replay counters, and optionally the log |
| `tunnel mode [passthrough\|replay] [--session NAME]` | how endpoints with no rule are answered, and which recordings they answer from; both in one call |
| `tunnel session [NAME]` | the session recording writes into and replay reads from; with no name it prints that one and every other session on disk |
| `tunnel apply FILE [--replace]` | apply a scenario file |
| `tunnel export [-o FILE] [--with-config]` | the rules as they stand, in scenario shape |
| `tunnel pack FILE [-o FILE]` | the same scenario with its `script_file` and `json_file` inlined |
| `tunnel record start [--session NAME]` / `stop` / `status` | the recording switch; calls are filed under the current session, and `--session` switches it first |
| `tunnel recordings ls [--session S] [--key K] [--host H]` | one row per recorded call |
| `tunnel recordings show SEQ [--session S] [--raw]` | one recorded call in full |
| `tunnel recordings export -o DIR [--session S] [--raw]` | write the tree to commit |
| `tunnel recordings import DIR [--replace]` | read that tree back in; a loose `.json` directly under `DIR` goes into the current session |
| `tunnel recordings rm [--session S]` | delete recordings |
| `tunnel ssl ls / add / rm / on / off`, `tunnel ssl exclude add / rm` | which hosts are decrypted |
| `tunnel ca info / export / install / reset` | the CA devices install |
| `tunnel check METHOD URL [-q K=V] [-d BODY]` | send one request through the proxy port and print the answer |
| `tunnel --version` | the version, which `GET /__admin__/health` also reports |

`tunnel set` takes `-d JSON\|@file`, `--script FILE`, `--target URL`,
`--replay` (with `--strategy match\|sequence\|last`, and `--session NAME` to pin
the rule to one session or `--session ''` to put it back on the current one),
`--merge JSON\|@file`, `-H 'Name: value'` (repeatable), `--content-type TYPE`,
`--fault none\|hang\|garbage\|close`, `--fault-seconds SECONDS`, `--mode`,
`--status`, `--delay`, `--desc`, `--enable` and `--disable`. Only the fields it
is given change.

Exit codes: **0** success, **1** a user error (bad arguments, a file that is
not there, the server answering 4xx), **2** nothing answering where the admin
API was expected, **3** `tunnel wait` timed out. `tunnel check` exits 1 when
the answer is 400 or more.

## Admin API v1

Everything under `/__admin__` on the admin port, JSON in and JSON out. Errors
are `{"detail": "..."}` with the status that fits. `PATCH` updates only the
fields it is given; an unknown field is rejected rather than ignored.

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| `GET` | `/__admin__/health` | | `{"status": "ok", "version": "3.0.0", "config_dir": "…", "state_dir": "…", "data_dir": "…", "mocks": 3, "exchanges": 42, "first_seq": 1, "last_seq": 42, "ca_fingerprint": "8B:6F:…", "proxy": {"host": "0.0.0.0", "port": 8890, "lan_ips": ["192.168.1.23"]}, "session": "default", "recording": {"active": false, "session": "default", "count": 12}, "upstream": "direct"}` |
| `GET` | `/__admin__/config` | | `{"default_mode": "passthrough", "max_requests_history": 1000, "auto_record_requests": true, "ssl_proxying": {"enabled": true, "include": [], "exclude": []}, "allow_clients": [], "redact_headers": ["authorization", …], "recording": {"active": false}, "session": "default", "replay_marker": true}` |
| `PATCH` | `/__admin__/config` | any of those fields, e.g. `{"default_mode": "replay", "session": "acct_a"}` | `{"success": true, "config": {…}}` — a `session` that is not a directory name is refused with 400 |
| `GET` | `/__admin__/mocks` | `?key=` for one | `{"mocks": [{"key": "GET:api.example.com/v5/feed", "mode": "json", "json_response": {…}, "status_code": 200, "enabled": true, "description": "", "merge_json": {}, "headers": {}, "target": "", "response_delay": 0, "script": "", "replay_session": "", "replay_strategy": "match", "fault": "none", "fault_seconds": 3600}]}` — an empty `replay_session` follows the current session |
| `PATCH` | `/__admin__/mocks` | `{"key": "GET:/v5/feed", "mode": "json", "json_response": {"cards": []}}` — any subset of the fields above | `{"success": true, "mock": {…}}` |
| `DELETE` | `/__admin__/mocks?key=GET:/v5/feed` | | `{"success": true, "deleted": "GET:/v5/feed"}` |
| `POST` | `/__admin__/mocks/apply` | `{"replace": true, "config": {"default_mode": "replay", "session": "acct_a"}, "mocks": [{"key": …}, …]}` | `{"success": true, "applied": ["GET:/v5/feed"], "replaced": true}` — one invalid entry rejects the lot with 400 |
| `GET` | `/__admin__/export` | `?config=true` for the global settings too | `{"config": {"default_mode": "passthrough", "session": "default"}, "mocks": […]}` |
| `POST` | `/__admin__/state/reset` | `{"key": "GET:/v5/poll"}` or `{}` for all | `{"success": true, "cleared": ["GET:/v5/poll"]}` |
| `GET` | `/__admin__/requests` | `?each=1&key=&host=&since=&last=&unmatched=1&encrypted=1&q=&q_body=1` | `{"requests": [row, …], "last_seq": 42, "unmatched_count": 0}` — rows are the aggregate by key, or one summary per call with `each=1` |
| `GET` | `/__admin__/requests/{seq}` | | one exchange in full, the shape below |
| `GET` | `/__admin__/requests/wait` | `?key=&count=1&since=&timeout=10&q=name=value` (repeatable) | `{"seqs": [41], "count": 1, "wanted": 1, "timed_out": false, "last_seq": 41}` — answers as soon as `count` is reached, or when the timeout is up |
| `POST` | `/__admin__/requests/clear` | | `{"success": true, "last_seq": 42}` |
| `GET` | `/__admin__/events` | `?since=` to get what is buffered first | Server-Sent Events, one exchange summary per `data:` line, plus a named `window` event `{"first_seq": …, "last_seq": …}` on connect, on a clear and every 15s |
| `POST` | `/__admin__/record/start` | `{}` records into the current session; `{"session": "acct_a"}` switches it first | `{"success": true, "active": true, "session": "acct_a", "count": 0}` |
| `POST` | `/__admin__/record/stop` | | `{"success": true, "active": false, "session": "acct_a", "count": 12}` |
| `GET` | `/__admin__/record` | | `{"active": true, "session": "acct_a", "count": 12}` |
| `GET` | `/__admin__/sessions` | | `{"session": "acct_a", "sessions": {"acct_a": 12, "acct_b": 3}}` — the session in hand, and how many calls every session on disk holds |
| `GET` | `/__admin__/recordings` | `?session=&key=&host=` | `{"recordings": [{"session": "acct_a", "seq": 17, "time": "2026-09-24T10:00:00.123", "key": "GET:api.example.com/v5/feed", "query": {"page": "1"}, "status": 200, "size": 1234}], "count": 1}` |
| `GET` | `/__admin__/recordings/{session}/{seq}` | | one exchange in full |
| `POST` | `/__admin__/recordings/import` | `{"session": "acct_a", "replace": true, "exchanges": [exchange, …]}` | `{"success": true, "imported": 12, "session": "acct_a", "replaced": true}` |
| `DELETE` | `/__admin__/recordings` | `?session=` or nothing for every session | `{"success": true, "deleted": 12, "session": "acct_a"}` |
| `GET` | `/__admin__/ca` | | `{"subject": "CN=tunnel CA …", "fingerprint": "8B:6F:…", "not_before": "…", "not_after": "…", "ca_file": "…/ca.pem", "ca_key_file": "…/ca-key.pem"}` |
| `POST` | `/__admin__/ca/reset` | | `{"success": true, …the same fields}` — every device has to install the new certificate |

Two paths sit outside `/__admin__`: `/` is the panel and `/ca.pem` is the CA
certificate, served with the content type that makes a device offer to install
it. The proxy port answers those same two paths for requests addressed to the
port itself — `http://ca.tunnel/` is the install page a proxied device opens —
and 400 for anything else; it carries no management API.

One exchange, as `GET /__admin__/requests/{seq}` returns it and as a recording
file holds it:

```json
{
  "seq": 17,
  "time": "2026-09-24T10:00:00.123",
  "kind": "http",
  "request": {
    "method": "GET", "scheme": "https", "host": "api.example.com", "port": 443,
    "path": "/v5/feed", "query": {"page": "1"},
    "url": "https://api.example.com/v5/feed?page=1",
    "headers": {"user-agent": "…"}, "body": null, "body_encoding": null
  },
  "response": {
    "status": 200, "headers": {"content-type": "application/json"},
    "body": {"code": 0, "cards": []}, "body_encoding": "json",
    "elapsed_ms": 123, "size": 1234
  },
  "matched_by": "GET:api.example.com/v5/feed", "mode": "passthrough",
  "replay_seq": null, "unmatched": false, "client": "192.168.1.23",
  "truncated": false, "encrypted": false, "bytes_up": 0, "bytes_down": 0
}
```

`body_encoding` is `json` when the body was parsed into an object, `text` when
it is a string and `base64` when it is neither; a body over the limit is cut
and `truncated` says so. `kind` is `connect` for a tunnel that was never
decrypted: it has a host, a port, a client, a time and the bytes each way, and
nothing else.

## Where the files live

tunnel owns three kinds of files and touches nothing else on your disk:
**config** (`config.json`, `ca.pem`, `ca-key.pem`), **state**
(`requests.jsonl`, and `tunnel.pid` and `tunnel.log` once one was started in
the background) and **data** (`recordings/`).

Where they go is chosen the way git chooses a config: explicit first, then the
project, then you.

1. `--config-dir` on `tunnel serve`, or `TUNNEL_CONFIG_DIR`
2. the nearest `.tunnel/`, searching upwards from where the server was started
   — `tunnel init` creates one for the project you are in
3. otherwise the user directories

In the first two cases all three land in that one directory, which is what
makes a project's `.tunnel/` a single thing to delete. At the user level they
are split the way the platform splits them:

| | macOS and Linux | Windows |
| --- | --- | --- |
| config | `~/.config/tunnel/` (`$XDG_CONFIG_HOME`) | `%APPDATA%\tunnel` |
| state | `~/.local/state/tunnel/` (`$XDG_STATE_HOME`) | `%LOCALAPPDATA%\tunnel` |
| data | `~/.local/share/tunnel/` (`$XDG_DATA_HOME`) | `%LOCALAPPDATA%\tunnel` |

macOS gets `~/.config` rather than `~/Library/Application Support` on purpose:
the latter is the convention for GUI applications with a bundle identifier,
while command line tools — git and gh among them — live in `~/.config` there
just as they do on Linux. Keeping config apart from state is what lets you wipe
the state directory without losing the CA your devices already trust.

The server logs all three on startup, the first line of `tunnel ls` prints
them, and `GET /__admin__/health` reports them.

> ⚠️ Recorded calls and proxied responses are captured verbatim, so these files
> routinely hold real hostnames, auth headers, session cookies and user data
> from whatever backend you pointed at. Keep them out of version control and
> out of bug reports. Every `.tunnel/` that `tunnel init` creates ignores
> itself: it holds a `.gitignore` of `*`.

## Testing and development

```bash
make help             # show this help message
make setup            # install the dependencies (npm ci)
make test             # run the test suite, straight from the sources
make check            # type-check, and fail on unformatted files
make format           # format the TypeScript
make check-install    # pack, install into a throwaway directory, check the file list, the size budget, the command and the library entry with its types
make run              # run tunnel serve from the sources
make clean            # remove the build output
make panel            # build the panel into assets/panel/ (only when you change panel/)
make panel-check      # type-check the panel and fail when the committed build is stale
make panel-smoke      # open every panel page in Chrome, fail on any console error (needs Playwright; not in make test)
```

One file at a time: `npm run test:file -- tests/cli.test.ts`. The slow tests,
most of them ones that start a real server in a second process, end their
titles in `[slow]`, and `npm run test:fast` skips them. Nothing in the suite
reaches the network: upstream servers are faked in process, sockets are bound
on `127.0.0.1` with a port the operating system picks, and every test writes
to a temporary directory.

The panel is built ahead of time: `make panel` runs Vite over `panel/` and
writes `assets/panel/panel.js`, `assets/panel/panel.css` and the font it uses.
All three are committed, so an install needs no Node build and fetches nothing
— only a change to `panel/` itself needs building. Commit the build with the
change that caused it: `make panel-check` type-checks the sources and fails
when what is committed is not what they build, which is a staleness gate rather
than a coin toss because the build is byte-reproducible. `make panel-smoke` is
the pass a browser makes over it, on a throwaway server of its own: it opens
the five pages and two details in this machine's Chrome and fails on anything
logged. That one needs Playwright, so it is not part of `make test` — a
pre-release gate, run by hand. `panel/README.md` is the rest of it.

```
src/                              # flat, one layer a line: the command first, the base last
├── cli.ts                        # the `tunnel` command
├── mcp.ts                        # `tunnel mcp`: the same operations as MCP tools
├── index.ts                      # startTunnel(): the same operations, in a test's own process
├── cli-*.ts                      # what cli.ts runs: args, common, rules, traffic, ca, server
├── proxy.ts proxy-url.ts admin.ts app.ts   # the proxy port; the admin API and the panel
├── core.ts                       # resolve(request) -> response
├── script*.ts upstream*.ts       # handler(ctx) in a worker thread, or a function in the
│                                 # caller's; the way to the real server
├── recordings.ts                 # the recordings directory, and how a sample is chosen
├── exchanges.ts certs.ts         # the request log; the CA and the certificates it signs
├── config.ts rule-keys.ts messages.ts   # settings; rule keys; the request and the response
├── models.ts                     # the rules and the config, with their defaults
└── json.ts validate.ts glob.ts number-format.ts certs-der.ts errors.ts log.ts package-info.ts
                                  # the base: JSON that keeps integers past 2^53, checks,
                                  # glob patterns, %g, DER, errors, logging and the version

assets/                           # shipped in the package as they are
├── AGENTS.md                     # the guide `tunnel agents` prints
└── panel/                        # the built panel: panel.js, panel.css and its font

tests/
├── *.test.ts                     # the suite: one file per module, or per behaviour
├── contract/                     # black-box: the `tunnel` command as a child process
├── support/                      # shared helpers: temporary directories, fake servers
└── fixtures/                     # golden data the contract tests compare against

panel/                            # the panel's source: React, Catalyst and Vite
└── src/                          # what `make panel` builds; see panel/README.md
```

### Releasing

npm never takes the same version twice, so every release has a version of its
own, and `package.json` is the one place it is written: `tunnel --version`, the
banner, `GET /__admin__/health` and the panel's footer all read it from there.

1. `npm version <x.y.z> --no-git-tag-version` sets it in `package.json` and
   `package-lock.json` alike.
2. `make check-install` packs the package, checks that the tarball holds
   exactly the files it should, installs it, runs the command and the library
   entry, and type-checks a small consumer against the library's types.
3. Commit, and tag that commit `v<x.y.z>`: a lightweight tag, all three parts.
4. `npm publish` from that commit, in a clean working tree. Its `prepack`
   builds `dist/` again first.

## License

MIT — see [LICENSE](LICENSE).
