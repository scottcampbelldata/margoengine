import test from 'node:test';
import assert from 'node:assert/strict';
import { Animation } from '../packages/animation/dist/index.js';
import { GLTFAsset } from '../packages/gltf-pro/dist/index.js';
import { animatedTriangle } from './support/gltf-pro-fixture.js';
import { optionalGPU } from './support/optional-gpu.js';

test('animation retains inverse bind views through 120 moving frames and recreates resources after restoration', () => {
  const h = optionalGPU(),
    fixture = animatedTriangle(),
    identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const transforms = (h.engine.store.transforms = Object.fromEntries(
    ['x', 'y', 'z', 'qx', 'qy', 'qz', 'qw', 'sx', 'sy', 'sz'].map((name) => [
      name,
      new Float32Array(2).fill(['qw', 'sx', 'sy', 'sz'].includes(name) ? 1 : 0),
    ]),
  ));
  const nodes = [0, 1].map((id) => ({
    id,
    engine: h.engine,
    matrix: identity.slice(),
    check() {},
    setPosition(value) {
      this.matrix[12] = value[0];
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
    definition: fixture.doc.meshes[0].primitives[0],
    nodeIndex: 0,
    node: nodes[0],
    vertices: new Float32Array(60),
    weights: new Float32Array([0]),
  };
  const model = {
    name: 'moving',
    root: nodes[0],
    nodes,
    primitives: [primitive],
    asset: new GLTFAsset(fixture.doc, fixture.buffers),
    onDispose() {
      return () => {};
    },
  };
  const animation = new Animation(model);
  h.engine.use(animation);
  const writes = [],
    write = h.engine.gpu.queue.writeBuffer;
  h.engine.gpu.queue.writeBuffer = (buffer, offset, value) => {
    if (value.length === 16) writes.push(value.slice());
    write(buffer, offset, value);
  };
  const subarray = Float32Array.prototype.subarray;
  let views = 0;
  try {
    Float32Array.prototype.subarray = function (...args) {
      if (this.length === 16) views++;
      return subarray.apply(this, args);
    };
    for (let i = 0; i < 120; i++) h.frame();
  } finally {
    Float32Array.prototype.subarray = subarray;
  }
  try {
    assert.equal(views, 0, 'Inverse bind views must survive between deformation frames');
    assert.equal(h.counts.compute, 120);
    assert.equal(writes.length, 120);
    let time = 0;
    for (let i = 0; i < 120; i++) {
      time += 0.1;
      const expected = identity.slice();
      expected[12] = (time % 1) * Math.fround(0.4);
      assert.deepEqual(writes[i], expected);
    }
    assert.equal(transforms.sx[0], 1);
    const old = h.resources.slice();
    animation.onDeviceRestored(h.engine);
    assert.ok(old.every((r) => r.destroyed));
    h.frame();
    assert.equal(h.counts.compute, 121);
    primitive.weights[0] = NaN;
    assert.throws(() => h.frame(), /Invalid morph weights/);
    assert.equal(h.counts.compute, 121);
    primitive.weights[0] = 0;
    nodes[1].matrix[0] = 3e38;
    animation.resources[0].inverseBind[0][0] = 2;
    assert.throws(() => h.frame(), /Skin matrix overflow/);
    assert.equal(h.counts.compute, 121, 'Overflow cannot submit a deformation dispatch');
  } finally {
    animation.dispose();
  }
  assert.equal(primitive.deformed, undefined);
  assert.ok(h.resources.every((r) => r.destroyed));
});
