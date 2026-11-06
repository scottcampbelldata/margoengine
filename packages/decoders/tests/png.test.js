// PNG reading (@margoengine/decoders/png): every colour type and bit depth, all five filters and Adam7 against
// pixels built independently here (forward filters, node:zlib), the package's own encoder round trip, and refusals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateSync } from 'node:zlib';
import { decodePNG } from '@margoengine/decoders/png';

const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)) >>> 0, 8 + data.length);
  return out;
}

const paeth = (a, b, c) => {
  const p = a + b - c,
    pa = Math.abs(p - a),
    pb = Math.abs(p - b),
    pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** Packs per-pixel samples (`samples[y][x]` arrays) to filtered scanlines; filter `f` cycles per row when 'all'. */
function scanlines(samples, depth, bpp, filter) {
  const rows = samples.map((row) => {
    const bytes = [];
    if (depth >= 8)
      for (const pixel of row) for (const v of pixel) depth === 16 ? bytes.push(v >> 8, v & 255) : bytes.push(v);
    else {
      let acc = 0,
        bits = 0;
      for (const pixel of row)
        for (const v of pixel) {
          acc = (acc << depth) | v;
          bits += depth;
          if (bits === 8) bytes.push(acc), (acc = 0), (bits = 0);
        }
      if (bits) bytes.push(acc << (8 - bits));
    }
    return bytes;
  });
  const out = [];
  rows.forEach((row, y) => {
    const f = filter === 'all' ? y % 5 : filter,
      up = y ? rows[y - 1] : row.map(() => 0);
    out.push(f);
    row.forEach((v, x) => {
      const a = x >= bpp ? row[x - bpp] : 0,
        b = up[x],
        c = x >= bpp ? up[x - bpp] : 0,
        p = [0, a, b, (a + b) >> 1, paeth(a, b, c)][f];
      out.push((v - p) & 255);
    });
  });
  return out;
}

/** A PNG of `samples[y][x]` (one array of channel values per pixel) in the given format. */
function encode({ width, height, colour, depth, samples, interlace = false, filter = 'all', plte, trns, split }) {
  const bpp = Math.max(1, (CHANNELS[colour] * depth) >> 3);
  let raw = [];
  if (!interlace) raw = scanlines(samples, depth, bpp, filter);
  else
    for (const [x0, y0, dx, dy] of ADAM7) {
      const pass = [];
      for (let y = y0; y < height; y += dy) {
        const row = [];
        for (let x = x0; x < width; x += dx) row.push(samples[y][x]);
        if (row.length) pass.push(row);
      }
      if (pass.length) raw.push(...scanlines(pass, depth, bpp, filter));
    }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([depth, colour, 0, 0, interlace ? 1 : 0], 8);
  const zlib = deflateSync(Buffer.from(raw)),
    idat = split ? [zlib.subarray(0, 5), zlib.subarray(5)] : [zlib];
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr),
      chunk('tEXt', Buffer.from('Comment\0skipped')),
      ...(plte ? [chunk('PLTE', plte)] : []),
      ...(trns ? [chunk('tRNS', trns)] : []),
      ...idat.map((d) => chunk('IDAT', d)),
      chunk('IEND', []),
    ]),
  );
}

// Deterministic pseudo-random samples.
let seed = 7;
const random = (max) => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 8) % (max + 1);

const cases = [];
for (const [colour, depths] of Object.entries({
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
}))
  for (const depth of depths)
    for (const interlace of [false, true]) cases.push({ colour: Number(colour), depth, interlace });

for (const { colour, depth, interlace } of cases)
  test(`colour type ${colour}, ${depth}-bit${interlace ? ', Adam7' : ''}: every pixel matches`, async () => {
    const width = 13,
      height = 11,
      max = 2 ** depth - 1,
      channels = CHANNELS[colour],
      entries = colour === 3 ? Math.min(256, 2 ** depth) : 0,
      plte = colour === 3 ? Array.from({ length: entries * 3 }, () => random(255)) : undefined,
      trns = colour === 3 ? Array.from({ length: Math.max(1, entries - 1) }, () => random(255)) : undefined,
      samples = Array.from({ length: height }, () =>
        Array.from({ length: width }, () =>
          Array.from({ length: channels }, () => random(colour === 3 ? entries - 1 : max)),
        ),
      ),
      to8 = (v) => (depth === 16 ? v >> 8 : Math.floor((v * 255) / max)),
      decoded = decodePNG(encode({ width, height, colour, depth, samples, interlace, plte, trns, split: true }));
    assert.equal(decoded.width, width);
    assert.equal(decoded.height, height);
    const expected = new Uint8Array(width * height * 4);
    samples.flat().forEach((s, i) => {
      const rgba =
        colour === 3
          ? [plte[s[0] * 3], plte[s[0] * 3 + 1], plte[s[0] * 3 + 2], s[0] < trns.length ? trns[s[0]] : 255]
          : colour === 0
            ? [to8(s[0]), to8(s[0]), to8(s[0]), 255]
            : colour === 4
              ? [to8(s[0]), to8(s[0]), to8(s[0]), to8(s[1])]
              : colour === 2
                ? [to8(s[0]), to8(s[1]), to8(s[2]), 255]
                : s.map(to8);
      expected.set(rgba, i * 4);
    });
    assert.deepEqual(decoded.data, expected);
  });

