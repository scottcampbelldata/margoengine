// Minimum intensity projection (MinIP) against its closed form. A 24^3 volume holds 0.8 everywhere except a central
// 12^3 block of 0.2. With an opaque transfer function, the ray through the centre crosses the block, so MinIP must show
// exactly the colour of 0.2, MIP the colour of 0.8, and a ray beside the block 0.8 in both. Composite stops at the
// front face, 0.8. The colours are compared with the grey map's own value. WebGPU and the WebGL2 compatibility path.
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
      const { colormap } = await import('/packages/sciviz/dist/colormaps.js');
      const n = 24,
        data = new Float32Array(n * n * n).fill(0.8);
      for (let z = 6; z < 18; z++) for (let y = 6; y < 18; y++) for (let x = 6; x < 18; x++) data[(z * n + y) * n + x] = 0.2;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256;
      canvas.style.width = canvas.style.height = '256px';
      document.body.append(canvas);
      const figure = await Figure.create(canvas, { axes: false, controls: false });
      figure.engine.stop?.();
      // Straight down onto the box: every ray crosses it top to bottom.
      figure.engine.camera.position = [0, 2.2, 0.0001];
      figure.engine.camera.target = [0, 0, 0];
      figure.engine.camera.up = [0, 0, -1];
      const volume = figure.volume(data, { dims: [n, n, n], colormap: 'gray', range: [0, 1], opacity: [[0, 1], [1, 1]], shading: false });
      const read = async () => {
        await figure.ready();
        figure.render();
        const bitmap = await createImageBitmap(await figure.toPNG({ overlays: false }));
        const c = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
        c.drawImage(bitmap, 0, 0);
        const w = bitmap.width, h = bitmap.height;
        bitmap.close();
        const at = (fx, fy) => Array.from(c.getImageData(Math.floor(w * fx), Math.floor(h * fy), 1, 1).data);
        // Beside: this camera sees the volume across the whole canvas and the block over about the middle 45%, so a ray
        // 6% in from the left crosses only the 0.8 shell.
        return { centre: at(0.5, 0.5), beside: at(0.06, 0.5) };
      };
      const map = colormap('gray'),
        grey = (t) => map.sample(t).map((v) => Math.round(v * 255));
      const out = {};
      for (const mode of ['minip', 'mip', 'composite']) {
        volume.mode = mode;
        out[mode] = await read();
      }
      let refused = false;
      try { figure.volume(data, { dims: [n, n, n], mode: 'minimum' }); } catch (error) { refused = error instanceof TypeError; }
      figure.dispose();
      canvas.remove();
      return { ...out, low: grey(0.2), high: grey(0.8), refused };
    });
    assert.deepEqual(errors, []);
    const near = (pixel, rgb, what) => assert.ok(rgb.every((v, i) => Math.abs(pixel[i] - v) <= 3) && pixel[3] === 255, `${what}: ${pixel} versus ${rgb}`);
    near(result.minip.centre, result.low, 'MinIP through the block is the block value');
    near(result.mip.centre, result.high, 'MIP through the block is the shell value');
    near(result.composite.centre, result.high, 'opaque composite stops at the front face');
    near(result.minip.beside, result.high, 'MinIP beside the block sees only the shell');
    near(result.mip.beside, result.high, 'MIP beside the block sees only the shell');
    assert.ok(result.refused, 'an unknown mode is refused');
    console.log(JSON.stringify({ compat, ...result }));
  } finally {
    await browser.close();
  }
}
