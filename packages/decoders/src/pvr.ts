// PVR reading (`@margoengine/decoders/pvr`): legacy PVRTC files to RGBA8 on the CPU, since no WebGPU device samples PVRTC.
// Written from the public PVR container descriptions (version 3, and the older 52 byte header) and Fenney's paper
// "Texture Compression using Low-Frequency Signal Modulation": two low resolution images, A and B, are upscaled
// bilinearly and each texel blends them by a 2 bit or 1 bit modulation value. PVRTC 1 only, at 2 and 4 bits a texel.
import { decodeFailed } from './errors.js';
import type { TextureFile } from './texture-file.js';

export { uploadTexture } from './texture-file.js';
export type { TextureFile, TextureFileLevel, UploadTextureOptions } from './texture-file.js';

const VERSION_3 = 0x03525650,
  VERSION_3_SWAPPED = 0x50565203,
  OLD_HEADER = 52,
  OLD_TAG = 0x21525650,
  OLD_PVRTC2 = [0x0c, 0x18],
  OLD_PVRTC4 = [0x0d, 0x19],
  OLD_ALPHA = 0x8000,
  OLD_CUBE = 0x1000,
  SRGB = 1,
  MODULATION = [0, 3, 5, 8];

const refuse = (what: string): Error => decodeFailed(`PVR: ${what}; convert the file to KTX2`);

// Blocks are stored in Morton order over the square part of the grid; the rest of the longer side sits above it.
function twiddle(x: number, y: number, blocksX: number, blocksY: number): number {
  const small = Math.min(blocksX, blocksY);
  let out = 0,
    bit = 1,
    shift = 0;
  for (let size = 1; size < small; size <<= 1, bit <<= 2, shift++) {
    if (y & size) out |= bit;
    if (x & size) out |= bit << 1;
  }
  return out + (blocksX > blocksY ? x >> shift : y >> shift) * small * small;
}

const wrap = (value: number, size: number): number => value & (size - 1);

// The 5 bit colours and 4 bit alpha of one half of a block's colour word. Bit 15 says opaque; transparent halves hold
// 3 bits of alpha and fewer bits of colour. The A half has one blue bit fewer than the B half.
function unpackColour(half: number, out: Int32Array, at: number, isB: boolean): void {
  if (half & 0x8000) {
    out[at] = (half >> 10) & 31;
    out[at + 1] = (half >> 5) & 31;
    if (isB) out[at + 2] = half & 31;
    else {
      const blue = (half >> 1) & 15;
      out[at + 2] = (blue << 1) | (blue >> 3);
    }
    out[at + 3] = 15;
    return;
  }
  const red = (half >> 8) & 15,
    green = (half >> 4) & 15;
  out[at] = (red << 1) | (red >> 3);
  out[at + 1] = (green << 1) | (green >> 3);
  if (isB) {
    const blue = half & 15;
    out[at + 2] = (blue << 1) | (blue >> 3);
  } else {
    const blue = (half >> 1) & 7;
    out[at + 2] = (blue << 2) | (blue >> 1);
  }
  out[at + 3] = ((half >> 12) & 7) << 1;
}

/** Bytes of one image of PVRTC data: never fewer than 2 by 2 blocks. */
export function pvrtcBytes(width: number, height: number, twoBit: boolean): number {
  return Math.max(2, Math.ceil(width / (twoBit ? 8 : 4))) * Math.max(2, Math.ceil(height / 4)) * 8;
}

/**
 * Decodes one image of PVRTC data to RGBA8, `width * height * 4` bytes. Sizes are powers of two, as PVRTC 1 needs.
 *
 * @throws RangeError when a size is not a power of two or `data` is too short.
 */
