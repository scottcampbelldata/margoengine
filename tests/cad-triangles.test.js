// CAD import keeps every triangle the file or OpenCascade gives it. A zero-area triangle (repeated corners) stays as
// emitted and adds no normal weight; welding merges only corners at the same Float32 point, so a real triangle never
// collapses. The corners are the ones measured in NIST_MTC_CRADA_ASSEMBLY_REV-D.STP (OpenCascade, metres): box triangle
// 383, whose corners B and C are identical, and screw triangle 2475, whose corners A and B are 4.2 um apart and fell in
// one 1e-5 rounding cell. Both used to fail the whole file ("Degenerate CAD triangle", "Triangle collapses at CAD
// welding tolerance").
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import { parseCAD } from '../packages/machinery/dist/index.js';

const root = join(import.meta.dirname, '..');
const box = [
    [0.14636598199354653, 0.09596837638294874, 0.062339053321559],
    [0.1469, 0.09609999999999999, 0.06200858],
    [0.1469, 0.09609999999999999, 0.06200858],
  ],
  screw = [
    [0.005508420102125605, 0.007045313720452954, 0.0756366723],
    [0.005512630075099999, 0.00704528505, 0.0756366723],
    [0.0056127120931243075, 0.007041220742426028, 0.07554247536010658],
  ],
  good = [
    [0, 0, 0],
    [0.01, 0, 0],
    [0, 0.01, 0],
  ];

test('the measured corners: box 383 has no area as emitted; screw 2475 has area but shared one 1e-5 cell', () => {
  assert.deepEqual(box[1], box[2]);
  const [a, b] = screw;
  assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) > 4e-6, 'A and B are distinct points');
  assert.deepEqual(
    a.map((v) => Math.round(Math.fround(v) * 100_000)),
    b.map((v) => Math.round(Math.fround(v) * 100_000)),
    'the old grid key merged them',
  );
});

/** Every value finite, every normal unit length, every index in range. */
function sound(vertices, indices) {
  assert.ok(vertices.every(Number.isFinite), 'finite vertices');
  for (let o = 0; o < vertices.length; o += 6)
    assert.ok(Math.abs(Math.hypot(vertices[o + 3], vertices[o + 4], vertices[o + 5]) - 1) < 1e-5, 'unit normal');
  assert.ok(
    indices.every((i) => i < vertices.length / 6),
    'indices in range',
  );
}
/** Vertex ids of triangle `t` hold three distinct positions. */
function distinctCorners(vertices, indices, t) {
  const at = [0, 1, 2].map((j) => indices[t * 3 + j] * 6);
  return new Set(at.map((o) => `${vertices[o]},${vertices[o + 1]},${vertices[o + 2]}`)).size;
}

test('STL/OBJ: a zero-area facet and a micrometre-scale facet load with every triangle kept', async () => {
  const engine = new Engine(
    { width: 8, height: 8, clientWidth: 8, clientHeight: 8 },
    await TransformStore.create(8),
    { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
    undefined,
    null,
  );
  try {
    const facet = (corners) =>
        `facet normal 0 0 1\nouter loop\n${corners.map((c) => `vertex ${c.join(' ')}`).join('\n')}\nendloop\nendfacet\n`,
      model = parseCAD(engine, `solid nist\n${facet(box)}${facet(screw)}${facet(good)}endsolid nist\n`, 'stl'),
      { vertices, indices } = model.meshes[0].geometry;
    assert.equal(indices.length, 9, 'three triangles, none left out');
    sound(vertices, indices);
    assert.equal(distinctCorners(vertices, indices, 1), 3, 'the screw triangle keeps three corners');
  } finally {
    engine.dispose();
  }
});

/** machinery's built CAD worker in-process, with an OpenCascade that returns `meshes` (OpenCascade's own output shape). */
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
const mesh = (name, corners) => ({
  name,
  attributes: { position: { array: [...corners, ...good].flat() } },
  index: { array: [0, 1, 2, 3, 4, 5] },
});

for (const smoothing of [false, true])
  test(`STEP worker (smoothing ${smoothing}): OpenCascade's zero-area and micrometre triangles load, none left out`, async () => {
    const result = await cadWorker([mesh('box', box), mesh('screw', screw)], smoothing);
    assert.equal(result.error, undefined, result.error);
    assert.equal(result.done, true);
    assert.deepEqual(
      result.parts.map((p) => [p.name, p.indices.length]),
      [
        ['box', 6],
        ['screw', 6],
      ],
    );
    for (const p of result.parts) sound(p.vertices, p.indices);
    assert.equal(
      distinctCorners(result.parts[1].vertices, result.parts[1].indices, 0),
      3,
      'screw 2475 keeps 3 corners',
    );
  });
