// PIZ, RLE and the ZIP/RLE reconstruction in parseEXR: binding vectors plus round trips through an encoder written here
// from the format description (bitmap and rank table, forward wavelet, canonical Huffman with run codes).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseEXR, halfToFloat } from '../dist/index.js';

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const piz = fixtures + 'piz/';
const vectors = JSON.parse(readFileSync(piz + 'exr-piz.json', 'utf8'));
const roundtrip = JSON.parse(readFileSync(piz + 'roundtrip.json', 'utf8'));
// Vector paths name either the package fixtures or the Margo-made PIZ files, which live in fixtures/piz.
const resolve = (path) =>
  path.startsWith('vectors/exr-piz/')
    ? piz + path.slice('vectors/exr-piz/'.length)
    : fixtures + path.slice('packages/environment/tests/fixtures/'.length);
const sha = (data) =>
  createHash('sha256')
    .update(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
    .digest('hex');
const outcome = (bytes) => {
  try {
    return { ok: true, dataSha256: sha(parseEXR(bytes).data) };
  } catch (error) {
    return { name: error.name, code: error.code ?? null, message: error.message };
  }
};

// ------------------------------------------------------------------ binding vectors

test('every reference fixture decodes to its recorded digest', () => {
  assert.equal(vectors.fixtures.length, 22);
  for (const entry of vectors.fixtures) {
    const image = parseEXR(readFileSync(resolve(entry.path)));
    assert.equal(image.compression, entry.compression, entry.path);
    assert.equal(image.layout, entry.layout, entry.path);
    if (entry.dataWindow) assert.deepEqual(image.dataWindow, entry.dataWindow, entry.path);
    if (entry.displayWindow) assert.deepEqual(image.displayWindow, entry.displayWindow, entry.path);
    assert.deepEqual(
      image.channels.map((c) => `${c.name}:${c.type}`),
      entry.channels,
      entry.path,
    );
    assert.equal(sha(image.data), entry.dataSha256, entry.path);
  }
});

test('PIZ files covering both wavelet modes, odd sizes, 32-bit planes, empty bitmaps and runs decode exactly', () => {
  assert.equal(roundtrip.results.length, 9);
  for (const entry of roundtrip.results) {
    const bytes = readFileSync(resolve(entry.file));
    assert.equal(bytes.length, entry.bytes, entry.file);
    const image = parseEXR(bytes);
    assert.equal(image.compression, 'PIZ', entry.file);
    assert.deepEqual([image.width, image.height], [entry.width, entry.height], entry.file);
    assert.deepEqual(image.dataWindow, entry.dataWindow, entry.file);
    assert.deepEqual(
      image.channels.map((c) => `${c.name}:${c.type}`),
      entry.channels,
      entry.file,
    );
    assert.equal(sha(image.data), entry.expectedDataSha256, entry.file);
  }
});

test('truncated and bit-flipped PIZ files give the recorded outcome (same error class, code and message)', () => {
  assert.equal(vectors.damaged.length, 181);
  const bases = new Map();
  for (const entry of vectors.damaged) {
    if (!bases.has(entry.base)) bases.set(entry.base, readFileSync(resolve(entry.base)));
    const base = bases.get(entry.base);
    let bytes;
    if (entry.kind === 'truncate') bytes = base.subarray(0, entry.length);
    else {
      bytes = Buffer.from(base);
      bytes[entry.at] ^= 1 << entry.bit;
    }
    const where = `${entry.base} ${entry.kind} ${entry.kind === 'truncate' ? entry.length : `${entry.at}.${entry.bit}`}`;
    assert.deepEqual(outcome(bytes), entry.result, where);
  }
});

// ------------------------------------------------------------------ a scanline EXR builder for these tests

const TYPE_CODE = { UINT: 0, HALF: 1, FLOAT: 2 };
const SAMPLE_BYTES = { UINT: 4, HALF: 2, FLOAT: 4 };

/** Assembles a scanline file from already-encoded chunks: `chunks[i]` holds the bytes of chunk i (lines i*n...). */
function buildEXR({ width, height, channels, compression, chunks, origin = [0, 0] }) {
  const parts = [];
  const u8 = (v) => parts.push(Buffer.from([v]));
  const i32 = (v) => {
    const b = Buffer.alloc(4);
    b.writeInt32LE(v);
    parts.push(b);
  };
  const str = (s) => parts.push(Buffer.from(`${s}\0`, 'latin1'));
  const attribute = (name, type, body) => {
    str(name);
    str(type);
    i32(body.length);
    parts.push(body);
  };
  i32(20000630);
  i32(2);
  const list = [];
  for (const c of channels) {
    list.push(Buffer.from(`${c.name}\0`, 'latin1'));
    const b = Buffer.alloc(16);
    b.writeInt32LE(TYPE_CODE[c.type], 0);
    b.writeInt32LE(1, 8);
    b.writeInt32LE(1, 12);
    list.push(b);
  }
  list.push(Buffer.from([0]));
  attribute('channels', 'chlist', Buffer.concat(list));
  attribute('compression', 'compression', Buffer.from([compression]));
  const box = Buffer.alloc(16);
  box.writeInt32LE(origin[0], 0);
  box.writeInt32LE(origin[1], 4);
  box.writeInt32LE(origin[0] + width - 1, 8);
  box.writeInt32LE(origin[1] + height - 1, 12);
  attribute('dataWindow', 'box2i', box);
  attribute('displayWindow', 'box2i', box);
  attribute('lineOrder', 'lineOrder', Buffer.from([0]));
  u8(0);
  let header = Buffer.concat(parts);
  const linesPer = compression === 4 ? 32 : 1; // PIZ or RLE
  const table = Buffer.alloc(8 * chunks.length);
  let offset = header.length + table.length;
  const bodies = chunks.map((data, i) => {
    table.writeUInt32LE(offset, 8 * i);
    const prefix = Buffer.alloc(8);
    prefix.writeInt32LE(origin[1] + i * linesPer, 0);
    prefix.writeInt32LE(data.length, 4);
    offset += 8 + data.length;
    return Buffer.concat([prefix, Buffer.from(data)]);
  });
  header = Buffer.concat([header, table, ...bodies]);
  return header;
}

// ------------------------------------------------------------------ an independent PIZ encoder

// Forward step for the decoder's inverse pair D(l, h) -> (a, b): returns [l, h].
const forward14 = (a, b) => {
  const s = (x) => (x >= 32768 ? x - 65536 : x);
  const h = s(a) - s(b);
  const l = s(a) - Math.ceil(h / 2);
  return [l & 0xffff, h & 0xffff];
};
const forward16 = (a, b) => {
  const h = (a - b + 32768) & 0xffff;
  return [(b + (h >> 1)) & 0xffff, h];
};

function forwardWavelet(words, start, nx, ny, ox, oy, fourteen) {
  const step = fourteen ? forward14 : forward16;
  const m = Math.min(nx, ny);
  if (m < 2) return;
  let top = 1;
  while (top * 2 <= m) top *= 2;
  const at = (x, y) => start + x * ox + y * oy;
  const pair = (i, j) => {
    [words[i], words[j]] = step(words[i], words[j]);
  };
  for (let p = 1; p < top; p *= 2) {
    const q = 2 * p;
    for (let y0 = 0; y0 + q <= ny; y0 += q) {
      for (let x0 = 0; x0 + q <= nx; x0 += q) {
        const i00 = at(x0, y0),
          i10 = at(x0 + p, y0),
          i01 = at(x0, y0 + p),
          i11 = at(x0 + p, y0 + p);
        const [s, u] = step(words[i00], words[i10]);
        const [t, w] = step(words[i01], words[i11]);
        [words[i00], words[i01]] = step(s, t);
        [words[i10], words[i11]] = step(u, w);
      }
      if (nx & p) pair(at(q * Math.floor(nx / q), y0), at(q * Math.floor(nx / q), y0 + p));
    }
    if (ny & p)
      for (let x0 = 0; x0 + q <= nx; x0 += q) pair(at(x0, q * Math.floor(ny / q)), at(x0 + p, q * Math.floor(ny / q)));
  }
}

class BitWriter {
  bytes = [];
  bits = 0;
  write(value, n) {
    for (let k = n - 1; k >= 0; k--, this.bits++) {
      if ((this.bits & 7) === 0) this.bytes.push(0);
      if (Math.floor(value / 2 ** k) % 2) this.bytes[this.bytes.length - 1] |= 0x80 >> (this.bits & 7);
    }
  }
}

/** Encodes one chunk's uncompressed scanline bytes as PIZ (fixed-length canonical code, runs of repeated words). */
function encodePiz(raw, channels, width, lines) {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  // Planes: per channel, line-major, 32-bit samples as low word then high word.
  const words = new Uint16Array(raw.length / 2);
  let o = 0;
  const planeStarts = [];
  {
    let start = 0;
    for (const c of channels) {
      planeStarts.push(start);
      start += (SAMPLE_BYTES[c.type] / 2) * width * lines;
    }
  }
  for (let line = 0; line < lines; line++)
    for (let ci = 0; ci < channels.length; ci++) {
      const k = SAMPLE_BYTES[channels[ci].type] / 2;
      for (let i = 0; i < k * width; i++, o += 2)
        words[planeStarts[ci] + line * k * width + i] = view.getUint16(o, true);
    }
  // Bitmap and ranks.
  const bitmap = new Uint8Array(8192);
  for (const w of words) if (w) bitmap[w >> 3] |= 1 << (w & 7);
  const rank = new Uint16Array(65536);
  let n = 0;
  for (let v = 0; v < 65536; v++) if (v === 0 || bitmap[v >> 3] & (1 << (v & 7))) rank[v] = n++;
  for (let i = 0; i < words.length; i++) words[i] = rank[words[i]];
  const fourteen = n - 1 < 16384;
  channels.forEach((c, ci) => {
    const k = SAMPLE_BYTES[c.type] / 2;
    for (let j = 0; j < k; j++) forwardWavelet(words, planeStarts[ci] + j, width, lines, k, k * width, fourteen);
  });
  // Huffman: literals plus a run symbol one above the largest literal, all coded with one length.
  let lo = 65536,
    hi = 0;
  for (const w of words) {
    lo = Math.min(lo, w);
    hi = Math.max(hi, w);
  }
  const runSymbol = hi + 1;
  const used = new Set(words);
  used.add(runSymbol);
  const symbols = [...used].sort((a, b) => a - b);
  let length = 1;
  while (2 ** length < symbols.length) length++;
  const code = new Map(symbols.map((s, i) => [s, i]));
  const table = new BitWriter();
  for (let s = lo; s <= runSymbol; ) {
    if (used.has(s)) {
      table.write(length, 6);
      s++;
      continue;
    }
    let gap = 0;
    while (s + gap <= runSymbol && !used.has(s + gap)) gap++;
    if (gap === 1) table.write(0, 6);
    else if (gap <= 5) table.write(57 + gap, 6);
    else {
      gap = Math.min(gap, 261);
      table.write(63, 6);
      table.write(gap - 6, 8);
    }
    s += gap;
  }
  const data = new BitWriter();
  for (let i = 0; i < words.length; ) {
    let repeat = 0;
    while (repeat < 255 && i + 1 + repeat < words.length && words[i + 1 + repeat] === words[i]) repeat++;
    data.write(code.get(words[i]), length);
    if (repeat >= 2) {
      data.write(code.get(runSymbol), length);
      data.write(repeat, 8);
      i += 1 + repeat;
    } else i++;
  }
  const head = Buffer.alloc(20);
  head.writeUInt32LE(lo, 0);
  head.writeUInt32LE(runSymbol, 4);
  head.writeUInt32LE(table.bytes.length, 8);
  head.writeUInt32LE(data.bits, 12);
  const huffman = Buffer.concat([head, Buffer.from(table.bytes), Buffer.from(data.bytes)]);
  let first = 8192,
    last = 0;
  for (let i = 0; i < 8192; i++)
    if (bitmap[i]) {
      first = Math.min(first, i);
      last = i;
    }
  const bounds = Buffer.alloc(4);
  if (first > last) bounds.writeUInt16LE(8191, 0);
  else {
    bounds.writeUInt16LE(first, 0);
    bounds.writeUInt16LE(last, 2);
  }
  const size = Buffer.alloc(4);
  size.writeInt32LE(huffman.length);
  return {
    bytes: Buffer.concat([
      bounds,
      first > last ? Buffer.alloc(0) : Buffer.from(bitmap.subarray(first, last + 1)),
      size,
      huffman,
    ]),
    fourteen,
  };
}

let seed = 0x9e3779b9;
const random32 = () => {
  // xorshift32 (Marsaglia 2003): deterministic test data only.
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return seed >>> 0;
};

/** Builds a PIZ file from per-channel sample generators and returns it with the RGBA floats parseEXR must return. */
function pizImage({ width, height, channels, sample }) {
  const sorted = [...channels].sort((a, b) => (a.name < b.name ? -1 : 1));
  const lineBytes = sorted.reduce((s, c) => s + SAMPLE_BYTES[c.type] * width, 0);
  const expected = new Float32Array(width * height * 4);
  const modes = [],
    chunks = [];
  for (let y0 = 0; y0 < height; y0 += 32) {
    const lines = Math.min(32, height - y0);
    const raw = new Uint8Array(lines * lineBytes);
    const view = new DataView(raw.buffer);
    let o = 0;
    for (let line = 0; line < lines; line++)
      for (const c of sorted)
        for (let x = 0; x < width; x++) {
          const bits = sample(c, x, y0 + line);
          // Y (luminance) fills R, G and B.
          const slots = c.name === 'Y' ? [0, 1, 2] : 'RGBA'.includes(c.name) ? ['RGBA'.indexOf(c.name)] : [];
          let value;
          if (c.type === 'HALF') {
            view.setUint16(o, bits, true);
            value = halfToFloat(bits);
            o += 2;
          } else {
            view.setUint32(o, bits, true);
            value = c.type === 'FLOAT' ? view.getFloat32(o, true) : bits;
            o += 4;
          }
          for (const slot of slots) expected[((y0 + line) * width + x) * 4 + slot] = value;
        }
    const { bytes, fourteen } = encodePiz(raw, sorted, width, lines);
    assert.notEqual(bytes.length, raw.length, 'a chunk the size of its raw lines would be read raw, not as PIZ');
    modes.push(fourteen ? 14 : 16);
    chunks.push(bytes);
  }
  if (!sorted.some((c) => c.name === 'A')) for (let i = 3; i < expected.length; i += 4) expected[i] = 1;
  return { file: buildEXR({ width, height, channels: sorted, compression: 4, chunks }), expected, modes };
}

const sameBits = (a, b) =>
  Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));

