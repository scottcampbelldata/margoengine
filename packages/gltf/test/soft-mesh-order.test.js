// KB-SOFTMESH-LAG1: physics is a late plugin (KB-PHYS-FRAMEORDER1), so a soft-body mesh that ran as an ordinary plugin
// copied the particles before the frame's step and drew the step before. The engine runs the plugins' onPreUpdate in
// the order of its plugin map; the mesh must come after the physics world and match the particles once the frame is done.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { Physics } from '@margoengine/physics';
import { SoftBodies, SoftBodyDesc } from '@margoengine/physics/soft';
import { drawSoftBody } from '../dist/soft-mesh.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const warn = console.warn;
console.warn = () => {};
await Physics.load();
console.warn = warn;

test('a soft-body mesh runs after the physics step and draws the particles of this frame', async (t) => {
  const gpu = optionalGPU(),
    store = await TransformStore.create(64),
    engine = new Engine(
      { width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
      store,
      { backend: 'webgpu', gpu: gpu.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 3], target: [0, 0, 0] },
      null,
    );
  t.after(() => {
    engine.dispose();
    gpu.cleanup();
  });
  const physics = new Physics(engine);
  const soft = await SoftBodies.attach(physics);
  const cloth = soft.create(
    SoftBodyDesc.cloth([-1, 1, 0], [0.2, 0, 0], [0, -0.17, 0.1], 11, 11).setPinnedParticles([0, 110]),
  );
  const mesh = drawSoftBody(engine, cloth);
  const order = [...engine.scene.plugins.values()];
  assert.ok(
    order.indexOf(mesh) > order.indexOf(physics),
    'the mesh copies the particles after physics steps them (it runs later in the frame)',
  );
  for (let frame = 0; frame < 20; frame++) for (const plugin of order) plugin.onPreUpdate?.(1 / 60);
  const p = cloth.particlePositions(),
    v = mesh.model.primitives[0].vertices;
  let off = 0;
  for (let k = 0; k < 121; k++) for (let a = 0; a < 3; a++) off = Math.max(off, Math.abs(v[k * 20 + a] - p[k * 3 + a]));
  assert.equal(off, 0, 'the drawn vertices are the particles after the step');
  mesh.dispose();
});
