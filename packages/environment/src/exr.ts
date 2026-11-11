// OpenEXR scanline decoder for single-part scanline files with
// NONE, RLE, ZIPS, ZIP or PIZ compression and HALF, FLOAT or UINT channels.
import { halfFloats } from './half.js';
import { convertRGBA, exrChromaticities, exrToSRGB } from './exr-primaries.js';
import { inflateZlib } from '../../shared/inflate.js';
import { MAX_PIXELS, toBytes, type FloatImage } from './hdr.js';
import { MargoError } from '@margoengine/math/errors';

/** OpenEXR compressions `parseEXR` decodes (PXR24, B44, DWA and HTJ2K are rejected). */
export type EXRCompression = 'NONE' | 'RLE' | 'ZIPS' | 'ZIP' | 'PIZ';
/** One channel of an OpenEXR file, as listed in its header. */
export interface EXRChannel {
  /** Channel name, e.g. 'R', 'G', 'B', 'A', 'Y'. */
  name: string;
  /** Sample type in the file. */
  type: 'UINT' | 'HALF' | 'FLOAT';
  /** Horizontal subsampling (only 1 decodes). */
  xSampling: number;
  /** Vertical subsampling (only 1 decodes). */
  ySampling: number;
}
/** A decoded single-part scanline OpenEXR image: linear float RGBA, row 0 at the top, plus its header facts. */
export interface EXRImage extends FloatImage {
  /** Compression of the file's scanline chunks. */
  compression: EXRCompression;
  /** All channels in the file, in file (alphabetical) order. */
  channels: EXRChannel[];
  /** Which source channels filled RGBA: 'RGBA', 'RGB' or 'Y' (luminance replicated to RGB). */
  layout: 'RGBA' | 'RGB' | 'Y';
  /** Pixel bounds of the stored data, inclusive: [xMin, yMin, xMax, yMax]. */
  dataWindow: [number, number, number, number];
  /** Pixel bounds of the intended display area, inclusive: [xMin, yMin, xMax, yMax] (the data window when absent). */
  displayWindow: [number, number, number, number];
  /**
   * The `chromaticities` header attribute (red, green, blue and white CIE xy), `null` when the file has none (Rec.709
   * with the D65 white).
   */
  primaries: number[] | null;
  /**
   * True when the RGB was converted from other chromaticities to linear sRGB / Rec.709 (D65), white adapted with the
   * Bradford transform, as `parseHDR` does for PRIMARIES. Colours outside the sRGB gamut then carry negative components;
   * lighting reads them as 0. Luminance-only (`'Y'`) images are not converted.
   */
  primariesConverted: boolean;
}

const COMPRESSION_NAMES = ['NONE', 'RLE', 'ZIPS', 'ZIP', 'PIZ', 'PXR24', 'B44', 'B44A', 'DWAA', 'DWAB', 'HTJ2K'];
export const LINES_PER_BLOCK: Record<EXRCompression, number> = { NONE: 1, RLE: 1, ZIPS: 1, ZIP: 16, PIZ: 32 };
// Shared with the writer (exr-write.ts): the file magic and pixel types in their file order (index = type code).
export const EXR_MAGIC = 20000630;
export const TYPE_NAMES = ['UINT', 'HALF', 'FLOAT'] as const;
export const TYPE_SIZE = [4, 2, 4];
// Damaged data throws MargoError 'failed' (as parseHDR), a valid file this decoder does not read 'unsupported', and a
// decoder bound RangeError.
export const invalidEXR = (problem: string) =>
  new MargoError('failed', `Invalid EXR: ${problem}; the file is damaged or not OpenEXR, export it again`);
const invalid = invalidEXR;
export const unsupportedEXR = (message: string, fix = 'export it as a single-part scanline EXR') =>
  new MargoError('unsupported', `${message}; ${fix}`);
const unsupported = unsupportedEXR;

/** Header facts both the scanline and the tiled reader need (internal; shared with exr-tiled.ts). */
export interface EXRHeader {
  view: DataView;
  /** Byte position just past the header (the start of the offset table). */
  position: number;
  channels: EXRChannel[];
  compression: EXRCompression;
  dataWindow: [number, number, number, number];
  displayWindow: [number, number, number, number];
  lineOrder: number;
  /** The `tiles` attribute (tiledesc), present only in tiled files: tile size and the raw mode byte. */
  tiles?: { xSize: number; ySize: number; mode: number };
  width: number;
  height: number;
  /** Source channel index for R, G, B, A (-1 when absent). */
  indices: number[];
  layout: EXRImage['layout'];
}

