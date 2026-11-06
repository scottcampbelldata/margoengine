// UASTC HDR KTX2 (@margoengine/decoders/ktx2-hdr) on real files: the fixtures were written by the official Basis Universal
// 1.50 encoder from the EXR files named in fixtures/ktx2-hdr/NOTICE.md, whose sampled pixels are in records.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transcodeKTX2, transcodeKTX2HDR, transcodeKTX2Layers } from '../dist/codec.js';
import { getSupportedHDRFormat, KTX2HDRDecoder, toEnvironmentImage } from '../dist/ktx2-hdr.js';
import { basis, fixture as ldrFixture, sha } from './support/ktx2.js';

const folder = new URL('./fixtures/ktx2-hdr/', import.meta.url),
  fixture = async (name) => new Uint8Array(await readFile(new URL(name, folder))),
  records = JSON.parse(await readFile(new URL('records.json', folder), 'utf8'));

test('half-float output keeps the real EXR pixels, values over 1 included', async () => {
  const module = await basis();
  for (const [name, record] of Object.entries(records.files)) {
    const file = transcodeKTX2HDR(module, await fixture(name), 'rgba16float'),
      image = toEnvironmentImage(file),
      data = image.data ?? image.faces[0],
      width = image.width ?? image.size;
    assert.equal(file.format, 'rgba16float');
    assert.equal(file.transcoded, 'rgba16float');
    assert.equal(file.srgb, false);
    assert.equal(file.mipmaps.length, record.levels, name);
    let worst = 0;
    for (const [x, y, r, g, b] of record.samples) {
      const at = (y * width + x) * 4;
      [r, g, b].forEach((value, channel) => {
        worst = Math.max(worst, Math.abs(data[at + channel] - value) / Math.max(value, 0.05));
      });
      assert.equal(data[at + 3], 1, 'opaque');
    }
    assert.ok(worst < record.worst, `${name}: worst relative error ${worst} against the EXR, recorded ${record.worst}`);
  }
});

test('every target has the right size, format and feature', async () => {
  const module = await basis(),
    bytes = await fixture('this-way-up-uastc-hdr.ktx2');
  for (const [target, format, feature, block, bytesEach] of [
    ['bc6h', 'bc6h-rgb-ufloat', 'texture-compression-bc', 4, 16],
    ['astc-hdr-4x4', 'astc-4x4-hdr', undefined, 4, 16],
    ['rgba16float', 'rgba16float', undefined, 1, 8],
    ['rgb9e5', 'rgb9e5ufloat', undefined, 1, 4],
  ]) {
    const file = transcodeKTX2HDR(module, bytes, target);
    assert.equal(file.format, format);
    assert.equal(file.feature, feature);
    assert.equal(file.transcoded, target);
    assert.equal(file.mipmaps.length, 8);
    file.mipmaps.forEach((mip) =>
      assert.equal(mip.byteLength, Math.ceil(mip.width / block) * Math.ceil(mip.height / block) * bytesEach, target),
    );
    assert.ok(file.mipmaps[0].data.some((v) => v !== 0));
  }
});

test('a cube file keeps six different faces, and BC6H falls back when level 0 is not whole blocks', async () => {
  const module = await basis(),
    cube = transcodeKTX2HDR(module, await fixture('cube-uastc-hdr.ktx2'), 'bc6h');
  assert.equal(cube.dimension, 'cube');
  assert.equal(cube.layers, 6);
  assert.equal(cube.format, 'bc6h-rgb-ufloat');
  const size = cube.mipmaps[0].byteLength / 6,
    faces = Array.from({ length: 6 }, (_, i) => sha(cube.mipmaps[0].data.subarray(i * size, (i + 1) * size)));
  assert.equal(new Set(faces).size, 6);
  const image = toEnvironmentImage(transcodeKTX2HDR(module, await fixture('cube-uastc-hdr.ktx2'), 'rgba16float'));
  assert.equal(image.size, 96);
  assert.equal(image.faces.length, 6);
  assert.equal(image.faces[5].length, 96 * 96 * 4);
  const odd = transcodeKTX2HDR(module, await fixture('odd-uastc-hdr.ktx2'), 'bc6h');
  assert.equal(odd.transcoded, 'rgba16float');
  assert.equal(odd.format, 'rgba16float');
  assert.equal(odd.width % 4 || odd.height % 4 ? 1 : 0, 1, 'the fixture is not whole blocks');
});

test('negotiation and refusals', async () => {
  const module = await basis(),
    hdr = await fixture('this-way-up-uastc-hdr.ktx2'),
    ldr = await ldrFixture('cube-uastc-zstd.ktx2');
  assert.equal(getSupportedHDRFormat({ features: new Set(['texture-compression-bc']) }), 'bc6h');
  assert.equal(getSupportedHDRFormat({ features: new Set(['texture-compression-astc']) }), 'rgba16float');
  assert.equal(getSupportedHDRFormat(), 'rgba16float');
  assert.equal(new KTX2HDRDecoder().hdrTarget, 'rgba16float');
  assert.throws(() => new KTX2HDRDecoder({ target: 'nope' }), /Unknown HDR target/);
  assert.throws(() => transcodeKTX2HDR(module, hdr, 'nope'), /Unknown HDR target/);
  assert.throws(() => transcodeKTX2HDR(module, ldr, 'bc6h'), /not HDR/);
  // The 8-bit decoders point here instead of refusing without a route.
  assert.throws(() => transcodeKTX2(module, hdr, 'rgba8'), /KTX2HDRDecoder/);
  assert.throws(() => transcodeKTX2Layers(module, hdr, 'rgba8'), /KTX2HDRDecoder/);
  const astc = new KTX2HDRDecoder({ device: { features: new Set() }, target: 'astc-hdr-4x4' });
  await assert.rejects(astc.createTexture(hdr), { code: 'unsupported' });
  await assert.rejects(new KTX2HDRDecoder().createTexture(hdr), /needs a device/);
  assert.throws(() => toEnvironmentImage(transcodeKTX2HDR(module, hdr, 'bc6h')), /rgba16float/);
});
