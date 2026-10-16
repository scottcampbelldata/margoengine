// Shadow shimmer under slow camera motion (HANDOFF 1f.i), real GPU. Run from the repository root after
// `npm run build:packages`, on AC power (takes the GPU lock):
//   node examples/package-benchmarks/shadow-shimmer.mjs [--low] [--frames=64]
// Scene: examples/package-benchmarks/shadow-shimmer.html (thin posts, a beam and plates on a floor; @margoengine/shadows
// 2048, distance 60; 800x600 canvas, 4x MSAA unless --low).
// Measures, per frame, the change of shadow-edge pixels (penumbra: 10-90% of the frame's largest shadow attenuation,
// from the same frame rendered with no shadow casters):
// - pan: live frame vs the same camera with the cascades fitted to the sequence's first camera ("frozen"). With texel
//   snapping the texel lattice is world-locked, so these must match up to the static noise floor. Orthographic pans also
//   get a motion-compensated check: frame i vs frame i+4 (exactly 1 px later) shifted by 1 px.
// - orthographic zoom (projection.zoom): the cascades must not change at all.
// - dolly (orthographic with a fixed height, so the image of the world does not change): consecutive frames; plus, for
//   every motion, the texel lattice read from shadows.matrices (radius constant, centre an integer number of texels).
// - control: a 0.01 degree per frame light rotation (unsnappable), to show what shimmer looks like in these numbers.
// Writes examples/package-benchmarks/results/shadow-shimmer.json.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openBrowser } from '../../scripts/browser.js';
import { decodePNG } from '../../tests/support/png.js';

const frames = +(process.argv.find((a) => a.startsWith('--frames='))?.slice(9) ?? 64),
  low = process.argv.includes('--low');
const power = () =>
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      '(Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus | Select-Object -First 1).PowerOnline',
    ],
    { encoding: 'utf8' },
  ).trim() === 'True';
const lock =
  process.env.MARGO_GPU_LOCK_NESTED ??
  resolve(
    dirname(
      execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim(),
    ),
    'test-results/gpu.lock',
  );
