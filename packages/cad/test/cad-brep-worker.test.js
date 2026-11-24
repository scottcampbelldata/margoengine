// The CAD worker reads the B-rep formats with Margo's own kernel (@margoengine/brep): each placed body is meshed
// once from its exact geometry, with the kernel's exact surface normals (smooth across a curved face, hard at every
// B-rep edge), and every placement of the body reuses that geometry with its own transform. Runs the built worker
// in-process, as cad-crease.test.js does. Expected values are closed forms of the shapes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { model, parseSTEP, tessellateSTEP } from '@margoengine/brep';

const root = join(import.meta.dirname, '../../..');
const fixtures = join(root, 'packages/brep/tests/fixtures');

/** The worker's messages for `bytes` in `format`. */
function cadWorker(bytes, format, options = {}) {
  const code = readFileSync(join(root, 'packages/cad/dist/workers/cad-runtime.js'), 'utf8');
  return new Promise((done) => {
    const parts = [],
      progress = [],
      self = {
        postMessage: (m) => {
          if (m.part) parts.push(m.part);
          if (typeof m.progress === 'number') progress.push(m.progress);
          if (m.error !== undefined || m.done) done({ ...m, parts, progress });
        },
      };
    new Function('self', code)(self);
    // A copy: a Node Buffer's own .buffer may be a shared pool larger than the file.
    const buffer = new Uint8Array(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes).buffer;
    self.onmessage({ data: { buffer, format, smoothing: true, ...options } });
  });
}
const vertexCount = (part) => part.vertices.length / 6;
const normalOf = (part, k) => [...part.vertices.subarray(k * 6 + 3, k * 6 + 6)];
const positionOf = (part, k) => [...part.vertices.subarray(k * 6, k * 6 + 3)];

test('a box: 6 faces of 4 vertices each, every normal its face axis, hard at all 12 edges', async () => {
  const step = model.bodiesToSTEP([model.box('box', [0.01, 0.02, 0.03])]),
    result = await cadWorker(step, 'step');
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.done, true);
  assert.equal(result.failedFaces, 0);
  assert.equal(result.parts.length, 1);
  const [part] = result.parts;
  assert.equal(vertexCount(part), 24, 'each face has its own 4 corners, so no normal is shared across an edge');
  assert.equal(part.indices.length, 36, 'two triangles per face');
  const axes = new Set();
  for (let k = 0; k < 24; k++) {
    const n = normalOf(part, k);
    assert.equal(n.filter((v) => v !== 0).length, 1, `normal ${n} is an axis`);
    axes.add(n.join(','));
  }
  assert.equal(axes.size, 6, 'one normal per face, all six directions');
  assert.deepEqual(part.transform, { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
  assert.deepEqual(result.progress.at(-1), 100);
});

test('a cylinder: side normals are exactly radial (smooth across the curved face), cap normals exactly axial', async () => {
  const r = 0.005,
    h = 0.008,
    step = model.bodiesToSTEP([model.cylinder('cyl', r, h)]),
    result = await cadWorker(step, 'step'),
    [part] = result.parts;
  assert.equal(result.error, undefined, result.error);
  let side = 0;
  for (let k = 0; k < vertexCount(part); k++) {
    const [x, y, z] = positionOf(part, k),
      n = normalOf(part, k);
    if (Math.abs(n[2]) > 0.5) {
      assert.deepEqual([n[0], n[1], Math.abs(n[2])], [0, 0, 1], 'a cap normal is the axis');
      assert.ok(Math.abs(z) < 1e-9 || Math.abs(z - h) < 1e-9, 'cap vertices lie on z = 0 or z = h');
    } else {
      side++;
      assert.ok(Math.abs(Math.hypot(x, y) - r) < 1e-9, 'side vertices lie on the cylinder');
      assert.ok(Math.abs(n[0] - x / r) < 1e-6 && Math.abs(n[1] - y / r) < 1e-6 && n[2] === 0, `radial normal at ${x},${y}`);
    }
  }
  assert.ok(side > 8, 'the side is sampled round');
});

test('every triangle the kernel makes arrives (none left out), in metres', async () => {
  const body = model.cylinder('cyl', 0.005, 0.008),
    step = model.bodiesToSTEP([body]),
    [mesh] = tessellateSTEP(parseSTEP(step)),
    result = await cadWorker(step, 'step');
  assert.equal(result.parts[0].indices.length, mesh.indices.length);
});

test('smoothing false: one flat normal per triangle, the cross product of its edges', async () => {
  const step = model.bodiesToSTEP([model.cylinder('cyl', 0.005, 0.008)]),
    [part] = (await cadWorker(step, 'step', { smoothing: false })).parts;
  assert.equal(vertexCount(part), part.indices.length, 'three own corners per triangle');
  for (let t = 0; t < part.indices.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((j) => positionOf(part, part.indices[t + j])),
      u = [0, 1, 2].map((i) => b[i] - a[i]),
      v = [0, 1, 2].map((i) => c[i] - a[i]),
      n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]],
      l = Math.hypot(...n);
    for (let j = 0; j < 3; j++) {
      const got = normalOf(part, part.indices[t + j]);
      assert.ok(got.every((g, i) => Math.abs(g - n[i] / l) < 1e-5), `triangle ${t / 3} normal`);
    }
  }
});

