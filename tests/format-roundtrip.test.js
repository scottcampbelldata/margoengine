// The tile editor's export -> reimport loop: exporters' OBJ/MTL and COLLADA writers read back by the loaders' parsers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { exportDAE, exportOBJ } from '../packages/exporters/dist/index.js';
import { flattenDAE, parseDAE, parseOBJ } from '../packages/loaders/dist/index.js';

// Two tiles: a textured quad and a coloured triangle, each corner its own vertex (UV seams kept).
const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0);
const quad = {
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  uvs: [0, 1, 0.25, 1, 0.25, 0.75, 0, 0.75],
  indices: [0, 1, 2, 0, 2, 3],
  faceSizes: [4],
};
const tri = {
  positions: [2, 0, 0, 3, 0, 0, 2, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
  uvs: [0.5, 0.5, 0.75, 0.5, 0.5, 0.25],
  indices: [0, 1, 2],
};
const tiles = { name: 'tiles', baseColorTexture: { image: png, mimeType: 'image/png', name: 'atlas' } };
const scene = () => ({
  nodes: [
    { name: 'floor', geometry: quad, material: tiles },
    { name: 'flag', geometry: tri, material: { name: 'red', color: [1, 0, 0, 1] } },
  ],
});

/** World-space corners as sorted "x,y,z|u,v" strings, so triangulation order does not matter. */
function corners(positions, uvs, indices) {
  const out = [];
  for (const i of indices) {
    const p = [0, 1, 2].map((k) => positions[i * 3 + k].toFixed(4)),
      t = [0, 1].map((k) => uvs[i * 2 + k].toFixed(4));
    out.push(`${p}|${t}`);
  }
  return out.sort();
}
const expected = corners(
  [...quad.positions, ...tri.positions],
  [...quad.uvs, ...tri.uvs],
  [...quad.indices, ...tri.indices.map((i) => i + 4)],
);

test('OBJ/MTL export reimports with the same corners, UVs, quad and texture', async () => {
  const { obj, mtl, textures } = exportOBJ(scene(), { materials: true, textures: true, mtlName: 'tiles.mtl' }),
    files = new Map([['tiles.mtl', mtl], ...textures]),
    resolve = async (path) => {
      assert.ok(files.has(path), `exported file ${path} exists`);
      return files.get(path);
    },
    loaded = await parseOBJ(obj, { resolve });
  assert.deepEqual(loaded.warnings, []);
  assert.deepEqual(corners(loaded.positions, loaded.uvs, loaded.indices), expected);
  assert.deepEqual([...loaded.faceSizes], [4, 3]);
  const material = loaded.materials.find((m) => m.name === 'tiles');
  assert.deepEqual(loaded.images, [material?.maps.map_Kd?.path], 'tiles material keeps its one texture');
  assert.deepEqual(files.get(loaded.images[0]), png, 'the reimported texture path finds the exported bytes');
});

test('COLLADA export reimports with the same corners, UVs, quad and texture', () => {
  const { dae, textures } = exportDAE(scene()),
    loaded = parseDAE(dae),
    flat = flattenDAE(loaded);
  assert.equal(loaded.upAxis, 'Y_UP');
  assert.deepEqual(loaded.warnings, []);
  assert.deepEqual(corners(flat.positions, flat.uvs, flat.indices), expected);
  assert.deepEqual([...flat.faceSizes].sort(), [3, 4]);
  assert.equal(loaded.images.length, 1);
  assert.ok(textures.has(loaded.images[0]), 'the reimported image path names an exported texture file');
});
