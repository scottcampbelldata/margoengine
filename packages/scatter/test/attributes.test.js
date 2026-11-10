import test from 'node:test';
import assert from 'node:assert/strict';
import { PbrMaterial } from '@margoengine/core';
import { AttributedScatter } from '../dist/attributes.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { wgsl } from '../../core/src/shaders.ts';

const batch = () => ({
  name: 'test',
  vertices: new Float32Array(60),
  indices: new Uint32Array([0, 1, 2]),
  transforms: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  material: new PbrMaterial(),
  colors: new Float32Array([0.2, 0.3, 0.4]),
  attributes: { offset: new Float32Array([1, 2, 3]) },
});
test('live colour and custom values upload only their row, preserve caller input and survive device restoration', () => {
  const h = optionalGPU();
  h.context.shader = wgsl;
  h.engine.lighting = { direction: new Float32Array([1, 1, 0, 1]), radiance: new Float32Array([1, 1, 1, 1]) };
  const b = batch(),
    s = new AttributedScatter(() => [b], { attributes: { offset: 3 } });
  h.engine.use(s);
  h.frame();
  const resources = h.resources.length,
    colour = [0.5, 0.25, 0.75];
  s.setColorAt(0, colour).setAttributeAt(0, 'offset', [4, 5, 6]);
  h.frame();
  assert.equal(h.resources.length, resources);
  assert.deepEqual([...s.getColorAt(0)], colour);
  assert.deepEqual([...s.getAttributeAt(0, 'offset')], [4, 5, 6]);
  assert.deepEqual([...b.attributes.offset], [1, 2, 3]);
  assert.equal(h.bufferWrites.at(-1).bytes, 144, 'frame only updates its uniform');
  const v = s.attributeValues[0];
  assert.deepEqual([...new Float32Array(v.buffer.data).slice(0, 8)], [...colour, 1, 4, 5, 6, 0]);
  const copy = s.getColorAt(0);
  copy.fill(0);
  assert.deepEqual([...s.getColorAt(0)], colour);
  for (const bad of [
    [NaN, 0, 0],
    [-1, 0, 0],
    [1e40, 0, 0],
    [1, 2],
  ])
    assert.throws(() => s.setColorAt(0, bad), RangeError);
  assert.throws(() => s.setColorAt(1, [1, 1, 1]), RangeError);
  assert.throws(() => s.setAttributeAt(0, 'missing', [0]), RangeError);
  s.onDeviceRestored(h.engine);
  h.frame();
  assert.deepEqual([...s.getColorAt(0)], colour);
  assert.deepEqual([...s.getAttributeAt(0, 'offset')], [4, 5, 6]);
  s.dispose();
  assert.throws(() => s.setColorAt(0, colour), /disposed/);
  assert.ok(h.resources.every((r) => r.destroyed));
});
test('attribute setup validates complete data and device limits, releasing every partial allocation', () => {
  for (const edit of [
    (b) => (b.colors = new Float32Array([NaN, 0, 0])),
    (b) => (b.attributes.offset = new Float32Array([1, 2])),
    (b) => (b.attributes.other = new Float32Array([1])),
  ]) {
    const h = optionalGPU(),
      b = batch();
    edit(b);
    const s = new AttributedScatter(() => [b], { attributes: { offset: 3 } });
    assert.throws(() => h.engine.use(s), RangeError);
    assert.ok(h.resources.every((r) => r.destroyed));
  }
  assert.throws(() => new AttributedScatter(() => [], { attributes: { x: 0 } }), RangeError);
  assert.throws(() => new AttributedScatter(() => [], { shader: 'bad' }), TypeError);
});
