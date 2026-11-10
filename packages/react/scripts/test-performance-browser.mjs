import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
import { writeFile } from 'node:fs/promises';
import { compatRun } from '../../../scripts/support/compat-shim.js';
process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const browser = await openBrowser({ port: 'free', startPath: '/packages/react/tests/performance-browser.html' }),
  { page } = browser,
  errors = [],
  proof = [];
page.on('pageerror', (error) => errors.push(error.message));
page.setDefaultTimeout(30000);
try {
  await page.waitForFunction(() => window.performanceProof);
  for (const mode of ['default', 'named', 'pixelated', 'manual', 'demand']) {
    console.log('performance mode', mode);
    await page.evaluate((mode) => window.performanceProof.mount(mode), mode);
    await page.waitForFunction(
      () =>
        window.performanceProof.state.engines.length === 2 &&
        window.performanceProof.state.engines.every((engine) => window.performanceProof.state.ready.has(engine)),
    );
    const pump = async (goal) =>
      page.evaluate(async (goal) => {
        const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
        await waitForPipelines(
          async () => {
            await new Promise((resolve) =>
              requestAnimationFrame(() => {
                for (const invalidate of window.performanceProof.state.invalidate) invalidate();
                resolve();
              }),
            );
            await Promise.all(
              window.performanceProof.state.engines.map((engine) => engine.gpu.queue.onSubmittedWorkDone()),
            );
          },
          {
            ready: () => {
              const s = window.performanceProof.state;
              if (goal === 'removed') return s.engines[1].pick === s.picks[1];
              const size = goal === 'reduced' ? 128 : 256;
              return (
                s.factor === (goal === 'reduced' ? 0 : 1) &&
                s.rows[0].at(-1)?.[0] === 256 &&
                s.rows[1].at(-1)?.[0] === size
              );
            },
          },
        );
      }, goal);
    await pump('full');
    const images = await Promise.all(
      [0, 1].map(async (side) => decodePNG(await page.locator('canvas').nth(side).screenshot())),
    );
    assert.deepEqual(images[0].data, images[1].data, mode + ' full resolution exact');
    await page.evaluate(() => (window.performanceProof.state.sample = 50));
    await pump('reduced');
    await page.waitForFunction(
      () => window.performanceProof.state.factor === 0 && window.performanceProof.state.rows[1].at(-1)?.[0] === 128,
    );
    assert.deepEqual(await page.evaluate(() => window.performanceProof.state.rows[0].at(-1)), [256, 256]);
    const css = await page.locator('canvas').nth(1).boundingBox();
    assert.equal(css.width, 256);
    assert.equal(css.height, 256);
    const pick = await page.evaluate(async () => {
      const engine = window.performanceProof.state.engines[1];
      return [!!(await engine.pick(128, 128)), !!(await engine.pick(1, 1))];
    });
    assert.deepEqual(pick, [true, false], mode + ' reduced picking');
    await page
      .locator('canvas')
      .nth(1)
      .click({ position: { x: 128, y: 128 } });
    await page.waitForFunction(() => window.performanceProof.state.clicks === 1);
    await page.evaluate(() => (window.performanceProof.state.sample = 10));
    await pump('full');
    await page.waitForFunction(
      () => window.performanceProof.state.factor === 1 && window.performanceProof.state.rows[1].at(-1)?.[0] === 256,
    );
    const restored = await decodePNG(await page.locator('canvas').nth(1).screenshot());
    assert.deepEqual(restored.data, images[0].data, mode + ' restored exact');
    await page.evaluate(() => {
      window.performanceProof.state.sample = 50;
    });
    await pump('reduced');
    await page.evaluate(() => window.performanceProof.state.remove());
    await pump('removed');
    await page.waitForFunction(
      () => window.performanceProof.state.engines[1].pick === window.performanceProof.state.picks[1],
    );
    assert.deepEqual(await page.evaluate(() => window.performanceProof.state.errors), []);
    proof.push({ mode, original: 256, reduced: 128, restored: 256, exact: true, picking: true });
  }
  await page.evaluate(() => window.performanceProof.unmount());
  await page.waitForFunction(() => window.performanceProof.state.engines.every((engine) => engine.disposed));
  assert.deepEqual(errors, []);
  await writeFile(
    `test-results/react-performance${compatRun() ? '-compat' : ''}.json`,
    JSON.stringify({ hardware: browser.hardware, proof }, null, 2),
  );
  console.log(JSON.stringify(proof));
} finally {
  await browser.close();
}
