// src/number-format.ts: printf's %g, which tunnel prints in the hang fault's detail, two of the
// core's log lines and the CLI's "Timed out after …s".
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatG } from '../src/number-format.ts'

// Every expected string is what printf's %g prints for the number.
test("formatG writes a number the way printf's %g does", () => {
  const cases: [number, string][] = [
    // What the core prints: the hang's seconds, the delay's
    [0.2, '0.2'],
    [30, '30'],
    [3600, '3600'],
    [0.1, '0.1'],
    [1e-5, '1e-05'],
    [1234567, '1.23457e+06'],
    [0.123456789, '0.123457'],
    [100000, '100000'],
    [1e6, '1e+06'],
    [2.5e-5, '2.5e-05'],
    // Exact ties, settled to even, where JavaScript's toExponential rounds up
    [1234565, '1.23456e+06'],
    [1234575, '1.23458e+06'],
    [123456.5, '123456'],
    [123457.5, '123458'],
    [999999.5, '1e+06'],
    [9999995, '1e+07'],
    [617282.5, '617282'],
    // Not ties: written with seven digits ending in 5, but the double is a little off that
    [99999.95, '99999.9'],
    [144.3355, '144.335'],
    [0.4935105, '0.493511'],
    // Signs, and the edges of the two forms
    [-3.5, '-3.5'],
    [-0.00002, '-2e-05'],
    [0, '0'],
    [123456, '123456'],
    [999999, '999999'],
    [0.0001, '0.0001'],
    [0.00001234, '1.234e-05'],
    [1e21, '1e+21'],
    [1e100, '1e+100'],
    // What the CLI's wait prints
    [5, '5'],
    [0.1234567, '0.123457'],
    // What printf spells its own way
    [-0, '-0'],
    [Infinity, 'inf'],
    [-Infinity, '-inf'],
    [NaN, 'nan'],
  ]
  for (const [n, want] of cases) {
    assert.equal(formatG(n), want, `formatG(${Object.is(n, -0) ? '-0' : n})`)
  }
})
