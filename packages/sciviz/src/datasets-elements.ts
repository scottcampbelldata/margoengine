import { rangeError } from '../../shared/errors.js';

/** Parametric domains use unit coordinates; the pyramid apex is (0.5,0.5,1). */
export type ElementShape = 'curve' | 'triangle' | 'quad' | 'tetra' | 'hex' | 'wedge' | 'pyramid';
/** Equispaced nodal interpolation. Lagrange order defaults to 2, range 1..10.
 * Quadratic uses the standard edge-node serendipity space (3,6,8,10,20,15,13 nodes).
 * Optional referenceNodes changes nodal ordering, not the interpolation space.
 */
export interface FiniteElementCell {
  readonly type: 'lagrange' | 'quadratic';
  readonly shape: ElementShape;
  readonly ids: readonly number[];
  readonly order?: number;
  readonly referenceNodes?: readonly (readonly number[])[];
}
const bad = (message: string): never => {
  throw rangeError(`Finite element: ${message}; correct the cell definition`, 'sciviz');
};
const corners: Record<ElementShape, number[][]> = {
  curve: [
    [0, 0, 0],
    [1, 0, 0],
  ],
  triangle: [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
  ],
  quad: [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
  ],
  tetra: [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  hex: [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
    [0, 1, 1],
  ],
  wedge: [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [0, 1, 1],
  ],
  pyramid: [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
    [0.5, 0.5, 1],
  ],
};
const edges: Record<ElementShape, number[][]> = {
  curve: [[0, 1]],
  triangle: [
    [0, 1],
    [1, 2],
    [2, 0],
  ],
  quad: [
    [0, 1],
    [1, 2],
    [3, 2],
    [0, 3],
  ],
  tetra: [
    [0, 1],
    [1, 2],
    [2, 0],
    [0, 3],
    [1, 3],
    [2, 3],
  ],
  hex: [
    [0, 1],
    [1, 2],
    [3, 2],
    [0, 3],
    [4, 5],
    [5, 6],
    [7, 6],
    [4, 7],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ],
  wedge: [
    [0, 1],
    [1, 2],
    [2, 0],
    [3, 4],
    [4, 5],
    [5, 3],
    [0, 3],
    [1, 4],
    [2, 5],
  ],
  pyramid: [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [0, 4],
    [1, 4],
    [2, 4],
    [3, 4],
  ],
};
const faces: Partial<Record<ElementShape, number[][]>> = {
  tetra: [
    [0, 1, 3],
    [2, 3, 1],
    [0, 3, 2],
    [0, 2, 1],
  ],
  hex: [
    [0, 3, 7, 4],
    [1, 2, 6, 5],
    [0, 1, 5, 4],
    [3, 2, 6, 7],
    [0, 1, 2, 3],
    [4, 5, 6, 7],
  ],
  wedge: [
    [0, 1, 2],
    [3, 4, 5],
    [0, 1, 3, 4],
    [1, 2, 4, 5],
    [2, 0, 5, 3],
  ],
};
const lerp = (a: readonly number[], b: readonly number[], t: number) => a.map((x, k) => x + t * (b[k] - x));
function triangleInterior(order: number): number[][] {
  if (order < 3) return [];
  if (order === 3) return [[1 / 3, 1 / 3, 0]];
  return elementNodes('triangle', order - 3).map((p) => [
    (1 + (order - 3) * p[0]) / order,
    (1 + (order - 3) * p[1]) / order,
    0,
  ]);
}
function wedgeInterior(order: number): number[][] {
  const nodes: number[][] = [];
  for (let j = 1; j < order; j++) for (let i = 1; i < order - j; i++) nodes.push([i / order, j / order, 0]);
  return nodes;
}

/** @internal VTK's vertex, edge, face, interior ordering; custom nodes can describe anisotropic external orderings. */
export function elementNodes(shape: ElementShape, order: number, quadratic = false): number[][] {
  const vertices = corners[shape];
  if (!vertices) return bad('unknown shape');
  if (order === 0) return [shape === 'tetra' ? [0.25, 0.25, 0.25] : [1 / 3, 1 / 3, 0]];
  const nodes = vertices.map((p) => [...p]);
  for (const [a, b] of edges[shape])
    for (let i = 1; i < order; i++) nodes.push(lerp(vertices[a], vertices[b], i / order));
  if (quadratic || order === 1) return nodes;
  if (shape === 'pyramid') return bad('Lagrange pyramid is not a VTK Lagrange cell; use quadratic pyramid');
  if (shape === 'triangle') nodes.push(...triangleInterior(order));
  if (shape === 'quad')
    for (let j = 1; j < order; j++) for (let i = 1; i < order; i++) nodes.push([i / order, j / order, 0]);
  for (const face of faces[shape] ?? []) {
    if (face.length === 3)
      for (const p of shape === 'wedge' ? wedgeInterior(order) : triangleInterior(order))
        nodes.push(
          vertices[face[0]].map(
            (v, a) => v * (1 - p[0] - p[1]) + vertices[face[1]][a] * p[0] + vertices[face[2]][a] * p[1],
          ),
        );
    else
      for (let j = 1; j < order; j++)
        for (let i = 1; i < order; i++) {
          // Wedge quadrilateral face declarations use two lower then two upper vertices.
          const [a, b, c, d] = shape === 'wedge' ? [face[0], face[1], face[3], face[2]] : face;
          nodes.push(
            lerp(lerp(vertices[a], vertices[b], i / order), lerp(vertices[d], vertices[c], i / order), j / order),
          );
        }
  }
  if (shape === 'tetra' && order >= 4) {
    if (order === 4) nodes.push([0.25, 0.25, 0.25]);
    else for (const p of elementNodes('tetra', order - 4)) nodes.push(p.map((v) => (1 + (order - 4) * v) / order));
  }
  if (shape === 'hex')
    for (let k = 1; k < order; k++)
      for (let j = 1; j < order; j++) for (let i = 1; i < order; i++) nodes.push([i / order, j / order, k / order]);
  if (shape === 'wedge')
    for (let k = 1; k < order; k++) for (const p of wedgeInterior(order)) nodes.push([p[0], p[1], k / order]);
  return nodes;
}

const cardinal = (x: number, node: number, order: number) => {
  let value = 1;
  for (let j = 0; j <= order; j++) if (j !== node) value *= (order * x - j) / (node - j);
  return value;
};
const simplex = (bary: readonly number[], alpha: readonly number[], order: number) => {
  let value = 1;
  for (let a = 0; a < bary.length; a++)
    for (let j = 0; j < alpha[a]; j++) value *= (order * bary[a] - j) / (alpha[a] - j);
  return value;
};
function serendipity(shape: ElementShape, p: readonly number[]): number[] {
  const [r, s, t] = p.map((x) => 2 * x - 1),
    vertices = corners[shape];
  if (shape === 'quad' || shape === 'hex') {
    const dim = shape === 'quad' ? 2 : 3,
      q = [r, s, t],
      out = vertices.map((v) => {
        const signs = v.map((x) => 2 * x - 1);
        let n = 1 / 2 ** dim;
        for (let a = 0; a < dim; a++) n *= 1 + signs[a] * q[a];
        return n * (signs.slice(0, dim).reduce((sum, x, a) => sum + x * q[a], 0) - (dim - 1));
      });
    for (const [a, b] of edges[shape]) {
      const axis = vertices[a].findIndex((v, k) => v !== vertices[b][k]);
      let n = (1 - q[axis] ** 2) / 2 ** (dim - 1);
      for (let k = 0; k < dim; k++) if (k !== axis) n *= 1 + (2 * vertices[a][k] - 1) * q[k];
      out.push(n);
    }
    return out;
  }
  if (shape === 'wedge') {
    const l = [1 - p[0] - p[1], p[0], p[1]],
      out: number[] = [];
    for (const side of [-1, 1]) for (const v of l) out.push(0.5 * v * (1 + side * t) * (2 * v - 2 + side * t));
    for (const side of [-1, 1])
      for (const [a, b] of [
        [0, 1],
        [1, 2],
        [2, 0],
      ])
        out.push(2 * l[a] * l[b] * (1 + side * t));
    for (const v of l) out.push(v * (1 - t * t));
    return out;
  }
  return [];
}

// Rational serendipity pyramid: P2 plus rs/(1-z), r^2s/(1-z), rs^2/(1-z).
// Traces are quadratic triangles and the 8-node base quadrilateral; cardinalization is 13x13.
function pyramidBasis(p: readonly number[]): number[] {
  const r = 2 * p[0] - 1,
    s = 2 * p[1] - 1,
    z = p[2],
    d = 1 - z;
  return [
    1,
    r,
    s,
    z,
    r * r,
    r * s,
    r * z,
    s * s,
    s * z,
    z * z,
    d === 0 ? 0 : (r * s) / d,
    d === 0 ? 0 : (r * r * s) / d,
    d === 0 ? 0 : (r * s * s) / d,
  ];
}
function inverse(matrix: number[][]): number[][] {
  const n = matrix.length,
    a = matrix.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => +(i === j))]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[pivot][c])) pivot = r;
    if (Math.abs(a[pivot][c]) < 1e-14) bad('singular reference nodes');
    [a[c], a[pivot]] = [a[pivot], a[c]];
    const d = a[c][c];
    for (let j = 0; j < 2 * n; j++) a[c][j] /= d;
    for (let r = 0; r < n; r++)
      if (r !== c) {
        const f = a[r][c];
        for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[c][j];
      }
  }
  return a.map((row) => row.slice(n));
}

