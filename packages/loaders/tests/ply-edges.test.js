// Turk's PLY format description gives `edge` elements (vertex1, vertex2, optional colour) beside vertex and face;
// parsePLY reads them into `lines`, ASCII and binary, before or after the faces, and rejects an edge outside the vertices.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LoaderError, parsePLY } from '../dist/index.js';

const vertexHeader = ['element vertex 3', 'property float x', 'property float y', 'property float z'];

test('PLY: edge elements become line segments in ASCII and binary', async () => {
  const ascii = [
    'ply',
    'format ascii 1.0',
    ...vertexHeader,
    'element edge 2',
    'property int vertex1',
    'property int vertex2',
    'property uchar red',
    'property uchar green',
    'property uchar blue',
    'end_header',
    '0 0 0',
    '1 0 0',
    '1 1 0',
    '0 1 255 0 0',
    '1 2 0 255 0',
    '',
  ].join('\n');
  const a = await parsePLY(new TextEncoder().encode(ascii));
  assert.equal(a.kind, 'points');
  assert.deepEqual([...a.lineIndices], [0, 1, 1, 2]);

  const head = new TextEncoder().encode(
    [
      'ply',
      'format binary_little_endian 1.0',
      ...vertexHeader,
      'element edge 1',
      'property int vertex1',
      'property int vertex2',
      'element face 1',
      'property list uchar uint vertex_indices',
      'end_header',
      '',
    ].join('\n'),
  );
  const out = new Uint8Array(head.length + 36 + 8 + 13),
    view = new DataView(out.buffer);
  out.set(head);
  let o = head.length;
  for (const v of [0, 0, 0, 1, 0, 0, 1, 1, 0]) view.setFloat32(o, v, true), (o += 4);
  view.setInt32(o, 2, true);
  view.setInt32(o + 4, 0, true);
  o += 8;
  out[o] = 3;
  [0, 1, 2].forEach((v, i) => view.setUint32(o + 1 + i * 4, v, true));
  const b = await parsePLY(out);
  assert.equal(b.kind, 'mesh');
  assert.deepEqual([...b.indices], [0, 1, 2]);
  assert.deepEqual([...b.lineIndices], [2, 0]);
});

test('PLY: an edge naming a missing vertex is a range error', async () => {
  const text = [
    'ply',
    'format ascii 1.0',
    ...vertexHeader,
    'element edge 1',
    'property int vertex1',
    'property int vertex2',
    'end_header',
    '0 0 0',
    '1 0 0',
    '1 1 0',
    '0 3',
    '',
  ].join('\n');
  await assert.rejects(
    async () => parsePLY(new TextEncoder().encode(text)),
    (error) => error instanceof LoaderError && error.code === 'range',
  );
});
