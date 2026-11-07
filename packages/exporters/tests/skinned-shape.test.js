// Formats with no skeleton write the shape the model has, not its stored bind geometry. Expected numbers come from plain glTF
// maths on the file (node transforms, skin applied, weights normalized), worked out with no exporter code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadGLTF } from '@margoengine/gltf-pro';
import { exportDAE, exportOBJ, exportPLY, exportSTL } from '../dist/index.js';
import { loadedPBREngine } from '../../../tests/support/loaded-pbr-fixtures.js';

/** Coordinates as they are, for tests that read them. */
const raw = { upAxis: 'z' };

const asset = (path) => new URL(`../../../examples/assets/${path}`, import.meta.url);

/** Serves one file to the real loader. */
async function load(path) {
  const bytes = await readFile(asset(path)),
    fetched = globalThis.fetch,
    bitmap = globalThis.createImageBitmap;
  globalThis.fetch = async () => new Response(bytes);
  // Node has no image decoder; the pixels play no part in a shape.
  globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
  try {
    const engine = await loadedPBREngine();
    engine.gpu.queue.copyExternalImageToTexture = () => {};
    return { engine, model: await loadGLTF(engine, 'http://margo.test/model.glb') };
  } finally {
    globalThis.fetch = fetched;
    if (bitmap === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = bitmap;
  }
}

/** Every vertex of a binary STL, with each triangle's stored normal. */
function readSTL(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset),
    count = view.getUint32(80, true),
    points = [],
    faces = [];
  for (let t = 0; t < count; t++) {
    const at = 84 + t * 50,
      read = (o) => [0, 4, 8].map((k) => view.getFloat32(at + o + k, true));
    const corners = [read(12), read(24), read(36)];
    points.push(...corners);
    faces.push({ normal: read(0), corners });
  }
  return { count, points, faces };
}

const box = (points) => {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (const p of points)
    for (let c = 0; c < 3; c++) {
      min[c] = Math.min(min[c], p[c]);
      max[c] = Math.max(max[c], p[c]);
    }
  return { min, max };
};

const near = (got, want, tolerance, label) =>
  got.forEach((v, c) => assert.ok(Math.abs(v - want[c]) <= tolerance, `${label}[${c}]: ${v} against ${want[c]}`));

const quarterTurnZ = [0, 0, Math.SQRT1_2, Math.SQRT1_2];

/** A one-bone strip along +x from the origin, its joint turned a quarter about z, so it should point along +y. */
function bent(extra = {}) {
  const joint = { name: 'joint', rotation: quarterTurnZ, ...extra.joint };
  const skinned = {
    name: 'strip',
    translation: [50, 50, 50],
    geometry: {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0.25, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint16Array([0, 1, 2]),
      joints: new Uint16Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      weights: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
      ...extra.geometry,
    },
    material: { color: [1, 1, 1] },
    skin: { joints: [joint], inverseBindMatrices: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) },
  };
  return { nodes: [joint, skinned] };
}

test('a skin sets the shape in STL, and the skinned node own transform does not place it, as glTF says', () => {
  const { points } = readSTL(exportSTL(bent(), raw));
  near(points[1], [0, 1, 0], 1e-6, 'tip');
  near(points[2], [-0.25, 0, 0], 1e-6, 'side');
});

test('OBJ, PLY and DAE write the same shape', () => {
  const obj = exportOBJ(bent()).obj,
    vertex = obj.split('\n').filter((line) => line.startsWith('v '))[1].split(' ').slice(1).map(Number);
  near(vertex, [0, 1, 0], 1e-6, 'obj');
  const ply = exportPLY(bent(), { ...raw, binary: false });
  assert.match(ply, /\n-?[\d.e-]+ 1 -?[\d.e-]+/, 'a PLY vertex at y = 1');
  const dae = exportDAE(bent()),
    floats = /<float_array[^>]*positions[^>]*>([^<]*)</.exec(dae.dae ?? dae.text ?? dae)[1].trim().split(/\s+/).map(Number),
    matrix = /<matrix[^>]*>([^<]*)</.exec((dae.dae ?? dae.text ?? dae).split('strip').slice(-1)[0]);
  const m = matrix ? matrix[1].trim().split(/\s+/).map(Number) : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    [x, y, z] = floats.slice(3, 6);
  near([0, 1, 2].map((r) => m[r * 4] * x + m[r * 4 + 1] * y + m[r * 4 + 2] * z + m[r * 4 + 3]), [0, 1, 0], 1e-5, 'dae');
});

