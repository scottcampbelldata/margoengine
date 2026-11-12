// The layer's own acos, asin and atan2 for drivers whose built-ins miss 1e-5 (src/device/inverse-trig.ts,
// src/glsl/helpers.ts; docs/known-bugs.md, "ANGLE Direct3D 11: acos is 6.75e-5 off"). The GPU check is
// features-browser.mjs inverseTrig; these pin the emitted calls, the startup probe's verdict, and the helpers' maths
// step by step in float32 over the whole domain.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ATAN_UNIT,
  GLSL_HELPERS,
  INVERSE_TRIG_IMPLAUSIBLE,
  INVERSE_TRIG_PROBE,
  INVERSE_TRIG_TOLERANCE,
  inverseTrigError,
  translateWGSL,
} from '../dist/glsl.js';

const SOURCE = `
@vertex fn v() -> @builtin(position) vec4f { return vec4f(0.0, 0.0, 0.0, 1.0); }
struct U { a: vec4f, b: vec3f, s: f32 }
@group(0) @binding(0) var<uniform> u: U;
@fragment fn f() -> @location(0) vec4f {
  let m = acos(u.s) + asin(u.s) + atan2(u.s, u.a.x) + atan(u.s);
  return vec4f(acos(u.a.xy), atan2(u.b, u.a.xyz).x, m) + asin(u.a);
}`;
const fragment = (accurateInverseTrig) =>
  translateWGSL({ vertex: { source: SOURCE }, fragment: { source: SOURCE }, accurateInverseTrig }).fragment.source;

