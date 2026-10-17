// Back-only triangles are baked into ordinary glTF geometry: no renderer-specific side flag survives export.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Material, createMesh, createInstancedMesh } from '@margoengine/materials';
import { parseGLTF } from '@margoengine/gltf-pro';
import { instancing } from '@margoengine/gltf-pro/instancing';
import { exportModel } from '../dist/model.js';
import { exportGLTF } from '../dist/index.js';
import { headless, headlessModels } from '../../../tests/support/pbr-snapshot.js';
import { accessor, readGLB, validate, validator } from './helpers.js';

const quad = {
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  tangents: [1, 0, 0, 1, 1, 0, 0, -1, 1, 0, 0, 1, 1, 0, 0, -1],
  uvs: [0, 0, 1, 0, 1, 1, 0, 1],
  indices: [0, 1, 2, 0, 2, 3],
};
const flippedNormals = quad.normals.map((v) => (v ? -v : 0));
const reversed = [0, 2, 1, 0, 3, 2];
const values = (result, primitive, name) => [...accessor(result.json, result.bin, primitive.attributes[name])];
const primitive = (result, i = 0) => result.json.meshes[0].primitives[i];
const exported = (source) => exportModel(source, { embed: false });
const load = async (result, decoders = {}) =>
  parseGLTF(
    await headless(),
    result.json,
    [result.bin.buffer.slice(result.bin.byteOffset, result.bin.byteOffset + result.bin.byteLength)],
    [],
    decoders,
  );
const back = (model) => {
  // The prepared flag isolates the exporter contract from public API implementation.
  for (const p of model.primitives) p.material.settings[2] = 2;
  return model;
};

test('exportModel bakes packed back-only triangle winding and normals without changing tangent handedness or inputs', () =>
  headlessModels(async () => {
    const source = back(createMesh(await headless(), quad, new Material())),
      p = source.primitives[0],
      beforeVertices = p.vertices.slice(),
      beforeIndices = p.indices.slice(),
      result = await exported(source),
      out = primitive(result);
    assert.deepEqual([...accessor(result.json, result.bin, out.indices)], reversed);
    assert.deepEqual(values(result, out, 'NORMAL'), flippedNormals);
    assert.deepEqual(values(result, out, 'TANGENT'), quad.tangents);
    assert.deepEqual(values(result, out, 'POSITION'), quad.positions);
    assert.deepEqual(values(result, out, 'TEXCOORD_0'), quad.uvs);
    assert.equal(result.json.materials[0].doubleSided, undefined);
    assert.deepEqual(p.vertices, beforeVertices);
    assert.deepEqual(p.indices, beforeIndices);
    const copy = await load(result);
    assert.deepEqual([...copy.primitives[0].indices], reversed);
    assert.equal(copy.primitives[0].material.settings[2], 0, 'ordinary front-only glTF material');
    if (validator) {
      const report = await validate(result.text, { 'scene.bin': result.bin });
      assert.equal(report.errors, 0, JSON.stringify(report.messages));
    }
  }));

