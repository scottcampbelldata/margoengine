// Cut convex tetrahedra along a plane, following Areias and Rabczuk (2017) for shared
// edge points. Globally ordered pulling triangulations agree on every common face.
import type { Vec3 } from './math.js';

export type Tet = [number, number, number, number];
type Matrix = [Vec3, Vec3, Vec3];
type Side = -1 | 1;

export interface SlicePoint {
  readonly first: number;
  readonly second: number;
  /** Fraction measured from first to second. An old vertex has first === second. */
  readonly weight: number;
  /** A point formed by clipping or triangulating a polygon can use all four parent vertices. */
  readonly vertices?: readonly (readonly [particle: number, weight: number])[];
}

export interface SliceCell {
  readonly parent: number;
  readonly nodes: Tet;
  /** Fraction of the parent tetrahedron, measured in its affine coordinates. */
  readonly fraction: number;
  /** Inverse of this tetrahedron's edge matrix in the parent tetrahedron's affine coordinates. */
  readonly inverse: Matrix | null;
}

export interface SlicePlan {
  readonly points: readonly SlicePoint[];
  readonly pieces: readonly SliceCell[][];
  readonly crackFront?: ReadonlyMap<SlicePoint, ReadonlySet<SlicePoint>>;
  /** Original particle IDs of the front segment opened by this advance. */
  readonly releasedFront?: readonly [number, number];
}

export const FACES = [
  [1, 2, 3],
  [0, 3, 2],
  [0, 1, 3],
  [0, 2, 1],
] as const;
export const TETRA_EDGES = [
  [0, 1],
  [0, 2],
  [0, 3],
  [1, 2],
  [1, 3],
  [2, 3],
] as const;
const SIDES: readonly Side[] = [-1, 1];
const edgeKey = (a: number, b: number): string => (a < b ? `${a},${b}` : `${b},${a}`);
export const faceKey = (a: readonly number[]): string => [...a].sort((x, y) => x - y).join(',');
export const subtract = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function cutDistances(current: ArrayLike<number>, origin: Vec3, normal: Vec3): Float64Array {
  return Float64Array.from({ length: current.length / 3 }, (_, i) => {
    const terms = [0, 1, 2].map((axis) => (current[3 * i + axis]! - origin[axis]!) * normal[axis]!);
    const value = terms[0]! + terms[1]! + terms[2]!;
    const roundoff = 8 * Number.EPSILON * (Math.abs(terms[0]!) + Math.abs(terms[1]!) + Math.abs(terms[2]!));
    return Math.abs(value) <= roundoff ? 0 : value;
  });
}

export function faceIntersection(
  tet: Tet,
  face: readonly number[],
  side: Side,
  d: Float64Array,
  add: (a: number, b: number) => number,
): number[] {
  const polygon: number[] = [];
  for (let i = 0; i < 3; i++) {
    const first = tet[face[i]!]!;
    const second = tet[face[(i + 1) % 3]!]!;
    if (side * d[first]! >= 0) polygon.push(first);
    if (Math.sign(d[first]!) * Math.sign(d[second]!) < 0) polygon.push(add(first, second));
  }
  return polygon;
}

/** The clipped original faces meet the section in a single cyclic sequence of edges. */
export function sectionPolygon(faces: readonly number[][], onPlane: (node: number) => boolean): number[] {
  const adjacent = new Map<number, number[]>();
  for (const face of faces) {
    if (face.length < 3) continue;
    const edge = face.filter(onPlane);
    if (edge.length !== 2) continue;
    const [a, b] = edge as [number, number];
    adjacent.set(a, [...(adjacent.get(a) ?? []), b]);
    adjacent.set(b, [...(adjacent.get(b) ?? []), a]);
  }
  const start = Math.min(...adjacent.keys());
  const ring = [start];
  for (let i = 1; i < adjacent.size; i++) {
    const [a, b] = adjacent.get(ring[i - 1]!)!;
    ring.push(a === ring[i - 2] ? b! : a!);
  }
  return ring;
}

export function childCell(parent: number, tetra: Tet, node: Tet, points: readonly SlicePoint[]): SliceCell {
  const affine = (i: number): Vec3 => {
    const { first, second, weight, vertices } = points[i]!;
    const coordinate = (corner: number): number =>
      vertices
        ? (vertices.find(([particle]) => particle === corner)?.[1] ?? 0)
        : (corner === first ? 1 - weight : 0) + (corner === second ? weight : 0);
    return [coordinate(tetra[1]), coordinate(tetra[2]), coordinate(tetra[3])];
  };
  const a = affine(node[0]);
  const u = subtract(affine(node[1]), a);
  let v = subtract(affine(node[2]), a);
  let w = subtract(affine(node[3]), a);
  let determinant = dot(u, cross(v, w));
  if (determinant < 0) {
    [node[2], node[3]] = [node[3], node[2]];
    [v, w] = [w, v];
    determinant = -determinant;
  }
  const row = (a: Vec3, b: Vec3): Vec3 => {
    const [x, y, z] = cross(a, b);
    return [x / determinant, y / determinant, z / determinant];
  };
  return { parent, nodes: node, fraction: determinant, inverse: [row(v, w), row(w, u), row(u, v)] };
}

