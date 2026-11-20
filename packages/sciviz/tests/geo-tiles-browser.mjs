import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
// Map tiles past zoom 20 lost their shape: the tile shader placed vertices at (x + u) / 2^zoom in float32 and the
// figure's float32 data-to-scene translation for a small area was huge. A tile framed the same way at zoom 2, 22 and
// 24 must draw the same picture.
const reports = [];
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/examples/sciviz-geo-lod.html', port: 'free', compat }),
    errors = [];
  browser.page.setDefaultTimeout(60000);
  browser.page.on('pageerror', (error) => errors.push(error.message));
  try {
    await browser.page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Ready.'));
    const report = await browser.page.evaluate(async () => {
      const { currentFigure } = await import('/examples/sciviz-geo-lod.ts');
      currentFigure().dispose();
      const { Figure } = await import('/packages/sciviz/dist/index.js');
      const { tileLayer, tileAt } = await import('/packages/sciviz/dist/geo.js');
      // Four flat quadrants, so a stretched or collapsed tile changes the picture.
      const image = new ImageData(8, 8);
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) {
          const q = (y < 4 ? 0 : 2) + (x < 4 ? 0 : 1),
            c = [
              [230, 40, 40],
              [40, 200, 60],
              [50, 70, 230],
              [240, 240, 240],
            ][q];
          image.data.set([...c, 255], (y * 8 + x) * 4);
        }
      const draw = async (zoom, [x, y]) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 256;
        document.body.append(canvas);
        const n = 2 ** zoom,
          x0 = (2 * x) / n - 1,
          x1 = (2 * (x + 1)) / n - 1,
          top = 1 - (2 * y) / n,
          bottom = 1 - (2 * (y + 1)) / n,
          w = x1 - x0,
          h = top - bottom;
        const figure = await Figure.create(canvas, {
          axes: false,
          controls: false,
          limits: [x0 - w / 2, x1 + w / 2, bottom - h / 2, top + h / 2, -1, 1],
          aspect: [1, 1, 1],
        });
        const gpuErrors = [];
        figure.renderer.device.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
        await tileLayer(figure, {
          tiles: async (z, tx, ty) => (z === zoom && tx === x && ty === y ? image : undefined),
          zoom,
          area: [((x + 0.5) / n) * 360 - 180, 0, ((x + 0.5) / n) * 360 - 180, 0].map((v, i) =>
            i % 2 ? (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n))) * 180) / Math.PI : v,
          ),
        });
        const camera = figure.engine.camera;
        camera.up = [0, 0, -1];
        camera.position = [0, 4, 0];
        camera.target = [0, 0, 0];
        figure.engine.stop();
        const bitmap = await createImageBitmap(await figure.toPNG({ overlays: false })),
          c = new OffscreenCanvas(bitmap.width, bitmap.height),
          g = c.getContext('2d');
        g.drawImage(bitmap, 0, 0);
        bitmap.close();
        const pixels = g.getImageData(0, 0, c.width, c.height).data;
        figure.dispose();
        canvas.remove();
        return { pixels, gpuErrors };
      };
      const lonlat = [7.0005, 46.0005];
      const reference = await draw(2, tileAt(...lonlat, 2));
      // Pixels of each quadrant colour: a whole, square tile shows four equal quadrants.
      const quadrants = [0, 0, 0, 0],
        p = reference.pixels;
      for (let i = 0; i < p.length; i += 4) {
        if (p[i] > 180 && p[i + 1] < 90 && p[i + 2] < 90) quadrants[0]++;
        else if (p[i] < 90 && p[i + 1] > 150 && p[i + 2] < 110) quadrants[1]++;
        else if (p[i] < 100 && p[i + 1] < 120 && p[i + 2] > 180) quadrants[2]++;
        else if (p[i] > 200 && p[i + 1] > 200 && p[i + 2] > 200) quadrants[3]++;
      }
      const rows = [];
      for (const zoom of [22, 24]) {
        const { pixels, gpuErrors } = await draw(zoom, tileAt(...lonlat, zoom));
        let different = 0;
        for (let i = 0; i < pixels.length; i += 4)
          if (
            Math.max(
              Math.abs(pixels[i] - reference.pixels[i]),
              Math.abs(pixels[i + 1] - reference.pixels[i + 1]),
              Math.abs(pixels[i + 2] - reference.pixels[i + 2]),
            ) > 24
          )
            different++;
        rows.push({ zoom, different, gpuErrors });
      }
      return { quadrants, size: Math.sqrt(p.length / 4), rows, gpuErrors: reference.gpuErrors };
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(report.gpuErrors, []);
    // The white quadrant also picks up light edge pixels, so the three saturated ones are compared.
    const smallest = Math.min(...report.quadrants.slice(0, 3)),
      largest = Math.max(...report.quadrants.slice(0, 3));
    assert.ok(smallest > report.size ** 2 / 200 && largest < smallest * 1.1, `zoom 2 quadrants ${report.quadrants}`);
    for (const row of report.rows) {
      assert.deepEqual(row.gpuErrors, []);
      // Only edge pixels may differ (rasterising the same square from different float32 inputs).
      assert.ok(row.different < 600, `zoom ${row.zoom}: ${row.different} pixels differ from the zoom 2 tile`);
    }
    reports.push({ compat, hardware: browser.hardware, ...report });
  } finally {
    await browser.close();
  }
}
await writeFile('test-results/sciviz-geo-tiles.json', JSON.stringify(reports, null, 2));
console.log('geo-tiles: a tile at zoom 22 and 24 draws the same picture as at zoom 2 on both backends');
