// KB4000: gltf's screen-space Transmission pass draws on a display target (no HDR PostStack) from the native glass
// capture, decoded to linear light; before it threw "needs an HDR scene capture". Run with and without --compat.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';
const context = await openBrowser({ startPath: '/packages/gltf/test/screen-transmission.html', port: 'free' });
await runSuite(
  async () => {
    await context.page.waitForFunction(() => window.screenTransmission, null, { timeout: 30000 });
    let timer, rows;
    try {
      rows = await Promise.race([
        context.page.evaluate(() => window.screenTransmission()),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Screen transmission proof exceeded 180 seconds')), 180000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    const frames = {};
    for (const row of rows) {
      const picture = await decodePNG(Buffer.from(row.png.split(',')[1], 'base64'));
      delete row.png;
      assert.equal(picture.width, 128);
      // The glass covers the centre (about 98 px square); measure the middle 64 x 64.
      const red = [],
        green = [];
      for (let y = 32; y < 96; y++)
        for (let x = 32; x < 96; x++) {
          red.push(picture.data[(y * 128 + x) * 4]);
          green.push(picture.data[(y * 128 + x) * 4 + 1]);
        }
      row.greenMean = green.reduce((a, b) => a + b, 0) / green.length;
      const mean = red.reduce((a, b) => a + b, 0) / red.length;
      row.mean = mean;
      // Red values seen in the glass, and in the open checker at the left edge (x 0 to 7), for the report.
      const seen = (xs) => [...new Set(xs)].sort((a, b) => a - b);
      row.glassValues = seen(red);
      const open = [];
      for (let y = 32; y < 96; y++) for (let x = 0; x < 8; x++) open.push(picture.data[(y * 128 + x) * 4]);
      row.openValues = seen(open);
      row.spread = Math.sqrt(red.reduce((a, v) => a + (v - mean) ** 2, 0) / red.length);
      frames[`${row.name}:${row.antialias}`] = { row, red };
    }
    const levels = Math.floor(Math.log2(128)) + 1;
    const report = { hardware: context.hardware, levels, rows };
    writeFileSync(
      `test-results/kb4000-screen-transmission${context.hardware.compat ? '-compat' : ''}.json`,
      JSON.stringify(report, null, 2) + '\n',
    );
    for (const antialias of [false, true]) {
      const at = (name) => frames[`${name}:${antialias}`];
      const sharp = at('pass-rough0'),
        clearRough = at('pass-rough06'),
        bent = at('pass-ior15-rough0'),
        rough = at('pass-ior15-rough06'),
        tint = at('tint-rough0'),
        two = at('pass-two');
      // The checker shows through clear glass and blurs behind rough IOR 1.5 glass; a rough IOR 1 slab bends no ray, so
      // it stays see-through (the blur derivation in src/transmission.ts).
      assert.ok(sharp.row.spread > 60, `clear glass shows the checker (spread ${sharp.row.spread}, ${antialias})`);
      assert.ok(bent.row.spread > 60, `clear IOR 1.5 glass shows the checker (spread ${bent.row.spread}, ${antialias})`);
      assert.ok(
        rough.row.spread < bent.row.spread / 2,
        `roughness 0.6 at IOR 1.5 blurs the checker (${rough.row.spread} vs ${bent.row.spread}, ${antialias})`,
      );
      assert.ok(Math.abs(clearRough.row.spread - sharp.row.spread) < 1, `rough IOR 1 stays see-through (${antialias})`);
      // IOR 1, roughness 0, no specular: the pass equals the tinted blend in light (display decode right, no double encode).
      let worst = 0;
      for (let i = 0; i < sharp.red.length; i++) worst = Math.max(worst, Math.abs(sharp.red[i] - tint.red[i]));
      assert.ok(worst <= 1, `pass and tint agree through IOR 1 clear glass (worst ${worst} levels, ${antialias})`);
      // One scene copy (a mip chain of `levels` passes) per frame, also for two glass models.
      assert.equal(sharp.row.copies, levels, `one copy chain per frame (${antialias})`);
      assert.equal(two.row.copies, levels, `two glass models share one copy chain (${antialias})`);
      assert.equal(tint.row.copies, 0, 'the tint route copies nothing');
      // depthWrite: the white glass in front hides the red glass behind it in either draw order (green survives); without
      // it the later red draw lands over the white one (green gone). The white-only frame's green mean is the target.
      const white = sharp.row.greenMean;
      assert.ok(at('stack-blend-near-first').row.greenMean < white / 4, `blended: the later red glass covers (${antialias})`);
      for (const name of ['stack-write-near-first', 'stack-write-far-first'])
        assert.ok(Math.abs(at(name).row.greenMean - white) < 1, `${name}: the front glass hides the red (${antialias})`);
      // KB4000 step 4: parseGLTFAsync wires the pass for a file that declares KHR_materials_transmission (and the
      // synchronous parse when passed `screenTransmission`): the same pixels as the attached pass, with depth writes.
      for (const name of ['default-ior15-rough06', 'sync-ior15-rough06']) {
        const row = at(name);
        let worst = 0;
        for (let i = 0; i < rough.red.length; i++) worst = Math.max(worst, Math.abs(row.red[i] - rough.red[i]));
        assert.ok(worst <= 1, `${name} matches the attached pass (worst ${worst} levels, ${antialias})`);
        assert.equal(row.row.copies, levels, `${name}: one copy chain (${antialias})`);
        assert.equal(row.row.passes, 1, `${name}: one pass in the scene (${antialias})`);
        assert.equal(row.row.passesAfterAll, 0, `${name}: the pass goes with the model (${antialias})`);
      }
      const explicit = at('default-then-explicit');
      assert.equal(explicit.row.passes, 1, `an explicit Transmission replaces the default pass (${antialias})`);
      assert.equal(explicit.row.copies, levels, `default-then-explicit: one copy chain (${antialias})`);
      let drift = 0;
      for (let i = 0; i < rough.red.length; i++) drift = Math.max(drift, Math.abs(explicit.red[i] - rough.red[i]));
      assert.ok(drift <= 1, `default-then-explicit draws the glass once (worst ${drift} levels, ${antialias})`);
      const shared = at('default-two').row;
      assert.equal(shared.passes, 1, `two default-loaded glass models share one pass (${antialias})`);
      assert.equal(shared.copies, levels, `default-two: one copy chain (${antialias})`);
      assert.equal(shared.passesAfterOne, 1, `the pass stays while a glass model remains (${antialias})`);
      assert.equal(shared.passesAfterAll, 0, `the pass goes with the last glass model (${antialias})`);
      const off = at('default-off').row;
      assert.equal(off.passes, 0, `transmission: false adds no pass (${antialias})`);
      assert.equal(off.copies, 0, `transmission: false copies nothing (${antialias})`);
      assert.ok(off.spread > 60, `transmission: false keeps the unblurred tint (${off.spread}, ${antialias})`);
      assert.ok(
        Math.abs(at('default-stack-far-first').row.greenMean - white) < 1,
        `the default pass writes depth: the front glass hides the red (${antialias})`,
      );
    }
    console.log('screen transmission:', rows.length, 'frames passed', context.hardware.compat ? '(compat)' : '');
  },
  () => context.close(),
);
