// encodeKTX2 and compressTextures: every file goes through Binomial's own transcoder (the Wasm @margoengine/decoders ships)
// and every GLB through the Khronos validator. Neither tool is ours, so a file either refuses fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { exportGLB, joinGLB, splitGLB } from '@margoengine/exporters';
import { encodePNG } from '@margoengine/exporters/capture';
import { compressTextures, encodeKTX2 } from '@margoengine/exporters/ktx2';
import { transcodeKTX2 } from '../../decoders/dist/codec.js';
import { basis } from '../../decoders/tests/support/ktx2.js';
import { validate } from './helpers.js';

const transcoder = await basis(),
  file = (path) => new Uint8Array(readFileSync(new URL(path, import.meta.url))),
  pixels = (bytes) => transcodeKTX2(transcoder, bytes, 'rgba8'),
  header = (bytes) => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      descriptor = view.getUint32(48, true);
    return {
      width: view.getUint32(20, true),
      height: view.getUint32(24, true),
      levels: view.getUint32(40, true),
      scheme: view.getUint32(44, true),
      model: bytes[descriptor + 12],
      primaries: bytes[descriptor + 13],
      transfer: bytes[descriptor + 14],
      planes: [...bytes.subarray(descriptor + 20, descriptor + 28)],
    };
  };

/** Quadrants of solid colour, each a whole number of 4 x 4 blocks. */
function quadrants(size, colors) {
  const data = new Uint8Array(size * size * 4),
    half = size / 2;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) data.set(colors[(y < half ? 0 : 2) + (x < half ? 0 : 1)], (y * size + x) * 4);
  return { width: size, height: size, data };
}

const FOUR = [
  [200, 40, 40, 255],
  [40, 200, 40, 255],
  [40, 40, 200, 255],
  [200, 200, 40, 255],
];

/** Largest difference of the RGB channels from the source, at the centre of each quadrant. */
function quadrantError(data, size) {
  let worst = 0;
  [
    [size / 4, size / 4],
    [(size * 3) / 4, size / 4],
    [size / 4, (size * 3) / 4],
    [(size * 3) / 4, (size * 3) / 4],
  ].forEach(([x, y], i) => {
    for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(data[(y * size + x) * 4 + c] - FOUR[i][c]));
  });
  return worst;
}

// ETC1S stores a block's colour in 5 bits a channel, a step of 255 / 31 = 8.2, so at most half of that from the source.
// The block's four intensity offsets (at least +-2 at table 0, from T. Strom's ETC tables) are chosen by the encoder to
// bring it nearer, never further, so 4.2 stands, and rounding to 8 bits gives 5. UASTC has a solid-block mode, exact.
const ETC1S_FLAT = 5,
  UASTC_FLAT = 0;

test('encodeKTX2 writes ETC1S that Binomial reads back within its colour grid, the right way up, with a mip chain', async () => {
  const bytes = await encodeKTX2(quadrants(32, FOUR)),
    { width, height, levels, scheme, model, primaries, transfer } = header(bytes);
  assert.deepEqual([width, height, levels, scheme], [32, 32, 6, 1], 'BasisLZ, 32 to 1 is 6 levels');
  assert.deepEqual([model, primaries, transfer], [163, 1, 2], 'ETC1S, BT.709, sRGB');
  const decoded = pixels(bytes);
  assert.equal(decoded.srgb, true);
  assert.equal(decoded.mipmaps.length, 6);
  const error = quadrantError(decoded.mipmaps[0].data, 32);
  assert.ok(error <= ETC1S_FLAT, `worst ${error}`);
});

test('encodeKTX2 writes UASTC that keeps flat colour exactly, in a Zstandard file', async () => {
  const bytes = await encodeKTX2(quadrants(32, FOUR), { mode: 'uastc' }),
    { levels, scheme, model } = header(bytes);
  assert.deepEqual([levels, scheme, model], [6, 2, 166], 'Zstandard, UASTC');
  assert.equal(quadrantError(pixels(bytes).mipmaps[0].data, 32), UASTC_FLAT);
});