/**
 * Reads the magic number, version and header of a single-part file (OpenEXR File Layout, "Version Field" and
 * "Header"). `tiled` says which part type the caller decodes; the other one is refused, as are deep and multi-part files.
 * @internal
 */
export function readEXRHeader(
  bytes: Uint8Array,
  tiled: boolean,
  unsupportedCompression = rejectCompression,
): EXRHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let position = 0;
  const need = (n: number) => {
    if (n < 0 || position + n > bytes.length) throw invalid('unexpected end of file');
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
      if (position - start >= limit) throw invalid('header name too long');
      position++;
    }
    need(1);
    let text = '';
    for (let i = start; i < position; i++) text += String.fromCharCode(bytes[i]);
    position++;
    return text;
  };

  if (bytes.length < 8 || view.getUint32(0, true) !== EXR_MAGIC) throw invalid('bad magic number');
  const version = view.getUint32(4, true);
  if ((version & 255) !== 2) throw unsupported(`Unsupported EXR version ${version & 255}`);
  if (version & 0x800) throw unsupported('Unsupported EXR: deep data');
  if (version & 0x1000) throw unsupported('Unsupported EXR: multi-part files');
  if (!tiled && version & 0x200)
    throw unsupported(
      'Unsupported EXR: tiled images',
      'read it with parseTiledEXR from @margoengine/environment/exr-tiled, or export it as a scanline EXR',
    );
  if (tiled && !(version & 0x200)) throw unsupported('Not a tiled EXR', 'read scanline files with parseEXR');
  const nameLimit = version & 0x400 ? 255 : 31;
  const partType = tiled ? 'tiledimage' : 'scanlineimage';
  position = 8;

  let channels: EXRChannel[] | undefined, compression: EXRCompression | undefined;
  let dataWindow: [number, number, number, number] | undefined,
    displayWindow: [number, number, number, number] | undefined;
  let lineOrder = 0;
  let tiles: EXRHeader['tiles'];
  for (let attributes = 0; ; attributes++) {
    if (attributes > 1024)
      throw new RangeError('Invalid EXR: too many header attributes; the decoder reads at most 1024');
    const name = string(nameLimit);
    if (name === '') break;
    const type = string(nameLimit),
      size = i32();
    need(size);
    const end = position + size;
    if (name === 'channels' && type === 'chlist') {
      channels = [];
      for (;;) {
        if (position >= end) throw invalid('unterminated channel list');
        const channelName = string(nameLimit);
        if (channelName === '') break;
        if (position + 16 > end) throw invalid('truncated channel list');
        const pixelType = i32();
        position += 4;
        const xSampling = i32(),
          ySampling = i32();
        if (pixelType < 0 || pixelType > 2) throw invalid(`channel ${channelName} has pixel type ${pixelType}`);
        channels.push({ name: channelName, type: TYPE_NAMES[pixelType], xSampling, ySampling });
      }
      if (channels.length > 1024)
        throw new RangeError('Invalid EXR: too many channels; the decoder reads at most 1024');
    } else if (name === 'compression' && type === 'compression') {
      if (size < 1)
        throw new TypeError(
          'Invalid EXR: bad compression; save the file with NONE, RLE, ZIPS, ZIP, PIZ, PXR24, B44 or DWA compression',
        );
      const value = bytes[position],
        label = COMPRESSION_NAMES[value] ?? `#${value}`;
      if (!(label in LINES_PER_BLOCK)) throw unsupportedCompression(label);
      compression = label as EXRCompression;
    } else if ((name === 'dataWindow' || name === 'displayWindow') && type === 'box2i') {
      if (size !== 16) throw invalid(`bad ${name}`);
      const box: [number, number, number, number] = [
        view.getInt32(position, true),
        view.getInt32(position + 4, true),
        view.getInt32(position + 8, true),
        view.getInt32(position + 12, true),
      ];
      if (name === 'dataWindow') dataWindow = box;
      else displayWindow = box;
    } else if (name === 'lineOrder' && type === 'lineOrder') {
      if (size < 1) throw new TypeError('Invalid EXR: bad lineOrder; re-save the file with a standard line order');
      lineOrder = bytes[position];
    } else if (tiled && name === 'tiles' && type === 'tiledesc') {
      if (size !== 9) throw invalid('bad tiles');
      tiles = {
        xSize: view.getUint32(position, true),
        ySize: view.getUint32(position + 4, true),
        mode: bytes[position + 8],
      };
    } else if (name === 'type' && type === 'string') {
      // Spread only a short value: a long one would overflow the call stack (and cannot be a known part type).
      const value = size <= 64 ? String.fromCharCode(...bytes.subarray(position, end)) : '(too long)';
      if (value !== partType)
        throw unsupported(
          `Unsupported EXR part type ${value}`,
          tiled ? 'export it as a single-part tiled or scanline EXR' : undefined,
        );
    }
    position = end;
  }
  if (!channels || !channels.length || !compression || !dataWindow)
    throw invalid('missing channels, compression or dataWindow');
  if (tiled && !tiles) throw invalid('missing tiles');
  if (lineOrder > 2) throw invalid('bad lineOrder');
  for (const channel of channels)
    if (channel.xSampling !== 1 || channel.ySampling !== 1)
      throw unsupported(`Unsupported EXR: subsampled channel ${channel.name}`, 'export full-resolution channels');
  const [xMin, yMin, xMax, yMax] = dataWindow;
  const width = xMax - xMin + 1,
    height = yMax - yMin + 1;
  if (!(width > 0 && height > 0) || width > 1 << 24 || height > 1 << 24 || width * height > MAX_PIXELS)
    throw new RangeError(
      `Invalid EXR size ${width}x${height}; 1 to ${1 << 24} a side and at most ${MAX_PIXELS} pixels decode`,
    );

  const pick = (name: string) => channels!.findIndex((c) => c.name === name);
  let indices: number[], layout: EXRImage['layout'];
  const [r, g, b, a, y] = ['R', 'G', 'B', 'A', 'Y'].map(pick);
  if (r >= 0 && g >= 0 && b >= 0) {
    indices = [r, g, b, a];
    layout = a >= 0 ? 'RGBA' : 'RGB';
  } else if (y >= 0) {
    indices = [y, y, y, a];
    layout = 'Y';
  } else
    throw new MargoError(
      'unsupported',
      `Unsupported EXR channels: ${channels.map((c) => c.name).join(', ')} (need R, G, B or Y)`,
    );
  return {
    view,
    position,
    channels,
    compression,
    dataWindow,
    displayWindow: displayWindow ?? dataWindow,
    lineOrder,
    tiles,
    width,
    height,
    indices,
    layout,
  };
}

