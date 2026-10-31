// printf's %g, where JavaScript's number formatting differs. Part of the base, importing nothing:
// the core uses it, and so does the CLI, which may not import the core.

/** printf's `%g`: six significant digits, exponent form below 1e-4 and from 1e6, trailing zeros
 *  dropped, an exact tie settled to even; inf, -inf, nan and -0 spelled the way printf spells
 *  them. The core uses it for the hang's detail and two log lines, the CLI for wait's
 *  "Timed out after …s" */
export function formatG(n: number): string {
  if (Number.isNaN(n)) return 'nan'
  const sign = n < 0 || Object.is(n, -0) ? '-' : ''
  const x = Math.abs(n)
  if (x === Infinity) return `${sign}inf`
  if (x === 0) return `${sign}0`
  // toExponential and %g both round the exact value of the double to six digits, and differ
  // only on an exact tie, a value that is a seven digit decimal ending in 5: toExponential rounds
  // a tie up, %g to even. Up is to even when the sixth digit is odd, so only a tie on an even one
  // needs another answer, the six digits as they stand. Seven digits ending in 5 say a value may
  // be a tie; whether it is takes the exact comparison. 99999.95 is written that way but the
  // double is 99999.949999…, which both round down; taking a value for a tie because its seven
  // digits read back as the same double got 78 of 320,061 values wrong.
  const seven = scientific(x, 6)
  const truncated = seven.digits.slice(0, 6)
  const tieToKeep =
    seven.digits.endsWith('5') &&
    Number(truncated) % 2 === 0 &&
    isExactDecimal(x, seven.digits, seven.exponent)
  const { digits, exponent } = tieToKeep
    ? { digits: truncated, exponent: seven.exponent }
    : scientific(x, 5)
  const significant = digits.replace(/0+$/, '')
  if (exponent < -4 || exponent >= 6) {
    const mantissa =
      significant.length === 1 ? significant : `${significant[0]}.${significant.slice(1)}`
    const power = String(Math.abs(exponent)).padStart(2, '0')
    return `${sign}${mantissa}e${exponent < 0 ? '-' : '+'}${power}`
  }
  if (exponent < 0) return `${sign}0.${'0'.repeat(-exponent - 1)}${significant}`
  const whole = significant.slice(0, exponent + 1).padEnd(exponent + 1, '0')
  const fraction = significant.slice(exponent + 1)
  return fraction === '' ? `${sign}${whole}` : `${sign}${whole}.${fraction}`
}

/** x.toExponential(fractionDigits) taken apart: the digits without the point, and the exponent */
function scientific(x: number, fractionDigits: number): { digits: string; exponent: number } {
  const [mantissa = '', exponent = ''] = x.toExponential(fractionDigits).split('e')
  return { digits: mantissa.replace('.', ''), exponent: Number(exponent) }
}

/** Whether the double x (finite, above 0) is exactly the decimal `digits` with the point after the
 *  first digit, times 10^exponent. The double is an integer times a power of two, the decimal an
 *  integer times a power of ten; each negative power moves to the other side as a multiplier, and
 *  the two integers left are compared as BigInts */
function isExactDecimal(x: number, digits: string, exponent: number): boolean {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, x)
  const bits = view.getBigUint64(0)
  const biased = Number((bits >> 52n) & 0x7ffn)
  const fraction = bits & ((1n << 52n) - 1n)
  // A subnormal has no implicit leading 1, and the exponent of the smallest normal double
  const mantissa = biased === 0 ? fraction : fraction | (1n << 52n)
  const power2 = biased === 0 ? -1074 : biased - 1075
  const power10 = exponent - (digits.length - 1)
  let double = mantissa
  let decimal = BigInt(digits)
  if (power2 >= 0) double <<= BigInt(power2)
  else decimal <<= BigInt(-power2)
  if (power10 >= 0) decimal *= 10n ** BigInt(power10)
  else double *= 10n ** BigInt(-power10)
  return double === decimal
}
