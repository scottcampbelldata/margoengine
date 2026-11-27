// export3MF's layers, by the 3MF Slice Extension specification (https://github.com/3MFConsortium/spec_slice), read
// back through `parse3MFLattice`, and parse3MF passing them by.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse3MF, readZipDirectory, readZipEntry } from '@margoengine/loaders';
import { parse3MFLattice } from '@margoengine/loaders/threemf-lattice';
import { export3MF } from '@margoengine/exporters/threemf';

const corners = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
const faces = [
  0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
];
const box = {
  positions: new Float32Array(corners),
  normals: new Float32Array(corners.length),
  indices: new Uint32Array(faces),
};
/** A square of the box's cross section, counter-clockwise, in metres. */
const square = [0, 0, 1, 0, 1, 1, 0, 1];
const slices = { layers: [{ top: 0.5, contours: [square] }, { top: 0.75 }, { top: 1, contours: [[...square, 0, 0]] }] };
const attributes = (tag) => Object.fromEntries([...tag.matchAll(/([\w:]+)="([^"]*)"/g)].map(([, k, v]) => [k, v]));
const elements = (text, name) =>
  [...text.matchAll(new RegExp(`<${name}((?: [^>]*?)?)/?>`, 'g'))].map((m) => attributes(m[1]));
const parts = async (file) => {
  const out = {};
  for (const entry of readZipDirectory(file))
    out[entry.name] = new TextDecoder().decode(await readZipEntry(file, entry));
  return out;
};
const ROOT = '3D/3dmodel.model';
const written = async (given, options = {}, node = {}) => {
  const file = await export3MF(
    { nodes: [{ name: 'block', geometry: box, ...node }] },
    { unit: 'meter', upAxis: 'z', objectInfo: () => ({ slices: given }), ...options },
  );
  const all = await parts(file);
  return { file, all, text: all[ROOT], read: await parse3MFLattice(file, { units: 'file' }) };
};

test('layers are a slice stack the object names, gaps included, which read back', async () => {
  const { file, text, read } = await written(slices),
    [model] = elements(text, 'model'),
    [stack] = elements(text, 's:slicestack'),
    [object] = elements(text, 'object');
  assert.equal(model['xmlns:s'], 'http://schemas.microsoft.com/3dmanufacturing/slice/2015/07');
  // A full-resolution mesh serves a reader without the extension, so nothing is required.
  assert.equal(model.requiredextensions, undefined);
  assert.equal(object['s:slicestackid'], stack.id);
  assert.equal(object['s:meshresolution'], undefined);
  assert.equal(stack.zbottom, '0');
  assert.ok(text.indexOf('<s:slicestack') < text.indexOf('<object'));
  // The void layer holds nothing but its height.
  assert.ok(text.includes('<s:slice ztop="0.75"></s:slice>'));
  const [{ layers }] = read.sliceStacks;
  assert.deepEqual(
    layers.map((l) => [l.top, l.polygons.length]),
    [
      [0.5, 1],
      [0.75, 0],
      [1, 1],
    ],
  );
  for (const layer of [layers[0], layers[2]]) {
    // A solid's contour closes on its first vertex; a repeated end point adds no vertex.
    assert.deepEqual([...layer.vertices], square);
    const [polygon] = layer.polygons;
    assert.equal(polygon.start, 0);
    assert.deepEqual(
      polygon.segments.map((s) => s.vertex),
      [1, 2, 3, 0],
    );
  }
  assert.equal(read.sliceInstances.length, 1);
  // A reader without the extension reads the mesh and passes the layers by.
  assert.equal((await parse3MF(file)).indices.length, 36);
});

test('a Y-up scene stands the object up, so its build transform keeps layers level', async () => {
  const { text, read } = await written(
      slices,
      { upAxis: 'y' },
      // A quarter turn about the up axis, a move, and a wider bed footprint.
      { rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2], translation: [5, 2, 3] },
    ),
    [item] = elements(text, 'item'),
    m = item.transform.split(' ');
  // m02, m12, m20 and m21 must be written as 0 and m22 as 1 (chapter 1).
  assert.deepEqual([m[2], m[5], m[6], m[7], m[8]], ['0', '0', '0', '0', '1']);
  assert.deepEqual(m.slice(9), ['5', '-3', '2']);
  // The box's Y is now the file's Z.
  const vertices = elements(text, 'vertex').map((v) => [Number(v.x), Number(v.y), Number(v.z)]);
  assert.deepEqual(vertices[3], [0, 0, 1]);
  assert.deepEqual(vertices[4], [0, -1, 0]);
  assert.equal(read.indices.length, 36);
});

