// Roblox GLB: meshes split into parts of at most 20,000 triangles with every triangle and attribute value kept.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { box, PbrMaterial } from '@margoengine/core/extension';
import { exportGLB } from '@margoengine/exporters';
import { exportRobloxGLB } from '@margoengine/exporters/roblox';
import { accessor, headlessEngine, readGLB, validate } from './helpers.js';

const triangle = () => ({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1] });
const values = ({ json, bin }, id) => accessor(json, bin, id);
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);

/** Every corner of every part equals the ordinary export's corner it came from, for every attribute. */
function sameCorners(ordinary, roblox, mapping) {
  const source = ordinary.json.meshes[0].primitives[0],
    sourceIndices = values(ordinary, source.indices);
  for (const [p, primitive] of roblox.json.meshes[0].primitives.entries()) {
    const part = mapping.parts[mapping.uses[p].part],
      indices = values(roblox, primitive.indices);
    assert.deepEqual(Object.keys(primitive.attributes).sort(), Object.keys(source.attributes).sort());
    for (const [name, id] of Object.entries(primitive.attributes)) {
      const before = values(ordinary, source.attributes[name]),
        after = values(roblox, id),
        width = after.length / part.sourceVertices.length;
      for (let i = 0; i < indices.length; i++) {
        const from = sourceIndices[part.firstTriangle * 3 + i];
        assert.equal(part.sourceVertices[indices[i]], from);
        for (let c = 0; c < width; c++) assert.equal(after[indices[i] * width + c], before[from * width + c]);
      }
    }
  }
}

test('every primitive splits into parts that keep each corner and attribute value exactly', () => {
  for (const colorSize of [3, 4]) {
    const geometry = {
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0],
      normals: Array(6).fill([0.29061404, 0.489734, 0.8220122]).flat(),
      uvs: [0, 0, 1, 0, 0, 1, 1, 1, 0.5, 0.5, 1, 0],
      tangents: Array(6).fill([0.3, 0.4, 0.5, -2]).flat(),
      colors: Array.from({ length: 6 * colorSize }, (_, i) => (i % 5) / 4),
      indices: [0, 1, 2, 3, 4, 5, 0, 1, 2],
    };
    const scene = { nodes: [{ name: 'n', translation: [1e-50, 2, 3], scale: [-1, 2, 1], geometry }] },
      before = exportGLB(scene),
      { glb, mapping } = exportRobloxGLB(scene, { maxTrianglesPerPart: 1 }),
      ordinary = readGLB(before),
      roblox = readGLB(glb);
    assert.equal(roblox.json.meshes[0].primitives.length, 3);
    sameCorners(ordinary, roblox, mapping);
    assert.deepEqual(roblox.json.nodes, ordinary.json.nodes);
    assert.deepEqual(
      mapping.uses.map((use) => [use.node, use.primitive, use.sourcePrimitive, use.part]),
      [
        [0, 0, 0, 0],
        [0, 1, 0, 1],
        [0, 2, 0, 2],
      ],
    );
    assert.deepEqual(exportGLB(scene), before, 'the source scene is not changed');
  }
});

test('the parts in the file hold the source triangles in order, read with no help from the mapping', () => {
  const positions = Array.from({ length: 36 }, (_, i) => (i * 7) % 11),
    indices = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 2, 5, 8, 1, 4, 7],
    normals = Array(12).fill([0, 0, 1]).flat(),
    scene = { nodes: [{ name: 'n', geometry: { positions, normals, indices } }] },
    file = readGLB(exportRobloxGLB(scene, { maxTrianglesPerPart: 2 }).glb),
    corners = [];
  for (const primitive of file.json.meshes[0].primitives) {
    const stored = values(file, primitive.attributes.POSITION);
    assert.ok(values(file, primitive.indices).length <= 6, 'the cap, in the file');
    for (const index of values(file, primitive.indices)) corners.push([...stored.slice(index * 3, index * 3 + 3)]);
  }
  assert.deepEqual(
    corners,
    indices.map((index) => positions.slice(index * 3, index * 3 + 3)),
  );
});

test('the default cap makes parts of 20,000 triangles and a partial last part', () => {
  for (const [triangles, expected] of [
    [20_000, [20_000]],
    [20_001, [20_000, 1]],
    [50_000, [20_000, 20_000, 10_000]],
  ]) {
    const geometry = { ...triangle(), indices: Uint32Array.from({ length: triangles * 3 }, (_, i) => i % 3) },
      { glb, mapping } = exportRobloxGLB({ nodes: [{ geometry }] }),
      { json } = readGLB(glb);
    assert.deepEqual(
      json.meshes[0].primitives.map((p) => json.accessors[p.indices].count / 3),
      expected,
    );
    assert.deepEqual(
      mapping.parts.map((part) => [part.firstTriangle, part.triangleCount]),
      expected.map((count, i) => [i * 20_000, count]),
    );
  }
});

