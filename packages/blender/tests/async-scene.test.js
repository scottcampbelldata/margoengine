// KB-OWN-ASYNC1: a .margo load started in a second scene's setup builds its model after its awaits, when the default
// scene is active again. The model, its meshes and its plugin belong to the scene the load started in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { headless, headlessModels } from '../../../tests/support/pbr-snapshot.js';
import { loadMargo, parseMargo } from '../dist/index.js';
import { loadMargoNodes, parseMargoNodes } from '../dist/nodes.js';
import { loadMargoPBR, parseMargoPBR } from '../dist/pbr-ext.js';
import { loadAnimatedMargo, parseAnimatedMargo } from '../dist/anim.js';
import { loadMargoCurves, parseMargoCurves } from '../dist/curves.js';
import { loadMargoKTX2, parseMargoKTX2 } from '../dist/ktx2.js';
import { compressMargoMeshopt, loadMargoMeshopt } from '../dist/meshopt.js';
import { loadMargoComponents, parseMargoComponents } from '../dist/components.js';

const nodes = await readFile(new URL('./fixtures/nodes.margo', import.meta.url)),
  pbr = await readFile(new URL('./fixtures/pbr-ext.margo', import.meta.url)),
  plain = await readFile(new URL('./fixtures/compact-triangle.margo', import.meta.url)),
  fixture = (name) => readFile(new URL(`./fixtures/${name}.margo`, import.meta.url)),
  [anim, curves, components] = await Promise.all(['anim', 'curves', 'components'].map(fixture)),
  meshopt = await compressMargoMeshopt(plain);
/** Runs `start` inside a second scene's setup, which is where an app starts a load for that scene. */
function inSecondScene(engine, start) {
  const scene = engine.createScene('b');
  let started;
  scene.use({ name: 'loader', setup: () => (started = start()) });
  return { scene, started };
}
const owned = (scene) => [...scene.plugins.keys()].filter((name) => name !== 'loader');
const withEngine = (run) =>
  headlessModels(async () => {
    // The stand-in decoder reads the PNG header, as the .margo reader checks, and the pbr-ext path closes its images.
    const decode = globalThis.createImageBitmap;
    globalThis.createImageBitmap = async (source, options) => {
      if (!(source instanceof Blob)) return decode(source, options);
      const header = new DataView(await source.arrayBuffer());
      return { width: header.getUint32(16), height: header.getUint32(20), close() {} };
    };
    const engine = await headless();
    try {
      return await run(engine);
    } finally {
      engine.dispose();
    }
  });
const landed = (engine, scene, model) => {
  assert.ok(model.root.scene === scene, `the root is in scene ${model.root.scene.name}`);
  for (const node of model.nodes) assert.ok(node.scene === scene, 'a node is not in the second scene');
  assert.ok(engine.sceneOf(model) === scene, 'the model plugin is not in the second scene');
  assert.equal(engine.scene.meshes.size, 0, 'meshes landed in the default scene');
  assert.equal(engine.scene.plugins.size, 0, 'a plugin landed in the default scene');
};
const empty = (...scenes) => {
  for (const scene of scenes) {
    assert.equal(scene.meshes.size, 0, `scene ${scene.name} holds meshes`);
    assert.deepEqual(owned(scene), [], `scene ${scene.name} holds plugins`);
  }
};

// KB-OWN-BLEND1: parseMargo built its model after its image await, and each load* fetched first and then called its
// parse function, which captured the scene active by then: all four built in the default scene. The animated,
// curves, KTX2 and meshopt parse and load functions did the same.
// KB-OWN-BLEND2: parseMargoComponents and parseMargoLightmap did the same; parseMargoLightmap needs a GPU device and an
// image decoder, so its rows are in tests/lightmap-scene.browser.mjs.
const served = (load) => (engine, bytes, options) =>
  load(engine, 'https://assets.example/scene.margo', { ...options, fetch: async () => new Response(bytes) });
