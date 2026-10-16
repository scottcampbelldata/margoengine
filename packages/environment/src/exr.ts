// OpenEXR scanline decoder: the Three.js EXRLoader equivalent for single-part scanline files with
// NONE, RLE, ZIPS, ZIP or PIZ compression and HALF, FLOAT or UINT channels.
import { halfToFloat } from './half.js';
import { inflateZlib } from './inflate.js';
import { MAX_PIXELS, toBytes, type FloatImage } from './hdr.js';

export type EXRCompression = 'NONE' | 'RLE' | 'ZIPS' | 'ZIP' | 'PIZ';
export interface EXRChannel {
  name: string;
  type: 'UINT' | 'HALF' | 'FLOAT';
  xSampling: number;
  ySampling: number;
}
export interface EXRImage extends FloatImage {
  compression: EXRCompression;
  /** All channels in the file, in file (alphabetical) order. */
  channels: EXRChannel[];
  /** Which source channels filled RGBA: 'RGBA', 'RGB' or 'Y' (luminance replicated to RGB). */
  layout: 'RGBA' | 'RGB' | 'Y';
  dataWindow: [number, number, number, number];
  displayWindow: [number, number, number, number];
}

const COMPRESSION_NAMES = ['NONE', 'RLE', 'ZIPS', 'ZIP', 'PIZ', 'PXR24', 'B44', 'B44A', 'DWAA', 'DWAB', 'HTJ2K'];
const LINES_PER_BLOCK: Record<EXRCompression, number> = { NONE: 1, RLE: 1, ZIPS: 1, ZIP: 16, PIZ: 32 };
const TYPE_NAMES = ['UINT', 'HALF', 'FLOAT'] as const;
const TYPE_SIZE = [4, 2, 4];

/**
 * Parses a single-part scanline OpenEXR file into linear float RGBA. Picks the R, G, B and A channels
 * (or Y for luminance-only files); other channels are decoded and ignored. Tiled, multi-part, deep and
 * subsampled files and PXR24, B44 and DWA compression are rejected with a descriptive error.
 */
