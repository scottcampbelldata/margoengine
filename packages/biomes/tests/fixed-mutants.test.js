// Mutation testing (scripts/mutation.mjs, `node scripts/mutation.mjs biomes fixed`) found places in src/fixed.ts that
// no test pinned: the wide division paths, the exp2 and log2 tables, the CORDIC scaling branches, acos and fade. This file pins them. Wide divisions and square roots are checked against exact BigInt models; the
// table-driven functions are checked over a full sweep of their inputs by digest (the digest is of the current, already
// error-bounded results, so any one-unit change anywhere in a table or constant fails here).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  ONE,
  atan2,
  divFloor,
  divWide,
  fade,
  isqrt,
  qacos,
  qdiv,
  qexp2,
  qlog2,
  qmul,
  qpow,
  qsqrt,
  sincos,
  wendland,
} from '../dist/toolkit.js';
import { random } from './random.js';

const digest = (values) =>
  createHash('sha256')
    .update(Buffer.from(Int32Array.from(values).buffer))
    .digest('hex')
    .slice(0, 24);
const big = (v) => BigInt(v);
const truncDiv = (n, d) => big(n) / big(d); // BigInt division truncates toward zero
const floorDiv = (n, d) => {
  const q = big(n) / big(d);
  return big(n) % big(d) !== 0n && big(n) < 0n !== big(d) < 0n ? q - 1n : q;
};

const WIDE = [
  2 ** 52,
  2 ** 52 + 1,
  2 ** 52 - 1,
  2 ** 53 - 1,
  2 ** 53 - 2,
  9007199254740991 - 4096,
  4503599627370495,
  4503599627370497,
  3000000000001,
  123456789012345,
];
const DIVISORS = [
  1,
  2,
  3,
  7,
  10,
  255,
  65535,
  65536,
  65537,
  2147483647,
  2147483648,
  4294967295,
  99999999977,
  2 ** 40 + 1,
];

test('divWide and divFloor are exact on wide numerators and divisors, both signs', () => {
  const r = random(41);
  const numerators = [...WIDE, ...WIDE.map((n) => -n), 0, 1, -1];
  for (let i = 0; i < 300; i++) numerators.push(Math.floor((r() - 0.5) * 2 ** 53));
  for (const n of numerators)
    for (const d0 of DIVISORS)
      for (const d of [d0, -d0]) {
        assert.equal(divWide(n, d), Number(truncDiv(n, d)), `divWide ${n} / ${d}`);
        assert.equal(divFloor(n, d), Number(floorDiv(n, d)), `divFloor ${n} / ${d}`);
      }
  for (const n of [5, -5, 2 ** 52 + 6, -(2 ** 52) - 6]) {
    assert.equal(divWide(n, 0), n);
    assert.equal(divFloor(n, 0), n);
  }
  // Around the fast-path limits: 2^52 and the 2^31 divisor edge, exactly on and beside them.
  for (const n of [2 ** 52 - 1, 2 ** 52, 2 ** 52 + 1, -(2 ** 52) + 1, -(2 ** 52), -(2 ** 52) - 1])
    for (const d of [2147483647, 2147483648, -2147483647, -2147483648, 3])
      assert.equal(divFloor(n, d), Number(floorDiv(n, d)), `edge ${n} / ${d}`);
});

