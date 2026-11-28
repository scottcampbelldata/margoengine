import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { moduleHooks } from '../../../scripts/support/node-compat.mjs';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { loadAuto } from '../dist/auto.js';
import { sceneData } from '../dist/scene-data.js';
import { encodeAttributes } from '../../decoders/tests/support/meshopt-encode.js';
import { documentOf, headlessEngine, vertexData, withBitmaps } from './helpers.js';
import { MargoError } from '@margoengine/math/errors';

// Stands in for gltf/pbr, which needs a GPU; the real one runs in scripts/test-gltf-browser.mjs.
await moduleHooks([
  {
    specifier: '@margoengine/gltf/pbr-instancing',
    url: 'data:text/javascript,export const instancing = { read() {} };',
  },
  {
    specifier: '@margoengine/gltf/pbr',
    url: 'data:text/javascript,export const loadGLTF = (...args) => globalThis.loadPro(...args);',
  },
]);

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

test('a plain file stays on the light loader, downloaded once, and never imports gltf/pbr', async (t) => {
  globalThis.loadPro = () => assert.fail('gltf/pbr was called');
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

test('a camera and a light stay light too, and read back with sceneData', async () => {
  const { engine } = await headlessEngine();
  try {
    const shot = plain({
        cameras: [{ type: 'perspective', perspective: { yfov: 1, znear: 0.1 } }],
        extensions: { KHR_lights_punctual: { lights: [{ type: 'point' }] } },
        extensionsUsed: ['KHR_lights_punctual'],
        nodes: [{ mesh: 0 }, { camera: 0 }, { extensions: { KHR_lights_punctual: { light: 0 } } }],
      }),
      { loader, model } = await loadAuto(engine, url, server(fileOf(shot)));
    assert.equal(loader, 'gltf');
    assert.equal(sceneData(model).cameras.length, 1);
    assert.equal(sceneData(model).lights.length, 1);
    model.dispose();
  } finally {
    engine.dispose();
  }
});

test('an unsupported file moves to gltf/pbr from the bytes already downloaded', async (t) => {
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
    assert.equal(result.loader, 'gltf/pbr');
    assert.equal(result.model, model);
    assert.match(result.reason, /Skins, animations/);
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

const moved = async (t, input, options) => {
  const calls = [],
    model = { dispose() {} };
  globalThis.loadPro = async (...args) => {
    calls.push(args[2]);
    return model;
  };
  t.after(() => delete globalThis.loadPro);
  const { engine } = await headlessEngine();
  try {
    const { fetch, asked } = server(fileOf(input)),
      result = await loadAuto(engine, url, { fetch, ...options });
    assert.equal(result.loader, 'gltf/pbr');
    assert.equal(result.model, model);
    assert.deepEqual(asked, ['/m.glb']);
    assert.equal(engine.meshes.size, 0);
    return { result, options: calls[0] };
  } finally {
    engine.dispose();
  }
};

test('a file over a light limit gltf/pbr does not share moves on: total vertices', async (t) => {
  const count = 600_000,
    file = documentOf([new Float32Array(count * 3), new Float32Array(count * 3).fill(1)], {
      accessors: accessors.map((a) => ({ ...a, count })),
      meshes: [{ primitives: [primitive, primitive] }],
      nodes: [{ mesh: 0 }],
    }),
    { result } = await moved(t, file);
  assert.match(result.reason, /one million vertices/);
});

test('a file over a light limit gltf/pbr does not share moves on: one accessor', async (t) => {
  const count = 1_000_001,
    file = documentOf([new Float32Array(count * 3), new Float32Array(count * 3).fill(1)], {
      accessors: accessors.map((a) => ({ ...a, count })),
      meshes: [{ primitives: [primitive] }],
      nodes: [{ mesh: 0 }],
    }),
    { result } = await moved(t, file);
  assert.match(result.reason, /one million values/);
});

const forest = (rest) =>
  documentOf([positions, normals, new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0])], {
    accessors: [...accessors, { bufferView: 2, componentType: 5126, count: 3, type: 'VEC3' }],
    meshes: [{ primitives: [primitive] }],
    nodes: [{ mesh: 0, extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 2 } } } }],
    ...rest,
  });

test('instances past maxNodes move on, and gltf/pbr gets the reader that keeps them', async (t) => {
  const { result, options } = await moved(t, forest({ extensionsRequired: ['EXT_mesh_gpu_instancing'] }), {
    maxNodes: 2,
  });
  assert.match(result.reason, /maxNodes/);
  assert.equal(options.maxNodes, 2);
  assert.equal(typeof options.decoders.instancing.read, 'function');
});

