// Real-GPU check that point, sprite and surfel pixel sizes are CSS pixels (KB-POINTS-CSSPX1), on canvases backed at 1
// and 2 pixels per CSS pixel at devicePixelRatio 2, on WebGPU and the WebGL2 compatibility layer, including a cloud
// written by exportGLB and drawn again by gltf/pbr. Needs built packages.
// Run from the repository root: node packages/points/tests/pixel-density-browser.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const reports = [];
for (const compat of [false, true]) {
  const browser = await openBrowser({
    startPath: '/packages/points/tests/pixel-density.html',
    port: 'free',
    compat,
    deviceScaleFactor: 2,
  });
  browser.page.setDefaultTimeout(120000);
  const errors = [];
  browser.page.on('pageerror', (e) => errors.push(e.message));
  try {
    const results = await browser.page.evaluate(async () => {
      const { Engine } = await import('/packages/core/dist/index.js');
      const { PointCloud, PointsPlugin, SpriteBatch } = await import('/packages/points/dist/index.js');
      const { SurfelPlugin } = await import('/packages/points/dist/surfels.js');
      const { exportGLB } = await import('/packages/exporters/dist/index.js');
      const { parseGLTFAsync } = await import('/packages/gltf/dist/pbr.js');
      // Widest lit run of any row of the canvas: a mark's width in its pixels.
      const widest = (canvas) => {
        const copy = new OffscreenCanvas(canvas.width, canvas.height),
          context = copy.getContext('2d');
        context.drawImage(canvas, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let best = 0;
        for (let y = 0; y < canvas.height; y++)
          for (let x = 0, run = 0; x < canvas.width; x++) {
            const p = (y * canvas.width + x) * 4;
            run = pixels[p] + pixels[p + 1] + pixels[p + 2] > 300 ? run + 1 : 0;
            best = Math.max(best, run);
          }
        return best;
      };
      // A 200 CSS pixel canvas backed at `backing` pixels each.
      const rig = async (backing) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 200 * backing;
        canvas.style.cssText = 'width:200px;height:200px;display:block';
        document.body.append(canvas);
        const engine = await Engine.create(canvas, {
          exactSize: true,
          background: '#000000',
          camera: { position: [0, 0, 5], target: [0, 0, 0] },
        });
        engine.stop();
        return {
          canvas,
          engine,
          end() {
            engine.dispose();
            canvas.remove();
          },
        };
      };
      const draw = (r) => {
        r.engine.render();
        return widest(r.canvas);
      };
      const point = (material) => new PointCloud({ positions: [0, 0, 0], material });
      // Every mark is 20 CSS pixels wide.
      const marks = {
        point: (e) => PointsPlugin.attach(e).add(point({ size: 20 })),
        floored: (e) => PointsPlugin.attach(e).add(point({ size: 1, minPixelSize: 20 })),
        capped: (e) => PointsPlugin.attach(e).add(point({ size: 90, maxPixelSize: 20 })),
        sprite: (e) =>
          PointsPlugin.attach(e).add(
            new SpriteBatch({ material: { sizeUnits: 'pixels' }, sprites: [{ position: [0, 0, 0], size: 20 }] }),
          ),
        surfel: (e) => SurfelPlugin.attach(e, { overlap: 1 }).add(point({ size: 20 })),
      };
      const results = [];
      for (const backing of [1, 2]) {
        for (const [mark, add] of Object.entries(marks)) {
          const r = await rig(backing);
          add(r.engine);
          results.push({ mark, backing, width: draw(r) });
          r.end();
        }
        const first = await rig(backing);
        marks.point(first.engine);
        draw(first);
        const glb = exportGLB(first.engine);
        first.end();
        const again = await rig(backing);
        const model = await parseGLTFAsync(again.engine, glb);
        results.push({ mark: 'reloaded GLB', backing, width: draw(again) });
        model.dispose();
        again.end();
      }
      return { dpr: devicePixelRatio, results };
    });
    assert.deepEqual(errors, []);
    assert.equal(results.dpr, 2);
    for (const report of results.results) {
      reports.push({ compat, ...report });
      const label = `${report.mark} on ${compat ? 'the WebGL2 layer' : 'WebGPU'}, ${report.backing} pixels per CSS pixel`;
      // A disc's or an antialiased edge's partial pixels move the lit run by a pixel or two.
      assert.ok(
        Math.abs(report.width - 20 * report.backing) <= 2,
        `${label}: ${report.width} px wide, expected ${20 * report.backing}`,
      );
    }
  } finally {
    await browser.close();
  }
}
console.log(JSON.stringify(reports));
