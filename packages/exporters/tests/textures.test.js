import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeTexture, resizeTexture, textureFormatSupported, transformTextures } from '@margoengine/exporters/textures';
import { joinGLB, splitGLB } from '@margoengine/exporters';
import { decodePNG } from '@margoengine/decoders/png';
import { encodeWebP } from '@margoengine/exporters/webp';

const pixels = (values) => ({ width: values.length, height: 1, data: Uint8Array.from(values.flat()) });
const bw = pixels([[0, 0, 0, 255], [255, 255, 255, 255]]);
const rgba = (image) => [...image.data];

for (const filter of ['box', 'bilinear', 'lanczos']) {
  test(`${filter}: sRGB averaging is linear light and alpha is linear`, () => {
    const srgb = resizeTexture(bw, { width: 1, filter });
    assert.deepEqual(rgba(srgb), [188, 188, 188, 255]);
    assert.deepEqual(rgba(resizeTexture(bw, { width: 1, filter, colorSpace: 'linear' })), [128, 128, 128, 255]);
    const edge = pixels([[255, 0, 0, 0], [0, 0, 255, 255]]);
    assert.deepEqual(rgba(resizeTexture(edge, { width: 1, filter })), [0, 0, 255, 128]);
    assert.deepEqual(rgba(resizeTexture(edge, { width: 1, filter, colorSpace: 'linear' })), [128, 0, 128, 128]);
  });
  test(`${filter}: constants survive anisotropic resize, all-zero alpha stays finite`, () => {
    const flat = { width: 7, height: 3, data: Uint8Array.from({ length: 84 }, (_, i) => [17, 88, 231, 120][i % 4]) };
    const result = resizeTexture(flat, { width: 3, height: 8, filter });
    assert.equal(result.data.length, 96);
    for (let i = 0; i < result.data.length; i++) assert.equal(result.data[i], [17, 88, 231, 120][i % 4]);
    assert.deepEqual(rgba(resizeTexture(pixels([[255, 99, 3, 0], [19, 11, 230, 0]]), { width: 1, filter })), [0, 0, 0, 0]);
  });
}

test('box integrates fractional footprints and bilinear places pixel centres correctly', () => {
  const ramp = pixels([[0, 0, 0, 255], [90, 90, 90, 255], [180, 180, 180, 255]]);
  assert.deepEqual(rgba(resizeTexture(ramp, { width: 2, filter: 'box', colorSpace: 'linear' })), [30, 30, 30, 255, 150, 150, 150, 255]);
  assert.deepEqual(rgba(resizeTexture(bw, { width: 3, height: 1, filter: 'bilinear', colorSpace: 'linear' })), [0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255]);
});

test('all minification kernels antialias high frequency alternating pixels', () => {
  const stripe = { width: 64, height: 8, data: Uint8Array.from({ length: 64 * 8 * 4 }, (_, i) => i % 4 === 3 ? 255 : (Math.floor(i / 4) % 2) * 255) };
  for (const filter of ['box', 'bilinear', 'lanczos']) {
    const image = resizeTexture(stripe, { width: 8, height: 1, filter, colorSpace: 'linear' });
    // Interior samples must average the Nyquist stripe, rather than select one source pixel.
    for (let x = 2; x < 6; x++) assert.ok(Math.abs(image.data[x * 4] - 127.5) <= 1);
  }
});

test('dimensions, ownership, validation, cancellation and bounded allocations', () => {
  const input = { width: 8, height: 4, data: new Uint8Array(128) };
  assert.deepEqual([resizeTexture(input, { maxSize: 3 }).width, resizeTexture(input, { maxSize: 3 }).height], [3, 2]);
  assert.equal(resizeTexture(input, { height: 2 }).width, 4);
  const copy = resizeTexture(input);
  assert.notEqual(copy.data, input.data);
  for (const options of [{ width: NaN }, { maxSize: 0 }, { height: 1.5 }, { width: 16385 }, { colorSpace: 'bad' }, { filter: 'bad' }, { width: 8192, height: 8192 }])
    assert.throws(() => resizeTexture(input, options), RangeError);
  assert.throws(() => resizeTexture({ ...input, data: new Uint8Array(4) }), RangeError);
  assert.throws(() => resizeTexture({ ...input, data: [] }), TypeError);
  const controller = new AbortController();
  controller.abort(new Error('stop texture'));
  assert.throws(() => resizeTexture(input, { signal: controller.signal }), /stop texture/);
});

