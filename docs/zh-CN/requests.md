# 请求日志

📖 [English](../requests.md)

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

## 等待请求到达

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
