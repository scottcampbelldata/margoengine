// B0: the fixed-point library, hashes, noise, the relief generator and R16. Every helper is checked against a
// high-precision reference (float maths in the test only) and fuzzed against an exact BigInt model of the same
// algorithm, so the JavaScript result is the one integer answer, not an approximation that might differ elsewhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  ONE,
  R16,
  atan2,
  clampInt,
  createRelief,
  degreesToAngle,
  divFloor,
  divWide,
  fade,
  fbm,
  hash2,
  hash3,
  hash4,
  hash5,
  idiv,
  imod,
  isqrt,
  mul64,
  mulHigh,
  mulShift,
  pcg,
  qdiv,
  qexp2,
  qlog2,
  qmul,
  qpow,
  qsqrt,
  quantizeHeights,
  ridged,
  sincos,
  udiv,
  umod,
  valueNoise,
  wendland,
} from '../dist/index.js';
import { random } from './random.js';

const golden = JSON.parse(readFileSync(new URL('./golden/relief.json', import.meta.url), 'utf8'));
const i32 = (rng) => (rng() * 4294967296 - 2147483648) | 0;
const B = BigInt;
// Inputs that break naive code: limits, signs, powers of two and their neighbours.
const edges = [0, 1, -1, 2, -2, 65535, 65536, -65536, 65537, 2147483647, -2147483648, 1 << 30, -(1 << 30), 46341];

test('mul64 and mulShift equal the exact BigInt product on edges and 20,000 fuzzed pairs', () => {
  const rng = random(1),
    pairs = [];
  for (const a of edges) for (const b of edges) pairs.push([a, b]);
  for (let i = 0; i < 20000; i++) pairs.push([i32(rng), i % 3 ? i32(rng) : (rng() * 131072) | 0]);
  for (const [a, b] of pairs) {
    const p = B(a) * B(b),
      lo = mul64(a, b);
    assert.equal(lo, Number(BigInt.asUintN(32, p)), `lo ${a} * ${b}`);
    assert.equal(mulHigh(), Number(BigInt.asIntN(32, p >> 32n)), `hi ${a} * ${b}`);
    for (const shift of [0, 1, 8, 15, 16, 24, 31, 32])
      assert.equal(mulShift(a, b, shift), Number(BigInt.asIntN(32, p >> B(shift))), `${a} * ${b} >> ${shift}`);
    assert.equal(qmul(a, b), Number(BigInt.asIntN(32, p >> 16n)));
  }
});

/** WGSL's i32 `/` and `%` (WGSL section 8.8) on BigInt. */
const wgslDiv = (a, b) => (b === 0 || (a === -2147483648 && b === -1) ? a : Number(B(a) / B(b)));
const wgslMod = (a, b) => (b === 0 || (a === -2147483648 && b === -1) ? 0 : Number(B(a) % B(b)));

test('idiv, imod, udiv and umod follow WGSL integer rules, zero divisors and INT_MIN / -1 included', () => {
  const rng = random(2),
    pairs = [];
  for (const a of edges) for (const b of edges) pairs.push([a, b]);
  for (let i = 0; i < 20000; i++) pairs.push([i32(rng), i % 4 ? i32(rng) >> ((rng() * 31) | 0) : 0]);
  for (const [a, b] of pairs) {
    assert.equal(idiv(a, b), wgslDiv(a, b), `${a} / ${b}`);
    assert.equal(imod(a, b), wgslMod(a, b), `${a} % ${b}`);
    const ua = a >>> 0,
      ub = b >>> 0;
    assert.equal(udiv(a, b), ub === 0 ? ua : Number(B(ua) / B(ub)), `${ua} u/ ${ub}`);
    assert.equal(umod(a, b), ub === 0 ? 0 : Number(B(ua) % B(ub)), `${ua} u% ${ub}`);
  }
  // The JavaScript pitfall these helpers exist for.
  assert.equal((7 / 0) | 0, 0);
  assert.equal(idiv(7, 0), 7);
  assert.equal(imod(7, 0), 0);
  assert.equal(idiv(-2147483648, -1), -2147483648);
  assert.equal(imod(-2147483648, -1), 0);
});

