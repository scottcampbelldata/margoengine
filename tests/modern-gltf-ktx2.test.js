import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import { loadGLTF, parseGLTF, parseGLTFAsync } from '../packages/gltf-pro/dist/index.js';
import { KTX2Decoder } from '../packages/decoders/dist/index.js';
import { initBasis, transcodeKTX2 } from '../packages/decoders/dist/codec.js';
import { optionalGPU } from './support/optional-gpu.js';
import { materialQuad } from './support/materials-fixture.js';

globalThis.require ??= createRequire(import.meta.url);
globalThis.__dirname ??= fileURLToPath(new URL('.', import.meta.url));
const fixture = (name) => readFile(new URL('../packages/decoders/tests/fixtures/' + name, import.meta.url));
const routes = new Map(),
  server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    try {
      const data =
        routes.get(path) ??
        (path.startsWith('/basis/')
          ? await readFile(new URL('../packages/decoders/dist' + path, import.meta.url))
          : undefined);
      if (!data) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, {
        'content-type': path.endsWith('.wasm')
          ? 'application/wasm'
          : path.endsWith('.js')
            ? 'text/javascript'
            : 'application/octet-stream',
      });
      response.end(data);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = 'http://127.0.0.1:' + server.address().port;
test.after(() => server.close());
let basis;
async function realKTX(data, _options) {
  basis ??= initBasis(base + '/basis/basis_transcoder.js', base + '/basis/basis_transcoder.wasm', async (url) => {
    (0, eval)(await (await fetch(url)).text());
  });
  const bytes =
    data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return transcodeKTX2((await basis).module, bytes, 'rgba8');
}
function dataURI(bytes, type = 'application/octet-stream') {
  return 'data:' + type + ';base64,' + Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}
async function definition(two = false) {
  const value = materialQuad(),
    color = await fixture('Dot_C.ktx2');
  value.doc.extensionsUsed = value.doc.extensionsRequired = ['KHR_texture_basisu'];
  value.doc.images = [{ uri: dataURI(color, 'image/ktx2') }];
  value.doc.textures = [{ extensions: { KHR_texture_basisu: { source: 0 } } }];
  value.doc.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 };
  if (two) {
    value.doc.images.push({ uri: dataURI(await fixture('Rib_N.ktx2'), 'image/ktx2') });
    value.doc.textures.push({ extensions: { KHR_texture_basisu: { source: 1 } } });
    value.doc.materials[0].normalTexture = { index: 1 };
  }
  return value;
}
async function scene() {
  const harness = optionalGPU(),
    store = await TransformStore.create(32),
    device = harness.engine.gpu;
  device.limits.maxTextureDimension2D = 8192;
  const writes = [],
    copies = [],
    createTexture = device.createTexture,
    writeTexture = device.queue.writeTexture;
  device.createTexture = (descriptor) => {
    const texture = createTexture(descriptor);
    texture.descriptor = descriptor;
    return texture;
  };
  device.queue.writeTexture = (destination, data, layout, size) => {
    writes.push({ destination, data, layout, size });
    writeTexture(destination, data, layout, size);
  };
  device.queue.copyExternalImageToTexture = (...args) => copies.push(args);
  const engine = new Engine(
    { width: 128, height: 128, clientWidth: 128, clientHeight: 128 },
    store,
    { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 3], target: [0, 0, 0] },
    null,
  );
  return { ...harness, engine, device, writes, copies };
}

test('ordinary synchronous PBR parsing retains the baseline shader without invoking Basis', async () => {
  const s = await scene(),
    f = materialQuad(),
    original = KTX2Decoder.prototype.transcode;
  let calls = 0;
  KTX2Decoder.prototype.transcode = () => {
    calls++;
    throw new Error('Ordinary glTF must not transcode');
  };
  try {
    const model = parseGLTF(s.engine, f.doc, f.buffers);
    assert.equal(model instanceof Promise, false);
    assert.equal(calls, 0);
    model.destroy();
  } finally {
    KTX2Decoder.prototype.transcode = original;
    s.engine.dispose();
  }
});

