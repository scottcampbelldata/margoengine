// PNG container pieces from the W3C PNG specification (third edition), shared by the exporters and voxel-pathtracer
// writers, the decoders reader and blender's .margo image check.
import { crc32 } from './crc32.js';

/** The 8-byte PNG signature. */
export const PNG_SIGNATURE = Object.freeze([137, 80, 78, 71, 13, 10, 26, 10]);

/** Value predicted for a byte by row filter `type` (0 none, 1 Sub, 2 Up, 3 Average, 4 Paeth) from its left `a`, up `b`
 * and up-left `c` neighbours. */
export function pngPredict(type, a, b, c) {
  if (type === 1) return a;
  if (type === 2) return b;
  if (type === 3) return (a + b) >> 1;
  if (type === 4) {
    const p = a + b - c,
      pa = Math.abs(p - a),
      pb = Math.abs(p - b),
      pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  }
  return 0;
}

/** The IHDR fields of `bytes` when they start with the PNG signature and a 13-byte IHDR chunk, else undefined. The CRC is
 * not checked. */
export function pngHeader(bytes) {
  if (bytes.length < 33 || PNG_SIGNATURE.some((v, i) => bytes[i] !== v)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) return undefined;
  return {
    width: view.getUint32(16),
    height: view.getUint32(20),
    depth: bytes[24],
    colour: bytes[25],
    compression: bytes[26],
    filter: bytes[27],
    interlace: bytes[28],
  };
}

const chunk = (type, data) => {
  const out = new Uint8Array(data.length + 12),
    view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(data.length + 8, crc32(out.subarray(4, data.length + 8)));
  return out;
};

/** The parts of an 8-bit, non-interlaced PNG file: signature, IHDR (colour type `colour`: 2 RGB, 6 RGBA), one IDAT with
 * the zlib stream `zlib` of the filtered rows, IEND. Join them (a Blob or one array) for the file. */
export function pngParts(width, height, colour, zlib) {
  const header = new Uint8Array(13),
    view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = colour;
  return [Uint8Array.from(PNG_SIGNATURE), chunk('IHDR', header), chunk('IDAT', zlib), chunk('IEND', new Uint8Array(0))];
}
