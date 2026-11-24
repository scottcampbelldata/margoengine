// addModel on a real Khronos sample (BoxVertexColors, a 1 m cube from (0, 0, 0) to (1, 1, 1)): colliders built from the model's
// triangles with the node's pose and scale applied, as fixed scenery, as a falling prop and one body a node.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { mockGPU } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { parseGLTFAsync } from '../../gltf/dist/pbr.js';
import { Physics } from '../dist/index.js';

await Physics.load();
const file = fileURLToPath(
  new URL('../../../examples/assets/khronos/BoxVertexColors/BoxVertexColors.glb', import.meta.url),
);
const near = (actual, expected, bound, message) =>
  assert.ok(Math.abs(actual - expected) <= bound, `${message}: ${actual} is not within ${bound} of ${expected}`);

async function withModel(run) {
  const gpu = mockGPU(),
    store = await TransformStore.create(64),
    renderer = { backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {} },
    engine = new Engine(
      { width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
      store,
      renderer,
      { position: [0, 5, 10], target: [0, 0, 0] },
      null,
    );
  try {
    const bytes = readFileSync(file),
      model = await parseGLTFAsync(engine, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
    await run(model, engine);
  } finally {
    engine.dispose();
  }
}

test('a fixed model is a trimesh the shape of the file: a ray meets its top at 1 m and its far side where the file says', async () => {
  await withModel((model) => {
    const physics = new Physics(null, { gravity: [0, -10, 0] });
    model.root.setPosition([0, 3, 0]);
    const bodies = physics.addModel(model, { type: 'fixed' });
    assert.equal(bodies.length, 1, 'one body on the root');
    assert.equal(bodies[0].colliders.length, model.primitives.length, 'one collider a primitive');
    assert.equal(bodies[0].colliders[0].shape, 'trimesh');
    physics.step();
    const down = physics.raycast([0.5, 10, 0.5], [0, -1, 0], { maxDistance: 20 });
    near(down.distance, 10 - (3 + 1), 1e-4, 'the top face of the cube at root + 1 m');
    const across = physics.raycast([-2, 3.5, 0.5], [1, 0, 0], { maxDistance: 20 });
    near(across.distance, 2, 1e-4, 'the near side at x = 0');
    assert.equal(physics.raycast([-2, 3.5, 5], [1, 0, 0], { maxDistance: 20 }), null, 'nothing beside the cube');
    physics.dispose();
  });
});

test('the node scale is applied: a model scaled by 2 is 2 m across', async () => {
  await withModel((model) => {
    const physics = new Physics(null);
    model.root.setScale([2, 2, 2]);
    physics.addModel(model, { type: 'fixed' });
    physics.step();
    near(physics.raycast([1, 10, 1], [0, -1, 0], { maxDistance: 20 }).distance, 8, 1e-4, 'the top at 2 m');
    near(physics.raycast([-1, 1, 1], [1, 0, 0], { maxDistance: 20 }).distance, 1, 1e-4, 'the near side');
    physics.dispose();
  });
});

test('a dynamic model is a convex hull with a mass: it falls on a floor and rests on its bottom face', async () => {
  await withModel((model) => {
    const physics = new Physics(null, { gravity: [0, -10, 0] });
    physics.addBody(null, {
      type: 'fixed',
      position: [0, -0.5, 0],
      colliders: { shape: 'box', halfExtents: [10, 0.5, 10] },
    });
    model.root.setPosition([0, 3, 0]);
    const [body] = physics.addModel(model, { collider: { density: 1000 } });
    assert.equal(body.colliders[0].shape, 'convexHull');
    near(body.mass, 1000, 1, 'a cubic metre of 1000 kg');
    for (let i = 0; i < 240; i++) physics.step();
    // The body's origin is the model's root, the cube's corner: at rest on its bottom face the root is on the floor.
    near(body.position[1], 0, 0.02, 'the root rests on the floor');
    physics.dispose();
  });
});

test('a filter leaves primitives out: with none left no body is made, and perNode gives one body a node', async () => {
  await withModel((model) => {
    const physics = new Physics(null);
    assert.deepEqual(physics.addModel(model, { type: 'fixed', filter: () => false }), []);
    assert.equal(physics.addModel(model, { type: 'fixed', perNode: true }).length >= 1, true);
    assert.throws(() => physics.addModel(model, { shape: 'sphere' }), /trimesh|convexHull/);
    physics.dispose();
  });
});
