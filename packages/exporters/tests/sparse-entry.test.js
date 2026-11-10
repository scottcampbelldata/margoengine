import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { exportSparseGLB, layoutGLB } from '@margoengine/exporters/sparse';
import { exportGLB, joinGLB, readAccessor, splitGLB } from '@margoengine/exporters';
import { compressDraco } from '@margoengine/exporters/draco';
import { validate } from './helpers.js';

const triangle = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2] };
const fixture = async () => new Uint8Array(await readFile(new URL('./fixtures/Box.glb', import.meta.url)));
function equalAccessors(a, b) {
  assert.equal(a.json.accessors.length, b.json.accessors.length);
  for (let i = 0; i < a.json.accessors.length; i++) {
    const before = readAccessor(a, i),
      after = readAccessor(b, i);
    assert.deepEqual(after.values, before.values, `accessor ${i}`);
    assert.equal(after.width, before.width);
    for (const field of ['count', 'componentType', 'type', 'normalized', 'min', 'max'])
      assert.deepEqual(b.json.accessors[i][field], a.json.accessors[i][field], `${i}.${field}`);
  }
}

test('real licensed Box geometry interleaves without changing any decoded accessor value', async () => {
  const source = await fixture(),
    copy = source.slice(),
    result = layoutGLB(source, { sparse: false }),
    out = splitGLB(result.glb),
    p = out.json.meshes[0].primitives[0];
  equalAccessors(splitGLB(source), out);
  assert.deepEqual(source, copy);
  assert.equal(result.stats.streams, 1);
  assert.equal(result.stats.interleaved, 2);
  assert.equal(
    out.json.accessors[p.attributes.POSITION].bufferView,
    out.json.accessors[p.attributes.NORMAL].bufferView,
  );
  const report = await validate(result.glb);
  assert.equal(report.errors + report.warnings, 0, JSON.stringify(report.messages));
});

test('sparse morph targets save bytes on write and retain exact dense values and bounds', async () => {
  const n = 90,
    positions = Float32Array.from({ length: n * 3 }, (_, i) => {
      const v = Math.floor(i / 3);
      return i % 3 === 0 ? Math.floor(v / 3) * 2 + (v % 3 === 1 ? 1 : 0) : i % 3 === 1 && v % 3 === 2 ? 1 : 0;
    }),
    normals = Float32Array.from({ length: n * 3 }, (_, i) => (i % 3 === 2 ? 1 : 0)),
    deltas = new Float32Array(n * 3);
  deltas[4 * 3] = 0.25;
  const source = {
      nodes: [
        {
          geometry: {
            positions,
            normals,
            indices: Uint16Array.from({ length: n }, (_, i) => i),
            morphs: [{ positions: deltas }],
          },
          morphWeights: [0.5],
        },
      ],
    },
    dense = exportGLB(source),
    sparse = exportSparseGLB(source, { sparse: 'morphs', interleave: false }),
    before = splitGLB(dense),
    out = splitGLB(sparse),
    index = out.json.meshes[0].primitives[0].targets[0].POSITION;
  assert.ok(out.json.accessors[index].sparse);
  assert.equal(out.json.accessors[index].bufferView, undefined);
  assert.ok(sparse.length < dense.length);
  equalAccessors(before, out);
  const report = await validate(sparse);
  assert.equal(report.errors, 0, JSON.stringify(report.messages));
});

function scalar(count, index, value = 7) {
  const values = new Float32Array(count);
  values[index] = value;
  return {
    json: {
      asset: { version: '2.0' },
      buffers: [{ byteLength: values.byteLength }],
      bufferViews: [{ buffer: 0, byteLength: values.byteLength }],
      accessors: [{ bufferView: 0, count, componentType: 5126, type: 'SCALAR' }],
    },
    bin: new Uint8Array(values.buffer),
  };
}
test('sparse index widths, implicit zeros and negative zero all retain exact values', () => {
  for (const [count, index, type] of [
    [90, 89, 5121],
    [400, 399, 5123],
    [70000, 69999, 5125],
  ]) {
    const parts = scalar(count, index),
      result = layoutGLB(joinGLB(parts), { interleave: false }),
      out = splitGLB(result.glb);
    assert.equal(out.json.accessors[0].sparse.indices.componentType, type);
    equalAccessors(parts, out);
  }
  const zero = scalar(90, 0, 0),
    z = splitGLB(layoutGLB(joinGLB(zero), { interleave: false }).glb);
  assert.equal(z.bin, null);
  assert.equal(z.json.buffers, undefined);
  assert.equal(z.json.accessors[0].sparse, undefined);
  equalAccessors(zero, z);
  const signed = scalar(90, 0, -0),
    s = splitGLB(layoutGLB(joinGLB(signed), { interleave: false }).glb);
  assert.ok(Object.is(readAccessor(s, 0).values[0], -0));
  equalAccessors(signed, s);
});

