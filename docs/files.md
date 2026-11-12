# Where the files live

📖 [中文](zh-CN/files.md)

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
