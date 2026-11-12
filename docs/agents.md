# Driving tunnel from a coding agent

📖 [中文](zh-CN/agents.md)

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

## Through MCP

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
