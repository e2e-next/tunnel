// PACKAGE_ROOT and VERSION: every path inside the package and the version
// number come from src/package-info.ts, so these two have to be right. And what
// an import of the package resolves to, the library entry and its declarations.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { test } from 'node:test'
import { PACKAGE_ROOT, VERSION } from '../src/package-info.ts'

test('VERSION is the version package.json declares', () => {
  // Read here rather than through the module under test, which could not catch its own wrong path
  const declared = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(VERSION, declared.version)
})

test('PACKAGE_ROOT is the directory holding package.json, with no trailing slash', () => {
  assert.ok(existsSync(join(PACKAGE_ROOT, 'package.json')))
  // This file sits one level below the package root, as src/package-info.ts does
  assert.equal(PACKAGE_ROOT, dirname(import.meta.dirname))
  assert.ok(!PACKAGE_ROOT.endsWith(sep), PACKAGE_ROOT)
})

test('package.json exports the library entry with its types, and the build emits declarations', () => {
  const declared = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const entry = { types: './dist/index.d.ts', default: './dist/index.js' }
  assert.deepEqual(declared.exports, { '.': entry })
  // In this order: TypeScript takes the first condition that matches
  assert.deepEqual(Object.keys(declared.exports['.']), ['types', 'default'])
  assert.equal(declared.types, './dist/index.d.ts')
  assert.deepEqual(declared.bin, { tunnel: 'dist/cli.js' })
  const build = JSON.parse(readFileSync(new URL('../tsconfig.build.json', import.meta.url), 'utf8'))
  assert.equal(build.compilerOptions.declaration, true)
})
