// Structural checks on the Blender-exported Tokyo diorama (examples/assets/tokyo-diorama.glb).
// Rebuild the asset with `npm run build:tokyo` (needs Blender 5.3; see BLENDER in scripts/build-tokyo-diorama.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';

const file = new URL('../examples/assets/tokyo-diorama.glb', import.meta.url);

function readGLB(path) {
  const bytes = readFileSync(path);
  assert.equal(bytes.toString('ascii', 0, 4), 'glTF', 'not a GLB');
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a, 'first chunk must be JSON');
  return JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)));
}

const doc = readGLB(file);
const nodeIndex = (name) => {
  const index = doc.nodes.findIndex((node) => node.name === name);
  assert.ok(index >= 0, `missing node ${name}`);
  return index;
};
const channels = (name) =>
  doc.animations[0].channels.filter((c) => c.target.node === nodeIndex(name)).map((c) => c.target.path);
const triangles = () => {
  let count = 0;
  for (const node of doc.nodes)
    if (node.mesh !== undefined)
      for (const p of doc.meshes[node.mesh].primitives)
        count +=
          (p.indices !== undefined ? doc.accessors[p.indices].count : doc.accessors[p.attributes.POSITION].count) / 3;
  return count;
};

const named = (prefix) => doc.nodes.filter((n) => n.name?.startsWith(prefix)).map((n) => n.name);
const textured = (name) => doc.materials.find((m) => m.name === name)?.pbrMetallicRoughness?.baseColorTexture;

test('one 12 s Diorama clip, Draco-compressed', () => {
  assert.equal(doc.animations.length, 1);
  assert.equal(doc.animations[0].name, 'Diorama');
  const duration = Math.max(...doc.animations[0].samplers.map((s) => doc.accessors[s.input].max[0]));
  assert.ok(duration > 11.9 && duration < 12.1, `clip lasts ${duration} s`);
  assert.ok(doc.extensionsRequired?.includes('KHR_draco_mesh_compression'), 'GLB is not Draco-compressed');
});

test('ground: slab, road, sidewalk, track and moving tram', () => {
  for (const name of [
    'Diorama_Root',
    'Slab',
    'Road',
    'Sidewalk',
    'Track_Rails',
    'Track_Sleepers',
    'Crosswalk',
    'Road_Text',
  ])
    nodeIndex(name);
  assert.deepEqual(channels('Tram').sort(), ['rotation', 'translation']);
});

test('five dense buildings with alleys, spinning AC fans and swaying banners', () => {
  for (let i = 1; i <= 5; i++) nodeIndex('Building_' + i);
  nodeIndex('Alley_1');
  const fans = named('AC_Fan_').filter((n) => /^AC_Fan_\d+$/.test(n));
  assert.ok(fans.length >= 8, `${fans.length} AC fans`);
  for (const fan of fans) assert.deepEqual(channels(fan), ['rotation'], fan);
  const banners = named('Banner_').filter((n) => /^Banner_\d+$/.test(n));
  assert.ok(banners.length >= 3);
  for (const banner of banners) assert.deepEqual(channels(banner), ['rotation'], banner);
});

test('tanuki hero swings its lantern', () => {
  nodeIndex('Tanuki_Statue');
  assert.deepEqual(channels('Tanuki_Lantern_Arm'), ['rotation']);
});

test('street life: poles and wires, vending machines, cones, food stall, birds', () => {
  for (const name of [
    'Utility_Pole_1',
    'Utility_Pole_2',
    'Vending_Machine_1',
    'Vending_Machine_2',
    'Post_Box',
    'Food_Stall',
    'Tram_Stop',
  ])
    nodeIndex(name);
  assert.ok(named('Power_Line_').length >= 10, 'too few power lines');
  assert.ok(named('Traffic_Cone_').length >= 4, 'too few cones');
  assert.ok(named('Bicycle_').filter((n) => /^Bicycle_\d+$/.test(n)).length >= 2, 'too few bicycles');
  assert.ok(named('Bird_').filter((n) => /^Bird_\d+$/.test(n)).length >= 3, 'too few birds');
});

test('the cat walks with moving legs and a swishing tail', () => {
  assert.deepEqual(channels('Cat_1').sort(), ['rotation', 'translation'], 'cat walk');
  assert.deepEqual(channels('Cat_1_Leg_FL'), ['rotation'], 'cat legs');
  assert.deepEqual(channels('Cat_1_Tail_1'), ['rotation'], 'cat tail');
  assert.equal(named('Cat_').filter((n) => /^Cat_\d+$/.test(n)).length, 1, 'one cat');
});

