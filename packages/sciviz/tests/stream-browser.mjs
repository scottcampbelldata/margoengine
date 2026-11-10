import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
await mkdir('test-results/stream', { recursive: true });
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/examples/sciviz-stream.html', port: 'free', compat }),
    errors = [];
  browser.page.on('pageerror', (e) => errors.push(e.message));
  browser.page.setDefaultTimeout(60000);
  try {
    await browser.page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Ready:'));
    const report = await browser.page.evaluate(async () => {
      const d = globalThis.streamDemo,
        { line, points, figure, chart } = d,
        identity = [line, points];
      await Promise.all([d.advance(30), d.advance(40)]);
      if (line.streamData.x.length !== 64 || points.count !== 64 || line.positions.length !== 64 * 3)
        throw Error('Rollover did not reach native geometry and metadata');
      if (!figure.layers.includes(identity[0]) || !figure.layers.includes(identity[1]) || figure.layers.length !== 2)
        throw Error('Native layer identity changed');
      const expected = d.samples.slice(9, 73);
      for (let i = 0; i < 64; i++)
        if (line.streamData.x[i] !== expected[i].time || line.streamData.y[i] !== expected[i].mag)
          throw Error('Rollover lost original USGS precision or order');
      const before = line.streamData.y[0];
      await line.patch(0, { y: [before + 0.5] });
      if (line.streamData.y[0] !== before + 0.5) throw Error('Patch not committed');
      await line.patch(0, { y: [before] });
      const p = figure.plotArea,
        b = figure.bounds;
      d.window.setTime(line.streamData.x.at(-1), true);
      await figure.ready();
      figure.render();
      const target = d.window.target;
      d.window.setTime(target + 1000);
      d.window.advance(250);
      if (!(d.window.end > target && d.window.end < target + 1000)) throw Error('Smooth axis did not interpolate');
      d.window.setTime(target, true);
      const old = [...line.streamData.y];
      let rejected = false;
      try {
        await line.patch(64, { y: [1] });
      } catch {
        rejected = true;
      }
      if (!rejected || JSON.stringify(old) !== JSON.stringify([...line.streamData.y]))
        throw Error('Rejected patch changed data');
      const svg = await chart.toSVG(),
        doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
      const dataCircles = doc.querySelectorAll('g[clip-path] circle').length,
        allCircles = doc.querySelectorAll('circle').length;
      if (dataCircles !== 64 || allCircles !== 65 || doc.querySelector('parsererror'))
        throw Error(`Expected 64 data circles and one legend swatch, got ${dataCircles} data / ${allCircles} total`);
      const stroke = doc.querySelector('polyline')?.getAttribute('stroke');
      if (stroke !== '#d47a46') throw Error('Updates changed the original line styling');
      const last = 63,
        worldX = chart.x.forward(line.streamData.x[last]),
        worldY = chart.y.forward(line.streamData.y[last]),
        bounds = figure.bounds,
        pixel = [
          p.x + ((worldX - bounds[0]) * p.width) / (bounds[1] - bounds[0]),
          p.y + (1 - (worldY - bounds[2]) / (bounds[3] - bounds[2])) * p.height,
        ];
      figure.render();
      const hit = figure.pick(...pixel, { radius: 8 });
      if (!hit || !identity.includes(hit.layer)) throw Error('Updated native trace cannot pick');
      const source = await import('/packages/sciviz/dist/stream.js'),
        controller = new AbortController(),
        probe = await source.streamLayer(
          figure,
          await chart.line({ x: d.samples.slice(0, 2).map((r) => r.time), y: [1, 2] }, { name: 'Abort probe' }),
          { signal: controller.signal, data: { x: d.samples.slice(0, 2).map((r) => r.time), y: [1, 2] } },
        ),
        count = probe.positions.length;
      const pending = probe.append({ x: [d.samples[2].time], y: [3] });
      controller.abort();
      let aborted = false;
      try {
        await pending;
      } catch {
        aborted = true;
      }
      if (!aborted || probe.positions.length !== count)
        throw Error('Abort changed a previously committed native layer');
      figure.remove(probe);
      const canvas = figure.engine.canvas,
        out = new OffscreenCanvas(canvas.width, canvas.height);
      figure.render();
      const ctx = out.getContext('2d');
      ctx.drawImage(canvas, 0, 0);
      const pixels = ctx.getImageData(0, 0, out.width, out.height).data;
      let ink = 0;
      for (let i = 0; i < pixels.length; i += 4)
        if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) - Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) > 30)
          ink++;
      if (ink < 1000) throw Error('Live native geometry did not render');
      return {
        retained: line.streamData.x.length,
        originalTime: line.streamData.x.at(-1),
        nativePoints: points.count,
        stroke,
        ink,
        pixel,
      };
    });
    const box = await browser.page.locator('#viewport').boundingBox();
    await browser.page.mouse.move(box.x + report.pixel[0] - 10, box.y + report.pixel[1]);
    const hover = await browser.page.evaluate(() =>
      globalThis.streamDemo.chart.hover.map((h) => ({ x: h.x, y: h.y, name: h.name })),
    );
    assert.equal(hover.length, 2, 'removed abort probe must not remain in unified hover');
    assert.ok(hover.some((h) => h.x > 1e12 && h.name === 'Event magnitudes'));
    const download = browser.page.waitForEvent('download');
    await browser.page.locator('#export').click();
    assert.equal((await download).suggestedFilename(), 'usgs-live.svg');
    await browser.page.screenshot({ path: `test-results/stream/${compat ? 'webgl2' : 'webgpu'}.png`, fullPage: true });
    await browser.page.setViewportSize({ width: 390, height: 800 });
    assert.ok(await browser.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await browser.page.evaluate(() => {
      const d = globalThis.streamDemo;
      d.stop();
      d.window.dispose();
      d.line.disposeStream();
      d.points.disposeStream();
      d.chart.dispose();
      d.figure.dispose();
    });
    assert.deepEqual(errors, []);
    console.log(`stream ${compat ? 'WebGL2' : 'WebGPU'} ${JSON.stringify(report)}`);
  } finally {
    await browser.close();
  }
}
