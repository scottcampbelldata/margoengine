// Real-GPU check of @margoengine/post/decals (AC power, GPU lock, after npm run build:packages):
//   node examples/package-benchmarks/decals-gpu.mjs            correctness, 4x and 1x MSAA scenes (no quiet machine needed)
//   node examples/package-benchmarks/decals-gpu.mjs --bench    plus GPU cost (run node scripts/quiet-gate.mjs first; else diagnostic)
// Per pixel (8 px grid) the runner ray-casts the known scene (floor y = 0, unit cube) on the CPU and classifies each hit:
// 1. Footprint: outside every decal box (margin 3 cm) the frame equals the decal-free frame exactly; inside, 'multiply'
//    scales the radiance (inverse of Tonemap 'neutral' + sRGB) by the decal colour: channel ratios within 0.04.
// 2. Normal-angle fade: a decal over the cube's top edge marks the top face and leaves the 90-degree side face untouched;
//    its box ends above the floor, which stays untouched (depth range).
// 3. Atlas: an 'over' decal addressing the red quadrant of an 8 x 8 atlas shows exactly tonemap(0.6, 0, 0) inside.
// 4. Camera inside a decal box: still drawn (back faces, no depth test).
// 5. No Decals equals an empty Decals.
// Writes results/decals-gpu.json and test-results/decals-*.png.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openBrowser } from '../../scripts/browser.js';
import { cpuLoad, waitForQuiet } from '../../scripts/quiet-gate.mjs';
import { decodePNG } from '../../tests/support/png.js';

const bench = process.argv.includes('--bench');
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
// Checks collect their failures so one run reports every one; the run fails at the end.
const problems = [],
  expect = (ok, message) => {
    if (!ok) {
      problems.push(message);
      console.log('FAIL ' + message);
    }
  };
const linear = (byte) => {
  const c = byte / 255;
  return c >= 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92;
};
// Inverse of Tonemap 'neutral' below its compression knee (packages/tonemap/src/shaders.ts): out = in - offset(min(in)).
const unneutral = (rgb) => {
  const y = rgb.map(linear),
    m = Math.min(...y),
    x = m >= 0.04 ? m + 0.04 : Math.sqrt(m / 6.25),
    offset = m >= 0.04 ? 0.04 : x - m;
  return y.map((v) => v + offset);
};
const pixel = (image, [x, y]) => {
  const i = (y * image.width + x) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2]];
};
// CPU scene: floor top y = 0 (40 m square), cube x, z in -0.5..0.5, y in 0..1. Returns {p, n, surface} or null.
function hit(eye, d) {
  let best = null;
  if (d[1] < 0) {
    const t = -eye[1] / d[1],
      p = eye.map((e, i) => e + d[i] * t);
    if (Math.abs(p[0]) < 20 && Math.abs(p[2]) < 20) best = { t, p, n: [0, 1, 0], surface: 'floor' };
  }
  const lo = [-0.5, 0, -0.5],
    hi = [0.5, 1, 0.5];
  let t0 = -Infinity,
    t1 = Infinity,
    axis = -1;
  for (let i = 0; i < 3; i++) {
    const a = (lo[i] - eye[i]) / d[i],
      b = (hi[i] - eye[i]) / d[i],
      near = Math.min(a, b);
    if (near > t0) {
      t0 = near;
      axis = i;
    }
    t1 = Math.min(t1, Math.max(a, b));
  }
  if (t0 > 0 && t0 < t1 && (!best || t0 < best.t)) {
    const n = [0, 0, 0];
    n[axis] = d[axis] > 0 ? -1 : 1;
    best = { t: t0, p: eye.map((e, i) => e + d[i] * t0), n, surface: 'cube' };
  }
  return best;
}
// Local decal coordinates (-1..1 inside), as the shader: right = up x n, up = n x right.
function local(decal, p) {
  const f = decal.direction,
    l = Math.hypot(...f),
    n = f.map((v) => v / l),
    h = decal.up ?? (Math.abs(n[1]) > 0.999 ? [0, 0, 1] : [0, 1, 0]);
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    r0 = cross(h, n),
    rl = Math.hypot(...r0),
    right = r0.map((v) => v / rl),
    up = cross(n, right);
  const q = p.map((v, i) => v - decal.position[i]),
    dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return [
    dot(q, right) / (decal.width / 2),
    dot(q, up) / (decal.height / 2),
    dot(q, n) / ((decal.depth ?? Math.min(decal.width, decal.height)) / 2),
  ];
}
const inside = (decal, p, margin) =>
  local(decal, p).every(
    (v, i) =>
      Math.abs(v) <
      1 - margin / ([decal.width, decal.height, decal.depth ?? Math.min(decal.width, decal.height)][i] / 2),
  );
