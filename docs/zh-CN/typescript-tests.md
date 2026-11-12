# 在 TypeScript 测试里用 tunnel

📖 [English](../typescript-tests.md)

[在测试用例里调用 tunnel](in-app-tests.md) 里的测试用例跑在 app 里，连的是别人起好的 tunnel。跑在 Node 里的测试套件 ——
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
校验和报错就是 [管理 API v1](admin-api.md) 那张表说的。数据沿用 API 的字段名 ——
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

## 函数规则

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

## 起和停

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

## 错误、大整数和日志

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
