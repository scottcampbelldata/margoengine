// Seam-splitting tangents against MikkTSpace itself. tests/fixtures/mikktspace-mirror.json is a mesh written for this
// test and run through Blender's Mesh.calc_tangents: a wavy sheet with UVs mirrored at x = 0, so the middle vertices
// share position, normal and UV but need two frames. skinning-ik-orb.glb holds tangents Blender exported to glTF.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { boxGeometry, computeTangents, sphereGeometry, torusGeometry } from '../dist/index.js';
import { splitTangents } from '../dist/utils.js';
import { close, vertexCount } from './support/mesh-checks.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/mikktspace-mirror.json', import.meta.url), 'utf8'));

function assertUnitFrames(data, label) {
  for (let v = 0; v < vertexCount(data); v++) {
    const [x, y, z, w] = data.tangents.subarray(v * 4, v * 4 + 4);
    close(Math.hypot(x, y, z), 1, 1e-5, `${label} unit`);
    close(
      x * data.normals[v * 3] + y * data.normals[v * 3 + 1] + z * data.normals[v * 3 + 2],
      0,
      1e-5,
      `${label} on plane`,
    );
    assert.ok(w === 1 || w === -1, `${label} sign`);
  }
}

test('a mirrored sheet matches MikkTSpace at every triangle corner, splitting the mirror line', () => {
  const mesh = {
      positions: Float32Array.from(fixture.positions),
      normals: Float32Array.from(fixture.normals),
      uvs: Float32Array.from(fixture.uvs),
      indices: Uint32Array.from(fixture.indices),
    },
    { data, source } = splitTangents(mesh);
  // Six vertices stand on the mirror line, and each gains exactly one twin.
  assert.equal(source.length, vertexCount(mesh) + 6);
  for (let c = 0; c < mesh.indices.length; c++) {
    const v = data.indices[c],
      want = fixture.cornerTangents.slice(c * 4, c * 4 + 4),
      along = want[0] * data.tangents[v * 4] + want[1] * data.tangents[v * 4 + 1] + want[2] * data.tangents[v * 4 + 2];
    assert.ok(along > 0.9999, `corner ${c} against Blender: ${along}`);
    assert.equal(data.tangents[v * 4 + 3], want[3], `corner ${c} sign`);
  }
  assertUnitFrames(data, 'sheet');
});

/** The first primitive of a binary glTF, as plain arrays. */
function readGlb(url) {
  const file = readFileSync(url),
    size = file.readUInt32LE(12),
    json = JSON.parse(file.subarray(20, 20 + size).toString()),
    chunk = file.subarray(20 + size + 8),
    widths = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 },
    read = (i) => {
      const a = json.accessors[i],
        view = json.bufferViews[a.bufferView],
        at = (view.byteOffset ?? 0) + (a.byteOffset ?? 0),
        count = a.count * widths[a.type],
        bytes = chunk.subarray(at, at + count * (a.componentType === 5126 || a.componentType === 5125 ? 4 : 2)),
        copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
      assert.equal(view.byteStride ?? 0, 0, 'tightly packed');
      return a.componentType === 5126
        ? new Float32Array(copy)
        : a.componentType === 5125
          ? new Uint32Array(copy)
          : new Uint16Array(copy);
    },
    primitive = json.meshes[0].primitives[0];
  return {
    positions: read(primitive.attributes.POSITION),
    normals: read(primitive.attributes.NORMAL),
    uvs: read(primitive.attributes.TEXCOORD_0),
    tangents: read(primitive.attributes.TANGENT),
    indices: Uint32Array.from(read(primitive.indices)),
  };
}

test('tangents Blender exported to glTF come back, with v turned the way glTF stores it', () => {
  const { tangents: want, ...mesh } = readGlb(new URL('../../../examples/assets/skinning-ik-orb.glb', import.meta.url));
  // glTF UVs run v down; tangents here follow v up, like the primitives.
  mesh.uvs = mesh.uvs.map((value, i) => (i & 1 ? 1 - value : value));
  const { data } = splitTangents(mesh);
  for (let c = 0; c < mesh.indices.length; c++) {
    const from = mesh.indices[c] * 4,
      to = data.indices[c] * 4,
      along =
        want[from] * data.tangents[to] +
        want[from + 1] * data.tangents[to + 1] +
        want[from + 2] * data.tangents[to + 2];
    assert.ok(along > 0.9995, `corner ${c}: ${along}`);
    assert.equal(data.tangents[to + 3], want[from + 3]);
  }
});

