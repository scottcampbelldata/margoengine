import { fault } from '../../shared/errors.js';
// FBX surface schema: Autodesk FbxNurbsSurface/FbxPatch. Basis conversion: Piegl/Tiller and Catmull/Rom.
import { tessellateNurbsSurface, type NurbsSurface } from '@margoengine/loaders/nurbs';
import { array, findChild, invalid, objectName, type FBXNode, type FBXValue, type ParseBudget } from './document.js';
import type { ExtensionHooks, FBXExtension } from './extension.js';
import { fbxGeometricTransform, multiply, translation } from './math.js';

const record = (name: string, properties: FBXValue[] = [], children: FBXNode[] = []): FBXNode => ({
  name,
  properties,
  children,
});
const field = (source: FBXNode, name: string, fallback?: FBXValue[]): FBXValue[] =>
  findChild(source, name)?.properties ?? fallback ?? invalid(`surface ${name}`);
const numbers = (source: FBXNode, name: string): number[] => Array.from(array(source, name));
const dimensions = (source: FBXNode): [number, number] => {
  const d = numbers(source, 'Dimensions');
  if (d.length !== 2 || d.some((n) => !Number.isSafeInteger(n) || n < 2)) invalid('surface dimensions');
  return d as [number, number];
};
interface Net {
  u: number;
  v: number;
  points: Float64Array;
}
function net(source: FBXNode, budget: ParseBudget): Net {
  const [u, v] = dimensions(source),
    raw = array(source, 'Points');
  if (raw.length !== u * v * 4 || u * v > budget.limits.vertices) invalid('surface control point count');
  budget.array(raw.length * 8);
  budget.work(raw.length);
  const points = Float64Array.from(raw);
  for (let i = 0; i < points.length; i++)
    if (!Number.isFinite(points[i]) || (i % 4 === 3 && points[i] <= 0)) invalid('surface control point or weight');
  return { u, v, points };
}
// FBX is u-fastest, while loaders/nurbs is v-fastest. Closure copies complete rows/columns with their weights.
function prepare(
  net: Net,
  countU: number,
  countV: number,
  degreeU: number,
  degreeV: number,
  knotsU: number[],
  knotsV: number[],
  budget: ParseBudget,
): NurbsSurface {
  budget.array(countU * countV * 32);
  budget.work(countU * countV * 4);
  const points = new Float64Array(countU * countV * 3),
    weights = new Float64Array(countU * countV);
  for (let u = 0; u < countU; u++)
    for (let v = 0; v < countV; v++) {
      const from = ((v % net.v) * net.u + (u % net.u)) * 4,
        to = u * countV + v;
      for (let k = 0; k < 3; k++) points[to * 3 + k] = net.points[from + k];
      weights[to] = net.points[from + 3];
    }
  return { degreeU, degreeV, countU, countV, knotsU, knotsV, points, weights };
}
function nurbs(source: FBXNode, control: Net, budget: ParseBudget): NurbsSurface {
  const order = findChild(source, 'NurbsSurfaceOrder')
      ? numbers(source, 'NurbsSurfaceOrder')
      : numbers(source, 'NurbOrder'),
    forms = field(source, 'Form', ['Open', 'Open']);
  if (order.length !== 2 || order.some((n) => !Number.isSafeInteger(n) || n < 2 || n > 32)) invalid('surface order');
  const ku = numbers(source, 'KnotVectorU'),
    kv = numbers(source, 'KnotVectorV'),
    u = ku.length - order[0],
    v = kv.length - order[1];
  for (const [count, given, degree, form] of [
    [u, control.u, order[0] - 1, forms[0]],
    [v, control.v, order[1] - 1, forms[1]],
  ] as const) {
    if (
      !['Open', 'Closed', 'Periodic'].includes(String(form)) ||
      count < given ||
      count - given > degree ||
      (count !== given && form === 'Open')
    )
      invalid('surface form/knot count');
  }
  return prepare(control, u, v, order[0] - 1, order[1] - 1, ku, kv, budget);
}
function knots(count: number, degree: number, bezier: boolean): number[] {
  if (!bezier) return Array.from({ length: count + degree + 1 }, (_, i) => i);
  if ((count - 1) % degree) invalid('Bezier patch point count');
  const spans = (count - 1) / degree,
    out = new Array<number>(degree + 1).fill(0);
  for (let i = 1; i < spans; i++) for (let k = 0; k < degree; k++) out.push(i);
  out.push(...new Array<number>(degree + 1).fill(spans));
  return out;
}
const patchTypes = ['Bezier', 'BezierQuadric', 'Cardinal', 'BSpline', 'Linear'];
function patchType(value: unknown): string {
  const name = typeof value === 'number' ? patchTypes[value] : String(value);
  if (!patchTypes.includes(name)) invalid('patch basis type');
  return name;
}
// Cardinal spans become cubic Bezier spans in homogeneous coordinates. The two axes are independent linear maps.
function cardinal(net: Net, axis: 0 | 1, closed: boolean, budget: ParseBudget): Net {
  const count = axis === 0 ? net.u : net.v,
    spans = closed ? count : count - 3;
  if (spans < 1) invalid('cardinal patch point count');
  const target = spans * 3 + 1,
    u = axis === 0 ? target : net.u,
    v = axis === 1 ? target : net.v;
  budget.array(u * v * 32);
  budget.work(u * v * 32);
  const points = new Float64Array(u * v * 4);
  for (let j = 0; j < (axis === 0 ? net.v : net.u); j++)
    for (let span = 0; span < spans; span++) {
      const start = closed ? span - 1 : span;
      const source = (i: number, k: number) => {
        const at = (((start + i) % count) + count) % count,
          index = axis === 0 ? (j * net.u + at) * 4 : (at * net.u + j) * 4;
        return net.points[index + k] * (k === 3 ? 1 : net.points[index + 3]);
      };
      for (let b = 0; b < 4; b++) {
        const at = span * 3 + b,
          index = axis === 0 ? (j * u + at) * 4 : (at * u + j) * 4;
        for (let k = 0; k < 4; k++)
          points[index + k] =
            b === 0
              ? source(1, k)
              : b === 3
                ? source(2, k)
                : b === 1
                  ? source(1, k) + (source(2, k) - source(0, k)) / 6
                  : source(2, k) - (source(3, k) - source(1, k)) / 6;
        const weight = points[index + 3];
        if (!(weight > 0)) invalid('cardinal patch weight');
        for (let k = 0; k < 3; k++) points[index + k] /= weight;
      }
    }
  return { u, v, points };
}
function patch(source: FBXNode, control: Net, budget: ParseBudget): NurbsSurface {
  const types = field(source, 'PatchType'),
    closed = field(source, 'Closed', [0, 0]);
  if (types.length !== 2) invalid('patch types');
  const modes = types.map(patchType),
    wrap = [false, false];
  let current = control;
  const degrees = modes.map((t) => (t === 'Linear' ? 1 : t === 'BezierQuadric' ? 2 : 3));
  for (const axis of [0, 1] as const) {
    const isClosed = !!Number(closed[axis]);
    if (modes[axis] === 'Cardinal') {
      current = cardinal(current, axis, isClosed, budget);
      modes[axis] = 'Bezier';
    } else wrap[axis] = isClosed;
  }
  const u = current.u + (wrap[0] ? (modes[0] === 'BSpline' ? 3 : 1) : 0),
    v = current.v + (wrap[1] ? (modes[1] === 'BSpline' ? 3 : 1) : 0);
  return prepare(
    current,
    u,
    v,
    degrees[0],
    degrees[1],
    knots(u, degrees[0], modes[0].startsWith('Bezier')),
    knots(v, degrees[1], modes[1].startsWith('Bezier')),
    budget,
  );
}
// Optional end caps use the same polygon triangulator as ordinary FBX faces, with separate flat normals.
function caps(
  source: FBXNode,
  rows: number,
  cols: number,
  result: { positions: Float32Array; normals?: Float32Array; uvs?: Float32Array },
  triangles: Int32Array,
  budget: ParseBudget,
): Grid {
  const boundaries: { ring: number[]; reverse: boolean }[] = [];
  const u = field(source, 'UCapped', [0, 0]),
    v = field(source, 'VCapped', [0, 0]);
  if (Number(u[0]))
    boundaries.push({
      ring: Array.from({ length: cols }, (_, j) => j),
      reverse: false,
    });
  if (Number(u[1]))
    boundaries.push({
      ring: Array.from({ length: cols }, (_, j) => (rows - 1) * cols + j),
      reverse: true,
    });
  if (Number(v[0]))
    boundaries.push({
      ring: Array.from({ length: rows }, (_, i) => i * cols),
      reverse: true,
    });
  if (Number(v[1]))
    boundaries.push({
      ring: Array.from({ length: rows }, (_, i) => i * cols + cols - 1),
      reverse: false,
    });
  if (!boundaries.length)
    return { positions: result.positions, normals: result.normals!, uvs: result.uvs!, indices: triangles, rings: [] };
  const extra = boundaries.reduce((n, b) => n + b.ring.length, 0),
    count = result.positions.length / 3;
  if (count + extra > budget.limits.vertices || triangles.length + extra * 3 > budget.limits.corners)
    invalid('surface cap budget');
  budget.array((count + extra) * 32 + (triangles.length + extra) * 4);
  budget.work(extra * 16);
  const positions = Array.from(result.positions),
    normals = Array.from(result.normals!),
    uvs = Array.from(result.uvs!),
    indices = Array.from(triangles),
    flip = Number(field(source, 'FlipNormals', [0])[0]) ? -1 : 1,
    rings: number[][] = [];
  for (const { ring, reverse } of boundaries) {
    if (ring.length > 4096) invalid('surface cap polygon budget');
    if (reverse !== (flip === -1)) ring.reverse();
    const normal = newell(positions, ring),
      length = Math.hypot(...normal);
    if (length === 0) continue;
    rings.push(ring);
    const first = positions.length / 3;
    for (const i of ring) {
      for (let k = 0; k < 3; k++) {
        positions.push(positions[i * 3 + k]);
        normals.push(normal[k] / length);
      }
      uvs.push(uvs[i * 2], uvs[i * 2 + 1]);
    }
    for (let i = 0; i < ring.length; i++) indices.push(i === ring.length - 1 ? ~(first + i) : first + i);
  }
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    uvs: Float32Array.from(uvs),
    indices: Int32Array.from(indices),
    rings,
  };
}
// The unnormalized polygon normal of Newell's method: twice the projected areas of the ring.
function newell(positions: ArrayLike<number>, ring: readonly number[]): number[] {
  const normal = [0, 0, 0];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] * 3,
      b = ring[(i + 1) % ring.length] * 3;
    for (let k = 0; k < 3; k++)
      normal[k] +=
        (positions[a + ((k + 1) % 3)] - positions[b + ((k + 1) % 3)]) *
        (positions[a + ((k + 2) % 3)] + positions[b + ((k + 2) % 3)]);
  }
  return normal;
}
interface Grid {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Int32Array;
  /** Boundary rings copied for caps, in order: the cap vertices after the grid repeat them. */
  rings: number[][];
}
const surfaceOf = (source: FBXNode, control: Net, budget: ParseBudget): NurbsSurface =>
  String(source.properties[2]) === 'Patch' ? patch(source, control, budget) : nurbs(source, control, budget);
