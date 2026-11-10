import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
const reports = [];
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/examples/sciviz-geo-time.html', port: 'free', compat });
  const errors = [];
  browser.page.setDefaultTimeout(90000);
  browser.page.on('pageerror', (e) => errors.push(e.message));
  try {
    await browser.page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Ready.'));
    const report = await browser.page.evaluate(async () => {
      const demo = await import('/examples/sciviz-geo-time.ts'),
        { Figure } = await import('/packages/sciviz/dist/index.js'),
        { geoTripsLayer, geoTimeRasterLayer, wmtsTimeSource } = await import('/packages/sciviz/dist/geo-time.js');
      const image = async (figure) => {
        const bitmap = await createImageBitmap(await figure.toPNG({ overlays: false })),
          c = new OffscreenCanvas(bitmap.width, bitmap.height),
          g = c.getContext('2d');
        g.drawImage(bitmap, 0, 0);
        bitmap.close();
        return g.getImageData(0, 0, c.width, c.height).data;
      };
      const difference = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0),
        lit = (p) => {
          let n = 0;
          for (let i = 0; i < p.length; i += 4) if (Math.max(p[i], p[i + 1], p[i + 2]) > 90) n++;
          return n;
        };
      const modes = [];
      for (const mode of ['ais', 'iss', 'raster']) {
        if (mode !== 'ais') {
          document.querySelector('#dataset').value = mode;
          await demo.start();
        }
        const figure = demo.currentFigure(),
          layer = demo.currentLayer();
        figure.engine.stop();
        const a = await image(figure),
          time = layer.time;
        await layer.seek(time + (mode === 'raster' ? 86400000 : 600000));
        const b = await image(figure);
        await layer.seek(time);
        const c = await image(figure);
        await figure.engine.rebootDevice();
        await figure.ready();
        figure.engine.stop();
        const restored = await image(figure);
        layer.visible = false;
        const hidden = await image(figure);
        layer.visible = true;
        modes.push({
          mode,
          lit: lit(a),
          changed: difference(a, b),
          seekDifference: difference(a, c),
          restoreDifference: difference(c, restored),
          hiddenDifference: difference(a, hidden),
        });
      }
      demo.currentFigure().dispose();
      const figure = await Figure.create(document.querySelector('#map'), {
        axes: false,
        controls: false,
        limits: [-1, 1, -1, 1, -0.01, 0.01],
        aspect: [1, 1, 1],
      });
      figure.engine.stop();
      figure.engine.camera.position = [0, 2.4, 0.001];
      const gpuErrors = [];
      figure.renderer.device.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
      const trip = await geoTripsLayer(
        figure,
        [{ id: 'cross', times: [0, 10, 20], positions: [-90, 0, 0, 0, 0, 0, 90, 0, 0] }],
        {
          trail: 10,
          fadeSteps: 4,
          width: 5,
          radius: 8,
          time: 10,
          lineColor: [0, 1, 0],
          color: [1, 0, 0],
          projection: 'plate',
        },
      );
      const a = await image(figure),
        controller = new AbortController();
      controller.abort();
      let aborts = 0;
      try {
        await trip.seek(15, { signal: controller.signal });
      } catch {
        aborts++;
      }
      const abortDifference = difference(a, await image(figure));
      await Promise.all([trip.seek(5), trip.seek(15), trip.seek(10)]);
      const queueDifference = difference(a, await image(figure));
      const timeline = trip.timeline([0, 10, 20], { controls: false });
      await timeline.seek(0);
      await timeline.play({ fps: 100 });
      const played = trip.time === 20;
      figure.remove(trip);
      const empty = await image(figure);
      // A real retained NASA tile is returned by a synthetic dimension service for deterministic failure tests.
      const bytes = await fetch('/examples/assets/sciviz/geo-time/terra-2024-01-01.jpg').then((r) => r.blob());
      let requested = 0;
      const raster = await geoTimeRasterLayer(figure, {
        times: [0, 1, 2],
        maxZoom: 0,
        tileBudget: 1,
        cacheTiles: 2,
        cacheFrames: 1,
        source: {
          url: 'https://wmts.test/tiles',
          layer: 'real',
          matrixSet: 'global',
          formatTime: String,
          fetch: async (url) => {
            requested++;
            return new URL(url).searchParams.get('Time') === '2'
              ? new Response('failed', { status: 503 })
              : new Response(bytes);
          },
        },
      });
      const ra = await image(figure);
      let failures = 0;
      try {
        await raster.seek(2);
      } catch {
        failures++;
      }
      const failedDifference = difference(ra, await image(figure));
      await raster.seek(1);
      await raster.seek(0);
      figure.remove(raster);
      const disposedDifference = difference(empty, await image(figure));
      const gradient = new OffscreenCanvas(8, 8),
        gc = gradient.getContext('2d');
      for (let row = 0; row < 8; row++) {
        gc.fillStyle = `rgb(${16 + 32 * row},0,0)`;
        gc.fillRect(0, row, 8, 1);
      }
      const gradientBytes = await gradient.convertToBlob();
      const reproject = wmtsTimeSource(
        {
          url: 'https://wmts.test/{Time}/{TileMatrix}/{TileRow}/{TileCol}',
          layer: 'gradient',
          matrixSet: 'geographic',
          projection: 'EPSG:4326',
          matrices: [
            {
              id: 'geographic-zero',
              width: 1,
              height: 1,
              tileWidth: 8,
              tileHeight: 4,
              resolution: 45,
              topLeft: [-180, 90],
            },
          ],
          fetch: async () => new Response(gradientBytes),
        },
        0,
      );
      const projected = await reproject(0, 0, 0);
      const customMercator = wmtsTimeSource(
        {
          url: 'https://wmts.test/{Time}/{TileMatrix}/{TileRow}/{TileCol}',
          layer: 'gradient',
          matrixSet: 'custom',
          matrices: [
            {
              id: 'custom-zero',
              width: 1,
              height: 1,
              tileWidth: 8,
              tileHeight: 8,
              resolution: (2 * Math.PI * 6378137) / 8,
              topLeft: [-Math.PI * 6378137, Math.PI * 6378137],
            },
          ],
          fetch: async () => new Response(gradientBytes),
        },
        0,
      );
      const cropped = await customMercator(0, 0, 0);
      const projectionSamples = [
        projected.data[(64 * 256 + 128) * 4],
        projected.data[(192 * 256 + 128) * 4],
        cropped.data[(64 * 256 + 128) * 4],
      ];
      figure.dispose();
      return {
        modes,
        aborts,
        abortDifference,
        queueDifference,
        played,
        failures,
        failedDifference,
        disposedDifference,
        requested,
        gpuErrors,
        projectionSamples,
      };
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(report.gpuErrors, []);
    for (const mode of report.modes) {
      assert.ok(mode.lit > 100, JSON.stringify(mode));
      assert.ok(mode.changed > 1000, JSON.stringify(mode));
      assert.equal(mode.seekDifference, 0, JSON.stringify(mode));
      assert.equal(mode.restoreDifference, 0, JSON.stringify(mode));
      assert.ok(mode.hiddenDifference > 1000, JSON.stringify(mode));
    }
    assert.equal(report.aborts, 1);
    assert.equal(report.abortDifference, 0);
    assert.equal(report.queueDifference, 0);
    assert.ok(report.played);
    assert.equal(report.failures, 1);
    assert.equal(report.failedDifference, 0);
    assert.equal(report.disposedDifference, 0);
    assert.ok(report.requested >= 4);
    assert.ok(report.projectionSamples[0] < report.projectionSamples[2]);
    assert.ok(report.projectionSamples[1] > report.projectionSamples[0]);
    reports.push({ compat, ...report });
  } finally {
    await browser.close();
  }
}
await writeFile('test-results/sciviz-geo-time.json', JSON.stringify(reports, null, 2));
console.log(
  'geo-time: real AIS, full SGP4 ISS, WMTS time rasters, seeks, playback, rollback, visibility, disposal and device reboot pass both backends',
);
