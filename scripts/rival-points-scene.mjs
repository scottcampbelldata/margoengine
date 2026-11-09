// Shared scene for the batch 168 points measurement.
// One Potree 2.0 folder: metadata.json, a 22-byte hierarchy record, and octree.bin
// in the DEFAULT layout (position int32, intensity uint16, rgb uint16). The grid is
// 200 x 200 x 250, which is 10,000,000 points, in a 100 m cube centred on the origin.
// Scale is 0.001, the same unit PotreeConverter writes. Both budgets are 10,000,000,
// so a settled frame draws every point. This file does not read a rival.

export const POINTS_SCENE = {
  nx: 200,
  ny: 200,
  nz: 250,
  side: 100,
  scale: 0.001,
  budget: 10_000_000,
  pointSize: 4,
  camera: {
    position: [0, 0, 180],
    target: [0, 0, 0],
    up: [0, 1, 0],
    fov: 50,
    near: 0.1,
    far: 1000,
    width: 1080,
    height: 1080,
  },
};

export const POINT_STRIDE = 20;

/** Points in a scene, or in a smaller grid that uses the same layout. */
export const pointCount = (spec) => spec.nx * spec.ny * spec.nz;

const minOf = (spec) => -spec.side / 2;

/** World position of point `i` on the grid, before the file's integer rounding. */
export function pointAt(i, spec) {
  const ix = i % spec.nx;
  const iy = Math.floor(i / spec.nx) % spec.ny;
  const iz = Math.floor(i / (spec.nx * spec.ny));
  const axis = (index, n) => {
    const min = minOf(spec);
    return n === 1 ? min : min + (index / (n - 1)) * spec.side;
  };
  return [axis(ix, spec.nx), axis(iy, spec.ny), axis(iz, spec.nz)];
}

function stored(world, spec) {
  return Math.round((world - minOf(spec)) / spec.scale);
}

/** metadata.json for this grid. */
export function metadataOf(spec) {
  const count = pointCount(spec);
  const min = [minOf(spec), minOf(spec), minOf(spec)];
  const max = min.map((value) => value + spec.side);
  const wide = 255;
  const integer = Math.round(spec.side / spec.scale);
  return {
    version: '2.0',
    name: 'points-10m',
    points: count,
    hierarchy: { firstChunkSize: 22, stepSize: 1, depth: 1 },
    offset: min,
    scale: [spec.scale, spec.scale, spec.scale],
    spacing: spec.side / 128,
    boundingBox: { min, max },
    encoding: 'DEFAULT',
    attributes: [
      {
        name: 'position',
        size: 12,
        numElements: 3,
        elementSize: 4,
        type: 'int32',
        min: [0, 0, 0],
        max: [integer, integer, integer],
      },
      { name: 'intensity', size: 2, numElements: 1, elementSize: 2, type: 'uint16', min: [1], max: [1] },
      {
        name: 'rgb',
        size: 6,
        numElements: 3,
        elementSize: 2,
        type: 'uint16',
        min: [0, 0, 0],
        max: [wide, wide, wide],
      },
    ],
  };
}

/** One hierarchy record: a leaf holding every point. */
export function hierarchyOf(spec) {
  const count = pointCount(spec);
  const bytes = new Uint8Array(22);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 1);
  view.setUint8(1, 0);
  view.setUint32(2, count, true);
  view.setBigUint64(6, 0n, true);
  view.setBigUint64(14, BigInt(count * POINT_STRIDE), true);
  return bytes;
}

/**
 * Writes points `[start, start + count)` into `out` (count * POINT_STRIDE bytes).
 * Position is int32 of (world - min) / scale. Colour is the grid index in 8 bits.
 */
export function fillPoints(spec, start, count, out) {
  const view = new DataView(out.buffer, out.byteOffset, count * POINT_STRIDE);
  const { nx, ny } = spec;
  const plane = nx * ny;
  for (let k = 0; k < count; k++) {
    const i = start + k;
    const ix = i % nx;
    const iy = Math.floor(i / nx) % ny;
    const iz = Math.floor(i / plane);
    const world = pointAt(i, spec);
    const at = k * POINT_STRIDE;
    view.setInt32(at, stored(world[0], spec), true);
    view.setInt32(at + 4, stored(world[1], spec), true);
    view.setInt32(at + 8, stored(world[2], spec), true);
    view.setUint16(at + 12, 1, true);
    view.setUint16(at + 14, ix & 255, true);
    view.setUint16(at + 16, iy & 255, true);
    view.setUint16(at + 18, iz & 255, true);
  }
}

/** A whole folder in memory. For the 10,000,000 point file, write it from the runner instead. */
export function potreeBytes(spec) {
  const count = pointCount(spec);
  const octree = new Uint8Array(count * POINT_STRIDE);
  fillPoints(spec, 0, count, octree);
  const text = new TextEncoder().encode(JSON.stringify(metadataOf(spec)));
  return new Map([
    ['metadata.json', text],
    ['hierarchy.bin', hierarchyOf(spec)],
    ['octree.bin', octree],
  ]);
}
