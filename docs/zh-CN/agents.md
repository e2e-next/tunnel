# 用 AI 编码助手来驱动

📖 [English](../agents.md)

tunnel 就是一个命令加一套 JSON API，所以任何能执行 shell 的 agent 都能驱动它：
配一条规则、驱动客户端、读实际收到了什么。要让它在**别的工程**里也能用，需要两样
东西。

**`tunnel agents` 会打印那份给 agent 看的文档**：命令与它们确切的形状、规则 key
怎么匹配、请求日志能回答什么、script 模式的 `handler(ctx)` 全部接口以及「交付前
用哪三条命令验」、replay 如何挑中一条录制、测试里哪些事在 run 级哪些在 case 级，
最后是一份「实际会犯的错」清单。它从**已安装的包**里出来，所以描述的是你装的这个
版本，而不是主干上的任意状态。

**然后给 agent 一行字**，放进它自己会读的那个文件——Claude Code 是 `CLAUDE.md`，
Codex、Cursor 等是 `AGENTS.md`：

```
Working with tunnel (the local mock proxy)? Run `tunnel agents` first — it prints
the command reference and the handler(ctx) API for the installed version.
```

是**一行指针，不是把文档拷进去**：那份文档 23 KB，贴进工程的指令文件等于每次会话
都无条件背着它，而且从此冻结在你粘贴的那个版本上。一行指针不花成本，且永远解析到
当前安装的版本。

除此之外不需要别的。agent 要用的其余东西命令里本来就有：每个子命令都支持
`--json`、可分支的退出码（0 正常、1 用法错、2 没人应答、3 wait 超时）、`tunnel
check` 打一发真请求穿过代理、`tunnel requests --each` 看实际到达了什么。

## 走 MCP

会说 MCP 的编辑器可以把上面这些操作换一副面孔递给 agent：它把 `tunnel mcp`
拉起来，在这个进程的 stdin 和 stdout 上跟它对话，于是 agent 是照着 schema
填字段，而不是自己拼一行命令 —— 字段填错了，回来的是针对那个字段的一句话，
而不是一段得自己读出门道的 400。它多出来的就是这一点，没有任何新能力。

```bash
claude mcp add tunnel -- tunnel mcp        # Claude Code
codex mcp add tunnel -- tunnel mcp         # Codex
```

Cursor、Windsurf、Zed 这些读的是一份 JSON 配置；不管那个客户端把它放在哪儿，
条目都是同样两个字段：

```json
{"mcpServers": {"tunnel": {"command": "tunnel", "args": ["mcp"]}}}
```

管理 API 不在 `127.0.0.1:8000` 上作答时，把 `TUNNEL_BASE` 放进这个对象的 `env`
里 —— 而通常用不着：`--background` 起的服务会把自己的管理口写进 pid 文件，每次
工具调用都重新解析一次 base，所以编辑器先起、tunnel 后起，或者 tunnel 换个端口
重启，都不用回来改这里。

**工具是操作面，`tunnel agents` 仍然是知识面。** schema 能说明 `strategy` 是三个
词里的一个，却说不了 replay 接下来怎么挑中一条录制、`ctx` 上到底有什么、为什么
query string 不参与规则匹配。所以两样都要；而只配了 MCP server 的 agent 也照样
够得着 —— `guide` 工具返回的就是那同一份文件。至于完全没配 MCP 的场合，也不损失
什么：`--json` 和退出码是同一套操作，只是得自己拼。

**`tunnel mcp` 连的是一个已经在跑的服务，它绝不会自己起一个。** 它是编辑器的子
进程，编辑器一退它就死；而 tunnel 是手机要指过来的那个代理，通常比好几个编辑器
窗口活得都久 —— 何况起它的那个人，多半正是要看 banner 里的 LAN 地址和 CA 指纹的
人。服务没起时，工具调用会把这件事说清楚，并报出 `tunnel serve --background`。

16 个工具，是按「agent 真正要做的事」切的，而不是一个端点配一个，因为每个 schema
不管用不用都常驻在每一次提示里：

| | 工具 | 做什么 |
| --- | --- | --- |
| 你在哪儿 | `status` | tunnel 在不在、此刻是怎么设的：版本、三类目录、当前 session、录制开关、代理地址、CA 指纹 —— 第一个该调的 |
| | `guide` | `tunnel agents` 打印的那份文档，从已安装的包里出来；唯一一个不需要服务在跑的工具 |
| 规则 | `list_mocks` | 当前全部规则，形状就是 `apply_scenario` 收回去的那个 |
| | `set_mock` | 配置一个端点；只有传了的字段会变 |
| | `delete_mock` | 删掉一条规则 |
| | `apply_scenario` | 一个场景文件，或者直接给出的场景；要么全应用，要么一条都不应用 |
| 收到了什么 | `list_requests` | 客户端实际调了什么，聚合或者一次调用一行；`unmatched` 就是「还有什么没人应答」 |
| | `get_request` | 某一次调用的全貌，header 值默认脱敏，`raw` 才给原值 |
| | `wait_for_request` | 阻塞到客户端真的调了它；等到超时会答 `timed_out`，那不是错误 |
| | `reset` | 清掉一个用例留给下一个的东西：脚本状态和 replay 计数器，带上 `requests` 连日志一起 |
| 整轮开关 | `set_config` | 全局模式、当前 session、日志留多少条、哪些 header 要脱敏 |
| | `decrypt` | 把 host 加进 SSL Proxying 列表或者拿出来；host 不在表上就什么都不解密 |
| 录制与回放 | `record` | 开、关、问一声 —— 这是个全局开关，不是一种响应模式 |
| | `list_recordings` | 每条录制一行 |
| | `get_recording` | 某条录制的全貌，和 `get_request` 一样默认脱敏：也就是写 `ctx.recorded()` 的脚本会拿到的东西 |
| 证明它对 | `check` | 经代理口真打一发，用 tunnel 自己的 CA 验 —— 交付一个脚本前的那一步 |