test('PIZ decodes what an independent encoder wrote, for many sizes and both wavelet modes', () => {
  const smoothHalf = (c, x, y) => 0x3c00 + ((x * 7 + y * 3 + c.name.charCodeAt(0)) % 61) * ((x >> 3) % 2 ? 1 : 0);
  let cases = 0;
  for (const [width, height] of [
    [1, 1],
    [1, 33],
    [2, 2],
    [3, 5],
    [17, 1],
    [31, 64],
    [64, 31],
    [65, 70],
  ]) {
    const { file, expected, modes } = pizImage({
      width,
      height,
      channels: [
        { name: 'R', type: 'HALF' },
        { name: 'G', type: 'FLOAT' },
        { name: 'B', type: 'UINT' },
      ],
      sample: (c, x, y) =>
        c.type === 'HALF'
          ? smoothHalf(c, x, y)
          : c.type === 'FLOAT'
            ? 0x3f800000 + ((x * y) % 97) * 4096
            : (x + 3 * y) % 23,
    });
    assert.ok(modes.every((m) => m === 14));
    const image = parseEXR(file);
    assert.ok(sameBits(image.data, expected), `${width}x${height}`);
    cases++;
  }
  // Random 32-bit words give more than 16,384 distinct values: 16-bit wavelet and codes longer than the 14-bit window.
  const { file, expected, modes } = pizImage({
    width: 400,
    height: 40,
    channels: [
      { name: 'Y', type: 'UINT' },
      { name: 'A', type: 'HALF' },
    ],
    sample: (c, x, y) => (c.type === 'UINT' ? random32() : y < 20 ? 0x3c00 : 0x3800),
  });
  assert.deepEqual(modes, [16, 14]);
  assert.ok(sameBits(parseEXR(file).data, expected));
  assert.equal(cases + 1, 9);
});

