// Real-GPU check of VolumetricFog (`@margoengine/environment/volumetric`). Run on AC power, holding the GPU lock, after
// npm run build:packages:  node examples/package-benchmarks/volumetric-gpu.mjs [--no-timing]
// At 4x and 1x MSAA (Tonemap capture, 1280x720, volumetric.html):
// 1. Light shafts: the wall left of the slit (rays cross the sunlit shaft) against the wall right of it (rays stay in
//    the wall's shadow), slit open vs plugged; perspective and orthographic.
// 2. Spot light cone visible in fog (inside vs outside the cone, with and without `lights`), and its LocalShadows: the
//    fog under a box caster in the cone darkens.
// 3. Density and height falloff on a black wall lit by ambient only (wall pixels show fog alone).
// 4. No NaN/Inf or negative values in the integrated volume.
// 5. (4x) Flicker: frame-to-frame change with a still camera and over a slow pan, fog against no fog.
// 6. GPU cost (timestamp queries, Stats profiler): fog variants and grid sizes at 1280x720 and 1920x1080, after
//    scripts/quiet-gate.mjs (labelled diagnostic when the machine did not get quiet).
// Writes results/volumetric-gpu.json and frames to test-results/volumetric-*.png.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openBrowser } from '../../scripts/browser.js';
import { waitForQuiet } from '../../scripts/quiet-gate.mjs';
import { decodePNG } from '../../tests/support/png.js';

const ac = () =>
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      '(Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus | Select-Object -First 1).PowerOnline',
    ],
    { encoding: 'utf8' },
  ).trim();
const powerBefore = ac();
assert.equal(powerBefore, 'True', 'measure on AC power only');
const timing = !process.argv.includes('--no-timing'),
  port = 5231;
const context = await openBrowser({ startPath: '/examples/package-benchmarks/volumetric.html', port }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const report = {
  benchmark: 'volumetric-gpu',
  recordedAt: new Date().toISOString(),
  hardware: hardware.webgpu,
  browser: hardware.browserName + ' ' + hardware.browserVersion,
  powerOnline: { before: powerBefore },
  checks: {},
};
const open = async (query) => {
  await page.goto(`http://127.0.0.1:${port}/examples/package-benchmarks/volumetric.html${query}`);
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
};
const shot = async (name, options) => {
  const result = await page.evaluate((o) => window.check.render(o), options);
  assert.equal(result.error, null, name);
  assert.deepEqual(result.errors, [], name);
  return decodePNG(
    await page.locator('canvas').screenshot(name ? { path: `test-results/volumetric-${name}.png` } : {}),
  );
};
const luma = (image, [x, y], r = 2) => {
  let sum = 0,
    n = 0;
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) {
      const i = ((Math.round(y) + dy) * image.width + Math.round(x) + dx) * 4;
      sum += 0.2126 * image.data[i] + 0.7152 * image.data[i + 1] + 0.0722 * image.data[i + 2];
      n++;
    }
  return sum / n;
};
const mean = (image, points) => points.reduce((s, p) => s + luma(image, p), 0) / points.length;
const project = (points) => page.evaluate((p) => window.check.project(p), points);
const round = (v) => +v.toFixed(3),
  deferred = []; // flicker asserts run after the timings, so one GPU slot yields both
