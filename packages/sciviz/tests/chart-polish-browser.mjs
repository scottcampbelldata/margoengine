import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
await mkdir('test-results/chart-polish', { recursive: true });
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/examples/sciviz-chart-polish.html', port: 'free', compat }),
    errors = [];
  browser.page.on('pageerror', (e) => errors.push(e.message));
  browser.page.setDefaultTimeout(60000);
  try {
    await browser.page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Ready:'));
    const report = await browser.page.evaluate(async () => {
      const d = window.chartPolishDemo,
        { chart, figure, existing, secondary } = d,
        p = figure.plotArea,
        b = figure.bounds,
        index = 100;
      const pixel = (l) => [
        p.x + ((l.positions[index * 3] - b[0]) * p.width) / (b[1] - b[0]),
        p.y + (1 - (l.positions[index * 3 + 1] - b[2]) / (b[3] - b[2])) * p.height,
      ];
      const {attachAccessibility} = await import('/packages/sciviz/dist/a11y.js');
      const accessible = attachAccessibility(figure);
      await accessible.ready;
      const rows = accessible.series.find(s => s.name === secondary.name);
      const source = await fetch('/examples/assets/sciviz/stats/ghcn.json').then(r => r.json());
      if (!rows || rows.count !== source.length || rows.datum(index).x !== Date.parse(source[index].date) || rows.datum(index).y !== 32 + 1.8 * source[index].tmin)
        throw Error('Accessible secondary values lost exact original data units');
      accessible.dispose();
      chart.setVisible(secondary, false);
      figure.render();
      const [x, y] = pixel(existing),
        before = figure.pick(x, y, { radius: 3 });
      if (before?.layer !== existing) throw Error('Regression setup did not hit the existing line');
      chart.setVisible(existing, false);
      if (figure.pick(x, y, { radius: 3 }) !== null) throw Error('Hidden layer still picks');
      if (figure.select({ rect: [0, 0, 2000, 2000] }).points.length) throw Error('Hidden layer still selects');
      if ((await figure.toSVG()).includes('<polyline')) throw Error('Hidden lines still export');
      chart.setVisible(existing, true);
      chart.setVisible(secondary, true);
      const svg = await chart.toSVG(),
        doc = new DOMParser().parseFromString(svg, 'image/svg+xml'),
        ids = [...doc.querySelectorAll('[id]')].map((n) => n.id);
      if (doc.querySelector('parsererror') || ids.length !== new Set(ids).size)
        throw Error('Inset export has invalid XML or duplicate clip identifiers');
      if (!svg.includes('Minimum °F') || doc.querySelectorAll('svg').length !== 2)
        throw Error('Secondary axis or inset absent from export');
      if (d.cluster.rows.order.length !== 12 || d.cluster.columns.order.length !== 28)
        throw Error('Cluster dimensions lost');
      if (d.cluster.dendrogram.innerHTML.includes('NaN')) throw Error('Invalid dendrogram coordinate');
      // Security: axis chrome and the dendrogram are built with createElementNS, setAttribute and text nodes. HTML
      // parsing is trapped while a chart with hostile labels and categories lays out and both overlays redraw.
      const sink = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
      Object.defineProperty(Element.prototype, 'innerHTML', {
        configurable: true,
        get: sink.get,
        set() {
          throw Error('chart overlay parsed an HTML string');
        },
      });
      try {
        const hostile = '"><img src=x onerror="window.__chartXSS=1"><script>window.__chartXSS=1</script>',
          host = document.createElement('div'),
          canvas = document.createElement('canvas');
        host.style.cssText = 'position:relative;width:320px;height:200px';
        canvas.style.cssText = 'width:320px;height:200px';
        host.append(canvas);
        document.body.append(host);
        const { createFigure } = await import('/examples/sciviz-demo.ts'),
          { polishFigure } = await import('/packages/sciviz/dist/format.js');
        const hostileFigure = await createFigure(canvas, { mode: '2d', theme: 'light', tooltips: false, legend: false });
        const hostileChart = await polishFigure(hostileFigure, {
          xLabel: hostile,
          yLabel: hostile,
          categories: { x: [hostile, 'b'] },
          y: { domain: [0, 1] },
        });
        hostileChart.relayout();
        const overlay = hostileChart.element;
        if (overlay.querySelector('img,script')) throw Error('Hostile chart labels created elements');
        if ([...overlay.querySelectorAll('text')].filter((t) => t.textContent === hostile).length < 3)
          throw Error('Hostile chart labels did not stay literal text');
        if (!(await hostileChart.toSVG()).includes('&quot;&gt;&lt;img src=x onerror=&quot;window.__chartXSS=1&quot;'))
          throw Error('Exported chart SVG does not escape hostile labels');
        await d.cluster.toSVG();
        if (d.cluster.dendrogram.querySelectorAll('path').length !== 1) throw Error('Dendrogram did not redraw');
        if (window.__chartXSS !== undefined) throw Error('A hostile chart label ran script');
        hostileChart.dispose();
        hostileFigure.dispose();
        host.remove();
      } finally {
        Object.defineProperty(Element.prototype, 'innerHTML', sink);
      }
      for (const f of [d.imageFigure, d.clusterFigure]) {
        f.render();
        const c = f.engine.canvas,
          out = new OffscreenCanvas(c.width, c.height),
          ctx = out.getContext('2d');
        ctx.drawImage(c, 0, 0);
        const p = ctx.getImageData(0, 0, c.width, c.height).data;
        let colored = 0;
        for (let i = 0; i < p.length; i += 4)
          if (Math.max(p[i], p[i + 1], p[i + 2]) - Math.min(p[i], p[i + 1], p[i + 2]) > 15) colored++;
        if (colored < 10000) throw Error('Native rectangle trace was not registered with the renderer');
      }
      return {
        secondary: svg.includes('Minimum °F'),
        nested: doc.querySelectorAll('svg').length,
        imagePixels: d.image.values.length,
        rows: d.cluster.rows.order,
        cols: d.cluster.columns.order,
        point: [x, y],
        originalY: chart.y.inverse(existing.positions[index * 3 + 1]),
      };
    });
    assert.ok(report.originalY > -15 && report.originalY < 40);
    assert.equal(report.imagePixels, 372);
    const legend = browser.page.locator('[data-sciviz-legend]').first().locator('[data-chart-legend]');
    assert.equal(await legend.count(), 2);
    assert.equal(await browser.page.locator('[data-sciviz-legend]').first().getAttribute('role'), 'group');
    for (const row of await legend.all()) {
      const box = await row.boundingBox();
      assert.ok(box.width >= 24 && box.height >= 24, 'Legend button needs a real 24px target');
    }
    await legend.first().click();
    assert.equal(await browser.page.evaluate(() => window.chartPolishDemo.existing.line.visible), false);
    await legend.first().dblclick();
    assert.equal(await browser.page.evaluate(() => window.chartPolishDemo.secondary.line.visible), false);
    await browser.page.evaluate(() => {
      const d = window.chartPolishDemo;
      d.chart.setVisible(d.existing, true);
      d.chart.setVisible(d.secondary, true);
    });
    const canvas = await browser.page.locator('#primary').boundingBox();
    await browser.page.mouse.move(canvas.x + canvas.width * 0.3, canvas.y + canvas.height * 0.65);
    assert.equal(await browser.page.evaluate(() => window.chartPolishDemo.chart.hover.length), 2);
    const text = await browser.page.locator('[data-sciviz-unified-hover]').first().textContent();
    assert.match(text, /Maximum °C/);
    assert.match(text, /Minimum °F/);
    await browser.page.getByRole('button', { name: '30 days', exact: true }).click();
    assert.ok(
      await browser.page.evaluate(() => {
        const d = window.chartPolishDemo,
          b = d.figure.bounds;
        return Math.abs(d.chart.x.inverse(b[1]) - d.chart.x.inverse(b[0]) - 30 * 86400000) < 1;
      }),
    );
    await browser.page.getByRole('button', { name: 'All', exact: true }).click();
    const download = browser.page.waitForEvent('download');
    await browser.page.locator('#download').click();
    assert.equal((await download).suggestedFilename(), 'ghcn-chart-polish.svg');
    await browser.page.screenshot({
      path: `test-results/chart-polish/${compat ? 'webgl2' : 'webgpu'}.png`,
      fullPage: true,
    });
    await browser.page.setViewportSize({ width: 390, height: 800 });
    await browser.page.waitForFunction(() => {
      const c = document.querySelector('#primary'),
        s = c.parentElement.querySelector('svg');
      return Number(s.getAttribute('width')) === c.clientWidth;
    });
    assert.ok(await browser.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const cleanup = await browser.page.evaluate(() => {
      const d = window.chartPolishDemo;
      d.chart.dispose();
      let rejects = false;
      try {
        d.chart.setRange(0, 1);
      } catch {
        rejects = true;
      }
      return { rejects, inset: d.inset.canvas.parentElement.style.position, removed: !d.chart.element.isConnected };
    });
    assert.deepEqual(cleanup, { rejects: true, inset: '', removed: true });
    assert.deepEqual(errors, []);
    console.log(`chart-polish ${compat ? 'WebGL2' : 'WebGPU'} ${JSON.stringify(report)}`);
  } finally {
    await browser.close();
  }
}
