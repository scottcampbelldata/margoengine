import { hypot } from '@margoengine/math/pinned';
import type { HullMesh, Vec3 } from './wetted.js';

type Point = readonly [number, number];
interface SectionEdge {
  readonly a: Point;
  readonly b: Point;
  readonly normal: Point;
}

interface GirthEdge extends SectionEdge {
  readonly distance: number;
  readonly length: number;
}

interface Girth {
  readonly edges: readonly GirthEdge[];
  readonly direction: number;
}

export interface BilgePressureSection {
  readonly root: Point;
  readonly ahead: Girth;
  readonly behind: Girth;
}

/** Intersect the closed hull with the plate's transverse plane, retaining the hull's outward normals. */
function sectionEdges(mesh: HullMesh, x: number): SectionEdge[] {
  const { vertices, indices } = mesh;
  const result: SectionEdge[] = [];
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const points = [indices[i]!, indices[i + 1]!, indices[i + 2]!].map((vert) => {
      const at = 3 * vert;
      return [vertices[at]!, vertices[at + 1]!, vertices[at + 2]!] as const;
    });
    const crosses: Point[] = [];
    for (let k = 0; k < 3; k++) {
      const p = points[k]!;
      const q = points[(k + 1) % 3]!;
      const [a, b] = p[0] < q[0] ? [p, q] : [q, p];
      if (a[0] < x && x <= b[0]) {
        const t = (x - a[0]) / (b[0] - a[0]);
        crosses.push([a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])]);
      }
    }
    if (crosses.length !== 2) continue;
    const [a, b] = crosses as [Point, Point];
    if (a[0] === b[0] && a[1] === b[1]) continue;
    const [p, q, r] = points as [Vec3, Vec3, Vec3];
    const u = q[0] - p[0];
    const v = r[0] - p[0];
    const ny = (q[2] - p[2]) * v - u * (r[2] - p[2]);
    const nz = u * (r[1] - p[1]) - (q[1] - p[1]) * v;
    const magnitude = hypot(ny, nz);
    if (magnitude > 0) result.push({ a, b, normal: [ny / magnitude, nz / magnitude] });
  }
  return result;
}

function nearestEdge(edges: readonly SectionEdge[], root: Vec3): { index: number; point: Point; gap: number } | null {
  let best: ReturnType<typeof nearestEdge> = null;
  for (let i = 0; i < edges.length; i++) {
    const { a, b } = edges[i]!;
    const dy = b[0] - a[0];
    const dz = b[1] - a[1];
    const t = Math.min(1, Math.max(0, ((root[1] - a[0]) * dy + (root[2] - a[1]) * dz) / (dy * dy + dz * dz)));
    const point: Point = t <= 0 ? a : t >= 1 ? b : [a[0] + t * dy, a[1] + t * dz];
    const gap = hypot(root[1] - point[0], root[2] - point[1]);
    if (!best || gap < best.gap) best = { point, gap, index: i };
  }
  return best;
}

function pointKey(point: Point): string {
  return `${point[0]}:${point[1]}`;
}

function walkGirth(
  edges: readonly SectionEdge[],
  adjacent: ReadonlyMap<string, readonly number[]>,
  attached: number,
  root: Point,
  into: 'a' | 'b',
  centre: Vec3,
  centreline: number,
): Girth {
  const visited = new Set<number>();
  const sections: GirthEdge[] = [];
  const side = Math.sign(root[1] - centreline);
  let start = root;
  let i = attached;
  let end = edges[i]![into];
  let distance = 0;
  while (!visited.has(i)) {
    visited.add(i);
    const segment = edges[i]!;
    const sideStart = side * (start[1] - centreline);
    const sideEnd = side * (end[1] - centreline);
    const crossesCentre = sideEnd <= 0;
    const finish: Point = crossesCentre
      ? [start[0] + ((end[0] - start[0]) * sideStart) / (sideStart - sideEnd), centreline]
      : end;
    const length = hypot(finish[0] - start[0], finish[1] - start[1]);
    if (length > 0) {
      sections.push({ a: start, b: finish, normal: segment.normal, distance, length });
      distance += length;
    }
    if (crossesCentre) break;
    const endKey = pointKey(end);
    const next = adjacent.get(endKey)?.find((candidate) => !visited.has(candidate));
    if (next === undefined) break;
    start = end;
    i = next;
    end = pointKey(edges[i]!.a) === endKey ? edges[i]!.b : edges[i]!.a;
  }
  const first = sections[0];
  const direction = first
    ? (-(root[1] - centre[2]) * (first.b[0] - first.a[0]) + (root[0] - centre[1]) * (first.b[1] - first.a[1])) /
      first.length
    : 0;
  return { edges: sections, direction };
}