export function parseEXR(source: ArrayBuffer | ArrayBufferView): EXRImage {
  const bytes = toBytes(source);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let position = 0;
  const need = (n: number) => {
    if (n < 0 || position + n > bytes.length) throw new Error('Invalid EXR: unexpected end of file');
  };
  const _u8 = () => {
    need(1);
    return bytes[position++];
  };
  const i32 = () => {
    need(4);
    const v = view.getInt32(position, true);
    position += 4;
    return v;
  };
  const string = (limit: number): string => {
    const start = position;
    while (position < bytes.length && bytes[position] !== 0) {
      if (position - start >= limit) throw new Error('Invalid EXR: header name too long');
      position++;
    }
    need(1);
    let text = '';
    for (let i = start; i < position; i++) text += String.fromCharCode(bytes[i]);
    position++;
    return text;
  };

  if (bytes.length < 8 || view.getUint32(0, true) !== 20000630) throw new Error('Invalid EXR: bad magic number');
  const version = view.getUint32(4, true);
  if ((version & 255) !== 2) throw new Error(`Unsupported EXR version ${version & 255}`);
  if (version & 0x200) throw new Error('Unsupported EXR: tiled images');
  if (version & 0x800) throw new Error('Unsupported EXR: deep data');
  if (version & 0x1000) throw new Error('Unsupported EXR: multi-part files');
  const nameLimit = version & 0x400 ? 255 : 31;
  position = 8;

  let channels: EXRChannel[] | undefined, compression: EXRCompression | undefined;
  let dataWindow: [number, number, number, number] | undefined,
    displayWindow: [number, number, number, number] | undefined;
  let lineOrder = 0;
  for (let attributes = 0; ; attributes++) {
    if (attributes > 1024) throw new Error('Invalid EXR: too many header attributes');
    const name = string(nameLimit);
    if (name === '') break;
    const type = string(nameLimit),
      size = i32();
    need(size);
    const end = position + size;
    if (name === 'channels' && type === 'chlist') {
      channels = [];
      for (;;) {
        if (position >= end) throw new Error('Invalid EXR: unterminated channel list');
        const channelName = string(nameLimit);
        if (channelName === '') break;
        if (position + 16 > end) throw new Error('Invalid EXR: truncated channel list');
        const pixelType = i32();
        position += 4;
        const xSampling = i32(),
          ySampling = i32();
        if (pixelType < 0 || pixelType > 2)
          throw new Error(`Invalid EXR: channel ${channelName} has pixel type ${pixelType}`);
        channels.push({ name: channelName, type: TYPE_NAMES[pixelType], xSampling, ySampling });
      }
      if (channels.length > 1024) throw new Error('Invalid EXR: too many channels');
    } else if (name === 'compression' && type === 'compression') {
      const value = bytes[position],
        label = COMPRESSION_NAMES[value] ?? `#${value}`;
      if (!(label in LINES_PER_BLOCK)) throw new Error(`Unsupported EXR compression ${label}`);
      compression = label as EXRCompression;
    } else if ((name === 'dataWindow' || name === 'displayWindow') && type === 'box2i') {
      if (size !== 16) throw new Error(`Invalid EXR: bad ${name}`);
      const box: [number, number, number, number] = [
        view.getInt32(position, true),
        view.getInt32(position + 4, true),
        view.getInt32(position + 8, true),
        view.getInt32(position + 12, true),
      ];
      if (name === 'dataWindow') dataWindow = box;
      else displayWindow = box;
    } else if (name === 'lineOrder' && type === 'lineOrder') lineOrder = bytes[position];
    else if (name === 'type' && type === 'string') {
      const value = String.fromCharCode(...bytes.subarray(position, end));
      if (value !== 'scanlineimage') throw new Error(`Unsupported EXR part type ${value}`);
    }
    position = end;
  }
  if (!channels || !channels.length || !compression || !dataWindow)
    throw new Error('Invalid EXR: missing channels, compression or dataWindow');
  if (lineOrder > 2) throw new Error('Invalid EXR: bad lineOrder');
  for (const channel of channels)
    if (channel.xSampling !== 1 || channel.ySampling !== 1)
      throw new Error(`Unsupported EXR: subsampled channel ${channel.name}`);
  const [xMin, yMin, xMax, yMax] = dataWindow;
  const width = xMax - xMin + 1,
    height = yMax - yMin + 1;
  if (!(width > 0 && height > 0) || width > 1 << 24 || height > 1 << 24 || width * height > MAX_PIXELS)
    throw new Error(`Invalid EXR size ${width}x${height}`);

  const pick = (name: string) => channels!.findIndex((c) => c.name === name);
  let indices: number[], layout: EXRImage['layout'];
  const [r, g, b, a, y] = ['R', 'G', 'B', 'A', 'Y'].map(pick);
  if (r >= 0 && g >= 0 && b >= 0) {
    indices = [r, g, b, a];
    layout = a >= 0 ? 'RGBA' : 'RGB';
  } else if (y >= 0) {
    indices = [y, y, y, a];
    layout = 'Y';
  } else throw new Error(`Unsupported EXR channels: ${channels.map((c) => c.name).join(', ')} (need R, G, B or Y)`);

  const linesPerBlock = LINES_PER_BLOCK[compression];
  const blocks = Math.ceil(height / linesPerBlock);
  need(blocks * 8);
  const offsets: number[] = [];
  for (let i = 0; i < blocks; i++) {
    const low = view.getUint32(position, true),
      high = view.getUint32(position + 4, true);
    position += 8;
    offsets.push(high ? Infinity : low);
  }
  const pixelBytes = channels.reduce((sum, c) => sum + TYPE_SIZE[TYPE_NAMES.indexOf(c.type)], 0);
  const lineBytes = pixelBytes * width;
  const channelOffsets: number[] = [];
  {
    let o = 0;
    for (const c of channels) {
      channelOffsets.push(o);
      o += TYPE_SIZE[TYPE_NAMES.indexOf(c.type)] * width;
    }
  }

  const data = new Float32Array(width * height * 4);
  if (indices[3] < 0) for (let i = 3; i < data.length; i += 4) data[i] = 1;
  const filled = new Uint8Array(blocks);
  for (let block = 0; block < blocks; block++) {
    const offset = offsets[block];
    if (!(offset >= 8 && offset + 8 <= bytes.length))
      throw new Error(`Invalid EXR: chunk ${block} offset out of bounds`);
    const blockY = view.getInt32(offset, true),
      dataSize = view.getInt32(offset + 4, true);
    const index = (blockY - yMin) / linesPerBlock;
    if (!Number.isInteger(index) || index < 0 || index >= blocks || filled[index])
      throw new Error(`Invalid EXR: chunk ${block} has bad y ${blockY}`);
    filled[index] = 1;
    if (dataSize < 0 || offset + 8 + dataSize > bytes.length)
      throw new Error(`Invalid EXR: chunk ${block} data out of bounds`);
    const lines = Math.min(linesPerBlock, height - index * linesPerBlock);
    const expected = lines * lineBytes;
    const packed = bytes.subarray(offset + 8, offset + 8 + dataSize);
    let raw: Uint8Array;
    if (dataSize === expected)
      raw = packed; // Writers store a chunk raw when compression does not shrink it.
    else if (compression === 'NONE')
      throw new Error(`Invalid EXR: chunk ${block} has ${dataSize} bytes, expected ${expected}`);
    else if (compression === 'RLE') raw = unpredict(rleDecode(packed, expected));
    else if (compression === 'ZIP' || compression === 'ZIPS') raw = unpredict(inflateZlib(packed, expected));
    else raw = pizDecode(packed, expected, channels, width, lines);
    const raw16 = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    for (let line = 0; line < lines; line++) {
      const row = index * linesPerBlock + line,
        lineStart = line * lineBytes;
      for (let component = 0; component < 4; component++) {
        const channelIndex = indices[component];
        if (channelIndex < 0) continue;
        const type = channels[channelIndex].type;
        let source = lineStart + channelOffsets[channelIndex],
          target = row * width * 4 + component;
        if (type === 'HALF')
          for (let x = 0; x < width; x++, source += 2, target += 4)
            data[target] = halfToFloat(raw16.getUint16(source, true));
        else if (type === 'FLOAT')
          for (let x = 0; x < width; x++, source += 4, target += 4) data[target] = raw16.getFloat32(source, true);
        else for (let x = 0; x < width; x++, source += 4, target += 4) data[target] = raw16.getUint32(source, true);
      }
    }
  }
  return { width, height, data, compression, channels, layout, dataWindow, displayWindow: displayWindow ?? dataWindow };
}

