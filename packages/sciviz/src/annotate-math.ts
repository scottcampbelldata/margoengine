import { rangeError } from '../../shared/errors.js';
import { gridSurface, type UnstructuredGrid } from './grids.js';
import type { Bounds } from './layer.js';

/** Physical data coordinates. */
export type AnnotationPoint = readonly [number, number, number];
/** Draw and measurement kinds; every point remains in data units. */
export type AnnotationKind =
  | 'text'
  | 'arrow'
  | 'line'
  | 'rectangle'
  | 'ellipse'
  | 'scale'
  | 'ruler'
  | 'angle'
  | 'polyline'
  | 'box'
  | 'sphere';
/** Portable annotation state. Sphere uses centre and one radius handle; angle uses end/vertex/end. */
export interface Annotation {
  readonly id: string;
  readonly kind: AnnotationKind;
  readonly points: readonly AnnotationPoint[];
  readonly text?: string;
  /** Default #ffd166. */ readonly color?: string;
  /** Default 2 CSS pixels. */ readonly width?: number;
  /** Label suffix, default empty. */ readonly unit?: string;
  /** Default true. */ readonly visible?: boolean;
  /** Text offset from the final point in CSS pixels, default [12,-12]. */ readonly offset?: readonly [number, number];
}
const kinds = ['text', 'arrow', 'line', 'rectangle', 'ellipse', 'scale', 'ruler', 'angle', 'polyline', 'box', 'sphere'];
const finite = (p: readonly number[]) => p.length === 3 && p.every(Number.isFinite);
/** Validate and snapshot before a mutation, so errors cannot partially change a figure. */
export function annotationSnapshot(input: Annotation): Annotation {
  const n = input.points?.length;
  if (
    typeof input.id !== 'string' ||
    !input.id ||
    !kinds.includes(input.kind) ||
    !n ||
    !input.points.every(finite) ||
    (input.kind === 'text' ? n !== 1 : input.kind === 'angle' ? n !== 3 : input.kind === 'polyline' ? n < 2 : n !== 2)
  )
    throw rangeError('Annotation needs an ID, a known kind and the required finite 3D handles', 'sciviz');
  if (input.width !== undefined && (!(input.width > 0) || !Number.isFinite(input.width)))
    throw rangeError('Annotation width must be positive and finite', 'sciviz');
  if (input.color !== undefined && !/^#[\da-f]{6}$/i.test(input.color))
    throw rangeError('Annotation color must be #rrggbb', 'sciviz');
  if (input.offset && (input.offset.length !== 2 || !input.offset.every(Number.isFinite)))
    throw rangeError('Annotation offset needs two finite CSS pixels', 'sciviz');
  if (input.text !== undefined && typeof input.text !== 'string')
    throw rangeError('Annotation text must be a string', 'sciviz');
  if (input.unit !== undefined && typeof input.unit !== 'string')
    throw rangeError('Annotation unit must be a string', 'sciviz');
  if (input.visible !== undefined && typeof input.visible !== 'boolean')
    throw rangeError('Annotation visibility must be boolean', 'sciviz');
  return {
    ...input,
    points: input.points.map((p) => [...p] as [number, number, number]),
    offset: input.offset && [...input.offset],
  };
}
const sub = (a: readonly number[], b: readonly number[]) => a.map((v, i) => v - b[i]);
const dot = (a: readonly number[], b: readonly number[]) => a.reduce((s, v, i) => s + v * b[i], 0);
const cross = (a: readonly number[], b: readonly number[]) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
/** Distance, length or degrees; other visual annotations have no scalar measurement. */
export function annotationMeasure(annotation: Annotation): number | null {
  const a = annotationSnapshot(annotation),
    p = a.points;
  if (a.kind === 'angle') {
    const u = sub(p[0], p[1]),
      v = sub(p[2], p[1]),
      denom = Math.hypot(...u) * Math.hypot(...v);
    return denom ? (Math.acos(Math.max(-1, Math.min(1, dot(u, v) / denom))) * 180) / Math.PI : null;
  }
  if (['ruler', 'scale', 'sphere'].includes(a.kind)) return Math.hypot(...sub(p[0], p[1]));
  if (a.kind === 'polyline') return p.slice(1).reduce((sum, v, i) => sum + Math.hypot(...sub(v, p[i])), 0);
  return null;
}
/** Closed box/sphere ROI test in physical data coordinates. */
export function annotationContains(annotation: Annotation, point: AnnotationPoint): boolean {
  const a = annotationSnapshot(annotation);
  if (!finite(point)) throw rangeError('ROI point must be finite xyz', 'sciviz');
  if (a.kind === 'box')
    return point.every(
      (v, i) => v >= Math.min(a.points[0][i], a.points[1][i]) && v <= Math.max(a.points[0][i], a.points[1][i]),
    );
  if (a.kind === 'sphere')
    return Math.hypot(...sub(point, a.points[0])) <= Math.hypot(...sub(a.points[1], a.points[0]));
  throw rangeError('ROI membership needs a box or sphere annotation', 'sciviz');
}
/** CPU voxel source for picking; bounds locate first/last centres, including descending axes. */
export interface PickVolume {
  readonly data: ArrayLike<number>;
  readonly dims: readonly [number, number, number];
  readonly bounds?: Bounds;
}
/** First occupied voxel intersected by the ray. */
export interface VolumeHit {
  readonly index: number;
  readonly voxel: readonly [number, number, number];
  readonly position: AnnotationPoint;
  readonly value: number;
  /** Ray parameter, nonnegative. */ readonly t: number;
}
/** Amanatides/Woo DDA: exact cell crossings, with no sampling stride or hidden step limit.
 * Default occupancy is finite value > 0; supply the displayed classification threshold as needed.
 */
export function firstVolumeHit(
  volume: PickVolume,
  origin: AnnotationPoint,
  direction: AnnotationPoint,
  occupied: (value: number) => boolean = (v) => v > 0,
): VolumeHit | null {
  const { dims, data } = volume,
    bounds = volume.bounds ?? [0, dims[0] - 1, 0, dims[1] - 1, 0, dims[2] - 1];
  if (
    !finite(origin) ||
    !finite(direction) ||
    !Math.hypot(...direction) ||
    dims.length !== 3 ||
    !dims.every((v) => Number.isInteger(v) && v >= 2) ||
    data.length !== dims[0] * dims[1] * dims[2] ||
    bounds.length !== 6 ||
    !bounds.every(Number.isFinite)
  )
    throw rangeError('Volume picking needs finite ray, exact dimensions >=2, data and sample-centre bounds', 'sciviz');
  const spacing = dims.map((n, i) => (bounds[2 * i + 1] - bounds[2 * i]) / (n - 1));
  if (spacing.some((v) => v === 0))
    throw rangeError('Volume pick bounds need a nonzero extent on every axis', 'sciviz');
  const o = spacing.map((s, i) => (origin[i] - bounds[2 * i]) / s + 0.5),
    d = spacing.map((s, i) => direction[i] / s);
  let near = 0,
    far = Infinity;
  for (let i = 0; i < 3; i++) {
    if (d[i] === 0) {
      if (o[i] < 0 || o[i] > dims[i]) return null;
      continue;
    }
    const a = -o[i] / d[i],
      b = (dims[i] - o[i]) / d[i];
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
  }
  if (near > far) return null;
  const cell = o.map((v, i) =>
      Math.min(
        dims[i] - 1,
        Math.max(0, Math.floor(v + d[i] * near) - (d[i] < 0 && Number.isInteger(v + d[i] * near) ? 1 : 0)),
      ),
    ),
    step = d.map(Math.sign);
  const next = cell.map((v, i) => (d[i] === 0 ? Infinity : ((d[i] > 0 ? v + 1 : v) - o[i]) / d[i]));
  let t = near;
  while (t <= far && cell.every((v, i) => v >= 0 && v < dims[i])) {
    const index = cell[0] + dims[0] * (cell[1] + dims[1] * cell[2]),
      value = data[index];
    if (Number.isFinite(value) && occupied(value))
      return {
        index,
        voxel: cell.slice() as [number, number, number],
        position: origin.map((v, i) => v + t * direction[i]) as [number, number, number],
        value,
        t,
      };
    t = Math.min(...next);
    if (!Number.isFinite(t)) break;
    for (let i = 0; i < 3; i++)
      if (next[i] === t) {
        cell[i] += step[i];
        next[i] += Math.abs(1 / d[i]);
      }
  }
  return null;
}
/** First surface intersection retaining the original grid cell ID. */
export interface GridHit {
  readonly cell: number;
  readonly triangle: number;
  readonly position: AnnotationPoint;
  readonly t: number;
}
/** Two-sided Moller/Trumbore intersection against the owning package's clean-room boundary triangles. */
export function firstGridHit(
  grid: UnstructuredGrid,
  origin: AnnotationPoint,
  direction: AnnotationPoint,
): GridHit | null {
  if (!finite(origin) || !finite(direction) || !Math.hypot(...direction))
    throw rangeError('Grid picking needs a finite nonzero ray', 'sciviz');
  const mesh = gridSurface(grid);
  let result: GridHit | null = null;
  for (let tri = 0; tri < mesh.cells.length; tri++) {
    const at = tri * 9,
      a = Array.from(mesh.positions.subarray(at, at + 3)),
      b = Array.from(mesh.positions.subarray(at + 3, at + 6)),
      c = Array.from(mesh.positions.subarray(at + 6, at + 9)),
      e1 = sub(b, a),
      e2 = sub(c, a),
      h = cross(direction, e2),
      det = dot(e1, h);
    if (det === 0) continue;
    const s = sub(origin, a),
      u = dot(s, h) / det;
    if (u < 0 || u > 1) continue;
    const q = cross(s, e1),
      v = dot(direction, q) / det;
    if (v < 0 || u + v > 1) continue;
    const t = dot(e2, q) / det;
    if (t < 0 || (result && t >= result.t)) continue;
    result = {
      cell: mesh.cells[tri],
      triangle: tri,
      t,
      position: origin.map((v, i) => v + t * direction[i]) as [number, number, number],
    };
  }
  return result;
}
