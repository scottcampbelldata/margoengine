// Real-GPU check and cost of SSR's model capture (`ssr.add(model)`, HANDOFF 5l.l). Run on AC power, holding the GPU lock,
// after npm run build:packages:
//   node examples/package-benchmarks/ssr-models-gpu.mjs [--rounds=3] [--frames=90] [--no-timing] [--diagnostic]
// Correctness (ssr.html, each scene rendered with SSR on and off in the same PostStack pipeline):
// 1. Mirror floor as a generated glTF plane (gltf-pro, metal 1, roughness 0) at 4x/1x and as a @margoengine/materials
//    mesh: the red box appears in the floor exactly inside the projected planar-mirror bounds and at the mirrored centre,
//    like the core floor (same scene, ssr-gpu.mjs); the floor's IBL specular is replaced, not added (green at the mirrored
//    centre falls from the grey environment reflection to the red box's). Not added with ssr.add: the floor is unchanged.
// 2. Roughness from a metallic-roughness map (factor 1): 0.3 blurs and weakens the reflection; 0.8 (> maxRoughness) leaves
//    the frame unchanged.
// 3. DamagedHelmet beside a red box: SSR changes the helmet's metal and visor pixels and some turn redder.
// No black (NaN) pixels anywhere. Timing: GPU time of the capture pass (models into SSR's targets) and of SSR's own passes
// with a glossy glTF floor filling most of the view (12 boxes, worst case) and with DamagedHelmet, each added vs not
// added, at 1280x720 and 1920x1080, 4x and 1x.
// Run `node scripts/quiet-gate.mjs` first for publishable timings; --diagnostic labels them as taken on a busy machine.
// Writes examples/package-benchmarks/results/ssr-models-gpu.json, frames to test-results/ssr-models-*.png.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { openBrowser } from '../../scripts/browser.js';
import { decodePNG } from '../../tests/support/png.js';
import { acPower } from './cad/power.mjs';

const arg = (name, fallback) => {
  const a = process.argv.find((v) => v.startsWith(`--${name}`));
  return a ? (a.includes('=') ? +a.split('=')[1] : true) : fallback;
};
const rounds = arg('rounds', 3),
  frames = arg('frames', 90);
const report = {
  date: new Date().toISOString(),
  commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(),
  acPowerBefore: acPower(),
  checks: {},
  timing: {},
  timingLabel: arg('diagnostic', false) ? 'diagnostic (machine not quiet-gated)' : 'after scripts/quiet-gate.mjs',
};
assert.equal(report.acPowerBefore, true, 'run on AC power only');
const context = await openBrowser({
    startPath: '/examples/package-benchmarks/ssr.html',
    port: 5252,
    args: ['--enable-webgpu-developer-features'],
  }),
  { page, hardware } = context,
  pageErrors = [];
page.setDefaultTimeout(120_000);
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
report.gpu = hardware.webgpu;
report.browser = hardware.browserName + ' ' + hardware.browserVersion;
const px = (img, x, y) => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};
const grab = async (name) =>
  decodePNG(await page.locator('canvas').screenshot({ path: `test-results/ssr-models-${name}.png` }));
