import { deflateSync } from 'node:zlib';

// A real 64x16 RGBA PNG with four solid cells. No application image encoder is involved.
function chunk(type, data) {
  const tag = Buffer.from(type),
    bytes = Buffer.concat([tag, data]);
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const header = Buffer.alloc(4),
    tail = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([header, bytes, tail]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(64);
header.writeUInt32BE(16, 4);
header[8] = 8;
header[9] = 6;
const pixels = Buffer.alloc(16 * (64 * 4 + 1));
for (let y = 0; y < 16; y++)
  for (let x = 0; x < 64; x++) {
    const at = y * 257 + 1 + x * 4;
    pixels.set(
      [
        [255, 0, 0, 255],
        [0, 255, 0, 255],
        [0, 0, 255, 255],
        [255, 255, 0, 0],
      ][x >> 4],
      at,
    );
  }
export const atlas = {
  image: new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(pixels)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  ),
  mimeType: 'image/png',
  magFilter: 'nearest',
  minFilter: 'nearest',
  mipmaps: false,
};
export const quad = {
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  uvs: [0, 1, 1, 1, 1, 0, 0, 0],
  indices: [0, 1, 2, 0, 2, 3],
};
export function material(offset = [0, 0], scale = [0.25, 1]) {
  return {
    name: '水/~🔥',
    baseColorTexture: atlas,
    baseColorTextureTransform: { offset, scale },
    unlit: true,
    alphaMode: 'MASK',
    alphaCutoff: 0.25,
    doubleSided: true,
  };
}
export function channel(
  target,
  property = 'offset',
  values = [0, 0, 0.25, 0, 0.5, 0, 0.75, 0, 0, 0],
  times = [0, 0.125, 0.25, 0.375, 0.5],
) {
  return { material: target, texture: 'baseColorTexture', property, times, values, interpolation: 'STEP' };
}
export function fixture(start = 0) {
  const animated = material(start === 2 ? [0.5, 0] : [0, 0]),
    still = material([0.75, 0]);
  const values = start === 2 ? [0.5, 0, 0.75, 0, 0, 0, 0.25, 0, 0.5, 0] : [0, 0, 0.25, 0, 0.5, 0, 0.75, 0, 0, 0];
  const node = {
    name: 'atlas',
    primitives: [
      { geometry: quad, material: still },
      { geometry: quad, material: animated },
      { geometry: quad, material: animated },
    ],
  };
  return {
    animated,
    still,
    node,
    scene: {
      nodes: [node],
      materialAnimations: [
        {
          name: '水/~🔥',
          channels: [
            channel(animated, 'offset', values),
            channel(animated, 'scale', [0.25, 1, 0.25, 1, 0.25, 1, 0.25, 1, 0.25, 1]),
          ],
        },
      ],
    },
  };
}
