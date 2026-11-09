import assert from 'node:assert/strict';
import test from 'node:test';
import { packGLTF } from '../scripts/reference-rendering/pack.mjs';

test('reference packing preserves every source scene value and byte across aligned buffers and images', () => {
  const input = {
    asset: { version: '2.0' },
    buffers: [
      { uri: 'a.bin', byteLength: 3 },
      { uri: 'b.bin', byteLength: 5 },
    ],
    bufferViews: [
      { buffer: 0, byteLength: 3 },
      { buffer: 1, byteOffset: 1, byteLength: 4, byteStride: 4 },
    ],
    images: [{ uri: 'a.png', name: 'original image' }, { uri: 'b.jpg' }],
    materials: [{ name: 'original', extensions: { KHR_materials_iridescence: { iridescenceFactor: 1 } } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    nodes: [{ mesh: 0, translation: [1, 2, 3] }],
    accessors: [{ bufferView: 0, componentType: 5121, count: 1, type: 'VEC3' }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  const before = structuredClone(input);
  const buffers = [Uint8Array.of(1, 2, 3), Uint8Array.of(4, 5, 6, 7, 8)];
  const images = [
    { bytes: Uint8Array.of(9, 10), mimeType: 'image/png' },
    { bytes: Uint8Array.of(11), mimeType: 'image/jpeg' },
  ];
  const packed = packGLTF(input, buffers, images);
  assert.deepEqual(input, before);
  assert.equal(packed.readUInt32LE(0), 0x46546c67);
  assert.equal(packed.readUInt32LE(4), 2);
  assert.equal(packed.readUInt32LE(8), packed.length);
  assert.equal(packed.length % 4, 0);
  const n = packed.readUInt32LE(12),
    doc = JSON.parse(packed.subarray(20, 20 + n));
  const bin = packed.subarray(28 + n);
  assert.equal(packed.readUInt32LE(20 + n), bin.length);
  for (const key of ['materials', 'meshes', 'nodes', 'accessors', 'scenes', 'scene'])
    assert.deepEqual(doc[key], input[key]);
  assert.deepEqual([...bin.subarray(0, 3)], [1, 2, 3]);
  assert.deepEqual([...bin.subarray(4, 9)], [4, 5, 6, 7, 8]);
  assert.deepEqual(doc.bufferViews.slice(0, 2), [
    { buffer: 0, byteLength: 3, byteOffset: 0 },
    { buffer: 0, byteOffset: 5, byteLength: 4, byteStride: 4 },
  ]);
  for (const [index, image] of doc.images.entries()) {
    assert.equal(image.uri, undefined);
    assert.equal(image.mimeType, images[index].mimeType);
    const view = doc.bufferViews[image.bufferView];
    assert.equal(view.byteOffset % 4, 0);
    assert.deepEqual([...bin.subarray(view.byteOffset, view.byteOffset + view.byteLength)], [...images[index].bytes]);
  }
  assert.equal(doc.images[0].name, 'original image');
  assert.deepEqual(packGLTF(input, buffers, images), packed);
});

test('reference packing rejects missing or shortened source resources and invalid views', () => {
  const base = {
    buffers: [{ byteLength: 3 }],
    bufferViews: [{ buffer: 0, byteLength: 3 }],
    images: [{ uri: 'a.png' }],
  };
  assert.throws(() => packGLTF(base, [], []), /every original buffer/);
  assert.throws(() => packGLTF(base, [Uint8Array.of(1)], []), /length changed/);
  assert.throws(() => packGLTF(base, [Uint8Array.of(1, 2, 3)], []), /original image/);
  for (const view of [
    { buffer: 1, byteLength: 3 },
    { buffer: 0, byteOffset: -1, byteLength: 3 },
    { buffer: 0, byteLength: 4 },
  ]) {
    assert.throws(() => packGLTF({ ...base, bufferViews: [view] }, [Uint8Array.of(1, 2, 3)], []));
  }
});
