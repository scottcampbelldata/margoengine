import { hypot } from '@margoengine/math/pinned';
import { rotateVec } from '../math.js';
import type { HullMesh, Quat, Vec3 } from '../seakeeping/wetted.js';
import { atan2 } from '../space/angles.js';
import { type CapsuleDimensions, capsuleSilhouette } from './capsule.js';

type Point = readonly [number, number]; // Horizontal coordinate in the projection plane, then height.
type Moments = [number, number, number]; // Area, horizontal first moment, vertical first moment.
type Frame = readonly [Vec3, Vec3, Vec3];

export interface EmergedSilhouette {
  area: number;
  fullArea: number;
  /** Offset of the projected area centroid from the shape centre, in world axes. */
  offset: [number, number, number];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function turn(a: Point, b: Point, c: Point): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

/** Andrew (1979), https://doi.org/10.1016/0020-0190(79)90072-3. */
function convexHull(points: Point[]): Point[] {
  points.sort(([u1, y1], [u2, y2]) => u1 - u2 || y1 - y2);
  const chain = (rows: Point[]) => {
    const result: Point[] = [];
    for (const point of rows) {
      while (result.length > 1 && turn(result.at(-2)!, result.at(-1)!, point) <= 0) result.pop();
      result.push(point);
    }
    result.pop();
    return result;
  };
  return [...chain(points), ...chain(points.reverse())];
}

/** Clip a projected polygon against one waterline (Sutherland and Hodgman, 1974, doi:10.1145/360767.360802). */
function clip(points: Point[], level: number): Point[] {
  const cut: Point[] = [];
  let from = points.at(-1)!;
  for (const to of points) {
    if (from[1] >= level !== to[1] >= level) {
      const fraction = (level - from[1]) / (to[1] - from[1]);
      cut.push([from[0] + fraction * (to[0] - from[0]), level]);
    }
    if (to[1] >= level) cut.push(to);
    from = to;
  }
  return cut;
}

function polygonMoments(points: Point[]): Moments {
  let area = 0,
    u = 0,
    y = 0;
  const anchor = points[0];
  if (!anchor) return [0, 0, 0];
  for (let i = 1; i + 1 < points.length; i++) {
    const a = points[i]!,
      b = points[i + 1]!;
    const triangle = turn(anchor, a, b) / 2;
    area += triangle;
    u += (triangle * (anchor[0] + a[0] + b[0])) / 3;
    y += (triangle * (anchor[1] + a[1] + b[1])) / 3;
  }
  return [area, u, y];
}

interface Edge {
  readonly low: Point;
  readonly high: Point;
}

function uAt({ low, high }: Edge, y: number): number {
  return low[0] + ((y - low[1]) / (high[1] - low[1])) * (high[0] - low[0]);
}

/**
 * Vertical arrangement of projected convex polygons. Between vertex heights and edge crossings,
 * every interval endpoint is affine and its ordering is fixed. The covered intervals are
 * integrated once, preserving concavities and holes. The event search scans overlapping edge
 * height ranges and is O(E²) in the worst case. Boxes use the separate constant-size convex path.
 */
function unionMoments(polygons: readonly Point[][], level: number): { fullArea: number; emerged: Moments } {
  const heights: number[] = [level];
  const groups: Edge[][] = [];
  for (const polygon of polygons) {
    const edges: Edge[] = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i]!,
        b = polygon[(i + 1) % polygon.length]!;
      if (a[1] !== b[1]) edges.push(a[1] < b[1] ? { low: a, high: b } : { low: b, high: a });
      heights.push(a[1]);
    }
    groups.push(edges);
  }
  const edges = groups.flat().sort((a, b) => a.low[1] - b.low[1]);
  for (let i = 0; i < edges.length; i++) {
    const a = edges[i]!;
    for (let j = i + 1; j < edges.length && edges[j]!.low[1] < a.high[1]; j++) {
      const b = edges[j]!;
      const low = b.low[1],
        high = Math.min(a.high[1], b.high[1]);
      const first = uAt(a, low) - b.low[0],
        last = uAt(a, high) - uAt(b, high);
      if ((first < 0 && last > 0) || (first > 0 && last < 0))
        heights.push(low + (high - low) * (first / (first - last)));
    }
  }
  heights.sort((a, b) => a - b);
  let fullArea = 0;
  const emerged: Moments = [0, 0, 0];
  for (let i = 1; i < heights.length; i++) {
    const low = heights[i - 1]!,
      high = heights[i]!,
      span = high - low;
    const mid = low + span / 2;
    if (!(low < mid && mid < high)) continue;
    const intervals: { left: Edge; right: Edge; u: number; end: number }[] = [];
    for (const group of groups) {
      let left: Edge | undefined,
        right: Edge | undefined,
        u = Infinity,
        end = -Infinity;
      for (const edge of group) {
        if (edge.low[1] > mid || edge.high[1] < mid) continue;
        const x = uAt(edge, mid);
        if (x < u) {
          u = x;
          left = edge;
        }
        if (x > end) {
          end = x;
          right = edge;
        }
      }
      if (left && right && u < end) intervals.push({ left, right, u, end });
    }
    intervals.sort((a, b) => a.u - b.u || a.end - b.end);
    for (let k = 0; k < intervals.length; k++) {
      const left = intervals[k]!.left;
      let { right, end } = intervals[k]!;
      while (k + 1 < intervals.length && intervals[k + 1]!.u <= end) {
        const next = intervals[++k]!;
        if (next.end > end) {
          right = next.right;
          end = next.end;
        }
      }
      const leftLow = uAt(left, low),
        rightLow = uAt(right, low);
      const leftHigh = uAt(left, high),
        rightHigh = uAt(right, high);
      const lenLow = Math.max(0, rightLow - leftLow),
        lenHigh = Math.max(0, rightHigh - leftHigh);
      const area = (span * (lenLow + lenHigh)) / 2;
      fullArea += area;
      if (low < level) continue;
      const leftMid = uAt(left, mid),
        rightMid = uAt(right, mid);
      emerged[0] += area;
      emerged[1] +=
        (span *
          (lenLow * (leftLow + rightLow) +
            4 * (rightMid - leftMid) * (leftMid + rightMid) +
            lenHigh * (leftHigh + rightHigh))) /
        12;
      emerged[2] += area * low + (span * span * (lenLow + 2 * lenHigh)) / 6;
    }
  }
  return { fullArea, emerged };
}

