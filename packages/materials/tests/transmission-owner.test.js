import assert from 'node:assert/strict';
import test from 'node:test';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { mockGPU } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Transmission } from '../dist/transmission.js';
import { TransmissionLayers } from '../dist/transmission-layers.js';

for (const [label, Class] of [
  ['Transmission', Transmission],
  ['TransmissionLayers', TransmissionLayers],
]) {
  test(`${label} disposal removes its owning scene's passes and preserves same-name plugins elsewhere`, async () => {
    const engine = new Engine(
      { width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
      await TransformStore.create(32),
      { backend: 'webgpu', gpu: mockGPU().device, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 4], target: [0, 0, 0] },
      null,
    );
    try {
      const scene = engine.createScene('refraction'),
        effect = new Class();
      scene.use(effect);
      const names = effect.transmission ? [effect.name, effect.transmission.name] : [effect.name];
      let disposed = 0;
      const decoys = names.map((name) => ({
        name,
        setup() {},
        dispose() {
          disposed++;
        },
      }));
      for (const decoy of decoys) engine.use(decoy);
      assert.equal(engine.sceneOf(effect), scene);
      assert.equal(engine.scene, engine.sceneOf(decoys[0]));
      effect.dispose();
      assert.equal(engine.sceneOf(effect) === undefined, true, 'disposed plugin must be detached');
      assert.equal(scene.plugins.has(effect.name), false);
      assert.equal(disposed, 0, 'a same-name plugin in the default scene is unrelated');
      for (const name of names) {
        const remove = scene.frameGraph.add({ name, order: 3, execute() {} });
        remove();
      }
      effect.dispose();
      const other = new Class();
      scene.use(other);
      scene.removePlugin(other.name);
      assert.equal(engine.sceneOf(other), undefined, 'engine-initiated disposal is safe too');
      assert.equal(disposed, 0);
      for (const decoy of decoys) assert.equal(engine.scene.plugins.get(decoy.name), decoy);
    } finally {
      engine.dispose();
    }
  });
}
