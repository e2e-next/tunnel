# Testing and development

📖 [中文](zh-CN/development.md)

From a checkout, `npm ci` and then `make run` starts tunnel straight from the sources, or
`npm run build && npm link` puts the checkout's `tunnel` on your PATH — build again after
changing `src/`.

```bash
make help             # show this help message
make setup            # install the dependencies (npm ci)
make test             # run the test suite, straight from the sources
make check            # type-check, and fail on unformatted files
make format           # format the TypeScript
make check-install    # pack, install into a throwaway directory, check the file list, the size budget, the command and the library entry with its types
make run              # run tunnel serve from the sources
make clean            # remove the build output
make panel            # build the panel into assets/panel/ (only when you change panel/)
make panel-check      # type-check the panel and fail when the committed build is stale
make panel-smoke      # open every panel page in Chrome, fail on any console error (needs Playwright; not in make test)
```

One file at a time: `npm run test:file -- tests/cli.test.ts`. The slow tests,
most of them ones that start a real server in a second process, end their
titles in `[slow]`, and `npm run test:fast` skips them. Nothing in the suite
reaches the network: upstream servers are faked in process, sockets are bound
on `127.0.0.1` with a port the operating system picks, and every test writes
to a temporary directory.

The panel is built ahead of time: `make panel` runs Vite over `panel/` and
writes `assets/panel/panel.js`, `assets/panel/panel.css` and the font it uses.
All three are committed, so an install needs no Node build and fetches nothing
— only a change to `panel/` itself needs building. Commit the build with the
change that caused it: `make panel-check` type-checks the sources and fails
when what is committed is not what they build, which is a staleness gate rather
than a coin toss because the build is byte-reproducible. `make panel-smoke` is
the pass a browser makes over it, on a throwaway server of its own: it opens
the five pages and two details in this machine's Chrome and fails on anything
logged. That one needs Playwright, so it is not part of `make test` — a
pre-release gate, run by hand. `panel/README.md` is the rest of it.

```
src/                              # flat, one layer a line: the command first, the base last
├── cli.ts                        # the `tunnel` command
├── mcp.ts                        # `tunnel mcp`: the same operations as MCP tools
├── index.ts                      # startTunnel(): the same operations, in a test's own process
├── cli-*.ts                      # what cli.ts runs: args, common, rules, traffic, ca, server
├── proxy.ts proxy-url.ts admin.ts app.ts   # the proxy port; the admin API and the panel
├── core.ts                       # resolve(request) -> response
├── script*.ts upstream*.ts       # handler(ctx) in a worker thread, or a function in the
│                                 # caller's; the way to the real server
├── recordings.ts                 # the recordings directory, and how a sample is chosen
├── exchanges.ts certs.ts         # the request log; the CA and the certificates it signs
├── config.ts rule-keys.ts messages.ts   # settings; rule keys; the request and the response
├── models.ts                     # the rules and the config, with their defaults
└── json.ts validate.ts glob.ts number-format.ts certs-der.ts errors.ts log.ts package-info.ts
                                  # the base: JSON that keeps integers past 2^53, checks,
                                  # glob patterns, %g, DER, errors, logging and the version

assets/                           # shipped in the package as they are
├── AGENTS.md                     # the guide `tunnel agents` prints
└── panel/                        # the built panel: panel.js, panel.css and its font

tests/
├── *.test.ts                     # the suite: one file per module, or per behaviour
├── contract/                     # black-box: the `tunnel` command as a child process
├── support/                      # shared helpers: temporary directories, fake servers
└── fixtures/                     # golden data the contract tests compare against

panel/                            # the panel's source: React, Catalyst and Vite
└── src/                          # what `make panel` builds; see panel/README.md
```

## Releasing

npm never takes the same version twice, so every release has a version of its
own, and `package.json` is the one place it is written: `tunnel --version`, the
banner, `GET /__admin__/health` and the panel's footer all read it from there.

1. `npm version <x.y.z> --no-git-tag-version` sets it in `package.json` and
   `package-lock.json` alike.
2. `make check-install` packs the package, checks that the tarball holds
   exactly the files it should, installs it, runs the command and the library
   entry, and type-checks a small consumer against the library's types.
3. Commit, and tag that commit `v<x.y.z>`: a lightweight tag, all three parts.
4. `npm publish` from that commit, in a clean working tree. Its `prepack`
   builds `dist/` again first.
