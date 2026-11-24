import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const browser = await openBrowser({ port: 'free', startPath: '/packages/react/tests/controls-extra-browser.html' });
const { page } = browser, errors = []; page.on('pageerror', e => errors.push(e.message)); page.setDefaultTimeout(30000);
try {
  await page.waitForFunction(() => window.controlsProof?.state.ready && window.controlsProof.state.scroll);
  await page.keyboard.down('w'); assert.equal(await page.evaluate(() => window.controlsProof.state.keys().forward), true);
  await page.keyboard.up('w'); assert.equal(await page.evaluate(() => window.controlsProof.state.keys().forward), false);
  await page.evaluate(() => { const el = window.controlsProof.state.scroll.el; el.scrollTop = (el.scrollHeight - el.clientHeight) / 2; });
  await page.waitForFunction(() => Math.abs(window.controlsProof.state.scroll.offset - 0.5) < 0.01);
  const labelTop = await page.locator('h1').evaluate(el => el.getBoundingClientRect().top);
  assert.ok(Math.abs(labelTop - 120) < 10, 'HTML follows damped scrolling once, without native-scroll double translation');
  await page.evaluate(() => { window.controlsProof.state.scroll.el.style.pointerEvents = 'none'; });
  const before = await page.locator('canvas').screenshot();
  await page.mouse.move(320, 220); await page.mouse.down(); await page.mouse.move(410, 290, { steps: 8 });
  await page.waitForFunction(() => { const e = window.controlsProof.state.engine, child = window.controlsProof.state.mesh; const id = e.store.parents[child.id]; return Math.abs(e.store.transforms.qy[id]) > 0.05; });
  const after = await page.locator('canvas').screenshot(); assert.notDeepEqual(after, before);
  await page.mouse.up();
  await page.waitForFunction(() => { const e = window.controlsProof.state.engine, child = window.controlsProof.state.mesh; return Math.abs(e.store.transforms.qy[e.store.parents[child.id]]) < 0.001; });
  assert.deepEqual(await page.evaluate(() => window.controlsProof.state.errors), []); assert.deepEqual(errors, []);
  await page.evaluate(() => window.controlsProof.unmount()); await page.waitForFunction(() => window.controlsProof.state.engine.disposed);
  console.log('Keyboard, native scroll, spring product rotation, snap-back and cleanup passed');
} finally { await browser.close(); }