test('divWide and divFloor are exact near the limit of the exact range', () => {
  // Near the limit of the exact range (the quotient sits 1/d under an integer). The double quotient is never wrong for
  // |n| below 2^53 (that needs q * d above 2^53), so divWider's correction steps are unreachable defence, listed as
  let wrongUp = 0,
    // equivalent mutants in docs/mutation.md; this pins the answers.
    wrongDown = 0;
  const r = random(42);
  for (let i = 0; i < 6000; i++) {
    const d = 2 ** 40 + Math.floor(r() * 2 ** 52 * 0.9);
    const q = 1 + Math.floor(r() * Math.max(1, Math.floor(2 ** 53 / d) - 1));
    for (const rem of [-1, 0, 1, d - 1, d]) {
      const n = q * d + rem;
      if (!Number.isSafeInteger(n)) continue;
      for (const [a, b] of [
        [n, d],
        [-n, d],
        [n, -d],
        [-n, -d],
      ]) {
        const guess = Math.trunc(a / b),
          exact = Number(truncDiv(a, b));
        if (guess > exact) wrongUp++;
        if (guess < exact) wrongDown++;
        assert.equal(divWide(a, b), exact, `divWide ${a} / ${b}`);
        assert.equal(divFloor(a, b), Number(floorDiv(a, b)), `divFloor ${a} / ${b}`);
      }
    }
  }
  assert.equal(
    wrongUp + wrongDown,
    0,
    'the double quotient is exact in the whole range, as the comment in divWide says',
  );
});

test('qdiv and qmul: exact on wide products, qdiv by zero wraps a * 65536', () => {
  const r = random(43);
  for (let i = 0; i < 4000; i++) {
    const a = (r() * 2 ** 32) | 0,
      b = (r() * 2 ** 32) | 0;
    assert.equal(qmul(a, b), Number(BigInt.asIntN(32, (big(a) * big(b)) >> 16n)), `qmul ${a} ${b}`);
    if (b !== 0) assert.equal(qdiv(a, b), Number(BigInt.asIntN(32, truncDiv(big(a) * 65536n, b))), `qdiv ${a} ${b}`);
  }
  assert.equal(qdiv(12345, 0), Number(BigInt.asIntN(32, 12345n * 65536n)));
  // The fast-path edge of qmul: products at and beside 2^53.
  for (const [a, b] of [
    [2 ** 26, 2 ** 27],
    [2 ** 26, 2 ** 27 - 1],
    [-(2 ** 26), 2 ** 27],
    [2 ** 26 + 1, 2 ** 27 - 1],
  ])
    assert.equal(qmul(a, b), Number(BigInt.asIntN(32, (big(a) * big(b)) >> 16n)), `qmul edge ${a} ${b}`);
});

test('isqrt is the exact floor square root at perfect squares and one below, up to 2^52', () => {
  const roots = [0, 1, 2, 3, 255, 65535, 65536, 1000003, 67108863, 67108864];
  for (const s of roots) {
    const sq = s * s;
    assert.equal(isqrt(sq), s);
    if (sq > 0) assert.equal(isqrt(sq - 1), s - 1);
    if (sq + 1 <= 2 ** 52) assert.equal(isqrt(sq + 1), s === 0 ? 1 : s);
    if (sq + 2 * s <= 2 ** 52) assert.equal(isqrt(sq + 2 * s), s);
  }
  assert.equal(isqrt(2 ** 52), 2 ** 26);
  assert.equal(isqrt(2 ** 52 - 1), 2 ** 26 - 1);
  const r = random(44);
  for (let i = 0; i < 5000; i++) {
    const n = Math.floor(r() * 2 ** 52);
    let s = BigInt(Math.floor(Math.sqrt(n)));
    while (s * s > BigInt(n)) s--;
    while ((s + 1n) * (s + 1n) <= BigInt(n)) s++;
    assert.equal(isqrt(n), Number(s), `isqrt ${n}`);
  }
  for (const bad of [-1, 0.5, 2 ** 52 + 1, NaN]) assert.throws(() => isqrt(bad), RangeError);
  assert.equal(qsqrt(ONE * 4), 2 * ONE);
  assert.equal(qsqrt(0xffffffff | 0), Number(BigInt(isqrt(0xffffffff * ONE))));
});