test('weights that do not add to one are normalized, and morph weights apply before the skin', () => {
  const half = bent({ geometry: { weights: new Float32Array([0.5, 0, 0, 0, 0.5, 0, 0, 0, 0.5, 0, 0, 0]) } });
  near(readSTL(exportSTL(half, raw)).points[1], [0, 1, 0], 1e-6, 'normalized');
  const morphed = bent({
    geometry: { morphs: [{ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 0]) }] },
  });
  morphed.nodes[1].morphWeights = [0.5];
  near(readSTL(exportSTL(morphed, raw)).points[1], [0, 1.5, 0], 1e-6, 'morph then skin');
});

test('a mirroring joint keeps faces outward', () => {
  const mirrored = bent({ joint: { rotation: [0, 0, 0, 1], scale: [-1, 1, 1] } }),
    { faces } = readSTL(exportSTL(mirrored, raw)),
    [a, b, c] = faces[0].corners,
    u = b.map((v, i) => v - a[i]),
    w = c.map((v, i) => v - a[i]),
    z = u[0] * w[1] - u[1] * w[0];
  near(box(faces[0].corners).min, [-1, 0, 0], 1e-6, 'the mirror is applied');
  assert.ok(z > 0, `winding faces +z after the mirror: ${z}`);
  assert.ok(faces[0].normal[2] > 0.99, 'and so does the stored normal');
});

test('a bone scaled to zero hides its part and does not stop the export', () => {
  const hidden = bent({ joint: { rotation: [0, 0, 0, 1], scale: [0, 0, 0] } });
  assert.equal(readSTL(exportSTL(hidden, raw)).count, 1);
});

test('RobotExpressive: skinned hands stay on their arms in STL, at the rest pose plain glTF maths gives', async () => {
  const { engine } = await load('robot-expressive.glb'),
    { min, max } = box(readSTL(exportSTL(engine, raw)).points);
  // Unskinned, the hands sit at x = -3.312 and 3.307, detached from the arms.
  near(min, [-1.521, -0.02, -1.269], 2e-3, 'min');
  near(max, [1.579, 4.441, 1.416], 2e-3, 'max');
});

test('RobotExpressive stands up in STL and PLY by default: readers take Z as up, and a turn keeps every face outward', async () => {
  const { engine } = await load('robot-expressive.glb'),
    { min, max } = box(readSTL(exportSTL(engine)).points);
  near(min, [-1.521, -1.416, -0.02], 2e-3, 'min');
  near(max, [1.579, 1.269, 4.441], 2e-3, 'max');
  const { faces } = readSTL(exportSTL(engine));
  for (const { normal, corners: [a, b, c] } of faces.slice(0, 500)) {
    const u = b.map((v, i) => v - a[i]),
      w = c.map((v, i) => v - a[i]),
      cross = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    assert.ok(cross[0] * normal[0] + cross[1] * normal[1] + cross[2] * normal[2] >= 0, 'stored normal agrees with the winding');
  }
  const ply = exportPLY(engine).split('\n'),
    first = ply.indexOf('end_header') + 1,
    vertices = Number(/element vertex (\d+)/.exec(ply.join('\n'))[1]),
    rows = ply.slice(first, first + vertices).map((line) => line.split(' ').map(Number));
  near(box(rows.map((r) => r.slice(0, 3))).max, [1.579, 1.269, 4.441], 2e-3, 'PLY positions');
  // Normals turn with the positions: the top of the head faces +Z and no longer +Y.
  const top = rows.reduce((a, b) => (b[2] > a[2] ? b : a));
  assert.ok(top[5] > 0.5, `normal at the top of the head: ${top.slice(3, 6)}`);
});

