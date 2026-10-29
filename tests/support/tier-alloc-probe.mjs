// Runs in its own process with --expose-gc --max-opt=2: V8 then stops at Maglev, the optimizing tier a function called
// once per frame sits in for its first thousands of frames in a browser (scripts/frame-alloc-browser.mjs measures it
// there). Maglev boxes every fractional number it passes to a call it does not inline (Number.isFinite included) and
// allocates a function's closure context on each call. Prints JSON { bytes: [heap bytes per call, five windows] }.
// Cases: invert (invertMatrixStable of a camera-like matrix), cascades (cascadeSplits + fitCascades of four cascades).
// MARGO_PROBE_ROOT points it at another checkout (to measure a commit before a fix).
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { getHeapStatistics } from 'node:v8';

const root = process.env.MARGO_PROBE_ROOT ?? resolve(import.meta.dirname, '../..'),
  load = (path) => import(pathToFileURL(resolve(root, path)).href),
  name = process.argv[2];
let call;
if (name === 'invert') {
  const { invertMatrixStable } = await load('packages/math/dist/mat4.js');
  const m = new Float32Array([0.71, -0.41, 0.58, 0, 0, 0.82, 0.58, 0, -0.71, -0.41, 0.58, 0, 0.13, -0.27, -5.83, 1]),
    out = new Float32Array(16),
    workspace = new Float64Array(52);
  call = () => invertMatrixStable(m, out, workspace);
} else if (name === 'cascades') {
  const { cascadeSplits, fitCascades } = await load('packages/shadows/dist/index.js');
  const camera = { position: [3.3, 2.1, 5.7], target: [0.1, 0.4, -0.3], fov: 60, near: 0.1, far: 93.7 },
    direction = [-0.37, -0.81, -0.45],
    splits = new Float32Array(4),
    matrices = new Float32Array(64),
    ranges = new Float32Array(4),
    result = { matrices, ranges };
  call = () => {
    cascadeSplits(camera.near, camera.far, 0.5, splits, 4);
    fitCascades(camera, 4 / 3, direction, 1024, splits, matrices, ranges, 100, result, 4);
  };
} else throw new TypeError(`Unknown case ${name}`);

for (let i = 0; i < 20_000; i++) call();
const heap = () => getHeapStatistics().used_heap_size;
heap();
const r0 = heap(),
  read = heap() - r0,
  bytes = [];
for (let w = 0; w < 5; w++) {
  globalThis.gc();
  const before = heap();
  for (let i = 0; i < 1000; i++) call();
  bytes.push((heap() - before - read) / 1000);
}
console.log(JSON.stringify({ bytes }));
