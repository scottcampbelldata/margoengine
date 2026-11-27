// A volume `transform` against the same picture drawn without one: a volume mirrored or turned by the transform must
// look like the axis-aligned volume of the samples moved the same way, seen from outside and from inside the box (a
// mirrored box turns its face winding, so a wrong cull mode draws nothing from inside). WebGPU and the WebGL2
// compatibility path.
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
      const { GpuPicking } = await import('/packages/sciviz/dist/pick-gpu.js');
      const n = 24,
        m = n - 1;
      // Different along every axis and either way along it.
      const value = (x, y, z) => 0.1 + (0.4 * x) / m + (y < 8 ? 0.4 : 0) + (z > 15 ? 0.1 : 0);
      const grid = (at) => {
        const data = new Float32Array(n * n * n);
        for (let z = 0; z < n; z++)
          for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) data[(z * n + y) * n + x] = at(x, y, z);
        return data;
      };
      const plain = grid(value);
      const cases = {
        // x -> m - x.
        mirrored: {
          transform: [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, m, 0, 0, 1],
          moved: grid((x, y, z) => value(m - x, y, z)),
        },
        // (x, y) -> (m - y, x), a quarter turn about z.
        turned: {
          transform: [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, m, 0, 0, 1],
          moved: grid((x, y, z) => value(y, m - x, z)),
        },
      };
      const views = { outside: [1.9, 1.4, 2.2], inside: [0.55, 0.35, 0.3] };
      const draw = async (data, transform, eye) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 192;
        canvas.style.width = canvas.style.height = '192px';
        document.body.append(canvas);
        const figure = await Figure.create(canvas, { axes: false, controls: false });
        figure.engine.stop?.();
        figure.engine.camera.position = eye;
        figure.engine.camera.target = [0, 0, 0];
        const layer = figure.volume(data, {
          dims: [n, n, n],
          colormap: 'gray',
          range: [0, 1],
          opacity: [
            [0, 0.05],
            [1, 0.4],
          ],
          shading: true,
          transform,
        });
        await figure.ready();
        figure.render();
        const bitmap = await createImageBitmap(await figure.toPNG({ overlays: false }));
        const c = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
        c.drawImage(bitmap, 0, 0);
        const pixels = c.getImageData(0, 0, bitmap.width, bitmap.height).data;
        const bounds = [...layer.bounds];
        // Off the centre column, where a mirrored position reported unmirrored would differ.
        const picking = new GpuPicking(figure),
          hit = await picking.pick(74, 100);
        picking.dispose();
        bitmap.close();
        figure.dispose();
        canvas.remove();
        return { pixels, bounds, picked: hit && [hit.x, hit.y, hit.z] };
      };
      // Mean absolute channel difference.
      const apart = (a, b) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0) / a.length;
      const out = {};
      for (const [name, { transform, moved }] of Object.entries(cases))
        for (const [view, eye] of Object.entries(views)) {
          const placed = await draw(plain, transform, eye),
            wanted = await draw(moved, undefined, eye),
            unmoved = await draw(plain, undefined, eye);
          out[`${name} ${view}`] = {
            error: apart(placed.pixels, wanted.pixels),
            control: apart(unmoved.pixels, wanted.pixels),
            bounds: placed.bounds,
            picked: placed.picked,
            wantedPick: wanted.picked,
          };
        }
      let refused = false;
      try {
        const canvas = document.createElement('canvas');
        document.body.append(canvas);
        const figure = await Figure.create(canvas, { axes: false, controls: false });
        try {
          figure.volume(plain, { dims: [n, n, n], transform: new Array(16).fill(0) });
        } finally {
          figure.dispose();
          canvas.remove();
        }
      } catch (error) {
        refused = /invertible/.test(error.message);
      }
      return { out, refused };
    });
    console.log(JSON.stringify({ compat, ...result }));
    assert.deepEqual(errors, []);
    for (const [name, { error, control, bounds, picked, wantedPick }] of Object.entries(result.out)) {
      // GPU picking reports the placed data position: the same point the moved samples give under that pixel.
      if (name.endsWith('outside')) {
        assert.ok(picked && wantedPick, `${name}: the pixel picks the volume`);
        assert.ok(
          wantedPick.every((v, i) => Math.abs(v - picked[i]) < 0.05),
          `${name}: picked ${picked}, the moved samples pick ${wantedPick}`,
        );
      }
      assert.deepEqual(bounds, [0, 23, 0, 23, 0, 23], name);
      assert.ok(control > 2, `${name}: the move must show (${control})`);
      assert.ok(error < 0.5, `${name}: the transform differs from the moved samples by ${error}`);
    }
    assert.ok(result.refused, 'a singular transform is refused');
  } finally {
    await browser.close();
  }
}
