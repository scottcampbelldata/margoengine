// Regenerate with draco3d@1.5.7 extracted outside node_modules; no encoder dependency is needed at test time.
// node packages/decoders/tests/generate-normalized-fixture.mjs test-results/draco-fixture-encoder/package
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const require = createRequire(import.meta.url), directory = resolve(process.argv[2]);
assert.equal(JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8')).version, '1.5.7');
const module = await require(resolve(directory, 'draco_encoder_nodejs.js'))();
const mesh = new module.Mesh(), builder = new module.MeshBuilder(), encoder = new module.Encoder(), output = new module.DracoInt8Array();
try {
  builder.AddFacesToMesh(mesh, 1, new Uint32Array([0, 1, 2]));
  const attributes = {
    POSITION: builder.AddFloatAttribute(mesh, module.POSITION, 3, 3, new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0])),
    TEXCOORD_0: builder.AddUInt8Attribute(mesh, module.TEX_COORD, 3, 2, new Uint8Array([0, 0, 255, 0, 0, 255])),
    COLOR_0: builder.AddUInt8Attribute(mesh, module.COLOR, 3, 4, new Uint8Array([255, 128, 0, 255, 0, 255, 128, 255, 128, 0, 255, 255])),
  };
  for (const semantic of ['TEXCOORD_0', 'COLOR_0']) builder.SetNormalizedFlagForAttribute(mesh, attributes[semantic], true);
  encoder.SetSpeedOptions(10, 10);
  const length = encoder.EncodeMeshToDracoBuffer(mesh, output);
  assert.ok(length > 0);
  const binary = Uint8Array.from({length}, (_, i) => output.GetValue(i));
  const doc = {asset: {version: '2.0', generator: 'draco3d@1.5.7 normalized attribute regression fixture'},
    extensionsUsed: ['KHR_draco_mesh_compression'], extensionsRequired: ['KHR_draco_mesh_compression'],
    buffers: [{byteLength: binary.length, uri: 'NormalizedTriangle.bin'}], bufferViews: [{buffer: 0, byteLength: binary.length}],
    accessors: [{componentType: 5126, count: 3, type: 'VEC3', min: [-1, -1, 0], max: [1, 1, 0]},
      {componentType: 5121, count: 3, type: 'VEC2', normalized: true}, {componentType: 5121, count: 3, type: 'VEC4', normalized: true},
      {componentType: 5123, count: 3, type: 'SCALAR'}],
    meshes: [{primitives: [{attributes: {POSITION: 0, TEXCOORD_0: 1, COLOR_0: 2}, indices: 3,
      extensions: {KHR_draco_mesh_compression: {bufferView: 0, attributes}}}]}], nodes: [{mesh: 0}], scenes: [{nodes: [0]}], scene: 0};
  await writeFile(new URL('./fixtures/NormalizedTriangle.bin', import.meta.url), binary);
  await writeFile(new URL('./fixtures/NormalizedTriangle.gltf', import.meta.url), JSON.stringify(doc, null, 2) + '\n');
  console.log(`Generated normalized Draco triangle (${binary.length} bytes).`);
} finally {
  module.destroy(output); module.destroy(encoder); module.destroy(builder); module.destroy(mesh);
}
