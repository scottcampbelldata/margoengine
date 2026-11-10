import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildParallel } from '@margoengine/bvh/parallel';
import { MeshBVH } from '../dist/tree.js';
import { BrowserWorker } from './worker-adapter.js';
import { parseObj, rng, soup, randomRay } from './reference.js';

const real = parseObj(readFileSync(new URL('./fixtures/bean.obj', import.meta.url), 'utf8'));
const same = (a, b) => {
  assert.deepEqual(new Uint32Array(a.nodes), new Uint32Array(b.nodes));
  assert.deepEqual(a.index, b.index);
  assert.deepEqual(a.triangles, b.triangles);
};

test('one million triangles build across four leaf workers without changing any tree bytes', {
  timeout: 120000,
}, async () => {
  globalThis.Worker = BrowserWorker;
  try {
    const source = soup(rng(221001), 1000000),
      before = BrowserWorker.leaves;
    same(await buildParallel(source, { workers: 4 }), MeshBVH.build(source));
    assert.equal(BrowserWorker.leaves - before, 4);
  } finally {
    delete globalThis.Worker;
  }
});

test('real multi-worker builds retain serial SAH topology, depth, precision and all query results', {
  timeout: 120000,
}, async () => {
  globalThis.Worker = BrowserWorker;
  try {
    const random = rng(221),
      mesh = soup(random, 16000);
    const coincident = { positions: new Float32Array(9000) };
    const double = {
      positions: Float64Array.from(mesh.positions, (v) => v + 100000000.00001),
      indices: mesh.indices,
      precision: 'float64',
    };
    const strided = { positions: new Float32Array(mesh.positions.length * 2), indices: mesh.indices, stride: 6 };
    mesh.positions.forEach((v, i) => {
      strided.positions[Math.floor(i / 3) * 6 + (i % 3)] = v;
    });
    for (const source of [mesh, real, coincident, double, strided]) {
      const original = source.indices?.slice();
      for (const options of [
        { workers: 3 },
        { workers: 2, strategy: 'center', maxLeafTriangles: 2 },
        { workers: 4, maxDepth: 2 },
        { workers: 1, maxDepth: 9, bins: 4 },
      ]) {
        const parallel = await buildParallel(source, options),
          serial = MeshBVH.build(source, options);
        same(parallel, serial);
        assert.deepEqual(source.indices, original, 'caller index order is untouched');
        for (let i = 0; i < 10; i++) {
          const ray = randomRay(random);
          assert.deepEqual(parallel.raycast(ray), serial.raycast(ray));
          assert.deepEqual(parallel.closestPointToPoint(ray.origin), serial.closestPointToPoint(ray.origin));
        }
        same(MeshBVH.deserialize(parallel.serialize(), source), serial);
        source.positions[0] += 0.25;
        parallel.refit();
        serial.refit();
        same(parallel, serial);
      }
    }
    assert.equal(BrowserWorker.active.size, 0, 'each coordinator was terminated');
    assert.ok(BrowserWorker.leaves >= 3, 'real coordinator started multiple leaf threads');
  } finally {
    delete globalThis.Worker;
  }
});

test('cloned-input parallel path works without SharedArrayBuffer', { timeout: 30000 }, async () => {
  globalThis.Worker = BrowserWorker;
  BrowserWorker.noShared = true;
  const source = soup(rng(9), 3000);
  try {
    same(await buildParallel(source, { workers: 2 }), MeshBVH.build(source));
  } finally {
    delete globalThis.Worker;
    BrowserWorker.noShared = false;
  }
});

test('SSR fallback, argument rejection and cancellation', { timeout: 30000 }, async () => {
  same(await buildParallel(real), MeshBVH.build(real));
  for (const workers of [0, 1.5, 65, NaN]) await assert.rejects(buildParallel(real, { workers }), RangeError);
  for (const timeoutMs of [0, -1, Infinity, 2147483648])
    await assert.rejects(buildParallel(real, { timeoutMs }), RangeError);
  await assert.rejects(buildParallel(real, { bins: 2 }), RangeError);
  const pre = new AbortController();
  pre.abort(new Error('cancelled before startup'));
  await assert.rejects(buildParallel(real, { signal: pre.signal }), /cancelled before/);
  globalThis.Worker = BrowserWorker;
  try {
    const controller = new AbortController();
    const job = buildParallel(real, { workers: 3, signal: controller.signal });
    controller.abort(new Error('cancelled during startup'));
    await assert.rejects(job, /cancelled during/);
    assert.equal(BrowserWorker.active.size, 0);
    await assert.rejects(buildParallel({ positions: [0, NaN, 0, 0, 1, 0, 1, 0, 0] }), /finite/);
    same(await buildParallel(real, { workers: 2 }), MeshBVH.build(real));
  } finally {
    delete globalThis.Worker;
  }
});

test('worker failure, message failure, post failure and hard deadline release resources', {
  timeout: 10000,
}, async () => {
  let stopped = 0;
  class FakeWorker {
    terminate() {
      stopped++;
    }
    postMessage() {}
  }
  globalThis.Worker = FakeWorker;
  try {
    await assert.rejects(buildParallel(real, { timeoutMs: 10 }), (error) => error.code === 'timeout');
    FakeWorker.prototype.postMessage = function () {
      queueMicrotask(() => this.onerror({ message: 'load failed' }));
    };
    await assert.rejects(buildParallel(real), /load failed/);
    FakeWorker.prototype.postMessage = function () {
      queueMicrotask(() => this.onmessageerror());
    };
    await assert.rejects(buildParallel(real), /deserialized/);
    FakeWorker.prototype.postMessage = function () {
      throw new TypeError('clone failed');
    };
    await assert.rejects(buildParallel(real), /clone failed/);
    assert.equal(stopped, 4);
  } finally {
    delete globalThis.Worker;
  }
});