function rleDecode(input: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size);
  let i = 0,
    o = 0;
  while (i < input.length) {
    const count = (input[i++] << 24) >> 24;
    if (count < 0) {
      const n = -count;
      if (i + n > input.length || o + n > size) throw new Error('Invalid EXR: RLE literal out of bounds');
      out.set(input.subarray(i, i + n), o);
      i += n;
      o += n;
    } else {
      const n = count + 1;
      if (i >= input.length || o + n > size) throw new Error('Invalid EXR: RLE run out of bounds');
      out.fill(input[i++], o, o + n);
      o += n;
    }
  }
  if (o !== size) throw new Error('Invalid EXR: RLE chunk size mismatch');
  return out;
}

// Undoes the byte delta predictor and the even/odd byte split shared by RLE, ZIPS and ZIP.
function unpredict(t: Uint8Array): Uint8Array {
  for (let i = 1; i < t.length; i++) t[i] = (t[i - 1] + t[i] - 128) & 255;
  const out = new Uint8Array(t.length),
    half = (t.length + 1) >> 1;
  for (let i = 0, a = 0, b = half; i < t.length; ) {
    out[i++] = t[a++];
    if (i < t.length) out[i++] = t[b++];
  }
  return out;
}

// ---------------------------------------------------------------- PIZ (Huffman + Haar wavelet + LUT)

