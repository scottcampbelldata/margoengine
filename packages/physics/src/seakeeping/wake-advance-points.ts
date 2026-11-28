import { MargoError } from '@margoengine/math/errors';
import { requireWakeHullMesh } from './wake-mesh.js';
import type { HullMesh } from './wetted.js';

type Point = readonly [number, number, number];
type Axis = 0 | 1 | 2;
type Moments = [area: number, x: number, y: number, z: number];
interface Bin {
  readonly xCell: number;
  readonly zCell: number;
  readonly sign: number;
  readonly moments: Moments;
}
/**
 * Options for building advance points: depth edges in metres below the reference plane, the horizontal bin size
 * for each depth interval and an optional upper bound on the node count.
 */
export interface WakeAdvancePointOptions {
  /** Increasing depth edges in metres below the reference plane, starting at zero and covering the draft. */
  readonly depths: readonly number[];
  /** Horizontal bin size in metres for each depth interval. */
  readonly panelSizes: readonly number[];
  /** Optional upper bound on the number of output nodes. */
  readonly maxRows?: number;
}

/**
 * Advance points of a hull: the reference waterline in hull-local metres and X, Z, depth and signed longitudinal
 * area quadruples.
 */
export interface WakeAdvancePoints {
  /** Reference hull-local Y in metres. */
  readonly waterline: number;
  /** Body X, Z, reference depth and signed longitudinal area, in consecutive f64 quadruples. */
  readonly nodes: Float64Array;
}

function cut(polygon: readonly Point[], axis: Axis, boundary: number, below: boolean): Point[] {
  // Assign an exactly aligned panel to one bin, using the same half-open bins as floor().
  const clipped: Point[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    const inside = below ? a[axis] < boundary : a[axis] >= boundary;
    if (inside) clipped.push(a);
    const nextInside = below ? b[axis] < boundary : b[axis] >= boundary;
    if (inside === nextInside) continue;
    const t = (boundary - a[axis]) / (b[axis] - a[axis]);
    const point: [number, number, number] = [
      a[0] + t * (b[0] - a[0]),
      a[1] + t * (b[1] - a[1]),
      a[2] + t * (b[2] - a[2]),
    ];
    point[axis] = boundary;
    clipped.push(point);
  }
  return clipped;
}

function areaX(a: Point, b: Point, c: Point): number {
  return ((b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1])) / 2;
}

function projectedMoments(polygon: readonly Point[]): Moments {
  const out: Moments = [0, 0, 0, 0];
  for (let i = 1; i + 1 < polygon.length; i++) {
    const a = polygon[0]!;
    const b = polygon[i]!;
    const c = polygon[i + 1]!;
    const area = areaX(a, b, c);
    out[0] += area;
    out[1] += (area * (a[0] + b[0] + c[0])) / 3;
    out[2] += (area * (a[1] + b[1] + c[1])) / 3;
    out[3] += (area * (a[2] + b[2] + c[2])) / 3;
  }
  return out;
}

function binRange(polygon: readonly Point[], axis: Axis, size: number): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of polygon) {
    lo = Math.min(lo, v[axis]);
    hi = Math.max(hi, v[axis]);
  }
  const a = Math.floor(lo / size);
  const b = Math.floor(hi / size);
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b))
    throw new MargoError('state', 'Use larger wake panel spacing or move the hull mesh closer to its local origin.');
  return [a, b];
}

/**
 * Bake a closed, outward-wound hull into signed advancing source points, using the actual panels below its
 * reference waterline. Within each horizontal bin and depth slice, each sign gets its own centroid.
 * Signed longitudinal area and all three first moments are retained. The source receiver's radius is set separately.
 * @throws MargoError `state` for invalid spacing, insufficient draft coverage or excess row count.
 */
