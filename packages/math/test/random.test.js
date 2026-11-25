// `@margoengine/math/random`, through its package entry, gives the Rust generator's words (kernel-common's K02).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { RandomStream } from '@margoengine/math/random';

test("the package entry's stream gives the pinned words of random-vectors.txt", () => {
  const text = readFileSync(new URL('../../physics/kernel-common/tests/random-vectors.txt', import.meta.url), 'utf8'),
    [seed, solver, tick, element, stream, ...words] = text
      .split('\n')
      .find((line) => line && !line.startsWith('#'))
      .trim()
      .split(/\s+/),
    got = new RandomStream(Number(seed), Number(solver)).block(Number(tick), Number(element), Number(stream));
  assert.equal(Array.from(got, (w) => w.toString(16).padStart(8, '0')).join(' '), words.join(' '));
});
