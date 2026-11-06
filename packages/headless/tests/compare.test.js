import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { encodePNG } from '../dist/index.js';
import { compareImages, decodePNG, pixelDiff, ssim } from '../dist/compare.js';

const flat = (width, height, [r, g, b, a = 255]) => {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([r, g, b, a], i);
  return { width, height, data };
};
/** A seeded picture with gradients and a block, so SSIM has structure to see. */
const picture = (width = 48, height = 32, seed = 1) => {
  const image = flat(width, height, [0, 0, 0]);
  let state = seed;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      state = (state * 1664525 + 1013904223) >>> 0;
      const at = (y * width + x) * 4,
        block = x > 12 && x < 30 && y > 8 && y < 24 ? 90 : 0;
      image.data[at] = (x * 4 + block) & 255;
      image.data[at + 1] = (y * 6 + block) & 255;
      image.data[at + 2] = state >>> 24;
    }
  return image;
};
const clone = ({ width, height, data }) => ({ width, height, data: data.slice() });

test('pixelDiff counts the pixels over the threshold', () => {
  const a = flat(4, 4, [10, 20, 30]),
    b = clone(a);
  assert.deepEqual(pixelDiff(a, b), { different: 0, total: 16, ratio: 0, largest: 0, mean: 0 });
  b.data[1] += 2; // At the threshold: the same.
  b.data[4] += 3; // Over it.
  b.data[10] += 100;
  const result = pixelDiff(a, b);
  assert.equal(result.different, 2);
  assert.equal(result.ratio, 2 / 16);
  assert.equal(result.largest, 100);
  assert.equal(result.mean, (2 + 3 + 100) / 16);
  assert.equal(pixelDiff(a, b, { threshold: 0 }).different, 3);
  assert.equal(pixelDiff(a, b, { threshold: 255 }).different, 0);
});

test('pixelDiff ignores colour under full transparency, and sees alpha', () => {
  const clear = flat(1, 1, [255, 0, 0, 0]),
    other = flat(1, 1, [0, 255, 0, 0]);
  assert.equal(pixelDiff(clear, other, { threshold: 0 }).different, 0);
  assert.equal(pixelDiff(flat(1, 1, [9, 9, 9, 255]), flat(1, 1, [9, 9, 9, 100])).largest, 155);
  // Half covered, colour differs by 100: the viewer sees 50.
  assert.ok(Math.abs(pixelDiff(flat(1, 1, [200, 0, 0, 128]), flat(1, 1, [100, 0, 0, 128])).largest - 50.2) < 0.01);
});

test('pixelDiff draws changes in red over a faded picture', () => {
  const a = flat(2, 1, [100, 100, 100]),
    b = clone(a);
  b.data[0] = 0;
  const { image } = pixelDiff(a, b, { image: true });
  assert.deepEqual([image.width, image.height], [2, 1]);
  assert.deepEqual([...image.data], [255, 0, 0, 255, 216, 216, 216, 255]);
  assert.deepEqual([...a.data.subarray(0, 4)], [100, 100, 100, 255], 'inputs stay as they are');
});

test('both comparisons refuse images they cannot pair', () => {
  const a = flat(2, 2, [0, 0, 0]);
  for (const compare of [pixelDiff, ssim]) {
    assert.throws(() => compare(a, flat(2, 3, [0, 0, 0])), /one size/);
    assert.throws(() => compare(a, { width: 2, height: 2, data: new Uint8Array(3) }), /match its size/);
  }
  assert.throws(() => pixelDiff(a, a, { threshold: -1 }), RangeError);
  assert.throws(() => pixelDiff(a, a, { threshold: NaN }), RangeError);
  for (const options of [{ window: 4 }, { window: 0 }, { sigma: 0 }]) assert.throws(() => ssim(a, a, options), RangeError);
});

test('SSIM of identical images is 1, and it is symmetric', () => {
  const a = picture(),
    b = picture(48, 32, 2);
  assert.equal(ssim(a, clone(a)).score, 1);
  const forward = ssim(a, b).score;
  assert.ok(forward < 1);
  assert.ok(Math.abs(forward - ssim(b, a).score) < 1e-12);
});

test('SSIM of two flat images is the luminance term of the published formula', () => {
  // No variance anywhere, so the structure term is C2 / C2 = 1.
  const a = flat(16, 16, [100, 100, 100]),
    b = flat(16, 16, [110, 110, 110]),
    C1 = (0.01 * 255) ** 2,
    expected = (2 * 100 * 110 + C1) / (100 ** 2 + 110 ** 2 + C1);
  assert.ok(Math.abs(ssim(a, b).score - expected) < 1e-9);
});