test('two triangles touching at one vertex are separate fans', () => {
  const mesh = {
      // Both meet at vertex 0; the second one's texture runs the other way.
      positions: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0, -1, 0, 0, 0, -1, 0),
      normals: Float32Array.from({ length: 15 }, (_, i) => (i % 3 === 2 ? 1 : 0)),
      uvs: Float32Array.of(0, 0, 1, 0, 0, 1, 1, 0, 0, 1),
      indices: Uint32Array.of(0, 1, 2, 0, 3, 4),
    },
    { data, source } = splitTangents(mesh);
  assert.equal(source.length, 6);
  assert.equal(source[5], 0);
  assert.deepEqual([...data.indices], [0, 1, 2, 5, 3, 4]);
  close(data.tangents[0], 1, 1e-6, 'first fan runs +x');
  close(data.tangents[5 * 4], -1, 1e-6, 'second fan runs -x');
});

test('a mesh with nothing to split keeps its vertices and agrees with computeTangents', () => {
  for (const [name, mesh] of [
    ['sphere', sphereGeometry(1, 24, 12)],
    ['torus', torusGeometry(1, 0.3, 16, 32)],
    ['box', boxGeometry(1, 2, 3, 2, 2, 2)],
  ]) {
    const plain = computeTangents(mesh),
      { data, source } = splitTangents(mesh);
    assertUnitFrames(data, name);
    // Sphere poles hold one vertex per wedge already, so no vertex here has two frames.
    assert.equal(source.length, vertexCount(mesh), name);
    for (let v = 0; v < vertexCount(mesh); v++) {
      const along =
        data.tangents[v * 4] * plain.tangents[v * 4] +
        data.tangents[v * 4 + 1] * plain.tangents[v * 4 + 1] +
        data.tangents[v * 4 + 2] * plain.tangents[v * 4 + 2];
      assert.ok(along > 0.999, `${name} vertex ${v}: ${along}`);
      assert.equal(data.tangents[v * 4 + 3], plain.tangents[v * 4 + 3]);
    }
  }
});

test('the split option of computeTangents gives the same mesh; other attributes follow source', () => {
  const mesh = {
      positions: Float32Array.from(fixture.positions),
      normals: Float32Array.from(fixture.normals),
      uvs: Float32Array.from(fixture.uvs),
      indices: Uint32Array.from(fixture.indices),
      groups: [{ start: 0, count: 6, materialIndex: 2 }],
    },
    frozen = mesh.indices.slice(),
    split = computeTangents(mesh, { split: true }),
    { data, source } = splitTangents(mesh);
  assert.deepEqual(split.tangents, data.tangents);
  assert.deepEqual(split.groups, mesh.groups);
  assert.notEqual(split.groups[0], mesh.groups[0]);
  assert.deepEqual(mesh.indices, frozen);
  // Triangles keep their order and winding: each corner is still the same point.
  for (let c = 0; c < frozen.length; c++) assert.equal(source[data.indices[c]], frozen[c]);
  for (let v = 0; v < source.length; v++)
    for (let k = 0; k < 3; k++) assert.equal(data.positions[v * 3 + k], mesh.positions[source[v] * 3 + k]);
  assert.equal(computeTangents(mesh).positions.length, mesh.positions.length, 'no split unless asked');
});

test('triangles with no UV area and unused vertices still get a frame', () => {
  const { data } = splitTangents({
    positions: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 5, 5, 5),
    normals: Float32Array.from({ length: 15 }, (_, i) => (i % 3 === 2 ? 1 : 0)),
    uvs: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 1, 0, 0),
    indices: Uint32Array.of(0, 1, 2, 1, 3, 2),
  });
  assertUnitFrames(data, 'degenerate');
  assert.equal(data.tangents[3], 1);
});

test('invalid input is refused with the fix in the message', () => {
  const box = boxGeometry();
  assert.throws(() => splitTangents({ ...box, uvs: new Float32Array(2) }), /matching attribute/);
  assert.throws(() => splitTangents({ ...box, normals: new Float32Array(3) }), /matching attribute/);
  assert.throws(() => splitTangents({ ...box, indices: Uint32Array.of(0, 1) }), /whole triangles/);
  assert.throws(() => splitTangents({ ...box, indices: Uint32Array.of(0, 1, 9999) }), /fix the indices/);
});