try {
  for (const samples of [4, 1]) {
    await open(samples === 1 ? '?samples=1' : '');
    const tag = samples + 'x',
      out = (report.checks[tag] = {});
    // 1. Shafts.
    const left = [],
      right = [];
    for (const y of [1.5, 2.5, 3.5])
      for (const x of [2, 2.5, 3]) {
        left.push([-x, y, -1.74]);
        right.push([x, y, -1.74]);
      }
    for (const ortho of [false, true]) {
      const name = ortho ? 'orthographic' : 'perspective',
        fog = { density: 0.06, anisotropy: 0.6, range: 60, shadows: true };
      const none = await shot(`${tag}-shaft-${name}-nofog`, { scene: 'shaft', ortho }),
        closed = await shot(`${tag}-shaft-${name}-closed`, { scene: 'shaft', fog, ortho, closed: true });
      const lit = await shot(`${tag}-shaft-${name}`, { scene: 'shaft', fog, ortho }),
        [l, r] = [await project(left), await project(right)];
      const row = {
        litColumns: round(mean(lit, l)),
        shadowedColumns: round(mean(lit, r)),
        closedLeft: round(mean(closed, l)),
        closedRight: round(mean(closed, r)),
        noFogLeft: round(mean(none, l)),
        noFogRight: round(mean(none, r)),
      };
      row.shaftRatio = round(row.litColumns / row.shadowedColumns);
      row.closedRatio = round(row.closedLeft / row.closedRight);
      const [a, b] = await project([
        [-6, 2.5, -1.74],
        [6, 2.5, -1.74],
      ]);
      row.profile = Array.from({ length: 25 }, (_, i) =>
        Math.round(luma(lit, [a[0] + ((b[0] - a[0]) * i) / 24, a[1] + ((b[1] - a[1]) * i) / 24])),
      );
      out['shaft-' + name] = row;
      console.log(tag, name, JSON.stringify(row));
      assert.ok(
        row.shaftRatio > 1.5 * row.closedRatio && row.litColumns - row.shadowedColumns > 15,
        `${tag} ${name}: no light shaft (${row.shaftRatio} vs closed ${row.closedRatio})`,
      );
    }
    const nan = (out.volumeAfterShaft = await page.evaluate(() => window.check.volume()));
    console.log(tag, 'volume', JSON.stringify(nan));
    assert.equal(nan.nonFinite, 0, 'NaN/Inf in the volume');
    assert.equal(nan.negative, 0, 'negative fog');
    // 2. Spot cone and its local shadow.
    const fogSpot = { density: 0.05, range: 40, lights: true };
    const spot = await shot(`${tag}-spot`, { scene: 'spot', fog: fogSpot }),
      [inside, outside, under] = await project([
        [0, 3, -6],
        [3.5, 3, -6],
        [0, 2, -6],
      ]),
      noLights = await shot(`${tag}-spot-nolights`, { scene: 'spot', fog: { ...fogSpot, lights: false } });
    const unshadowed = await shot(`${tag}-spot-caster`, { scene: 'spot', fog: fogSpot, caster: true }),
      shadowed = await shot(`${tag}-spot-caster-shadow`, {
        scene: 'spot',
        fog: fogSpot,
        caster: true,
        spotShadow: true,
      });
    const cone = (out.spot = {
      inside: round(luma(spot, inside, 4)),
      outside: round(luma(spot, outside, 4)),
      noLightsInside: round(luma(noLights, inside, 4)),
      noLightsOutside: round(luma(noLights, outside, 4)),
      underCasterNoShadow: round(luma(unshadowed, under, 4)),
      underCasterShadow: round(luma(shadowed, under, 4)),
    });
    console.log(tag, 'spot', JSON.stringify(cone));
    assert.ok(
      cone.inside > 1.5 * cone.outside && cone.inside - cone.outside > 20,
      `${tag}: spot cone not visible in fog`,
    );
    assert.ok(Math.abs(cone.noLightsInside - cone.noLightsOutside) < 4, `${tag}: cone without lights`);
    assert.ok(cone.underCasterShadow < 0.85 * cone.underCasterNoShadow, `${tag}: LocalShadows do not shadow the fog`);
    out.volumeAfterSpot = await page.evaluate(() => window.check.volume());
    assert.equal(out.volumeAfterSpot.nonFinite + out.volumeAfterSpot.negative, 0);
    // 3. Density and height falloff (black wall, ambient only: luma is fog alone).
    await shot(null, { scene: 'falloff', fog: null, frames: 1 });
    const [low, high, centre] = await project([
      [0, 1, -29.7],
      [0, 9, -29.7],
      [0, 5, -29.7],
    ]);
    const density = [];
    for (const d of [0.01, 0.03, 0.09])
      density.push(
        round(
          luma(await shot(`${tag}-density-${d}`, { scene: 'falloff', fog: { density: d, anisotropy: 0 } }), centre, 4),
        ),
      );
    const uniform = await shot(`${tag}-height-uniform`, { scene: 'falloff', fog: { density: 0.03, anisotropy: 0 } }),
      layered = await shot(`${tag}-height-falloff`, {
        scene: 'falloff',
        fog: { density: 0.03, anisotropy: 0, heightFalloff: 0.4, height: 2 },
      });
    const height = (out.falloff = {
      density,
      uniformLow: round(luma(uniform, low, 4)),
      uniformHigh: round(luma(uniform, high, 4)),
      falloffLow: round(luma(layered, low, 4)),
      falloffHigh: round(luma(layered, high, 4)),
    });
    console.log(tag, 'falloff', JSON.stringify(height));
    assert.ok(
      density[0] < density[1] && density[1] < density[2] && density[0] > 3,
      `${tag}: fog does not grow with density`,
    );
    assert.ok(Math.abs(height.uniformLow - height.uniformHigh) < 3, `${tag}: uniform fog depends on height`);
    assert.ok(height.falloffLow > 1.3 * height.falloffHigh, `${tag}: no height falloff`);
    // 5. Flicker: per-pixel frame-to-frame change, still camera then a slow pan (0.05 degrees per frame).
    if (samples === 4) {
      const frames = async (fog, turn) => {
        await page.evaluate((o) => window.check.render(o), { scene: 'shaft', fog, frames: 30 });
        const images = [];
        for (let i = 0; i < 31; i++) {
          await page.evaluate((d) => window.check.turn(d), turn ? i * 0.05 : 0);
          images.push(await decodePNG(await page.locator('canvas').screenshot()));
        }
        const steps = [];
        for (let i = 1; i < images.length; i++) {
          const a = images[i - 1].data,
            b = images[i].data,
            diffs = new Uint32Array(256);
          let sum = 0,
            n = 0;
          for (let k = 0; k < a.length; k += 4) {
            const d = Math.round(
              Math.abs(0.2126 * (a[k] - b[k]) + 0.7152 * (a[k + 1] - b[k + 1]) + 0.0722 * (a[k + 2] - b[k + 2])),
            );
            diffs[d]++;
            sum += d;
            n++;
          }
          let c = 0,
            p99 = 0;
          for (let d = 0; d < 256; d++) {
            c += diffs[d];
            if (c >= n * 0.99) {
              p99 = d;
              break;
            }
          }
          steps.push({ mean: sum / n, p99 });
        }
        const m = steps.map((s) => s.mean).sort((x, y) => x - y);
        return {
          meanChange: round(m.reduce((s, v) => s + v, 0) / m.length),
          medianChange: round(m[m.length >> 1]),
          maxChange: round(m.at(-1)),
          maxP99: Math.max(...steps.map((s) => s.p99)),
        };
      };
      const fog = { density: 0.06, anisotropy: 0.6, range: 60, shadows: true };
      const flicker = (out.flicker = {
        still: await frames(fog, false),
        stillNoFog: await frames(null, false),
        pan: await frames(fog, true),
        panNoFog: await frames(null, true),
        still95: await frames({ ...fog, temporal: 0.95 }, false),
        pan95: await frames({ ...fog, temporal: 0.95 }, true),
      });
      console.log(tag, 'flicker', JSON.stringify(flicker));
      deferred.push(
        () => assert.ok(flicker.still.maxP99 <= 2 && flicker.still.maxChange < 0.5, 'fog flickers with a still camera'),
        () =>
          assert.ok(
            flicker.pan.maxChange <= 2 * flicker.pan.medianChange + 0.5 &&
              flicker.pan.maxChange <= flicker.panNoFog.maxChange + 1,
            'fog flickers over a slow pan',
          ),
      );
    }
  }
  // 6. Timings.
  if (timing) {
    let machine;
    try {
      machine = await waitForQuiet({ timeout: 600 });
      report.timingConditions = { quiet: true, ...machine };
    } catch (error) {
      report.timingConditions = { quiet: false, label: 'diagnostic (machine busy)', reason: error.message };
      console.log('timings are diagnostic:', error.message);
    }
    report.timings = [];
    for (const [size, samples] of [
      ['1280x720', 4],
      ['1920x1080', 4],
      ['1280x720', 1],
      ['1920x1080', 1],
    ]) {
      await open(`?size=${size}&samples=${samples}`);
      const cases = [
        { name: 'no fog' },
        { name: 'fog', fog: {} },
        { name: 'fog + sun shadows', fog: { shadows: true } },
        { name: 'fog + sun shadows + 8 point lights', fog: { shadows: true, lights: true }, pointLights: 8 },
        ...[
          [80, 45, 32],
          [240, 135, 96],
        ].map((grid) => ({ name: `fog + sun shadows, grid ${grid.join('x')}`, fog: { shadows: true, grid } })),
        { name: 'no fog (again)' },
      ];
      for (const c of cases) {
        const row = await page.evaluate((o) => window.check.bench(o), {
          fog: c.fog ?? null,
          pointLights: c.pointLights ?? 0,
        });
        assert.deepEqual(row.errors, []);
        delete row.errors;
        const entry = {
          size,
          samples,
          case: c.name,
          grid: c.fog ? (c.fog.grid ?? [160, 90, 64]).join('x') : null,
          ...row,
        };
        report.timings.push(entry);
        console.log(JSON.stringify(entry));
      }
    }
  }
  assert.deepEqual(pageErrors, []);
} finally {
  await context.close();
}
report.powerOnline.after = ac();
assert.equal(report.powerOnline.after, 'True', 'still on AC power');
await writeFile(resolve(import.meta.dirname, 'results/volumetric-gpu.json'), JSON.stringify(report, null, 2) + '\n');
for (const check of deferred) check();
console.log('volumetric GPU check passed');
