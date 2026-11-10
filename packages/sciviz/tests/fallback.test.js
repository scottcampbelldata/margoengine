import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createFallbackFigure, marchingCubes } from '@margoengine/sciviz/fallback';
import { caseTriangles, CORNERS, EDGES } from '@margoengine/sciviz/maths';
import { parseNRRD } from '@margoengine/loaders/nrrd';
import { build } from 'vite';
import { bare } from '../../../scripts/measure-size.js';

// Independent scalar reference with explicit float32 rounding, matching the WGSL operation order.
const f = Math.fround;
function reference(data, dims, level) {
  const [nx, ny, nz] = dims;
  level = f(level);
  const out = [];
  const at = (p) =>
    data[
      Math.min(nx - 1, Math.max(0, p[0])) +
        nx * (Math.min(ny - 1, Math.max(0, p[1])) + ny * Math.min(nz - 1, Math.max(0, p[2])))
    ];
  const gradient = (p) =>
    p.map((_, axis) => {
      const a = [...p],
        b = [...p];
      a[axis]++;
      b[axis]--;
      return f(at(a) - at(b));
    });
  const mix = (a, b, t) => f(f(a * f(1 - t)) + f(b * t));
  for (let z = 0; z < nz - 1; z++)
    for (let y = 0; y < ny - 1; y++)
      for (let x = 0; x < nx - 1; x++) {
        const base = [x, y, z];
        const points = CORNERS.map((c) => c.map((v, axis) => v + base[axis]));
        let mask = 0;
        for (let c = 0; c < 8; c++) if (at(points[c]) > level) mask |= 1 << c;
        for (const triangle of caseTriangles(mask))
          for (const edge of triangle) {
            const [a, b] = EDGES[edge].map((c) => points[c]);
            const t = Math.min(1, Math.max(0, f(f(level - at(a)) / f(at(b) - at(a)))));
            const ga = gradient(a),
              gb = gradient(b);
            out.push(
              ...a.map((v, axis) => f(mix(v, b[axis], t) / (dims[axis] - 1))),
              1,
              ...ga.map((v, axis) => -mix(v, gb[axis], t)),
              0,
            );
          }
      }
  return new Float32Array(out);
}

test('CPU extraction matches all 256 GPU case-table configurations, winding and gradients', {
  timeout: 20_000,
}, async () => {
  for (let mask = 0; mask < 256; mask++) {
    const data = Float32Array.from({ length: 8 }, (_, c) => (mask & (1 << c) ? 1 : -1));
    const result = await marchingCubes(data, 0, { dims: [2, 2, 2] });
    assert.equal(result.triangles, caseTriangles(mask).length, `case ${mask} count`);
    assert.deepEqual(result.vertices, reference(data, [2, 2, 2], 0), `case ${mask} vertices`);
  }
});

test('SIMD lanes, row tails, float32 levels, chunk boundaries and non-cubic grids match scalar extraction', {
  timeout: 20_000,
}, async () => {
  for (const dims of [
    [3, 4, 5],
    [5, 3, 2],
    [6, 5, 4],
    [9, 7, 6],
    [34, 33, 18],
  ]) {
    const data = Float32Array.from(
      { length: dims.reduce((a, b) => a * b) },
      (_, i) => Math.sin(i * 0.037) + Math.cos(i * 0.13),
    );
    for (const level of [0, 0.300000001]) {
      const result = await marchingCubes(data, level, { dims });
      assert.deepEqual(result.vertices, reference(data, dims, level), `${dims} at ${level}`);
    }
  }
});

test('constant and equal-to-level fields are empty; output budget is enforced before vertex allocation', async () => {
  const data = new Float32Array(8);
  assert.deepEqual(await marchingCubes(data, 0, { dims: [2, 2, 2], maxTriangles: 0 }), {
    triangles: 0,
    vertices: new Float32Array(),
  });
  data[0] = 1;
  await assert.rejects(marchingCubes(data, 0.5, { dims: [2, 2, 2], maxTriangles: 0 }), /maxTriangles 0/);
  assert.equal((await marchingCubes(data, 0.5, { dims: [2, 2, 2] })).triangles, 1);
});

test('pre-abort and an abort during chunked work reject with the exact caller reason', {
  timeout: 10_000,
}, async () => {
  const reason = new Error('cancel extraction');
  await assert.rejects(
    marchingCubes(new Float32Array(8), 0, { dims: [2, 2, 2], signal: AbortSignal.abort(reason) }),
    (e) => e === reason,
  );
  const controller = new AbortController();
  // A getter establishes that Wasm loaded and input upload began, then abort runs at the first work yield.
  const n = 64;
  const data = {
    length: n ** 3,
    get 0() {
      setTimeout(() => controller.abort(reason), 0);
      return 1;
    },
  };
  await assert.rejects(marchingCubes(data, 0.5, { dims: [n, n, n], signal: controller.signal }), (e) => e === reason);
});

