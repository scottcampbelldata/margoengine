// Engine-based exporters use the shared optional PBR source protocol, independently of exportModel().
import test from 'node:test';
import assert from 'node:assert/strict';
import { Material, createMesh } from '@margoengine/materials';
import { parseGLTF } from '@margoengine/gltf-pro';
import { readZipDirectory, readZipEntry } from '@margoengine/loaders';
import { exportModel } from '../dist/model.js';
import { exportGLTF, exportGLB, exportUSDZ, exportOBJ, exportPLY, exportSTL } from '../dist/index.js';
import { headless, headlessModels } from '../../../tests/support/pbr-snapshot.js';
import { accessor, readGLB, parseOBJ, parsePLY, parseASCIISTL } from './helpers.js';

const quad = {
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  tangents: [1, 0, 0, 1, 1, 0, 0, -1, 1, 0, 0, 1, 1, 0, 0, -1],
  uvs: [0, 0, 1, 0, 1, 1, 0, 1],
  indices: [0, 1, 2, 0, 2, 3],
};
const negative = (v) => (v ? -v : 0);
const reversed = [0, 2, 1, 0, 3, 2];
const attribute = (result, p, name) => [...accessor(result.json, result.bin, p.attributes[name])];
const first = (result) => result.json.meshes[0].primitives[0];
const load = async (fixture, engine) =>
  parseGLTF(engine ?? (await headless()), fixture.json, [
    fixture.bin.buffer.slice(fixture.bin.byteOffset, fixture.bin.byteOffset + fixture.bin.byteLength),
  ]);

for (const loaded of [false, true])
  test(`engine glTF/GLB export follows live ${loaded ? 'loaded' : 'constructed'} PBR sides`, () =>
    headlessModels(async () => {
      const engine = await headless(),
        source = loaded
          ? await load(await exportModel(createMesh(await headless(), quad, new Material()), { embed: false }), engine)
          : createMesh(engine, quad, new Material()),
        p = source.primitives[0],
        beforeVertices = p.vertices.slice(),
        beforeIndices = p.indices.slice();
      for (const side of ['back', 'front', 'double']) {
        p.material.side = side;
        for (const result of [exportGLTF(engine, { embed: false }), readGLB(exportGLB(engine))]) {
          const out = first(result);
          assert.deepEqual(
            [...accessor(result.json, result.bin, out.indices)],
            side === 'back' ? reversed : quad.indices,
          );
          assert.deepEqual(
            attribute(result, out, 'NORMAL'),
            side === 'back' ? quad.normals.map(negative) : quad.normals,
          );
          assert.equal(result.json.materials[out.material].doubleSided, side === 'double' ? true : undefined);
          assert.deepEqual(attribute(result, out, 'POSITION'), quad.positions);
          if (loaded) assert.deepEqual(attribute(result, out, 'TANGENT'), quad.tangents);
        }
      }
      p.material = { ...p.material, side: undefined, settings: p.material.settings.slice() };
      p.material.settings[2] = 2;
      const fallback = exportGLTF(engine, { embed: false });
      assert.deepEqual([...accessor(fallback.json, fallback.bin, first(fallback).indices)], reversed);
      assert.equal(fallback.json.materials[0].doubleSided, undefined);
      assert.deepEqual(p.vertices, beforeVertices);
      assert.deepEqual(p.indices, beforeIndices);
    }));

test('engine scene extraction keeps front/back group geometry separate', () =>
  headlessModels(async () => {
    const engine = await headless(),
      source = createMesh(
        engine,
        {
          ...quad,
          groups: [
            { start: 0, count: 3, materialIndex: 0 },
            { start: 3, count: 3, materialIndex: 1 },
          ],
        },
        [new Material(), new Material({ side: 'back' })],
      ),
      result = exportGLTF(engine, { embed: false }),
      [front, back] = result.json.meshes[0].primitives;
    assert.deepEqual([...accessor(result.json, result.bin, front.indices)], [0, 1, 2]);
    assert.deepEqual([...accessor(result.json, result.bin, back.indices)], [0, 3, 2]);
    assert.deepEqual(attribute(result, front, 'NORMAL'), quad.normals);
    assert.deepEqual(attribute(result, back, 'NORMAL'), quad.normals.map(negative));
    assert.deepEqual([...source.primitives[1].indices], [0, 2, 3]);
  }));

