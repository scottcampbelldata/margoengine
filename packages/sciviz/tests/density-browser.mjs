import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
const reports = [];
for (const fallback of [false, true]) {
  const browser = await openBrowser({ startPath: '/packages/sciviz/tests/volume-quality.html', port: 'free' }),
    errors = [];
  browser.page.setDefaultTimeout(120000);
  browser.page.on('pageerror', (e) => errors.push(e.message));
  try {
    const report = await browser.page.evaluate(async (fallback) => {
      const { Figure } = await import('/packages/sciviz/dist/index.js');
      const { createFallbackFigure } = await import('/packages/sciviz/dist/fallback.js');
      const { densityScatter } = await import('/packages/sciviz/dist/density.js');
      const { ColumnarTable, CrossFilter } = await import('/packages/sciviz/dist/table.js');
      const compat = fallback ? await import('/packages/webgl2-compat/dist/index.js') : undefined;
      const create = fallback ? (c, o) => createFallbackFigure(c, { ...o, compat }) : Figure.create;
      const canvas = document.createElement('canvas');
      canvas.width = 96;
      canvas.height = 64;
      canvas.style.cssText = 'width:96px;height:64px';
      document.body.append(canvas);
      const fig = await create(canvas, {
        mode: '2d',
        controls: false,
        axes: false,
        pointBudget: 1,
        limits: [-1, 1, -1, 1],
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
      });
      fig.engine.stop();
      const gpuErrors = [];
      fig.renderer.device.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
      const check = (v, m) => {
        if (!v) throw new Error(m);
      };
      const render = async () => {
        await fig.ready();
        fig.render();
        await fig.renderer.device.queue.onSubmittedWorkDone();
      };
      const sum = (a) => a.reduce((x, y) => x + y, 0);
      const pixels = async () => {
        const b = await createImageBitmap(await fig.toPNG()),
          c = new OffscreenCanvas(b.width, b.height),
          ctx = c.getContext('2d');
        ctx.drawImage(b, 0, 0);
        b.close();
        return ctx.getImageData(0, 0, c.width, c.height).data;
      };
      try {
        const points = new Float32Array([0.01, 0.01, 0, 0.01, 0.01, 0, -0.51, 0.51, 0, 5, 0, 0, NaN, 0, 0]);
        const source = await fig.scatter({ positions: points });
        const layer = densityScatter(fig, source, { opacity: 0.5, color: '#ffffff' });
        check(!source.cloud.visible, 'original budgeted scatter is suppressed');
        await render();
        const counts = await layer.readCounts();
        check(sum(counts) === 3 && Math.max(...counts) === 2, 'all in-frustum points vote once despite point budget 1');
        const expected = new Uint32Array(96 * 64);
        expected[31 * 96 + 48] = 2;
        expected[15 * 96 + 23] = 1;
        check(
          counts.every((v, i) => v === expected[i]),
          'every pixel equals independent analytical orthographic projection',
        );
        fig.setLimits([-0.25, 0.25, -0.25, 0.25]);
        await render();
        check(sum(await layer.readCounts()) === 2, 'pan/zoom rebin clips the view without a sampling budget');
        fig.setLimits([-1, 1, -1, 1]);
        await render();
        const before = await pixels();
        const bg = before[0],
          centre = (31 * 96 + 48) * 4;
        check(Math.abs(before[centre] - (bg * 0.25 + 255 * 0.75)) <= 2, 'two marks use 1-(1-opacity)^count');
        layer.setStyle({ mode: 'kernel', bandwidth: 2 });
        await render();
        const after = await pixels();
        check(
          before.some((v, i) => v !== after[i]),
          'Gaussian smoothing changes pixels',
        );
        let norm = 0;
        for (let d = -8; d <= 8; d++) norm += Math.exp((-d * d) / 8);
        const alpha = 1 - Math.exp((-Math.LN2 * 2) / (norm * norm));
        check(
          Math.abs(after[centre] - (bg * (1 - alpha) + 255 * alpha)) <= 2,
          'Gaussian impulse matches independent normalized analytical kernel',
        );
        check(
          (await layer.readCounts()).every((v, i) => v === counts[i]),
          'KDE never changes exact counts',
        );
        source.cloud.positions[0] = 0.51;
        layer.invalidate();
        await render();
        check((await layer.readCounts())[31 * 96 + 72] === 1, 'in-place updates upload after invalidation');
        await fig.updateData(source, { x: new Float32Array([-0.5, 0.5]), y: new Float32Array([0, 0]) });
        await render();
        check(
          layer.count === 2 && !source.cloud.visible && sum(await layer.readCounts()) === 2,
          'native scatter cloud replacement transfers suppression and reuploads every point',
        );
        layer.visible = false;
        check(fig.pick(48, 31) === null, 'replacement visibility controls source picking');
        layer.visible = true;
        layer.dispose();
        check(source.cloud.visible, 'disposing restores original scatter');
        fig.remove(layer);
        fig.remove(source);
        const table = new ColumnarTable({
          x: new Float32Array([-0.5, 0.5, 0.5]),
          y: new Float32Array([0.5, -0.5, -0.5]),
          v: new Float32Array([2, 4, 6]),
        });
        const direct = densityScatter(fig, new Float32Array([-0.5, 0.5, 0, 0.5, -0.5, 0, 0.5, -0.5, 0]), {
          opacity: 1,
        });
        await render();
        const aggregate = await direct.aggregate(table, {
          x: { column: 'x', bins: 2, range: [-1, 1] },
          y: { column: 'y', bins: 2, range: [-1, 1] },
          value: 'v',
        });
        check(
          JSON.stringify([...aggregate.count]) === '[0,2,1,0]' && aggregate.sum[1] === 10,
          'exact table aggregation linked to density',
        );
        const filter = new CrossFilter(table);
        filter.dimension('x').filterRange(0, 1);
        const filtered = await direct.aggregate(filter, { x: { column: 'x', bins: 2, range: [-1, 1] } });
        check(filtered.count[0] === 0 && filtered.count[1] === 2, 'exact filtered aggregation');
        filter.dispose();
        const active = new AbortController();
        active.abort(new Error('cancelled'));
        let cancelled = false;
        try {
          await direct.readCounts({ signal: active.signal });
        } catch (e) {
          cancelled = e.message === 'cancelled';
        }
        check(cancelled, 'cancelled readback');
        const previous = await direct.readCounts();
        direct.restore();
        await render();
        check(
          (await direct.readCounts()).every((v, i) => v === previous[i]),
          'restore reproduces counts',
        );
        await fig.engine.rebootDevice();
        await fig.renderer.ready();
        await render();
        check(
          (await direct.readCounts()).every((v, i) => v === previous[i]),
          'real device replacement reproduces counts',
        );
        canvas.width = 80;
        canvas.height = 48;
        canvas.style.cssText = 'width:80px;height:48px';
        await render();
        check(
          direct.rasterSize[0] === 80 && sum(await direct.readCounts()) === 3,
          'resize rebuilds raster without losing points',
        );
        fig.remove(direct);
        const empty = densityScatter(fig, new Float32Array());
        await render();
        check(sum(await empty.readCounts()) === 0, 'empty histogram');
        fig.remove(empty);
        const many = 100000,
          duplicates = new Float32Array(many * 3);
        const stress = densityScatter(fig, duplicates);
        await render();
        const exact = await stress.readCounts();
        check(Math.max(...exact) === many && sum(exact) === many, 'integer accumulation exceeds f16 saturation');
        fig.remove(stress);
        check(gpuErrors.length === 0, gpuErrors.join('\n'));
        return { fallback, exactMaximum: Math.max(...exact), votes: sum(exact), pixels: exact.length };
      } finally {
        fig.dispose();
        canvas.remove();
      }
    }, fallback);
    assert.deepEqual(errors, []);
    reports.push({ ...report, hardware: browser.hardware });
    console.log(JSON.stringify(report));
    await browser.page.goto(
      new URL(`/examples/sciviz-density.html${fallback ? '?backend=webgl2' : ''}`, browser.page.url()).href,
    );
    await browser.page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Ready.'));
    const demo = await browser.page.evaluate(async () => {
      const d = await import('/examples/sciviz-density.ts');
      d.stars.engine.stop();
      d.taxi.engine.stop();
      return {
        stars: d.starDensity.count,
        taxi: d.taxiDensity.count,
        exact: d.exact.count.reduce((a, b) => a + b, 0),
        sum: d.exact.sum.reduce((a, b) => a + b, 0),
      };
    });
    assert.equal(demo.stars, 1000000);
    assert.equal(demo.taxi, 1024);
    assert.equal(demo.exact, 1024);
    assert.ok(demo.sum > 0);
    reports.at(-1).demo = demo;
    assert.deepEqual(errors, []);
    await browser.page.screenshot({ path: `test-results/batch181-j4-demo-${fallback ? 'compat' : 'native'}.png` });
    console.log(JSON.stringify({ fallback, demo }));
  } finally {
    await browser.close();
  }
}
await writeFile('test-results/batch181-j4-density.json', JSON.stringify(reports, null, 2) + '\n');
