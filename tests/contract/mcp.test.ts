// The black-box comparison for `tunnel mcp`: what it answers to the two eras' opening moves and to
// tools/list, field by field against the golden answers in tests/fixtures/mcp-answers.json. A
// client calls the tools by these names and builds its arguments from these schemas, so they are
// pinned here, and tests/mcp.test.ts looks at their shape only. The fixture leaves out one thing:
// the version in initialize and in server/discover, which is this package's.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseJson } from '../../src/json.ts'
import { PACKAGE_ROOT, VERSION } from '../../src/package-info.ts'
import { runTunnel } from '../support/target.ts'
import { tmpDir } from '../support/tmp.ts'

/** The three answers, under the method each answers, as the fixture holds them */
interface Answers {
  initialize: any
  'tools/list': any
  'server/discover': any
}

// The reverse-DNS key discover hangs the server's identity off, spelt out: this test reads the
// wire, not the module that writes it
const SERVER_INFO_KEY = 'io.modelcontextprotocol/serverInfo'

// The three messages the fixture holds the answers to, one a line: a handshake asking for
// 2025-06-18, then tools/list and server/discover
const INPUT = [
  {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'fixture', version: '0' },
    },
  },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  { jsonrpc: '2.0', id: 3, method: 'server/discover', params: {} },
]
  .map((message) => `${JSON.stringify(message)}\n`)
  .join('')

test('initialize, tools/list and server/discover answer as the fixture does [slow]', async (t) => {
  const dir = tmpDir(t)
  // None of the three reaches the admin port, so a base nobody listens on does
  const { code, stdout, stderr } = await runTunnel(['--base', 'http://127.0.0.1:1', 'mcp'], {
    input: INPUT,
    env: { TUNNEL_CONFIG_DIR: dir },
    cwd: dir,
    timeoutMs: 60_000,
  })
  assert.equal(code, 0, stderr)
  const replies = stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => parseJson(line) as { id: number; result: any })
  assert.deepEqual(
    replies.map((reply) => reply.id),
    [1, 2, 3],
  )
  const [initialize, list, discover] = replies.map((reply) => reply.result)
  const expected = parseJson(
    readFileSync(join(PACKAGE_ROOT, 'tests/fixtures/mcp-answers.json'), 'utf8'),
  ) as unknown as Answers
  // This package's version in both, which the fixture does not hold
  assert.equal(initialize.serverInfo.version, VERSION)
  assert.equal(discover._meta[SERVER_INFO_KEY].version, VERSION)
  delete initialize.serverInfo.version
  delete discover._meta[SERVER_INFO_KEY].version
  assert.deepEqual(initialize, expected.initialize)
  assert.deepEqual(list, expected['tools/list'])
  assert.deepEqual(discover, expected['server/discover'])
})
