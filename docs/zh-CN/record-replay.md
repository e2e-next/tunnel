# 录一次，在 CI 里回放

📖 [English](../record-replay.md)

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

## 后台运行

```bash
tunnel serve --background --admin-port 8000 --proxy-port 8890
tunnel status                       # pid、端口、CA、三类目录、当前 session
tunnel stop                         # SIGTERM，等它退出，清掉记录
```

子进程是脱离终端的 —— 新起一个 session，不是 fork —— 它本来要打印的一切都进
state 目录的 `tunnel.log`，所以某个端口没绑上，事后也还读得到。旁边的
`tunnel.pid` 存着它的 pid 和两个端口；不带 `--base` 也没有 `TUNNEL_BASE` 的命令
会从那里读管理口，所以后台起在别的端口上，也不用每条命令都传 `--base`。
