// Real-GPU check of @margoengine/environment/probes (AC power, GPU lock, after npm run build:packages):
//   node examples/package-benchmarks/probes-gpu.mjs            correctness (no quiet machine needed)
//   node examples/package-benchmarks/probes-gpu.mjs --bench    plus bake time and per-frame cost (quiet-gate first; else diagnostic)
// Room scene (probes.html?scene=room): six walls each radiating exactly its linear colour (ambient 1, sun off).
// 1. Irradiance volume: each probe's 9 SH coefficients (read back) vs a CPU projection of the analytic room radiance
//    (6 x 256^2 cube samples), error relative to the probe's DC term.
// 2. Reflection probe: octahedral level 0 vs the analytic radiance per texel; levels 1-5 vs a CPU GGX convolution of the
//    analytic radiance at the level's roughness (the bake's n = v = r prefilter).
// 3. Shading, from the read-back texels through a CPU mirror of the WGSL (trilinear SH, box projection, trilinear octahedral
//    levels, analytic split-sum) and each path's tone map: a white core sphere and a white materials sphere (gltf-pro hook),
//    a mirror metal floor and a rough (0.5) metal floor, within 3/255 (mirror: 95th percentile; its sharp level 0 flips a texel
//    at a wall-colour boundary for a sub-pixel shift between the CPU ray and the raster, so the maximum is only reported).
// 4. Box projection is physical: on the mirror floor each pixel shows the wall its reflected ray hits (the probe box is the
//    room, at bake-time wall radiance), 95th percentile within 3/255, for wall points 0.4 m or more from a wall edge.
// 5. Zero cost: an attached, unbaked LightProbes leaves core meshes bit-identical and gltf-pro within 1/255.
// 6. SSR (post/ssr) over the probes on the mirror floor, two views: where the mirrored wall is on screen the floor shows it as
//    rendered now (the probe specular was replaced, not added: the probe holds the bake-time radiance, which differs);
//    where it is off screen the floor keeps the probe reflection (equal to the frame without SSR).
// Environment scene (?scene=env, no walls): the volume's SH equals the Environment's own SH, and spheres lit by
// LightProbes({environment}) match EnvironmentLighting.
// Writes results/probes-gpu.json and test-results/probes-*.png.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openBrowser } from '../../scripts/browser.js';
import { cpuLoad, waitForQuiet } from '../../scripts/quiet-gate.mjs';
import { decodePNG } from '../../tests/support/png.js';
import { halfToFloat, shBasis, SH_IRRADIANCE_BANDS } from '../../packages/environment/dist/index.js';

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
const failures = [],
  expect = (ok, message) => {
    if (!ok) {
      failures.push(message);
      console.log('FAIL ' + message);
    }
  };
const srgb = (c) =>
  Math.round(255 * Math.min(1, Math.max(0, c >= 0.0031308 ? 1.055 * c ** (1 / 2.4) - 0.055 : c * 12.92)));
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
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  norm = (a) => {
    const l = Math.hypot(...a);
    return a.map((v) => v / l);
  };
