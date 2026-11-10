// Multi-volume and multi-component compositing against closed forms. Two opaque grey channels of 0.2 and 0.8 in one
// box mix within the first step to the mean of their linear colours, then stop (opacity is above 0.99). A second
// channel whose box covers only the left half of x mixes there and leaves the right half to the first channel alone.
// Interleaved two-component tuples split by componentChannels draw the same pixel as the two separate channels.
// WebGPU and the WebGL2 compatibility path.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/packages/sciviz/tests/sciviz.html', port: 'free', compat });
  const errors = [];
  browser.page.on('pageerror', (e) => errors.push(e.message));
  browser.page.setDefaultTimeout(120000);
  try {
    const result = await browser.page.evaluate(async () => {
      const { Figure } = await import('/packages/sciviz/dist/index.js');
      const { multiVolume, componentChannels } = await import('/packages/sciviz/dist/multivolume.js');
      const { colormap } = await import('/packages/sciviz/dist/colormaps.js');
      const n = 8, dims = [n, n, n], count = n * n * n;
      const constant = (v) => new Float32Array(count).fill(v);
      const look = { colormap: 'gray', range: [0, 1], opacity: [[0, 1], [1, 1]] };
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256;
      canvas.style.width = canvas.style.height = '256px';
      document.body.append(canvas);
      const shot = async (channels) => {
        const figure = await Figure.create(canvas, { axes: false, controls: false });
        figure.engine.stop?.();
        figure.engine.camera.position = [0, 2.2, 0.0001];
        figure.engine.camera.target = [0, 0, 0];
        figure.engine.camera.up = [0, 0, -1];
        const layer = multiVolume(figure, channels);
        await figure.ready();
        figure.render();
        const bitmap = await createImageBitmap(await figure.toPNG({ overlays: false }));
        const c = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
        c.drawImage(bitmap, 0, 0);
        const w = bitmap.width, h = bitmap.height;
        bitmap.close();
        const at = (fx) => Array.from(c.getImageData(Math.floor(w * fx), Math.floor(h / 2), 1, 1).data);
        const out = { left: at(0.32), centre: at(0.5), right: at(0.68), bounds: [...layer.bounds] };
        layer.dispose();
        figure.dispose();
        return out;
      };
      const both = await shot([{ ...look, data: constant(0.2), dims }, { ...look, data: constant(0.8), dims }]);
      const half = await shot([
        { ...look, data: constant(0.2), dims, bounds: [0, 1, 0, 1, 0, 1] },
        { ...look, data: constant(0.8), dims, bounds: [0, 0.5, 0, 1, 0, 1] },
      ]);
      const tuples = new Float32Array(count * 2);
      for (let i = 0; i < count; i++) { tuples[2 * i] = 0.2; tuples[2 * i + 1] = 0.8; }
      const components = await shot(componentChannels(tuples, 2, dims, [look, look]));
      const map = colormap('gray');
      const decode = (s) => (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4);
      const encode = (l) => (l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055);
      const mixed = map.sample(0.2).map((s, k) => Math.round(encode((decode(s) + decode(map.sample(0.8)[k])) / 2) * 255));
      const low = map.sample(0.2).map((s) => Math.round(s * 255));
      const refusals = [];
      for (const bad of [[], Array(5).fill({ data: constant(0), dims }), [{ data: constant(0), dims: [n, n, n + 1] }], [{ data: constant(0), dims, range: [1, 1] }], [{ data: constant(0), dims, bounds: [1, 0, 0, 1, 0, 1] }]]) {
        try { new (await import('/packages/sciviz/dist/multivolume.js')).MultiVolumeLayer({ device: null, add() {} }, bad); refusals.push(false); } catch (error) { refusals.push(error instanceof RangeError); }
      }
      canvas.remove();
      return { both, half, components, mixed, low, refusals };
    });
    assert.deepEqual(errors, []);
    const near = (pixel, rgb, what) => assert.ok(rgb.every((v, i) => Math.abs(pixel[i] - v) <= 3), `${what}: ${pixel} versus ${rgb}`);
    for (const key of ['left', 'centre', 'right']) near(result.both[key], result.mixed, `two channels in one box mix at ${key}`);
    near(result.half.left, result.mixed, 'the half-box channel mixes inside its box');
    near(result.half.right, result.low, 'outside its box only the first channel shows');
    assert.deepEqual(result.half.bounds, [0, 1, 0, 1, 0, 1]);
    for (const key of ['left', 'centre', 'right']) assert.deepEqual(result.components[key], result.both[key], `components equal separate channels at ${key}`);
    assert.deepEqual(result.refusals, [true, true, true, true, true]);
    console.log(JSON.stringify({ compat, ...result }));
  } finally {
    await browser.close();
  }
}
