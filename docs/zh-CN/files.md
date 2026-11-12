# 文件放在哪里

📖 [English](../files.md)

tunnel 拥有三类文件，你磁盘上别的东西它一概不碰：**config**（`config.json`、
`ca.pem`、`ca-key.pem`）、**state**（`requests.jsonl`，以及后台起过服务之后的
`tunnel.pid` 和 `tunnel.log`）和 **data**（`recordings/`）。

它们放在哪里，和 git 选配置的方式一样：先显式指定，再看项目，最后才是你。

1. `tunnel serve` 的 `--config-dir`，或者 `TUNNEL_CONFIG_DIR`
2. 从服务启动的位置向上找到的最近一个 `.tunnel/` —— `tunnel init` 给你所在的
   项目建一个
3. 都没有就用用户级目录

前两种情况下三类目录都落在那一个目录里，这正是项目的 `.tunnel/` 删起来是一件
事的原因。在用户级它们按各平台的习惯分开放：

| | macOS 与 Linux | Windows |
| --- | --- | --- |
| config | `~/.config/tunnel/`（`$XDG_CONFIG_HOME`） | `%APPDATA%\tunnel` |
| state | `~/.local/state/tunnel/`（`$XDG_STATE_HOME`） | `%LOCALAPPDATA%\tunnel` |
| data | `~/.local/share/tunnel/`（`$XDG_DATA_HOME`） | `%LOCALAPPDATA%\tunnel` |

macOS 上用 `~/.config` 而不是 `~/Library/Application Support` 是有意的：后者是
带 bundle identifier 的图形应用的惯例，而命令行工具 —— git 和 gh 都在其中 ——
在 macOS 上也和在 Linux 上一样住在 `~/.config`。把 config 和 state 分开，
才能清掉 state 目录而不丢掉设备已经信任的那份 CA。

服务启动时会把三类目录都记进日志，`tunnel ls` 的第一行会打印它们，
`GET /__admin__/health` 也会报。

> ⚠️ 录制和透传的响应都是原样留下的，所以这些文件里经常有真实的主机名、
> 认证头、会话 cookie，以及你指向的那个后端上的用户数据。别让它们进版本库，
> 也别进 bug 报告。`tunnel init` 建出来的每个 `.tunnel/` 都会忽略自己：
> 里面有一个内容为 `*` 的 `.gitignore`。
