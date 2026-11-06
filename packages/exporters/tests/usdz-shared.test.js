// exportUSDZ writes a geometry drawn by several nodes once, and both USD readers compose it back to the same world.
import test from 'node:test';
import assert from 'node:assert/strict';
import { exportUSDZ } from '../dist/usdz.js';
import { parseUSDA, parseUSDZ, readZipDirectory, readZipEntry } from '@margoengine/loaders';
import { parseUSDA as readUSDA, parseUSDZ as readUSD } from '@margoengine/usdz';

// A unit quad in the XY plane with glTF uvs (v down), and a triangle no other node shares.
const quad = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0.25, 0]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
};
const triangle = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]),
};
const usda = async (archive) => new TextDecoder().decode(await readZipEntry(archive, readZipDirectory(archive)[0]));
const count = (text, pattern) => (text.match(pattern) ?? []).length;
const turn = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** Vertex positions and unit normals of a loaded mesh, sorted, rounded so the two layouts compare. */
const points = ({ positions, normals }) => {
  const out = [];
  for (let i = 0; i < positions.length; i += 3)
    out.push([...positions.subarray(i, i + 3), ...normals.subarray(i, i + 3)].map((v) => v.toFixed(4)).join(' '));
  return out.sort();
};

test('a geometry of several nodes is written once and every node keeps its own transform and material', async () => {
  const red = { color: [1, 0, 0, 1] },
    blue = { color: [0, 0, 1, 1] },
    archive = exportUSDZ({
      nodes: [
        { name: 'a', translation: [5, 0, 0], geometry: quad, material: red },
        { name: 'b', translation: [0, 2, 0], rotation: turn, scale: [2, 3, 1], geometry: quad, material: blue },
        { name: 'c', translation: [0, 0, -4], geometry: quad, material: red },
      ],
    }),
    text = await usda(archive);
  assert.equal(count(text, /class Mesh "/g), 1);
  assert.equal(count(text, /point3f\[\] points/g), 1);
  assert.equal(count(text, /references = <\/Margo\/Shape_0>/g), 3);
  assert.equal(count(text, /def Material /g), 2, 'a shared material is written once');
  assert.match(text, /string displayName = "b"/);
  const parsed = await parseUSDZ(archive);
  assert.equal(parsed.groups.length, 3);
  assert.equal(parsed.positions.length, 3 * 12);
  assert.equal(parsed.indices.length, 3 * 6);
  const asset = await readUSD(archive);
  assert.equal(asset.meshes.length, 3);
});

test('shared and separate meshes load the same world geometry', async () => {
  const nodes = (make) =>
      [
        { translation: [5, 0, 0] },
        { translation: [0, 2, 0], rotation: turn, scale: [2, 3, 0.5] },
        { translation: [-1, 0, 7], scale: [0.25, 0.25, 0.25] },
      ].map((node) => ({ ...node, geometry: make() })),
    copy = () => ({
      positions: quad.positions.slice(),
      normals: quad.normals.slice(),
      uvs: quad.uvs.slice(),
      indices: quad.indices.slice(),
    }),
    shared = exportUSDZ({ nodes: nodes(() => quad) }),
    separate = exportUSDZ({ nodes: nodes(copy) });
  assert.equal(count(await usda(separate), /class Mesh/g), 0);
  assert.equal(count(await usda(shared), /class Mesh/g), 1);
  assert.ok(shared.length < separate.length);
  assert.deepEqual(points(await parseUSDZ(shared)), points(await parseUSDZ(separate)));
  const streams = async (archive) => (await readUSD(archive)).meshes.flatMap((m) => [...m.indices]);
  assert.deepEqual(await streams(shared), await streams(separate));
});

test('a mesh used once and a mirrored node keep their world-space mesh', async () => {
  const single = await usda(exportUSDZ({ nodes: [{ translation: [1, 0, 0], geometry: quad }] }));
  assert.doesNotMatch(single, /class|references|xformOp/);
  const mirrored = {
      nodes: [
        { translation: [1, 0, 0], geometry: quad },
        { translation: [2, 0, 0], geometry: quad },
        { translation: [3, 0, 0], scale: [-1, 1, 1], geometry: quad },
      ],
    },
    archive = exportUSDZ(mirrored),
    text = await usda(archive);
  assert.equal(count(text, /references = /g), 2);
  assert.equal(count(text, /point3f\[\] points/g), 2, 'the shape and the mirrored mesh');
  assert.match(text, /int\[\] faceVertexIndices = \[0, 2, 1, 0, 3, 2\]/, 'the mirrored winding is reversed in the file');
  const parsed = await parseUSDZ(archive);
  assert.equal(parsed.positions.length, 3 * 12);
  // One user left after the mirrored ones are set aside is no share at all.
  const two = await usda(
    exportUSDZ({ nodes: [{ geometry: quad }, { scale: [-1, 1, 1], geometry: quad }, { geometry: triangle }] }),
  );
  assert.doesNotMatch(two, /class|references/);
});

test('the shape holds the UV sets its users read, and textures stay per material', async () => {
  const texture = { image: png, mimeType: 'image/png', name: 'tile' },
    text = await usda(
      exportUSDZ({
        nodes: [
          { geometry: quad, material: { color: [1, 1, 1, 1] } },
          { translation: [2, 0, 0], geometry: quad, material: { color: [1, 1, 1, 1], baseColorTexture: texture } },
        ],
      }),
    );
  assert.equal(count(text, /primvars:st = /g), 1);
  assert.ok(text.indexOf('primvars:st = ') < text.indexOf('def Mesh'), 'in the class prim, not in a node');
  assert.equal(count(text, /def Shader "BaseColorTexture"/g), 1);
});

test('vertex colors stay on each node of a shared geometry', async () => {
  const painted = { ...triangle, colors: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), colorSize: 3 },
    archive = exportUSDZ({
      nodes: [
        { geometry: painted, material: { color: [1, 1, 1, 1] } },
        { translation: [2, 0, 0], geometry: painted, material: { color: [0.5, 0.5, 0.5, 1] } },
      ],
    }),
    text = await usda(archive);
  assert.equal(count(text, /primvars:displayColor = \[.*interpolation = "vertex"/g), 2);
  assert.equal(count(text, /inputs:diffuseColor.connect/g), 2);
  assert.equal((await readUSD(archive)).meshes.length, 2);
});

test('the Float32 world check holds for a shared geometry', () => {
  assert.throws(
    () => exportUSDZ({ nodes: [{ geometry: quad }, { translation: [1e39, 0, 0], geometry: quad }] }),
    /exceeds Float32 range/,
  );
});

// The readers: a reference brings the target's properties under the prim, and everything else stays refused.
const shape = `class Mesh "Shape" {
  point3f[] points = [(0,0,0),(1,0,0),(0,1,0)]
  int[] faceVertexCounts = [3]
  int[] faceVertexIndices = [0,1,2]
  uniform token subdivisionScheme = "none"
}`;
const stage = (body) => `#usda 1.0\n(\n metersPerUnit = 1\n upAxis = "Y"\n)\n${body}\n`;
const node = (reference, more = '') => `def Mesh "A" (\n references = ${reference}\n) {\n ${more}\n}`;

test('the readers compose an internal reference, and what the prim authors wins', () => {
  const moved = 'double3 xformOp:translate = (1, 0, 0)\n uniform token[] xformOpOrder = ["xformOp:translate"]';
  for (const read of [parseUSDA, readUSDA]) read(stage(`${shape}\n${node('</Shape>', moved)}`));
  const parsed = parseUSDA(stage(`${shape}\n${node('</Shape>', moved)}`));
  assert.deepEqual([...parsed.positions.subarray(0, 3)], [1, 0, 0]);
  const own = parseUSDA(stage(`${shape}\n${node('</Shape>', 'point3f[] points = [(0,0,2),(1,0,2),(0,1,2)]')}`));
  assert.equal(own.positions[2], 2);
  assert.throws(() => parseUSDA(stage(shape)), /mesh|renderable|empty|no /i, 'a class alone draws nothing');
});

test('the readers refuse a missing target, other files and nested references', () => {
  for (const read of [parseUSDA, readUSDA]) {
    assert.throws(() => read(stage(node('</Missing>'))), /not found/);
    assert.throws(() => read(stage(node('@other.usda@</Shape>'))), /composition/);
    assert.throws(() => read(stage(`${shape}\n${node('[</Shape>]')}`)), /composition/);
    const nested = `class Mesh "Middle" (\n references = </Shape>\n) {\n}`;
    assert.throws(() => read(stage(`${shape}\n${nested}\n${node('</Middle>')}`)), /composition/);
    const parent = `class Xform "Group" {\n def Mesh "Child" {\n }\n}`;
    assert.throws(() => read(stage(`${parent}\n${node('</Group>')}`)), /composition/);
  }
});

test('a reference counts toward the vertex budget', () => {
  const copies = [1, 2, 3].map((i) => node('</Shape>').replace('"A"', `"A${i}"`)).join('\n');
  assert.throws(() => parseUSDA(stage(`${shape}\n${copies}`), { maxVertices: 8 }), /vertex limit/);
});