/** The attached plate acts on the two girth directions of its own half-hull. */
export function bilgePressureSections(
  mesh: HullMesh,
  root: Vec3,
  length: number,
  centre: Vec3,
): readonly (BilgePressureSection | null)[] {
  const mounted = nearestEdge(sectionEdges(mesh, root[0]), root);
  const limit = 1e-8 * Math.max(1, length);
  if (!mounted || mounted.gap > limit) return [];
  const gauss = length / (2 * Math.sqrt(3));
  return [root[0] - gauss, root[0] + gauss].map((x) => {
    const edges = sectionEdges(mesh, x);
    const anchor = nearestEdge(edges, root);
    if (!anchor) return null;
    const adjacent = new Map<string, number[]>();
    let left = Infinity;
    let right = -Infinity;
    for (let i = 0; i < edges.length; i++) {
      for (const point of [edges[i]!.a, edges[i]!.b]) {
        left = Math.min(left, point[1]);
        right = Math.max(right, point[1]);
        const key = pointKey(point);
        const references = adjacent.get(key);
        if (references) references.push(i);
        else adjacent.set(key, [i]);
      }
    }
    const centreline = (left + right) / 2;
    if (Math.abs(anchor.point[1] - centreline) <= limit) return null;
    const first = walkGirth(edges, adjacent, anchor.index, anchor.point, 'a', centre, centreline);
    const second = walkGirth(edges, adjacent, anchor.index, anchor.point, 'b', centre, centreline);
    return first.direction >= second.direction
      ? { root: anchor.point, ahead: first, behind: second }
      : { root: anchor.point, ahead: second, behind: first };
  });
}

function wetGirth(girth: Girth, x: number, depthAt: (point: Vec3) => number): number {
  let wetLength = 0;
  for (const { a, b, distance, length } of girth.edges) {
    const depth = depthAt([x, b[0], b[1]]);
    if (depth <= 0) {
      const start = depthAt([x, a[0], a[1]]);
      return distance + (length * start) / (start - depth);
    }
    wetLength = distance + length;
  }
  return wetLength;
}

/** ITTC 2024, §3.2, eqs. 52–55, integrated along the hull contour instead of assuming a quarter-round bilge. */
export function bilgePressureMoment(
  section: BilgePressureSection,
  x: number,
  centre: Vec3,
  positiveRoll: boolean,
  suctionLength: number,
  drag: number,
  depthAt: (point: Vec3) => number,
): number {
  if (depthAt([x, section.root[0], section.root[1]]) <= 0) return 0;
  const front = positiveRoll ? section.ahead : section.behind;
  const rear = positiveRoll ? section.behind : section.ahead;
  const frontLength = wetGirth(front, x, depthAt);
  const rearLength = Math.min(suctionLength, wetGirth(rear, x, depthAt));
  const integrate = (girth: Girth, stop: number, pressure: number, falls: boolean) => {
    let total = 0;
    for (const { a, b, normal, distance, length } of girth.edges) {
      const wet = Math.min(length, stop - distance);
      if (wet <= 0) break;
      const arm = (p: Point) => (p[0] - centre[1]) * normal[1] - (p[1] - centre[2]) * normal[0];
      const from = arm(a);
      const to = from + (wet / length) * (arm(b) - from);
      const p0 = falls ? pressure * (1 - distance / stop) : pressure;
      const p1 = falls ? pressure * (1 - (distance + wet) / stop) : pressure;
      total += (wet / 6) * (from * (2 * p0 + p1) + to * (p0 + 2 * p1));
    }
    return total;
  };
  return integrate(front, frontLength, 1.2, true) + integrate(rear, rearLength, 1.2 - drag, false);
}