function rejectCompression(label: string): MargoError {
  return unsupported(`Unsupported EXR compression ${label}`, 'export it with NONE, RLE, ZIPS, ZIP or PIZ');
}

/** Bytes of one pixel across every channel. @internal */
export const pixelBytesOf = (channels: EXRChannel[]) =>
  channels.reduce((sum, c) => sum + TYPE_SIZE[TYPE_NAMES.indexOf(c.type)], 0);

/**
 * Turns one chunk's stored bytes into its uncompressed lines: `lines` lines of `width` pixels, each line holding every
 * channel's samples in list order. A chunk whose size equals the uncompressed size is stored raw. @internal
 */
export function decodeEXRChunk(
  packed: Uint8Array,
  expected: number,
  compression: EXRCompression,
  channels: EXRChannel[],
  width: number,
  lines: number,
  label: string,
): Uint8Array {
  if (packed.length === expected) return packed; // Writers store a chunk raw when compression does not shrink it.
  if (compression === 'NONE') throw invalid(`${label} has ${packed.length} bytes, expected ${expected}`);
  if (compression === 'RLE') return unpredict(rleDecode(packed, expected));
  if (compression === 'ZIP' || compression === 'ZIPS') return unpredict(inflateZlib(packed, expected));
  return decodePizChunk(packed, expected, channels, width, lines);
}

/**
 * Copies uncompressed chunk lines (`width` pixels each) into RGBA floats at column `x0`, row `y0` of an image
 * `imageWidth` pixels wide. @internal
 */
