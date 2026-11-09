// Rich plain-data glTF: multi-material primitives sharing one vertex set, extras at every glTF scope, occlusion and
// emissive textures on either UV set, KHR transmission/IOR/emissive strength, node matrices, skin skeletons, indexed
// palette textures, collapsed nodes and the lightmap record. Every GLB here passes the Khronos validator.
import test from 'node:test';
import assert from 'node:assert/strict';
import { exportGLB, exportGLTF, exportOBJ, exportSTL, paletteTexture } from '../dist/index.js';
import { accessor, decodePNG, readGLB, validate } from './helpers.js';

// Two unit quads side by side: quad 0 red, quad 1 blue in the palette.
const twoQuads = () => ({
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 2, 0, 0, 2, 1, 0, 1, 1, 0],
  normals: Array.from({ length: 8 }, () => [0, 0, 1]).flat(),
  uvs: new Array(16).fill(0.5),
  uvs1: [0, 1, 0.5, 1, 0.5, 0, 0, 0, 0.5, 1, 1, 1, 1, 0, 0.5, 0],
  colors: Array.from({ length: 8 }, (_, i) => [0.5 + i / 16, 0.5 + i / 16, 0.5 + i / 16, 1]).flat(),
  indices: [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7],
});

async function richScene() {
  const palette = await paletteTexture([255, 0, 0, 255, 0, 0, 255, 255, 0, 255, 0, 128], { name: 'palette' });
  const geometry = twoQuads();
  // Each quad samples its palette texel through TEXCOORD_0.
  for (let v = 0; v < 8; v++) geometry.uvs.splice(v * 2, 2, ...palette.uvs.subarray(v < 4 ? 0 : 2, v < 4 ? 2 : 4));
  const ao = { ...palette.texture, texCoord: 1, extras: { pass: 'ao' } };
  const glow = { ...palette.texture, name: 'glow', extras: { pass: 'emission' } };
  const solid = {
      name: 'Palette solid',
      baseColorTexture: palette.texture,
      metalness: 0.25,
      roughness: 0.75,
      occlusionTexture: ao,
      occlusionStrength: 0.5,
      emissive: [1, 1, 1],
      emissiveTexture: glow,
      emissiveStrength: 4,
      extras: { margo: { paletteIndex: 1 } },
    },
    glass = {
      name: 'Palette glass',
      baseColorTexture: palette.texture,
      alphaMode: 'BLEND',
      transmission: 0.8,
      ior: 1.33,
      doubleSided: true,
      extras: { margo: { paletteIndex: 2, type: 'glass' } },
    };
  const body = {
    name: 'Body_Mesh',
    primitives: [
      { geometry, material: solid, indices: [0, 1, 2, 0, 2, 3], extras: { margo: { group: 'solid' } } },
      { geometry, material: glass, indices: [4, 5, 6, 4, 6, 7], extras: { margo: { group: 'glass' } } },
    ],
    meshName: 'Body_Mesh',
    meshExtras: { margo: { role: 'visual' } },
    extras: { margo: { role: 'mesh', modelId: 'body' } },
  };
  const placed = {
    name: 'Placed',
    matrix: [0, 1, 0, 0, -2, 0, 0, 0, 0, 0, 3, 0, 4, 5, 6, 1],
    extras: { margo: { role: 'instance', instanceId: '7' } },
  };
  return {
    palette,
    scene: {
      nodes: [{ name: 'Body', translation: [1, 2, 3], children: [body, placed], extras: { margo: { role: 'model' } } }],
      extras: { margo: { coordinates: 'Y-up' }, stats: { quads: 2 } },
      scene: { name: 'Voxel scene', extras: { source: 'studio' } },
      asset: { copyright: 'Original fixture', extras: { tool: 'test' } },
    },
  };
}

