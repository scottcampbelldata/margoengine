import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { KTX2HDR6Decoder } from '../dist/ktx2-hdr6.js';
import { decodeHDR6 } from '../dist/ktx2-hdr6-codec.js';
import { readKTX2Index } from '../dist/ktx2-file.js';

const folder = new URL('./fixtures/ktx2-hdr6/', import.meta.url);
const records = JSON.parse(await readFile(new URL('records.json', folder)));
const fixture = async (name) => new Uint8Array(await readFile(new URL(name, folder)));
const hash = (data) => createHash('sha256').update(data).digest('hex');
const native = async () =>
  (await WebAssembly.instantiate(await readFile(new URL('../dist/hdr6.wasm', import.meta.url)))).instance.exports;

test('HDR6 clean-room output matches the independent transcoder for native, intermediate and legacy files, every mip', {
  timeout: 30000,
}, async () => {
  const module = await native();
  for (const [name, record] of Object.entries(records.files)) {
    const bytes = await fixture(name);
    assert.equal(hash(bytes), record.sha256);
    for (const [target, key] of [
      ['rgba16float', 'half'],
      ['astc-hdr-6x6', 'astc'],
      ['rgb9e5', 'rgb9e5'],
    ]) {
      const file = await decodeHDR6(module, bytes, target);
      assert.equal(file.width, record.width);
      assert.equal(file.height, record.height);
      assert.equal(file.layers, 1);
      assert.equal(file.srgb, false);
      assert.equal(file.mipmaps.length, record.levels.length);
      file.mipmaps.forEach((mip, level) =>
        assert.equal(hash(mip.data), record.levels[level][key], `${name} ${target} level ${level}`),
      );
    }
  }
});

test('HDR6 Node worker_threads decodes, transfers, pools concurrent jobs and restarts after disposal', {
  timeout: 30000,
}, async () => {
  const decoder = new KTX2HDR6Decoder({ workerLimit: 2 });
  const name = 'intermediate-real.ktx2';
  try {
    const bytes = await fixture(name),
      original = hash(bytes);
    const results = await Promise.all(Array.from({ length: 5 }, () => decoder.decode(bytes)));
    for (const file of results) assert.equal(hash(file.mipmaps[0].data), records.files[name].levels[0].half);
    assert.equal(hash(bytes), original);
    const transferred = (await fixture(name)).buffer;
    await decoder.decode(transferred, { transfer: true });
    assert.equal(transferred.byteLength, 0);
    decoder.dispose();
    assert.equal((await decoder.decode(bytes)).width, records.files[name].width);
  } finally {
    decoder.dispose();
  }
});

test('HDR6 abort, dimensions, malformed headers, scheme-4 seek tables and damaged streams reject', {
  timeout: 30000,
}, async () => {
  const module = await native();
  const bytes = await fixture('intermediate-noise.ktx2'),
    index = readKTX2Index(bytes);
  const bad = async (mutate) => {
    const copy = bytes.slice();
    mutate(copy, new DataView(copy.buffer));
    await assert.rejects(decodeHDR6(module, copy, 'rgba16float'));
  };
  await bad((data) => {
    data[0] = 0;
  });
  await bad((data, view) => {
    view.setUint32(44, 1, true);
  });
  await bad((data) => {
    data[index.dfd.offset + 12] = 166;
  });
  await bad((data) => {
    data[index.dfd.offset + 16] = 3;
  });
  await bad((data, view) => {
    view.setUint32(index.globalData.offset + 4, 0xffffffff, true);
  });
  await bad((data) => {
    data[index.levels[0].offset] = 0;
  });
  await bad((data, view) => {
    view.setUint16(index.levels[0].offset + 2, 0, true);
  });
  await assert.rejects(decodeHDR6(module, bytes.subarray(0, bytes.length - 1), 'rgba16float'));
  await assert.rejects(decodeHDR6(module, bytes, 'rgba16float', { maxPixels: 1 }), /maxPixels/);
  await assert.rejects(decodeHDR6(module, bytes, 'rgba16float', { maxPixels: Infinity }), /positive safe integer/);
  const controller = new AbortController();
  controller.abort(new Error('cancelled-hdr6'));
  await assert.rejects(decodeHDR6(module, bytes, 'rgba16float', { signal: controller.signal }), /cancelled-hdr6/);
  const decoder = new KTX2HDR6Decoder();
  try {
    await assert.rejects(decoder.decode(bytes, { signal: controller.signal }), /cancelled-hdr6/);
  } finally {
    decoder.dispose();
  }
});

