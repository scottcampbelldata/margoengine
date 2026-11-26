import { MargoError } from '@margoengine/math/errors';
import { hypot, ln } from '@margoengine/math/pinned';
import { atan2 } from '../ship/propeller.js';
import type { HullMesh, Vec3 } from './wetted.js';

const MAX_PANELS = 512;
const BED_IMAGES = 12;

interface Edge {
  readonly length: number;
  readonly direction: Vec3;
  readonly outward: Vec3;
}

interface Panel {
  readonly vertices: readonly [Vec3, Vec3, Vec3];
  readonly edges: readonly Edge[];
  readonly centre: Vec3;
  readonly normal: Vec3;
  readonly area: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const magnitude = ([x, y, z]: Vec3): number => hypot(x, y, z);
const scale = ([x, y, z]: Vec3, by: number): Vec3 => [x * by, y * by, z * by];

/** Triangulate the actual wetted hull at the reference waterline, without an artificial lid. */
export function panelsOf(mesh: HullMesh, waterline: number, depth: number, limit = MAX_PANELS): Panel[] {
  const points = (index: number): Vec3 => {
    const at = index * 3;
    return [mesh.vertices[at]!, mesh.vertices[at + 1]! - waterline, mesh.vertices[at + 2]!];
  };
  const panels: Panel[] = [];
  for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
    const triangle = [points(mesh.indices[i]!), points(mesh.indices[i + 1]!), points(mesh.indices[i + 2]!)];
    if (!triangle.some((point) => point[1] < 0)) continue;
    const wet: Vec3[] = [];
    for (let j = 0; j < 3; j++) {
      const a = triangle[j]!;
      const b = triangle[(j + 1) % 3]!;
      if (a[1] <= -depth)
        throw new MargoError(
          'state',
          'The surge panels reach below the modelled bed. Use a hull draft smaller than the local water depth.',
        );
      if (a[1] <= 0) wet.push(a);
      if ((a[1] > 0 && b[1] < 0) || (a[1] < 0 && b[1] > 0)) {
        const t = a[1] / (a[1] - b[1]);
        wet.push([a[0] + t * (b[0] - a[0]), 0, a[2] + t * (b[2] - a[2])]);
      }
    }
    for (let j = 1; j + 1 < wet.length; j++) {
      const vertices = [wet[0]!, wet[j]!, wet[j + 1]!] as const;
      const [a, b, c] = vertices;
      const direction = cross(sub(b, a), sub(c, a));
      const area = magnitude(direction) / 2;
      if (!(area > 0)) continue;
      const normal = scale(direction, 1 / (2 * area));
      const centre: Vec3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
      const edges = vertices.map((p, k) => {
        const tangent = sub(vertices[(k + 1) % 3]!, p);
        const length = magnitude(tangent);
        const direction = scale(tangent, 1 / length);
        return { length, direction, outward: cross(direction, normal) };
      });
      panels.push({ vertices, centre, area, normal, edges });
      if (panels.length > limit)
        throw new MargoError(
          'state',
          `This hull panel solve supports ${limit} wetted panels. Use a coarser closed hull mesh or disable the panel option.`,
        );
    }
  }
  return panels;
}

/** Analytic constant-panel single-layer potential and signed solid angle, without the 1/(4π) factor. */
function influence(panel: Panel, point: Vec3, self: boolean): readonly [number, number] {
  const [a, b, c] = panel.vertices.map((vertex) => sub(vertex, point)) as [Vec3, Vec3, Vec3];
  const r = [a, b, c];
  const lengths = r.map(magnitude);
  const [ra, rb, rc] = lengths as [number, number, number];
  const angle = self
    ? 0
    : 2 * atan2(dot(a, cross(b, c)), ra * rb * rc + dot(a, b) * rc + dot(b, c) * ra + dot(c, a) * rb);
  const height = self ? 0 : -dot(a, panel.normal);
  let potential = height * angle;
  for (let k = 0; k < 3; k++) {
    const edge = panel.edges[k]!;
    const start = r[k]!;
    const finish = r[(k + 1) % 3]!;
    const offset = dot(start, edge.outward);
    if (offset === 0) continue;
    const startLength = lengths[k]!;
    const finishLength = lengths[(k + 1) % 3]!;
    const distance = startLength + finishLength;
    const remainder = distance - edge.length;
    if (remainder > 1e-8 * distance) {
      potential += offset * ln((distance + edge.length) / remainder);
      continue;
    }
    // Near an edge, R1 + R2 - L loses the distance to the edge. Evaluate the same line integral
    // using signed asinh primitives with a perpendicular distance instead.
    const s = dot(start, edge.direction);
    const t = dot(finish, edge.direction);
    const p = startLength + Math.abs(s);
    const q = finishLength + Math.abs(t);
    const perpendicular = magnitude(cross(start, edge.direction));
    const integral =
      s < 0 && t >= 0
        ? perpendicular > 0
          ? ln(p / perpendicular) + ln(q / perpendicular)
          : 0
        : Math.sign(t || s) * ln(q / p);
    potential += offset * integral;
  }
  return [potential, angle];
}