export function copyEXRLines(
  raw: Uint8Array,
  lines: number,
  width: number,
  channels: EXRChannel[],
  indices: number[],
  data: Float32Array,
  imageWidth: number,
  x0: number,
  y0: number,
): void {
  const raw16 = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const halves = halfFloats();
  const lineBytes = pixelBytesOf(channels) * width;
  const channelOffsets: number[] = [];
  let o = 0;
  for (const c of channels) {
    channelOffsets.push(o);
    o += TYPE_SIZE[TYPE_NAMES.indexOf(c.type)] * width;
  }
  for (let line = 0; line < lines; line++) {
    const lineStart = line * lineBytes;
    for (let component = 0; component < 4; component++) {
      const channelIndex = indices[component];
      if (channelIndex < 0) continue;
      const type = channels[channelIndex].type;
      let source = lineStart + channelOffsets[channelIndex],
        target = ((y0 + line) * imageWidth + x0) * 4 + component;
      if (type === 'HALF')
        for (let x = 0; x < width; x++, source += 2, target += 4)
          data[target] = halves[raw[source] | (raw[source + 1] << 8)];
      else if (type === 'FLOAT')
        for (let x = 0; x < width; x++, source += 4, target += 4) data[target] = raw16.getFloat32(source, true);
      else for (let x = 0; x < width; x++, source += 4, target += 4) data[target] = raw16.getUint32(source, true);
    }
  }
}

/**
 * Parses a single-part scanline OpenEXR file into linear float RGBA. Picks the R, G, B and A channels
 * (or Y for luminance-only files); other channels are decoded and ignored. Tiled files are read by `parseTiledEXR`
 * (`@margoengine/environment/exr-tiled`); multi-part, deep and subsampled files and PXR24, B44 and DWA compression are
 * rejected with a descriptive error.
 * @throws MargoError `'failed'` for damaged data, `'unsupported'` for a file feature it does not decode; RangeError for an
 * image or chunk over its bounds; TypeError for a source that is not bytes or an empty compression or lineOrder value.
 */
export function parseEXR(source: ArrayBuffer | ArrayBufferView): EXRImage {
  const bytes = toBytes(source);
  const header = readEXRHeader(bytes, false);
  const { view, channels, compression, dataWindow, displayWindow, width, height, indices, layout } = header;
  let position = header.position;
  const yMin = dataWindow[1];

  const linesPerBlock = LINES_PER_BLOCK[compression];
  const blocks = Math.ceil(height / linesPerBlock);
  if (position + blocks * 8 > bytes.length) throw invalid('unexpected end of file');
  const offsets: number[] = [];
  for (let i = 0; i < blocks; i++) {
    const low = view.getUint32(position, true),
      high = view.getUint32(position + 4, true);
    position += 8;
    offsets.push(high ? Infinity : low);
  }
  const lineBytes = pixelBytesOf(channels) * width;

  // Every chunk is checked before the image is allocated, so a small or truncated file cannot make the parser allocate a
  // large one: each chunk lies inside the file and together they could hold every line (deflate expands at most about
  // 1032:1, RLE 64:1 and PIZ's Huffman runs about 450:1; NONE stores lines as they are).
  let capacity = 0;
  for (let block = 0; block < blocks; block++) {
    const offset = offsets[block];
    if (!(offset >= 8 && offset + 8 <= bytes.length))
      throw new RangeError(
        `Invalid EXR: chunk ${block} offset out of bounds; the file is truncated, download or export it again`,
      );
    const dataSize = view.getInt32(offset + 4, true);
    if (dataSize < 0 || offset + 8 + dataSize > bytes.length)
      throw new RangeError(
        `Invalid EXR: chunk ${block} data out of bounds; the file is truncated, download or export it again`,
      );
    capacity += dataSize * (compression === 'NONE' ? 1 : 2048);
  }
  if (capacity < height * lineBytes)
    throw new RangeError(
      'Invalid EXR: chunks are too small for the image size; the file is truncated, download or export it again',
    );
  // One chunk's decoded lines are allocated at once (many channels times a wide image can claim gigabytes).
  if (Math.min(linesPerBlock, height) * lineBytes > 1 << 28)
    throw new RangeError(
      'Unsupported EXR: a chunk decodes to more than 256 MiB; export the image with smaller chunks or a smaller size',
    );
  const data = new Float32Array(width * height * 4);
  if (indices[3] < 0) for (let i = 3; i < data.length; i += 4) data[i] = 1;
  const filled = new Uint8Array(blocks);
  for (let block = 0; block < blocks; block++) {
    const offset = offsets[block]; // in bounds, with its data: checked before the image was allocated
    const blockY = view.getInt32(offset, true),
      dataSize = view.getInt32(offset + 4, true);
    const index = (blockY - yMin) / linesPerBlock;
    if (!Number.isInteger(index) || index < 0 || index >= blocks || filled[index])
      throw invalid(`chunk ${block} has bad y ${blockY}`);
    filled[index] = 1;
    const lines = Math.min(linesPerBlock, height - index * linesPerBlock);
    const packed = bytes.subarray(offset + 8, offset + 8 + dataSize);
    const raw = decodeEXRChunk(packed, lines * lineBytes, compression, channels, width, lines, `chunk ${block}`);
    copyEXRLines(raw, lines, width, channels, indices, data, width, 0, index * linesPerBlock);
  }
  const primaries = exrChromaticities(bytes),
    convert = layout === 'Y' ? null : exrToSRGB(primaries);
  if (convert) convertRGBA(data, convert);
  return {
    width,
    height,
    data,
    compression,
    channels,
    layout,
    dataWindow,
    displayWindow,
    primaries,
    primariesConverted: !!convert,
  };
}

