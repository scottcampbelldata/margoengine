import test from 'node:test';
import assert from 'node:assert/strict';
import { TexturedScatter } from '../dist/textured.js';
import { PBRInstances } from '../../gltf-pro/dist/instancing.js';
import { parseGLTF } from '../../gltf-pro/dist/model-entry.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { mockGPU } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { animatedTriangle } from '../../../tests/support/gltf-pro-fixture.js';
import { multiplyMatrices } from '@margoengine/math/mat4';

const identity = (x = 0, y = 0, z = 0) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
async function fixture() {
  const gpu = mockGPU(),
    store = await TransformStore.create(64);
  const engine = new Engine(
    { width: 128, height: 128, clientWidth: 128, clientHeight: 128 },
    store,
    { backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 8], target: [0, 0, 0] },
    null,
  );
  const { doc, buffers } = animatedTriangle();
  delete doc.skins;
  delete doc.animations;
  delete doc.nodes[0].skin;
  delete doc.meshes[0].primitives[0].targets;
  delete doc.meshes[0].weights;
  doc.nodes = [
    { translation: [1, 2, 0], children: [1] },
    { mesh: 0, translation: [2, 0, 0], scale: [1.3, 0.7, 2.1] },
    { mesh: 0, translation: [-2, 0, 0] },
  ];
  doc.materials[0].alphaMode = 'MASK';
  const model = parseGLTF(engine, doc, buffers);
  return { engine, model, gpu };
}
const near = (a, b) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-5, `${i}: ${v} vs ${b[i]}`));

test('textured scatter copies complete multi-node plants in root space and restores ownership', async () => {
  const { engine, model } = await fixture();
  model.root.setPosition([10, 0, 0]);
  const before = (model.primitives[0].material.renderState = { depthWrite: true });
  const scatter = TexturedScatter.attach(engine, model, new Float32Array([...identity(-4), ...identity(4)]));
  const root = model.root.matrix;
  for (const p of model.primitives) {
    assert.equal(p.instances.count, 2);
    for (let i = 0; i < 2; i++) {
      const actual = multiplyMatrices(p.node.matrix, p.instances.getMatrixAt(i));
      const expected = p.node.matrix.slice();
      expected[12] += i ? 4 : -4;
      near(actual, expected);
    }
    assert.equal(p.material.renderState.alphaToCoverage, true);
    assert.equal(p.material.renderState.depthWrite, true);
  }
  assert.equal(root[12], 10);
  scatter.setMatrixAt(1, identity(0, 5));
  assert.equal(scatter.getMatrixAt(1)[13], 5);
  assert.throws(() => scatter.setMatrixAt(2, identity()), RangeError);
  assert.throws(() => scatter.setMatrixAt(0, new Float32Array(16)), TypeError);
  assert.throws(() => TexturedScatter.attach(engine, model, identity()), /live model/);
  scatter.dispose();
  scatter.dispose();
  assert.equal(model.primitives[0].material.renderState, before);
  assert.equal(model.primitives[0].instances, undefined);
  assert.equal(model.disposed, false);
  assert.throws(() => scatter.setMatrixAt(0, identity()), /new TexturedScatter/);
  model.dispose();
  engine.dispose();
});

test('textured scatter preserves embedded instances, tints and UVs, and rejects bad input atomically', async () => {
  const { engine, model } = await fixture();
  const original = new PBRInstances(2).setMatrixAt(0, identity(1)).setMatrixAt(1, identity(-1));
  original.setColorAt(1, [0.2, 0.4, 0.6]).setUVTransformAt(1, { scale: [0.5, 0.5], offset: [0.5, 0] });
  model.primitives[0].instances = original;
  const bad = identity();
  bad[0] = NaN;
  assert.throws(() => TexturedScatter.attach(engine, model, bad), RangeError);
  assert.equal(model.primitives[0].instances, original);
  const scatter = TexturedScatter.attach(engine, model, new Float32Array([...identity(-3), ...identity(3)]));
  const rows = model.primitives[0].instances;
  assert.equal(rows.count, 4);
  assert.deepEqual([...rows.data.subarray(3 * 24 + 16, 4 * 24)], [...original.data.subarray(40, 48)]);
  scatter.setMatrixAt(0, identity(0, 2));
  for (let i = 0; i < 2; i++) {
    const node = model.primitives[0].node.matrix;
    assert.ok(Math.abs(multiplyMatrices(node, rows.getMatrixAt(i))[13] - node[13] - 2) < 1e-6);
  }
  scatter.dispose();
  assert.equal(model.primitives[0].instances, original);
  const empty = TexturedScatter.attach(engine, model, new Float32Array());
  assert.ok(model.primitives.every((p) => p.instances.count === 0));
  empty.dispose();
  model.dispose();
  engine.dispose();
});
