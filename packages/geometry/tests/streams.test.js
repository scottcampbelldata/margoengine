import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boxGeometry,
  computeTangents,
  pbrVertexStream,
  footprintRadius,
  wireframe,
  wireframePositions,
} from '../dist/index.js';

test('line positions expand shared wireframe indices and apply the supplied lift', () => {
  const data = boxGeometry(2, 4, 6),
    edges = wireframe(data),
    positions = wireframePositions(data, 0.035);
  assert.equal(positions.length, edges.length * 3);
  for (let i = 0; i < edges.length; i++)
    for (let k = 0; k < 3; k++)
      assert.equal(positions[i * 3 + k], Math.fround(data.positions[edges[i] * 3 + k] + (k === 1 ? 0.035 : 0)));
  assert.throws(() => wireframePositions(data, NaN), /offset/);
});

test('PBR streams preserve tangent and UV attributes and pack bounded baked occlusion', () => {
  const data = computeTangents(boxGeometry(2, 4, 6)),
    stream = pbrVertexStream(data, (_x, y) => (y > 0 ? 1 : 0.2));
  assert.equal(stream.byteLength / (data.positions.length / 3), 80);
  assert.deepEqual(stream.slice(0, 3), data.positions.slice(0, 3));
  assert.equal(stream[3], 1);
  assert.deepEqual(stream.slice(8, 12), data.tangents.slice(0, 4));
  assert.deepEqual(stream.slice(12, 14), data.uvs.slice(0, 2));
  assert.deepEqual(stream.slice(14, 16), data.uvs.slice(0, 2));
  assert.ok(stream.every((v, i) => i % 20 < 16 || i % 20 === 19 || v === 1));
  assert.ok(stream.some((v, i) => i % 20 === 19 && Math.abs(v - 0.2) < 1e-6));
  assert.equal(footprintRadius(data), Math.hypot(1, 3));
  for (const ao of [NaN, -1, 2]) assert.throws(() => pbrVertexStream(data, () => ao), /occlusion/);
  assert.throws(() => pbrVertexStream({ ...data, tangents: undefined }), /attributes/);
  assert.throws(() => footprintRadius({ ...data, positions: new Float32Array([NaN, 0, 0]) }), /positions/);
});

function packedFixture(ArrayType = Float32Array) {
  const backed = (values) => {
    const buffer = new ArrayType(values.length + 4);
    buffer.set(values, 2);
    return buffer.subarray(2, values.length + 2);
  };
  return {
    positions: backed([-0, 1.25, -3.5, 4.5, -5.75, 6.875]),
    normals: backed([-1, 0, -0, 0.125, 0.25, 0.5]),
    tangents: backed([1, 0.125, -0.25, -1, -1, 0.25, 0.125, 1]),
    uvs: backed([-0, 1.375, -2.25, 0.375]),
    indices: new Uint32Array([0, 1, 0]),
  };
}
const bytes = (array) => Buffer.from(array.buffer, array.byteOffset, array.byteLength);

test('PBR packing preserves every ABI slot bit for bit, typed view offsets and default occlusion', () => {
  const empty = {
    positions: new Float32Array(),
    normals: new Float32Array(),
    uvs: new Float32Array(),
    tangents: new Float32Array(),
    indices: new Uint32Array(),
  };
  assert.deepEqual(pbrVertexStream(empty), new Float32Array());
  for (const ArrayType of [Float32Array, Float64Array]) {
    const data = packedFixture(ArrayType),
      before = structuredClone(data),
      expected = new Float32Array([
        -0, 1.25, -3.5, 1, -1, 0, -0, 0, 1, 0.125, -0.25, -1, -0, 1.375, -0, 1.375, 1, 1, 1, 1, 4.5, -5.75, 6.875, 1,
        0.125, 0.25, 0.5, 0, -1, 0.25, 0.125, 1, -2.25, 0.375, -2.25, 0.375, 1, 1, 1, 1,
      ]);
    assert.deepEqual(bytes(pbrVertexStream(data)), bytes(expected));
    assert.deepEqual(data, before);
    const calls = [],
      withAO = pbrVertexStream(data, (...point) => {
        calls.push(point);
        return calls.length === 1 ? 0.25 : 0.75;
      });
    expected[19] = 0.25;
    expected[39] = 0.75;
    assert.deepEqual(bytes(withAO), bytes(expected));
    assert.deepEqual(calls, [
      [-0, 1.25, -3.5],
      [4.5, -5.75, 6.875],
    ]);
  }
});

test('PBR packing avoids per-vertex views and copies attributes before calling occlusion', () => {
  const data = packedFixture(),
    subarray = Float32Array.prototype.subarray;
  let views = 0;
  Float32Array.prototype.subarray = function (...args) {
    views++;
    return subarray.apply(this, args);
  };
  try {
    pbrVertexStream(data);
  } finally {
    Float32Array.prototype.subarray = subarray;
  }
  assert.equal(views, 0, 'PBR packing created temporary attribute views');
  let calls = 0;
  const stream = pbrVertexStream(data, () => {
    if (++calls === 1) {
      data.positions[0] = 99;
      data.positions[3] = 7;
      data.normals[0] = 9;
      data.uvs[0] = 9;
    }
    return 0.5;
  });
  assert.equal(calls, 2);
  assert.equal(stream[0], -0);
  assert.equal(stream[4], -1);
  assert.equal(stream[12], -0);
  assert.equal(stream[20], 7);
  const failure = new Error('Occlusion failure');
  let invoked = 0;
  assert.throws(
    () =>
      pbrVertexStream(packedFixture(), () => {
        if (++invoked === 2) throw failure;
        return 1;
      }),
    (error) => error === failure,
  );
  assert.equal(invoked, 2);
  for (const value of [NaN, Infinity, -1, 2, '0.5']) {
    let calls = 0;
    assert.throws(
      () =>
        pbrVertexStream(packedFixture(), () => {
          calls++;
          return value;
        }),
      /Invalid baked vertex occlusion/,
    );
    assert.equal(calls, 1);
  }
  const invalid = packedFixture();
  invalid.positions[0] = NaN;
  let visited = 0;
  assert.throws(
    () =>
      pbrVertexStream(invalid, () => {
        visited++;
        return 1;
      }),
    /PBR vertex attributes must be finite/,
  );
  assert.equal(visited, 2);
  for (const invalid of [
    { ...packedFixture(), positions: new Float32Array(5) },
    { ...packedFixture(), normals: new Float32Array(3) },
    { ...packedFixture(), uvs: new Float32Array(2) },
    { ...packedFixture(), tangents: undefined },
  ])
    assert.throws(() => pbrVertexStream(invalid), /Invalid PBR vertex attributes/);
  assert.throws(() => pbrVertexStream(packedFixture(), 42), /Invalid PBR vertex attributes/);
});