// ------------------------------------------------------------------ RLE, ZIP and ZIPS reconstruction

/**
 * Expands an RLE chunk (OpenEXR Technical Introduction, "Data Compression"). Each packet starts with a signed count
 * byte: a negative count -k is followed by k literal bytes, a count k >= 0 by one byte repeated k + 1 times.
 * The packets must fill exactly `expected` bytes.
 */
function rleDecode(packed: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let read = 0,
    written = 0;
  while (read < packed.length) {
    const count = (packed[read++] << 24) >> 24;
    if (count < 0) {
      const length = -count;
      if (read + length > packed.length || written + length > expected) throw invalid('RLE literal out of bounds');
      out.set(packed.subarray(read, read + length), written);
      read += length;
      written += length;
    } else {
      const length = count + 1;
      if (read >= packed.length || written + length > expected) throw invalid('RLE run out of bounds');
      out.fill(packed[read++], written, written + length);
      written += length;
    }
  }
  if (written !== expected) throw invalid('RLE chunk size mismatch');
  return out;
}

/**
 * Undoes the byte predictor and the even/odd split that RLE, ZIPS and ZIP apply before compressing. The stored bytes
 * are differences biased by 128; once summed, the first half (rounded up) holds the even-indexed output bytes and the
 * rest the odd-indexed ones.
 */
function unpredict(stored: Uint8Array): Uint8Array {
  // One pass: the running sum stays in a register and lands straight in its de-interleaved slot.
  const n = stored.length,
    out = new Uint8Array(n),
    half = (n + 1) >> 1;
  if (!n) return out;
  let sum = stored[0];
  out[0] = sum;
  for (let i = 1; i < half; i++) out[2 * i] = sum = (sum + stored[i] - 128) & 255;
  for (let i = half, o = 1; i < n; i++, o += 2) out[o] = sum = (sum + stored[i] - 128) & 255;
  return out;
}

// ------------------------------------------------------------------ PIZ

// Format facts (OpenEXR PIZ): the bitmap covers every 16-bit value, the Huffman alphabet is the 65,536 words plus one
// run symbol, and code lengths are packed in 6-bit fields whose top values 59..63 encode runs of absent symbols.
const BITMAP_BYTES = 8192;
const WORD_VALUES = 65536;
const SYMBOLS = WORD_VALUES + 1;
const LENGTH_FIELD_BITS = 6;
const SHORT_ABSENT_FIRST = 59; // 59..62: 2..5 absent symbols
const LONG_ABSENT = 63; // followed by 8 bits: 6..261 absent symbols
const LARGEST_LEGAL_LENGTH = 58;
// Margo's own cap: codes up to 44 bits keep every code and bit read exact in a double.
const LONGEST_SUPPORTED_LENGTH = 44;
// Decoding window: codes up to this many bits resolve with one table lookup; longer ones by their 14-bit prefix.
const WINDOW_BITS = 14;
const WINDOW_SIZE = 1 << WINDOW_BITS;
// The wavelet runs in its 14-bit form while every rank fits in 14 bits, else in its 16-bit form.
const FOURTEEN_BIT_LIMIT = 1 << 14;