test('multi-material primitives share one vertex set and keep extras at every scope', async () => {
  const { scene } = await richScene(),
    glb = exportGLB(scene, { generator: 'Rich test' }),
    report = await validate(glb);
  assert.equal(report.errors + report.warnings, 0, JSON.stringify(report.messages));
  const { json, bin } = readGLB(glb);
  assert.deepEqual(json.asset, {
    version: '2.0',
    generator: 'Rich test',
    copyright: 'Original fixture',
    extras: { tool: 'test' },
  });
  assert.deepEqual(json.extras, { margo: { coordinates: 'Y-up' }, stats: { quads: 2 } });
  assert.deepEqual(json.scenes, [{ name: 'Voxel scene', nodes: [0], extras: { source: 'studio' } }]);
  assert.deepEqual(
    json.nodes.map((node) => node.name),
    ['Body', 'Body_Mesh', 'Placed'],
  );
  assert.deepEqual(json.nodes[0].extras, { margo: { role: 'model' } });
  assert.deepEqual(json.nodes[1].extras, { margo: { role: 'mesh', modelId: 'body' } });
  assert.deepEqual(json.nodes[2].matrix, [0, 1, 0, 0, -2, 0, 0, 0, 0, 0, 3, 0, 4, 5, 6, 1]);
  assert.equal(json.nodes[2].translation, undefined);
  const [mesh] = json.meshes;
  assert.equal(json.meshes.length, 1);
  assert.equal(mesh.name, 'Body_Mesh');
  assert.deepEqual(mesh.extras, { margo: { role: 'visual' } });
  assert.equal(mesh.primitives.length, 2);
  // One vertex set: both primitives name the same attribute accessors.
  assert.deepEqual(mesh.primitives[0].attributes, mesh.primitives[1].attributes);
  assert.deepEqual(Object.keys(mesh.primitives[0].attributes), [
    'POSITION',
    'NORMAL',
    'TEXCOORD_0',
    'TEXCOORD_1',
    'COLOR_0',
  ]);
  assert.notEqual(mesh.primitives[0].indices, mesh.primitives[1].indices);
  assert.deepEqual([...accessor(json, bin, mesh.primitives[1].indices)], [4, 5, 6, 4, 6, 7]);
  assert.deepEqual(
    mesh.primitives.map((p) => p.extras),
    [{ margo: { group: 'solid' } }, { margo: { group: 'glass' } }],
  );
  const color = accessor(json, bin, mesh.primitives[0].attributes.COLOR_0);
  assert.equal(color.length, 32);
  assert.equal(color[4], Math.fround(0.5 + 1 / 16), 'vertex colors (baked AO) kept as linear floats');
  const [solid, glass] = json.materials;
  assert.deepEqual(solid.occlusionTexture, { index: 1, texCoord: 1, strength: 0.5 });
  assert.deepEqual(solid.emissiveTexture, { index: 2 });
  assert.deepEqual(solid.emissiveFactor, [1, 1, 1]);
  assert.deepEqual(solid.extensions, { KHR_materials_emissive_strength: { emissiveStrength: 4 } });
  assert.deepEqual(solid.extras, { margo: { paletteIndex: 1 } });
  assert.deepEqual(glass.extensions, {
    KHR_materials_transmission: { transmissionFactor: 0.8 },
    KHR_materials_ior: { ior: 1.33 },
  });
  assert.equal(glass.alphaMode, 'BLEND');
  assert.deepEqual(json.extensionsUsed.sort(), [
    'KHR_materials_emissive_strength',
    'KHR_materials_ior',
    'KHR_materials_transmission',
  ]);
  assert.equal(json.images.length, 1, 'three textures share one palette image');
  assert.deepEqual(json.samplers, [{ magFilter: 9728, minFilter: 9728, wrapS: 33071, wrapT: 33071 }]);
  assert.deepEqual(
    json.textures.map((t) => t.extras),
    [undefined, { pass: 'ao' }, { pass: 'emission' }],
  );
});

test('the .gltf writer carries the same extras and extension fields', async () => {
  const { scene } = await richScene(),
    { json, text } = exportGLTF(scene),
    report = await validate(text);
  assert.equal(report.errors + report.warnings, 0, JSON.stringify(report.messages));
  assert.deepEqual(json.extras.stats, { quads: 2 });
  assert.equal(json.meshes[0].primitives.length, 2);
});

