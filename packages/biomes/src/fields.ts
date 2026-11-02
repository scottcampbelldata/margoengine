// Tile fields (spec 2.1, 2.2): local fields from a 3x3 or bounded neighbourhood of one tile plus its apron, and the
// region fields upsampled. Integer arithmetic only, as functions of the global cell position, so a tile's cells do not
// depend on the tile size or the order tiles are made in.
// Sources: slope and aspect, Horn, "Hill shading and the reflectance map", Proc. IEEE 1981 (3x3 gradient); curvature,
// Zevenbergen and Thorne 1987 (3x3 quadratic fit: general, profile and plan); topographic position index, Guisan,
// Weiss and Weiss 1999; soil depth from soil production against transport, Heimsath et al. 1997 and Pelletier and
// Rasmussen 2009 (depth from the log of convexity, deep in hollows, thin on steep ground); climate in climate.ts.
import { typeError } from '../../shared/errors.js';
import {
  type Climate,
  degreeDays,
  evapotranspiration,
  halfAmplitude,
  heatLoadOf,
  moistureIndex,
  seasonMean,
  treelineMargin,
} from './climate.js';
import { atan2, clampInt, divFloor, isqrt, ONE, qexp2, qlog2 } from './fixed.js';
import type { RegionFields } from './gpu-region-fields.js';
import type { Heights } from './height.js';
import { LAYERS, type RasterLayer } from './layers.js';
import type { Region } from './region.js';
import type { Scratch } from './scratch.js';

/** The geometry a tile kernel needs. */
export interface TileFrame {
  readonly climate: Climate;
  readonly region: Region;
  readonly heights: Heights;
  /** Cell size, mm. */
  readonly cell: number;
  /** Working arrays reused from tile to tile (the world's); without it every array is fresh. */
  readonly scratch?: Scratch;
}

/** Radius of the topographic position box, mm (a 49 m box at 1 m). */
export const TPI_RADIUS = 24_000;
/** Cold-air pool depth scale, mm: pooling grows as 1 - exp(-depth / 30 m). */
const POOL_DEPTH = 30_000;
/** Monthly mean of a cosine year at its extreme: sin(pi / 12) / (pi / 12) in Q16. */
const MONTH = 64790;
/** log2 of the soil convexity scale 0.08 per metre, Q16. */
const LOG_CONVEX = qlog2(5243);

/** The season cache of cellClimate (made on first use): 4,096 (mean, half) keys and their three stored values. */
let seasonKeys: Float64Array | undefined, seasonValues: Int32Array;

const ARRAYS = { i32: Int32Array, i16: Int16Array, u16: Uint16Array, u8: Uint8Array, rgba8: Uint8Array } as const;

function raster(
  name: string,
  width: number,
  depth: number,
  scratch?: Scratch,
): RasterLayer & { data: Int32Array | Int16Array | Uint16Array | Uint8Array } {
  const info = LAYERS[name],
    Type = ARRAYS[info.format] as new (length: number) => Int32Array | Int16Array | Uint16Array | Uint8Array;
  return {
    name,
    format: info.format,
    width,
    depth,
    data: scratch ? scratch.take(name, Type, width * depth) : new Type(width * depth),
    scale: info.scale,
    unit: info.unit,
  };
}

/**
 * Computes the named layers over `width` x `depth` cells whose first cell is global cell (ox, oz): a tile, a tile with
 * a margin (classification blurs over one), or any part of one. Every layer here is a pure function of the global
 * cell, the heights and the region fields, so a cell holds the same bytes whatever rectangle it is made in. With the
 * frame's scratch, the layers not asked for and the working arrays are reused; `temporary` reuses the returned layers
 * too (valid until the next call: the caller copies what it keeps).
 * Async callers must keep `temporary` false so requested layers survive reuse of the frame's scratch.
 * @param raw Internal raw upsampled region samples in regionFieldsRef layout; omitted uses CPU interpolation.
 */
