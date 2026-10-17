// Packed material meshes keep independent UVs and per-group material ownership when saved as glTF/GLB.
import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { Material, Texture, createMesh, createInstancedMesh } from '@margoengine/materials';
import { parseGLTF, parseGLTFAsync } from '@margoengine/gltf-pro';
import { instancing } from '@margoengine/gltf-pro/instancing';
import { exportModel } from '../dist/model.js';
import { headless, headlessModels } from '../../../tests/support/pbr-snapshot.js';
import { accessor, readGLB, validate, validator } from './helpers.js';

const quad = {
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  uvs: [0, 0, 1, 0, 1, 1, 0, 1],
  indices: [0, 1, 2, 0, 2, 3],
};
const uv1 = [0.25, 0.5, 0.5, 0.5, 0.5, 0.75, 0.25, 0.75];
const pixel = (rgba) => new Texture({ width: 1, height: 1, data: Uint8Array.from(rgba) });
const packedUV = (p, set) =>
  Array.from({ length: p.vertices.length / 10 }, (_, i) => p.vertices[(i >> 1) * 20 + 12 + set * 2 + (i & 1)]);
// Synthetic prepared primitives isolate the exporter contract from createMesh's group construction.
function withUV1(model, values) {
  model.primitives.forEach((p) => {
    for (let v = 0; v < values.length / 2; v++) p.vertices.set(values.slice(v * 2, v * 2 + 2), v * 20 + 14);
  });
  return model;
}
async function valid(bytes) {
  if (!validator) return;
  const report = await validate(bytes);
  assert.equal(report.errors, 0, JSON.stringify(report.messages));
}
function imagePixel(model, textureIndex) {
  const image = model.asset.doc.images[model.asset.doc.textures[textureIndex].source],
    png = model.asset.view(image.bufferView),
    view = new DataView(png.buffer, png.byteOffset),
    chunks = [];
  for (let at = 8; at < png.length; ) {
    const length = view.getUint32(at);
    if (new TextDecoder().decode(png.subarray(at + 4, at + 8)) === 'IDAT')
      chunks.push(png.subarray(at + 8, at + 8 + length));
    at += length + 12;
  }
  return [...inflateSync(Buffer.concat(chunks)).subarray(1, 5)];
}

test('exportModel writes distinct packed UV1 to GLB and preserves it on reimport', () =>
  headlessModels(async () => {
    const source = withUV1(createMesh(await headless(), quad, new Material()), uv1),
      bytes = await exportModel(source, { binary: true }),
      { json, bin } = readGLB(bytes),
      attributes = json.meshes[0].primitives[0].attributes;
    assert.notEqual(attributes.TEXCOORD_1, undefined, 'independent UV1 accessor');
    assert.deepEqual([...accessor(json, bin, attributes.TEXCOORD_1)], uv1);
    const copy = await parseGLTFAsync(await headless(), bytes);
    assert.deepEqual(packedUV(copy.primitives[0], 0), quad.uvs);
    assert.deepEqual(packedUV(copy.primitives[0], 1), uv1);
    await valid(bytes);
  }));

test('exportModel retains all-zero UV1 selected by a live material map and its affine transform', () =>
  headlessModels(async () => {
    const material = new Material({ aoMap: pixel([64, 64, 64, 255]) });
    material.setUVTransform({ texCoord: 1, offset: [0.25, 0.5], scale: [2, 0.5] }, 'aoMap');
    const source = withUV1(
        createMesh(await headless(), { ...quad, uvs: Array(8).fill(0) }, material),
        Array(8).fill(0),
      ),
      result = await exportModel(source, { embed: false }),
      p = result.json.meshes[0].primitives[0],
      map = result.json.materials[0].occlusionTexture;
    assert.equal(map.texCoord, 1, 'live UV row selects TEXCOORD_1');
    assert.deepEqual([...accessor(result.json, result.bin, p.attributes.TEXCOORD_1)], Array(8).fill(0));
    assert.deepEqual(map.extensions.KHR_texture_transform, { offset: [0.25, 0.5], scale: [2, 0.5] });
    const copy = parseGLTF(await headless(), result.json, [result.bin.buffer], [{ width: 1, height: 1 }]);
    assert.deepEqual(packedUV(copy.primitives[0], 1), Array(8).fill(0));
    assert.deepEqual(
      copy.primitives[0].material.uvt.slice(24, 32).map((v) => v || 0),
      [2, 0, 0.25, 1, 0, 0.5, 0.5, 0],
    );
    if (validator) {
      const report = await validate(result.text, { 'scene.bin': result.bin });
      assert.equal(report.errors, 0, JSON.stringify(report.messages));
    }
  }));

