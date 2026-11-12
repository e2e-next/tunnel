# 规则

📖 [English](../rules.md)

## key

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

## 模式

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

## 全局模式与当前 session

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

## 修饰响应

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