test('real required Basis glTF images preserve sRGB, linear roles, and every mip on upload and restoration', async () => {
  const s = await scene(),
    f = await definition(true),
    calls = [];
  try {
    const model = await parseGLTFAsync(s.engine, f.doc, f.buffers, [], {
      ktx2: {
        transcode(data, options) {
          calls.push(options);
          return realKTX(data, options);
        },
      },
    });
    assert.equal(calls.length, 2);
    assert.equal(s.copies.length, 0);
    const color = s.resources.find((resource) => resource.descriptor?.mipLevelCount === 8),
      normal = s.resources.find((resource) => resource.descriptor?.mipLevelCount === 6);
    assert.equal(color.descriptor.format, 'rgba8unorm-srgb');
    assert.equal(normal.descriptor.format, 'rgba8unorm');
    assert.equal(s.writes.filter((write) => write.destination.texture === color).length, 8);
    assert.equal(s.writes.filter((write) => write.destination.texture === normal).length, 6);
    assert.equal(model.image(0).ktx2.mipmaps.length, 8);
    assert.equal(model.image(1).ktx2.mipmaps.length, 6);
    model.onDeviceRestored(s.engine);
    assert.equal(calls.length, 2, 'restoration reuses retained transcodes');
    assert.equal(color.destroyed, true);
    assert.equal(normal.destroyed, true);
    model.destroy();
  } finally {
    s.engine.dispose();
  }
  assert.ok(s.resources.every((resource) => resource.destroyed));
});

test('loadGLTF honors Basis source over PNG fallback and keeps caller decoder ownership', async () => {
  const s = await scene(),
    f = await definition(),
    oldBitmap = globalThis.createImageBitmap;
  let decoded = 0,
    closed = 0,
    transcodes = 0,
    disposed = 0;
  const ktx = f.doc.images[0];
  f.doc.images = [{ uri: dataURI(new Uint8Array([1]), 'image/png') }, ktx];
  f.doc.textures[0] = { source: 0, extensions: { KHR_texture_basisu: { source: 1 } } };
  f.doc.buffers.forEach((def, i) => (def.uri = dataURI(f.buffers[i])));
  routes.set('/ktx-fallback.gltf', JSON.stringify(f.doc));
  globalThis.createImageBitmap = async () => {
    decoded++;
    return {
      width: 1,
      height: 1,
      close() {
        closed++;
      },
    };
  };
  try {
    const model = await loadGLTF(s.engine, base + '/ktx-fallback.gltf', {
      ktx2: {
        transcode(data, options) {
          transcodes++;
          return realKTX(data, options);
        },
        dispose() {
          disposed++;
        },
      },
    });
    assert.equal(decoded, 0, 'unused PNG fallback is not decoded');
    assert.equal(transcodes, 1);
    assert.equal(s.copies.length, 0, 'the PNG fallback is not uploaded');
    assert.equal(model.image(1).width, 128);
    model.destroy();
    assert.equal(closed, 0);
    assert.equal(disposed, 0);
  } finally {
    globalThis.createImageBitmap = oldBitmap;
    s.engine.dispose();
  }
});

test('automatic KTX decoder is lazy, shared across images, and disposed after success or failure', async () => {
  const original = KTX2Decoder.prototype.transcode,
    dispose = KTX2Decoder.prototype.dispose;
  let created = new Set(),
    disposed = 0,
    fail = false;
  KTX2Decoder.prototype.transcode = function (data, options) {
    created.add(this);
    return fail ? Promise.reject(new Error('Basis failure')) : realKTX(data, options);
  };
  KTX2Decoder.prototype.dispose = function () {
    disposed++;
    dispose.call(this);
  };
  try {
    for (const failing of [false, true]) {
      fail = failing;
      const s = await scene(),
        f = await definition(true),
        before = s.resources.length;
      try {
        const pending = parseGLTFAsync(s.engine, f.doc, f.buffers);
        if (failing) {
          await assert.rejects(pending, /Basis failure/);
          assert.equal(s.resources.length, before);
        } else (await pending).destroy();
      } finally {
        s.engine.dispose();
      }
    }
    assert.equal(created.size, 2);
    assert.equal(disposed, 2);
  } finally {
    KTX2Decoder.prototype.transcode = original;
    KTX2Decoder.prototype.dispose = dispose;
  }
});

