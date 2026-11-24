// USDZ and DAE of a model loaded through @margoengine/gltf/pbr: an untextured one from the engine as it stands, a textured one
// through exportModel's GLB, which exportUSDZ takes and exportDAEOfGLB reads (docs/limits.md, "OBJ, STL and PLY of a loaded model").
import test from 'node:test';
import assert from 'node:assert/strict';
import { Material, Texture, createMesh } from '@margoengine/materials';
import { parseGLTF } from '@margoengine/gltf/pbr';
import { readZipDirectory, readZipEntry } from '@margoengine/loaders';
import { exportModel } from '../dist/model.js';
import { exportDAE } from '../dist/dae.js';
import { exportDAEOfGLB } from '../dist/dae-glb.js';
import { exportUSDZ } from '../dist/usdz.js';
import { headlessModels } from '../../../tests/support/pbr-snapshot.js';
import { materialEngine as headless } from './helpers.js';

const quad = {
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  uvs: [0, 0, 1, 0, 1, 1, 0, 1],
  indices: [0, 1, 2, 0, 2, 3],
};
/** A model written by exportModel and loaded back into a fresh engine, as a .gltf from a server would be. */
async function loaded(material) {
  const fixture = await exportModel(createMesh(await headless(), quad, material), { embed: false }),
    engine = await headless(),
    bin = fixture.bin.buffer.slice(fixture.bin.byteOffset, fixture.bin.byteOffset + fixture.bin.byteLength),
    model = await parseGLTF(engine, fixture.json, [bin]);
  return { engine, model };
}
const usda = async (archive) => new TextDecoder().decode(await readZipEntry(archive, readZipDirectory(archive)[0]));

test('an untextured loaded model exports as USDZ and DAE straight from the engine', () =>
  headlessModels(async () => {
    const { engine } = await loaded(new Material({ color: [1, 0.5, 0.25] })),
      text = await usda(exportUSDZ(engine));
    assert.match(text, /point3f\[\] points = \[\(0, 0, 0\), \(1, 0, 0\), \(1, 1, 0\), \(0, 1, 0\)\]/);
    assert.match(text, /color3f inputs:diffuseColor = \(1, 0\.5, 0\.25\)/);
    const { dae } = exportDAE(engine);
    assert.match(dae, /<float_array[^>]*>0 0 0 1 0 0 1 1 0 0 1 0<\/float_array>/);
    assert.match(dae, /<triangles /);
  }));

test('a textured loaded model goes to USDZ and DAE through exportModel, with its image', () =>
  headlessModels(async () => {
    const map = new Texture({ width: 2, height: 2, data: new Uint8Array(16).fill(200) }),
      { engine, model } = await loaded(new Material({ map }));
    // The live engine form is refused, and the message names the route.
    assert.throws(() => exportUSDZ(engine), /exportModel/);
    assert.throws(() => exportDAE(engine), /exportModel/);
    const glb = await exportModel(model, { binary: true }),
      archive = exportUSDZ(glb),
      names = readZipDirectory(archive).map(({ name }) => name),
      text = await usda(archive);
    assert.ok(
      names.some((name) => /\.png$/.test(name)),
      `the archive holds the image: ${names}`,
    );
    assert.match(text, /UsdUVTexture/);
    const { dae, textures, skipped } = exportDAEOfGLB(glb);
    assert.deepEqual(skipped, []);
    assert.equal(textures.size, 1);
    const [[path, bytes]] = textures;
    assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    assert.match(dae, new RegExp(`<init_from>${path.replace('.', '\.')}</init_from>`));
    assert.match(dae, /<texture texture=/);
  }));

test('exportDAEOfGLB refuses what is not GLB bytes', () => {
  assert.throws(() => exportDAEOfGLB('model.glb'), TypeError);
  assert.throws(() => exportDAEOfGLB(new Uint8Array(40)), TypeError);
});
