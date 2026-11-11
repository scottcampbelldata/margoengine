import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeDDSImage, ddsTextures } from '../dist/dds.js';
import { parseGLTFAsync, loadGLTF } from '../dist/index.js';
import { headlessModels, headless } from '../../../tests/support/pbr-snapshot.js';
import { materialQuad } from '../../../tests/support/materials-fixture.js';
import { dds, bc1Solid } from '../../decoders/tests/support/texture-encoders.js';

const bytes = () =>
  dds({
    width: 4,
    height: 4,
    fourCC: 'DXT1',
    data: new Uint8Array([...bc1Solid(255, 0, 0), ...bc1Solid(0, 255, 0), ...bc1Solid(0, 0, 255)]),
    mips: 3,
  });
const uri = (data) => 'data:image/vnd-ms.dds;base64,' + Buffer.from(data).toString('base64');
const document = () => {
  const { doc, buffers } = materialQuad();
  doc.buffers.forEach(
    (d, i) => (d.uri = 'data:application/octet-stream;base64,' + Buffer.from(buffers[i].buffer).toString('base64')),
  );
  return {
    ...doc,
    extensionsRequired: ['MSFT_texture_dds'],
    images: [{ uri: 'missing.png' }, { uri: uri(bytes()) }],
    textures: [{ source: 0, extensions: { MSFT_texture_dds: { source: 1 } } }],
  };
};

test('DDS loads automatically through required extension and never fetches the unused fallback', async () =>
  headlessModels(async () => {
    const engine = await headless();
    const model = await parseGLTFAsync(engine, document());
    try {
      assert.equal(model.image(0, true), undefined);
      assert.equal(model.image(1).format, 'bc1-rgba-unorm');
      assert.equal(model.image(1).mipmaps.length, 3);
    } finally {
      model.dispose();
      engine.dispose();
    }
  }));

async function load(doc, fetch) {
  return headlessModels(async () => {
    const engine = await headless();
    const model = await loadGLTF(engine, 'https://example.test/model.gltf', {
      fetch: async (url) => (String(url).endsWith('model.gltf') ? Response.json(doc) : fetch(url)),
    });
    try {
      return { images: model.shareImages() };
    } finally {
      model.dispose();
      engine.dispose();
    }
  });
}

test('DDS reader supports external URI and embedded bufferView with the specified MIME type', async () => {
  const doc = document();
  doc.images[1] = { uri: 'texture.dds' };
  const fetched = [];
  const loaded = await load(doc, async (url) => {
    fetched.push(String(url));
    return new Response(bytes());
  });
  assert.deepEqual(fetched, ['https://example.test/texture.dds']);
  assert.equal(loaded.images[1].mipmaps.length, 3);
  const data = bytes();
  const embedded = document();
  const bufferIndex = embedded.buffers.length;
  const viewIndex = embedded.bufferViews.length;
  embedded.buffers.push({
    byteLength: data.length,
    uri: 'data:application/octet-stream;base64,' + Buffer.from(data).toString('base64'),
  });
  embedded.bufferViews.push({ buffer: bufferIndex, byteLength: data.length });
  embedded.images[1] = { bufferView: viewIndex, mimeType: 'image/vnd-ms.dds' };
  assert.equal((await load(embedded)).images[1].width, 4);
  embedded.images[1].mimeType = 'image/png';
  await assert.rejects(load(embedded), /MSFT_texture_dds requires/);
});

function device(features = []) {
  const calls = [],
    value = {
      features: new Set(features),
      limits: { maxTextureDimension2D: 8192 },
      createTexture(desc) {
        calls.push(desc);
        return { destroy() {} };
      },
      queue: {
        writeTexture(...args) {
          calls.push(args);
        },
      },
    };
  return { value, calls };
}
test('DDS native and fallback uploads preserve mips, slot colour spaces, and restoration on another device', () => {
  const old = globalThis.GPUTextureUsage;
  globalThis.GPUTextureUsage = { TEXTURE_BINDING: 4, COPY_DST: 2 };
  try {
    const image = decodeDDSImage(bytes()),
      native = device(['texture-compression-bc']),
      fallback = device();
    image.upload(native.value, true);
    assert.equal(native.calls[0].format, 'bc1-rgba-unorm-srgb');
    assert.equal(native.calls[0].mipLevelCount, 3);
    assert.deepEqual(
      native.calls.slice(1).map((c) => c[1].length),
      [8, 8, 8],
    );
    image.upload(fallback.value, false);
    assert.equal(fallback.calls[0].format, 'rgba8unorm');
    assert.deepEqual(
      fallback.calls.slice(1).map((c) => [...c[1].slice(0, 4)]),
      [
        [255, 0, 0, 255],
        [0, 255, 0, 255],
        [0, 0, 255, 255],
      ],
    );
    const restored = device(['texture-compression-bc']);
    image.upload(restored.value, false);
    assert.equal(restored.calls[0].format, 'bc1-rgba-unorm');
    const signed = decodeDDSImage(
      dds({ width: 4, height: 4, fourCC: 'BC4S', data: new Uint8Array([129, 129, 0, 0, 0, 0, 0, 0]) }),
    );
    const signedDevice = device();
    signed.upload(signedDevice.value, true);
    assert.equal(signedDevice.calls[0].format, 'rgba16float');
    assert.deepEqual([...new Uint16Array(signedDevice.calls[1][1].buffer).slice(0, 4)], [0xbc00, 0, 0, 0x3c00]);
  } finally {
    globalThis.GPUTextureUsage = old;
  }
});
test('DDS rejects malformed bytes, cube material images and cancellation', () => {
  assert.throws(() => ddsTextures.decode(new Uint8Array(4)), /DDS header/);
  assert.throws(
    () => decodeDDSImage(dds({ width: 4, height: 4, fourCC: 'DXT1', caps2: 0xfe00, data: new Uint8Array(48) })),
    /single-layer 2D/,
  );
  assert.throws(() => decodeDDSImage(bytes(), { signal: AbortSignal.abort() }), { name: 'AbortError' });
});

test('a malformed MSFT_texture_dds names itself, not KHR_texture_basisu', () =>
  headlessModels(async () => {
    const engine = await headless();
    try {
      for (const value of [null, 3, 'image.dds', [0]]) {
        const doc = document();
        doc.textures[0].extensions.MSFT_texture_dds = value;
        await assert.rejects(
          parseGLTFAsync(engine, doc),
          (error) => error instanceof TypeError && /Invalid glTF MSFT_texture_dds;/.test(error.message),
          String(value),
        );
      }
      const doc = document();
      doc.textures[0].extensions.KHR_texture_basisu = 1;
      await assert.rejects(parseGLTFAsync(engine, doc), /Invalid glTF KHR_texture_basisu;/);
    } finally {
      engine.dispose();
    }
  }));
