import assert from 'node:assert/strict';
import test from 'node:test';
import {
  studioPresets,
  studioPreset,
  PreviewBudget,
  diffuse,
  metal,
  emit,
  paletteFromMaterials,
} from '../dist/studio.js';

test('studio presets include product and outdoor', () => {
  const ids = studioPresets().map((p) => p.id);
  assert.ok(ids.includes('product'));
  assert.ok(ids.includes('outdoor-day'));
  const product = studioPreset('product');
  assert.ok(product);
  assert.equal(product.label, 'Product');
  for (const p of studioPresets()) assert.ok(p.environment.sunIntensity > 0, `${p.id} lights the scene with its sun`);
  studioPreset('product').environment.sunColor[0] = 0;
  assert.equal(studioPreset('product').environment.sunColor[0], 1, 'each call returns new objects');
});

test('preview budget ramps after idle frames', () => {
  const b = new PreviewBudget({ dirtySamples: 2, idleSamples: 32, idleFrames: 3 });
  b.markDirty();
  assert.equal(b.tick(), 2);
  assert.equal(b.tick(), 2);
  assert.equal(b.tick(), 2);
  assert.equal(b.tick(), 32);
  assert.equal(b.isIdle, true);
  b.markDirty();
  assert.equal(b.isIdle, false);
  assert.equal(b.tick(), 2);
  for (const bad of [{ dirtySamples: 0 }, { idleSamples: 1.5 }, { idleFrames: -1 }])
    assert.throws(() => new PreviewBudget(bad), RangeError);
});

test('material builders set type and id', () => {
  const d = diffuse(1, [1, 0, 0]);
  assert.equal(d.type, 'diffuse');
  assert.equal(d.id, 1);
  const m = metal(2, [0.8, 0.8, 0.8], 0.1);
  assert.equal(m.type, 'metal');
  assert.equal(m.roughness, 0.1);
  const e = emit(3, [1, 0.5, 0], 8);
  assert.equal(e.emission, 8);
});

test('paletteFromMaterials rejects duplicates', () => {
  assert.throws(() => paletteFromMaterials([diffuse(1, [1, 0, 0]), metal(1, [0, 1, 0])]), RangeError);
  const ok = paletteFromMaterials([diffuse(1, [1, 0, 0]), metal(2, [0, 1, 0])]);
  assert.equal(ok.length, 2);
});