test('linearDeflection sets the chord error in metres: a finer value gives more triangles, each within it', async () => {
  const r = 0.005,
    step = model.bodiesToSTEP([model.cylinder('cyl', r, 0.008)]),
    coarse = (await cadWorker(step, 'step', { linearDeflection: 1e-4 })).parts[0],
    fine = (await cadWorker(step, 'step', { linearDeflection: 1e-6 })).parts[0];
  assert.ok(fine.indices.length > coarse.indices.length);
  // Along the side face, a rim edge (two neighbouring samples at one height) is a chord of the circle; its sagitta,
  // r - sqrt(r^2 - (chord / 2)^2), is its distance from the true surface.
  for (const [part, d] of [
    [coarse, 1e-4],
    [fine, 1e-6],
  ]) {
    let rims = 0;
    for (let t = 0; t < part.indices.length; t += 3)
      for (let j = 0; j < 3; j++) {
        const ia = part.indices[t + j],
          ib = part.indices[t + ((j + 1) % 3)],
          a = positionOf(part, ia),
          b = positionOf(part, ib);
        if (Math.abs(normalOf(part, ia)[2]) > 0.5 || Math.abs(normalOf(part, ib)[2]) > 0.5) continue;
        if (Math.abs(a[2] - b[2]) > 1e-12) continue;
        const half = Math.hypot(a[0] - b[0], a[1] - b[1]) / 2;
        rims++;
        assert.ok(r - Math.sqrt(r * r - half * half) <= d * (1 + 1e-6), `rim sagitta for d ${d}`);
      }
    assert.ok(rims > 0);
  }
});

// fixtures/bracket-assembly.step: one part (a triangle face on z = 0, 10 mm sides, coloured 0.8, 0.2, 0.1) placed twice
// by an assembly: 100 mm along x turned 90 degrees about z, and 50 mm along y unturned.
test('an assembly: the body is meshed once and each placement reuses it with its own transform and colour', async () => {
  const result = await cadWorker(readFileSync(join(import.meta.dirname, 'fixtures/bracket-assembly.step')), 'step');
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.parts.length, 2);
  const [first, second] = result.parts;
  assert.equal(first.name, 'Bracket');
  assert.equal(first.color, '#cc331a', 'sRGB 0.8, 0.2, 0.1');
  assert.equal(second.reuse, 0, 'the second placement reuses the first geometry');
  assert.equal(second.vertices, undefined);
  // The geometry is the body in its own frame, in metres.
  assert.deepEqual(
    Array.from({ length: vertexCount(first) }, (_, k) => positionOf(first, k).map((v) => Math.round(v * 1e6) / 1e6))
      .map(String)
      .sort(),
    ['0,0,0', '0,0.01,0', '0.01,0,0'],
  );
  const s = Math.SQRT1_2,
    near = (a, b, label) => assert.ok(a.every((v, i) => Math.abs(v - b[i]) < 1e-12), `${label}: ${a} != ${b}`);
  const placed = new Map(result.parts.map((p) => [p.transform.position.map((v) => Math.round(v * 1e9) / 1e9).join(), p]));
  assert.deepEqual([...placed.keys()].sort(), ['0,0.05,0', '0.1,0,0']);
  near(placed.get('0.1,0,0').transform.rotation, [0, 0, s, s], '90 degrees about z');
  near(placed.get('0,0.05,0').transform.rotation, [0, 0, 0, 1], 'unturned');
  for (const p of result.parts) near(p.transform.scale, [1, 1, 1], 'unscaled');
});

test('IGES, through the kernel: a 10 mm cube fixture reads as one closed body with axis normals', async () => {
  const result = await cadWorker(readFileSync(join(fixtures, 'iges/cube.igs')), 'iges');
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.failedFaces, 0);
  const geometries = result.parts.filter((p) => p.vertices);
  assert.ok(geometries.length >= 1);
  for (const p of geometries)
    for (let k = 0; k < vertexCount(p); k++)
      assert.equal(normalOf(p, k).filter((v) => Math.abs(v) > 1e-6).length, 1, 'a cube face normal is an axis');
});

test('a file the kernel cannot read fails with its TypeError; an unknown format is refused', async () => {
  const bad = await cadWorker('ISO-10303-21;\nHEADER;\nnot step', 'step');
  assert.equal(bad.kind, 'TypeError');
  assert.match(bad.error, /STEP/);
  const unknown = await cadWorker('x', 'brep');
  assert.equal(unknown.kind, 'TypeError');
  assert.match(unknown.error, /stl, obj, step, iges, sat, xt or jt/);
});
