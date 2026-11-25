// Counter-based random numbers of the physics framework: Philox4x32-10 matching the published answers and, word for word,
// the kernels' Rust generator; a pure function of (seed, solver, tick, element, stream), so the order of draws never
// changes a number.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { RandomStream, philox, solverNumber } from '../dist/world.js';

const hex = (a) => Array.from(a, (v) => v.toString(16).padStart(8, '0')).join(' ');

test('Philox4x32-10 gives the published answers', () => {
  // Salmon, Moraes, Dror and Shaw 2011: the known answers for Philox4x32-10.
  assert.equal(hex(philox(0, 0, 0, 0, 0, 0)), '6627e8d5 e169c58d bc57ac4c 9b00dbd8');
  assert.equal(hex(philox(~0, ~0, ~0, ~0, ~0, ~0)), '408f276d 41c83b0e a20bc7c6 6d5451fd');
  assert.equal(
    hex(philox(0x243f6a88, 0x85a308d3, 0x13198a2e, 0x03707344, 0xa4093822, 0x299f31d0)),
    'd16cfe09 94fdcceb 5001e420 24126ea1',
  );
});

test("a stream gives the Rust generator's words (the vectors kernel-common's random_twin test pins)", () => {
  const text = readFileSync(new URL('../kernel-common/tests/random-vectors.txt', import.meta.url), 'utf8');
  let checked = 0;
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [seed, solver, tick, element, stream, ...words] = line.trim().split(/\s+/);
    const got = new RandomStream(Number(seed), Number(solver)).block(Number(tick), Number(element), Number(stream));
    assert.equal(hex(got), words.join(' '), line);
    checked++;
  }
  assert.equal(checked, 8);
});

test('a stream is keyed by seed and solver and counted by tick, element and stream', () => {
  const r = new RandomStream(7, solverNumber('ocean'));
  const forward = [0, 1, 2, 3].map((e) => r.uniform(5, e)),
    backward = [3, 2, 1, 0].map((e) => r.uniform(5, e)).reverse();
  assert.deepEqual(forward, backward, 'any order of draws gives the same numbers');
  assert.notEqual(r.uniform(5, 0), r.uniform(5, 0, 1), 'another stream');
  assert.notEqual(r.uniform(5, 0), new RandomStream(7, solverNumber('wind')).uniform(5, 0), 'another solver');
  assert.notEqual(r.uniform(5, 0), new RandomStream(8, solverNumber('ocean')).uniform(5, 0), 'another seed');
  assert.notEqual(r.uniform(2 ** 40, 0), r.uniform(0, 0), 'ticks past 2^32 use the high word');
  // Uniform in [0, 1): a mean of a half within 4 standard errors over 20,000 draws, each a multiple of 2^-53.
  let sum = 0;
  for (let i = 0; i < 20000; i++) {
    const [u, v] = r.unitF64(i, 0);
    assert.ok(u >= 0 && u < 1 && v >= 0 && v < 1);
    assert.equal(u * 2 ** 53, Math.floor(u * 2 ** 53));
    sum += u;
  }
  assert.ok(Math.abs(sum / 20000 - 0.5) < 4 * Math.sqrt(1 / 12 / 20000), `mean ${sum / 20000}`);
  for (const x of r.unitF32(3, 4)) assert.ok(x >= 0 && x < 1 && x * 2 ** 24 === Math.floor(x * 2 ** 24));
  for (const n of r.below(3, 4, 0, 6)) assert.ok(n < 6);
  // below() is the high word of x * n, exactly, even where the product passes 2^53.
  const [w] = r.block(3, 4, 0);
  assert.equal(r.below(3, 4, 0, 0xffffffff)[0], Number((BigInt(w) * 0xffffffffn) >> 32n));
  assert.throws(() => r.uniform(-1, 0), RangeError);
  assert.throws(() => r.uniform(0, 0, 2 ** 32), RangeError);
  assert.throws(() => new RandomStream(2 ** 32, 0), RangeError, 'a seed is one 32-bit word');
  assert.throws(() => new RandomStream(0, 2 ** 32), RangeError);
  assert.notEqual(
    new RandomStream(1, 1).uniform(0, 0),
    new RandomStream(1, 1 + 2 ** 16).uniform(0, 0),
    'a solver number keeps its high bits',
  );
  assert.notEqual(r.uniform(0, 0, 1), r.uniform(0, 0, 1 + 2 ** 16), 'a stream is a whole word');
});

test("a solver's number is the whole 32-bit FNV-1a of its id, the same in every world", () => {
  // FNV-1a 32-bit of "", "a" and "foobar" is 811c9dc5, e40c292c and bf9cf968 (the published values).
  assert.equal(solverNumber(''), 0x811c9dc5);
  assert.equal(solverNumber('a'), 0xe40c292c);
  assert.equal(solverNumber('foobar'), 0xbf9cf968);
});
