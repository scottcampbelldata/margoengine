import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const code = readFileSync(new URL('../src/volumetric.ts', import.meta.url), 'utf8');
// JS twin of the fog's value noise: PCG corner values (Jarzynski and Olano, JCGT 9(3), 2020), cubic fade, trilinear.
const pcg = (v) => {
  const s = (Math.imul(v, 747796405) + 2891336453) >>> 0;
  const w = Math.imul((s >>> ((s >>> 28) + 4)) ^ s, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
};
const corner = (x, y, z) => (pcg(((x >>> 0) + pcg(((y >>> 0) + pcg(z >>> 0)) >>> 0)) >>> 0) >>> 8) / 16777216;
const mix = (a, b, t) => a + (b - a) * t,
  fade = (t) => t * t * (3 - 2 * t);
function noise(x, y, z) {
  const bx = Math.floor(x),
    by = Math.floor(y),
    bz = Math.floor(z),
    u = fade(x - bx),
    v = fade(y - by),
    w = fade(z - bz);
  const layer = (k) =>
    mix(
      mix(corner(bx, by, bz + k), corner(bx + 1, by, bz + k), u),
      mix(corner(bx, by + 1, bz + k), corner(bx + 1, by + 1, bz + k), u),
      v,
    );
  return mix(layer(0), layer(1), w);
}
const octave = Number(/0\.6667\*noise\(x\*([\d.]+)\+vec3f\(([-\d.]+),([-\d.]+),([-\d.]+)\)\)/.exec(code)?.[1]);
const offset = /0\.6667\*noise\(x\*[\d.]+\+vec3f\(([-\d.]+),([-\d.]+),([-\d.]+)\)\)/.exec(code)?.slice(1).map(Number);

test('the fog noise is lattice value noise over an integer PCG hash', () => {
  assert.match(code, /fn fogPcg\(v:u32\)->u32 \{let s=v\*747796405u\+2891336453u;/);
  assert.match(code, /return f32\(fogPcg\(u\.x\+fogPcg\(u\.y\+fogPcg\(u\.z\)\)\)>>8u\)\*5\.9604645e-8;/);
  assert.match(code, /let w=t\*t\*\(3\.0-2\.0\*t\);/);
  assert.equal(code.match(/fn noise\(x:vec3f\)->f32/g)?.length, 1);
  assert.doesNotMatch(code, /0\.1031|31\.32|fract\(sin|x\*2\.03/);
  assert.ok(octave > 1.9 && octave < 2.3 && Math.abs(octave - 2.03) > 0.02, `second octave ratio ${octave}`);
});

test('value noise and the two-octave density term keep their statistics', () => {
  let state = 0x9e3779b9;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) / 4294967296) * 2000 - 1000;
  };
  const n = 300000;
  let s1 = 0,
    q1 = 0,
    s2 = 0,
    q2 = 0,
    lo = 1,
    hi = 0;
  for (let i = 0; i < n; i++) {
    const x = random(),
      y = random(),
      z = random();
    const a = noise(x, y, z),
      b = noise(x * octave + offset[0], y * octave + offset[1], z * octave + offset[2]);
    const term = 1.3333 * a + 0.6667 * b - 1;
    s1 += a;
    q1 += a * a;
    s2 += term;
    q2 += term * term;
    lo = Math.min(lo, a);
    hi = Math.max(hi, a);
  }
  const mean = s1 / n,
    std = Math.sqrt(q1 / n - mean * mean),
    termMean = s2 / n,
    termStd = Math.sqrt(q2 / n - termMean * termMean);
  assert.ok(lo >= 0 && hi < 1);
  assert.ok(Math.abs(mean - 0.5) < 0.01, `mean ${mean}`);
  assert.ok(Math.abs(std - 0.1852) < 0.015, `std ${std}`);
  assert.ok(Math.abs(termMean) < 0.01, `term mean ${termMean}`);
  assert.ok(Math.abs(termStd - 0.276) < 0.015, `term std ${termStd}`);
  // Far-out fog volumes hash exactly: integer corners, so a 1e4 offset gives a different, equally spread field.
  assert.notEqual(noise(10000.5, 0.5, 0.5), noise(0.5, 0.5, 0.5));
});
