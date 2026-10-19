// OBJ/MTL completion: textures as sidecar files, quads, o/g, vertex color space, welding and scale, read back by a
// small OBJ/MTL reader written here from the Wavefront format description.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { exportOBJ } from '../dist/index.js';
import { readGLB } from './helpers.js';

function readOBJ(text) {
  const out = { v: [], vt: [], vn: [], objects: [], mtllib: null };
  let current = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [key, ...rest] = line.split(/\s+/);
    if (key === 'v' || key === 'vt' || key === 'vn') out[key].push(rest.map(Number));
    else if (key === 'o' || key === 'g')
      out.objects.push((current = { kind: key, name: rest[0], material: null, faces: [] }));
    else if (key === 'usemtl') current.material = rest[0];
    else if (key === 'mtllib') out.mtllib = rest[0];
    else if (key === 'f')
      current.faces.push(
        rest.map((corner) => {
          const [v, t, n] = corner.split('/').map((s) => (s ? Number(s) : null));
          for (const [i, list] of [
            [v, out.v],
            [t, out.vt],
            [n, out.vn],
          ])
            if (i !== null) assert.ok(i >= 1 && i <= list.length, `index ${i} out of range`);
          return { v, t, n };
        }),
      );
    else throw new Error(`unknown OBJ statement ${key}`);
  }
  return out;
}

function readMTL(text) {
  const out = {};
  let current = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [key, ...rest] = line.split(/\s+/);
    if (key === 'newmtl') out[rest[0]] = current = {};
    else current[key] = key.startsWith('map_') ? rest.join(' ') : rest.map(Number);
  }
  return out;
}

const isPNG = (bytes) =>
  [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b) &&
  new TextDecoder().decode(bytes.subarray(12, 16)) === 'IHDR';

async function png() {
  const { json, bin } = readGLB(new Uint8Array(await readFile(new URL('./fixtures/BoxTextured.glb', import.meta.url))));
  const view = json.bufferViews[json.images[0].bufferView];
  return bin.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

/** Two unit tiles side by side, each a quad (a, b, c), (a, c, d) with its own four corners. */
const tiles = (uvShift = 0) => ({
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 2, 0, 0, 2, 1, 0, 1, 1, 0],
  normals: Array.from({ length: 8 }, () => [0, 0, 1]).flat(),
  uvs: [0, 1, 0.5, 1, 0.5, 0, 0, 0, 0.5 + uvShift, 1, 1, 1, 1, 0, 0.5 + uvShift, 0],
  colors: Array.from({ length: 8 }, () => [0.5, 0.25, 1]).flat(),
  indices: [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7],
  faceSizes: [4, 4],
});

test('OBJ writes map_Kd and map_d texture names and returns the PNG bytes as sidecar files', async () => {
  const image = await png(),
    tile = { image, mimeType: 'image/png', name: 'tile set.png' };
  const scene = {
    nodes: [
      { name: 'floor', geometry: tiles(), material: { name: 'ground', baseColorTexture: tile } },
      {
        name: 'glass',
        geometry: tiles(),
        material: { name: 'glass', alphaMode: 'BLEND', color: [1, 1, 1, 0.5], baseColorTexture: tile },
      },
      {
        name: 'other',
        geometry: tiles(),
        material: {
          name: 'other',
          baseColorTexture: { image: image.slice(), mimeType: 'image/png', name: 'tile set' },
        },
      },
      { name: 'plain', geometry: tiles(), material: { name: 'plain' } },
    ],
  };
  const { obj, mtl, textures } = exportOBJ(scene, { materials: true, textures: true, texturePrefix: 'textures/' });
  const materials = readMTL(mtl);
  assert.equal(materials.ground.map_Kd, 'textures/tile_set.png');
  assert.equal(materials.ground.map_d, undefined, 'opaque materials have no map_d');
  assert.equal(materials.glass.map_Kd, 'textures/tile_set.png', 'one image, one file');
  assert.equal(materials.glass.map_d, 'textures/tile_set.png');
  assert.equal(materials.other.map_Kd, 'textures/tile_set_2.png', 'different bytes with the same name get a suffix');
  assert.equal(materials.plain.map_Kd, undefined);
  assert.deepEqual([...textures.keys()], ['textures/tile_set.png', 'textures/tile_set_2.png']);
  for (const bytes of textures.values()) {
    assert.ok(isPNG(bytes));
    assert.deepEqual(bytes, image);
  }
  assert.equal(readOBJ(obj).mtllib, 'scene.mtl');
  // Without the option the MTL is as before and nothing is returned.
  const plain = exportOBJ(scene, { materials: true });
  assert.equal(readMTL(plain.mtl).ground.map_Kd, undefined);
  assert.equal(plain.textures.size, 0);
});

