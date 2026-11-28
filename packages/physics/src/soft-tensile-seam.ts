import { softError } from './soft-error.js';
import { checkVec, type Vec3 } from './math.js';
import { cross, dot, subtract, type Tet } from './soft-plane-cut.js';
import { MIN_TET_DETERMINANT } from './soft-volume.js';

type Triangle = readonly [Vec3, Vec3, Vec3];
type Edges = [Vec3, Vec3, Vec3];

/** Native cell flag carried through a cut and snapshots. */
export const NUCLEATED_CELL = 32;
export const CRACK_FRONT_SHIFT = 6;
export const CRACK_FRONT_MASK = 63 << CRACK_FRONT_SHIFT;
export const UNREPRESENTABLE_CELL = 1 << 12;

/** A triangular weak patch in a single tetrahedron with tensile and optional shear thresholds. */
export interface SoftTensileSeam {
  /** The cell containing the patch, numbered in the order supplied to `setCells`. */
  readonly cell: number;
  /** Three noncollinear rest-space points in that tetrahedron, in metres. */
  readonly triangle: Triangle;
  /** Dimensionless normal Green strain that opens the patch. */
  readonly openingStrain: number;
  /** Engineering shear strain perpendicular to the triangle's first edge. Omit to disable sliding failure. */
  readonly slidingStrain?: number;
  /** Engineering shear strain parallel to the triangle's first edge. Omit to disable tearing failure. */
  readonly tearingStrain?: number;
}

export interface BoundTensileSeam {
  readonly cell: number;
  readonly corners: Tet;
  readonly coordinates: Triangle;
  readonly direction: Vec3;
  readonly shear: readonly { direction: Vec3; threshold: number }[];
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
  { cell, triangle, openingStrain, slidingStrain, tearingStrain }: SoftTensileSeam,
  particles: readonly number[],
  cells: readonly number[],
): BoundTensileSeam {
  if (!Number.isInteger(cell) || cell < 0 || cell >= cells.length / 4)
    throw softError('A tensile seam needs a valid cell index. Choose a tetrahedron from setCells.');
  if (!Number.isFinite(openingStrain) || openingStrain <= 0)
    throw softError('A tensile seam needs a finite strain above zero. Pass a dimensionless openingStrain.');
  for (const limit of [slidingStrain, tearingStrain]) {
    if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0))
      throw softError('A seam shear limit needs a finite strain above zero. Pass a positive strain or omit the limit.');
  }
  if (!Array.isArray(triangle) || triangle.length !== 3)
    throw softError('A tensile seam is triangular. Pass three points in the tetrahedron in rest space.');
  for (const point of triangle) checkVec(point, 'Tensile seam point');
  const [a, b, c, d] = cells.slice(cell * 4, cell * 4 + 4) as Tet;
  const position = (p: number): Vec3 => coordinates((axis) => particles[3 * p + axis]!);
  const origin = position(a);
  const edges: Edges = [subtract(position(b), origin), subtract(position(c), origin), subtract(position(d), origin)];
  const cofactors = volumeMatrix(edges);
  const determinant = dot(edges[0], cofactors[0]);
  // setCells refuses a flat cell, but the positions can change after it; a seam in a cell with no volume has no
  // orientation (its sign would be 0) and no cell coordinates, so it is refused here with its own reason.
  if (!(Math.abs(determinant) > MIN_TET_DETERMINANT))
    throw softError(
      `Tensile seam cell ${cell} has no volume: its four particles lie in one plane. Move one off that plane.`,
    );
  const inCell = (p: Vec3): Vec3 => coordinates((axis) => dot(p, cofactors[axis]) / determinant);
  const locate = (p: Vec3): Vec3 => {
    const q = inCell(subtract(p, origin));
    const barycentric = [1 - q[0] - q[1] - q[2], ...q];
    if (barycentric.some((weight) => !Number.isFinite(weight) || weight < -coordinateTolerance))
      throw softError('A tensile seam point is outside its cell. Move its triangle inside the tetrahedron.');
    return q;
  };
  const [p, q, r] = triangle;
  const firstEdge = subtract(q, p);
  const normal = cross(firstEdge, subtract(r, p));
  const length = Math.sqrt(dot(normal, normal));
  if (!(length > 0 && Number.isFinite(length)))
    throw softError('The tensile seam has no finite area. Use three noncollinear rest-space points.');
  const points = [locate(p), locate(q), locate(r)] as const;
  const onFace = (weight: number): boolean => Math.abs(weight) <= coordinateTolerance;
  if (axes.some((i) => points.every((v) => onFace(v[i]))) || points.every(([x, y, z]) => onFace(1 - x - y - z)))
    throw softError('The tensile seam lies on a cell face. Move at least one point into the tetrahedron.');
  const unitNormal = coordinates((i) => normal[i] / length);
  const shear: { direction: Vec3; threshold: number }[] = [];
  if (slidingStrain !== undefined || tearingStrain !== undefined) {
    const edgeLength = Math.sqrt(dot(firstEdge, firstEdge));
    const tangent = coordinates((i) => firstEdge[i] / edgeLength);
    if (slidingStrain !== undefined)
      shear.push({ direction: inCell(cross(tangent, unitNormal)), threshold: slidingStrain });
    if (tearingStrain !== undefined) shear.push({ direction: inCell(tangent), threshold: tearingStrain });
  }
  return {
    cell,
    corners: [a, b, c, d],
    coordinates: points,
    direction: inCell(unitNormal),
    shear,
    openingStrain,
    orientation: determinant < 0 ? -1 : 1,
  };
}

export function openTensileSeam(seam: BoundTensileSeam, at: (particle: number) => Vec3): Triangle | null {
  const [a, b, c, d] = seam.corners;
  const origin = at(a);
  const edges: Edges = [subtract(at(b), origin), subtract(at(c), origin), subtract(at(d), origin)];
  if (!(seam.orientation * dot(edges[0], cross(edges[1], edges[2])) > 0)) return null;
  const image = (direction: Vec3): Vec3 => vectorAt([0, 0, 0], edges, direction);
  const stretched = image(seam.direction);
  const opening = 0.5 * (dot(stretched, stretched) - 1);
  if (!(opening > seam.openingStrain)) {
    if (seam.shear.length === 0) return null;
    const relativeOpening = Math.max(0, opening) / seam.openingStrain;
    let used = relativeOpening * relativeOpening;
    for (const { direction, threshold } of seam.shear) {
      const relativeShear = dot(stretched, image(direction)) / threshold;
      used += relativeShear * relativeShear;
    }
    if (!(used > 1)) return null;
  }
  const [u, v, w] = seam.coordinates;
  return [vectorAt(origin, edges, u), vectorAt(origin, edges, v), vectorAt(origin, edges, w)];
}