test('world-space engine exports combine back-side winding with mirrored transforms', () =>
  headlessModels(async () => {
    const engine = await headless(),
      source = createMesh(engine, quad, new Material({ side: 'back' }));
    source.nodes[0].setScale([-1, 1, 1]);
    const archive = exportUSDZ(engine),
      entry = readZipDirectory(archive)[0],
      usda = new TextDecoder().decode(await readZipEntry(archive, entry));
    assert.match(usda, /faceVertexIndices = \[0, 1, 2, 0, 2, 3\]/);
    assert.match(usda, /normals = \[\(0, 0, -1\), \(0, 0, -1\), \(0, 0, -1\), \(0, 0, -1\)\]/);
    assert.match(usda, /doubleSided = false/);
    const obj = parseOBJ(exportOBJ(engine).obj);
    assert.deepEqual(
      obj.vn,
      Array.from({ length: 4 }, () => [0, 0, -1]),
    );
    assert.deepEqual(
      obj.groups[0].faces.map((f) => f.map((v) => v.v)),
      [
        [1, 2, 3],
        [1, 3, 4],
      ],
    );
    const ply = parsePLY(exportPLY(engine));
    assert.deepEqual(
      ply.elements.face.map((f) => f.vertex_indices),
      [
        [0, 1, 2],
        [0, 2, 3],
      ],
    );
    assert.ok(ply.elements.vertex.every((v) => v.nx === 0 && v.ny === 0 && v.nz === -1));
    const stl = parseASCIISTL(exportSTL(engine, { binary: false }));
    assert.deepEqual(
      stl.map((f) => f.normal.map((v) => v || 0)),
      [
        [0, 0, -1],
        [0, 0, -1],
      ],
    );
  }));

test('engine glTF extraction flips loaded morph normal deltas while retaining skins and tangent data', () =>
  headlessModels(async () => {
    const joint = { name: 'joint' },
      identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      deltas = quad.normals.map((v) => v * 0.25),
      fixture = exportGLTF(
        {
          nodes: [
            {
              geometry: {
                ...quad,
                joints: Array(16).fill(0),
                weights: Array.from({ length: 16 }, (_, i) => +(i % 4 === 0)),
                morphs: [{ positions: deltas, normals: deltas, tangents: deltas }],
              },
              skin: { joints: [joint], inverseBindMatrices: identity },
              morphWeights: [0.5],
            },
            joint,
          ],
        },
        { embed: false },
      ),
      source = await load(fixture),
      p = source.primitives[0],
      before = source.asset.accessor(p.definition.targets[0].NORMAL).slice();
    p.material.side = 'back';
    const result = exportGLTF(source.root.engine, { embed: false }),
      out = first(result),
      target = out.targets[0];
    assert.deepEqual([...accessor(result.json, result.bin, target.NORMAL)], deltas.map(negative));
    assert.deepEqual([...accessor(result.json, result.bin, target.POSITION)], deltas);
    assert.deepEqual([...accessor(result.json, result.bin, target.TANGENT)], deltas);
    assert.deepEqual(attribute(result, out, 'TANGENT'), quad.tangents);
    assert.deepEqual(attribute(result, out, 'JOINTS_0'), Array(16).fill(0));
    assert.deepEqual([...accessor(result.json, result.bin, result.json.skins[0].inverseBindMatrices)], identity);
    assert.deepEqual(source.asset.accessor(p.definition.targets[0].NORMAL), before);
  }));
