// Batch 161 job 2: the skinned primitives of one node share one bone range, so the palette is computed, checked,
// encoded and uploaded once per node and skin. RobotExpressive has two skinned nodes of two primitives each.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { invertMatrixStable, multiplyMatrices } from '@margoengine/math/mat4';
import { Animation } from '../dist/index.js';
import { dualQuaternionSkinning } from '../dist/dqs.js';
import { model } from './support/models.js';
import { animatorGLB } from '../../../tests/support/animator-rig.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const robot = new URL('../../../examples/assets/robot-expressive.glb', import.meta.url);

async function gpuEngine(t) {
  const gpu = optionalGPU(),
    store = await TransformStore.create(256),
    e = new Engine(
      { width: 8, height: 8, clientWidth: 8, clientHeight: 8 },
      store,
      { backend: 'webgpu', gpu: gpu.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 4], target: [0, 0, 0] },
      null,
    );
  t.after(() => {
    e.dispose();
    gpu.cleanup();
  });
  return { e, gpu, store, device: gpu.engine.gpu };
}
/** The palette the parent commit uploaded for one primitive: inverse(node) x joint x inverse bind, then the encoding. */
function reference(animation, r) {
  const inverse = new Float32Array(16),
    joint = new Float32Array(16),
    product = new Float32Array(16),
    palette = new Float32Array(r.joints.length * 16);
  assert.ok(invertMatrixStable(r.primitive.node.matrix, inverse, new Float64Array(52)));
  for (let i = 0; i < r.joints.length; i++) {
    multiplyMatrices(animation.model.nodes[r.joints[i]].matrix, r.inverseBind.subarray(i * 16, i * 16 + 16), joint);
    multiplyMatrices(inverse, joint, product);
    palette.set(product, i * 16);
  }
  animation.options.skinning?.encode(palette);
  return new Uint8Array(palette.buffer);
}

for (const [mode, options] of [
  ['linear', {}],
  ['dual quaternion', { skinning: dualQuaternionSkinning }],
])
  test(`RobotExpressive uploads one ${mode} palette per skinned node, with each primitive's parent bytes`, async (t) => {
    const { e, store, device } = await gpuEngine(t),
      m = model(e, animatorGLB(robot));
    e.use(m);
    const a = Animation.attach(m, options);
    a.play('Walking');
    a.seek(0.4);
    store.tick(false);
    const skinned = a['resources'].filter((r) => r.joints.length);
    assert.equal(skinned.length, 4, 'four skinned primitives');
    const nodes = new Set(skinned.map((r) => r.primitive.node));
    assert.equal(nodes.size, 2, 'on two skinned nodes');
    const bones = skinned[0].slot.page.bones.buffer,
      writes = [],
      writeBuffer = device.queue.writeBuffer;
    device.queue.writeBuffer = function (buffer, offset, data, ...rest) {
      if (buffer === bones) writes.push(data.byteLength);
      return writeBuffer.call(this, buffer, offset, data, ...rest);
    };
    t.after(() => {
      device.queue.writeBuffer = writeBuffer;
    });
    const context = { backend: 'webgpu', device, encoder: device.createCommandEncoder() };
    for (let frame = 0; frame < 3; frame++) {
      writes.length = 0;
      a.seek(0.4 + frame * 0.1);
      store.tick(false);
      assert.ok(a['upload'](context));
      // Job 2 made it one palette per node (2 writes, parent 4); job 3 writes the two contiguous palettes at once.
      assert.equal(writes.length, 1, `frame ${frame}: bone writes`);
      assert.equal(
        writes.reduce((sum, n) => sum + n, 0),
        [...nodes].reduce((sum, node) => sum + skinned.find((r) => r.primitive.node === node).joints.length * 64, 0),
        'bone bytes: one palette per node',
      );
      for (const r of skinned) {
        const bytes = new Uint8Array(bones.data, r.slot.bones.offset * 64, r.joints.length * 64);
        assert.deepEqual(bytes, reference(a, r), `${mode} palette of a primitive of node ${r.primitive.node.name}`);
      }
    }
    for (const node of nodes) {
      const ranges = skinned.filter((r) => r.primitive.node === node).map((r) => r.slot.bones);
      assert.equal(ranges[0], ranges[1], 'the primitives of one node name one bone range');
      assert.equal(ranges[0].offset, ranges[1].offset);
    }
    // Disposing one Animation frees the shared range once; another copy places and fills its own.
    const b = Animation.attach(model(e, animatorGLB(robot)), options);
    a.dispose();
    const left = b['resources'].filter((r) => r.joints.length);
    assert.equal(new Set(left.map((r) => r.slot.bones)).size, 2);
    for (const r of left) assert.ok(r.slot.page.bones.ranges.has(r.slot.bones), 'live range kept in its pool');
    b.dispose();
  });
