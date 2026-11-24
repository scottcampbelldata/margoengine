import { LoaderError } from './types.js';
import { concaveTriangles } from './polygon.js';
import { floats, uints } from './util.js';
const F = 'VTK XML';
type Numbers = ArrayLike<number>;
/** Corner lists of the faces of a volume cell, outward by VTK's ordering of its points. */
const TETRA = [
  [0, 2, 1],
  [0, 1, 3],
  [1, 2, 3],
  [0, 3, 2],
];
const HEXAHEDRON = [
  [0, 3, 2, 1],
  [4, 5, 6, 7],
  [0, 1, 5, 4],
  [1, 2, 6, 5],
  [2, 3, 7, 6],
  [3, 0, 4, 7],
];
const VOXEL = [
  [0, 2, 3, 1],
  [4, 5, 7, 6],
  [0, 1, 5, 4],
  [1, 3, 7, 5],
  [3, 2, 6, 7],
  [2, 0, 4, 6],
];
const WEDGE = [
  [0, 2, 1],
  [3, 4, 5],
  [0, 1, 4, 3],
  [1, 2, 5, 4],
  [2, 0, 3, 5],
];
const PYRAMID = [
  [0, 3, 2, 1],
  [0, 1, 4],
  [1, 2, 4],
  [2, 3, 4],
  [3, 0, 4],
];
function prism(sides: number): number[][] {
  const base = Array.from({ length: sides }, (_, i) => sides - 1 - i),
    top = Array.from({ length: sides }, (_, i) => sides + i),
    faces = [base, top];
  for (let i = 0; i < sides; i++) {
    const next = (i + 1) % sides;
    faces.push([i, next, sides + next, sides + i]);
  }
  return faces;
}
const VOLUMES: Record<number, { corners: number; faces: number[][] }> = {
  10: { corners: 4, faces: TETRA },
  11: { corners: 8, faces: VOXEL },
  12: { corners: 8, faces: HEXAHEDRON },
  13: { corners: 6, faces: WEDGE },
  14: { corners: 5, faces: PYRAMID },
  15: { corners: 10, faces: prism(5) },
  16: { corners: 12, faces: prism(6) },
  // Higher-order cells list their corners first (VTK file formats, cell types 24 to 37 and the Lagrange and Bezier
  // cells 71 to 74 and 78 to 81), so they draw from those corners with the linear cell's faces.
  24: { corners: 4, faces: TETRA },
  25: { corners: 8, faces: HEXAHEDRON },
  26: { corners: 6, faces: WEDGE },
  27: { corners: 5, faces: PYRAMID },
  29: { corners: 8, faces: HEXAHEDRON },
  31: { corners: 6, faces: WEDGE },
  32: { corners: 6, faces: WEDGE },
  33: { corners: 8, faces: HEXAHEDRON },
  37: { corners: 5, faces: PYRAMID },
  71: { corners: 4, faces: TETRA },
  72: { corners: 8, faces: HEXAHEDRON },
  73: { corners: 6, faces: WEDGE },
  74: { corners: 5, faces: PYRAMID },
  78: { corners: 4, faces: TETRA },
  79: { corners: 8, faces: HEXAHEDRON },
  80: { corners: 6, faces: WEDGE },
  81: { corners: 5, faces: PYRAMID },
};
/** Higher-order surface cells, by the corners kept. */
const QUADRATIC: Record<number, number> = { 22: 3, 23: 4, 28: 4, 30: 4, 34: 3, 69: 3, 70: 4, 76: 3, 77: 4 };
/** Higher-order line cells: the two end points come first. */
const CURVES = new Set([21, 35, 68, 75]);

