// src/proxy-url.ts: splitTarget, splitAuthority and parseQuery, each held to the
// answers in tests/fixtures/proxy/url-cases.json, case by case.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { parseQuery, splitAuthority, splitTarget } from '../src/proxy-url.ts'

interface TargetCase {
  target: string
  scheme: string
  netloc: string
  path: string
  query: string
  absolute: boolean
}

/** A host and port, or `raises` where splitAuthority throws in their place */
interface AuthorityCase {
  authority: string
  defaultPort: number
  host?: string
  port?: number
  raises?: string
}

interface QueryCase {
  query: string
  parsed: Record<string, string>
}

const CASES: { targets: TargetCase[]; authorities: AuthorityCase[]; queries: QueryCase[] } =
  JSON.parse(readFileSync(new URL('./fixtures/proxy/url-cases.json', import.meta.url), 'utf8'))

test('splitTarget matches url-cases.json on the sample targets', () => {
  // So that a list that came out empty or short cannot pass
  assert.equal(CASES.targets.length, 22)
  for (const { target, ...split } of CASES.targets) {
    assert.deepEqual(splitTarget(target), split, JSON.stringify(target))
  }
})

test('splitAuthority matches url-cases.json on the sample authorities', () => {
  assert.equal(CASES.authorities.length, 16)
  for (const { authority, defaultPort, host, port, raises } of CASES.authorities) {
    const label = JSON.stringify([authority, defaultPort])
    if (raises === undefined) {
      assert.deepEqual(splitAuthority(authority, defaultPort), [host, port], label)
    } else {
      // A port that is not a number: the connection that names one is dropped
      assert.throws(() => splitAuthority(authority, defaultPort), /is not a number/, label)
    }
  }
})

test('parseQuery matches url-cases.json on the sample queries', () => {
  assert.equal(CASES.queries.length, 17)
  for (const { query, parsed } of CASES.queries) {
    assert.deepEqual(parseQuery(query), parsed, JSON.stringify(query))
  }
})
