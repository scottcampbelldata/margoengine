// libraryMesh keeps a library model's PBR maps (Fauld recut gap 5): a glTF whose material has a base colour map drew as
// one flat colour, the mean of its baseColorFactor (white for most scans), so a textured prop read as a grey block.
import test from 'node:test';
import assert from 'node:assert/strict';

// One triangle, one material, its maps by uri; a second document with two textured materials.
const model = (materials) => {
  const bin = new ArrayBuffer(36 * 2 + 24 + 8),
    p = new Float32Array(bin, 0, 18),
    t = new Float32Array(bin, 72, 6),
    i = new Uint16Array(bin, 96, 3);
  p.set([0, 1, 0, 2, 1, 0, 0, 3, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  t.set([0, 0, 1, 0, 0, 1]);
  i.set([0, 1, 2]);
  const prims = materials.map((_, m) => ({
    attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 },
    indices: 3,
    material: m,
  }));
  return {
    bin,
    doc: {
      asset: { version: '2.0' },
      buffers: [{ uri: 'm.bin', byteLength: bin.byteLength }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 72 },
        { buffer: 0, byteOffset: 72, byteLength: 24 },
        { buffer: 0, byteOffset: 96, byteLength: 6 },
      ],
      accessors: [
        { bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: 'VEC3' },
        { bufferView: 0, byteOffset: 36, componentType: 5126, count: 3, type: 'VEC3' },
        { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' },
        { bufferView: 2, componentType: 5123, count: 3, type: 'SCALAR' },
      ],
      meshes: [{ primitives: prims }],
      materials,
      textures: [{ source: 0 }, { source: 1 }, { source: 2 }],
      images: [
        { uri: 'paint_diff.jpg', mimeType: 'image/jpeg' },
        { uri: 'paint_nor.jpg', mimeType: 'image/jpeg' },
        { uri: 'paint_arm.jpg', mimeType: 'image/jpeg' },
      ],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
    },
  };
};
const serve = ({ doc, bin }) => {
  const fetched = [];
  const fetch = async (url) => {
    fetched.push(url);
    if (url.endsWith('.gltf')) return { ok: true, status: 200, json: async () => doc };
    if (url.endsWith('.bin')) return { ok: true, status: 200, arrayBuffer: async () => bin };
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(url).buffer };
  };
  return { fetch, fetched };
};
const decode = async (bytes) => ({
  width: 1,
  height: 1,
  data: new Uint8Array(4),
  name: new TextDecoder().decode(bytes),
});
const painted = {
  name: 'TN_BombPaint',
  pbrMetallicRoughness: {
    baseColorFactor: [1, 1, 1, 1],
    baseColorTexture: { index: 0 },
    metallicRoughnessTexture: { index: 2 },
  },
  normalTexture: { index: 1 },
};

test('libraryMesh draws a textured library model with its base colour, normal and ORM maps', async () => {
  const { libraryMesh } = await import('@margoengine/scenes/library');
  const { fetch, fetched } = serve(model([painted])),
    part = await libraryMesh('/lib/bomb/bomb_2k.gltf', { fetch, decode });
  assert.ok(part.textures, 'the part carries its maps (it drew one flat colour before)');
  assert.equal(part.textures.baseColor.name, '/lib/bomb/paint_diff.jpg');
  assert.equal(part.textures.normal.name, '/lib/bomb/paint_nor.jpg');
  assert.equal(part.textures.occlusionRoughnessMetal.name, '/lib/bomb/paint_arm.jpg');
  assert.deepEqual(Array.from(part.textures.uvs), [0, 0, 1, 0, 0, 1]);
  assert.equal(part.name, 'TN_BombPaint');
  assert.equal(part.kind, 'stone');
  assert.deepEqual(part.color, [1, 1, 1], 'the factor that multiplies the map');
  assert.deepEqual(Array.from(part.geometry.positions), [-1, 0, 0, 1, 0, 0, -1, 2, 0], 'base on y = 0, centred');
  assert.equal(fetched.filter((u) => u.endsWith('.gltf')).length, 1, 'the document is fetched once');
});

test('libraryMesh draws flat only when asked, and sends a model of several textured materials to libraryParts', async () => {
  const { libraryMesh } = await import('@margoengine/scenes/library');
  const flat = await libraryMesh('/lib/bomb/bomb_2k.gltf', {
    fetch: serve(model([painted])).fetch,
    color: [0.03, 0.05, 0.02],
  });
  assert.equal(flat.textures, undefined);
  assert.deepEqual(flat.color, [0.03, 0.05, 0.02]);
  await assert.rejects(
    libraryMesh('/lib/bomb/bomb_2k.gltf', {
      fetch: serve(model([painted, { ...painted, name: 'TN_BombBand' }])).fetch,
      decode,
    }),
    (e) => e.code === 'unsupported' && /2 textured materials/.test(e.message) && /libraryParts/.test(e.message),
  );
});
