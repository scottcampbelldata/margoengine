// KTX2 cube maps, cube arrays and 2D arrays (@margoengine/decoders/ktx2-layers) against real files written by Khronos
// KTX-Software 4.4.2: every image must hash the same as `ktx extract --raw --all` (fixtures/ktx2-layers/records.json,
// written by scripts/ktx2-oracle.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { transcodeKTX2, transcodeKTX2Layers } from '../dist/codec.js';
import { KTX2LayerDecoder, parseKTX2, uploadTexture } from '../dist/ktx2-layers.js';
import { assertImages, basis, fixture, sha } from './support/ktx2.js';

test('Basis cube maps, cube arrays and arrays match KTX-Software image for image', async () => {
  const module = await basis();
  for (const [name, dimension, layers, arrayLayers, faces] of [
    ['cube-uastc-zstd.ktx2', 'cube', 6, 0, 6],
    ['cube-etc1s.ktx2', 'cube', 6, 0, 6],
    ['array-uastc.ktx2', '2d-array', 3, 3, 1],
    ['cube-array-etc1s.ktx2', 'cube-array', 12, 2, 6],
  ]) {
    const file = transcodeKTX2Layers(module, await fixture(name), 'rgba8');
    assert.equal(file.dimension, dimension, name);
    assert.equal(file.layers, layers, name);
    assert.equal(file.target, 'ktx2');
    assert.equal(file.transcoded, 'rgba8');
    assert.equal(file.format, 'rgba8unorm-srgb');
    assert.equal(file.srgb, true);
    assert.equal(new Set(file.mipmaps.map((m) => m.data.buffer)).size, 1, 'one transferable buffer');
    assertImages(file, name, arrayLayers, faces);
  }
});

test('Basis layers transcode to each compressed target with every image in place', async () => {
  const module = await basis(),
    bytes = await fixture('cube-uastc-zstd.ktx2');
  for (const [target, format, feature] of [
    ['bc7', 'bc7-rgba-unorm-srgb', 'texture-compression-bc'],
    ['astc-4x4', 'astc-4x4-unorm-srgb', 'texture-compression-astc'],
    ['etc2', 'etc2-rgba8unorm-srgb', 'texture-compression-etc2'],
  ]) {
    const file = transcodeKTX2Layers(module, bytes, target);
    assert.equal(file.format, format);
    assert.equal(file.feature, feature);
    assert.equal(file.mipmaps.length, 7);
    file.mipmaps.forEach((mip, level) => {
      assert.equal(mip.width, 64 >> level);
      assert.equal(mip.byteLength, Math.ceil(mip.width / 4) * Math.ceil(mip.height / 4) * 16 * 6, `${target} ${level}`);
    });
    const size = file.mipmaps[0].byteLength / 6,
      faces = Array.from({ length: 6 }, (_, i) => sha(file.mipmaps[0].data.subarray(i * size, (i + 1) * size)));
    assert.equal(new Set(faces).size, 6, 'six different faces');
  }
});

test('files that store a GPU format read without the transcoder, through zlib and Zstandard', async () => {
  const array = await parseKTX2(await fixture('arraytex_7_mipmap_reference_u.ktx2'));
  assert.equal(array.dimension, '2d-array');
  assert.equal(array.layers, 7);
  assert.equal(array.format, 'rgba8unorm-srgb');
  assert.equal(array.transcoded, 'native');
  assertImages(array, 'arraytex_7_mipmap_reference_u.ktx2', 7, 1);
  const half = await parseKTX2(await fixture('valid_R16G16B16A16_SFLOAT_CUBE_ARRAY_MIP.ktx2'));
  assert.equal(half.dimension, 'cube-array');
  assert.equal(half.format, 'rgba16float');
  assert.equal(half.layers % 6, 0);
  assertImages(half, 'valid_R16G16B16A16_SFLOAT_CUBE_ARRAY_MIP.ktx2', half.layers / 6, 6);
  for (const name of ['cube-native-zstd.ktx2', 'cube-native-zlib.ktx2']) {
    const cube = await parseKTX2(await fixture(name));
    assert.equal(cube.dimension, 'cube', name);
    assertImages(cube, name, 0, 6);
  }
});

