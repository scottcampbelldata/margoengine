// Raw texture pixels only, with no image-container or transcoder loading.
import { deviceUnsupported } from './errors.js';
import type { TextureFile } from './texture-file.js';
import type { DecodedImage } from './image.js';

/**
 * The first layer of level 0 of a texture file as RGBA8: a missing green or blue is 0, a missing alpha is 255. Signed
 * formats map -1..1 to 0..255, as a normal map stored in an unsigned image does, so a missing channel is 128. Float
 * formats hold linear light, so they clamp to 0..1 and are sRGB encoded.
 *
 * @throws MargoError `unsupported` for ETC, EAC and ASTC blocks, which are not decoded on the CPU.
 */
export async function textureFileToRGBA(file: TextureFile): Promise<DecodedImage> {
  const { width, height, data: all } = file.mipmaps[0],
    format = file.format as string,
    count = width * height,
    out = new Uint8Array(count * 4);
  if (format.startsWith('bc')) {
    const { decodeBC } = await import('./bc.js');
    return decodeBC(format, all, width, height);
  }
  const { halfToFloat, linearToByte, signedByte } = await import('./bc.js'),
    view = new DataView(all.buffer, all.byteOffset, all.byteLength),
    unpacked = (width: number, read: (i: number, c: number) => number): void => {
      for (let i = 0; i < count; i++) {
        for (let c = 0; c < 3; c++) out[i * 4 + c] = c < width ? linearToByte(read(i, c)) : 0;
        out[i * 4 + 3] = width === 4 ? Math.round(Math.min(1, Math.max(0, read(i, 3))) * 255) : 255;
      }
    },
    bytes = (channels: number, signed: boolean): void => {
      for (let i = 0; i < count; i++)
        for (let c = 0; c < 4; c++) {
          const v = c < channels ? all[i * channels + c] : c === 3 ? 255 : signed ? 128 : 0;
          out[i * 4 + c] = signed && c < channels ? signedByte((v << 24) >> 24) : v;
        }
    };
  switch (format) {
    case 'rgba8unorm':
    case 'rgba8unorm-srgb':
      out.set(all.subarray(0, count * 4));
      break;
    case 'bgra8unorm':
    case 'bgra8unorm-srgb':
      for (let i = 0; i < count; i++) {
        out[i * 4] = all[i * 4 + 2];
        out[i * 4 + 1] = all[i * 4 + 1];
        out[i * 4 + 2] = all[i * 4];
        out[i * 4 + 3] = all[i * 4 + 3];
      }
      break;
    case 'r8unorm':
      bytes(1, false);
      break;
    case 'rg8unorm':
      bytes(2, false);
      break;
    case 'rgba8snorm':
      bytes(4, true);
      break;
    case 'rg8snorm':
      bytes(2, true);
      break;
    case 'r8snorm':
      bytes(1, true);
      break;
    case 'r16float':
      unpacked(1, (i) => halfToFloat(view.getUint16(i * 2, true)));
      break;
    case 'rg16float':
      unpacked(2, (i, c) => halfToFloat(view.getUint16((i * 2 + c) * 2, true)));
      break;
    case 'rgba16float':
      unpacked(4, (i, c) => halfToFloat(view.getUint16((i * 4 + c) * 2, true)));
      break;
    case 'r32float':
      unpacked(1, (i) => view.getFloat32(i * 4, true));
      break;
    case 'rg32float':
      unpacked(2, (i, c) => view.getFloat32((i * 2 + c) * 4, true));
      break;
    case 'rgba32float':
      unpacked(4, (i, c) => view.getFloat32((i * 4 + c) * 4, true));
      break;
    case 'rgb10a2unorm':
      for (let i = 0; i < count; i++) {
        const p = view.getUint32(i * 4, true);
        out[i * 4] = Math.round(((p & 1023) / 1023) * 255);
        out[i * 4 + 1] = Math.round((((p >>> 10) & 1023) / 1023) * 255);
        out[i * 4 + 2] = Math.round((((p >>> 20) & 1023) / 1023) * 255);
        out[i * 4 + 3] = Math.round(((p >>> 30) / 3) * 255);
      }
      break;
    case 'rgb9e5ufloat':
      unpacked(3, (i, c) => {
        const p = view.getUint32(i * 4, true);
        return (((p >>> (c * 9)) & 511) / 512) * 2 ** ((p >>> 27) - 15);
      });
      break;
    case 'rg11b10ufloat':
      unpacked(3, (i, c) => {
        const p = view.getUint32(i * 4, true),
          [shift, mantissa] = c === 0 ? [0, 6] : c === 1 ? [11, 6] : [22, 5],
          m = (p >>> shift) & ((1 << mantissa) - 1),
          e = (p >>> (shift + mantissa)) & 31;
        return e === 0 ? (m / 2 ** mantissa) * 2 ** -14 : (1 + m / 2 ** mantissa) * 2 ** (e - 15);
      });
      break;
    default:
      throw deviceUnsupported(
        `${format} blocks are not decoded on the CPU; export the texture as PNG, WebP, BC or Basis`,
      );
  }
  return { width, height, data: out };
}
