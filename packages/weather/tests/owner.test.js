import assert from 'node:assert/strict';
import test from 'node:test';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { mockGPU } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { GLTFWeather } from '../dist/gltf.js';
import { PrecipitationCover } from '../dist/cover.js';

function cover() {
  return new PrecipitationCover({
    name: 'capture', options: { weather: { occlusion: {} } }, setup() {},
    registerPasses(graph) { graph.add({ name: 'sky:cover', execute() {} }); },
    dispose() {},
  });
}
for (const [label, create] of [['GLTFWeather', () => new GLTFWeather()], ['PrecipitationCover', cover]]) {
  test(`${label} direct disposal detaches its owning scene and preserves other scene plugins`, async () => {
    const engine = new Engine(
      { width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
      await TransformStore.create(8),
      { backend: 'webgpu', gpu: mockGPU().device, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 4], target: [0, 0, 0] }, null,
    );
    try {
      const scene = engine.createScene('weather'), effect = create();
      scene.use(effect);
      let decoyDisposals = 0;
      const decoy = { name: effect.name, setup() {}, dispose() { decoyDisposals++; } };
      engine.use(decoy);
      effect.dispose();
      assert.deepEqual({ retained: scene.plugins.has(effect.name), decoyDisposals },
        { retained: false, decoyDisposals: 0 });
      assert.equal(engine.sceneOf(effect), undefined);
      assert.equal(engine.scene.plugins.get(decoy.name), decoy);
      effect.dispose();
      const other = create();
      scene.use(other);
      scene.removePlugin(other.name);
      assert.equal(engine.sceneOf(other), undefined);
      assert.equal(decoyDisposals, 0);
      // Capture passes must have been removed with the registration.
      for (const name of ['weather:cover-map', 'weather:cover-surfaces']) {
        const remove = scene.frameGraph.add({ name, order: 3, execute() {} });
        remove();
      }
    } finally { engine.dispose(); }
  });
}

