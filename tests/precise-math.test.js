// The precise WGSL maths (packages/shared/precise-math.js), proven on the host through its operation-for-operation
// mirror (tests/precise-math-reference.js; packages/compute/tests/compute-precise-browser.js shows the GPU computes
// the same values): every constant re-derived from scratch, the pi/2 reduction exact against BigInt, each function
// within its bound in ulp over dense inputs, also when every multiply-add is fused and when the builtin division and
// sqrt are as far off as WGSL allows, and the special values of Math.*.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PRECISE, PRECISE_FUNCTIONS, preciseMathWgsl } from '../packages/shared/precise-math.js';
import { derive, PI_FIXED } from '../scripts/precise-math-coefficients.mjs';
import { perturbBuiltinMath } from '../scripts/browser.js';
import { bitsOf, preciseCases, preciseReference, reduceHalfPi, worstError } from './precise-math-reference.js';

test('every constant is what scripts/precise-math-coefficients.mjs derives from pi, ln 2 and 2/pi', () => {
  const d = derive();
  for (const key of Object.keys(PRECISE)) {
    const want = Array.isArray(d[key]) ? d[key] : (d[key].coefficients ?? d[key]);
    assert.deepEqual(PRECISE[key], want, key);
  }
  // Every polynomial is well inside f32: its own error is under 2^-31 relative (an ulp is 2^-23 to 2^-24).
  for (const key of ['sin', 'cos', 'atan', 'asin', 'sinh', 'cosh', 'tanh', 'expm1', 'log'])
    assert.ok(d[key].log2Error < -31, `${key}: 2^${d[key].log2Error}`);
  // The closest any f32 comes to a multiple of pi/2 is 2^-29.2 (at 16367173 * 2^72), so the reduction's 2^-63
  // resolution keeps 34 bits of the smallest reduced argument.
  assert.ok(d.reduction.log2 > -29.5 && d.reduction.log2 < -29, `2^${d.reduction.log2}`);
});

test('the pi/2 reduction matches exact BigInt arithmetic for f32 inputs of every exponent', () => {
  const twoOverPi = (2n << 1200n) / PI_FIXED; // 2/pi * 2^600
  const halfPi = PI_FIXED / 2n; // pi/2 * 2^600
  const view = new DataView(new ArrayBuffer(4));
  let seed = 3;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  // The hardest input (closest to a multiple of pi/2) and the largest finite f32, then random mantissas per exponent.
  const inputs = [16367173 * 2 ** 72, 3.4028234663852886e38, Math.fround(Math.PI / 2), Math.fround(Math.PI)];
  for (let biased = 126; biased <= 254; biased++)
    for (let k = 0; k < 40; k++) {
      view.setUint32(0, (biased << 23) | (next() & 0x7fffff));
      inputs.push(view.getFloat32(0));
    }
  for (const a of inputs) {
    if (a <= 0.78125) continue;
    // a = m 2^e exactly; k = round(a 2/pi); r = a - k pi/2 in 2^-600 units.
    const bits = bitsOf(a),
      e = BigInt((bits >>> 23) - 150),
      m = BigInt((bits & 0x7fffff) | 0x800000),
      scaled = e >= 0n ? m << (600n + e) : (m << 600n) >> -e;
    const quotient = (scaled * twoOverPi) >> 600n; // a 2/pi in 2^-600 units
    const k = (quotient + (1n << 599n)) >> 600n,
      r = scaled - k * halfPi;
    const exact = Number(r) / 2 ** 600 || Number(r >> 500n) / 2 ** 100,
      got = reduceHalfPi(a);
    assert.equal(got.q, Number(((k % 4n) + 4n) % 4n), `quadrant of ${a}`);
    const rel = Math.abs(got.hi + got.lo - exact) / Math.abs(exact);
    // 2^-63 absolute (the 64-bit fraction) over r >= 2^-29.2, plus 2^-35.6 from pi/2 in 32 bits: under 2^-32.5.
    assert.ok(rel < 2 ** -32.5, `${a}: reduced ${got.hi + got.lo}, exact ${exact} (${rel})`);
  }
});

const MODES = [
  ['as WGSL rounds each operation', {}],
  ['with every multiply-add fused', { fused: true }],
  ['with division 2 ulp high and sqrt 4 ulp high', { divUlps: 2, sqrtUlps: 4 }],
  ['with division 2 ulp low, sqrt 4 ulp low and fused multiply-adds', { divUlps: -2, sqrtUlps: -4, fused: true }],
];

test('each function is within its bound in ulp over dense inputs, however the GPU rounds', () => {
  const cases = preciseCases(1 << 14);
  for (const [label, mode] of MODES) {
    const fns = preciseReference(mode);
    for (const [name, c] of Object.entries(cases)) {
      const { ratio, ulp, at } = worstError(fns[name], c);
      assert.ok(ratio <= 1, `${name} ${label}: ${ulp} ulp at ${JSON.stringify(at)}`);
    }
  }
});

