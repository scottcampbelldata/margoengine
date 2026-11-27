// KTX 1 reading (`@margoengine/decoders/ktx`), written from the Khronos KTX File Format Specification 1.1. The
// glInternalFormat picks the WebGPU format: 8-bit, half and full float one-, two- and four-channel formats, the packed
// float and 10-bit formats, and BC (S3TC, RGTC, BPTC), ETC1, ETC2, EAC and ASTC blocks, passed through. RGB8 and SRGB8
// expand to RGBA8. Mip levels, cube faces and arrays are read with the spec's row, cube and mip padding; big-endian
// files have their 16- and 32-bit values swapped. The KTXorientation key (section 2 "keyAndValue", values S=r|l and
// T=d|u) turns 2D and array images to top row first, left column first: texels are moved, and BC1 to BC5 blocks are
// rewritten without decoding (their 2-bit and 3-bit indices are stored row by row: Khronos Data Format Specification
// 1.3, "S3TC Compressed Texture Image Formats" and "RGTC Compressed Texture Image Formats"). Other key/value data is
// skipped. KTX2 files go through `KTX2Decoder` instead; 1D and 3D textures are refused.
import { decodeFailed } from './errors.js';
import { formatBlock, levelBytes, levelMajor, type TextureFile } from './texture-file.js';

export { uploadTexture } from './texture-file.js';
export type { TextureFile, TextureFileLevel, UploadTextureOptions } from './texture-file.js';

const IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x31, 0x31, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a],
  ASTC = ['4x4', '5x4', '5x5', '6x5', '6x6', '8x5', '8x6', '8x8', '10x5', '10x6', '10x8', '10x10', '12x10', '12x12'],
  GL: Record<number, string> = {
    0x8229: 'r8unorm',
    0x8f94: 'r8snorm',
    0x822b: 'rg8unorm',
    0x8f95: 'rg8snorm',
    0x8058: 'rgba8unorm',
    0x8c43: 'rgba8unorm-srgb',
    0x8f97: 'rgba8snorm',
    0x822d: 'r16float',
    0x822f: 'rg16float',
    0x881a: 'rgba16float',
    0x822e: 'r32float',
    0x8230: 'rg32float',
    0x8814: 'rgba32float',
    0x8059: 'rgb10a2unorm',
    0x8c3a: 'rg11b10ufloat',
    0x8c3d: 'rgb9e5ufloat',
    0x83f0: 'bc1-rgba-unorm',
    0x83f1: 'bc1-rgba-unorm',
    0x83f2: 'bc2-rgba-unorm',
    0x83f3: 'bc3-rgba-unorm',
    0x8c4c: 'bc1-rgba-unorm-srgb',
    0x8c4d: 'bc1-rgba-unorm-srgb',
    0x8c4e: 'bc2-rgba-unorm-srgb',
    0x8c4f: 'bc3-rgba-unorm-srgb',
    0x8dbb: 'bc4-r-unorm',
    0x8dbc: 'bc4-r-snorm',
    0x8dbd: 'bc5-rg-unorm',
    0x8dbe: 'bc5-rg-snorm',
    0x8e8c: 'bc7-rgba-unorm',
    0x8e8d: 'bc7-rgba-unorm-srgb',
    0x8e8e: 'bc6h-rgb-float',
    0x8e8f: 'bc6h-rgb-ufloat',
    0x8d64: 'etc2-rgb8unorm',
    0x9270: 'eac-r11unorm',
    0x9271: 'eac-r11snorm',
    0x9272: 'eac-rg11unorm',
    0x9273: 'eac-rg11snorm',
    0x9274: 'etc2-rgb8unorm',
    0x9275: 'etc2-rgb8unorm-srgb',
    0x9276: 'etc2-rgb8a1unorm',
    0x9277: 'etc2-rgb8a1unorm-srgb',
    0x9278: 'etc2-rgba8unorm',
    0x9279: 'etc2-rgba8unorm-srgb',
    ...Object.fromEntries(
      ASTC.flatMap((s, i) => [
        [0x93b0 + i, `astc-${s}-unorm`],
        [0x93d0 + i, `astc-${s}-unorm-srgb`],
      ]),
    ),
  },
  // RGB8 and SRGB8: three bytes per texel in the file, expanded to RGBA8.
  RGB8: Record<number, string> = { 0x8051: 'rgba8unorm', 0x8c41: 'rgba8unorm-srgb' },
  // COMPRESSED_RGB_S3TC_DXT1 and its sRGB twin carry no alpha (EXT_texture_compression_s3tc): a three-colour block's
  // fourth index is opaque black there, while bc1-rgba-unorm samples it with alpha 0, so the alpha must be ignored.
  OPAQUE_BC1 = new Set([0x83f0, 0x8c4c]);

/** Options of {@link parseKTX}. */
export interface KTXOptions {
  /**
   * Applies the file's `KTXorientation`, so rows come out top row first and columns left first, as every other Margo
   * reader returns them. `false` keeps the stored order. Default true. Cube map faces have the orientation the cube
   * face definitions give them, so they are never moved.
   */
  applyOrientation?: boolean;
}

