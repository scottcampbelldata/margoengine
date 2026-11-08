import test from 'node:test';
import assert from 'node:assert/strict';
import { Tonemap } from '../dist/index.js';
import { CustomCurve } from '../dist/custom.js';
import { gpuHarness } from '../../../tests/support/postfx-gpu.js';

const fragment = (h) => h.pipelines.filter((p) => p.fragment?.module.code.includes('fn sampleLUT')).at(-1).fragment.module.code;

test('CustomCurve with WGSL calls your function after the built-in curve, before contrast, and binds params', () => {
  const custom = new CustomCurve({
      wgsl: 'fn film(x: vec3f) -> vec3f { return x / (x + vec3f(curveParams[0].x)); }',
      params: [0.6],
    }),
    h = gpuHarness(),
    effect = Tonemap.attach(h.engine, { curve: 'reinhard', extensions: [custom] });
  h.frame();
  const code = fragment(h);
  assert.ok(code.includes('fn film(x: vec3f) -> vec3f { return x / (x + vec3f(customCurveData.params[0].x)); }'));
  assert.ok(code.indexOf('color=customCurve(hdr);') > code.indexOf('color=agx(hdr);}'), 'after the curve choice');
  assert.ok(code.indexOf('color=customCurve(hdr);') < code.indexOf('color=clamp((color-0.18)*p.grade.y'));
  assert.ok(code.includes('fn customCurve(x:vec3f)->vec3f {return film(x);}'));
  assert.ok(code.includes('@group(0) @binding(5) var<uniform> customCurveData:CustomCurve;'));
  assert.ok(h.groups.at(-1).entries.some((e) => e.binding === 5));
  assert.equal(custom.values()[0], Math.fround(0.6));
  assert.equal(custom.values().byteLength, 592, 'params (64 B) plus 33 vec4f of samples');
  // Live params need no new pipeline; a new WGSL string does.
  const pipelines = h.pipelines.length;
  custom.options.params = [0.8];
  h.frame();
  assert.equal(h.pipelines.length, pipelines);
  custom.options.wgsl = 'fn film(x: vec3f) -> vec3f { return min(x, vec3f(1.0)); }';
  h.frame();
  assert.ok(h.pipelines.length > pipelines);
  assert.ok(fragment(h).includes('return min(x, vec3f(1.0));'));
  effect.dispose();
});

test('CustomCurve with a JavaScript curve samples it in log2 from 2^-12 to 2^8 plus its value at 0', () => {
  const custom = new CustomCurve({ curve: (x) => x / (1 + x) }),
    v = custom.values();
  for (const i of [0, 40, 77, 127]) {
    const x = 2 ** (-12 + (20 * i) / 127);
    assert.ok(Math.abs(v[16 + i] - x / (1 + x)) < 1e-6, `sample ${i}`);
  }
  assert.equal(v[16 + 128], 0, 'value at 0');
  const h = gpuHarness(),
    effect = Tonemap.attach(h.engine, { extensions: [custom] });
  h.frame();
  assert.ok(fragment(h).includes('return vec3f(customSample(x.r),customSample(x.g),customSample(x.b));'));
  effect.dispose();
});

test('CustomCurve checks its options now and every frame', () => {
  for (const bad of [
    {},
    { wgsl: 'fn a(x: vec3f) -> vec3f { return x; }', curve: (x) => x },
    { wgsl: 'fn a(x: f32) -> f32 { return x; }' },
    { wgsl: 'let a = 1;' },
    { curve: 1 },
    { curve: (x) => x, params: Array(17).fill(0) },
    { curve: (x) => x, params: [NaN] },
  ])
    assert.throws(() => new CustomCurve(bad), RangeError);
  assert.throws(() => new CustomCurve({ curve: () => -1 }).values(), RangeError);
  assert.throws(() => new CustomCurve({ curve: () => NaN }).values(), RangeError);
  const taken = new CustomCurve({ wgsl: 'fn agx(x: vec3f) -> vec3f { return x; }' });
  assert.throws(() => taken.patch('fn agx(v:vec3f)->vec3f {return v;}', 5), RangeError);
  const custom = new CustomCurve({ curve: (x) => x });
  custom.options.wgsl = 'fn b(x: vec3f) -> vec3f { return x; }';
  assert.throws(() => custom.values(), RangeError);
});
