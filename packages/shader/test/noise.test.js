import test from 'node:test';
import assert from 'node:assert/strict';
import { ComputePass, storage, uniform, vec2, vec3, vec4 } from '../dist/index.js';
import {
  simplex2,
  simplex3,
  simplex4,
  perlin3,
  worley2,
  worley3,
  voronoi2,
  voronoi3,
  fbm,
  ridged,
  domainWarp,
} from '../dist/noise.js';

const count = (text, part) => text.split(part).length - 1;
const compute = (body) =>
  new ComputePass(4, (i) => {
    const p = vec3(i.toFloat(), 0.5, 0.25);
    return storage(4, 'f32').store(i, body(p));
  }).code;

test('noise nodes declare each seed table and helper once per shader', () => {
  const code = compute((p) =>
    simplex3(p, 7)
      .add(simplex2(p.xy, 7))
      .add(simplex3(p.mul(2), 7))
      .add(simplex3(p, 8)),
  );
  assert.equal(count(code, 'var<private> noisePerm7Table'), 1);
  assert.equal(count(code, 'var<private> noisePerm8Table'), 1);
  assert.equal(count(code, 'fn noiseCorner3('), 1);
  assert.equal(count(code, 'fn noisePerm7Simplex3('), 1);
  assert.equal(count(code, 'fn noisePerm7Simplex2('), 1);
  // Seed 0 uses the same table as seed 1, as on the CPU (xorshift state seed >>> 0 || 1).
  assert.match(
    compute((p) => simplex3(p, 0)),
    /noisePerm1Simplex3\(/,
  );
  // The packed table holds the CPU permutation: seed 1's first entries, little-endian bytes.
  const table = /noisePerm1Table: array<u32, 64> = array<u32, 64>\(([^)]*)\)/
    .exec(compute((p) => simplex3(p, 1)))[1]
    .split(', ')
    .map((v) => parseInt(v));
  assert.equal(table.length, 64);
  assert.deepEqual(new Set(new Uint8Array(Uint32Array.from(table).buffer)).size, 256);
});

test('4D simplex shares the seed table and folds like the other fields', () => {
  const code = compute((p) => simplex4(vec4(p, 0.5), 7).add(simplex3(p, 7)));
  assert.equal(count(code, 'var<private> noisePerm7Table'), 1);
  assert.equal(count(code, 'fn noisePerm7Simplex4('), 1);
  assert.equal(count(code, 'fn noiseCorner4('), 1);
  assert.equal(fbm((q) => simplex4(q, 3), vec4(1), { octaves: 2 }).type, 'f32');
  assert.equal(ridged((q) => simplex4(q, 3), vec4(1), { octaves: 2 }).type, 'f32');
  assert.match(
    compute((p) => domainWarp((q) => simplex4(q, 3), vec4(p, 1))),
    /noisePerm3Simplex4/,
  );
  assert.throws(() => simplex4(vec3(1), 1), /simplex4 position must be vec4f/);
  assert.throws(() => simplex4(vec4(1), 1.5), RangeError);
});

test('cellular nodes hash once per shader, take live seeds and share one search', () => {
  const seed = uniform(3, { type: 'u32', name: 'seed' }),
    code = compute((p) => worley3(p, seed).add(voronoi3(p, seed).y).add(perlin3(p, 1)).add(worley2(p.xy)));
  assert.equal(count(code, 'fn noiseHash('), 1);
  assert.equal(count(code, 'fn noiseVoronoi3('), 1);
  assert.equal(count(code, 'noiseVoronoi3(p'), 1);
  assert.equal(voronoi2(vec2(0)).type, 'vec3f');
  assert.equal(worley3(vec3(0)).type, 'f32');
  assert.throws(() => worley2(vec2(0), 0.5), RangeError);
});

test('perlin takes a constant or a live u32 seed; fractal sums unroll', () => {
  assert.match(
    compute((p) => perlin3(p, -1)),
    /noisePerlin3\(vec3f\([^;]*, 4294967295u\)/,
  );
  const seed = uniform(5, { type: 'u32', name: 'seed' }),
    live = compute((p) => perlin3(p, seed));
  assert.match(live, /noisePerlin3\([^;]*ndu\.seed\)/);
  const f = compute((p) => fbm((q) => simplex3(q, 3), p, { octaves: 4 }));
  assert.equal(count(f, 'noisePerm3Simplex3('), 5, 'one declaration and four octave calls');
  assert.match(f, /\/ 1\.875/);
  assert.equal(
    count(
      compute((p) => ridged((q) => simplex2(q, 3), p.xy, { octaves: 3 })),
      'abs(',
    ),
    3,
  );
  const warped = compute((p) => domainWarp((q) => simplex3(q, 3), p, { strength: 0.5 }));
  assert.equal(count(warped, 'noisePerm3Simplex3('), 5, 'three warp samples, the warped sample and the declaration');
  assert.match(
    compute((p) => domainWarp((q) => simplex2(q), p.xy)),
    /vec2f\(/,
  );
});

test('noise nodes validate their inputs', () => {
  assert.throws(() => simplex3(vec2(0, 1)), /simplex3 position must be vec3f/);
  assert.throws(() => simplex2(vec2(0, 1), 0.5), /seed/);
  assert.throws(() => perlin3(vec3(0), NaN), /seed/);
  assert.throws(() => fbm((q) => simplex3(q), vec3(0), { octaves: 17 }), /fractal/);
  assert.throws(() => domainWarp((q) => simplex3(q), vec3(0), { strength: Infinity }), /warp/);
});
