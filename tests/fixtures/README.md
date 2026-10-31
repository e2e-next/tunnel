# tests/fixtures

Golden files: data the tests compare tunnel's behaviour with.

| Data | What it holds | Read by |
| --- | --- | --- |
| `certs/` | A CA (`ca.pem`, `ca-key.pem`); the leaf certificates it signed for a DNS name, an IPv4 and an IPv6 address and a name of 102 characters (`leaf-*.pem`); `ca.info()` without its two paths (`info.json`); and the subjectAltName encoded for each of a list of hosts, or the error that refuses it (`san.json`) | `tests/certs.test.ts`, `tests/certs-der.test.ts`; `tests/cli-common.test.ts` reads `ca.pem` |
| `cli-help/` | The 44 `--help` pages, and `probes.jsonl`, what the CLI's parser makes of each of 92 command lines ([its README](cli-help/README.md)) | `tests/cli-args.test.ts`; `tests/contract/cli.test.ts` reads `probes.jsonl` |
| `config/` | `config.json` as tunnel writes it into an empty directory (`defaults.json`) and with every setting and kind of rule changed (`full.json`); a file in an older format, with what tunnel reads and logs from it (`old-format.json`, `old-format.loaded.json`, `old-format.log.json`); what validation makes of an input, the value it becomes or its errors, type by type (`lax.json`, which also lists the members of each enum) and model by model (`models.json`); and the validation error bodies the admin API answers three bad requests with (`validation-422.json`) | `tests/config.test.ts`, `tests/models.test.ts`, `tests/validate.test.ts` |
| `glob-cases.json` | Cases of `[pattern, value, answer]`, the answer being whether the glob pattern matches the value, case-sensitively | `tests/glob.test.ts` |
| `mcp-answers.json` | What `tunnel mcp` answers to `initialize`, `tools/list` and `server/discover`, less the server's version in the two places it appears | `tests/contract/mcp.test.ts` |
| `proxy/` | `url-cases.json`: how the proxy port takes a request apart, case by case: request targets (`targets`), a host and port (`authorities`) and queries (`queries`), each with the parts it splits into; an authority with `raises` is one that has to be refused | `tests/proxy-url.test.ts` |
| `recordings/` | `tree/`, a recordings directory of nine files, which `formatRecording` writes back byte for byte but for floats and integer-like keys; `loaded.json`, what a `RecordingStore` reads back out of `tree/`; `layout.json`, how the directories and files of a recording are named and a session name is cleaned | `tests/recordings.test.ts` |
| `requests/` | `requests.jsonl`, a request log of five exchanges, then a line that lacks most fields, a blank line and a line written halfway; `loaded.json`, the exchanges, summaries and aggregate an `ExchangeLog` reads back out of it; `bodies.json`, how a body is kept, given back and shown; `urlencode.json`, how a query is spelled in a URL | `tests/exchanges.test.ts`; `tests/messages.test.ts` reads `urlencode.json` |
| `rule-keys.json` | What each of a list of rule keys reads as: the canonical spelling and the four fields, or the words of the error that refuses it | `tests/key-matching.test.ts` |

## Changing them

Nothing in this repository generates these files. One is changed by hand, and
only together with the behaviour it pins, in the same change: a change to the
CLI's help changes the page in `cli-help/` it touches, and a change to an MCP
schema starts in `mcp-answers.json`.
