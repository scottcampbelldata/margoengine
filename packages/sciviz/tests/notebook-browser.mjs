import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { prepareNotebookFixtures } from './notebook-fixtures.mjs';

await mkdir('test-results/sciviz-notebook', { recursive: true });
// The pages read the shipped notebook's real comm payloads: make them now (CPU work, before any browser opens), as no
// earlier run of python/tests/notebook-fixtures.py can be relied on (amd-gpu-hunt row 18).
prepareNotebookFixtures();
for (const compat of [false, true]) {
  const ctx = await openBrowser({ startPath: '/packages/sciviz/tests/sciviz.html', port: 'free', compat });
  ctx.page.setDefaultTimeout(60000);
  const errors = [];
  ctx.page.on('pageerror', (error) => errors.push(error.message));
  try {
    const result = await ctx.page.evaluate(async (compat) => {
      const { render } = await import('/packages/sciviz/dist/notebook.js');
      const { Figure, recordedFigure } = await import('/packages/sciviz/dist/spec.js');
      const results = [];
      for (const name of ['mri', 'exo']) {
        const state = await (await fetch(`/test-results/sciviz-notebook/${name}.json`)).json();
        state.backend = compat ? 'webgl2' : 'webgpu';
        state.camera = null;
        state.selection = null;
        for (const key in state.buffers)
          state.buffers[key] = new DataView(await (await fetch(state.buffers[key])).arrayBuffer());
        const events = new Map();
        let saves = 0;
        const model = {
          get: (key) => state[key],
          set: (key, value) => {
            state[key] = value;
            for (const f of events.get(`change:${key}`) ?? []) f();
          },
          save_changes: () => ++saves,
          on: (key, f) => events.set(key, [...(events.get(key) ?? []), f]),
          off: (key, f) =>
            events.set(
              key,
              (events.get(key) ?? []).filter((x) => x !== f),
            ),
        };
        const host = document.createElement('div');
        host.style.width = '480px';
        document.body.append(host);
        let figure,
          ready = 0;
        host.addEventListener('margo-notebook-ready', (event) => {
          figure = event.detail;
          ++ready;
        });
        const controller = new AbortController();
        const dispose = await render({ model, el: host, signal: controller.signal,
          prepareBackend: async (options) => (await import('/packages/webgl2-compat/dist/index.js')).install(options),
        });
        await figure.ready();
        figure.engine.stop();
        figure.engine.render();
        const bitmap = await createImageBitmap(await figure.toPNG({ overlays: false }));
        const surface = new OffscreenCanvas(bitmap.width, bitmap.height),
          context = surface.getContext('2d');
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
        const pixels = context.getImageData(0, 0, surface.width, surface.height).data;
        let lit = 0;
        for (let i = 0; i < pixels.length; i += 4) if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 180) ++lit;
        if (lit < 50) throw new Error(`${name} drew only ${lit} lit pixels`);
        const camera = { ...state.spec.camera, position: [3, 2, 2] };
        model.set('camera', camera);
        if (figure.engine.camera.position[0] !== 3) throw new Error('Kernel camera did not reach the figure');
        figure.engine.camera.position = [4, 2, 2];
        figure.controls.dispatchEvent(new Event('change'));
        if (state.camera.position[0] !== 4) throw new Error('View camera did not reach the kernel');
        if (name === 'exo') {
          const region = { rect: [0, 0, 480, 360] };
          model.set('selection', {
            region,
            points: [{ layer: 0, indices: new DataView(new Uint32Array([2, 5]).buffer) }],
          });
          if (figure.selection.points[0].indices[1] !== 5) throw new Error('Kernel selection did not reach the figure');
          figure.setSelection({ region, points: [{ layer: figure.layers[0], indices: new Uint32Array([1, 3]) }] });
          if (state.selection.points[0].indices[1] !== 3) throw new Error('View selection did not reach the kernel');
          const full = await figure.toJSON();
          const canvas = document.createElement('canvas');
          canvas.style.cssText = 'width:480px;height:360px';
          document.body.append(canvas);
          const restored = await Figure.fromJSON(full, canvas);
          await restored.ready();
          if (restored.selection.points[0].indices[1] !== 3) throw new Error('Notebook selection was not portable');
          restored.dispose();
          canvas.remove();
          const prior = figure;
          model.set('spec', { ...state.spec, options: { ...state.spec.options, theme: 'light' } });
          const deadline = Date.now() + 60000;
          while (ready < 2 && !state.error && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
          if (state.error || ready !== 2 || figure === prior)
            throw new Error('Model spec replacement failed: ' + state.error);
          const removed = host.querySelector('canvas');
          model.set('height', 99);
          if (!state.error.includes('height') || recordedFigure(removed))
            throw new Error('Error display retained its figure');
          model.set('height', 360);
          model.set('spec', { ...state.spec });
          const recoveryDeadline = Date.now() + 60000;
          while (ready < 3 && Date.now() < recoveryDeadline) await new Promise((r) => setTimeout(r, 20));
          if (ready !== 3 || state.error) throw new Error('Corrected model did not recover after a rejected update');
        }
        controller.abort();
        dispose();
        if (host.childNodes.length || [...events.values()].some((a) => a.length))
          throw new Error('AFM disposal retained a view or subscriptions');
        host.remove();
        results.push({ name, lit, saves, ready });
      }
      return results;
    }, compat);
    // Python's static output must work from file: without any network request.
    let requests = 0;
    await ctx.page.route(/^https?:/, (route) => {
      ++requests;
      return route.abort();
    });
    for (const name of ['mri', 'exo']) {
      await ctx.page.addInitScript(() => {
        window.addEventListener('margo-notebook-ready', () => {
          globalThis.notebookReady = true;
        });
      });
      await ctx.page.goto(pathToFileURL(resolve(`test-results/sciviz-notebook/${name}.html`)).href);
      await ctx.page.waitForFunction(() => globalThis.notebookReady === true);
      await ctx.page.screenshot({ path: `test-results/sciviz-notebook/${name}-${compat ? 'webgl2' : 'webgpu'}.png` });
    }
    assert.equal(requests, 0, 'offline output made HTTP requests');
    assert.deepEqual(errors, []);
    await writeFile(
      `test-results/sciviz-notebook/${compat ? 'webgl2' : 'webgpu'}.json`,
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify({ compat, result, offlineRequests: requests }));
  } finally {
    await ctx.close();
  }
}