test('textured: baked atlases and a sign atlas with original lettering', () => {
  for (const name of [
    'TD_tram_atlas',
    'TD_ground_atlas',
    'TD_b1_atlas',
    'TD_b2_atlas',
    'TD_b3_atlas',
    'TD_b4_atlas',
    'TD_b5_atlas',
    'TD_props_atlas',
    'TD_signs',
  ])
    assert.ok(textured(name), `${name} has no texture`);
  const signFaces = doc.meshes
    .flatMap((m) => m.primitives)
    .filter((p) => ['TD_signs', 'TD_signs_lit'].includes(doc.materials[p.material]?.name))
    .reduce((sum, p) => sum + doc.accessors[p.indices].count / 6, 0); // one quad (two triangles) per sign face
  assert.ok(signFaces >= 15, `${signFaces} sign faces`);
  for (const image of doc.images) assert.equal(image.mimeType, 'image/webp', image.name); // WebP keeps leaf alpha
  const leaves = doc.materials.find((m) => m.name === 'TD_foliage');
  assert.ok(
    leaves?.alphaMode === 'MASK' && leaves.doubleSided && leaves.pbrMetallicRoughness?.baseColorTexture,
    'foliage is not alpha-cut, double-sided and textured',
  );
});

test('all atlas images are embedded and textured primitives have valid UV sets', () => {
  for (const name of [
    'b1_atlas',
    'b2_atlas',
    'b3_atlas',
    'b4_atlas',
    'b5_atlas',
    'cats_atlas',
    'foliage_sprites',
    'ground_atlas',
    'props_atlas',
    'signs_atlas',
    'tanuki_atlas',
    'tram_atlas',
  ]) {
    const image = doc.images.find((image) => image.name === name);
    assert.ok(image && Number.isInteger(image.bufferView), `${name} is not embedded`);
    assert.ok(doc.bufferViews[image.bufferView].byteLength > 20, `${name} has no image data`);
  }
  for (const mesh of doc.meshes) {
    for (const primitive of mesh.primitives) {
      const material = doc.materials[primitive.material];
      const maps = [
        material.pbrMetallicRoughness?.baseColorTexture,
        material.pbrMetallicRoughness?.metallicRoughnessTexture,
        material.normalTexture,
        material.occlusionTexture,
        material.emissiveTexture,
      ].filter(Boolean);
      for (const map of maps) {
        const set = map.texCoord ?? 0;
        assert.ok(
          Number.isInteger(set) && set >= 0 && set <= 1,
          `${mesh.name}/${material.name} has invalid texture coordinate ${set}`,
        );
        const accessor = doc.accessors[primitive.attributes[`TEXCOORD_${set}`]];
        assert.ok(accessor, `${mesh.name}/${material.name} has no TEXCOORD_${set}`);
        assert.equal(accessor.type, 'VEC2', `${mesh.name}/${material.name} UV type`);
        assert.equal(
          accessor.count,
          doc.accessors[primitive.attributes.POSITION].count,
          `${mesh.name}/${material.name} UV count`,
        );
      }
    }
  }
});

test('underside dedication is baked into the existing base and ground atlas', () => {
  assert.equal(named('Makers_Mark').length, 0, 'authoring lettering must not ship as geometry');
  const index = doc.materials.findIndex((material) => material.name === 'TD_makers_mark_baked');
  assert.ok(index >= 0, 'missing baked underside material');
  const material = doc.materials[index];
  const color = material.pbrMetallicRoughness.baseColorTexture;
  const imageFor = (map) =>
    doc.textures[map.index].extensions?.EXT_texture_webp?.source ?? doc.textures[map.index].source;
  assert.equal(
    imageFor(material.emissiveTexture),
    imageFor(color),
    'underside must reuse its color atlas for emission',
  );
  assert.ok(
    material.emissiveFactor.every((value) => value > 0 && value <= 1),
    'underside needs a readable glow',
  );
  assert.equal(doc.images[imageFor(color)].name, 'ground_atlas', 'dedication must reuse GroundAtlas');
  const base = doc.nodes[nodeIndex('Slab_Base')];
  assert.ok(
    doc.meshes[base.mesh].primitives.some((primitive) => primitive.material === index),
    'dedication must be on Slab_Base',
  );
});

test('hero tram: baked weathering atlas, see-through glass, real detail', () => {
  const subtree = [nodeIndex('Tram')];
  for (let i = 0; i < subtree.length; i++) subtree.push(...(doc.nodes[subtree[i]].children ?? []));
  const primitives = subtree.flatMap((i) =>
    doc.nodes[i].mesh === undefined ? [] : doc.meshes[doc.nodes[i].mesh].primitives,
  );
  const materials = [...new Set(primitives.map((p) => p.material))].map((i) => doc.materials[i]);
  assert.ok(
    materials.some((m) => m.name === 'TD_tram_atlas'),
    'tram has no baked atlas',
  );
  assert.ok(
    materials.some((m) => m.alphaMode === 'BLEND'),
    'tram glass is not see-through',
  );
  const tris = primitives.reduce((sum, p) => sum + doc.accessors[p.indices].count / 3, 0);
  assert.ok(tris >= 6000 && tris <= 40000, `tram has ${tris} triangles`);
});

test('glowing signs and web budget', () => {
  const emissive = doc.materials.filter((m) => (m.emissiveFactor ?? [0, 0, 0]).some((v) => v > 0));
  assert.ok(emissive.length >= 5, `only ${emissive.length} emissive materials`);
  assert.ok(triangles() <= 350_000, `${triangles()} triangles`);
  assert.ok(statSync(file).size <= 16 * 1024 * 1024, `${statSync(file).size} bytes`);
});
