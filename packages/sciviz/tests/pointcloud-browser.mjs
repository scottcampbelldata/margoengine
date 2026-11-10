import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const reports = [];
for (const compat of [false, true]) {
  const context = await openBrowser({ startPath: '/examples/sciviz-pointcloud.html', port: 'free', compat });
  const { page } = context,
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.setDefaultTimeout(60000);
  try {
    await page.waitForFunction(() => document.querySelector('canvas')?.dataset.ready === 'true');
    const report = await page.evaluate(async () => {
      const { figure, layer, selection, reads } = await import('/examples/sciviz-pointcloud.ts');
      const { projectPoint } = await import('/packages/math/dist/mat4.js');
      async function capture() {
        const bitmap = await createImageBitmap(await figure.toPNG({ overlays: false }));
        const copy = new OffscreenCanvas(bitmap.width, bitmap.height),
          ctx = copy.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        const pixels = ctx.getImageData(0, 0, copy.width, copy.height).data;
        let hash = 2166136261,
          lit = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          hash = Math.imul(hash ^ pixels[i] ^ (pixels[i + 1] << 8) ^ (pixels[i + 2] << 16), 16777619);
          if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) > 75) lit++;
        }
        return { hash, lit };
      }
      const before = await capture(),
        initial = { ...layer.stats };
      layer.setColour({ attribute: 'classification', range: [0, 18], colormap: 'viridis' });
      const classes = await capture();
      const canvas = document.querySelector('canvas'),
        r = canvas.getBoundingClientRect();
      const selected = layer.select({ rect: [0, 0, r.width / 2, r.height] });
      const highlighted = await capture();
      const keys = [...selection.rowIds];
      selection.clear();
      const cleared = await capture();
      layer.setPointBudget(40000);
      await layer.ready({ signal: AbortSignal.timeout(30000) });
      const budget = { ...layer.stats };
      const cloud = [...layer.points.pointClouds].find((c) => c.visible);
      let pick = null;
      for (let i = 0; i < cloud.count && !pick; i++) {
        const p = cloud.positions.subarray(i * 3, i * 3 + 3),
          m = cloud.matrix;
        const world = [
          m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
          m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
          m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
        ];
        const out = projectPoint(figure.engine.camera.matrix, ...world, r.width, r.height, 'webgpu');
        if (out.inFrustum) {
          const hit = layer.pick(out.x, out.y);
          if (hit) pick = { rowId: hit.rowId, attributes: hit.attributes, position: hit.position };
        }
      }
      const module = await import('/examples/sciviz-pointcloud.ts');
      const axisLabels = [...document.querySelectorAll('div,span')].filter(
        (e) => e.textContent === 'Easting (m)',
      ).length;
      return {
        before,
        classes,
        highlighted,
        cleared,
        initial,
        budget,
        selected: selected.length,
        shared: keys.length,
        pick,
        readsBefore: reads,
        readsAfter: module.reads,
        axisLabels,
      };
    });
    assert(report.before.lit > 1000, 'real USGS points render');
    assert.notEqual(report.before.hash, report.classes.hash, 'classification colours change pixels');
    assert.notEqual(report.classes.hash, report.highlighted.hash, 'shared selection changes pixels');
    assert.equal(report.classes.hash, report.cleared.hash, 'clearing selection restores pixels exactly');
    assert(report.selected > 0 && report.selected < report.initial.drawn);
    assert.equal(report.selected, report.shared);
    assert(report.initial.drawn <= 220000 && report.initial.drawn > 40000);
    assert(report.budget.drawn <= 40000 && report.budget.drawn > 0);
    assert.equal(report.readsBefore, report.readsAfter, 'recolour and selection make no tile reads');
    assert.equal(report.readsAfter, 9, 'only archived visible tiles load');
    assert(report.axisLabels > 0, 'figure axes label survey coordinates');
    assert(report.pick && Number.isFinite(report.pick.attributes.intensity));
    assert(Number.isFinite(report.pick.attributes.gps_time));
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `test-results/sciviz-pointcloud-${compat ? 'webgl2' : 'webgpu'}.png` });
    reports.push({ compat, ...report, hardware: context.hardware });
  } finally {
    await context.close();
  }
}
await writeFile('test-results/sciviz-pointcloud-gpu.json', JSON.stringify(reports, null, 2));
console.log(JSON.stringify(reports));