test('an instanced file refused for another reason keeps its instances on gltf/pbr', async (t) => {
  const { options } = await moved(
    t,
    forest({
      extensionsUsed: ['EXT_mesh_gpu_instancing'],
      animations: [{ channels: [], samplers: [] }],
    }),
  );
  assert.equal(typeof options.decoders.instancing.read, 'function');
});

test('a file with no instances passes gltf/pbr no decoders', async (t) => {
  const { options } = await moved(t, animated());
  assert.equal(options.decoders, undefined);
});

test('a limit both loaders share is the error, with no trip to gltf/pbr', async (t) => {
  globalThis.loadPro = () => assert.fail('gltf/pbr must not run');
  t.after(() => delete globalThis.loadPro);
  const { engine } = await headlessEngine();
  try {
    const file = plain({ nodes: [{ mesh: 0 }, { mesh: 0 }, { mesh: 0 }] });
    await assert.rejects(loadAuto(engine, url, { ...server(fileOf(file)), maxNodes: 2 }), {
      name: 'RangeError',
      message: /raise the maxNodes option/,
    });
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
    const blended = plain({
      materials: [{ alphaMode: 'BLEND' }],
      meshes: [{ primitives: [{ ...primitive, material: 0 }] }],
    });
    assert.equal((await loadAuto(engine, url, server(fileOf(blended)))).loader, 'gltf/pbr');
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
    assert.equal(result.loader, 'gltf/pbr');
    assert.match(result.reason, /WebGPU/);
    assert.equal(calls, 2);
    assert.equal(engine.meshes.size, 0);
  } finally {
    engine.dispose();
  }
});

test('with no GPU device for gltf/pbr either, the error carries the light loader reason first (KB-GLTFA B17)', async (t) => {
  globalThis.loadPro = async () => {
    throw new MargoError('unsupported', 'PBRModel requires WebGPU; use a browser that supports it');
  };
  t.after(() => delete globalThis.loadPro);
  withBitmaps(t);
  const { engine } = await headlessEngine();
  try {
    const png = new Uint8Array([137, 80, 78, 71]),
      mapped = documentOf([positions, normals, new Float32Array(6), png], {
        accessors: [...accessors, { bufferView: 2, componentType: 5126, count: 3, type: 'VEC2' }],
        images: [{ bufferView: 3, mimeType: 'image/png' }],
        textures: [{ source: 0 }],
        materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
        meshes: [{ primitives: [{ attributes: { ...primitive.attributes, TEXCOORD_0: 2 }, material: 0 }] }],
        nodes: [{ mesh: 0 }],
      });
    await assert.rejects(loadAuto(engine, url, server(fileOf(mapped))), (error) => {
      assert.equal(error.code, 'unsupported');
      assert.match(error.message, /^(?!PBRModel requires WebGPU)/, 'the light loader reason leads');
      assert.match(error.message, /gltf\/pbr cannot load it here either: PBRModel requires WebGPU/);
      return true;
    });
  } finally {
    engine.dispose();
  }
});