const outside = (decal, p, margin) =>
  local(decal, p).some(
    (v, i) =>
      Math.abs(v) >
      1 + margin / ([decal.width, decal.height, decal.depth ?? Math.min(decal.width, decal.height)][i] / 2),
  );

const white = [0.5, 0.5, 1, 1]; // the atlas's white quadrant
const A = {
  position: [-1.6, 0, 1.0],
  direction: [0, -1, 0],
  width: 1.2,
  height: 0.8,
  depth: 0.6,
  up: [0, 0, -1],
  color: [1, 0.25, 0.25],
  rect: white,
};
const B = {
  position: [0, 1, 0.3],
  direction: [0, -1, 0],
  width: 1.4,
  height: 1.4,
  depth: 0.6,
  color: [0.25, 0.25, 1],
  rect: white,
};
const C = {
  position: [1.6, 0, 1.0],
  direction: [0, -1, 0],
  width: 0.8,
  height: 0.8,
  depth: 0.6,
  up: [0, 0, -1],
  color: [0.6, 0.6, 0.6],
  mode: 'over',
  rect: [0, 0, 0.5, 0.5],
};
const D = {
  position: [0, 2, 2],
  direction: [0, -1, 0],
  width: 6,
  height: 6,
  depth: 6,
  color: [1, 1, 0.3],
  rect: white,
};

