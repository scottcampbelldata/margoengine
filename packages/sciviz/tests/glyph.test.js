import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Geometry } from '@margoengine/core';
import {
  prepareGlyphs,
  glyphLayer,
  GlyphLayer,
  warpByVector,
  warpByScalar,
  warpOperator,
  glyphOperator,
} from '../dist/glyph.js';
const table = {
  points: [0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 2, 0],
  pointArrays: { v: [1, 0, 0, 0, 2, 0, -1, 0, 0, 0, 0, 0], s: [2, 3, 4, 0] },
};
const close = (a, b, e = 1e-6) => {
  assert.equal(a.length, b.length);
  a.forEach((v, i) => assert(Math.abs(v - b[i]) <= e, `${i}: ${v} versus ${b[i]}`));
};
function fixture(failAt = Infinity) {
  const meshes = [],
    layers = new Set();
  return {
    meshes,
    layers,
    engine: {
      createMesh(parent) {
        if (meshes.length === failAt) throw new Error('allocation');
        const m = {
          parent,
          disposed: false,
          setPosition(v) {
            this.position = v;
            return this;
          },
          setScale(v) {
            this.scale = v;
            return this;
          },
          setQuaternion(v) {
            if (!Math.hypot(...v)) throw Error('quaternion');
            this.quaternion = v;
            return this;
          },
          setGeometry(v) {
            this.geometry = v;
            return this;
          },
          setMaterial(v) {
            this.material = v;
            return this;
          },
          dispose() {
            this.disposed = true;
          },
        };
        meshes.push(m);
        return m;
      },
    },
    addLayer(layer) {
      layers.add(layer);
      layer.setModel(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
      return layer;
    },
    remove(layer) {
      layers.delete(layer);
      layer.dispose();
    },
  };
}
test('stride/mask retain source IDs and vector scaling omits zero size', async () => {
  const r = await prepareGlyphs(table, {
    vectors: 'v',
    scaleMode: 'magnitude',
    scaleFactor: 2,
    stride: 2,
    mask: [0, 1, 1, 1],
  });
  assert.deepEqual([...r.ids], [2]);
  close(r.scales, [2, 2, 2]);
  close(r.quaternions, [0, 1, 0, 0]);
  const s = await prepareGlyphs(table, { vectors: 'v', scalars: 's', scaleMode: 'scalar' });
  assert.deepEqual([...s.ids], [0, 1, 2]);
  close(s.scales, [2, 2, 2, 3, 3, 3, 4, 4, 4]);
  const components = await prepareGlyphs(
    { points: [0, 0, 0], pointArrays: { v: [-2, 3, 4] } },
    { vectors: 'v', scaleMode: 'components' },
  );
  close(components.scales, [-2, 3, 4]);
});
test('orientation maps +X onto axes, antipodes and nearly opposite vectors without singularities', async () => {
  for (const vector of [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, 0, -1],
    [-1, 1e-8, -1e-7],
    [1e-30, 2e-30, 3e-30],
  ]) {
    const { quaternions: q } = await prepareGlyphs({ points: [0, 0, 0] }, { vectors: vector });
    const [x, y, z, w] = q,
      actual = [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)],
      length = Math.hypot(...vector);
    close(
      actual,
      vector.map((v) => v / length),
    );
  }
  const r = await prepareGlyphs({ points: [0, 0, 0] }, { vectors: [0, 0, 0] });
  close(r.quaternions, [0, 0, 0, 1]);
});
test('cell glyphs use vertex means and associated cell fields; tables reject cell mode', async () => {
  const g = { points: table.points, connectivity: [0, 1, 2], offsets: [3], types: [5], cellArrays: { v: [0, 0, 2] } };
  const r = await prepareGlyphs(g, { association: 'cell', vectors: 'v' });
  close(r.positions, [1 / 3, 1 / 3, 0]);
  await assert.rejects(prepareGlyphs(table, { association: 'cell' }), RangeError);
});
test('regular and curvilinear images support cell glyphs and retain their implicit topology through warp', async () => {
  const image = {
    dims: [2, 2, 1],
    bounds: [0, 1, 0, 1, 0, 0],
    pointData: [1, 2, 3, 4],
    pointArrays: { v: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1] },
    cellArrays: { v: [1, 0, 0] },
  };
  const glyphs = await prepareGlyphs(image, { association: 'cell', vectors: 'v' });
  close(glyphs.positions, [0.5, 0.5, 0]);
  const warped = await warpByVector(image, 'v', { scaleFactor: 2 });
  assert.equal(warped.dims, image.dims);
  close(warped.points, [0, 0, 2, 1, 0, 2, 0, 1, 2, 1, 1, 2]);
  const curved = await prepareGlyphs(warped, { association: 'cell', vectors: 'v' });
  close(curved.positions, [0.5, 0.5, 2]);
});
test('all built-ins and custom meshes share one geometry/material and own only their meshes', async () => {
  const custom = new Geometry([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 0, 1, 0, 0, 1, 0, 0, 1], [0, 1, 2]);
  for (const shape of ['arrow', 'cone', 'sphere', 'cube', 'line', custom]) {
    const f = fixture(),
      layer = await glyphLayer(f, table, { shape, vectors: 'v' });
    assert.equal(layer.meshes.length, 4);
    assert(layer.meshes.every((m) => m.geometry === layer.geometry && m.material === layer.meshes[0].material));
    assert(layer.bounds.every(Number.isFinite));
    if (shape === custom) assert.equal(layer.geometry, custom);
    layer.dispose();
    layer.dispose();
    assert.equal(f.layers.size, 0);
    assert(f.meshes.every((m) => m.disposed));
  }
});
test('construction and figure publication failures release all partial instance ownership', async () => {
  const f = fixture(3);
  await assert.rejects(glyphLayer(f, table), /allocation/);
  assert(f.meshes.every((m) => m.disposed));
  const publish = fixture();
  publish.addLayer = () => {
    throw Error('publication');
  };
  await assert.rejects(glyphLayer(publish, table), /publication/);
  assert(publish.meshes.every((m) => m.disposed));
  const r = await prepareGlyphs(table),
    bad = fixture();
  r.quaternions.fill(0);
  assert.throws(() => new GlyphLayer(bad, r), /quaternion/);
  assert(bad.meshes.every((m) => m.disposed));
});
test('invalid rows, modes, masks, array widths, scales and bounds reject before publication', async () => {
  for (const options of [
    { stride: 0 },
    { stride: 1.5 },
    { vectors: [1, 2] },
    { scalars: 'missing', scaleMode: 'scalar' },
    { mask: [1] },
    { scaleFactor: Infinity },
    { scaleMode: 'unknown' },
  ])
    await assert.rejects(prepareGlyphs(table, options), RangeError);
  const f = fixture();
  await assert.rejects(glyphLayer(f, { points: [3e38, 0, 0] }, { shape: 'sphere', scaleFactor: 3e38 }), RangeError);
  assert.equal(f.meshes.length, 0);
});
test('vector and scalar warp preserve topology/attributes, rebuild surface normals and never mutate inputs', async () => {
  const grid = {
    points: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    connectivity: [0, 1, 2],
    offsets: [3],
    types: [5],
    pointArrays: { v: [0, 0, 1, 0, 0, 2, 0, 0, 3] },
    pointData: [1, 2, 3],
  };
  const w = await warpByVector(grid, 'v', { scaleFactor: -2 });
  close(w.points, [0, 0, -2, 1, 0, -4, 0, 1, -6]);
  assert.equal(w.connectivity, grid.connectivity);
  assert.equal(w.pointArrays, grid.pointArrays);
  close(grid.points, [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const scalar = await warpByScalar(grid, '', { direction: [0, 1, 0], scaleFactor: 2 });
  close(scalar.points, [0, 2, 0, 1, 4, 0, 0, 7, 0]);
  const surface = {
    positions: Float32Array.from(grid.points),
    normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    values: Float32Array.from([0, 0, 1]),
    cells: new Uint32Array([7]),
    bounds: [0, 1, 0, 1, 0, 0],
  };
  const out = await warpByScalar(surface, '');
  close(out.positions, [0, 0, 0, 1, 0, 0, 0, 1, 1]);
  close(out.normals, [0, -Math.SQRT1_2, Math.SQRT1_2, 0, -Math.SQRT1_2, Math.SQRT1_2, 0, -Math.SQRT1_2, Math.SQRT1_2]);
  assert.equal(out.cells, surface.cells);
  close(out.bounds, [0, 1, 0, 1, 0, 1]);
});
test('snapshots inputs before yielding, cooperatively cancels and supplies pipeline operators', async () => {
  const points = [0, 0, 0],
    vectors = [1, 0, 0],
    pending = prepareGlyphs({ points }, { vectors });
  points[0] = 99;
  vectors[0] = 0;
  close((await pending).positions, [0, 0, 0]);
  const c = new AbortController(),
    reason = new Error('cancel'),
    job = prepareGlyphs(table, { signal: c.signal });
  c.abort(reason);
  await assert.rejects(job, (e) => e === reason);
  await assert.rejects(
    warpByVector({ points: [0, 0, 0], connectivity: [], offsets: [], types: [] }, [0, 0, 0], { signal: c.signal }),
    (e) => e === reason,
  );
  const f = fixture(),
    op = glyphOperator(f),
    layer = await op.execute({ inputs: [table], params: { vectors: 'v' }, signal: new AbortController().signal });
  op.release(layer);
  assert.equal(f.layers.size, 0);
  const result = await warpOperator().execute({
    inputs: [{ points: [0, 0, 0], connectivity: [], offsets: [], types: [], pointArrays: { v: [1, 2, 3] } }],
    params: { kind: 'vector', array: 'v', scaleFactor: 2 },
    signal: new AbortController().signal,
  });
  close(result.points, [2, 4, 6]);
});