test('exportModel keeps shared loaded front/back accessors distinct, including morph normals and unchanged tangent deltas', () =>
  headlessModels(async () => {
    const fixture = await exported(createMesh(await headless(), quad, new Material())),
      def = primitive(fixture);
    def.targets = [{ NORMAL: def.attributes.NORMAL, TANGENT: def.attributes.NORMAL, POSITION: def.attributes.NORMAL }];
    fixture.json.meshes[0].weights = [0.25];
    fixture.json.materials.push({ doubleSided: true });
    fixture.json.meshes[0].primitives.push({ ...def, material: 1 });
    const source = await load(fixture),
      p = source.primitives[1],
      sourceNormal = source.asset.accessor(def.attributes.NORMAL).slice(),
      sourceIndices = p.indices.slice();
    p.material.settings[2] = 2;
    const result = await exported(source),
      front = primitive(result),
      rear = primitive(result, 1);
    assert.deepEqual([...accessor(result.json, result.bin, front.indices)], quad.indices);
    assert.deepEqual([...accessor(result.json, result.bin, rear.indices)], reversed);
    assert.deepEqual(values(result, front, 'NORMAL'), quad.normals);
    assert.deepEqual(values(result, rear, 'NORMAL'), flippedNormals);
    assert.notEqual(front.indices, rear.indices);
    assert.notEqual(front.attributes.NORMAL, rear.attributes.NORMAL);
    assert.equal(front.attributes.POSITION, rear.attributes.POSITION, 'unchanged source accessors remain shared');
    assert.equal(front.attributes.TANGENT, rear.attributes.TANGENT);
    assert.deepEqual([...accessor(result.json, result.bin, rear.targets[0].NORMAL)], flippedNormals);
    assert.deepEqual([...accessor(result.json, result.bin, rear.targets[0].TANGENT)], quad.normals);
    assert.deepEqual([...accessor(result.json, result.bin, rear.targets[0].POSITION)], quad.normals);
    assert.deepEqual(source.asset.accessor(def.attributes.NORMAL), sourceNormal);
    assert.deepEqual(p.indices, sourceIndices);
    assert.deepEqual(result.json.nodes[0].weights, [0.25]);
  }));

test('exportModel writes reversed indices for nonindexed loaded back faces and supplies missing generated normals', () =>
  headlessModels(async () => {
    const fixture = await exported(
        createMesh(
          await headless(),
          {
            positions: quad.positions.slice(0, 9),
            normals: quad.normals.slice(0, 9),
            indices: [0, 1, 2],
          },
          new Material(),
        ),
      ),
      def = primitive(fixture);
    delete def.indices;
    delete def.attributes.NORMAL;
    const source = back(await load(fixture)),
      result = await exported(source),
      out = primitive(result);
    assert.deepEqual([...accessor(result.json, result.bin, out.indices)], [0, 2, 1]);
    assert.deepEqual(values(result, out, 'NORMAL'), flippedNormals.slice(0, 9));
  }));

test('exportModel reads live side fields and leaves front/double geometry on their existing path', () =>
  headlessModels(async () => {
    const source = createMesh(await headless(), quad, new Material()),
      p = source.primitives[0];
    p.material.side = 'back';
    let result = await exported(source);
    assert.deepEqual([...accessor(result.json, result.bin, primitive(result).indices)], reversed);
    p.material.side = 'front';
    result = await exported(source);
    assert.deepEqual([...accessor(result.json, result.bin, primitive(result).indices)], quad.indices);
    assert.deepEqual(values(result, primitive(result), 'NORMAL'), quad.normals);
    assert.equal(result.json.materials[0].doubleSided, undefined);
    p.material.side = 'double';
    result = await exported(source);
    assert.deepEqual([...accessor(result.json, result.bin, primitive(result).indices)], quad.indices);
    assert.deepEqual(values(result, primitive(result), 'NORMAL'), quad.normals);
    assert.equal(result.json.materials[0].doubleSided, true);
  }));

test('exportModel bakes only back groups while preserving mirrored node and instance transforms', () =>
  headlessModels(async () => {
    const materials = [new Material(), new Material()],
      source = createInstancedMesh(
        await headless(),
        {
          ...quad,
          groups: [
            { start: 0, count: 3, materialIndex: 0 },
            { start: 3, count: 3, materialIndex: 1 },
          ],
        },
        materials,
        2,
      );
    source.primitives[1].material.settings[2] = 2;
    source.nodes[0].setScale([-1, 1, 1]);
    source.instances.setMatrixAt(1, [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 0, 1]);
    const bytes = await exportModel(source, { binary: true }),
      result = readGLB(bytes),
      first = primitive(result),
      second = primitive(result, 1);
    assert.deepEqual([...accessor(result.json, result.bin, first.indices)], [0, 1, 2]);
    assert.deepEqual([...accessor(result.json, result.bin, second.indices)], [0, 3, 2]);
    assert.deepEqual(values(result, first, 'NORMAL'), quad.normals);
    assert.deepEqual(values(result, second, 'NORMAL'), flippedNormals);
    assert.deepEqual(result.json.nodes[0].scale, [-1, 1, 1]);
    const copy = await load(result, { instancing });
    assert.deepEqual(
      [...copy.primitives[1].instances.getMatrixAt(1)].map((v) => v || 0),
      [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 0, 1],
    );
  }));

