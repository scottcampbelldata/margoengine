import test from 'node:test';
import assert from 'node:assert/strict';
import { LoaderError, parseMTL, parseOBJ, toGeometry } from '../dist/index.js';

const text = (value) => new TextEncoder().encode(value);
const rejects = (promise, code, pattern) =>
  assert.rejects(
    promise,
    (error) => error instanceof LoaderError && error.code === code && (!pattern || pattern.test(error.message)),
  );
const close = (actual, expected, label) => {
  assert.equal(actual.length, expected.length, `${label} length`);
  for (let i = 0; i < expected.length; i++)
    assert.ok(Math.abs(actual[i] - expected[i]) < 1e-6, `${label}[${i}]: ${actual[i]} != ${expected[i]}`);
};
/** Rebuilds the polygons (as vertex numbers) from fan triangles and faceSizes. */
const polygons = ({ indices, faceSizes }) => {
  const out = [];
  let t = 0;
  for (const n of faceSizes) {
    const face = [indices[t * 3], indices[t * 3 + 1]];
    for (let k = 0; k < n - 2; k++, t++) face.push(indices[t * 3 + 2]);
    out.push(face);
  }
  return out;
};
/** Files by path, for the resolver. */
const files = (entries) => async (path) => {
  if (!Object.hasOwn(entries, path)) throw new Error(`no file ${path}`);
  return entries[path];
};

// Every OBJ statement the reader interprets, plus CRLF, comments, a continuation and statements it keeps as extras.
const FULL = [
  '# full fixture',
  'mtllib a.mtl mats/b.mtl',
  'o Box',
  'v 0 0 0',
  'v 1 0 0 1.0',
  'v 1 1 0',
  'v 0 1 0',
  'v 2 0 0',
  'vt 0 0',
  'vt 1 0 0',
  'vt 1 1',
  'vt 0.25',
  'vn 0 0 1',
  'g side top',
  'usemtl red',
  's 1',
  'f 1/1/1 2/2/1 3/3/1 4/4/1 # a quad',
  's off',
  'f -4//-1 -3//-1 \\',
  '  -1//-1',
  'usemtl blue',
  's 7',
  'f 2/2 5/1 3/3',
  'g',
  's 0',
  'f 1 2 5 3 4',
  'l 1 2',
  'p 3',
  '',
].join('\r\n');

test('OBJ: every statement, n-gons, negative indices, continuation, groups, smoothing and extras', async () => {
  const obj = await parseOBJ(text(FULL));
  assert.equal(obj.kind, 'mesh');
  assert.deepEqual([...obj.faceSizes], [4, 3, 3, 5]);
  assert.deepEqual([...obj.smoothingGroups], [1, 0, 7, 0]);
  assert.equal(obj.indices.length, (2 + 1 + 1 + 3) * 3);
  assert.deepEqual(obj.materialLibraries, ['a.mtl', 'mats/b.mtl']);
  assert.deepEqual(obj.extras, [
    { keyword: 'l', value: '1 2', line: 27 },
    { keyword: 'p', value: '3', line: 28 },
  ]);
  assert.deepEqual(
    obj.groups.map(({ start, count, name, object, groupNames, material }) => ({
      start,
      count,
      name,
      object,
      groupNames,
      material,
    })),
    [
      { start: 0, count: 9, name: 'side top', object: 'Box', groupNames: ['side', 'top'], material: 'red' },
      { start: 9, count: 3, name: 'side top', object: 'Box', groupNames: ['side', 'top'], material: 'blue' },
      { start: 12, count: 9, name: 'Box', object: 'Box', groupNames: [], material: 'blue' },
    ],
  );
  // The polygons come back with their corners' positions in file order (negative indices resolved).
  const faces = polygons(obj).map((face) => face.map((v) => obj.positionIndices[v]));
  assert.deepEqual(faces, [
    [0, 1, 2, 3],
    [1, 2, 4],
    [1, 4, 2],
    [0, 1, 4, 2, 3],
  ]);
  // Per-corner attributes: vt v is flipped, `vt 0.25` has v = 0, missing vt/vn read as 0.
  const corner = (face, k) => polygons(obj)[face][k];
  const uv = (v) => [obj.uvs[v * 2], obj.uvs[v * 2 + 1]];
  assert.deepEqual(uv(corner(0, 2)), [1, 0]);
  assert.deepEqual(uv(corner(0, 3)), [0.25, 1]);
  assert.deepEqual(uv(corner(2, 1)), [0, 1]);
  assert.deepEqual([...obj.normals.subarray(corner(1, 0) * 3, corner(1, 0) * 3 + 3)], [0, 0, 1]);
  assert.deepEqual([...obj.normals.subarray(corner(3, 0) * 3, corner(3, 0) * 3 + 3)], [0, 0, 0]);
  assert.equal(obj.colors, undefined);
  // Corner 1 of the quad (v2/vt2/vn1) and of the blue triangle (v2/vt2/-) differ in normal: two vertices.
  assert.notEqual(corner(0, 1), corner(2, 0));
  assert.equal(obj.positionIndices[corner(0, 1)], obj.positionIndices[corner(2, 0)]);
  // The result feeds toGeometry like every other loader.
  assert.equal(toGeometry(obj).indices.length, obj.indices.length);
});