const USHORT_RANGE = 1 << 16,
  BITMAP_SIZE = USHORT_RANGE >> 3;
const HUF_ENCSIZE = (1 << 16) + 1,
  HUF_DECBITS = 14,
  HUF_DECSIZE = 1 << HUF_DECBITS,
  HUF_DECMASK = HUF_DECSIZE - 1;
const SHORT_ZEROCODE_RUN = 59,
  LONG_ZEROCODE_RUN = 63,
  SHORTEST_LONG_RUN = 2 + LONG_ZEROCODE_RUN - SHORT_ZEROCODE_RUN;
// Bit accumulators stay exact in a double up to 53 bits, so codes longer than this are rejected.
const MAX_CODE_LENGTH = 44;

function pizDecode(input: Uint8Array, size: number, channels: EXRChannel[], width: number, lines: number): Uint8Array {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (input.length < 4) throw new Error('Invalid EXR: truncated PIZ chunk');
  const minNonZero = view.getUint16(0, true),
    maxNonZero = view.getUint16(2, true);
  let position = 4;
  if (maxNonZero >= BITMAP_SIZE) throw new Error('Invalid EXR: PIZ bitmap out of range');
  const bitmap = new Uint8Array(BITMAP_SIZE);
  if (minNonZero <= maxNonZero) {
    const n = maxNonZero - minNonZero + 1;
    if (position + n > input.length) throw new Error('Invalid EXR: truncated PIZ bitmap');
    bitmap.set(input.subarray(position, position + n), minNonZero);
    position += n;
  }
  const lut = new Uint16Array(USHORT_RANGE);
  let k = 0;
  for (let i = 0; i < USHORT_RANGE; i++) if (i === 0 || bitmap[i >> 3] & (1 << (i & 7))) lut[k++] = i;
  const maxValue = k - 1;
  if (position + 4 > input.length) throw new Error('Invalid EXR: truncated PIZ chunk');
  const length = view.getInt32(position, true);
  position += 4;
  if (length < 0 || position + length > input.length) throw new Error('Invalid EXR: PIZ Huffman data out of bounds');
  if (size & 1) throw new Error('Invalid EXR: PIZ chunk size is odd');
  const buffer = new Uint16Array(size >> 1);
  hufUncompress(input.subarray(position, position + length), buffer);

  // Wavelet decode each channel plane (FLOAT and UINT channels are two interleaved 16-bit planes).
  const starts: number[] = [];
  let start = 0;
  for (const channel of channels) {
    const components = channel.type === 'HALF' ? 1 : 2;
    starts.push(start);
    for (let j = 0; j < components; j++)
      wav2Decode(buffer, start + j, width, components, lines, width * components, maxValue);
    start += width * lines * components;
  }
  for (let i = 0; i < buffer.length; i++) buffer[i] = lut[buffer[i]];

  // Interleave the planes back into scanline order.
  const out = new Uint8Array(size),
    outView = new DataView(out.buffer);
  let o = 0;
  for (let y = 0; y < lines; y++)
    for (let c = 0; c < channels.length; c++) {
      const n = width * (channels[c].type === 'HALF' ? 1 : 2),
        from = starts[c] + y * n;
      for (let i = 0; i < n; i++, o += 2) outView.setUint16(o, buffer[from + i], true);
    }
  return out;
}

