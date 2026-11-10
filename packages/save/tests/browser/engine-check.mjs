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
    const shoe = await loadGLTF(
      engine,
      new URL('/examples/assets/khronos/MaterialsVariantsShoe/MaterialsVariantsShoe.glb', location.href),
    );
    shoe.root.setPosition([0, 0.2, 2]).setScale([4, 4, 4]);
    shoe.selectVariant(1);
    knight.root.setPosition([-1, 0, 0]);
    copy.root.setPosition([1, 0, 0]).setRotation([0, 1, 0]);
    const hand = knight.nodes.findIndex((node) => /hand/i.test(node.name)),
      arm = knight.nodes[Math.max(hand, 0)];
    arm.setPosition([arm.position.x, arm.position.y + 0.2, arm.position.z + 0.3]);
    const sword = engine
      .createMesh(arm)
      .setGeometry(box(0.1, 1, 0.1))
      .setPosition([0, 0.5, 0]);
    sword.name = 'sword';
    sword.material.set({ color: [0.8, 0.1, 0.1], metalness: 0.5 });
    const floor = engine
      .createMesh()
      .setGeometry(box(6, 0.1, 6))
      .setPosition([0, -0.05, 0]);
    floor.name = 'floor';
    engine.use({
      name: 'score',
      value: 41,
      setup() {},
      saveState() {
        return this.value;
      },
      loadState(v) {
        this.value = v;
      },
    });
    Object.assign(engine.camera, { position: [0, 2, 6], target: [0, 1, 0], near: 0.1, far: 50, fov: 45 });
    engine.scene.lighting.direction.set([0.3, 0.8, 0.5, 2]);
    engine.scene.background = '#203040';
    const { Animation } = await import('/packages/animation/dist/index.js');
    const { Animator } = await import('/packages/animator/dist/index.js');
    const { captureSceneState, restoreSceneState } = await import('/packages/save/dist/scene-state.js');
    const animated = await loadGLTF(engine, '/examples/assets/khronos/Fox/Fox.glb');
    animated.root.setScale([0.02,0.02,0.02]);
    const player = Animation.attach(animated);
    if (!player.clips.length) throw Error('Fox fixture needs animation clips');
    const clip = player.clips[0].name;
    const animator = Animator.attach(player, { initial: 'a', states: { a: clip, b: clip } });
    animator.onPreUpdate(0.2);
    animator.transition('b', 1);
    animator.addLayer({ clip, weight: 0.35, mask: [0], time: 0.4 });
    animator.onPreUpdate(0.1);
    const bindings = { animations: { knight: animator, player } };
    const playback = JSON.parse(JSON.stringify(captureSceneState(bindings)));
    const poseBefore = await picture(engine);
    animator.onPreUpdate(0.2);
    restoreSceneState(playback, bindings);
    const poseAfter = await picture(engine);
    if (poseBefore.some((v, i) => v !== poseAfter[i])) throw Error('restored layered fade pixels differ');
    if (JSON.stringify(captureSceneState(bindings)) !== JSON.stringify(playback))
      throw Error('playback snapshot differs');
    animator.dispose();
    player.dispose();
    animated.dispose();
    const before = await picture(engine),
      extra = shoe.ownedMeshes.length - shoe.nodes.length - 1,
      storage = indexedDBStorage({ database: 'save-engine-check' }),
      saved = captureScene(engine, { meta: { title: 'proof' } });
    await saveGame(storage, 'slot', saved);
    const bytes = (await storage.read('slot')).length,
      target = await open(),
      score = {
        name: 'score',
        value: 0,
        setup() {},
        saveState() {
          return this.value;
        },
        loadState(v) {
          this.value = v;
        },
      };
    target.use(score);
    const restored = await restoreScene(target, await loadGame(storage, 'slot')),
      after = await picture(target);
    let different = 0,
      lit = 0;
    for (let i = 0; i < before.length; i++) {
      if (before[i] !== after[i]) different++;
      if (i % 4 === 0 && Math.abs(before[i] - 0x20) > 8) lit++;
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
  const owner = await page.evaluate(async () => {
    const { Engine, box } = await import('/packages/core/dist/index.js'),
      { restoreScene } = await import('/packages/save/dist/engine.js');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    document.body.append(canvas);
    const engine = await Engine.create(canvas, { backend: 'webgpu', exactSize: [64, 64] });
    try {
      const scene = engine.createScene('save-target'),
        made = [],
        errors = [];
      engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
      const sentinel = { name: 'factory', setup() {} };
      engine.use(sentinel);
      Object.assign(engine.camera, { position: [0, 0, 3], target: [0, 0, 0] });
      scene.background = '#000000';
      let passes = 0;
      const type = {
        attach(host) {
          const plugin = {
            name: 'factory',
            setup(runtime) {
              this.mesh = runtime.createMesh().setGeometry(box());
              this.mesh.material.set({ color: [1, 0, 0], unlit: true });
            },
            registerPasses(graph) {
              graph.add({
                name: 'factory',
                order: 1,
                execute() {
                  passes++;
                },
              });
            },
            dispose() {
              this.mesh.dispose();
            },
          };
          host.use(plugin);
          made.push(plugin);
          return plugin;
        },
      };
      const saved = { format: 'margo-save', version: 1, entities: [], meta: { engine: { plugins: { factory: {} } } } };
      await restoreScene(engine, saved, { scene, clear: false, plugins: { factory: { type } } });
      engine.render({ delta: 0, views: [{ scene, camera: engine.camera, viewport: [0, 0, 1, 1] }] });
      const bitmap = await createImageBitmap(canvas),
        flat = new OffscreenCanvas(64, 64).getContext('2d');
      flat.drawImage(bitmap, 0, 0);
      bitmap.close();
      const pixels = flat.getImageData(0, 0, 64, 64).data;
      let red = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 100 && pixels[i + 1] < 20) red++;
      const owned = engine.sceneOf(made[0]) === scene && made[0].mesh.scene === scene;
      scene.removePlugin('factory');
      const failure = await restoreScene(engine, saved, {
        scene,
        clear: false,
        plugins: {
          factory: {
            type,
            load() {
              throw new Error('reject state');
            },
          },
        },
      }).then(
        () => 'unexpected success',
        (error) => error.cause.message,
      );
      engine.render({ delta: 0, views: [{ scene, camera: engine.camera, viewport: [0, 0, 1, 1] }] });
      await engine.gpu.queue.onSubmittedWorkDone();
      return {
        red,
        owned,
        passes,
        failure,
        errors,
        remaining: scene.plugins.size,
        meshes: scene.meshes.size,
        sentinel: engine.scene.plugins.get('factory') === sentinel,
        aliases: engine.lighting === engine.scene.lighting,
      };
    } finally {
      engine.dispose();
    }
  });
  console.log(JSON.stringify({ owner }));
  assert.ok(owner.red > 100, `restored secondary factory mesh must draw, ${owner.red} red pixels`);
  assert.equal(owner.owned, true);
  assert.equal(owner.passes, 1, 'factory pass survives scope removal and rolls back on failure');
  assert.equal(owner.failure, 'reject state');
  assert.equal(owner.remaining, 0);
  assert.equal(owner.meshes, 0);
  assert.equal(owner.sentinel, true);
  assert.equal(owner.aliases, true);
  assert.deepEqual(owner.errors, []);
} finally {
  await browser.close();
}
