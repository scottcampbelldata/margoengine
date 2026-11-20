// Runs in its own process with --expose-gc (tests/frame-alloc.test.js at the repository root gives the reasons for
// the other V8 flags): heap bytes per call of each WebGL2-layer culling route (src/compat.ts), run once a frame there,
// on a stand-in device whose writeBuffer keeps nothing, so every byte left is the route's own. The box shape's CPU test
// is BoxCulledMeshes' (dist/bounds.js). Prints JSON { bytes: { <route>: [heap bytes per call, five windows] }, errors: { <route>: message } }.
import { heapWindows } from '../../../../tests/support/heap-windows.mjs';
import { cullParts, dynamicRoute, instancesRoute, meshesRoute } from '../../src/compat.ts';
import { BoxCulledMeshes } from '../../dist/bounds.js';

const ROWS = 256,
  device = { queue: { writeBuffer() {} } },
  shape = new BoxCulledMeshes()['shape'],
  // A camera at the origin looking down -z: planes x, y within +-40 and z in [-200, 0]; every row below is inside.
  frame = new Float32Array(44);
frame.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -1, 0, 0, 0, 1]);
frame.set([1, 0, 0, 40, -1, 0, 0, 40, 0, 1, 0, 40, 0, -1, 0, 40, 0, 0, -1, 0, 0, 0, 1, 200], 16);
frame.set([800, 300, 0], 40);
// A 2 x 2 x 2 cube's vertices (position and normal, 6 floats each) for the box shape.
const vertices = new Float32Array(8 * 6);
for (let i = 0; i < 8; i++) vertices.set([i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1], i * 6);
// Rows: rotated, scaled and placed at fractional positions inside the view, so no length is an integer.
const records = new Float32Array(ROWS * 24),
  matrices = new Float32Array(ROWS * 12),
  attributes = new ArrayBuffer(ROWS * 16),
  tints = new Float32Array(attributes),
  states = new Uint32Array(attributes);
for (let i = 0; i < ROWS; i++) {
  const a = i * 0.37,
    s = 0.5 + (i % 7) * 0.1,
    m = [s * Math.cos(a), s * Math.sin(a), 0, 0, -s * Math.sin(a), s * Math.cos(a), 0, 0, 0, 0, s, 0];
  m.push(((i % 16) - 7.5) * 2.1, (Math.floor(i / 16) - 7.5) * 2.1, -20 - (i % 5) * 3.3, 1);
  records.set(m, i * 24);
  records.set([1, 1, 1, 1, 0.5, 0.5, 0, 1], i * 24 + 16);
  [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14].forEach((k, j) => (matrices[i * 12 + j] = m[k]));
  tints.set([1, 0.5, 0.25], i * 4);
  states[i * 4 + 3] = 1;
}
const part = new Float32Array(16);
part.set([0.8, 0.2, 0, 16777216], 8);
part.set([1, 1, 1, 1], 12);
const sphere = new Float32Array([0, 0, 0, Math.sqrt(3)]),
  world = { world: {}, drawn: {}, args: {} },
  target = {},
  dynamic = dynamicRoute(ROWS),
  lists = {
    records,
    hidden: new Uint32Array(ROWS),
    bounds: new Float32Array([0, 0, 0, Math.sqrt(3), 0, 0, 0, Math.sqrt(3)]),
    batchOf: Uint32Array.from({ length: ROWS }, (_, i) => i & 1),
    starts: [0, ROWS / 2],
    count: ROWS,
  },
  args = new Uint32Array(10),
  instances = instancesRoute(lists, args, 2),
  meshes = meshesRoute(),
  batch = { instances: records, count: ROWS, geometry: { bounds: sphere, indices: new Uint32Array(36), vertices } },
  planes = frame.subarray(16, 40);

// Every route must keep every row (a route that culls them all would measure nothing).
const kept = new Uint32Array(2);
cullParts(lists, planes, true, new Float32Array(ROWS * 24), args, kept);
if (kept[0] + kept[1] !== ROWS) throw new Error(`instances kept ${kept[0] + kept[1]} of ${ROWS}`);

const routes = {
  dynamic: () => dynamic(device, ROWS, matrices, tints, world, frame, part, sphere, 36),
  dynamicBox: () => dynamic(device, ROWS, matrices, tints, world, frame, part, sphere, 36, shape.cpu, vertices),
  instances: () => instances(device, world, planes, true),
  meshes: () => meshes(device, batch, target, target, frame),
  meshesBox: () => meshes(device, batch, target, target, frame, shape.cpu),
};
// A route that throws reports its message in `errors` instead of bytes.
const bytes = {},
  errors = {};
for (const [name, route] of Object.entries(routes)) {
  const run = (calls) => {
    for (let i = 0; i < calls; i++) route();
  };
  try {
    run(2000);
    bytes[name] = heapWindows(run, 200);
  } catch (error) {
    errors[name] = error.message;
  }
}
console.log(JSON.stringify({ bytes, errors }));
