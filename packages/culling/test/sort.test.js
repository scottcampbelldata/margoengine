import test from 'node:test';
import assert from 'node:assert/strict';
import { FrontToBack, InstanceSorter, SortedInstances } from '../dist/sort.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { box, PbrMaterial } from '@margoengine/core';
const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function harness() {
  const h = optionalGPU();
  h.engine.gpu.createBindGroupLayout = (d) => d;
  h.engine.gpu.createPipelineLayout = (d) => d;
  h.context.camera.position = [0, 0, 10];
  h.context.camera.target = [0, 0, 0];
  return h;
}
test('network parameters have independent dynamic uniform slots and separate view resources', () => {
  const h = harness(),
    sorter = new InstanceSorter(),
    owner = {},
    input = h.engine.gpu.createBuffer({ size: 17 * 96, usage: 128 });
  const a = sorter.encode(h.context, owner, { instances: input, capacity: 17, count: 9, indexCount: 36 });
  assert.equal(a.instances.size, 17 * 96);
  assert.equal(new Uint32Array(a.args.data ?? new ArrayBuffer(20)).length, 5);
  const writes = h.bufferWrites.filter((w) => w.buffer.size > 256 && w.buffer.usage & 64);
  assert.equal(writes.length, 1);
  assert.ok(h.pipelines.some((p) => p.compute?.module.code.includes('a.index<b.index')));
  h.context.view = { id: 'other' };
  const b = sorter.encode(h.context, owner, { instances: input, capacity: 17, count: 9, indexCount: 36 });
  assert.notEqual(a.instances, b.instances);
  sorter.dispose();
  assert.ok(a.instances.destroyed);
  assert.ok(b.instances.destroyed);
  assert.throws(() => sorter.encode(h.context, owner, { instances: input, capacity: 17, count: 9, indexCount: 36 }), {
    code: 'disposed',
  });
});
test('invalid sort ranges reject before GPU allocation and zero capacity is supported', () => {
  const h = harness(),
    sorter = new InstanceSorter(),
    instances = { size: 96 };
  for (const capacity of [-1, 1.5, 4194305])
    assert.throws(() => sorter.encode(h.context, {}, { instances, capacity, count: 0, indexCount: 36 }), RangeError);
  assert.throws(() => sorter.encode(h.context, {}, { instances, capacity: 1, count: 2, indexCount: 36 }), RangeError);
  assert.throws(
    () => sorter.encode(h.context, {}, { instances, capacity: 1, count: 1, indexCount: 36, node: [NaN] }),
    TypeError,
  );
  const empty = sorter.encode(h.context, {}, { instances: { size: 16 }, capacity: 0, count: 0, indexCount: 0 });
  assert.equal(empty.instances.size, 96);
  sorter.dispose();
});
test('ordering is after culling, never changes transparent models, and restores redirected ownership', () => {
  const h = harness(),
    geometry = box(),
    source = h.engine.gpu.createBuffer({ size: 192, usage: 128 }),
    args = h.engine.gpu.createBuffer({ size: 20, usage: 128 | 4 }),
    previous = { instances: source, args },
    batch = { geometry, instances: new Float32Array(48), count: 2, redirect: previous };
  h.context.batches = [batch];
  h.engine.geometryBuffers = () => ({ instance: source });
  const opaque = {
      vertices: new Float32Array(20),
      indices: new Uint32Array([0, 0, 0]),
      node: { matrix: I },
      instances: { count: 1, capacity: 1, upload: () => source },
    },
    transparent = { ...opaque, material: { alphaMode: 'BLEND' } };
  const p = FrontToBack.attach(h.engine, { models: [{ primitives: [opaque, transparent] }] });
  assert.throws(() => p.add({}), TypeError);
  h.engine.frameGraph.execute(h.context);
  assert.notEqual(batch.redirect, previous);
  assert.ok(opaque.redirect);
  assert.equal(transparent.redirect, undefined);
  p.enabled = false;
  h.engine.frameGraph.execute(h.context);
  assert.equal(batch.redirect, previous);
  assert.equal(opaque.redirect, undefined);
  p.dispose();
  const staticParts = new SortedInstances([{ geometry, material: new PbrMaterial(), transforms: new Float32Array(I) }]);
  assert.equal(staticParts.sortEnabled, true);
  staticParts.dispose();
});

test('removed owners release every view and may later acquire fresh resources', () => {
  const h = harness(),
    sorter = new InstanceSorter(),
    owner = {},
    range = { instances: { size: 96 }, capacity: 1, count: 1, indexCount: 36 };
  const old = sorter.encode(h.context, owner, range);
  h.context.view = { id: 'two' };
  const other = sorter.encode(h.context, owner, range);
  sorter.forget(owner);
  assert.ok(old.instances.destroyed);
  assert.ok(other.instances.destroyed);
  const next = sorter.encode(h.context, owner, range);
  assert.notEqual(next.instances, other.instances);
  sorter.dispose();
});
