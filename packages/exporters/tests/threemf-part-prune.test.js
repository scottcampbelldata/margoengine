// KB-3MF-PARTCOPY1: with `production: {separateParts: true}` a model part carries only the property entries its object
// uses (production extension 3.2 lets a part refer to its own resources only), renumbered to match, instead of a copy
// of every group it names whole.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse3MF, readZipDirectory, readZipEntry } from '@margoengine/loaders';
import { parse3MFMaterials } from '@margoengine/loaders/threemf-materials';
import { export3MF } from '@margoengine/exporters/threemf';

const corners = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
const faces = [
  0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
];
const box = (colors) => ({
  positions: new Float32Array(corners),
  normals: new Float32Array(corners.length),
  indices: new Uint32Array(faces),
  ...(colors ? { colors: new Float32Array(colors) } : {}),
});
const parts = async (file) => {
  const out = {};
  for (const entry of readZipDirectory(file))
    out[entry.name] = new TextDecoder().decode(await readZipEntry(file, entry));
  return out;
};
const SEPARATE = { assembly: 'components', production: { separateParts: true } };

/** Six boxes with their own metallic and translucent materials, two with vertex colours over them. */
const scene = () => {
  const shaded = Array.from({ length: 8 }, (_, i) => [i / 7, 1 - i / 7, 0.5, 1]).flat();
  const materials = [
    { name: 'Red steel', color: [1, 0, 0, 1], metalness: 1, roughness: 0.3 },
    { name: 'Green paint', color: [0, 1, 0, 1], metalness: 0, roughness: 0.6 },
    { name: 'Blue paint', color: [0, 0, 1, 1], metalness: 0, roughness: 0.2 },
    { name: 'Gold', color: [0.8, 0.8, 0.2, 1], metalness: 1, roughness: 0.1 },
    { name: 'Glass', color: [1, 1, 1, 1], transmission: 1, ior: 1.5, roughness: 0 },
    { name: 'Tinted', color: [0.5, 0.5, 1, 1], metalness: 0.5, roughness: 0.5 },
  ];
  return {
    nodes: materials.map((material, i) => ({
      name: `box ${i}`,
      translation: [i * 2, 0, 0],
      geometry: box(i === 2 || i === 4 ? shaded : undefined),
      material,
    })),
  };
};
const strip = (groups) => groups.map(({ modelPath, uuid, itemUUID, componentUUID, ...rest }) => rest);

test('each separate part carries only the entries its object uses, and reads back as the components form does', async () => {
  const together = await export3MF(scene(), { assembly: 'components' }),
    apart = await export3MF(scene(), SEPARATE),
    all = await parts(apart),
    objectParts = Object.keys(all).filter((name) => /^3D\/Objects\/.*\.model$/.test(name));
  assert.equal(objectParts.length, 6);
  for (const name of objectParts) {
    const text = all[name];
    // One object, so each base material group holds one entry, and its display properties one too.
    for (const [, body] of text.matchAll(/<basematerials [^>]*>(.*?)<\/basematerials>/g))
      assert.equal(body.match(/<base /g).length, 1, name);
    for (const [, body] of text.matchAll(/<m:pb(?:metallic|specular)displayproperties [^>]*>(.*?)<\/m:pb/g))
      assert.equal(body.match(/<m:pb/g).length, 1, name);
    for (const [, body] of text.matchAll(
      /<m:translucentdisplayproperties [^>]*>(.*?)<\/m:translucentdisplayproperties>/g,
    ))
      assert.equal(body.match(/<m:translucent /g).length, 1, name);
  }
  const one = await parse3MFMaterials(together),
    two = await parse3MFMaterials(apart);
  assert.deepEqual(strip(two.groups), strip(one.groups));
  assert.deepEqual([...two.colors], [...one.colors]);
  assert.deepEqual([...two.positions], [...one.positions]);
  const plain = await parse3MF(apart);
  assert.deepEqual(
    plain.groups.map((g) => g.color),
    (await parse3MF(together)).groups.map((g) => g.color),
  );
});

test('NodePerformanceTest in separate parts stays near its components size (KB-3MF-PARTCOPY1)', async () => {
  const glb = readFileSync(
      new URL('../../../examples/assets/khronos/NodePerformanceTest/NodePerformanceTest.glb', import.meta.url),
    ),
    together = await export3MF(glb, { assembly: 'components' }),
    // Before the fix this threw "ZIP would exceed 268435456 bytes": each part held the scene's whole base material
    // group of about 10,000 entries and its display properties.
    apart = await export3MF(glb, SEPARATE);
  assert.ok(apart.byteLength < together.byteLength * 4, `${apart.byteLength} B against ${together.byteLength} B`);
  const objects = readZipDirectory(apart, { maxEntries: 30000 }).filter(
    (entry) => entry.name.startsWith('3D/Objects/') && entry.name.endsWith('.model'),
  );
  assert.equal(objects.length, 10000);
  // A part is its one small mesh and the one entry of each group it uses: a few kilobytes, never the whole groups.
  for (const { name, size } of objects) assert.ok(size < 16384, `${name} is ${size} B`);
  for (const entry of objects.slice(0, 50)) {
    const text = new TextDecoder().decode(await readZipEntry(apart, entry));
    for (const [, body] of text.matchAll(/<basematerials [^>]*>(.*?)<\/basematerials>/g))
      assert.equal(body.match(/<base /g).length, 1, entry.name);
    for (const [, index] of text.matchAll(/ pindex="(\d+)"/g)) assert.equal(index, '0', entry.name);
  }
  // KB-3MF-PARTLIMIT1: Margo reads its own 10,000-part file back with the default limits (it refused past 1,024 parts).
  const back = await parse3MF(apart),
    flat = await parse3MF(together);
  assert.equal(new Set(back.groups.map((g) => g.modelPath)).size, 10000);
  assert.equal(back.indices.length, flat.indices.length);
});
