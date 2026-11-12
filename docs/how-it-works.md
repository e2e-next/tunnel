# How it works

📖 [中文](zh-CN/how-it-works.md)

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
cannot spawn a command on your machine. [Calling tunnel from a test case](in-app-tests.md) has the split.
