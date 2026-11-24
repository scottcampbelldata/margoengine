import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { Noise } from '../dist/index.js';

const samples = [];
for (let i = 0; i < 16; i++)
  for (let j = 0; j < 16; j++)
    for (let k = 0; k < 4; k++) samples.push([i * 0.37 - 3, j * 0.61 - 4.2, k * 1.25 - 2]);
// Lattice boundaries, negative zero and coordinates far from the origin.
samples.push([0, 0, 0], [-0, 1, -1], [2, 3, 4], [0.999999999, 1e-12, -1e-12], [9999999.5, -9999999.25, 1234567.875]);

function imulCalls(run) {
  const imul = Math.imul;
  let calls = 0;
  Math.imul = (a, b) => {
    calls++;
    return imul(a, b);
  };
  try {
    run();
  } finally {
    Math.imul = imul;
  }
  return calls;
}

test('worley hashes only cells that can still hold the nearest feature', () => {
  const noise = new Noise(7);
  // Parent: 1,536,000 multiplies, every one of 125 cells hashed three times (4 multiplies each) for 1024 samples.
  assert.equal(imulCalls(() => samples.slice(0, 1024).forEach(([x, y, z]) => noise.worley(x, y, z))), 183696);
});

test('worley values keep the parent bytes for three seeds', () => {
  const hash = createHash('sha256');
  for (const seed of [1, 7, -123456789]) {
    const noise = new Noise(seed);
    hash.update(new Uint8Array(Float64Array.from(samples, ([x, y, z]) => noise.worley(x, y, z)).buffer));
  }
  assert.equal(hash.digest('hex'), 'fa71899e983c10959a7ac96ebd295e88a7071b64059f05804296c9d273325bad');
});
