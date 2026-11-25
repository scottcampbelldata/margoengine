// Real-adapter check (run from the repository root after building packages): node packages/shader/test/black-hole-check.mjs
// The black hole's look on the GPU, each measure on the frame's pixels:
// - camera frame: a camera just off the z axis sees the shadow in the middle of the frame and the disk across it (the
//   Radeon 680M's D3D12 compiler drops the sign of -(v * k).z / (v * k).x, so the old atan2 camera frame looked away);
// - stars: point stars away from the photon ring stay round (median axis ratio of their second moments under 1.5),
//   where the same stars point sampled (prefilter off) stretch;
// - jet: seen side on the relativistic jet beams away from the camera, so its band shows no bright columns;
// - disk: the turbulent disk's fine detail stays as it was between 1 s and 120 s on the shader clock (no winding).
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const context = await openBrowser({ startPath: '/packages/shader/test/black-hole-check.html', port: 5241 }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
await page.waitForFunction(() => document.title === 'ready', null, { timeout: 60000 });

/** Renders a scene and returns its luminance image (mean of the 8-bit channels), w, h. */
async function frame(scene) {
  const result = await page.evaluate((s) => window.check.scene(s), scene);
  assert.deepEqual(result.errors, [], JSON.stringify(scene));
  const png = await decodePNG(await page.locator('canvas').screenshot());
  const lum = new Float32Array(png.width * png.height);
  for (let i = 0; i < lum.length; i++) lum[i] = (png.data[i * 4] + png.data[i * 4 + 1] + png.data[i * 4 + 2]) / 3;
  return { lum, w: png.width, h: png.height };
}
const at = (f, x, y) => f.lum[Math.round(y) * f.w + Math.round(x)];

/** Second-moment axis ratios of the stars (local maxima above 50) farther than `clear` px from the frame's middle. */
function starRatios(f, clear) {
  const ratios = [],
    R = 3;
  for (let y = R; y < f.h - R; y++)
    for (let x = R; x < f.w - R; x++) {
      const v = at(f, x, y);
      if (v < 50 || Math.hypot(x - f.w / 2, y - f.h / 2) < clear) continue;
      let peak = true,
        floor = Infinity;
      for (let j = -R; j <= R; j++)
        for (let i = -R; i <= R; i++) {
          const u = at(f, x + i, y + j);
          if ((i || j) && Math.abs(i) <= 1 && Math.abs(j) <= 1 && (u > v || (u === v && (j < 0 || (j === 0 && i < 0)))))
            peak = false;
          floor = Math.min(floor, u);
        }
      if (!peak) continue;
      let m = 0,
        sx = 0,
        sy = 0,
        sxx = 0,
        syy = 0,
        sxy = 0;
      for (let j = -R; j <= R; j++)
        for (let i = -R; i <= R; i++) {
          const u = Math.max(at(f, x + i, y + j) - floor, 0);
          m += u;
          sx += u * i;
          sy += u * j;
        }
      const cx = sx / m,
        cy = sy / m;
      for (let j = -R; j <= R; j++)
        for (let i = -R; i <= R; i++) {
          const u = Math.max(at(f, x + i, y + j) - floor, 0);
          sxx += u * (i - cx) ** 2;
          syy += u * (j - cy) ** 2;
          sxy += u * (i - cx) * (j - cy);
        }
      const t = (sxx + syy) / m,
        d = Math.sqrt(((sxx - syy) / m) ** 2 + 4 * (sxy / m) ** 2);
      ratios.push(Math.sqrt((t + d) / Math.max(t - d, 1e-3)));
    }
  return ratios.sort((a, b) => a - b);
}

/** Fine-detail energy of the bright part of a frame: mean squared Laplacian over mean squared value, where lum > 20. */
function fineEnergy(f) {
  let e = 0,
    s = 0;
  for (let y = 1; y < f.h - 1; y++)
    for (let x = 1; x < f.w - 1; x++) {
      const v = at(f, x, y);
      if (v <= 20) continue;
      const l = 4 * v - at(f, x - 1, y) - at(f, x + 1, y) - at(f, x, y - 1) - at(f, x, y + 1);
      e += l * l;
      s += v * v;
    }
  return e / s;
}

const report = process.argv.includes('--report');
const results = {};

// Camera frame: just off the z axis, edge on. The shadow sits in the middle and the disk crosses the frame.
{
  const f = await frame({ position: [0.01, 0.12, 12.5], turbulence: 0 });
  let row = 0;
  for (let x = 0; x < f.w; x++) row = Math.max(row, at(f, x, f.h / 2));
  results.cameraFrame = { middle: at(f, f.w / 2, f.h * 0.38), diskRow: row };
}

// Stars, close and inclined, disk and jet off: away from the ring every star is a round point.
for (const [name, prefilter] of [
  ['stars', true],
  ['starsPointSampled', false],
]) {
  const f = await frame({ position: [-0.55, 0.95, 11.8], target: [0, -0.05, 0], accretion: 0, stars: 1, prefilter });
  const r = starRatios(f, f.h * 0.3);
  results[name] = {
    count: r.length,
    median: r[r.length >> 1],
    p75: r[Math.floor(r.length * 0.75)],
    p90: r[Math.floor(r.length * 0.9)],
    max: r.at(-1),
  };
}

// Jet side on, disk and stars off: the band above and below the hole stays dark.
{
  const f = await frame({ position: [26, 3, 0], accretion: 0, jet: 1 });
  let band = 0;
  for (let y = 0; y < f.h; y++) {
    if (Math.abs(y - f.h / 2) < f.h * 0.12) continue;
    for (let x = Math.floor(f.w * 0.4); x < f.w * 0.6; x++) band = Math.max(band, at(f, x, y));
  }
  results.jet = { band };
}

// Disk detail at 1 s and 120 s on the shader clock, turbulence at full.
{
  const a = fineEnergy(await frame({ position: [-0.55, 0.95, 11.8], target: [0, -0.05, 0], turbulence: 1, time: 1 })),
    b = fineEnergy(await frame({ position: [-0.55, 0.95, 11.8], target: [0, -0.05, 0], turbulence: 1, time: 120 }));
  results.disk = { early: a, late: b, ratio: b / a };
}

// The jet from near the pole (70 degrees latitude), disk and stars off: the middle of the shadow stays dark. Its base,
// just outside the horizon, shone there as a bright dot while the jet's light had no lapse redshift and the
// mass-starved funnel next to the hole radiated.
{
  const f = await frame({ position: [2.3, 11.7, 3.4], accretion: 0, jet: 1 });
  let peak = 0;
  for (let y = 0; y < f.h; y++)
    for (let x = 0; x < f.w; x++)
      if (Math.hypot(x - f.w / 2, y - f.h / 2) < f.h * 0.1) peak = Math.max(peak, at(f, x, y));
  results.jetBase = { peak };
}

console.log(JSON.stringify(results));
await context.close();
assert.deepEqual(pageErrors, []);
if (!report) {
  assert.ok(
    results.cameraFrame.middle < 12,
    `camera frame: the shadow is not in the middle (${results.cameraFrame.middle})`,
  );
  assert.ok(
    results.cameraFrame.diskRow > 120,
    `camera frame: no disk across the middle row (${results.cameraFrame.diskRow})`,
  );
  assert.ok(results.stars.count >= 20, `stars: too few to measure (${results.stars.count})`);
  assert.ok(results.stars.median < 1.5, `stars: stretched (median axis ratio ${results.stars.median})`);
  // The control: point sampled (prefilter off), as the march drew stars before, the same measure sees them stretched.
  assert.ok(
    results.starsPointSampled.median > 2,
    `stars: the measure misses stretched stars (${results.starsPointSampled.median})`,
  );
  assert.ok(results.jet.band < 40, `jet: bright columns side on (${results.jet.band})`);
  assert.ok(
    results.disk.ratio < 1.25 && results.disk.ratio > 0.8,
    `disk: fine detail changed over time (${results.disk.ratio})`,
  );
  console.log('ok black hole: camera frame, round stars, jet side on, disk detail over time');
}
