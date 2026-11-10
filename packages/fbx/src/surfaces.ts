import { fault } from '../../shared/errors.js';
// FBX surface schema: Autodesk FbxNurbsSurface/FbxPatch. Basis conversion: Piegl/Tiller and Catmull/Rom.
import { tessellateNurbsSurface, type NurbsSurface } from '@margoengine/loaders/nurbs';
import { array, findChild, invalid, type FBXNode, type FBXValue, type ParseBudget } from './document.js';
import type { ExtensionHooks, FBXExtension } from './extension.js';

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
): { positions: Float32Array; normals: Float32Array; uvs: Float32Array; indices: Int32Array } {
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
    return { positions: result.positions, normals: result.normals!, uvs: result.uvs!, indices: triangles };
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
    flip = Number(field(source, 'FlipNormals', [0])[0]) ? -1 : 1;
  for (const { ring, reverse } of boundaries) {
    if (ring.length > 4096) invalid('surface cap polygon budget');
    if (reverse !== (flip === -1)) ring.reverse();
    const normal = [0, 0, 0];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i] * 3,
        b = ring[(i + 1) % ring.length] * 3;
      for (let k = 0; k < 3; k++) {
        normal[k] +=
          (positions[a + ((k + 1) % 3)] - positions[b + ((k + 1) % 3)]) *
          (positions[a + ((k + 2) % 3)] + positions[b + ((k + 2) % 3)]);
      }
    }
    const length = Math.hypot(...normal);
    if (length === 0) continue;
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
  };
}
function mesh(source: FBXNode, budget: ParseBudget): void {
  const control = net(source, budget),
    type = String(source.properties[2]),
    surface = type === 'Patch' ? patch(source, control, budget) : nurbs(source, control, budget),
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
  const capped = caps(source, rows, cols, result, indices, budget);
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
function normalize(roots: FBXNode[], budget: ParseBudget): void {
  const objects = roots.find((n) => n.name === 'Objects');
  if (!objects) return;
  const deformers = new Set(
    objects.children
      .filter((n) => n.name === 'Deformer' && ['Skin', 'BlendShape'].includes(String(n.properties[2])))
      .map((n) => String(n.properties[0])),
  );
  const deformed = new Set(
    (roots.find((n) => n.name === 'Connections')?.children ?? [])
      .filter((n) => n.name === 'C' && n.properties[0] === 'OO' && deformers.has(String(n.properties[1])))
      .map((n) => String(n.properties[2])),
  );
  const used = new Set(objects.children.map((n) => String(n.properties[0])));
  let next = -1n;
  let connections = roots.find((n) => n.name === 'Connections');
  for (const source of [...objects.children]) {
    budget.work();
    if (!['Nurb', 'NurbsSurface', 'Patch'].includes(String(source.properties[2]))) continue;
    if (deformed.has(String(source.properties[0])) || source.children.some((n) => n.name === 'Shape'))
      throw fault(
        'unsupported',
        'FBX surface control-point deformation has no exact glTF skin equivalent; bake it to an animated polygon mesh before import',
      );
    if (source.name === 'Geometry') mesh(source, budget);
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
