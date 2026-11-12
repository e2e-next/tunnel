# Point a device at it

📖 [中文](zh-CN/devices.md)

`tunnel serve` prints this machine's LAN addresses; `PORT` below is the proxy
port, 8890 unless you moved it.

| Client | How it gets there |
| --- | --- |
| iPhone or iPad | Settings > Wi-Fi > the network > Configure Proxy > Manual, with this machine's LAN address and `PORT` |
| Android phone | Wi-Fi > the network > Advanced > Proxy > Manual, same address and port |
| iOS simulator | it follows the Mac's own proxy settings: System Settings > Network > the interface > Details > Proxies > Web Proxy and Secure Web Proxy, `127.0.0.1:PORT`. Remember to switch it off afterwards — it is the whole machine's setting. tunnel sees that this proxy is itself, so what it sends on goes out directly rather than back through itself, and the banner says `upstream: direct (system proxy points at tunnel itself, ignored)` |
| Android emulator | `adb shell settings put global http_proxy 10.0.2.2:PORT`, and `adb shell settings put global http_proxy :0` to clear it. `10.0.2.2` is the host as the emulator sees it |

A device on the same Wi-Fi is accepted from the private ranges (10/8,
172.16/12, 192.168/16, fc00::/7) and from this machine; `allow_clients` in the
config narrows that to a list of addresses or CIDR ranges. Anything else is
closed and logged, and a request that arrives from the network addressed to
this machine's own loopback is refused with 403 — the admin port lives there,
and the proxy port next to it is not a way around that.

To reach the **admin port** from a device, forward it rather than exposing it:
`adb reverse tcp:8000 tcp:8000` on Android, `10.0.2.2:8000` from an emulator,
and `127.0.0.1:8000` from an iOS simulator, which shares the Mac's loopback.

## The CA certificate

tunnel signs the TLS certificates it serves with a certificate authority of its
own, kept as `ca.pem` and `ca-key.pem` in the config directory. It is generated
on first use and stays put: a device that trusts it once keeps trusting it, and
wiping the state directory cannot take it away.

```bash
tunnel ca info                          # fingerprint, expiry and file paths
tunnel ca export -o tunnel-ca.pem       # the certificate to install on a device
tunnel ca install --ios-simulator       # xcrun simctl keychain booted add-root-cert
tunnel ca install --android             # adb push, then install it from Settings
tunnel ca install --macos               # security add-trusted-cert, asks for a password
tunnel ca reset                         # start over; every device has to install it again
```

A device that is already proxied through tunnel can open <http://ca.tunnel/>
for an install page with the steps for each platform; one that is not can fetch
`http://<this machine>:8890/ca.pem` directly, and <http://127.0.0.1:8000/ca.pem>
serves the same file. The `ca` commands read the certificate from the running
server when there is one and from the config directory when there is not, so
setting a device up does not depend on the order you do things in.

Installing is not trusting. These caveats are the same ones Charles has:

- **iOS**: after the profile is installed, switch the certificate on under
  Settings > General > About > Certificate Trust Settings. A simulator needs no
  such switch — `tunnel ca install --ios-simulator` is enough.
- **Android 7 and later**: apps do not trust user-installed CAs by default. The
  test build has to opt in with `<certificates src="user"/>` (or a
  `<debug-overrides>` block) in its `network_security_config`.
- **Any platform**: an app that pins its server's certificate rejects tunnel's
  certificate however the CA was installed, so pinning has to be off in the
  build you test against.

## Which hosts get decrypted

Installing the CA is still not enough on its own: tunnel decrypts a host only
when you list it, the way Charles has SSL Proxying Locations. Nothing is listed
to begin with, so every HTTPS connection is tunnelled through byte for byte
until you say otherwise — third-party SDKs that pin their certificates keep
working, and the log stays readable.

```bash
tunnel ssl ls                                   # both lists, and whether it is on
tunnel ssl add api.example.com '*.example.com:443'
tunnel ssl rm api.example.com
tunnel ssl exclude add cdn.example.com          # never decrypt this one
tunnel ssl on / tunnel ssl off                  # the switch over both lists
```

An entry is `host[:port]`; `*` is a wildcard in the host and leaving the port
off means any port. An excluded host wins over an included one. A change takes
effect on the next connection; tunnels that are already open are left alone.
A host that was not decrypted still appears in the log as a `connect` row with
the bytes it carried each way, and the panel offers to add it to the list.

## Upstream proxy

What tunnel does not answer itself — a passthrough, and an HTTPS connection to
a host it does not decrypt — leaves this machine the way the Mac's own traffic
does:

1. The environment first: `https_proxy`, `http_proxy`, `all_proxy` and
   `no_proxy`, each read lower-case first and upper-case only when the
   lower-case one is not set. Once one of the first three is set, the
   environment is all that counts: an `https://` call and an undecrypted tunnel
   go through `https_proxy`, an `http://` call through `http_proxy`, and either
   falls back to `all_proxy`.
2. Otherwise, on macOS, the system proxy: Web Proxy for `http://`, Secure Web
   Proxy for `https://` and for tunnels, with its bypass list and "Exclude
   simple hostnames" honoured. It is read again when it is five seconds old, so
   a proxy app switched on or off is followed within five seconds, without a
   restart.
3. Otherwise straight to the server.

Loopback, the private ranges, link-local addresses and `*.local` names always
go direct, and so does everything when the proxy is tunnel itself — the iOS
simulator setting above — so tunnel never hands its own traffic back to
itself. `no_proxy` applies whichever way the proxy came, and `NO_PROXY=*`
sends everything direct.

The route is one line, printed as `upstream:` by the banner and
`tunnel status` and reported as `upstream` by `GET /__admin__/health`, and the
log (`tunnel.log`, in the background) has an `Upstream route: …` line when it
is first read and each time it changes:

```
upstream: direct
upstream: via 127.0.0.1:3128 (system proxy)
upstream: via http://proxy:3128 (HTTPS_PROXY)
upstream: via http://proxy:3128 (http_proxy) for http; direct for https
upstream: direct (system proxy points at tunnel itself, ignored)
upstream: direct (ALL_PROXY=socks5://127.0.0.1:7890 ignored: only http:// proxies are supported)
```

A call that fails at the proxy is a 502 that names it, as in
`Could not reach https://api.example.com through the proxy 127.0.0.1:3128 (system proxy): …`;
a tunnel that fails there gets a bare 502, and the log line names the proxy.

Only `http://` proxies are spoken: a `socks5://` or an `https://` one is
ignored and that traffic goes direct, as the `upstream:` line then says, and
neither a PAC file, a system SOCKS proxy nor a system proxy that wants a
password from the keychain is supported. To use another proxy, set the
variables when you start tunnel. The CLI's own calls to the admin port go
direct; with Node's `NODE_USE_ENV_PROXY=1` in your shell, add `127.0.0.1` to
`NO_PROXY` to keep them that way.
