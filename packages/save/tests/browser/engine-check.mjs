// Real proof of @margoengine/save/engine: a real WebGPU engine with the real Knight.glb twice (the second a cloneModel
// copy), the real MaterialsVariantsShoe.glb on its second variant, a posed node, a sword hanging
// from a hand, a box and a plugin. The scene is captured, gzipped, written to
// the browser's real IndexedDB, read back, restored into a NEW engine on a new canvas, and the two frames must match
// byte for byte. Then a load of a file that 404s must leave the running scene drawing the same frame.
// `npm run test:gpu --workspace @margoengine/save`.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';

const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 'free' }),
  { page } = browser,
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' && !/404/.test(message.text())) errors.push(message.text());
});
try {
  const result = await page.evaluate(async () => {
    const { Engine, box } = await import('/packages/core/dist/index.js'),
      { loadGLTF } = await import('/packages/gltf-pro/dist/index.js'),
      { cloneModel } = await import('/packages/animation/dist/skeleton-utils.js'),
      { indexedDBStorage, loadGame, saveGame } = await import('/packages/save/dist/index.js'),
      { captureScene, restoreScene } = await import('/packages/save/dist/engine.js');
    const url = new URL('/examples/assets/kaykit/adventurers/characters/Knight.glb', location.href).href;
    const open = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256;
      canvas.style.cssText = 'width:256px;height:256px';
      document.body.append(canvas);
      return Engine.create(canvas, { backend: 'webgpu', capacity: 4096, exactSize: [256, 256] });
    };
    /** Two frames (the first bakes batches), then the second's pixels, read before the frame is presented. */
    const picture = async (engine) => {
      engine.render({ delta: 0 });
      await new Promise((resolve) => requestAnimationFrame(resolve));
      engine.render({ delta: 0 });
      const bitmap = await createImageBitmap(engine.canvas),
        flat = new OffscreenCanvas(256, 256).getContext('2d', { willReadFrequently: true });
      flat.drawImage(bitmap, 0, 0);
      return flat.getImageData(0, 0, 256, 256).data;
    };
    const engine = await open(),
      knight = await loadGLTF(engine, url),
      copy = await cloneModel(knight);
    const shoe = await loadGLTF(engine, new URL('/examples/assets/khronos/MaterialsVariantsShoe/MaterialsVariantsShoe.glb', location.href));
    shoe.root.setPosition([0, 0.2, 2]).setScale([4, 4, 4]);
    shoe.selectVariant(1);
    knight.root.setPosition([-1, 0, 0]);
    copy.root.setPosition([1, 0, 0]).setRotation([0, 1, 0]);
    const hand = knight.nodes.findIndex((node) => /hand/i.test(node.name)),
      arm = knight.nodes[Math.max(hand, 0)];
    arm.setPosition([arm.position.x, arm.position.y + 0.2, arm.position.z + 0.3]);
    const sword = engine.createMesh(arm).setGeometry(box(0.1, 1, 0.1)).setPosition([0, 0.5, 0]);
    sword.name = 'sword';
    sword.material.set({ color: [0.8, 0.1, 0.1], metalness: 0.5 });
    const floor = engine.createMesh().setGeometry(box(6, 0.1, 6)).setPosition([0, -0.05, 0]);
    floor.name = 'floor';
    engine.use({ name: 'score', value: 41, setup() {}, saveState() { return this.value; }, loadState(v) { this.value = v; } });
    Object.assign(engine.camera, { position: [0, 2, 6], target: [0, 1, 0], near: 0.1, far: 50, fov: 45 });
    engine.scene.lighting.direction.set([0.3, 0.8, 0.5, 2]);
    engine.scene.background = '#203040';
    const before = await picture(engine),
      extra = shoe.ownedMeshes.length - shoe.nodes.length - 1,
      storage = indexedDBStorage({ database: 'save-engine-check' }),
      saved = captureScene(engine, { meta: { title: 'proof' } });
    await saveGame(storage, 'slot', saved);
    const bytes = (await storage.read('slot')).length,
      target = await open(),
      score = { name: 'score', value: 0, setup() {}, saveState() { return this.value; }, loadState(v) { this.value = v; } };
    target.use(score);
    const restored = await restoreScene(target, await loadGame(storage, 'slot')),
      after = await picture(target);
    let different = 0,
      lit = 0;
    for (let i = 0; i < before.length; i++) {
      if (before[i] !== after[i]) different++;
      if (i % 4 === 0 && (Math.abs(before[i] - 0x20) > 8)) lit++;
    }
    // A save with a file that is not there: the scene keeps drawing the same frame.
    const broken = structuredClone(saved);
    broken.entities.push({ id: 'ghost', components: { mesh: new URL('/nothing/here.glb', location.href).href } });
    const message = await restoreScene(target, broken).then(
        () => 'restored',
        (error) => error.code,
      ),
      still = await picture(target);
    let moved = 0;
    for (let i = 0; i < after.length; i++) if (after[i] !== still[i]) moved++;
    return {
      nodes: knight.nodes.length,
      extra,
      variant: [...restored.models.values()].find((model) => model.variants.length)?.selectedVariant,
      entities: saved.entities.map((entity) => entity.id),
      movedNodes: Object.keys(saved.entities[0].components.model?.nodes ?? {}).length,
      bytes,
      models: restored.models.size,
      meta: restored.meta,
      score: score.value,
      different,
      lit,
      message,
      moved,
      plugins: [...target.scene.plugins.keys()].filter((name) => name.startsWith('gltf-pro')).length,
    };
  });
  console.log(JSON.stringify(result));
  assert.deepEqual(errors, []);
  assert.deepEqual(result.entities, ['Knight', 'Knight-1', 'MaterialsVariantsShoe', 'sword', 'floor']);
  assert.equal(result.models, 3);
  assert.equal(result.variant, 1);
  assert.equal(result.score, 41);
  assert.deepEqual(result.meta, { title: 'proof' });
  assert.ok(result.lit > 2000, `the frame must show the scene, ${result.lit} pixels differ from the background`);
  assert.equal(result.different, 0, 'the restored frame differs from the saved one');
  assert.equal(result.message, 'failed');
  assert.equal(result.moved, 0, 'a failed restore changed the frame');
  assert.equal(result.plugins, 3, 'a failed restore left a model behind');
} finally {
  await browser.close();
}
