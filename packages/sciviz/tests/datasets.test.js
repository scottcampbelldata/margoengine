import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createDataSet, openDataSet, parsePLOT3D } from '../dist/datasets.js';
import { contourGrid } from '../dist/contour.js';
import { clipGrid, thresholdGrid } from '../dist/clip.js';
import { calcGrid } from '../dist/calc.js';
import { probeGrid, integrateGrid } from '../dist/probe.js';
import { warpByScalar } from '../dist/glyph.js';
import { FilterPipeline } from '../dist/pipeline.js';

const near = (a, b, t = 1e-10) => assert.ok(Math.abs(a - b) <= t, `${a} vs ${b}`);
const rect = {
  kind: 'rectilinear',
  axes: [
    [0, 1, 3],
    [0, 2],
    [0, 1],
  ],
  pointData: [0, 1, 3, 0, 1, 3, 0, 1, 3, 0, 1, 3],
  cellData: [7, 9],
};
test('all structured dimensions normalize, including descending rectilinear axes and curvilinear positions', async () => {
  const grid = await createDataSet(rect);
  assert.deepEqual([...grid.types], [12, 12]);
  assert.deepEqual(grid.dimensions, [3, 2, 2]);
  near((await integrateGrid(grid)).volume.measure, 6);
  near((await probeGrid(grid, [2, 1, 0.5])).pointData, 2);
  const descending = await createDataSet({
    ...rect,
    axes: [
      [3, 1, 0],
      [0, 2],
      [0, 1],
    ],
  });
  near((await integrateGrid(descending)).volume.measure, 6);
  for (const dimensions of [
    [1, 1, 1],
    [3, 1, 1],
    [1, 3, 1],
    [1, 1, 3],
    [2, 2, 1],
    [1, 2, 2],
  ]) {
    const grid = await createDataSet({
      kind: 'rectilinear',
      axes: dimensions.map((n) => Array.from({ length: n }, (_, i) => i)),
    });
    assert.equal(grid.types[0], [1, 3, 9][dimensions.filter((n) => n > 1).length]);
  }
  const bent = await createDataSet({
    kind: 'structured',
    dimensions: [2, 2, 1],
    points: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1.5, 1, 0],
  });
  assert.deepEqual([...bent.connectivity], [0, 1, 3, 2]);
  near((await integrateGrid(bent)).area.measure, 1.25);
});
test('one DataSet passes every batch 172 analysis filter and the demand-driven pipeline', async () => {
  const grid = await createDataSet(rect);
  assert.ok((await contourGrid(grid, [0.5, 2])).triangles.cells.length > 0);
  near((await integrateGrid(await clipGrid(grid, { kind: 'plane', normal: [1, 0, 0], offset: -1 }))).volume.measure, 4);
  assert.deepEqual([...(await thresholdGrid(grid, [8, 10], { association: 'cell' })).cellData], [9]);
  assert.deepEqual(
    [...(await calcGrid(grid, { kind: 'expression', expression: 'x+2*y' })).values].slice(0, 3),
    [0, 1, 3],
  );
  const warped = await warpByScalar(grid, grid.pointData, { scaleFactor: 1, direction: [0, 0, 1] });
  assert.equal(warped.points.length, grid.points.length);
  using pipeline = new FilterPipeline({
    dataset: { kind: 'source', execute: () => grid },
    measure: { kind: 'filter', execute: (c) => integrateGrid(c.inputs[0], { signal: c.signal }) },
  });
  pipeline.add({ id: 'd', type: 'dataset' }).add({ id: 'm', type: 'measure', inputs: ['d'] });
  near((await pipeline.run('m')).volume.measure, 6);
});
test('polydata vertices, polylines, concave polygons and strips preserve source cell tuples', async () => {
  const grid = await createDataSet({
    kind: 'polydata',
    points: [0, 0, 0, 2, 0, 0, 2, 2, 0, 1, 1, 0, 0, 2, 0],
    vertices: [[0, 1]],
    lines: [[0, 1, 2]],
    polygons: [[0, 1, 2, 3, 4]],
    strips: [[0, 1, 3, 4]],
    cellData: [10, 20, 30, 40],
    pointData: [0, 2, 2, 1, 0],
  });
  assert.deepEqual([...grid.types], [1, 1, 3, 3, 5, 5, 5, 5, 5]);
  assert.deepEqual([...grid.sourceCells], [0, 0, 1, 1, 2, 2, 2, 3, 3]);
  assert.deepEqual([...grid.cellData], [10, 10, 20, 20, 30, 30, 30, 40, 40]);
  const line = await createDataSet({
    kind: 'polydata',
    points: [0, 0, 0, 2, 0, 0],
    lines: [[0, 1]],
    pointData: [0, 2],
  });
  const cut = await contourGrid(line, [1]);
  assert.deepEqual([...cut.points.positions], [1, 0, 0]);
  const clipped = await clipGrid(line, { kind: 'plane', normal: [1, 0, 0], offset: -1 });
  assert.deepEqual([...clipped.types], [3]);
  near((await integrateGrid(clipped)).length.measure, 1);
  const vertex = await createDataSet({ kind: 'polydata', points: [0, 0, 0], vertices: [[0]], pointData: [2] });
  assert.deepEqual([...(await contourGrid(vertex, [2])).points.positions], [0, 0, 0]);
  assert.equal((await clipGrid(vertex, { kind: 'plane', normal: [1, 0, 0], offset: 0 })).types[0], 1);
});
test('composites preserve sparse hierarchy, repeated boundaries, source IDs and owned inputs', async () => {
  const leaf = await createDataSet(rect),
    result = await createDataSet({
      kind: 'multiblock',
      names: ['a', 'empty', 'partitions'],
      blocks: [leaf, null, { kind: 'partitioned', blocks: [leaf] }],
    });
  assert.equal(result.blocks[1], null);
  assert.equal(result.blocks[2].kind, 'partitioned');
  assert.deepEqual([...result.blockIds], [0, 0, 2, 2]);
  assert.equal(result.points.length, 2 * leaf.points.length);
  near((await integrateGrid(result)).volume.measure, 12);
  leaf.points[0] = 99;
  assert.equal(result.points[0], 0);
  assert.equal(result.blocks[0].kind, 'rectilinear');
});
test('face-stream polyhedra produce positive non-overlapping tetrahedra with retained fields', async () => {
  const cube = {
    kind: 'unstructured',
    points: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1],
    pointData: [0, 1, 1, 0, 0, 1, 1, 0],
    cellData: [3],
    cells: [
      {
        type: 'polyhedron',
        faces: [6, 4, 0, 3, 2, 1, 4, 4, 5, 6, 7, 4, 0, 1, 5, 4, 4, 1, 2, 6, 5, 4, 2, 3, 7, 6, 4, 3, 0, 4, 7],
      },
    ],
  };
  const grid = await createDataSet(cube);
  assert.equal(grid.types.length, 12);
  assert.ok(grid.types.every((t) => t === 10));
  near((await integrateGrid(grid)).volume.measure, 1);
  near((await probeGrid(grid, [0.5, 0.5, 0.5])).pointData, 0.5);
  assert.ok(grid.cellData.every((x) => x === 3));
  await assert.rejects(createDataSet({ ...cube, cells: [{ type: 'polyhedron', faces: [4, 3, 0, 1, 2] }] }));
});
test('a non-star-shaped U prism uses non-overlapping convex regions and mean-value field interpolation', async () => {
  const ring = [
      [0, 0],
      [3, 0],
      [3, 3],
      [2, 3],
      [2, 1],
      [1, 1],
      [1, 3],
      [0, 3],
    ],
    points = [...ring.map((p) => [...p, 0]), ...ring.map((p) => [...p, 1])],
    faces = [Array.from({ length: 8 }, (_, i) => 7 - i), Array.from({ length: 8 }, (_, i) => i + 8)];
  for (let i = 0; i < 8; i++) faces.push([i, (i + 1) % 8, ((i + 1) % 8) + 8, i + 8]);
  const stream = [faces.length, ...faces.flatMap((f) => [f.length, ...f])],
    grid = await createDataSet({
      kind: 'unstructured',
      points: points.flat(),
      cells: [{ type: 'polyhedron', faces: stream }],
      pointData: points.map((p) => p[0] + 2 * p[1] + 3 * p[2]),
    });
  near((await integrateGrid(grid)).volume.measure, 7, 1e-9);
  assert.equal(await probeGrid(grid, [1.5, 2, 0.5]), null);
  near((await probeGrid(grid, [0.5, 2, 0.5])).pointData, 6, 1e-9);
});
test('read VTR coordinates and VTS curvature through loader-owned numeric arrays, and VTM mapped children', async () => {
  const enc = new TextEncoder(),
    data = '<PointData><DataArray type="Float64" Name="f">0 1 0 1</DataArray></PointData>';
  const array = (values, name = '') => `<DataArray type="Float64" Name="${name}">${values}</DataArray>`;
  const vtr = enc.encode(
    `<VTKFile type="RectilinearGrid"><RectilinearGrid WholeExtent="4 5 2 3 0 0"><Piece>${data}<Coordinates>${array('0 1')}${array('0 2')}${array('0')}</Coordinates></Piece></RectilinearGrid></VTKFile>`,
  );
  const grid = await openDataSet(vtr);
  assert.equal(grid.kind, 'rectilinear');
  near((await integrateGrid(grid)).area.measure, 2);
  const vts = enc.encode(
    `<VTKFile type="StructuredGrid"><StructuredGrid WholeExtent="0 1 0 1 0 0"><Piece>${data}<Points><DataArray type="Float64" NumberOfComponents="3">0 0 0 1 0 0 0 1 0 2 1 0</DataArray></Points></Piece></StructuredGrid></VTKFile>`,
  );
  const curved = await openDataSet(vts);
  near((await integrateGrid(curved)).area.measure, 1.5);
  const vtm = enc.encode(
    '<VTKFile type="vtkMultiBlockDataSet"><vtkMultiBlockDataSet><DataSet index="0" name="a" file="a.vtr"/><Block index="2" name="nested"><DataSet index="0" file="b.vts"/></Block></vtkMultiBlockDataSet></VTKFile>',
  );
  const collection = await openDataSet(vtm, { files: { 'a.vtr': vtr, 'b.vts': vts } });
  assert.equal(collection.blocks[1], null);
  assert.equal(collection.names[2], 'nested');
  assert.equal(collection.blocks[2].blocks[0].kind, 'structured');
  await assert.rejects(openDataSet(vtm, { files: { 'a.vtr': vtm } }), /cyclic/);
});
test('NASA original PLOT3D data remains exact in 2D and 3D and preserves writer ordering', async () => {
  const root = new URL('../../../examples/assets/sciviz/datasets/', import.meta.url);
  for (const [dim, n, hash] of [
    [2, 875, '41c409f49afca8affaafd4a0a49c6ba934eca9007da502fe0c20afbd091500b0'],
    [3, 1750, '37fe2257e2da6b6eb66d980b1a5efd642cce06a93ff4b64aac4ba916037183e4'],
  ]) {
    const bytes = readFileSync(new URL(`flatplate_clust2_4levelsdown_35x25.p${dim}dfmt`, root));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hash);
    const grid = await parsePLOT3D(bytes, { dimensions: dim });
    assert.equal(grid.points.length, n * 3);
    assert.equal(grid.types.length, 34 * 24);
    assert.ok((await integrateGrid(grid))[dim === 2 ? 'area' : 'volume'].measure > 0);
  }
});
test('VTK-owner-written compressed VTR, VTS and VTM NASA conversions read through the same dataset API', async () => {
  const root = new URL('../../../examples/assets/sciviz/datasets/', import.meta.url),
    vtr = await openDataSet(readFileSync(new URL('flatplate.vtr', root))),
    vts = await openDataSet(readFileSync(new URL('flatplate.vts', root)));
  assert.equal(vtr.points.length, 875 * 3);
  assert.equal(vts.points.length, 875 * 3);
  assert.equal(vts.types.length, 816);
  let delta = 0;
  for (let i = 0; i < vts.points.length; i++) delta = Math.max(delta, Math.abs(vts.points[i] - vtr.points[i]));
  near(delta, 2.0000112677109882e-12, 1e-25);
  assert.deepEqual([...vtr.pointData], [...vts.pointData]);
  const files = Object.fromEntries(
    ['flatplate/flatplate_0.vtr', 'flatplate/flatplate_1.vts'].map((p) => [p, readFileSync(new URL(p, root))]),
  );
  const composite = await openDataSet(readFileSync(new URL('flatplate.vtm', root)), { files });
  assert.deepEqual(composite.names, ['rectilinear', 'structured']);
  assert.equal(composite.types.length, 1632);
});
test('explicit baseURL resolves a relative composite input before fetching', async (t) => {
  const root = new URL('../../../examples/assets/sciviz/datasets/', import.meta.url);
  t.mock.method(globalThis, 'fetch', async (input) => {
    assert.equal(String(input), 'https://example.test/data/flatplate.vtm');
    return new Response(readFileSync(new URL('flatplate.vtm', root)));
  });
  const files = Object.fromEntries(
    ['flatplate/flatplate_0.vtr', 'flatplate/flatplate_1.vts'].map((p) => [p, readFileSync(new URL(p, root))]),
  );
  const data = await openDataSet('flatplate.vtm', { baseURL: 'https://example.test/data/', files });
  assert.equal(data.types.length, 1632);
});
test('PLOT3D binary endianness, real widths, record markers, blanking and invalid input', async () => {
  for (const precision of [4, 8])
    for (const little of [false, true])
      for (const markers of [false, true]) {
        const chunks = [],
          record = (parts) => {
            const data = Buffer.concat(parts);
            if (markers) {
              const b = Buffer.alloc(4);
              little ? b.writeInt32LE(data.length) : b.writeInt32BE(data.length);
              chunks.push(b, data, b);
            } else chunks.push(data);
          };
        const int = (n) => {
            const b = Buffer.alloc(4);
            little ? b.writeInt32LE(n) : b.writeInt32BE(n);
            return b;
          },
          real = (n) => {
            const b = Buffer.alloc(precision);
            b[`${precision === 4 ? 'writeFloat' : 'writeDouble'}${little ? 'LE' : 'BE'}`](n);
            return b;
          };
        record([int(1)]);
        record([int(2), int(1)]);
        record([real(0), real(2), real(0), real(0), int(1), int(0)]);
        const bytes = Buffer.concat(chunks),
          options = {
            binary: true,
            dimensions: 2,
            precision,
            littleEndian: little,
            recordMarkers: markers,
            iblank: true,
          };
        const grid = await parsePLOT3D(bytes, options);
        assert.deepEqual([...grid.points], [0, 0, 0, 2, 0, 0]);
        assert.deepEqual([...grid.pointArrays.iblank], [1, 0]);
        await assert.rejects(parsePLOT3D(bytes.subarray(0, bytes.length - 1), options));
      }
  await assert.rejects(parsePLOT3D('1 2 1 0 1 0 0 extra', { dimensions: 2 }));
  const reason = { cancel: true };
  await assert.rejects(createDataSet(rect, { signal: AbortSignal.abort(reason) }), (e) => e === reason);
  for (const input of [
    { ...rect, axes: [[0, 0], [0], [0]] },
    { ...rect, pointData: [1] },
    { kind: 'unstructured', points: [0, 0, 0], cells: [{ type: 1, ids: [-1] }] },
  ])
    await assert.rejects(createDataSet(input));
});
