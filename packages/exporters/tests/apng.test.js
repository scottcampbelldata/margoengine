import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { encodeAPNG } from '@margoengine/exporters/apng';
import { crc32 } from '../../shared/crc32.js';

// Walks the chunks, checking every CRC against the bytes, and undoes the Sub filter the encoder's rows use.
function walk(file) {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength),
    chunks = [];
  assert.deepEqual([...file.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  for (let at = 8; at < file.length; ) {
    const length = view.getUint32(at),
      type = String.fromCharCode(...file.subarray(at + 4, at + 8)),
      body = file.subarray(at + 8, at + 8 + length);
    assert.equal(view.getUint32(at + 8 + length), crc32(file.subarray(at + 4, at + 8 + length)), `${type} CRC`);
    chunks.push({ type, body, view: new DataView(body.buffer, body.byteOffset, body.byteLength) });
    at += 12 + length;
  }
  return chunks;
}
function rows(zlib, width, height) {
  const filtered = inflateSync(zlib),
    stride = width * 4,
    out = new Uint8Array(stride * height);
  assert.equal(filtered.length, (stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    assert.equal(filtered[start], 1, 'Sub filter');
    for (let x = 0; x < stride; x++)
      out[y * stride + x] = filtered[start + 1 + x] + (x < 4 ? 0 : out[y * stride + x - 4]);
  }
  return out;
}

const frameA = {
    data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 128, 9, 8, 7, 0]),
    width: 2,
    height: 2,
  },
  frameB = {
    data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
    width: 2,
    height: 2,
  };

test('a 2-frame 2x2 APNG has the chunks of the PNG third edition, in order, with pixels and CRCs exact', async () => {
  const chunks = walk(await encodeAPNG(2, (i) => (i ? frameB : frameA), { fps: 12, loops: 3 }));
  assert.deepEqual(
    chunks.map((c) => c.type),
    ['IHDR', 'acTL', 'fcTL', 'IDAT', 'fcTL', 'fdAT', 'IEND'],
  );
  const [ihdr, actl, fctl0, idat, fctl1, fdat] = chunks;
  assert.deepEqual([...ihdr.body], [0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0, 0, 0]);
  assert.deepEqual([...actl.body], [0, 0, 0, 2, 0, 0, 0, 3]);
  // Sequence, width, height, x, y, delay 1/12, dispose none, blend source.
  assert.deepEqual([...fctl0.body], [0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 12, 0, 0]);
  assert.deepEqual([...fctl1.body], [0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 12, 0, 0]);
  assert.equal(fdat.view.getUint32(0), 2, 'one sequence shared by fcTL and fdAT');
  assert.deepEqual(rows(idat.body, 2, 2), frameA.data);
  assert.deepEqual(rows(fdat.body.subarray(4), 2, 2), frameB.data);
});

test('sequence numbers count from 0 without a gap over many frames', async () => {
  const chunks = walk(await encodeAPNG(5, () => frameA)),
    numbers = chunks.filter((c) => c.type === 'fcTL' || c.type === 'fdAT').map((c) => c.view.getUint32(0));
  assert.deepEqual(numbers, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(chunks.filter((c) => c.type === 'IDAT').length, 1);
  assert.equal(chunks[1].view.getUint32(0), 5);
});

test('delays sum exactly: whole rates as 1/fps, others as whole milliseconds rounded cumulatively', async () => {
  const delays = async (fps, count) =>
    walk(await encodeAPNG(count, () => frameA, { fps }))
      .filter((c) => c.type === 'fcTL')
      .map((c) => [c.view.getUint16(20), c.view.getUint16(22)]);
  assert.deepEqual(await delays(30, 2), [
    [1, 30],
    [1, 30],
  ]);
  const fractional = await delays(29.97, 2997),
    total = fractional.reduce((sum, [n, d]) => (assert.equal(d, 1000), sum + n), 0);
  assert.equal(total, 100000);
  assert.ok(fractional.every(([n]) => n === 33 || n === 34));
});

test('dispose and blend ops reach every frame control', async () => {
  const controls = walk(await encodeAPNG(2, () => frameA, { dispose: 'background', blend: 'over' })).filter(
    (c) => c.type === 'fcTL',
  );
  for (const control of controls) assert.deepEqual([control.body[24], control.body[25]], [1, 1]);
  const previous = walk(await encodeAPNG(1, () => frameA, { dispose: 'previous' })).find((c) => c.type === 'fcTL');
  assert.deepEqual([previous.body[24], previous.body[25]], [2, 0]);
});

test('a frame of another size, bad pixels and bad options are refused with the fix named', async () => {
  await assert.rejects(
    encodeAPNG(2, (i) => (i ? { data: new Uint8Array(4), width: 1, height: 1 } : frameA)),
    /APNG frame 1 is 1x1, not 2x2; capture every frame at one size/,
  );
  await assert.rejects(
    encodeAPNG(1, () => ({ data: new Uint8Array(3), width: 1, height: 1 })),
    RangeError,
  );
  await assert.rejects(
    encodeAPNG(0, () => frameA),
    /Frame count 0/,
  );
  await assert.rejects(
    encodeAPNG(1, () => frameA, { fps: 0 }),
    /fps 0/,
  );
  await assert.rejects(
    encodeAPNG(1, () => frameA, { fps: 1001 }),
    /fps 1001/,
  );
  await assert.rejects(
    encodeAPNG(1, () => frameA, { loops: -1 }),
    /loops -1/,
  );
  await assert.rejects(
    encodeAPNG(1, () => frameA, { dispose: 'toString' }),
    TypeError,
  );
  await assert.rejects(
    encodeAPNG(1, () => frameA, { blend: 'add' }),
    TypeError,
  );
});