/** Internal shared VTK surface builder. */
export class Builder {
  readonly positions = floats();
  readonly triangles = uints();
  readonly cells = uints();
  readonly lines = uints();
  readonly warnings = new Set<string>();
  /** A face of a volume cell by its sorted corners; `null` once two cells share it. */
  readonly faces = new Map<string, { corners: number[]; cell: number } | null>();
  /** Coordinates, three per point, that polygons are ear-clipped on; `positions` when null. */
  coords: ArrayLike<number> | null = null;
  cellCount = 0;
  constructor(
    readonly maxTriangles: number,
    readonly outer: boolean,
  ) {}
  check(index: number, points: number): number {
    if (!(index >= 0 && index < points && Number.isInteger(index)))
      throw new LoaderError(F, 'range', `cell index ${index} is outside 0..${points - 1}`);
    return index;
  }
  polygon(corners: number[], cell: number): void {
    // vtkPolygon may be concave (VTK file formats, cell type 7): such a polygon is ear-clipped, a convex one fanned.
    const clipped = corners.length > 3 ? concaveTriangles(this.coords ?? this.positions.array, corners) : null;
    if (clipped) {
      for (let t = 0; t < clipped.length; t += 3) {
        if (this.triangles.length / 3 >= this.maxTriangles)
          throw new LoaderError(F, 'limit', `triangle count exceeds the limit of ${this.maxTriangles}`);
        this.triangles.push3(corners[clipped[t]], corners[clipped[t + 1]], corners[clipped[t + 2]]);
        this.cells.push(cell);
      }
      return;
    }
    for (let c = 1; c + 1 < corners.length; c++) {
      if (this.triangles.length / 3 >= this.maxTriangles)
        throw new LoaderError(F, 'limit', `triangle count exceeds the limit of ${this.maxTriangles}`);
      this.triangles.push3(corners[0], corners[c], corners[c + 1]);
      this.cells.push(cell);
    }
  }
  strip(corners: number[], cell: number): void {
    for (let c = 0; c + 2 < corners.length; c++)
      this.polygon(
        c % 2 ? [corners[c + 1], corners[c], corners[c + 2]] : [corners[c], corners[c + 1], corners[c + 2]],
        cell,
      );
  }
  polyline(corners: number[]): void {
    for (let c = 0; c + 1 < corners.length; c++) {
      this.lines.push(corners[c]);
      this.lines.push(corners[c + 1]);
    }
  }
  face(corners: number[], cell: number): void {
    if (!this.outer) {
      this.polygon(corners, cell);
      return;
    }
    const id = [...corners].sort((a, b) => a - b).join(' ');
    this.faces.set(id, this.faces.has(id) ? null : { corners, cell });
  }
  finish(): void {
    for (const face of this.faces.values()) if (face) this.polygon(face.corners, face.cell);
  }
}

/** Emits one retained VTK cell to the shared surface builder. */
export function gridCell(
  type: number,
  corners: number[],
  cell: number,
  builder: Builder,
  stream: Numbers | undefined,
  from: number,
  points: number,
  base: number,
): void {
  const volume = VOLUMES[type];
  if (volume) {
    if (corners.length < volume.corners)
      throw new LoaderError(F, 'range', `cell ${cell} of type ${type} has ${corners.length} points`);
    if (type >= 21) builder.warnings.add('second-order cells are drawn from their corner points');
    for (const face of volume.faces)
      builder.face(
        face.map((k) => corners[k]),
        cell,
      );
    return;
  }
  if (Object.hasOwn(QUADRATIC, type) || CURVES.has(type)) {
    const keep = CURVES.has(type) ? 2 : QUADRATIC[type];
    if (corners.length < keep) throw new LoaderError(F, 'range', `cell ${cell} of type ${type} has ${corners.length} points`);
    builder.warnings.add('second-order cells are drawn from their corner points');
    if (CURVES.has(type)) builder.polyline(corners.slice(0, 2));
    else builder.polygon(corners.slice(0, keep), cell);
    return;
  }
  switch (type) {
    case 1:
    case 2:
      return; // Vertex cells: their points are in `positions` already.
    case 3:
    case 4:
      builder.polyline(corners);
      return;
    case 36:
      // A quadratic polygon lists its corners, then its edge midpoints.
      builder.warnings.add('second-order cells are drawn from their corner points');
      builder.polygon(corners.slice(0, corners.length >> 1), cell);
      return;
    case 5:
    case 7:
    case 9:
      builder.polygon(corners, cell);
      return;
    case 6:
      builder.strip(corners, cell);
      return;
    case 8:
      builder.polygon([corners[0], corners[1], corners[3], corners[2]], cell);
      return;

    case 42: {
      if (!stream) throw new LoaderError(F, 'syntax', `polyhedron ${cell} has no faces array`);
      let at = from;
      const count = stream[at++];
      for (let f = 0; f < count; f++) {
        const size = stream[at++],
          face: number[] = [];
        if (!(at + size <= stream.length))
          throw new LoaderError(F, 'range', `polyhedron ${cell} runs past its faces array`);
        for (let k = 0; k < size; k++) face.push(builder.check(stream[at++], points) + base);
        builder.face(face, cell);
      }
      return;
    }
    default:
      builder.warnings.add(`cell type ${type} is not drawn`);
  }
}
