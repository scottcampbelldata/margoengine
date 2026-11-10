import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { Stage } from '@margoengine/stage';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const imports = [];
registerHooks({
  resolve(specifier, context, next) {
    if (['@margoengine/gltf-pro', '@margoengine/animation'].includes(specifier)) {
      imports.push(specifier);
      throw Object.assign(new Error(`Cannot find package '${specifier}'`), { code: 'ERR_MODULE_NOT_FOUND' });
    }
    return next(specifier, context);
  },
});
const { addGLTF } = await import('@margoengine/stage/gltf');
const triangle = () => ({
  asset: { version: '2.0' },
  buffers: [
    { byteLength: 36, uri: 'data:application/octet-stream;base64,AAAAAAAAAAAAAAAAAACAPwAAAAAAAAAAAAAAAAAAgD8AAAAA' },
  ],
  bufferViews: [{ buffer: 0, byteLength: 36 }],
  accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  nodes: [{ mesh: 0 }],
  scenes: [{ nodes: [0] }],
  scene: 0,
});

test('basic installation loads plain geometry without importing pro or animation, fetching the root once', async () => {
  const gpu = optionalGPU().engine.gpu;
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    await TransformStore.create(64),
    { backend: 'webgpu', gpu, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
  const stage = new Stage(engine),
    previous = globalThis.fetch;
  let requests = 0;
  let binary = false;
  globalThis.fetch = async () => {
    requests++;
    if (!binary) return Response.json(triangle());
    const json = new TextEncoder().encode(JSON.stringify(triangle())),
      padded = (json.length + 3) & ~3;
    const bytes = new Uint8Array(20 + padded),
      view = new DataView(bytes.buffer);
    [0x46546c67, 2, bytes.length, padded, 0x4e4f534a].forEach((n, i) => view.setUint32(i * 4, n, true));
    bytes.fill(32, 20);
    bytes.set(json, 20);
    return new Response(bytes);
  };
  try {
    for (binary of [false, true]) {
      const model = await addGLTF(stage, `https://test.invalid/plain.${binary ? 'glb' : 'gltf'}`);
      assert.equal(model.meshes.length, 1);
      assert.equal(model.pbr, undefined);
      assert.deepEqual(Array.from(model.bounds), [0, 0, 0, 1, 1, 0]);
      assert.deepEqual(imports, []);
      model.destroy();
      assert.equal(engine.scene.meshes.size, 0);
    }
    assert.equal(requests, 2);
  } finally {
    globalThis.fetch = previous;
    stage.dispose();
  }
});

test('a missing advanced loader names the material feature and its package with a code', async () => {
  const doc = triangle();
  doc.materials = [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }];
  doc.meshes[0].primitives[0].material = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = async () => Response.json(doc);
  try {
    await assert.rejects(
      addGLTF({ engine: {}, signal: new AbortController().signal }, 'https://test.invalid/map.gltf'),
      { name: 'MargoError', code: 'state', message: /textures.*@margoengine\/gltf-pro/ },
    );
  } finally {
    globalThis.fetch = previous;
  }
});

test('a glTF URL that returns a Git LFS pointer throws a coded error naming git lfs pull, not invalid JSON', async () => {
  // A clone without Git LFS serves this stub in place of the model; the route used to fail parsing it as JSON.
  const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:' + '0'.repeat(64) + '\nsize 12345\n';
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response(pointer);
  try {
    for (const url of ['https://test.invalid/lfs.gltf', 'https://test.invalid/lfs.glb'])
      await assert.rejects(addGLTF({ engine: {}, signal: new AbortController().signal }, url), (error) => {
        assert.equal(error.name, 'MargoError');
        assert.equal(error.code, 'failed');
        assert.ok(error.message.startsWith(`${url} is a Git LFS pointer file`), error.message);
        assert.match(error.message, /git lfs pull/);
        assert.ok(error.message.endsWith('; see https://margoengine.com/errors#git-lfs'), error.message);
        return true;
      });
  } finally {
    globalThis.fetch = previous;
  }
});
