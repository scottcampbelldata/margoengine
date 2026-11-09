import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPoissonSampler } from '../dist/poisson.js';

function spacing(result, radius) {
  const { positions: p, dimensions: d } = result;
  for (let i = 0; i < p.length; i += d)
    for (let j = 0; j < i; j += d) {
      let squared = 0;
      for (let k = 0; k < d; k++) squared += (p[i + k] - p[j + k]) ** 2;
      assert.ok(squared >= radius * radius, `separation ${Math.sqrt(squared)} < ${radius}`);
    }
}
test('seeded rectangle placement has independent minimum-distance and bounds proofs', async () => {
  using sampler = await createPoissonSampler();
  for (const seed of [0, 1, 17, 0xffffffff]) {
    const options = { radius: 0.7, seed, attempts: 6000 };
    const a = sampler.rectangle([-4, -3, 8, 7], options);
    assert.deepEqual(a, sampler.rectangle([-4, -3, 8, 7], options));
    assert.ok(a.positions.length > 200);
    spacing(a, options.radius);
    for (let i = 0; i < a.positions.length; i += 2) {
      assert.ok(a.positions[i] >= -4 && a.positions[i] < 8);
      assert.ok(a.positions[i + 1] >= -3 && a.positions[i + 1] < 7);
    }
    assert.equal(a.attempts, options.attempts);
  }
});
test('surface candidates stay on area-weighted triangles, including disconnected and sloped faces', async () => {
  using sampler = await createPoissonSampler();
  const triangles = new Float64Array([0, 0, 0, 1, 0, 1, 0, 1, 1, 10, 0, 0, 12, 0, 2, 10, 2, 2]);
  const a = sampler.surface(triangles, { radius: 1e-6, maxPoints: 10000, attempts: 10000, seed: 19 });
  let small = 0;
  for (let i = 0; i < a.positions.length; i += 3) {
    const [x, y, z] = a.positions.slice(i, i + 3),
      localX = x < 5 ? x : x - 10;
    if (x < 5) small++;
    assert.ok(localX >= 0 && y >= 0 && localX + y <= (x < 5 ? 1 : 2));
    assert.ok(Math.abs(z - localX - y) <= 1e-15);
  }
  assert.ok(small > 1800 && small < 2200, '1:4 area ratio, fixed seeded 10000-sample fixture');
  const crowded = sampler.surface(triangles, { radius: 0.14, attempts: 6000 });
  spacing(crowded, 0.14);
  assert.deepEqual(triangles, new Float64Array([0, 0, 0, 1, 0, 1, 0, 1, 1, 10, 0, 0, 12, 0, 2, 10, 2, 2]));
});
test('empty, zero, huge, nonfinite, malformed, aborted and disposed inputs are bounded', async () => {
  const sampler = await createPoissonSampler();
  const valid = { radius: 1 };
  const coded = (e) => e.code === 'failed' && e.message.includes('https://margoengine.com/errors#procedural');
  for (const bounds of [
    [],
    [0, 0, 0, 1],
    [0, 0, 1, 0],
    [0, 0, NaN, 1],
    [0, 0, Infinity, 1],
    [0, 0, 1e20, 1],
    ['0', 0, 1, 1],
  ])
    assert.throws(() => sampler.rectangle(bounds, valid), coded);
  for (const options of [
    {},
    { radius: 0 },
    { radius: NaN },
    { radius: 1e-10 },
    { radius: Infinity },
    { radius: 1, seed: -1 },
    { radius: 1, attempts: 2e6 + 1 },
    { radius: 1, maxPoints: 65537 },
  ])
    assert.throws(() => sampler.rectangle([0, 0, 1, 1], options), coded);
  for (const data of [
    [],
    new Float64Array(8),
    new Float64Array(9).fill(NaN),
    new Float64Array(9).fill(1e20),
    new Float64Array(589833),
  ])
    assert.throws(() => sampler.surface(data, valid), coded);
  for (const data of [new Float32Array(), new Float64Array(9)])
    assert.equal(sampler.surface(data, valid).positions.length, 0);
  assert.equal(
    sampler.surface(new Float64Array([0, 0, 0, 1e-150, 0, 0, 0, 1e-150, 0]), valid).positions.length,
    3,
    'scaled norm preserves a representable tiny triangle area',
  );
  assert.equal(sampler.rectangle([0, 0, 1, 1], { ...valid, maxPoints: 0 }).attempts, 0);
  assert.equal(sampler.rectangle([0, 0, 1, 1], { ...valid, attempts: 0 }).positions.length, 0);
  assert.equal(sampler.rectangle([-1e6, -1e6, 1e6, 1e6], { radius: 1e6, attempts: 1000 }).dimensions, 2);
  const signal = AbortSignal.abort();
  await assert.rejects(createPoissonSampler({ signal }), { name: 'AbortError' });
  assert.throws(() => sampler.rectangle([0, 0, 1, 1], { ...valid, signal }), { name: 'AbortError' });
  const held = sampler.rectangle([0, 0, 1, 1], valid),
    copy = held.positions.slice();
  sampler.dispose();
  sampler[Symbol.dispose]();
  assert.deepEqual(held.positions, copy);
  assert.throws(() => sampler.rectangle([0, 0, 1, 1], valid), { code: 'disposed' });
});
test('Wasm hash rejection matches a float64 all-pairs oracle with fewer distance checks', async () => {
  const bytes = await readFile(new URL('../dist/poisson.wasm', import.meta.url));
  const {
    instance: { exports: k },
  } = await WebAssembly.instantiate(bytes);
  let seed = 71;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  const input = Float64Array.from({ length: 9000 }, () => random() * 30 - 15),
    radius = 1;
  const expected = [];
  let checks = 0;
  for (let i = 0; i < input.length; i += 3) {
    let accepted = true;
    for (let j = 0; j < expected.length; j += 3) {
      checks++;
      const x = input[i] - expected[j],
        y = input[i + 1] - expected[j + 1],
        z = input[i + 2] - expected[j + 2];
      if (x * x + y * y + z * z < radius * radius) {
        accepted = false;
        break;
      }
    }
    if (accepted) expected.push(...input.slice(i, i + 3));
  }
  const at = k.allocate(input.length);
  new Float64Array(k.memory.buffer, at, input.length).set(input);
  const out = k.sample(at, input.length, radius, 1, 65536, 0, 2);
  const count = new Float64Array(k.memory.buffer, out, 3)[0],
    comparisons = new Float64Array(k.memory.buffer, out, 3)[2];
  assert.deepEqual([...new Float64Array(k.memory.buffer, out + 24, count * 3)], expected);
  assert.ok(comparisons * 100 < checks, `${comparisons} < ${checks}/100`);
  assert.equal(comparisons, 3329, 'published deterministic hash work count');
  assert.equal(checks, 3445553, 'published deterministic all-pairs work count');
  console.log(
    JSON.stringify({
      poissonWork: { hashComparisons: comparisons, allPairsComparisons: checks, identicalCoordinates: true },
    }),
  );
  k.release(out, 3 + count * 3);
  k.release(at, input.length);
});
