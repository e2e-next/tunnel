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

## Several devices at once

A server's rules, script state, request log and faults are its own, so devices
tested side by side get a server each, on ports and a config directory of their
own. What they share, the CA and the recordings, is set up before they start:

```bash
for n in 1 2 3; do
  dir=.tunnel/device-$n
  mkdir -p $dir
  cp .tunnel/ca.pem .tunnel/ca-key.pem $dir/    # the CA the devices trust
  tunnel serve --background --config-dir $dir --data-dir .tunnel \
    --admin-port 800$n --proxy-port 889$n
  TUNNEL_BASE=http://127.0.0.1:800$n tunnel mode replay --session acct_a
done
TUNNEL_BASE=http://127.0.0.1:8001 tunnel recordings import tests/mocks/recordings --replace
#    ... device n proxies through port 889n, its test cases call 800n ...
for n in 1 2 3; do TUNNEL_CONFIG_DIR=.tunnel/device-$n tunnel stop; done
```

- **The CA.** A config directory gets a CA of its own the first time a server
  starts there, so the pair the devices trust goes in before that: `tunnel ca
  info` names the files of the one in use, and in CI it is the pair the image
  was built with. Each server prints the fingerprint it signs with.
- **The recordings.** `--data-dir` keeps every server's recordings in one
  place, `.tunnel/recordings/` above, so what one imports, all of them replay. A
  server reads a session once and keeps it, and sees it change when another
  server records, imports or deletes there. What to avoid is two servers
  recording into one session at the same time: each names its files by its own
  request numbers, and one overwrites the other's.
- **Addresses.** A command reaches a server through `--base` or `TUNNEL_BASE`,
  and one started with `--background` also through `TUNNEL_CONFIG_DIR`, which
  leads to its `tunnel.pid`. `tunnel mcp` reads the same variables, so an
  agent's MCP server is pointed at one server by its environment. A script
  needs no address: `ctx.requests()` reads the log of the server it runs in.
