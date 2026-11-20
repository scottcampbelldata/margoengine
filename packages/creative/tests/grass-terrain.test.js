import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerrainGrass } from '../dist/grass-terrain.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

test('terrain grass validates maps and propagates pre-import abort', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(createTerrainGrass({}, { signal: controller.signal }), (e) => e === controller.signal.reason);
  for (const map of [
    { width: 0, height: 1, data: new Float32Array(4) },
    { width: 2, height: 1, data: new Float32Array(4) },
    { width: 1, height: 1, data: new Float32Array([NaN, 0, 0, 1]) },
    { width: 1, height: 1, data: new Float32Array([2, 0, 0, 1]) },
    { width: 1, height: 1, data: new Float32Array(4), bounds: [1, 0, 0, 1] },
    { width: 1, height: 1, data: new Float32Array(4), bounds: [1e20, 0, 1e20+1e6, 1] },
    { width: 1, height: 1, data: new Float32Array(4), bounds: [0, 0, 1e-40, 1] },
  ])
    await assert.rejects(createTerrainGrass({}, { colorMap: map }), RangeError);
});
test('terrain grass composes existing terrain, density, blades and sphere field; snapshots colour across restoration', async () => {
  const h = optionalGPU(),
    data = new Float32Array([0.2, 0.4, 0.6, 1]);
  const field = await createTerrainGrass(h.engine, {
    count: 64,
    area: [8, 8],
    bounds: [-4, -4, 4, 4],
    colorMap: { width: 1, height: 1, data },
  });
  try {
    data.fill(0);
    field.setInteractors([{ position: [1, 0, 0], radius: 2 }]);
    h.frame();
    const entries = field.poseEntries(),
      packed = new Float32Array(entries.at(-1).buffer.data);
    assert.deepEqual([...packed.slice(0, 6)], [-4, -4, 4, 4, 1, 1]);
    assert.deepEqual([...packed.slice(8)], Array.from(new Float32Array([0.2, 0.4, 0.6, 1])));
    const code = h.pipelines.find((p) => p.vertex?.module.code.includes('grassTint')).vertex.module.code;
    assert.match(code, /height|grassMap/);
    assert.match(code, /i\.shade\*i\.tint/);
    assert.match(code, /trampleTurn/);
    const pass=h.context.encoder.beginRenderPass({});
    field.drawShadow({context:h.context,pass,matrix:h.context.camera.matrix,cascade:0});
    field.prepareShadow({context:h.context,matrices:new Float32Array(16),cascades:1});
    field.drawShadow({context:h.context,pass,matrix:h.context.camera.matrix,cascade:0});
    const posed=h.pipelines.filter(p=>p.vertex?.module.code.includes('fn scatterPose('));
    assert.equal(posed.length,3);assert.ok(posed.every(p=>p.vertex.module.code.includes('grassTint')));
    field.onDeviceRestored(h.engine);
    h.frame();
    assert.deepEqual([...new Float32Array(field.poseEntries().at(-1).buffer.data).slice(8)], [...packed.slice(8)]);
  } finally {
    field.dispose();
    h.cleanup();
  }
});

// KB-OWN-ASYNC3: the field was added after the lazy import of scatter, when the default scene is active again.
const realEngine = async (h) =>
  new Engine(
    { width: 16, height: 16, clientWidth: 16, clientHeight: 16 },
    await TransformStore.create(4),
    { backend: 'webgpu', gpu: h.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
    undefined,
    null,
  );
test('createTerrainGrass started in a second scene joins that scene', async () => {
  const h = optionalGPU(),
    engine = await realEngine(h),
    other = engine.createScene('other');
  try {
    let pending;
    other.use({ name: 'probe', setup: () => (pending = createTerrainGrass(engine, { count: 4, area: [2, 2] })) });
    const field = await pending;
    assert.ok(engine.sceneOf(field) === other, 'the field is not in the second scene');
    assert.deepEqual([...engine.scene.plugins.keys()], [], 'a plugin landed in the default scene');
    field.dispose();
    assert.deepEqual([...other.plugins.keys()], ['probe']);
  } finally {
    engine.dispose();
    h.cleanup();
  }
});
test('an aborted createTerrainGrass started in a second scene leaves nothing in either scene', async () => {
  const h = optionalGPU(),
    engine = await realEngine(h),
    other = engine.createScene('other'),
    controller = new AbortController();
  try {
    let pending;
    other.use({
      name: 'probe',
      setup: () => (pending = createTerrainGrass(engine, { count: 4, area: [2, 2], signal: controller.signal })),
    });
    controller.abort(new Error('stop'));
    await assert.rejects(pending, /stop/);
    assert.deepEqual([...engine.scene.plugins.keys()], []);
    assert.deepEqual([...other.plugins.keys()], ['probe']);
  } finally {
    engine.dispose();
    h.cleanup();
  }
});
