import test from 'node:test';
import assert from 'node:assert/strict';
import { Material, Texture } from '@margoengine/materials';
import { SRGBToLinear } from '@margoengine/math/color';
import { LoaderError, parseMTL, parseOBJ } from '../dist/index.js';
import { createMTLMaterials, loadOBJ, prepareOBJMesh } from '../dist/mtl.js';

/** A texture loader that records every request and returns a 1x1 texture (or fails for names containing "missing"). */
function recorder() {
  const requests = [];
  const load = async (url, options) => {
    requests.push({ url, ...options, signal: undefined });
    if (url.includes('missing')) throw new Error('404');
    return new Texture({ data: new Uint8Array(4), width: 1, height: 1 }, options);
  };
  return { requests, load };
}
const close = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: ${actual} != ${expected}`);

const MTL = `newmtl shiny
Ka 0.1 0.1 0.1
Kd 1 0 0
Ks 1 1 1
Ns 100
Ke 0 0.5 0
d 0.5
illum 2
map_Kd -s 2 2 1 -o 0.5 0.25 tex/diffuse.png
map_Bump -bm 0.3 tex/bump.png
map_d alpha.png
norm -bm 2 tex/normal.png
refl sky.png
newmtl flat
Kd 0.5 0.5 0.5
illum 1
Ns 500
Tr 0.25
map_Kd tex/diffuse.png
newmtl unlit
Kd 0 0 1
illum 0
map_Ke glow.png
newmtl pbr
Pr 0.3
Pm 1
Ks 0 0 0
map_Ke -clamp on glow.png
newmtl broken
map_Kd missing.png
newmtl bright
Ke 2 1 0
`;

test('createMTLMaterials: colours, opacity, roughness from Ns, PBR extension, illum, maps and their options', async () => {
  const { requests, load } = recorder(),
    set = await createMTLMaterials(parseMTL(MTL), {
      baseUrl: 'https://example.com/models/scene.mtl',
      loadTexture: load,
    });
  assert.deepEqual([...set.materials.keys()], ['shiny', 'flat', 'unlit', 'pbr', 'broken', 'bright']);
  const { shiny, flat, unlit, pbr, broken, bright } = Object.fromEntries(set.materials);
  for (const material of set.materials.values()) assert.ok(material instanceof Material);
  // Kd is sRGB in the file; Material colours are linear. Opacity rides in the colour's alpha.
  assert.deepEqual([...shiny.color], [1, 0, 0, 0.5]);
  assert.equal(shiny.transparent, true);
  close(shiny.roughness, (2 / 102) ** 0.25, 'roughness from Ns 100');
  assert.equal(shiny.metalness, 0);
  close(shiny.emissive[1], SRGBToLinear(0.5), 'Ke');
  assert.ok(shiny.map instanceof Texture && shiny.bumpMap instanceof Texture);
  assert.ok(shiny.alphaMap instanceof Texture && shiny.normalMap instanceof Texture);
  close(shiny.bumpScale, 0.3, '-bm');
  // map_Kd -s 2 2 -o 0.5 0.25 becomes the map slot's UV transform (scale then offset).
  assert.deepEqual(
    shiny.uvt.slice(0, 8).map((v) => v + 0),
    [2, 0, 0.5, 0, 0, 2, 0.25, 0],
  );
  close(flat.color[0], SRGBToLinear(0.5), 'Kd');
  close(flat.opacity, 0.75, '1 - Tr');
  assert.equal(flat.roughness, 1, 'illum 1 has no highlight');
  assert.equal(unlit.shading, 'basic');
  assert.equal(unlit.emissiveMap, null, 'illum 0 ignores lighting maps');
  close(pbr.roughness, 0.3, 'Pr');
  assert.equal(pbr.metalness, 1);
  assert.deepEqual([...pbr.emissive], [1, 1, 1], 'map_Ke without Ke emits the map as it is');
  assert.ok(pbr.emissiveMap instanceof Texture);
  assert.equal(broken.map, null);
  // Emission over 1 keeps its colour and moves the excess into emissiveIntensity.
  assert.deepEqual(
    [...bright.emissive].map((v) => Math.round(v * 1e6) / 1e6),
    [1, Math.round(SRGBToLinear(0.5) * 1e6) / 1e6, 0],
  );
  assert.equal(bright.emissiveIntensity, 2);
  // Paths resolve against the .mtl URL; each file loads once per colour space and wrap mode.
  assert.deepEqual(
    requests.map((r) => [r.url.replace('https://example.com/models/', ''), r.colorSpace, r.wrapS]),
    [
      ['tex/diffuse.png', 'srgb', 'repeat'],
      ['alpha.png', 'linear', 'repeat'],
      ['tex/bump.png', 'linear', 'repeat'],
      ['tex/normal.png', 'linear', 'repeat'],
      ['glow.png', 'srgb', 'clamp'],
      ['missing.png', 'srgb', 'repeat'],
    ],
  );
  assert.equal(set.textures.length, 5);
  for (const pattern of [/missing\.png could not be loaded/, /refl has no Margo/, /Ka/, /Ks/])
    assert.ok(
      set.warnings.some((w) => pattern.test(w)),
      `warning ${pattern}`,
    );
  set.dispose();
});

test('createMTLMaterials: bump as normal map, doubleSided, abort, and argument errors', async () => {
  const { requests, load } = recorder(),
    set = await createMTLMaterials(parseMTL('newmtl a\nbump n.png\n'), {
      baseUrl: 'https://example.com/a.mtl',
      loadTexture: load,
      bump: 'normal',
      doubleSided: true,
    });
  const a = set.materials.get('a');
  assert.ok(a.normalMap instanceof Texture);
  assert.equal(a.bumpMap, null);
  assert.equal(a.doubleSided, true);
  assert.equal(requests.length, 1);
  const controller = new AbortController();
  const aborted = createMTLMaterials(parseMTL('newmtl a\nmap_Kd x.png\n'), {
    baseUrl: 'https://example.com/a.mtl',
    signal: controller.signal,
    loadTexture: (url, { signal }) =>
      new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
  });
  controller.abort();
  await assert.rejects(aborted, (e) => e instanceof LoaderError && e.code === 'aborted');
  await assert.rejects(createMTLMaterials('nope'), TypeError);
  await assert.rejects(createMTLMaterials([], { bump: 'height map' }), RangeError);
  await assert.rejects(
    createMTLMaterials(parseMTL('newmtl a\nmap_Kd x.png\n'), { baseUrl: 'relative/a.mtl' }),
    TypeError,
  );
  // No maps: no base URL is needed.
  assert.equal((await createMTLMaterials(parseMTL('newmtl a\nKd 1 1 1\n'))).materials.size, 1);
});

const OBJ = `mtllib mats/lib.mtl
v 0 0 0 1 0 0
v 1 0 0 0 1 0
v 1 1 0 0 0 1
v 0 1 0 1 1 1
vt 0 0
vt 1 0
vt 1 1
vt 0 1
vt 0.5 0.5
usemtl red
f 1/1 2/2 3/3
usemtl blue
f 1/1 3/3 4/4
usemtl none
f 1/5 2/2 4/4
`;
const LIB = `newmtl red
Kd 1 0 0
map_Kd tex/red.png
norm ../normals/red.png
newmtl blue
Kd 0 0 1
`;

test('OBJ with MTL: map paths relative to the library, groups to material slots, UVs, colours, normals', async () => {
  const obj = await parseOBJ(OBJ, {
    resolve: async (path) => {
      assert.equal(path, 'mats/lib.mtl');
      return LIB;
    },
  });
  const { requests, load } = recorder(),
    set = await createMTLMaterials(obj.materials, {
      baseUrl: 'https://example.com/models/scene.obj',
      loadTexture: load,
    });
  assert.deepEqual(
    requests.map((r) => r.url),
    ['https://example.com/models/mats/tex/red.png', 'https://example.com/models/normals/red.png'],
  );
  const fallback = new Material({ color: '#808080' }),
    { geometry, materials } = prepareOBJMesh(obj, set, { fallback });
  assert.deepEqual(materials, [set.materials.get('red'), set.materials.get('blue'), fallback]);
  assert.deepEqual(geometry.groups, [
    { start: 0, count: 3, materialIndex: 0 },
    { start: 3, count: 3, materialIndex: 1 },
    { start: 6, count: 3, materialIndex: 2 },
  ]);
  assert.equal(obj.warnings.length, 1, 'usemtl none names no material');
  // UVs are back in OBJ orientation (parseOBJ stores v flipped) for flipY textures.
  const uvOf = (vt) => {
    for (let v = 0; v < geometry.uvs.length / 2; v++)
      if (geometry.uvs[v * 2] === vt[0] && geometry.uvs[v * 2 + 1] === vt[1]) return v;
    return -1;
  };
  for (const vt of [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
    [0.5, 0.5],
  ])
    assert.ok(uvOf(vt) >= 0, `uv ${vt}`);
  // Corner 1/1 and 1/5 are two vertices (UV seam) that share position 1, so they share its smooth normal.
  assert.equal(obj.positionIndices.filter((p) => p === 0).length, 2);
  for (let v = 0; v < geometry.normals.length / 3; v++)
    assert.deepEqual([...geometry.normals.slice(v * 3, v * 3 + 3)], [0, 0, 1]);
  // Vertex colours become linear.
  const first = obj.positionIndices.indexOf(1);
  close(geometry.colors[first * 3 + 1], SRGBToLinear(1), 'colour');
  close(geometry.colors[obj.positionIndices.indexOf(0) * 3], 1, 'colour');
  // With a Map and no fallback, a white Material is made for unknown materials.
  const plain = prepareOBJMesh(obj, new Map([['red', set.materials.get('red')]]));
  assert.equal(plain.materials.length, 2);
  assert.deepEqual([...plain.materials[1].color], [1, 1, 1, 1]);
  assert.deepEqual(
    plain.geometry.groups.map((g) => g.materialIndex),
    [0, 1, 1],
  );
  const cloud = await parseOBJ('v 0 0 0\nv 1 0 0\n');
  assert.throws(
    () => prepareOBJMesh(cloud, set),
    (e) => e instanceof LoaderError && e.code === 'unsupported',
  );
  assert.throws(() => prepareOBJMesh(obj, {}), TypeError);
  set.dispose();
});

test('loadOBJ: fetches the OBJ, its libraries and textures relative to each file, and cleans up when the mesh fails', async () => {
  const fetched = [],
    files = { 'https://example.com/models/scene.obj': OBJ, 'https://example.com/models/mats/lib.mtl': LIB };
  const fetch = async (url) => {
    fetched.push(String(url));
    return files[String(url)] === undefined ? new Response('', { status: 404 }) : new Response(files[String(url)]);
  };
  const disposed = [],
    { requests, load } = recorder(),
    loadTexture = async (url, options) => {
      const texture = await load(url, options);
      texture.dispose = () => disposed.push(url);
      return texture;
    };
  // A stand-in engine makes materials' createMesh throw after everything was loaded and built.
  await assert.rejects(loadOBJ({}, 'https://example.com/models/scene.obj', { fetch, loadTexture }), TypeError);
  assert.deepEqual(fetched, ['https://example.com/models/scene.obj', 'https://example.com/models/mats/lib.mtl']);
  assert.deepEqual(
    requests.map((r) => r.url),
    ['https://example.com/models/mats/tex/red.png', 'https://example.com/models/normals/red.png'],
  );
  assert.deepEqual(disposed.sort(), requests.map((r) => r.url).sort(), 'textures are freed when the mesh fails');
  await assert.rejects(
    loadOBJ({}, 'https://example.com/models/none.obj', { fetch, loadTexture }),
    (e) => e instanceof LoaderError && e.code === 'fetch',
  );
  await assert.rejects(loadOBJ({}, 'relative.obj'), TypeError);
});