assert.ok(power(), 'On battery: run on AC power');
for (;;) {
  try {
    mkdirSync(lock);
    break;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    console.log('GPU lock held, waiting');
    await new Promise((r) => setTimeout(r, 15000));
  }
}
const report = {
  recordedAt: new Date().toISOString(),
  commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(),
  frames,
  acPowerBefore: true,
};
let context;
try {
  context = await openBrowser({ startPath: '/examples/package-benchmarks/shadow-shimmer.html', port: 5212 });
  const { page } = context;
  report.hardware = context.hardware;
  if (low)
    await page.addInitScript(() => {
      globalThis.margoLow = 1;
    }),
      await page.reload();
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  const set = async (state) => {
    const r = await page.evaluate((s) => window.shimmer.set(s), state);
    assert.equal(r.error, null);
    assert.deepEqual(r.errors, []);
    report.samples = r.samples;
    return r;
  };
  const shot = async (state) => {
    const r = await set(state),
      png = await page.locator('canvas').screenshot();
    return { ...r, png, image: await decodePNG(png) };
  };
  const luma = (d, o) => 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2];
  const edges = (on, off) => {
    const n = on.width * on.height,
      a = new Float32Array(n);
    let max = 0;
    for (let i = 0; i < n; i++) {
      a[i] = 1 - luma(on.data, i * 4) / Math.max(luma(off.data, i * 4), 1);
      if (a[i] > max) max = a[i];
    }
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) mask[i] = a[i] > 0.1 * max && a[i] < 0.9 * max ? 1 : 0;
    return mask;
  };
  // dx: compare x[p] with y[p + dx]. Panning the camera 1 px right moves the content 1 px left, so dx = -1.
  const diff = (x, y, mask, dx = 0) => {
    let pixels = 0,
      changed = 0,
      sum = 0,
      max = 0;
    for (let row = 0; row < x.height; row++)
      for (let col = Math.max(0, -dx); col < x.width - Math.max(0, dx); col++) {
        const i = row * x.width + col;
        if (mask && !mask[i]) continue;
        pixels++;
        const o = i * 4,
          q = (i + dx) * 4;
        let d = 0;
        for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(x.data[o + k] - y.data[q + k]));
        if (d > 2) changed++;
        sum += d;
        if (d > max) max = d;
      }
    return { pixels, changed, mean: +(sum / Math.max(pixels, 1)).toFixed(4), max };
  };
  const lattice = (matrices) => {
    let fraction = 0;
    const radii = [];
    for (let c = 0; c < 4; c++) {
      const o = c * 16,
        radius = 1 / Math.hypot(matrices[o], matrices[o + 4], matrices[o + 8]),
        texel = (2 * radius) / 2048;
      radii.push(+radius.toFixed(4));
      for (const k of [12, 13]) {
        const t = (-matrices[o + k] * radius) / texel;
        fraction = Math.max(fraction, Math.abs(t - Math.round(t)));
      }
    }
    return { radii, fraction };
  };
  const summary = (rows) => {
    const keys = Object.keys(rows[0]).filter((k) => typeof rows[0][k] === 'object' && 'changed' in rows[0][k]);
    return Object.fromEntries(
      keys.map((k) => [
        k,
        {
          frames: rows.length,
          edgePixelsMean: Math.round(rows.reduce((s, r) => s + r[k].pixels, 0) / rows.length),
          changedMax: Math.max(...rows.map((r) => r[k].changed)),
          changedMean: +(rows.reduce((s, r) => s + r[k].changed, 0) / rows.length).toFixed(2),
          meanMax: Math.max(...rows.map((r) => r[k].mean)),
          maxDelta: Math.max(...rows.map((r) => r[k].max)),
        },
      ]),
    );
  };
  const latticeSummary = (list) => ({
    radiiConstant: list.every((l) => JSON.stringify(l.radii) === JSON.stringify(list[0].radii)),
    radii: list[0].radii,
    maxTexelFraction: +Math.max(...list.map((l) => l.fraction)).toExponential(2),
  });

  // Noise floor: the same state rendered again, and frozen vs live at the first camera (identical cascades).
  for (const mode of ['orthographic', 'perspective']) {
    const a = await shot({ mode }),
      b = await shot({ mode }),
      f = await shot({ mode, frozen: true }),
      off = await shot({ mode, shadows: false }),
      mask = edges(a.image, off.image);
    report[`noise-${mode}`] = {
      repeat: diff(a.image, b.image, mask),
      frozenAtStart: diff(a.image, f.image, mask),
      repeatAllPixels: diff(a.image, b.image),
    };
    console.log(`noise ${mode}`, JSON.stringify(report[`noise-${mode}`]));
  }
  // Slow pans: 0.25 px per frame.
  for (const mode of ['orthographic', 'perspective']) {
    const rows = [],
      live = [],
      lattices = [];
    for (let i = 0; i < frames; i++) {
      const pan = i * 0.25,
        a = await shot({ mode, pan }),
        f = await shot({ mode, pan, frozen: true }),
        off = await shot({ mode, pan, shadows: false }),
        mask = edges(a.image, off.image);
      live.push({ image: a.image, mask });
      lattices.push(lattice(a.matrices));
      if (!i) writeFileSync(resolve(import.meta.dirname, `../../test-results/shadow-shimmer-${mode}.png`), a.png);
      const row = { pan, liveVsFrozen: diff(a.image, f.image, mask) };
      if (mode === 'orthographic' && i >= 4) row.onePixelShift = diff(live[i - 4].image, a.image, live[i - 4].mask, -1);
      rows.push(row);
    }
    const valid = rows.map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)));
    report[`pan-${mode}`] = {
      summary: {
        liveVsFrozen: summary(valid).liveVsFrozen,
        ...(mode === 'orthographic' ? { onePixelShift: summary(valid.slice(4)).onePixelShift } : {}),
      },
      lattice: latticeSummary(lattices),
      rows: valid,
    };
    console.log(
      `pan ${mode}`,
      JSON.stringify(report[`pan-${mode}`].summary),
      JSON.stringify(report[`pan-${mode}`].lattice),
    );
  }
  // Orthographic zoom by projection.zoom: the shadow pass must see no change at all.
  {
    const first = await set({}),
      list = [],
      hits = [];
    for (let i = 0; i <= 40; i++) {
      const r = await set({ zoom: 1 + i * 0.0125 });
      list.push(r.matrices);
      hits.push(r.cacheHits);
    }
    report['zoom-orthographic'] = {
      matricesUnchanged: list.every((m) => m.every((v, k) => v === first.matrices[k])),
      cacheHitsPerFrame: (hits.at(-1) - hits[0]) / (hits.length - 1),
    };
    console.log('zoom orthographic', JSON.stringify(report['zoom-orthographic']));
  }
  // Dolly: orthographic with a fixed height (the world's image is unchanged), and the lattice for both modes.
  for (const mode of ['orthographic', 'perspective']) {
    const rows = [],
      lattices = [];
    let previous;
    for (let i = 0; i < frames; i++) {
      const dolly = i * 0.005,
        a = await shot({ mode, dolly });
      lattices.push(lattice(a.matrices));
      if (mode === 'orthographic') {
        // Moving along the view axis moves the cascade split distances across the scene: pixels whose floor point
        // changed cascade switch shadow-map resolution (a moving boundary, not shimmer) and are reported apart.
        const off = await shot({ mode, dolly, shadows: false }),
          mask = edges(a.image, off.image),
          cascade = Buffer.from(await page.evaluate(() => window.shimmer.cascades()), 'base64');
        if (previous) {
          const same = previous.mask.map((m, k) => (m && previous.cascade[k] === cascade[k] ? 1 : 0)),
            moved = previous.mask.map((m, k) => (m && previous.cascade[k] !== cascade[k] ? 1 : 0));
          rows.push({
            dolly,
            consecutive: diff(previous.image, a.image, previous.mask),
            sameCascade: diff(previous.image, a.image, same),
            cascadeChanged: diff(previous.image, a.image, moved),
          });
        }
        previous = { image: a.image, mask, cascade };
      }
    }
    report[`dolly-${mode}`] = {
      ...(rows.length ? { summary: summary(rows), rows } : {}),
      lattice: latticeSummary(lattices),
    };
    console.log(
      `dolly ${mode}`,
      JSON.stringify(report[`dolly-${mode}`].summary ?? {}),
      JSON.stringify(report[`dolly-${mode}`].lattice),
    );
  }
  // Control: real shimmer. Static camera, light turning 0.01 degree per frame.
  {
    const rows = [];
    let previous;
    for (let i = 0; i < 16; i++) {
      const a = await shot({ light: i * 0.01 }),
        off = await shot({ light: i * 0.01, shadows: false }),
        mask = edges(a.image, off.image);
      if (previous) rows.push({ light: i * 0.01, consecutive: diff(previous.image, a.image, previous.mask) });
      previous = { image: a.image, mask };
    }
    report.controlLightRotation = { summary: summary(rows), rows };
    console.log('control', JSON.stringify(report.controlLightRotation.summary));
  }
  report.acPowerAfter = power();
  assert.ok(report.acPowerAfter, 'Power dropped to battery during the run; discard it');
  const out = resolve(import.meta.dirname, `results/shadow-shimmer${low ? '-low' : ''}.json`);
  writeFileSync(out, JSON.stringify(report, null, 1) + '\n');
  console.log('wrote', out);
} finally {
  await context?.close();
  rmdirSync(lock);
}