// The grid of one control net: the same knots, weights and steps give the same parameters for every net of a geometry.
function tessellate(source: FBXNode, control: Net, budget: ParseBudget, withCaps: boolean): Grid {
  const surface = surfaceOf(source, control, budget),
    step = field(source, 'Step', [4 * surface.degreeU, 4 * surface.degreeV]).map(Number);
  if (step.length !== 2 || step.some((n) => !Number.isSafeInteger(n) || n < 1)) invalid('surface step');
  // Charge before the shared tessellator allocates either break lists or output grids.
  const spans = (k: ArrayLike<number>, p: number, n: number) => {
    let out = 0;
    for (let i = p; i < n; i++) if (k[i + 1] > k[i]) out++;
    return out;
  };
  const rows = spans(surface.knotsU, surface.degreeU, surface.countU) * step[0] + 1,
    cols = spans(surface.knotsV, surface.degreeV, surface.countV) * step[1] + 1;
  if (
    !Number.isSafeInteger(rows * cols) ||
    rows * cols > budget.limits.vertices ||
    (rows - 1) * (cols - 1) * 6 > budget.limits.corners
  )
    invalid('surface tessellation budget');
  budget.array(rows * cols * 64 + (rows - 1) * (cols - 1) * 24);
  budget.work(rows * cols * (surface.degreeU + 1) * (surface.degreeV + 1));
  const result = tessellateNurbsSurface(surface, {
      segmentsU: step[0],
      segmentsV: step[1],
      maxVertices: budget.limits.vertices,
      maxTriangles: Math.floor(budget.limits.corners / 3),
    }),
    indices = Int32Array.from(result.indices!, (i, k) => (k % 3 === 2 ? ~i : i));
  // Swapping FBX's u-fastest storage does not change its parameter-space winding.
  if (Number(field(source, 'FlipNormals', [0])[0])) {
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i];
      indices[i] = ~indices[i + 2];
      indices[i + 2] = ~a;
    }
    for (let i = 0; i < result.normals!.length; i++) result.normals![i] *= -1;
  }
  return withCaps
    ? caps(source, rows, cols, result, indices, budget)
    : { positions: result.positions, normals: result.normals!, uvs: result.uvs!, indices, rings: [] };
}
function mesh(source: FBXNode, budget: ParseBudget, deformed?: Deformation, tree?: Tree): void {
  const control = net(source, budget),
    capped = tessellate(source, control, budget, true);
  if (deformed) deform(source, control, capped, deformed, budget, tree!);
  const layer = (name: string, dataName: string, width: number, data: Float32Array) =>
    record(
      name,
      [0],
      [
        record('MappingInformationType', ['ByVertice']),
        record('ReferenceInformationType', ['Direct']),
        record(dataName, [data]),
        ...(width === 2 ? [record('Name', ['SurfaceUV'])] : []),
      ],
    );
  source.properties[2] = 'Mesh';
  source.children = [
    ...source.children.filter((n) => n.name === 'Properties70' || n.name === 'LayerElementMaterial'),
    record('Vertices', [capped.positions]),
    record('PolygonVertexIndex', [capped.indices]),
    layer('LayerElementNormal', 'Normals', 3, capped.normals),
    layer('LayerElementUV', 'UV', 2, capped.uvs),
  ];
}
// A control net with the geometry's own weights and other xyz: every grid of one geometry has the same rational basis
// R (The NURBS Book, Piegl and Tiller 1997, eq. 4.2), so the grid of these values is R times them.
function derived(control: Net, budget: ParseBudget, fill: (cp: number, out: Float64Array, at: number) => void): Net {
  budget.array(control.points.length * 8);
  budget.work(control.points.length);
  const points = new Float64Array(control.points.length);
  for (let cp = 0, at = 0; at < points.length; cp++, at += 4) {
    fill(cp, points, at);
    points[at + 3] = control.points[at + 3];
  }
  return { u: control.u, v: control.v, points };
}
interface Deformation {
  shapes: FBXNode[];
  clusters: FBXNode[];
  /** The Skin deformer, when there is one. */
  skin?: FBXNode;
  /** The joint Model each cluster moves with. */
  joints: Map<FBXNode, FBXNode>;
  /** Column-major 3x3 linear part of the geometric transform of the models that draw the surface; null when they differ. */
  geometric: number[] | null;
}
/** Where new objects go: the document's Objects and Connections. */
interface Tree {
  /** An object id no other object has. */
  fresh(): bigint;
  /** Adds `node` to Objects with an OO connection to `parent`. */
  add(node: FBXNode, parent: FBXValue): void;
  /** An OO connection from `child` to `parent`. */
  link(child: FBXValue, parent: FBXValue): void;
}
const unsupported = (what: string): never => {
  throw fault(
    'unsupported',
    `FBX surface ${what}; bake it to an animated polygon mesh before import, or give the control points each vertex reaches one weight set`,
  );
};
// A shape moves control points, and the surface is linear in them: the grid of the deltas is the exact morph of every
// vertex at every weight, in-betweens included. Normals are the deformed surface's own at full weight, as a mesh shape's.
function deformShape(source: FBXNode, control: Net, base: Grid, shape: FBXNode, budget: ParseBudget): void {
  const cpCount = control.u * control.v,
    indices = array(shape, 'Indexes'),
    deltas = array(shape, 'Vertices');
  if (deltas.length !== indices.length * 3) invalid('surface shape delta count');
  budget.array(cpCount * 4);
  budget.work(indices.length * 4);
  const lookup = new Int32Array(cpCount).fill(-1);
  for (let i = 0; i < indices.length; i++) {
    const cp = indices[i];
    if (!Number.isInteger(cp) || cp < 0 || cp >= cpCount || lookup[cp] !== -1) invalid('surface shape control point');
    for (let k = 0; k < 3; k++) if (!Number.isFinite(deltas[i * 3 + k])) invalid('surface shape delta');
    lookup[cp] = i;
  }
  const value = (cp: number, k: number) => (lookup[cp] < 0 ? 0 : deltas[lookup[cp] * 3 + k]);
  const moved = tessellate(
      source,
      derived(control, budget, (cp, out, at) => {
        for (let k = 0; k < 3; k++) out[at + k] = value(cp, k);
      }),
      budget,
      false,
    ),
    target = tessellate(
      source,
      derived(control, budget, (cp, out, at) => {
        for (let k = 0; k < 3; k++) out[at + k] = control.points[cp * 4 + k] + value(cp, k);
      }),
      budget,
      false,
    );
  const count = base.positions.length / 3,
    grid = moved.positions.length / 3;
  budget.array(count * 72);
  budget.work(count * 8);
  const offsets = new Float64Array(count * 3),
    normals = new Float64Array(count * 3),
    targets = new Float64Array(count * 3);
  for (let i = 0; i < grid * 3; i++) {
    offsets[i] = moved.positions[i];
    normals[i] = target.normals[i] - base.normals[i];
    targets[i] = target.positions[i];
  }
  // Cap vertices repeat their ring, and a cap's normal is the flat one of its moved ring.
  let at = grid;
  for (const ring of base.rings) {
    const normal = newell(targets, ring),
      length = Math.hypot(...normal);
    for (const v of ring) {
      for (let k = 0; k < 3; k++) {
        offsets[at * 3 + k] = offsets[v * 3 + k];
        normals[at * 3 + k] = length ? normal[k] / length - base.normals[at * 3 + k] : 0;
      }
      at++;
    }
  }
  if (at !== count) invalid('surface cap layout');
  const kept: number[] = [];
  for (let v = 0; v < count; v++)
    for (let k = 0; k < 3; k++)
      if (offsets[v * 3 + k] || normals[v * 3 + k]) {
        kept.push(v);
        break;
      }
  budget.array(kept.length * 52);
  const pick = (from: Float64Array) =>
    Float64Array.from({ length: kept.length * 3 }, (_, i) => from[kept[Math.floor(i / 3)] * 3 + (i % 3)]);
  shape.children = [
    ...shape.children.filter((n) => !['Indexes', 'Vertices', 'Normals'].includes(n.name)),
    record('Indexes', [Int32Array.from(kept)]),
    record('Vertices', [pick(offsets)]),
    record('Normals', [pick(normals)]),
  ];
}
// A skin moves each control point by the blend of its own weights. A vertex is a fixed affine combination of the
// control points its basis reaches, so when they all carry one weight set the vertex moves by that same blend, exactly,
// whatever the joints do: an affine map commutes with affine combinations (Farin, Curves and Surfaces for CAGD, 2002,
// ch. 3). Where those points carry different sets, linear blend skinning of the net (Magnenat-Thalmann, Laperriere and
// Thalmann 1988) moves the vertex to sum_j s_j S_j b_j: s_j is the vertex's share of joint j (its basis over the points'
// normalized weights) and b_j a bind position of its own, the share-weighted mean of those points. A glTF skin
// (glTF 2.0, section 3.7.3) has one position v a vertex, so each joint whose weight changes across the points gets four
// helper joints, identity children of it whose inverse binds add the offsets R e_k of a regular tetrahedron. Any
// d = b_j - v with |d| <= R / (2 sqrt(3)) has the barycentric weights 1/4 + e_k.d / (4R) >= 1/8, as sum_k e_k = 0 and
// sum_k e_k e_k^T = 4I for these four vectors (Coxeter, Regular Polytopes, 1973), and then
// sum_k s_j (1/4 + e_k.d / (4R)) S_j (v + R e_k) = s_j S_j b_j: the exact vertex, in eight influences for two such joints.
const TETRAHEDRON = [
  [1, 1, 1],
  [1, -1, -1],
  [-1, 1, -1],
  [-1, -1, 1],
];
function deformSkin(
  source: FBXNode,
  control: Net,
  base: Grid,
  { clusters, skin, joints, geometric }: Deformation,
  budget: ParseBudget,
  tree: Tree,
): void {
  const cpCount = control.u * control.v,
    n = clusters.length;
  budget.array(cpCount * n * 8 + cpCount * 8);
  budget.work(cpCount * n);
  const weights = new Float64Array(cpCount * n),
    seen = new Int32Array(cpCount);
  clusters.forEach((cluster, c) => {
    if (!findChild(cluster, 'Indexes') && !findChild(cluster, 'Weights')) return;
    const indices = array(cluster, 'Indexes'),
      values = array(cluster, 'Weights');
    if (indices.length !== values.length) invalid('surface cluster weight count');
    budget.work(indices.length);
    for (let i = 0; i < indices.length; i++) {
      const cp = indices[i],
        weight = values[i];
      // As on a mesh, writers leave entries for control points the geometry lost after binding.
      if (cp >= cpCount) continue;
      if (!Number.isInteger(cp) || cp < 0 || seen[cp] === c + 1 || !Number.isFinite(weight) || weight < 0)
        invalid('surface cluster weight');
      seen[cp] = c + 1;
      weights[cp * n + c] = weight;
    }
  });
  const sets = new Map<string, number>(),
    setOf = new Int32Array(cpCount);
  for (let cp = 0; cp < cpCount; cp++) {
    const key = weights.subarray(cp * n, cp * n + n).join(',');
    let set = sets.get(key);
    if (set === undefined) sets.set(key, (set = sets.size));
    setOf[cp] = set;
  }
  const count = base.positions.length / 3,
    copies = base.rings.flat(),
    grid = count - copies.length;
  budget.array(count * 8 * (n + 1));
  budget.work(count * sets.size);
  const reached: number[][] = Array.from({ length: grid }, () => []);
  // A set reaches a vertex when its points' share of the vertex is not zero. Generic positive values stand in for one,
  // so a Cardinal patch's negative coefficients cannot cancel to an exact zero (Schwartz 1980; Zippel 1979).
  for (let set = 0; set < sets.size; set++) {
    const reach = tessellate(
      source,
      derived(control, budget, (cp, out, at) => {
        out[at] = setOf[cp] === set ? 1 + ((cp * 0.6180339887498949) % 1) : 0;
        out[at + 1] = out[at + 2] = 0;
      }),
      budget,
      false,
    );
    for (let v = 0; v < grid; v++) if (reach.positions[v * 3] !== 0) reached[v].push(set);
  }
  for (let v = 0; v < grid; v++) if (!reached[v].length) invalid('surface skin coverage');
  const rows = [...sets.keys()].map((key) => key.split(',').map(Number));
  // Each cluster's weight at each vertex; helper clusters follow the source ones.
  const out: Float64Array[] = clusters.map(() => new Float64Array(count)),
    blended: number[] = [];
  for (let v = 0; v < grid; v++)
    if (reached[v].length === 1) for (let c = 0; c < n; c++) out[c][v] = rows[reached[v][0]][c];
    else blended.push(v);
  const made: FBXNode[] = [];
  if (blended.length) {
    for (const cluster of clusters) {
      const mode = findChild(cluster, 'Mode')?.properties[0];
      if (mode !== undefined && mode !== 'Normalize')
        unsupported(`skin weights blend across the control points of one vertex in a ${String(mode)} cluster`);
    }
    // A Normalize cluster set moves a point by its weights over their total, as on a mesh.
    const shares = rows.map((row) => {
      const total = row.reduce((a, b) => a + b, 0);
      if (!(total > 0))
        throw new RangeError('FBX skin vertex has no positive weights; clean up the source model before export');
      return row.map((w) => w / total);
    });
    const varies = (v: number, c: number) => reached[v].some((set) => shares[set][c] !== shares[reached[v][0]][c]),
      helpers: { c: number; radius: number; first: number }[] = [],
      share: Float32Array[] = [],
      mean: Float32Array[] = [];
    clusters.forEach((_, c) => {
      if (!blended.some((v) => varies(v, c))) return;
      // The vertex's share of the joint and the share-weighted sum of its points, by the surface's own basis.
      share[c] = tessellate(
        source,
        derived(control, budget, (cp, values, at) => {
          values[at] = shares[setOf[cp]][c];
          values[at + 1] = values[at + 2] = 0;
        }),
        budget,
        false,
      ).positions;
      mean[c] = tessellate(
        source,
        derived(control, budget, (cp, values, at) => {
          for (let k = 0; k < 3; k++) values[at + k] = shares[setOf[cp]][c] * control.points[cp * 4 + k];
        }),
        budget,
        false,
      ).positions;
      let reach = 0;
      for (const v of blended) {
        if (!varies(v, c)) continue;
        const s = share[c][v * 3];
        let length = 0;
        for (let k = 0; k < 3; k++) length += (mean[c][v * 3 + k] - s * base.positions[v * 3 + k]) ** 2;
        length = Math.sqrt(length);
        if (s < 0 || (s === 0 && length > 0))
          unsupported(
            'skin weights blend across the control points of one vertex where a joint takes a negative share',
          );
        if (s > 0) reach = Math.max(reach, length / s);
      }
      if (reach > 0) helpers.push({ c, radius: 2 * Math.sqrt(3) * reach, first: n + helpers.length * 4 });
    });
    budget.array(helpers.length * 4 * count * 8);
    budget.work(blended.length * n * 4);
    for (let i = 0; i < helpers.length * 4; i++) out.push(new Float64Array(count));
    const helperOf = new Map(helpers.map((helper) => [helper.c, helper]));
    for (const v of blended) {
      let influences = 0;
      for (let c = 0; c < n; c++) {
        const helper = helperOf.get(c);
        if (!helper || !varies(v, c)) {
          // A joint whose weight holds across the points moves the vertex by that weight.
          const w = varies(v, c) ? share[c][v * 3] : shares[reached[v][0]][c];
          out[c][v] = w;
          if (w > 0) influences++;
          continue;
        }
        const s = share[c][v * 3];
        if (!(s > 0)) continue;
        for (let k = 0; k < 4; k++) {
          let dot = 0;
          for (let r = 0; r < 3; r++) dot += TETRAHEDRON[k][r] * (mean[c][v * 3 + r] / s - base.positions[v * 3 + r]);
          out[helper.first + k][v] = s * (0.25 + dot / (4 * helper.radius));
        }
        influences += 4;
      }
      if (influences > 8)
        unsupported(
          'skin weights blend across the control points of one vertex past eight influences, four for each joint whose weight changes there',
        );
    }
    if (helpers.length && geometric === null)
      unsupported('skin blend on a surface that models with different geometric transforms draw');
    if (helpers.length && !skin) invalid('surface skin');
    budget.node(helpers.length * 20);
    budget.property(helpers.length * 40);
    for (const { c, radius } of helpers) {
      const cluster = clusters[c],
        joint = joints.get(cluster);
      if (!joint) invalid('surface cluster joint');
      if (!findChild(cluster, 'Transform') || !findChild(cluster, 'TransformLink'))
        invalid('surface cluster bind matrix');
      const transform = array(cluster, 'Transform'),
        link = array(cluster, 'TransformLink'),
        mode = findChild(cluster, 'Mode'),
        g = geometric ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
      if (transform.length !== 16 || link.length !== 16) invalid('surface cluster bind matrix');
      TETRAHEDRON.forEach((e, k) => {
        // The offset is in the space the inverse bind reads, after the geometric transform.
        const offset = [0, 1, 2].map((r) => radius * (g[r] * e[0] + g[3 + r] * e[1] + g[6 + r] * e[2])),
          name = `${objectName(joint!)} blend ${k}`,
          model = record('Model', [tree.fresh(), `Model::${name}`, 'LimbNode']),
          helper = record(
            'Deformer',
            [tree.fresh(), `SubDeformer::${name}`, 'Cluster'],
            [
              record('Version', [100]),
              ...(mode ? [mode] : []),
              record('Transform', [multiply(transform, translation(offset))]),
              record('TransformLink', [Float64Array.from(link)]),
            ],
          );
        tree.add(model, joint!.properties[0]);
        tree.add(helper, skin!.properties[0]);
        tree.link(model.properties[0], helper.properties[0]);
        made.push(helper);
      });
    }
  }
  for (const weightsOf of out) for (let i = 0; i < copies.length; i++) weightsOf[grid + i] = weightsOf[copies[i]];
  [...clusters, ...made].forEach((cluster, c) => {
    const indices: number[] = [],
      values: number[] = [];
    for (let v = 0; v < count; v++)
      if (out[c][v] > 0) {
        indices.push(v);
        values.push(out[c][v]);
      }
    budget.array(indices.length * 12);
    const rest = cluster.children.filter((node) => node.name !== 'Indexes' && node.name !== 'Weights');
    cluster.children = indices.length
      ? [...rest, record('Indexes', [Int32Array.from(indices)]), record('Weights', [Float64Array.from(values)])]
      : rest;
  });
}
function deform(
  source: FBXNode,
  control: Net,
  base: Grid,
  deformation: Deformation,
  budget: ParseBudget,
  tree: Tree,
): void {
  for (const shape of deformation.shapes) deformShape(source, control, base, shape, budget);
  if (deformation.clusters.length) deformSkin(source, control, base, deformation, budget, tree);
}
function normalize(roots: FBXNode[], budget: ParseBudget): void {
  const objects = roots.find((n) => n.name === 'Objects');
  if (!objects) return;
  const links = (roots.find((n) => n.name === 'Connections')?.children ?? []).filter(
      (n) => n.name === 'C' && n.properties[0] === 'OO',
    ),
    byId = new Map(objects.children.map((n) => [String(n.properties[0]), n])),
    parents = new Map<string, number>(),
    owners = new Map<string, string[]>(),
    kids = new Map<string, FBXNode[]>();
  budget.work(links.length);
  for (const link of links) {
    const child = String(link.properties[1]),
      parent = String(link.properties[2]),
      node = byId.get(child);
    parents.set(child, (parents.get(child) ?? 0) + 1);
    let up = owners.get(child);
    if (!up) owners.set(child, (up = []));
    up.push(parent);
    if (!node) continue;
    let list = kids.get(parent);
    if (!list) kids.set(parent, (list = []));
    list.push(node);
  }
  const typed = (id: FBXValue, type: string) => (kids.get(String(id)) ?? []).filter((n) => n.properties[2] === type);
  const surface = (n: FBXNode) => ['Nurb', 'NurbsSurface', 'Patch'].includes(String(n.properties[2]));
  // The deformers of each surface, gathered before any geometry is rewritten.
  const deformations = new Map<FBXNode, Deformation>();
  for (const source of objects.children) {
    if (!surface(source)) continue;
    const deformers = (kids.get(String(source.properties[0])) ?? []).filter(
      (n) => n.name === 'Deformer' && (n.properties[2] === 'Skin' || n.properties[2] === 'BlendShape'),
    );
    if (source.children.some((n) => n.name === 'Shape') || (deformers.length && source.name !== 'Geometry'))
      unsupported('deformation on inline legacy geometry has no control-net form');
    if (!deformers.length) continue;
    const skins = deformers.filter((n) => n.properties[2] === 'Skin');
    if (skins.length > 1) throw new TypeError('Multiple FBX skins on geometry; keep one per target when exporting');
    const shapes = deformers
      .filter((n) => n.properties[2] === 'BlendShape')
      .flatMap((d) => typed(d.properties[0], 'BlendShapeChannel'))
      .flatMap((c) => typed(c.properties[0], 'Shape'));
    const clusters = skins.flatMap((d) => typed(d.properties[0], 'Cluster')),
      joints = new Map<FBXNode, FBXNode>();
    for (const cluster of clusters) {
      const models = (kids.get(String(cluster.properties[0])) ?? []).filter((n) => n.name === 'Model');
      if (models.length === 1) joints.set(cluster, models[0]);
    }
    // The models drawing the surface: one geometric linear part for all of them, or null.
    let geometric: number[] | null = [1, 0, 0, 0, 1, 0, 0, 0, 1],
      first = true;
    for (const owner of owners.get(String(source.properties[0])) ?? []) {
      const model = byId.get(owner);
      if (model?.name !== 'Model') continue;
      const m = fbxGeometricTransform(model),
        part = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
      if (first) geometric = part;
      else if (geometric && part.some((value, i) => value !== geometric![i])) geometric = null;
      first = false;
    }
    // Each rewritten node must belong to this surface alone, or another geometry would read surface vertex numbers.
    for (const node of [...deformers, ...shapes, ...clusters])
      if (parents.get(String(node.properties[0])) !== 1) unsupported('deformer shared with other geometry');
    deformations.set(source, { shapes, clusters, skin: skins[0], joints, geometric });
  }
  const used = new Set(objects.children.map((n) => String(n.properties[0])));
  let next = -1n;
  let connections = roots.find((n) => n.name === 'Connections');
  const tree: Tree = {
    fresh() {
      while (used.has(String(next))) next--;
      used.add(String(next));
      return next--;
    },
    add(node, parent) {
      budget.node(1);
      budget.property(3);
      objects.children.push(node);
      tree.link(node.properties[0], parent);
    },
    link(child, parent) {
      if (!connections) {
        connections = record('Connections');
        roots.push(connections);
      }
      budget.node(1);
      budget.property(3);
      connections.children.push(record('C', ['OO', child, parent]));
    },
  };
  for (const source of [...objects.children]) {
    budget.work();
    if (!surface(source)) continue;
    if (source.name === 'Geometry') mesh(source, budget, deformations.get(source), tree);
    else if (source.name === 'Model' && findChild(source, 'Points')) {
      while (used.has(String(next))) next--;
      budget.node(1);
      budget.property(3);
      const geometry = record('Geometry', [next, source.properties[1], source.properties[2]], source.children);
      mesh(geometry, budget);
      objects.children.push(geometry);
      if (!connections) {
        connections = record('Connections');
        roots.push(connections);
      }
      budget.node(1);
      budget.property(3);
      connections.children.push(record('C', ['OO', next, source.properties[0]]));
      used.add(String(next--));
    }
  }
}
/** Tessellates FBX NURBS and all five patch bases through the optional loaders NURBS evaluator. */
export const surfaces: FBXExtension = { name: 'surfaces', geometry: normalize } as ExtensionHooks;