/** @internal Nodal evaluator shared by geometry and every field component. */
export function elementWeights(cell: FiniteElementCell): (p: readonly number[]) => number[] {
  const order = cell.type === 'quadratic' ? 2 : (cell.order ?? 2),
    shape = cell.shape;
  if (!Number.isInteger(order) || order < 1 || order > 10) bad('order must be 1..10');
  if (shape === 'pyramid' && cell.type !== 'quadratic') bad('use the standard quadratic pyramid');
  const standard = elementNodes(shape, order, cell.type === 'quadratic'),
    nodes = cell.referenceNodes ?? standard;
  if (
    nodes.length !== standard.length ||
    cell.ids.length !== nodes.length ||
    nodes.some((p) => p.length !== 3 || p.some((x) => !Number.isFinite(x)))
  )
    bad('node count or reference coordinates do not match the element');
  const permutation = nodes.map((p) => standard.findIndex((q) => q.every((v, k) => Math.abs(v - p[k]) < 1e-12)));
  if (permutation.some((i) => i < 0) || new Set(permutation).size !== nodes.length)
    bad('reference nodes must be a permutation of the standard equispaced lattice');
  const pyramid = shape === 'pyramid' ? inverse(standard.map(pyramidBasis)) : undefined;
  return (p) => {
    let weights: number[];
    if (pyramid) {
      const b = pyramidBasis(p);
      weights = standard.map((_, i) => b.reduce((sum, v, j) => sum + v * pyramid[j][i], 0));
      // VTK's 13-node pyramid adds a collapsed-coordinate interior bubble to the rational basis.
      // It vanishes on every face and at every node. Black-box nodal/sample oracle is retained in tests.
      const d = 1 - p[2],
        u = d === 0 ? 0 : (p[0] - 0.5 * p[2]) / d,
        v = d === 0 ? 0 : (p[1] - 0.5 * p[2]) / d,
        bubble = 8 * u * (1 - u) * v * (1 - v) * p[2] * d;
      for (let i = 0; i < 4; i++) {
        weights[i] -= bubble;
        weights[i + 5] += bubble;
      }
    } else if (cell.type === 'quadratic' && ['quad', 'hex', 'wedge'].includes(shape)) weights = serendipity(shape, p);
    else
      weights = standard.map((q) => {
        if (shape === 'triangle' || shape === 'tetra' || shape === 'wedge') {
          const bary = shape === 'tetra' ? [1 - p[0] - p[1] - p[2], p[0], p[1], p[2]] : [1 - p[0] - p[1], p[0], p[1]],
            qb = shape === 'tetra' ? [1 - q[0] - q[1] - q[2], q[0], q[1], q[2]] : [1 - q[0] - q[1], q[0], q[1]];
          return (
            simplex(
              bary,
              qb.map((x) => Math.round(x * order)),
              order,
            ) * (shape === 'wedge' ? cardinal(p[2], Math.round(q[2] * order), order) : 1)
          );
        }
        const dim = shape === 'curve' ? 1 : shape === 'quad' ? 2 : 3;
        let w = 1;
        for (let a = 0; a < dim; a++) w *= cardinal(p[a], Math.round(q[a] * order), order);
        return w;
      });
    weights = permutation.map((i) => weights[i]);
    if (weights.some((x) => !Number.isFinite(x)) || Math.abs(weights.reduce((a, b) => a + b, 0) - 1) > 1e-9)
      bad('interpolation lost partition of unity');
    return weights;
  };
}

