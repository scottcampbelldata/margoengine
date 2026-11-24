// Real-GPU regression test: shadows.add(group) and shadows.add(model.root) cast every mesh below them (`Shadows` and
// `VirtualShadows`), a mesh parented later casts from the next frame, one that leaves the group stops, and the remover
// takes them all out. Known bug it guards (docs/known-bugs.md, KB-SHADOW-GROUP1): add() accepted a group and a model
// root without an error and drew nothing for them. On that code the group, model and late checks read 1.0 of the open
// light on the floor points under the slabs.
// Run from the repository root after `npm run build:packages`: node packages/shadows/test/group-casters-browser.mjs
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

// A floor point's light against the same floor with nothing added: at or under SHADED counts as in shadow, at or over LIT as clear.
const SHADED = 0.6,
  LIT = 0.93;
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const context = await openBrowser({ startPath: '/packages/shadows/test/group-casters.html', port: 'free' }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
const linear = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const shot = async () => decodePNG(await page.locator('canvas').screenshot());
// Mean linear luminance of a 9 x 9 patch around world point p.
const patch = async (image, p, r = 4) => {
  const [cx, cy] = await page.evaluate((w) => window.check.pixel(w), p);
  let sum = 0;
  for (let y = cy - r; y <= cy + r; y++)
    for (let x = cx - r; x <= cx + r; x++) {
      const o = (y * image.width + x) * 4;
      sum += 0.2126 * linear(image.data[o]) + 0.7152 * linear(image.data[o + 1]) + 0.0722 * linear(image.data[o + 2]);
    }
  return sum / (2 * r + 1) ** 2;
};
const points = { A: [0, 0, 0], B: [0, 0, 2], C: [0, 0, -2] },
  rows = [],
  failures = [];
let lit = {};
const show = async (kind, scenario, cast = true) => {
  assert.deepEqual(await page.evaluate(([k, s, c]) => window.check.show(k, s, c), [kind, scenario, cast]), []);
  return shot();
};
const step = async (name) => {
  assert.deepEqual(await page.evaluate((n) => window.check.step(n), name), []);
  return shot();
};
// `want`: the floor points that must be in shadow; every other point must be clear.
const judge = async (label, image, want) => {
  const row = { label };
  for (const [name, point] of Object.entries(points)) {
    const ratio = (row[name] = +((await patch(image, point)) / lit[name]).toFixed(3));
    if (want.includes(name) ? ratio > SHADED : ratio < LIT)
      failures.push(`${label} ${name}: ${ratio} of its open light, expected ${want.includes(name) ? 'shadow' : 'clear'}`);
  }
  rows.push(row);
  console.log(JSON.stringify(row));
};
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  for (const kind of ['directional', 'virtual']) {
    // The open light: the same floor and slabs with nothing registered.
    const open = await show(kind, 'group', false);
    lit = {};
    for (const [name, point] of Object.entries(points)) {
      lit[name] = await patch(open, point);
      assert.ok(lit[name] > 0.02, `${kind}: floor point ${name} is unlit (${lit[name]}), so nothing is measured`);
    }
    // Control: each slab added by itself shades its point, so the measurement works and a group must match it.
    await judge(`${kind} each slab added`, await show(kind, 'single'), ['A', 'B']);
    // A group with a group inside it: both slabs cast.
    await judge(`${kind} group`, await show(kind, 'group'), ['A', 'B']);
    // A gltf/pbr model's root: the model casts at A only.
    await judge(`${kind} model root`, await show(kind, 'model'), ['A']);
    // A group with nothing below it casts nothing and raises no error.
    await judge(`${kind} empty group`, await show(kind, 'empty'), []);
    // A mesh parented to the group after add() casts from the next frame; one that leaves the group stops casting.
    await judge(`${kind} late, before the new child`, await show(kind, 'late'), ['A', 'B']);
    await judge(`${kind} late, child attached`, await step('attach'), ['A', 'B', 'C']);
    await judge(`${kind} late, child left`, await step('away'), ['A', 'B']);
    // The remover takes every mesh of the group out.
    await judge(`${kind} removed`, await step('remove'), []);
    // A disposed group stops casting without an error.
    await show(kind, 'group');
    await judge(`${kind} group disposed`, await step('dispose-group'), []);
  }
  await writeFile('test-results/shadows-group-casters.json', JSON.stringify(rows, null, 2));
  assert.deepEqual(failures, []);
  assert.deepEqual(pageErrors, []);
  console.log('shadows group casters: ok');
} finally {
  await context.close?.();
}