test('OBJ: seams keep separate vertices; shared corners weld; missing vt and vn give no arrays', async () => {
  // Two quads share the edge 2-3; the second maps it to different UVs (a seam), the first pair of corners repeats.
  const seam = await parseOBJ(
    'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nv 2 0 0\nv 2 1 0\nvt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\nvt 0.5 0\nvt 0.5 1\n' +
      'f 1/1 2/2 3/3 4/4\nf 2/5 5/2 6/3 3/6\nf 1/1 2/2 3/3\n',
  );
  assert.equal(seam.positions.length / 3, 8);
  assert.deepEqual([...seam.positionIndices], [0, 1, 2, 3, 1, 4, 5, 2]);
  const plain = await parseOBJ('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
  assert.equal(plain.uvs, undefined);
  assert.equal(plain.normals, undefined);
  assert.deepEqual([...plain.indices], [0, 1, 2]);
  const cloud = await parseOBJ('v 0 0 0 1 0 0\nv 1 2 3 0 1 0\n');
  assert.equal(cloud.kind, 'points');
  assert.deepEqual([...cloud.positions], [0, 0, 0, 1, 2, 3]);
  assert.deepEqual([...cloud.colors], [1, 0, 0, 0, 1, 0]);
});

// Crocotile 3D style: vertex colors after xyz, one tileset material, quads that pair into triangles.
const CROCOTILE = `# Crocotile 3D
mtllib scene.mtl
o Object1
v -0.5 0 -0.5 1 1 1
v 0.5 0 -0.5 0.5 0.25 1
v 0.5 0 0.5 1 1 1
v -0.5 0 0.5 0 0 0
v 1.5 0 -0.5 1 0 0
v 1.5 0 0.5 1 0 0
vt 0 1
vt 0.25 1
vt 0.25 0.75
vt 0 0.75
vt 0.5 1
vt 0.5 0.75
vn 0 1 0
usemtl tileset
f 1/1/1 4/4/1 3/3/1 2/2/1
f 2/2/1 3/3/1 6/6/1 5/5/1
`;

test('OBJ: Crocotile-style vertex colors and quads give the corners read by hand from the text', async () => {
  const obj = await parseOBJ(CROCOTILE);
  assert.deepEqual([...obj.faceSizes], [4, 4]);
  assert.deepEqual(
    polygons(obj).map((face) => face.map((v) => obj.positionIndices[v])),
    [
      [0, 3, 2, 1],
      [1, 2, 5, 4],
    ],
  );
  assert.equal(obj.groups.length, 1);
  assert.equal(obj.groups[0].material, 'tileset');
  // Expected triangle corners, read by hand from the text: each quad c0 c1 c2 c3 fans into (c0, c1, c2) and
  // (c0, c2, c3); a corner takes the v line's position and colour (as written), its vt line (OBJ orientation, so ours
  // is 1 - v) and the single vn (0, 1, 0).
  const corner = {
    1: { p: [-0.5, 0, -0.5], c: [1, 1, 1], t: [0, 1] },
    2: { p: [0.5, 0, -0.5], c: [0.5, 0.25, 1], t: [0.25, 1] },
    3: { p: [0.5, 0, 0.5], c: [1, 1, 1], t: [0.25, 0.75] },
    4: { p: [-0.5, 0, 0.5], c: [0, 0, 0], t: [0, 0.75] },
    5: { p: [1.5, 0, -0.5], c: [1, 0, 0], t: [0.5, 1] },
    6: { p: [1.5, 0, 0.5], c: [1, 0, 0], t: [0.5, 0.75] },
  };
  const expected = [1, 4, 3, 1, 3, 2, 2, 3, 6, 2, 6, 5].map((k) => corner[k]);
  const corners = [...obj.indices];
  assert.equal(corners.length, 12, 'two quads give four triangles');
  close(
    corners.flatMap((v) => [...obj.positions.subarray(v * 3, v * 3 + 3)]),
    expected.flatMap((e) => e.p),
    'position',
  );
  close(
    corners.flatMap((v) => [...obj.colors.subarray(v * 3, v * 3 + 3)]),
    expected.flatMap((e) => e.c),
    'color',
  );
  close(
    corners.flatMap((v) => [...obj.normals.subarray(v * 3, v * 3 + 3)]),
    expected.flatMap(() => [0, 1, 0]),
    'normal',
  );
  close(
    corners.flatMap((v) => [obj.uvs[v * 2], 1 - obj.uvs[v * 2 + 1]]),
    expected.flatMap((e) => e.t),
    'uv',
  );
});

const MTL_A = `# library a
newmtl red
Ka 0.1 0.1 0.1
Kd 1 0 0
Ks 0.5
Ke 0 0 0.25
Ns 96
d 0.75
Tr 0.25
illum 2
Ni 1.45
map_Kd -o 0.5 0.25 -s 2 -clamp on -blendu off -blendv on -cc off -mm 0.1 0.9 -texres 512 -boost 2 tex/red.png
map_d -imfchan m alpha.png
map_Ka ambient.png
map_Ks -type sphere spec.png
map_Bump -bm 0.5 normal map.png
map_Pr rough.png
map_Ke -unknown 1 glow.png
`;
const MTL_B = `newmtl blue
Kd 0 0 1
bump ../tex/red.png
newmtl red
Kd 0 1 0
`;

test('MTL: every statement and map option; texture paths resolve against the MTL folder', async () => {
  const [red] = parseMTL(MTL_A);
  assert.deepEqual(
    { Ka: red.Ka, Kd: red.Kd, Ks: red.Ks, Ke: red.Ke, Ns: red.Ns, d: red.d, Tr: red.Tr, illum: red.illum },
    { Ka: [0.1, 0.1, 0.1], Kd: [1, 0, 0], Ks: [0.5, 0.5, 0.5], Ke: [0, 0, 0.25], Ns: 96, d: 0.75, Tr: 0.25, illum: 2 },
  );
  assert.deepEqual(red.maps.map_Kd, {
    file: 'tex/red.png',
    path: 'tex/red.png',
    options: {
      o: [0.5, 0.25, 0],
      s: [2, 1, 1],
      clamp: true,
      blendu: false,
      blendv: true,
      cc: false,
      mm: [0.1, 0.9],
      texres: 512,
      boost: 2,
    },
  });
  assert.deepEqual(red.maps.map_d.options, { imfchan: 'm' });
  assert.equal(red.maps.map_Ka.file, 'ambient.png');
  assert.deepEqual(red.maps.map_Ks.options, { type: 'sphere' });
  assert.deepEqual(red.maps.bump, { file: 'normal map.png', path: 'normal map.png', options: { bm: 0.5 } });
  assert.equal(red.maps.map_Pr.file, 'rough.png');
  assert.equal(Object.getPrototypeOf(red.maps), null);
  assert.deepEqual(red.extras, [
    { keyword: 'Ni', value: '1.45', line: 11 },
    { keyword: 'map_Ke', value: '-unknown 1 glow.png', line: 18 },
  ]);
  const [blue] = parseMTL(text(MTL_B), { path: 'mats/b.mtl' });
  assert.deepEqual(blue.maps.bump, { file: '../tex/red.png', path: 'tex/red.png', options: {} });
});

test('OBJ + MTL: resolver reads every library once, first material wins, groups get Kd colors, warnings', async () => {
  const requested = [];
  const resolve = async (path) => {
    requested.push(path);
    return files({ 'a.mtl': text(MTL_A), 'mats/b.mtl': MTL_B })(path);
  };
  const obj = await parseOBJ(FULL, { resolve });
  assert.deepEqual(requested, ['a.mtl', 'mats/b.mtl']);
  assert.deepEqual(
    obj.materials.map((m) => m.name),
    ['red', 'blue'],
  );
  assert.deepEqual(obj.materials[0].Kd, [1, 0, 0]);
  assert.deepEqual(
    obj.groups.map((g) => g.color),
    [
      [1, 0, 0, 0.75],
      [0, 0, 1, 1],
      [0, 0, 1, 1],
    ],
  );
  assert.deepEqual(obj.images, ['tex/red.png', 'alpha.png', 'ambient.png', 'spec.png', 'normal map.png', 'rough.png']);
  assert.deepEqual(obj.warnings, []);
  const missing = await parseOBJ('mtllib gone.mtl\nusemtl nothing\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n', {
    resolve: files({}),
  });
  assert.deepEqual(missing.warnings, [
    'mtllib "gone.mtl" could not be read (no file gone.mtl)',
    'usemtl "nothing" names no material in the MTL libraries',
  ]);
  // A library name with spaces stays whole.
  assert.deepEqual((await parseOBJ('mtllib my model.mtl\n')).materialLibraries, ['my model.mtl']);
  await assert.rejects(parseOBJ('v 0 0 0', { resolve: 'a.mtl' }), TypeError);
  const controller = new AbortController();
  controller.abort();
  await rejects(parseOBJ(FULL, { resolve, signal: controller.signal }), 'aborted');
});

test('OBJ and MTL: malformed input names the line; limits', async () => {
  const tri = 'v 0 0 0\nv 1 0 0\nv 0 1 0\n';
  await rejects(parseOBJ('v 0 0 0\nv 1 2\n'), 'syntax', /v on line 2 has 2 values/);
  await rejects(parseOBJ('v 0 0 0\nv 1 2 3 4 5\n'), 'syntax', /line 2/);
  await rejects(parseOBJ('v 0 x 0\n'), 'syntax', /line 1/);
  await rejects(parseOBJ(`${tri}f 1 2\n`), 'syntax', /face on line 4 has 2 corners/);
  await rejects(parseOBJ(`${tri}f 0 1 2\n`), 'syntax', /v index "0" on line 4/);
  await rejects(parseOBJ(`${tri}f 1 2 4\n`), 'range', /v index 4 on line 4 is outside the 3 defined/);
  await rejects(parseOBJ(`${tri}f -4 1 2\n`), 'range', /line 4/);
  await rejects(parseOBJ(`${tri}vt 0 0\nf 1/2 2/1 3/1\n`), 'range', /vt index 2 on line 5/);
  await rejects(parseOBJ(`${tri}f 1/1/1/1 2 3\n`), 'syntax', /line 4/);
  await rejects(parseOBJ(`${tri}vn 0 1\n`), 'syntax', /vn on line 4/);
  await rejects(parseOBJ('vt\n'), 'syntax', /vt on line 1/);
  await rejects(parseOBJ('s smooth\n'), 'syntax', /s on line 1/);
  await rejects(parseOBJ(`${tri}v 1 1 1\n`, { maxVertices: 3 }), 'limit');
  await rejects(parseOBJ(`${tri}f 1 2 3\nf 1 2 3\n`, { maxTriangles: 1 }), 'limit');
  assert.throws(
    () => parseMTL('Kd 1 0 0\n'),
    (e) => e instanceof LoaderError && e.code === 'syntax' && /line 1 comes before the first newmtl/.test(e.message),
  );
  assert.throws(() => parseMTL('newmtl\n'), /newmtl on line 1 has no name/);
  assert.throws(() => parseMTL('newmtl a\n\nNs high\n'), /line 3/);
  assert.throws(() => parseMTL('newmtl a\nmap_Kd -clamp yes a.png\n'), /-clamp on line 2 must be on or off/);
  assert.throws(() => parseMTL('newmtl a\nmap_Kd -bm\n'), /line 2/);
});
