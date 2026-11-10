import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const reports = [];
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/examples/sciviz-export-vector.html', port: 'free', compat });
  const errors = [];
  browser.page.on('pageerror', (e) => {
    errors.push(e.message);
    console.error(e.message);
  });
  browser.page.on('console', (m) => {
    if (m.type() === 'error') console.error(m.text());
  });
  const progress = setInterval(async () => {
    console.log(await browser.page.locator('#status').textContent());
  }, 10000);
  browser.page.setDefaultTimeout(120000);
  try {
    await browser.page.evaluate(async () => {
      await import('/examples/sciviz-export-vector.ts');
    });
    const report = await browser.page.evaluate(async () => {
      const demo = await import('/examples/sciviz-export-vector.ts');
      const { exportVector, exportVectorScene } = await import('/packages/sciviz/dist/export-vector.js');
      const { Figure } = await import('/packages/sciviz/dist/index.js');
      const check = (v, m) => {
        if (!v) throw new Error(m);
      };
      const parse = (svg) => new DOMParser().parseFromString(svg, 'image/svg+xml');
      const head = demo.result;
      check(
        head.mode === 'vector' && head.triangles > 100 && parse(head.svg).querySelectorAll('path').length > 100,
        'real MRI vectors',
      );
      check(!parse(head.svg).querySelector('image'), 'MRI contains no raster');
      const snapshot = await demo.figure.layers[0].vectorGeometry();
      check(snapshot.positions.length === head.triangles * 9, 'exact committed iso readback');
      const nasa = await demo.show('nasa');
      check(nasa.mode === 'vector' && nasa.triangles > 30000, 'complete NASA surface');
      check(
        !parse(nasa.svg).querySelector('image') && parse(nasa.svg).querySelectorAll('path').length > nasa.triangles,
        'NASA colour facets',
      );
      const raster = await exportVector(demo.figure, { maxTriangles: 1 });
      check(
        raster.mode === 'raster' && parse(raster.svg).querySelector('image') && raster.reason.includes('input limit'),
        'explicit figure raster fallback',
      );
      demo.figure.dispose();
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 240;
      document.body.append(canvas);
      const figure = await Figure.create(canvas, { axes: false, controls: false });
      try {
        const surface = figure.surface([0, 1, 2, 3], { nx: 2, contours: 0 });
        surface.setHeights([3, 2, 1, 0]);
        const mesh = await surface.vectorGeometry();
        check(
          mesh.positions[2] === 3 && mesh.positions[5] === 2 && mesh.positions.length === 18,
          'latest surface heights',
        );
        const trace = await figure.line({ x: [0, 1], y: [0, 1], z: [0, 1] }, { color: '#ff0000' });
        const points = await figure.scatter({ positions: [0, 0, 0, 1, 1, 1] }, { color: '#00ff00', size: 8 });
        points.cloud.updatePositions(0, [0.2, 0.3, 0.4]);
        // Integration output must keep surface, live line and point layers vector throughout.
        const all = await exportVector(figure);
        check(all.mode === 'vector' && !parse(all.svg).querySelector('image'), 'surface line and points vector');
        check(trace.line.count === 2 && points.cloud.positions[0] > 0, 'live series retained');
        const ac = new AbortController(),
          reason = new Error('cancel iso snapshot');
        ac.abort(reason);
        let cancelled = false;
        try {
          await surface.vectorGeometry({ signal: ac.signal });
        } catch (e) {
          cancelled = e === reason;
        }
        check(cancelled, 'snapshot cancellation identity');
      } finally {
        figure.dispose();
        canvas.remove();
      }
      // Browser rasterization is an independent pixel check of the exported depth order.
      const result = await exportVectorScene({
        width: 200,
        height: 200,
        matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        geometry: [
          {
            kind: 'triangles',
            positions: [-0.9, -0.8, 0.1, 0.9, -0.8, 0.9, 0, 0.9, 0.5],
            colors: [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1],
          },
          {
            kind: 'triangles',
            positions: [-0.9, -0.8, 0.9, 0.9, -0.8, 0.1, 0, 0.9, 0.5],
            colors: [0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1],
          },
        ],
      });
      const url = URL.createObjectURL(new Blob([result.svg], { type: 'image/svg+xml' })),
        image = new Image();
      try {
        image.src = url;
        await image.decode();
        const c = new OffscreenCanvas(200, 200),
          g = c.getContext('2d');
        g.drawImage(image, 0, 0);
        check(g.getImageData(60, 140, 1, 1).data[2] === 255, 'left pixel blue');
        check(g.getImageData(140, 140, 1, 1).data[0] === 255, 'right pixel red');
      } finally {
        URL.revokeObjectURL(url);
      }
      return {
        head: { triangles: head.triangles, fragments: head.fragments },
        nasa: { triangles: nasa.triangles, fragments: nasa.fragments },
        raster: raster.reason,
      };
    });
    assert.deepEqual(errors, []);
    reports.push({ compat, ...report });
    console.log(JSON.stringify(reports.at(-1)));
  } finally {
    clearInterval(progress);
    await browser.close();
  }
}
await mkdir('test-results', { recursive: true });
await writeFile('test-results/sciviz-export-vector.json', JSON.stringify(reports, null, 2) + '\n');
