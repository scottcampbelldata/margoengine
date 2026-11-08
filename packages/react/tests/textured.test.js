// The glTF document a textured Box, Sphere or Plane hands the light loader (src/textured-document.ts), checked against the
// glTF 2.0 rules it relies on: accessors and buffer views (sections 3.6 and 3.7), 4-byte alignment of each view,
// POSITION min and max, and an image in a buffer view with its media type (section 3.8). Real PNG and JPEG files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { boxGeometry, planeGeometry, sphereGeometry } from '@margoengine/geometry';

const { texturedDocument } = await import('../dist/textured-document.js');
const asset = (path) => readFile(new URL(`../../../examples/assets/${path}`, import.meta.url));
const png = new Uint8Array(await asset('kaykit/dungeon/pieces/dungeon_texture.png')),
  jpeg = new Uint8Array(await asset('khronos-samples/CesiumMan.jpg'));
const material = { color: [1, 0.5, 0.25, 1], roughness: 0.4, metalness: 0.1 };

test('the document holds the shape, its UVs and the image, each view 4-byte aligned', () => {
  for (const [data, image, mime] of [
    [boxGeometry(2, 1, 0.5), png, 'image/png'],
    [sphereGeometry(1, 12, 8), jpeg, 'image/jpeg'],
    [planeGeometry(3, 2), png, 'image/png'],
  ]) {
    const { doc, buffer } = texturedDocument(data, image, material);
    assert.equal(doc.asset.version, '2.0');
    assert.equal(doc.buffers[0].byteLength, buffer.byteLength);
    for (const view of doc.bufferViews) {
      assert.equal(view.byteOffset % 4, 0, 'every view starts on a 4-byte boundary');
      assert.ok(view.byteOffset + view.byteLength <= buffer.byteLength);
    }
    const read = (accessor, Type) => {
      const view = doc.bufferViews[accessor.bufferView];
      return new Type(buffer.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
    };
    const [position, normal, uv, index] = doc.accessors;
    assert.deepEqual(read(position, Float32Array), data.positions);
    assert.deepEqual(read(normal, Float32Array), data.normals);
    assert.deepEqual(read(uv, Float32Array), data.uvs);
    assert.deepEqual(read(index, Uint32Array), data.indices);
    assert.equal(position.count, data.positions.length / 3);
    assert.equal(uv.type, 'VEC2');
    assert.equal(index.componentType, 5125);
    for (let k = 0; k < 3; k++) {
      const axis = data.positions.filter((_, i) => i % 3 === k);
      assert.equal(position.min[k], Math.min(...axis));
      assert.equal(position.max[k], Math.max(...axis));
    }
    const imageView = doc.bufferViews[doc.images[0].bufferView];
    assert.equal(doc.images[0].mimeType, mime);
    assert.equal(imageView.target, undefined, 'an image view has no vertex or index target');
    assert.deepEqual(buffer.subarray(imageView.byteOffset, imageView.byteOffset + imageView.byteLength), image);
    const pbr = doc.materials[0].pbrMetallicRoughness;
    assert.deepEqual(pbr.baseColorFactor, material.color);
    assert.equal(pbr.roughnessFactor, 0.4);
    assert.equal(pbr.metallicFactor, 0.1);
    assert.equal(pbr.baseColorTexture.index, 0);
    assert.deepEqual(doc.meshes[0].primitives[0].attributes, { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 });
  }
});

test('a map that is neither PNG nor JPEG is refused with the fix', () => {
  const webp = new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ');
  assert.throws(
    () => texturedDocument(planeGeometry(), webp, material),
    (error) => error.code === 'unsupported' && /neither PNG nor JPEG; convert it/.test(error.message),
  );
});
