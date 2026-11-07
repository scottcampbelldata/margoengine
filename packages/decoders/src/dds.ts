// DDS reading (`@margoengine/decoders/dds`), written from Microsoft's DirectDraw Surface documentation (DDS_HEADER,
// DDS_PIXELFORMAT, DDS_HEADER_DXT10). Block-compressed BC1-BC7 data passes through untouched as the matching WebGPU
// format (it needs `texture-compression-bc`; `decodeBC` in `bc.ts` gives the pixels on the CPU); BGRA8, BGRX8, 565, 5551, 4444, luminance and other bit-mask formats
// become rgba8unorm; RGBA8, R8, RG8, 16- and 32-bit float and the packed float formats pass through. 2D textures, cube
// maps and arrays of either, with their mip chains. Volume and 1D textures are refused.
import { decodeFailed } from './errors.js';
import { formatBlock, levelBytes, levelMajor, type TextureFile } from './texture-file.js';

export { uploadTexture } from './texture-file.js';
export type { TextureFile, TextureFileLevel, UploadTextureOptions } from './texture-file.js';

const FOURCC: Record<string, string> = {
    DXT1: 'bc1-rgba-unorm',
    DXT2: 'bc2-rgba-unorm',
    DXT3: 'bc2-rgba-unorm',
    DXT4: 'bc3-rgba-unorm',
    DXT5: 'bc3-rgba-unorm',
    ATI1: 'bc4-r-unorm',
    BC4U: 'bc4-r-unorm',
    BC4S: 'bc4-r-snorm',
    ATI2: 'bc5-rg-unorm',
    BC5U: 'bc5-rg-unorm',
    BC5S: 'bc5-rg-snorm',
    // D3DFORMAT numbers stored in the FourCC field.
    '111': 'r16float',
    '112': 'rg16float',
    '113': 'rgba16float',
    '114': 'r32float',
    '115': 'rg32float',
    '116': 'rgba32float',
  },
  DXGI: Record<number, string> = {
    2: 'rgba32float',
    10: 'rgba16float',
    16: 'rg32float',
    24: 'rgb10a2unorm',
    26: 'rg11b10ufloat',
    28: 'rgba8unorm',
    29: 'rgba8unorm-srgb',
    31: 'rgba8snorm',
    34: 'rg16float',
    41: 'r32float',
    49: 'rg8unorm',
    51: 'rg8snorm',
    54: 'r16float',
    61: 'r8unorm',
    63: 'r8snorm',
    67: 'rgb9e5ufloat',
    71: 'bc1-rgba-unorm',
    72: 'bc1-rgba-unorm-srgb',
    74: 'bc2-rgba-unorm',
    75: 'bc2-rgba-unorm-srgb',
    77: 'bc3-rgba-unorm',
    78: 'bc3-rgba-unorm-srgb',
    80: 'bc4-r-unorm',
    81: 'bc4-r-snorm',
    83: 'bc5-rg-unorm',
    84: 'bc5-rg-snorm',
    95: 'bc6h-rgb-ufloat',
    96: 'bc6h-rgb-float',
    98: 'bc7-rgba-unorm',
    99: 'bc7-rgba-unorm-srgb',
  },
  // DXGI formats converted to rgba8unorm: bits per pixel, R, G, B and A masks, sRGB.
  DXGI_MASKS: Record<number, [number, number, number, number, number, boolean?]> = {
    85: [16, 0xf800, 0x07e0, 0x001f, 0],
    86: [16, 0x7c00, 0x03e0, 0x001f, 0x8000],
    87: [32, 0xff0000, 0xff00, 0xff, 0xff000000],
    88: [32, 0xff0000, 0xff00, 0xff, 0],
    91: [32, 0xff0000, 0xff00, 0xff, 0xff000000, true],
    93: [32, 0xff0000, 0xff00, 0xff, 0, true],
    115: [16, 0x0f00, 0x00f0, 0x000f, 0xf000],
  };

const corrupt = (problem: string): Error => decodeFailed(`DDS ${problem}; pass the complete bytes of a valid DDS file`);
const refuse = (what: string): Error =>
  decodeFailed(`DDS ${what} is not supported; convert the file to a 2D, cube or array texture in a WebGPU format`);

/** Expands `count` little-endian pixels of `bytes` bytes each, through channel `masks` (R, G, B, A), to RGBA8. */
function expand(src: Uint8Array, count: number, bytes: number, masks: number[], luminance: boolean): Uint8Array {
  const out = new Uint8Array(count * 4),
    channels = [0, 1, 2, 3].map((c) => masks[luminance && c < 3 ? 0 : c] >>> 0);
  for (let i = 0; i < count; i++) {
    let pixel = 0;
    for (let b = 0; b < bytes; b++) pixel += src[i * bytes + b] * 2 ** (8 * b);
    for (let c = 0; c < 4; c++) {
      const m = channels[c];
      out[i * 4 + c] = m ? Math.round((((pixel & m) >>> 0) / m) * 255) : c === 3 ? 255 : 0;
    }
  }
  return out;
}

