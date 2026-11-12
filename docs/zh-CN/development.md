# 测试与开发

📖 [English](../development.md)

从源码 checkout 的话，先 `npm ci`，然后 `make run` 直接从源码跑起来；或者
`npm run build && npm link`，把 checkout 里的 `tunnel` 放上 PATH —— 改了 `src/` 之后要重新 build。

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

## 发版

npm 不会收同一个版本两次，所以每次发版都有自己的版本号，而它只写在 `package.json`
这一个地方：`tunnel --version`、横幅、`GET /__admin__/health` 和面板的页脚都从那里
读。

1. `npm version <x.y.z> --no-git-tag-version` 把它同时写进 `package.json` 和
   `package-lock.json`。
2. `make check-install` 打包，检查 tarball 里不多不少正是该有的那些文件，装上它，
   跑一下命令和库入口，再对着库的类型检查一个小消费者。
3. 提交，给这个提交打 tag `v<x.y.z>`：轻量 tag，三段都写全。
4. 在这个提交上、干净的工作树里 `npm publish`。它的 `prepack` 会先重新构建 `dist/`。
