import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { Splats } from '../dist/index.js';
import { SplatModifier } from '../dist/modify.js';
import { loadProgressiveSplats } from '../dist/progressive.js';

// KB-OWN-ASYNC3: SplatModifier.attach and loadProgressiveSplats add their plugin after an await, when the default scene is
// active again. The classes need a WebGPU device to set up, so their setup is a no-op here: the scene is what is tested.
const data = () => ({
  positions: new Float32Array([1, 2, 3]),
  covariances: new Float32Array([1, 0, 0, 1, 0, 1]),
  colors: new Float32Array([0.2, 0.4, 0.6, 1]),
});
async function withEngine(run) {
  const setups = [Splats.prototype.setup, SplatModifier.prototype.setup];
  Splats.prototype.setup = SplatModifier.prototype.setup = () => {};
  const engine = new Engine(
    { width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
    await TransformStore.create(16),
    { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
    undefined,
    null,
  );
  try {
    await run(engine);
  } finally {
    engine.dispose();
    [Splats.prototype.setup, SplatModifier.prototype.setup] = setups;
  }
}
/** Runs `start` inside a second scene's setup, which is where an app starts an attach for that scene. */
function inSecondScene(engine, start) {
  const scene = engine.createScene('b');
  let started;
  scene.use({ name: 'attacher', setup: () => (started = start()) });
  return { scene, started };
}
const owned = (scene) => [...scene.plugins.keys()].filter((name) => name !== 'attacher');
async function* stream(bytes) {
  await Promise.resolve();
  yield bytes;
}
const splatBytes = () => {
  // One 32-byte .splat record: position, scale, rgba, rotation.
  const out = new Uint8Array(32),
    view = new DataView(out.buffer);
  view.setFloat32(0, 1, true);
  for (let i = 1; i < 6; i++) view.setFloat32(i * 4, i === 3 || i === 4 || i === 5 ? 0.1 : 0, true);
  out.set([255, 128, 64, 255, 255, 128, 128, 128], 24);
  return out;
};

test('SplatModifier.attach started in a second scene joins that scene', () =>
  withEngine(async (engine) => {
    const cloud = new Splats(data()),
      { scene, started } = inSecondScene(engine, () => SplatModifier.attach(engine, cloud)),
      modifier = await started;
    assert.ok(engine.sceneOf(modifier) === scene, 'the modifier is not in the second scene');
    assert.deepEqual(owned(engine.scene), [], 'a plugin landed in the default scene');
  }));

test('SplatModifier.attach outside any setup stays in the default scene', () =>
  withEngine(async (engine) => {
    assert.ok(engine.sceneOf(await SplatModifier.attach(engine, new Splats(data()))) === engine.scene);
  }));

test('an aborted SplatModifier.attach in a second scene leaves nothing in either scene', () =>
  withEngine(async (engine) => {
    const controller = new AbortController(),
      cloud = new Splats(data()),
      { scene, started } = inSecondScene(engine, () => SplatModifier.attach(engine, cloud, { signal: controller.signal }));
    controller.abort(new Error('stop'));
    await assert.rejects(started, /stop/);
    for (const each of [scene, engine.scene]) assert.deepEqual(owned(each), [], `scene ${each.name} holds plugins`);
  }));

test('loadProgressiveSplats started in a second scene reserves its cloud there', () =>
  withEngine(async (engine) => {
    const { scene, started } = inSecondScene(engine, () =>
        loadProgressiveSplats(engine, stream(splatBytes()), { format: 'splat', count: 1 }),
      ),
      cloud = await started;
    assert.ok(engine.sceneOf(cloud) === scene, 'the cloud is not in the second scene');
    assert.deepEqual(owned(engine.scene), [], 'a plugin landed in the default scene');
  }));

test('loadProgressiveSplats outside any setup stays in the default scene', () =>
  withEngine(async (engine) => {
    const cloud = await loadProgressiveSplats(engine, stream(splatBytes()), { format: 'splat', count: 1 });
    assert.ok(engine.sceneOf(cloud) === engine.scene);
  }));

test('a failed loadProgressiveSplats in a second scene leaves nothing in either scene', () =>
  withEngine(async (engine) => {
    const { scene, started } = inSecondScene(engine, () =>
      loadProgressiveSplats(engine, stream(splatBytes().subarray(0, 20)), { format: 'splat', count: 1 }),
    );
    await assert.rejects(started);
    for (const each of [scene, engine.scene]) assert.deepEqual(owned(each), [], `scene ${each.name} holds plugins`);
  }));
