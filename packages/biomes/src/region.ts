// Region fields (spec 2.1): fields that need far-away data, on a coarse grid over the whole world (default 16 m), in
// integers. Tiles read them by bilinear upsampling, so tiles stay independent of each other.
// Sources: depression filling, Barnes, Lehman and Mulla, "Priority-Flood", Computers and Geosciences 2014 (a min-heap
// of outlet cells, ties by index); wind exposure, Winstral, Elder and Davis 2002 (Sx, the largest upwind slope angle
// within a search distance); exact Euclidean distance transform, Meijster, Roerdink and Hesselink 2000 (two separable
// passes in integer squared distances); orographic rain, the upslope-condensation model reviewed by Roe 2005 with
// downwind drift of the condensate and evaporation on descent (Roe and Baker 2006), approximating Smith and Barstad 2004.
import { type Climate, continentality } from './climate.js';
import { atan2, bilinear, clampInt, divFloor, divWide, idiv, imod, isqrt, ONE } from './fixed.js';

export { heightsOf } from './height.js';

/** Region fields of a world: grids of `nx` x `nz` corner samples `step` mm apart, from the world's minimum corner. */
export interface Region {
  readonly nx: number;
  readonly nz: number;
  /** Sample spacing in mm. */
  readonly step: number;
  /** Height, mm. */
  readonly height: Int32Array;
  /** Priority-Flood fill depth (filled surface minus height), mm. */
  readonly fill: Int32Array;
  /** Rainfall, mm per year. */
  readonly rain: Int32Array;
  /** Wind exposure, 0 (sheltered) .. 255 (exposed), 128 on flat ground. */
  readonly exposure: Int32Array;
  /** Distance to water, dm. */
  readonly water: Int32Array;
  /** Continentality 0..1, Q16. */
  readonly continentality: Int32Array;
}

/** Search distance of the wind exposure index, mm (Winstral et al. use about 300 m). */
const SX_DISTANCE = 300_000;
/** Mean downwind drift of condensate before it falls, mm. */
const DRIFT = 1_500_000;
/** Fetch over which depleted air recovers its moisture over land and over sea, mm. */
const LAND_FETCH = 50_000_000,
  SEA_FETCH = 5_000_000;
/** Rain enhancement per unit of airborne condensate, and the lee-side rain floor, Q16. */
const GAIN = 5 * ONE,
  FLOOR = ONE / 4;

/**
 * Builds the region fields from region heights (mm, `nx` x `nz` row-major, z rows), the climate and optional water
 * source cells (1 = water). Deterministic: every step is integer, and order-dependent steps have fixed orders.
 */
export function buildRegion(
  height: Int32Array,
  nx: number,
  nz: number,
  step: number,
  climate: Climate,
  water?: Uint8Array,
): Region {
  const n = nx * nz,
    sea = new Uint8Array(n);
  for (let i = 0; i < n; i++) sea[i] = height[i] < climate.sea ? 1 : 0;
  const fill = priorityFlood(height, nx, nz, sea),
    { rain, continent } = rainMarch(height, nx, nz, step, climate, sea),
    exposure = windExposure(height, nx, nz, step, climate),
    sources = new Uint8Array(n);
  for (let i = 0; i < n; i++) sources[i] = sea[i] | (water ? water[i] : 0);
  const d2 = distanceTransform(sources, nx, nz),
    dist = new Int32Array(n),
    stepDm = Math.floor(step / 100);
  for (let i = 0; i < n; i++) dist[i] = d2[i] < 0 ? 2147483647 : isqrt(d2[i] * stepDm * stepDm);
  return { nx, nz, step, height, fill, rain, exposure, water: dist, continentality: continent };
}