function meshProjection(mesh: HullMesh, rotation: Quat, right: Vec3, up: Vec3): Point[] {
  const { vertices } = mesh;
  const points: Point[] = [];
  for (let i = 0; i < vertices.length; i += 3) {
    const p = rotateVec(rotation, [vertices[i]!, vertices[i + 1]!, vertices[i + 2]!]);
    points.push([dot(p, right), dot(p, up)]);
  }
  return points;
}

function meshProjectionMoments(mesh: HullMesh, rotation: Quat, right: Vec3, up: Vec3, level: number, box: boolean) {
  const points = meshProjection(mesh, rotation, right, up);
  if (box) {
    const boundary = convexHull(points);
    return { fullArea: polygonMoments(boundary)[0], emerged: polygonMoments(clip(boundary, level)) };
  }
  const polygons: Point[][] = [];
  const { indices } = mesh;
  for (let i = 0; i < indices.length; i += 3) {
    const a = points[indices[i]!]!,
      b = points[indices[i + 1]!]!,
      c = points[indices[i + 2]!]!;
    if (turn(a, b, c) !== 0) polygons.push([a, b, c]);
  }
  return unionMoments(polygons, level);
}

/** Full orthographic area of a closed mesh on a body-local principal axis, computed once. */
export function meshProjectedArea(mesh: HullMesh, axis: Vec3, right: Vec3): number {
  const up: Vec3 = [
    axis[1] * right[2] - axis[2] * right[1],
    axis[2] * right[0] - axis[0] * right[2],
    axis[0] * right[1] - axis[1] * right[0],
  ];
  return meshProjectionMoments(mesh, [0, 0, 0, 1], right, up, -Infinity, false).fullArea;
}

function ellipseSegment(axes: Vec3, frame: Frame, right: Vec3, level: number): { fullArea: number; emerged: Moments } {
  const u: Vec3 = [axes[0] * dot(frame[0], right), axes[1] * dot(frame[1], right), axes[2] * dot(frame[2], right)];
  const y: Vec3 = [axes[0] * frame[0][1], axes[1] * frame[1][1], axes[2] * frame[2][1]];
  const half = hypot(...y);
  const jacobian = hypot(u[1] * y[2] - u[2] * y[1], u[2] * y[0] - u[0] * y[2], u[0] * y[1] - u[1] * y[0]);
  const fullArea = Math.PI * jacobian;
  if (level >= half) return { fullArea, emerged: [0, 0, 0] };
  if (level <= -half) return { fullArea, emerged: [fullArea, 0, 0] };
  const cutoff = level / half;
  const radius = Math.sqrt((1 - cutoff) * (1 + cutoff));
  const angle = atan2(radius, cutoff);
  // angle - sin(angle) cos(angle), evaluated by its series at a vanishing cap.
  const angle2 = angle * angle;
  const segment =
    angle < 0.01 ? (2 / 3) * angle * angle2 * (1 + angle2 * (-1 / 5 + (2 / 105) * angle2)) : angle - cutoff * radius;
  const moment = (2 / 3) * jacobian * radius * radius * radius;
  return { fullArea, emerged: [jacobian * segment, (dot(u, y) / half) * moment, half * moment] };
}

/** Orthographic silhouette of the emerged solid against a local horizontal plane. */
export function projectedAboveWater(
  axes: Vec3,
  frameWorld: Frame,
  rotation: Quat,
  mesh: HullMesh | undefined,
  box: boolean,
  level: number,
  direction: Vec3,
  capsule?: CapsuleDimensions,
): EmergedSilhouette {
  const length = hypot(direction[0], direction[2]);
  const right: Vec3 = length > 0 ? [-direction[2] / length, 0, direction[0] / length] : [0, 0, 1];
  // A horizontal orthographic projection keeps world height, so clipping before or after projection is equivalent.
  const {
    fullArea,
    emerged: [area, u, y],
  } = mesh
    ? meshProjectionMoments(mesh, rotation, right, [0, 1, 0], level, box)
    : capsule
      ? capsuleSilhouette(
          capsule.radius,
          capsule.halfHeight * dot(frameWorld[1], right),
          capsule.halfHeight * frameWorld[1][1],
          level,
        )
      : ellipseSegment(axes, frameWorld, right, level);
  return { area, fullArea, offset: area > 0 ? [(right[0] * u) / area, y / area, (right[2] * u) / area] : [0, 0, 0] };
}
