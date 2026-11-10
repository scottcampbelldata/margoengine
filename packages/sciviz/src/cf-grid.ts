// CF 1.12 bilinear geometry, Jones (1999) spherical cell areas. No extrapolation across regional boundaries.
import { rangeError } from '../../shared/errors.js';
import type { CFGrid } from './cf.js';
import type { ClimateProjection } from './projections.js';
import { wrapLongitude } from './projections.js';
import { convertCFUnits } from './cf-units.js';
import type { Figure } from './figure.js';
import type { MeshLayer, MeshLayerOptions, TriangleSet } from './grids.js';
/** Structured-grid sampling and explicit mask interpolation policy. */
export interface CFSampleOptions {
  /** Default bilinear. Nearest still respects the structured grid's domain. */
  readonly method?: 'nearest' | 'bilinear';
  /** Default infer a complete longitude cycle for rectilinear grids, false for curvilinear. */
  readonly periodic?: boolean;
  /** Default strict: any positively weighted missing corner masks the result. */
  readonly missing?: 'strict' | 'renormalize';
}
/** A bounded regular plane of cells in an invertible geographic projection. */
export interface CFMapTarget {
  readonly projection: ClimateProjection;
  /** Cell-edge extent [westX,southY,eastX,northY] in projection radius units. */
  readonly extent: readonly [number, number, number, number];
  readonly width: number;
  readonly height: number;
}
/** Map sampling with an independent land-fraction grid and cancellation. */
export interface CFRegridOptions extends CFSampleOptions {
  /** Independent rectilinear or curvilinear land fraction grid. Units percent or 1. */
  readonly landMask?: CFGrid;
  /** Default land when landMask is given. */
  readonly keep?: 'land' | 'ocean';
  /** Fraction threshold in [0,1], default 0.5. Missing masks never count as ocean. */
  readonly landThreshold?: number;
  /** Default 4194304 target cells. */
  readonly maxCells?: number;
  readonly signal?: AbortSignal;
}
/** Regridded cell centres, geographic positions and values; NaN denotes missing or out of domain. */
export interface CFMapGrid {
  readonly values: Float64Array;
  readonly longitude: Float64Array;
  readonly latitude: Float64Array;
  readonly width: number;
  readonly height: number;
  readonly extent: readonly [number, number, number, number];
  readonly units: string;
}
const bad = (s: string) => rangeError(`CF regrid: ${s}`, 'sciviz');
function snapshot(input: CFGrid): CFGrid {
  const { nx, ny, curvilinear } = input;
  if (
    !Number.isSafeInteger(nx) ||
    !Number.isSafeInteger(ny) ||
    nx < 1 ||
    ny < 1 ||
    nx * ny > 16777216 ||
    input.values.length !== nx * ny ||
    input.longitude.length !== (curvilinear ? nx * ny : nx) ||
    input.latitude.length !== (curvilinear ? nx * ny : ny)
  )
    throw bad('grid shape mismatch or exceeds 16777216 source nodes');
  if (Array.from(input.values).some((v) => !Number.isFinite(v) && !Number.isNaN(v)))
    throw bad('values must be finite or NaN');
  if (Array.from(input.latitude).some((v) => Number.isFinite(v) && Math.abs(v) > 90))
    throw bad('latitude outside +/-90');
  return {
    ...input,
    values: Float64Array.from(input.values),
    longitude: Float64Array.from(input.longitude),
    latitude: Float64Array.from(input.latitude),
  };
}
function weights(values: Float64Array, ids: number[], w: number[], options: CFSampleOptions): number {
  if (options.method === 'nearest') {
    let best = 0;
    for (let k = 1; k < w.length; k++) if (w[k] > w[best]) best = k;
    return values[ids[best]];
  }
  let sum = 0,
    total = 0;
  for (let k = 0; k < w.length; k++)
    if (w[k] > 1e-14) {
      const v = values[ids[k]];
      if (Number.isNaN(v)) {
        if (options.missing !== 'renormalize') return NaN;
      } else {
        sum += w[k] * v;
        total += w[k];
      }
    }
  return total > 0 ? sum / total : NaN;
}
function axis(values: Float64Array, longitude: boolean): { values: number[]; order: number[] } {
  const unwrapped: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) throw bad('rectilinear coordinates must be finite');
    unwrapped.push(longitude && i ? unwrapped[i - 1] + wrapLongitude(values[i] - values[i - 1]) : values[i]);
  }
  const sign = unwrapped.length > 1 ? Math.sign(unwrapped[1] - unwrapped[0]) : 1;
  if (!sign || unwrapped.some((v, i) => i > 0 && (v - unwrapped[i - 1]) * sign <= 0))
    throw bad('axes must be strictly monotonic after dateline unwrapping');
  const order = Array.from(values, (_, i) => i);
  if (sign < 0) order.reverse();
  return { values: order.map((i) => unwrapped[i]), order };
}
function bracket(values: number[], v: number): [number, number, number] | undefined {
  const n = values.length;
  if (v < values[0] - 1e-10 || v > values[n - 1] + 1e-10) return undefined;
  if (n === 1) return [0, 0, 0];
  let lo = 0,
    hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (values[m] <= v) lo = m;
    else hi = m;
  }
  return [lo, hi, Math.max(0, Math.min(1, (v - values[lo]) / (values[hi] - values[lo])))];
}
type Cell = { ids: number[]; x: number[]; y: number[] };
/** Builds an owned sampler. Rectilinear lookup is binary; curvilinear lookup uses a 5 degree spatial index. */
export function cfSampler(
  input: CFGrid,
  options: CFSampleOptions = {},
): (longitude: number, latitude: number) => number {
  if (
    (options.method !== undefined && !['nearest', 'bilinear'].includes(options.method)) ||
    (options.missing !== undefined && !['strict', 'renormalize'].includes(options.missing))
  )
    throw bad('unknown sampling method or missing policy');
  const grid = snapshot(input),
    { nx, ny, values } = grid;
  let sample: (lon: number, lat: number) => number;
  if (!grid.curvilinear) {
    const x = axis(grid.longitude, true),
      y = axis(grid.latitude, false),
      span = x.values.at(-1)! - x.values[0],
      steps = x.values.slice(1).map((v, i) => v - x.values[i]),
      typical = steps.length ? steps.slice().sort((a, b) => a - b)[Math.floor(steps.length / 2)] : 0,
      periodic =
        options.periodic ??
        (span >= 360 - 1e-8 || (nx > 2 && Math.abs(span + typical - 360) < Math.max(1e-8, typical * 0.01)));
    if (span > 360 + 1e-8) throw bad('longitude axis spans more than one cycle');
    if (periodic && Math.abs(span - 360) < 1e-8) {
      for (let j = 0; j < ny; j++) {
        const a = values[j * nx + x.order[0]],
          b = values[j * nx + x.order.at(-1)!];
        if (!(a === b || (Number.isNaN(a) && Number.isNaN(b))))
          throw bad('duplicate longitude seam has inconsistent values');
      }
      x.values.pop();
      x.order.pop();
    }
    const last = x.values.length - 1;
    sample = (lon, lat) => {
      const yy = bracket(y.values, lat);
      if (!yy) return NaN;
      let v = wrapLongitude(lon, (x.values[0] + x.values[last]) / 2),
        xx: [number, number, number] | undefined;
      if (periodic) {
        v = ((((lon - x.values[0]) % 360) + 360) % 360) + x.values[0];
        xx =
          v > x.values[last]
            ? [last, 0, (v - x.values[last]) / (x.values[0] + 360 - x.values[last])]
            : bracket(x.values, v);
      } else xx = bracket(x.values, v);
      if (!xx) return NaN;
      const [i0, i1, u] = xx,
        [j0, j1, vv] = yy,
        ids = [
          y.order[j0] * nx + x.order[i0],
          y.order[j0] * nx + x.order[i1],
          y.order[j1] * nx + x.order[i0],
          y.order[j1] * nx + x.order[i1],
        ];
      return weights(values, ids, [(1 - u) * (1 - vv), u * (1 - vv), (1 - u) * vv, u * vv], options);
    };
  } else {
    const bins = new Map<number, Cell[]>(),
      periodic = options.periodic ?? false;
    if (nx < 2 || ny < 2) throw bad('curvilinear sampler needs at least 2x2 nodes');
    const width = periodic ? nx : nx - 1;
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < width; i++) {
        const ids = [j * nx + i, j * nx + ((i + 1) % nx), (j + 1) * nx + i, (j + 1) * nx + ((i + 1) % nx)],
          y = ids.map((k) => grid.latitude[k]),
          raw = ids.map((k) => grid.longitude[k]);
        if ([...y, ...raw].some((v) => !Number.isFinite(v))) continue;
        const x = raw.map((v) => wrapLongitude(v, wrapLongitude(raw[0]))),
          base = wrapLongitude(raw[0]);
        for (let k = 0; k < 4; k++) x[k] = base + wrapLongitude(raw[k] - raw[0]);
        if (Math.max(...x) - Math.min(...x) > 180) continue;
        // Reject folded/degenerate bilinear cells by the Jacobian at all four corners.
        const dx = x[1] - x[0],
          dy = y[1] - y[0],
          ex = x[2] - x[0],
          ey = y[2] - y[0],
          fx = x[3] - x[2] - x[1] + x[0],
          fy = y[3] - y[2] - y[1] + y[0],
          det = (u: number, v: number) => (dx + fx * v) * (ey + fy * u) - (ex + fx * u) * (dy + fy * v),
          signs = [det(0, 0), det(0, 1), det(1, 0), det(1, 1)];
        if (signs.some((v) => Math.abs(v) < 1e-14) || signs.some((v) => v * signs[0] <= 0)) continue;
        for (const shift of [-360, 0, 360]) {
          const xx = x.map((v) => v + shift),
            lo = Math.max(-180, Math.min(...xx)),
            hi = Math.min(180, Math.max(...xx));
          if (hi < lo) continue;
          const cell = { ids, x: xx, y };
          for (
            let bj = Math.max(0, Math.floor((Math.min(...y) + 90) / 5));
            bj <= Math.min(35, Math.floor((Math.max(...y) + 90) / 5));
            bj++
          )
            for (
              let bi = Math.max(0, Math.floor((lo + 180) / 5));
              bi <= Math.min(71, Math.floor((hi + 180) / 5));
              bi++
            ) {
              const key = bj * 72 + bi,
                list = bins.get(key) ?? [];
              list.push(cell);
              bins.set(key, list);
            }
        }
      }
    sample = (lon, lat) => {
      lon = wrapLongitude(lon);
      if (lon === 180) lon = -180;
      const list =
        bins.get(Math.min(35, Math.floor((lat + 90) / 5)) * 72 + Math.min(71, Math.floor((lon + 180) / 5))) ?? [];
      for (const { ids, x, y } of list) {
        const dx = x[1] - x[0],
          dy = y[1] - y[0],
          ex = x[2] - x[0],
          ey = y[2] - y[0],
          fx = x[3] - x[2] - x[1] + x[0],
          fy = y[3] - y[2] - y[1] + y[0];
        let u = 0.5,
          v = 0.5;
        for (let it = 0; it < 16; it++) {
          const rx = x[0] + u * dx + v * ex + u * v * fx - lon,
            ry = y[0] + u * dy + v * ey + u * v * fy - lat,
            ax = dx + v * fx,
            ay = dy + v * fy,
            bx = ex + u * fx,
            by = ey + u * fy,
            det = ax * by - ay * bx;
          if (Math.abs(det) < 1e-14) break;
          const du = (rx * by - ry * bx) / det,
            dv = (ax * ry - ay * rx) / det;
          u -= du;
          v -= dv;
          if (Math.max(Math.abs(du), Math.abs(dv)) < 1e-12) break;
        }
        const residual = Math.hypot(
          x[0] + u * dx + v * ex + u * v * fx - lon,
          y[0] + u * dy + v * ey + u * v * fy - lat,
        );
        if (u >= -1e-10 && u <= 1 + 1e-10 && v >= -1e-10 && v <= 1 + 1e-10 && residual < 1e-8) {
          u = Math.max(0, Math.min(1, u));
          v = Math.max(0, Math.min(1, v));
          return weights(values, ids, [(1 - u) * (1 - v), u * (1 - v), (1 - u) * v, u * v], options);
        }
      }
      return NaN;
    };
  }
  return (lon, lat) => {
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90)
      throw bad('sample needs finite geographic coordinates');
    return sample(lon, lat);
  };
}
/** Inverse-maps target cell centres. Outside-projection pixels, missing data and rejected land fractions stay NaN. */
export function regridCF(grid: CFGrid, target: CFMapTarget, options: CFRegridOptions = {}): CFMapGrid {
  options.signal?.throwIfAborted();
  const { width, height, extent } = target,
    max = options.maxCells ?? 4194304;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    !Number.isSafeInteger(max) ||
    max < 1 ||
    width * height > max ||
    extent.length !== 4 ||
    !extent.every(Number.isFinite) ||
    extent[2] <= extent[0] ||
    extent[3] <= extent[1]
  )
    throw bad('invalid target extent, dimensions or maxCells');
  if (options.keep !== undefined && !['land', 'ocean'].includes(options.keep)) throw bad('keep must be land or ocean');
  const threshold = options.landThreshold ?? 0.5;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw bad('landThreshold must be a fraction');
  const sample = cfSampler(grid, options),
    mask = options.landMask
      ? cfSampler(
          { ...options.landMask, values: convertCFUnits(options.landMask.values, options.landMask.units, '1') },
          { method: 'nearest' },
        )
      : undefined,
    values = new Float64Array(width * height).fill(NaN),
    longitude = new Float64Array(width * height).fill(NaN),
    latitude = new Float64Array(width * height).fill(NaN);
  for (let j = 0; j < height; j++) {
    options.signal?.throwIfAborted();
    for (let i = 0; i < width; i++) {
      const at = j * width + i,
        p = target.projection.inverse(
          extent[0] + ((i + 0.5) / width) * (extent[2] - extent[0]),
          extent[1] + ((j + 0.5) / height) * (extent[3] - extent[1]),
        );
      if (!p) continue;
      longitude[at] = p[0];
      latitude[at] = p[1];
      if (mask) {
        const fraction = mask(p[0], p[1]);
        if (
          !Number.isFinite(fraction) ||
          fraction < 0 ||
          fraction > 1 ||
          ((options.keep ?? 'land') === 'land' ? fraction < threshold : fraction >= threshold)
        )
          continue;
      }
      values[at] = sample(p[0], p[1]);
    }
  }
  return Object.freeze({
    values,
    longitude,
    latitude,
    width,
    height,
    extent: Object.freeze([...extent]) as CFMapGrid['extent'],
    units: grid.units,
  });
}
function cellBounds(axisValues: Float64Array, bounds: Float64Array | undefined, latitude: boolean): number[][] {
  if (bounds) {
    if (bounds.length !== axisValues.length * 2) throw bad('cell bounds length mismatch');
    return Array.from(axisValues, (_, i) => {
      let a = bounds[i * 2],
        b = bounds[i * 2 + 1];
      if (!latitude && Math.abs(b - a) < 360 - 1e-8) b = a + wrapLongitude(b - a);
      if (!Number.isFinite(a) || !Number.isFinite(b) || a === b || (latitude && (Math.abs(a) > 90 || Math.abs(b) > 90)))
        throw bad('invalid cell bounds');
      return [Math.min(a, b), Math.max(a, b)];
    });
  }
  if (axisValues.length < 2) throw bad('singleton axes need explicit cell bounds');
  const a = axis(axisValues, !latitude),
    edges = a.values.map((v, i) => (i === 0 ? v - (a.values[1] - v) / 2 : (v + a.values[i - 1]) / 2));
  edges.push(a.values.at(-1)! + (a.values.at(-1)! - a.values.at(-2)!) / 2);
  const out: number[][] = [];
  for (let i = 0; i < a.values.length; i++)
    out[a.order[i]] = [
      latitude ? Math.max(-90, edges[i]) : edges[i],
      latitude ? Math.min(90, edges[i + 1]) : edges[i + 1],
    ];
  return out;
}
/** First-order conservative spherical remap between rectilinear cell averages. Explicit CF bounds preferred.
 * Returns area coverage fractions; missing= strict masks any missing overlap, renormalize averages valid area.
 * No invented curvilinear cell bounds and no claim of conservation for the inverse-map display sampler.
 */
