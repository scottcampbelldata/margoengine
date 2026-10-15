import test from 'node:test';
import assert from 'node:assert/strict';
import {Noise, permutation, fbm, ridged, domainWarp, SIMPLEX_SCALE} from '../dist/noise.js';
import {Noise as RootNoise} from '../dist/index.js';

const seeded = seed => {let s = seed; return () => {s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296;};};
const fields = noise => [[2, (p) => noise.simplex2(p[0], p[1])], [3, p => noise.simplex(p[0], p[1], p[2])], [4, p => noise.simplex4(p[0], p[1], p[2], p[3])]];
const unskew = {2: (3 - Math.sqrt(3)) / 6, 3: 1 / 6, 4: (5 - Math.sqrt(5)) / 20};

test('simplex is deterministic per seed and differs between seeds', () => {
  const a = new Noise(13), b = new Noise(13), c = new Noise(14);
  for (const [[, f], [, g], [, h]] of fields(a).map((x, i) => [x, fields(b)[i], fields(c)[i]])) {
    const p = [0.25, 1.5, -2.7, 0.9];
    assert.equal(f(p), g(p)); assert.notEqual(f(p), h(p));
  }
  assert.equal(RootNoise, Noise, 'the root entry re-exports the same class');
  assert.equal(new Noise(0).simplex(1.1, 2.2, 3.3), new Noise(1).simplex(1.1, 2.2, 3.3), 'seed 0 uses the xorshift state 1');
});

test('simplex stays inside (-1, 1) with a sane, centred distribution', () => {
  const random = seeded(77);
  for (const [dims, f] of fields(new Noise(5))) {
    let sum = 0, squares = 0, lo = Infinity, hi = -Infinity, above = 0;
    const count = 40000;
    for (let i = 0; i < count; i++) {
      const v = f(Array.from({length: dims}, () => (random() - 0.5) * 400));
      sum += v; squares += v * v; lo = Math.min(lo, v); hi = Math.max(hi, v); if (Math.abs(v) > 0.5) above++;
    }
    const mean = sum / count, deviation = Math.sqrt(squares / count - mean * mean);
    assert.ok(lo > -1 && hi < 1, `${dims}D range ${lo}..${hi}`);
    assert.ok(hi > 0.75 && lo < -0.75, `${dims}D uses most of the range: ${lo}..${hi}`);
    assert.ok(Math.abs(mean) < 0.02, `${dims}D mean ${mean}`); assert.ok(deviation > 0.2 && deviation < 0.55, `${dims}D deviation ${deviation}`);
    assert.ok(above > count * 0.01, `${dims}D tails`);
  }
  assert.deepEqual(SIMPLEX_SCALE.slice(2), [70, 76, 62]);
});

test('simplex is continuous across simplex faces (no seams)', () => {
  // Points exactly on faces: in skewed lattice space either one coordinate is an integer (a cell face) or two coordinates
  // have equal fractional parts (a face between simplices inside the cell). Then a nudge of 1e-9 to either side.
  const random = seeded(31), noise = new Noise(9);
  for (const [dims, f] of fields(noise)) {
    let worst = 0;
    for (let i = 0; i < 20000; i++) {
      const u = Array.from({length: dims}, () => (random() - 0.5) * 40), a = Math.floor(random() * dims), b = (a + 1 + Math.floor(random() * (dims - 1))) % dims;
      if (i & 1) u[a] = Math.round(u[a]); else u[a] = Math.floor(u[a]) + (u[b] - Math.floor(u[b]));
      const t = u.reduce((s, v) => s + v, 0) * unskew[dims], p = u.map(v => v - t);
      const d = Array.from({length: dims}, () => (random() - 0.5) * 2e-9), q = p.map((v, k) => v + d[k]), r = p.map((v, k) => v - d[k]);
      worst = Math.max(worst, Math.abs(f(q) - f(p)), Math.abs(f(r) - f(p)));
    }
    assert.ok(worst < 1e-6, `${dims}D jump of ${worst} across a simplex face`);
  }
});

test('permutation tables are seeded shuffles of 0..255, repeated', () => {
  const p = permutation(7);
  assert.equal(p.length, 512); assert.deepEqual([...p.slice(0, 256)].sort((a, b) => a - b), Array.from({length: 256}, (_, i) => i));
  assert.deepEqual(p.slice(256), p.slice(0, 256)); assert.deepEqual(permutation(7), p); assert.notDeepEqual(permutation(8), p);
  assert.throws(() => permutation(0.5), /seed/); assert.throws(() => new Noise(1).simplex4(0, 0, 0, Infinity), /finite/);
  assert.throws(() => new Noise(1).simplex2(NaN, 0), /finite/);
});

test('fbm, ridged and domain warp are deterministic, bounded and validate options', () => {
  const noise = new Noise(3), field = (x, y, z) => noise.simplex(x, y, z), f = fbm(field, {octaves: 6}), r = ridged(field), w = domainWarp(f, {strength: 0.8});
  let lo = Infinity, hi = -Infinity, rlo = Infinity, rhi = -Infinity;
  for (let i = 0; i < 4000; i++) {
    const x = Math.sin(i) * 40, y = Math.cos(i * 1.3) * 40, z = i * 0.01, v = f(x, y, z), q = r(x, y, z);
    lo = Math.min(lo, v); hi = Math.max(hi, v); rlo = Math.min(rlo, q); rhi = Math.max(rhi, q);
    assert.ok(Number.isFinite(w(x, y, z)));
  }
  assert.ok(lo >= -1 && hi <= 1 && hi - lo > 0.8, `fbm range ${lo}..${hi}`); assert.ok(rlo >= 0 && rhi <= 1 && rhi - rlo > 0.3, `ridged range ${rlo}..${rhi}`);
  // One octave is the noise itself; a 2D field ignores z and w; warp with strength 0 is the identity.
  assert.equal(fbm(field, {octaves: 1})(0.3, 0.7, 0.1), field(0.3, 0.7, 0.1));
  const flat = (x, y) => noise.simplex2(x, y); assert.equal(fbm(flat)(1.5, 2.5, 99, 99), fbm(flat)(1.5, 2.5));
  assert.equal(domainWarp(field, {strength: 0})(0.3, 0.2, 0.1), field(0.3, 0.2, 0.1));
  // Hand-computed fbm: two octaves, gain 0.5, lacunarity 2.
  assert.equal(fbm(field, {octaves: 2})(0.3, 0.2, 0.1), (field(0.3, 0.2, 0.1) + 0.5 * field(0.6, 0.4, 0.2)) / 1.5);
  assert.throws(() => fbm(field, {octaves: 0}), /fractal/); assert.throws(() => domainWarp(field, {dimensions: 5}), /warp/);
});