test('PIZ errors name the damaged part of the chunk', () => {
  const channels = [{ name: 'Y', type: 'HALF' }];
  const good = encodePiz(new Uint8Array(8 * 4 * 2).fill(60), channels, 8, 4).bytes;
  const file = (chunk) => buildEXR({ width: 8, height: 4, channels, compression: 4, chunks: [chunk] });
  const failed = (problem) => ({
    name: 'MargoError',
    code: 'failed',
    message: `Invalid EXR: ${problem}; the file is damaged or not OpenEXR, export it again`,
  });
  const check = (chunk, problem) => {
    const result = outcome(file(chunk));
    assert.equal(result.message, failed(problem).message, problem);
    assert.equal(result.code, 'failed');
  };
  assert.ok(outcome(file(good)).ok);
  check(good.subarray(0, 3), 'truncated PIZ chunk');
  const bitmapOut = Buffer.from(good);
  bitmapOut.writeUInt16LE(8192, 2);
  check(bitmapOut, 'PIZ bitmap out of range');
  const longBitmap = Buffer.from(good);
  longBitmap.writeUInt16LE(0, 0);
  longBitmap.writeUInt16LE(200, 2);
  check(longBitmap, 'truncated PIZ bitmap');
  const lengthAt = 4 + (good.readUInt16LE(2) - good.readUInt16LE(0) + 1);
  check(good.subarray(0, lengthAt + 2), 'truncated PIZ chunk');
  const negative = Buffer.from(good);
  negative.writeInt32LE(-1, lengthAt);
  check(negative, 'PIZ Huffman data out of bounds');
  const section = lengthAt + 4;
  const shortHeader = Buffer.from(good.subarray(0, section + 10));
  shortHeader.writeInt32LE(10, lengthAt);
  check(shortHeader, 'truncated PIZ Huffman header');
  const range = Buffer.from(good);
  range.writeUInt32LE(65537, section + 4);
  check(range, 'bad Huffman symbol range');
  const bitCount = Buffer.from(good);
  bitCount.writeUInt32LE(1e6, section + 12);
  check(bitCount, 'Huffman bit count exceeds data');
  const fewer = Buffer.from(good);
  fewer.writeUInt32LE(good.readUInt32LE(section + 12) - 8, section + 12);
  assert.match(outcome(file(fewer)).message, /Huffman (produced \d+ of 32 values|tail|run)/);
});

