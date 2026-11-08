import test from 'node:test';
import assert from 'node:assert/strict';
import { Tonemap } from '../dist/index.js';
import { gpuHarness } from '../../../tests/support/postfx-gpu.js';

const code = (h) =>
  h.pipelines.filter((p) => p.fragment?.module.code.includes('fn sampleLUT')).at(-1).fragment.module.code;

test('reinhard, cineon and linear select codes 3, 4 and 5 in the classic variant, compiled only for them', () => {
  const h = gpuHarness(),
    effect = Tonemap.attach(h.engine, { curve: 'agx' });
  h.frame();
  const plain = code(h);
  assert.ok(!plain.includes('p.grade.z==3.0'), 'the built-in curves keep their shader');
  for (const [curve, n] of [
    ['reinhard', 3],
    ['cineon', 4],
    ['linear', 5],
  ]) {
    effect.options.curve = curve;
    h.frame();
    assert.equal(h.writes[2], n, curve);
    assert.ok(code(h).includes('color=hdr/(1.0+hdr);') && code(h).includes('vec3f(2.2)'));
  }
  const compiled = h.pipelines.length;
  effect.options.curve = 'reinhard';
  h.frame();
  assert.equal(h.pipelines.length, compiled, 'switching between classic curves compiles nothing');
  effect.options.curve = 'neutral';
  h.frame();
  assert.equal(code(h), plain, 'back to the plain shader');
  assert.equal(h.writes[2], 2);
  effect.options.curve = 'filmic';
  assert.throws(() => h.frame(), RangeError);
  effect.dispose();
});
