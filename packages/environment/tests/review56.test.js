import test from 'node:test';
import assert from 'node:assert/strict';
import { engine, calls, scissors } from '../../../tests/support/review56-engine.js';
import { Reflector } from '../dist/reflector.js';
import { studio } from '../dist/studio.js';
test('review: mirror draw applies independent viewport and scissor', async (t) => {
  const e = await engine(t),
    floor = Reflector.attach(e, { width: 8, height: 8, roughness: 0.4, autoUpdate: false });
  floor.update();
  e.gpu.createBindGroupLayout = () => ({});
  e.gpu.createPipelineLayout = () => ({});
  calls.length = 0;
  scissors.length = 0;
  e.render({ views: [{ camera: e.camera, viewport: [0, 0, 200, 200], pixels: true, scissor: [0, 0, 100, 200] }] });
  const row = {
    viewport: calls.filter((c) => c.label === floor.name),
    scissor: scissors.filter((c) => c.label === floor.name),
  };
  console.log('MIRROR_RECT', JSON.stringify(row));
  assert.deepEqual(
    row.viewport.map((v) => v.args),
    [[0, 0, 200, 200, 0, 1]],
  );
  assert.deepEqual(
    row.scissor.map((v) => v.args),
    [[0, 0, 100, 200]],
  );
});
test('review: finite overflowed studio direction preserves the softbox', () => {
  const base = { width: 16, floor: [0, 0, 0], walls: [0, 0, 0], ceiling: [0, 0, 0] },
    light = { direction: [1, 1, 0], width: 1, height: 1, intensity: 1 };
  const peak = (direction) =>
    Math.max(...studio({ ...base, lights: [{ ...light, direction }] }).data.filter((v, i) => i % 4 !== 3));
  const row = { normal: peak([1, 1, 0]), extreme: peak([Number.MAX_VALUE, Number.MAX_VALUE, 0]) };
  assert.equal(row.normal, 1);
  assert.equal(row.extreme, 1);
  console.log('STUDIO_DIRECTION', JSON.stringify(row));
});
test('review: secondary scene mirror captures its owner scene and detaches', async (t) => {
  const e = await engine(t),
    scene = e.createScene('product-stage');
  let defaultPasses = 0,
    ownerPasses = 0;
  e.frameGraph.add({
    name: 'default-evidence',
    order: 0.25,
    execute() {
      defaultPasses++;
    },
  });
  scene.frameGraph.add({
    name: 'owner-evidence',
    order: 0.25,
    execute() {
      ownerPasses++;
    },
  });
  const floor = new Reflector({ autoUpdate: false, name: 'secondary-floor' });
  scene.use(floor);
  const captured = floor.update();
  floor.dispose();
  const row = {
    captured,
    defaultPasses,
    ownerPasses,
    stillRegistered: scene.plugins.has(floor.name),
    stillOwned: e.sceneOf(floor) === scene,
  };
  console.log('MIRROR_OWNER', JSON.stringify(row));
  assert.equal(defaultPasses, 0);
  assert.equal(ownerPasses, 1);
  assert(!row.stillRegistered);
  assert(!row.stillOwned);
});

for (const [entry, Name, frames] of [
  ['reflector', 'Reflector', 1],
  ['refractor', 'Refractor', 1],
  ['cube-camera', 'CubeCamera', 6],
]) {
  test(`secondary scene ${Name} captures only its owner and permits a same-name replacement`, async (t) => {
    const Type = (await import(`../dist/${entry}.js`))[Name],
      e = await engine(t),
      owner = e.createScene('product');
    let primary = 0,
      secondary = 0;
    e.frameGraph.add({
      name: 'default-spy',
      order: 0.25,
      execute() {
        primary++;
      },
    });
    owner.frameGraph.add({
      name: 'owner-spy',
      order: 0.25,
      execute() {
        secondary++;
      },
    });
    const first = new Type({ name: 'floor', autoUpdate: false, size: 16 });
    owner.use(first);
    const unrelated = Reflector.attach(e, { name: 'floor', autoUpdate: false });
    first.update();
    assert.equal(primary, 0);
    assert.equal(secondary, frames);
    first.dispose();
    first.dispose();
    assert(!e.sceneOf(first));
    assert(!owner.plugins.has('floor'));
    assert.equal(owner.meshes.size,0,'disposing the surface releases its owning-scene transform node');
    assert.equal(e.scene.plugins.get('floor'), unrelated, 'another scene keeps its same-name plugin');
    const replacement = new Type({ name: 'floor', autoUpdate: false, size: 16 });
    owner.use(replacement);
    replacement.dispose();
  });
}

test('all environment scene plugins detach from their owner rather than the default scene', async (t) => {
  const { ColorBackground, ImageBackground, EnvironmentBackground, EnvironmentLighting, Fog } = await import(
    '../dist/index.js'
  );
  const { ColorOutput } = await import('../dist/index.js');
  const { VolumetricFog } = await import('../dist/volumetric.js');
  const e = await engine(t),
    owner = e.createScene('secondary'),
    environment = { disposed: true, device: null };
  const factories = [
    () => new ColorBackground(),
    () => new ImageBackground({ shape: 'sphere', images: [{ width: 1, height: 1, data: new Uint8ClampedArray(4) }] }),
    () => new EnvironmentBackground(environment),
    () => new EnvironmentLighting(environment),
    () => new Fog(),
    () => new ColorOutput({ hdr: false, gamut: 'srgb' }),
    () => new VolumetricFog(),
  ];
  for (const make of factories) {
    const effect = make();
    owner.use(effect);
    effect.dispose();
    effect.dispose();
    assert(!owner.plugins.has(effect.name), effect.name);
    assert(!e.sceneOf(effect));
    const next = make();
    owner.use(next);
    next.dispose();
  }
});

test('secondary scene captures hide owning meshes by exclusion and layer then restore visibility', async (t) => {
  const { box, PbrMaterial } = await import('../../core/dist/index.js');
  const { setRenderLayers } = await import('../../cameras/dist/layers.js');
  const e = await engine(t),
    owner = e.createScene('hidden-owner');
  const a = owner.createMesh().setGeometry(box()).setMaterial(new PbrMaterial()).setPosition([0, 0, 2]);
  const b = owner.createMesh().setGeometry(box()).setMaterial(new PbrMaterial()).setPosition([1, 0, 2]);
  setRenderLayers(b, 2);
  const seen = [];
  owner.frameGraph.add({
    name: 'hidden-spy',
    order: 0.25,
    execute() {
      seen.push([a.visible, b.visible]);
    },
  });
  const surface = new Reflector({ autoUpdate: false, exclude: [a], layers: 1 });
  owner.use(surface);
  surface.update();
  assert.deepEqual(seen, [[false, false]]);
  assert(a.visible && b.visible);
  surface.dispose();
});