function green(panel: Panel, target: Vec3, self: boolean, depth: number): readonly [number, number] {
  const [directPotential, directAngle] = influence(panel, target, self);
  const [x, y, z] = target;
  const [mirrorPotential, mirrorAngle] = influence(panel, [x, -y, z], false);
  let potential = directPotential - mirrorPotential;
  let angle = directAngle - mirrorAngle;
  if (depth === Infinity) return [potential, angle];
  // Odd reflection at the free surface, even reflection at the bed. Opposite shells cancel their leading far term.
  for (let i = 1; i <= BED_IMAGES; i++) {
    const sign = i % 2 ? -1 : 1;
    for (const shift of [-2 * i * depth, 2 * i * depth]) {
      const [p, a] = influence(panel, [x, y + shift, z], false);
      const [pm, am] = influence(panel, [x, -y + shift, z], false);
      potential += sign * (p - pm);
      angle += sign * (a - am);
    }
  }
  return [potential, angle];
}

function solve(matrix: Float64Array, rhs: Float64Array): void {
  const n = rhs.length;
  for (let k = 0; k < n; k++) {
    let pivot = k;
    for (let i = k + 1; i < n; i++) {
      if (Math.abs(matrix[i * n + k]!) > Math.abs(matrix[pivot * n + k]!)) pivot = i;
    }
    const value = matrix[pivot * n + k]!;
    if (!(Math.abs(value) > 1e-12 && Number.isFinite(value)))
      throw new MargoError(
        'state',
        'The surge panel system is singular. Use a closed hull without overlapping or degenerate panels.',
      );
    if (pivot !== k) {
      for (let j = k; j < n; j++)
        [matrix[k * n + j], matrix[pivot * n + j]] = [matrix[pivot * n + j]!, matrix[k * n + j]!];
      [rhs[k], rhs[pivot]] = [rhs[pivot]!, rhs[k]!];
    }
    for (let i = k + 1; i < n; i++) {
      const ratio = matrix[i * n + k]! / value;
      for (let j = k + 1; j < n; j++) matrix[i * n + j]! -= ratio * matrix[k * n + j]!;
      rhs[i]! -= ratio * rhs[k]!;
    }
  }
  for (let i = n - 1; i >= 0; i--) {
    let value = rhs[i]!;
    for (let j = i + 1; j < n; j++) value -= matrix[i * n + j]! * rhs[j]!;
    rhs[i] = value / matrix[i * n + i]!;
  }
}

/** The high-encounter-frequency surge virtual mass, kg, from a 3D potential boundary integral at mean draft. */
export function surgePanelMass(mesh: HullMesh, waterline: number, density: number, depth = Infinity): number {
  if (!(depth > 0))
    throw new MargoError('state', 'The surge panel water depth is invalid. Use a positive depth or deep water.');
  const panels = panelsOf(mesh, waterline, depth);
  const n = panels.length;
  const matrix = new Float64Array(n * n);
  const potential = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const [single, angle] = green(panels[j]!, panels[i]!.centre, i === j, depth);
      matrix[i * n + j] = (i === j ? 2 * Math.PI : 0) + angle;
      potential[i]! -= single * panels[j]!.normal[0];
    }
  }
  solve(matrix, potential);
  let mass = 0;
  for (let i = 0; i < n; i++) mass -= density * potential[i]! * panels[i]!.normal[0] * panels[i]!.area;
  if (!(mass >= 0 && Number.isFinite(mass)))
    throw new MargoError(
      'state',
      'The surge panel mass is invalid. Use an outward-wound closed hull with distinct panels.',
    );
  return mass;
}
