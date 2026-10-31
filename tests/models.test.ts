// src/models.ts: the two models and their parts. Their defaults and the order of
// their fields are held to the config.json files in tests/fixtures/config/, and
// their validation to the samples and 422 bodies there.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { ValidationError, type ValidationIssue } from '../src/errors.ts'
import {
  DEFAULT_MODES,
  DEFAULT_REDACT_HEADERS,
  FAULTS,
  REPLAY_STRATEGIES,
  SSL_PROXYING_SCHEMA,
  TUNNEL_CONFIG_SCHEMA,
  TUNNEL_MODES,
  TUNNEL_REQUEST_CONFIG_SCHEMA,
  makeSslProxying,
  makeTunnelConfig,
  makeTunnelRequestConfig,
  parseTunnelConfig,
  parseTunnelRequestConfig,
} from '../src/models.ts'
import { check, validationErrorBody, type Schema } from '../src/validate.ts'

/** The text of a golden file in tests/fixtures/config/ */
function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/config/${name}`, import.meta.url), 'utf8')
}

/** The issues check() reports, which there have to be */
function issuesOf(schema: Schema<unknown>, input: unknown): ValidationIssue[] {
  const result = check(schema, input)
  assert.ok(!result.ok)
  return result.issues
}

test('makeTunnelConfig() serialises to defaults.json, byte for byte', () => {
  // What tunnel writes into an empty directory: every field, its default and its place
  assert.equal(JSON.stringify(makeTunnelConfig(), null, 2), fixture('defaults.json'))
})

test('makeTunnelRequestConfig() lists the fields in the order full.json has them', () => {
  const rules = (JSON.parse(fixture('full.json')) as { request_configs: Record<string, object> })
    .request_configs
  const feed = rules['GET:/api/feed']
  assert.ok(feed)
  assert.deepStrictEqual(
    Object.keys(makeTunnelRequestConfig({ request_key: 'GET:/k' })),
    Object.keys(feed),
  )

  // GET:/10 has mode "json" and the defaults for the rest. The fields given go in their places
  // whatever order they come in, and one given as undefined is not given
  const ten = rules['GET:/10']
  assert.ok(ten)
  const made = makeTunnelRequestConfig({
    status_code: undefined,
    mode: 'json',
    request_key: 'GET:/10',
  })
  assert.deepStrictEqual(made, ten)
  assert.deepStrictEqual(Object.keys(made), Object.keys(ten))
})

test('every default is a new object', () => {
  const rule = makeTunnelRequestConfig({ request_key: 'GET:/a' })
  const other = makeTunnelRequestConfig({ request_key: 'GET:/a' })
  assert.notEqual(rule.json_response, other.json_response)
  assert.notEqual(rule.merge_json, other.merge_json)
  assert.notEqual(rule.headers, other.headers)
  const json = rule.json_response
  assert.ok(!Array.isArray(json))
  json.message = 'changed'
  assert.deepStrictEqual(makeTunnelRequestConfig({ request_key: 'GET:/a' }).json_response, {
    message: 'Tunnel response',
  })

  const config = makeTunnelConfig()
  const another = makeTunnelConfig()
  assert.notEqual(config.ssl_proxying, another.ssl_proxying)
  assert.notEqual(config.ssl_proxying.include, another.ssl_proxying.include)
  assert.notEqual(config.redact_headers, another.redact_headers)
  assert.notEqual(config.request_configs, another.request_configs)
  assert.notEqual(config.redact_headers, DEFAULT_REDACT_HEADERS)
  // and the list it is copied from cannot be changed
  assert.ok(Object.isFrozen(DEFAULT_REDACT_HEADERS))
  config.ssl_proxying.include.push('*.example.com')
  config.redact_headers.push('x-secret')
  config.request_configs['GET:/a'] = rule
  assert.equal(JSON.stringify(makeTunnelConfig(), null, 2), fixture('defaults.json'))
})

test('the four enums are the values lax.json lists', () => {
  const { enums } = JSON.parse(fixture('lax.json')) as { enums: Record<string, string[]> }
  assert.deepStrictEqual(
    {
      TunnelMode: [...TUNNEL_MODES],
      ReplayStrategy: [...REPLAY_STRATEGIES],
      Fault: [...FAULTS],
      DefaultMode: [...DEFAULT_MODES],
    },
    enums,
  )
})

test('parseTunnelConfig drops the fields it does not know', () => {
  const config = parseTunnelConfig({
    from_a_newer_version: 1,
    ssl_proxying: { include: ['*.example.com'], ports: [443] },
    request_configs: { 'GET:/a': { request_key: 'GET:/a', status_code: 201, priority: 'high' } },
  })
  assert.deepStrictEqual(
    config,
    makeTunnelConfig({
      ssl_proxying: makeSslProxying({ include: ['*.example.com'] }),
      request_configs: {
        'GET:/a': makeTunnelRequestConfig({ request_key: 'GET:/a', status_code: 201 }),
      },
    }),
  )
})

test("a failed parse throws ValidationError: the model's name as title, one line of loc: msg", () => {
  const config = { max_requests_history: 'many' }
  assert.throws(
    () => parseTunnelConfig(config),
    (error) => {
      assert.ok(error instanceof ValidationError)
      assert.ok(error instanceof Error)
      assert.equal(error.name, 'ValidationError')
      assert.equal(error.title, 'TunnelConfig')
      assert.equal(
        error.message,
        '1 validation error for TunnelConfig: max_requests_history: Input should be a valid integer, unable to parse string as an integer',
      )
      assert.deepStrictEqual(error.issues, issuesOf(TUNNEL_CONFIG_SCHEMA, config))
      return true
    },
  )

  const rule = { status_code: 'x' }
  assert.throws(
    () => parseTunnelRequestConfig(rule),
    (error) => {
      assert.ok(error instanceof ValidationError)
      assert.equal(error.title, 'TunnelRequestConfig')
      assert.equal(
        error.message,
        '2 validation errors for TunnelRequestConfig: request_key: Field required; status_code: Input should be a valid integer, unable to parse string as an integer',
      )
      assert.deepStrictEqual(error.issues, issuesOf(TUNNEL_REQUEST_CONFIG_SCHEMA, rule))
      return true
    },
  )
})

test('every sample in models.json', () => {
  const { samples } = JSON.parse(fixture('models.json')) as {
    samples: { model: string; input: unknown; value?: unknown; errors?: ValidationIssue[] }[]
  }
  const schemas: Record<string, Schema<unknown>> = {
    TunnelConfig: TUNNEL_CONFIG_SCHEMA,
    TunnelRequestConfig: TUNNEL_REQUEST_CONFIG_SCHEMA,
  }
  for (const sample of samples) {
    const schema = schemas[sample.model]
    assert.ok(schema, sample.model)
    assert.deepStrictEqual(
      check(schema, sample.input),
      'value' in sample ? { ok: true, value: sample.value } : { ok: false, issues: sample.errors },
      JSON.stringify(sample.input),
    )
  }
})

test('the validation error bodies in validation-422.json, key order included', () => {
  const { responses } = JSON.parse(fixture('validation-422.json')) as {
    responses: { body: { ssl_proxying: unknown }; response: unknown }[]
  }
  for (const captured of responses) {
    // A body is checked with fromAttributes, and its loc starts with 'body'
    const result = check(SSL_PROXYING_SCHEMA, captured.body.ssl_proxying, {
      at: ['body', 'ssl_proxying'],
      fromAttributes: true,
    })
    assert.ok(!result.ok, JSON.stringify(captured.body))
    const body = validationErrorBody(result.issues)
    assert.deepStrictEqual(body, captured.response)
    assert.equal(JSON.stringify(body), JSON.stringify(captured.response))
  }
})
