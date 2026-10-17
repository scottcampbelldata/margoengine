import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { Material, createMesh } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

test('Material raster controls default to the original pipeline and validate inactive options', () => {
  const m = new Material();
  assert.equal(m.customState, false);
  assert.equal(m.colorWrite, true);
  assert.equal(m.polygonOffset, false);
  assert.equal(m.stencilWrite, false);
  assert.equal(m.stencilRef, 0);
  assert.equal(m.stencilReadMask, 255);
  assert.equal(m.stencilWriteMask, 255);
  for (const options of [
    { colorWrite: 1 },
    { polygonOffset: 1 },
    { stencilWrite: 1 },
    { polygonOffsetFactor: Infinity },
    { polygonOffsetFactor: null },
    { polygonOffsetClamp: 1e50 },
    { polygonOffsetUnits: 0.25 },
    { polygonOffsetUnits: -2147483648 },
    { stencilRef: -1 },
    { stencilRef: null },
    { stencilReadMask: 1.5 },
    { stencilWriteMask: 0x100000000 },
    { stencilFunc: 'lesser' },
    { stencilFail: 'increment' },
    { stencilZFail: null },
    { stencilZPass: 'replace-with-reference' },
  ])
    assert.throws(() => new Material(options), /material/i);
  const inactive = new Material({ polygonOffsetFactor: 2, stencilFunc: 'equal', stencilRef: 3 });
  assert.equal(inactive.customState, false);
});

test('raster argument errors distinguish types from numeric ranges and name the fix', () => {
  for (const key of [
    'polygonOffsetFactor',
    'polygonOffsetClamp',
    'polygonOffsetUnits',
    'stencilRef',
    'stencilReadMask',
    'stencilWriteMask',
  ]) {
    for (const value of [null, '1', true])
      assert.throws(() => new Material({ [key]: value }), { name: 'TypeError', message: new RegExp(key + '.*; set') });
    assert.throws(() => new Material({ [key]: Infinity }), {
      name: 'RangeError',
      message: new RegExp(key + '.*; set'),
    });
  }
  for (const key of ['colorWrite', 'polygonOffset', 'stencilWrite'])
    assert.throws(() => new Material({ [key]: 1 }), { name: 'TypeError', message: new RegExp(key + '.*; set') });
});

test('constructed meshes map Three-style polygon offset to reverse-Z and preserve stencil semantics', async () => {
  const h = optionalGPU(),
    engine = new Engine(
      { width: 64, height: 64 },
      await TransformStore.create(32),
      { backend: 'webgpu', gpu: h.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 4], target: [0, 0, 0] },
      null,
    );
  try {
    const material = new Material({
      colorWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: -3,
      polygonOffsetClamp: 0.1,
      stencilWrite: true,
      stencilFunc: 'equal',
      stencilRef: 7,
      stencilReadMask: 15,
      stencilWriteMask: 3,
      stencilFail: 'invert',
      stencilZFail: 'increment-wrap',
      stencilZPass: 'replace',
    });
    const model = createMesh(
      engine,
      { positions: [-1, -1, 0, 1, -1, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1] },
      material,
    );
    assert.equal(material.customState, true);
    const state = model.primitives[0].material.renderState;
    assert.equal(state.colorWrite, false);
    assert.equal(state.depthBiasMode, 'away');
    assert.equal(state.depthBias, -3);
    assert.equal(state.depthBiasSlopeScale, 2);
    assert.equal(state.depthBiasClamp, 0.1);
    assert.equal(state.stencilReference, 7);
    assert.equal(state.stencilReadMask, 15);
    assert.equal(state.stencilWriteMask, 3);
    assert.deepEqual(state.stencilFront, {
      compare: 'equal',
      failOp: 'invert',
      depthFailOp: 'increment-wrap',
      passOp: 'replace',
    });
    assert.deepEqual(state.stencilBack, state.stencilFront);
    model.dispose();
  } finally {
    engine.dispose();
    h.cleanup();
  }
});