const corrupt = (problem: string): Error =>
  decodeFailed(`KTX ${problem}; pass the complete bytes of a valid KTX 1 file`);
const refuse = (what: string): Error =>
  decodeFailed(`KTX ${what} is not supported; convert the file to a 2D, cube or array texture in a WebGPU format`);

/**
 * Reads a KTX 1 file: its 2D texture, cube map or array, every mip level, in a WebGPU format. Upload it with
 * {@link uploadTexture}; compressed results name the device feature they need in `feature`. A `KTXorientation` of
 * `T=u` (bottom row first, as OpenGL tools write) or `S=l` is applied. Where a block format cannot be mirrored without
 * decoding it (BC6H, BC7, ETC, EAC, ASTC, any compressed `S=l`, and BC1 to BC5 with a mip height that is not a multiple
 * of 4 above 4), the data stays as stored and `flipY` or `flipX` is true: sample it with that coordinate mirrored.
 *
 * @throws TypeError when `bytes` is not a Uint8Array.
 * @throws MargoError `failed` when the bytes are not a complete KTX 1 file, or hold a format or layout WebGPU cannot
 * sample (1D and 3D textures, integer, depth and luminance formats).
 */
export function parseKTX(bytes: Uint8Array, options: KTXOptions = {}): TextureFile {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('parseKTX needs the KTX file as a Uint8Array');
  if (bytes.length < 64 || IDENTIFIER.some((v, i) => bytes[i] !== v)) throw corrupt('identifier is missing');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    endian = view.getUint32(12, true),
    little = endian === 0x04030201;
  if (!little && endian !== 0x01020304) throw corrupt('endianness field is invalid');
  const u32 = (at: number) => view.getUint32(at, little),
    typeSize = u32(20),
    internal = u32(28),
    width = u32(36),
    height = u32(40),
    depth = u32(44),
    count = u32(48),
    faces = u32(52),
    levels = Math.max(1, u32(56)),
    expandRGB = RGB8[internal],
    format = GL[internal] ?? expandRGB;
  if (!format) throw refuse(`glInternalFormat 0x${internal.toString(16)}`);
  if (!width || width > 65536 || height > 65536) throw corrupt(`size ${width}x${height} is invalid`);
  if (!height) throw refuse('1D texture');
  if (depth > 1) throw refuse('3D texture');
  if (faces !== 1 && faces !== 6) throw corrupt(`numberOfFaces ${faces} is invalid`);
  if (faces === 6 && width !== height) throw corrupt('cube faces are not square');
  if (levels > 32 - Math.clz32(Math.max(width, height)))
    throw corrupt(`has ${levels} mip levels, too many for its size`);
  const block = formatBlock(format)!,
    compressed = block[0] > 1,
    texel = expandRGB ? 3 : block[2],
    swap = !little && !compressed && (typeSize === 2 || typeSize === 4) ? typeSize : 0,
    elements = Math.max(1, count),
    layers = elements * faces,
    chunks: Uint8Array[][] = Array.from({ length: layers }, () => []);
  let at = 64 + u32(60);
  if (at > bytes.length) throw corrupt('key/value data runs past the end');
  const turn = options.applyOrientation !== false && faces === 1 ? orientation(bytes, at, u32) : undefined,
    heights = Array.from({ length: levels }, (_, level) => Math.max(1, height >> level)),
    // Texels move for uncompressed formats. BC1 to BC5 rows turn inside their blocks, where every level allows it.
    flipRows = !!turn?.y && (!compressed || (/^bc[1-5]-/.test(format) && heights.every((h) => h < 4 || h % 4 === 0))),
    flipColumns = !!turn?.x && !compressed;
  for (let level = 0; level < levels; level++) {
    const w = Math.max(1, width >> level),
      h = Math.max(1, height >> level),
      // Uncompressed rows pad to 4 bytes (GL_UNPACK_ALIGNMENT); block rows do not.
      stride = compressed ? levelBytes(block, w, 1)[0] : (w * texel + 3) & ~3,
      tight = compressed ? stride : w * texel,
      rows = compressed ? Math.ceil(h / block[1]) : h,
      face = stride * rows,
      cubePadding = (4 - (face % 4)) % 4,
      // A non-array cube map's imageSize counts one face; every other imageSize counts the whole level.
      nonArrayCube = faces === 6 && !count;
    if (at + 4 > bytes.length) throw corrupt(`ends before mip ${level}`);
    const imageSize = u32(at),
      expected = nonArrayCube ? face : face * layers;
    if (imageSize !== expected) throw corrupt(`mip ${level} imageSize ${imageSize} should be ${expected}`);
    at += 4;
    for (let layer = 0; layer < layers; layer++) {
      if (at + face > bytes.length) throw corrupt(`ends inside mip ${level}`);
      let data = new Uint8Array(tight * rows);
      for (let y = 0; y < rows; y++) data.set(bytes.subarray(at + y * stride, at + y * stride + tight), y * tight);
      at += face + (nonArrayCube ? cubePadding : 0);
      if (swap) for (let i = 0; i < data.length; i += swap) data.subarray(i, i + swap).reverse();
      if (expandRGB) {
        const rgba = new Uint8Array(w * h * 4).fill(255);
        for (let i = 0; i < w * h; i++) rgba.set(data.subarray(i * 3, i * 3 + 3), i * 4);
        data = rgba;
      }
      if (flipRows) data = compressed ? flipBlocks(data, format, stride, h) : mirrorRows(data, data.length / h);
      if (flipColumns) mirrorColumns(data, data.length / h, data.length / (w * h));
      chunks[layer].push(data);
    }
    at += (4 - (at % 4)) % 4;
  }
  return {
    width,
    height,
    layers,
    dimension: faces === 6 ? (count ? 'cube-array' : 'cube') : count ? '2d-array' : '2d',
    mipmaps: levelMajor(chunks, width, height),
    format: format as GPUTextureFormat,
    ...(block[3] ? { feature: block[3] } : {}),
    target: 'ktx',
    srgb: format.endsWith('-srgb'),
    hasAlpha:
      !expandRGB && !OPAQUE_BC1.has(internal) && /^(rgba|rgb10a2|bc[1237]|etc2-rgba|etc2-rgb8a1|astc)/.test(format),
    ...(turn?.x && !flipColumns ? { flipX: true } : {}),
    ...(turn?.y && !flipRows ? { flipY: true } : {}),
  };
}

