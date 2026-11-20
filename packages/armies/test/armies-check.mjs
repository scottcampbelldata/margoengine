// Real-GPU check of @margoengine/armies (WebGPU, or the WebGL2 compatibility layer with MARGO_COMPAT=1), on the
// code-built test body: 300 foot soldiers and 40 riders on horses drawn by addArmy in their levels, inside the budget,
// a seek drawing the frame playing drew, and the near-to-far hand-over: the same men all skinned near and all far
// cover the same pixels to within the simplified mesh's silhouette.
// Run from the repository root after building packages, under a hard limit:
//   node scripts/run-with-timeout.mjs --max 10 -- node packages/armies/test/armies-check.mjs
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
const port = 5329,
  context = await openBrowser({ startPath: '/packages/armies/test/armies-check.html', port }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
console.log('device', context.hardware?.compat ? 'webgl2-compat layer' : 'webgpu');
const mask = async (bytes) => {
  const image = await decodePNG(new Uint8Array(bytes)),
    channels = image.data.length / (image.width * image.height),
    out = new Uint8Array(image.width * image.height);
  for (let i = 0, p = 0; i < image.data.length; i += channels, p++)
    out[p] = Math.abs(image.data[i] - 0x30) + Math.abs(image.data[i + 1] - 0x33) + Math.abs(image.data[i + 2] - 0x3a) > 30 ? 1 : 0;
  return out;
};
// The silhouette mismatch allowed between the 24 men skinned near and the same men far: measured 0.02 percent of the
// body (3 of about 12,900 pixels) on WebGPU and on the WebGL2 layer (RTX A6000, 2026-11-18); the bound is 0.5 percent
// (about 64 pixels), room for another GPU's rasterisation along the simplified edges. A quarter cycle off measured
// 19.7 percent, so the bound fails a far level posed from anything but the near bone rows.
const HAND_OVER = 0.005;
const share = (m) => m.reduce((a, b) => a + b, 0) / m.length;
try {
  await page.goto(`http://127.0.0.1:${port}/packages/armies/test/armies-check.html`);
  await page.waitForFunction(() => window.ready, null, { timeout: 180000 });
  // ARMIES_PNG_DIR=<folder> keeps the frames for a look.
  const keep = (name, bytes) => process.env.ARMIES_PNG_DIR && writeFileSync(join(process.env.ARMIES_PNG_DIR, name), new Uint8Array(bytes));
  const a = await page.evaluate(() => window.check.army());
  keep('army.png', a.bytes);
  keep('again.png', a.again);
  assert.deepEqual(a.errors, []);
  const covers = share(await mask(a.bytes));
  console.log('army covers', (100 * covers).toFixed(1), 'percent;', JSON.stringify(a.counts), 'posed', a.posed, 'horses', a.horses, 'mesh', a.near, '->', a.far);
  assert.ok(covers > 0.02, 'the army is drawn');
  assert.equal(a.counts.near + a.counts.far + a.counts.hidden, 340);
  assert.ok(a.counts.near > 0 && a.counts.near <= 64, 'some men skinned near, inside the near budget of 64');
  assert.ok(a.counts.far > 100, 'most far');
  assert.equal(a.horses, 40);
  assert.ok(a.clips.slice(300).every((c) => c === 3), 'riders ride');
  assert.ok(a.clips.slice(0, 300).every((c) => c === 1), 'the foot walks at quick time');
  if (!a.same) {
    const p = JSON.parse(a.played), s = JSON.parse(a.sought);
    p[0].forEach((row, i) => JSON.stringify(row) !== JSON.stringify(s[0][i]) && console.log('person', i, JSON.stringify(row), JSON.stringify(s[0][i])));
    p[1].forEach((l, i) => l !== s[1][i] && console.log('level', i, l, s[1][i]));
  }
  assert.equal(a.same, true, 'a seek places everyone where playing did');
  assert.deepEqual(a.again, a.bytes, 'and draws the same frame, pixel for pixel');
  const h = await page.evaluate(() => window.check.handover());
  keep('near.png', h.a);
  keep('far.png', h.b);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.na, { near: 24, far: 0, hidden: 0 });
  assert.deepEqual(h.nb, { near: 0, far: 24, hidden: 0 });
  keep('control.png', h.c);
  const near = await mask(h.a),
    far = await mask(h.b),
    control = await mask(h.c),
    body = Math.max(1, near.reduce((x, y) => x + y, 0)),
    parted = (m) => m.reduce((n, v, i) => n + (v !== near[i] ? 1 : 0), 0) / body;
  const nc = share(near),
    fc = share(far),
    part = parted(far),
    off = parted(control);
  console.log('hand-over: near covers', (100 * nc).toFixed(2), 'far', (100 * fc).toFixed(2), 'percent; silhouette pixels that differ', (100 * part).toFixed(2), 'percent of the body; a quarter cycle off', (100 * off).toFixed(2));
  assert.ok(nc > 0.03, 'the close men are drawn');
  // The same pose on the 500-triangle far mesh: the silhouettes part only at the simplified edges.
  assert.ok(part <= HAND_OVER, `near and far stand in the same place: ${(100 * part).toFixed(2)} percent of the body differs`);
  // The bound tells a right pose from a wrong one: the same men a quarter cycle off part by far more.
  assert.ok(off > 10 * HAND_OVER, `a quarter cycle off parts ${(100 * off).toFixed(2)} percent, past 10 times the bound`);
  assert.deepEqual(pageErrors, []);
  console.log('armies check passed');
} finally {
  await context.close();
}