test('upAxis takes y or z only, as 3MF does', () => {
  assert.throws(() => exportSTL(bent(), { upAxis: 'x' }), /STL upAxis must be 'y' or 'z'/);
  assert.throws(() => exportPLY(bent(), { upAxis: 'x' }), /PLY upAxis must be 'y' or 'z'/);
});

test('a textured model has a shape: STL and PLY write it, DAE still refuses to lose its textures', async () => {
  const { engine } = await load('khronos/Fox/Fox.glb');
  assert.equal(readSTL(exportSTL(engine)).count, 576);
  assert.ok(exportPLY(engine, { binary: true }).length > 0);
  assert.throws(() => exportDAE(engine), /exportModel/);
});

/** The image a GLB holds at `index`, read straight from the file. */
async function glbImage(path, index) {
  const bytes = await readFile(asset(path)),
    length = bytes.readUInt32LE(12),
    doc = JSON.parse(bytes.subarray(20, 20 + length).toString('utf8')),
    view = doc.bufferViews[doc.images[index].bufferView],
    bin = 20 + length + 8;
  return bytes.subarray(bin + (view.byteOffset ?? 0), bin + (view.byteOffset ?? 0) + view.byteLength);
}

test('Fox as OBJ: its shape and UVs without asking for more, its own texture bytes with textures: true', async () => {
  const { engine } = await load('khronos/Fox/Fox.glb'),
    plain = exportOBJ(engine);
  assert.equal(plain.obj.split('\n').filter((line) => line.startsWith('f ')).length, 576);
  assert.ok(plain.obj.includes('\nvt '), 'UVs are kept for a texture applied by hand');
  assert.equal(plain.textures.size, 0);
  const { mtl, textures } = exportOBJ(engine, { materials: true, textures: true }),
    map = /map_Kd (.+)/.exec(mtl)[1];
  assert.deepEqual([...textures.keys()], [map]);
  assert.deepEqual(Buffer.from(textures.get(map)), Buffer.from(await glbImage('khronos/Fox/Fox.glb', 0)));
});

test('RobotExpressive as OBJ: the skinned shape, and one MTL entry for each material the file has', async () => {
  const { engine, model } = await load('robot-expressive.glb'),
    { obj, mtl } = exportOBJ(engine, { materials: true }),
    points = obj.split('\n').filter((line) => line.startsWith('v ')).map((line) => line.split(' ').slice(1).map(Number));
  near(box(points).max, [1.579, 4.441, 1.416], 2e-3, 'max');
  assert.equal(mtl.split('\n').filter((line) => line.startsWith('newmtl ')).length, model.asset.doc.materials.length);
});

test('MTL has no rotation, so a texture transform goes into the OBJ coordinates by the glTF matrix', () => {
  const image = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
  const scene = (transform) => ({
    nodes: [
      {
        geometry: {
          positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
          normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
          uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
          indices: new Uint32Array([0, 1, 2]),
        },
        material: {
          color: [1, 1, 1],
          baseColorTexture: { image, mimeType: 'image/png', name: 'grid' },
          baseColorTextureTransform: transform,
        },
      },
    ],
  });
  const vt = (options, transform) =>
    exportOBJ(scene(transform), options)
      .obj.split('\n')
      .filter((line) => line.startsWith('vt '))
      .map((line) => line.split(' ').slice(1).map(Number));
  const on = { materials: true, textures: true };
  // uv (1, 0) with scale 2, offset (0.25, 0.5) and a quarter turn: u = 0.25, v = 0.5 - 2 = -1.5, written as 1 - v.
  const got = vt(on, { offset: [0.25, 0.5], scale: [2, 3], rotation: Math.PI / 2 });
  near(got[0], [0.25, 0.5], 1e-6, 'uv 0 0');
  near(got[1], [0.25, 2.5], 1e-6, 'uv 1 0');
  near(got[2], [3.25, 0.5], 1e-6, 'uv 0 1');
  // With no texture written there is nothing for the transform to serve, so the file's UVs stay.
  near(vt({}, { offset: [0.25, 0.5], scale: [2, 3] })[1], [1, 1], 1e-6, 'no texture');
});
