# tunnel

AI-first 的 mock server 与 HTTPS 代理：把手机、模拟器或任何 HTTP 客户端指向它，
就能查看、录制、mock、回放 API 调用 —— 由你的 AI 编码助手通过 MCP 或命令行驱动，
也可以嵌进你自己的代码里驱动。

📖 [English](README.md)

[![Node](https://img.shields.io/badge/node-22.18%2B-brightgreen.svg)](https://nodejs.org)
[![npm](https://img.shields.io/npm/v/tunnel-use.svg)](https://www.npmjs.com/package/tunnel-use)
[![License](https://img.shields.io/badge/license-MIT-lightgrey.svg)](LICENSE)

## 痛点

拿真实后端测客户端，又慢又不稳：

- 真正值得测的情况 —— 空列表、支付失败、响应很慢或返回坏数据 —— 很难让真实服务器
  按需给出来。
- 真实数据会变，测试账号会被用掉，同一轮测试明天就是另一个结果。
- Charles 这类代理能改返回，但得手点，一次一下：测试套件和 AI 编码助手都驱动不了。
- 另起一个 mock server，就得让 app 改连别的地址，每个返回还都要自己写。
- CI 悄悄打到了真实后端，测试过了，却不是因为对的理由。

## tunnel 怎么解决

app 照旧调用它真实的 host，只需要把 HTTP 代理指向 tunnel、信任 tunnel 的证书。
tunnel 解密你点名的 host，记下每一次调用，每个端点按它的规则作答：

- **录制**：真实返回录一次，每次调用一个 JSON 文件，可以和测试一起提交。
- **Mock**：答字面量 JSON，或者交给 JavaScript `handler(ctx)`，它可以拿录制的返回
  改掉其中一个字段再答。
- **回放**：从录制作答，不碰网络。没有任何东西能答的调用直接拒绝，不会漏到真实后端，
  `tunnel requests --unmatched` 会把它们列出来。
- **故意弄坏**：任意状态码、延迟、挂住或掐断连接、JSON 写到一半的响应体。
- **检查**：等调用到来而不是 sleep，再把它完整读回来。

规则下一个请求就生效，不用重启，也不用重新打包 app。

## 特色

### AI-first：让 AI 编码助手来驱动

`tunnel mcp` 给 Claude Code、Codex 或任何 MCP 客户端十六个带类型的工具。每条命令
也都能加 `--json`，退出码可以拿来分支；`tunnel agents` 打印对应已装版本的使用指南。

```bash
claude mcp add tunnel -- tunnel mcp        # Claude Code
codex mcp add tunnel -- tunnel mcp         # Codex
```

之后用一句大白话提要求就够了 ——「feed 返回空列表，然后告诉我 app 调了什么」——
agent 会设好规则、等调用到来、再把它们读回来。

### 嵌进测试代码

每个用例在测试里自己设定返回、自己检查 app 调了什么。跑在 Node 或 TypeScript
里的测试套件直接在自己的进程里起 tunnel，不用先起服务，也不用约定端口：

```ts
import assert from 'node:assert/strict'
import { startTunnel } from 'tunnel-use'

const tunnel = await startTunnel({ proxyHost: '127.0.0.1' })
try {
  await tunnel.setRule({ key: 'GET:api.example.test/v5/feed', mode: 'json', json_response: { cards: [] } })
  // …经 tunnel.proxyUrl 驱动 app；这里用一个请求代替
  const answer = await tunnel.check('GET', 'http://api.example.test/v5/feed')
  assert.equal(answer.status, 200)
  const wait = await tunnel.waitForRequest({ key: 'GET:api.example.test/v5/feed', timeout: 5 })
  assert.equal(wait.timed_out, false)
} finally {
  await tunnel.stop()
}
```

跑在 app 里的 Swift、Kotlin 测试用例经管理 API 做同样的事。

## 安装

```bash
npm install -g tunnel-use   # 包名；命令叫 `tunnel`
```

需要 Node 22.18 或更新版本。

## 快速开始

```bash
tunnel serve
```

它会打印要填进设备的代理地址和要安装的 CA：

```
tunnel 3.0.0
  panel:  http://127.0.0.1:8000/
  proxy:  0.0.0.0:8890
    set the device's HTTP proxy to 192.168.1.23 port 8890
  upstream: direct
  CA:     http://ca.tunnel/ once the device is proxied, or http://192.168.1.23:8890/ca.pem
          8B:6F:...:1C
```

把设备设好（各平台的步骤见[让设备走它](docs/zh-CN/devices.md)），打开
<http://127.0.0.1:8000/> 看请求到达，然后：

```bash
tunnel requests                                        # 客户端实际调了什么
tunnel ssl add api.example.com                         # 解密这个 host 的 HTTPS
tunnel set GET api.example.com/v5/feed -d '{"cards": []}'   # 用这个作答
tunnel check GET https://api.example.com/v5/feed       # 经代理口真打一发
```

## 文档

| 页面 | 讲什么 |
| --- | --- |
| [工作原理](docs/zh-CN/how-it-works.md) | 两个端口，每个请求怎么被作答 |
| [让设备走它](docs/zh-CN/devices.md) | 手机、模拟器怎么接进来；CA 证书；哪些 host 会被解密；上游代理 |
| [面板](docs/zh-CN/panel.md) | `127.0.0.1:8000` 上的网页面板 |
| [规则](docs/zh-CN/rules.md) | 规则 key；json、script、passthrough、replay 四种模式；session；故障与延迟；场景文件 |
| [请求日志](docs/zh-CN/requests.md) | app 调了什么，以及等待某个调用 |
| [录一次，在 CI 里回放](docs/zh-CN/record-replay.md) | 录制、CI 里的 session、后台运行 |
| [在测试用例里调用 tunnel](docs/zh-CN/in-app-tests.md) | Swift、Kotlin 测试用例经管理 API 调用 |
| [在 TypeScript 测试里用 tunnel](docs/zh-CN/typescript-tests.md) | `tunnel-use` 库：`startTunnel()` 和函数规则 |
| [用 AI 编码助手来驱动](docs/zh-CN/agents.md) | `tunnel agents` 和 MCP server |
| [命令行速查](docs/zh-CN/cli.md) | 所有命令 |
| [管理 API v1](docs/zh-CN/admin-api.md) | CLI、面板和 MCP 共用的 HTTP API |
| [文件放在哪里](docs/zh-CN/files.md) | config、state、data 三类目录 |
| [测试与开发](docs/zh-CN/development.md) | 开发 tunnel 本身，以及发版 |

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
