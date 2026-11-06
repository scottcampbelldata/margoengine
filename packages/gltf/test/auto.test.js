import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { loadAuto } from '../dist/auto.js';
import { encodeAttributes } from '../../decoders/tests/support/meshopt-encode.js';
import { documentOf, headlessEngine, vertexData, withBitmaps } from './helpers.js';

// Stands in for gltf-pro, which needs a GPU; the real one runs in scripts/test-gltf-browser.mjs. Node keeps a resolved
// module but not a failed resolve, so the test with no gltf-pro has to come first.
let installed = false;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier !== '@margoengine/gltf-pro') return next(specifier, context);
    if (!installed)
      throw Object.assign(new Error(`Cannot find package '${specifier}'`), { code: 'ERR_MODULE_NOT_FOUND' });
    return {
      url: 'data:text/javascript,export const loadGLTF = (...args) => globalThis.loadPro(...args);',
      shortCircuit: true,
    };
  },
});

const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
const accessors = [
    { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
    { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
  ],
  primitive = { attributes: { POSITION: 0, NORMAL: 1 } };
const plain = (rest = {}) =>
  documentOf([positions, normals], { accessors, meshes: [{ primitives: [primitive] }], nodes: [{ mesh: 0 }], ...rest });
function glb({ doc, bytes }) {
  const text = new TextEncoder().encode(JSON.stringify(doc)),
    size = (text.length + 3) & ~3,
    out = new Uint8Array(12 + 8 + size + 8 + bytes.length),
    view = new DataView(out.buffer);
  out.fill(0x20, 20, 20 + size);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.length, true);
  view.setUint32(12, size, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  view.setUint32(20 + size, bytes.length, true);
  view.setUint32(24 + size, 0x004e4942, true);
  out.set(bytes, 28 + size);
  return out;
}
function server(files) {
  const asked = [];
  const fetch = async (url) => {
    asked.push(new URL(url).pathname);
    const body = files[new URL(url).pathname];
    return body === undefined ? new Response('gone', { status: 404 }) : new Response(body);
  };
  return { fetch, asked };
}
const animated = () => plain({ animations: [{ channels: [], samplers: [] }] });
const fileOf = (input) => ({ '/m.glb': glb(input) });
const url = 'https://example.test/m.glb';

test('a file that needs gltf-pro says to install it when it is missing', async () => {
  const { engine } = await headlessEngine();
  try {
    await assert.rejects(loadAuto(engine, url, server(fileOf(animated()))), (error) => {
      assert.equal(error.code, 'failed');
      assert.match(error.message, /install @margoengine\/gltf-pro/);
      return true;
    });
    assert.equal(engine.meshes.size, 0);
  } finally {
    engine.dispose();
  }
  installed = true;
});

test('a plain file stays on the light loader, downloaded once, and never imports gltf-pro', async (t) => {
  globalThis.loadPro = () => assert.fail('gltf-pro was called');
  t.after(() => delete globalThis.loadPro);
  const { engine } = await headlessEngine();
  try {
    const { fetch, asked } = server(fileOf(plain())),
      { loader, model } = await loadAuto(engine, url, { fetch });
    assert.equal(loader, 'gltf');
    assert.equal(model.meshes.length, 1);
    assert.deepEqual(asked, ['/m.glb']);
    model.dispose();
  } finally {
    engine.dispose();
  }
});

test('a .gltf with an external buffer reads each URL once', async () => {
  const { engine } = await headlessEngine();
  try {
    const { doc, bytes } = plain();
    doc.buffers[0].uri = 'm.bin';
    const { fetch, asked } = server({ '/m.gltf': JSON.stringify(doc), '/m.bin': bytes }),
      { model } = await loadAuto(engine, 'https://example.test/m.gltf', { fetch });
    assert.deepEqual(asked, ['/m.gltf', '/m.bin']);
    model.dispose();
  } finally {
    engine.dispose();
  }
});

test('the file decides the entries: quantized, meshopt and instancing all load light', async () => {
  const { engine } = await headlessEngine();
  try {
    const packed = new Uint16Array([0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0]),
      quantizedFile = documentOf([packed, normals], {
        extensionsRequired: ['KHR_mesh_quantization'],
        accessors: [{ bufferView: 0, componentType: 5123, count: 3, type: 'VEC3' }, accessors[1]],
        meshes: [{ primitives: [primitive] }],
        nodes: [{ mesh: 0 }],
      });
    quantizedFile.doc.bufferViews[0].byteStride = 8;
    const quantized = await loadAuto(engine, url, server(fileOf(quantizedFile)));
    assert.equal(quantized.loader, 'gltf');
    assert.deepEqual(vertexData(quantized.model.meshes[0].geometry).positions, [0, 0, 0, 1, 0, 0, 0, 1, 0]);
    quantized.model.dispose();

    const raw = new Uint8Array(positions.buffer),
      stream = encodeAttributes(raw, 3, 12),
      compressed = documentOf([stream, normals], {
        extensionsRequired: ['EXT_meshopt_compression'],
        accessors,
        meshes: [{ primitives: [primitive] }],
        nodes: [{ mesh: 0 }],
      }),
      view = compressed.doc.bufferViews[0];
    compressed.doc.bufferViews[0] = {
      buffer: 0,
      byteLength: 36,
      extensions: {
        EXT_meshopt_compression: {
          buffer: 0,
          byteOffset: view.byteOffset,
          byteLength: view.byteLength,
          byteStride: 12,
          count: 3,
          mode: 'ATTRIBUTES',
        },
      },
    };
    const meshopt = await loadAuto(engine, url, server(fileOf(compressed)));
    assert.equal(meshopt.loader, 'gltf');
    assert.deepEqual(vertexData(meshopt.model.meshes[0].geometry).positions, [...positions]);
    meshopt.model.dispose();

    const offsets = new Float32Array([0, 0, 0, 1, 0, 0]),
      forest = documentOf([positions, normals, offsets], {
        extensionsRequired: ['EXT_mesh_gpu_instancing'],
        accessors: [...accessors, { bufferView: 2, componentType: 5126, count: 2, type: 'VEC3' }],
        meshes: [{ primitives: [primitive] }],
        nodes: [{ mesh: 0, extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 2 } } } }],
      }),
      instanced = await loadAuto(engine, url, server(fileOf(forest)));
    assert.equal(instanced.loader, 'gltf');
    assert.equal(instanced.model.meshes.length, 2);
    instanced.model.dispose();
    assert.equal(engine.meshes.size, 0);
  } finally {
    engine.dispose();
  }
});

