// Loading a config file written by an older tunnel.
//
// Two response modes are gone. `file` cannot be migrated — the server reads no
// user files at all — so such an entry is skipped with a warning rather than
// taken down the whole config file with it. `proxy` was only renamed
// `passthrough`, so those entries are carried over instead of dropped.
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { Paths, TunnelConfigManager } from '../src/config.ts'
import type { LogLevel, LogRecord } from '../src/log.ts'
import type { TunnelConfig } from '../src/models.ts'
import { captureLogs } from './support/logs.ts'
import { tmpDir } from './support/tmp.ts'

function writeConfig(directory: string, config: unknown): void {
  writeFileSync(join(directory, 'config.json'), JSON.stringify(config))
}

function load(directory: string): TunnelConfig {
  return new TunnelConfigManager(Paths.inOneDirectory(directory)).getConfig()
}

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warning', 'error']

/** The messages logged at level and above, one a line */
function atLevel(records: readonly LogRecord[], level: LogLevel): string {
  const lowest = LEVELS.indexOf(level)
  return records
    .filter((record) => LEVELS.indexOf(record.level) >= lowest)
    .map((record) => record.message)
    .join('\n')
}

test('file mode entry is skipped with a warning', (t) => {
  const dir = tmpDir(t)
  writeConfig(dir, {
    request_configs: {
      'GET:/api/old': {
        request_key: 'GET:/api/old',
        mode: 'file',
        file_path: 'data/old.json',
        auto_file_path: true,
      },
      'GET:/api/feed': { request_key: 'GET:/api/feed', mode: 'json', json_response: { v: 1 } },
    },
  })

  const logs = captureLogs(t)
  const config = load(dir)

  assert.deepStrictEqual(Object.keys(config.request_configs), ['GET:/api/feed'])
  assert.ok(atLevel(logs.records, 'warning').includes('GET:/api/old'))
})

// The mode was renamed, not removed: keep the rule and its upstream address
test('proxy entries are carried over under the new name', (t) => {
  const dir = tmpDir(t)
  writeConfig(dir, {
    request_configs: {
      'GET:/api/feed': {
        request_key: 'GET:/api/feed',
        mode: 'proxy',
        custom_proxy_target: 'https://api.example.com/v5/feed',
      },
    },
  })

  const rule = load(dir).request_configs['GET:/api/feed']

  assert.ok(rule)
  assert.equal(rule.mode, 'passthrough')
  assert.equal(rule.target, 'https://api.example.com/v5/feed')
})

// Dropped fields must not cost the user the mocks that are still valid
test('the rest of an old config still loads', (t) => {
  const dir = tmpDir(t)
  writeConfig(dir, {
    default_mode: 'proxy',
    default_proxy_target: 'http://127.0.0.1:8080',
    max_requests_history: 42,
    request_configs: {
      'GET:/api/feed': {
        request_key: 'GET:/api/feed',
        mode: 'json',
        json_response: { v: 1 },
        json_base_file: 'data/base.json',
      },
    },
  })

  const logs = captureLogs(t)
  const config = load(dir)

  assert.equal(config.max_requests_history, 42)
  // `proxy` is a per-endpoint mode, never a global one; the global default
  // answers endpoints with no rule, and today that is passthrough.
  assert.equal(config.default_mode, 'passthrough')
  assert.ok(atLevel(logs.records, 'warning').includes('default_mode'))
  assert.deepStrictEqual(config.request_configs['GET:/api/feed']?.json_response, { v: 1 })
})

// Recording and replay share one session now; the old one was the switch's
test('the session being recorded becomes the current session', (t) => {
  const dir = tmpDir(t)
  writeConfig(dir, { recording: { active: false, session: 'acct_a' } })

  const logs = captureLogs(t)
  const config = load(dir)

  assert.equal(config.session, 'acct_a')
  assert.ok(atLevel(logs.records, 'info').includes('acct_a'))
})

// Every rule used to be written with `default` in it, which meant nothing
test('a rule pinned to the default session is set to follow instead', (t) => {
  const dir = tmpDir(t)
  writeConfig(dir, {
    request_configs: {
      'GET:/api/feed': {
        request_key: 'GET:/api/feed',
        mode: 'replay',
        replay_session: 'default',
      },
      'GET:/api/poll': {
        request_key: 'GET:/api/poll',
        mode: 'replay',
        replay_session: 'acct_a',
      },
    },
  })

  const logs = captureLogs(t)
  const rules = load(dir).request_configs

  assert.equal(rules['GET:/api/feed']?.replay_session, '')
  // A session anybody chose is left exactly where it was pinned
  assert.equal(rules['GET:/api/poll']?.replay_session, 'acct_a')
  assert.ok(atLevel(logs.records, 'info').includes('GET:/api/feed'))
})