test('divWide truncates toward zero exactly (BigInt division) for numerators up to 2^53', () => {
  const rng = random(3);
  const cases = [
    [7, 2],
    [-7, 2],
    [7, -2],
    [-7, -2],
    [2 ** 53 - 1, 3],
    [-(2 ** 53 - 1), 7],
    [2 ** 52 + 1, 2 ** 26 + 1],
    [1, 2147483647],
  ];
  for (let i = 0; i < 20000; i++) {
    const n = Math.floor((rng() - 0.5) * 2 ** 53),
      d = Math.floor((rng() - 0.5) * 2 ** (1 + ((rng() * 40) | 0))) || 1;
    cases.push([n, d]);
  }
  for (const [n, d] of cases) {
    assert.equal(divWide(n, d), Number(B(n) / B(d)), `${n} / ${d}`);
    const q = B(n) / B(d),
      floor = B(n) % B(d) !== 0n && n < 0 !== d < 0 ? q - 1n : q;
    assert.equal(divFloor(n, d), Number(floor), `floor ${n} / ${d}`);
  }
  assert.equal(divFloor(-7, 2), -4);
  assert.equal(divFloor(7, 0), 7);
  assert.equal(divWide(123, 0), 123);
  for (const [a, b] of [
    [ONE, 3 * ONE],
    [-5 * ONE, 2 * ONE],
    [123456789, -98765],
  ])
    assert.equal(qdiv(a, b), Number(BigInt.asIntN(32, (B(a) * 65536n) / B(b))));
  assert.equal(qdiv(3, 0), 3 << 16);
});

test('isqrt is the exact floor square root (BigInt) up to 2^52; qsqrt within one unit', () => {
  const rng = random(30),
    exact = (n) => {
      if (n < 2n) return n;
      let x = n,
        y = (x + 1n) / 2n;
      while (y < x) {
        x = y;
        y = (x + n / x) / 2n;
      }
      return x;
    };
  const values = [0, 1, 2, 3, 4, 15, 16, 17, 2 ** 52, 2 ** 52 - 1, (2 ** 26 - 1) ** 2, (2 ** 26 - 1) ** 2 - 1];
  for (let i = 0; i < 20000; i++) values.push(Math.floor(rng() * 2 ** (1 + ((rng() * 52) | 0))));
  for (const n of values) assert.equal(isqrt(n), Number(exact(B(n))), `isqrt ${n}`);
  for (const bad of [-1, 0.5, 2 ** 53, NaN]) assert.throws(() => isqrt(bad), RangeError);
  for (const x of [ONE, 2 * ONE, 100 * ONE, 1, 2147483647])
    assert.ok(Math.abs(qsqrt(x) - Math.sqrt(x / ONE) * ONE) <= 1, `qsqrt ${x}`);
});

/** The qlog2 algorithm on BigInt: the same bits by a different arithmetic. */
function log2Model(x) {
  if (x <= 0) return -2147483648;
  const e = 31 - Math.clz32(x);
  let m = e >= 15 ? B(x) >> B(e - 15) : B(x) << B(15 - e),
    frac = 0;
  for (let bit = 1 << 15; bit; bit >>>= 1) {
    m = (m * m + 16384n) >> 15n;
    if (m >= 65536n) {
      m >>= 1n;
      frac |= bit;
    }
  }
  return (e - 16) * 65536 + frac;
}

test('qlog2 equals its BigInt model and is within 6 units of log2; qexp2 within 1 unit relative', () => {
  const rng = random(4);
  for (let i = 0; i < 20000; i++) {
    const x = 1 + Math.floor(rng() * 2147483646);
    const q = qlog2(x);
    assert.equal(q, log2Model(x), `model ${x}`);
    assert.ok(Math.abs(q - Math.log2(x / ONE) * ONE) <= 6, `log2 ${x}: ${q}`);
  }
  assert.equal(qlog2(0), -2147483648);
  assert.equal(qlog2(ONE), 0);
  assert.equal(qlog2(2 * ONE), ONE);
  for (let i = 0; i < 20000; i++) {
    const x = Math.floor((rng() * 30 - 15.5) * ONE),
      want = 2 ** (x / ONE) * ONE,
      got = qexp2(x);
    assert.ok(Math.abs(got - want) <= Math.max(1.5, want * 2e-5), `exp2 ${x / ONE}: ${got} vs ${want}`);
  }
  assert.equal(qexp2(0), ONE);
  assert.equal(qexp2(15 * ONE), 2147483647);
  assert.equal(qexp2(-20 * ONE), 0);
  assert.ok(Math.abs(qpow(9 * ONE, ONE / 2) - 3 * ONE) < 20);
});