function hufUncompress(input: Uint8Array, out: Uint16Array): void {
  if (input.length < 20) throw new Error('Invalid EXR: truncated PIZ Huffman header');
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const im = view.getUint32(0, true),
    iM = view.getUint32(4, true),
    nBits = view.getUint32(12, true);
  if (im >= HUF_ENCSIZE || iM >= HUF_ENCSIZE || im > iM) throw new Error('Invalid EXR: bad Huffman symbol range');
  const codes = new Float64Array(HUF_ENCSIZE); // (code << 6) | length, may exceed 32 bits
  let position = 20;
  // Unpack the code length table.
  {
    let c = 0,
      lc = 0;
    const getBits = (n: number): number => {
      while (lc < n) {
        if (position >= input.length) throw new Error('Invalid EXR: truncated Huffman table');
        c = ((c << 8) | input[position++]) & 0xffffff;
        lc += 8;
      }
      lc -= n;
      return (c >> lc) & ((1 << n) - 1);
    };
    for (let i = im; i <= iM; i++) {
      const l = getBits(6);
      codes[i] = l;
      if (l === LONG_ZEROCODE_RUN) {
        let run = getBits(8) + SHORTEST_LONG_RUN;
        if (i + run > iM + 1) throw new Error('Invalid EXR: Huffman table overrun');
        while (run--) codes[i++] = 0;
        i--;
      } else if (l >= SHORT_ZEROCODE_RUN) {
        let run = l - SHORT_ZEROCODE_RUN + 2;
        if (i + run > iM + 1) throw new Error('Invalid EXR: Huffman table overrun');
        while (run--) codes[i++] = 0;
        i--;
      }
    }
  }
  // Canonical code assignment.
  const counts = new Float64Array(59);
  for (let i = 0; i < HUF_ENCSIZE; i++) counts[codes[i]]++;
  let code = 0;
  for (let i = 58; i > 0; i--) {
    const next = Math.floor((code + counts[i]) / 2);
    counts[i] = code;
    code = next;
  }
  const lengths = new Uint8Array(HUF_ENCSIZE);
  const values = new Float64Array(HUF_ENCSIZE);
  for (let i = 0; i < HUF_ENCSIZE; i++) {
    const l = codes[i];
    if (l > 0) {
      lengths[i] = l;
      values[i] = counts[l]++;
    }
  }
  // Decoding table: short codes fill a direct lookup, long codes chain off their 14-bit prefix.
  const decodeLength = new Uint8Array(HUF_DECSIZE),
    decodeLiteral = new Int32Array(HUF_DECSIZE);
  const longCodes: (number[] | undefined)[] = new Array(HUF_DECSIZE);
  for (let i = im; i <= iM; i++) {
    const l = lengths[i],
      c = values[i];
    if (!l) continue;
    if (l > MAX_CODE_LENGTH) throw new Error('Unsupported EXR: Huffman code too long');
    if (c >= 2 ** l) throw new Error('Invalid EXR: bad Huffman code');
    if (l > HUF_DECBITS) {
      const prefix = Math.floor(c / 2 ** (l - HUF_DECBITS));
      if (decodeLength[prefix]) throw new Error('Invalid EXR: bad Huffman table');
      (longCodes[prefix] ??= []).push(i);
    } else {
      const first = c * 2 ** (HUF_DECBITS - l),
        count = 1 << (HUF_DECBITS - l);
      for (let j = first; j < first + count; j++) {
        if (decodeLength[j] || longCodes[j]) throw new Error('Invalid EXR: bad Huffman table');
        decodeLength[j] = l;
        decodeLiteral[j] = i;
      }
    }
  }
  // Decode the bit stream. `c` holds the `lc` unread bits, kept below 2^53.
  const available = input.length - position;
  if (nBits > available * 8) throw new Error('Invalid EXR: Huffman bit count exceeds data');
  const end = position + Math.ceil(nBits / 8),
    rlc = iM,
    size = out.length;
  let c = 0,
    lc = 0,
    o = 0;
  const top = (n: number) =>
    lc <= 32 && n <= 30 ? (c >>> (lc - n)) & ((1 << n) - 1) : Math.floor(c / 2 ** (lc - n)) % 2 ** n;
  const consume = (n: number) => {
    lc -= n;
    c = lc <= 30 ? c & ((1 << lc) - 1) : c % 2 ** lc;
  };
  const emit = (symbol: number) => {
    if (symbol === rlc) {
      if (lc < 8) {
        if (position >= end) throw new Error('Invalid EXR: truncated Huffman run');
        c = c * 256 + input[position++];
        lc += 8;
      }
      const run = top(8);
      consume(8);
      if (o + run > size || o < 1) throw new Error('Invalid EXR: Huffman run out of bounds');
      out.fill(out[o - 1], o, o + run);
      o += run;
    } else {
      if (o >= size) throw new Error('Invalid EXR: Huffman output overflow');
      out[o++] = symbol;
    }
  };
  while (position < end) {
    c = c * 256 + input[position++];
    lc += 8;
    while (lc >= HUF_DECBITS) {
      const index = top(HUF_DECBITS) & HUF_DECMASK;
      if (decodeLength[index]) {
        consume(decodeLength[index]);
        emit(decodeLiteral[index]);
        continue;
      }
      const candidates = longCodes[index];
      if (!candidates) throw new Error('Invalid EXR: bad Huffman code in data');
      let matched = false;
      for (const symbol of candidates) {
        const l = lengths[symbol];
        while (lc < l && position < end) {
          c = c * 256 + input[position++];
          lc += 8;
        }
        if (lc >= l && top(l) === values[symbol]) {
          consume(l);
          emit(symbol);
          matched = true;
          break;
        }
      }
      if (!matched) throw new Error('Invalid EXR: bad Huffman code in data');
    }
  }
  const pad = (8 - nBits) & 7;
  c = Math.floor(c / 2 ** pad);
  lc -= pad;
  while (lc > 0) {
    const index = (c * 2 ** (HUF_DECBITS - lc)) % HUF_DECSIZE;
    if (!decodeLength[index] || decodeLength[index] > lc) throw new Error('Invalid EXR: bad Huffman tail');
    consume(decodeLength[index]);
    emit(decodeLiteral[index]);
  }
  if (o !== size) throw new Error(`Invalid EXR: Huffman produced ${o} of ${size} values`);
}