export function rectFields(
  frame: TileFrame,
  ox: number,
  oz: number,
  width: number,
  depth: number,
  names: readonly string[],
  temporary = false,
  raw?: RegionFields,
): Map<string, RasterLayer> {
  if (raw !== undefined)
    for (const name of ['rain', 'continentality', 'exposure', 'water', 'fill'] as const)
      if (!(raw?.[name] instanceof Int32Array) || raw[name].length !== width * depth)
        throw typeError(
          `Raw region ${name} must be an Int32Array of width * depth samples; supply the full plane`,
          'biomes',
        );
  const { climate, region, heights, cell, scratch } = frame,
    apron = Math.max(1, divFloor(TPI_RADIUS, cell)),
    side = width + 2 * apron,
    rows = depth + 2 * apron,
    h = heights.grid(ox - apron, oz - apron, side, rows, cell, scratch),
    want = new Set(names),
    out = new Map<string, RasterLayer>();
  const make = (name: string) => {
    const layer = raster(name, width, depth, temporary || !want.has(name) ? scratch : undefined);
    if (want.has(name)) out.set(name, layer);
    return layer.data;
  };
  const height = make('height'),
    slope = make('slope'),
    aspect = make('aspect'),
    curvature = make('curvature'),
    tpi = make('tpi'),
    temperature = make('temperature'),
    coldest = make('coldest'),
    warmest = make('warmest'),
    gdd5 = make('gdd5'),
    season = make('season'),
    treeline = make('treeline'),
    rainfall = make('rainfall'),
    alpha = make('alpha'),
    moisture = make('moisture'),
    exposure = make('exposure'),
    water = make('waterDistance'),
    soil = make('soil'),
    profile = want.has('profile') ? make('profile') : undefined,
    plan = want.has('plan') ? make('plan') : undefined;
  // Box sums of heights for the topographic position index (exact: below 2^53).
  const sat = scratch
    ? scratch.take('sat', Float64Array, (side + 1) * (rows + 1))
    : new Float64Array((side + 1) * (rows + 1));
  // Row 0 and column 0 are read as zeros and never written (a reused array may hold old sums there).
  sat.fill(0, 0, side + 1);
  for (let z = 0; z < rows; z++) {
    sat[(z + 1) * (side + 1)] = 0;
    let row = 0;
    for (let x = 0; x < side; x++) {
      row += h[z * side + x];
      sat[(z + 1) * (side + 1) + x + 1] = sat[z * (side + 1) + x + 1] + row;
    }
  }
  const box = (2 * apron + 1) * (2 * apron + 1),
    l2 = cell * cell,
    boxRadius = apron * cell,
    dd = [0, 0],
    c9 = new Int32Array(9),
    // Q16 region cells per tile cell: exact, the region step is a power-of-two multiple of the cell.
    toRegion = divFloor(cell * ONE, region.step),
    { nx, nz } = region,
    // Bilinear lookups of the region grids (region.ts `bilinear`), split per column and per row once per tile: every
    // grid shares the cell's corner index and Q16 fractions.
    colIndex = new Int32Array(width),
    colFrac = new Int32Array(width);
  for (let i = 0; i < width; i++) {
    const fx = clampInt((ox + i) * toRegion, 0, (nx - 1) * ONE),
      ix = Math.min(nx - 2, fx >> 16);
    colIndex[i] = ix;
    colFrac[i] = fx - ix * ONE;
  }
  const lerp = (grid: Int32Array, at: number, fx: number, fz: number) => {
    const a = grid[at] + Math.floor(((grid[at + 1] - grid[at]) * fx) / ONE),
      b = grid[at + nx] + Math.floor(((grid[at + nx + 1] - grid[at + nx]) * fx) / ONE);
    return a + Math.floor(((b - a) * fz) / ONE);
  };
  for (let j = 0; j < depth; j++) {
    const fz0 = clampInt((oz + j) * toRegion, 0, (nz - 1) * ONE),
      iz = Math.min(nz - 2, fz0 >> 16),
      fz = fz0 - iz * ONE;
    for (let i = 0; i < width; i++) {
      const k = j * width + i,
        g = (j + apron) * side + i + apron,
        e = h[g],
        a = h[g - side - 1],
        b = h[g - side],
        c = h[g - side + 1],
        d = h[g - 1],
        f = h[g + 1],
        gg = h[g + side - 1],
        hh = h[g + side],
        ii = h[g + side + 1];
      height[k] = e;
      // Horn: east (+x) and south (+z) gradients times 8 cells.
      const gx = c + 2 * f + ii - (a + 2 * d + gg),
        gz = gg + 2 * hh + ii - (a + 2 * b + c),
        s2 = Math.min(68719476736, gx * gx + gz * gz),
        root8 = isqrt(s2 * 65536), // floor(256 sqrt(s2)); floor(sqrt(s2)) is root8 >> 8
        tan = Math.min(32767, divFloor(root8, 8 * cell)); // Q8.8
      slope[k] = tan;
      // Downslope direction (-gx, -gz); north is -z, so its north component is gz.
      const angle = gx === 0 && gz === 0 ? 0 : atan2(-gx, gz);
      aspect[k] = angle >> 16;
      const sum = d + f + b + hh - 4 * e;
      curvature[k] = clampInt(divFloor(-sum * 10_000_000, l2), -32768, 32767);
      if (profile || plan) {
        const dn = d + f - 2 * e,
          en = b + hh - 2 * e,
          fn = c + gg - a - ii,
          gn = f - d,
          hn = b - hh,
          den = gn * gn + hn * hn;
        if (profile)
          profile[k] = den
            ? clampInt(
                divFloor(
                  -divFloor((2 * dn * gn * gn + 2 * en * hn * hn + fn * gn * hn) * 16, den) * 10_000_000,
                  32 * l2,
                ),
                -32768,
                32767,
              )
            : 0;
        if (plan)
          plan[k] = den
            ? clampInt(
                divFloor(
                  divFloor((2 * dn * hn * hn + 2 * en * gn * gn - fn * gn * hn) * 16, den) * 10_000_000,
                  32 * l2,
                ),
                -32768,
                32767,
              )
            : 0;
      }
      // Topographic position: height minus the box mean.
      const x0 = i,
        z0 = j,
        x1 = i + 2 * apron + 1,
        z1 = j + 2 * apron + 1,
        w = side + 1,
        total = sat[z1 * w + x1] - sat[z0 * w + x1] - sat[z1 * w + x0] + sat[z0 * w + x0],
        position = e - divFloor(total, box); // mm
      tpi[k] = clampInt(Math.floor(position / 100), -32768, 32767);
      // Region fields at this cell.
      const at = iz * nx + colIndex[i],
        fx = colFrac[i],
        rain = Math.max(0, raw ? raw.rain[k] : lerp(region.rain, at, fx, fz)),
        cont = clampInt(raw ? raw.continentality[k] : lerp(region.continentality, at, fx, fz), 0, ONE),
        expo = clampInt(raw ? raw.exposure[k] : lerp(region.exposure, at, fx, fz), 0, 255),
        dist = clampInt(raw ? raw.water[k] : lerp(region.water, at, fx, fz), 0, 65535),
        fill = Math.max(0, raw ? raw.fill[k] : lerp(region.fill, at, fx, fz));
      rainfall[k] = Math.min(65535, rain);
      exposure[k] = expo;
      water[k] = dist;
      cellClimate(climate, e, tan, gx, gz, position, boxRadius, rain, cont, expo, dist, fill, dd, c9, root8 >> 8);
      temperature[k] = c9[0];
      coldest[k] = c9[1];
      warmest[k] = c9[2];
      gdd5[k] = c9[3];
      season[k] = c9[4];
      treeline[k] = c9[5];
      alpha[k] = c9[6];
      moisture[k] = c9[7];
      soil[k] = c9[8];
    }
  }
  return out;
}