test('OBJ writes faceSizes quads as 4-corner faces, also under a mirrored transform', () => {
  for (const scale of [undefined, [-1, 1, 1]]) {
    // The second quad uses the other diagonal: (a, b, d), (b, c, d).
    const geometry = { ...tiles(), indices: [0, 1, 2, 0, 2, 3, 4, 5, 7, 5, 6, 7, 1, 4, 7], faceSizes: [4, 4, 3] };
    const parsed = readOBJ(exportOBJ({ nodes: [{ geometry, scale }] }).obj),
      faces = parsed.objects[0].faces;
    assert.deepEqual(
      faces.map((f) => f.length),
      [4, 4, 3],
    );
    // Every quad lists its four distinct corners around the boundary, counterclockwise about +z (its normal).
    for (const face of faces.slice(0, 2)) {
      const p = face.map((c) => parsed.v[c.v - 1]);
      let area = 0;
      for (let i = 0; i < p.length; i++)
        area += p[i][0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * p[i][1];
      assert.equal(Math.sign(area), 1, 'boundary order and winding kept');
      assert.equal(new Set(face.map((c) => c.v)).size, 4);
    }
  }
  const quad = (faceSizes, indices = [0, 1, 2, 0, 2, 3]) => ({
    nodes: [{ geometry: { ...tiles(), indices, faceSizes } }],
  });
  assert.throws(() => exportOBJ(quad([4], [0, 1, 2, 4, 5, 6])), { name: 'RangeError', message: /share no edge/ });
  assert.throws(() => exportOBJ(quad([3])), { name: 'RangeError', message: /cover every triangle/ });
  assert.throws(() => exportOBJ(quad([4, 3])), RangeError);
  assert.throws(() => exportOBJ(quad([5])), { name: 'RangeError', message: /3 or 4/ });
  assert.throws(() => exportOBJ(quad('4')), TypeError);
  assert.equal(readOBJ(exportOBJ(quad([3, 3])).obj).objects[0].faces.length, 2);
});

test('OBJ groups or objects, vertex color space, welding and scale', () => {
  const scene = {
    nodes: [
      { name: 'a', geometry: tiles() },
      { name: 'b', geometry: tiles(0.25), translation: [0, 0, 1] },
    ],
  };
  const groups = readOBJ(exportOBJ(scene).obj),
    objects = readOBJ(exportOBJ(scene, { groups: false }).obj);
  assert.deepEqual(
    groups.objects.map((o) => o.kind + o.name),
    ['ga', 'gb'],
  );
  assert.deepEqual(
    objects.objects.map((o) => o.kind + o.name),
    ['oa', 'ob'],
  );

  const srgb = readOBJ(exportOBJ(scene, { colors: true }).obj).v[0].slice(3),
    linear = readOBJ(exportOBJ(scene, { colors: true, colorSpace: 'linear' }).obj).v[0].slice(3);
  assert.deepEqual(linear, [0.5, 0.25, 1]);
  // sRGB transfer function (IEC 61966-2-1).
  const encode = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
  srgb.forEach((value, i) => assert.ok(Math.abs(value - encode(linear[i])) < 1e-6, `${value}`));
  assert.ok(Math.abs(srgb[0] - 0.7353569) < 1e-6);

  // Tile a's shared edge has matching uvs and welds (8 -> 6 corners); tile b's uvs differ there and stay apart.
  const welded = readOBJ(exportOBJ(scene, { mergeVertices: true, colors: true }).obj);
  assert.equal(welded.v.length, 6 + 8);
  assert.equal(welded.vt.length, 14);
  assert.equal(welded.vn.length, 14);
  assert.deepEqual(
    welded.objects.map((o) => o.faces.map((f) => f.length)),
    [
      [4, 4],
      [4, 4],
    ],
  );
  const shared = welded.objects[0].faces.map((f) => new Set(f.map((c) => c.v)));
  assert.equal([...shared[0]].filter((v) => shared[1].has(v)).length, 2, 'the two tiles share an edge');
  for (const object of welded.objects)
    for (const face of object.faces) for (const c of face) assert.ok(c.v === c.t && c.v === c.n);
  // A different normal or color keeps corners apart; a sub-tolerance offset still welds.
  const lit = tiles();
  lit.normals[4 * 3 + 2] = -1;
  assert.equal(readOBJ(exportOBJ({ nodes: [{ geometry: lit }] }, { mergeVertices: true }).obj).v.length, 7);
  const tinted = tiles();
  tinted.colors[4 * 3] = 0;
  assert.equal(
    readOBJ(exportOBJ({ nodes: [{ geometry: tinted }] }, { mergeVertices: true }).obj).v.length,
    6,
    'colors not written',
  );
  assert.equal(
    readOBJ(exportOBJ({ nodes: [{ geometry: tinted }] }, { mergeVertices: true, colors: true }).obj).v.length,
    7,
  );
  const nudged = tiles();
  nudged.positions[4 * 3] += 1e-7;
  assert.equal(readOBJ(exportOBJ({ nodes: [{ geometry: nudged }] }, { mergeVertices: true }).obj).v.length, 6);

  const scaled = readOBJ(exportOBJ(scene, { scale: 2.5 }).obj);
  assert.deepEqual(scaled.v[6], [5, 2.5, 0]);
  assert.deepEqual(scaled.v[8], [0, 0, 2.5]);

  assert.throws(() => exportOBJ(scene, { scale: 0 }), RangeError);
  assert.throws(() => exportOBJ(scene, { scale: '2' }), TypeError);
  assert.throws(() => exportOBJ(scene, { colorSpace: 'rgb' }), TypeError);
  assert.throws(() => exportOBJ(scene, { textures: true }), /needs materials/);
  assert.throws(() => exportOBJ(scene, { materials: true, textures: true, texturePrefix: 'my textures/' }), TypeError);
  assert.throws(() => exportOBJ(scene, { mergeVertices: 'yes' }), TypeError);
});
