// The former early colour resolve is the control. Compare every canvas byte within each backend;
// no tolerance, timing, shader substitution or smaller workload. postBrowser takes the GPU lock.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from './post-browser.mjs';

await postBrowser(
  'ssao-resolve',
  5489,
  () => launchBrowser({ headless: true, args: process.env.BROWSER_ARGS ? JSON.parse(process.env.BROWSER_ARGS) : [] }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const adapter = await navigator.gpu.requestAdapter();
      console.log(JSON.stringify({ adapter: adapter.info }));
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { SSAO } = await import('/packages/post/dist/ssao.js'),
        { GTAO } = await import('/packages/post/dist/gtao.js'),
        { PostStack } = await import('/packages/post/dist/stack.js'),
        { Tonemap } = await import('/packages/tonemap/dist/index.js');
      window.resolveTest = { Engine, PbrMaterial, box, SSAO, GTAO, PostStack, Tonemap };
    });
    let checked = 0;
    for (const samples of [1, 4])
      for (const kind of ['standalone', 'stacked', 'gtao']) {
        await page.evaluate(
          async ({ samples, kind }) => {
            const { Engine, PbrMaterial, box, SSAO, GTAO, PostStack, Tonemap } = window.resolveTest,
              engine = await Engine.create(document.querySelector('canvas'), {
                backend: 'webgpu',
                exactSize: samples === 1,
                camera: { position: [3, 2, 5], target: [0, 0, 0] },
              });
            engine.stop();
            for (const [position, size, color] of [
              [[0, -0.8, 0], [8, 0.1, 8], '#c0a080'],
              [[0, 0, 0], [1, 1.5, 1], '#4090c0'],
              [[0.65, 0.1, 0.5], [0.25, 1.7, 0.25], '#f05020'],
            ])
              engine
                .createMesh()
                .setGeometry(box(...size))
                .setPosition(position)
                .setMaterial(new PbrMaterial({ color }));
            const effect = kind === 'gtao' ? new GTAO() : new SSAO();
            if (kind === 'standalone') engine.use(effect);
            else PostStack.attach(engine, [effect, new Tonemap()]);
            const extractDepth = effect.extractDepth;
            window.resolveTest.frame = async (baseline, resize) => {
              if (resize) {
                const canvas = document.querySelector('canvas');
                canvas.width = 257;
                canvas.height = 193;
                canvas.style.width = '257px';
                canvas.style.height = '193px';
              }
              effect.extractDepth = baseline
                ? function (c) {
                    this.captureTarget.resolve(c.encoder);
                  }
                : extractDepth;
              engine.render({ delta: 1 / 60 });
              await engine.gpu.queue.onSubmittedWorkDone();
            };
            window.resolveTest.dispose = () => engine.dispose();
          },
          { samples, kind },
        );
        for (const resize of [false, true]) {
          await page.evaluate(({ resize }) => window.resolveTest.frame(true, resize), { resize });
          const baseline = await shot();
          await page.evaluate(() => window.resolveTest.frame(false, false));
          const optimized = await shot();
          if (!optimized.data.every((value, i) => value === baseline.data[i])) {
            const difference = (a, b) => {
              let changed = 0,
                max = 0;
              for (let i = 0; i < a.length; i++) {
                const delta = Math.abs(a[i] - b[i]);
                if (delta) changed++;
                max = Math.max(max, delta);
              }
              return { changed, max };
            };
            const controls = [];
            for (let i = 0; i < 3; i++) {
              await page.evaluate(() => window.resolveTest.frame(true, false));
              controls.push((await shot()).data);
            }
            console.log(
              JSON.stringify({
                kind,
                samples,
                resize,
                candidate: difference(optimized.data, baseline.data),
                unchangedControls: controls.map((data) => difference(data, baseline.data)),
              }),
            );
          }
          assert.deepEqual(optimized.data, baseline.data, `${kind} ${samples}x ${resize ? 'resized' : 'initial'}`);
          assert.ok(new Set(optimized.data).size > 30, 'nonempty shaded scene');
          checked++;
        }
        await page.evaluate(() => window.resolveTest.dispose());
      }
    console.log(JSON.stringify({ checked, byteIdentical: true }));
  },
);
