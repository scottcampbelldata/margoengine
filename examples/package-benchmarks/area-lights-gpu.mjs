// Real-GPU check of @margoengine/clustered/area (AC power, GPU lock, after npm run build:packages):
//   node examples/package-benchmarks/area-lights-gpu.mjs            correctness (no quiet machine needed)
//   node examples/package-benchmarks/area-lights-gpu.mjs --bench    plus GPU cost per light (run node scripts/quiet-gate.mjs first)
// 1. A glossy (roughness 0.2) and a rough (0.8) grey floor, as a core mesh and as a materials plane (gltf-pro, lit through
//    lights.add), under one rectangle light: at ~700 pixel centres per frame the screenshot equals the CPU mirror of the
//    WGSL (test/ltc-reference.js) pushed through each path's tone mapping, within 3/255; on the core floors a few of those
//    points are also compared with brute-force GGX + Lambert quadrature (radiance from the inverted tone map).
// 2. Highlight shape under a square light: the glossy floor's half-maximum region is stretched along the view direction;
//    the rough floor's is not, and its largest pixel-to-pixel radiance step is much smaller (soft falloff). No AreaLights
//    equals an empty one.
// 3. Two-sided: a light facing away from the floor leaves it black; twoSided lights it exactly like the light turned down.
// 4. --bench: GPU pass time (timestamp queries, median) at 1280x720 with no AreaLights, an empty one, and 1/4/16 lights.
// Writes results/area-lights-gpu.json and the frames to test-results/area-lights-*.png.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openBrowser } from '../../scripts/browser.js';
import { cpuLoad } from '../../scripts/quiet-gate.mjs';
import { decodePNG } from '../../tests/support/png.js';
import { AreaLights } from '../../packages/clustered/dist/area.js';
import { ltc, bruteForce } from '../../packages/clustered/test/ltc-reference.js';

const bench = process.argv.includes('--bench'),
  benchOnly = process.argv.includes('--bench-only');
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
assert.equal(powerBefore, 'True', 'run on AC power only');
const pack = (light) => {
  const a = new AreaLights({ lights: { setLights() {} } });
  a.setLights([light]);
  return Array.from(a['data'].subarray(4, 20));
};
const srgb = (c) => Math.round(255 * Math.min(1, c >= 0.0031308 ? 1.055 * c ** (1 / 2.4) - 0.055 : c * 12.92));
const linear = (byte) => {
  const c = byte / 255;
  return c >= 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92;
};
// Output transforms: core (Reinhard, packages/core/src/shaders.ts) and gltf-pro (ACES fit / 0.6, packages/shared/aces.js).
const aces = (v) => {
  const m1 = [
      [0.59719, 0.35458, 0.04823],
      [0.076, 0.90834, 0.01566],
      [0.0284, 0.13383, 0.83777],
    ],
    m2 = [
      [1.60475, -0.53108, -0.07367],
      [-0.10208, 1.10813, -0.00605],
      [-0.00327, -0.07276, 1.07602],
    ];
  const x = m1
    .map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2])
    .map((x) => (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.432951) + 0.238081));
  return m2.map((r) => Math.min(1, Math.max(0, r[0] * x[0] + r[1] * x[1] + r[2] * x[2])));
};
const output = {
  core: (rgb) => rgb.map((c) => srgb(c / (1 + c))),
  materials: (rgb) => aces(rgb.map((c) => Math.max(c, 0) / 0.6)).map(srgb),
};
const pixel = (image, [x, y]) => {
  const i = (y * image.width + x) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2]];
};

// The page's first load can exceed openBrowser's 30 s goto under load (Vite transforms every dist module), so open a
// trivial path first and load the page with a longer timeout.
const context = await openBrowser({ startPath: '/LICENSE', port: 5263 }),
  { page, hardware } = context,
  pageErrors = [];
