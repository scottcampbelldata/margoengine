// Real-GPU check of the order-independent passes on real files: Khronos sample models with BLEND and transmission parts,
// from eight sides. Takes a GPU slot itself. From the repository root, after building packages:
// node packages/oit/test/gpu/real-check.mjs [folder for pictures]
// Under MARGO_COMPAT=1 ExactOIT refuses by design (README "Exact (ExactOIT)": `setup` throws 'unsupported'; use OIT).
// Each model's 'exact' run then asserts that coded refusal, the particles run goes through the documented fallback
// (weighted OIT) and is compared with OIT's own run, and the assertions that need an ExactOIT picture ("ExactOIT takes
// its BLEND parts", the oit and moments distances to exact, "moments stay closer to exact") are skipped with a note.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../../scripts/browser.js';
import { acquire } from '../../../../scripts/gpu-lock.mjs';
import { compatRun } from '../../../../scripts/support/compat-shim.js';
import { decodePNG } from '../../../../tests/support/png.js';

const models = [
  'khronos-samples/GlassVaseFlowers',
  'khronos-samples/DiffuseTransmissionPlant',
  'khronos-samples/TransmissionTest',
  'khronos/AlphaBlendModeTest/AlphaBlendModeTest',
  'khronos/LightsPunctualLamp/LightsPunctualLamp',
  'khronos/CommercialRefrigerator/CommercialRefrigerator',
];
const angles = [0, 45, 90, 135, 180, 225, 270, 315];
const folder = process.argv[2];
const compat = compatRun(),
  release = await acquire({ owner: 'oit-real' });
const context = await openBrowser({ startPath: '/packages/oit/test/gpu/real.html', port: 5290 }),
  { page } = context;
/** Pixels of two pictures apart by more than 2 of 255 in any channel, of all; the mean and worst channel gap among them. */
function gap(a, b) {
  let moved = 0,
    sum = 0,
    worst = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.max(
      Math.abs(a.data[i] - b.data[i]),
      Math.abs(a.data[i + 1] - b.data[i + 1]),
      Math.abs(a.data[i + 2] - b.data[i + 2]),
    );
    if (d > 2) {
      moved++;
      sum += d;
      worst = Math.max(worst, d);
    }
  }
  return { moved: moved / (a.data.length / 4), mean: moved ? sum / moved : 0, worst };
}
const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, +v.toFixed(4)]));
try {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text());
  });
  await page
    .waitForFunction(() => window.ready, null, { timeout: 30000 })
    .catch((error) => {
      throw new Error(`the page did not start: ${pageErrors.join('; ') || error.message}`);
    });
  const shot = async (name) => {
    const url = await page.evaluate(() => window.check.shot()),
      bytes = Buffer.from(url.split(',')[1], 'base64');
    if (folder && name) await writeFile(`${folder}/${name}.png`, bytes);
    return decodePNG(bytes);
  };
  const orbit = async (name, o) => {
    const info = await page.evaluate((options) => window.check.build(options), o),
      pictures = [];
    let taken = 0;
    for (const angle of angles) {
      taken = await page.evaluate((a) => window.check.turn(a), angle);
      pictures.push(await shot(angle % 90 === 0 ? `${name}-${angle}` : undefined));
    }
    return { info, pictures, taken };
  };
  const between = (a, b) => {
    const each = a.pictures.map((p, i) => gap(p, b.pictures[i]));
    return round({
      moved: Math.max(...each.map((e) => e.moved)),
      mean: Math.max(...each.map((e) => e.mean)),
      worst: Math.max(...each.map((e) => e.worst)),
    });
  };
  const report = {};
  for (const path of models) {
    const name = path.split('/').pop(),
      url = `/examples/assets/${path}.glb`,
      samples = 4,
      sorted = await orbit(`${name}-sorted`, { samples, url }),
      repeat = await orbit(`${name}-repeat`, { samples, url }),
      entry = (report[name] = { model: sorted.info, repeat: between(sorted, repeat) }),
      runs = {};
    for (const mode of ['oit', 'blending', 'moments', 'exact']) {
      if (compat && mode === 'exact') {
        const error = await page.evaluate(
          (options) =>
            window.check.build(options).then(
              () => null,
              (e) => ({ code: e.code, message: e.message }),
            ),
          { samples, url, mode },
        );
        entry.exact = { refused: error };
        assert.equal(error?.code, 'unsupported', `compat ${name}: ExactOIT must refuse, got ${JSON.stringify(error)}`);
        assert.match(error.message, /^ExactOIT needs storage buffers in fragment shaders; use OIT on this device/);
        continue;
      }
      const started = Date.now();
      runs[mode] = await orbit(`${name}-${mode}`, { samples, url, mode });
      entry[mode] = {
        taken: runs[mode].taken,
        seconds: (Date.now() - started) / 1000,
        sorted: between(sorted, runs[mode]),
      };
    }
    if (!compat) for (const mode of ['oit', 'moments']) entry[mode].exact = between(runs.exact, runs[mode]);
    // Particles through the model, in the pass with its parts (on compat, the documented fallback: weighted OIT).
    const reference = compat ? runs.oit : runs.exact,
      particles = await orbit(`${name}-particles`, { samples, url, mode: compat ? 'oit' : 'exact', particles: true });
    entry.particles = { taken: particles.taken, exact: between(reference, particles) };
    // The depth of the scene with and without its glass.
    await page.evaluate((options) => window.check.build(options), { samples: 1, url });
    const before = await page.evaluate(() => window.check.depth());
    await page.evaluate((options) => window.check.build(options), { samples: 1, url, depth: true });
    const after = await page.evaluate(() => window.check.depth()),
      nearer = after.filter((d, i) => d > before[i]).length,
      farther = after.filter((d, i) => d < before[i]).length;
    entry.depth = { nearer: nearer / after.length, farther: farther / after.length };
    console.log(name, JSON.stringify(entry));
    // Only parts the hook takes reach a pass: BLEND ones, and with `blending` transmission too.
    const held = sorted.info.transparent > 0;
    if (!compat) assert.equal(runs.exact.taken > 0, held, `${name}: ExactOIT takes its BLEND parts and only those`);
    assert.equal(runs.moments.taken > 0, held, `${name}: MomentOIT takes its BLEND parts and only those`);
    assert.ok(runs.blending.taken > 0, `${name}: blending takes every transparent part`);
    // Reversed Z: a surface added to the depth can only bring a pixel nearer, and every model here has one to add.
    assert.ok(nearer > 0, `${name}: its glass reaches the depth`);
    assert.equal(farther, 0, `${name}: no pixel moves away`);
    // A fifth of the frame's size in particles shows through: some land on open background from every side.
    assert.ok(
      entry.particles.exact.moved > 0.05,
      `${name}: the particles show with the model, ${entry.particles.exact.moved}`,
    );
  }
  // Layers on layers: moments stay closer to the exact picture than weighted blending, as on the generated planes.
  if (compat) console.log('compat: ExactOIT refused for every model; the comparisons with an ExactOIT picture skipped');
  else {
    const { oit, moments } = report.GlassVaseFlowers;
    assert.ok(moments.exact.moved < oit.exact.moved, `moments ${moments.exact.moved}, weighted ${oit.exact.moved}`);
  }
  const errors = await page.evaluate(() => window.check.errors);
  assert.deepEqual(errors.concat(pageErrors), [], 'no GPU or shader errors');
  console.log('oit real file check passed');
} finally {
  await context.close();
  release();
}