test('a malformed file is an error, never a trip to gltf/pbr', async (t) => {
  globalThis.loadPro = () => assert.fail('gltf/pbr was called');
  t.after(() => delete globalThis.loadPro);
  const { engine } = await headlessEngine();
  try {
    const at = (body) => loadAuto(engine, 'https://example.test/m.gltf', server({ '/m.gltf': body }));
    await assert.rejects(at('{ nope'), /Invalid glTF JSON/);
    await assert.rejects(at('null'), /Expected glTF 2.0/);
    await assert.rejects(
      at('{"asset":{"version":"2.0"},"meshes":3,"extensionsUsed":4}'),
      /glTF meshes must be an array/,
    );
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

test('gltf/pbr and the other entries stay out of what the entry imports at load', async () => {
  const code = await readFile(new URL('../dist/auto.js', import.meta.url), 'utf8');
  assert.match(code, /import\(["`]@margoengine\/gltf\/pbr["`]\)/);
  assert.doesNotMatch(code, /from\s*["`]@margoengine\/gltf\/pbr/);
  assert.match(
    code,
    /import\(["`]@margoengine\/gltf\/pbr-instancing["`]\)/,
    "the reader is gltf/pbr's own, not a copy",
  );
  for (const name of ['meshopt', 'quantized', 'textured', 'instancing', 'scene-data'])
    assert.doesNotMatch(code, new RegExp(`from\\s*["\`]\\./${name}`));
});

// KB-OWN-GLTF1: loadAuto finishes after its downloads, when the default scene is active again.
// An earlier test edits the shared accessors above, so these tests read counts of their own.
const fresh = () => plain({ accessors: accessors.map((a) => ({ ...a, count: 3 })) });
const inScene = (engine, start) => {
  const scene = engine.createScene('b');
  let started;
  scene.use({ name: 'loader', setup: () => (started = start()) });
  return { scene, started };
};

test('loadAuto started in a second scene builds the light model there', async () => {
  const { engine } = await headlessEngine();
  try {
    const { scene, started } = inScene(engine, () => loadAuto(engine, url, server(fileOf(fresh())))),
      { loader, model } = await started;
    assert.equal(loader, 'gltf');
    assert.ok(model.meshes[0].scene === scene, 'the mesh is not in the second scene');
    assert.equal(engine.scene.meshes.size, 0);
    assert.equal(scene.meshes.size, 3);
    model.dispose();
    assert.equal(scene.meshes.size, 0);
  } finally {
    engine.dispose();
  }
});

test('loadAuto hands gltf/pbr the second scene it started in', async (t) => {
  const { engine } = await headlessEngine();
  globalThis.loadPro = (target) => ({ mesh: target.createMesh() });
  t.after(() => delete globalThis.loadPro);
  try {
    const { scene, started } = inScene(engine, () => loadAuto(engine, url, server(fileOf(animated())))),
      { loader, model } = await started;
    assert.equal(loader, 'gltf/pbr');
    assert.ok(model.mesh.scene === scene, 'the gltf/pbr call ran outside the second scene');
    assert.equal(engine.scene.meshes.size, 0);
  } finally {
    engine.dispose();
  }
});

test('an abort during loadAuto leaves nothing in either scene', async () => {
  const { engine } = await headlessEngine();
  try {
    const controller = new AbortController(),
      files = server(fileOf(fresh())),
      fetch = async (...args) => {
        const response = await files.fetch(...args);
        controller.abort();
        return response;
      },
      { scene, started } = inScene(engine, () => loadAuto(engine, url, { fetch, signal: controller.signal }));
    await assert.rejects(started, { name: 'AbortError' });
    assert.equal(engine.scene.meshes.size + scene.meshes.size, 0);
  } finally {
    engine.dispose();
  }
});

// Bytes held in ArrayBuffers after a full collection: a count of what is still reachable, not a timing.
setFlagsFromString('--expose-gc');
const collect = runInNewContext('gc');
const heldBytes = () => {
  collect();
  collect();
  return process.memoryUsage().arrayBuffers;
};
const MiB = 1024 * 1024;
// A 100 MB stand-in, streamed in fresh 1 MiB chunks so the server holds none of it.
const streamed = (chunks) =>
  new ReadableStream({
    pull(controller) {
      if (chunks-- > 0) controller.enqueue(new Uint8Array(MiB));
      else controller.close();
    },
  });

test('a file over the light loader 64 MiB goes to gltf/pbr, downloaded once and held once (KB-GLTFA B5, B14)', async (t) => {
  const model = { dispose() {} },
    calls = [];
  let read = 0,
    held = 0;
  const base = heldBytes();
  globalThis.loadPro = async (_engine, target, options) => {
    calls.push(String(target));
    read = (await (await options.fetch(target, { signal: options.signal })).arrayBuffer()).byteLength;
    // gltf/pbr has its bytes: nothing else may still hold a copy of them.
    held = heldBytes() - base;
    return model;
  };
  t.after(() => delete globalThis.loadPro);
  const { engine } = await headlessEngine();
  try {
    let requests = 0;
    const fetch = async () => {
        requests++;
        return new Response(streamed(100));
      },
      result = await loadAuto(engine, url, { fetch });
    assert.equal(result.loader, 'gltf/pbr');
    assert.equal(result.model, model);
    assert.match(result.reason, /64 MiB/);
    assert.deepEqual(calls, [url]);
    assert.equal(requests, 1);
    assert.equal(read, 100 * MiB);
    assert.ok(held < 110 * MiB, `${held} bytes held while gltf/pbr loads 100 MiB`);
  } finally {
    engine.dispose();
  }
});

test('a declared length over the light loader 64 MiB moves on before any byte is read (KB-GLTFA B5)', async (t) => {
  let read = -1,
    where = '';
  globalThis.loadPro = async (_engine, target, options) => {
    const response = await options.fetch(target, { signal: options.signal });
    where = response.url;
    read = (await response.arrayBuffer()).byteLength;
    return { dispose() {} };
  };
  t.after(() => delete globalThis.loadPro);
  const { engine } = await headlessEngine();
  try {
    const fetch = async () => {
        const response = new Response(new Uint8Array(8), { headers: { 'content-length': String(65 * MiB) } });
        // Where a redirect ended: the loaders take their base from it and check it against allowedURLs.
        return Object.defineProperty(response, 'url', { value: `${url}?moved` });
      },
      result = await loadAuto(engine, url, { fetch });
    assert.equal(result.loader, 'gltf/pbr');
    assert.equal(read, 8);
    assert.equal(where, `${url}?moved`);
  } finally {
    engine.dispose();
  }
});