await page.goto('http://127.0.0.1:5263/examples/package-benchmarks/area-lights.html', { timeout: 300000 });
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const report = {
  benchmark: 'area-lights-gpu',
  recordedAt: new Date().toISOString(),
  hardware: hardware.webgpu,
  browser: hardware.browserName + ' ' + hardware.browserVersion,
  resolution: [1280, 720],
  powerOnline: { before: powerBefore },
};
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const shot = async (name, options) => {
    const result = await page.evaluate((o) => window.check.render(o), options);
    assert.equal(result.error, null, name);
    assert.deepEqual(result.errors, [], name);
    const image = await decodePNG(
      await page.locator('canvas').screenshot({ path: `test-results/area-lights-${name}.png` }),
    );
    assert.equal(image.width, 1280);
    return { image, eye: result.eye };
  };
  if (!benchOnly) {
    const grid = [];
    for (let y = 250; y < 720; y += 20) for (let x = 20; x < 1280; x += 40) grid.push([x, y]);
    const floorPoints = await page.evaluate((p) => window.check.unproject(p), grid);
    const panel = {
      position: [0, 1.4, -0.8],
      direction: [0, -1, 0.3],
      width: 1.6,
      height: 0.6,
      color: [1, 0.95, 0.9],
      intensity: 8,
    };
    report.reference = [];
    for (const kind of ['core', 'materials'])
      for (const roughness of [0.2, 0.8]) {
        const name = `${kind}-${roughness}`,
          { image, eye } = await shot(name, { floor: kind + roughness, light: panel }),
          light = pack(panel);
        let worst = 0,
          lit = 0,
          nonFinite = 0;
        const physical = [];
        floorPoints.forEach((p, i) => {
          const v = eye.map((e, k) => e - p[k]),
            length = Math.hypot(...v),
            rgb = ltc(
              light,
              p,
              [0, 1, 0],
              v.map((x) => x / length),
              [0.6, 0.6, 0.6],
              roughness,
              0,
            ).total;
          if (!rgb.every(Number.isFinite)) nonFinite++;
          const want = output[kind](rgb),
            got = pixel(image, grid[i]);
          worst = Math.max(worst, ...got.map((g, k) => Math.abs(g - want[k])));
          if (want[1] > 20) lit++;
        });
        if (kind === 'core') {
          // Brightest sample points and a few on the falloff: GPU radiance (inverted tone map) vs brute-force quadrature.
          const order = floorPoints
            .map((p, i) => i)
            .sort((a, b) => pixel(image, grid[b])[1] - pixel(image, grid[a])[1]);
          for (const i of [order[0], order[3], order[10], order[30], order[60]]) {
            const p = floorPoints[i],
              v = eye.map((e, k) => e - p[k]),
              length = Math.hypot(...v),
              m = linear(pixel(image, grid[i])[1]),
              gpu = m / (1 - m);
            const truth = bruteForce(
              light,
              p,
              [0, 1, 0],
              v.map((x) => x / length),
              [0.6, 0.6, 0.6],
              roughness,
              0,
              roughness < 0.5 ? 768 : 256,
            ).total[1];
            physical.push({
              pixel: grid[i],
              gpu: +gpu.toFixed(4),
              bruteForce: +truth.toFixed(4),
              relative: +(gpu / truth - 1).toFixed(3),
            });
          }
        }
        const row = {
          floor: kind,
          roughness,
          samples: grid.length,
          litSamples: lit,
          maxDiffVsCpuMirror: worst,
          nonFinite,
          ...(physical.length ? { vsBruteForce: physical } : {}),
        };
        report.reference.push(row);
        console.log(JSON.stringify(row));
        assert.equal(nonFinite, 0);
        assert.ok(lit > 40, `${name}: only ${lit} lit samples`);
        assert.ok(worst <= 3, `${name}: GPU differs from the CPU mirror by ${worst}/255`);
        for (const r of physical)
          assert.ok(Math.abs(r.relative) < 0.2, `${name}: GPU ${r.gpu} vs brute force ${r.bruteForce} at ${r.pixel}`);
      }
    // Highlight shape: half-maximum region of a square light's reflection, measured on the floor (x across, z toward the camera).
    const square = { position: [0, 1.4, -1.2], direction: [0, -1, 0], width: 0.8, height: 0.8, intensity: 8 },
      fine = [];
    for (let y = 240; y < 720; y += 4) for (let x = 200; x < 1080; x += 4) fine.push([x, y]);
    const finePoints = await page.evaluate((p) => window.check.unproject(p), fine);
    report.highlight = [];
    for (const roughness of [0.2, 0.8]) {
      const { image } = await shot(`square-${roughness}`, { floor: 'core' + roughness, light: square }),
        luma = fine.map((p) => pixel(image, p)[1]),
        peak = Math.max(...luma);
      const half = finePoints.filter((p, i) => linear(luma[i]) >= 0.5 * linear(peak)),
        span = (k) => Math.max(...half.map((p) => p[k])) - Math.min(...half.map((p) => p[k]));
      // Sharpness: largest radiance step between vertically adjacent samples (4 px), from the inverted core tone map.
      const radiance = luma.map((b) => {
          const m = linear(b);
          return m / (1 - m);
        }),
        across = 880 / 4;
      let step = 0;
      for (let i = 0; i + across < radiance.length; i++)
        step = Math.max(step, Math.abs(radiance[i + across] - radiance[i]));
      const row = {
        roughness,
        peak,
        halfMaxSamples: half.length,
        extentX: +span(0).toFixed(3),
        extentZ: +span(2).toFixed(3),
        stretch: +(span(2) / span(0)).toFixed(2),
        maxStep: +step.toFixed(4),
      };
      report.highlight.push(row);
      console.log(JSON.stringify(row));
    }
    const [glossy, rough] = report.highlight;
    assert.ok(glossy.stretch > 1.3, `glossy highlight not stretched toward the viewer (${glossy.stretch})`);
    // On these dielectric floors Lambert diffuse (the same at both roughnesses) dominates the half-maximum region, so the
    // rough floor's softness shows as smaller radiance steps rather than a wider region.
    assert.ok(
      rough.stretch < glossy.stretch && glossy.maxStep > 1.25 * rough.maxStep,
      'rough highlight should be softer and less stretched',
    );
    // Zero cost when unused: no AreaLights, and an AreaLights without lights, render the same frame.
    const none = (await shot('none', { floor: 'core0.8', light: null })).image,
      empty = (await shot('empty', { floor: 'core0.8', light: 'empty' })).image;
    assert.deepEqual(empty.data, none.data, 'an AreaLights without lights changed the frame');
    // Two-sided: facing away from the floor -> black; twoSided -> identical to the same light facing the floor.
    const up = { ...square, direction: [0, 1, 0] },
      away = (await shot('away', { floor: 'core0.8', light: up })).image,
      both = (await shot('two-sided', { floor: 'core0.8', light: { ...up, twoSided: true } })).image,
      down = (await shot('down', { floor: 'core0.8', light: square })).image;
    let awayMax = 0,
      sideDiff = 0;
    for (let i = 0; i < down.data.length; i++) {
      if (i % 4 === 3) continue;
      awayMax = Math.max(awayMax, Math.abs(away.data[i] - none.data[i]));
      sideDiff = Math.max(sideDiff, Math.abs(both.data[i] - down.data[i]));
    }
    report.twoSided = { oneSidedFacingAwayMaxDiffVsUnlit: awayMax, twoSidedMaxDiffVsFacingDown: sideDiff };
    console.log(JSON.stringify(report.twoSided));
    assert.ok(awayMax <= 1 && sideDiff <= 1, 'two-sided toggle');
  }
  if (bench || benchOnly) {
    report.timings = [];
    report.cpuLoadAtStart = cpuLoad();
    for (const count of benchOnly ? [null, 4] : [null, 0, 1, 4, 16, null]) {
      const row = await page.evaluate((o) => window.check.bench(o), { count });
      assert.deepEqual(row.errors, []);
      delete row.errors;
      report.timings.push(row);
      console.log(JSON.stringify(row));
    }
  }
  assert.deepEqual(pageErrors, []);
} finally {
  await context.close();
}
report.powerOnline.after = ac();
assert.equal(report.powerOnline.after, 'True', 'still on AC power');
if (!benchOnly)
  await writeFile(resolve(import.meta.dirname, 'results/area-lights-gpu.json'), JSON.stringify(report, null, 2) + '\n');
console.log('area lights GPU check passed');
