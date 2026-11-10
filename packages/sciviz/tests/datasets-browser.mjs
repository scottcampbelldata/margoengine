import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/examples/sciviz-datasets.html', port: 'free', compat }),
    errors = [];
  browser.page.on('pageerror', (e) => errors.push(e.message));
  browser.page.setDefaultTimeout(120000);
  try {
    await browser.page.waitForFunction(
      () => document.querySelector('canvas')?.dataset.ready || document.querySelector('canvas')?.dataset.error,
    );
    assert.equal(await browser.page.locator('canvas').getAttribute('data-error'), null);
    const report = await browser.page.evaluate(async () => {
      const demo = await import('/examples/sciviz-datasets.ts'),
        hashes = {};
      for (const format of ['plot3d', 'vtr', 'vts', 'vtm']) {
        await demo.show(format);
        const bitmap = await createImageBitmap(await demo.figure.toPNG({ overlays: false })),
          canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
          ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let lit = 0,
          hash = 2166136261;
        for (let i = 0; i < pixels.length; i += 4) {
          if (Math.max(...[0, 1, 2].map((k) => Math.abs(pixels[i + k] - pixels[k]))) > 30) lit++;
          hash = Math.imul(hash ^ pixels[i] ^ (pixels[i + 1] << 8) ^ (pixels[i + 2] << 16), 16777619);
        }
        if (lit < 500) throw new Error(`${format} needs real data pixels: ${lit}`);
        hashes[format] = hash;
      }
      const { createDataSet } = await import('/packages/sciviz/dist/datasets.js'),
        { contourGrid, contourGridGPU } = await import('/packages/sciviz/dist/contour.js'),
        gpu = await demo.figure.renderer.compute();
      const { openDataSet } = await import('/packages/sciviz/dist/datasets.js');
      const relative = await openDataSet('./assets/sciviz/datasets/flatplate.vtm');
      if (relative.blocks.length !== 2 || relative.types.length !== 1632)
        throw new Error('relative composite URLs must resolve against the document base');
      const grid = await createDataSet({
        kind: 'polydata',
        points: [0, 0, 0, 2, 0, 0],
        lines: [[0, 1]],
        vertices: [[0]],
        pointData: [0, 2],
      });
      const cpu = await contourGrid(grid, [0, 1]),
        actual = await contourGridGPU(gpu, grid, [0, 1]);
      for (const kind of ['triangles', 'lines', 'points']) {
        if (JSON.stringify([...cpu[kind].cells]) !== JSON.stringify([...actual[kind].cells]))
          throw new Error(`${kind} topology mismatch`);
        for (let i = 0; i < cpu[kind].positions.length; i++)
          if (Math.abs(cpu[kind].positions[i] - actual[kind].positions[i]) > cpu.floatBound)
            throw new Error(`${kind} coordinate mismatch`);
      }
      demo.figure.dispose();
      return { hashes, points: actual.points.cells.length };
    });
    assert.equal(report.hashes.plot3d, report.hashes.vts);
    assert.equal(report.hashes.vtr, report.hashes.vts);
    assert.equal(report.hashes.vts, report.hashes.vtm);
    assert.equal(report.points, 2);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ backend: compat ? 'WebGL2 compatibility' : 'WebGPU', ...report }));
  } finally {
    await browser.close();
  }
}
