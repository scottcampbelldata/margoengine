// Scatterplot matrix (SPLOM, `scatterMatrix` in src/parcoords.ts): every off-diagonal cell (column cx, row cy) draws
// each table row at (cx + u[cx], d - 1 - cy + u[cy]), u being the row's value on that column's shared scale; the
// diagonal holds a histogram instead of points. Positions are checked against that closed form after fitting only
// the data-to-pixel scale and offset from the image, so a misplaced, missing or extra point fails. Brushing a cell,
// flipping an axis and reordering columns are checked the same way, on WebGPU and the WebGL2 compatibility backend.
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
      const { scatterMatrix } = await import('/packages/sciviz/dist/parcoords.js');
      const { ColumnarTable } = await import('/packages/sciviz/dist/table.js');
      const columns = { x: [2, 7, 5], y: [3, 6, 8], z: [9, 1, 4] },
        names = ['x', 'y', 'z'],
        d = 3;
      const table = new ColumnarTable(Object.fromEntries(names.map((n) => [n, Float64Array.from(columns[n])])));
      const canvas = document.createElement('canvas');
      canvas.style.width = canvas.style.height = '600px';
      document.body.append(canvas);
      const plot = await scatterMatrix(canvas, table, {
        axes: names.map((column) => ({ column, domain: [0, 10] })),
        rowIds: ['r0', 'r1', 'r2'],
        size: 4,
      });
      plot.figure.engine.stop();
      // Bright point pixels: the unselected dimming and the diagonal histogram stay below this blue margin.
      const blobs = async () => {
        await plot.ready();
        plot.figure.render();
        const bitmap = await createImageBitmap(await plot.figure.toPNG());
        const c = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
        c.drawImage(bitmap, 0, 0);
        const { width, height } = bitmap;
        bitmap.close();
        const px = c.getImageData(0, 0, width, height).data,
          seen = new Uint8Array(width * height),
          found = [];
        const ink = (i) => px[i * 4 + 2] > px[i * 4] + 100 && px[i * 4 + 1] > 120;
        for (let i = 0; i < width * height; i++) {
          if (seen[i] || !ink(i)) continue;
          let sx = 0, sy = 0, n = 0;
          const stack = [i];
          seen[i] = 1;
          while (stack.length) {
            const k = stack.pop(), x = k % width, y = (k - x) / width;
            sx += x; sy += y; n++;
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const nx = x + dx, ny = y + dy, j = ny * width + nx;
              if (nx >= 0 && ny >= 0 && nx < width && ny < height && !seen[j] && ink(j)) { seen[j] = 1; stack.push(j); }
            }
          }
          if (n >= 4) found.push([sx / n + 0.5, sy / n + 0.5]);
        }
        return found;
      };
      // Closed-form cell positions in data units for the plot's current order, flips and selected rows.
      const expected = (rows) => {
        const out = [];
        for (const r of rows)
          for (let cx = 0; cx < d; cx++)
            for (let cy = 0; cy < d; cy++) {
              if (cx === cy) continue;
              const u = (p) => { const axis = plot.data.order[p * 2], v = columns[names[axis]][r] / 10; return plot.data.order[p * 2 + 1] ? 1 - v : v; };
              out.push([cx + u(cx), d - 1 - cy + u(cy)]);
            }
        return out;
      };
      // Fit data-to-pixel x and y from the extreme points only, then every expected point must have its own blob.
      const compare = (want, got) => {
        if (want.length !== got.length) return { ok: false, why: `${got.length} blobs for ${want.length} points` };
        const fit = (k) => {
          const w = want.map((p) => p[k]), g = got.map((p) => p[k]);
          const scale = (Math.max(...g) - Math.min(...g)) / (Math.max(...w) - Math.min(...w));
          return k === 0 ? [scale, Math.min(...g) - scale * Math.min(...w)] : [-scale, Math.max(...g) + scale * Math.min(...w)];
        };
        const [ax, bx] = fit(0), [ay, by] = fit(1);
        let worst = 0;
        const used = new Set();
        for (const [x, y] of want) {
          const tx = ax * x + bx, ty = ay * y + by;
          let best = -1, bestDistance = Infinity;
          got.forEach(([gx, gy], k) => { const dd = Math.hypot(gx - tx, gy - ty); if (!used.has(k) && dd < bestDistance) { bestDistance = dd; best = k; } });
          used.add(best);
          worst = Math.max(worst, bestDistance);
        }
        return { ok: worst <= 1.5, worst, scale: ax };
      };
      const initial = compare(expected([0, 1, 2]), await blobs());
      plot.brushCell('x', 'y', [1, 6], [2, 7]);
      const brushedRows = [...plot.selection.rowIds];
      const brushed = compare(expected([0]), await blobs());
      plot.selection.clear();
      plot.flip('x');
      const flipped = compare(expected([0, 1, 2]), await blobs());
      plot.reorder(['z', 'x', 'y']);
      const reordered = compare(expected([0, 1, 2]), await blobs());
      const order = Array.from({ length: d }, (_, p) => names[plot.data.order[p * 2]]);
      let refused = false;
      try { plot.brushCell('x', 'y', [3, 1], [0, 1]); } catch (error) { refused = error instanceof RangeError; }
      plot.dispose();
      canvas.remove();
      return { initial, brushedRows, brushed, flipped, reordered, order, refused };
    });
    assert.deepEqual(errors, []);
    for (const key of ['initial', 'brushed', 'flipped', 'reordered']) assert.ok(result[key].ok, `${key}: ${JSON.stringify(result[key])}`);
    assert.ok(result.initial.scale > 100, 'a matrix cell spans more than 100 pixels');
    assert.deepEqual(result.brushedRows, ['r0']);
    assert.deepEqual(result.order, ['z', 'x', 'y']);
    assert.ok(result.refused, 'reversed brush ranges are refused');
    console.log(JSON.stringify({ compat, ...result }));
  } finally {
    await browser.close();
  }
}
