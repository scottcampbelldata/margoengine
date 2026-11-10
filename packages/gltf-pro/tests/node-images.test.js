import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { encodePNG } from '@margoengine/headless';
import { decodeImage } from '@margoengine/decoders/image';
import { loadGLTF, parseGLTF, parseGLTFAsync } from '../dist/index.js';
import { headless } from '../../../tests/support/pbr-snapshot.js';
import { mockGPU } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { materialQuad } from '../../../tests/support/materials-fixture.js';

const uri = (bytes, type) =>
  `data:${type};base64,${Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')}`;
const png = await encodePNG({
  width: 2,
  height: 2,
  data: Uint8Array.of(255, 0, 0, 128, 0, 255, 0, 255, 0, 0, 255, 0, 255, 255, 0, 64),
});
const jpeg = new Uint8Array(
  await readFile(new URL('../../exporters/tests/fixtures/jpeg/progressive-420.jpg', import.meta.url)),
);
function document(bytes, type, form) {
  const { doc, buffers } = materialQuad();
  doc.buffers.forEach((d, i) => {
    d.uri = uri(buffers[i], 'application/octet-stream');
  });
  if (form === 'bufferView') {
    doc.images = [{ bufferView: doc.bufferViews.length, mimeType: type }];
    doc.bufferViews.push({ buffer: doc.buffers.length, byteLength: bytes.length });
    doc.buffers.push({ byteLength: bytes.length, uri: uri(bytes, 'application/octet-stream') });
  } else doc.images = [{ uri: form === 'external' ? 'image' : uri(bytes, type) }];
  doc.textures = [{ source: 0 }];
  doc.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 };
  return doc;
}

for (const [type, bytes] of [
  ['image/png', png],
  ['image/jpeg', jpeg],
])
  for (const form of ['data URI', 'bufferView', 'external'])
    test(`Node glTF decodes ${type} ${form}, uploads straight RGBA bytes and retains them for restore`, async () => {
      assert.equal(typeof globalThis.createImageBitmap, 'undefined');
      const gpu = mockGPU(),
        engine = await headless(gpu.device),
        writes = [],
        made = [];
      const write = gpu.device.queue.writeTexture,
        create = gpu.device.createTexture;
      gpu.device.queue.writeTexture = (to, data, layout, size) => {
        writes.push({ to, data: data.slice(), layout, size });
        write(to, data, layout, size);
      };
      gpu.device.createTexture = (d) => {
        made.push(d);
        return create(d);
      };
      const doc = document(bytes, type, form),
        expected = await decodeImage(bytes);
      let model;
      try {
        model =
          form === 'external'
            ? await loadGLTF(engine, 'https://example.test/model.gltf', {
                fetch: async (url) => (String(url).endsWith('model.gltf') ? Response.json(doc) : new Response(bytes)),
              })
            : await parseGLTFAsync(engine, doc);
        const image = model.image(0);
        assert.deepEqual(image, expected, 'the original straight-alpha samples are retained');
        const uploaded = writes.filter((w) => w.to.texture.format === 'rgba8unorm-srgb');
        assert.ok(uploaded.length > 0, 'material setup uploaded its colour texture without a browser image');
        assert.deepEqual(uploaded[0].data, expected.data);
        assert.deepEqual(uploaded[0].layout, { bytesPerRow: expected.width * 4 });
        assert.ok(
          made.some(
            (d) =>
              d.format === 'rgba8unorm-srgb' &&
              d.mipLevelCount === Math.floor(Math.log2(Math.max(expected.width, expected.height))) + 1,
          ),
          'ordinary mip generation is retained',
        );
        for (const srgb of [false, true]) {
          const texture = model.uploadImage(0, gpu.device, srgb);
          assert.equal(texture.format, srgb ? 'rgba8unorm-srgb' : 'rgba8unorm');
          assert.deepEqual(writes.at(-1).data, expected.data);
          texture.destroy();
        }
        const count = writes.length;
        model.onDeviceRestored(engine);
        assert.ok(
          writes.slice(count).some((w) => Buffer.from(w.data).equals(Buffer.from(expected.data))),
          'restoration uploads retained pixels',
        );
      } finally {
        model?.dispose();
        engine.dispose();
      }
    });

test('Node image failures name the image, preserve abort reasons and publish no model', async () => {
  const gpu = mockGPU(),
    engine = await headless(gpu.device);
  try {
    const invalid = document(Uint8Array.of(0), 'image/png', 'data URI');
    await assert.rejects(parseGLTFAsync(engine, invalid), /glTF image 0 could not be decoded/);
    assert.equal(engine.meshes.size, 0);
    const reason = new Error('cancelled');
    await assert.rejects(
      parseGLTFAsync(engine, document(png, 'image/png', 'data URI'), { signal: AbortSignal.abort(reason) }),
      (error) => error === reason,
    );
    assert.equal(engine.meshes.size, 0);
  } finally {
    engine.dispose();
  }
});

test('caller-provided pixel images reject malformed dimensions and byte rows before publishing meshes', async () => {
  const engine = await headless(mockGPU().device),
    { doc, buffers } = materialQuad();
  try {
    for (const image of [
      { width: 0, height: 1, data: new Uint8Array(0) },
      { width: 1.5, height: 1, data: new Uint8Array(6) },
      { width: 1, height: 1, data: new Uint8Array(3) },
      { width: 1, height: 1, data: new Float32Array(4) },
    ]) {
      assert.throws(() => parseGLTF(engine, doc, buffers, [image]), /Invalid glTF pixel image/);
      assert.equal(engine.meshes.size, 0);
    }
  } finally {
    engine.dispose();
  }
});
