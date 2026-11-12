# Rules

📖 [中文](zh-CN/rules.md)

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

## Modes

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

## The global mode, and the current session

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

## Shaping the answer

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