test('HDR6 validates its options without creating a worker', async () => {
  assert.throws(() => new KTX2HDR6Decoder({ target: 'bad' }), /target/);
  assert.throws(() => new KTX2HDR6Decoder({ workerLimit: 0 }), /workerLimit/);
  assert.throws(() => new KTX2HDR6Decoder({ timeout: 0 }), /timeout/);
  const decoder = new KTX2HDR6Decoder();
  try {
    await assert.rejects(decoder.createTexture(new ArrayBuffer(0)), /device/);
  } finally {
    decoder.dispose();
  }
});

test('native and intermediate arrays, cubes and cube arrays keep every image in WebGPU order', {
  timeout: 30000,
}, async () => {
  const module = await native();
  for (const intermediate of [false, true])
    for (const [layers, faces] of [
      [2, 1],
      [0, 6],
      [2, 6],
    ]) {
      const source = await fixture(intermediate ? 'intermediate-ramp.ktx2' : 'astc-ramp.ktx2');
      const descriptor = readKTX2Index(source).dfd;
      const images = Math.max(1, layers) * faces,
        mipCount = 3;
      const globalAt = 80 + mipCount * 24 + descriptor.length;
      const globalBytes = intermediate ? mipCount * images * 12 : 0;
      const payloadAt = globalAt + globalBytes,
        imageBytes = intermediate ? 14 : 16;
      const file = new Uint8Array(payloadAt + mipCount * images * imageBytes),
        view = new DataView(file.buffer);
      file.set(source.subarray(0, 80));
      for (const [at, value] of [
        [20, 6],
        [24, 6],
        [28, 0],
        [32, layers],
        [36, faces],
        [40, mipCount],
        [44, intermediate ? 4 : 0],
        [48, 80 + mipCount * 24],
        [56, 0],
        [60, 0],
      ])
        view.setUint32(at, value, true);
      view.setBigUint64(64, intermediate ? BigInt(globalAt) : 0n, true);
      view.setBigUint64(72, BigInt(globalBytes), true);
      file.set(source.subarray(descriptor.offset, descriptor.offset + descriptor.length), 80 + mipCount * 24);
      for (let mip = 0; mip < mipCount; mip++) {
        const edge = Math.max(1, 6 >> mip),
          size = imageBytes * images,
          start = payloadAt + mip * size;
        view.setBigUint64(80 + mip * 24, BigInt(start), true);
        view.setBigUint64(88 + mip * 24, BigInt(size), true);
        view.setBigUint64(96 + mip * 24, intermediate ? 0n : BigInt(size), true);
        for (let image = 0; image < images; image++) {
          const color = [0x3c00 + image * 32, 0x4000 + mip * 64, 0x4200, 0x3c00],
            at = start + image * imageBytes;
          if (intermediate) {
            const entry = globalAt + (mip * images + image) * 12;
            view.setUint32(entry, image * imageBytes, true);
            view.setUint32(entry + 4, imageBytes, true);
            view.setUint32(entry + 8, 0xabce, true);
            view.setUint16(at, 0xabce, true);
            view.setUint16(at + 2, edge, true);
            view.setUint16(at + 4, edge, true);
            let bits = 4n | (BigInt(color[0]) << 3n) | (BigInt(color[1]) << 18n) | (BigInt(color[2]) << 33n);
            for (let b = 0; b < 6; b++) {
              file[at + 6 + b] = Number(bits & 255n);
              bits >>= 8n;
            }
            view.setUint16(at + 12, 0xa742, true);
          } else {
            file.set([0xfc, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], at);
            color.forEach((value, c) => view.setUint16(at + 8 + c * 2, value, true));
          }
        }
      }
      const decoded = await decodeHDR6(module, file, 'rgba16float');
      assert.equal(decoded.layers, images);
      assert.equal(decoded.dimension, faces === 6 ? (layers ? 'cube-array' : 'cube') : '2d-array');
      for (let mip = 0; mip < mipCount; mip++) {
        const edge = Math.max(1, 6 >> mip),
          data = new Uint16Array(decoded.mipmaps[mip].data.buffer);
        for (let image = 0; image < images; image++)
          for (let pixel = 0; pixel < edge * edge; pixel++)
            assert.deepEqual(
              [...data.subarray((image * edge * edge + pixel) * 4, (image * edge * edge + pixel + 1) * 4)],
              [0x3c00 + image * 32, 0x4000 + mip * 64, 0x4200, 0x3c00],
            );
      }
    }
});
