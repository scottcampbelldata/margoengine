// The Milky Way and the aurora on the WebGL2 compatibility layer against native WebGPU on the same GPU (one GPU job, run
// from the repository root after building packages): node packages/sky/test/compat-gpu.mjs
// Two parts on each device. First, precision-check.html reads the float32 values inside each entry's own shader and
// checks them against float64: the pixel's solid angle, the aurora's shell distances and its height above the ground.
// Those were the cause of the layer's differences (docs/known-bugs.md, "Milky Way and aurora on the WebGL2 layer"):
// each subtracted two nearly equal numbers, so a one-ULP difference between the two shader compilers came out of
// them hundreds of ULPs wide. Second, each check page draws its entry into Bloom's half-float scene capture and the two
// devices are compared value by value. Measured on an RTX A6000 (2026-11-15): the sky without the entry is identical;
// with it 25 to 153 of 196,608 values differ, by at most two half-float steps. Two steps is the bound for any
// difference at all between the two shader outputs, however small (docs/limits.md, "Sky layers on the WebGL2 layer"):
// the output is cut to half precision toward zero and then added, so two outputs one float32 ULP apart on either side
// of a half float land one half step apart, and the sum's rounding can widen that to two (the blend pair below shows
// it). The compilers may round differently within both specs, so no tighter bound holds.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const pages = { 'milky-way': ['smooth', 'cloudy'], aurora: ['view'] };
// One step of a half float (rgba16float, IEEE 754 binary16: 10 fraction bits) at the size of x.
const step = (x) => 2 ** (Math.max(-14, Math.floor(Math.log2(Math.abs(x) || 2 ** -24))) - 10);
const W = 256,
  H = 192,
  EARTH = 6371.0088,
  bits = new Uint32Array(1),
  float = new Float32Array(bits.buffer);
const f32 = (u) => ((bits[0] = u), float[0]);
const half = (h) =>
  (h & 0x7c00 ? 1 + (h & 0x3ff) / 1024 : (h & 0x3ff) / 1024) * 2 ** (Math.max(1, (h >> 10) & 31) - 15);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
// float64 of what the shaders compute. The pixel's solid angle is the area element of the unit ray's map from NDC,
// |q . (qx x qy)| / |q|^3 for the unnormalised ray q and its partial derivatives, times one pixel's NDC area.
function solidAngle(u, eyeAt, extraAt, nx, ny) {
  const m = (r, c) => u[c * 4 + r],
    p = [0, 1, 2, 3].map((r) => m(r, 0) * nx + m(r, 1) * ny + m(r, 2) * 1e-6 + m(r, 3)),
    s = [0, 1, 2].map((i) => p[i] / p[3]),
    q = s.map((v, i) => v - u[eyeAt + i]),
    qx = [0, 1, 2].map((i) => (m(i, 0) - s[i] * m(3, 0)) / p[3]),
    qy = [0, 1, 2].map((i) => (m(i, 1) - s[i] * m(3, 1)) / p[3]);
  return (Math.abs(dot(q, cross(qx, qy))) / Math.hypot(...q) ** 3) * u[extraAt + 2] * u[extraAt + 3];
}
// The far root of the ray from o along d through the sphere at height s above the ground.
const far = (o, d, s) => {
  const c = [o[0], o[1] + EARTH, o[2]],
    b = dot(c, d);
  return -b + Math.sqrt(b * b - dot(c, c) + (EARTH + s) ** 2);
};
const height = (p) => Math.hypot(p[0], p[1] + EARTH, p[2]) - EARTH;
// Each device's float32 values against float64: the largest relative error of the solid angle and the shell
// distances, and the largest error of the height (km) at the point the shader made (o + d t in float32).
function precision(entry, r) {
  const u = r.uniform,
    [eyeAt, extraAt] = entry === 'milky-way' ? [28, 36] : [16, 44],
    o = [0, 1, 2].map((i) => u[eyeAt + i] / 1000),
    worst = { omega: 0, t0: 0, t1: 0, height: 0, pixels: 0 };
  for (let i = 0; i < W * H; i++) {
    const v = (k) => f32(r.ray[i * 4 + k]);
    if (r.ray[i * 4] === 0) continue;
    worst.pixels++;
    const want = solidAngle(u, eyeAt, extraAt, ((i % W) + 0.5) / (W / 2) - 1, 1 - (Math.floor(i / W) + 0.5) / (H / 2));
    worst.omega = Math.max(worst.omega, Math.abs(v(0) - want) / want);
    if (!r.shell || r.shell[i * 4 + 1] === 0) continue;
    const d = [v(1), v(2), v(3)],
      s = (k) => f32(r.shell[i * 4 + k]),
      at = (t) => o.map((x, c) => Math.fround(x + Math.fround(d[c] * t)));
    worst.t0 = Math.max(worst.t0, Math.abs(s(0) - far(o, d, 80)) / far(o, d, 80));
    worst.t1 = Math.max(worst.t1, Math.abs(s(1) - far(o, d, 450)) / far(o, d, 450));
    worst.height = Math.max(worst.height, Math.abs(s(2) - height(at(s(1)))), Math.abs(s(3) - height(at(s(0)))));
  }
  return worst;
}
async function capture(compat) {
  const context = await openBrowser({ startPath: '/packages/sky/test/milky-way-check.html', port: 'free', compat }),
    { page, hardware } = context,
    errors = [],
    shots = {};
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  try {
    assert.equal(Boolean(hardware.compat), compat, 'the requested device is the one in use');
    const origin = new URL(page.url()).origin;
    for (const [name, keys] of Object.entries(pages))
      for (const samples of [4, 1]) {
        await page.goto(`${origin}/packages/sky/test/${name}-check.html${samples === 1 ? '?samples=1' : ''}`);
        await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
        try {
          const r = await page.evaluate(() => window.check.run());
          assert.equal(r.error, null);
          assert.deepEqual(r.errors, []);
          for (const key of keys)
            shots[`${name} ${samples}x ${key}`] = await page.evaluate(
              (k) => ({ on: Array.from(window.frames[k].on), off: Array.from(window.frames[k].off) }),
              key,
            );
        } finally {
          await page.evaluate(() => window.check.dispose());
        }
      }
    const inside = {};
    for (const entry of ['milky-way', 'aurora']) {
      await page.goto(`${origin}/packages/sky/test/precision-check.html?entry=${entry}`);
      await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
      try {
        const r = await page.evaluate(() => window.check.run());
        assert.equal(r.error, null);
        assert.deepEqual(r.errors, []);
        inside[entry] = r;
      } finally {
        await page.evaluate(() => window.check.dispose());
      }
    }
    assert.deepEqual(errors, []);
    return { shots, inside, adapter: hardware.webgpu?.description ?? hardware.webgpu?.device };
  } finally {
    await context.close();
  }
}

