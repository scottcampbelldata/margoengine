import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Noise } from '../dist/noise.js';

// Recorded before the gradient lookup was rewritten as a table: the same seeds must give the same fields.
const vectors = JSON.parse(readFileSync(new URL('./fixtures/perlin-vectors.json', import.meta.url), 'utf8'));

test('perlin keeps every seeded sample exactly (index-to-gradient order unchanged)', () => {
  for (const [seed, values] of Object.entries(vectors.samples)) {
    const noise = new Noise(Number(seed));
    vectors.points.forEach(([x, y, z], i) => {
      assert.ok(Math.abs(noise.perlin(x, y, z) - values[i]) <= 1e-12, `seed ${seed} point ${i}`);
    });
  }
});

test('perlin is zero on the lattice and keeps its spread', () => {
  const noise = new Noise(vectors.statistics.seed);
  for (let x = -5; x <= 5; x++) for (let z = -5; z <= 5; z++) assert.equal(Math.abs(noise.perlin(x, 3, z)), 0);
  // Deterministic xorshift sample positions in [-1000, 1000]^3.
  let state = 12345,
    sum = 0,
    squares = 0,
    min = Infinity,
    max = -Infinity;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) / 4294967296) * 2000 - 1000;
  };
  const count = 100000;
  for (let i = 0; i < count; i++) {
    const v = noise.perlin(next(), next(), next());
    sum += v;
    squares += v * v;
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  const mean = sum / count,
    std = Math.sqrt(squares / count - mean * mean);
  assert.ok(Math.abs(mean) < 0.01, `mean ${mean}`);
  assert.ok(Math.abs(std - vectors.statistics.std) < 0.01, `std ${std}`);
  assert.ok(min > -1.05 && max < 1.05, `range ${min}..${max}`);
});

test('island heights for seed 731 are unchanged', async () => {
  const { createIslandHeight } = await import('../dist/index.js');
  const height = createIslandHeight(731);
  for (const { x, z, height: expected } of vectors.islandHeight731)
    assert.ok(Math.abs(height(x, z) - expected) <= 1e-12, `(${x}, ${z})`);
});
