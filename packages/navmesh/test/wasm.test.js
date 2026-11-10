import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { Worker as Thread } from 'node:worker_threads';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { buildNavMeshInWorker, buildTiledNavMeshInWorker } from '../dist/wasm.js';
import { buildNavMesh } from '../dist/build.js';
import { TiledNavMesh } from '../dist/tiles.js';
import { encodeNavMesh, encodeTiledNavMesh } from '../dist/codec.js';
import { bundleBytes } from '../../../scripts/measure-size.js';
import binaryen from 'binaryen';

const previous = globalThis.Worker;
let active = 0,
  created;
class WorkerHost {
  constructor(url) {
    active++;
    this.thread = new Thread(new URL('./support/build-worker-host.mjs', import.meta.url), {
      workerData: { url: url.href },
    });
    this.thread.on('message', (data) => this.onmessage?.({ data }));
    this.thread.on('error', (error) => this.onerror?.({ message: error.message, preventDefault() {} }));
    created?.();
  }
  postMessage(data, transfer) {
    this.thread.postMessage(data, transfer);
  }
  terminate() {
    if (!this.stopped) {
      this.stopped = true;
      active--;
      return this.thread.terminate();
    }
  }
}
globalThis.Worker = WorkerHost;
after(() => {
  globalThis.Worker = previous;
  assert.equal(active, 0);
});

const floor = [0, 0, 0, 16, 0, 0, 16, 0, 16, 0, 0, 16],
  indices = [0, 2, 1, 0, 3, 2];
const settings = { cs: 0.5, ch: 0.1, walkableRadius: 0, minRegionArea: 0 };
const controls = { timeout: 30000 };

test('real CPU worker Rust SIMD builds byte-identical meshes for floors, ramps, obstacles and irregular triangles', async () => {
  const cases = [
    [floor, indices, settings],
    [[0, 0, 0, 16, 4, 0, 16, 4, 16, 0, 0, 16], indices, { ...settings, detailSampleDist: 1 }],
    [
      floor,
      indices,
      {
        ...settings,
        obstacles: [{ min: [6, -1, 2], max: [8, 3, 13] }],
        areas: [{ min: [0, -1, 0], max: [5, 2, 16], area: 7 }],
      },
    ],
    [
      [-3, 0.2, -2, 10, 1, 0, 8, 0.8, 15, -1, 0.1, 8],
      [0, 1, 2, 0, 2, 3],
      { ...settings, walkableClimb: 4, detailSampleDist: 0 },
    ],
  ];
  for (const [p, i, o] of cases) {
    const before = [...p],
      expected = buildNavMesh(p, i, o),
      actual = await buildNavMeshInWorker(p, i, o, controls);
    assert.deepEqual(encodeNavMesh(actual.mesh), encodeNavMesh(expected));
    assert.deepEqual(p, before);
    assert.equal(actual.work.rasterCalls, 1);
    assert.ok(actual.work.vectorPairs > 0);
    assert.equal(active, 0);
  }
});

test('worker tiled build matches every polygon and retains runtime geometry for ordinary rebuilds', async () => {
  const options = { ...settings, tileSize: 8, obstacles: [{ min: [7, -1, 0], max: [9, 3, 10] }] };
  using expected = new TiledNavMesh(floor, indices, options);
  const built = await buildTiledNavMeshInWorker(floor, indices, options, controls);
  using actual = built.mesh;
  assert.deepEqual(encodeTiledNavMesh(actual, { geometry: true }), encodeTiledNavMesh(expected, { geometry: true }));
  assert.ok(built.work.rasterCalls > 1);
  const obstacle = { min: [1, -1, 3], max: [3, 3, 5] };
  actual.addObstacle(obstacle);
  expected.addObstacle(obstacle);
  actual.update();
  expected.update();
  assert.deepEqual(encodeTiledNavMesh(actual, { geometry: true }), encodeTiledNavMesh(expected, { geometry: true }));
});

test('SIMD work counts equal the reference clipper and replace two scalar interpolation lanes per intersection', async (t) => {
  await mkdir('test-results', { recursive: true });
  const path = new URL('../../../test-results/batch252-pipeline.mjs', import.meta.url);
  await writeFile(path, await bundleBytes('packages/navmesh/src/pipeline.ts'));
  const reference = await import(path.href),
    input = reference.validate(floor, indices, settings),
    voxel = reference.voxelise(input.points, input.triangles, input.config, reference.gridOf(input)),
    { work } = await buildNavMeshInWorker(floor, indices, settings, controls);
  assert.equal(work.cells, voxel.cells);
  assert.equal(work.intersections, voxel.intersections);
  assert.equal(work.vectorPairs, voxel.intersections);
  // Each scalar coordinate uses sub,mul,add. XY share three SIMD instructions; Z keeps three scalar ones.
  assert.equal(work.vectorPairs * 6, voxel.intersections * 6);
  assert.ok(work.vectorPairs * 6 < voxel.intersections * 9);
  const wasm = await readFile(new URL('../dist/navmesh-raster.wasm', import.meta.url));
  assert.ok(WebAssembly.validate(wasm));
  const module = binaryen.readBinary(wasm);
  try {
    const text = module.emitText();
    for (const instruction of ['f64x2.add', 'f64x2.mul', 'f64x2.sub'])
      assert.ok(text.includes(instruction), instruction);
  } finally {
    module.dispose();
  }
  assert.ok(work.memoryBytes > 0);
  t.diagnostic(JSON.stringify(work));
});

test('worker validates inputs without coercing indices, preserves errors, and always terminates', async () => {
  await assert.rejects(
    buildNavMeshInWorker(floor, indices, settings, { wasmURL: new URL('./absent.wasm', import.meta.url) }),
    (e) => e.code === 'failed' && e.cause?.code === 'ENOENT',
  );
  await assert.rejects(buildNavMeshInWorker(floor, [0, 1.5, 2], settings, controls), RangeError);
  await assert.rejects(buildNavMeshInWorker([NaN, ...floor.slice(1)], indices, settings, controls), RangeError);
  await assert.rejects(
    buildNavMeshInWorker(floor, indices, { ...settings, walkableSlopeAngle: 90 }, controls),
    RangeError,
  );
  await assert.rejects(buildNavMeshInWorker(floor, indices, settings, { timeout: 0 }), RangeError);
  assert.equal(active, 0);
});

test('abort before loading, in-flight abort and a hard deadline terminate owned workers', async () => {
  const a = new AbortController(),
    reason = new Error('cancel build');
  a.abort(reason);
  await assert.rejects(buildNavMeshInWorker(floor, indices, settings, { signal: a.signal }), (e) => e === reason);
  const b = new AbortController();
  created = () => queueMicrotask(() => b.abort(reason));
  await assert.rejects(buildNavMeshInWorker(floor, indices, settings, { signal: b.signal }), (e) => e === reason);
  created = undefined;
  await assert.rejects(
    buildNavMeshInWorker(floor, indices, settings, {
      timeout: 30,
      workerURL: new URL('./support/idle-worker.mjs', import.meta.url),
    }),
    (e) => e.code === 'timeout',
  );
  assert.equal(active, 0);
});