test('special values follow Math.*', () => {
  const P = preciseReference(),
    inf = Number.POSITIVE_INFINITY;
  const same = (got, want, label) => assert.ok(Object.is(got, want), `${label}: ${got}, want ${want}`);
  for (const name of ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'exp', 'exp2', 'expm1', 'log', 'log2', 'log1p'])
    same(P[name](Number.NaN), Number.NaN, `${name}(NaN)`);
  for (const name of ['sin', 'tan', 'asin', 'atan', 'expm1', 'log1p', 'sinh', 'tanh']) {
    same(P[name](0), 0, `${name}(0)`);
    same(P[name](-0), -0, `${name}(-0)`);
  }
  same(P.cos(0), 1, 'cos(0)');
  same(P.sin(inf), Number.NaN, 'sin(inf)');
  same(P.asin(1.5), Number.NaN, 'asin(1.5)');
  same(P.atan(inf), Math.fround(Math.PI / 2), 'atan(inf)');
  same(P.exp(-inf), 0, 'exp(-inf)');
  same(P.exp(inf), inf, 'exp(inf)');
  same(P.log(0), -inf, 'log(0)');
  same(P.log(-1), Number.NaN, 'log(-1)');
  same(P.log(inf), inf, 'log(inf)');
  same(P.log1p(-1), -inf, 'log1p(-1)');
  same(P.tanh(inf), 1, 'tanh(inf)');
  for (const [y, x] of [
    [0, 0],
    [-0, 0],
    [0, -0],
    [-0, -0],
    [0, -1],
    [-0, -1],
    [1, 0],
    [-1, -0],
    [inf, inf],
    [inf, -inf],
    [-inf, inf],
    [1, inf],
    [1, -inf],
    [-1, -inf],
  ])
    same(P.atan2(y, x), Math.fround(Math.atan2(y, x)), `atan2(${y}, ${x})`);
  for (const [x, y] of [
    [Number.NaN, 0],
    [1, Number.NaN],
    [1, inf],
    [2, inf],
    [0.5, inf],
    [2, -inf],
    [0, 3],
    [-0, 3],
    [-0, 2],
    [0, -1],
    [-0, -1],
    [-0, -2],
    [inf, 2],
    [-inf, 3],
    [-inf, -3],
    [-inf, 2],
    [-2, 3],
    [-2, 2],
    [-2, -1],
    [-8, 1 / 3],
    [2, 0.5],
  ])
    same(P.pow(x, Math.fround(y)), Math.fround(x ** Math.fround(y)), `pow(${x}, ${y})`);
});

test('preciseMathWgsl gives each function and its helpers once, and names the choices for an unknown one', () => {
  const sin = preciseMathWgsl(['preciseSin']);
  assert.match(sin, /fn preciseSin\(x: f32\) -> f32/);
  assert.match(sin, /fn pmReduce\(a: f32\)/);
  assert.doesNotMatch(sin, /fn preciseCos|fn preciseLog|fn precisePow/);
  const both = preciseMathWgsl(['preciseSin', 'preciseCos', 'preciseSin']);
  assert.equal(both.match(/fn pmReduce\(/g).length, 1);
  assert.equal(both.match(/const PM_PI_HI/g).length, 1);
  const all = preciseMathWgsl(PRECISE_FUNCTIONS);
  for (const name of PRECISE_FUNCTIONS) assert.match(all, new RegExp(`fn ${name}\\(`));
  // No builtin transcendental function is called (only sqrt, which is corrected): they are what this replaces.
  assert.doesNotMatch(
    all.replace(/\/\/[^\n]*/g, ''),
    /(?<![\w.])(sin|cos|tan|asin|acos|atan|atan2|exp|exp2|log|log2|pow|sinh|cosh|tanh)\(/,
  );
  assert.throws(
    () => preciseMathWgsl(['preciseSine']),
    (e) => e instanceof RangeError && /preciseSin/.test(e.message),
  );
});

test('the spec-math stand-in moves each builtin result by the WGSL bound and leaves everything else alone', () => {
  const previous = globalThis.GPUDevice;
  try {
    globalThis.GPUDevice = class {
      createShaderModule(descriptor) {
        return descriptor.code;
      }
    };
    perturbBuiltinMath(1);
    const device = new globalThis.GPUDevice();
    const code = device.createShaderModule({
      code: 'fn f(x: f32) -> f32 { // sin(\n  return sin(cos(x) * 2.0) + preciseSin(x) + v.sin(x) + atan2(x, 1.0); }\nfn sin2(a: f32) {}',
    });
    assert.match(code, /\(sin\(\(cos\(x\) \* 0\.99951171875\) \* 2\.0\) \* 0\.99951171875\)/);
    assert.match(code, /preciseSin\(x\)/);
    assert.match(code, /v\.sin\(x\)/);
    assert.match(code, /\(atan2\(x, 1\.0\) \* 1\.00024408\d*\)/);
    assert.match(code, /fn sin2\(a: f32\)/);
    assert.doesNotMatch(code, /\/\/ sin\(/);
  } finally {
    globalThis.GPUDevice = previous;
  }
});
