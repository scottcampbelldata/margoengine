import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The noise lives in the shared mesh patch module; terrain colors turn its fine octave.
const code = ['../src/mesh-patch.ts', '../src/colors.ts']
  .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
  .join('\n');
// JS twin of terrainNoise: lowbias32 (C. Wellons, "Prospecting for Hash Functions", 2018) nested over the cell, cubic
// fade, bilinear blend, analytic gradient.
const lowbias32 = (v) => {
  let h = v >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
};
const value = (x, row) => (lowbias32((x + row) >>> 0) >>> 8) / 16777216;
const mix = (a, b, t) => a + (b - a) * t;
function terrainNoise(px, py) {
  const bx = Math.floor(px),
    by = Math.floor(py),
    tx = px - bx,
    ty = py - by;
  const r0 = lowbias32(by >>> 0),
    r1 = lowbias32((by + 1) >>> 0);
  const v00 = value(bx >>> 0, r0),
    v10 = value((bx + 1) >>> 0, r0),
    v01 = value(bx >>> 0, r1),
    v11 = value((bx + 1) >>> 0, r1);
  const sx = tx * tx * (3 - 2 * tx),
    sy = ty * ty * (3 - 2 * ty),
    dx = 6 * tx * (1 - tx),
    dy = 6 * ty * (1 - ty);
  const low = mix(v00, v10, sx),
    high = mix(v01, v11, sx);
  return [mix(low, high, sy), dx * mix(v10 - v00, v11 - v01, sy), dy * (high - low)];
}
let state = 0x6a09e667;
const random = () => {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return (state >>> 0) / 4294967296;
};

test('terrainNoise is value noise over the nested lowbias32 hash, and the fine octave turns 52 degrees', () => {
  assert.match(
    code,
    /fn terrainHash\(seed:u32\)->u32 \{\r?\n var h=seed;h\^=h>>16u;h\*=0x7feb352du;h\^=h>>15u;h\*=0x846ca68bu;h\^=h>>16u;return h;\r?\n\}/,
  );
  assert.match(code, /let row0=terrainHash\(c\.y\);let row1=terrainHash\(c\.y\+1u\);/);
  assert.match(code, /let v00=f32\(terrainHash\(c\.x\+row0\)>>8u\)\*5\.9604645e-8;/);
  assert.match(code, /let s=t\*t\*\(3\.0-2\.0\*t\);let ds=6\.0\*t\*\(1\.0-t\);/);
  assert.doesNotMatch(code, /0\.8,0\.6,-0\.6,0\.8/);
  const [a, b, c, d] = /terrainNoise\(mat2x2f\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)\*p\.xz/
    .exec(code)
    .slice(1)
    .map(Number);
  assert.ok(Math.abs(a - d) < 1e-9 && Math.abs(b + c) < 1e-9 && Math.abs(Math.hypot(a, b) - 1) < 1e-4);
  assert.ok(Math.abs((Math.atan2(b, a) * 180) / Math.PI - 52) < 0.01);
});

test('terrainNoise statistics: mean 0.5, std 0.215, RMS slope 0.385, values in 0..1', () => {
  const n = 300000;
  let sum = 0,
    squares = 0,
    gx2 = 0,
    gy2 = 0,
    lo = 1,
    hi = 0;
  for (let i = 0; i < n; i++) {
    const [v, gx, gy] = terrainNoise(random() * 2000 - 1000, random() * 2000 - 1000);
    sum += v;
    squares += v * v;
    gx2 += gx * gx;
    gy2 += gy * gy;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const mean = sum / n,
    std = Math.sqrt(squares / n - mean * mean);
  assert.ok(lo >= 0 && hi < 1);
  assert.ok(Math.abs(mean - 0.5) < 0.01, `mean ${mean}`);
  assert.ok(Math.abs(std - 0.2146) < 0.015, `std ${std}`);
  assert.ok(Math.abs(Math.sqrt(gx2 / n) - 0.385) < 0.03, `slope x ${Math.sqrt(gx2 / n)}`);
  assert.ok(Math.abs(Math.sqrt(gy2 / n) - 0.385) < 0.03, `slope y ${Math.sqrt(gy2 / n)}`);
});

test('terrainNoise derivatives match central differences (h = 0.01 within 0.002 inside cells; exact everywhere)', () => {
  const difference = (x, y, h) => [
    (terrainNoise(x + h, y)[0] - terrainNoise(x - h, y)[0]) / (2 * h),
    (terrainNoise(x, y + h)[0] - terrainNoise(x, y - h)[0]) / (2 * h),
  ];
  const inside = (v) => v - Math.floor(v) > 0.01 && Math.ceil(v) - v > 0.01;
  for (let i = 0; i < 5000; i++) {
    const x = random() * 2e4 - 1e4,
      y = random() * 2e4 - 1e4;
    const [, gx, gy] = terrainNoise(x, y);
    // The cubic fade's curvature jumps on cell edges, so a 0.01 step straddling one is off by up to ~0.012 there;
    // a fine step agrees everywhere.
    const [ex, ey] = difference(x, y, 1e-5);
    assert.ok(Math.abs(gx - ex) < 1e-4 && Math.abs(gy - ey) < 1e-4, `fine step (${x}, ${y})`);
    if (!inside(x) || !inside(y)) continue;
    const [fx, fy] = difference(x, y, 0.01);
    assert.ok(Math.abs(gx - fx) < 0.002 && Math.abs(gy - fy) < 0.002, `(${x}, ${y})`);
  }
});
