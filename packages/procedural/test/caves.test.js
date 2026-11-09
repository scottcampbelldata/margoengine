import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createCaveGenerator } from '../dist/caves.js';
import { reference, islandGrid } from './caves-reference.js';

test('kernel rejection preserves the allocation length required for safe release', async () => {
  const {
    instance: { exports: k },
  } = await WebAssembly.instantiate(readFileSync(new URL('../dist/caves.wasm', import.meta.url)));
  for (const [w, h, d] of [
    [0, 48, 1],
    [1025, 48, 1],
    [64, 48, 2],
    [1024, 1024, 256],
  ]) {
    const p = k.generate(w, h, d, 1, 5, 0.45, 1, 5, 4, 0);
    const header = new DataView(k.memory.buffer, p, 16),
      length = header.getUint32(0, true);
    assert.equal(length, 16);
    assert.equal(header.getUint32(4, true), 0);
    k.release(p, length);
  }
});

test('seeded 2D/3D caves and islands exactly match synchronous scalar rules and owned outputs', async () => {
  using generator = await createCaveGenerator();
  for (const depth of [1, 3, 11])
    for (const mode of ['caves', 'islands'])
      for (const seed of [0, 1, 7, 0xffffffff]) {
        const options = { width: 19, height: 17, depth, seed, mode, steps: 7 };
        const map = generator.generate(options),
          saved = map.cells.slice();
        assert.deepEqual(map.cells, reference(options));
        assert.deepEqual(generator.generate(options).cells, saved);
        generator.generate({ ...options, seed: 123 });
        assert.deepEqual(map.cells, saved, 'Wasm output is copied before release');
        assert.ok(map.stencilReads <= map.directReads);
        if (depth !== 3) assert.ok(map.stencilReads < map.directReads);
      }
  assert.notDeepEqual(generator.generate({ seed: 0 }).cells, generator.generate({ seed: 1 }).cells);
  assert.deepEqual(generator.generate().cells, reference({ width: 64, height: 48 }));
});

test('real public-domain Natural Earth Madagascar mask matches the scalar automaton byte for byte', async () => {
  const base = new URL('./fixtures/caves/', import.meta.url),
    ref = JSON.parse(readFileSync(new URL('reference.json', base))),
    bytes = readFileSync(new URL('ne_110m_land.geojson', base));
  assert.equal(bytes.length, ref.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), ref.sha256);
  const initial = islandGrid(JSON.parse(bytes), ref),
    snapshot = initial.slice();
  assert.ok(initial.reduce((a, b) => a + b, 0) > 1000, 'real island has land');
  assert.ok(initial.includes(0), 'real reference has sea');
  using generator = await createCaveGenerator();
  const options = { width: ref.width, height: ref.height, initial, mode: 'islands', steps: 5 };
  const map = generator.generate(options);
  assert.deepEqual(map.cells, reference(options));
  assert.deepEqual(initial, snapshot, 'input remains caller-owned');
  assert.notDeepEqual(map.cells, initial, 'real coast exercises smoothing');
  assert.ok(map.stencilReads < map.directReads);
});

test('zero steps, tiny grids, fill extremes and rule extremes are exact stand-in controls', async () => {
  using generator = await createCaveGenerator();
  for (const depth of [1, 3, 5])
    for (const steps of [0, 1, 64])
      for (const fill of [0, 1])
        for (const mode of ['caves', 'islands']) {
          const options = { width: 3, height: 5, depth, steps, fill, mode, birth: 0, survival: depth === 1 ? 8 : 26 };
          const map = generator.generate(options);
          assert.deepEqual(map.cells, reference(options));
          const inner = (options.width - 2) * (options.height - 2) * (depth === 1 ? 1 : depth - 2);
          assert.equal(map.directReads, inner * steps * (depth === 1 ? 9 : 27));
          assert.ok(map.stencilReads <= map.directReads);
        }
});

test('maximum dimensions, volume and step-work bounds run without truncation', async () => {
  using generator = await createCaveGenerator();
  for (const options of [
    { width: 1024, height: 1024, steps: 16, fill: 0, mode: 'islands' },
    { width: 64, height: 64, depth: 256, steps: 1, fill: 1 },
    { width: 3, height: 3, steps: 64, fill: 1 },
  ]) {
    const map = generator.generate(options);
    assert.equal(map.cells.length, options.width * options.height * (options.depth ?? 1));
    assert.ok(map.cells.every((v) => v === (options.fill ?? 0)));
    assert.ok(Number.isSafeInteger(map.stencilReads) && map.stencilReads <= map.directReads);
  }
});

test('hostile numbers, malformed grids and unsupported modes fail with coded help links', async () => {
  using generator = await createCaveGenerator();
  const bad = [];
  for (const key of ['width', 'height', 'depth', 'seed', 'steps', 'birth', 'survival', 'fill'])
    for (const value of [NaN, Infinity, -Infinity, -1, Number.MAX_VALUE, '4', 1n, Symbol('bad')])
      bad.push({ [key]: value });
  bad.push(
    { width: 0 },
    { height: 2 },
    { depth: 2 },
    { depth: 257 },
    { width: 1025 },
    { seed: 2 ** 32 },
    { seed: 0.1 },
    { steps: 65 },
    { steps: 0.5 },
    { fill: 1.001 },
    { mode: '' },
    { mode: 'island' },
    { width: 1024, height: 1024, steps: 17 },
    { width: 1024, height: 1024, depth: 3 },
    { birth: 9 },
    { survival: 9 },
    { depth: 3, birth: 27 },
    { depth: 3, survival: 27 },
    { initial: [] },
    { initial: new Uint8Array(0) },
    { initial: new Uint8Array(64 * 48).fill(2) },
  );
  for (const options of bad)
    assert.throws(
      () => generator.generate(options),
      (e) => e.code === 'failed' && e.message.includes('https://margoengine.com/errors#procedural'),
      Object.keys(options).join(','),
    );
});

test('abort reasons, disposal, repeated instances and output lifetime', async () => {
  const controller = new AbortController(),
    reason = new Error('caller abort');
  controller.abort(reason);
  await assert.rejects(createCaveGenerator({ signal: controller.signal }), (e) => e === reason);
  const a = await createCaveGenerator(),
    b = await createCaveGenerator();
  assert.throws(
    () => a.generate({ signal: controller.signal }),
    (e) => e === reason,
  );
  const map = a.generate();
  const saved = map.cells.slice();
  a.dispose();
  a[Symbol.dispose]();
  assert.throws(
    () => a.generate(),
    (e) => e.code === 'disposed' && e.message.includes('https://'),
  );
  assert.deepEqual(map.cells, saved);
  assert.deepEqual(b.generate().cells, saved);
  b.dispose();
});
