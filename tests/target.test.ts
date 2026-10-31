// runTunnel from tests/support/target.ts, which the black-box tests in
// tests/contract/ run the tunnel command through.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runTunnel } from './support/target.ts'

test('runTunnel copes with a command that exits without reading its input', async () => {
  // More than a pipe holds, so it is still being written when the command exits
  const input = 'x'.repeat(4 * 1024 * 1024)
  const { code, stdout, stderr } = await runTunnel(['--version'], { input })
  assert.equal(stderr, '')
  assert.equal(code, 0)
  assert.match(stdout, /^tunnel \d+\.\d+\.\d+\n$/)
})
