// KB-POST-LATEDRAW1: a pass drawn before post-processing composes (order below 30, as Lines at its default 20) must
// reach the picture under every effect that captures the scene, at 1 sample and at 4, whichever of the two attached
// first. At 4 samples an effect that made its final resolve earlier lost those draws. Run it again with MARGO_COMPAT=1
// for the WebGL2 layer.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));

const effects = ['tonemap', 'dof', 'fxaa', 'smaa', 'bloom', 'ssao', 'taa', 'stack'];
const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 'free' });
const failures = [],
  checks = [],
  errors = [];
browser.page.on('pageerror', (error) => errors.push(String(error)));
browser.page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
try {
  /** Pixels of the line's green on the canvas after a few frames, and the GPU errors of those frames. */
  const draw = (options) =>
    browser.page.evaluate(async ({ effect, samples, order, linesFirst }) => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js');
      const { Line, Lines } = await import('/packages/lines/dist/index.js');
      const from = (path) => import('/packages/' + path + '.js');
      const canvas = document.createElement('canvas');
      document.body.append(canvas);
      const engine = await Engine.create(canvas, {
        backend: 'webgpu',
        exactSize: [128, 128],
        antialias: samples === 4,
        camera: { position: [0, 0, 5], target: [0, 0, 0] },
      });
      const lines = () =>
        Lines.attach(engine, { order }).add(
          new Line({ positions: [-1.5, 0.9, 0, 1.5, 0.9, 0], colors: [0, 1, 0, 0, 1, 0], width: 6 }),
        );
      if (linesFirst) lines();
      if (effect === 'tonemap') (await from('tonemap/dist/index')).Tonemap.attach(engine);
      if (effect === 'dof') (await from('dof/dist/index')).DOF.attach(engine, { focalDistance: 5 });
      if (effect === 'fxaa') (await from('post/dist/fxaa')).FXAA.attach(engine);
      if (effect === 'smaa') (await from('post/dist/smaa')).SMAA.attach(engine);
      if (effect === 'bloom') (await from('post/dist/bloom')).Bloom.attach(engine);
      if (effect === 'ssao') (await from('post/dist/ssao')).SSAO.attach(engine);
      if (effect === 'taa') (await from('taa/dist/index')).TAA.attach(engine);
      if (effect === 'stack') {
        const { PostStack } = await from('post/dist/stack');
        const { SSAO } = await from('post/dist/ssao');
        const { Tonemap } = await from('tonemap/dist/index');
        PostStack.attach(engine, [new SSAO(), new Tonemap()]);
      }
      if (!linesFirst) lines();
      engine
        .createMesh()
        .setGeometry(box(1, 1, 1))
        .setMaterial(new PbrMaterial({ color: [0.8, 0.2, 0.2], roughness: 0.6 }))
        .setPosition([0, -0.5, 0]);
      const device = engine.gpu;
      device.pushErrorScope('validation');
      for (let frame = 0; frame < 4; frame++) {
        engine.render({ delta: 0 });
        await device.queue.onSubmittedWorkDone();
      }
      engine.render({ delta: 0 });
      // Read in the render's task: the canvas texture is presented when it ends.
      const copy = new OffscreenCanvas(128, 128).getContext('2d');
      copy.drawImage(canvas, 0, 0);
      const pixels = copy.getImageData(0, 0, 128, 128).data;
      const error = await device.popErrorScope();
      let green = 0;
      for (let i = 0; i < pixels.length; i += 4)
        if (pixels[i + 1] > 120 && pixels[i + 1] > pixels[i] + 60 && pixels[i + 1] > pixels[i + 2] + 60) green++;
      const result = { green, samples: engine.renderTarget?.samples, error: error?.message ?? null };
      engine.dispose();
      canvas.remove();
      return result;
    }, options);

  for (const samples of [1, 4]) {
    const base = await draw({ effect: 'none', samples, order: 20, linesFirst: true });
    assert.ok(base.green > 200, `the line draws without an effect: ${JSON.stringify(base)}`);
    for (const effect of effects)
      for (const order of [20, 29])
        for (const linesFirst of [true, false]) {
          const result = await draw({ effect, samples, order, linesFirst });
          const check = { effect, samples, order, linesFirst, base: base.green, ...result };
          checks.push(check);
          if (result.error || result.green < base.green * 0.6) failures.push(check);
        }
  }
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/post-late-draw-browser.json', JSON.stringify({ checks }, null, 2));
  assert.deepEqual(failures, [], 'a pass below order 30 reaches the picture under every capturing effect');
  assert.deepEqual(errors, [], 'no page errors');
  console.log('post late draw PASS', checks.length, 'checks');
} finally {
  await browser.close();
}