export function bakeWakeAdvancePoints(
  mesh: HullMesh,
  waterline: number,
  options: WakeAdvancePointOptions,
): WakeAdvancePoints {
  const { depths, panelSizes, maxRows } = options ?? {};
  if (
    !Number.isFinite(waterline) ||
    !Array.isArray(depths) ||
    depths[0] !== 0 ||
    depths.length < 2 ||
    depths.some((depth, i) => !Number.isFinite(depth) || (i > 0 && depth <= depths[i - 1]!)) ||
    !Array.isArray(panelSizes) ||
    panelSizes.length !== depths.length - 1 ||
    panelSizes.some((size) => !Number.isFinite(size) || !(size > 0)) ||
    (maxRows !== undefined && (!Number.isSafeInteger(maxRows) || maxRows < 0))
  )
    throw new MargoError(
      'state',
      'Bake a finite reference waterline, increasing depth edges from zero, and one positive panel size per interval.',
    );
  const { vertices, indices } = requireWakeHullMesh(mesh);
  const point = (i: number): Point => [vertices[3 * i]!, vertices[3 * i + 1]!, vertices[3 * i + 2]!];
  let lowest = waterline;
  for (let i = 1; i < vertices.length; i += 3) lowest = Math.min(lowest, vertices[i]!);
  const draft = waterline - lowest;
  if (depths.at(-1)! < draft - 1e-10 * Math.max(1, draft))
    throw new MargoError('state', 'Add a deeper edge to the point wake bake so it covers the hull’s reference draft.');

  const triangles: (readonly [Point, Point, Point])[] = [];
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const triangle = [point(indices[i]!), point(indices[i + 1]!), point(indices[i + 2]!)] as const;
    if (areaX(...triangle) !== 0) triangles.push(triangle);
  }
  const rowLimit = Math.min(maxRows ?? Infinity, Math.floor(0xffffffff / (4 * Float64Array.BYTES_PER_ELEMENT)));
  const rows: number[] = [];
  for (let band = 0; band < depths.length - 1; band++) {
    const shallow = depths[band]!;
    const deep = depths[band + 1]!;
    const size = panelSizes[band]!;
    const bins = new Map<string, Bin>();
    for (const triangle of triangles) {
      const slice = cut(cut(triangle, 1, waterline - shallow, true), 1, waterline - deep, false);
      if (slice.length < 3) continue;
      const [firstX, lastX] = binRange(slice, 0, size);
      for (let i = firstX; i <= lastX; i++) {
        const strip = cut(cut(slice, 0, i * size, false), 0, (i + 1) * size, true);
        if (strip.length < 3) continue;
        const [firstZ, lastZ] = binRange(strip, 2, size);
        for (let j = firstZ; j <= lastZ; j++) {
          const patch = cut(cut(strip, 2, j * size, false), 2, (j + 1) * size, true);
          if (patch.length < 3) continue;
          const moments = projectedMoments(patch);
          const sign = Math.sign(moments[0]);
          if (sign === 0) continue;
          const key = `${i},${j},${sign}`;
          const previous = bins.get(key);
          if (previous) {
            for (let m = 0; m < 4; m++) previous.moments[m]! += moments[m]!;
          } else {
            if (rows.length / 4 + bins.size >= rowLimit)
              throw new MargoError(
                'state',
                'Increase the point wake panel size or its source row budget before baking.',
              );
            bins.set(key, { xCell: i, zCell: j, sign, moments });
          }
        }
      }
    }
    const ordered = [...bins.values()].sort((a, b) => a.xCell - b.xCell || a.zCell - b.zCell || a.sign - b.sign);
    for (const {
      moments: [area, x, y, z],
    } of ordered) {
      const depth = waterline - y / area;
      const centreX = x / area;
      const centreZ = z / area;
      if (![centreX, centreZ, depth, area].every(Number.isFinite))
        throw new MargoError('state', 'Use a bounded hull in metres so its point wake moments stay finite.');
      // Same-sign centroids lie in the slice. Keep roundoff at a boundary inside that slice.
      rows.push(centreX, centreZ, Math.max(shallow, Math.min(deep, depth)), area);
    }
  }
  return { waterline, nodes: Float64Array.from(rows) };
}
