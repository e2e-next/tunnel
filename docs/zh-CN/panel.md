# 面板

📖 [English](../panel.md)

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
