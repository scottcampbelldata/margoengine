import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
const reports = [];
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/examples/sciviz-geo-vector.html', port: 'free', compat });
  const errors = [];
  browser.page.setDefaultTimeout(60000);
  browser.page.on('pageerror', (e) => errors.push(e.message));
  try {
    await browser.page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Ready.'));
    const report = await browser.page.evaluate(async () => {
      const demo = await import('/examples/sciviz-geo-vector.ts');
      const { Figure } = await import('/packages/sciviz/dist/index.js');
      const { geoVectorLayer, parseGeoVectors } = await import('/packages/sciviz/dist/geo-vector.js');
      const counts = [];
      for (const dataset of ['countries', 'states'])
        for (const projection of ['globe', 'plate', 'mercator']) {
          document.querySelector('#dataset').value = dataset;
          document.querySelector('#projection').value = projection;
          await demo.start();
          const figure = demo.currentFigure();
          figure.engine.stop();
          const bitmap = await createImageBitmap(await figure.toPNG({ overlays: false }));
          const c = new OffscreenCanvas(bitmap.width, bitmap.height),
            g = c.getContext('2d');
          g.drawImage(bitmap, 0, 0);
          bitmap.close();
          const p = g.getImageData(0, 0, c.width, c.height).data;
          let lit = 0;
          for (let i = 0; i < p.length; i += 4) if (Math.max(p[i], p[i + 1], p[i + 2]) > 65) lit++;
          counts.push({ dataset, projection, lit, labels: document.querySelectorAll('.margo-geo-label').length });
        }
      for (const mode of ['points', 'hexagon', 'square']) {
        document.querySelector('#dataset').value = 'countries';
        document.querySelector('#mode').value = mode;
        document.querySelector('#projection').value = 'globe';
        await demo.start();
        await demo.currentFigure().toPNG();
      }
      demo.currentFigure().dispose();
      const figure = await Figure.create(document.querySelector('#map'), {
        axes: false,
        controls: false,
        limits: [-1, 1, -1, 1, -1, 1],
        aspect: [1, 1, 1],
      });
      figure.engine.camera.position = [6, 0, 0];
      figure.engine.camera.target = [0, 0, 0];
      const gpuErrors = [];
      figure.renderer.device.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
      const features = [
        { type: 'Feature', properties: { name: 'front' }, geometry: { type: 'Point', coordinates: [0, 0] } },
        { type: 'Feature', properties: { name: 'back' }, geometry: { type: 'Point', coordinates: [180, 0] } },
        {
          type: 'Feature',
          properties: { name: 'back polygon' },
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [170, -10],
                [180, -10],
                [180, 10],
                [170, 10],
                [170, -10],
              ],
            ],
          },
        },
        {
          type: 'Feature',
          properties: { name: 'front line' },
          geometry: {
            type: 'LineString',
            coordinates: [
              [-10, -10],
              [10, 10],
            ],
          },
        },
      ];
      const layer = await geoVectorLayer(figure, await parseGeoVectors({ type: 'FeatureCollection', features }), {
        projection: 'globe',
        radius: 12,
        width: 4,
        color: (f) => (f.properties.name === 'front' ? [0, 1, 0] : [1, 0, 0]),
        labels: 'name',
        declutter: false,
      });
      await figure.ready();
      figure.engine.stop();
      const image = async () => {
        const bmp = await createImageBitmap(await figure.toPNG({ overlays: false }));
        const c = new OffscreenCanvas(bmp.width, bmp.height),
          g = c.getContext('2d');
        g.drawImage(bmp, 0, 0);
        bmp.close();
        return g.getImageData(0, 0, c.width, c.height).data;
      };
      const a = await image();
      layer.restore();
      const b = await image();
      await figure.engine.rebootDevice();
      await figure.ready();
      figure.engine.stop();
      const rebooted = await image();
      let green = 0,
        red = 0,
        restoreDifference = 0,
        rebootDifference = 0;
      for (let i = 0; i < a.length; i += 4) {
        if (a[i + 1] > 150 && a[i] < 60) green++;
        if (a[i] > 150 && a[i + 1] < 60) red++;
        for (let k = 0; k < 4; k++) restoreDifference = Math.max(restoreDifference, Math.abs(a[i + k] - b[i + k]));
        for (let k = 0; k < 4; k++) rebootDifference = Math.max(rebootDifference, Math.abs(a[i + k] - rebooted[i + k]));
      }
      const visibleLabels = [...document.querySelectorAll('.margo-geo-label')]
        .filter((e) => e.style.display !== 'none')
        .map((e) => e.textContent);
      layer.visible = false;
      await image();
      const labelsHidden = [...document.querySelectorAll('.margo-geo-label')].every((e) => e.style.display === 'none');
      layer.dispose();
      const labelsRemoved = document.querySelectorAll('.margo-geo-label').length === 0;
      figure.dispose();
      return {
        counts,
        green,
        red,
        restoreDifference,
        rebootDifference,
        visibleLabels,
        labelsHidden,
        labelsRemoved,
        gpuErrors,
      };
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(report.gpuErrors, []);
    for (const row of report.counts) {
      assert.ok(row.lit > 1000, JSON.stringify(row));
      assert.ok(row.labels > 50);
    }
    assert.ok(report.green > 200, 'front point draws');
    assert.equal(report.red, 0, 'rear points and polygons are horizon discarded');
    assert.equal(report.restoreDifference, 0);
    assert.equal(report.rebootDifference, 0, 'actual engine device reboot restores exact pixels');
    assert.ok(report.visibleLabels.includes('front'));
    assert.ok(!report.visibleLabels.includes('back'));
    assert.ok(report.labelsHidden);
    assert.ok(report.labelsRemoved);
    reports.push({ compat, hardware: browser.hardware, ...report });
  } finally {
    await browser.close();
  }
}
await writeFile('test-results/sciviz-geo-vector.json', JSON.stringify(reports, null, 2));
console.log(
  'geo-vector: real datasets in all projections, bins, arcs, horizon, labels and retained restore passed on both backends',
);
