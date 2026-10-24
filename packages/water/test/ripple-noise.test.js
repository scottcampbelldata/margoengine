import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const code = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
// JS twin of the WGSL ripple noise (PCG corner angles, Perlin 2002 quintic fade, analytic gradient), in f64.
const pcg = (v) => {
  const s = (Math.imul(v, 747796405) + 2891336453) >>> 0;
  const w = Math.imul((s >>> ((s >>> 28) + 4)) ^ s, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
};
const gradient = (x, y) => {
  const angle = (pcg(((x >>> 0) + pcg(y >>> 0)) >>> 0) >>> 8) * ((2 * Math.PI) / 16777216);
  return [Math.cos(angle), Math.sin(angle)];
};
const fade = (t) => t * t * t * (10 + t * (6 * t - 15)),
  slope = (t) => 30 * t * t * (1 - t) * (1 - t);
function noise(px, py) {
  const cx = Math.floor(px),
    cy = Math.floor(py),
    fx = px - cx,
    fy = py - cy;
  const g00 = gradient(cx, cy),
    g10 = gradient(cx + 1, cy),
    g01 = gradient(cx, cy + 1),
    g11 = gradient(cx + 1, cy + 1);
  const r00 = g00[0] * fx + g00[1] * fy,
    r10 = g10[0] * (fx - 1) + g10[1] * fy,
    r01 = g01[0] * fx + g01[1] * (fy - 1),
    r11 = g11[0] * (fx - 1) + g11[1] * (fy - 1);
  const qx = fade(fx),
    qy = fade(fy),
    dx = slope(fx),
    dy = slope(fy);
  const mix = (a, b, t) => a + (b - a) * t;
  const low = mix(r00, r10, qx),
    high = mix(r01, r11, qx);
  const dlow = [mix(g00[0], g10[0], qx) + dx * (r10 - r00), mix(g00[1], g10[1], qx)],
    dhigh = [mix(g01[0], g11[0], qx) + dx * (r11 - r01), mix(g01[1], g11[1], qx)];
  return [mix(low, high, qy), mix(dlow[0], dhigh[0], qy), mix(dlow[1], dhigh[1], qy) + dy * (high - low)];
}
let state = 0x2545f491;
const random = () => {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return (state >>> 0) / 4294967296;
};

test('the shader holds the PCG-angle gradient noise the twin models', () => {
  assert.match(code, /fn ripplePcg\(v:u32\)->u32 \{let s=v\*747796405u\+2891336453u;/);
  assert.match(
    code,
    /let angle=f32\(ripplePcg\(c\.x\+ripplePcg\(c\.y\)\)>>8u\)\*3\.7450703e-7;return vec2f\(cos\(angle\),sin\(angle\)\);/,
  );
  assert.match(code, /let q=f\*f\*f\*\(10\.0\+f\*\(6\.0\*f-15\.0\)\);let dq=30\.0\*f\*f\*\(1\.0-f\)\*\(1\.0-f\);/);
  assert.equal(code.match(/fn noise\(p:vec2f\)->vec3f/g)?.length, 1);
  assert.doesNotMatch(code, /fract\(sin|43758/);
});

test('ripple noise statistics match the binding targets (mean 0, std 0.216, RMS slope 0.625, |v| < 0.71)', () => {
  const n = 400000;
  let sum = 0,
    squares = 0,
    sx = 0,
    sy = 0,
    extreme = 0;
  for (let i = 0; i < n; i++) {
    const [v, gx, gy] = noise(random() * 2000 - 1000, random() * 2000 - 1000);
    sum += v;
    squares += v * v;
    sx += gx * gx;
    sy += gy * gy;
    extreme = Math.max(extreme, Math.abs(v));
  }
  const mean = sum / n,
    std = Math.sqrt(squares / n - mean * mean);
  assert.ok(Math.abs(mean) < 0.01, `mean ${mean}`);
  assert.ok(Math.abs(std - 0.2157) < 0.02, `std ${std}`);
  assert.ok(Math.abs(Math.sqrt(sx / n) - 0.625) < 0.05, `rms slope x ${Math.sqrt(sx / n)}`);
  assert.ok(Math.abs(Math.sqrt(sy / n) - 0.625) < 0.05, `rms slope y ${Math.sqrt(sy / n)}`);
  assert.ok(extreme <= Math.SQRT1_2 + 1e-9, `max |v| ${extreme}`);
});

test('ripple noise is zero on the lattice and its derivatives match central differences', () => {
  for (let x = -6; x <= 6; x++) for (let y = -6; y <= 6; y++) assert.ok(Math.abs(noise(x, y)[0]) < 1e-12);
  // The GPU probe's point and step (coast.browser.mjs): h = 0.01 within 0.001.
  const fd = (x, y, h) => [
    (noise(x + h, y)[0] - noise(x - h, y)[0]) / (2 * h),
    (noise(x, y + h)[0] - noise(x, y - h)[0]) / (2 * h),
  ];
  const [, px, py] = noise(1.31, -2.46),
    [qx, qy] = fd(1.31, -2.46, 0.01);
  assert.ok(Math.abs(px - qx) < 0.001 && Math.abs(py - qy) < 0.001, 'probe point');
  // Everywhere else the analytic gradient is exact: a fine step agrees to the step's own error.
  for (let i = 0; i < 2000; i++) {
    const x = random() * 200 - 100,
      y = random() * 200 - 100;
    const [, gx, gy] = noise(x, y),
      [fx, fy] = fd(x, y, 1e-5);
    assert.ok(Math.abs(gx - fx) < 1e-5 && Math.abs(gy - fy) < 1e-5, `(${x}, ${y})`);
  }
});
