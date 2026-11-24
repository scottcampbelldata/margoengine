// /section: sectionIFC cuts placed geometry by planes into caps (even-odd nested, ear clipped), cut edges and loops,
// trimmed by the other planes; IFCSectionView draws them for an IFCScene and follows its planes and visibility.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { createIFCScene, IFCScene } from '../dist/scene.js';
import { sectionIFC, IFCSectionView } from '../dist/section.js';

async function engine() {
  const device = optionalGPU().engine.gpu;
  device.queue.writeTexture = () => {};
  return new Engine(
    { width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
    await TransformStore.create(64),
    { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
}
const translate = (x, y, z) => Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
// A closed box from `lo` to `hi`, flat shaded as web-ifc writes it: four vertices of its own per face.
function cube(lo = [0, 0, 0], hi = [1, 1, 1]) {
  const positions = [],
    normals = [],
    indices = [];
  for (let axis = 0; axis < 3; axis++)
    for (const side of [0, 1]) {
      const u = (axis + 1) % 3,
        v = (axis + 2) % 3,
        base = positions.length / 3;
      for (const [a, b] of [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ]) {
        const p = [0, 0, 0],
          n = [0, 0, 0];
        p[axis] = side ? hi[axis] : lo[axis];
        p[u] = a ? hi[u] : lo[u];
        p[v] = b ? hi[v] : lo[v];
        n[axis] = side ? 1 : -1;
        positions.push(...p);
        normals.push(...n);
      }
      indices.push(...(side ? [base, base + 1, base + 2, base, base + 2, base + 3] : [base, base + 2, base + 1, base, base + 3, base + 2]));
    }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices) };
}
const area = (cut) => {
  let s = 0;
  const p = cut.positions;
  for (let t = 0; t < cut.indices.length; t += 3) {
    const [a, b, c] = [cut.indices[t], cut.indices[t + 1], cut.indices[t + 2]].map((i) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]]);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
      v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    s += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
  }
  return s;
};
const length = (cut) => {
  let s = 0;
  const e = cut.edges;
  for (let i = 0; i < e.length; i += 6) s += Math.hypot(e[i + 3] - e[i], e[i + 4] - e[i + 1], e[i + 5] - e[i + 2]);
  return s;
};
const close = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-5, `${what}: ${a} vs ${b}`);

test('a plane through a closed box gives one closed loop, a full cap on the plane and its four edges', () => {
  const [cut, ...rest] = sectionIFC([{ element: 7, geometry: cube(), matrix: translate(0, 0, 0) }], [[0, -1, 0, 0.5]]);
  assert.equal(rest.length, 0);
  assert.equal(cut.element, 7);
  assert.equal(cut.plane, 0);
  assert.equal(cut.closed, 1);
  assert.equal(cut.loops.length, 1);
  assert.equal(cut.loops[0].length, 12, 'the four corners of the square, each once');
  close(area(cut), 1, 'cap area');
  close(length(cut), 4, 'edge length');
  for (let i = 1; i < cut.positions.length; i += 3) close(cut.positions[i], 0.5, 'caps lie on the plane');
});

test('placement matrices move the cut; a cavity is a hole, whatever the winding', () => {
  const outer = cube([0, 0, 0], [3, 3, 3]),
    inner = cube([1, 1, 1], [2, 2, 2]);
  // The cavity wound the same way as the outside: nesting is even-odd, not by winding.
  const [cut] = sectionIFC(
    [
      { element: 1, geometry: outer, matrix: translate(10, 0, 0) },
      { element: 1, geometry: inner, matrix: translate(10, 0, 0) },
    ],
    [[0, -1, 0, 1.5]],
  );
  assert.equal(cut.closed, 2);
  close(area(cut), 8, 'outer square minus the hole');
  close(length(cut), 16, 'both loops are cut edges');
  assert.ok(Array.from(cut.positions).filter((_, i) => i % 3 === 0).every((x) => x >= 10 - 1e-6 && x <= 13 + 1e-6));
});

test('caps and edges are trimmed by the other planes, and each plane caps its own face of the cut', () => {
  const cuts = sectionIFC(
    [{ element: 2, geometry: cube(), matrix: translate(0, 0, 0) }],
    [
      [0, -1, 0, 0.5],
      [1, 0, 0, -0.5],
    ],
  );
  assert.equal(cuts.length, 2);
  const [y, x] = cuts;
  close(area(y), 0.5, 'y cap keeps x >= 0.5');
  close(length(y), 2, 'y edges keep x >= 0.5');
  close(area(x), 0.5, 'x cap keeps y <= 0.5');
  close(length(x), 2, 'x edges keep y <= 0.5');
});