test('a zlib level that declares more bytes than it inflates to fails as damaged, without allocating the claim', async () => {
  const bytes = (await fixture('cube-native-zlib.ktx2')).slice(),
    view = new DataView(bytes.buffer, bytes.byteOffset);
  // Level 0's uncompressedByteLength (bytes 96 to 103) past 4 GiB: allocating it threw an uncoded RangeError.
  view.setUint32(100, 1, true);
  await assert.rejects(parseKTX2(bytes), (error) => error.code === 'failed' && /declares/.test(error.message));
  // A few bytes over the real size: the same coded failure once the stream ends.
  view.setUint32(100, 0, true);
  view.setUint32(96, view.getUint32(96, true) + 4, true);
  await assert.rejects(parseKTX2(bytes), (error) => error.code === 'failed' && /declares/.test(error.message));
});

test('uploadTexture writes every level and layer of a transcoded cube map', async () => {
  const file = transcodeKTX2Layers(await basis(), await fixture('cube-uastc-zstd.ktx2'), 'bc7'),
    writes = [];
  globalThis.GPUTextureUsage ??= { TEXTURE_BINDING: 4, COPY_DST: 2 };
  let created;
  const device = {
    features: new Set(['texture-compression-bc']),
    limits: { maxTextureDimension2D: 8192 },
    createTexture: (descriptor) => (created = { ...descriptor, destroy() {} }),
    queue: { writeTexture: (destination, data, layout, size) => writes.push({ destination, data, layout, size }) },
  };
  uploadTexture(device, file);
  assert.deepEqual(created.size, [64, 64, 6]);
  assert.equal(created.mipLevelCount, 7);
  assert.equal(writes.length, 7);
  assert.deepEqual(writes[0].size, [64, 64, 6]);
  assert.equal(writes[0].layout.bytesPerRow, 16 * 16);
  assert.equal(writes[0].layout.rowsPerImage, 16);
  // 2x2 and 1x1 mips are one block; the copy covers the physical block.
  assert.deepEqual(writes[6].size, [4, 4, 6]);
  assert.equal(writes[6].layout.bytesPerRow, 16);
});

test('refusals name the problem', async () => {
  const cube = await fixture('cube-uastc-zstd.ktx2'),
    module = await basis();
  // The 2D decoder points at this entry instead of dropping layers.
  assert.throws(() => transcodeKTX2(module, cube, 'rgba8'), /KTX2LayerDecoder/);
  const threeD = cube.slice();
  new DataView(threeD.buffer).setUint32(28, 4, true);
  assert.throws(() => transcodeKTX2Layers(module, threeD, 'rgba8'), /3D textures/);
  assert.throws(() => transcodeKTX2Layers(module, cube.subarray(0, 60), 'rgba8'), /truncated header/);
  assert.throws(() => transcodeKTX2Layers(module, cube, 'nope'), /Unknown transcode target/);
  await assert.rejects(parseKTX2(cube), /Basis Universal payload/);
  await assert.rejects(parseKTX2([1, 2]), TypeError);
  const native = await fixture('arraytex_7_mipmap_reference_u.ktx2'),
    unknown = native.slice(),
    short = native.slice();
  new DataView(unknown.buffer).setUint32(12, 100000, true);
  await assert.rejects(parseKTX2(unknown), /vkFormat 100000/);
  new DataView(short.buffer).setUint32(88, 4, true);
  await assert.rejects(parseKTX2(short), /level 0 holds 4 bytes/);
});

test('a KTX2LayerDecoder reads a native file on the calling thread and needs a device to upload', async () => {
  const decoder = new KTX2LayerDecoder();
  assert.equal(decoder.target, 'rgba8');
  const file = await decoder.decode(await fixture('cube-native-zstd.ktx2'));
  assert.equal(file.dimension, 'cube');
  await assert.rejects(decoder.createTexture(new Uint8Array(4)), /needs a device/);
  decoder.dispose();
});