test('encodeKTX2 fills bytesPlane for what the file holds, as KTX-Software requires', async () => {
  const opaque = quadrants(16, FOUR),
    clear = { ...opaque, data: opaque.data.slice() };
  for (let i = 3; i < clear.data.length; i += 4) clear.data[i] = 90;
  assert.deepEqual(header(await encodeKTX2(opaque)).planes, [8, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(header(await encodeKTX2(clear)).planes, [8, 8, 0, 0, 0, 0, 0, 0], 'colour and alpha slices');
  assert.deepEqual(header(await encodeKTX2(clear, { mode: 'uastc' })).planes, [16, 0, 0, 0, 0, 0, 0, 0]);
});

test('encodeKTX2 keeps alpha through a transcode', async () => {
  const image = quadrants(16, FOUR);
  for (let i = 3; i < image.data.length; i += 4) image.data[i] = 90;
  const decoded = pixels(await encodeKTX2(image, { mode: 'uastc' }));
  assert.equal(decoded.hasAlpha, true);
  assert.equal(decoded.mipmaps[0].data[3], 90);
});

test('encodeKTX2 marks linear and normal-map files linear, with no colour primaries', async () => {
  for (const options of [{ colorSpace: 'linear' }, { normalMap: true }, { mode: 'uastc', normalMap: true }]) {
    const { primaries, transfer } = header(await encodeKTX2(quadrants(16, FOUR), options));
    assert.deepEqual([primaries, transfer], [0, 1], JSON.stringify(options));
  }
});

test('encodeKTX2 takes PNG and JPEG files, writes one level when asked and leaves the caller bytes alone', async () => {
  const png = await encodePNG(quadrants(16, FOUR)),
    copy = png.slice();
  assert.equal(header(await encodeKTX2(png, { mipmaps: false })).levels, 1);
  assert.deepEqual(png, copy);
  const jpeg = file('fixtures/jpeg/progressive-420.jpg'),
    { width, height, levels } = header(await encodeKTX2(jpeg));
  assert.deepEqual([width, height, levels], [53, 37, 6], 'any size outside glTF; 53 to 1 is 6 levels');
  const image = quadrants(16, FOUR);
  await encodeKTX2(image);
  assert.equal(image.data[0], 200);
});

test('encodeKTX2 uastcRDO makes a noisy image smaller on the wire', async () => {
  let state = 1;
  const data = new Uint8Array(64 * 64 * 4).map((_, i) => {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      return i % 4 === 3 ? 255 : 128 + ((state >>> 16) % 24);
    }),
    plain = await encodeKTX2({ width: 64, height: 64, data }, { mode: 'uastc' }),
    rdo = await encodeKTX2({ width: 64, height: 64, data }, { mode: 'uastc', uastcRDO: 4 });
  assert.ok(rdo.length < plain.length, `${rdo.length} against ${plain.length}`);
});

test('encodeKTX2 refuses bad input and stops on an abort', async () => {
  const image = quadrants(16, FOUR);
  await assert.rejects(encodeKTX2(image, { quality: 0 }), RangeError);
  await assert.rejects(encodeKTX2(image, { effort: 7 }), RangeError);
  await assert.rejects(encodeKTX2(image, { uastcLevel: 5 }), RangeError);
  await assert.rejects(encodeKTX2(image, { uastcRDO: 11 }), RangeError);
  await assert.rejects(encodeKTX2(image, { mode: 'astc' }), RangeError);
  await assert.rejects(encodeKTX2(image, { colorSpace: 'p3' }), RangeError);
  await assert.rejects(encodeKTX2({ ...image, width: 15 }), RangeError);
  await assert.rejects(encodeKTX2(new Uint8Array([1, 2, 3, 4])), TypeError);
  await assert.rejects(encodeKTX2(image, { signal: AbortSignal.abort() }), { name: 'AbortError' });
});

const quad = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: [0, 1, 2, 0, 2, 3],
  },
  texture = async (size = 16) => ({ image: await encodePNG(quadrants(size, FOUR)), mimeType: 'image/png' });

/** The KTX2 file a texture reads. */
function ktx2Of({ json, bin }, index) {
  const image = json.images[json.textures[index].extensions.KHR_texture_basisu.source],
    view = json.bufferViews[image.bufferView];
  assert.equal(image.mimeType, 'image/ktx2');
  return bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
}

test('compressTextures turns a real PNG file into a file the Khronos validator accepts, and drops the PNG', async () => {
  const source = file('fixtures/BoxTextured.glb'),
    before = await validate(source),
    { glb, compressed, skipped } = await compressTextures(source),
    report = await validate(glb),
    parts = splitGLB(glb),
    // The validator (2.0.0-dev.3.10) does not implement KHR_texture_basisu: it warns that image/ktx2 is no type it knows and
    // that it cannot read the image. Those two are that gap, once for each KTX2 image; anything else fails.
    unknown = ({ code, pointer }) =>
      (code === 'VALUE_NOT_IN_LIST' && pointer === '/images/0/mimeType') ||
      (code === 'IMAGE_UNRECOGNIZED_FORMAT' && pointer === '/images/0');
  assert.equal(compressed, 1);
  assert.deepEqual(skipped, []);
  assert.equal(report.errors, before.errors, JSON.stringify(report.messages));
  assert.deepEqual(
    report.messages.filter((message) => !unknown(message)),
    before.messages,
  );
  assert.equal(report.warnings, 2);
  assert.equal(parts.json.textures[0].source, undefined, 'no fallback');
  assert.ok(parts.json.extensionsRequired.includes('KHR_texture_basisu'));
  assert.ok(parts.json.extensionsUsed.includes('KHR_texture_basisu'));
  assert.equal(parts.json.images.length, 1);
  assert.equal(parts.json.textures[0].sampler, splitGLB(source).json.textures[0].sampler);
  const { width, height, mipmaps } = pixels(ktx2Of(parts, 0));
  assert.ok(width % 4 === 0 && height % 4 === 0);
  assert.equal(mipmaps.length, 1 + Math.floor(Math.log2(Math.max(width, height))));
});

test('compressTextures picks the format by what a material does with the texture', async () => {
  const glb = exportGLB({
      nodes: [
        {
          geometry: quad,
          material: {
            color: [1, 1, 1],
            baseColorTexture: await texture(),
            normalTexture: await texture(),
            metallicRoughnessTexture: await texture(),
            emissiveTexture: await texture(),
          },
        },
      ],
    }),
    parts = splitGLB((await compressTextures(glb)).glb),
    material = parts.json.materials[0],
    of = (info) => header(ktx2Of(parts, info.index));
  const color = of(material.pbrMetallicRoughness.baseColorTexture),
    emissive = of(material.emissiveTexture),
    normal = of(material.normalTexture),
    data = of(material.pbrMetallicRoughness.metallicRoughnessTexture);
  assert.deepEqual([color.scheme, color.transfer], [1, 2], 'colour: ETC1S, sRGB');
  assert.deepEqual([emissive.scheme, emissive.transfer], [1, 2], 'emissive: ETC1S, sRGB');
  assert.deepEqual([normal.scheme, normal.transfer, normal.primaries], [2, 1, 0], 'normal: UASTC, linear');
  assert.deepEqual([data.scheme, data.transfer, data.primaries], [2, 1, 0], 'data: UASTC, linear');
  const swapped = splitGLB((await compressTextures(glb, { color: 'uastc', data: 'etc1s', normal: 'etc1s' })).glb),
    material2 = swapped.json.materials[0];
  assert.equal(header(ktx2Of(swapped, material2.pbrMetallicRoughness.baseColorTexture.index)).scheme, 2);
  assert.equal(header(ktx2Of(swapped, material2.normalTexture.index)).scheme, 1);
  assert.equal(header(ktx2Of(swapped, material2.pbrMetallicRoughness.metallicRoughnessTexture.index)).scheme, 1);
});

/** A GLB of hand-made JSON around `images`, for shapes no writer here produces. */
function handmade(images, textures, material) {
  const views = [],
    list = [];
  let length = 0;
  const chunks = images.map(({ bytes, ...rest }) => {
    if (bytes) {
      views.push({ buffer: 0, byteOffset: length, byteLength: bytes.length });
      list.push({ ...rest, bufferView: views.length - 1 });
      const at = length;
      length = (length + bytes.length + 3) & ~3;
      return [bytes, at];
    }
    list.push(rest);
    return null;
  });
  const bin = length ? new Uint8Array(length) : null;
  for (const chunk of chunks) if (chunk) bin.set(chunk[0], chunk[1]);
  return joinGLB({
    json: {
      asset: { version: '2.0' },
      ...(length ? { buffers: [{ byteLength: length }], bufferViews: views } : {}),
      images: list,
      textures,
      materials: [material],
    },
    bin,
  });
}

test('compressTextures splits a texture read as both colour and data, and an image read in both roles', async () => {
  const png = await encodePNG(quadrants(16, FOUR)),
    glb = handmade([{ bytes: png, mimeType: 'image/png' }], [{ source: 0 }, { source: 0 }], {
      pbrMetallicRoughness: {
        baseColorTexture: { index: 0 },
        metallicRoughnessTexture: { index: 0 },
      },
      emissiveTexture: { index: 1 },
      normalTexture: { index: 1 },
      occlusionTexture: { index: 1 },
    }),
    { glb: out, compressed } = await compressTextures(glb),
    parts = splitGLB(out),
    [material] = parts.json.materials,
    base = material.pbrMetallicRoughness.baseColorTexture.index,
    rough = material.pbrMetallicRoughness.metallicRoughnessTexture.index;
  assert.equal(compressed, 5, 'a texture for each role: two of the first, three of the second');
  assert.notEqual(base, rough);
  assert.equal(header(ktx2Of(parts, base)).transfer, 2);
  assert.equal(header(ktx2Of(parts, rough)).transfer, 1);
  assert.equal(parts.json.images.length, 3, 'one image in each of three roles, however many textures read it');
  assert.equal(
    parts.json.textures[base].extensions.KHR_texture_basisu.source,
    parts.json.textures[material.emissiveTexture.index].extensions.KHR_texture_basisu.source,
  );
  assert.notEqual(material.normalTexture.index, material.occlusionTexture.index);
  assert.equal(parts.json.bufferViews.length, 3, 'the PNG left the file');
});

test('compressTextures grows a texture to multiples of 4 and reads a JPEG, in Node as in a browser', async () => {
  const jpeg = file('fixtures/jpeg/baseline-420.jpg'),
    glb = handmade([{ bytes: jpeg, mimeType: 'image/jpeg' }], [{ source: 0 }], {
      pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
    }),
    parts = splitGLB((await compressTextures(glb)).glb),
    { width, height } = header(ktx2Of(parts, 0));
  assert.deepEqual([width, height], [56, 40], '53 x 37 to the next multiples of 4');
});

test('compressTextures reads a data URI and adds the BIN chunk it needs', async () => {
  const png = await encodePNG(quadrants(16, FOUR)),
    uri = `data:image/png;base64,${Buffer.from(png).toString('base64')}`,
    glb = handmade([{ uri }], [{ source: 0 }], { pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }),
    parts = splitGLB((await compressTextures(glb)).glb);
  assert.equal(parts.json.images.length, 1);
  assert.equal(parts.json.images[0].uri, undefined);
  assert.equal(header(ktx2Of(parts, 0)).width, 16);
});

test('compressTextures leaves what it cannot compress, says why, and returns the input when nothing changed', async () => {
  const png = await encodePNG(quadrants(16, FOUR)),
    webp = new TextEncoder().encode('RIFF....WEBPVP8L'),
    glb = handmade(
      [{ uri: 'wood.png' }, { bytes: webp, mimeType: 'image/webp' }, { bytes: png, mimeType: 'image/png' }],
      [{ source: 0 }, { source: 1 }, { source: 2 }, { extensions: { EXT_texture_webp: { source: 1 } } }],
      {
        pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicRoughnessTexture: { index: 1 } },
        emissiveTexture: { index: 3 },
      },
    ),
    result = await compressTextures(glb);
  assert.equal(result.compressed, 0);
  assert.equal(result.glb, glb);
  assert.deepEqual(result.skipped, [
    { texture: 0, reason: 'external-image' },
    { texture: 1, reason: 'not-png-or-jpeg' },
    { texture: 2, reason: 'not-on-a-material' },
    { texture: 3, reason: 'other-image-extension' },
  ]);
});