const native = await capture(false),
  layer = await capture(true);
console.log(`native: ${native.adapter}\nlayer: ${layer.adapter}`);
for (const [device, run] of [
  ['native', native],
  ['layer', layer],
])
  for (const entry of ['milky-way', 'aurora']) {
    const w = precision(entry, run.inside[entry]);
    console.log(
      `  ${device} ${entry} shader: solid angle within ${w.omega.toExponential(2)} of float64 over ${w.pixels} pixels` +
        (entry === 'aurora'
          ? `, shell distances ${w.t0.toExponential(2)} and ${w.t1.toExponential(2)}, height ${w.height.toExponential(2)} km`
          : ''),
    );
    // Measured 5.7e-7 at worst (RTX A6000); the difference of the rays through the pixel's edges was 4.3e-5 off.
    assert.ok(w.omega < 2e-6, `${device} ${entry} solid angle ${w.omega} off`);
    if (entry === 'aurora') {
      // Measured 2.2e-7 and 2.2e-7; the root -b + sqrt(b^2 - |c|^2 + r^2) was 8.7e-6 and 1.2e-6 off.
      assert.ok(w.t0 < 1e-6 && w.t1 < 1e-6, `${device} shell distances ${w.t0} and ${w.t1} off`);
      // Measured 6.6e-5 km at 450 km (two float32 ULPs); |p + R up| - R was 5.8e-4 km off.
      assert.ok(w.height < 1.5e-4, `${device} height ${w.height} km off`);
    }
  }
// The scene capture's rounding: the same two outputs give the same half floats on both devices, and one float32 ULP
// between them is at most two half-float steps (two on the A6000: cut toward zero, then a tie in the sum).
const pair = native.inside['milky-way'].blend;
assert.deepEqual(layer.inside['milky-way'].blend, pair, 'both devices round the blend alike');
const apart = Math.abs(half(pair.bits[1]) - half(pair.bits[0])) / step(half(pair.bits[1]));
console.log(
  `  blend: ${pair.inputs.join(' and ')} onto 0.0179901123046875 give ${pair.bits.map(half).join(' and ')} (${apart} half-float steps)`,
);
assert.ok(apart <= 2, `${apart} half-float steps from one float32 ULP`);
for (const [name, pair] of Object.entries(native.shots))
  for (const frame of ['on', 'off']) {
    const a = pair[frame],
      b = layer.shots[name][frame];
    assert.equal(b.length, a.length, name);
    let peak = 0,
      worst = 0,
      differing = 0,
      ulps = 0;
    for (let i = 0; i < a.length; i++) {
      const d = Math.abs(a[i] - b[i]);
      peak = Math.max(peak, Math.abs(a[i]));
      if (d > 0) differing++;
      worst = Math.max(worst, d);
      // No value apart by more than two half-float steps of the larger of the two.
      ulps = Math.max(ulps, d / step(Math.max(Math.abs(a[i]), Math.abs(b[i]))));
      assert.ok(
        d <= 2 * step(Math.max(Math.abs(a[i]), Math.abs(b[i]))),
        `${name} ${frame} value ${i}: ${a[i]} natively, ${b[i]} on the layer`,
      );
    }
    console.log(
      `  ${name} ${frame}: ${differing} of ${a.length} values differ, worst ${worst.toPrecision(3)} (${ulps} half-float steps) of a peak ${peak.toPrecision(3)}`,
    );
  }
console.log('night sky compat check passed: the Milky Way and the aurora match WebGPU within two half-float steps');