test('exportModel ignores back-side geometry baking for synthetic point and line primitives', () =>
  headlessModels(async () => {
    for (const [topology, indices] of [
      ['point-list', [0, 1, 2]],
      ['line-list', [0, 1, 1, 2]],
    ]) {
      const source = back(createMesh(await headless(), quad, new Material())),
        p = source.primitives[0];
      p.topology = topology;
      p.indices = Uint32Array.from(indices);
      const result = await exported(source),
        out = primitive(result);
      assert.deepEqual([...accessor(result.json, result.bin, out.indices)], indices);
      assert.deepEqual(values(result, out, 'NORMAL'), quad.normals);
      assert.deepEqual(values(result, out, 'TANGENT'), quad.tangents);
    }
  }));

test('exportModel retains a loaded back material skin and morph deformation while flipping only normal data', () =>
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
                morphs: [{ name: 'shape', positions: deltas, normals: deltas, tangents: deltas }],
              },
              skin: { joints: [joint], inverseBindMatrices: identity },
              morphWeights: [0.5],
            },
            joint,
          ],
        },
        { embed: false },
      ),
      source = back(await load(fixture)),
      p = source.primitives[0],
      inputNormalDeltas = source.asset.accessor(p.definition.targets[0].NORMAL).slice(),
      result = await exported(source),
      out = primitive(result),
      target = out.targets[0],
      copy = await load(result);
    assert.deepEqual(
      [...accessor(result.json, result.bin, target.NORMAL)],
      deltas.map((v) => (v ? -v : 0)),
    );
    assert.deepEqual([...accessor(result.json, result.bin, target.POSITION)], deltas);
    assert.deepEqual([...accessor(result.json, result.bin, target.TANGENT)], deltas);
    assert.deepEqual([...copy.asset.accessor(out.attributes.JOINTS_0)], Array(16).fill(0));
    assert.deepEqual(
      values(result, out, 'WEIGHTS_0'),
      Array.from({ length: 16 }, (_, i) => +(i % 4 === 0)),
    );
    assert.deepEqual(result.json.skins[0].joints, [1]);
    assert.deepEqual([...accessor(result.json, result.bin, result.json.skins[0].inverseBindMatrices)], identity);
    assert.deepEqual(result.json.nodes[0].weights, [0.5]);
    assert.deepEqual(source.asset.accessor(p.definition.targets[0].NORMAL), inputNormalDeltas);
    assert.deepEqual([...copy.primitives[0].weights], [0.5]);
    assert.deepEqual(copy.asset.doc.skins[0].joints, [1]);
  }));

test('exportModel separates front/back mesh variants when two loaded nodes share the same mesh definition', () =>
  headlessModels(async () => {
    const fixture = await exported(createMesh(await headless(), quad, new Material()));
    fixture.json.nodes.push({ mesh: 0, translation: [2, 0, 0] });
    fixture.json.scenes[0].nodes.push(1);
    const source = await load(fixture);
    source.primitives[1].material = { ...source.primitives[1].material, side: 'back' };
    const result = await exported(source),
      front = result.json.meshes[result.json.nodes[0].mesh].primitives[0],
      rear = result.json.meshes[result.json.nodes[1].mesh].primitives[0];
    assert.notEqual(result.json.nodes[0].mesh, result.json.nodes[1].mesh);
    assert.deepEqual([...accessor(result.json, result.bin, front.indices)], quad.indices);
    assert.deepEqual([...accessor(result.json, result.bin, rear.indices)], reversed);
    assert.deepEqual(values(result, front, 'NORMAL'), quad.normals);
    assert.deepEqual(values(result, rear, 'NORMAL'), flippedNormals);
    assert.deepEqual(result.json.nodes[1].translation, [2, 0, 0]);
  }));
