// Real-GPU check against an outside renderer: a real glTF model's shadow on a white ground, as Margo draws it and as Blender
// Cycles (a path tracer sharing no code with Margo) drew it. reference.py writes the fixtures; this needs no Blender.
// Both sides give the same quantity, ground light with the model over ground light without it, so no Margo code decides
// what the right answer is. Run from the repository root after `npm run build:packages`.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../../scripts/browser.js';
import { crc32, deflateSync } from 'node:zlib';
import { decodePNG } from '../../../../tests/support/png.js';
import { acquire } from '../../../../scripts/gpu-lock.mjs';

process.chdir(fileURLToPath(new URL('../../../..', import.meta.url)));
const dump = process.argv.find((a) => a.startsWith('--dump='))?.slice(7);
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
const linear = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
// A difference picture for --dump: red Margo, green Cycles, blue their difference, full red where the model hides the ground.
const encodePNG = (width, height, rgba) => {
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rows.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]),
      out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header.set([8, 6], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};
const fixture = async (name) => decodePNG(await readFile(`packages/shadows/test/fixtures/outside/${name}.png`));
const { cases } = await import('./cases.mjs');
const release = await acquire({ owner: 'shadows-outside' });
const context = await openBrowser({ startPath: '/packages/shadows/test/outside/outside.html', port: 5273 }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
const shot = async () => decodePNG(await page.locator('canvas').screenshot());
const failures = [];
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  for (const c of cases) {
    if (only && !c.name.includes(only)) continue;
    assert.deepEqual(await page.evaluate((s) => window.check.scene(s), c.scene), []);
    const open = await shot();
    assert.deepEqual(await page.evaluate(([k, o, n]) => window.check.shadows(k, o, n), [c.kind, c.options, c.control]), []);
    const lit = await shot(),
      visibility = await fixture(`${c.reference ?? c.scene}.visibility`),
      mask = await fixture(`${c.reference ?? c.scene}.mask`),
      { width, height } = lit;
    assert.equal(visibility.width, width, 'the reference and the frame must be the same size');
    let both = 0,
      either = 0,
      difference = 0,
      count = 0,
      shadowed = 0;
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        // A model pixel and its neighbours show the model, not the ground.
        let hidden = false;
        for (let j = -1; j <= 1; j++)
          for (let i = -1; i <= 1; i++) {
            const q = (Math.min(height - 1, Math.max(0, y + j)) * width + Math.min(width - 1, Math.max(0, x + i))) * 4;
            hidden ||= mask.data[q] > 127;
          }
        const base = linear(open.data[o + 1]),
          ours = base > 0.004 ? Math.min(1, linear(lit.data[o + 1]) / base) : 1,
          theirs = visibility.data[o + 1] / 255;
        out[o] = hidden ? 255 : ours * 255;
        out[o + 1] = hidden ? 0 : theirs * 255;
        out[o + 2] = hidden ? 0 : Math.abs(ours - theirs) * 255;
        out[o + 3] = 255;
        // No sun here in the engine's own frame: light over no light is no measurement, as in the reference's mask.
        if (hidden || base <= 0.004) continue;
        count++;
        difference += Math.abs(ours - theirs);
        const a = ours < 0.5,
          b = theirs < 0.5;
        if (a && b) both++;
        if (a || b) either++;
        if (b) shadowed++;
      }
    const row = {
      name: c.name,
      iou: +(both / either).toFixed(4),
      meanDifference: +(difference / count).toFixed(4),
      shadowedPixels: shadowed,
    };
    console.log(JSON.stringify(row));
    if (dump) {
      await mkdir(dump, { recursive: true });
      await writeFile(`${dump}/${c.name}.png`, encodePNG(width, height, out));
    }
    if (shadowed < c.minShadow) failures.push(`${c.name}: only ${shadowed} shadowed pixels, so nothing is measured`);
    if (c.below !== undefined) {
      // A control: the feature off, so the same comparison has to come out worse, or it proves nothing.
      if (row.iou >= c.below) failures.push(`${c.name}: the control reached ${row.iou}, so the check cannot see the feature`);
      continue;
    }
    if (row.iou < c.iou) failures.push(`${c.name}: shadow overlap ${row.iou}, needs ${c.iou}`);
    if (row.meanDifference > c.difference)
      failures.push(`${c.name}: mean difference ${row.meanDifference}, allowed ${c.difference}`);
  }
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(failures, []);
  console.log('shadows against Cycles: ok');
} finally {
  await context.close?.();
  await release();
}
