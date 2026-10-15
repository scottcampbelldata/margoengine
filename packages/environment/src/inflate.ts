// Minimal synchronous zlib/DEFLATE (RFC 1950/1951) decoder for EXR ZIP and ZIPS blocks.
// The output size is always known up front in EXR, so decoding writes into a fixed buffer and
// every read and write is bounds checked.

const LENGTH_BASE = new Uint16Array([
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
]);
const LENGTH_EXTRA = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
]);
const DIST_BASE = new Uint16Array([
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
  8193, 12289, 16385, 24577,
]);
const DIST_EXTRA = new Uint8Array([
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
]);
const CODE_ORDER = new Uint8Array([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);

interface Huffman {
  counts: Uint16Array;
  symbols: Uint16Array;
}

function buildHuffman(lengths: Uint8Array, offset: number, count: number): Huffman {
  const counts = new Uint16Array(16),
    symbols = new Uint16Array(count),
    offsets = new Uint16Array(16);
  for (let i = 0; i < count; i++) counts[lengths[offset + i]]++;
  counts[0] = 0;
  let left = 1;
  for (let len = 1; len < 16; len++) {
    left = (left << 1) - counts[len];
    if (left < 0) throw new Error('Corrupt deflate stream: oversubscribed code');
  }
  for (let len = 1; len < 15; len++) offsets[len + 1] = offsets[len] + counts[len];
  for (let i = 0; i < count; i++) if (lengths[offset + i]) symbols[offsets[lengths[offset + i]]++] = i;
  return { counts, symbols };
}

let fixedLiteral: Huffman | undefined, fixedDistance: Huffman | undefined;
function fixedTables(): [Huffman, Huffman] {
  if (!fixedLiteral || !fixedDistance) {
    const lengths = new Uint8Array(320);
    lengths.fill(8, 0, 144);
    lengths.fill(9, 144, 256);
    lengths.fill(7, 256, 280);
    lengths.fill(8, 280, 288);
    lengths.fill(5, 288, 320);
    fixedLiteral = buildHuffman(lengths, 0, 288);
    fixedDistance = buildHuffman(lengths, 288, 30);
  }
  return [fixedLiteral, fixedDistance];
}

/**
 * Inflates a zlib stream (2 byte header, DEFLATE data, Adler-32 trailer is not verified) into exactly
 * `size` bytes. Throws on malformed data or when the stream does not produce exactly `size` bytes.
 */
export function inflateZlib(input: Uint8Array, size: number): Uint8Array {
  if (input.length < 2) throw new Error('Corrupt zlib stream: too short');
  const cmf = input[0],
    flg = input[1];
  if ((cmf & 15) !== 8 || ((cmf << 8) | flg) % 31 !== 0 || flg & 32) throw new Error('Corrupt zlib stream header');
  return inflateRaw(input.subarray(2), size);
}

export function inflateRaw(input: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size);
  let position = 0,
    bitBuffer = 0,
    bitCount = 0,
    written = 0;
  const bits = (n: number): number => {
    while (bitCount < n) {
      if (position >= input.length) throw new Error('Corrupt deflate stream: unexpected end');
      bitBuffer |= input[position++] << bitCount;
      bitCount += 8;
    }
    const value = bitBuffer & ((1 << n) - 1);
    bitBuffer >>>= n;
    bitCount -= n;
    return value;
  };
  const decode = (table: Huffman): number => {
    let code = 0,
      first = 0,
      index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const count = table.counts[len];
      if (code - count < first) return table.symbols[index + (code - first)];
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw new Error('Corrupt deflate stream: invalid code');
  };
  const lengths = new Uint8Array(320);
  let last = 0;
  while (!last) {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitBuffer = 0;
      bitCount = 0;
      if (position + 4 > input.length) throw new Error('Corrupt deflate stream: unexpected end');
      const length = input[position] | (input[position + 1] << 8),
        check = input[position + 2] | (input[position + 3] << 8);
      position += 4;
      if ((length ^ 0xffff) !== check) throw new Error('Corrupt deflate stream: stored length mismatch');
      if (position + length > input.length || written + length > size)
        throw new Error('Corrupt deflate stream: stored block out of bounds');
      out.set(input.subarray(position, position + length), written);
      position += length;
      written += length;
      continue;
    }
    let literal: Huffman, distance: Huffman;
    if (type === 1) [literal, distance] = fixedTables();
    else if (type === 2) {
      const nLiteral = bits(5) + 257,
        nDistance = bits(5) + 1,
        nCode = bits(4) + 4;
      if (nLiteral > 286 || nDistance > 30) throw new Error('Corrupt deflate stream: bad table sizes');
      lengths.fill(0);
      for (let i = 0; i < nCode; i++) lengths[CODE_ORDER[i]] = bits(3);
      const codeTable = buildHuffman(lengths, 0, 19);
      let i = 0;
      while (i < nLiteral + nDistance) {
        const symbol = decode(codeTable);
        if (symbol < 16) {
          lengths[i++] = symbol;
          continue;
        }
        let repeat = 0,
          value = 0;
        if (symbol === 16) {
          if (i === 0) throw new Error('Corrupt deflate stream: repeat with no previous length');
          value = lengths[i - 1];
          repeat = 3 + bits(2);
        } else if (symbol === 17) repeat = 3 + bits(3);
        else repeat = 11 + bits(7);
        if (i + repeat > nLiteral + nDistance) throw new Error('Corrupt deflate stream: too many lengths');
        while (repeat--) lengths[i++] = value;
      }
      if (!lengths[256]) throw new Error('Corrupt deflate stream: missing end-of-block code');
      literal = buildHuffman(lengths, 0, nLiteral);
      distance = buildHuffman(lengths, nLiteral, nDistance);
    } else throw new Error('Corrupt deflate stream: invalid block type');
    for (;;) {
      const symbol = decode(literal);
      if (symbol < 256) {
        if (written >= size) throw new Error('Corrupt deflate stream: output overflow');
        out[written++] = symbol;
      } else if (symbol === 256) break;
      else {
        const lengthIndex = symbol - 257;
        if (lengthIndex >= 29) throw new Error('Corrupt deflate stream: invalid length symbol');
        const length = LENGTH_BASE[lengthIndex] + bits(LENGTH_EXTRA[lengthIndex]);
        const distanceSymbol = decode(distance);
        if (distanceSymbol >= 30) throw new Error('Corrupt deflate stream: invalid distance symbol');
        const back = DIST_BASE[distanceSymbol] + bits(DIST_EXTRA[distanceSymbol]);
        if (back > written) throw new Error('Corrupt deflate stream: distance before start');
        if (written + length > size) throw new Error('Corrupt deflate stream: output overflow');
        for (let k = 0; k < length; k++, written++) out[written] = out[written - back];
      }
    }
  }
  if (written !== size) throw new Error(`Corrupt deflate stream: produced ${written} of ${size} bytes`);
  return out;
}
