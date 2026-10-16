import test from 'node:test';
import assert from 'node:assert/strict';
import { Animation } from '../packages/animation/dist/index.js';
import { GLTFAsset } from '../packages/gltf-pro/dist/index.js';
import { animatedTriangle } from './support/gltf-pro-fixture.js';
import { optionalGPU } from './support/optional-gpu.js';

const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
function fixture(Type = Animation) {
  const h = optionalGPU(),
    doc = animatedTriangle();
  h.engine.store.transforms = Object.fromEntries(
    ['x', 'y', 'z', 'qx', 'qy', 'qz', 'qw', 'sx', 'sy', 'sz'].map((key) => [
      key,
      new Float32Array(2).fill(['qw', 'sx', 'sy', 'sz'].includes(key) ? 1 : 0),
    ]),
  );
  const nodes = [0, 1].map((id) => ({
    id,
    engine: h.engine,
    matrix: identity(),
    check() {},
    setPosition(v) {
      this.matrix[12] = v[0];
      return this;
    },
    setScale() {
      return this;
    },
    setQuaternion() {
      return this;
    },
  }));
  const primitive = {
    definition: doc.doc.meshes[0].primitives[0],
    nodeIndex: 0,
    node: nodes[0],
    vertices: new Float32Array(60),
    weights: new Float32Array([0]),
  };
  const model = {
    name: 'uploads',
    root: nodes[0],
    nodes,
    primitives: [primitive],
    asset: new GLTFAsset(doc.doc, doc.buffers),
    onDispose() {
      return () => {};
    },
  };
  const animation = new Type(model);
  animation.playing = false;
  h.engine.use(animation);
  const record = animation.resources[0],
    writes = [],
    write = h.engine.gpu.queue.writeBuffer;
  h.engine.gpu.queue.writeBuffer = (buffer, offset, value) => {
    if (!ArrayBuffer.isView(value)) throw new TypeError('GPUBufferSource required');
    writes.push({ buffer, bytes: value.byteLength });
    return write(buffer, offset, value);
  };
  return { ...h, animation, record, nodes, primitive, writes };
}
test('identical palettes and morph weights upload once while every render still dispatches', (t) => {
  const f = fixture();
  t.after(() => f.animation.dispose());
  const output = f.primitive.deformed;
  f.frame();
  assert.equal(f.writes.length, 2);
  for (let i = 0; i < 300; i++) f.frame();
  assert.equal(f.writes.length, 2);
  assert.equal(f.counts.compute, 301);
  assert.equal(f.primitive.deformed, output);
});
test('joint, mesh, replacement view and signed-zero weight edits invalidate exact GPU inputs', (t) => {
  const f = fixture();
  t.after(() => f.animation.dispose());
  f.frame();
  f.writes.length = 0;
  f.nodes[1].matrix[12] = 0.25;
  f.frame();
  assert.deepEqual(
    f.writes.map((w) => w.buffer),
    [f.record.bones],
  );
  f.writes.length = 0;
  f.nodes[0].matrix[13] = 0.125;
  f.frame();
  assert.deepEqual(
    f.writes.map((w) => w.buffer),
    [f.record.bones],
  );
  f.writes.length = 0;
  f.primitive.weights[0] = -0;
  f.frame();
  assert.deepEqual(
    f.writes.map((w) => w.buffer),
    [f.record.weights],
  );
  f.writes.length = 0;
  f.frame();
  assert.equal(f.writes.length, 0);
  f.primitive.weights = new Float32Array([-0]);
  f.nodes[1].matrix = new Float32Array(f.nodes[1].matrix);
  f.frame();
  assert.equal(f.writes.length, 0);
  f.primitive.weights[0] = 0;
  f.frame();
  assert.deepEqual(
    f.writes.map((w) => w.buffer),
    [f.record.weights],
  );
  f.writes.length = 0;
  f.primitive.weights[0] = 0.5;
  f.frame();
  assert.deepEqual(
    f.writes.map((w) => w.buffer),
    [f.record.weights],
  );
});
test('palette uploads distinguish signed-zero bit patterns', (t) => {
  const f = fixture();
  t.after(() => f.animation.dispose());
  f.nodes[1].matrix.fill(-0);
  f.frame();
  assert.ok(f.record.paletteBits.some((value) => value === 0x80000000));
  f.writes.length = 0;
  f.nodes[1].matrix.fill(0);
  f.frame();
  assert.deepEqual(
    f.writes.map((w) => w.buffer),
    [f.record.bones],
  );
  assert.deepEqual(new Uint32Array(f.record.bones.data), f.record.paletteBits);
});
test('length-tracking weight views repair the normal cache after buffer growth and shrink', (t) => {
  const f = fixture();
  t.after(() => f.animation.dispose());
  const buffer = new ArrayBuffer(4, { maxByteLength: 16 });
  f.primitive.weights = new Float32Array(buffer);
  f.primitive.weights[0] = 0.25;
  f.frame();
  f.writes.length = 0;
  f.frame();
  assert.equal(f.writes.length, 0);
  buffer.resize(8);
  f.primitive.weights[1] = 0.5;
  f.frame();
  f.frame();
  assert.equal(f.writes.length, 2);
  buffer.resize(4);
  f.writes.length = 0;
  f.frame();
  assert.equal(f.writes.length, 1);
  f.writes.length = 0;
  f.frame();
  assert.equal(f.writes.length, 0);
});
test('empty and detached weight views retain the original no-upload behavior', (t) => {
  const f = fixture();
  t.after(() => f.animation.dispose());
  f.frame();
  f.writes.length = 0;
  const original = f.primitive.weights;
  structuredClone(original.buffer, { transfer: [original.buffer] });
  f.frame();
  assert.equal(f.writes.length, 0);
  f.primitive.weights = new Float32Array();
  f.frame();
  assert.equal(f.writes.length, 0);
  f.primitive.weights = new Float32Array([0]);
  f.frame();
  assert.equal(f.writes.length, 0);
});
test('shared-memory weights always upload so concurrent edits cannot invalidate a cached snapshot', (t) => {
  const f = fixture();
  t.after(() => f.animation.dispose());
  f.primitive.weights = new Float32Array(new SharedArrayBuffer(4));
  f.frame();
  f.writes.length = 0;
  f.frame();
  assert.deepEqual(
    f.writes.map((w) => w.buffer),
    [f.record.weights],
  );
  f.primitive.weights[0] = 0.5;
  f.writes.length = 0;
  f.frame();
  assert.deepEqual(
    f.writes.map((w) => w.buffer),
    [f.record.weights],
  );
  f.primitive.weights = new Float32Array([0]);
  f.writes.length = 0;
  f.frame();
  assert.deepEqual(
    f.writes.map((w) => w.buffer),
    [f.record.weights],
  );
  f.writes.length = 0;
  f.frame();
  assert.equal(f.writes.length, 0);
});
test('non-finite weights, singular meshes and Float32 palette overflow remain guarded on cache hits', (t) => {
  const f = fixture();
  t.after(() => f.animation.dispose());
  f.frame();
  f.writes.length = 0;
  const before = f.counts.compute;
  f.primitive.weights[0] = NaN;
  assert.throws(() => f.frame(), /Invalid morph weights/);
  assert.equal(f.counts.compute, before);
  assert.equal(f.writes.length, 0);
  f.primitive.weights[0] = 0;
  f.nodes[0].matrix.fill(0);
  assert.throws(() => f.frame(), /Singular skinned mesh transform/);
  assert.equal(f.counts.compute, before);
  assert.equal(f.writes.length, 0);
  f.nodes[0].matrix.set(identity());
  f.nodes[1].matrix[0] = 3e38;
  f.record.inverseBind[0][0] = 2;
  assert.throws(() => f.frame(), /Skin matrix overflow/);
  assert.equal(f.counts.compute, before);
  assert.equal(f.writes.length, 0);
  f.nodes[1].matrix[0] = 1;
  f.record.inverseBind[0][0] = 1;
  f.frame();
  assert.equal(f.counts.compute, before + 1);
  assert.equal(f.writes.length, 0);
});
test('failed native uploads remain dirty and retry without suppressing the dispatch', (t) => {
  const f = fixture();
  t.after(() => f.animation.dispose());
  f.frame();
  const original = f.engine.gpu.queue.writeBuffer;
  for (const [buffer, edit] of [
    [
      f.record.bones,
      () => {
        f.nodes[1].matrix[12] += 0.1;
      },
    ],
    [
      f.record.weights,
      () => {
        f.primitive.weights[0] += 0.1;
      },
    ],
  ]) {
    edit();
    const before = f.counts.compute;
    f.engine.gpu.queue.writeBuffer = (target, offset, value) => {
      if (target === buffer) throw new Error('upload failed');
      return original(target, offset, value);
    };
    assert.throws(() => f.frame(), /upload failed/);
    assert.equal(f.counts.compute, before);
    f.engine.gpu.queue.writeBuffer = original;
    f.writes.length = 0;
    f.frame();
    assert.ok(f.writes.some((w) => w.buffer === buffer));
    assert.equal(f.counts.compute, before + 1);
    f.writes.length = 0;
    f.frame();
    assert.equal(f.writes.length, 0);
  }
});
test('changed weight types and lengths preserve the original upload path and cannot leave a stale cache', (t) => {
  const f = fixture();
  t.after(() => f.animation.dispose());
  f.frame();
  f.writes.length = 0;
  for (const values of [new Float32Array([0.25, 0.5]), new Float64Array([0.75])]) {
    f.primitive.weights = values;
    f.frame();
    f.frame();
    assert.equal(f.writes.length, 2);
    assert.ok(f.writes.every((w) => w.buffer === f.record.weights));
    f.writes.length = 0;
  }
  f.primitive.weights = [0.5];
  assert.throws(() => f.frame(), TypeError);
  f.primitive.weights = new Float32Array([0]);
  f.writes.length = 0;
  f.frame();
  assert.deepEqual(
    f.writes.map((w) => w.buffer),
    [f.record.weights],
  );
  f.writes.length = 0;
  f.frame();
  assert.equal(f.writes.length, 0);
});
test('device restoration creates fresh upload state and disposal releases the shared output', (t) => {
  const f = fixture();
  t.after(() => f.animation.dispose());
  f.frame();
  const old = f.primitive.deformed,
    resources = f.resources.slice();
  f.animation.onDeviceRestored(f.engine);
  assert.ok(resources.every((r) => r.destroyed));
  assert.notEqual(f.primitive.deformed, old);
  f.writes.length = 0;
  f.frame();
  assert.equal(f.writes.length, 2);
  f.writes.length = 0;
  f.frame();
  assert.equal(f.writes.length, 0);
  f.animation.dispose();
  assert.equal(f.primitive.deformed, undefined);
  assert.ok(f.resources.every((r) => r.destroyed));
});
test('queued uploads remain reusable after a later graph pass throws, while deformation is encoded again', (t) => {
  const f = fixture();
  t.after(() => f.animation.dispose());
  f.frame();
  f.nodes[1].matrix[12] = 0.4;
  f.writes.length = 0;
  const remove = f.engine.frameGraph.add({
      name: 'later-failure',
      order: -5,
      execute() {
        throw new Error('later pass');
      },
    }),
    before = f.counts.compute;
  assert.throws(() => f.frame(), /later pass/);
  assert.equal(f.counts.compute, before + 1);
  assert.equal(f.writes.length, 1);
  remove();
  f.writes.length = 0;
  f.frame();
  assert.equal(f.writes.length, 0);
  assert.equal(f.counts.compute, before + 2);
});
test('moving and held poses always leave GPU input bytes equal to the current palette and morph weights', (t) => {
  const b = fixture();
  t.after(() => b.animation.dispose());
  for (let i = 0; i < 1000; i++) {
    if (i % 7 === 0) {
      b.nodes[1].matrix[12] = Math.sin(i * 0.17) * 0.25;
      b.nodes[1].matrix[0] = Math.cos(i * 0.11) * 0.1 + 1;
    }
    if (i % 11 === 0) b.nodes[0].matrix[13] = Math.sin(i * 0.03) * 0.12;
    if (i % 5 === 0) b.primitive.weights[0] = Math.sin(i * 0.05) * 0.5;
    if (i % 101 === 0) b.nodes[1].matrix = new Float32Array(b.nodes[1].matrix);
    if (i % 103 === 0) b.primitive.weights = new Float32Array(b.primitive.weights);
    b.frame();
    assert.deepEqual(new Uint8Array(b.record.bones.data), new Uint8Array(b.record.palette.buffer));
    assert.deepEqual(new Float32Array(b.record.weights.data)[0], b.primitive.weights[0]);
  }
  assert.equal(b.counts.compute, 1000);
  assert.ok(b.writes.length < 1000);
});