test('a tRNS colour key makes exactly the matching grey and RGB pixels transparent', async () => {
  const grey = decodePNG(
    encode({ width: 3, height: 1, colour: 0, depth: 4, samples: [[[5], [9], [5]]], trns: [0, 5] }),
  );
  assert.deepEqual([...grey.data], [85, 85, 85, 0, 153, 153, 153, 255, 85, 85, 85, 0]);
  const rgb = decodePNG(
    encode({
      width: 2,
      height: 1,
      colour: 2,
      depth: 16,
      samples: [
        [
          [1, 2, 3],
          [1, 2, 4],
        ],
      ],
      trns: [0, 1, 0, 2, 0, 3],
    }),
  );
  assert.deepEqual([...rgb.data], [0, 0, 0, 0, 0, 0, 0, 255]);
});

test('PNGs from the package encoder decode to the pixels that went in', async () => {
  const width = 5,
    height = 4,
    data = Uint8Array.from({ length: width * height * 4 }, () => random(255)),
    { png } = await import('../../exporters/dist/png.js'),
    decoded = decodePNG(await png({ data, width, height }, 4096, false));
  assert.deepEqual(decoded, { width, height, data });
});

test('broken files are refused with MargoError failed, size limits with RangeError', async () => {
  const good = encode({
    width: 2,
    height: 2,
    colour: 6,
    depth: 8,
    samples: [
      [
        [1, 2, 3, 4],
        [5, 6, 7, 8],
      ],
      [
        [9, 10, 11, 12],
        [13, 14, 15, 16],
      ],
    ],
  });
  const failed = { name: 'MargoError', code: 'failed' };
  assert.throws(() => decodePNG(good.subarray(0, good.length - 12)), failed);
  assert.throws(() => decodePNG(good.subarray(1)), failed);
  const flipped = good.slice();
  flipped[40] ^= 1;
  assert.throws(() => decodePNG(flipped), failed);
  assert.throws(() => decodePNG(good, { maxPixels: 3 }), RangeError);
  assert.throws(() => decodePNG([1, 2, 3]), TypeError);
  const short = encode({
    width: 2,
    height: 2,
    colour: 6,
    depth: 8,
    samples: [
      [
        [1, 2, 3, 4],
        [5, 6, 7, 8],
      ],
    ],
  });
  // Header says two rows, data holds one.
  assert.throws(() => decodePNG(short), failed);
  assert.deepEqual(
    decodePNG(good).data,
    Uint8Array.from({ length: 16 }, (_, i) => i + 1),
  );
});

test('bitDepth 16 keeps 16-bit samples and scales shallower ones to 0-65535', () => {
  const wide = (options) => decodePNG(new Uint8Array(encode({ width: 2, height: 1, ...options })), { bitDepth: 16 });
  const rgba = wide({ colour: 6, depth: 16, samples: [[[1, 513, 65535, 256], [40000, 0, 255, 65534]]] });
  assert.ok(rgba.data instanceof Uint16Array);
  assert.deepEqual([...rgba.data], [1, 513, 65535, 256, 40000, 0, 255, 65534]);
  assert.deepEqual([...wide({ colour: 2, depth: 8, samples: [[[0, 1, 255], [128, 2, 3]]] }).data], [0, 257, 65535, 65535, 32896, 514, 771, 65535]);
  assert.deepEqual([...wide({ colour: 0, depth: 2, samples: [[[1], [3]]] }).data], [21845, 21845, 21845, 65535, 65535, 65535, 65535, 65535]);
  assert.deepEqual([...wide({ colour: 4, depth: 8, samples: [[[2, 255], [3, 0]]] }).data], [514, 514, 514, 65535, 771, 771, 771, 0]);
  const palette = wide({ colour: 3, depth: 8, samples: [[[0], [1]]], plte: [1, 2, 3, 4, 5, 6], trns: [128] });
  assert.deepEqual([...palette.data], [257, 514, 771, 32896, 1028, 1285, 1542, 65535]);
  assert.throws(
    () => decodePNG(new Uint8Array(encode({ width: 1, height: 1, colour: 0, depth: 8, samples: [[[0]]] })), { bitDepth: 12 }),
    /bitDepth must be 8 or 16/,
  );
});
