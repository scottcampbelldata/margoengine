import assert from 'node:assert/strict';
import { test } from 'node:test';
import { headless, headlessModels } from '../../../tests/support/pbr-snapshot.js';
import { TilesRenderer } from '../dist/index.js';
import { PointsPlugin } from '../../points/dist/index.js';
import { boxGLB, memoryFetch } from './generator.js';

// KB-OWN-ASYNC1: a renderer started in a second scene's setup joins that scene, and the content it makes after fetches and
// imports (models, point anchors) is made there, though the default scene is active again by then.
const tileset = () =>
  memoryFetch(
    new Map([
      [
        'tileset.json',
        new TextEncoder().encode(
          JSON.stringify({
            asset: { version: '1.1' },
            geometricError: 10,
            root: { boundingVolume: { box: [0, 0, 0, 5, 0, 0, 0, 5, 0, 0, 0, 5] }, geometricError: 0 },
          }),
        ),
      ],
    ]),
  );
/** Runs `start` inside a second scene's setup, which is where an app starts a load for that scene. */
function inSecondScene(engine, start) {
  const scene = engine.createScene('b');
  let started;
  scene.use({ name: 'loader', setup: () => (started = start()) });
  return { scene, started };
}
const withEngine = (run) =>
  headlessModels(async () => {
    const engine = await headless();
    try {
      return await run(engine);
    } finally {
      engine.dispose();
    }
  });
const loadIn = async (engine) => {
  const memory = tileset(),
    { scene, started } = inSecondScene(engine, () => TilesRenderer.load(engine, memory.url, { fetch: memory.fetch }));
  return { scene, renderer: await started };
};

test('TilesRenderer.load started in a second scene joins that scene', () =>
  withEngine(async (engine) => {
    const { scene, renderer } = await loadIn(engine);
    assert.ok(engine.sceneOf(renderer) === scene, 'the renderer is not in the second scene');
    assert.equal(engine.scene.plugins.size, 0, 'the renderer landed in the default scene');
    renderer.dispose();
    assert.equal(scene.plugins.has(renderer.name), false);
  }));

test('a renderer loaded outside any setup stays in the default scene', () =>
  withEngine(async (engine) => {
    const memory = tileset(),
      renderer = await TilesRenderer.load(engine, memory.url, { fetch: memory.fetch });
    assert.ok(engine.sceneOf(renderer) === engine.scene);
    renderer.dispose();
  }));

test('a glb tile of a renderer in a second scene is a model of that scene, made from the default scene', () =>
  withEngine(async (engine) => {
    const { scene, renderer } = await loadIn(engine),
      glb = boxGLB(),
      content = await renderer.createContent(
        { type: 'glb', gltf: glb, byteLength: glb.byteLength },
        renderer.tileset.root,
        new AbortController().signal,
      );
    assert.equal(engine.scene.meshes.size, 0, 'the tile model landed in the default scene');
    assert.equal(engine.scene.plugins.size, 0, 'a plugin landed in the default scene');
    assert.ok(scene.meshes.size > 0, 'the second scene holds the tile model');
    content.dispose();
    renderer.dispose();
    assert.equal(scene.meshes.size, 0);
  }));

test('an aborted glb tile of a renderer in a second scene leaves nothing in either scene', () =>
  withEngine(async (engine) => {
    const { scene, renderer } = await loadIn(engine),
      glb = boxGLB(),
      controller = new AbortController(),
      made = renderer.createContent(
        { type: 'glb', gltf: glb, byteLength: glb.byteLength },
        renderer.tileset.root,
        controller.signal,
      );
    controller.abort(new Error('stop'));
    await assert.rejects(made, /stop/);
    assert.equal(engine.scene.meshes.size, 0);
    assert.equal(scene.meshes.size, 0);
    renderer.dispose();
  }));

test("a pnts tile's anchor of a renderer in a second scene is a mesh of that scene", () =>
  withEngine(async (engine) => {
    const { scene, renderer } = await loadIn(engine),
      { setup, registerPasses } = PointsPlugin.prototype;
    // The points plugin's GPU set-up needs a real device; the scene its anchor joins does not.
    PointsPlugin.prototype.setup = PointsPlugin.prototype.registerPasses = () => {};
    try {
      const content = await renderer.createContent(
        {
          type: 'pnts',
          positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
          featureTable: {},
          byteLength: 36,
        },
        renderer.tileset.root,
        new AbortController().signal,
      );
      assert.equal(engine.scene.meshes.size, 0, 'the anchor landed in the default scene');
      assert.ok(scene.meshes.size > 0, 'the second scene holds the anchor');
      content.dispose();
    } finally {
      Object.assign(PointsPlugin.prototype, { setup, registerPasses });
    }
    renderer.dispose();
  }));
