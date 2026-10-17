// STEP/IGES shading uses OpenCascade's own surface normals (default smoothing): smooth across a curved B-rep face and
// hard at every B-rep edge. Welding positions across faces and averaging their normals used to round off every hard
// edge of a CAD part (the NIST box rim and the screw socket). Runs machinery's built CAD worker in-process with an
// OpenCascade stand-in that returns meshes in OpenCascade's shape: each B-rep face has its own vertices and normals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');

function cadWorker(meshes, smoothing) {
  const code = readFileSync(join(root, 'packages/machinery/dist/workers/cad-runtime.js'), 'utf8');
  return new Promise((done) => {
    const parts = [],
      self = {
        location: { href: 'file:///cad-runtime.js' },
        postMessage: (m) => {
          if (m.part) parts.push(m.part);
          if (m.error !== undefined || m.done) done({ ...m, parts });
        },
        importScripts() {
          self.occtimportjs = async () => ({ ReadStepFile: () => ({ success: true, meshes }) });
        },
      };
    new Function('self', code)(self);
    self.onmessage({ data: { buffer: new Uint8Array(8).buffer, format: 'step', smoothing } });
  });
}
const unit = ([x, y, z]) => {
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
};
/** Normal of output vertex `k` (Geometry keeps OpenCascade's vertex order). */
const normalOf = (part, k) => [...part.vertices.subarray(k * 6 + 3, k * 6 + 6)];
const close = (actual, expected, label) =>
  assert.ok(
    actual.every((v, i) => Math.abs(v - expected[i]) < 1e-6),
    `${label}: ${actual.map((v) => v.toFixed(4))} != ${expected.map((v) => v.toFixed(4))}`,
  );

// Two B-rep faces meeting at a 90 degree edge along (0,0,0)-(0,1,0): face A in z = 0 (normal +Z), face B in x = 0
// (normal +X). Face A's surface is slightly curved, so OpenCascade's normals there lean toward +X.
const tilt = unit([0.1, 0, 1]);
const lShape = (normals) => ({
  name: 'bracket',
  attributes: {
    position: { array: [0, 0, 0, 1, 0, 0, 0, 1, 0, /* face B */ 0, 0, 0, 0, 1, 0, 0, 0, 1] },
    ...(normals ? { normal: { array: normals } } : {}),
  },
  index: { array: [0, 1, 2, 3, 4, 5] },
});

test('default smoothing: OpenCascade normals are used as given, so the 90 degree edge stays hard', async () => {
  const result = await cadWorker([lShape([...tilt, ...tilt, ...tilt, 1, 0, 0, 1, 0, 0, 1, 0, 0])], true),
    [part] = result.parts;
  assert.equal(result.error, undefined, result.error);
  assert.equal(part.vertices.length / 6, 6, 'no welding across B-rep faces');
  for (const k of [0, 1, 2]) close(normalOf(part, k), tilt, `face A vertex ${k}`);
  for (const k of [3, 4, 5]) close(normalOf(part, k), [1, 0, 0], `face B vertex ${k}`);
  // The same point on both faces keeps both normals: the edge is not rounded off.
  assert.notDeepEqual(normalOf(part, 0), normalOf(part, 3));
});

test('a missing, zero or backwards OpenCascade normal falls back to its own face normal', async () => {
  const backwards = await cadWorker([lShape([0, 0, -1, ...tilt, 0, 0, 0, 1, 0, 0, 1, 0, 0, Number.NaN, 0, 0])], true),
    [part] = backwards.parts;
  close(normalOf(part, 0), [0, 0, 1], 'backwards normal');
  close(normalOf(part, 1), tilt, 'good normal kept');
  close(normalOf(part, 2), [0, 0, 1], 'zero normal');
  close(normalOf(part, 5), [1, 0, 0], 'NaN normal');
  const missing = (await cadWorker([lShape(undefined)], true)).parts[0];
  for (const k of [0, 1, 2]) close(normalOf(missing, k), [0, 0, 1], `no normals: face A vertex ${k}`);
  for (const k of [3, 4, 5]) close(normalOf(missing, k), [1, 0, 0], `no normals: face B vertex ${k}`);
});

test('{ smoothing: false } keeps one flat normal per triangle and ignores the surface normals', async () => {
  const [part] = (await cadWorker([lShape([...tilt, ...tilt, ...tilt, 1, 0, 0, 1, 0, 0, 1, 0, 0])], false)).parts;
  for (const k of [0, 1, 2]) close(normalOf(part, k), [0, 0, 1], `face A vertex ${k}`);
  for (const k of [3, 4, 5]) close(normalOf(part, k), [1, 0, 0], `face B vertex ${k}`);
});