test('concurrent calls isolate memory and returned vertices own their storage', async () => {
  const a = new Float32Array([1, -1, -1, -1, -1, -1, -1, -1]);
  const b = Float32Array.from(a, (v) => -v);
  const original = a.slice();
  const results = await Promise.all([
    marchingCubes(a, 0, { dims: [2, 2, 2] }),
    marchingCubes(b, 0, { dims: [2, 2, 2] }),
  ]);
  assert.deepEqual(results[0].vertices, reference(a, [2, 2, 2], 0));
  assert.deepEqual(results[1].vertices, reference(b, [2, 2, 2], 0));
  const saved = results[0].vertices.slice();
  a.fill(99);
  results[1].vertices.fill(0);
  await marchingCubes(original, 0.5, { dims: [2, 2, 2] });
  assert.deepEqual(results[0].vertices, saved);
  assert.equal(results[0].vertices.byteOffset, 0);
  assert.equal(results[0].vertices.buffer.byteLength, results[0].vertices.byteLength);
});

test('invalid dimensions, sample counts, levels and budgets fail before loading or allocating', async () => {
  for (const dims of [undefined, [2, 2], [1, 2, 4], [2.5, 2, 2], [Infinity, 2, 2], [4, 4, 4]])
    await assert.rejects(marchingCubes(new Float32Array(8), 0, { dims }), RangeError);
  for (const level of [NaN, Infinity, -Infinity, Number.MAX_VALUE])
    await assert.rejects(marchingCubes(new Float32Array(8), level, { dims: [2, 2, 2] }), RangeError);
  for (const maxTriangles of [-1, 0.5, NaN, Infinity, 0xffffffff])
    await assert.rejects(marchingCubes(new Float32Array(8), 0, { dims: [2, 2, 2], maxTriangles }), RangeError);
  await assert.rejects(marchingCubes({ length: 800_000_000 }, 0, { dims: [2000, 1000, 400] }), /limit/);
  await assert.rejects(marchingCubes({ length: 300_000_000 }, 0, { dims: [1000, 1000, 300] }), /working-memory limit/);
});

test('the real head MRI extracts the native review triangle count with pinned scalar/SIMD vertices', {
  timeout: 30_000,
}, async () => {
  const file = await readFile(new URL('../../../examples/assets/sciviz/head.nrrd', import.meta.url));
  const volume = await parseNRRD(file);
  const result = await marchingCubes(volume.data, 300, { dims: volume.dims });
  assert.equal(result.triangles, 216_150);
  assert.equal(result.vertices.length, 216_150 * 24);
  assert.equal(
    createHash('sha256').update(new Uint8Array(result.vertices.buffer)).digest('hex'),
    '57d02c9bce60a0d5e342b0551244d6bb12a597802945020f2b62ff60e6475cb9',
  );
});

test('root, bricks and stage never import the optional CPU extraction or its Wasm asset', async () => {
  for (const name of ['index', 'bricks']) {
    const source = await readFile(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /import[^;]*fallback/);
  }
  const stage = await readFile(new URL('../../stage/src/index.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(stage, /sciviz|fallback\.wasm/);
  const wasm = await readFile(new URL('../dist/fallback.wasm', import.meta.url));
  assert.ok(wasm.length < 24_000, `feature-local Wasm ${wasm.length} exceeds its 24,000-byte ceiling`);
  assert.ok(WebAssembly.validate(wasm));
});

test('a consuming build keeps the feature-local Wasm as a lazy file rather than embedding it in JavaScript', {
  timeout: 30_000,
}, async () => {
  const entry = fileURLToPath(new URL('../dist/fallback.js', import.meta.url));
  // The package keeps the instruction for a consuming bundler, which removes the query on the emitted file.
  assert.match(await readFile(entry, 'utf8'), /fallback\.wasm\?no-inline/);
  const result = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    build: { write: false, minify: true, lib: { entry, formats: ['es'] }, rollupOptions: { external: bare } },
  });
  const output = [result].flat().flatMap((r) => r.output);
  const bundle = output
    .filter((r) => r.type === 'chunk')
    .map((r) => r.code)
    .join('\n');
  assert.doesNotMatch(bundle, /data:application\/wasm|AGFzbQE/);
  const wasm = output.filter((r) => r.type === 'asset' && r.fileName.endsWith('.wasm'));
  assert.equal(wasm.length, 1, 'the consuming build emits one separate Wasm file');
  assert.deepEqual(Buffer.from(wasm[0].source), await readFile(new URL('../dist/fallback.wasm', import.meta.url)));
  assert.ok(bundle.includes(wasm[0].fileName), 'the entry references the emitted asset');
});

test('createFallbackFigure installs only the layer the caller passes, and names the fix when it is missing', async () => {
  for (const options of [undefined, {}, { compat: {} }])
    await assert.rejects(createFallbackFigure(null, options), (e) => {
      assert.ok(e instanceof TypeError);
      assert.match(e.message, /pass \{ compat: await import\('@margoengine\/webgl2-compat'\) \}/);
      return true;
    });
  const abort = new AbortController();
  const calls = [];
  const compat = {
    async install(options) {
      calls.push(options);
      abort.abort('stop after install');
    },
  };
  await assert.rejects(createFallbackFigure(null, { compat, signal: abort.signal }), (e) => e === 'stop after install');
  assert.deepEqual(calls, [{ force: true, signal: abort.signal }]);
});