for (const [name, parse, bytes, model] of [
  ['parseMargoNodes', parseMargoNodes, nodes, (loaded) => loaded.model],
  ['parseMargoPBR', parseMargoPBR, pbr, (loaded) => loaded],
  ['parseMargo', parseMargo, plain, (loaded) => loaded],
  ['loadMargo', served(loadMargo), plain, (loaded) => loaded],
  ['loadMargoNodes', served(loadMargoNodes), nodes, (loaded) => loaded.model],
  ['loadMargoPBR', served(loadMargoPBR), pbr, (loaded) => loaded],
  ['parseAnimatedMargo', parseAnimatedMargo, anim, (loaded) => loaded],
  ['loadAnimatedMargo', served(loadAnimatedMargo), anim, (loaded) => loaded],
  ['parseMargoCurves', parseMargoCurves, curves, (loaded) => loaded.model],
  ['loadMargoCurves', served(loadMargoCurves), curves, (loaded) => loaded.model],
  ['parseMargoKTX2', parseMargoKTX2, plain, (loaded) => loaded],
  ['loadMargoKTX2', served(loadMargoKTX2), plain, (loaded) => loaded],
  ['loadMargoMeshopt', served(loadMargoMeshopt), meshopt, (loaded) => loaded],
]) {
  test(`${name} started in a second scene builds the model there`, () =>
    withEngine(async (engine) => {
      const { scene, started } = inSecondScene(engine, () => parse(engine, bytes)),
        loaded = await started;
      landed(engine, scene, model(loaded));
      model(loaded).dispose();
      empty(scene, engine.scene);
    }));
  test(`${name} started outside any setup stays in the default scene`, () =>
    withEngine(async (engine) => {
      const loaded = await parse(engine, bytes);
      assert.ok(model(loaded).root.scene === engine.scene);
      assert.ok(engine.sceneOf(model(loaded)) === engine.scene);
      model(loaded).dispose();
    }));
  test(`an aborted ${name} started in a second scene leaves nothing in either scene`, () =>
    withEngine(async (engine) => {
      const controller = new AbortController(),
        { scene, started } = inSecondScene(engine, () => parse(engine, bytes, { signal: controller.signal }));
      controller.abort(new Error('stop'));
      await assert.rejects(started, /stop/);
      empty(scene, engine.scene);
    }));
}

// KB-OWN-BLEND2: parseMargoComponents built its model after the image await and glTF PBR attached the physics world
// after its own awaits, both in the scene active by then. The model, its lights, its physics world and what its
// scripts make belong to the scene the load started in.
const made = [];
const scripts = {
  door: ({ model }) => {
    const mesh = model.root.engine.createMesh();
    made.push(mesh);
    return () => mesh.dispose();
  },
  glow: () => {},
};
for (const [name, parse] of [
  ['parseMargoComponents', parseMargoComponents],
  ['loadMargoComponents', served(loadMargoComponents)],
]) {
  test(`${name} started in a second scene builds the model, its world and its script meshes there`, () =>
    withEngine(async (engine) => {
      made.length = 0;
      const { scene, started } = inSecondScene(engine, () => parse(engine, components, { scripts })),
        loaded = await started;
      landed(engine, scene, loaded.model);
      assert.ok(engine.sceneOf(loaded.physics.physics) === scene, 'the physics world is not in the second scene');
      assert.equal(made.length, 2);
      for (const mesh of made) assert.ok(mesh.scene === scene, `a script mesh is in scene ${mesh.scene.name}`);
      loaded.dispose();
      empty(scene, engine.scene);
    }));
  test(`${name} started outside any setup stays in the default scene`, () =>
    withEngine(async (engine) => {
      const loaded = await parse(engine, components, { scripts });
      assert.ok(engine.sceneOf(loaded.model) === engine.scene);
      assert.ok(engine.sceneOf(loaded.physics.physics) === engine.scene);
      loaded.dispose();
      assert.equal(engine.scene.meshes.size, 0);
      assert.equal(engine.scene.plugins.size, 0);
    }));
  test(`an aborted ${name} started in a second scene leaves nothing in either scene`, () =>
    withEngine(async (engine) => {
      const controller = new AbortController(),
        { scene, started } = inSecondScene(engine, () =>
          parse(engine, components, { scripts, signal: controller.signal }),
        );
      controller.abort(new Error('stop'));
      await assert.rejects(started, /stop/);
      empty(scene, engine.scene);
    }));
}