const report = {
  benchmark: 'decals-gpu',
  recordedAt: new Date().toISOString(),
  resolution: [1280, 720],
  powerOnline: { before: powerBefore },
  runs: [],
};
for (const msaa of ['4', '1']) {
  const context = await openBrowser({ startPath: '/LICENSE', port: 5272 }),
    { page, hardware } = context,
    pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text());
  });
  report.hardware = hardware.webgpu;
  report.browser = hardware.browserName + ' ' + hardware.browserVersion;
  let run;
  try {
    await page.goto(`http://127.0.0.1:5272/examples/package-benchmarks/decals.html?msaa=${msaa}`, { timeout: 300000 });
    await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    const samples = await page.evaluate(() => window.check.samples());
    assert.equal(String(samples), msaa);
    const shot = async (name, options) => {
      const r = await page.evaluate((o) => window.check.render(o), options);
      assert.equal(r.error, null, name);
      assert.deepEqual(r.errors, [], name);
      return {
        image: await decodePNG(
          await page.locator('canvas').screenshot({ path: `test-results/decals-${msaa}x-${name}.png` }),
        ),
        eye: r.eye,
      };
    };
    const grid = [];
    for (let y = 4; y < 720; y += 8) for (let x = 4; x < 1280; x += 8) grid.push([x, y]);
    const rays = await page.evaluate((p) => window.check.rays(p), grid);
    const none = await shot('none', { list: null }),
      empty = await shot('empty', { list: [] });
    assert.deepEqual(empty.image.data, none.image.data, 'an empty Decals changed the frame');
    const hits = rays.map((d) => hit(none.eye, d));
    run = { samples, emptyEqualsNone: true };
    const check = (name, image, decals, test) => {
      let untouchedMax = 0,
        untouched = 0,
        tested = 0;
      const failures = [];
      hits.forEach((h, i) => {
        if (!h) return;
        const got = pixel(image, grid[i]),
          base = pixel(none.image, grid[i]);
        if (decals.every((d) => outside(d, h.p, 0.03))) {
          untouched++;
          untouchedMax = Math.max(untouchedMax, ...got.map((g, k) => Math.abs(g - base[k])));
        } else {
          const r = test(h, got, base);
          if (r === undefined) return;
          tested++;
          if (r !== true) failures.push({ pixel: grid[i], surface: h.surface, ...r });
        }
      });
      const row = {
        case: name,
        untouchedSamples: untouched,
        untouchedMaxDiff: untouchedMax,
        testedSamples: tested,
        failures: failures.length,
        firstFailures: failures.slice(0, 3),
      };
      run[name] = row;
      console.log(JSON.stringify({ msaa, ...row }));
      expect(untouchedMax === 0, `${name}: pixels outside the decal boxes changed`);
      expect(tested > 30, `${name}: only ${tested} samples inside`);
      expect(failures.length === 0, `${name}: ${JSON.stringify(failures.slice(0, 3))}`);
    };
    const ratio = (decal, margin) => (h, got, base) => {
      const l = local(decal, h.p);
      if (!inside(decal, h.p, margin) || h.n[1] < 0.99 || Math.abs(l[0]) > 0.7 || Math.abs(l[1]) > 0.7)
        return undefined; // bilinear stays inside the quadrant
      const a = unneutral(got),
        b = unneutral(base),
        r = a.map((v, k) => v / b[k]);
      return r.every((v, k) => Math.abs(v - decal.color[k]) < 0.04) || { ratio: r.map((v) => +v.toFixed(3)) };
    };
    check('multiply-floor', (await shot('multiply', { list: [A] })).image, [A], ratio(A, 0.03));
    // Angle fade: the cube's side faces inside B's box are untouched; its top face is scaled.
    const b = (await shot('angle', { list: [B] })).image;
    let side = 0,
      sideMax = 0;
    hits.forEach((h, i) => {
      if (h?.surface === 'cube' && h.n[1] === 0 && inside(B, h.p, 0.03)) {
        side++;
        sideMax = Math.max(sideMax, ...pixel(b, grid[i]).map((g, k) => Math.abs(g - pixel(none.image, grid[i])[k])));
      }
    });
    run.angleSideFace = { samples: side, maxDiff: sideMax };
    console.log(JSON.stringify({ msaa, angleSideFace: run.angleSideFace }));
    expect(side > 20, 'side-face samples');
    expect(sideMax === 0, 'a 90-degree face received the decal');
    check('angle-top', b, [B], (h, got, base) =>
      h.n[1] === 1 && h.p[1] === 1 ? ratio(B, 0.03)(h, got, base) : h.n[1] === 0 ? undefined : true,
    );
    // Atlas 'over': exact tonemap(0.6, 0, 0) = sRGB (203, 0, 0) where the bilinear sample stays inside the red quadrant.
    check('atlas-over', (await shot('atlas', { list: [C] })).image, [C], (h, got) => {
      const l = local(C, h.p);
      if (Math.abs(l[0]) > 0.7 || Math.abs(l[1]) > 0.7) return undefined;
      return (Math.abs(got[0] - 203) <= 1 && got[1] <= 1 && got[2] <= 1) || { got };
    });
    check('camera-inside', (await shot('inside', { list: [D] })).image, [D], (h, got, base) =>
      h.surface === 'floor' && (Math.abs(h.p[0]) > 0.55 || Math.abs(h.p[2]) > 0.55)
        ? ratio(D, 0.05)(h, got, base)
        : undefined,
    ); // floor pixels clear of the cube's silhouette
    run.cameraInsideBox = local(D, none.eye).every((v) => Math.abs(v) < 1);
    expect(run.cameraInsideBox, 'camera inside the box');
    if (bench && msaa === '4') {
      // Timings count only after the quiet gate (AC, CPU <= 20% for 20 s, waited up to 3 min); otherwise they are diagnostic.
      try {
        report.quietGate = await waitForQuiet({ timeout: 180 });
      } catch (error) {
        report.quietGate = { passed: false, timingsAreDiagnostic: true, reason: error.message };
      }
      report.cpuLoadAtStart = cpuLoad();
      report.timings = [];
      for (const [width, height] of [
        [1280, 720],
        [1920, 1080],
      ])
        for (const count of [null, 1, 16, 256]) {
          const row = await page.evaluate((o) => window.check.bench(o), { count, size: 1, width, height });
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
  report.runs.push(run);
}
report.powerOnline.after = ac();
assert.equal(report.powerOnline.after, 'True', 'still on AC power');
assert.deepEqual(problems, [], 'decal checks failed');
await writeFile(resolve(import.meta.dirname, 'results/decals-gpu.json'), JSON.stringify(report, null, 2) + '\n');
console.log('decals GPU check passed');