/**
 * Decodes the pixel data of one PIZ chunk (after its 8-byte y / size prefix) into the chunk's uncompressed scanline
 * bytes: for each line, each channel in list order, its `width` samples little-endian.
 * `size` is lines * width * (sum of channel sample sizes); the result has exactly that length.
 */
function decodePizChunk(
  input: Uint8Array,
  size: number,
  channels: EXRChannel[],
  width: number,
  lines: number,
): Uint8Array {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (input.length < 4) throw invalid('truncated PIZ chunk');
  const firstByte = view.getUint16(0, true),
    lastByte = view.getUint16(2, true);
  if (lastByte >= BITMAP_BYTES) throw invalid('PIZ bitmap out of range');
  const bitmapLength = firstByte <= lastByte ? lastByte - firstByte + 1 : 0;
  let at = 4;
  if (at + bitmapLength > input.length) throw invalid('truncated PIZ bitmap');
  const bitmap = new Uint8Array(BITMAP_BYTES);
  bitmap.set(input.subarray(at, at + bitmapLength), firstByte);
  at += bitmapLength;
  if (at + 4 > input.length) throw invalid('truncated PIZ chunk');
  const huffmanLength = view.getInt32(at, true);
  at += 4;
  if (huffmanLength < 0 || at + huffmanLength > input.length) throw invalid('PIZ Huffman data out of bounds');
  if (size % 2) throw invalid('PIZ chunk size is odd');

  // Ranks back to values: rank k is the k-th present value counting up from 0, which is always present.
  const values = new Uint16Array(WORD_VALUES);
  let present = 0;
  for (let value = 0; value < WORD_VALUES; value++)
    if (value === 0 || bitmap[value >> 3] & (1 << (value & 7))) values[present++] = value;

  const words = decodeHuffman(input.subarray(at, at + huffmanLength), size / 2);

  const fourteenBit = present - 1 < FOURTEEN_BIT_LIMIT;
  let planeStart = 0;
  for (const channel of channels) {
    const parts = channel.type === 'HALF' ? 1 : 2;
    for (let part = 0; part < parts; part++)
      inverseWavelet(words, planeStart + part, width, lines, parts, parts * width, fourteenBit);
    planeStart += parts * width * lines;
  }
  for (let i = 0; i < words.length; i++) words[i] = values[words[i]];

  const out = new Uint8Array(size);
  let o = 0;
  for (let line = 0; line < lines; line++) {
    let start = 0;
    for (const channel of channels) {
      const rowWords = (channel.type === 'HALF' ? 1 : 2) * width;
      for (let i = start + line * rowWords, end = i + rowWords; i < end; i++) {
        const word = words[i];
        out[o++] = word & 255;
        out[o++] = word >> 8;
      }
      start += rowWords * lines;
    }
  }
  return out;
}

/**
 * Decodes PIZ's Huffman section (20-byte header, packed code lengths, then the coded words) into exactly `count`
 * 16-bit words. The largest symbol in the table is the run symbol: it is followed by an 8-bit count of extra copies of
 * the previous word.
 */