test('SSIM against a hand-worked 3 x 3 window', () => {
  // A window of 3 with sigma large enough to be nearly uniform, on a picture and its inverse: variance equal, covariance
  // negative, so the score is far below a plain brightness change of the same size.
  const a = flat(3, 3, [0, 0, 0]),
    b = flat(3, 3, [0, 0, 0]);
  [0, 2, 4, 6, 8].forEach((i) => {
    a.data.fill(200, i * 4, i * 4 + 3);
  });
  [1, 3, 5, 7].forEach((i) => {
    b.data.fill(200, i * 4, i * 4 + 3);
  });
  const w = 1 / 9,
    meanA = 200 * 5 * w,
    meanB = 200 * 4 * w,
    varA = 200 * 200 * 5 * w - meanA ** 2,
    varB = 200 * 200 * 4 * w - meanB ** 2,
    cov = -meanA * meanB,
    C1 = (0.01 * 255) ** 2,
    C2 = (0.03 * 255) ** 2,
    expected = ((2 * meanA * meanB + C1) * (2 * cov + C2)) / ((meanA ** 2 + meanB ** 2 + C1) * (varA + varB + C2));
  const { score, map } = ssim(a, b, { window: 3, sigma: 1e6, map: true });
  assert.ok(Math.abs(score - expected) < 1e-6, `${score} against ${expected}`);
  assert.deepEqual([map.width, map.height, map.data.length], [1, 1, 1]);
});

test('SSIM falls as damage grows, and sees structure a pixel count does not', () => {
  const a = picture(),
    damage = (amount) => {
      const out = clone(a);
      for (let i = 0; i < out.data.length; i += 4) out.data[i + 1] = Math.max(0, out.data[i + 1] - (i % 8 ? amount : 0));
      return out;
    },
    small = ssim(a, damage(8)).score,
    large = ssim(a, damage(40)).score;
  assert.ok(1 > small && small > large, `${small} ${large}`);
  // Every pixel brighter by 6 fails a pixel count outright, but looks the same.
  const brighter = clone(a);
  for (let i = 0; i < brighter.data.length; i += 4)
    for (let c = 0; c < 3; c++) brighter.data[i + c] = Math.min(255, brighter.data[i + c] + 6);
  assert.ok(pixelDiff(a, brighter).ratio > 0.9);
  assert.ok(ssim(a, brighter).score > 0.98);
});

test('SSIM map has one score per window, and shrinks its window to a small image', () => {
  const { map } = ssim(picture(), picture(), { map: true });
  assert.deepEqual([map.width, map.height], [38, 22]);
  assert.equal(ssim(flat(4, 4, [1, 2, 3]), flat(4, 4, [1, 2, 3]), { map: true }).map.width, 2);
  assert.equal(ssim(flat(1, 1, [1, 2, 3]), flat(1, 1, [1, 2, 3])).score, 1);
  assert.equal(ssim(flat(2, 9, [1, 2, 3]), flat(2, 9, [1, 2, 3])).score, 1);
});