/** @internal Uniform midpoint refinement of reference simplices, with shared vertices within each source cell. */
export function tessellateCell(
  cell: FiniteElementCell,
  subdivisions: number,
  insert: (w: readonly number[]) => number,
  emit: (ids: readonly number[], type: number) => void,
): void {
  const weights = elementWeights(cell),
    vertices = corners[cell.shape],
    cache = new Map<string, number>();
  const id = (p: readonly number[]) => {
    const key = p.join(',');
    if (!cache.has(key)) cache.set(key, insert(weights(p)));
    return cache.get(key)!;
  };
  const mid = (a: number[], b: number[]) => lerp(a, b, 0.5);
  const refine = (p: number[][], depth: number): void => {
    if (depth === 0) {
      emit(p.map(id), p.length === 2 ? 3 : p.length === 3 ? 5 : 10);
      return;
    }
    const [a, b, c, d] = p,
      ab = mid(a, b);
    if (p.length === 2) {
      refine([a, ab], depth - 1);
      refine([ab, b], depth - 1);
      return;
    }
    const ac = mid(a, c),
      bc = mid(b, c);
    if (p.length === 3) {
      for (const tri of [
        [a, ab, ac],
        [ab, b, bc],
        [ac, bc, c],
        [ab, bc, ac],
      ])
        refine(tri, depth - 1);
      return;
    }
    const ad = mid(a, d),
      bd = mid(b, d),
      cd = mid(c, d);
    for (const tet of [
      [a, ab, ac, ad],
      [ab, b, bc, bd],
      [ac, bc, c, cd],
      [ad, bd, cd, d],
      [ab, ac, ad, cd],
      [ab, ac, bc, cd],
      [ab, bc, bd, cd],
      [ab, ad, bd, cd],
    ])
      refine(tet, depth - 1);
  };
  // Any requested resolution is rounded upward to a power of two, never down.
  const depth = Math.ceil(Math.log2(subdivisions));
  const simplices: Record<ElementShape, number[][]> = {
    curve: [[0, 1]],
    triangle: [[0, 1, 2]],
    quad: [
      [0, 1, 2],
      [0, 2, 3],
    ],
    tetra: [[0, 1, 2, 3]],
    hex: [
      [0, 1, 2, 6],
      [0, 2, 3, 6],
      [0, 3, 7, 6],
      [0, 7, 4, 6],
      [0, 4, 5, 6],
      [0, 5, 1, 6],
    ],
    wedge: [
      [0, 1, 2, 5],
      [0, 1, 5, 4],
      [0, 4, 5, 3],
    ],
    pyramid: [
      [0, 1, 2, 4],
      [0, 2, 3, 4],
    ],
  };
  // A shared face uses its smallest global corner as the diagonal apex, regardless of either cell's rotation.
  const fan = (face: readonly number[]): number[][] => {
    const start = face.findIndex((i) => cell.ids[i] === Math.min(...face.map((j) => cell.ids[j])));
    return Array.from({ length: face.length - 2 }, (_, k) => [
      face[start],
      face[(start + k + 1) % face.length],
      face[(start + k + 2) % face.length],
    ]);
  };
  if (cell.shape === 'quad') simplices.quad = fan([0, 1, 2, 3]);
  if (['hex', 'wedge', 'pyramid'].includes(cell.shape)) {
    const shapeFaces =
      cell.shape === 'pyramid'
        ? [
            [0, 3, 2, 1],
            [0, 1, 4],
            [1, 2, 4],
            [2, 3, 4],
            [3, 0, 4],
          ]
        : faces[cell.shape]!.map((face) =>
            cell.shape === 'wedge' && face.length === 4 ? [face[0], face[1], face[3], face[2]] : face,
          );
    const apex = vertices.findIndex((_, i) => cell.ids[i] === Math.min(...vertices.map((_, j) => cell.ids[j])));
    simplices[cell.shape] = shapeFaces
      .filter((face) => !face.includes(apex))
      .flatMap((face) => fan(face).map((tri) => [apex, ...tri]));
  }
  for (const simplex of simplices[cell.shape])
    refine(
      simplex.map((i) => vertices[i]),
      depth,
    );
}