async function pair(name, config) {
  const info = await page.evaluate((c) => window.check.run(c), config);
  assert.deepEqual(info.errors, [], name);
  const on = await grab(name + '-on');
  assert.deepEqual((await page.evaluate(() => window.check.toggle(false))).errors, [], name);
  const off = await grab(name + '-off');
  let red = 0,
    outside = 0,
    black = 0,
    maxDiff = 0,
    changed = 0,
    redder = 0,
    x0 = 1e9,
    y0 = 1e9,
    x1 = -1,
    y1 = -1;
  const [mx0, my0, mx1, my1] = info.mirror,
    hb = info.helmetBounds;
  for (let y = 0; y < on.height; y++)
    for (let x = 0; x < on.width; x++) {
      const a = px(on, x, y),
        b = px(off, x, y),
        d = Math.max(...a.map((v, i) => Math.abs(v - b[i])));
      maxDiff = Math.max(maxDiff, d);
      if (a[0] + a[1] + a[2] === 0 && b[0] + b[1] + b[2] > 0) black++;
      if (hb && x >= hb[0] && x <= hb[2] && y >= hb[1] && y <= hb[3] && d > 8) {
        changed++;
        if (a[0] - a[1] > b[0] - b[1] + 8) redder++;
      }
      if (a[0] - a[1] > 60 && !(b[0] - b[1] > 60)) {
        red++;
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
        if (x < mx0 - 3 || x > mx1 + 3 || y < my0 - 3 || y > my1 + 3) outside++;
      }
    }
  const [cx, cy] = info.center,
    inside = cx >= 0 && cy >= 0 && cx < on.width && cy < on.height;
  return {
    name,
    info,
    on,
    off,
    row: {
      mirrorBounds: info.mirror,
      mirroredCenter: info.center,
      redPixels: red,
      redBounds: red ? [x0, y0, x1, y1] : null,
      redOutsideMirror: outside,
      blackIntroduced: black,
      maxDiff,
      centerOn: inside ? px(on, cx, cy) : null,
      centerOff: inside ? px(off, cx, cy) : null,
      ...(hb ? { helmetBounds: hb, helmetChanged: changed, helmetRedder: redder } : {}),
    },
  };
}
function edgeWidth(img, info) {
  const y = info.center[1],
    from = Math.max(0, info.mirror[0] - 30),
    to = info.center[0],
    v = [];
  for (let x = from; x <= to; x++) {
    const p = px(img, x, y);
    v.push(p[0] - p[1]);
  }
  const lo = Math.min(...v),
    hi = Math.max(...v),
    a = v.findIndex((s) => s > lo + 0.1 * (hi - lo)),
    b = v.findIndex((s) => s > lo + 0.9 * (hi - lo));
  return { width: b - a, contrast: hi - lo };
}
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60_000 });
  const results = {};
  for (const [name, config] of Object.entries({
    'core-mirror-4x': { roughness: 0 },
    'gltf-mirror-4x': { roughness: 0, floor: 'gltf' },
    'gltf-mirror-1x': { roughness: 0, floor: 'gltf', samples: 1 },
    'materials-mirror-4x': { roughness: 0, floor: 'materials' },
    'gltf-not-added': { roughness: 0, floor: 'gltf', add: false },
    'gltf-map-0.3': { roughness: 0.3, floor: 'gltf', roughMap: true },
    'gltf-map-0.8': { roughness: 0.8, floor: 'gltf', roughMap: true },
    'helmet-4x': { helmet: true, size: [640, 512] },
  })) {
    const r = (results[name] = await pair(name, config));
    report.checks[name] = r.row;
    console.log(name, JSON.stringify(r.row));
  }
  for (const [name, r] of Object.entries(results))
    assert.equal(r.row.blackIntroduced, 0, `${name}: SSR introduced black (NaN) pixels`);
  const core = results['core-mirror-4x'].row;
  for (const name of ['gltf-mirror-4x', 'gltf-mirror-1x', 'materials-mirror-4x']) {
    const r = results[name].row;
    assert.ok(r.redPixels > 200, `${name}: no reflection`);
    assert.ok(
      r.redOutsideMirror <= Math.max(8, r.redPixels * 0.002),
      `${name}: reflected pixels outside the planar-mirror bounds`,
    );
    assert.ok(r.centerOn[0] - r.centerOn[1] > 60, `${name}: mirrored centre is not red`);
    // Double counting: added on top of the IBL, G would stay at least as high as the grey environment reflection.
    assert.ok(
      r.centerOn[1] < 0.5 * r.centerOff[1],
      `${name}: IBL specular not replaced (G ${r.centerOn[1]} vs ${r.centerOff[1]})`,
    );
    // The same reflection as the core floor: area within 5%, mirrored-centre colour within a few levels.
    assert.ok(
      Math.abs(r.redPixels - core.redPixels) <= 0.05 * core.redPixels,
      `${name}: ${r.redPixels} reflected pixels vs core floor ${core.redPixels}`,
    );
    for (const k of [0, 1, 2])
      assert.ok(
        Math.abs(r.centerOn[k] - core.centerOn[k]) <= 6 && Math.abs(r.centerOff[k] - core.centerOff[k]) <= 6,
        `${name}: centre ${r.centerOn}/${r.centerOff} vs core ${core.centerOn}/${core.centerOff}`,
      );
  }
  const notAdded = results['gltf-not-added'].row;
  assert.ok(notAdded.maxDiff <= 1 && notAdded.redPixels === 0, 'a model not added must not reflect');
  const sharp = edgeWidth(results['gltf-mirror-4x'].on, results['gltf-mirror-4x'].info),
    soft = edgeWidth(results['gltf-map-0.3'].on, results['gltf-map-0.3'].info);
  report.checks.blur = { mirrorEdge: sharp, map03Edge: soft };
  console.log('blur', JSON.stringify(report.checks.blur));
  assert.ok(soft.width > sharp.width + 2, 'rough-mapped floor: reflection not blurred');
  const map = results['gltf-map-0.3'].row,
    mirror = results['gltf-mirror-4x'].row;
  assert.ok(
    map.redPixels > 0 && map.centerOn[0] - map.centerOn[1] < mirror.centerOn[0] - mirror.centerOn[1],
    'rough-mapped floor: reflection not weaker',
  );
  assert.ok(results['gltf-map-0.8'].row.maxDiff <= 1, 'mapped roughness above maxRoughness must be untouched');
  const helmet = results['helmet-4x'].row;
  assert.ok(
    helmet.helmetChanged > 500 && helmet.helmetRedder > 50,
    `helmet: ${helmet.helmetChanged} pixels changed, ${helmet.helmetRedder} redder`,
  );

  if (!arg('no-timing', false)) {
    const configs = [];
    for (const size of [
      [1280, 720],
      [1920, 1080],
    ])
      for (const samples of [4, 1])
        configs.push({ size, samples, scene: 'bench', floor: 'gltf', roughness: 0.1 }, { size, samples, helmet: true });
    const samples = {};
    for (let round = 0; round < rounds; round++)
      for (const config of round % 2 ? [...configs].reverse() : configs)
        for (const add of [true, false]) {
          assert.notEqual(acPower(), false, 'On battery mid-run');
          const key = `${config.helmet ? 'helmet' : 'glTF floor'} ${config.size.join('x')} ${config.samples}x ${add ? 'added' : 'not added'}`;
          const info = await page.evaluate((c) => window.check.run(c), { ...config, add, frames: 2 });
          assert.deepEqual(info.errors, [], key);
          let m;
          for (let attempt = 0; attempt < 3 && !(m && !m.error); attempt++)
            m = await page.evaluate((f) => window.check.measure(f), frames);
          assert.ok(!m.error, m.error);
          assert.deepEqual(m.errors, [], key);
          m.ownerMs.ssr = Object.entries(m.ownerMs)
            .filter(([k]) => k.startsWith('ssr'))
            .reduce((t, [, v]) => t + v, 0);
          (samples[key] ??= []).push(m);
          console.log(
            'round',
            round + 1,
            key,
            JSON.stringify({ gpuMs: m.gpuMs, ssrMs: m.ownerMs.ssr, captureMs: m.ownerMs['ssr:capture'] ?? 0 }),
          );
        }
    const median = (a) => {
      const s = [...a].sort((x, y) => x - y);
      return +s[s.length >> 1].toFixed(3);
    };
    for (const [key, list] of Object.entries(samples))
      report.timing[key] = {
        frameGpuMs: median(list.map((m) => m.gpuMs)),
        ssrOwnMs: median(list.map((m) => m.ownerMs.ssr ?? 0)),
        captureMs: median(list.map((m) => m.ownerMs['ssr:capture'] ?? 0)),
        gbufferMs: median(list.map((m) => m.ownerMs['ssr:gbuffer'] ?? 0)),
        traceMs: median(list.map((m) => m.ownerMs['ssr:trace'] ?? 0)),
        sceneMs: median(list.map((m) => m.ownerMs.scene ?? 0)),
        zeroFrames: list.reduce((t, m) => t + m.zeroFrames, 0),
      };
    console.log('timing', JSON.stringify(report.timing, null, 1));
  }
  await page.evaluate(() => window.check.teardown());
  assert.deepEqual(pageErrors, []);
} finally {
  await context.close();
}
report.acPowerAfter = acPower();
assert.equal(report.acPowerAfter, true, 'ended on battery: discard this run');
writeFileSync('examples/package-benchmarks/results/ssr-models-gpu.json', JSON.stringify(report, null, 1) + '\n');
console.log('SSR model capture GPU check passed; wrote examples/package-benchmarks/results/ssr-models-gpu.json');
