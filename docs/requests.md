# The request log

📖 [中文](zh-CN/requests.md)

Every call tunnel answers is kept whole — query, headers, body, the answer that
went back, the rule that decided it and how long it took.

```bash
tunnel requests                            # aggregated by endpoint
tunnel requests --each --last 20           # the log itself, one row per call
tunnel requests --each --unmatched         # what nothing answered
tunnel requests --each --host api.example.com -q pay
tunnel requests show 17                    # one call in full
tunnel reset --requests                    # clear it; prints the seq it stopped at
```

`--each` takes `--key`, `--host`, `--since SEQ`, `--last N`, `--unmatched`,
`--encrypted` and `-q KEYWORD` (host, path, query, status and rule). A tunnel
whose host is not decrypted appears as a `connect` row: the host, the port and
the bytes each way, which is all there is to know about it.

The recent entries stay in memory (`max_requests_history` of them) and every
one is appended to `requests.jsonl` in the state directory, so `seq` carries on
where the last run left off. Printed output hides the values of
`authorization`, `cookie`, `set-cookie`, `x-api-key` and `proxy-authorization`
— `redact_headers` changes that list, and `show --raw` prints them as they
arrived. The files keep them either way, because a recording has to replay.

## Waiting for a request

`tunnel wait` is what a script blocks on instead of sleeping for a second and
hoping. The server holds the connection open and answers the moment enough
matching calls have arrived:

```bash
tunnel wait POST api.example.com/v5/pay              # one call, ten seconds
tunnel wait GET /v5/poll --count 3 --timeout 30      # three of them
tunnel wait POST /v5/pay -q amount=100 --since 41    # narrowed down
```

It exits 0 and prints the seqs that matched, or 3 with the number seen so far
when the wait runs out — so the exit code is the assertion. `--since SEQ` counts
only what arrived after that seq (`tunnel reset --requests` prints the one to
use); without it the whole log counts, calls made before the wait included.
Each `-q name=value` is a query parameter the call has to carry with that
value; the rest of its query is free.
