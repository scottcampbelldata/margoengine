import test from 'node:test';
import assert from 'node:assert/strict';
import { Shadows } from '../dist/index.js';
import { VirtualShadows } from '../dist/virtual.js';
import { mockGPU, context, passes } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { box } from '../../core/dist/index.js';

// `shadows.add(group)` casts every mesh with geometry below the group (KB-SHADOW-GROUP1). The real-GPU proof of the
// pixels is group-casters-browser.mjs; here the draws and the registrations are counted on the recording GPU.
async function setup() {
  const gpu = mockGPU(),
    store = await TransformStore.create(32),
    buffers = { vertex: gpu.device.createBuffer({ size: 576 }), index: gpu.device.createBuffer({ size: 144 }) };
  const engine = new Engine(
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
    { position: [0, 20, 40], target: [0, 0, 0] },
    null,
  );
  const geometry = box(0.5, 0.5, 0.5),
    slab = (parent, x) => engine.createMesh(parent).setGeometry(geometry).setPosition([x, 0.25, 0]),
    view = context(gpu, { samples: 1, shader: 'let linear=direct*vec3f(1);' });
  return {
    gpu,
    engine,
    slab,
    view,
    frame(shadows, position = [0, 20, 40]) {
      const run = passes(shadows);
      return gpu.record(() => {
        store.tick(false);
        view.begin(0);
        view.camera.position = position;
        run(view.c);
      });
    },
  };
}
const drawn = (log) => log.filter((e) => e[0] === 'pass.drawIndexed').length;
for (const [name, make] of [
  ['Shadows', () => new Shadows({ resolution: 64, distance: 100 })],
  ['VirtualShadows', () => new VirtualShadows({ poolSize: 256, levels: 2 })],
]) {
  test(`${name}: a group casts every mesh below it, the same draws as adding each mesh`, async () => {
    const world = await setup(),
      group = world.engine.createMesh(),
      inner = world.engine.createMesh(group);
    // Two levels, and a mesh with geometry that has a child of its own: all three cast.
    const a = world.slab(group, 0),
      b = world.slab(inner, 1),
      c = world.slab(b, 2);
    const grouped = make();
    grouped.setup(world.engine);
    grouped.add(group);
    const single = make();
    single.setup(world.engine);
    for (const mesh of [a, b, c]) single.add(mesh);
    const withGroup = drawn(world.frame(grouped)),
      withSingles = drawn(world.frame(single));
    assert.ok(withSingles > 0, 'the control draws casters');
    assert.equal(withGroup, withSingles, 'the group draws what the three meshes added one by one draw');
    grouped.dispose();
    single.dispose();
  });

  test(`${name}: a mesh parented later casts, one that leaves stops, the remover takes every mesh out`, async () => {
    const world = await setup(),
      group = world.engine.createMesh(),
      shadows = make();
    shadows.setup(world.engine);
    const empty = drawn(world.frame(shadows)),
      remove = shadows.add(group);
    assert.equal(drawn(world.frame(shadows)), empty, 'a group with nothing below it draws nothing');
    const late = world.slab(group, 0);
    const added = drawn(world.frame(shadows));
    assert.ok(added > empty, 'a mesh parented after add() casts from the next frame');
    late.setParent(null);
    assert.equal(drawn(world.frame(shadows)), empty, 'a mesh that left the group stops casting');
    late.setParent(group);
    assert.equal(drawn(world.frame(shadows)), added, 'and casts again when it returns');
    remove();
    assert.equal(drawn(world.frame(shadows)), empty, 'the remover takes it out');
    shadows.dispose();
  });

  test(`${name}: a group is added once, a disposed group stops casting, receiveShadow false is restored`, async () => {
    const world = await setup(),
      group = world.engine.createMesh(),
      mesh = world.slab(group, 0),
      shadows = make();
    shadows.setup(world.engine);
    const remove = shadows.add(group, { receiveShadow: false });
    assert.throws(() => shadows.add(group), /Duplicate shadow source/);
    world.frame(shadows);
    assert.equal(mesh.receiveShadow, false, 'a mesh below the group takes the option');
    remove();
    assert.equal(mesh.receiveShadow, true, 'the remover restores it');
    shadows.add(group);
    world.frame(shadows);
    group.dispose();
    assert.doesNotThrow(() => world.frame(shadows), 'a disposed group leaves quietly');
    shadows.dispose();
  });
}
