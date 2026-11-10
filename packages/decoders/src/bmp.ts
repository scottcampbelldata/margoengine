// Clean-room Windows/OS2 bitmap reader from the Microsoft DIB specifications (docs/clean-room.md).
import { decodeFailed } from './errors.js';

/** RGBA8 pixels, top row first, with straight alpha. */
export interface DecodedBMP {
  width: number;
  height: number;
  data: Uint8Array;
}
/** Limits of a BMP decode. */
export interface BMPOptions {
  /** Maximum pixel count. Default 2^26. */
  maxPixels?: number;
}
const bad = (why: string): never => {
  throw decodeFailed(`BMP ${why}; pass a complete Windows or OS/2 bitmap`);
};

/** Decodes indexed 1/4/8-bit, RGB 16/24/32-bit, bitfield and RLE4/RLE8 BMP images. */
export function parseBMP(input: ArrayBuffer | ArrayBufferView, { maxPixels = 2 ** 26 }: BMPOptions = {}): DecodedBMP {
  const bytes =
    input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const need = (at: number, count: number) => {
    if (at < 0 || count < 0 || at > bytes.length - count) bad('is truncated');
  };
  need(0, 26);
  if (bytes[0] !== 66 || bytes[1] !== 77) bad('signature is invalid');
  const offset = view.getUint32(10, true),
    header = view.getUint32(14, true),
    core = header === 12;
  if (!core && ![40, 52, 56, 108, 124].includes(header)) bad('DIB header is unsupported');
  need(14, header);
  const width = core ? view.getUint16(18, true) : view.getInt32(18, true);
  const signedHeight = core ? view.getUint16(20, true) : view.getInt32(22, true);
  const height = Math.abs(signedHeight),
    top = signedHeight < 0;
  const planes = view.getUint16(core ? 22 : 26, true),
    bits = view.getUint16(core ? 24 : 28, true);
  const compression = core ? 0 : view.getUint32(30, true);
  if (!Number.isSafeInteger(maxPixels) || maxPixels < 1 || width < 1 || !height || width * height > maxPixels)
    bad('pixel budget is invalid or exceeded');
  if (planes !== 1 || ![1, 4, 8, 16, 24, 32].includes(bits) || ![0, 1, 2, 3, 6].includes(compression))
    bad('pixel layout is unsupported');
  if (
    (compression === 1 && bits !== 8) ||
    (compression === 2 && bits !== 4) ||
    ((compression === 3 || compression === 6) && bits !== 16 && bits !== 32) ||
    (top && (compression === 1 || compression === 2))
  )
    bad('compression does not match the pixel layout');
  let paletteAt = 14 + header;
  let masks = bits === 16 ? [0x7c00, 0x3e0, 0x1f, 0] : [0xff0000, 0xff00, 0xff, 0];
  if (compression === 3 || compression === 6) {
    const at = 54,
      count = header >= 56 || compression === 6 ? 4 : 3;
    need(at, count * 4);
    masks = Array.from({ length: 4 }, (_, i) => (i < count ? view.getUint32(at + i * 4, true) : 0));
    if (header === 40) paletteAt += count * 4;
    for (let i = 0; i < 4; i++) {
      if (!masks[i]) {
        if (i < 3 || compression === 6) bad('channel mask is empty');
        continue;
      }
      let shifted = masks[i] >>> 0;
      while (!(shifted & 1)) shifted >>>= 1;
      if ((shifted & (shifted + 1)) !== 0 || (bits === 16 && masks[i] > 65535)) bad('channel mask is invalid');
      for (let j = 0; j < i; j++) if (masks[i] & masks[j]) bad('channel masks overlap');
    }
  }
  const paletteSize = bits <= 8 ? (core ? 0 : view.getUint32(46, true)) || 2 ** bits : 0;
  const paletteWidth = core ? 3 : 4;
  if (paletteSize > 2 ** bits) bad('palette exceeds the index range');
  need(paletteAt, paletteSize * paletteWidth);
  if (offset < paletteAt + paletteSize * paletteWidth) bad('pixel offset overlaps the header');
  need(offset, 0);
  const data = new Uint8Array(width * height * 4);
  const indexed = (x: number, y: number, index: number) => {
    if (x >= width || y >= height || index >= paletteSize) bad('palette index or RLE coordinate is invalid');
    const at = paletteAt + index * paletteWidth,
      dest = ((top ? y : height - 1 - y) * width + x) * 4;
    data.set([bytes[at + 2], bytes[at + 1], bytes[at], 255], dest);
  };
  if (compression === 1 || compression === 2) {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) indexed(x, y, 0);
    let at = offset,
      x = 0,
      y = 0,
      ended = false;
    while (!ended) {
      need(at, 2);
      const count = bytes[at++],
        value = bytes[at++];
      if (count) {
        for (let i = 0; i < count; i++) indexed(x++, y, bits === 8 ? value : (value >> (i % 2 ? 0 : 4)) & 15);
      } else if (value === 0) {
        x = 0;
        y++;
      } else if (value === 1) ended = true;
      else if (value === 2) {
        need(at, 2);
        x += bytes[at++];
        y += bytes[at++];
        if (x >= width || y >= height) bad('RLE delta leaves the image');
      } else {
        const size = bits === 8 ? value : Math.ceil(value / 2);
        need(at, size + (size & 1));
        for (let i = 0; i < value; i++)
          indexed(x++, y, bits === 8 ? bytes[at + i] : (bytes[at + (i >> 1)] >> (i % 2 ? 0 : 4)) & 15);
        at += size + (size & 1);
      }
    }
  } else {
    const stride = Math.ceil((width * bits) / 32) * 4;
    need(offset, stride * height);
    const channels = masks.map((mask) => {
      let shift = 0;
      if (mask) while (!((mask >>> shift) & 1)) shift++;
      return { mask, shift, maximum: mask >>> shift };
    });
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const row = offset + y * stride;
        if (bits <= 8) {
          indexed(x, y, (bytes[row + Math.floor((x * bits) / 8)] >> (8 - bits - ((x * bits) % 8))) & (2 ** bits - 1));
          continue;
        }
        const at = row + (x * bits) / 8,
          dest = ((top ? y : height - 1 - y) * width + x) * 4;
        if (bits === 24) data.set([bytes[at + 2], bytes[at + 1], bytes[at], 255], dest);
        else {
          const value = bits === 16 ? view.getUint16(at, true) : view.getUint32(at, true);
          for (let c = 0; c < 4; c++) {
            const { mask, shift, maximum } = channels[c];
            data[dest + c] = mask ? Math.round((((value & mask) >>> shift) * 255) / maximum) : c === 3 ? 255 : 0;
          }
        }
      }
  }
  return { width, height, data };
}
