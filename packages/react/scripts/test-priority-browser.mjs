import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
import { writeFile } from 'node:fs/promises';
import { compatRun } from '../../../scripts/support/compat-shim.js';
process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const browser = await openBrowser({ port: 'free', startPath: '/packages/react/tests/priority-browser.html' });
const { page } = browser, errors = [], rows = [];
page.on('pageerror', (error) => errors.push(error.message)); page.setDefaultTimeout(30000);
try {
  await page.waitForFunction(() => window.priorityProof);
  let automatic;
  for (const mode of ['auto', 'manual', 'empty', 'multi', 'restore', 'demand-auto', 'demand-manual', 'demand-empty']) {
    await page.evaluate((mode) => window.priorityProof.mount(mode), mode);
    await page.waitForFunction(() => window.priorityProof.state.ready);
    const demand = mode.startsWith('demand');
    if (demand) await page.evaluate(() => { for (let i = 0; i < 20; i++) window.priorityProof.state.invalidate(); });
    else await page.waitForFunction(() => window.priorityProof.state.rows.length >= 20);
    const result = await page.evaluate(() => ({ rows: window.priorityProof.state.rows.slice(-8), errors: window.priorityProof.state.errors }));
    const draws = mode.includes('empty') || mode === 'restore' ? 0 : mode === 'multi' ? 2 : 1;
    const trace = ['negative', 'zero-a', 'zero-b', ...(!mode.endsWith('auto') ? ['main'] : []), ...(mode === 'multi' ? ['hud'] : [])];
    assert.deepEqual(result.errors, [], mode);
    for (const row of result.rows) assert.deepEqual(row, { trace, draws }, mode);
    if (mode === 'auto') automatic = await decodePNG(await page.locator('canvas').screenshot());
    if (mode === 'manual') assert.deepEqual((await decodePNG(await page.locator('canvas').screenshot())).data, automatic.data);
    if (mode === 'restore') {
      await page.evaluate(() => { window.priorityProof.state.rows = []; window.priorityProof.state.takeover(false); });
      await page.waitForFunction(() => window.priorityProof.state.rows.length >= 20);
      const restored = await page.evaluate(() => window.priorityProof.state.rows.slice(-8));
      for (const row of restored) assert.deepEqual(row, { trace: ['negative', 'zero-a', 'zero-b'], draws: 1 });
    }
    rows.push({ mode, draws, trace });
  }
  await page.evaluate(() => window.priorityProof.unmount());
  await page.waitForFunction(() => window.priorityProof.state.engine.disposed);
  assert.deepEqual(errors, []);
  await writeFile(`test-results/react-priority${compatRun() ? '-compat' : ''}.json`, JSON.stringify({ hardware: browser.hardware, rows }, null, 2));
  console.log(JSON.stringify(rows));
} finally { await browser.close(); }
