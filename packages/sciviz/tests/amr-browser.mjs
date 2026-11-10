import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/examples/sciviz-amr.html', port: 'free', compat }),
    errors = [];
  browser.page.on('pageerror', (e) => errors.push(e.message));
  browser.page.setDefaultTimeout(180000);
  try {
    await browser.page.waitForFunction(
      () => document.querySelector('#volume')?.dataset.ready || document.querySelector('#volume')?.dataset.error,
    );
    assert.equal(await browser.page.locator('#volume').getAttribute('data-error'), null);
    const report = await browser.page.evaluate(async () => {
      const demo = await import('/examples/sciviz-amr.ts'),
        result = {};
      async function pixels(figure) {
        await figure.ready();
        figure.engine.render();
        const bitmap = await createImageBitmap(await figure.toPNG({ overlays: false })),
          canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
          ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let lit = 0,
          green = 0,
          hash = 2166136261;
        for (let i = 0; i < data.length; i += 4) {
          if (Math.max(...[0, 1, 2].map((k) => Math.abs(data[i + k] - data[k]))) > 25) lit++;
          if (data[i + 1] > data[i] + 30 && data[i + 1] > data[i + 2] + 30) green++;
          hash = Math.imul(hash ^ data[i] ^ (data[i + 1] << 8) ^ (data[i + 2] << 16), 16777619);
        }
        return { lit, hash, green };
      }
      for (const [name, f] of Object.entries(demo.figures)) result[name] = await pixels(f);
      const f = demo.figures.volume,
        layer = demo.volume,
        old = layer.source.density;
      layer.source.density = old * 2;
      result.dense = await pixels(f);
      layer.source.density = old;
      layer.source.mode = 'mip';
      // MIP displays one classified sample. Use an opaque classifier density,
      // independently of the very dilute curve needed for many composite samples.
      layer.source.density = 32;
      result.mip = await pixels(f);
      layer.source.mode = 'composite';
      layer.source.density = old;
      layer.source.clip = [{ normal: [1, 0, 0], offset: -0.5 }];
      result.clipped = await pixels(f);
      layer.source.clip = [];
      layer.visible = false;
      result.hidden = await pixels(f);
      layer.visible = true;
      result.blocks = demo.licensed.blocks.length;
      result.levels = [...new Set(demo.licensed.blocks.map((b) => b.level))];
      result.nodes = demo.licensed.nodes.length;
      const before = await pixels(f);
      layer.restore();
      result.restored = await pixels(f);
      result.before = before;
      layer.dispose();
      const { createAMR, amrVolume } = await import('/packages/sciviz/dist/amr.js');
      const { colorScale } = await import('/packages/sciviz/dist/colormaps.js');
      const encoded = amrVolume(
        f,
        createAMR([
          { level: 0, dims: [2, 2, 2], bounds: [0, 1, 0, 1, 0, 1], values: [NaN, -2, -2, -2, -2, -2, -2, -2] },
        ]),
        {
          range: [0, 1],
          mode: 'mip',
          shading: false,
          colormap: colorScale('coolwarm', { domain: [0, 1], under: '#00ff00', over: '#ff0000' }),
        },
      );
      result.encoded = await pixels(f);
      encoded.dispose();
      for (const figure of Object.values(demo.figures)) figure.dispose();
      return result;
    });
    for (const key of ['volume', 'slice', 'contour', 'mip'])
      assert.ok(report[key].lit > 100, `${key} has real rendered pixels`);
    assert.notEqual(report.dense.hash, report.volume.hash);
    assert.notEqual(report.clipped.hash, report.volume.hash);
    assert.notEqual(report.hidden.hash, report.volume.hash);
    assert.equal(report.before.hash, report.restored.hash);
    assert.ok(report.encoded.green > 100, 'encoded float transfer texture preserves below-range negative MIP values');
    assert.ok(report.blocks > 1 && report.levels.length > 1 && report.nodes > report.blocks);
    assert.deepEqual(errors, []);
    assert.equal(await browser.page.evaluate(() => window.__margoWGSLErrors?.length ?? 0), 0);
    console.log(compat ? 'webgl2-compat' : 'webgpu', JSON.stringify(report));
  } finally {
    await browser.close();
  }
}