function decodeHuffman(section: Uint8Array, count: number): Uint16Array {
  if (section.length < 20) throw invalid('truncated PIZ Huffman header');
  const header = new DataView(section.buffer, section.byteOffset, 20);
  const lowest = header.getUint32(0, true),
    highest = header.getUint32(4, true),
    bitCount = header.getUint32(12, true);
  if (lowest >= SYMBOLS || highest >= SYMBOLS || lowest > highest) throw invalid('bad Huffman symbol range');

  // Packed code lengths, read MSB-first from byte 20.
  const lengths = new Uint8Array(SYMBOLS);
  const tableBits = (section.length - 20) * 8;
  let bit = 0;
  const take = (n: number): number => {
    if (bit + n > tableBits) throw invalid('truncated Huffman table');
    let value = 0;
    for (let k = 0; k < n; k++, bit++) value = (value << 1) | ((section[20 + (bit >> 3)] >> (7 - (bit & 7))) & 1);
    return value;
  };
  for (let symbol = lowest; symbol <= highest; ) {
    const field = take(LENGTH_FIELD_BITS);
    if (field < SHORT_ABSENT_FIRST) {
      lengths[symbol++] = field;
      continue;
    }
    const absent = field === LONG_ABSENT ? take(8) + 6 : field - SHORT_ABSENT_FIRST + 2;
    if (symbol + absent > highest + 1) throw invalid('Huffman table overrun');
    symbol += absent; // their lengths stay 0
  }
  const dataStart = 20 + Math.ceil(bit / 8);

  // Canonical codes: longer codes take smaller values; within one length, codes follow symbol order.
  const perLength = new Float64Array(LARGEST_LEGAL_LENGTH + 1);
  for (let symbol = lowest; symbol <= highest; symbol++) perLength[lengths[symbol]]++;
  const next = new Float64Array(LARGEST_LEGAL_LENGTH + 1);
  for (let length = LARGEST_LEGAL_LENGTH, c = 0; length >= 1; length--) {
    next[length] = c;
    c = Math.floor((c + perLength[length]) / 2);
  }

  // Lookup: a window value maps to the short code covering it, or to the long codes that have it as their prefix.
  const codes = new Float64Array(SYMBOLS);
  const windowSymbol = new Int32Array(WINDOW_SIZE).fill(-1);
  const windowLength = new Uint8Array(WINDOW_SIZE);
  const longByPrefix = new Map<number, number[]>();
  for (let symbol = lowest; symbol <= highest; symbol++) {
    const length = lengths[symbol];
    if (!length) continue;
    if (length > LONGEST_SUPPORTED_LENGTH)
      throw unsupported('Unsupported EXR: Huffman code too long', 'export it with ZIP compression');
    const code = next[length]++;
    if (code >= 2 ** length) throw invalid('bad Huffman code');
    codes[symbol] = code;
    if (length <= WINDOW_BITS) {
      const first = code * 2 ** (WINDOW_BITS - length),
        end = first + 2 ** (WINDOW_BITS - length);
      for (let w = first; w < end; w++) {
        if (windowSymbol[w] >= 0 || longByPrefix.has(w)) throw invalid('bad Huffman table');
        windowSymbol[w] = symbol;
        windowLength[w] = length;
      }
    } else {
      const prefix = Math.floor(code / 2 ** (length - WINDOW_BITS));
      if (windowSymbol[prefix] >= 0) throw invalid('bad Huffman table');
      const list = longByPrefix.get(prefix);
      if (list) list.push(symbol);
      else longByPrefix.set(prefix, [symbol]);
    }
  }
  if (bitCount > (section.length - dataStart) * 8) throw invalid('Huffman bit count exceeds data');

  const data = section.subarray(dataStart, dataStart + Math.ceil(bitCount / 8));
  const totalBits = data.length * 8;
  const byteAt = (i: number) => (i < data.length ? data[i] : 0);
  // The 14 bits starting at bit position p (zeros past the data).
  const peekWindow = (p: number): number => {
    const i = p >>> 3;
    const three = (byteAt(i) << 16) | (byteAt(i + 1) << 8) | byteAt(i + 2);
    return (three >> (10 - (p & 7))) & (WINDOW_SIZE - 1);
  };
  // n bits (n <= 44) starting at bit position p, all inside the data.
  const readBits = (p: number, n: number): number => {
    let value = 0;
    for (let k = 0; k < n; k++, p++) value = value * 2 + ((data[p >>> 3] >> (7 - (p & 7))) & 1);
    return value;
  };

  const out = new Uint16Array(count);
  let produced = 0,
    position = 0;
  // Outputs one decoded symbol whose code ended at bit `at`; returns the position after it (and after a run count).
  const emit = (symbol: number, at: number): number => {
    if (symbol !== highest) {
      if (produced >= count) throw invalid('Huffman output overflow');
      out[produced++] = symbol;
      return at;
    }
    const repeat = readBits(at, 8);
    if (produced === 0 || produced + repeat > count) throw invalid('Huffman run out of bounds');
    out.fill(out[produced - 1], produced, produced + repeat);
    produced += repeat;
    return at + 8;
  };

  // Phase 1: a full window is available (padding bits count as available).
  while (totalBits - position >= WINDOW_BITS) {
    const w = peekWindow(position);
    let symbol = windowSymbol[w],
      length = windowLength[w];
    if (symbol < 0) {
      const candidates = longByPrefix.get(w);
      if (candidates)
        for (const candidate of candidates) {
          const l = lengths[candidate];
          if (totalBits - position >= l && readBits(position, l) === codes[candidate]) {
            symbol = candidate;
            length = l;
            break;
          }
        }
      if (symbol < 0) throw invalid('bad Huffman code in data');
    }
    position += length;
    if (symbol === highest && totalBits - position < 8) throw invalid('truncated Huffman run');
    position = emit(symbol, position);
  }

  // Phase 2: under 14 bits left; only the meaningful ones (not the padding) are decoded, with short codes.
  let left = bitCount - position;
  while (left > 0) {
    const shift = WINDOW_BITS - left;
    const w = (peekWindow(position) >> shift) << shift;
    const symbol = windowSymbol[w],
      length = windowLength[w];
    if (symbol < 0 || length > left) throw invalid('bad Huffman tail');
    position += length;
    left -= length;
    if (symbol === highest) {
      if (left < 8) throw invalid('truncated Huffman run');
      left -= 8;
    }
    position = emit(symbol, position);
  }

  if (produced !== count) throw invalid(`Huffman produced ${produced} of ${count} values`);
  return out;
}