test('PNG encode, encoded PNG/JPEG input and MIME/quality validation work in Node', async () => {
  const encoded = await encodeTexture(bw, { format: 'png', width: 1, filter: 'box' });
  assert.equal(encoded.mimeType, 'image/png');
  assert.deepEqual(rgba(decodePNG(encoded.data)), [188, 188, 188, 255]);
  assert.deepEqual((await encodeTexture(encoded.data, { format: 'png' })).data, encoded.data);
  const jpeg = new Uint8Array(readFileSync(new URL('./fixtures/jpeg/progressive-420.jpg', import.meta.url)));
  const resized = await encodeTexture(jpeg, { format: 'png', maxSize: 8 });
  assert.equal(resized.width, 8);
  assert.equal(resized.height, 6);
  for (const options of [{ quality: NaN }, { quality: 2 }, { format: 'bad' }]) await assert.rejects(encodeTexture(bw, options), RangeError);
  for (const format of ['webp', 'avif']) {
    assert.equal(await textureFormatSupported(format), false);
    await assert.rejects(encodeTexture(bw, { format }), error => error.code === 'unsupported' && error.message.includes(`image/${format}`) && error.message.includes('https://'));
  }
});

// Deterministic platform double verifies the AVIF path and extension contract even on Chromium,
// whose canvas currently cannot serialize AVIF. Real browser tests exercise native capability detection.
function platform(t, { formatFallback = false, dom = false, hang = false, empty = false, fail = false } = {}) {
  const originals = Object.fromEntries(['OffscreenCanvas', 'ImageData', 'document'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  t.after(() => {
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  class Canvas {
    constructor(width = 1, height = 1) { this.width = width; this.height = height; }
    getContext() { return { putImageData: image => { this.image = image; } }; }
    async convertToBlob({ type }) {
      if (hang) return new Promise(() => {});
      if (fail) throw new Error('platform failed');
      if (empty) return null;
      const data = type === 'image/webp' && this.image ? await encodeWebP(this.image) : Uint8Array.of(0, 0, 0, 16, 102, 116, 121, 112, 97, 118, 105, 102, 0, 0, 0, 0);
      return new Blob([data], { type: formatFallback ? 'image/png' : type });
    }
  }
  globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
  if (dom) {
    globalThis.OffscreenCanvas = undefined;
    globalThis.document = { createElement: () => {
      const c = new Canvas();
      const convert = Canvas.prototype.convertToBlob;
      Object.setPrototypeOf(c, { getContext: Canvas.prototype.getContext });
      c.toBlob = (done, type, quality) => convert.call(c, { type, quality }).then(done);
      return c;
    } };
  } else globalThis.OffscreenCanvas = Canvas;
}

async function fixture() {
  const png = (await encodeTexture(bw, { format: 'png' })).data;
  return joinGLB({ json: {
    asset: { version: '2.0' }, images: [{ bufferView: 0, mimeType: 'image/png', name: 'black-white', extras: { asset: 'owned' } }],
    textures: [{ source: 0, sampler: 0, extras: { retained: true } }], samplers: [{ wrapS: 33071 }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0, texCoord: 1 }, metallicRoughnessTexture: { index: 0 } } }],
    buffers: [{ byteLength: png.length }], bufferViews: [{ buffer: 0, byteLength: png.length }],
  }, bin: png, chunks: [] });
}
const embedded = (parts, image) => {
  const view = parts.json.bufferViews[image.bufferView];
  return parts.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
};

for (const format of ['webp', 'avif']) test(`${format}: GLB fallback, role split, required metadata, reprocessing and image compaction`, async t => {
  platform(t);
  const input = await fixture(), before = input.slice(), ext = `EXT_texture_${format}`;
  const result = await transformTextures(input, { format, width: 1, filter: 'box', fallback: 'png' });
  const parts = splitGLB(result.glb), j = parts.json;
  assert.equal(result.transformed, 2);
  assert.deepEqual(input, before);
  assert.equal(j.images.length, 4);
  assert.equal(j.textures.length, 2);
  assert.deepEqual(j.extensionsUsed, [ext]);
  assert.equal(j.extensionsRequired, undefined);
  assert.equal(j.materials[0].pbrMetallicRoughness.metallicRoughnessTexture.index, 1);
  assert.equal(j.materials[0].pbrMetallicRoughness.baseColorTexture.texCoord, 1);
  for (let i = 0; i < 2; i++) {
    const texture = j.textures[i];
    assert.equal(texture.sampler, 0);
    assert.deepEqual(texture.extras, { retained: true });
    assert.equal(j.images[texture.extensions[ext].source].mimeType, `image/${format}`);
    const payload = embedded(parts, j.images[texture.extensions[ext].source]);
    assert.equal(new TextDecoder().decode(payload.subarray(format === 'webp' ? 0 : 4, format === 'webp' ? 4 : 8)), format === 'webp' ? 'RIFF' : 'ftyp');
    assert.deepEqual(j.images[texture.source].extras, { asset: 'owned' });
    assert.equal(j.images[texture.source].mimeType, 'image/png');
    assert.deepEqual(rgba(decodePNG(embedded(parts, j.images[texture.source]))), [i ? 128 : 188, i ? 128 : 188, i ? 128 : 188, 255]);
  }
  const required = splitGLB((await transformTextures(input, { format })).glb).json;
  assert.deepEqual(required.extensionsRequired, [ext]);
  assert.ok(required.textures.every(t => t.source === undefined));
  const png = splitGLB((await transformTextures(result.glb, { format: 'png' })).glb).json;
  assert.equal(png.extensionsUsed, undefined);
  assert.equal(png.extensionsRequired, undefined);
  assert.equal(png.images.length, 2);
});

test('DOM toBlob, unsupported MIME substitution, platform failures and cancellation', async t => {
  await t.test('DOM canvas only', async t => {
    platform(t, { dom: true });
    assert.equal(await textureFormatSupported('avif'), true);
    assert.equal((await encodeTexture(bw, { format: 'avif' })).mimeType, 'image/avif');
  });
  await t.test('silent substitution', async t => {
    platform(t, { formatFallback: true });
    assert.equal(await textureFormatSupported('avif'), false);
    await assert.rejects(encodeTexture(bw, { format: 'avif' }), e => e.code === 'unsupported' && /image\/avif/.test(e.message));
  });
  await t.test('null blob', async t => {
    platform(t, { empty: true });
    await assert.rejects(encodeTexture(bw), e => e.code === 'failed');
  });
  await t.test('platform rejection propagates', async t => {
    platform(t, { fail: true });
    await assert.rejects(textureFormatSupported('avif'), /platform failed/);
  });
  await t.test('abort a pending encode', async t => {
    platform(t, { hang: true });
    const controller = new AbortController(), pending = encodeTexture(bw, { signal: controller.signal });
    controller.abort(new Error('abort pending encoder'));
    await assert.rejects(pending, /abort pending encoder/);
  });
});

test('GLB PNG works without platform, JPEG fallback, external resolver and malformed images', async t => {
  const input = await fixture();
  const png = await transformTextures(input, { format: 'png', width: 1, filter: 'box' });
  assert.equal(png.transformed, 2);
  const parts = splitGLB(input);
  const image = embedded(parts, parts.json.images[0]).slice();
  parts.json.images[0] = { uri: 'textures/albedo.png' };
  const external = joinGLB(parts);
  await assert.rejects(transformTextures(external, { format: 'png' }), e => e.code === 'unsupported' && /resolveImage/.test(e.message));
  assert.equal((await transformTextures(external, { format: 'png', resolveImage: async uri => { assert.equal(uri, 'textures/albedo.png'); return image; } })).transformed, 2);
  parts.json.images[0] = { uri: `data:image/png;base64,${Buffer.from(image).toString('base64')}` };
  assert.equal((await transformTextures(joinGLB(parts), { format: 'png' })).transformed, 2);
  parts.json.images[0] = { bufferView: 900, mimeType: 'image/png' };
  await assert.rejects(transformTextures(joinGLB(parts), { format: 'png' }), RangeError);
  const empty = joinGLB({ json: { asset: { version: '2.0' } }, bin: null, chunks: [] });
  assert.equal((await transformTextures(empty)).glb, empty);
  await assert.rejects(transformTextures(input, { fallback: 'webp' }), RangeError);
  platform(t);
  const fallback = splitGLB((await transformTextures(input, { fallback: 'jpeg' })).glb).json;
  assert.equal(fallback.images.filter(i => i.mimeType === 'image/jpeg').length, 2);
});