export function decodePVRTC(data: Uint8Array, width: number, height: number, twoBit: boolean): Uint8Array {
  if (width < 1 || height < 1 || width & (width - 1) || height & (height - 1))
    throw new RangeError(`PVRTC needs power-of-two sizes, not ${width}x${height}`);
  if (data.length < pvrtcBytes(width, height, twoBit))
    throw new RangeError(`PVRTC data of ${data.length} bytes is too short for ${width}x${height}; pass the whole level`);
  const blockWidth = twoBit ? 8 : 4,
    blocksX = Math.max(2, width / blockWidth),
    blocksY = Math.max(2, height / 4),
    view = new DataView(data.buffer, data.byteOffset, data.byteLength),
    colourA = new Int32Array(blocksX * blocksY * 4),
    colourB = new Int32Array(blocksX * blocksY * 4),
    fullWidth = blocksX * blockWidth,
    fullHeight = blocksY * 4,
    modulation = new Uint8Array(fullWidth * fullHeight),
    // Texels of 4 bit punch-through blocks that are fully transparent.
    clear = new Uint8Array(fullWidth * fullHeight),
    // Texels of 2 bit blocks whose modulation comes from their neighbours, once all blocks are read: place, x, y, kind.
    derived: number[] = [];
  for (let y = 0; y < blocksY; y++)
    for (let x = 0; x < blocksX; x++) {
      const at = twiddle(x, y, blocksX, blocksY) * 8,
        colour = view.getUint32(at + 4, true),
        block = (y * blocksX + x) * 4,
        flag = colour & 1;
      let word = view.getUint32(at, true);
      unpackColour(colour & 0xffff, colourA, block, false);
      unpackColour(colour >>> 16, colourB, block, true);
      if (!twoBit) {
        for (let t = 0; t < 16; t++) {
          const value = (word >>> (t * 2)) & 3,
            place = (y * 4 + (t >> 2)) * fullWidth + x * 4 + (t & 3);
          if (!flag) modulation[place] = MODULATION[value];
          else {
            modulation[place] = value === 0 ? 0 : value === 3 ? 8 : 4;
            clear[place] = value === 2 ? 1 : 0;
          }
        }
      } else if (!flag) {
        for (let t = 0; t < 32; t++)
          modulation[(y * 4 + (t >> 3)) * fullWidth + x * 8 + (t & 7)] = (word >>> t) & 1 ? 8 : 0;
      } else {
        // Every other texel is stored, in 2 bits. Bits 0 and 20 say which neighbours fill the rest, then take the
        // value of the bits above them.
        let kind = 0;
        if (word & 1) {
          kind = word & (1 << 20) ? 2 : 1;
          word = word & (1 << 21) ? word | (1 << 20) : word & ~(1 << 20);
        }
        word = word & 2 ? word | 1 : word & ~1;
        for (let row = 0; row < 4; row++)
          for (let column = 0; column < 8; column++) {
            const px = x * 8 + column,
              py = y * 4 + row;
            if ((column ^ row) & 1) derived.push(py * fullWidth + px, px, py, kind);
            else {
              modulation[py * fullWidth + px] = MODULATION[word & 3];
              word >>>= 2;
            }
          }
      }
    }
  for (let i = 0; i < derived.length; i += 4) {
    const px = derived[i + 1],
      py = derived[i + 2],
      kind = derived[i + 3],
      across = modulation[py * fullWidth + wrap(px - 1, fullWidth)] + modulation[py * fullWidth + wrap(px + 1, fullWidth)],
      down = modulation[wrap(py - 1, fullHeight) * fullWidth + px] + modulation[wrap(py + 1, fullHeight) * fullWidth + px];
    modulation[derived[i]] = kind === 0 ? (across + down + 2) >> 2 : kind === 1 ? (across + 1) >> 1 : (down + 1) >> 1;
  }
  const out = new Uint8Array(width * height * 4),
    half = blockWidth >> 1,
    shift = twoBit ? 1 : 0;
  for (let y = 0; y < height; y++) {
    // Each block's colours sit at its centre, and the images wrap at the edges.
    const row = y - 2,
      y0 = wrap(row >> 2, blocksY),
      y1 = wrap(y0 + 1, blocksY),
      fy = row & 3;
    for (let x = 0; x < width; x++) {
      const column = x - half,
        x0 = wrap(Math.floor(column / blockWidth), blocksX),
        x1 = wrap(x0 + 1, blocksX),
        fx = column & (blockWidth - 1),
        w00 = (blockWidth - fx) * (4 - fy),
        w10 = fx * (4 - fy),
        w01 = (blockWidth - fx) * fy,
        w11 = fx * fy,
        i00 = (y0 * blocksX + x0) * 4,
        i10 = (y0 * blocksX + x1) * 4,
        i01 = (y1 * blocksX + x0) * 4,
        i11 = (y1 * blocksX + x1) * 4,
        place = y * fullWidth + x,
        blend = modulation[place],
        at = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) {
        // Sixteenths of a 5 bit colour or 4 bit alpha, scaled to 8 bits before the blend.
        const a =
            (w00 * colourA[i00 + c] + w10 * colourA[i10 + c] + w01 * colourA[i01 + c] + w11 * colourA[i11 + c]) >> shift,
          b =
            (w00 * colourB[i00 + c] + w10 * colourB[i10 + c] + w01 * colourB[i01 + c] + w11 * colourB[i11 + c]) >> shift,
          a8 = c < 3 ? (a >> 1) + (a >> 6) : a + (a >> 4),
          b8 = c < 3 ? (b >> 1) + (b >> 6) : b + (b >> 4);
        out[at + c] = (a8 * (8 - blend) + b8 * blend) >> 3;
      }
      if (clear[place]) out[at + 3] = 0;
    }
  }
  return out;
}

interface Layout {
  width: number;
  height: number;
  twoBit: boolean;
  levels: number;
  surfaces: number;
  faces: number;
  dataAt: number;
  srgb: boolean;
  hasAlpha: boolean;
  /** Version 3 stores all surfaces of a level together; the older files store all levels of a surface together. */
  surfaceMajor: boolean;
}