test('nodes sharing a primitives array share one mesh; another mesh name gets its own mesh', async () => {
  const geometry = twoQuads(),
    primitives = [
      { geometry, indices: [0, 1, 2, 0, 2, 3], material: { color: [1, 0, 0, 1] } },
      { geometry, indices: [4, 5, 6, 4, 6, 7], material: { color: [0, 0, 1, 1] } },
    ],
    glb = exportGLB({
      nodes: [
        { name: 'A', primitives },
        { name: 'B', primitives, translation: [3, 0, 0] },
        { name: 'C', primitives, meshName: 'Other' },
      ],
    }),
    report = await validate(glb);
  assert.equal(report.errors + report.warnings, 0, JSON.stringify(report.messages));
  const { json } = readGLB(glb);
  assert.deepEqual(
    json.nodes.map((n) => n.mesh),
    [0, 0, 1],
  );
  assert.deepEqual(
    json.meshes.map((m) => m.name),
    ['A', 'Other'],
  );
  assert.equal(json.accessors.filter((a) => a.type === 'VEC3').length, 2, 'one POSITION and one NORMAL in all');
});

test('indexed palette textures: one texel per entry, NEAREST, texel-centre UVs', async () => {
  const colors = Array.from({ length: 5 * 4 }, (_, i) => (i * 37 + 11) % 256),
    { texture, size, uvs } = await paletteTexture(colors, { name: 'colors' });
  assert.equal(size, 4);
  assert.equal(texture.name, 'colors');
  assert.deepEqual(
    [texture.magFilter, texture.minFilter, texture.mipmaps, texture.wrapS, texture.wrapT],
    ['nearest', 'nearest', false, 'clamp', 'clamp'],
  );
  const image = decodePNG(texture.image);
  assert.deepEqual([image.width, image.height], [4, 4]);
  assert.deepEqual([...image.data.subarray(0, 20)], colors);
  assert.ok(
    image.data.subarray(20).every((v) => v === 0),
    'unused texels transparent black',
  );
  assert.deepEqual([...uvs], [0.125, 0.125, 0.375, 0.125, 0.625, 0.125, 0.875, 0.125, 0.125, 0.375]);
  assert.equal((await paletteTexture([1, 2, 3, 4])).size, 1);
  await assert.rejects(paletteTexture([]), RangeError);
  await assert.rejects(paletteTexture([1, 2, 3]), RangeError);
  await assert.rejects(paletteTexture([1, 2, 3, 256]), RangeError);
});

test('a [0, 0, 0] scale collapses a node: glTF keeps it, mesh-only formats leave it out', async () => {
  const quad = { positions: [0, 0, 0, 1, 0, 0, 1, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1] };
  const scene = {
    nodes: [
      { name: 'Shown', geometry: quad },
      { name: 'Hidden', geometry: quad, scale: [0, 0, 0], children: [{ name: 'Child', geometry: quad }] },
    ],
  };
  const glb = exportGLB(scene),
    report = await validate(glb);
  assert.equal(report.errors + report.warnings, 0, JSON.stringify(report.messages));
  assert.deepEqual(readGLB(glb).json.nodes[1].scale, [0, 0, 0]);
  assert.equal(exportSTL(scene, { binary: true }).length, 84 + 50, 'one STL triangle');
  assert.equal((exportOBJ(scene).obj.match(/^f /gm) ?? []).length, 1);
  assert.equal(
    readGLB(exportGLB(scene, { flatten: true })).json.nodes.length,
    1,
    'flatten leaves collapsed meshes out',
  );
  assert.throws(() => exportGLB({ nodes: [{ geometry: quad, scale: [1, 0, 1] }] }), /Scale must be nonzero/);
});