function wav2Decode(
  buffer: Uint16Array,
  start: number,
  nx: number,
  ox: number,
  ny: number,
  oy: number,
  maxValue: number,
): void {
  const w14 = maxValue < 1 << 14;
  const n = nx > ny ? ny : nx;
  let p = 1;
  while (p <= n) p <<= 1;
  p >>= 1;
  let p2 = p;
  p >>= 1;
  let a = 0,
    b = 0;
  // 14-bit and 16-bit inverse Haar steps; results land in `a` and `b`.
  const dec14 = (l: number, h: number) => {
    const ls = (l << 16) >> 16,
      hs = (h << 16) >> 16;
    const ai = ls + (hs & 1) + (hs >> 1);
    a = ai & 0xffff;
    b = (ai - hs) & 0xffff;
  };
  const dec16 = (l: number, h: number) => {
    const bb = (l - (h >> 1)) & 0xffff;
    a = (h + bb - 0x8000) & 0xffff;
    b = bb;
  };
  const dec = w14 ? dec14 : dec16;
  while (p >= 1) {
    let py = start;
    const ey = start + oy * (ny - p2),
      oy1 = oy * p,
      oy2 = oy * p2,
      ox1 = ox * p,
      ox2 = ox * p2;
    for (; py <= ey; py += oy2) {
      let px = py;
      const ex = py + ox * (nx - p2);
      for (; px <= ex; px += ox2) {
        const p01 = px + ox1,
          p10 = px + oy1,
          p11 = p10 + ox1;
        dec(buffer[px], buffer[p10]);
        const i00 = a,
          i10 = b;
        dec(buffer[p01], buffer[p11]);
        const i01 = a,
          i11 = b;
        dec(i00, i01);
        buffer[px] = a;
        buffer[p01] = b;
        dec(i10, i11);
        buffer[p10] = a;
        buffer[p11] = b;
      }
      if (nx & p) {
        const p10 = px + oy1;
        dec(buffer[px], buffer[p10]);
        buffer[px] = a;
        buffer[p10] = b;
      }
    }
    if (ny & p) {
      let px = py;
      const ex = py + ox * (nx - p2);
      for (; px <= ex; px += ox2) {
        const p01 = px + ox1;
        dec(buffer[px], buffer[p01]);
        buffer[px] = a;
        buffer[p01] = b;
      }
    }
    p2 = p;
    p >>= 1;
  }
}