/** Priority-Flood depression filling: fill depth per cell (mm). Outlets are the border and the sea. */
export function priorityFlood(height: Int32Array, nx: number, nz: number, sea: Uint8Array): Int32Array {
  const n = nx * nz,
    filled = new Int32Array(n),
    done = new Uint8Array(n),
    heap = new Int32Array(n),
    key = new Float64Array(n); // filled height, an integer
  let size = 0;
  const less = (a: number, b: number) => key[a] < key[b] || (key[a] === key[b] && a < b);
  const push = (i: number, h: number) => {
    filled[i] = h;
    key[i] = h;
    done[i] = 1;
    let k = size++;
    while (k > 0) {
      const parent = (k - 1) >> 1;
      if (!less(i, heap[parent])) break;
      heap[k] = heap[parent];
      k = parent;
    }
    heap[k] = i;
  };
  const pop = () => {
    const top = heap[0],
      last = heap[--size];
    let k = 0;
    for (;;) {
      let child = 2 * k + 1;
      if (child >= size) break;
      if (child + 1 < size && less(heap[child + 1], heap[child])) child++;
      if (!less(heap[child], last)) break;
      heap[k] = heap[child];
      k = child;
    }
    heap[k] = last;
    return top;
  };
  for (let z = 0; z < nz; z++)
    for (let x = 0; x < nx; x++) {
      const i = z * nx + x;
      if (sea[i] || x === 0 || z === 0 || x === nx - 1 || z === nz - 1) push(i, height[i]);
    }
  while (size) {
    const c = pop(),
      cx = imod(c, nx),
      cz = idiv(c - cx, nx);
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx,
          z = cz + dz;
        if (x < 0 || z < 0 || x >= nx || z >= nz) continue;
        const i = z * nx + x;
        if (!done[i]) push(i, Math.max(height[i], filled[c]));
      }
  }
  for (let i = 0; i < n; i++) filled[i] -= height[i];
  return filled;
}

/**
 * Moisture marched along the wind (one sweep along its main axis, each cell reading the previous column or row by
 * linear interpolation): uplift condenses a share of the column moisture, the condensate drifts downwind before it
 * falls, descent evaporates it again, and the column recovers toward the base over a 50 km fetch (5 km over sea).
 * Also the over-land distance the air has travelled, turned into continentality.
 */
function rainMarch(height: Int32Array, nx: number, nz: number, step: number, climate: Climate, sea: Uint8Array) {
  const n = nx * nz,
    rain = new Int32Array(n),
    continent = new Int32Array(n),
    q = new Int32Array(n),
    pending = new Int32Array(n),
    land = new Float64Array(n),
    [wx, wz] = climate.wind,
    alongX = Math.abs(wx) >= Math.abs(wz),
    major = alongX ? wx : wz,
    minor = alongX ? wz : wx,
    dir = major >= 0 ? 1 : -1,
    // Cells of the minor axis moved per major step, Q16, |ratio| <= 1.
    ratio = divWide(minor * ONE, Math.abs(major)),
    minorStep = divFloor(step * ratio, ONE),
    length = isqrt(step * step + minorStep * minorStep),
    lines = alongX ? nx : nz,
    across = alongX ? nz : nx;
  const at = (line: number, k: number) => (alongX ? k * nx + line : line * nx + k);
  // Lagrangian look-back: the minor offset of the upwind sample, split into a cell and a Q16 fraction.
  const back = -ratio,
    shift = back >> 16,
    frac = back & 0xffff;
  for (let s = 0; s < lines; s++) {
    const line = dir > 0 ? s : lines - 1 - s,
      previous = line - dir;
    for (let k = 0; k < across; k++) {
      const i = at(line, k);
      let cq = ONE,
        cp = 0,
        cl = climate.inland,
        hUp = height[i];
      if (s > 0) {
        const k0 = clampInt(k + shift, 0, across - 1),
          k1 = clampInt(k + shift + 1, 0, across - 1),
          a = at(previous, k0),
          b = at(previous, k1),
          lerp = (u: number, v: number) => u + divFloor((v - u) * frac, ONE);
        cq = lerp(q[a], q[b]);
        cp = lerp(pending[a], pending[b]);
        cl = land[a] + Math.floor(((land[b] - land[a]) * frac) / ONE);
        hUp = lerp(height[a], height[b]);
      }
      const rise = height[i] - hUp; // mm over `length` mm
      if (rise > 0) {
        // Condensed share: shadow strength per 1,500 m of rise, at most half the column per step.
        const c = Math.min(cq >> 1, divFloor(divFloor(cq * climate.shadow, ONE) * rise, 1_500_000));
        cq -= c;
        cp += c;
      } else if (rise < 0) {
        // Descent warms the air: condensate evaporates back into the column (same rate as condensation).
        const e = Math.min(cp, divFloor(divFloor(cp * climate.shadow, ONE) * -rise, 1_500_000));
        cp -= e;
        cq += e;
      }
      const out = divFloor(cp * Math.min(length, DRIFT), DRIFT);
      cp -= out;
      // Recovery toward the base moisture.
      cq += divFloor((ONE - cq) * length, sea[i] ? SEA_FETCH : LAND_FETCH);
      cl = sea[i] ? 0 : cl + length;
      q[i] = cq;
      pending[i] = cp;
      land[i] = cl;
      const share = Math.max(FLOOR, cq + divFloor(GAIN * cp, ONE));
      rain[i] = divFloor(climate.rainfall * share, ONE);
    }
  }
  for (let i = 0; i < n; i++) continent[i] = continentalityOf(land[i]);
  return { rain, continent };
}

