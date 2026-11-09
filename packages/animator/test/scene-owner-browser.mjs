// Real skin/morph deformation, rendered pixels and scene-owned Animator/graph lifetimes.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { animatedTriangle } from '../../../tests/support/gltf-pro-fixture.js';
import { decodePNG } from '../../../tests/support/png.js';

const browser = await openBrowser({ startPath: '/tests/modern-game.html', port: 'free' });
const { page } = browser;
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
const data = animatedTriangle();
try {
  const cases = [];
  for (const target of ['default', 'secondary'])
    for (const factory of ['Animator', 'AnimatorGraph'])
      for (const mode of ['direct', 'owner']) {
        const result = await page.evaluate(
          async ({ doc, buffers, target, factory, mode }) => {
            const { EngineKernel } = await import('/packages/core/dist/index.js');
            const { engineRuntime } = await import('/packages/core/dist/extension.js');
            const { GLTFAsset, PBRModel } = await import('/packages/gltf-pro/dist/index.js');
            const { Animation } = await import('/packages/animation/dist/index.js');
            const { Animator } = await import('/packages/animator/dist/index.js');
            const { AnimatorGraph } = await import('/packages/animator/dist/graph.js');
            document.body.replaceChildren();
            const canvas = document.createElement('canvas');
            document.body.append(canvas);
            const instance = await EngineKernel.create(canvas, {
              backend: 'webgpu',
              exactSize: [64, 64],
              capacity: 64,
              camera: { position: [0, 0, 3], target: [0, 0, 0] },
            });
            const engine = engineRuntime(instance),
              device = engine.gpu;
            device.pushErrorScope('validation');
            const scene = target === 'default' ? engine.scene : engine.createScene('animator-owner');
            let model;
            scene.use({
              name: 'model-loader',
              setup(runtime) {
                model = new PBRModel(
                  runtime,
                  new GLTFAsset(
                    doc,
                    buffers.map((b) => new Uint8Array(b)),
                  ),
                );
                runtime.use(model);
              },
            });
            const animation = new Animation(model);
            scene.use(animation);
            const handle = (factory === 'Animator' ? Animator : AnimatorGraph).attach(animation, {
              initial: 'move',
              states: { move: 'Move' },
            });
            const animator = handle.animator ?? handle;
            const check = (ok, why) => {
              if (!ok) throw new Error(why);
            };
            check(engine.sceneOf(animator) === scene, 'factory registration owner');
            const sentinel = { name: animator.name, setup() {} };
            if (target === 'secondary') engine.use(sentinel);
            animator.onDeviceRestored();
            animator.onPreUpdate(0.25);
            check(animator.time === 0.25, 'direct update retained owner');
            check(Math.abs(model.nodes[1].position.x - 0.1) < 1e-6, 'actual clip pose');
            await engine.render({ delta: 0, views: [{ scene, camera: engine.camera, viewport: [0, 0, 64, 64], pixels: true }] });
            await device.queue.onSubmittedWorkDone();
            if (mode === 'direct') handle.dispose();
            else scene.removePlugin(animator.name);
            check(!engine.sceneOf(animator), 'direct/owner detach');
            check(animation.playing, 'prior Animation playback restored');
            if (target === 'secondary')
              check(engine.scene.plugins.get(animator.name) === sentinel, 'same-name isolation');
            const replacement = new Animator(animation, { initial: 'move', states: { move: 'Move' } });
            scene.use(replacement);
            handle.dispose();
            check(scene.plugins.get(animator.name) === replacement, 'replacement identity');
            replacement.onPreUpdate(0.25);
            await engine.render({ delta: 0, views: [{ scene, camera: engine.camera, viewport: [0, 0, 64, 64], pixels: true }] });
            await device.queue.onSubmittedWorkDone();
            check((await device.popErrorScope()) === null, 'GPU validation');
            window.ownerFixture = { instance };
            return { target, factory, mode, time: replacement.time, x: model.nodes[1].position.x };
          },
          {
            doc: data.doc,
            buffers: data.buffers.map((b) => [...new Uint8Array(b.buffer, b.byteOffset, b.byteLength)]),
            target,
            factory,
            mode,
          },
        );
        const png = await decodePNG(await page.locator('canvas').screenshot());
        let lit = 0;
        for (let i = 0; i < png.data.length; i += 4) if (png.data[i] + png.data[i + 1] + png.data[i + 2] > 80) lit++;
        assert.ok(lit > 30, `actual animated model pixels: ${lit}`);
        cases.push({ ...result, lit });
        await page.evaluate(() => window.ownerFixture.instance.dispose());
      }
  assert.deepEqual(errors, []);
  await writeFile('test-results/animator-scene-owner-browser.json', JSON.stringify({ cases, errors }, null, 2));
  console.log('Animator scene owners PASS', JSON.stringify(cases));
} finally {
  await browser.close();
}
