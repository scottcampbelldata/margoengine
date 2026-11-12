// The binary16 export rounding of src/device/half-export.ts, which no pipeline applies now (docs/known-bugs.md,
// environment fog-all row 28): these pin which outputs it rounds and the rounding the GLSL computes, step by step in
// float32. The GPU check features-browser.mjs halfExport now requires the layer to store what native stores.
import assert from 'node:assert/strict';
import test from 'node:test';
import { HALF_ROUND_GLSL, roundHalfExports } from '../dist/glsl.js';

const SOURCE = 'layout(location = 0) out highp vec4 _o0;\nvoid main() {\n  _o0 = vec4(1.0);\n}\n';

test('float outputs to 16-bit float and 8-bit or 10-bit UNORM targets round after main', () => {
  for (const format of ['rgba16float', 'rg16float', 'r16float', 'rgba8unorm', 'bgra8unorm', 'rgba8unorm-srgb', 'rgb10a2unorm']) {
    const out = roundHalfExports(SOURCE, [{ format }], [{ location: 0, kind: 'float', components: 4 }]);
    assert.ok(out.includes('void _margoHalfMain() {\n  _o0 = vec4(1.0);'), format);
    assert.ok(out.endsWith('\nvoid main() { _margoHalfMain(); _o0 = _margoHalf(_o0); }\n'), format);
    assert.equal(out.split('vec4 _margoHalf(vec4 v)').length, 2, format);
  }
});

test('narrower outputs widen to vec4 and take their own components back', () => {
  const source = 'void main() {\n}\n',
    outputs = [1, 2, 3].map((components, location) => ({ location, kind: 'float', components })),
    out = roundHalfExports(source, Array(3).fill({ format: 'rgba16float' }), outputs);
  assert.ok(
    out.includes('_o0 = _margoHalf(vec4(_o0)).x; _o1 = _margoHalf(vec4(_o1, 0.0, 0.0)).xy; _o2 = _margoHalf(vec4(_o2, 0.0)).xyz;'),
  );
});

test('32-bit float, integer, absent and unwritten targets are left alone', () => {
  const outputs = [{ location: 0, kind: 'float', components: 4 }];
  assert.equal(roundHalfExports(SOURCE, [{ format: 'rgba32float' }], outputs), SOURCE);
  assert.equal(roundHalfExports(SOURCE, [{ format: 'rgba16float' }], [{ location: 0, kind: 'uint', components: 4 }]), SOURCE);
  assert.equal(roundHalfExports(SOURCE, [null], outputs), SOURCE);
  assert.equal(roundHalfExports(SOURCE, [{ format: 'rgba16float' }], []), SOURCE);
  assert.equal(roundHalfExports(SOURCE, [{ format: 'rgba8uint' }], outputs), SOURCE);
});

// HALF_ROUND_GLSL, one component, in float32 (Math.fround after each operation, as the shader computes).
const f32 = new Float32Array(1),
  u32 = new Uint32Array(f32.buffer);
const bitsOf = (x) => ((f32[0] = x), u32[0]);
const fromBits = (b) => ((u32[0] = b >>> 0), f32[0]);
const roundEven = (x) => {
  const f = Math.floor(x),
    r = x - f;
  return r > 0.5 || (r === 0.5 && f % 2) ? f + 1 : f;
};
function shaderHalf(v) {
  const a = Math.abs(v),
    e = bitsOf(Math.max(a, 6.103515625e-5)) & 0x7f800000,
    r0 = Math.fround(Math.fround(roundEven(Math.fround(a * fromBits(0x84000000 - e)))) * fromBits(e - 0x05000000)),
    r = fromBits(bitsOf(r0) | (bitsOf(v) & 0x80000000));
  return a < 65520 ? r : v;
}
/** The nearest binary16, ties to even, by exhaustive search of the halves around v (independent of the shader's maths). */
function nearest(v) {
  const half = (h) => {
    const e = (h >> 10) & 31,
      m = h & 1023;
    return (h & 0x8000 ? -1 : 1) * (e ? (1 + m / 1024) * 2 ** (e - 15) : m * 2 ** -24);
  };
  let best = 0,
    bestError = Infinity;
  for (let h = 0; h < 0x7c00; h++)
    for (const s of [0, 0x8000]) {
      const d = Math.abs(half(h | s) - v);
      if (d < bestError || (d === bestError && !(h & 1) && (best & 1))) [best, bestError] = [h | s, d];
    }
  return half(best);
}

test('the shader rounding is the nearest binary16, ties to even, over normal, subnormal and edge values', () => {
  assert.ok(HALF_ROUND_GLSL.includes('roundEven(a * uintBitsToFloat(0x84000000u - e)) * uintBitsToFloat(e - 0x05000000u)'));
  const nudge = (x, d) => fromBits(bitsOf(x) + d);
  const values = [0, 3e-6, 6.1e-5, 6.103515625e-5, 1e-7, 2.9e-8, 3.1e-8, 65504, 65519, 1000.4, 1000.25, 1000.75];
  for (const g of [0.5, 1, 0.24609375, 0.75, 1000, 3.140625, 0.0204010009765625, 2, 2 ** -14, 2 ** -20]) {
    const mid = g + 2 ** (Math.floor(Math.log2(g)) - 11);
    values.push(nudge(g, -1), nudge(g, 1), g, mid, nudge(mid, 1), nudge(mid, -1));
  }
  for (let i = 0; i < 400; i++) values.push(Math.fround(Math.exp((i / 400) * 30 - 20)));
  for (const v of values.flatMap((x) => [Math.fround(x), -Math.fround(x)]))
    assert.ok(shaderHalf(v) === nearest(v), `${v}: shader ${shaderHalf(v)}, nearest ${nearest(v)}`);
  assert.equal(shaderHalf(Infinity), Infinity);
  assert.ok(Number.isNaN(shaderHalf(NaN)));
  assert.equal(shaderHalf(70000), 70000);
});
