import type { MutableVec2, MutableVec3 } from '@margoengine/math';
import type { PolygonMesh, PrimitiveMeshKind } from './types.js';

/** Legacy top-left normalized primitive UVs: 8-pixel tiles in a 128-pixel atlas with one-pixel padding. */
export function meshTileUV(tile: number, count: number): MutableVec2[] {
  if (!Number.isInteger(tile) || tile < 0 || tile > 255 || !Number.isInteger(count) || count < 3 || count > 64)
    throw new RangeError('Tile UV needs tile 0 to 255 and 3 to 64 corners; choose a supported tile and polygon.');
  const x = (tile % 16) * 8,
    y = Math.floor(tile / 16) * 8;
  const corners: MutableVec2[] = [
    [(x + 1) / 128, (y + 7) / 128],
    [(x + 7) / 128, (y + 7) / 128],
    [(x + 7) / 128, (y + 1) / 128],
    [(x + 1) / 128, (y + 1) / 128],
  ];
  if (count <= 4) return corners.slice(0, count);
  return Array.from({ length: count }, (_, i) => [
    (x + 4 + Math.cos((i / count) * Math.PI * 2) * 3) / 128,
    (y + 4 + Math.sin((i / count) * Math.PI * 2) * 3) / 128,
  ]);
}

/** Create the current unit-box low-poly primitives, with face IDs `${faceIdPrefix}-face-${index}` and owned corner UVs. */
export function createPrimitiveMesh(kind: PrimitiveMeshKind, faceIdPrefix: string): PolygonMesh {
  if (typeof faceIdPrefix !== 'string' || !faceIdPrefix.length)
    throw new TypeError('Primitive face ID prefix must be nonempty; supply a stable caller identity.');
  let vertices: MutableVec3[], polygons: number[][];
  if (kind === 'plane') {
    vertices = [
      [-0.5, 0, -0.5],
      [-0.5, 0, 0.5],
      [0.5, 0, 0.5],
      [0.5, 0, -0.5],
    ];
    polygons = [[0, 1, 2, 3]];
  } else if (kind === 'wedge') {
    vertices = [
      [-0.5, -0.5, -0.5],
      [0.5, -0.5, -0.5],
      [0, 0.5, -0.5],
      [-0.5, -0.5, 0.5],
      [0.5, -0.5, 0.5],
      [0, 0.5, 0.5],
    ];
    polygons = [
      [2, 1, 0],
      [3, 4, 5],
      [0, 1, 4, 3],
      [1, 2, 5, 4],
      [2, 0, 3, 5],
    ];
  } else if (kind === 'cylinder') {
    const sides = 8;
    vertices = Array.from({ length: sides * 2 }, (_, i) => [
      Math.cos(((i % sides) / sides) * Math.PI * 2) * 0.5,
      i < sides ? -0.5 : 0.5,
      Math.sin(((i % sides) / sides) * Math.PI * 2) * 0.5,
    ]);
    polygons = [Array.from({ length: sides }, (_, i) => i), Array.from({ length: sides }, (_, i) => sides * 2 - 1 - i)];
    for (let i = 0; i < sides; i++) polygons.push([(i + 1) % sides, i, i + sides, ((i + 1) % sides) + sides]);
  } else if (kind === 'cube') {
    vertices = [
      [-0.5, -0.5, -0.5],
      [0.5, -0.5, -0.5],
      [0.5, 0.5, -0.5],
      [-0.5, 0.5, -0.5],
      [-0.5, -0.5, 0.5],
      [0.5, -0.5, 0.5],
      [0.5, 0.5, 0.5],
      [-0.5, 0.5, 0.5],
    ];
    polygons = [
      [1, 0, 3, 2],
      [4, 5, 6, 7],
      [0, 4, 7, 3],
      [5, 1, 2, 6],
      [3, 7, 6, 2],
      [0, 1, 5, 4],
    ];
  } else throw new TypeError('Primitive kind is unsupported; choose cube, plane, cylinder or wedge.');
  return {
    vertices,
    faces: polygons.map((polygon, index) => ({
      id: `${faceIdPrefix}-face-${index}`,
      vertices: polygon,
      uv: meshTileUV(index, polygon.length),
    })),
  };
}
