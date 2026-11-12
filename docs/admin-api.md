# Admin API v1

📖 [中文](zh-CN/admin-api.md)

Everything under `/__admin__` on the admin port, JSON in and JSON out. Errors
are `{"detail": "..."}` with the status that fits. `PATCH` updates only the
fields it is given; an unknown field is rejected rather than ignored.

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| `GET` | `/__admin__/health` | | `{"status": "ok", "version": "3.0.0", "config_dir": "…", "state_dir": "…", "data_dir": "…", "mocks": 3, "exchanges": 42, "first_seq": 1, "last_seq": 42, "ca_fingerprint": "8B:6F:…", "proxy": {"host": "0.0.0.0", "port": 8890, "lan_ips": ["192.168.1.23"]}, "session": "default", "recording": {"active": false, "session": "default", "count": 12}, "upstream": "direct"}` |
| `GET` | `/__admin__/config` | | `{"default_mode": "passthrough", "max_requests_history": 1000, "auto_record_requests": true, "ssl_proxying": {"enabled": true, "include": [], "exclude": []}, "allow_clients": [], "redact_headers": ["authorization", …], "recording": {"active": false}, "session": "default", "replay_marker": true}` |
| `PATCH` | `/__admin__/config` | any of those fields, e.g. `{"default_mode": "replay", "session": "acct_a"}` | `{"success": true, "config": {…}}` — a `session` that is not a directory name is refused with 400 |
| `GET` | `/__admin__/mocks` | `?key=` for one | `{"mocks": [{"key": "GET:api.example.com/v5/feed", "mode": "json", "json_response": {…}, "status_code": 200, "enabled": true, "description": "", "merge_json": {}, "headers": {}, "target": "", "response_delay": 0, "script": "", "replay_session": "", "replay_strategy": "match", "fault": "none", "fault_seconds": 3600}]}` — an empty `replay_session` follows the current session |
| `PATCH` | `/__admin__/mocks` | `{"key": "GET:/v5/feed", "mode": "json", "json_response": {"cards": []}}` — any subset of the fields above | `{"success": true, "mock": {…}}` |
| `DELETE` | `/__admin__/mocks?key=GET:/v5/feed` | | `{"success": true, "deleted": "GET:/v5/feed"}` |
| `POST` | `/__admin__/mocks/apply` | `{"replace": true, "config": {"default_mode": "replay", "session": "acct_a"}, "mocks": [{"key": …}, …]}` | `{"success": true, "applied": ["GET:/v5/feed"], "replaced": true}` — one invalid entry rejects the lot with 400 |
| `GET` | `/__admin__/export` | `?config=true` for the global settings too | `{"config": {"default_mode": "passthrough", "session": "default"}, "mocks": […]}` |
| `POST` | `/__admin__/state/reset` | `{"key": "GET:/v5/poll"}` or `{}` for all | `{"success": true, "cleared": ["GET:/v5/poll"]}` |
| `GET` | `/__admin__/requests` | `?each=1&key=&host=&since=&last=&unmatched=1&encrypted=1&q=&q_body=1` | `{"requests": [row, …], "last_seq": 42, "unmatched_count": 0}` — rows are the aggregate by key, or one summary per call with `each=1` |
| `GET` | `/__admin__/requests/{seq}` | | one exchange in full, the shape below |
| `GET` | `/__admin__/requests/wait` | `?key=&count=1&since=&timeout=10&q=name=value` (repeatable) | `{"seqs": [41], "count": 1, "wanted": 1, "timed_out": false, "last_seq": 41}` — answers as soon as `count` is reached, or when the timeout is up |
| `POST` | `/__admin__/requests/clear` | | `{"success": true, "last_seq": 42}` |
| `GET` | `/__admin__/events` | `?since=` to get what is buffered first | Server-Sent Events, one exchange summary per `data:` line, plus a named `window` event `{"first_seq": …, "last_seq": …}` on connect, on a clear and every 15s |
| `POST` | `/__admin__/record/start` | `{}` records into the current session; `{"session": "acct_a"}` switches it first | `{"success": true, "active": true, "session": "acct_a", "count": 0}` |
| `POST` | `/__admin__/record/stop` | | `{"success": true, "active": false, "session": "acct_a", "count": 12}` |
| `GET` | `/__admin__/record` | | `{"active": true, "session": "acct_a", "count": 12}` |
| `GET` | `/__admin__/sessions` | | `{"session": "acct_a", "sessions": {"acct_a": 12, "acct_b": 3}}` — the session in hand, and how many calls every session on disk holds |
| `GET` | `/__admin__/recordings` | `?session=&key=&host=` | `{"recordings": [{"session": "acct_a", "seq": 17, "time": "2026-09-24T10:00:00.123", "key": "GET:api.example.com/v5/feed", "query": {"page": "1"}, "status": 200, "size": 1234}], "count": 1}` |
| `GET` | `/__admin__/recordings/{session}/{seq}` | | one exchange in full |
| `POST` | `/__admin__/recordings/import` | `{"session": "acct_a", "replace": true, "exchanges": [exchange, …]}` | `{"success": true, "imported": 12, "session": "acct_a", "replaced": true}` |
| `DELETE` | `/__admin__/recordings` | `?session=` or nothing for every session | `{"success": true, "deleted": 12, "session": "acct_a"}` |
| `GET` | `/__admin__/ca` | | `{"subject": "CN=tunnel CA …", "fingerprint": "8B:6F:…", "not_before": "…", "not_after": "…", "ca_file": "…/ca.pem", "ca_key_file": "…/ca-key.pem"}` |
| `POST` | `/__admin__/ca/reset` | | `{"success": true, …the same fields}` — every device has to install the new certificate |

Two paths sit outside `/__admin__`: `/` is the panel and `/ca.pem` is the CA
certificate, served with the content type that makes a device offer to install
it. The proxy port answers those same two paths for requests addressed to the
port itself — `http://ca.tunnel/` is the install page a proxied device opens —
and 400 for anything else; it carries no management API.

One exchange, as `GET /__admin__/requests/{seq}` returns it and as a recording
file holds it:

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

`body_encoding` is `json` when the body was parsed into an object, `text` when
it is a string and `base64` when it is neither; a body over the limit is cut
and `truncated` says so. `kind` is `connect` for a tunnel that was never
decrypted: it has a host, a port, a client, a time and the bytes each way, and
nothing else.
