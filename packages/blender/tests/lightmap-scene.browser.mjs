// KB-OWN-BLEND2: parseMargoLightmap decoded its lightmap images, then called parseMargo, which captured the scene active
// by then, and applyLightmap installed its plugin in that scene too: a load started in a second scene's setup built its
// model and lightmap in the default scene. loadMargoLightmap fetched first and did the same. The model, its meshes and
// its lightmap plugin belong to the scene the load started in. On a real device (a lightmap uploads textures); run it
// natively and with MARGO_COMPAT=1 (the WebGL2 layer).
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-extension.html' });
const errors = [];
browser.page.on('pageerror', (e) => errors.push(e.message));
try {
  const result = await browser.page.evaluate(async () => {
    const { Engine } = await import('/packages/core/dist/index.js');
    const { loadMargoLightmap, parseMargoLightmap } = await import('/packages/blender/dist/lightmap.js');
    const url = '/packages/blender/tests/fixtures/lightmap.margo',
      bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    document.body.append(canvas);
    const engine = await Engine.create(canvas, { backend: 'webgpu', capacity: 16 });
    engine.gpu.pushErrorScope('validation');
    const names = (scene) => [...scene.plugins.keys()].filter((name) => name !== 'loader').sort();
    const rows = [];
    for (const [name, start] of [
      ['parseMargoLightmap', () => parseMargoLightmap(engine, bytes)],
      ['loadMargoLightmap', () => loadMargoLightmap(engine, url)],
    ]) {
      const scene = engine.createScene(`b-${name}`);
      let started;
      scene.use({ name: 'loader', setup: () => (started = start()) });
      const model = await started,
        row = {
          name,
          rootInScene: model.root.scene === scene,
          nodesInScene: model.nodes.every((node) => node.scene === scene),
          modelInScene: engine.sceneOf(model) === scene,
          scenePlugins: names(scene).length,
          defaultMeshes: engine.scene.meshes.size,
          defaultPlugins: names(engine.scene),
        };
      model.dispose();
      scene.removePlugin('loader');
      row.afterScene = { meshes: scene.meshes.size, plugins: names(scene) };
      row.afterDefault = { meshes: engine.scene.meshes.size, plugins: names(engine.scene) };
      scene.dispose();
      rows.push(row);
    }
    // Outside any setup the load stays in the default scene.
    const plain = await parseMargoLightmap(engine, bytes),
      outside = { inDefault: engine.sceneOf(plain) === engine.scene, plugins: names(engine.scene).length };
    plain.dispose();
    outside.after = { meshes: engine.scene.meshes.size, plugins: names(engine.scene) };
    const validation = (await engine.gpu.popErrorScope())?.message ?? null;
    engine.dispose();
    canvas.remove();
    return { rows, outside, validation };
  });
  console.log(JSON.stringify(result));
  for (const row of result.rows) {
    assert.ok(row.rootInScene, `${row.name}: the root is not in the second scene`);
    assert.ok(row.nodesInScene, `${row.name}: a node is not in the second scene`);
    assert.ok(row.modelInScene, `${row.name}: the model plugin is not in the second scene`);
    assert.ok(row.scenePlugins >= 2, `${row.name}: the lightmap plugin is not in the second scene`);
    assert.equal(row.defaultMeshes, 0, `${row.name}: meshes landed in the default scene`);
    assert.deepEqual(row.defaultPlugins, [], `${row.name}: a plugin landed in the default scene`);
    assert.deepEqual(row.afterScene, { meshes: 0, plugins: [] }, `${row.name}: dispose left part of the load behind`);
    assert.deepEqual(row.afterDefault, { meshes: 0, plugins: [] }, `${row.name}: the default scene holds a leftover`);
  }
  assert.ok(result.outside.inDefault, 'a load outside any setup left the default scene');
  assert.ok(result.outside.plugins >= 2, 'the lightmap plugin is not in the default scene');
  assert.deepEqual(result.outside.after, { meshes: 0, plugins: [] });
  assert.equal(result.validation, null);
  assert.deepEqual(errors, []);
  console.log(`PASS lightmap-scene${process.env.MARGO_COMPAT === '1' || process.argv.includes('--compat') ? ' (WebGL2 layer)' : ''}`);
} finally {
  await browser.close();
}