// A PNG writer for the tests, with any colour type, depth and filter, since the package's own writes one kind only.
const crc = (bytes) => {
  let value = ~0;
  for (const byte of bytes) {
    value ^= byte;
    for (let k = 0; k < 8; k++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  return ~value >>> 0;
};
const chunk = (name, body) => {
  const typed = Buffer.concat([Buffer.from(name, 'latin1'), Buffer.from(body)]),
    out = Buffer.alloc(typed.length + 8);
  out.writeUInt32BE(body.length, 0);
  typed.copy(out, 4);
  out.writeUInt32BE(crc(typed), typed.length + 4);
  return out;
};
function png({ width, height, type, depth = 8, rows, interlace = 0, extra = [] }) {
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head.set([depth, type, 0, 0, interlace], 8);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', head),
      ...extra,
      chunk('IDAT', deflateSync(Buffer.from(rows))),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

test('decodePNG reads back what encodePNG wrote, exactly', async () => {
  const image = picture(17, 9);
  for (let i = 3; i < image.data.length; i += 16) image.data[i] = i & 255;
  const read = await decodePNG(await encodePNG(image));
  assert.deepEqual([read.width, read.height], [17, 9]);
  assert.deepEqual(read.data, image.data);
});

test('decodePNG undoes every row filter', async () => {
  // One grey row per filter, each encoding 10, 20, 30 against the row above, whose values are 10, 20, 30 too.
  const paeth = (a, b, c) => {
      const p = a + b - c,
        [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    },
    want = [10, 20, 30],
    encode = (filter, x) => {
      const left = x ? want[x - 1] : 0,
        up = want[x],
        corner = x ? want[x - 1] : 0,
        predicted = [0, left, up, (left + up) >> 1, paeth(left, up, corner)][filter];
      return (want[x] - predicted) & 255;
    },
    rows = [0, ...want];
  for (const filter of [1, 2, 3, 4]) rows.push(filter, ...want.map((_, x) => encode(filter, x)));
  const { data } = await decodePNG(png({ width: 3, height: 5, type: 0, rows }));
  for (let y = 0; y < 5; y++)
    assert.deepEqual([0, 1, 2].map((x) => data[(y * 3 + x) * 4]), want, `row ${y}`);
});

test('decodePNG reads each colour type and depth', async () => {
  const rgb = await decodePNG(png({ width: 1, height: 1, type: 2, rows: [0, 1, 2, 3] }));
  assert.deepEqual([...rgb.data], [1, 2, 3, 255]);
  const greyAlpha = await decodePNG(png({ width: 1, height: 1, type: 4, rows: [0, 7, 9] }));
  assert.deepEqual([...greyAlpha.data], [7, 7, 7, 9]);
  const deep = await decodePNG(png({ width: 1, height: 1, type: 6, depth: 16, rows: [0, 1, 0xff, 2, 0xff, 3, 0xff, 4, 0xff] }));
  assert.deepEqual([...deep.data], [1, 2, 3, 4]);
  const bit = await decodePNG(png({ width: 3, height: 1, type: 0, depth: 1, rows: [0, 0b10100000] }));
  assert.deepEqual([bit.data[0], bit.data[4], bit.data[8]], [255, 0, 255]);
  const two = await decodePNG(png({ width: 2, height: 1, type: 0, depth: 2, rows: [0, 0b01110000] }));
  assert.deepEqual([two.data[0], two.data[4]], [85, 255]);
  const palette = await decodePNG(
    png({
      width: 2,
      height: 1,
      type: 3,
      depth: 4,
      rows: [0, 0x10],
      extra: [chunk('PLTE', [1, 2, 3, 4, 5, 6]), chunk('tRNS', [200])],
    }),
  );
  assert.deepEqual([...palette.data], [4, 5, 6, 255, 1, 2, 3, 200]);
  const keyed = await decodePNG(
    png({ width: 2, height: 1, type: 2, rows: [0, 1, 2, 3, 4, 5, 6], extra: [chunk('tRNS', [0, 4, 0, 5, 0, 6])] }),
  );
  assert.deepEqual([keyed.data[3], keyed.data[7]], [255, 0]);
  const greyKey = await decodePNG(
    png({ width: 2, height: 1, type: 0, rows: [0, 8, 9], extra: [chunk('tRNS', [0, 9])] }),
  );
  assert.deepEqual([greyKey.data[3], greyKey.data[7]], [255, 0]);
});

test('decodePNG refuses what is not a PNG it can read', async () => {
  await assert.rejects(decodePNG(new Uint8Array(40)), { code: 'failed' });
  await assert.rejects(decodePNG('x.png'), TypeError);
  await assert.rejects(decodePNG(png({ width: 1, height: 1, type: 0, rows: [0, 1], interlace: 1 })), { code: 'failed' });
  await assert.rejects(decodePNG(png({ width: 1, height: 1, type: 0, rows: [9, 1] })), { code: 'failed' });
  await assert.rejects(decodePNG(png({ width: 9, height: 9, type: 0, rows: [0, 1] })), { code: 'failed' });
  await assert.rejects(decodePNG(png({ width: 1, height: 1, type: 3, rows: [0, 1] })), { code: 'failed' });
});

test('compareImages passes the same picture, fails a changed one, and takes PNG bytes', async () => {
  const a = picture(),
    bytes = await encodePNG(a),
    same = await compareImages(a, bytes);
  assert.equal(same.pass, true);
  assert.equal(same.ssim, 1);
  assert.equal(same.different, 0);
  const changed = clone(a);
  for (let y = 10; y < 22; y++) for (let x = 14; x < 28; x++) changed.data.fill(0, (y * 48 + x) * 4, (y * 48 + x) * 4 + 3);
  const failed = await compareImages(bytes, changed);
  assert.equal(failed.pass, false);
  assert.equal(failed.different, 168);
  assert.ok(failed.ssim < 0.99);
  assert.deepEqual([...failed.image.data.subarray((10 * 48 + 14) * 4, (10 * 48 + 14) * 4 + 4)], [255, 0, 0, 255]);
  assert.equal((await compareImages(bytes, changed, { maxRatio: 1, minSSIM: 0 })).pass, true);
  assert.equal((await compareImages(a, a, { minSSIM: 1, maxRatio: 0 })).pass, true);
});

test('each limit fails on its own', async () => {
  const a = picture(),
    one = clone(a);
  one.data[0] ^= 0xff;
  assert.equal((await compareImages(a, one, { maxRatio: 0, minSSIM: -1 })).pass, false);
  assert.equal((await compareImages(a, one, { maxRatio: 1, minSSIM: 1 })).pass, false);
  await assert.rejects(compareImages(a, a, { maxRatio: 2 }), RangeError);
  await assert.rejects(compareImages(a, a, { minSSIM: NaN }), RangeError);
  await assert.rejects(compareImages(a, flat(1, 1, [0, 0, 0])), /one size/);
});