test('low-resolution meshes require the extension, and layers may live in a part of their own', async () => {
  const { all, text, read } = await written(
      {
        bottom: 0.25,
        meshResolution: 'lowres',
        separatePart: true,
        layers: [{ top: 0.5, contours: [{ points: square, color: ['#ff0000', '#00FF00', '#FF0000', '#00FF00'] }] }],
      },
      { production: { separateParts: true } },
    ),
    [model] = elements(text, 'model'),
    [object] = elements(text, 'object'),
    [ref] = elements(text, 's:sliceref');
  assert.equal(model.requiredextensions, 's');
  assert.equal(object['s:meshresolution'], 'lowres');
  assert.match(ref.slicepath, /^\/2D\/slices\d+\.model$/);
  assert.ok(all['3D/_rels/3dmodel.model.rels'].includes(`Target="${ref.slicepath}"`));
  const layers = all[ref.slicepath.slice(1)],
    [inner] = elements(layers, 's:slicestack'),
    [group] = elements(layers, 'm:colorgroup');
  assert.equal(inner.id, ref.slicestackid);
  assert.equal(inner.zbottom, '0.25');
  assert.ok(layers.includes('<build/>'));
  // Each segment runs from one point's colour to the next one's, in the part's own group.
  assert.deepEqual(
    elements(layers, 's:segment').map((s) => [s.pid, s.p1, s.p2]),
    [
      [group.id, '0', '1'],
      [group.id, '1', '0'],
      [group.id, '0', '1'],
      [group.id, '1', '0'],
    ],
  );
  const stack = read.sliceStacks.find((s) => s.references.length);
  assert.equal(stack.layers.length, 1);
  assert.equal(stack.bottom, 0.25);
});

test('a support has open paths', async () => {
  const { text, read } = await written(
    { layers: [{ top: 1, contours: [[0, 0, 1, 0, 1, 1]] }] },
    { objectInfo: () => ({ type: 'support', slices: { layers: [{ top: 1, contours: [[0, 0, 1, 0, 1, 1]] }] } }) },
  );
  assert.deepEqual(
    elements(text, 's:segment').map((s) => s.v2),
    ['1', '2'],
  );
  assert.equal(read.sliceStacks[0].layers[0].polygons[0].segments.length, 2);
});

test('a mirrored node mirrors its layers and keeps them counter-clockwise', async () => {
  const { read } = await written(slices, {}, { scale: [-1, 1, 1] });
  const [layer] = read.sliceStacks[0].layers,
    walk = [layer.polygons[0].start, ...layer.polygons[0].segments.map((s) => s.vertex)],
    point = (v) => [layer.vertices[v * 2], layer.vertices[v * 2 + 1]];
  let area = 0;
  for (let i = 0; i + 1 < walk.length; i++) {
    const [a, b] = [point(walk[i]), point(walk[i + 1])];
    area += a[0] * b[1] - b[0] * a[1];
  }
  assert.equal(area / 2, 1);
  assert.equal(Math.min(...layer.vertices), -1);
});

test('layers the extension would reject are refused', async () => {
  const refused = (given, options, node) => assert.rejects(written(given, options, node), RangeError);
  await refused({ layers: [] });
  await refused({ layers: [{ top: 0 }] });
  await refused({ layers: [{ top: 1 }, { top: 1 }] });
  await refused({ bottom: 2, layers: [{ top: 1 }] });
  await refused({ layers: [{ top: 1, contours: [[0, 0, 1, 0]] }] });
  await refused({ layers: [{ top: 1, contours: [[0, 0, 0, 0, 1, 1]] }] });
  await refused({ layers: [{ top: 1, contours: [[0, 0, 1]] }] });
  await refused({ layers: [{ top: 1, contours: [{ points: square, color: ['#FF0000'] }] }] });
  await refused({ ...slices, meshResolution: 'coarse' });
  // Tilted, or taller than its layers say.
  await refused(slices, {}, { rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] });
  await refused(slices, {}, { scale: [1, 1, 2] });
  await refused(slices, { upAxis: 'y' }, { scale: [1, 2, 1] });
  await assert.rejects(
    export3MF({ nodes: [{ geometry: box }, { geometry: box }] }, { objectInfo: () => ({ slices }) }),
    RangeError,
  );
});
