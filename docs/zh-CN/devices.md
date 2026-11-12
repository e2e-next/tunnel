# 让设备走它

📖 [English](../devices.md)

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

## CA 证书

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

## 哪些 host 会被解密

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

## 上游代理

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