export function conservativeCF(
  source: CFGrid,
  target: Pick<CFGrid, 'longitude' | 'latitude' | 'longitudeBounds' | 'latitudeBounds'>,
  options: {
    readonly missing?: 'strict' | 'renormalize';
    readonly signal?: AbortSignal;
    readonly maxCells?: number;
  } = {},
): CFGrid & { readonly coverage: Float64Array } {
  options.signal?.throwIfAborted();
  const grid = snapshot(source);
  if (grid.curvilinear) throw bad('conservative remap requires rectilinear CF cell bounds');
  const nx = target.longitude.length,
    ny = target.latitude.length;
  if (!nx || !ny || nx * ny > (options.maxCells ?? 4194304)) throw bad('conservative target exceeds maxCells');
  const sx = cellBounds(grid.longitude, grid.longitudeBounds, false),
    sy = cellBounds(grid.latitude, grid.latitudeBounds, true),
    tx = cellBounds(target.longitude, target.longitudeBounds, false),
    ty = cellBounds(target.latitude, target.latitudeBounds, true),
    values = new Float64Array(nx * ny).fill(NaN),
    coverage = new Float64Array(nx * ny),
    r = Math.PI / 180;
  const overlap = (s: number[][], t: number[][], lon: boolean) =>
      t.map(([a, b]) => {
        const list: [number, number][] = [];
        for (let k = 0; k < s.length; k++) {
          let area = 0;
          if (lon) {
            const shift = Math.round((a + b - (s[k][0] + s[k][1])) / 720) * 360;
            for (const d of [shift - 360, shift, shift + 360])
              area += Math.max(0, Math.min(b, s[k][1] + d) - Math.max(a, s[k][0] + d)) * r;
          } else {
            const low = Math.max(a, s[k][0]),
              high = Math.min(b, s[k][1]);
            if (high > low) area = Math.sin(high * r) - Math.sin(low * r);
          }
          if (area > 0) list.push([k, area]);
        }
        return list;
      }),
    wx = overlap(sx, tx, true),
    wy = overlap(sy, ty, false);
  for (let j = 0; j < ny; j++) {
    options.signal?.throwIfAborted();
    for (let i = 0; i < nx; i++) {
      let sum = 0,
        valid = 0,
        total = 0,
        missing = false;
      for (const [sj, ay] of wy[j])
        for (const [si, ax] of wx[i]) {
          const area = ax * ay,
            v = grid.values[sj * grid.nx + si];
          total += area;
          if (Number.isFinite(v)) {
            sum += area * v;
            valid += area;
          } else missing = true;
        }
      const area = (tx[i][1] - tx[i][0]) * r * (Math.sin(ty[j][1] * r) - Math.sin(ty[j][0] * r));
      coverage[j * nx + i] = valid / area;
      if (total > area * (1 + 1e-10)) throw bad('overlapping source cells would double count area');
      if (valid > 0 && (!missing || options.missing === 'renormalize')) values[j * nx + i] = sum / valid;
    }
  }
  return Object.freeze({
    ...target,
    longitude: Float64Array.from(target.longitude),
    latitude: Float64Array.from(target.latitude),
    values,
    nx,
    ny,
    curvilinear: false,
    units: grid.units,
    coverage,
  });
}
/** Regrids and draws finite cells as a retained optional mesh. Works with both rendering backends and device restore. */
export async function cfMapLayer(
  figure: Figure,
  grid: CFGrid,
  target: CFMapTarget,
  options: CFRegridOptions & MeshLayerOptions = {},
): Promise<MeshLayer> {
  const map = regridCF(grid, target, options),
    positions: number[] = [],
    normals: number[] = [],
    values: number[] = [],
    cells: number[] = [],
    e = map.extent,
    dx = (e[2] - e[0]) / map.width,
    dy = (e[3] - e[1]) / map.height;
  for (let j = 0; j < map.height; j++)
    for (let i = 0; i < map.width; i++) {
      const at = j * map.width + i,
        v = map.values[at];
      if (!Number.isFinite(v)) continue;
      const x = e[0] + i * dx,
        y = e[1] + j * dy;
      for (const [u, w] of [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
        [1, 1],
        [0, 1],
      ]) {
        positions.push(x + u * dx, y + w * dy, 0);
        normals.push(0, 0, 1);
        values.push(v);
      }
      cells.push(at, at);
    }
  const set: TriangleSet = {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    values: new Float32Array(values),
    cells: new Uint32Array(cells),
    bounds: [e[0], e[2], e[1], e[3], 0, 0],
  };
  const { meshLayer } = await import('@margoengine/sciviz/grids');
  options.signal?.throwIfAborted();
  return meshLayer(figure, set, options);
}