function clippedChildren(
  parent: number,
  tet: Tet,
  d: Float64Array,
  side: Side,
  points: readonly SlicePoint[],
  add: (a: number, b: number) => number,
): SliceCell[] {
  const faces = FACES.map((face) => faceIntersection(tet, face, side, d, add));
  faces.push(sectionPolygon(faces, (node) => node >= d.length || d[node] === 0));
  return pullCells(parent, tet, faces, points);
}

/** Pulling triangulation for convex cells whose faces do not have inserted collinear vertices. */
export function pullCells(
  parent: number,
  tet: Tet,
  faces: readonly number[][],
  points: readonly SlicePoint[],
): SliceCell[] {
  const root = Math.min(...faces.flat());
  const children: SliceCell[] = [];
  for (const face of faces) {
    if (face.length < 3 || face.includes(root)) continue;
    const start = face.indexOf(Math.min(...face));
    for (let i = 1; i < face.length - 1; i++) {
      children.push(
        childCell(
          parent,
          tet,
          [root, face[start]!, face[(start + i) % face.length]!, face[(start + i + 1) % face.length]!],
          points,
        ),
      );
    }
  }
  return children;
}

/** Groups tetrahedra connected by faces. A contact along an edge or vertex alone does not join fragments. */
function connectedPieces(cells: readonly SliceCell[]): SliceCell[][] {
  const parent = Int32Array.from({ length: cells.length }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const faces = new Map<string, number>();
  cells.forEach(({ nodes }, i) => {
    for (const face of FACES) {
      const key = faceKey(face.map((k) => nodes[k]));
      const other = faces.get(key);
      if (other === undefined) faces.set(key, i);
      else parent[find(i)] = find(other);
    }
  });
  const pieces = new Map<number, SliceCell[]>();
  cells.forEach((cell, i) => {
    const root = find(i);
    const piece = pieces.get(root) ?? [];
    piece.push(cell);
    pieces.set(root, piece);
  });
  return [...pieces.values()];
}

/** Plans a complete plane section without modifying the body. */
export function planPlaneCut(current: Float32Array, cells: Uint32Array, origin: Vec3, normal: Vec3): SlicePlan | null {
  const d = cutDistances(current, origin, normal);
  const points: SlicePoint[] = Array.from({ length: d.length }, (_, i) => ({ first: i, second: i, weight: 0 }));
  const intersections = new Map<string, number>();
  const atIntersection = (a: number, b: number): number => {
    const key = edgeKey(a, b);
    const had = intersections.get(key);
    if (had !== undefined) return had;
    const first = Math.min(a, b);
    const second = Math.max(a, b);
    const magnitude = Math.max(Math.abs(d[first]!), Math.abs(d[second]!));
    const from = Math.abs(d[first]!) / magnitude;
    const to = Math.abs(d[second]!) / magnitude;
    const weight = from / (from + to);
    intersections.set(key, points.length);
    return points.push({ first, second, weight }) - 1;
  };
  const halves: [SliceCell[], SliceCell[]] = [[], []];
  const onPlane = new Map<string, Side>();
  let cut = false;
  for (let parent = 0; parent < cells.length / 4; parent++) {
    const tet: Tet = [cells[4 * parent]!, cells[4 * parent + 1]!, cells[4 * parent + 2]!, cells[4 * parent + 3]!];
    const negative = tet.some((node) => d[node]! < 0);
    const positive = tet.some((node) => d[node]! > 0);
    if (negative && positive) {
      cut = true;
      SIDES.forEach((side, i) => halves[i]!.push(...clippedChildren(parent, tet, d, side, points, atIntersection)));
      continue;
    }
    const side = negative ? -1 : 1;
    halves[side === -1 ? 0 : 1].push({ parent, nodes: tet, fraction: 1, inverse: null });
    for (const face of FACES) {
      const nodes = face.map((slot) => tet[slot]);
      if (!nodes.every((node) => d[node] === 0)) continue;
      const key = faceKey(nodes);
      const other = onPlane.get(key);
      if (other !== undefined && other !== side) cut = true;
      onPlane.set(key, side);
    }
  }
  if (!cut) return null;
  return { points, pieces: halves.flatMap(connectedPieces) };
}