test('shared geometry and shared primitive lists are split once and reused', async () => {
  const geometry = { ...triangle(), indices: [0, 1, 2, 0, 2, 1] },
    primitives = [{ geometry, indices: [0, 2, 1, 0, 1, 2] }],
    scene = {
      nodes: [
        {
          name: 'Root',
          translation: [2, 3, 4],
          children: [
            { name: 'Body', geometry, scale: [-1, 2, 1] },
            { name: 'Head', geometry, translation: [0, 2, 0] },
            { name: 'A', primitives },
            { name: 'B', primitives },
            { name: 'Mount', translation: [0.5, 1, 0] },
          ],
        },
      ],
    },
    { glb, mapping } = exportRobloxGLB(scene, { maxTrianglesPerPart: 1 }),
    { json } = readGLB(glb),
    report = await validate(glb);
  assert.equal(report.errors + report.warnings, 0, JSON.stringify(report.messages));
  assert.deepEqual(json.nodes, readGLB(exportGLB(scene)).json.nodes);
  assert.equal(json.meshes.length, 2);
  assert.equal(mapping.parts.length, 4);
  assert.deepEqual(
    mapping.uses.map((use) => use.node),
    [1, 1, 2, 2, 3, 3, 4, 4],
  );
});

test('a textured palette keeps its image, sampler and material and passes the Khronos validator', async () => {
  const fixture = readGLB(new Uint8Array(await readFile(new URL('./fixtures/BoxTextured.glb', import.meta.url)))),
    view = fixture.json.bufferViews[fixture.json.images[0].bufferView],
    image = fixture.bin.slice(view.byteOffset, view.byteOffset + view.byteLength),
    geometry = {
      positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
      normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
      uvs: [0, 0, 1, 0, 1, 1, 0, 1],
      indices: [0, 1, 2, 0, 2, 3],
    },
    texture = { image, mimeType: 'image/png', magFilter: 'nearest', minFilter: 'nearest', mipmaps: false },
    scene = { nodes: [{ geometry, material: { name: 'Palette', baseColorTexture: texture } }] },
    ordinary = readGLB(exportGLB(scene)),
    { glb, mapping } = exportRobloxGLB(scene, { maxTrianglesPerPart: 1 }),
    roblox = readGLB(glb),
    report = await validate(glb);
  assert.equal(report.errors + report.warnings, 0, JSON.stringify(report.messages));
  for (const key of ['materials', 'samplers', 'textures', 'images'])
    assert.deepEqual(roblox.json[key], ordinary.json[key]);
  sameCorners(ordinary, roblox, mapping);
});

test('engine scenes split like data scenes', async () => {
  const engine = await headlessEngine();
  engine
    .createMesh()
    .setGeometry(box(1, 1, 1))
    .setMaterial(new PbrMaterial({ color: '#ff0000' }));
  const { glb, mapping } = exportRobloxGLB(engine, { maxTrianglesPerPart: 5 }),
    { json } = readGLB(glb);
  assert.deepEqual(
    json.meshes[0].primitives.map((p) => json.accessors[p.indices].count / 3),
    [5, 5, 2],
  );
  assert.equal(mapping.importSettings.mergeMeshes, false);
});

test('node clips are kept with animations: true and refused without it', () => {
  const node = { name: 'n', geometry: { ...triangle(), indices: [0, 1, 2, 0, 2, 1] } },
    channels = [{ node, path: 'translation', times: [0, 1], values: [0, 0, 0, 1, 2, 3] }],
    scene = { nodes: [node], animations: [{ name: 'move', channels }] };
  assert.throws(() => exportRobloxGLB(scene), { name: 'TypeError', message: /animations: true/ });
  const ordinary = readGLB(exportGLB(scene)),
    roblox = readGLB(exportRobloxGLB(scene, { animations: true, maxTrianglesPerPart: 1 }).glb),
    [a] = ordinary.json.animations,
    [b] = roblox.json.animations;
  assert.deepEqual(b.channels, a.channels);
  for (const [i, sampler] of b.samplers.entries()) {
    assert.deepEqual(values(roblox, sampler.input), values(ordinary, a.samplers[i].input));
    assert.deepEqual(values(roblox, sampler.output), values(ordinary, a.samplers[i].output));
  }
});