// ------------------------------------------------------------------ RLE and the byte reconstruction

/** RLE with the format's predictor and split (OpenEXR Technical Introduction), for one-line chunks. */
function rleChunk(raw) {
  const n = raw.length,
    split = new Uint8Array(n),
    half = (n + 1) >> 1;
  for (let i = 0; i < n; i++) split[i % 2 ? half + (i >> 1) : i >> 1] = raw[i];
  const deltas = split.map((v, i) => (i ? (v - split[i - 1] + 128) & 255 : v));
  const out = [];
  for (let i = 0; i < n; ) {
    let run = 1;
    while (run < 128 && i + run < n && deltas[i + run] === deltas[i]) run++;
    if (run >= 3) {
      out.push(run - 1, deltas[i]);
      i += run;
    } else {
      let literal = 0;
      while (
        literal < 127 &&
        i + literal < n &&
        !(
          i + literal + 2 < n &&
          deltas[i + literal] === deltas[i + literal + 1] &&
          deltas[i + literal] === deltas[i + literal + 2]
        )
      )
        literal++;
      out.push((256 - literal) & 255, ...deltas.subarray(i, i + literal));
      i += literal;
    }
  }
  return Uint8Array.from(out);
}

test('RLE chunks and the predictor/split reconstruction round trip, and damaged RLE names the problem', () => {
  const width = 40,
    channels = [{ name: 'Y', type: 'HALF' }];
  const rows = [];
  for (let y = 0; y < 3; y++) {
    const raw = new Uint8Array(width * 2);
    const v = new DataView(raw.buffer);
    for (let x = 0; x < width; x++) v.setUint16(2 * x, x < 20 ? 0x3c00 : 0x3c00 + ((x * 13 + y) % 300), true);
    rows.push(raw);
  }
  const file = buildEXR({ width, height: 3, channels, compression: 1, chunks: rows.map(rleChunk) });
  const image = parseEXR(file);
  for (let y = 0; y < 3; y++)
    for (let x = 0; x < width; x++)
      assert.equal(image.data[(y * width + x) * 4], halfToFloat(new DataView(rows[y].buffer).getUint16(2 * x, true)));
  const single = (chunk) => outcome(buildEXR({ width, height: 1, channels, compression: 1, chunks: [chunk] })).message;
  assert.match(single(Uint8Array.from([0x80 + 100, 1, 2])), /RLE literal out of bounds/);
  assert.match(single(Uint8Array.from([5])), /RLE run out of bounds/);
  assert.match(single(Uint8Array.from([100, 7])), /RLE run out of bounds/);
  assert.match(single(Uint8Array.from([3, 7])), /RLE chunk size mismatch/);
});
