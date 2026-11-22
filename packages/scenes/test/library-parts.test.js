// libraryParts (KB-SCATTER-TEX1): a library glTF as one textured part per material, so a scanned fir draws its bark and
// needle maps in the forest scatter. Before it, a library model drew as one merged part of one flat colour.
import test from 'node:test';
import assert from 'node:assert/strict';

test('libraryParts splits a glTF by material with its uvs, texture transform and maps', async () => {
  const { libraryParts } = await import('@margoengine/scenes/library');
  // Two triangles: one bark (material 0), one needle card (material 1, MASK, base colour with a texture transform).
  const bin = new ArrayBuffer(6 * 12 * 2 + 6 * 8 + 12),
    p = new Float32Array(bin, 0, 18 * 2),
    t = new Float32Array(bin, 144, 12),
    i = new Uint16Array(bin, 192, 6);
  p.set([0, 1, 0, 1, 1, 0, 0, 2, 0, 0, 3, 0, 1, 3, 0, 0, 4, 0]);
  p.set([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 18);
  t.set([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  i.set([0, 1, 2, 0, 1, 2]);
  const view = (byteOffset, byteLength) => ({ buffer: 0, byteOffset, byteLength }),
    acc = (bufferView, byteOffset, count, type, componentType = 5126) => ({
      bufferView,
      byteOffset,
      componentType,
      count,
      type,
    }),
    doc = {
      asset: { version: '2.0' },
      buffers: [{ uri: 'f.bin', byteLength: bin.byteLength }],
      bufferViews: [view(0, 144), view(144, 48), view(192, 12)],
      accessors: [
        acc(0, 0, 3, 'VEC3'),
        acc(0, 36, 3, 'VEC3'),
        acc(0, 72, 3, 'VEC3'),
        acc(0, 108, 3, 'VEC3'),
        acc(1, 0, 3, 'VEC2'),
        acc(1, 24, 3, 'VEC2'),
        acc(2, 0, 3, 'SCALAR', 5123),
        acc(2, 6, 3, 'SCALAR', 5123),
      ],
      meshes: [
        {
          primitives: [
            { attributes: { POSITION: 0, NORMAL: 2, TEXCOORD_0: 4 }, indices: 6, material: 0 },
            { attributes: { POSITION: 1, NORMAL: 3, TEXCOORD_0: 5 }, indices: 7, material: 1 },
          ],
        },
      ],
      materials: [
        { name: 'fir_bark', pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, normalTexture: { index: 1 } },
        {
          name: 'fir_twig',
          alphaMode: 'MASK',
          alphaCutoff: 0.3,
          pbrMetallicRoughness: {
            baseColorFactor: [0.9, 1, 0.9, 1],
            baseColorTexture: {
              index: 2,
              extensions: { KHR_texture_transform: { offset: [0, 0.5], scale: [2, 0.5] } },
            },
          },
        },
      ],
      textures: [{ source: 0 }, { source: 1 }, { source: 2 }],
      images: [
        { uri: 'bark.jpg', mimeType: 'image/jpeg' },
        { uri: 'bark_nor.jpg', mimeType: 'image/jpeg' },
        { uri: 'twig.png' },
      ],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
    },
    fetched = [],
    fetch = async (url) => {
      fetched.push(url);
      if (url.endsWith('.gltf')) return { ok: true, status: 200, json: async () => doc };
      if (url.endsWith('f.bin')) return { ok: true, status: 200, arrayBuffer: async () => bin };
      return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(url).buffer };
    },
    decode = async (bytes, mime) => ({
      width: 1,
      height: 1,
      data: new Uint8Array(4),
      name: new TextDecoder().decode(bytes),
      mime,
    }),
    [bark, twig] = await libraryParts('/lib/fir/fir.gltf', { fetch, decode });
  assert.equal(bark.name, 'fir_bark');
  assert.equal(bark.kind, 'bark');
  assert.equal(twig.kind, 'foliage', 'a MASK material is foliage');
  assert.deepEqual(Array.from(bark.geometry.positions), [-0.5, 0, 0, 0.5, 0, 0, -0.5, 1, 0], 'one frame for all parts');
  assert.deepEqual(Array.from(twig.geometry.positions), [-0.5, 2, 0, 0.5, 2, 0, -0.5, 3, 0]);
  assert.deepEqual(Array.from(bark.textures.uvs), [0, 0, 1, 0, 0, 1]);
  assert.deepEqual(Array.from(twig.textures.uvs), [0, 0.5, 2, 0.5, 0, 1], 'KHR_texture_transform offset and scale');
  assert.equal(bark.textures.baseColor.name, '/lib/fir/bark.jpg');
  assert.equal(bark.textures.normal.name, '/lib/fir/bark_nor.jpg');
  assert.equal(twig.textures.baseColor.mime, 'image/png');
  assert.equal(twig.textures.alphaCutoff, 0.3);
  assert.equal(bark.textures.alphaCutoff, 0, 'an opaque material draws every texel');
  assert.deepEqual(twig.color, [0.9, 1, 0.9]);
  await assert.rejects(libraryParts('/lib/fir/fir.gltf', { fetch, decode, maxTriangles: 0 }), RangeError);
  // Three levels (near, middle, far): each part one geometry and one uv set per LOD ring, matched by material name.
  const rings = await libraryParts(['/lib/fir/fir.gltf', '/lib/fir/fir.gltf', '/lib/fir/fir.gltf'], { fetch, decode });
  assert.equal(rings.length, 2);
  assert.equal(rings[1].geometry.length, 3);
  assert.equal(rings[1].textures.uvs.length, 3);
  assert.equal(rings[1].textures.alphaCutoff, 0.3);
});