/**
 * Reads a DDS file: its 2D texture, cube map or array, every mip level, in a WebGPU format. Upload it with
 * {@link uploadTexture}; block-compressed results name `texture-compression-bc` in `feature`.
 *
 * @throws TypeError when `bytes` is not a Uint8Array.
 * @throws MargoError `failed` when the bytes are not a complete DDS file, or hold a format or layout WebGPU cannot
 * sample (volume and 1D textures, YUV, typeless or integer formats).
 */
export function parseDDS(bytes: Uint8Array): TextureFile {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('parseDDS needs the DDS file as a Uint8Array');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    u32 = (at: number) => view.getUint32(at, true);
  if (bytes.length < 128 || u32(0) !== 0x20534444 || u32(4) !== 124 || u32(76) !== 32)
    throw corrupt('header is missing');
  const height = u32(12),
    width = u32(16),
    flags = u32(80),
    caps2 = u32(112),
    fourCC = String.fromCharCode(bytes[84], bytes[85], bytes[86], bytes[87]),
    levels = Math.max(1, u32(28));
  if (!width || !height || width > 65536 || height > 65536) throw corrupt(`size ${width}x${height} is invalid`);
  if (levels > 32 - Math.clz32(Math.max(width, height)))
    throw corrupt(`has ${levels} mip levels, too many for its size`);
  if (caps2 & 0x200000 || (u32(8) & 0x800000 && u32(24) > 1)) throw refuse('volume texture');
  let format: string | undefined,
    masks: number[] | undefined,
    pixelBytes = 0,
    luminance = false,
    hasAlpha = true,
    cube = !!(caps2 & 0x200),
    count = 1,
    at = 128;
  if (cube && (caps2 & 0xfc00) !== 0xfc00) throw refuse('cube map without all six faces');
  if (flags & 4 && fourCC === 'DX10') {
    if (bytes.length < 148) throw corrupt('DX10 header is missing');
    const dxgi = u32(128),
      converted = DXGI_MASKS[dxgi];
    // Some writers leave the dimension and array size at zero; such a file is one 2D texture.
    if (u32(132) !== 3 && u32(132) !== 0) throw refuse(`resource dimension ${u32(132)} (only 2D textures)`);
    cube = !!(u32(136) & 4);
    count = u32(140) || 1;
    hasAlpha = (u32(144) & 7) !== 3;
    at = 148;
    if (converted) {
      [pixelBytes] = converted;
      pixelBytes /= 8;
      masks = converted.slice(1, 5) as number[];
      format = converted[5] ? 'rgba8unorm-srgb' : 'rgba8unorm';
      hasAlpha &&= !!converted[4];
    } else format = DXGI[dxgi];
    if (!format) throw refuse(`DXGI format ${dxgi}`);
  } else if (flags & 4) {
    const key = /^[\x20-\x7e]{4}$/.test(fourCC) ? fourCC : String(u32(84));
    format = FOURCC[key];
    if (!format) throw refuse(`FourCC ${key}`);
  } else if (flags & 0x20042) {
    const bits = u32(88),
      alpha = flags & 3 ? u32(104) : 0;
    luminance = !!(flags & 0x20000);
    masks = flags & 0x20040 ? [u32(92), u32(96), u32(100), alpha] : [0, 0, 0, alpha];
    if (![8, 16, 24, 32].includes(bits) || masks.every((m) => !m))
      throw corrupt(`pixel format of ${bits} bits is invalid`);
    pixelBytes = bits / 8;
    hasAlpha = !!alpha;
    format = 'rgba8unorm';
    // Plain RGBA8 needs no conversion.
    if (bits === 32 && !luminance && masks.join() === [0xff, 0xff00, 0xff0000, alpha ? 0xff000000 : 0].join() && alpha)
      masks = undefined;
  } else throw refuse('pixel format (YUV or unknown)');
  const block = formatBlock(format)!,
    layers = count * (cube ? 6 : 1),
    chunks: Uint8Array[][] = [];
  if (/^bc[456]/.test(format) || /^(r|rg)\d/.test(format)) hasAlpha = false;
  for (let layer = 0; layer < layers; layer++) {
    const faces: Uint8Array[] = [];
    for (let level = 0; level < levels; level++) {
      const w = Math.max(1, width >> level),
        h = Math.max(1, height >> level),
        size = masks ? w * h * pixelBytes : levelBytes(block, w, h)[0];
      if (at + size > bytes.length) throw corrupt(`ends inside layer ${layer} mip ${level}`);
      const data = bytes.subarray(at, (at += size));
      faces.push(masks ? expand(data, w * h, pixelBytes, masks, luminance) : data);
    }
    chunks.push(faces);
  }
  return {
    width,
    height,
    layers,
    dimension: cube ? (count > 1 ? 'cube-array' : 'cube') : layers > 1 ? '2d-array' : '2d',
    mipmaps: levelMajor(chunks, width, height),
    format: format as GPUTextureFormat,
    ...(block[3] ? { feature: block[3] } : {}),
    target: 'dds',
    srgb: format.endsWith('-srgb'),
    hasAlpha,
  };
}
