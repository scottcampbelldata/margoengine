import { deferSpeed } from '../../../scripts/support/speed-phase.mjs';
// Real-GPU regression test: a materials mesh with a base colour map or alphaMap and `alphaTest` casts the cut-out shape,
// not its whole quad, into every shadow pass (`Shadows`, `LocalShadows` spot and point, Clustered's integrated local
// maps). Without the fix each of those passes shaded the floor under the cut-out half. A RawMesh casts its vertex
// stage's shape, cut by its fragment's discard, into Shadows, VirtualShadows, LocalShadows spot and point maps and
// Clustered's integrated spot and point maps, and every map follows its moves, uniform changes and material swaps. With `?hardware` the page asks for 'clip-distances',
// and clipped casters must cast the same through the rasterizer's clip distances in every pass.
// Run from the repository root after `npm run build:packages`: node packages/shadows/test/cutout-casters-browser.mjs
// `--cost` measures frame cost instead and asserts nothing about it.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

// A point's light against the same floor with no caster: at or under SHADED counts as in shadow, at or over LIT as clear.
const SHADED = 0.6,
  LIT = 0.93,
  // How far a hashed caster's share of the whole shadow may sit from its opacity: noise over a 25 x 25 patch.
  HASHED = 0.12;
const measuringCost = process.argv.includes('--cost');
if (!(measuringCost && deferSpeed('shadows cutout caster paired cost'))) {
  process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
  const context = await openBrowser({ startPath: '/packages/shadows/test/cutout-casters.html', port: 5268 }),
    { page } = context,
    pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
  const linear = (v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const shot = async (pass, caster, instanced) => {
    assert.deepEqual(await page.evaluate(([p, c, i]) => window.check.show(p, c, i), [pass, caster, instanced]), []);
    return decodePNG(await page.locator('canvas').screenshot());
  };
  // Mean linear luminance of a (2r + 1) x (2r + 1) patch around world point p.
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
  // Where each half of the quad (x -3 to -2 solid, -2 to -1 cut) lands on the floor, through its middle.
  const directional = { solid: [-0.5, 0, 0], cut: [0.5, 0, 0] },
    local = { solid: [-0.75, 0, 0], cut: [0.75, 0, 0] },
    passes = {
      directional,
      virtual: directional,
      spot: local,
      point: local,
      integratedSpot: local,
      integratedPoint: local,
    };
  // Whether each half's floor point is in shadow, per caster.
  const expected = {
    map: { solid: true, cut: false },
    opaque: { solid: true, cut: true },
    threshold: { solid: true, cut: false },
    above: { solid: false, cut: false },
    opacity: { solid: true, cut: false },
    transform: { solid: false, cut: true },
    alphaMap: { solid: true, cut: false },
    alphaOnly: { solid: true, cut: false },
    vertexOff: { solid: true, cut: true },
    vertexOn: { solid: false, cut: false },
    clipped: { solid: true, cut: false },
    clipOff: { solid: true, cut: true },
  };
  // RawMesh casters (@margoengine/shader/raw) in the passes that take a drawShadow or drawLocalShadow source.
  const rawExpected = { raw: { solid: true, cut: true }, rawCut: { solid: true, cut: false } },
    rawPasses = ['directional', 'virtual', 'spot', 'point', 'integratedSpot', 'integratedPoint'];
  try {
    await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
    if (measuringCost) {
      const result = [];
      for (const n of [50, 200])
        for (const kind of ['opaque', 'cutout', 'opaque', 'cutout']) {
          const row = await page.evaluate(([k, c]) => window.check.cost(k, c, 120), [kind, n]);
          assert.deepEqual(row.errors, []);
          result.push(row);
          console.log(JSON.stringify(row));
        }
      await writeFile('test-results/shadows-cutout-cost.json', JSON.stringify(result, null, 2));
    } else {
      const rows = [],
        failures = [],
        // Clipped frames by pass, caster and mode, so the hardware path's frames can be held against the discard path's.
        frames = new Map();
      let mode = 'discard';
      const run = async (pass, caster, instanced) => {
        const points = passes[pass],
          open = await shot(pass),
          lit = { solid: await patch(open, points.solid), cut: await patch(open, points.cut) },
          image = await shot(pass, caster, instanced),
          row = { pass, caster, instanced: !!instanced };
        if (caster === 'clipped' || caster === 'clipOff') frames.set(`${mode}:${pass}:${caster}:${!!instanced}`, image);
        for (const half of ['solid', 'cut']) {
          assert.ok(lit[half] > 0.02, `${pass}: the floor is unlit at ${half} (${lit[half]}), so nothing is measured`);
          const ratio = (row[half] = +((await patch(image, points[half])) / lit[half]).toFixed(3));
          if ((expected[caster] ?? rawExpected[caster])[half] ? ratio > SHADED : ratio < LIT)
            failures.push(`${pass} ${caster}${instanced ? ' instanced' : ''} ${half}: ${ratio} of its open light`);
        }
        rows.push(row);
        console.log(JSON.stringify(row));
      };
      for (const pass of Object.keys(passes)) for (const caster of Object.keys(expected)) await run(pass, caster);
      await run('directional', 'map', true);
      await run('directional', 'alphaMap', true);
      await run('directional', 'vertexOff', true);
      await run('spot', 'alphaMap', true);
      await run('integratedPoint', 'alphaMap', true);
      await run('point', 'clipped', true);
      await run('integratedSpot', 'clipped', true);
      await run('virtual', 'clipped', true);
      for (const pass of rawPasses) for (const caster of Object.keys(rawExpected)) await run(pass, caster);
      // A raw caster's cached maps follow a move, a uniform its vertex stage reads, and the way back.
      for (const pass of rawPasses) {
        const points = passes[pass],
          open = await shot(pass),
          lit = { solid: await patch(open, points.solid), cut: await patch(open, points.cut) };
        await shot(pass, 'raw');
        for (const [name, shaded] of [
          ['rawMove', false],
          ['rawBack', true],
          ['rawLift', false],
          ['rawBack', true],
          ['rawSwap', false],
          ['rawBack', true],
        ]) {
          assert.deepEqual(await page.evaluate((n) => window.check.edit(n), name), []);
          const image = await decodePNG(await page.locator('canvas').screenshot()),
            row = { pass, caster: 'raw', edit: name };
          for (const half of ['solid', 'cut']) {
            const ratio = (row[half] = +((await patch(image, points[half])) / lit[half]).toFixed(3));
            if (shaded ? ratio > SHADED : ratio < LIT)
              failures.push(`${pass} raw ${name} ${half}: ${ratio} of its open light`);
          }
          rows.push(row);
          console.log(JSON.stringify(row));
        }
      }
      // Live edits redraw the cached map: no test casts the whole quad, the test again cuts it, a new map moves the cut.
      {
        const points = passes.directional,
          open = await shot('directional'),
          lit = { solid: await patch(open, points.solid), cut: await patch(open, points.cut) };
        await shot('directional', 'map');
        for (const [name, solid, cut] of [
          ['noTest', true, true],
          ['test', true, false],
          ['swap', false, true],
        ]) {
          assert.deepEqual(await page.evaluate((n) => window.check.edit(n), name), []);
          const image = await decodePNG(await page.locator('canvas').screenshot()),
            row = { pass: 'directional', caster: 'live', edit: name };
          for (const [half, shaded] of [
            ['solid', solid],
            ['cut', cut],
          ]) {
            const ratio = (row[half] = +((await patch(image, points[half])) / lit[half]).toFixed(3));
            if (shaded ? ratio > SHADED : ratio < LIT)
              failures.push(`live ${name} ${half}: ${ratio} of its open light`);
          }
          rows.push(row);
          console.log(JSON.stringify(row));
        }
      }
      // Hashed alpha (materials alphaHash): each pass darkens the floor by the opacity's share of the whole quad's shadow,
      // measured over a 25 x 25 patch so the noise averages out. A fixed cutoff gave 0 at 0.3 and 1 at 0.7.
      for (const pass of Object.keys(passes)) {
        const points = passes[pass],
          open = await shot(pass),
          whole = await shot(pass, 'opaque');
        for (const [caster, opacity] of [
          ['hashed30', 0.3],
          ['hashed70', 0.7],
        ]) {
          const image = await shot(pass, caster),
            row = { pass, caster };
          for (const half of ['solid', 'cut']) {
            const lit = await patch(open, points[half], 12),
              dark = lit - (await patch(whole, points[half], 12)),
              share = (row[half] = +((lit - (await patch(image, points[half], 12))) / dark).toFixed(3));
            assert.ok(
              dark > 0.1 * lit,
              `${pass}: the whole quad shades ${half} (${dark} of ${lit}), so nothing is measured`,
            );
            if (Math.abs(share - opacity) > HASHED)
              failures.push(`${pass} ${caster} ${half}: ${share} of the whole shadow, opacity ${opacity}`);
          }
          rows.push(row);
          console.log(JSON.stringify(row));
        }
      }
      // The hardware clip path: the same page on an engine that asks for 'clip-distances'. Every pass that takes material
      // clipping planes cuts in the rasterizer there (Clustered's integrated maps included), and must cast what the
      // discard path casts. Where no adapter offers the feature this is recorded and the discard rows above stand.
      await page.goto(page.url().split('?')[0] + '?hardware');
      await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
      const hardware = await page.evaluate(() => window.check.hardware);
      if (!hardware.has)
        console.log('cut-out casters: no adapter here offers clip-distances; the hardware clip path is not checked');
      else {
        mode = 'hardware';
        const before = await page.evaluate(() => window.check.clipModules());
        for (const pass of Object.keys(passes)) for (const caster of ['clipped', 'clipOff']) await run(pass, caster);
        await run('point', 'clipped', true);
        await run('integratedSpot', 'clipped', true);
        await run('virtual', 'clipped', true);
        const compiled = (await page.evaluate(() => window.check.clipModules())) - before;
        console.log(JSON.stringify({ hardware: true, clipModules: compiled }));
        // The whole frame, the clipped quad as the camera sees it included, matches the discard path's: a pixel may
        // differ only where the rasterizer and a per-fragment test round a cut edge differently.
        for (const [key, image] of frames) {
          if (!key.startsWith('hardware:')) continue;
          const other = frames.get(key.replace('hardware:', 'discard:'));
          let differ = 0,
            box;
          for (let i = 0; i < image.data.length; i += 4)
            if (Math.max(...[0, 1, 2].map((k) => Math.abs(image.data[i + k] - other.data[i + k]))) > 8) {
              differ++;
              const x = (i / 4) % image.width,
                y = Math.floor(i / 4 / image.width);
              box = box
                ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)]
                : [x, y, x, y];
            }
          const share = differ / (image.width * image.height);
          console.log(JSON.stringify({ frame: key, differ, share: +share.toFixed(5), box }));
          if (share > 0.002) failures.push(`${key}: ${differ} pixels differ from the discard path`);
        }
        // Each pass's clipped caster compiled through clip_distances, not only the colour pass.
        assert.ok(compiled >= Object.keys(passes).length, `clip_distances modules compiled: ${compiled}`);
      }
      await writeFile('test-results/shadows-cutout-casters.json', JSON.stringify(rows, null, 2));
      assert.deepEqual(failures, []);
    }
    assert.deepEqual(pageErrors, []);
    console.log('shadows cut-out casters: ok');
  } finally {
    await context.close?.();
  }
}