const room = { min: [-2, 0, -2], max: [2, 3, 2] };
const wallAt = (p, d) => {
  let t = Infinity,
    wall = '';
  for (let i = 0; i < 3; i++) {
    if (!d[i]) continue;
    const ti = ((d[i] > 0 ? room.max[i] : room.min[i]) - p[i]) / d[i];
    if (ti < t) {
      t = ti;
      wall = (d[i] > 0 ? 'p' : 'n') + 'xyz'[i];
    }
  }
  return { t, wall, hit: p.map((v, i) => v + d[i] * t) };
};
// Cube-face sampling shared with the bake: forward, up (right = forward x up).
const FACES = [
  [
    [1, 0, 0],
    [0, 1, 0],
  ],
  [
    [-1, 0, 0],
    [0, 1, 0],
  ],
  [
    [0, 1, 0],
    [0, 0, -1],
  ],
  [
    [0, -1, 0],
    [0, 0, 1],
  ],
  [
    [0, 0, 1],
    [0, 1, 0],
  ],
  [
    [0, 0, -1],
    [0, 1, 0],
  ],
];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function* sphereSamples(n) {
  for (const [f, u] of FACES) {
    const r = cross(f, u);
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const a = ((x + 0.5) / n) * 2 - 1,
          b = 1 - ((y + 0.5) / n) * 2;
        yield { d: norm(f.map((v, i) => v + a * r[i] + b * u[i])), w: (1 + a * a + b * b) ** -1.5 };
      }
  }
}
const octDecode = (u, v) => {
  const f = [u * 2 - 1, v * 2 - 1],
    n = [f[0], 1 - Math.abs(f[0]) - Math.abs(f[1]), f[1]],
    t = Math.max(-n[1], 0);
  n[0] += n[0] >= 0 ? -t : t;
  n[2] += n[2] >= 0 ? -t : t;
  return norm(n);
};
const octEncode = (d) => {
  const s = Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2]),
    a = d.map((v) => v / s);
  let q = [a[0], a[2]];
  if (a[1] < 0) q = [(1 - Math.abs(a[2])) * (a[0] >= 0 ? 1 : -1), (1 - Math.abs(a[0])) * (a[2] >= 0 ? 1 : -1)];
  return q.map((v) => v * 0.5 + 0.5);
};
const texel = (t, i) => [
  halfToFloat(t[i * 2] & 0xffff),
  halfToFloat(t[i * 2] >>> 16),
  halfToFloat(t[i * 2 + 1] & 0xffff),
];
// Volume probe SH (L2): 27 float16 values (coefficient j, channel c at 3j + c) in the probe's 16 words.
const halfAt = (t, w, h) => halfToFloat(h & 1 ? t[w + (h >> 1)] >>> 16 : t[w + (h >> 1)] & 0xffff);
const shOf = (t, probe) => Array.from({ length: 9 }, (_, j) => [0, 1, 2].map((c) => halfAt(t, probe * 16, j * 3 + c)));
// CPU mirrors of the WGSL in packages/environment/src/probes.ts.
const mirror = (bake, R = 128) => {
  const levels = Math.log2(R) - 1,
    t = bake.texels;
  const level = (o, s, uv) => {
    const st = uv.map((v) => Math.min(s - 1, Math.max(0, v * s - 0.5))),
      i = st.map(Math.floor),
      j = i.map((v) => Math.min(v + 1, s - 1)),
      f = st.map((v, k) => v - i[k]);
    const at = (x, y) => texel(t, o + y * s + x),
      mix = (a, b, w) => a.map((v, k) => v + (b[k] - v) * w);
    return mix(mix(at(i[0], i[1]), at(j[0], i[1]), f[0]), mix(at(i[0], j[1]), at(j[0], j[1]), f[0]), f[1]);
  };
  const radiance = (d, rough) => {
    const lod = Math.min(1, Math.max(0, rough)) * (levels - 1),
      k0 = Math.floor(lod),
      k1 = Math.min(k0 + 1, levels - 1);
    let o0 = bake.offset;
    for (let j = 0; j < k0; j++) o0 += (R >> j) ** 2;
    const s0 = R >> k0,
      uv = octEncode(d),
      a = level(o0, s0, uv),
      b = level(k1 === k0 ? o0 : o0 + s0 * s0, R >> k1, uv);
    return a.map((v, k) => v + (b[k] - v) * (lod - k0));
  };
  const irradiance = (p, n) => {
    const counts = [2, 2, 2],
      g = p.map((v, i) =>
        Math.min(counts[i] - 1, Math.max(0, ((v - room.min[i]) / (room.max[i] - room.min[i])) * counts[i] - 0.5)),
      ),
      i0 = g.map(Math.floor),
      f = g.map((v, i) => v - i0[i]);
    const basis = shBasis(...n),
      sum = [0, 0, 0];
    for (let c = 0; c < 8; c++) {
      const corner = [0, 1, 2].map((a) => Math.min(i0[a] + ((c >> a) & 1), counts[a] - 1)),
        w = [0, 1, 2].reduce((m, a) => m * ((c >> a) & 1 ? f[a] : 1 - f[a]), 1);
      const sh = shOf(t, corner[0] + 2 * (corner[1] + 2 * corner[2]));
      for (let k = 0; k < 9; k++) for (let ch = 0; ch < 3; ch++) sum[ch] += w * sh[k][ch] * basis[k];
    }
    return sum.map((v) => Math.max(0, v));
  };
  const shade = (p, n, v, base, metal, rough) => {
    const nv = Math.min(1, Math.max(1e-4, dot(n, v))),
      f0 = base.map((b) => 0.04 + (b - 0.04) * metal),
      r = n.map((x, i) => 2 * dot(n, v) * x - v[i]);
    const c = [-1, -0.0275, -0.572, 0.022].map((x, i) => rough * x + [1, 0.0425, 1.04, -0.04][i]),
      a = Math.min(c[0] * c[0], 2 ** (-9.28 * nv)) * c[0] + c[1],
      sw = f0.map((x) => x * (c[2] - 1.04 * a) + (c[3] + 1.04 * a));
    const e = irradiance(p, n),
      q = r.map((x) => (Math.abs(x) < 1e-6 ? x + 1e-6 : x)),
      t3 = q.map((x, i) => ((x > 0 ? room.max[i] : room.min[i]) - p[i]) / x),
      tt = Math.max(Math.min(...t3), 0);
    const d = p.map((x, i) => x + r[i] * tt - [0, 1.5, 0][i]),
      s = radiance(dot(d, d) > 1e-12 ? norm(d) : r, rough);
    return base.map((b, k) => (1 - sw[k]) * (1 - metal) * b * e[k] + s[k] * sw[k]);
  };
  return { radiance, irradiance, shade, levels };
};

