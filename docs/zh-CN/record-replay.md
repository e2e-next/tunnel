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

## 几台设备同时测

服务的规则、脚本状态、请求日志和故障都只属于它自己，所以并排测的几台设备各配一个
服务，端口和 config 目录各用各的。要共用的是 CA 和录制，在服务启动前准备好：

```bash
for n in 1 2 3; do
  dir=.tunnel/device-$n
  mkdir -p $dir
  cp .tunnel/ca.pem .tunnel/ca-key.pem $dir/    # 设备信任的那个 CA
  tunnel serve --background --config-dir $dir --data-dir .tunnel \
    --admin-port 800$n --proxy-port 889$n
  TUNNEL_BASE=http://127.0.0.1:800$n tunnel mode replay --session acct_a
done
TUNNEL_BASE=http://127.0.0.1:8001 tunnel recordings import tests/mocks/recordings --replace
#    …第 n 台设备的代理设成 889n，它的测试用例调 800n…
for n in 1 2 3; do TUNNEL_CONFIG_DIR=.tunnel/device-$n tunnel stop; done
```

- **CA。** config 目录在第一次有服务在里面启动时会生成自己的 CA，所以设备信任的
  那一对要在那之前放进去：`tunnel ca info` 会列出正在用的那一对文件，CI 里就是构建
  镜像时装进去的那一对。每个服务启动时都会打印它签名用的指纹。
- **录制。** `--data-dir` 让所有服务的录制放在一处，上面是 `.tunnel/recordings/`，
  所以通过其中一个导入，大家回放的就都是它。服务读过一个 session 就留着，别的服务
  在那里录制、导入或删除时它会发现。要避免的是两个服务同时往同一个 session 录：
  文件按各自的请求序号命名，一个会覆盖另一个的。
- **地址。** 命令用 `--base` 或 `TUNNEL_BASE` 找到某个服务；用 `--background` 起
  的，还可以用 `TUNNEL_CONFIG_DIR` 找到，它指向那个服务的 `tunnel.pid`。`tunnel mcp`
  读的是同样的变量，所以 agent 的 MCP 服务靠环境变量对准某一个服务。脚本不需要地
  址：`ctx.requests()` 读的就是它所在服务的日志。