const sweeps = {
  qexp2: () => {
    const out = [];
    for (let x = -20 * ONE; x <= 16 * ONE; x += 7) out.push(qexp2(x));
    for (let f = 0; f < 65536; f++) out.push(qexp2(f), qexp2(-f), qexp2(14 * ONE + f));
    for (const x of [15 * ONE - 1, 15 * ONE, 15 * ONE + 1, -18 * ONE, -18 * ONE + 1, -18 * ONE - 1]) out.push(qexp2(x));
    return out;
  },
  qlog2: () => {
    const out = [];
    for (let x = -3; x < 1 << 20; x++) out.push(qlog2(x));
    for (let k = 0; k < 32; k++)
      for (const d of [-1, 0, 1]) out.push(qlog2(((2 ** k + d) | 0) >>> 0 === 0 ? 1 : (2 ** k + d) | 0));
    const r = random(51);
    for (let i = 0; i < 200000; i++) out.push(qlog2((r() * 2 ** 31) | 0));
    return out;
  },
  qpow: () => {
    const out = [];
    for (let x = 1; x < 20 * ONE; x += 4099) for (let y = -3 * ONE; y <= 3 * ONE; y += 20011) out.push(qpow(x, y));
    out.push(qpow(0, ONE), qpow(-5, ONE));
    return out;
  },
  atan2: () => {
    const out = [atan2(0, 0)];
    const vals = [
      0,
      1,
      -1,
      2,
      3,
      37,
      -37,
      1000,
      -1000,
      65536,
      -65536,
      2 ** 28,
      -(2 ** 28),
      2 ** 29 - 1,
      2 ** 30,
      2 ** 31 - 1,
      -(2 ** 31),
    ];
    for (const y of vals) for (const x of vals) out.push(atan2(y, x));
    // wide and fractional inputs take the second scaling branch
    const wideVals = [2 ** 31, 2 ** 31 + 5, -(2 ** 31) - 5, 2 ** 40, -(2 ** 40) - 3, 3 * 2 ** 33, 1.5, -0.5, 7e12];
    for (const y of wideVals) for (const x of [...wideVals, 5, -5, 0, 2 ** 31 - 1]) out.push(atan2(y, x), atan2(x, y));
    const r = random(52);
    for (let i = 0; i < 20000; i++) {
      const s = 2 ** Math.floor(r() * 31);
      out.push(atan2(Math.floor((r() - 0.5) * s), Math.floor((r() - 0.5) * s)));
    }
    return out;
  },
  sincos: () => {
    const out = [],
      o = [0, 0];
    for (let a = -2147483648; a < 2147483648; a += 40009) {
      sincos(a, o);
      out.push(o[0], o[1]);
    }
    for (const a of [0, 1, -1, 1073741823, 1073741824, 1073741825, -1073741824, -1073741825, 2147483647, -2147483648]) {
      sincos(a, o);
      out.push(o[0], o[1]);
    }
    return out;
  },
  qacos: () => {
    const out = [];
    for (let x = -ONE - 5; x <= ONE + 5; x += 3) out.push(qacos(x));
    return out;
  },
  fade: () => {
    const out = [];
    for (let t = 0; t <= ONE; t++) out.push(fade(t));
    return out;
  },
  wendland: () => {
    const out = [wendland(-5), wendland(0)];
    for (let r = 1; r <= ONE + 3; r++) out.push(wendland(r));
    return out;
  },
};

const EXPECT = {
  qexp2: '66ba88446bbc88b820263fb1',
  qlog2: '616192c98be005e341e47aef',
  qpow: 'b1e74a5639814034358a2593',
  atan2: '09267d632572530fd617f5b6',
  sincos: '9b20e9db10c05e4da4dd0072',
  qacos: '23754cb0bcc20471154712dd',
  fade: '2eeec324c6ce665b3f750adf',
  wendland: '505bc69907aba7133264de98',
};

for (const [name, run] of Object.entries(sweeps))
  test(`full-sweep digest of ${name} is locked`, () => {
    const got = digest(run());
    if (process.env.PRINT_DIGESTS) console.log(`DIGEST ${name} ${got}`);
    else assert.equal(got, EXPECT[name], `${name}: a table, constant or branch changed an output`);
  });
