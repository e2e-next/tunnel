# 命令行速查

📖 [English](../cli.md)

每条命令都与管理 API 对话；`--base URL`（或 `TUNNEL_BASE`）说明它在哪儿作答，
`--json` 让任何命令打印原始 JSON，出错也一样 —— 出错那份走 stderr，形如
`{"error": "…", "exit_code": 2}`，而敲错的参数仍然是参数解析器自己的用法提示。
两个开关写在子命令前后都行。

| 命令 | 做什么 |
| --- | --- |
| `tunnel serve [--admin-port 8000] [--proxy-port 8890] [--proxy-host 0.0.0.0] [--config-dir DIR] [--background]` | 启动两个端口；`--port` 仍然当作管理口接受 |
| `tunnel status` / `tunnel stop` | 跟踪 `serve --background` 起的那个服务 —— pid、两个端口、三类目录和当前 session —— 以及结束它 |
| `tunnel init` | 在当前目录建 `.tunnel/`，让这个项目有自己的 config、state 和录制 |
| `tunnel agents` | 打印给 coding agent 看的那份指南，出自装好的包而不是默认分支 |
| `tunnel mcp` | 在 stdin 和 stdout 上说 MCP，让编辑器里的 agent 用带 schema 的工具驱动 tunnel，而不是拼命令行 |
| `tunnel ls` | 已配置的规则，第一行是三类目录 |
| `tunnel set METHOD [host]/path ...` | 配置一个端点；可选项见下 |
| `tunnel rm METHOD [host]/path` | 删掉一条规则 |
| `tunnel requests [--each] [--key K] [--host H] [--since SEQ] [--last N] [--unmatched] [--encrypted] [-q TEXT]` | 客户端调了什么 |
| `tunnel requests show SEQ [--raw]` | 某一次调用的全貌 |
| `tunnel wait METHOD [host]/path [--count N] [--timeout S] [--since SEQ] [-q K=V]` | 阻塞到它到达；超时退出 3 |
| `tunnel reset [METHOD path] [--state] [--requests]` | 清掉脚本状态和 replay 计数器，也可以顺带清日志 |
| `tunnel mode [passthrough\|replay] [--session NAME]` | 没有规则的端点怎么作答、从哪套录制里作答；一次调用同时设好 |
| `tunnel session [NAME]` | 录制写进去、回放读出来的那个 session；不给名字就打印它和磁盘上其它的 session |
| `tunnel apply FILE [--replace]` | 应用一个场景文件 |
| `tunnel export [-o FILE] [--with-config]` | 当前这些规则，写成场景的形状 |
| `tunnel pack FILE [-o FILE]` | 同一个场景，把 `script_file` 和 `json_file` 内联进去 |
| `tunnel record start [--session NAME]` / `stop` / `status` | 录制开关；调用落进当前 session，给了 `--session` 就先切过去 |
| `tunnel recordings ls [--session S] [--key K] [--host H]` | 每条录制一行 |
| `tunnel recordings show SEQ [--session S] [--raw]` | 某条录制的全貌 |
| `tunnel recordings export -o DIR [--session S] [--raw]` | 写出可以提交的目录树 |
| `tunnel recordings import DIR [--replace]` | 把那棵树读回来；直接躺在 `DIR` 下的 `.json` 归进当前 session |
| `tunnel recordings rm [--session S]` | 删录制 |
| `tunnel ssl ls / add / rm / on / off`、`tunnel ssl exclude add / rm` | 哪些 host 被解密 |
| `tunnel ca info / export / install / reset` | 设备要装的那份 CA |
| `tunnel check METHOD URL [-q K=V] [-d BODY]` | 经代理口真打一发并打印回答 |
| `tunnel --version` | 版本号，`GET /__admin__/health` 也会报它 |

`tunnel set` 接受 `-d JSON\|@file`、`--script FILE`、`--target URL`、
`--replay`（配 `--strategy match\|sequence\|last`，以及把规则钉死在某个 session
上的 `--session NAME`、把它放回当前 session 的 `--session ''`）、
`--merge JSON\|@file`、`-H 'Name: value'`（可重复）、`--content-type TYPE`、
`--fault none\|hang\|garbage\|close`、`--fault-seconds SECONDS`、`--mode`、
`--status`、`--delay`、`--desc`、`--enable` 和 `--disable`。只有你传的字段会变。

退出码：**0** 成功，**1** 用户错误（参数不对、文件不在、服务端答了 4xx），
**2** 管理 API 那个地址上没人应答，**3** `tunnel wait` 超时。`tunnel check` 在
回答是 400 及以上时退出 1。