test('embedded KTX2 buffer views and image indices survive async parsing without fallback bitmaps', async () => {
  const s = await scene(),
    f = await definition(),
    bytes = await fixture('Dot_C.ktx2');
  f.doc.images = [{ uri: 'unused.png' }, { bufferView: f.doc.bufferViews.length, mimeType: 'image/ktx2' }];
  f.doc.textures[0].extensions.KHR_texture_basisu.source = 1;
  f.doc.bufferViews.push({ buffer: f.buffers.length, byteLength: bytes.length });
  f.doc.buffers.push({ byteLength: bytes.length });
  f.buffers.push(bytes);
  try {
    const model = await parseGLTFAsync(s.engine, f.doc, f.buffers, [], { ktx2: { transcode: realKTX } });
    assert.equal(model.image(1).width, 128);
    model.destroy();
  } finally {
    s.engine.dispose();
  }
});

test('invalid Basis sources, dimensional headers, mip results, and aborts fail before GPU allocation', async () => {
  const mutations = [
    (f) => (f.doc.textures[0].extensions.KHR_texture_basisu.source = -1),
    (f) => (f.doc.textures[0].extensions.KHR_texture_basisu = null),
    (f) => (f.doc.images[0].mimeType = 'image/png'),
    (f) => {
      const bytes = Buffer.from(f.doc.images[0].uri.split(',')[1], 'base64');
      bytes.writeUInt32LE(65536, 20);
      f.doc.images[0].uri = dataURI(bytes, 'image/ktx2');
    },
    (f) => {
      const bytes = Buffer.from(f.doc.images[0].uri.split(',')[1], 'base64');
      bytes.writeUInt32LE(7, 36);
      f.doc.images[0].uri = dataURI(bytes, 'image/ktx2');
    },
  ];
  for (const mutate of mutations) {
    const s = await scene(),
      f = await definition();
    mutate(f);
    let calls = 0;
    try {
      await assert.rejects(
        parseGLTFAsync(s.engine, f.doc, f.buffers, [], {
          ktx2: {
            transcode() {
              calls++;
              throw new Error('Unexpected transcode');
            },
          },
        }),
        /KTX2|basisu|source|image/i,
      );
      assert.equal(calls, 0);
      assert.equal(s.resources.length, 0);
    } finally {
      s.engine.dispose();
    }
  }
  for (const invalid of ['format', 'mip', 'sparse']) {
    const s = await scene(),
      f = await definition();
    try {
      await assert.rejects(
        parseGLTFAsync(s.engine, f.doc, f.buffers, [], {
          ktx2: {
            async transcode(data, options) {
              const result = await realKTX(data, options);
              if (invalid === 'format') result.format = 'r32float';
              else if (invalid === 'sparse') delete result.mipmaps[1];
              else result.mipmaps[1].data = new Uint8Array(1);
              return result;
            },
          },
        }),
        /KTX2|mip|image/,
      );
      assert.equal(s.resources.length, 0);
    } finally {
      s.engine.dispose();
    }
  }
  const s = await scene(),
    f = await definition(),
    controller = new AbortController();
  try {
    await assert.rejects(
      parseGLTFAsync(s.engine, f.doc, f.buffers, [], {
        signal: controller.signal,
        ktx2: {
          async transcode(data, options) {
            const result = await realKTX(data, options);
            controller.abort(new Error('Cancel KTX2'));
            return result;
          },
        },
      }),
      /Cancel KTX2/,
    );
    assert.equal(s.resources.length, 0);
  } finally {
    s.engine.dispose();
  }
});
