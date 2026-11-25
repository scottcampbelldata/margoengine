// The engine's counter-based generator from its own entry, `@margoengine/math/random`, the one weather loads without the
// physics world: Philox4x32-10 matches the published answers and the kernels' Rust words, a draw is a pure function of
// (seed, solver, tick, element, stream), and a solver's number is the 32-bit FNV-1a hash of its id.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { RandomStream, philox, solverNumber } from '@margoengine/math/random';

const hex = (a) => Array.from(a, (v) => v.toString(16).padStart(8, '0')).join(' ');

test('Philox4x32-10 gives the published answers', () => {
  // Salmon, Moraes, Dror and Shaw, "Parallel random numbers: as easy as 1, 2, 3", SC 2011: the known answers.
  assert.equal(hex(philox(0, 0, 0, 0, 0, 0)), '6627e8d5 e169c58d bc57ac4c 9b00dbd8');
  assert.equal(hex(philox(~0, ~0, ~0, ~0, ~0, ~0)), '408f276d 41c83b0e a20bc7c6 6d5451fd');
  assert.equal(
    hex(philox(0x243f6a88, 0x85a308d3, 0x13198a2e, 0x03707344, 0xa4093822, 0x299f31d0)),
    'd16cfe09 94fdcceb 5001e420 24126ea1',
  );
  const out = new Uint32Array(4);
  assert.equal(philox(0, 0, 0, 0, 0, 0, out), out, 'writes into the given array');
});

test("a stream gives the Rust generator's words, the vectors kernel-common pins", () => {
  const text = readFileSync(new URL('../../physics/kernel-common/tests/random-vectors.txt', import.meta.url), 'utf8');
  let checked = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [seed, solver, tick, element, stream, ...words] = line.trim().split(/\s+/);
    const got = new RandomStream(Number(seed), Number(solver)).block(Number(tick), Number(element), Number(stream));
    assert.equal(hex(got), words.join(' '), line);
    checked++;
  }
  assert.equal(checked, 8);
});

test('draws do not depend on order, and every key and counter word changes them', () => {
  const r = new RandomStream(7, solverNumber('wind'));
  const forward = [0, 1, 2, 3].map((e) => r.uniform(5, e)),
    backward = [3, 2, 1, 0].map((e) => r.uniform(5, e)).reverse();
  assert.deepEqual(forward, backward);
  assert.notEqual(r.uniform(5, 0), r.uniform(5, 0, 1), 'stream');
  assert.notEqual(r.uniform(5, 0), r.uniform(6, 0), 'tick');
  assert.notEqual(r.uniform(2 ** 40, 0), r.uniform(0, 0), 'the high word of the tick');
  assert.notEqual(r.uniform(5, 0), new RandomStream(8, solverNumber('wind')).uniform(5, 0), 'seed');
  assert.notEqual(r.uniform(5, 0), new RandomStream(7, solverNumber('rain')).uniform(5, 0), 'solver');
  const [u, v] = r.unitF64(9, 2);
  assert.ok(u >= 0 && u < 1 && v >= 0 && v < 1 && u * 2 ** 53 === Math.floor(u * 2 ** 53));
  assert.equal(u, r.uniform(9, 2), 'uniform is the first of unitF64');
  for (const x of r.unitF32(3, 4)) assert.ok(x >= 0 && x < 1 && x * 2 ** 24 === Math.floor(x * 2 ** 24));
  const [w] = r.block(3, 4, 0);
  assert.equal(r.below(3, 4, 0, 0xffffffff)[0], Number((BigInt(w) * 0xffffffffn) >> 32n), 'below is exact past 2^53');
});

test('out-of-range seeds, solvers, ticks and bounds throw RangeError', () => {
  const r = new RandomStream(0, 0);
  assert.throws(() => new RandomStream(2 ** 32, 0), RangeError);
  assert.throws(() => new RandomStream(0, -1), RangeError);
  assert.throws(() => r.uniform(-1, 0), RangeError);
  assert.throws(() => r.uniform(2 ** 53, 0), RangeError);
  assert.throws(() => r.uniform(0, 0, 2 ** 32), RangeError);
  assert.throws(() => r.below(0, 0, 0, 0), RangeError);
});

test('solverNumber is the 32-bit FNV-1a hash of the UTF-8 id', () => {
  // Eastlake et al., "The FNV Non-Cryptographic Hash Algorithm", IETF draft: offset basis and test strings.
  assert.equal(solverNumber(''), 0x811c9dc5);
  assert.equal(solverNumber('a'), 0xe40c292c);
  assert.equal(solverNumber('foobar'), 0xbf9cf968);
  assert.equal(solverNumber('é'), Math.imul(Math.imul(0x811c9dc5 ^ 0xc3, 0x01000193) ^ 0xa9, 0x01000193) >>> 0);
});
