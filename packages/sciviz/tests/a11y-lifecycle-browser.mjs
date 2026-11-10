import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const failures = [];
for (const fallback of [false, true]) {
  const browser = await openBrowser({ startPath: '/packages/sciviz/tests/volume-quality.html', port: 'free' });
  try {
    const report = await browser.page.evaluate(async (fallback) => {
      const { Figure } = await import('/packages/sciviz/dist/index.js');
      const { createFallbackFigure } = await import('/packages/sciviz/dist/fallback.js');
      const { attachAccessibility } = await import('/packages/sciviz/dist/a11y.js');
      const compat = fallback ? await import('/packages/webgl2-compat/dist/index.js') : undefined;
      const canvas = document.createElement('canvas');
      document.body.append(canvas);
      const options = { axes: false, controls: false };
      const fig = await (fallback ? createFallbackFigure(canvas, { ...options, compat }) : Figure.create(canvas, options));
      let frames = 0;
      const off = fig.engine.onFrame(() => { frames++; });
      const refreshes = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      try {
        const original = JSON.stringify(fig.theme);
        const a = attachAccessibility(fig, { highContrast: true, reducedMotion: true });
        await a.ready;
        const before = frames;
        await refreshes();
        const suspended = frames === before;
        a.dispose();
        await fig.ready();
        await refreshes();
        const resumed = frames > before;
        const themeRestored = JSON.stringify(fig.theme) === original;
        fig.engine.stop();
        const stopped = frames;
        const b = attachAccessibility(fig, { reducedMotion: true });
        await b.ready;
        b.dispose();
        await refreshes();
        return { suspended, resumed, themeRestored, stoppedPreserved: frames === stopped };
      } finally { off(); fig.dispose(); canvas.remove(); }
    }, fallback);
    console.log(JSON.stringify({ fallback, ...report }));
    if (!Object.values(report).every(Boolean)) failures.push({ fallback, ...report });
  } finally { await browser.close(); }
}
assert.deepEqual(failures, []);