/**
 * Inverts PIZ's Haar-like wavelet in place on one sub-plane of `words`: element (x, y) sits at
 * start + x * xStride + y * yStride for 0 <= x < nx, 0 <= y < ny. Levels run coarsest first; at each level an odd
 * last column or row is transformed in one direction only.
 */
function inverseWavelet(
  words: Uint16Array,
  start: number,
  nx: number,
  ny: number,
  xStride: number,
  yStride: number,
  fourteenBit: boolean,
): void {
  // Inverse of one (low, high) pair; the two results land in pair[0] and pair[1].
  const pair = [0, 0];
  const unpair = fourteenBit
    ? (low: number, high: number) => {
        const l = low >= 32768 ? low - 65536 : low,
          h = high >= 32768 ? high - 65536 : high;
        const a = l + (h & 1) + (h >> 1);
        pair[0] = a & 0xffff;
        pair[1] = (a - h) & 0xffff;
      }
    : (low: number, high: number) => {
        const b = (low - (high >> 1)) & 0xffff;
        pair[0] = (high + b - 32768) & 0xffff;
        pair[1] = b;
      };
  const smaller = Math.min(nx, ny);
  if (smaller < 2) return;
  let top = 1;
  while (top * 2 <= smaller) top *= 2;
  for (let p = top >> 1; p >= 1; p >>= 1) {
    const q = 2 * p;
    const dx = p * xStride,
      dy = p * yStride;
    const fullX = nx - (nx % q),
      fullY = ny - (ny % q);
    for (let y0 = 0; y0 < fullY; y0 += q) {
      const row = start + y0 * yStride;
      for (let x0 = 0; x0 < fullX; x0 += q) {
        const i00 = row + x0 * xStride,
          i10 = i00 + dx,
          i01 = i00 + dy,
          i11 = i01 + dx;
        unpair(words[i00], words[i01]);
        const s = pair[0],
          t = pair[1];
        unpair(words[i10], words[i11]);
        const u = pair[0],
          v = pair[1];
        unpair(s, u);
        words[i00] = pair[0];
        words[i10] = pair[1];
        unpair(t, v);
        words[i01] = pair[0];
        words[i11] = pair[1];
      }
      if (nx & p) {
        const i0 = row + fullX * xStride,
          i1 = i0 + dy;
        unpair(words[i0], words[i1]);
        words[i0] = pair[0];
        words[i1] = pair[1];
      }
    }
    if (ny & p) {
      const row = start + fullY * yStride;
      for (let x0 = 0; x0 < fullX; x0 += q) {
        const i0 = row + x0 * xStride,
          i1 = i0 + dx;
        unpair(words[i0], words[i1]);
        words[i0] = pair[0];
        words[i1] = pair[1];
      }
    }
  }
}
