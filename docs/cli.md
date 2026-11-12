# CLI reference

📖 [中文](zh-CN/cli.md)

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
