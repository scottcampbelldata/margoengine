import test from 'node:test';
import assert from 'node:assert/strict';
import { Shadows } from '../dist/index.js';
import { VirtualShadows } from '../dist/virtual.js';
import { mockGPU, context, passes } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { box } from '../../core/dist/index.js';

// KB-SHADOW-GROUP2: `shadows.add(mesh)` casts the mesh and every mesh with geometry below it, as `add(group)` does
// (KB-SHADOW-GROUP1): a Blender car whose body mesh parents the wheels cast the body only.
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
    engine,
    slab,
    frame(shadows) {
      const run = passes(shadows);
      return gpu.record(() => {
        store.tick(false);
        view.begin(0);
        run(view.c);
      });
    },
  };
}
const drawn = (log) => log.filter((e) => e[0] === 'pass.drawIndexed').length;
// The draws of a frame that redraws every caster, once the frames settle (a VirtualShadows needs a few to fill its pages).
const redraw = (world, shadows) => {
  let draws = 0;
  for (let i = 0; i < 4; i++) {
    shadows.invalidate();
    draws = drawn(world.frame(shadows));
  }
  return draws;
};
for (const [name, make] of [
  ['Shadows', () => new Shadows({ resolution: 64, distance: 100 })],
  ['VirtualShadows', () => new VirtualShadows({ poolSize: 256, levels: 2 })],
]) {
  test(`${name}: a mesh with geometry casts the meshes below it, the same draws as adding each one`, async () => {
    const world = await setup(),
      body = world.slab(null, 0),
      wheel = world.slab(body, 1),
      hub = world.slab(wheel, 2);
    const parent = make();
    parent.setup(world.engine);
    parent.add(body);
    const single = make();
    single.setup(world.engine);
    for (const mesh of [body, wheel, hub]) single.add(mesh);
    const withParent = redraw(world, parent),
      withSingles = redraw(world, single);
    assert.ok(withSingles > 0, 'the control draws casters');
    assert.equal(withParent, withSingles, 'one add(body) draws what the three meshes added one by one draw');
    parent.dispose();
    single.dispose();
  });

  test(`${name}: a child parented later casts, one that leaves stops, the remover takes self and children out`, async () => {
    const world = await setup(),
      body = world.slab(null, 0),
      shadows = make();
    shadows.setup(world.engine);
    const remove = shadows.add(body);
    assert.ok(redraw(world, shadows) > 0, 'the mesh casts itself');
    const late = world.slab(body, 1);
    const added = redraw(world, shadows);
    late.setParent(null);
    const left = redraw(world, shadows);
    assert.ok(left > 0 && left < added, 'a mesh parented after add() casts, and stops casting when it leaves');
    late.setParent(body);
    assert.equal(redraw(world, shadows), added, 'and casts again when it returns');
    remove();
    assert.equal(redraw(world, shadows), 0, 'the remover takes the mesh and the child out');
    shadows.dispose();
  });

  test(`${name}: a child that is also added by hand casts once, in either order`, async () => {
    const world = await setup();
    for (const order of ['parent first', 'child first', 'child after a frame']) {
      const body = world.slab(null, 0),
        wheel = world.slab(body, 1),
        shadows = make(),
        control = make();
      shadows.setup(world.engine);
      control.setup(world.engine);
      control.add(body);
      control.add(wheel);
      let removeChild;
      if (order === 'child first') removeChild = shadows.add(wheel);
      const removeBody = shadows.add(body);
      if (order === 'parent first') removeChild = shadows.add(wheel);
      if (order === 'child after a frame') {
        world.frame(shadows);
        removeChild = shadows.add(wheel);
      }
      const expected = redraw(world, control);
      assert.ok(expected > 0, 'the control draws casters');
      assert.equal(redraw(world, shadows), expected, order + ': no mesh is drawn twice');
      removeChild();
      assert.equal(
        redraw(world, shadows),
        expected,
        order + ': removing the hand-added child leaves it cast through the parent',
      );
      removeBody();
      assert.equal(redraw(world, shadows), 0, order + ': the parent remover leaves nothing');
      shadows.dispose();
      control.dispose();
    }
  });

  test(`${name}: a mesh added twice is refused`, async () => {
    const world = await setup(),
      body = world.slab(null, 0),
      shadows = make();
    shadows.setup(world.engine);
    const remove = shadows.add(body);
    assert.throws(() => shadows.add(body), /Duplicate shadow source/);
    remove();
    assert.doesNotThrow(() => shadows.add(body), 'and may be added again once removed');
    shadows.dispose();
  });
}
