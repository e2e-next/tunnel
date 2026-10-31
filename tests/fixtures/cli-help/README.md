# tests/fixtures/cli-help

What the tunnel command prints for `--help` and makes of a command line, byte
for byte, for the CLI to be held to.

## The files

- **44 `--help` pages**, one per level of the command table:
  `<subcommand path joined with ->.txt`, `tunnel.txt` for the top level
  (`ssl-exclude-add.txt` is `tunnel ssl exclude add --help`).
  `tests/cli-args.test.ts` compares the page the CLI prints with each, byte for
  byte, and checks that there is a page for every level and none other.
- **`probes.jsonl`**, one JSON line per command line: its `argv`, then what the
  parser makes of it. One that parses has `args` (every key of the parsed
  arguments) and `handler` (the function it lands on, such as
  `cmdRequestsShow`; no test reads it); one that ends in parsing has `exit`,
  `stdout` and `stderr`. The version number in `stdout` is
  written `tunnel {VERSION}`, which the test replaces with the package's
  version, and a float that is not finite is the string `inf`, `-inf` or
  `nan`, JSON having no such number. `tests/cli-args.test.ts` checks every
  line, and the black-box test of usage errors in `tests/contract/cli.test.ts`
  reads its expected stderr from here as well.

The pages are laid out for 80 columns, and the `--base` line shows its
fallback, `http://127.0.0.1:8000`: the tests run the CLI with no `COLUMNS`, no
`TUNNEL_BASE` and an empty config directory.

## Changing the help

Nothing generates these files. A change to the CLI that changes a help page,
or what a command line parses to, changes that page or that line of
`probes.jsonl` by hand, in the same change, for the review to read in the
diff. The tests above hold the CLI to these files byte for byte, so they fail
until the two agree.