// The one-argument atan stayed GLSL's until 2026-11-12: on the Radeon 680M under ANGLE D3D11 it was 1.16e-5 off over
// [-8, 8] (features-browser.mjs inverseTrig, sweep 4), past the 1e-5 the rest meet.
test('the option calls the layer\'s acos, asin, atan and atan2 for scalars and vectors', () => {
  const on = fragment(true);
  for (const call of ['_acos(', '_asin(', '_atan2(', '_atan(']) assert.ok(on.includes(call), call);
  assert.ok(!/(?<![_\w])(acos|asin|atan)\(/.test(on), 'no built-in acos, asin or atan is left');
  for (const name of ['_atanu', '_atan2', '_atan', '_asin', '_acos']) assert.equal(on.split(`${name}(float`).length, 2, `${name} once`);
});

test('without the option the shader is unchanged: GLSL built-ins, no helpers', () => {
  const off = fragment(false);
  assert.equal(off, fragment(undefined));
  assert.ok(off.includes('acos(') && off.includes('asin(') && off.includes('atan('));
  assert.ok(!off.includes('_atanu') && !off.includes('_acos') && !off.includes('_atan2'));
});

test('_atanu evaluates ATAN_UNIT by Horner\'s rule', () => {
  const body = ATAN_UNIT.reduceRight(
    (inner, c, k) => (k === ATAN_UNIT.length - 1 ? String(c) : `${Number.isInteger(c) ? `${c}.0` : c} + t * (${inner})`),
    '',
  );
  assert.equal(GLSL_HELPERS._atanu.source, `float _atanu(float a) { float t = a * a; return a * (${body}); }`);
});

// The helpers in float32: Math.fround after every operation the GLSL performs, in its order.
const f = Math.fround;
const sign = (v) => Object.is(v, -0) || v < 0;
function atanu(a) {
  const t = f(a * a);
  let p = f(ATAN_UNIT[ATAN_UNIT.length - 1]);
  for (let k = ATAN_UNIT.length - 2; k >= 0; k--) p = f(f(ATAN_UNIT[k]) + f(t * p));
  return f(a * p);
}
function atan2(y, x) {
  const ax = Math.abs(x),
    ay = Math.abs(y),
    hi = Math.max(ax, ay);
  let r = atanu(hi > 0 ? f(Math.min(ax, ay) / hi) : 0);
  if (ay > ax) r = f(f(1.5707964) - r);
  if (sign(x)) r = f(f(3.1415927) - r);
  return sign(y) ? -r : r;
}
const root = (x) => f(Math.sqrt(f(f(1 - x) * f(1 + x))));
const asin = (x) => atan2(x, root(x));
const atan = (x) => atan2(x, 1);
const acos = (x) => atan2(root(x), x);

const bits = new Float32Array(1),
  word = new Uint32Array(bits.buffer);
const fromBits = (b) => ((word[0] = b >>> 0), bits[0]);
const ONE = 0x3f800000;

test('acos and asin stay within 1e-6 over [-1, 1]: every float32 within 1 / 16 of either end, a stride elsewhere', () => {
  let worst = 0;
  const check = (x) => {
    worst = Math.max(worst, Math.abs(acos(x) - Math.acos(x)), Math.abs(asin(x) - Math.asin(x)));
  };
  for (let b = 0x3f700000; b <= ONE; b++) {
    const x = fromBits(b);
    check(x);
    check(-x);
  }
  for (let b = 0; b < 0x3f700000; b += 1009) {
    const x = fromBits(b);
    check(x);
    check(-x);
  }
  for (const x of [0, -0, 1, -1, 0.5, -0.5]) check(x);
  assert.ok(worst < 1e-6, `largest error ${worst}`);
  assert.ok(worst < INVERSE_TRIG_TOLERANCE / 10);
  // The ends and the middle exactly as the float32 results of pi / 2 and pi.
  assert.equal(acos(1), 0);
  assert.equal(acos(-1), f(Math.PI));
  assert.equal(acos(0), f(Math.PI / 2));
  assert.equal(asin(-1), -f(Math.PI / 2));
});

test('atan2 stays within 1e-6 in every octant, at every magnitude, and keeps the signs of zero', () => {
  let worst = 0;
  // Every ratio the octant reduction can give (a stride of the float32 values in [0, 1]), in all eight octants.
  for (let b = 0; b <= ONE; b += 1021) {
    const a = fromBits(b);
    for (const [y, x] of [[a, 1], [1, a], [a, -1], [1, -a], [-a, 1], [-1, a], [-a, -1], [-1, -a]])
      worst = Math.max(worst, Math.abs(atan2(y, x) - Math.atan2(y, x)));
  }
  // Directions around the circle at tiny, unit and huge magnitudes.
  for (let i = 0; i < 20000; i++) {
    const angle = -Math.PI + (2 * Math.PI * (i + 0.5)) / 20000;
    for (const r of [1e-30, 1e-3, 1, 1e3, 1e30]) {
      const y = f(r * Math.sin(angle)),
        x = f(r * Math.cos(angle));
      worst = Math.max(worst, Math.abs(atan2(y, x) - Math.atan2(y, x)));
    }
  }
  assert.ok(worst < 1e-6, `largest error ${worst}`);
  for (const [y, x] of [[0, 1], [-0, 1], [0, -1], [-0, -1], [0, 0], [-0, -0], [1, 0], [-1, -0]])
    assert.ok(Object.is(atan2(y, x), f(Math.atan2(y, x))), `atan2(${y}, ${x})`);
});

test('atan stays within 1e-6 at every magnitude and keeps the sign of zero', () => {
  let worst = 0;
  for (let b = 0; b < 0x7f800000; b += 4093) {
    const x = fromBits(b);
    worst = Math.max(worst, Math.abs(atan(x) - Math.atan(x)), Math.abs(atan(-x) - Math.atan(-x)));
  }
  assert.ok(worst < 1e-6, `largest error ${worst}`);
  assert.ok(Object.is(atan(-0), -0) && Object.is(atan(0), 0));
  assert.equal(atan(Infinity), f(Math.PI / 2));
  assert.ok(Math.abs(atan(1) - Math.PI / 4) < 1e-7);
});

test('the probe flags the ANGLE Direct3D 11 results and passes accurate ones', () => {
  const exact = new Float32Array(INVERSE_TRIG_PROBE.flatMap(([x, y, z]) => [Math.acos(x), Math.asin(x), Math.atan2(y, z), 0]));
  assert.ok(inverseTrigError(exact) < 1e-6);
  assert.ok(inverseTrigError(exact) <= INVERSE_TRIG_TOLERANCE);
  // The Radeon 680M's D3D11 compiler: acos(0) = 1.5707288 (raw WebGL2, docs/known-bugs.md).
  const d3d11 = exact.slice();
  const zero = INVERSE_TRIG_PROBE.findIndex(([x]) => x === 0);
  d3d11[zero * 4] = 1.5707288;
  assert.ok(inverseTrigError(d3d11) > INVERSE_TRIG_TOLERANCE);
  assert.ok(inverseTrigError(d3d11) < INVERSE_TRIG_IMPLAUSIBLE, 'a real driver error is flagged');
  // A stand-in context that draws nothing reads zeros: implausible, so it never changes the shaders.
  assert.ok(inverseTrigError(new Float32Array(INVERSE_TRIG_PROBE.length * 4)) >= INVERSE_TRIG_IMPLAUSIBLE);
  // The layer's own helpers pass their own probe.
  const own = new Float32Array(INVERSE_TRIG_PROBE.flatMap(([x, y, z]) => [acos(x), asin(x), atan2(y, z), 0]));
  assert.ok(inverseTrigError(own) <= INVERSE_TRIG_TOLERANCE);
  // An error just past the tolerance, and a NaN, are flagged.
  const off = exact.slice();
  off[4] += 2e-5;
  assert.ok(inverseTrigError(off) > INVERSE_TRIG_TOLERANCE);
  off[4] = NaN;
  assert.equal(inverseTrigError(off), Infinity);
});
