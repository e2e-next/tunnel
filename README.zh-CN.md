# tunnel

给客户端测试用的本地 HTTP 代理与 mock server。手机、模拟器或任何别的客户端，
像指向 Charles 一样把 HTTP 代理指到这台机器；tunnel 解密你点名的 host，
实时显示每一次调用，把真实服务端的回答留下来，之后就用这些录制作答 ——
也可以答字面量 JSON，或者一分钟前刚写好的 JavaScript handler。

tunnel 是按 AI 编码助手来驱动设计的：每条命令都能加 `--json` 输出 JSON，
`tunnel mcp` 把同样的操作做成带类型的工具，交给 Claude Code、Codex 这类 MCP
客户端，`tunnel agents` 打印 agent 该先读的那份文档。详见
[用 AI 编码助手来驱动](#用-ai-编码助手来驱动)。

📖 [English](README.md)

[![Node](https://img.shields.io/badge/node-22.18%2B-brightgreen.svg)](https://nodejs.org)
[![npm](https://img.shields.io/npm/v/tunnel-use.svg)](https://www.npmjs.com/package/tunnel-use)
[![License](https://img.shields.io/badge/license-MIT-lightgrey.svg)](LICENSE)

## 这是什么

一个进程监听两个端口：

| 端口 | 绑定 | 承载什么 |
| --- | --- | --- |
| 代理口 8890 | 所有网卡 | 设备发来的流量；不带任何管理能力 |
| 管理口 8000 | `127.0.0.1` | 面板、JSON 管理 API、CA 下载 |

到达代理口的每个请求都由同一个内核作答。请求被完整记下来，按你配置的规则匹配
—— key 的形状是 `METHOD:host/path` —— 再按那条规则的模式作答。没有自己规则的
端点走全局模式：`passthrough` 把它送到客户端原本要去的服务器，`replay` 用录制
作答、没有录制就拒绝，这样自动化跑起来就不会偷偷打到真实后端。

规则可以在客户端一直跑着的时候改：下一个请求就生效，不用重启，也不用重新打包。

管理 API 是契约，`tunnel` 只是它的一层薄封装。整轮跑动共用的准备 —— 启动服务、
导入录制、切换模式和 session、安装 CA —— 在宿主机上用 CLI 做。跑在设备里的测试
用例做同样的事情要走 HTTP，因为它没法在你的机器上起一个命令。两边下面都会讲到。

## 安装

```bash
npm install -g tunnel-use   # 包名；命令叫 `tunnel`
tunnel --version
```

需要 Node 22.18 或更新版本。从源码 checkout 的话，先 `npm ci`，然后 `make run` 直接
从源码跑起来；或者 `npm run build && npm link`，把 checkout 里的 `tunnel` 放上
PATH —— 改了 `src/` 之后要重新 build。

## 快速开始

```bash
tunnel serve
```

它会打印要填进设备的地址和 CA 指纹（它拥有的三类目录会进启动日志，
`tunnel ls` 也会打印）：

```
tunnel 3.0.0
  panel:  http://127.0.0.1:8000/
  proxy:  0.0.0.0:8890
    set the device's HTTP proxy to 192.168.1.23 port 8890
  upstream: direct
  CA:     http://ca.tunnel/ once the device is proxied, or http://192.168.1.23:8890/ca.pem
          8B:6F:...:1C
```

把设备指过来（见下），打开 <http://127.0.0.1:8000/> 看请求到达，然后在另一个
终端里：

```bash
tunnel requests                                        # 客户端实际调了什么
tunnel ssl add api.example.com                         # 解密这个 host 的 HTTPS
tunnel set GET api.example.com/v5/feed -d '{"cards": []}'   # 用这个作答
tunnel check GET https://api.example.com/v5/feed       # 经代理口真打一发
```

## 让设备走它

`tunnel serve` 会打印这台机器的各个局域网地址；下面的 `PORT` 是代理端口，
没改过就是 8890。

| 客户端 | 怎么接进来 |
| --- | --- |
| iPhone / iPad | 设置 > 无线局域网 > 当前网络 > 配置代理 > 手动，填这台机器的局域网地址和 `PORT` |
| Android 手机 | WLAN > 当前网络 > 高级 > 代理 > 手动，同样的地址和端口 |
| iOS 模拟器 | 跟随 Mac 自己的代理设置：系统设置 > 网络 > 当前网卡 > 详细信息 > 代理 > 网页代理和安全网页代理，填 `127.0.0.1:PORT`。用完记得关掉 —— 这是整台机器的设置。tunnel 认得出这个代理就是它自己，所以它往外发的流量直连出去，不会再绕回自己，横幅上写的是 `upstream: direct (system proxy points at tunnel itself, ignored)` |
| Android 模拟器 | `adb shell settings put global http_proxy 10.0.2.2:PORT`，清除用 `adb shell settings put global http_proxy :0`。`10.0.2.2` 是模拟器眼里的宿主机 |

同一个 Wi-Fi 下的设备从私有网段（10/8、172.16/12、192.168/16、fc00::/7）和本机
过来都会被接受；config 里的 `allow_clients` 可以把范围收窄成一串地址或 CIDR。
其余的连接直接关掉并记一条日志。从网络上过来、却指向本机回环地址的请求会被
403 拒绝 —— 管理口就在那儿，挨着它的代理口不是绕过去的路。

要从设备访问**管理口**，请做端口转发而不是把它暴露出去：Android 上用
`adb reverse tcp:8000 tcp:8000`，模拟器里用 `10.0.2.2:8000`，iOS 模拟器共享 Mac
的回环，直接 `127.0.0.1:8000`。

### CA 证书

tunnel 用自己的一份 CA 给它提供的 TLS 证书签名，CA 以 `ca.pem` 和 `ca-key.pem`
存在 config 目录里。它在第一次用到时生成，之后就不动了：设备信过一次就一直信，
清空 state 目录也带不走它。

```bash
tunnel ca info                          # 指纹、有效期和文件路径
tunnel ca export -o tunnel-ca.pem       # 要装到设备上的那份证书
tunnel ca install --ios-simulator       # xcrun simctl keychain booted add-root-cert
tunnel ca install --android             # adb push，然后在设置里安装
tunnel ca install --macos               # security add-trusted-cert，会要密码
tunnel ca reset                         # 重新来过；所有设备都得重装
```

已经走 tunnel 代理的设备可以打开 <http://ca.tunnel/>，那是一页各平台的安装说明；
还没设代理的设备可以直接取 `http://<这台机器>:8890/ca.pem`，
<http://127.0.0.1:8000/ca.pem> 给的是同一个文件。`ca` 系列命令在服务跑着时从
运行中的服务读证书，没跑时从 config 目录读，所以设备的准备工作不挑先后顺序。

装上不等于信任。下面这些注意事项和 Charles 的完全一样：

- **iOS**：描述文件装好之后，还要在 设置 > 通用 > 关于本机 > 证书信任设置 里把
  这张证书打开。模拟器不需要这一步 —— `tunnel ca install --ios-simulator` 就够了。
- **Android 7 及以上**：应用默认不信任用户安装的 CA。测试构建要在
  `network_security_config` 里用 `<certificates src="user"/>`（或一个
  `<debug-overrides>` 块）显式打开。
- **所有平台**：做了证书固定的应用，不管 CA 怎么装都会拒绝 tunnel 的证书，
  所以你要测的那个构建必须把 pinning 关掉。

### 哪些 host 会被解密

光装上 CA 还不够：tunnel 只解密你列出来的 host，和 Charles 的 SSL Proxying
Locations 一样。一开始列表是空的，所以每条 HTTPS 连接都原样按字节转发，直到你
另有交代 —— 做了证书固定的第三方 SDK 照常能用，日志也清爽。

```bash
tunnel ssl ls                                   # 两个列表，以及开关状态
tunnel ssl add api.example.com '*.example.com:443'
tunnel ssl rm api.example.com
tunnel ssl exclude add cdn.example.com          # 这个永远不解密
tunnel ssl on / tunnel ssl off                  # 管着两个列表的总开关
```

条目形如 `host[:port]`；host 里 `*` 是通配，省略端口表示任意端口。exclude 优先
于 include。改动在下一条连接上生效；已经建立的隧道不受影响。没被解密的 host
仍会作为一条 `connect` 记录出现在日志里，带上双向传输的字节数，面板上可以一键
把它加进列表。

### 上游代理

tunnel 自己不作答的流量 —— passthrough，以及发往不解密的 host 的 HTTPS 连接 ——
离开这台机器的方式和 Mac 自己的流量一样：

1. 先看环境变量：`https_proxy`、`http_proxy`、`all_proxy` 和 `no_proxy`，每个都先读
   小写的，小写的没设才读大写的。前三个里只要设了一个，就只看环境变量：`https://`
   的调用和不解密的隧道走 `https_proxy`，`http://` 的调用走 `http_proxy`，两者都
   退回到 `all_proxy`。
2. 没有的话，在 macOS 上读系统代理：「网页代理」管 `http://`，「安全网页代理」管
   `https://` 和隧道，例外列表和「不包括简单主机名」都照办。读到的设置过了五秒就
   重读，所以打开或关掉一个代理 App，五秒内就跟上，不用重启。
3. 再没有就直连服务器。

回环地址、私有网段、link-local 地址和 `*.local` 名字一律直连；代理就是 tunnel 自己
的时候 —— 上面 iOS 模拟器那种设法 —— 也全部直连，所以 tunnel 永远不会把自己的流量
交回给自己。`no_proxy` 不管代理是从哪儿来的都管用，`NO_PROXY=*` 让所有流量直连。

路线就是一行字：横幅和 `tunnel status` 把它打成 `upstream:`，
`GET /__admin__/health` 把它报成 `upstream`；日志（后台运行时是 `tunnel.log`）在
第一次读到时和每次变化时各记一行 `Upstream route: …`：

```
upstream: direct
upstream: via 127.0.0.1:3128 (system proxy)
upstream: via http://proxy:3128 (HTTPS_PROXY)
upstream: via http://proxy:3128 (http_proxy) for http; direct for https
upstream: direct (system proxy points at tunnel itself, ignored)
upstream: direct (ALL_PROXY=socks5://127.0.0.1:7890 ignored: only http:// proxies are supported)
```

在代理那里失败的调用是一个写明代理的 502，比如
`Could not reach https://api.example.com through the proxy 127.0.0.1:3128 (system proxy): …`；
隧道在那里失败的话，客户端拿到的只是一个空的 502，代理写在那条日志里。

只会说 `http://` 的代理：`socks5://` 或 `https://` 的代理会被忽略、那部分流量直连，
`upstream:` 那一行会写明；PAC 文件、系统的 SOCKS 代理、要从钥匙串取密码的系统代理
都不支持。要用别的代理，就在启动 tunnel 时设环境变量。CLI 自己调管理口的请求直连；
shell 里开着 Node 的 `NODE_USE_ENV_PROXY=1` 的话，把 `127.0.0.1` 加进 `NO_PROXY`，
它们才仍然直连。

## 面板

<http://127.0.0.1:8000/> 是一个页面，一个预先构建好的 React 应用，不从互联网
加载任何东西：`make panel` 写出 `assets/panel/panel.js`、`assets/panel/panel.css`
和 `assets/panel/panel-InterVariable-latin.woff2`，三个文件都提交进仓库，所以安装
时什么都不用构建，断网也能把面板打开。

侧栏放着五个页面，以及所有属于这一轮运行、而不属于某一页的东西：顶上是 session
切换器；**This run** 一节是默认模式（**Live** 或 **Replay**，即 `tunnel mode`，
回放时带未命中的条数）和录制按钮（`tunnel record`）；脚部是设备要用的代理地址、
版本号，以及一个小点 —— 事件流断了它就变灰，并显示 `reconnecting…`。⌘K 能到每
一页、两个开关、每个 session，以及按 key 找到每条规则。

**Traffic** 是实时到达的日志，走 Server-Sent Events：调用一行一条列成一张表，
点开的那条在旁边的详情栏里 —— 概览、谁答的，然后是请求与响应的头和正文（窗口窄
到放不下两列时，详情改成对话框）。可以按 host、路径、query、状态或答它的规则
搜索；可以只看某个 host、某个方法、某段状态码，只看 **Unmatched** 或
**Encrypted** 的行；勾上 **Search bodies**，搜索就交给服务端 —— 正文在那边。
**Pause** 冻住列表，而这一轮运行在底下照常继续，**Clear** 清空日志；每行都有一
个菜单：Open、**Mock this**、**Copy as curl**、**Copy key**、只看这个 host、跳
到答它的那条规则 —— 没被解密的隧道还多一条 **Decrypt this host**。

**Rules** 列出每条规则，带模式、状态码、命中次数和一个开关；点开就是这条规则的
每个字段：key —— 新建时分三段填，存过之后只读，因为换一个端点就是另一条规则
—— 然后是模式，只展开所选模式的字段（JSON 正文、JavaScript handler、session 加
策略，或者要转发到的 target），再是状态码、延迟、额外的响应头、要注入的故障，
以及一条留给下一个人的备注。New rule、Duplicate、Delete、Reset state 就是这里的
`tunnel set`、`tunnel rm` 和 `tunnel reset`；整套规则进出仍走 `tunnel apply`
与 `tunnel export`。

**Recordings** 列出磁盘上的 session、各自有多少条录制、这一轮用的是哪一个、上次
录进去是多久以前；点进一个 session 是它录下的调用，再点一条就看全貌。把一个
session 设为当前、往里录或者删掉，都在这里 —— 即 `tunnel session`、
`tunnel record` 和 `tunnel recordings rm` —— 导出与导入仍在命令行。

**Connect a device** 带一台设备接进来，三步，每一步的勾都是从日志里挣来的，不是
页面自己打的：要设的代理地址，每个网卡一条、各带复制按钮；证书 —— `/ca.pem`
下载、设备上打开的 `http://ca.tunnel/`、用来核对的指纹，以及 iOS 和 Android 的
步骤；要解密什么 —— SSL proxying 开关、include 与 exclude 两个列表，以及最近走
隧道的 host，每个都带一个 **Decrypt** 按钮（`tunnel ssl add`）。下面列出跟代理
说过话的每个客户端，以及它最后一次出现的时间。

**Settings** 是设一次就不动的东西：默认模式与 replay marker、日志保留多少条、是
否每轮运行都自动录制、日志和录制里隐去哪些 header、允许的客户端（这里只读，要改
用 `tunnel config`），以及这台服务把文件放在哪儿，连证书的指纹和到期那天。

## 规则

### key

规则的 key 是 `METHOD:[host[:port]]/path`。**query 和 headers 不参与匹配** ——
要按它们分支就写脚本。`*` 在 host 和 path 里都是通配，在 path 里还能跨 `/`：

```bash
tunnel set GET '/api/user/*' -d '{"id": 1}'             # 任意 host，/api/user/42 及其下
tunnel set GET 'api.example.com/v5/feed' -d '{"v": 1}'  # 只有这一个 host
tunnel set GET '*.example.com/api/*' -d '{"v": 1}'      # 一族 host
```

不带 host 的 key 对所有 host 都作答。最具体的规则胜出：精确路径胜过通配路径，
精确 host 胜过通配 host、通配 host 胜过不限 host；两个同样具体的模式之间，
更长的那个胜出。`tunnel requests` 会在方括号里显示每次调用是被哪条规则答的。

### 模式

**json** —— 原样返回 `json_response`，对象或数组都可以。

```bash
tunnel set GET /v5/feed -d '{"code": 0, "cards": []}'
tunnel set GET /v5/feed -d @feed.json --status 201
```

**script** —— 每个请求跑一次 `handler(ctx)`：

```js
function handler(ctx) {
  const page = Number(ctx.query.page ?? 1)         // ctx.query 的值都是字符串
  const rec = ctx.recorded()                        // replay 本来会答的那一条
  if (rec === null) return { cards: [], page }
  rec.body.cards = rec.body.cards.slice(0, 2)       // 真实回答，只改一个字段
  return rec                                        // status、headers、body 一起带回去
}
```

```bash
tunnel set GET /v5/feed --script feed.js
```

脚本是 JavaScript；TypeScript 也收，跑之前先擦掉类型。`ctx` 带着 `method`、`path`、
`query`、`headers`（名字小写）、`body`（一个 `Buffer`）、`json`（解析好的 body，
或者 `null`）、`scheme`、`host`、`port`、`url`、`client`，一个跨请求存活的 `state`
对象，以及两个读录制的方法 `ctx.recorded({ query, key, session })` 和
`ctx.recordings({ key, session })` —— 它们读的是传进去的那个 session，没传就读本
规则钉死的那个，再没有就读当前 session；两个都当场作答、不返回 promise，而且只在
它们自己的请求正在答复时能用。返回对象或数组就是 JSON，字符串是文本，`Buffer` 是
字节，返回 `Recorded` 就是那条录制本身，要连状态码和 headers 一起定就返回
`ctx.reply(body, status, headers)`。handler 可以是 async 的，`require('node:…')`
能用到 Node 自带的模块，超过 2^53 的整数在脚本里是 `BigInt`，写回去还是原来那个数。
整个脚本每个请求都会重新执行一遍，所以顶层变量会被重置，要活下来的东西请放进
`ctx.state`；脚本在 worker 线程里跑，超时十秒，过了时限还卡着的脚本会被停掉，抛
异常会变成一个 500，JavaScript 的栈在里面。延迟请用 `--delay` 而不是在脚本里等
—— 等待花的是那十秒超时。

**passthrough** —— 让请求到它本来要去的服务器。`--target` 可以改送到别处：
base URL 只替换 origin、保留路径，带路径的 URL 则替换整个地址（Charles 管这叫
Map Remote）。

```bash
tunnel set GET /v5/feed --target http://localhost:3000
```

**replay** —— 用录制作答，完全不碰网络：

```bash
tunnel set GET api.example.com/v5/feed --replay --session acct_a
tunnel set GET api.example.com/v5/poll --replay --strategy sequence
```

样本按本次请求的 host 和 path 定位，再按策略挑：`match`（默认）取 query 与本次
相同的最新一条，没有就退回这个端点的最新一条；`sequence` 按顺序往下走、走完停在
最后一条，轮询到有变化为止的客户端要的就是它；`last` 永远取最新一条。通配规则
先找实际被调的 host，找不到再退回录在它自己那个模式下的样本。`tunnel reset` 会把
`sequence` 的计数器归零，脚本状态也一样，这样一个用例不会去答下一个用例的调用。

一条规则读哪个 session 的录制，默认就是当前 session，除非它自己点名了一个：
`--session acct_a` 把这个端点钉死在那儿，不管整轮跑动在回放别的什么，
`--session ''` 把它放回当前 session。不给这个开关就不动这个字段，
所以写过一次的规则会跟着下面讲的那个开关走。

回放的回答带着录制的 status、headers 和 body，另加一个 `x-tunnel-replay: <seq>`
说明它来自哪条录制 —— 客户端对看到的 headers 很挑剔的话，把 `replay_marker`
设成 `false`。

### 全局模式与当前 session

```bash
tunnel mode              # 现在是哪个模式
tunnel mode replay       # 没有自己规则的端点用录制作答
tunnel mode passthrough  # …或者去真实服务器（默认）
tunnel session           # 当前是哪个 session，磁盘上还有哪些
tunnel session acct_a    # 切过去；一条命令挪动整轮跑动
tunnel mode replay --session acct_a   # 模式和 session 一次设好
```

当前 session 就是录制写进去、回放读出来的那个，你不去动它就是 `default`。
某次调用该读哪个 session，各处的规矩都一样：先看显式传进来的参数 —— 脚本的
`session` —— 再看规则自己的 `--session`（点了名才算），最后才是当前 session。
所以没有自己规则的端点会跟着开关走，写的时候没给 `--session` 的规则也跟着走，
而钉死过的规则留在原地。

切换会把 `sequence` 的计数器归零 —— 它们走的是另一套录制，对这一套什么也说明
不了 —— 脚本的 `ctx.state` 不动。`tunnel session` 不带名字时打印当前 session
和它有多少条录制，并列出磁盘上其它的 session；切到一个谁也没录过的 session 是
允许的，它会提醒你一句，因为在 `replay` 模式下所有没有规则的端点随即都会 404。
当前是哪个 session，`tunnel status`、`GET /__admin__/health` 和面板侧栏都会报。

`replay` 模式下，既没有规则也没有录制的端点会得到
`404 {"detail": "no rule or recording for <key>", "key": "<key>"}`，带
`x-tunnel-unmatched: 1`，而 `tunnel requests --unmatched` 列的正是这些：
还没录、也还没 mock 的端点。

### 修饰响应

有四个字段对任何模式产生的回答都生效，所以同一个开关在 mock 的、真实的、回放的
响应上都管用：

```bash
tunnel set GET /v5/feed --merge '{"data": {"total": 0}}'
tunnel set GET /v5/feed -H 'Set-Cookie: sid=1' --content-type application/json
tunnel set GET /v5/pay --fault hang --fault-seconds 30   # 也可以是 garbage、close、none
tunnel set GET /v5/feed --delay 1.5 --status 503
tunnel set GET /v5/feed --disable            # 一直 503，直到 --enable
```

- `merge_json` 会深合并进 passthrough 或 replay 带回来的 JSON：对象递归，
  其它一切 —— 包括数组 —— 整体替换。删字段，或者改数组里的某一个元素，是脚本的
  活儿。不是 JSON 的 body 原样透传。
- `headers` 最后覆盖到响应上，在模式之后、合并之后。`-H` 和 `--content-type`
  一起决定这一个字段，所以每条命令都要把这条规则要保留的 header 全写出来。
- `fault` 是够到客户端错误分支的办法。`hang` 把请求挂住 `--fault-seconds`
  （默认一小时，比任何客户端的超时都长）然后答 504；`garbage` 用 JSON 的
  content type 发一段中途断掉的 body；`close` 什么都不写就断连接，请求日志里
  显示状态 0，因为确实没有东西回去。`--fault none` 让端点恢复正常作答。
  客户端一旦不等了，hang 就立刻放手，而不是把连接守满剩下的那一小时；这次调用
  照样进日志，状态 0，所以跑测试的人看得见它来过又被放弃了。
- `response_delay` 把回答按住一会儿，不管是哪个模式产生的。它跑在故障注入之前、
  模式之前。客户端一旦不等了就不再按住，但模式照样跑完：这次调用照样进日志，
  状态是那个模式本来要答的状态，passthrough 也照样录进 session —— 上游说了什么
  值得留下，哪怕没人读到。半关闭 socket 的客户端被当成已经走掉的：模式照样跑完，
  这次调用照样按它本来要答的状态进日志，但回答到不了它那里。

`tunnel set` 只动你传的字段；这个端点其它的一切保持原样。

## 场景文件

一组规则可以放在一个 JSON 文件里，和测试一起提交，整体应用。它的形状和管理 API
接受的、`tunnel export` 写出来的完全一致：

```json
{
  "replace": true,
  "config": {"default_mode": "replay"},
  "mocks": [
    {"key": "GET:api.example.com/v5/feed", "mode": "json", "json_file": "feed_empty.json"},
    {"key": "GET:api.example.com/v5/user/*", "mode": "script", "script_file": "user.js"},
    {"key": "POST:api.example.com/v5/pay", "mode": "json", "json_response": {"code": 500},
     "status_code": 500, "description": "payment refused"}
  ]
}
```

```bash
tunnel apply scenarios/empty_feed.json      # 要么全中要么全不中：一条不合法，整批不生效
tunnel apply scenarios/empty_feed.json --replace
tunnel export -o scenarios/current.json     # 当前这些规则
tunnel pack scenarios/empty_feed.json -o bundle/empty_feed.json
```

`script_file` 和 `json_file` 相对场景文件所在的目录解析，由 CLI 读出来把内容送
进去：服务端不读你的任何文件，不管它是从哪个目录启动的。

`tunnel pack` 也是因此而存在。跑在设备里的测试用例是自己经管理 API 应用场景的，
它够不到你的工作目录：`pack` 把同一个场景写出来，其中 `script_file` 和
`json_file` 换成了它们指向的内容，可以直接进测试 bundle。不给 `-o` 时这两个命令
都打到标准输出。

`tunnel export` 默认不带全局设置，除非给 `--with-config`，它写出的是默认模式和
当前 session：场景是按用例应用的，不该顺手改掉整轮跑动里其它端点怎么作答、
或者从哪套录制里作答。

## 请求日志

tunnel 答过的每一次调用都被完整留下 —— query、headers、body、回去的那个回答、
决定它的那条规则，以及耗时。

```bash
tunnel requests                            # 按端点聚合
tunnel requests --each --last 20           # 日志本身，一次调用一行
tunnel requests --each --unmatched         # 没有东西答过的
tunnel requests --each --host api.example.com -q pay
tunnel requests show 17                    # 某一次调用的全貌
tunnel reset --requests                    # 清空；并打印它停在哪个 seq
```

`--each` 支持 `--key`、`--host`、`--since SEQ`、`--last N`、`--unmatched`、
`--encrypted` 和 `-q 关键字`（匹配 host、路径、query、状态和规则）。没被解密的
隧道显示成一条 `connect` 记录：host、端口和双向字节数，关于它能知道的就这些。

最近的条目留在内存里（`max_requests_history` 条），每一条同时追加到 state 目录的
`requests.jsonl`，所以 `seq` 会接着上一次跑到的地方往下走。打印出来的内容会把
`authorization`、`cookie`、`set-cookie`、`x-api-key`、`proxy-authorization`
的值隐去 —— `redact_headers` 可以改这个列表，`show --raw` 则原样打印。
落盘的文件两种情况下都保留原文，因为录制是要能回放的。

### 等待请求到达

`tunnel wait` 是脚本该阻塞的地方，而不是 sleep 一秒然后碰运气。服务端把连接挂着，
等到够数的匹配调用一到就回答：

```bash
tunnel wait POST api.example.com/v5/pay              # 一次调用，十秒
tunnel wait GET /v5/poll --count 3 --timeout 30      # 三次
tunnel wait POST /v5/pay -q amount=100 --since 41    # 再收窄一点
```

它退出 0 并打印匹配到的 seq，或者在等不到时退出 3 并打印已经看到几条 ——
所以退出码就是断言。`--since SEQ` 只数那个 seq 之后到达的（`tunnel reset
--requests` 会打印该用哪个）；不给它就整本日志都算，包括 wait 之前发生的调用。
每个 `-q name=value` 是这次调用必须带着的一个 query 参数和它的值，query 的其余
部分不限。

## 录一次，在 CI 里回放

录制是全局开关，不是一种响应模式：开着的时候，每一次透传到真实服务器的调用都会
在 data 目录里写成一个独立文件。Mock 出来的回答已经写在产生它的规则里了，
没解密的隧道也没有什么可留的。

```bash
# 1. 在你的机器上，设备驱动着 app
tunnel record start --session acct_a
tunnel record stop
tunnel recordings ls --host api.example.com
tunnel recordings show 17

# 2. 放进客户端仓库
tunnel recordings export -o tests/mocks/recordings --session acct_a

# 3. 在 CI 里，没有设备也没有后端
tunnel serve --background
tunnel recordings import tests/mocks/recordings --replace
tunnel mode replay --session acct_a    # 用 acct_a 的录制作答
tunnel apply tests/mocks/scenarios/empty_feed.json --replace
#    …跑测试用例…
tunnel wait POST api.example.com/v5/pay --timeout 30
tunnel requests --unmatched
tunnel stop
```

一次调用被存成
`recordings/<session>/<host>/<METHOD>/<path>/<seq>.json`，所以这个目录本身就是
索引，同一个端点调两次两个回答都留着。session 把一个测试账号、或者一个批次，
和另一个分开：`record start --session acct_a` 先把当前 session 切过去再开录，
这样随后起的回放读到的就是刚录的这批；不给这个开关，调用就落进已经在用的那个
session。在 CI 里，把整轮跑动从一个批次挪到另一个的是 `tunnel session acct_a`，
或者上面那个 `--session`。散落在 session 目录之外的 `.json` 没有点名任何
session，所以 `import` 把它归进当前 session。`export` 写出来的就是 `import`
读进去的；导出时 header 的值默认隐去，除非给 `--raw`，而服务端自己留的那一份是
原文，因为录制存在就是为了回放。提交前请审一遍：这些是真实后端的真实响应。

### 后台运行

```bash
tunnel serve --background --admin-port 8000 --proxy-port 8890
tunnel status                       # pid、端口、CA、三类目录、当前 session
tunnel stop                         # SIGTERM，等它退出，清掉记录
```

子进程是脱离终端的 —— 新起一个 session，不是 fork —— 它本来要打印的一切都进
state 目录的 `tunnel.log`，所以某个端口没绑上，事后也还读得到。旁边的
`tunnel.pid` 存着它的 pid 和两个端口；不带 `--base` 也没有 `TUNNEL_BASE` 的命令
会从那里读管理口，所以后台起在别的端口上，也不用每条命令都传 `--base`。

## 在测试用例里调用 tunnel

上面这些都是宿主机这一侧的活儿。跑在 app 里的测试用例做同样的事情要走 HTTP，
因为它没法在你的机器上起一个命令。行得通的分工是：

- **整轮级，在宿主机用 CLI**：`serve --background`、`recordings import`、
  `mode replay --session acct_a`、`ssl add`、`ca install`。
- **用例级，在测试里调管理 API**：`POST /__admin__/mocks/apply` 应用本用例的
  场景，`POST /__admin__/state/reset` 在用例之间重置，
  `GET /__admin__/requests/wait` 代替 sleep，
  `GET /__admin__/requests?each=1` 断言客户端调了什么。

测试用例应用的场景必须是自包含的 —— `tunnel pack` 写出来的正是这个 ——
因为服务端既不读设备上的文件，也不读你 checkout 里的文件。

从测试的角度看，管理口在哪里：

| 测试跑在 | 管理 API 地址 |
| --- | --- |
| iOS 模拟器 | `http://127.0.0.1:8000` —— 它和 Mac 共享回环 |
| Android 模拟器 | `http://10.0.2.2:8000` |
| USB 连着的 Android 真机 | `adb reverse tcp:8000 tcp:8000` 之后用 `http://127.0.0.1:8000` |
| iPhone / iPad | 没有反向转发这回事：开跑之前在宿主机上用 CLI 准备好 |

### Swift，用 URLSession

```swift
enum Tunnel {
    static let base = URL(string: "http://127.0.0.1:8000/__admin__")!

    static func post(_ path: String, _ body: [String: Any]) async throws -> [String: Any] {
        var request = URLRequest(url: base.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, _) = try await URLSession.shared.data(for: request)
        return try JSONSerialization.jsonObject(with: data) as! [String: Any]
    }

    /// 应用本用例的场景，覆盖掉上一个用例留下的东西。
    static func apply(_ scenario: [String: Any]) async throws {
        _ = try await post("mocks/apply", scenario)
        _ = try await post("state/reset", [:])
    }

    /// 阻塞到客户端发出这次调用；false 表示它始终没发。
    static func waitFor(_ key: String, timeout: Int = 10) async throws -> Bool {
        var components = URLComponents(url: base.appendingPathComponent("requests/wait"),
                                       resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "key", value: key),
                                 URLQueryItem(name: "timeout", value: String(timeout))]
        let (data, _) = try await URLSession.shared.data(from: components.url!)
        let answer = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        return (answer["timed_out"] as? Bool) == false
    }
}

// 在测试里
try await Tunnel.apply([
    "replace": true,
    "mocks": [["key": "GET:api.example.com/v5/feed",
               "mode": "json",
               "json_response": ["code": 0, "cards": []]]],
])
// …驱动 app…
XCTAssertTrue(try await Tunnel.waitFor("POST:api.example.com/v5/pay", timeout: 30))
```

### Kotlin，用 OkHttp

```kotlin
object Tunnel {
    // 10.0.2.2 是模拟器眼里的宿主机；`adb reverse` 之后用 127.0.0.1。
    private const val BASE = "http://10.0.2.2:8000/__admin__"
    private val client = OkHttpClient()
    private val JSON = "application/json".toMediaType()

    fun apply(scenario: String) {
        post("mocks/apply", scenario)
        post("state/reset", "{}")
    }

    fun waitFor(key: String, timeoutSeconds: Int = 10): Boolean {
        val url = "$BASE/requests/wait".toHttpUrl().newBuilder()
            .addQueryParameter("key", key)
            .addQueryParameter("timeout", timeoutSeconds.toString())
            .build()
        val body = client.newCall(Request.Builder().url(url).build())
            .execute().use { it.body!!.string() }
        return !JSONObject(body).getBoolean("timed_out")
    }

    private fun post(path: String, body: String): String =
        client.newCall(
            Request.Builder().url("$BASE/$path").post(body.toRequestBody(JSON)).build()
        ).execute().use { response ->
            check(response.isSuccessful) { "tunnel said ${response.code}: ${response.body?.string()}" }
            response.body!!.string()
        }
}

// 在测试里
Tunnel.apply(
    """
    {"replace": true,
     "mocks": [{"key": "GET:api.example.com/v5/feed", "mode": "json",
                "json_response": {"code": 0, "cards": []}}]}
    """.trimIndent()
)
// …驱动 app…
assertTrue(Tunnel.waitFor("POST:api.example.com/v5/pay", timeoutSeconds = 30))
```

被测 app 自己不需要为这一切写任何代码：把它的流量送进 tunnel 的是代理设置和 CA。
给测试构建一个信任用户 CA 的 `network_security_config`，并在那里关掉证书固定。

## 在 TypeScript 测试里用 tunnel

上面的测试用例跑在 app 里，连的是别人起好的 tunnel。跑在 Node 里的测试套件 ——
铺数据、在模拟器或真机上驱动 app、再检查它调了什么的那一套 —— 可以直接在自己的
进程里起 tunnel：不用先起服务，不用约定端口，也不用自己写 HTTP 去打管理口。
装命令的那个包里也有这个库，ES module，带类型：

```bash
npm install --save-dev tunnel-use
```

```ts
import assert from 'node:assert/strict'
import { startTunnel } from 'tunnel-use'

// 模拟器和 CI 连 127.0.0.1 就够；网络上的真机要用默认的 0.0.0.0
const tunnel = await startTunnel({ proxyHost: '127.0.0.1' })
try {
  await tunnel.setRule({ key: 'GET:api.example.test/v5/feed', mode: 'json', json_response: { cards: [] } })
  await tunnel.setRule({
    key: 'POST:api.example.test/v5/pay',
    handler: (ctx) => ctx.reply({ paid: ctx.json?.amount ?? 0 }, 201),
  })
  // …经 tunnel.proxyUrl 驱动 app；这里用一个请求代替
  const answer = await tunnel.check('POST', 'http://api.example.test/v5/pay', {
    body: '{"amount": 100}',
    contentType: 'application/json',
  })
  assert.equal(answer.status, 201)
  const wait = await tunnel.waitForRequest({ key: 'POST:api.example.test/v5/pay', timeout: 5 })
  assert.equal(wait.timed_out, false)
  const exchange = await tunnel.getRequest(wait.seqs[0]!)
  assert.deepEqual(exchange.request.body, { amount: 100 })
} finally {
  await tunnel.stop()
}
```

`startTunnel()` 起的就是 `tunnel serve` 起的那些 —— 代理口、管理口、core 和脚本
worker —— 然后返回一个句柄，上面写着它们落在哪里：`proxyPort` 和 `proxyUrl` 给
app 的代理设置，`caFile` 是设备要装的证书，`configDir` 是文件所在的目录，
`adminUrl` 就是面板，调试测试时也可以当 CLI 的 `--base`。

每个方法都是一个管理 API 端点，在本进程里由管理口背后的同一套代码执行，所以默认值、
校验和报错就是 [管理 API v1](#管理-api-v1) 那张表说的。数据沿用 API 的字段名 ——
`status_code`、`json_response`、`default_mode`、`timed_out`、`last_seq` ——
所以场景文件里的一条规则可以原样交给 `setRule()`；只有方法名和方法自己的选项是
camelCase。

| 方法 | 管理 API（在 `/__admin__` 下） | 返回 |
| --- | --- | --- |
| `status()` | `GET /health` 加 `GET /sessions`，合成一个对象 | 这个对象，其中 `mocks` 把函数规则也算上 |
| `getConfig()`、`setConfig(patch)` | `GET`、`PATCH /config` | 设置 |
| `decrypt(hosts, { exclude, remove })` | SSL Proxying 名单，照 `tunnel ssl add`、`ssl rm` 的方式改 | `ssl_proxying` |
| `listRules(key?)` | `GET /mocks`，再接上函数规则 | 规则；给了 key 就是那一条，没有则 404 |
| `setRule(rule)` | `PATCH /mocks`；带 `handler` 时是函数规则 | 规则现在的样子 |
| `deleteRule(key)` | 有这个 key 的函数规则就删它，否则 `DELETE /mocks` | 规范化后的 key |
| `applyScenario(scenario, { replace })` | `POST /mocks/apply`；字符串是场景文件，照 `tunnel apply` 的方式读 | `{ applied, replaced }` |
| `resetState(key?)` | `POST /state/reset` | 清掉的 key |
| `listRequests(filters)` | `GET /requests`：`qBody` 即 `q_body`，`each: true` 是每个请求一行 | `{ requests, last_seq, unmatched_count }` |
| `getRequest(seq)` | `GET /requests/{seq}` | 一条 exchange，header 不遮 |
| `waitForRequest({ key, count, since, timeout, query })` | `GET /requests/wait`，`query` 的每一项是一个 `q=name=value` | `{ seqs, count, wanted, timed_out, last_seq }`；超时不是错误 |
| `clearRequests()` | `POST /requests/clear` | `last_seq`，之后用作 `since` |
| `check(method, url, { body, contentType })` | 经本实例的代理口发一个请求，只信它的 CA，同 `tunnel check` | `{ status, contentType, body }`，body 是 `Buffer` |
| `startRecording(session?)`、`stopRecording()` | `POST /record/start`、`POST /record/stop` | `{ active, session, count }` |
| `listRecordings({ session, key, host })` | `GET /recordings` | 其中的 `recordings` |
| `getRecording(session, seq)` | `GET /recordings/{session}/{seq}` | 一条 exchange |
| `importRecordings(from, { session, replace })` | `POST /recordings/import`：exchange 数组导进 `session`；或者 `tunnel recordings export` 写出的目录，照 `tunnel recordings import` 的方式读，一个 session 一个 session 地导入，中途失败时之前的 session 留着 | `{ imported, sessions, replaced }` |
| `deleteRecordings(session?)` | `DELETE /recordings`，一个 session 的或全部的 | 删了几条 |

`check()` 发请求的方式和设备一样：https 的 URL 只有在它的 host 经过 `decrypt()`
之后才解密，否则直接去真服务器。不许出网的测试只打有规则的 host，或者在
`setConfig({ default_mode: 'replay' })` 下跑：没有规则答的请求回 404。它和
`tunnel check` 一样最多等 10 秒：函数 handler 撞上自己的 10 秒上限时，它以
`timed out` reject，答这个请求的 500 在请求日志里。

### 函数规则

`setRule({ key, handler })` 在脚本规则放源码的地方放一个函数。函数拿到的 `ctx`
和脚本拿到的一样，返回值按同一套规则变成答复 —— 对象是 JSON，
`ctx.reply(body, status, headers)`、`Recorded`、字节也都一样 —— 同样是 10 秒上限，
抛错同样回 500 带栈。它是一条 `script` 模式的规则，其余字段照常起作用
（`status_code`、`headers`、`enabled`、`fault`、`response_delay`，以及决定
`ctx.recorded()` 读哪里的 `replay_session`），由默认值和给出的字段整条建出来：
要改其中一个字段，就带着 handler 再放一次。

和脚本的不同，都来自它跑在测试自己的进程里：

- 只在内存里：从不写进 `config.json`，`stop()` 时随之消失。
- 在测试的主线程上跑，几个调用同时跑：一个 handler 在等测试手里的 Promise 时，
  别的请求照常答。
- `ctx.state` 是每条规则一个的活对象，同时在跑的调用共用，直到 `resetState()`。
  调用超时之后再往里放的东西照样留下。
- `ctx.recorded()` 和 `ctx.recordings()` 返回 Promise。两种 handler 都写成
  async、用 `await ctx.recorded()` 就对了：`await` 对不是 Promise 的值也成立。
- 同步的死循环停不下来：它占着计时器要用的那个线程。可能死循环的 handler 应该
  写成脚本，脚本的 worker 到 10 秒会被停掉。
- 场景里只放存盘的规则。`applyScenario()` 拒绝带 `handler` 的场景：不拦的话
  JSON 会悄悄丢掉函数，留下一条 passthrough 规则。

一个 key 只有一条规则。放函数规则会替换同 key 的存盘规则，把它从 `config.json`
里拿掉；放存盘规则（不带 handler 的 `setRule()`，或者 `applyScenario()`）会替换
同 key 的函数规则，`applyScenario(…, { replace: true })` 清掉全部函数规则。面板、
CLI 和管理 API 看不到函数规则：`GET /__admin__/mocks` 只列存盘的规则，
`GET /__admin__/health` 的 `mocks` 也只数它们（`status().mocks` 两种都数）；在面板
上给函数规则的 key 存一条规则，它会被函数规则挡住，直到 `deleteRule()`；
`tunnel apply --replace` 也不碰函数规则。在请求日志里它们和别的规则一样：`mode`
是 `script`，`matched_by` 是它的 key。

### 起和停

不给选项时，两个端口都由系统挑空闲的，代理口和 `tunnel serve` 一样监听所有网卡，
文件放进新建的 `<os.tmpdir()>/tunnel-XXXXXX`，里面生成新 CA。模拟器和 CI 有
`proxyHost: '127.0.0.1'` 就够 —— iOS 模拟器和 Mac 共享回环，Android 模拟器里的
`10.0.2.2` 就是这个回环 —— macOS 也就不会问要不要允许传入连接；只有网络上的真机
需要默认值。`proxyPort`、`adminPort` 用来固定端口。

模拟器或设备已经信任某个 CA 时，让 tunnel 用那个 CA 签名，它就照常解密：`caDir`
从一个目录（项目的 `.tunnel/`，或者 `~/.config/tunnel/`）把 `ca.pem` 和
`ca-key.pem` 拷进临时目录，原文件不动。`configDir` 则让它跑在你指定的目录里，同
`--config-dir`，用完保留：它写的规则和设置都和 CLI 写的一样落进那里的
`config.json`，包括函数规则替换掉同 key 的存盘规则。给一个只给这次测试用的目录 ——
两个 tunnel 用同一个目录会互相覆盖文件。它不写 `tunnel.pid`，所以 `tunnel stop`
不会去停测试进程。

它起的东西都不会让进程留着不退。忘了 `stop()` 的测试文件照样结束，临时目录在进程
退出时删掉；进程被信号杀掉时，留下的目录由系统的临时文件清理收走。正在答的请求、
正在等的 wait 会把进程留到它们完成。反过来说：一个起了 tunnel 却什么也不等的脚本
会立刻退出，要常驻请用 `tunnel serve`。

`stop()` 关掉两个端口、脚本 worker 和还在跑的函数调用，再删掉临时目录；再调一次
返回的是第一次的那个 Promise。正在等的 `waitForRequest()` 以 503
`The server is shutting down` reject，`stop()` 之后的每个调用以 503
`the tunnel is stopped` reject；句柄上的属性照旧可读。从 Node 24 起，
`await using tunnel = await startTunnel()` 在块结束时停掉它 —— Node 22.18 认得
`Symbol.asyncDispose`，但不认这个语句，所以上面的例子写 `try`/`finally`。同一个
进程里的几个 tunnel 各跑各的，端口、规则、目录各是各的；共用的只有日志的去向。

### 错误、大整数和日志

管理 API 回 400 及以上时 reject 一个 `TunnelError`：`status` 是那个状态码，
`detail` 是答复里的 `detail` 原样 —— 一句话，或者 422 的 issue 列表 —— message
是那句话，或者把每个 issue 写成 `<字段>: <msg>`、用 `; ` 连起来。库自己的拒绝也是
`TunnelError`：不认识的选项名是 400 —— 拼错的选项被拒绝而不是被忽略，和 API 拒绝
不认识的字段一样 —— 收不了的参数也是 400，比如 `caDir` 和 `configDir` 同给、
handler 不是函数、函数规则给了别的 `mode` 或 `script`；停了以后是 503。端口被占
之类起不来的错误是 Node 自己的错误，`code` 是 `EADDRINUSE`。

超过 2^53 的整数，在库交出来的东西里 —— 规则、exchange、录制、`ctx.json` —— 都是
`BigInt`，和脚本里一样；交给它的 `BigInt` 写成原来的数字。`assert.deepEqual` 和
`console.log` 都能直接处理；`JSON.stringify` 遇到它会抛错，对任何 `BigInt` 都是
这样。

日志从 `INFO` 起写到 stderr，每个请求一行，和前台的 `tunnel serve` 一样。
`setLogSink(sink)` 把它们送到别处，对本进程里所有的 tunnel 都生效，并返回原来的
sink，方便之后还原：`setLogSink(() => {})` 让它们静音，`setLogSink((record) => {
if (record.level === 'warning' || record.level === 'error')
console.error(record.message) })` 只留下出了问题的那些。

类型随包发布。对着它们做类型检查需要 `@types/node`（声明里用到 `Buffer`），而
TypeScript 7 只在 tsconfig 写了 `"types": ["node"]` 时才带上它。

## 用 AI 编码助手来驱动

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

### 走 MCP

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

## 命令行速查

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

## 管理 API v1

全在管理口的 `/__admin__` 下面，进出都是 JSON。错误是 `{"detail": "..."}`
配上合适的状态码。`PATCH` 只更新它收到的字段；不认识的字段会被拒绝而不是忽略。

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| `GET` | `/__admin__/health` | | `{"status": "ok", "version": "3.0.0", "config_dir": "…", "state_dir": "…", "data_dir": "…", "mocks": 3, "exchanges": 42, "first_seq": 1, "last_seq": 42, "ca_fingerprint": "8B:6F:…", "proxy": {"host": "0.0.0.0", "port": 8890, "lan_ips": ["192.168.1.23"]}, "session": "default", "recording": {"active": false, "session": "default", "count": 12}, "upstream": "direct"}` |
| `GET` | `/__admin__/config` | | `{"default_mode": "passthrough", "max_requests_history": 1000, "auto_record_requests": true, "ssl_proxying": {"enabled": true, "include": [], "exclude": []}, "allow_clients": [], "redact_headers": ["authorization", …], "recording": {"active": false}, "session": "default", "replay_marker": true}` |
| `PATCH` | `/__admin__/config` | 上面这些字段的任意子集，例如 `{"default_mode": "replay", "session": "acct_a"}` | `{"success": true, "config": {…}}` —— `session` 不是一个目录名就 400 |
| `GET` | `/__admin__/mocks` | `?key=` 只要一条 | `{"mocks": [{"key": "GET:api.example.com/v5/feed", "mode": "json", "json_response": {…}, "status_code": 200, "enabled": true, "description": "", "merge_json": {}, "headers": {}, "target": "", "response_delay": 0, "script": "", "replay_session": "", "replay_strategy": "match", "fault": "none", "fault_seconds": 3600}]}` —— `replay_session` 为空表示跟随当前 session |
| `PATCH` | `/__admin__/mocks` | `{"key": "GET:/v5/feed", "mode": "json", "json_response": {"cards": []}}` —— 上面那些字段的任意子集 | `{"success": true, "mock": {…}}` |
| `DELETE` | `/__admin__/mocks?key=GET:/v5/feed` | | `{"success": true, "deleted": "GET:/v5/feed"}` |
| `POST` | `/__admin__/mocks/apply` | `{"replace": true, "config": {"default_mode": "replay", "session": "acct_a"}, "mocks": [{"key": …}, …]}` | `{"success": true, "applied": ["GET:/v5/feed"], "replaced": true}` —— 一条不合法，整批 400 |
| `GET` | `/__admin__/export` | `?config=true` 连全局设置一起 | `{"config": {"default_mode": "passthrough", "session": "default"}, "mocks": […]}` |
| `POST` | `/__admin__/state/reset` | `{"key": "GET:/v5/poll"}`，或 `{}` 表示全部 | `{"success": true, "cleared": ["GET:/v5/poll"]}` |
| `GET` | `/__admin__/requests` | `?each=1&key=&host=&since=&last=&unmatched=1&encrypted=1&q=&q_body=1` | `{"requests": [row, …], "last_seq": 42, "unmatched_count": 0}` —— 行要么是按 key 的聚合，要么在 `each=1` 时每次调用一条摘要 |
| `GET` | `/__admin__/requests/{seq}` | | 一条完整的 exchange，形状见下 |
| `GET` | `/__admin__/requests/wait` | `?key=&count=1&since=&timeout=10&q=name=value`（可重复） | `{"seqs": [41], "count": 1, "wanted": 1, "timed_out": false, "last_seq": 41}` —— 数够 `count` 就答，或者等到超时 |
| `POST` | `/__admin__/requests/clear` | | `{"success": true, "last_seq": 42}` |
| `GET` | `/__admin__/events` | `?since=` 先补发缓冲里的 | Server-Sent Events，每个 `data:` 行一条 exchange 摘要，另有命名事件 `window` `{"first_seq": …, "last_seq": …}`：连上时、清空时、以及每 15 秒一次 |
| `POST` | `/__admin__/record/start` | `{}` 录进当前 session；`{"session": "acct_a"}` 先切过去 | `{"success": true, "active": true, "session": "acct_a", "count": 0}` |
| `POST` | `/__admin__/record/stop` | | `{"success": true, "active": false, "session": "acct_a", "count": 12}` |
| `GET` | `/__admin__/record` | | `{"active": true, "session": "acct_a", "count": 12}` |
| `GET` | `/__admin__/sessions` | | `{"session": "acct_a", "sessions": {"acct_a": 12, "acct_b": 3}}` —— 当前 session，以及磁盘上每个 session 各有多少条调用 |
| `GET` | `/__admin__/recordings` | `?session=&key=&host=` | `{"recordings": [{"session": "acct_a", "seq": 17, "time": "2026-09-24T10:00:00.123", "key": "GET:api.example.com/v5/feed", "query": {"page": "1"}, "status": 200, "size": 1234}], "count": 1}` |
| `GET` | `/__admin__/recordings/{session}/{seq}` | | 一条完整的 exchange |
| `POST` | `/__admin__/recordings/import` | `{"session": "acct_a", "replace": true, "exchanges": [exchange, …]}` | `{"success": true, "imported": 12, "session": "acct_a", "replaced": true}` |
| `DELETE` | `/__admin__/recordings` | `?session=`，不传表示所有 session | `{"success": true, "deleted": 12, "session": "acct_a"}` |
| `GET` | `/__admin__/ca` | | `{"subject": "CN=tunnel CA …", "fingerprint": "8B:6F:…", "not_before": "…", "not_after": "…", "ca_file": "…/ca.pem", "ca_key_file": "…/ca-key.pem"}` |
| `POST` | `/__admin__/ca/reset` | | `{"success": true, …同样那些字段}` —— 所有设备都得装新证书 |

有两个路径不在 `/__admin__` 下面：`/` 是面板，`/ca.pem` 是 CA 证书，用能让设备
提示安装的 content type 提供。代理口对发给它自己的请求也答这两个路径 ——
`http://ca.tunnel/` 就是已设代理的设备打开的那页安装说明 —— 其余一律 400；
它不带任何管理 API。

一条 exchange 长这样，`GET /__admin__/requests/{seq}` 返回的和录制文件里存的
都是它：

```json
{
  "seq": 17,
  "time": "2026-09-24T10:00:00.123",
  "kind": "http",
  "request": {
    "method": "GET", "scheme": "https", "host": "api.example.com", "port": 443,
    "path": "/v5/feed", "query": {"page": "1"},
    "url": "https://api.example.com/v5/feed?page=1",
    "headers": {"user-agent": "…"}, "body": null, "body_encoding": null
  },
  "response": {
    "status": 200, "headers": {"content-type": "application/json"},
    "body": {"code": 0, "cards": []}, "body_encoding": "json",
    "elapsed_ms": 123, "size": 1234
  },
  "matched_by": "GET:api.example.com/v5/feed", "mode": "passthrough",
  "replay_seq": null, "unmatched": false, "client": "192.168.1.23",
  "truncated": false, "encrypted": false, "bytes_up": 0, "bytes_down": 0
}
```

body 被解析成对象时 `body_encoding` 是 `json`，是字符串时是 `text`，都不是就是
`base64`；超过上限的 body 会被截断，`truncated` 会说明。从未被解密的隧道，
`kind` 是 `connect`：它有 host、端口、client、时间和双向字节数，别的什么都没有。

## 文件放在哪里

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

## 测试与开发

```bash
make help             # 显示这份帮助
make setup            # 安装依赖（npm ci）
make test             # 跑整套测试，直接从源码跑
make check            # 类型检查，有没格式化的文件就失败
make format           # 格式化 TypeScript
make check-install    # 打包，装进一个用完即弃的目录，检查文件清单、体积预算、命令，以及库入口和它的类型
make run              # 直接从源码跑 tunnel serve
make clean            # 删掉构建产物
make panel            # 把面板构建进 assets/panel/（只有改 panel/ 时才用得上）
make panel-check      # 给面板做类型检查，提交进仓库的产物过期了就失败
make panel-smoke      # 用 Chrome 把面板每一页都打开一遍，控制台报任何错就失败（需要 Playwright；不在 make test 里）
```

单跑一个文件：`npm run test:file -- tests/cli.test.ts`。慢的测试 —— 大多是在第二个
进程里真起一个服务的 —— 标题以 `[slow]` 结尾，`npm run test:fast` 会跳过它们。
整套测试都不出网：上游服务在进程内伪造，socket 绑在 `127.0.0.1` 上、端口由操作
系统挑，每个测试都写临时目录。

面板是预先构建的：`make panel` 用 Vite 构建 `panel/`，写出 `assets/panel/panel.js`、
`assets/panel/panel.css` 和它用的那个字体。三个文件都提交进仓库，所以安装时不需要
用 Node 构建什么、也不从网上取任何东西 —— 只有改 `panel/` 本身才需要构建。产物要跟
引起它变化的那次改动一起提交：`make panel-check` 先做类型检查，再在提交的产物与
源码构建出来的不一致时失败 —— 构建是逐字节可复现的，所以这是一道真的过期检查，
不是抛硬币。`make panel-smoke` 是浏览器那一关：它自己起一个临时服务，用本机的
Chrome 打开五个页面和两个详情，浏览器有任何抱怨就失败。这一关需要 Playwright，
所以不进 `make test` —— 它是发布前手动跑的关卡。其余细节在 `panel/README.md`。

```
src/                              # 平铺，一层一行：命令在最前，底层在最后
├── cli.ts                        # `tunnel` 命令
├── mcp.ts                        # `tunnel mcp`：同一套操作，做成 MCP 工具
├── index.ts                      # startTunnel()：同一套操作，在测试自己的进程里
├── cli-*.ts                      # cli.ts 跑的那些：参数、公共部分、规则、流量、CA、服务
├── proxy.ts proxy-url.ts admin.ts app.ts   # 代理口；管理 API 和面板
├── core.ts                       # resolve(request) -> response
├── script*.ts upstream*.ts       # 在 worker 线程里跑的 handler(ctx)，或者调用方进程里的
│                                 # 函数；去真实服务器的路
├── recordings.ts                 # 录制目录，以及样本怎么挑
├── exchanges.ts certs.ts         # 请求日志；CA 和它签的证书
├── config.ts rule-keys.ts messages.ts   # 设置；规则的 key；请求和响应
├── models.ts                     # 规则和 config，连同它们的默认值
└── json.ts validate.ts glob.ts number-format.ts certs-der.ts errors.ts log.ts package-info.ts
                                  # 底层：留得住超过 2^53 的整数的 JSON、校验、
                                  # glob 匹配、%g、DER、错误、日志和版本号

assets/                           # 原样放进包里发出去
├── AGENTS.md                     # `tunnel agents` 打印的那份给 agent 看的文档
└── panel/                        # 构建好的面板：panel.js、panel.css 和它的字体

tests/
├── *.test.ts                     # 整套测试：一个模块一个文件，或者一种行为一个文件
├── contract/                     # 黑盒：把 `tunnel` 命令当成子进程来测
├── support/                      # 共用的辅助：临时目录、假的服务器
└── fixtures/                     # 契约测试比对用的定稿数据

panel/                            # 面板的源码：React、Catalyst 和 Vite
└── src/                          # `make panel` 构建的就是它；见 panel/README.md
```

### 发版

npm 不会收同一个版本两次，所以每次发版都有自己的版本号，而它只写在 `package.json`
这一个地方：`tunnel --version`、横幅、`GET /__admin__/health` 和面板的页脚都从那里
读。

1. `npm version <x.y.z> --no-git-tag-version` 把它同时写进 `package.json` 和
   `package-lock.json`。
2. `make check-install` 打包，检查 tarball 里不多不少正是该有的那些文件，装上它，
   跑一下命令和库入口，再对着库的类型检查一个小消费者。
3. 提交，给这个提交打 tag `v<x.y.z>`：轻量 tag，三段都写全。
4. 在这个提交上、干净的工作树里 `npm publish`。它的 `prepack` 会先重新构建 `dist/`。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