test('byte MAT3 sparse replacement values preserve per-column four-byte padding', () => {
  const bytes = new Uint8Array(80 * 12);
  bytes[79 * 12 + 9] = 9;
  const parts = {
    json: {
      asset: { version: '2.0' },
      buffers: [{ byteLength: bytes.length }],
      bufferViews: [{ buffer: 0, byteLength: bytes.length }],
      accessors: [{ bufferView: 0, componentType: 5121, type: 'MAT3', count: 80 }],
    },
    bin: bytes,
  };
  const out = splitGLB(layoutGLB(joinGLB(parts), { interleave: false }).glb);
  assert.equal(out.json.accessors[0].sparse.count, 1);
  equalAccessors(parts, out);
  assert.equal(out.json.bufferViews[out.json.accessors[0].sparse.values.bufferView].byteLength, 12);
});

test('many shared vertex accessors split at the 252-byte stride limit and remain aligned', async () => {
  const parts = splitGLB(await fixture()),
    p = parts.json.meshes[0].primitives[0],
    original = parts.json.accessors[p.attributes.POSITION];
  for (let i = 0; i < 25; i++)
    p.attributes[`_ATTRIBUTE_${i}`] = parts.json.accessors.push(structuredClone(original)) - 1;
  const before = structuredClone(parts),
    result = layoutGLB(joinGLB(parts), { sparse: false }),
    out = splitGLB(result.glb);
  assert.equal(result.stats.streams, 2);
  equalAccessors(before, out);
  for (const a of out.json.accessors)
    if (a.bufferView !== undefined && out.json.bufferViews[a.bufferView].byteStride) {
      assert.equal((a.byteOffset ?? 0) % 4, 0);
      assert.ok(out.json.bufferViews[a.bufferView].byteStride <= 252);
    }
});

test('normalized byte attributes survive interleaving with correct offsets and strides', () => {
  const source = exportGLB({ nodes: [{ geometry: triangle }] }),
    parts = splitGLB(source),
    old = parts.bin,
    bin = new Uint8Array(old.length + 12);
  bin.set(old);
  bin.set([0, 1, 255, 0, 2, 3, 4, 0, 5, 6, 7, 0], old.length);
  parts.bin = bin;
  parts.json.buffers[0].byteLength = bin.length;
  const view =
      parts.json.bufferViews.push({ buffer: 0, byteOffset: old.length, byteLength: 12, byteStride: 4, target: 34962 }) -
      1,
    a =
      parts.json.accessors.push({ bufferView: view, componentType: 5121, type: 'VEC3', count: 3, normalized: true }) -
      1;
  parts.json.meshes[0].primitives[0].attributes._BYTE = a;
  const out = splitGLB(layoutGLB(joinGLB(parts), { sparse: false }).glb);
  equalAccessors(parts, out);
  assert.equal(out.json.accessors[a].normalized, true);
  const stride = out.json.bufferViews[out.json.accessors[a].bufferView].byteStride;
  assert.equal(stride, 28);
});

test('compression-owned accessors stay intact; options, final limits and aborts are enforced', async () => {
  const source = await fixture(),
    compressed = await compressDraco(source),
    parts = splitGLB(compressed.glb),
    out = splitGLB(layoutGLB(compressed.glb).glb);
  assert.deepEqual(out.json.meshes, parts.json.meshes);
  assert.throws(() => layoutGLB(source, { maxBytes: 10 }), /MARGO_EXPORT_LAYOUT_SIZE/);
  assert.throws(() => layoutGLB(source, { sparse: 'yes' }), /MARGO_EXPORT_LAYOUT_OPTIONS/);
  assert.throws(() => layoutGLB(source, { signal: AbortSignal.abort() }), { name: 'AbortError' });
});