test('an unsupported file moves to gltf-pro from the bytes already downloaded', async (t) => {
  const model = { dispose() {} },
    calls = [];
  globalThis.loadPro = async (engine, target, options) => {
    await (await options.fetch(target, { signal: options.signal })).arrayBuffer();
    calls.push({ engine, target: String(target), options });
    return model;
  };
  t.after(() => delete globalThis.loadPro);
  const { engine } = await headlessEngine();
  try {
    const { fetch, asked } = server(fileOf(animated())),
      allowedURLs = ['https://cdn.example.test/'],
      result = await loadAuto(engine, url, { fetch, maxNodes: 7, allowedURLs });
    assert.equal(result.loader, 'gltf-pro');
    assert.equal(result.model, model);
    assert.match(result.reason, /skins and animations/);
    assert.deepEqual(asked, ['/m.glb']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].engine, engine);
    assert.equal(calls[0].target, url);
    assert.equal(calls[0].options.maxNodes, 7);
    assert.equal(calls[0].options.allowedURLs, allowedURLs);
    assert.equal(engine.meshes.size, 0);
  } finally {
    engine.dispose();
  }
});

test('a material the light entries refuse moves on; a texture on WebGL does too', async (t) => {
  const model = { dispose() {} };
  let calls = 0;
  globalThis.loadPro = async () => (calls++, model);
  t.after(() => delete globalThis.loadPro);
  withBitmaps(t);
  const { engine } = await headlessEngine();
  try {
    const blended = plain({ materials: [{ alphaMode: 'BLEND' }], meshes: [{ primitives: [{ ...primitive, material: 0 }] }] });
    assert.equal((await loadAuto(engine, url, server(fileOf(blended)))).loader, 'gltf-pro');
    const png = new Uint8Array([137, 80, 78, 71]),
      mapped = documentOf([positions, normals, new Float32Array(6), png], {
        accessors: [...accessors, { bufferView: 2, componentType: 5126, count: 3, type: 'VEC2' }],
        images: [{ bufferView: 3, mimeType: 'image/png' }],
        textures: [{ source: 0 }],
        materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
        meshes: [{ primitives: [{ attributes: { ...primitive.attributes, TEXCOORD_0: 2 }, material: 0 }] }],
        nodes: [{ mesh: 0 }],
      });
    const result = await loadAuto(engine, url, server(fileOf(mapped)));
    assert.equal(result.loader, 'gltf-pro');
    assert.match(result.reason, /WebGPU/);
    assert.equal(calls, 2);
    assert.equal(engine.meshes.size, 0);
  } finally {
    engine.dispose();
  }
});

test('a malformed file is an error, never a trip to gltf-pro', async (t) => {
  globalThis.loadPro = () => assert.fail('gltf-pro was called');
  t.after(() => delete globalThis.loadPro);
  const { engine } = await headlessEngine();
  try {
    const at = (body) => loadAuto(engine, 'https://example.test/m.gltf', server({ '/m.gltf': body }));
    await assert.rejects(at('{ nope'), /Invalid glTF JSON/);
    await assert.rejects(at('null'), /Expected glTF 2.0/);
    await assert.rejects(at('{"asset":{"version":"2.0"},"meshes":3,"extensionsUsed":4}'), /glTF meshes must be an array/);
    await assert.rejects(loadAuto(engine, url, server({})), /HTTP 404/);
    const broken = plain();
    broken.doc.accessors[0].count = 300;
    await assert.rejects(loadAuto(engine, url, server(fileOf(broken))), /bounds/);
    assert.equal(engine.meshes.size, 0);
  } finally {
    engine.dispose();
  }
});

test('an aborted load and a URL that is not HTTP stop before any download', async () => {
  const { engine } = await headlessEngine();
  try {
    const { fetch, asked } = server(fileOf(plain())),
      signal = AbortSignal.abort(new Error('stopped'));
    await assert.rejects(loadAuto(engine, url, { fetch, signal }), /stopped/);
    await assert.rejects(loadAuto(engine, 'file:///m.glb', { fetch }), /HTTP/);
    assert.deepEqual(asked, []);
  } finally {
    engine.dispose();
  }
});

test('gltf-pro and the other entries stay out of what the entry imports at load', async () => {
  const code = await readFile(new URL('../dist/auto.js', import.meta.url), 'utf8');
  assert.match(code, /import\(["`]@margoengine\/gltf-pro["`]\)/);
  assert.doesNotMatch(code, /from\s*["`]@margoengine\/gltf-pro/);
  for (const name of ['meshopt', 'quantized', 'textured', 'instancing'])
    assert.doesNotMatch(code, new RegExp(`from\\s*["\`]\\./${name}`));
});