function readHeader(bytes: Uint8Array): Layout {
  if (bytes.length < OLD_HEADER) throw decodeFailed('PVR: the file is too short for a header; download it again');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    first = view.getUint32(0, true);
  if (first === VERSION_3_SWAPPED) throw refuse('big-endian files are not supported');
  if (first === VERSION_3) {
    const format = view.getUint32(8, true);
    if (view.getUint32(12, true) || format > 3) throw refuse(`pixel format ${format} is not PVRTC 1`);
    if (view.getUint32(32, true) > 1) throw refuse('3D textures are not supported');
    return {
      width: view.getUint32(28, true),
      height: view.getUint32(24, true),
      twoBit: format < 2,
      levels: Math.max(1, view.getUint32(44, true)),
      surfaces: Math.max(1, view.getUint32(36, true)),
      faces: Math.max(1, view.getUint32(40, true)),
      dataAt: OLD_HEADER + view.getUint32(48, true),
      srgb: view.getUint32(16, true) === SRGB,
      hasAlpha: (format & 1) === 1,
      surfaceMajor: false,
    };
  }
  if (first !== OLD_HEADER || view.getUint32(44, true) !== OLD_TAG) throw decodeFailed('PVR: this is not a PVR file; check the path');
  const flags = view.getUint32(16, true),
    type = flags & 255,
    twoBit = OLD_PVRTC2.includes(type);
  if (!twoBit && !OLD_PVRTC4.includes(type)) throw refuse(`pixel type ${type} is not PVRTC 1`);
  const surfaces = Math.max(1, view.getUint32(48, true)),
    cube = flags & OLD_CUBE && surfaces % 6 === 0;
  return {
    width: view.getUint32(8, true),
    height: view.getUint32(4, true),
    twoBit,
    levels: view.getUint32(12, true) + 1,
    surfaces: cube ? surfaces / 6 : surfaces,
    faces: cube ? 6 : 1,
    dataAt: OLD_HEADER,
    srgb: false,
    hasAlpha: (flags & OLD_ALPHA) !== 0,
    surfaceMajor: true,
  };
}

/**
 * Reads a PVR file (version 3 or the older 52 byte header) of PVRTC 1 data, 2 or 4 bits a texel, to RGBA8: every level,
 * surface and cube face, sRGB when the file says so. The levels cost 4 bytes a texel on the GPU and take a CPU pass, so
 * this is a way to keep old files working, not a format to ship.
 *
 * @throws MargoError `failed` for another format, a 3D or big-endian file, or data shorter than the header says.
 * @example
 * const texture = uploadTexture(device, parsePVR(new Uint8Array(await (await fetch('/old.pvr')).arrayBuffer())));
 */
export function parsePVR(bytes: Uint8Array): TextureFile {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('parsePVR needs the file as a Uint8Array');
  const header = readHeader(bytes),
    { width, height, twoBit, levels, surfaces, faces, surfaceMajor } = header,
    layers = surfaces * faces,
    mipmaps: TextureFile['mipmaps'] = [];
  if (width < 1 || height < 1 || width & (width - 1) || height & (height - 1))
    throw refuse(`PVRTC needs power-of-two sizes, not ${width}x${height}`);
  const sizes: number[] = [];
  for (let level = 0; level < levels; level++)
    sizes.push(pvrtcBytes(Math.max(1, width >> level), Math.max(1, height >> level), twoBit));
  const chain = sizes.reduce((sum, size) => sum + size, 0),
    place = (level: number, layer: number): number => {
      const before = sizes.slice(0, level).reduce((sum, size) => sum + size, 0);
      return header.dataAt + (surfaceMajor ? layer * chain + before : before * layers + layer * sizes[level]);
    };
  if (header.dataAt + chain * layers > bytes.length)
    throw decodeFailed(`PVR: the file holds ${bytes.length} bytes, too few for its header's levels; re-export it`);
  for (let level = 0; level < levels; level++) {
    const w = Math.max(1, width >> level),
      h = Math.max(1, height >> level),
      data = new Uint8Array(w * h * 4 * layers);
    for (let layer = 0; layer < layers; layer++)
      data.set(decodePVRTC(bytes.subarray(place(level, layer)), w, h, twoBit), layer * w * h * 4);
    mipmaps.push({ data, width: w, height: h, byteLength: data.length });
  }
  return {
    width,
    height,
    layers,
    dimension: faces === 6 ? (surfaces > 1 ? 'cube-array' : 'cube') : surfaces > 1 ? '2d-array' : '2d',
    mipmaps,
    format: header.srgb ? 'rgba8unorm-srgb' : 'rgba8unorm',
    target: 'pvr',
    srgb: header.srgb,
    hasAlpha: header.hasAlpha,
  };
}