test('vertices on the plane cut nothing; an open surface gives edges and no cap; bad input is refused', () => {
  const box = [{ element: 3, geometry: cube(), matrix: translate(0, 0, 0) }];
  assert.deepEqual(sectionIFC(box, [[0, -1, 0, 1]]), [], 'the top face lies on the plane: nothing behind it is cut');
  assert.deepEqual(sectionIFC(box, [[0, 1, 0, 0]]), [], 'the bottom face on the plane');
  const quad = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    normals: new Float32Array(12),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
  const [cut] = sectionIFC([{ element: 4, geometry: quad, matrix: translate(0, 0, 0) }], [[0, -1, 0, 0.5]]);
  assert.equal(cut.closed, 0);
  assert.equal(cut.indices.length, 0, 'an open chain has no inside');
  close(length(cut), 1, 'the open chain still draws');
  assert.throws(() => sectionIFC(box, [[0, 0, 0, 1]]), /non-zero normal/);
  assert.throws(() => sectionIFC(box, [[0, 1, 0]]), /four finite numbers/);
  assert.throws(() => sectionIFC(box, [[0, 1, 0, 0]], { tolerance: -1 }), /tolerance/);
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => sectionIFC(box, [[0, -1, 0, 0.5]], { signal: controller.signal }), /aborted/);
});

test('an IFC scene clips with up to 16 planes, a BCF viewpoint with more than 6 applies', async () => {
  const scene = createIFCScene(await engine(), {
    origin: [0, 0, 0],
    geometries: new Map([[1, cube()]]),
    placements: [{ element: 10, geometry: 1, matrix: translate(0, 0, 0), color: [1, 0, 0, 1] }],
  });
  const many = Array.from({ length: 16 }, (_, i) => [Math.cos(i), 0, Math.sin(i), 5]);
  scene.clippingPlanes = many;
  assert.equal(scene.materials.opaque.clippingPlanes.length, 16);
  assert.throws(() => (scene.clippingPlanes = [...many, [0, 1, 0, 0]]), /at most 16/);
  scene.applyBCFView({ hidden: [], selected: [], colors: new Map(), clippingPlanes: many.slice(0, 8) });
  assert.equal(scene.clippingPlanes.length, 8);
  scene.dispose();
});

test('IFCSectionView caps shown elements in their colour, draws edges, and follows planes and visibility', async () => {
  const scene = createIFCScene(await engine(), {
    origin: [0, 0, 0],
    geometries: new Map([[1, cube()]]),
    placements: [
      { element: 10, geometry: 1, matrix: translate(0, 0, 0), color: [1, 0, 0, 1] },
      { element: 11, geometry: 1, matrix: translate(2, 0, 0), color: [0, 1, 0, 1] },
    ],
  });
  const added = [],
    removed = [];
  class Line {
    constructor(o) {
      this.options = o;
    }
  }
  const lines = { add: (l) => (added.push(l), l), remove: (l) => removed.push(l) };
  const view = new IFCSectionView(scene['engine'], scene, { edges: { lines, Line }, edgeColor: [1, 1, 1], edgeWidth: 3 });
  assert.equal(view.cuts.length, 0, 'no planes, no cuts');
  scene.clippingPlanes = [[0, -1, 0, 0.5]];
  view.update();
  assert.deepEqual(
    view.cuts.map((c) => c.element),
    [10, 11],
  );
  assert.equal(added.length, 1);
  assert.equal(added[0].options.mode, 'segments');
  assert.equal(added[0].options.width, 3);
  assert.equal(added[0].options.positions.length, 2 * 4 * 6, 'four edges of each box');
  const batch = view.meshes[0];
  assert.ok(batch, 'caps draw as one batch');
  assert.equal(view.update(), view, 'update with nothing changed');
  assert.equal(view.meshes[0], batch, 'and keeps the batch');
  scene.hide([11]);
  view.update();
  assert.deepEqual(
    view.cuts.map((c) => c.element),
    [10],
  );
  assert.equal(removed.length, 1, 'old edges removed');
  assert.notEqual(view.meshes[0], batch);
  assert.deepEqual(view.capColorOf(10), [1, 0, 0], 'the file colour (linear)');
  scene.setColor([10], [0, 0, 1]);
  view.update();
  assert.deepEqual(view.capColorOf(10), [0, 0, 1], 'the override');
  scene.clippingPlanes = [];
  view.update();
  assert.equal(view.meshes.length, 0);
  view.dispose();
  assert.throws(() => view.update(), /disposed/);
  scene.dispose();
});

// The engine-feature convention (tests/api-conventions.test.js): a class built from the engine has static attach.
test('IFCScene.attach and IFCSectionView.attach build what createIFCScene and the constructor build', async () => {
  const e = await engine(),
    scene = IFCScene.attach(e, {
      origin: [0, 0, 0],
      geometries: new Map([[1, cube()]]),
      placements: [{ element: 5, geometry: 1, matrix: translate(0, 0, 0), color: [1, 0, 0, 1] }],
    });
  assert.ok(scene instanceof IFCScene);
  assert.deepEqual(scene.elements, [5]);
  scene.clippingPlanes = [[0, -1, 0, 0.5]];
  const view = IFCSectionView.attach(e, scene);
  assert.ok(view instanceof IFCSectionView);
  assert.equal(view.cuts.length, 1);
  view[Symbol.dispose]();
  scene[Symbol.dispose]();
  assert.throws(() => view.update(), /disposed/);
});
