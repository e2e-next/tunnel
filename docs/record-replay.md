# Record once, replay in CI

📖 [中文](zh-CN/record-replay.md)

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

## Running in the background

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
