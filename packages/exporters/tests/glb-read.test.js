// readAccessor reads glTF accessors back from GLB bytes as plain packed data: strided, matrix-padded, sparse and
// view-less accessors, with bounds and finiteness checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { exportGLB, joinGLB, readAccessor, splitGLB } from '../dist/index.js';

const triangle = () =>
  exportGLB({
    nodes: [
      {
        name: 'Tri',
        geometry: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2] },
      },
    ],
  });

// A GLB of `json` whose BIN chunk holds `bin`.
const glb = (json, bin) =>
  joinGLB({
    json: { asset: { version: '2.0' }, buffers: [{ byteLength: bin.length }], ...json },
    bin,
    chunks: [],
  });

test('readAccessor returns the exported positions and indices', () => {
  const parts = splitGLB(triangle(), { copy: false }),
    primitive = parts.json.meshes[0].primitives[0],
    positions = readAccessor(parts, primitive.attributes.POSITION),
    indices = readAccessor(parts, primitive.indices);
  assert.equal(positions.width, 3);
  assert.equal(positions.count, 3);
  assert.equal(positions.componentType, 5126);
  assert.deepEqual([...positions.values], [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  assert.deepEqual([...indices.values].sort(), [0, 1, 2]);
  assert.equal(indices.width, 1);
});

test('readAccessor packs strided views and keeps integer values as stored', () => {
  // Two VEC2 uint16 elements with a 8-byte stride: [1, 2] pad pad [3, 4] pad pad.
  const bin = new Uint8Array(16),
    view = new DataView(bin.buffer);
  view.setUint16(0, 1, true);
  view.setUint16(2, 2, true);
  view.setUint16(8, 3, true);
  view.setUint16(10, 4, true);
  const parts = splitGLB(
    glb(
      {
        bufferViews: [{ buffer: 0, byteLength: 16, byteStride: 8 }],
        accessors: [{ bufferView: 0, componentType: 5123, normalized: true, count: 2, type: 'VEC2' }],
      },
      bin,
    ),
  );
  const out = readAccessor(parts, 0);
  assert.ok(out.values instanceof Uint16Array);
  assert.deepEqual([...out.values], [1, 2, 3, 4]);
  assert.equal(out.normalized, true);
});

test('readAccessor drops MAT2 byte column padding', () => {
  // MAT2 of uint8: each 2-byte column is padded to 4 bytes.
  const bin = Uint8Array.of(1, 2, 0, 0, 3, 4, 0, 0);
  const parts = splitGLB(
    glb(
      {
        bufferViews: [{ buffer: 0, byteLength: 8 }],
        accessors: [{ bufferView: 0, componentType: 5121, count: 1, type: 'MAT2' }],
      },
      bin,
    ),
  );
  assert.deepEqual([...readAccessor(parts, 0).values], [1, 2, 3, 4]);
});

test('readAccessor applies sparse values over zeros when there is no buffer view', () => {
  // Sparse: indices [2] (uint8, padded), values [7, 8, 9] (float32).
  const bin = new Uint8Array(16),
    view = new DataView(bin.buffer);
  bin[0] = 2;
  view.setFloat32(4, 7, true);
  view.setFloat32(8, 8, true);
  view.setFloat32(12, 9, true);
  const parts = splitGLB(
    glb(
      {
        bufferViews: [
          { buffer: 0, byteLength: 4 },
          { buffer: 0, byteOffset: 4, byteLength: 12 },
        ],
        accessors: [
          {
            componentType: 5126,
            count: 3,
            type: 'VEC3',
            sparse: { count: 1, indices: { bufferView: 0, componentType: 5121 }, values: { bufferView: 1 } },
          },
        ],
      },
      bin,
    ),
  );
  assert.deepEqual([...readAccessor(parts, 0).values], [0, 0, 0, 0, 0, 0, 7, 8, 9]);
});

test('readAccessor refuses bad accessors with the fix in the message', () => {
  const parts = splitGLB(triangle());
  assert.throws(() => readAccessor(parts, 99), { name: 'TypeError', message: /does not exist/ });
  const overrun = structuredClone(parts.json);
  overrun.accessors[0].count = 1000;
  assert.throws(() => readAccessor({ ...parts, json: overrun }, 0), { name: 'RangeError', message: /runs past/ });
  const external = structuredClone(parts.json);
  external.bufferViews[0].buffer = 1;
  assert.throws(() => readAccessor({ ...parts, json: external }, 0), { name: 'TypeError', message: /buffer 0/ });
  const nan = new Uint8Array(4);
  new DataView(nan.buffer).setFloat32(0, Number.NaN, true);
  const bad = splitGLB(
    glb(
      {
        bufferViews: [{ buffer: 0, byteLength: 4 }],
        accessors: [{ bufferView: 0, componentType: 5126, count: 1, type: 'SCALAR' }],
      },
      nan,
    ),
  );
  assert.throws(() => readAccessor(bad, 0), { name: 'RangeError', message: /non-finite/ });
});
