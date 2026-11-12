// The parser in src/cli-args.ts and the command table in src/cli.ts, held to the golden help pages
// and parses in tests/fixtures/cli-help/ (its README says what they hold).
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { test } from 'node:test'
import { helpWidth } from '../src/cli-args.ts'
import { buildParser, main } from '../src/cli.ts'
import { PACKAGE_ROOT, VERSION } from '../src/package-info.ts'
import { captureIo } from './support/cli.ts'
import { tmpDir } from './support/tmp.ts'

const FIXTURES = join(PACKAGE_ROOT, 'tests', 'fixtures', 'cli-help')
const pages = readdirSync(FIXTURES)
  .filter((name) => name.endsWith('.txt'))
  .sort()

/** The command a page is the help of: tunnel.txt is the top level, ssl-exclude-add.txt is
 *  tunnel ssl exclude add */
function pathOf(page: string): string[] {
  const name = page.slice(0, -'.txt'.length)
  return name === 'tunnel' ? [] : name.split('-')
}

for (const page of pages) {
  const path = pathOf(page)
  test(`--help of "${path.join(' ') || 'tunnel'}" matches its golden page`, async (t) => {
    // An empty directory, so that the --base line shows the fallback, as it did when the page was
    // written
    const io = captureIo()
    const code = await main([...path, '--help'], io, { env: { TUNNEL_CONFIG_DIR: tmpDir(t) } })
    const { out, err } = io.takeOutput()
    assert.equal(err, '')
    assert.equal(code, 0)
    assert.equal(out, readFileSync(join(FIXTURES, page), 'utf8'))
  })
}

test('the help fixtures are exactly the pages of the command table', (t) => {
  // A command added without its page, or a page left behind by a command taken out, fails here
  const parser = buildParser({ env: { TUNNEL_CONFIG_DIR: tmpDir(t) } })
  const names = parser.paths().map((path) => `${path.join('-') || 'tunnel'}.txt`)
  assert.deepEqual(names.sort(), pages)
})

/** A line of probes.jsonl: a command line and what the parser makes of it */
interface Probe {
  argv: string[]
  /** It parsed: every key of the parsed args */
  args?: Record<string, unknown>
  handler?: string
  /** It ended in the parser: --help, --version or a usage error */
  exit?: number
  stdout?: string
  stderr?: string
}

const probes: Probe[] = readFileSync(join(FIXTURES, 'probes.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line !== '')
  .map((line) => JSON.parse(line) as Probe)

/** The fixture writes a float that is not finite as a string, JSON having no such number */
function finite(value: unknown): unknown {
  if (value === 'inf') return Infinity
  if (value === '-inf') return -Infinity
  if (value === 'nan') return NaN
  return value
}

test('the parser takes each probe the way probes.jsonl says', async (t) => {
  const deps = { env: { TUNNEL_CONFIG_DIR: tmpDir(t) } }
  for (const probe of probes) {
    await t.test(JSON.stringify(probe.argv), async () => {
      if (probe.args !== undefined) {
        const parsed = buildParser(deps).parse(probe.argv)
        assert.ok(parsed.kind === 'run', parsed.kind)
        const expected = Object.fromEntries(
          Object.entries(probe.args).map(([dest, value]) => [dest, finite(value)]),
        )
        assert.deepEqual(parsed.args, expected)
      } else {
        const io = captureIo()
        const code = await main(probe.argv, io, deps)
        const { out, err } = io.takeOutput()
        assert.equal(err, probe.stderr)
        assert.equal(out, probe.stdout?.replace('tunnel {VERSION}\n', `tunnel ${VERSION}\n`))
        assert.equal(code, probe.exit)
      }
    })
  }
})

test('--json does not turn a usage error into JSON', async (t) => {
  // docs/cli.md: a misspelt flag is still the argument parser's own usage message
  const io = captureIo()
  const argv = ['--json', 'set', 'GET', '/a', '--nonsense']
  const code = await main(argv, io, { env: { TUNNEL_CONFIG_DIR: tmpDir(t) } })
  const { out, err } = io.takeOutput()
  assert.equal(code, 1)
  assert.equal(out, '')
  assert.ok(err.startsWith('usage: '), err)
  assert.equal(err.split('\n').at(-2), 'tunnel: error: unrecognized arguments: --nonsense')
})

test('the help width follows COLUMNS, then the terminal, then 80, less two', async (t) => {
  const pipe = captureIo().stdout
  const terminal = Object.assign(new Writable(), { isTTY: true, columns: 100 })
  assert.equal(helpWidth({}, pipe), 78)
  // Read with parseIntArg
  assert.equal(helpWidth({ COLUMNS: '120' }, pipe), 118)
  assert.equal(helpWidth({ COLUMNS: ' 60 ' }, pipe), 58)
  assert.equal(helpWidth({ COLUMNS: '1_20' }, pipe), 118)
  // Decimal digits outside ASCII count too: these are Arabic-Indic, 120
  assert.equal(helpWidth({ COLUMNS: '\u0661\u0662\u0660' }, pipe), 118)
  for (const columns of ['0', 'abc', '-5']) {
    assert.equal(helpWidth({ COLUMNS: columns }, pipe), 78, columns)
  }
  assert.equal(helpWidth({}, terminal), 98)

  // Far too narrow: set's page takes 195 lines, and all that is asked here is that the page comes
  // out at all
  const io = captureIo()
  const env = { TUNNEL_CONFIG_DIR: tmpDir(t), COLUMNS: '5' }
  assert.equal(await main(['set', '--help'], io, { env }), 0)
})
