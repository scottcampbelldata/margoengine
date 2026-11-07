// @margoengine/gltf-pro/model reaches no decoder module, so a bundler reading it copies no Wasm: materials, animation and
// the kits put 720 KB of Draco and Basis files in every build before this entry. A compressed file there is refused by
// name; the package root still decodes it with no option given.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GLTFAsset as RootAsset, parseGLTFAsync } from '../dist/index.js';
import { GLTFAsset, PBRModel, parseGLTF } from '../dist/model-entry.js';

const draco = () => ({
  asset: { version: '2.0' },
  buffers: [{ byteLength: 4 }],
  bufferViews: [{ buffer: 0, byteLength: 4 }],
  accessors: [{ componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
  meshes: [
    {
      primitives: [
        { attributes: { POSITION: 0 }, extensions: { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: 0 } } } },
      ],
    },
  ],
  extensionsUsed: ['KHR_draco_mesh_compression'],
  extensionsRequired: ['KHR_draco_mesh_compression'],
});

test('the model entry is the same classes as the root', () => {
  assert.equal(GLTFAsset, RootAsset);
  assert.equal(typeof PBRModel, 'function');
  assert.equal(typeof parseGLTF, 'function');
});

test('nothing the model entry reaches names the decoders module, and the root does reach it', () => {
  const dist = new URL('../dist/', import.meta.url),
    names = /import\(["'`]@margoengine\/decoders["'`]\)/;
  const reach = (start) => {
    const seen = new Set(),
      todo = [start];
    while (todo.length) {
      const file = todo.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      const code = readFileSync(new URL(file, dist), 'utf8');
      for (const [, next] of code.matchAll(/(?:from|import|import\()\s*["'`]\.\/([\w.-]+\.js)["'`]/g)) todo.push(next);
    }
    return [...seen].filter((file) => names.test(readFileSync(new URL(file, dist), 'utf8')));
  };
  assert.deepEqual(reach('model-entry.js'), []);
  assert.equal(reach('index.js').length, 1);
});

test('a Draco file without a way to the decoders is refused by name, and a supplied module is used', async () => {
  const bytes = [new Uint8Array(4)];
  await assert.rejects(new GLTFAsset(draco(), bytes).decode(), (error) => {
    assert.equal(error.code, 'unsupported');
    assert.match(error.message, /needs the Draco decoder; load it with loadGLTF from @margoengine\/gltf-pro/);
    return true;
  });
  let asked = 0;
  const decoderModule = async () => {
    asked++;
    throw new RangeError('stopped at the module');
  };
  await assert.rejects(new GLTFAsset(draco(), bytes, undefined, { decoderModule }).decode(), /stopped at the module/);
  assert.equal(asked, 1);
});

test('the root gives parseGLTFAsync the decoders with no option', async () => {
  // The default decoder needs module workers, which Node's global scope lacks: reaching that refusal proves the road.
  const engine = { gpu: null, requestRender() {}, addPlugin() {}, hasPlugin: () => false };
  await assert.rejects(parseGLTFAsync(engine, draco(), [new Uint8Array(4)]), (error) => {
    assert.doesNotMatch(String(error.message), /needs the Draco decoder/);
    return true;
  });
});
