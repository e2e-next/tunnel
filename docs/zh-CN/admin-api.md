# 管理 API v1

📖 [English](../admin-api.md)

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
