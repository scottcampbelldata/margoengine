import test from 'node:test';
import assert from 'node:assert/strict';
import { Shadows } from '../dist/index.js';
import { mockGPU, context, passes } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { box } from '../../core/dist/index.js';

test('cadence is checked', () => {
  for (const bad of [[0], [1.5], 'x', [1, -1]]) assert.throws(() => new Shadows({ cadence: bad }), RangeError);
  assert.doesNotThrow(() => new Shadows({ cadence: [1, 1, 2, 4] }));
});

test('cadence redraws a cascade only on its own frames and holds its matrix', async () => {
  const gpu = mockGPU(),
    store = await TransformStore.create(16),
    buffers = { vertex: gpu.device.createBuffer({ size: 576 }), index: gpu.device.createBuffer({ size: 144 }) },
    engine = new Engine(
      { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
      store,
      {
        backend: 'webgpu',
        gpu: gpu.device,
        add() {},
        remove() {},
        render() {},
        dispose() {},
        geometryBuffers: () => buffers,
      },
      { position: [0, 2, 6], target: [0, 0, 0] },
      null,
    ),
    mesh = engine.createMesh().setGeometry(box()),
    shadows = new Shadows({ resolution: 64, distance: 50, cadence: [1, 1, 2, 4] }),
    view = context(gpu, { samples: 1, shader: 'let linear=direct*vec3f(1);' });
  shadows.setup(engine);
  shadows.add(mesh);
  const frame = (x) => {
    store.tick(false);
    view.begin(0);
    view.camera.position = [x, 2, 6];
    const log = gpu.record(() => passes(shadows)(view.c));
    return log.filter((e) => e[0] === 'copyTextureToTexture').length;
  };
  frame(0);
  const held = shadows.matrices.slice(48, 64),
    near = shadows.matrices.slice(0, 16);
  // Frame serial 2: cascades 0, 1 and 2 are due, 3 is held.
  assert.equal(frame(1), 3, 'three cascades update');
  assert.deepEqual([...shadows.matrices.slice(48, 64)], [...held], 'the far cascade keeps its matrix');
  assert.notDeepEqual([...shadows.matrices.slice(0, 16)], [...near], 'the near cascade follows the camera');
  // Frame serial 3: only 0 and 1.
  assert.equal(frame(2), 2);
  // Frame serial 4: all four.
  assert.equal(frame(3), 4);
  assert.notDeepEqual([...shadows.matrices.slice(48, 64)], [...held], 'the far cascade catches up');
  shadows.dispose();
});