test('compressTextures on its own output has nothing to do', async () => {
  const { glb } = await compressTextures(file('fixtures/BoxTextured.glb')),
    again = await compressTextures(glb);
  assert.equal(again.glb, glb);
  assert.deepEqual(again.skipped, [{ texture: 0, reason: 'already-compressed' }]);
});

test('compressTextures keeps images other textures still read and renumbers them', async () => {
  const png = await encodePNG(quadrants(16, FOUR)),
    glb = handmade([{ bytes: png, mimeType: 'image/png' }, { uri: 'stays.png' }], [{ source: 0 }, { source: 1 }], {
      pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
      emissiveTexture: { index: 1 },
    }),
    { json } = splitGLB((await compressTextures(glb)).glb);
  assert.equal(json.images.length, 2);
  assert.equal(json.images[json.textures[1].source].uri, 'stays.png');
  assert.equal(json.images[json.textures[0].extensions.KHR_texture_basisu.source].mimeType, 'image/ktx2');
});

test('compressTextures refuses a texture that reads no image and stops on an abort', async () => {
  const bad = handmade([{ uri: 'a.png' }], [{ source: 4 }], {
    pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
  });
  await assert.rejects(compressTextures(bad), RangeError);
  await assert.rejects(compressTextures(file('fixtures/BoxTextured.glb'), { signal: AbortSignal.abort() }), {
    name: 'AbortError',
  });
  await assert.rejects(compressTextures(file('fixtures/BoxTextured.glb'), { color: 'jpeg' }), RangeError);
});
