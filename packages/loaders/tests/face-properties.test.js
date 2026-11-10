import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePLY } from '@margoengine/loaders/ply';
import { parseOFF } from '@margoengine/loaders/off';

const text = (s) => new TextEncoder().encode(s);
const vertices = '0 0 0\n1 0 0\n1 1 0\n0 1 0\n';
const header = (format) =>
  `ply\nformat ${format} 1.0\nelement vertex 4\nproperty float x\nproperty float y\nproperty float z\nelement face 2\nproperty float quality\nproperty list uchar int vertex_indices\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nproperty uchar alpha\nproperty list uchar float samples\nproperty int material_index\nend_header\n`;
function ply(format) {
  if (format === 'ascii')
    return text(
      header(format) + vertices + '0.25 4 0 1 2 3 255 0 0 128 2 1.5 2.5 7\n0.75 3 0 2 3 0 255 0 255 1 3.5 8\n',
    );
  const words = [];
  const little = format === 'binary_little_endian';
  const put = (type, n) => {
    const bytes = new Uint8Array(type === 'u8' ? 1 : 4),
      view = new DataView(bytes.buffer);
    if (type === 'u8') view.setUint8(0, n);
    else if (type === 'f32') view.setFloat32(0, n, little);
    else view.setInt32(0, n, little);
    words.push(...bytes);
  };
  vertices
    .trim()
    .split(/\s+/)
    .forEach((n) => put('f32', Number(n)));
  for (const [q, face, rgba, samples, material] of [
    [0.25, [0, 1, 2, 3], [255, 0, 0, 128], [1.5, 2.5], 7],
    [0.75, [0, 2, 3], [0, 255, 0, 255], [3.5], 8],
  ]) {
    put('f32', q);
    put('u8', face.length);
    face.forEach((n) => put('i32', n));
    rgba.forEach((n) => put('u8', n));
    put('u8', samples.length);
    samples.forEach((n) => put('f32', n));
    put('i32', material);
  }
  return new Uint8Array([...text(header(format)), ...words]);
}
for (const format of ['ascii', 'binary_little_endian', 'binary_big_endian'])
  test(`PLY ${format}: colors and owned scalar/list properties follow polygon ranges`, () => {
    const model = parsePLY(ply(format));
    assert.deepEqual([...model.indices], [0, 1, 2, 0, 2, 3, 0, 2, 3]);
    assert.deepEqual(
      model.groups.map((g) => [g.start, g.count, g.color]),
      [
        [0, 6, [1, 0, 0, 128 / 255]],
        [6, 3, [0, 1, 0, 1]],
      ],
    );
    assert.equal(model.groups[0].properties.quality, 0.25);
    assert.equal(model.groups[1].properties.material_index, 8);
    assert.deepEqual(model.groups[0].properties.samples, [1.5, 2.5]);
    assert.deepEqual(model.groups[1].properties.samples, [3.5]);
    assert.throws(() => parsePLY(ply(format), { maxTriangles: 2 }), { code: 'limit' });
    const sub = new Uint8Array(ply(format).length + 9);
    sub.set(ply(format), 5);
    assert.deepEqual(parsePLY(sub.subarray(5, -4)), model);
  });
test('PLY properties safely retain prototype names', () => {
  const bytes = text(
    'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nproperty int __proto__\nproperty list uchar int constructor\nend_header\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2 12 2 4 5\n',
  );
  const p = parsePLY(bytes).groups[0].properties;
  assert.equal(p.__proto__, 12);
  assert.deepEqual(p.constructor, [4, 5]);
  assert.equal(Object.getPrototypeOf(p), null);
});
test('OFF face colors, colormap indices and default mixed-face gray survive', () => {
  const mesh = parseOFF(
    text(`OFF\n4 4 0\n${vertices}4 0 1 2 3 255 0 0 128\n3 0 1 2 0.25 0.5 0.75\n3 0 2 3\n3 1 2 3 7\n`),
  );
  assert.deepEqual(
    mesh.groups.map((g) => [g.start, g.count]),
    [
      [0, 6],
      [6, 3],
      [9, 3],
      [12, 3],
    ],
  );
  assert.deepEqual(mesh.groups[0].color, [1, 0, 0, 128 / 255]);
  assert.deepEqual(mesh.groups[1].color, [0.25, 0.5, 0.75, 1]);
  assert.deepEqual(mesh.groups[2].color, [0.666, 0.666, 0.666, 0.666]);
  assert.deepEqual(mesh.groups[3].properties, { colorIndex: 7 });
});
function binaryOFF() {
  const bytes = [...text('STCNOFF BINARY # big endian\r\n')];
  const put = (value, integer = false) => {
    const b = new Uint8Array(4),
      v = new DataView(b.buffer);
    if (integer) v.setInt32(0, value, false);
    else v.setFloat32(0, value, false);
    bytes.push(...b);
  };
  [4, 2, 0].forEach((n) => put(n, true));
  for (const p of [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
  ])
    [...p, 0, 0, 1, 0.25, 0.5, 0.75, 1, 0.5, 0.25].forEach((n) => put(n));
  [4, 0, 1, 2, 3, 4].forEach((n) => put(n, true));
  [1, 0, 0, 0.5].forEach((n) => put(n));
  [3, 0, 2, 3, 0].forEach((n) => put(n, true));
  return new Uint8Array(bytes);
}
test('binary OFF: big endian counts, vertex attributes, colors, subarray and exact truncation checks', () => {
  const bytes = binaryOFF(),
    mesh = parseOFF(bytes);
  assert.deepEqual([...mesh.positions], vertices.trim().split(/\s+/).map(Number));
  assert.deepEqual([...mesh.indices], [0, 1, 2, 0, 2, 3, 0, 2, 3]);
  assert.deepEqual([...mesh.normals.slice(0, 3)], [0, 0, 1]);
  assert.deepEqual([...mesh.colors.slice(0, 3)], [0.25, 0.5, 0.75]);
  assert.deepEqual([...mesh.uvs.slice(0, 2)], [0.5, 0.25]);
  assert.deepEqual(mesh.groups[0].color, [1, 0, 0, 0.5]);
  assert.deepEqual(mesh.groups[1].color, [0.666, 0.666, 0.666, 0.666]);
  for (let end = text('STCNOFF BINARY # big endian\r\n').length; end < bytes.length; end++)
    assert.throws(
      () => parseOFF(bytes.subarray(0, end)),
      (e) => e.name === 'LoaderError',
    );
  assert.throws(() => parseOFF(bytes, { maxTriangles: 2 }), { code: 'limit' });
  const padded = new Uint8Array(bytes.length + 8);
  padded.set(bytes, 4);
  assert.deepEqual(parseOFF(padded.subarray(4, -4)), mesh);
});
test('OFF rejects malformed color arity and values', () => {
  for (const color of ['1 2', '-1 0 0', '0 0 Infinity', '0 0 256', '1.5'])
    assert.throws(
      () => parseOFF(text(`OFF\n4 1 0\n${vertices}4 0 1 2 3 ${color}\n`)),
      (e) => e.name === 'LoaderError',
    );
});