test('CORDIC atan2 and sincos match the float references within a few units', () => {
  const rng = random(5),
    turn = 2 ** 32;
  for (let i = 0; i < 20000; i++) {
    const y = i32(rng) >> ((rng() * 24) | 0),
      x = i32(rng) >> ((rng() * 24) | 0);
    if (!x && !y) continue;
    const want = (Math.atan2(y, x) / (2 * Math.PI)) * turn,
      got = atan2(y, x);
    // Compare on the circle: -2^31 and 2^31 are the same angle.
    const diff = ((((got - want) % turn) + turn * 1.5) % turn) - turn / 2;
    assert.ok(Math.abs(diff) <= 96, `atan2(${y}, ${x}) = ${got}, want ${want}`);
  }
  assert.equal(atan2(0, 0), 0);
  assert.ok(Math.abs(atan2(0, 5)) <= 8);
  assert.ok(Math.abs(atan2(1, 0) - 2 ** 30) <= 8);
  const out = [0, 0];
  for (let i = 0; i < 20000; i++) {
    const angle = i32(rng),
      radians = (angle / turn) * 2 * Math.PI;
    sincos(angle, out);
    assert.ok(Math.abs(out[0] - Math.cos(radians) * ONE) <= 2, `cos ${angle}: ${out[0]}`);
    assert.ok(Math.abs(out[1] - Math.sin(radians) * ONE) <= 2, `sin ${angle}: ${out[1]}`);
  }
  assert.equal(degreesToAngle(90), 2 ** 30);
  assert.equal(degreesToAngle(-90), -(2 ** 30));
  assert.equal(degreesToAngle(450), 2 ** 30);
});

/** pcg on BigInt. */
function pcgModel(v) {
  const state = BigInt.asUintN(32, B(v >>> 0) * 747796405n + 2891336453n);
  const word = BigInt.asUintN(32, ((state >> ((state >> 28n) + 4n)) ^ state) * 277803737n);
  return Number((word >> 22n) ^ word);
}

test('pcg equals its BigInt model, and nested hashes are u32 and order dependent', () => {
  const rng = random(6);
  for (const v of [0, 1, 2 ** 32 - 1, 2 ** 31, 12345]) assert.equal(pcg(v), pcgModel(v));
  for (let i = 0; i < 20000; i++) {
    const v = (rng() * 2 ** 32) >>> 0;
    assert.equal(pcg(v), pcgModel(v));
  }
  // Known answers lock the function: a change here changes every placement.
  assert.deepEqual([pcg(0), pcg(1), pcg(0xffffffff)], [pcgModel(0), pcgModel(1), pcgModel(0xffffffff)]);
  assert.equal(pcg(0), 129708002);
  for (const h of [hash2(1, 2), hash3(1, 2, 3), hash4(1, 2, 3, 4), hash5(1, 2, 3, 4, 5)])
    assert.ok(Number.isInteger(h) && h >= 0 && h < 2 ** 32);
  assert.notEqual(hash2(1, 2), hash2(2, 1));
  // Uniform enough: each of 16 buckets of 64,000 hashes holds 4,000 +- 5 %.
  const buckets = new Array(16).fill(0);
  for (let i = 0; i < 64000; i++) buckets[hash3(7, i, i >> 3) >>> 28]++;
  for (const b of buckets) assert.ok(Math.abs(b - 4000) < 200, `bucket ${b}`);
});

test('value noise, fbm and ridged are bounded, continuous and seed dependent', () => {
  const rng = random(7);
  for (let i = 0; i < 5000; i++) {
    const x = i32(rng) >> 4,
      z = i32(rng) >> 4;
    for (const v of [valueNoise(3, x, z), fbm(3, x, z, 5), ridged(3, x, z, 5)])
      assert.ok(Number.isInteger(v) && v >= 0 && v <= 65535, `range ${v}`);
    // One Q16 step moves the noise by a few units at most: no cracks at lattice lines.
    assert.ok(Math.abs(valueNoise(3, x + 1, z) - valueNoise(3, x, z)) <= 10);
    assert.ok(Math.abs(valueNoise(3, x, z + 1) - valueNoise(3, x, z)) <= 10);
  }
  // At lattice points the noise equals the lattice hash.
  assert.equal(valueNoise(9, 5 * ONE, -3 * ONE), hash3(9, 5, -3) >>> 16);
  let differs = 0;
  for (let i = 0; i < 100; i++)
    differs += +(valueNoise(1, i * 40000, i * 30000) !== valueNoise(2, i * 40000, i * 30000));
  assert.ok(differs > 90);
});