test('skins name their skeleton root and keep extras; animations keep extras', async () => {
  const joint = { name: 'Head', translation: [0, 1, 0] },
    root = { name: 'Root', children: [joint] },
    skin = {
      name: 'Rig',
      joints: [root, joint],
      skeleton: root,
      inverseBindMatrices: [
        1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1,
      ],
      extras: { margo: { rig: 'two-joint' } },
    },
    mesh = {
      name: 'Skinned',
      geometry: {
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
        joints: [0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0],
        weights: [1, 0, 0, 0, 0.5, 0.5, 0, 0, 1, 0, 0, 0],
      },
      skin,
    };
  const scene = {
    nodes: [mesh, root],
    animations: [
      {
        name: 'Nod',
        channels: [{ node: joint, path: 'translation', times: [0, 1], values: [0, 1, 0, 0, 2, 0] }],
        extras: { margo: { fps: 24, startFrame: 0, endExclusive: 25 } },
      },
    ],
  };
  const glb = exportGLB(scene),
    report = await validate(glb);
  assert.equal(report.errors + report.warnings, 0, JSON.stringify(report.messages));
  const { json } = readGLB(glb);
  assert.equal(
    json.skins[0].skeleton,
    json.nodes.findIndex((n) => n.name === 'Root'),
  );
  assert.deepEqual(json.skins[0].extras, { margo: { rig: 'two-joint' } });
  assert.deepEqual(json.animations[0].extras, { margo: { fps: 24, startFrame: 0, endExclusive: 25 } });
  assert.throws(
    () => exportGLB({ nodes: [{ ...mesh, skin: { ...skin, skeleton: joint } }, root] }),
    /skeleton must be an ancestor/,
  );
});

test('cameras and lights carry extras', async () => {
  const glb = exportGLB({
      nodes: [
        { name: 'Eye', camera: { type: 'perspective', perspective: { yfov: 1, znear: 0.1 }, extras: { lens: 35 } } },
        { name: 'Sun', light: { type: 'directional', color: [1, 1, 1], intensity: 2, extras: { baked: true } } },
      ],
    }),
    report = await validate(glb);
  assert.equal(report.errors + report.warnings, 0, JSON.stringify(report.messages));
  const { json } = readGLB(glb);
  assert.deepEqual(json.cameras[0].extras, { lens: 35 });
  assert.deepEqual(json.extensions.KHR_lights_punctual.lights[0].extras, { baked: true });
});

test('extras must be JSON; invalid rich fields are refused with the fix in the message', () => {
  const quad = twoQuads(),
    node = (more) => ({ nodes: [{ geometry: quad, ...more }] });
  assert.throws(() => exportGLB(node({ extras: [1] })), /plain object/);
  assert.throws(() => exportGLB(node({ extras: { values: new Float32Array(2) } })), /Float32Array instance/);
  assert.throws(() => exportGLB(node({ extras: { value: Number.NaN } })), RangeError);
  assert.throws(() => exportGLB(node({ extras: { f() {} } })), /function/);
  const cycle = {};
  cycle.self = cycle;
  assert.throws(() => exportGLB(node({ extras: cycle })), /circular/);
  // Undefined members are left out, as JSON.stringify does; "__proto__" stays an ordinary key.
  const { json } = readGLB(exportGLB(node({ extras: JSON.parse('{"a":1,"__proto__":{"b":2}}') })));
  assert.deepEqual(Object.keys(json.nodes[0].extras), ['a', '__proto__']);
  assert.throws(() => exportGLB(node({ primitives: [{ geometry: quad }] })), /primitives or geometry/);
  assert.throws(() => exportGLB(node({ material: [] })), /material data/);
  assert.throws(() => exportGLB({ nodes: [{ primitives: [{ geometry: quad, material: [] }] }] }), /material data/);
  // Flatten writes no skins, so joint attributes on any primitive (not only the first) are refused.
  const jointed = {
    ...quad,
    joints: new Array(32).fill(0),
    weights: Array.from({ length: 8 }, () => [1, 0, 0, 0]).flat(),
  };
  assert.throws(
    () => exportGLB({ nodes: [{ primitives: [{ geometry: quad }, { geometry: jointed }] }] }, { flatten: true }),
    /Flatten does not support skins/,
  );
  assert.throws(
    () => exportGLB({ nodes: [{ primitives: [{ geometry: quad, indices: [0, 1] }] }] }),
    /complete triangles/,
  );
  assert.throws(
    () => exportGLB({ nodes: [{ primitives: [{ geometry: quad, indices: [0, 1, 99] }] }] }),
    /Index exceeds vertices/,
  );
  const plain = { positions: quad.positions, normals: quad.normals, uvs: quad.uvs, indices: quad.indices };
  const image = { image: Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0), mimeType: 'image/png' };
  assert.throws(
    () => exportGLB({ nodes: [{ geometry: plain, material: { occlusionTexture: { ...image, texCoord: 1 } } }] }),
    /uvs1/,
  );
  assert.throws(() => exportGLB(node({ material: { emissiveTexture: { ...image, texCoord: 4 } } })), RangeError);
  assert.throws(() => exportGLB(node({ material: { ior: 0.5 } })), /ior/);
  assert.throws(() => exportGLB(node({ material: { transmission: 2 } })), RangeError);
  assert.throws(() => exportGLB(node({ material: { emissiveStrength: -1 } })), RangeError);
  assert.throws(() => exportGLB(node({ matrix: new Array(16).fill(0), scale: [1, 1, 1] })), /not both/);
  const shear = [1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  assert.throws(() => exportGLB(node({ matrix: shear })), /shear/);
  const placed = { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1] };
  assert.throws(
    () =>
      exportGLB({
        nodes: [placed],
        animations: [{ channels: [{ node: placed, path: 'translation', times: [0], values: [0, 0, 0] }] }],
      }),
    /not matrix/,
  );
});

