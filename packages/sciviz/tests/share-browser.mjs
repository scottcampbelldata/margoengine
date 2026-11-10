import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { bundleShareRuntime } from '../scripts/bundle-share.mjs';
import { loadNRRD, nrrdGrid } from '@margoengine/sciviz/nrrd';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const runtime = await bundleShareRuntime();
await mkdir('test-results', { recursive: true });
const raw = nrrdGrid(await loadNRRD(await readFile('examples/assets/sciviz/head.nrrd'))).data;
await writeFile('test-results/batch179-mri-data.bin', new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
for (const compat of [false, true]) {
  const ctx = await openBrowser({ startPath: '/packages/sciviz/tests/sciviz.html', port: 'free', compat });
  ctx.page.setDefaultTimeout(90000);
  const errors = [];
  ctx.page.on('pageerror', (error) => errors.push(error.message));
  try {
    const report = await ctx.page.evaluate(
      async ({ runtime, compat }) => {
        const { Figure, loadSpecData, specHash } = await import('/packages/sciviz/dist/spec.js');
        const { Engine } = await import('/packages/core/dist/index.js');
        const { loadNRRD, nrrdGrid } = await import('/packages/sciviz/dist/nrrd.js');
        const { exportStandalone, createShareURL, readShareURL, openShare, connectEmbed, serveEmbed } = await import(
          '/packages/sciviz/dist/share.js'
        );
        const canvas = document.createElement('canvas');
        canvas.style.cssText = 'width:320px;height:240px';
        document.body.append(canvas);
        const engine = await Engine.create(canvas, { exactSize: [320, 240] });
        const fig = Figure.attach(engine, { axes: false, aspect: [174 / 254, 1, 1] });
        const grid = nrrdGrid(await loadNRRD('/examples/assets/sciviz/head.nrrd'));
        const pinned = await loadSpecData({
          url: location.origin + '/test-results/batch179-mri-data.bin',
          dtype: grid.data.constructor.name,
          length: grid.data.length,
          sha256: await specHash(new Uint8Array(grid.data.buffer, grid.data.byteOffset, grid.data.byteLength)),
        });
        const volume = fig.volume(pinned, {
          dims: grid.dims,
          bounds: grid.bounds,
          range: [0, 600],
          colormap: 'gray',
          density: 2,
        });
        volume.slice('z', 0.6, { opacity: 0.8 });
        const scatter = await fig.scatter({ x: [0, 0.2, 0.4], y: [0, 0.2, 0.4], z: [0, 0.2, 0.4] });
        fig.timeline(
          [0, 1],
          async (index) => {
            volume.density = index + 2;
          },
          { controls: false },
        );
        await fig.ready();
        const view = {
          camera: { position: [2.6, 1.7, 2.9], target: [0, 0, 0], up: [0, 1, 0], fov: 45, near: 0.01, far: 100 },
          timeIndex: 1,
        };
        const spec = await fig.toJSON({ data: 'url' });
        const url = await createShareURL(spec, location.origin + '/examples/sciviz-share.html', { view });
        const shared = await readShareURL(url);
        if (shared.view.timeIndex !== 1) throw Error('Lost time step');
        const next = document.createElement('canvas');
        next.style.cssText = canvas.style.cssText;
        document.body.append(next);
        const copyEngine = await Engine.create(next, { exactSize: [320, 240] });
        const copy = await openShare(url, next, { engine: copyEngine });
        const saved = await copy.toJSON();
        if (saved.time.index !== 1 || saved.camera.position.join() !== view.camera.position.join())
          throw Error('Deep link did not apply');
        const html = await (
          await exportStandalone(spec, {
            runtime,
            view,
            parentOrigin: location.origin,
            backend: compat ? 'webgl2' : 'webgpu',
            title: 'OpenNeuro T1 MRI, CC0',
          })
        ).text();
        const iframe = document.createElement('iframe');
        iframe.style.cssText = 'width:320px;height:240px;border:0';
        iframe.srcdoc = html.replace(
          '<canvas',
          '<script>window.addEventListener("margo-ready",e=>window.testFigure=e.detail)</script><canvas',
        );
        document.body.append(iframe);
        await new Promise((resolve, reject) => {
          const deadline = Date.now() + 60000;
          const poll = () => {
            if (iframe.contentWindow.testFigure) return resolve();
            const box = iframe.contentDocument?.querySelector('#error');
            if (box && !box.hidden) return reject(Error(box.textContent));
            if (Date.now() >= deadline) return reject(Error('Standalone readiness timed out'));
            setTimeout(poll, 50);
          };
          poll();
        });
        const client = connectEmbed({ origin: location.origin, peer: iframe.contentWindow });
        const state = await client.request('getState');
        let events = 0;
        client.addEventListener('state', () => events++);
        const changedCamera = { ...view.camera, position: [3, 2, 3] };
        const changed = await client.request('setCamera', changedCamera);
        if (changed.camera.position.join() !== '3,2,3') throw Error('Camera command lost');
        const atZero = await client.request('setTime', 0);
        if (atZero.timeIndex !== 0) throw Error('Time command lost');
        const selected = await client.request('setSelection', {
          region: { rect: [0, 0, 320, 240] },
          points: [{ layer: 1, indices: [0, 2] }],
        });
        if (selected.selection.points[0].indices.join() !== '0,2') throw Error('Selection command lost');
        let rejected = false;
        try {
          await client.request('setCamera', { ...changedCamera, far: -1 });
        } catch {
          rejected = true;
        }
        if (!rejected) throw Error('Invalid command accepted');
        const controller = new AbortController();
        const wrong = connectEmbed({ origin: location.origin, peer: iframe.contentWindow, channel: 'wrong' });
        const cancelled = wrong.request('getState', undefined, { signal: controller.signal });
        controller.abort(new Error('cancelled'));
        try {
          await cancelled;
          throw Error('Cancellation accepted');
        } catch (error) {
          if (error.message !== 'cancelled') throw error;
        }
        wrong.dispose();
        client.dispose();
        // Source check: a sibling with the correct origin cannot mutate the target server.
        const endpoint = serveEmbed(fig, {
          origin: location.origin,
          peer: iframe.contentWindow,
          channel: 'source-check',
        });
        const before = JSON.stringify(engine.camera.position);
        window.postMessage(
          { channel: 'source-check', id: 'spoof', method: 'setCamera', value: changedCamera },
          location.origin,
        );
        await new Promise((resolve) => requestAnimationFrame(resolve));
        if (JSON.stringify(engine.camera.position) !== before) throw Error('Spoofed source accepted');
        endpoint.dispose();
        const result = {
          urlLength: url.length,
          htmlBytes: new TextEncoder().encode(html).length,
          time: state.timeIndex,
          events,
          layers: saved.layers.length,
          html,
          url,
        };
        iframe.remove();
        copy.dispose();
        copyEngine.dispose();
        next.remove();
        fig.dispose();
        engine.dispose();
        canvas.remove();
        return result;
      },
      { runtime, compat },
    );
    assert.equal(report.time, 1);
    assert.ok(report.events >= 3);
    assert.deepEqual(errors, []);
    const suffix = compat ? 'webgl2' : 'webgpu';
    const file = `test-results/batch179-mri-standalone-${suffix}.html`;
    await writeFile(file, report.html);
    await writeFile(`test-results/batch179-mri-deep-link-${suffix}.txt`, report.url);
    await ctx.page.addInitScript(() =>
      window.addEventListener('margo-ready', (event) => {
        window.restoredFigure = event.detail;
      }),
    );
    await ctx.page.goto(report.url);
    await ctx.page.waitForFunction(() => !!window.restoredFigure);
    assert.equal(await ctx.page.evaluate(async () => (await window.restoredFigure.toJSON()).time.index), 1);
    await ctx.page.screenshot({ path: `test-results/batch179-mri-link-${suffix}.png` });
    const offlineContext = await ctx.page.context().browser().newContext();
    const offline = await offlineContext.newPage();
    const requests = [];
    offline.on('request', (request) => {
      if (/^https?:/.test(request.url())) requests.push(request.url());
    });
    await offline.route(/^https?:/, (route) => route.abort());
    await offline.addInitScript(() =>
      window.addEventListener('margo-ready', (event) => {
        window.restoredFigure = event.detail;
      }),
    );
    try {
      await offline.goto(pathToFileURL(resolve(file)).href);
      await offline.waitForFunction(() => !!window.restoredFigure, { timeout: 90000 });
      const lit = await offline.evaluate(async () => {
        const figure = window.restoredFigure;
        await figure.ready();
        const bitmap = await createImageBitmap(await figure.toPNG());
        const c = new OffscreenCanvas(bitmap.width, bitmap.height),
          context = c.getContext('2d');
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
        return context.getImageData(0, 0, c.width, c.height).data.filter((v, i) => i % 4 !== 3 && v > 60).length;
      });
      assert.ok(lit > 100);
      assert.deepEqual(requests, []);
      await offline.screenshot({ path: `test-results/batch179-mri-offline-${suffix}.png` });
    } finally {
      await offlineContext.close();
    }
    delete report.html;
    delete report.url;
    console.log(JSON.stringify({ backend: suffix, ...report }));
  } finally {
    await ctx.close();
  }
}
