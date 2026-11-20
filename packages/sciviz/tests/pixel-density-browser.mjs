// CSS pixel sizes of sciviz marks on screen and in tiled export: scatter points, GPU graph nodes and geo-vector points,
// at devicePixelRatio 1 and 2 (emulated), on a canvas backed at 1 pixel per CSS pixel (the desktop 4x MSAA default)
// and at the device ratio (the light tier, `margoLow`, as on phones), on WebGPU and the WebGL2 compatibility layer.
// Every size follows the drawn target's pixels per CSS pixel (SciRenderer.cssScale: the canvas backbuffer over its CSS
// width on screen, the image width over the CSS width in an export), never window.devicePixelRatio.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const reports = [];
for (const compat of [false, true])
  for (const deviceScaleFactor of [1, 2]) {
    const browser = await openBrowser({
      startPath: '/packages/sciviz/tests/volume-quality.html',
      port: 'free',
      compat,
      deviceScaleFactor,
    });
    browser.page.setDefaultTimeout(120000);
    const errors = [];
    browser.page.on('pageerror', (e) => errors.push(e.message));
    try {
      const results = await browser.page.evaluate(async () => {
        const { Figure } = await import('/packages/sciviz/dist/index.js');
        const { renderMediaTiles } = await import('/packages/sciviz/dist/export-media.js');
        const { GPUGraphLayout, gpuGraphLayer } = await import('/packages/sciviz/dist/graph-gpu.js');
        const { geoVectorLayer, parseGeoVectors } = await import('/packages/sciviz/dist/geo-vector.js');
        const { createCompute } = await import('/packages/compute/dist/index.js');
        // Widest lit run of any row of an RGBA image: a disc's diameter.
        const run = (pixels, width, height) => {
          let widest = 0;
          for (let y = 0; y < height; y++) {
            let n = 0;
            for (let x = 0; x < width; x++) {
              const p = (y * width + x) * 4;
              n += +(pixels[p] + pixels[p + 1] + pixels[p + 2] > 300);
            }
            widest = Math.max(widest, n);
          }
          return widest;
        };
        const exported = async (fig, scale) => {
          let widest = 0;
          for await (const t of renderMediaTiles(fig, { overlays: false, scale }))
            widest = Math.max(widest, run(t.pixels, t.width, t.height));
          return widest;
        };
        const screen = (fig) => {
          fig.render();
          const c = fig.engine.canvas,
            s = new OffscreenCanvas(c.width, c.height),
            g = s.getContext('2d');
          g.drawImage(c, 0, 0);
          return run(g.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
        };
        // Each mark is 20 CSS pixels across, centred on a 200 x 200 CSS pixel plot. Geo-vector layers need a 3D figure.
        const marks = {
          scatter: (fig) => fig.scatter({ x: [0], y: [0] }, { size: 20, color: '#ffffff' }),
          graph: async (fig) => {
            const gpu = await createCompute({ device: fig.renderer.device });
            const layout = new GPUGraphLayout(
              gpu,
              { nodes: 1, edges: [] },
              { positions: Float32Array.of(0, 0, 0), dimensions: 2 },
            );
            gpuGraphLayer(fig, layout, { nodeSize: 20, nodeColor: '#ffffff' });
          },
          geoPoint3d: async (fig) =>
            geoVectorLayer(
              fig,
              await parseGeoVectors({
                type: 'FeatureCollection',
                features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [0, 0] } }],
              }),
              { projection: 'plate', radius: 10, width: 0, color: [1, 1, 1] },
            ),
        };
        const results = [];
        for (const light of [false, true])
          for (const [mark, add] of Object.entries(marks)) {
            if (light) globalThis.margoLow = 2;
            else delete globalThis.margoLow;
            const canvas = document.createElement('canvas');
            canvas.style.cssText = 'width:200px;height:200px;display:block';
            document.body.append(canvas);
            const fig = await Figure.create(
              canvas,
              mark.endsWith('3d')
                ? { axes: false, controls: false, background: '#000000' }
                : {
                    axes: false,
                    controls: false,
                    mode: '2d',
                    margin: { top: 0, left: 0, right: 0, bottom: 0 },
                    limits: [-1, 1, -1, 1],
                    background: '#000000',
                  },
            );
            try {
              fig.render();
              fig.engine.stop();
              await add(fig);
              await fig.ready();
              results.push({
                mark,
                light,
                dpr: devicePixelRatio,
                backing: fig.engine.canvas.width / fig.engine.canvas.clientWidth,
                screen: screen(fig),
                one: await exported(fig, 1),
                two: await exported(fig, 2),
              });
            } finally {
              fig.dispose();
              canvas.remove();
              delete globalThis.margoLow;
            }
          }
        return results;
      });
      assert.deepEqual(errors, []);
      for (const report of results) {
        reports.push({ compat, ...report });
        const label = `${report.mark} on ${compat ? 'the WebGL2 layer' : 'WebGPU'} at devicePixelRatio ${deviceScaleFactor}, ${report.light ? 'light tier' : 'desktop tier'}`;
        assert.equal(report.dpr, deviceScaleFactor, label);
        // The light tier backs the canvas at the device ratio; the desktop 4x MSAA default at 1 pixel per CSS pixel.
        assert.equal(report.backing, report.light ? deviceScaleFactor : 1, `${label}: backing store`);
        // A round mark's antialiased rim adds at most a pixel either side of its diameter.
        const near = (value, expected, what) =>
          assert.ok(Math.abs(value - expected) <= 2, `${label}: ${what} is ${value} px, expected ${expected}`);
        near(report.screen, 20 * report.backing, 'the on-screen mark');
        near(report.one, 20, 'the mark of a scale 1 export');
        near(report.two, 40, 'the mark of a scale 2 export');
      }
    } finally {
      await browser.close();
    }
  }
console.log(JSON.stringify(reports));