test('features Roblox meshes cannot hold are refused with the fix', () => {
  const mesh = (extra) => ({ nodes: [{ geometry: triangle(), ...extra }] }),
    uvs = [0, 0, 1, 0, 0, 1],
    normalMapped = {
      nodes: [{ geometry: { ...triangle(), uvs }, material: { normalTexture: { image: png, mimeType: 'image/png' } } }],
    };
  for (const [scene, message] of [
    [mesh({ name: 'Shirt_InnerCage' }), /layered-clothing cage/],
    [mesh({ meshExtras: { margo: { role: 'collision' } } }), /collision or cage proxy/],
    [mesh({ extras: { margo_collision: true } }), /collision or cage proxy/],
    [mesh({ camera: { type: 'perspective', yfov: 1, znear: 0.1 } }), /cameras or lights/],
    [{ nodes: [{ geometry: { ...triangle(), uvs, uvs1: uvs } }] }, /one UV set/],
    [normalMapped, /materialPolicy: 'preserve'/],
    [{ ...mesh({}), lightmap: {} }, /lightmap/],
  ])
    assert.throws(() => exportRobloxGLB(scene), { name: 'TypeError', message }, String(message));
  assert.doesNotThrow(() => exportRobloxGLB(normalMapped, { materialPolicy: 'preserve' }));
  for (const maxTrianglesPerPart of [0, 20_001, 1.5])
    assert.throws(() => exportRobloxGLB(mesh({}), { maxTrianglesPerPart }), RangeError);
});

// A two-joint rig: a root at the origin and a child joint carrying every vertex.
function rig({ rootAt = [0, 0, 0], weightRoot = false } = {}) {
  const child = { name: 'Arm', translation: [0, 1, 0] },
    root = { name: 'Root', translation: rootAt, children: [child] },
    skinned = {
      name: 'Body',
      geometry: {
        ...triangle(),
        indices: [0, 1, 2],
        joints: [0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
        weights: weightRoot ? [0.5, 0.5, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] : [0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
      },
      skin: { joints: [root, child], inverseBindMatrices: [...identity(), ...translate(0, -1, 0)] },
    };
  return { nodes: [root, skinned] };
}
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const translate = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

test('skins are kept with skins: true, split with their joints, and checked against Roblox rig rules', () => {
  assert.throws(() => exportRobloxGLB(rig()), { name: 'TypeError', message: /skins: true/ });
  const { glb, mapping } = exportRobloxGLB(rig(), { skins: true, maxTrianglesPerPart: 1 }),
    file = readGLB(glb),
    primitive = file.json.meshes[0].primitives[0];
  assert.equal(file.json.skins.length, 1);
  assert.deepEqual([...values(file, primitive.attributes.JOINTS_0)].slice(0, 4), [0, 1, 0, 0]);
  assert.equal(mapping.parts.length, 1);
  assert.throws(() => exportRobloxGLB(rig({ rootAt: [0, 0, 1] }), { skins: true }), {
    name: 'TypeError',
    message: /must rest at the origin/,
  });
  assert.throws(() => exportRobloxGLB(rig({ weightRoot: true }), { skins: true }), {
    name: 'TypeError',
    message: /no root influence/,
  });
});

test('units: meters and front: +z wrap the roots in one stud root, leaving skinned meshes as roots', () => {
  const scene = rig();
  scene.nodes.push({ name: 'Roblox_Studs', geometry: triangle() });
  const { glb } = exportRobloxGLB(scene, {
      skins: true,
      units: 'meters',
      front: '+z',
      rootExtras: { units: 'meters' },
    }),
    { json } = readGLB(glb),
    roots = json.scenes[0].nodes.map((i) => json.nodes[i]);
  assert.deepEqual(
    roots.map((n) => n.name),
    ['Roblox_Studs_2', 'Body'],
  );
  assert.deepEqual(roots[0].rotation, [0, 1, 0, 0]);
  assert.ok(roots[0].scale.every((s) => Math.abs(s - 25 / 7) < 1e-6));
  assert.deepEqual(roots[0].extras, { units: 'meters' });
  assert.deepEqual(
    roots[0].children.map((i) => json.nodes[i].name),
    ['Root', 'Roblox_Studs'],
  );
  assert.throws(() => exportRobloxGLB(rig(), { units: 'feet' }), TypeError);
  assert.throws(() => exportRobloxGLB(rig(), { front: 'x' }), TypeError);
});