/**
 * The mirroring the `KTXorientation` entry of the key/value data (bytes 64 to `end`) asks for: `x` for `S=l`, `y` for
 * `T=u`. Each entry is a UInt32 byte size, a NUL-terminated key, its value and padding to 4 bytes (KTX 1.1, 2.11).
 */
function orientation(bytes: Uint8Array, end: number, u32: (at: number) => number): { x: boolean; y: boolean } {
  const text = new TextDecoder();
  for (let at = 64; at < end; ) {
    const size = at + 4 <= end ? u32(at) : end;
    if (size > end - at - 4) throw corrupt('a key/value entry runs past the key/value data');
    const entry = bytes.subarray(at + 4, at + 4 + size),
      split = entry.indexOf(0);
    if (split >= 0 && text.decode(entry.subarray(0, split)) === 'KTXorientation') {
      const value = text.decode(entry.subarray(split + 1)).split('\0')[0];
      return { x: /(^|,)S=l/.test(value), y: /(^|,)T=u/.test(value) };
    }
    at += 4 + ((size + 3) & ~3);
  }
  return { x: false, y: false };
}

/** The rows of `data`, `row` bytes each, bottom to top, as new bytes. */
function mirrorRows(data: Uint8Array, row: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(data.length);
  for (let at = 0; at < data.length; at += row) out.set(data.subarray(at, at + row), data.length - row - at);
  return out;
}

/** Reverses the `texel`-byte texels of every `row`-byte row of `data` in place. */
function mirrorColumns(data: Uint8Array, row: number, texel: number): void {
  for (let begin = 0; begin < data.length; begin += row)
    for (let a = begin, b = begin + row - texel; a < b; a += texel, b -= texel) {
      const left = data.slice(a, a + texel);
      data.copyWithin(a, b, b + texel);
      data.set(left, b);
    }
}

/**
 * One BC1 to BC5 level of `height` texel rows, upside down, as new bytes: the block rows (of `stride` bytes) swap, and
 * the index rows inside each block turn. A level under 4 rows is one block row, of which only its own rows turn.
 */
function flipBlocks(data: Uint8Array, format: string, stride: number, height: number): Uint8Array<ArrayBuffer> {
  const out = mirrorRows(data, stride),
    rows = Math.min(height, 4),
    bytes = /^bc[14]-/.test(format) ? 8 : 16,
    // BC1 rows are one index byte each; BC2 alpha rows two bytes; BC3, BC4 and BC5 3-bit rows twelve bits.
    color = (at: number) => out.subarray(at + 4, at + 4 + rows).reverse(),
    explicit = (at: number) => {
      const alpha = out.slice(at, at + 8);
      for (let y = 0; y < rows; y++) out.set(alpha.subarray((rows - 1 - y) * 2, (rows - y) * 2), at + y * 2);
    },
    indexed = (at: number) => {
      const low = out[at + 2] | (out[at + 3] << 8) | (out[at + 4] << 16),
        high = out[at + 5] | (out[at + 6] << 8) | (out[at + 7] << 16),
        row = [low & 0xfff, low >> 12, high & 0xfff, high >> 12],
        turned = [...row.slice(0, rows).reverse(), ...row.slice(rows)];
      for (let half = 0; half < 2; half++) {
        const bits = turned[half * 2] | (turned[half * 2 + 1] << 12);
        out.set([bits & 255, (bits >> 8) & 255, bits >> 16], at + 2 + half * 3);
      }
    };
  for (let at = 0; at < out.length; at += bytes) {
    if (format.startsWith('bc1-')) color(at);
    else if (format.startsWith('bc2-')) {
      explicit(at);
      color(at + 8);
    } else if (format.startsWith('bc3-')) {
      indexed(at);
      color(at + 8);
    } else {
      indexed(at);
      if (bytes === 16) indexed(at + 8);
    }
  }
  return out;
}