// Continentality from the over-land distance (m from mm); the climate module holds the formula.
const continentalityOf = (mm: number) => continentality(Math.floor(mm / 1000));

/**
 * Winstral's Sx exposure on the region grid: the largest upwind slope angle within 300 m, mapped to 0..255 (128 flat,
 * 4 units per degree; higher is more exposed).
 */
function windExposure(height: Int32Array, nx: number, nz: number, step: number, climate: Climate): Int32Array {
  const out = new Int32Array(nx * nz),
    steps = Math.max(1, divFloor(SX_DISTANCE, step)),
    [wx, wz] = climate.wind;
  for (let z = 0; z < nz; z++)
    for (let x = 0; x < nx; x++) {
      const h0 = height[z * nx + x];
      let bestRise = -1,
        bestRun = 0;
      for (let k = 1; k <= steps; k++) {
        // Upwind sample k cells back along the wind, in Q16 cell units.
        const h = bilinear(height, nx, nz, x * ONE - k * wx, z * ONE - k * wz),
          rise = h - h0,
          run = k * step;
        // Keep the largest rise / run without dividing: rise * bestRun > bestRise * run.
        if (bestRun === 0 || rise * bestRun > bestRise * run) {
          bestRise = rise;
          bestRun = run;
        }
      }
      // Sx in degrees, as a binary angle; 2^32 / 360 per degree.
      const angle = atan2(bestRise, bestRun),
        degrees4 = divFloor(angle * 4, 11930465); // 4 units per degree
      out[z * nx + x] = clampInt(128 - degrees4, 0, 255);
    }
  return out;
}

/**
 * Exact squared Euclidean distance (in cells^2) from every cell to the nearest source cell (Meijster et al. 2000), or
 * -1 everywhere when there is no source.
 */
export function distanceTransform(source: Uint8Array, nx: number, nz: number): Int32Array {
  const n = nx * nz,
    far = nx + nz,
    g = new Int32Array(n),
    out = new Int32Array(n);
  let any = false;
  // Phase 1: per column, distance to the nearest source in that column.
  for (let x = 0; x < nx; x++) {
    g[x] = source[x] ? 0 : far;
    any ||= !!source[x];
    for (let z = 1; z < nz; z++) {
      const i = z * nx + x;
      any ||= !!source[i];
      g[i] = source[i] ? 0 : g[i - nx] + 1;
    }
    for (let z = nz - 2; z >= 0; z--) {
      const i = z * nx + x;
      if (g[i + nx] < g[i]) g[i] = g[i + nx] + 1;
    }
  }
  if (!any) return out.fill(-1);
  // Phase 2: per row, the lower envelope of parabolas (x - u)^2 + g(u)^2.
  const s = new Int32Array(nx),
    t = new Int32Array(nx);
  for (let z = 0; z < nz; z++) {
    const row = z * nx,
      f = (x: number, u: number) => (x - u) * (x - u) + g[row + u] * g[row + u],
      sep = (u: number, v: number) =>
        divFloor(v * v - u * u + g[row + v] * g[row + v] - g[row + u] * g[row + u], 2 * (v - u));
    let q = 0;
    s[0] = 0;
    t[0] = 0;
    for (let u = 1; u < nx; u++) {
      while (q >= 0 && f(t[q], s[q]) > f(t[q], u)) q--;
      if (q < 0) {
        q = 0;
        s[0] = u;
      } else {
        const w = 1 + sep(s[q], u);
        if (w < nx) {
          q++;
          s[q] = u;
          t[q] = w;
        }
      }
    }
    for (let u = nx - 1; u >= 0; u--) {
      out[row + u] = f(u, s[q]);
      if (u === t[q]) q--;
    }
  }
  return out;
}