test('wendland, fade and clampInt keep their end points and stay monotone', () => {
  assert.equal(wendland(0), ONE);
  assert.equal(wendland(ONE), 0);
  assert.equal(wendland(2 * ONE), 0);
  assert.equal(wendland(-5), ONE);
  assert.equal(fade(0), 0);
  assert.equal(fade(ONE), ONE);
  for (let r = 1; r <= ONE; r += 97) {
    assert.ok(wendland(r) <= wendland(r - 97) + 1);
    assert.ok(fade(r) >= fade(r - 97) - 1);
    assert.ok(Math.abs(wendland(r) - (1 - r / ONE) ** 4 * (4 * (r / ONE) + 1) * ONE) <= 8);
  }
  assert.equal(clampInt(5, 0, 3), 3);
  assert.equal(clampInt(-5, 0, 3), 0);
});

/** SHA-256 of the relief heights on a grid (little-endian i32). */
function reliefDigest(relief, [ox, oz], [sx, sz], step) {
  const n = Math.floor(sx / step) * Math.floor(sz / step),
    heights = new Int32Array(n);
  let k = 0;
  for (let z = 0; z < sz; z += step) for (let x = 0; x < sx; x += step) heights[k++] = relief.height(ox + x, oz + z);
  return createHash('sha256').update(new Uint8Array(heights.buffer)).digest('hex');
}

test('relief: the default and R16 landscapes match their committed golden digests', () => {
  const plain = createRelief();
  assert.equal(reliefDigest(plain, [-2048000, -2048000], [4096000, 4096000], 32000), golden.default);
  const r16 = createRelief(R16.relief);
  assert.equal(reliefDigest(r16, [-8192000, -8192000], [16384000, 16384000], 128000), golden.r16);
  assert.equal(r16.rivers.length, 2);
  // R16 shape: sea along the west edge, land inland, mountains somewhere above 900 m, river beds low.
  let sea = 0,
    high = 0;
  for (let z = -8000000; z < 8000000; z += 250000) {
    sea += +(r16.height(-8150000, z) < 0);
    for (let x = -4000000; x < 8000000; x += 250000) high = Math.max(high, r16.height(x, z));
  }
  assert.ok(sea >= 60, `west edge under the sea at ${sea} of 64 points`);
  assert.ok(high > 900000, `highest point ${high} mm`);
  for (const line of r16.rivers) {
    const h = r16.height(line[8], line[9]);
    assert.ok(h < 40000, `river bed ${h} mm`);
  }
});

test('relief: deterministic, seed dependent and validated', () => {
  const a = createRelief({ seed: 5, coast: 'south', rivers: 3 }),
    b = createRelief({ seed: 5, coast: 'south', rivers: 3 }),
    c = createRelief({ seed: 6, coast: 'south', rivers: 3 });
  let differs = 0;
  for (let i = 0; i < 200; i++) {
    const x = ((i * 9973) % 4000000) - 2000000,
      z = ((i * 7919) % 4000000) - 2000000;
    assert.equal(a.height(x, z), b.height(x, z));
    differs += +(a.height(x, z) !== c.height(x, z));
  }
  assert.ok(differs > 190);
  for (const side of ['west', 'east', 'north', 'south'])
    assert.ok(createRelief({ coast: side, rivers: 1 }).rivers[0].length === 18);
  assert.throws(() => createRelief(null), TypeError);
  for (const bad of [
    { size: [10, 10] },
    { relief: -1 },
    { coast: 'up' },
    { rivers: 9 },
    { rivers: 1.5 },
    { base: NaN },
  ])
    assert.throws(() => createRelief(bad), RangeError, JSON.stringify(bad));
});

test('quantizeHeights rounds metres to millimetres and rejects bad samples', () => {
  assert.deepEqual([...quantizeHeights(new Float32Array([0, 1.5, -2.25]))], [0, 1500, -2250]);
  assert.deepEqual([...quantizeHeights(new Float64Array([1]), 0.5)], [500]);
  assert.throws(() => quantizeHeights([1, 2]), TypeError);
  assert.throws(() => quantizeHeights(new Float32Array([NaN])), RangeError);
  assert.throws(() => quantizeHeights(new Float32Array([1]), 0), RangeError);
});

test('R16 is frozen data with the spec values', () => {
  assert.ok(Object.isFrozen(R16) && Object.isFrozen(R16.relief));
  assert.deepEqual(R16.size, [16384, 16384]);
  assert.equal(R16.tileSize, 256);
  assert.deepEqual([...R16.biomes], ['temperate', 'alpine', 'wetland', 'boreal']);
});
