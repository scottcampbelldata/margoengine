import { checkVec, type Vec3 } from './math.js';
import { cross, dot, subtract, type Tet } from './soft-plane-cut.js';

type Triangle = readonly [Vec3, Vec3, Vec3];
type Edges = [Vec3, Vec3, Vec3];

/** Native cell flag carried through a cut and snapshots. */
export const NUCLEATED_CELL = 32;

/** A triangular weak patch in a single tetrahedron, opened by positive normal Green strain. */
export interface SoftTensileSeam {
  /** The cell containing the patch, numbered in the order supplied to `setCells`. */
  readonly cell: number;
  /** Three noncollinear rest-space points in that tetrahedron, in metres. */
  readonly triangle: Triangle;
  /** Dimensionless normal Green strain that opens the patch. */
  readonly openingStrain: number;
}

export interface BoundTensileSeam {
  readonly cell: number;
  readonly corners: Tet;
  readonly coordinates: Triangle;
  readonly direction: Vec3;
  readonly openingStrain: number;
  readonly orientation: number;
}

const axes = [0, 1, 2] as const;
const coordinateTolerance = 32 * Number.EPSILON;
const coordinates = (component: (axis: 0 | 1 | 2) => number): Vec3 => [component(0), component(1), component(2)];
const vectorAt = (origin: Vec3, edges: Edges, weights: Vec3): Vec3 =>
  coordinates((i) => origin[i] + edges[0][i] * weights[0] + edges[1][i] * weights[1] + edges[2][i] * weights[2]);
const volumeMatrix = ([a, b, c]: Edges): Edges => [cross(b, c), cross(c, a), cross(a, b)];

export function bindTensileSeam(
  { cell, triangle, openingStrain }: SoftTensileSeam,
  particles: readonly number[],
  cells: readonly number[],
): BoundTensileSeam {
  if (!Number.isInteger(cell) || cell < 0 || cell >= cells.length / 4)
    throw new RangeError('A tensile seam needs a valid cell index. Choose a tetrahedron from setCells.');
  if (!Number.isFinite(openingStrain) || openingStrain <= 0)
    throw new RangeError('A tensile seam needs a finite strain above zero. Pass a dimensionless openingStrain.');
  if (!Array.isArray(triangle) || triangle.length !== 3)
    throw new RangeError('A tensile seam is triangular. Pass three points in the tetrahedron in rest space.');
  for (const point of triangle) checkVec(point, 'Tensile seam point');
  const [a, b, c, d] = cells.slice(cell * 4, cell * 4 + 4) as Tet;
  const position = (p: number): Vec3 => coordinates((axis) => particles[3 * p + axis]!);
  const origin = position(a);
  const edges: Edges = [subtract(position(b), origin), subtract(position(c), origin), subtract(position(d), origin)];
  const cofactors = volumeMatrix(edges);
  const determinant = dot(edges[0], cofactors[0]);
  const inCell = (p: Vec3): Vec3 => coordinates((axis) => dot(p, cofactors[axis]) / determinant);
  const locate = (p: Vec3): Vec3 => {
    const q = inCell(subtract(p, origin));
    const barycentric = [1 - q[0] - q[1] - q[2], ...q];
    if (barycentric.some((weight) => !Number.isFinite(weight) || weight < -coordinateTolerance))
      throw new RangeError('A tensile seam point is outside its cell. Move its triangle inside the tetrahedron.');
    return q;
  };
  const [p, q, r] = triangle;
  const normal = cross(subtract(q, p), subtract(r, p));
  const length = Math.sqrt(dot(normal, normal));
  if (!(length > 0 && Number.isFinite(length)))
    throw new RangeError('The tensile seam has no finite area. Use three noncollinear rest-space points.');
  const points = [locate(p), locate(q), locate(r)] as const;
  const onFace = (weight: number): boolean => Math.abs(weight) <= coordinateTolerance;
  if (axes.some((i) => points.every((v) => onFace(v[i]))) || points.every(([x, y, z]) => onFace(1 - x - y - z)))
    throw new RangeError('The tensile seam lies on a cell face. Move at least one point into the tetrahedron.');
  return {
    cell,
    corners: [a, b, c, d],
    coordinates: points,
    direction: inCell(coordinates((i) => normal[i] / length)),
    openingStrain,
    orientation: Math.sign(determinant),
  };
}

export function openTensileSeam(seam: BoundTensileSeam, at: (particle: number) => Vec3): Triangle | null {
  const [a, b, c, d] = seam.corners;
  const origin = at(a);
  const edges: Edges = [subtract(at(b), origin), subtract(at(c), origin), subtract(at(d), origin)];
  if (!(seam.orientation * dot(edges[0], cross(edges[1], edges[2])) > 0)) return null;
  const stretched = vectorAt([0, 0, 0], edges, seam.direction);
  if (!(0.5 * (dot(stretched, stretched) - 1) > seam.openingStrain)) return null;
  const [u, v, w] = seam.coordinates;
  return [vectorAt(origin, edges, u), vectorAt(origin, edges, v), vectorAt(origin, edges, w)];
}