test('a lightmap is a texture recorded under root extras, not a material slot', async () => {
  const { texture } = await paletteTexture([10, 20, 30, 255, 40, 50, 60, 255]),
    lightmap = { ...texture, minFilter: 'linear', magFilter: 'linear', name: 'lightmap' },
    scene = {
      nodes: [{ name: 'Baked', geometry: twoQuads(), material: { name: 'Baked' } }],
      extras: { source: { frame: 3 } },
      lightmap: {
        texture: lightmap,
        key: 'margoLightmap',
        extras: { encoding: 'linear-unorm-times-scale', scale: 2.5, padding: 2 },
      },
    },
    glb = exportGLB(scene),
    report = await validate(glb);
  assert.equal(report.errors + report.warnings, 0, JSON.stringify(report.messages));
  const { json } = readGLB(glb);
  assert.deepEqual(json.extras, {
    source: { frame: 3 },
    margoLightmap: { texture: 0, texCoord: 1, encoding: 'linear-unorm-times-scale', scale: 2.5, padding: 2 },
  });
  assert.equal(json.textures.length, 1);
  assert.equal(json.images[0].name, 'lightmap');
  assert.equal(json.materials[0].pbrMetallicRoughness.baseColorTexture, undefined);
  const noUV1 = { ...twoQuads(), uvs1: undefined };
  assert.throws(() => exportGLB({ ...scene, nodes: [{ geometry: noUV1 }] }), /needs uvs1 on every mesh/);
  assert.throws(() => exportGLB({ ...scene, extras: { margoLightmap: 1 } }), /another key/);
  assert.throws(
    () => exportGLB({ ...scene, lightmap: { ...scene.lightmap, extras: { texture: 9 } } }),
    /cannot set texture/,
  );
});

test('a lightmap record can carry the emission atlas and both scales', async () => {
  const { texture } = await paletteTexture([10, 20, 30, 255, 40, 50, 60, 255]),
    lightmap = { texture, emission: { ...texture, name: 'emission' }, lightmapScale: 2.5, emissionScale: 4 },
    scene = { nodes: [{ geometry: twoQuads() }], lightmap },
    glb = exportGLB(scene),
    report = await validate(glb);
  assert.equal(report.errors + report.warnings, 0, JSON.stringify(report.messages));
  const { json } = readGLB(glb);
  assert.deepEqual(json.extras.lightmap, {
    texture: 0,
    texCoord: 1,
    emission: 1,
    lightmapScale: 2.5,
    emissionScale: 4,
  });
  for (const lightmapScale of [0.5, Infinity, NaN])
    assert.throws(() => exportGLB({ ...scene, lightmap: { ...lightmap, lightmapScale } }), RangeError);
  assert.throws(() => exportGLB({ ...scene, lightmap: { ...lightmap, emissionScale: '2' } }), TypeError);
  assert.throws(
    () => exportGLB({ ...scene, lightmap: { ...lightmap, extras: { emissionScale: 1 } } }),
    /cannot set emissionScale/,
  );
});
