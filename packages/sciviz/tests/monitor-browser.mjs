import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
for (const fallback of [false, true]) {
  const browser = await openBrowser({ startPath: '/packages/sciviz/tests/volume-quality.html', port: 'free' });
  const errors = [];
  browser.page.on('pageerror', (e) => errors.push(e.message));
  browser.page.setDefaultTimeout(120000);
  try {
    const report = await browser.page.evaluate(async (fallback) => {
      globalThis.margoLow = 1;
      const { Figure } = await import('/packages/sciviz/dist/index.js');
      const { createFallbackFigure } = await import('/packages/sciviz/dist/fallback.js');
      const { installFigureStats } = await import('/packages/sciviz/dist/monitor.js');
      const canvas = document.createElement('canvas');
      canvas.width = 192;
      canvas.height = 144;
      canvas.style.cssText = 'width:192px;height:144px';
      document.body.append(canvas);
      const fig = installFigureStats(
        await (fallback ? createFallbackFigure : Figure.create)(canvas, { axes: false, controls: false }),
      );
      fig.engine.stop();
      const check = (condition, message) => {
        if (!condition) throw new Error(message);
      };
      const snapshot = async () => {
        await fig.ready();
        fig.render();
        await fig.renderer.device.queue.onSubmittedWorkDone();
        return fig.stats.snapshot();
      };
      const deviceErrors = [];
      const watch = () =>
        fig.renderer.device.addEventListener('uncapturederror', (e) => deviceErrors.push(e.error.message));
      watch();
      try {
        const surface = fig.surface(new Float32Array([0, 1, 1, 0]), { nx: 2, ny: 2 });
        let snap = await snapshot();
        check(snap.layers[0].gpuBytes === 16 + 192 + 1024, 'surface descriptor bytes');
        check(snap.counts.cells === 1, 'surface cells');
        fig.remove(surface);
        const values = Float32Array.from({ length: 512 }, (_, i) => i % 8);
        const volume = fig.volume(values, { dims: [8, 8, 8], shading: false });
        volume.slice('z', 0.5);
        snap = await snapshot();
        check(snap.layers[0].gpuBytes === 1024 + 1024 + 320, 'volume descriptor bytes');
        check(snap.layers[1].gpuBytes === 128, 'slice must not duplicate volume textures');
        check(snap.counts.voxels === 512, 'voxel count');
        const iso = await fig.isosurface(values, 3.5, { dims: [8, 8, 8] });
        const scatter = await fig.scatter({ x: [0, 1, 2], y: [1, 0, 2], color: [2, 3, 4] });
        const line = await fig.line({ x: [0, 1, 2], y: [0, 2, 1] });
        snap = await snapshot();
        check(snap.unreportedLayers === 0, 'all standard layers inventoried');
        check(snap.layers[1].gpuBytes > iso.triangles * 3 * 32, 'isosurface includes tables and field');
        check(scatter.cloud.memoryResources.gpu.length >= 3, 'point buffers reported after render');
        check(line.line.memoryResources.gpu.length === 3, 'line buffers reported after render');
        const before = snap.gpuBytes;
        await fig.engine.rebootDevice();
        watch();
        await fig.renderer.ready();
        snap = await snapshot();
        check(snap.gpuBytes === before, 'restored allocation bytes');
        for (const layer of fig.layers) fig.remove(layer);
        check(fig.stats.snapshot().gpuBytes === 0, 'figure removal releases attribution');
        check(scatter.cloud.memoryResources.gpu.length === 0, 'point disposal releases inventory');
        check(line.line.memoryResources.gpu.length === 0, 'line disposal releases inventory');
        check(deviceErrors.length === 0, deviceErrors.join('; '));
        return { fallback, restoredBytes: before, isoTriangles: iso.triangles };
      } finally {
        fig.stats.dispose();
        fig.dispose();
        canvas.remove();
      }
    }, fallback);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify(report));
  } finally {
    await browser.close();
  }
}
