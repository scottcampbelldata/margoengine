import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const failures = [];
for (const fallback of [false, true]) {
  const browser = await openBrowser({ startPath: '/packages/sciviz/tests/volume-quality.html', port: 'free' });
  try {
    await browser.page.evaluate(async (fallback) => {
      const { Figure } = await import('/packages/sciviz/dist/index.js');
      const { createFallbackFigure } = await import('/packages/sciviz/dist/fallback.js');
      const compat = fallback ? await import('/packages/webgl2-compat/dist/index.js') : undefined;
      const { GpuPicking } = await import('/packages/sciviz/dist/pick-gpu.js');
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 192;
      canvas.style.cssText = 'width:256px;height:192px';
      document.body.append(canvas);
      const options = { axes: false, controls: false, mode: '2d', limits: [-1, 1, -1, 1], margin: { top: 0, left: 0, right: 0, bottom: 0 } };
      const fig = await (fallback ? createFallbackFigure(canvas, { ...options, compat }) : Figure.create(canvas, options));
      fig.engine.stop();
      const picker = new GpuPicking(fig);
      try {
        const layer = await fig.scatter({ positions: new Float32Array([-0.5, 0, 0]) });
        await fig.ready();
        fig.render();
        if ((await picker.pick(64, 96))?.index !== 0) throw new Error('initial point missing');
        layer.cloud.updatePositions(0, [0.5, 0, 0]);
        // Rendering consumes the cloud dirty ranges before the next query.
        fig.render();
        if ((await picker.pick(192, 96))?.index !== 0) throw new Error('updated point missing');
        if (await picker.pick(64, 96)) throw new Error('stale point remains');
      } finally {
        picker.dispose();
        fig.dispose();
        canvas.remove();
      }
    }, fallback);
    console.log(`${fallback ? 'webgl2' : 'webgpu'} live picking passed`);
  } catch (e) {
    failures.push(`${fallback ? 'webgl2' : 'webgpu'}: ${e.message}`);
  } finally {
    await browser.close();
  }
}
assert.deepEqual(failures, []);
