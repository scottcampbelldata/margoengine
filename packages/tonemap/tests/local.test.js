import test from 'node:test';
import assert from 'node:assert/strict';
import { Tonemap } from '../dist/index.js';
import { LocalExposure } from '../dist/local.js';
import { gpuHarness } from '../../../tests/support/postfx-gpu.js';

const fragment = (h) =>
  h.pipelines.filter((p) => p.fragment?.module.code.includes('fn sampleLUT')).at(-1).fragment.module.code;

test('LocalExposure adds its stops after the exposure step and binds its base at 16', () => {
  const local = new LocalExposure(),
    h = gpuHarness(),
    effect = Tonemap.attach(h.engine, { extensions: [local] });
  h.frame();
  const code = fragment(h);
  assert.ok(code.includes('hdr=max(hdr,vec3f(0))*exp2(p.grade.x);hdr*=exp2(localStops(pos.xy,p.grade.x));'));
  assert.ok(code.includes('@group(0) @binding(16) var localBase:texture_2d<f32>;'));
  const entries = h.groups.at(-1).entries.map((e) => e.binding);
  assert.ok(entries.includes(5) && entries.includes(16), 'uniform and base bound');
  assert.deepEqual([...local.values()], [0.5, 3, 0, 0], 'strength and maxStops defaults');
  // Three quarter-resolution passes a frame, no new GPU objects on a steady frame.
  const before = { ...h.counts };
  h.frame();
  const plain = gpuHarness(),
    plainEffect = Tonemap.attach(plain.engine, {});
  plain.frame();
  const plainBefore = plain.counts.render;
  plain.frame();
  plainEffect.dispose();
  assert.equal(h.counts.render - before.render - (plain.counts.render - plainBefore), 3, 'three base passes a frame');
  assert.equal(h.counts.textures, before.textures);
  assert.equal(h.counts.groups, before.groups);
  effect.dispose();
  local.dispose();
  assert.ok(h.resources.every((r) => r.destroyed), 'every texture and buffer is freed');
});

test('LocalExposure follows the auto-exposure stops in the effects variant', () => {
  const local = new LocalExposure({ strength: 0.3 }),
    h = gpuHarness(),
    effect = Tonemap.attach(h.engine, { autoExposure: true, extensions: [local] });
  h.frame();
  assert.ok(fragment(h).includes('hdr*=exp2(localStops(pos.xy,p.grade.x+ae[0]));'));
  effect.dispose();
  local.dispose();
});

test('LocalExposure checks its options now and every frame', () => {
  for (const bad of [{ strength: 2 }, { maxStops: -1 }, { radius: 0.5 }, { edges: 0 }, { strength: NaN }])
    assert.throws(() => new LocalExposure(bad), RangeError, JSON.stringify(bad));
  const local = new LocalExposure();
  local.options.maxStops = 9;
  assert.throws(() => local.values(), RangeError);
  assert.throws(() => local.patch('no exposure here', 5, 16), RangeError);
});
