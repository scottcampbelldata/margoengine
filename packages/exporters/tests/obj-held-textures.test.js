// exportOBJ of a loaded model whose base colour is held in WebP, KTX2, DDS or a file beside it: writeTextures decodes each
// to the PNG the MTL names. The images are real files: cwebp's and the Khronos sample textures of @margoengine/decoders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { decodePNG } from '@margoengine/decoders/png';
import { decodeImage } from '@margoengine/decoders/image';
import { loadGLTF, parseGLTF } from '@margoengine/gltf-pro';
import { encodePNG } from '../dist/capture.js';
import { exportDAE, exportOBJ, writeOpacityMaps, writeTextures } from '../dist/index.js';
import { dds } from '../../decoders/tests/support/texture-encoders.js';
import { headless, headlessModels } from '../../../tests/support/pbr-snapshot.js';

const fixture = (name) => new Uint8Array(readFileSync(new URL(`../../decoders/tests/fixtures/${name}`, import.meta.url))),
  webp = () => fixture('webp/lossless.webp'),
  options = { materials: true, textures: true };

/** A one-quad document with the given textures entry and images; each image holds `bytes` or a `uri`. */
function document(texture, images) {
  const floats = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1, 0, 0, 0],
    head = new Uint8Array(new Float32Array(floats).buffer),
    indices = new Uint8Array(new Uint16Array([0, 1, 2, 0, 2, 3]).buffer),
    parts = [head, indices, ...images.filter((i) => i.bytes).map((i) => i.bytes)],
    views = [],
    at = [];
  let length = 0;
  for (const part of parts) {
    at.push(length);
    views.push({ buffer: 0, byteOffset: length, byteLength: part.length });
    length += (part.length + 3) & ~3;
  }
  // Positions, normals and UVs share the first part.
  views[0].byteLength = 48;
  views.splice(1, 0, { buffer: 0, byteOffset: 48, byteLength: 48 }, { buffer: 0, byteOffset: 96, byteLength: 32 });
  const bin = new Uint8Array(length);
  parts.forEach((part, i) => bin.set(part, at[i]));
  let next = 4;
  const json = {
    asset: { version: '2.0' },
    extensionsUsed: Object.keys(texture.extensions ?? {}),
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    materials: [{ name: 'held', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    textures: [texture],
    images: images.map(({ bytes, uri, mimeType }) => (bytes ? { bufferView: next++, mimeType } : { uri, mimeType })),
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: 4, type: 'VEC2' },
      { bufferView: 3, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
    bufferViews: views,
    buffers: [{ byteLength: length }],
  };
  return { json, bin };
}

function glb({ json, bin }) {
  const text = new TextEncoder().encode(JSON.stringify(json)),
    textLength = (text.length + 3) & ~3,
    out = new Uint8Array(12 + 8 + textLength + 8 + bin.length),
    view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.length, true);
  view.setUint32(12, textLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.fill(0x20, 20, 20 + textLength);
  out.set(text, 20);
  view.setUint32(20 + textLength, bin.length, true);
  view.setUint32(24 + textLength, 0x004e4942, true);
  out.set(bin, 28 + textLength);
  return out;
}

const held = (extension, bytes, mimeType) =>
  glb(document({ extensions: { [extension]: { source: 0 } } }, [{ bytes, mimeType }]));

for (const [name, file, mimeType, extension] of [
  ['WebP', webp, 'image/webp', 'EXT_texture_webp'],
  ['KTX2', () => fixture('Dot_C.ktx2'), 'image/ktx2', 'KHR_texture_basisu'],
  ['DDS', () => dds({ width: 16, height: 16, fourCC: 'DXT1', data: new Uint8Array(128) }), 'image/vnd-ms.dds', 'MSFT_texture_dds'],
])
  test(`exportOBJ writes a base colour held in ${name} as the PNG its MTL names`, () =>
    headlessModels(async () => {
      const engine = await headless(),
        bytes = file();
      parseGLTF(engine, held(extension, bytes, mimeType));
      const result = exportOBJ(engine, options),
        [mtlName] = /[\w.-]+\.png/.exec(result.mtl);
      assert.deepEqual([...result.undecoded.keys()], [mtlName]);
      assert.equal(result.textures.size, 0);
      await writeTextures(result);
      assert.equal(result.undecoded.size, 0);
      const written = decodePNG(result.textures.get(mtlName)),
        expected = await decodeImage(bytes);
      assert.deepEqual([written.width, written.height], [expected.width, expected.height]);
      assert.deepEqual(written.data, expected.data);
    }));

test('a PNG fallback beats the image an extension holds, and needs no decoding', () =>
  headlessModels(async () => {
    const engine = await headless(),
      png = await encodePNG({ width: 2, height: 2, data: new Uint8Array(16).fill(200) });
    parseGLTF(
      engine,
      glb(
        document({ source: 0, extensions: { EXT_texture_webp: { source: 1 } } }, [
          { bytes: png, mimeType: 'image/png' },
          { bytes: webp(), mimeType: 'image/webp' },
        ]),
      ),
    );
    const result = exportOBJ(engine, options);
    assert.equal(result.undecoded.size, 0);
    assert.deepEqual([...result.textures.values()], [png]);
    await writeTextures(result);
    assert.deepEqual([...result.textures.values()], [png]);
  }));

test('writeOpacityMaps decodes first, so a map can read a held image', () =>
  headlessModels(async () => {
    const engine = await headless();
    parseGLTF(engine, held('EXT_texture_webp', fixture('webp/lossless-alpha.webp'), 'image/webp'));
    const result = exportOBJ(engine, options);
    result.opacityMaps.set('map.png', [...result.undecoded.keys()][0]);
    await writeOpacityMaps(result);
    assert.equal(result.undecoded.size, 0);
    const map = decodePNG(result.textures.get('map.png')),
      alpha = decodePNG(result.textures.get(result.opacityMaps.get('map.png')));
    assert.equal(map.data[96 * 4], alpha.data[96 * 4 + 3]);
  }));

test('an image beside the model is fetched, decoded, and a missing one refused by name', () =>
  headlessModels(async () => {
    const png = await encodePNG({ width: 2, height: 2, data: new Uint8Array(16).fill(200) }),
      files = {
        '/near.png': png,
        '/near.webp': webp(),
      },
      server = createServer((request, response) => {
        const name = new URL(request.url, 'http://x').pathname;
        if (name === '/model.glb') return response.end(current);
        if (files[name]) return response.end(files[name]);
        response.writeHead(404);
        response.end();
      });
    let current;
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/model.glb`;
    try {
      const load = async (uri, mimeType, texture) => {
        const engine = await headless();
        current = glb(document(texture, [{ uri, mimeType }]));
        await loadGLTF(engine, url);
        return exportOBJ(engine, options);
      };
      const plain = await load('near.png', 'image/png', { source: 0 });
      assert.equal(plain.undecoded.size, 1);
      await writeTextures(plain);
      assert.deepEqual([...plain.textures.values()], [png], 'a PNG is kept as it is');

      const decoded = await load('near.webp', 'image/webp', { extensions: { EXT_texture_webp: { source: 0 } } });
      await writeTextures(decoded);
      assert.deepEqual(decodePNG([...decoded.textures.values()][0]).data, (await decodeImage(webp())).data);

      const missing = await load('near.png', 'image/png', { source: 0 });
      delete files['/near.png'];
      await assert.rejects(writeTextures(missing), (e) => e.code === 'failed' && /near\.png/.test(e.message));
      assert.equal(missing.undecoded.size, 1, 'it stays listed');
    } finally {
      server.closeAllConnections();
      server.close();
    }
  }));

test('writeTextures stops on an aborted signal and does nothing with no held images', () =>
  headlessModels(async () => {
    const engine = await headless();
    parseGLTF(engine, held('KHR_texture_basisu', fixture('Dot_C.ktx2'), 'image/ktx2'));
    const result = exportOBJ(engine, options),
      controller = new AbortController();
    controller.abort(new RangeError('stop'));
    await assert.rejects(writeTextures(result, { signal: controller.signal }), /stop/);
    assert.equal(result.undecoded.size, 1);
    const empty = { undecoded: new Map(), textures: new Map() };
    await writeTextures(empty);
    assert.equal(empty.textures.size, 0);
  }));

test('a texture with no reachable image is refused by name, and other writers still refuse a loaded model', () =>
  headlessModels(async () => {
    const engine = await headless();
    parseGLTF(engine, glb(document({ source: 0 }, [{ uri: 'nowhere.png', mimeType: 'image/png' }])));
    assert.throws(() => exportOBJ(engine, options), /no image the model can reach/);
    assert.throws(() => exportDAE(engine), TypeError);
  }));
