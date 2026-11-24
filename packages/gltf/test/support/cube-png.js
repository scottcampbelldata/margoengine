// Tiny RGBA PNG files for stand-in EXT_lights_image_based cubes.
import { deflateSync } from 'node:zlib';
import { crc32 } from '../../../shared/crc32.js';

const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)) >>> 0, 8 + data.length);
  return out;
};
/** A `size` square RGBA8 PNG; `pixel(x, y)` gives each pixel's four bytes. */
export function pngOf(size, pixel) {
  const header = Buffer.alloc(13),
    rows = Buffer.alloc(size * (1 + size * 4));
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) rows.set(pixel(x, y), y * (1 + size * 4) + 1 + x * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
/** The `uri` of a PNG in a glTF image. */
export const dataURI = (png) => `data:image/png;base64,${png.toString('base64')}`;
/** Six images of a cube, one colour each, +X to -Z, with the extension's light entry. */
export function cubeDocument(colors, { rotation, size = 4, intensity } = {}) {
  return {
    images: colors.map((color) => ({ uri: dataURI(pngOf(size, () => color)), mimeType: 'image/png' })),
    light: {
      ...(rotation && { rotation }),
      ...(intensity !== undefined && { intensity }),
      irradianceCoefficients: Array.from({ length: 9 }, () => [0, 0, 0]),
      specularImages: [[0, 1, 2, 3, 4, 5]],
      specularImageSize: size,
    },
  };
}