test('exportModel chooses each group texture owner by original material slot and deduplicates shared materials', () =>
  headlessModels(async () => {
    const engine = await headless(),
      red = new Material({ color: [1, 0, 0], map: pixel([255, 32, 0, 255]) }),
      blue = new Material({ shading: 'basic', color: [0, 0, 1], map: pixel([0, 64, 255, 255]) });
    blue.setUVTransform({ texCoord: 1 }, 'map');
    const a = withUV1(createMesh(engine, quad, red), uv1),
      b = withUV1(createMesh(engine, quad, blue), uv1),
      first = { ...b.primitives[0], nodeIndex: 0, definition: { material: 2 }, indices: new Uint32Array([0, 1, 2]) },
      second = { ...a.primitives[0], nodeIndex: 0, definition: { material: 0 }, indices: new Uint32Array([0, 2, 3]) };
    a.asset.doc.materials = [a.asset.doc.materials[0], {}, b.asset.doc.materials[0]];
    a.asset.doc.meshes[0].primitives = [first.definition, second.definition, first.definition];
    const source = {
        ...a,
        material: Object.freeze([red, new Material(), blue]),
        primitives: [first, second, { ...first }],
      },
      bytes = await exportModel(source, { binary: true }),
      { json } = readGLB(bytes);
    assert.equal(json.meshes.length, 1);
    assert.deepEqual(
      json.meshes[0].primitives.map((p) => p.material),
      [0, 1, 0],
    );
    assert.equal(json.materials.length, 2, 'shared source material written once');
    assert.equal(json.textures?.length, 2, 'each used group retains its own Texture');
    assert.deepEqual(
      json.materials.map((m) => m.pbrMetallicRoughness.baseColorFactor),
      [
        [0, 0, 1, 1],
        [1, 0, 0, 1],
      ],
    );
    assert.deepEqual(json.materials[0].extensions.KHR_materials_unlit, {});
    assert.equal(json.materials[0].pbrMetallicRoughness.baseColorTexture.texCoord, 1);
    const copy = await parseGLTFAsync(await headless(), bytes);
    assert.deepEqual(
      copy.primitives.map((p) => [...p.indices]),
      [
        [0, 1, 2],
        [0, 2, 3],
        [0, 1, 2],
      ],
    );
    const maps = copy.primitives.map((p) => p.material.maps[0].index);
    assert.deepEqual(imagePixel(copy, maps[0]), [0, 64, 255, 255]);
    assert.deepEqual(imagePixel(copy, maps[1]), [255, 32, 0, 255]);
    assert.deepEqual(packedUV(copy.primitives[0], 1), uv1);
    await valid(bytes);
  }));

test('exportModel preserves a loaded KHR texture coordinate override and exports subsequent live UV changes', () =>
  headlessModels(async () => {
    const material = new Material({ map: pixel([255, 255, 255, 255]) }),
      source = withUV1(createMesh(await headless(), quad, material), uv1),
      fixture = await exportModel(source, { embed: false });
    // Supply both indexed semantics without relying on the UV1 writer support under test.
    const attributes = fixture.json.meshes[0].primitives[0].attributes;
    attributes.TEXCOORD_1 = attributes.TEXCOORD_0;
    fixture.json.materials[0].pbrMetallicRoughness.baseColorTexture = {
      index: 0,
      texCoord: 0,
      extensions: { KHR_texture_transform: { texCoord: 1, offset: [0.25, 0.5] } },
    };
    const loaded = parseGLTF(await headless(), fixture.json, [fixture.bin.buffer], [{ width: 1, height: 1 }]),
      initial = (await exportModel(loaded)).json.materials[0].pbrMetallicRoughness.baseColorTexture;
    assert.equal(initial.texCoord, 1, 'KHR override remains the effective coordinate selection');
    assert.deepEqual(initial.extensions.KHR_texture_transform.offset, [0.25, 0.5]);
    loaded.primitives[0].material.uvt[3] = 0;
    const changed = (await exportModel(loaded)).json.materials[0].pbrMetallicRoughness.baseColorTexture;
    assert.equal(changed.texCoord ?? 0, 0, 'live row selection supersedes the loaded metadata');
    assert.deepEqual(changed.extensions.KHR_texture_transform.offset, [0.25, 0.5]);
  }));

for (const instanced of [false, true])
  test(`exportModel roundtrips a real grouped ${instanced ? 'instanced ' : ''}materials mesh`, () =>
    headlessModels(async () => {
      const engine = await headless(),
        red = new Material({ color: [1, 0, 0], map: pixel([255, 32, 0, 255]) }),
        blue = new Material({ color: [0, 0, 1], map: pixel([0, 64, 255, 255]), transparent: true, opacity: 0.5 });
      blue.setUVTransform({ texCoord: 1 }, 'map');
      const geometry = {
          ...quad,
          uvs1: uv1,
          groups: [
            { start: 0, count: 3, materialIndex: 1 },
            { start: 3, count: 3, materialIndex: 0 },
          ],
        },
        source = instanced
          ? createInstancedMesh(engine, geometry, [red, blue], 2)
          : createMesh(engine, geometry, [red, blue]);
      if (instanced) source.instances.setMatrixAt(1, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 0, 1]);
      const bytes = await exportModel(source, { binary: true }),
        { json } = readGLB(bytes),
        copy = await parseGLTFAsync(await headless(), bytes, { decoders: { instancing } });
      assert.equal(json.meshes.length, 1);
      assert.equal(json.nodes.filter((n) => n.mesh !== undefined).length, 1);
      assert.equal(copy.primitives.length, 2);
      assert.deepEqual(
        copy.primitives.map((p) => [...p.indices]),
        [
          [0, 1, 2],
          [0, 2, 3],
        ],
      );
      assert.deepEqual(
        copy.primitives.map((p) => p.material.base),
        [
          [0, 0, 1, 0.5],
          [1, 0, 0, 1],
        ],
      );
      assert.equal(copy.primitives[0].material.settings[0], 2);
      for (const p of copy.primitives) {
        assert.deepEqual(packedUV(p, 0), quad.uvs);
        assert.deepEqual(packedUV(p, 1), uv1);
        if (instanced) {
          assert.equal(p.instances.count, 2);
          assert.deepEqual([...p.instances.getMatrixAt(1)].slice(12, 15), [2, 0, 0]);
        }
      }
      assert.deepEqual(imagePixel(copy, copy.primitives[0].material.maps[0].index), [0, 64, 255, 255]);
      assert.deepEqual(imagePixel(copy, copy.primitives[1].material.maps[0].index), [255, 32, 0, 255]);
      assert.equal(copy.primitives[0].material.maps[0].texCoord, 1);
      await valid(bytes);
    }));
