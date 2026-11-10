import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/examples/sciviz-glyph.html', port: 'free', compat }),
    errors = [];
  browser.page.on('pageerror', (e) => errors.push(e.message));
  browser.page.setDefaultTimeout(120000);
  try {
    await Promise.race([
      browser.page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Ready.')),
      new Promise((_, reject) => browser.page.once('pageerror', reject)),
    ]);
    const report = await browser.page.evaluate(async () => {
      const demo = await import('/examples/sciviz-glyph.ts'),
        { Geometry } = await import('/packages/core/dist/index.js'),
        { glyphLayer, warpByScalar, warpByVector } = await import('/packages/sciviz/dist/glyph.js'),
        check = (v, m) => {
          if (!v) throw new Error(m);
        };
      demo.windFigure.engine.stop();
      demo.warpFigure.engine.stop();
      const pixels = async (figure) => {
        await figure.ready();
        figure.engine.render();
        const bitmap = await createImageBitmap(await figure.toPNG({ overlays: false })),
          canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
          ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let lit = 0,
          hash = 2166136261;
        for (let i = 0; i < data.length; i += 4) {
          hash = Math.imul(hash ^ data[i] ^ (data[i + 1] << 8) ^ (data[i + 2] << 16), 16777619);
          if (Math.max(...[0, 1, 2].map((k) => Math.abs(data[i + k] - data[k]))) > 30) lit++;
        }
        return { lit, hash };
      };
      const wind = await pixels(demo.windFigure),
        warp = await pixels(demo.warpFigure);
      check(wind.lit > 100 && warp.lit > 100, 'real NOAA and SEACAS pixels');
      check(demo.windFigure.engine.stats.drawCalls === 1, 'wind glyphs are one instanced draw');
      check(
        demo.windFigure.engine.stats.visible === demo.windLayer.instances.ids.length,
        'all selected wind rows draw',
      );
      const vector = await warpByVector(demo.exodusGrid, 'displacement', { scaleFactor: 20 }),
        scalar = await warpByScalar(demo.exodusGrid, '', { scaleFactor: 20 });
      let delta = 0;
      for (let i = 0; i < vector.points.length; i++) {
        const value = demo.exodusGrid.points[i] + 20 * demo.exodusGrid.pointArrays.displacement[i];
        delta = Math.max(delta, Math.abs(vector.points[i] - value));
        check(vector.points[i] === value, 'SEACAS vector warp exact');
        const expected =
          demo.exodusGrid.points[i] + (i % 3 === 2 ? 20 * demo.exodusGrid.pointData[Math.floor(i / 3)] : 0);
        check(scalar.points[i] === expected, 'SEACAS scalar warp exact');
      }
      const shapes = [];
      const custom = new Geometry([0, 0, 0, 1, 0, 0, 0, 0.6, 0], [0, 0, 1, 0, 0, 1, 0, 0, 1], [0, 1, 2]);
      for (const shape of ['arrow', 'cone', 'sphere', 'cube', 'line', custom]) {
        await demo.show(shape, 20, 'vector');
        const image = await pixels(demo.windFigure);
        check(
          image.lit > 20,
          `glyph ${typeof shape === 'string' ? shape : 'custom'} pixels ${JSON.stringify({ image, canvas: [document.querySelector('#wind').width, document.querySelector('#wind').height], stats: demo.windFigure.engine.stats, shapes })}`,
        );
        check(demo.windFigure.engine.stats.drawCalls === 1, 'one instanced draw per shape');
        shapes.push({ shape: typeof shape === 'string' ? shape : 'custom', ...image });
      }
      await demo.show('arrow', 20, 'scalar');
      const scalarImage = await pixels(demo.warpFigure);
      check(scalarImage.hash !== warp.hash, 'scalar and vector warp have different geometry');
      const before = await pixels(demo.windFigure);
      await demo.windFigure.engine.rebootDevice();
      const after = await pixels(demo.windFigure);
      check(before.hash === after.hash, 'glyph restoration is exact');
      const cellLayer = await glyphLayer(demo.warpFigure, demo.exodusGrid, {
        association: 'cell',
        shape: 'cube',
        scalars: Float32Array.from({ length: 1300 }, () => 0.01),
        scaleMode: 'scalar',
        stride: 25,
        mask: Float32Array.from({ length: 1300 }, (_, i) => (i % 50 === 0 ? 1 : 0)),
      });
      check(cellLayer.instances.ids.length === 26, 'cell stride and mask');
      cellLayer.dispose();
      const beforeCount = demo.windFigure.engine.scene.meshes.size;
      demo.windLayer.dispose();
      demo.windLayer.dispose();
      check(demo.windFigure.layers.length === 0, 'layer disposal detaches figure');
      check(demo.windFigure.engine.scene.meshes.size < beforeCount, 'owned meshes removed');
      demo.windFigure.dispose();
      demo.warpFigure.dispose();
      return {
        wind,
        warp,
        shapes,
        scalarImage,
        restored: after.hash === before.hash,
        vectorDelta: delta,
        nodes: demo.exodusGrid.points.length / 3,
        cells: demo.exodusGrid.types.length,
      };
    });
    assert.deepEqual(errors, []);
    console.log(`glyph ${compat ? 'WebGL2' : 'WebGPU'} ${JSON.stringify(report)}`);
  } finally {
    await browser.close();
  }
}