async function open(scene) {
  const context = await openBrowser({ startPath: '/LICENSE', port: 5273 }),
    { page } = context,
    pageErrors = [];
  await page.goto(`http://127.0.0.1:5273/examples/package-benchmarks/probes.html?scene=${scene}`, { timeout: 300000 });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text());
  });
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const shot = async (name, options) => {
    const r = await page.evaluate((o) => window.check.render(o), options);
    assert.equal(r.error, null, name);
    assert.deepEqual(r.errors, [], name);
    return {
      image: await decodePNG(await page.locator('canvas').screenshot({ path: `test-results/probes-${name}.png` })),
      eye: r.eye,
    };
  };
  const bake = async (options) => {
    const b = await page.evaluate((o) => window.check.bake(o), options);
    assert.equal(b.error, null);
    assert.deepEqual(b.errors, []);
    return b;
  };
  return { context, page, shot, bake, pageErrors };
}
const report = {
  benchmark: 'probes-gpu',
  recordedAt: new Date().toISOString(),
  resolution: [1280, 720],
  powerOnline: { before: powerBefore },
};
{
  const { context, page, shot, bake, pageErrors } = await open('room');
  report.hardware = await page.evaluate(() => navigator.userAgent);
  try {
    const none = await shot('none', { lighting: 'none' }),
      unbaked = await shot('unbaked', { lighting: 'unbaked' });
    const b = await bake({}),
      m = mirror(b),
      colors = b.walls;
    report.bakeMsDiagnostic = b.bakeMs;
    // 1. Volume SH vs the analytic room.
    report.volume = [];
    for (let probe = 0; probe < 8; probe++) {
      const c = [probe & 1, (probe >> 1) & 1, probe >> 2],
        p = c.map((v, i) => room.min[i] + ((v + 0.5) * (room.max[i] - room.min[i])) / 2),
        ref = Array.from({ length: 9 }, () => [0, 0, 0]);
      let total = 0;
      for (const { d, w } of sphereSamples(256)) {
        const L = colors[wallAt(p, d).wall],
          y = shBasis(...d);
        total += w;
        for (let k = 0; k < 9; k++) for (let ch = 0; ch < 3; ch++) ref[k][ch] += L[ch] * y[k] * w;
      }
      const scale = (4 * Math.PI) / total;
      ref.forEach((v, k) =>
        v.forEach((x, ch) => {
          v[ch] = x * scale * SH_IRRADIANCE_BANDS[k];
        }),
      );
      const gpu = shOf(b.texels, probe),
        dc = Math.max(...ref[0]),
        err = Math.max(...gpu.flatMap((v, k) => v.map((x, ch) => Math.abs(x - ref[k][ch])))) / dc;
      report.volume.push({ probe: p, maxCoefficientErrorOfDC: +err.toFixed(4) });
    }
    console.log(JSON.stringify({ volume: report.volume }));
    expect(
      report.volume.every((r) => r.maxCoefficientErrorOfDC < 0.02),
      'volume SH within 2% of DC',
    );
    // 2. Reflection probe levels vs the analytic room (level 0) and a CPU GGX convolution of it (levels 1+).
    const P = [0, 1.5, 0],
      R = 128,
      analytic = (d) => colors[wallAt(P, d).wall],
      fine = [...sphereSamples(96)].map((s) => ({ ...s, L: analytic(s.d) }));
    report.reflection = [];
    for (let level = 0, offset = b.offset; level < m.levels; offset += (R >> level) ** 2, level++) {
      const s = R >> level,
        rough = level / (m.levels - 1),
        a2 = rough ** 4,
        step = level === 0 ? 1 : level === 1 ? 4 : level === 2 ? 2 : 1,
        errors = [];
      for (let y = 0; y < s; y += step)
        for (let x = 0; x < s; x += step) {
          const n = octDecode((x + 0.5) / s, (y + 0.5) / s),
            gpu = texel(b.texels, offset + y * s + x);
          let ref;
          if (level === 0) ref = analytic(n);
          else {
            const sum = [0, 0, 0, 0];
            for (const { d, w, L } of fine) {
              const nl = dot(n, d);
              if (nl <= 0) continue;
              const nh = dot(n, norm(n.map((v, i) => v + d[i]))),
                q = nh * nh * (a2 - 1) + 1,
                wt = (a2 / (q * q)) * nl * w;
              for (let ch = 0; ch < 3; ch++) sum[ch] += L[ch] * wt;
              sum[3] += wt;
            }
            ref = sum.slice(0, 3).map((v) => v / sum[3]);
          }
          errors.push(Math.max(...gpu.map((v, ch) => Math.abs(v - ref[ch]))));
        }
      errors.sort((p, q) => p - q);
      const row = {
        level,
        size: s,
        roughness: +rough.toFixed(2),
        samples: errors.length,
        medianAbsError: +errors[errors.length >> 1].toFixed(4),
        p95AbsError: +errors[Math.floor(errors.length * 0.95)].toFixed(4),
        maxAbsError: +errors.at(-1).toFixed(4),
      };
      report.reflection.push(row);
      console.log(JSON.stringify(row));
    }
    expect(
      report.reflection[0].medianAbsError < 0.005 && report.reflection[0].p95AbsError < 0.05,
      'level 0 resamples the capture',
    );
    expect(
      report.reflection.slice(1).every((r) => r.p95AbsError < 0.01 && r.maxAbsError < 0.05),
      'prefiltered levels: p95 within 0.01, max within 0.05 of the CPU GGX convolution',
    );
    // 3 + 4. Shading through the CPU mirror, and the mirror floor against the physical box projection.
    const grid = [];
    for (let y = 4; y < 720; y += 6) for (let x = 4; x < 1280; x += 6) grid.push([x, y]);
    const rays = await page.evaluate((p) => window.check.rays(p), grid),
      spheres = await page.evaluate(() => window.check.spheres());
    report.shading = [];
    for (const floor of ['diffuse', 'mirror', 'rough']) {
      const { image, eye } = await shot(`room-${floor}`, { floor, lighting: 'probes' });
      const mirrorDiffs = [],
        wallDiffs = [],
        worstPixels = [];
      let samples = 0,
        nearEdges = 0;
      rays.forEach((d, i) => {
        const hits = [];
        for (const kind of ['core', 'materials']) {
          const c = spheres[kind],
            o = eye.map((v, k) => v - c[k]),
            bq = dot(o, d),
            cq = dot(o, o) - spheres.radius ** 2,
            disc = bq * bq - cq;
          if (disc > 0) {
            const t = -bq - Math.sqrt(disc);
            if (t > 0)
              hits.push({
                kind,
                t,
                p: eye.map((v, k) => v + d[k] * t),
                n: norm(eye.map((v, k) => v + d[k] * t - c[k])),
              });
          }
        }
        if (d[1] < 0) {
          const t = -eye[1] / d[1];
          hits.push({ kind: 'floor', t, p: eye.map((v, k) => v + d[k] * t), n: [0, 1, 0] });
        }
        const h = hits.sort((a, q) => a.t - q.t)[0];
        if (!h) return;
        const v = d.map((x) => -x);
        if (dot(h.n, v) < 0.25) return;
        if (h.kind === 'floor' && (floor === 'diffuse' || h.p.some((x, k) => k !== 1 && Math.abs(x) > 1.9))) return;
        const metal = h.kind === 'floor' ? 1 : 0,
          rough = h.kind === 'floor' ? (floor === 'mirror' ? 0 : 0.5) : 1;
        const rgb = m.shade(h.p, h.n, v, [1, 1, 1], metal, h.kind === 'materials' ? Math.max(rough, 0.045) : rough),
          want = output[h.kind === 'materials' ? 'materials' : 'core'](rgb),
          got = pixel(image, grid[i]);
        // The mirror shows level 0 sharply: reflections of wall points within 0.4 m of a wall edge (2-3 octahedral texels
        // seen from the probe) cross a colour boundary that bilinear filtering steps across; those pixels are counted apart.
        const { wall, hit } = h.kind === 'floor' ? wallAt(h.p, [d[0], -d[1], d[2]]) : {},
          edge = hit
            ? hit.map((x, k) => Math.min(Math.abs(x - room.min[k]), Math.abs(x - room.max[k]))).sort((a, q) => a - q)[1]
            : Infinity;
        if (floor === 'mirror' && h.kind === 'floor' && edge < 0.4) {
          nearEdges++;
          return;
        }
        const diff = Math.max(...got.map((g, k) => Math.abs(g - want[k])));
        mirrorDiffs.push(diff);
        samples++;
        if (diff > 3 && worstPixels.length < 5) worstPixels.push({ pixel: grid[i], kind: h.kind, got, want });
        if (h.kind === 'floor' && floor === 'mirror') {
          const truth = output.core(colors[wall]);
          wallDiffs.push(Math.max(...got.map((g, k) => Math.abs(g - truth[k]))));
        }
      });
      // A sub-pixel difference between the CPU ray and the rasterised position flips a sharp level-0 texel at a colour
      // boundary: the mirror is judged by the 95th percentile, the maximum is reported.
      const stats = (a) => {
        a.sort((p, q) => p - q);
        return {
          median: a[a.length >> 1],
          p95: a[Math.floor(a.length * 0.95)],
          p99: a[Math.floor(a.length * 0.99)],
          max: a.at(-1),
        };
      };
      const row = {
        floor,
        samples,
        diffVsCpuMirror: stats(mirrorDiffs),
        ...(floor === 'mirror'
          ? {
              boxProjectionSamples: wallDiffs.length,
              diffVsWallSeenInMirror: stats(wallDiffs),
              skippedNearWallEdges: nearEdges,
            }
          : {}),
        worstPixels,
      };
      report.shading.push(row);
      console.log(JSON.stringify(row));
      const limit = floor === 'mirror' ? row.diffVsCpuMirror.p95 : row.diffVsCpuMirror.max;
      expect(samples > 200 && limit <= 3, `${floor}: GPU differs from the CPU mirror by ${limit}/255`);
      if (floor === 'mirror')
        expect(
          wallDiffs.length > 200 && row.diffVsWallSeenInMirror.p95 <= 3,
          `mirror floor vs walls: p95 ${row.diffVsWallSeenInMirror.p95}/255`,
        );
    }
    // 6. SSR over the probes on the mirror floor, from the default view and from a steep one looking down (where most
    // mirrored wall points are above the screen). Hits (the mirrored wall point on screen, 8 px in): the floor is never
    // brighter than both the wall as rendered now and the probe reflection (adding instead of replacing would exceed
    // both), and mostly equals the wall. Misses (the point 20 px or more off screen, or behind the camera): the floor
    // equals the frame without SSR, i.e. the probe reflection is what SSR falls back to.
    {
      const added = [],
        hitDiffs = [],
        misses = [];
      for (const camera of [
        [
          [0, 1.6, 1.7],
          [0, 1.1, -1],
        ],
        [
          [0, 2.7, 1.6],
          [0, 0, -0.6],
        ],
      ]) {
        const probeOnly = (await shot('room-mirror', { floor: 'mirror', camera })).image,
          { image, eye } = await shot('room-mirror-ssr', { floor: 'mirror', ssr: true, camera });
        const view = await page.evaluate((p) => window.check.rays(p), grid),
          floorPixels = [];
        view.forEach((d, i) => {
          if (d[1] >= 0) return;
          const t = -eye[1] / d[1],
            p = eye.map((v, k) => v + d[k] * t);
          if (
            Math.abs(p[0]) > 1.9 ||
            Math.abs(p[2]) > 1.9 ||
            [spheres.core, spheres.materials].some((c) => Math.hypot(p[0] - c[0], p[2] - c[2]) < 0.6)
          )
            return;
          const { hit } = wallAt(p, [d[0], -d[1], d[2]]),
            edge = hit
              .map((x, k) => Math.min(Math.abs(x - room.min[k]), Math.abs(x - room.max[k])))
              .sort((a, q) => a - q)[1];
          // Skip wall points near an edge and those hidden behind a sphere from the camera (the screen shows the sphere there).
          const hidden = [spheres.core, spheres.materials].some((c) => {
            const dir = norm(hit.map((x, k) => x - eye[k])),
              o = eye.map((x, k) => x - c[k]),
              b = dot(o, dir),
              q = b * b - dot(o, o) + (spheres.radius + 0.05) ** 2;
            return q > 0 && -b - Math.sqrt(q) > 0;
          });
          if (edge > 0.15 && !hidden) floorPixels.push({ i, hit });
        });
        const projected = await page.evaluate(
          (p) => window.check.project(p),
          floorPixels.map((f) => f.hit),
        );
        floorPixels.forEach(({ i }, k) => {
          const [x, y, w] = projected[k],
            got = pixel(image, grid[i]),
            before = pixel(probeOnly, grid[i]);
          if (w > 0 && x >= 8 && y >= 8 && x < 1272 && y < 712) {
            const wall = pixel(image, [Math.round(x), Math.round(y)]);
            added.push(Math.max(...got.map((g, c) => g - Math.max(wall[c], before[c]))));
            hitDiffs.push(Math.max(...got.map((g, c) => Math.abs(g - wall[c]))));
          } else if (w <= 0 || x < -20 || y < -20 || x > 1300 || y > 740)
            misses.push(Math.max(...got.map((g, c) => Math.abs(g - before[c]))));
        });
      }
      const stats = (a) => {
        a.sort((p, q) => p - q);
        return {
          samples: a.length,
          median: a[a.length >> 1],
          p95: a[Math.floor(a.length * 0.95)],
          p99: a[Math.floor(a.length * 0.99)],
          max: a.at(-1),
        };
      };
      report.ssr = {
        hitsAboveWallAndProbe: stats(added),
        hitsVsWallOnScreen: stats(hitDiffs),
        missesVsProbesAlone: stats(misses),
      };
      console.log(JSON.stringify({ ssr: report.ssr }));
      expect(
        added.length > 200 && report.ssr.hitsAboveWallAndProbe.p99 <= 3 && report.ssr.hitsVsWallOnScreen.median <= 3,
        'SSR over probes: on-screen hits replace the probe specular (never added)',
      );
      expect(
        misses.length > 50 && report.ssr.missesVsProbesAlone.p95 <= 2,
        'SSR over probes: off-screen reflections keep the probe',
      );
      await shot('room-after-ssr', { floor: 'diffuse', ssr: false });
    }
    // 5. Zero cost: unbaked probes leave core meshes bit-identical (fallback = core's own ambient); gltf-pro within 1/255.
    let coreDiff = 0,
      modelDiff = 0;
    rays.forEach((d, i) => {
      const o = spheres.materials,
        oc = none.eye.map((v, k) => v - o[k]),
        bq = dot(oc, d),
        disc = bq * bq - dot(oc, oc) + (spheres.radius + 0.02) ** 2,
        diff = Math.max(...pixel(unbaked.image, grid[i]).map((g, k) => Math.abs(g - pixel(none.image, grid[i])[k])));
      if (disc > 0) modelDiff = Math.max(modelDiff, diff);
      else coreDiff = Math.max(coreDiff, diff);
    });
    report.unbaked = { coreMaxDiff: coreDiff, gltfProMaxDiff: modelDiff };
    console.log(JSON.stringify(report.unbaked));
    expect(coreDiff === 0, `unbaked core diff ${coreDiff}`);
    expect(modelDiff <= 1, `unbaked gltf-pro diff ${modelDiff}`);
    if (bench) {
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
        for (const [on, variant] of [
          [false],
          [true, 'both'],
          [true, 'volume'],
          [true, 'reflection'],
          [false],
          [true, 'both'],
        ]) {
          const row = await page.evaluate((o) => window.check.bench(o), { on, variant, width, height });
          assert.deepEqual(row.errors, []);
          delete row.errors;
          report.timings.push(row);
          console.log(JSON.stringify(row));
        }
      // Bake time for 32 volume probes (16 px) + one 128 px reflection probe, wall clock in the page (CPU encode + GPU).
      report.bakeTimings = [];
      for (let i = 0; i < 3; i++) report.bakeTimings.push((await bake({})).bakeMs);
    }
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
}
{
  const { context, page, shot, bake, pageErrors } = await open('env');
  try {
    const b = await bake({ reflection: false, volumeResolution: 64 });
    const envSH = Array.from({ length: 9 }, (_, k) => [0, 1, 2].map((ch) => b.envSH[k * 3 + ch])),
      dc = Math.max(...envSH[0]);
    report.environmentVolume = [];
    for (let probe = 0; probe < 8; probe++) {
      const gpu = shOf(b.texels, probe);
      report.environmentVolume.push(
        +(Math.max(...gpu.flatMap((v, k) => v.map((x, ch) => Math.abs(x - envSH[k][ch])))) / dc).toFixed(4),
      );
    }
    console.log(JSON.stringify({ environmentVolumeMaxErrorOfDC: report.environmentVolume }));
    expect(
      report.environmentVolume.every((e) => e < 0.02),
      'empty-scene probes equal the environment SH within 2% of DC',
    );
    const probes = (await shot('env-probes', { lighting: 'probes' })).image,
      lit = (await shot('env-lighting', { lighting: 'environment' })).image;
    let diff = 0,
      lit2 = 0;
    for (let i = 0; i < probes.data.length; i++)
      if (i % 4 !== 3) {
        const d = Math.abs(probes.data[i] - lit.data[i]);
        diff = Math.max(diff, d);
        if (lit.data[i] > 20) lit2++;
      }
    report.environmentEquivalence = { maxDiffVsEnvironmentLighting: diff };
    console.log(JSON.stringify(report.environmentEquivalence));
    expect(lit2 > 1000 && diff <= 3, `LightProbes(environment) vs EnvironmentLighting: ${diff}/255`);
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
}
report.powerOnline.after = ac();
assert.equal(report.powerOnline.after, 'True', 'still on AC power');
assert.deepEqual(failures, [], 'probe checks failed');
await writeFile(resolve(import.meta.dirname, 'results/probes-gpu.json'), JSON.stringify(report, null, 2) + '\n');
console.log('probes GPU check passed');
