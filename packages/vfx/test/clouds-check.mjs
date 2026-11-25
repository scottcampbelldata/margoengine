// Real-GPU checks of puff clouds (run from the repository root after building packages, one GPU job at a time; set
// MARGO_COMPAT=1 for the WebGL2 compatibility layer):
//   node scripts/run-with-timeout.mjs -- node packages/vfx/test/clouds-check.mjs
// Instanced draw: three clouds are one draw of 4 vertices and 21 instances, and one draw call more in an engine frame.
// Depth-soft edges: six puffs over a floor match Lorach's contrast curve of their gap to it (1x and 4x), alpha 1
// without softness. Near fade: five puffs 2 to 12 m away match smoothstep(0, fade, distance). Determinism: the same
// deltas draw the same bytes; a later time draws different ones.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const context = await openBrowser({ startPath: '/packages/vfx/test/clouds-check.html', port: 5299 }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const clean = (r, name) => {
  assert.equal(r.error ?? null, null, name);
  assert.deepEqual(r.errors, [], name);
};
try {
  console.log('adapter', JSON.stringify(hardware.webgpu), hardware.compat ? '(WebGL2 compatibility)' : '');
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  for (const samples of [1, 4]) {
    const r = await page.evaluate((s) => window.checkInstanced(s), samples);
    clean(r, `instanced ${samples}x`);
    assert.deepEqual(r.draws, [[4, 21]], `one instanced draw (${samples}x)`);
    assert.equal(r.drawn, 21);
    assert.ok(r.lit > 200, `puffs cover pixels: ${r.lit}`);
    console.log(`ok instanced ${samples}x: 21 puffs of 3 clouds in 1 draw, ${r.lit} pixels`);

    const hard = await page.evaluate((s) => window.checkSoft(s, 0), samples),
      soft = await page.evaluate((s) => window.checkSoft(s, 1), samples);
    clean(hard, `hard ${samples}x`);
    clean(soft, `soft ${samples}x`);
    const off = (rows) => Math.max(...rows.map((row) => Math.abs(row.got - row.expected)));
    assert.ok(off(hard.rows) <= 2, `without softness alpha is 1: ${JSON.stringify(hard.rows)}`);
    assert.ok(off(soft.rows) <= 4, `soft alpha follows the gap: ${JSON.stringify(soft.rows)}`);
    assert.ok(soft.rows[0].got < 60 && soft.rows.at(-1).got > 250, 'low puffs fade, high ones stay');
    console.log(
      `ok soft ${samples}x: ${soft.rows.map((row) => `${row.height} m ${row.got}/${Math.round(row.expected)}`).join(', ')}`,
    );

    const fade = await page.evaluate((s) => window.checkFade(s), samples);
    clean(fade, `fade ${samples}x`);
    assert.ok(off(fade.rows) <= 3, `near fade: ${JSON.stringify(fade.rows)}`);
    assert.ok(fade.rows[0].got < fade.rows[2].got && fade.rows.at(-1).got >= 253, 'nearer puffs fade more');
    console.log(
      `ok fade ${samples}x: ${fade.rows.map((row) => `${row.distance} m ${row.got}/${Math.round(row.expected)}`).join(', ')}`,
    );

    const same = await page.evaluate((s) => window.checkDeterminism(s), samples);
    clean(same, `determinism ${samples}x`);
    assert.equal(same.differing, 0, 'the same deltas draw the same bytes');
    assert.ok(same.moved > 100, `a later time moves the puffs: ${same.moved}`);
    assert.ok(same.lit > 500, `the clouds cover pixels: ${same.lit}`);
    console.log(`ok determinism ${samples}x: identical bytes, ${same.moved} bytes differ 0.5 s later`);
  }
  const engine = await page.evaluate(() => window.checkEngine());
  clean(engine, 'engine');
  assert.equal(engine.after - engine.before, 1, `one more draw call: ${engine.before} -> ${engine.after}`);
  assert.ok(engine.drawn > 0);
  console.log(`ok engine: ${engine.drawn} puffs in 1 draw call`);
  assert.deepEqual(pageErrors, []);
  console.log('clouds check passed');
} finally {
  await context.close();
}
