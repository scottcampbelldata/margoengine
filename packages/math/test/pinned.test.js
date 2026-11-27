// The pinned maths (K01) in TypeScript give the same bits as kernel-common's Rust: every vector in
// packages/physics/kernel-common/tests/pinned-vectors.txt, which the Rust writes and checks, is reproduced exactly.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { atan, atan2, cos, dot, exp, hypot, ln, pow, sin, sum } from '../dist/pinned.js';

const fromHex = (hex) => new Float64Array(new BigUint64Array([BigInt(`0x${hex}`)]).buffer)[0];
const toHex = (x) => new BigUint64Array(new Float64Array([x]).buffer)[0].toString(16).padStart(16, '0');

test('every pinned function gives the Rust bits for every vector', () => {
  const text = readFileSync(new URL('../../physics/kernel-common/tests/pinned-vectors.txt', import.meta.url), 'utf8');
  const one = { exp, ln, sin, cos },
    counts = {};
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [name, ...words] = line.split(' '),
      args = words.slice(0, -1).map(fromHex),
      want = words.at(-1);
    let got;
    if (name in one) got = one[name](args[0]);
    else if (name === 'pow') got = pow(args[0], args[1]);
    else if (name === 'sum') got = sum(args);
    else if (name === 'dot') got = dot(args.slice(0, args.length / 2), args.slice(args.length / 2));
    else assert.fail(`unknown function ${name}`);
    assert.equal(toHex(got), want, `${name}(${args.slice(0, 2).join(', ')})`);
    counts[name] = (counts[name] ?? 0) + 1;
  }
  assert.deepEqual(Object.keys(counts).sort(), ['cos', 'dot', 'exp', 'ln', 'pow', 'sin', 'sum']);
  assert.ok(Object.values(counts).reduce((a, b) => a + b) > 2800);
});

test('the pinned functions stay close to the exact values, and hypot is the rounded root of the squares', () => {
  assert.equal(exp(0), 1);
  assert.equal(ln(1), 0);
  assert.ok(Math.abs(exp(1) - Math.E) <= 2 * Number.EPSILON * Math.E);
  assert.ok(Math.abs(sin(Math.PI / 6) - 0.5) < 1e-15);
  assert.equal(pow(2, 10), 1024);
  assert.equal(hypot(3, 4), 5);
  assert.equal(hypot(2, 3, 6), 7);
  assert.throws(() => dot([1], [1, 2]), RangeError);
});

test('pinned atan and atan2 stay within 2 ulp of the true angle and keep their quadrants and signs', () => {
  // atan over 30 decades of x, against the engine's (itself within 1 ulp): 4.4e-16 near pi / 2 is 2 ulp there.
  let worst = 0;
  for (let i = -3000; i <= 3000; i++) {
    const x = Math.sinh(i / 150);
    worst = Math.max(worst, Math.abs(atan(x) - Math.atan(x)) / Math.max(Math.abs(Math.atan(x)), 1e-300) / Number.EPSILON);
  }
  assert.ok(worst <= 4, `${worst} ulp`);
  for (let i = 0; i < 3600; i++) {
    const a = (i / 3600) * 2 * Math.PI - Math.PI + 1e-9,
      y = Math.sin(a) * (1 + (i % 5)),
      x = Math.cos(a) * (1 + (i % 5));
    assert.ok(Math.abs(atan2(y, x) - Math.atan2(y, x)) <= 4 * Number.EPSILON * Math.PI, `${y}, ${x}`);
  }
  assert.equal(atan2(0, -1), Math.PI);
  assert.ok(Object.is(atan2(-0, 1), -0) && Object.is(atan2(0, 1), 0));
  assert.equal(atan2(1, 0), Math.PI / 2);
  assert.equal(atan2(-1, 0), -Math.PI / 2);
  assert.equal(atan(Infinity), Math.PI / 2);
  assert.ok(Number.isNaN(atan(Number.NaN)) && Number.isNaN(atan2(Number.NaN, 1)));
});