/**
 * The climate of one cell, written to `out` as stored layer values: mean, coldest and warmest month (cK), GDD5,
 * season days, treeline margin (cK), moisture index and soil moisture (u8), soil depth (cm). Inputs: height `e` (mm),
 * slope (Q8.8 tan), east and south gradients (any scale), topographic position (mm) over a box of `boxRadius` mm, and the region
 * values at the cell: rain (mm), continentality (Q16), exposure (0..255), water distance (dm), fill depth (mm).
 */
export function cellClimate(
  climate: Climate,
  e: number,
  tan: number,
  gx: number,
  gz: number,
  position: number,
  boxRadius: number,
  rain: number,
  cont: number,
  expo: number,
  dist: number,
  fill: number,
  dd: number[],
  out: Int32Array,
  root = isqrt(Math.min(68719476736, gx * gx + gz * gz)),
): Int32Array {
  // Temperature: sea-level mean, day and night lapse, heat load, cold-air pooling (spec 2.2).
  const above = Math.max(0, e - climate.sea),
    heat = heatLoadOf(climate, gx, gz, tan, root),
    range0 =
      700 +
      Math.floor((600 * cont) / ONE) +
      Math.floor((400 * (ONE - Math.min(ONE, Math.floor((rain * ONE) / 1500)))) / ONE);
  let pool = 0;
  if (climate.coldAir) {
    const depth = fill + Math.max(0, -position >> 1),
      fall = qexp2(-Math.min(15 * ONE, Math.floor((depth * 94548) / POOL_DEPTH))), // exp(-d / d0)
      vent = clampInt((expo - 128) * 2, 0, 255);
    pool = Math.floor((Math.floor((climate.coldAir * (ONE - fall)) / ONE) * (255 - vent)) / 255);
  }
  const tmax =
      climate.seaTemperature +
      (range0 >> 1) -
      Math.floor((above * climate.lapseDay) / 1_000_000) +
      Math.floor((heat * 150) / ONE),
    tmin =
      climate.seaTemperature -
      (range0 >> 1) -
      Math.floor((above * climate.lapseNight) / 1_000_000) +
      Math.floor((heat * 50) / ONE) -
      pool,
    mean = (tmax + tmin) >> 1,
    range = Math.max(100, tmax - tmin),
    half = halfAmplitude(climate, cont),
    monthly = Math.floor((half * MONTH) / ONE);
  out[0] = clampInt(mean, -32768, 32767);
  out[1] = clampInt(mean - monthly, -32768, 32767);
  out[2] = clampInt(mean + monthly, -32768, 32767);
  // GDD5, season and treeline depend on (mean, half) only, and a tile has few distinct pairs: a direct-mapped cache of
  // these pure functions (the result is the same with or without it).
  if (!seasonKeys) {
    seasonKeys = new Float64Array(4096).fill(Number.NaN);
    seasonValues = new Int32Array(3 * 4096);
  }
  const key = mean * 8192 + half, // half is 0..2,400 cK
    slot = (Math.imul(mean, -1640531535) ^ Math.imul(half, 40503)) >>> 20;
  if (seasonKeys[slot] === key) {
    out[3] = seasonValues[3 * slot];
    out[4] = seasonValues[3 * slot + 1];
    out[5] = seasonValues[3 * slot + 2];
  } else {
    out[3] = Math.min(65535, degreeDays(mean, half, 500, dd)[0]);
    degreeDays(mean, half, 90, dd);
    out[4] = dd[1];
    out[5] = clampInt(treelineMargin(seasonMean(dd[0], dd[1], 90), dd[1]), -32768, 32767);
    seasonKeys[slot] = key;
    seasonValues[3 * slot] = out[3];
    seasonValues[3 * slot + 1] = out[4];
    seasonValues[3 * slot + 2] = out[5];
  }
  // Moisture index from Hargreaves PET (sunnier slopes evaporate more) and Fu-Budyko.
  const pet = Math.floor(
      (evapotranspiration(climate, mean, half, range) * (ONE + Math.floor((heat * 19661) / ONE))) / ONE,
    ),
    index = moistureIndex(pet, rain);
  out[6] = (index * 255 + 32768) >> 16;
  // Soil moisture: 75 % moisture index, 15 % topographic wetness (hollows, gentle ground), 10 % near water.
  const wet = Math.floor(
      (clampInt(ONE / 2 - Math.floor((position * ONE) / 20_000), 0, ONE) * (ONE - (Math.min(256, tan) << 7))) / ONE,
    ),
    near = Math.max(0, ONE - Math.floor((dist * ONE) / 2000)),
    m = Math.floor((index * 49152 + wet * 9830 + near * 6554) / ONE);
  out[7] = (clampInt(m, 0, ONE) * 255 + 32768) >> 16;
  // Soil depth: 0.5 ln(0.08 / convexity) m with convexity 6 tpi / r^2, deep (2 m) in hollows, thinned above 35
  // degrees and gone at 45.
  const convex = divFloor(6 * position * 1000 * ONE, boxRadius * boxRadius);
  let depthCm = convex <= 0 ? 200 : clampInt(Math.floor(((LOG_CONVEX - qlog2(convex)) * 2271502) / 4294967296), 0, 200);
  if (tan > 179) depthCm = Math.floor((depthCm * Math.max(0, 256 - tan)) / 77);
  out[8] = clampInt(depthCm, 0, 255);
  return out;
}
