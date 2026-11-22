// A stored height grid as a terrain height function (entry `@margoengine/terrain/height-grid`, GAP-FILM-GRIDHEIGHT).
// `heightfield`, `TerrainHeightmap` and `Terrain` take a function (x, z) => height; a surveyed grid (a USGS 3DEP or SRTM
// tile read from a GeoTIFF, a PNG heightmap decoded to numbers) is row-major numbers that need a ground size, a corner,
// a no-data rule and bilinear lookup between texels. Bilinear interpolation: W. Press, S. Teukolsky, W. Vetterling,
// B. Flannery, Numerical Recipes, 3rd ed., Cambridge University Press 2007, section 3.6 (interpolation in two or more
// dimensions). No-data semantics: GDAL raster data model, "NODATA" band value, https://gdal.org/user/raster_data_model.html
// (a sample equal to it is missing; NaN is missing too). Pixel registration: OGC GeoTIFF standard 1.1, OGC 19-008r4, GeoKey
// GTRasterTypeGeoKey (PixelIsArea or PixelIsPoint), https://docs.ogc.org/is/19-008r4/19-008r4.html. The nearest-valid
// fill is a multi-source breadth-first sweep over the eight neighbours (the sequential distance transform of A. Rosenfeld
// and J. Pfaltz, "Sequential operations in digital picture processing", Journal of the ACM 13(4), 1966). Our own code
// from those descriptions.
import type { HeightField } from '@margoengine/math';

/** How a missing sample (NaN, or equal to `noData`) is filled before the grid is read. */
export type GridFill = number | 'nearest' | 'min' | 'mean';

/** Options of {@link gridHeightField}. */
export interface GridHeightOptions {
  /** Texels across (x), an integer 2 to 65,536. */
  width: number;
  /** Texels down (z), an integer 2 to 65,536. */
  height: number;
  /**
   * Row-major heights, `width * height` numbers (a Float32Array from a float GeoTIFF, an Int16Array from SRTM or any
   * array of numbers). Row 0 is at the grid's minimum z (the north edge of a north-up raster when north is -z), column 0
   * at its minimum x. Read once and not kept: later changes to it do not reach the result.
   */
  heights: ArrayLike<number>;
  /** Real ground extent in world units along x and z, each above 0 to 100,000. */
  size: readonly [number, number];
  /** World x and z of the grid's minimum corner. Default centred on the origin (`-size / 2`). */
  origin?: readonly [number, number];
  /** Added to every height after `exaggeration`, in world units. Default 0. */
  base?: number;
  /** Vertical scale: world height = (sample * exaggeration) + base. Default 1. */
  exaggeration?: number;
  /** A sample value that means no data (GDAL_NODATA, for example -32768 or -999999). NaN always does. Default none. */
  noData?: number;
  /**
   * What stands in for a missing sample: a number (a world height, `exaggeration` and `base` do not touch it),
   * `'nearest'` (the valid texel fewest steps away over the eight neighbours, ties to the one met first in row-major
   * order), `'min'` or `'mean'` of the valid heights (world units). A grid with no valid sample needs a number. Default
   * `'nearest'`.
   */
  fill?: GridFill;
  /**
   * Where the samples sit. `'point'` (default, as `Terrain` and `TerrainQuery` read heights): texel (0, 0) is at the
   * minimum corner and the last texel at `origin + size`. `'area'` (a GeoTIFF with PixelIsArea): each texel covers a cell
   * of `size / (width, height)` and its sample sits at the cell's centre, so the grid reaches half a cell short of the box
   * and the edge heights hold beyond it.
   */
  registration?: 'point' | 'area';
  /** Reads row 0 at the maximum z instead of the minimum (a south-up grid). Default false. */
  flipRows?: boolean;
}

/** A height function with the grid's own limits; call it as `(x, z) => height` for `heightfield` or `TerrainHeightmap`. */
export interface GridHeightField extends HeightField {
  /** Lowest world height the grid gives (after `exaggeration`, `base` and the fill). */
  readonly min: number;
  /** Highest world height the grid gives. */
  readonly max: number;
  /** Minimum world x and z of the grid box. */
  readonly origin: readonly [number, number];
  /** World x and z extent of the grid box. */
  readonly size: readonly [number, number];
  /** How many samples were missing and filled. */
  readonly filled: number;
}

const LIMIT = 65536;

function finite(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(Math.fround(value)))
    throw new RangeError(`Invalid grid height field; ${what} must be a finite number.`);
  return value;
}

/**
 * Turns a stored height grid into a height function: bilinear between texels, clamped to the edge texels outside the
 * box, with the grid's real ground size, an optional vertical exaggeration and base, and a fill for missing samples.
 * @example
 * const ground = gridHeightField({ width: 3, height: 3, heights: [0, 1, 0, 1, 2, 1, 0, 1, 0], size: [200, 200] });
 * ground(0, 0); // 2, the middle texel
 * @throws RangeError for a grid size, a heights array of another length, a size, an origin, a base, an exaggeration or a
 * fill that is not valid, a non-finite height that is not missing, or a grid with no valid sample and no numeric fill.
 */
export function gridHeightField(options: GridHeightOptions): GridHeightField {
  const {
      width,
      height,
      heights,
      size,
      base = 0,
      exaggeration = 1,
      noData,
      fill = 'nearest',
      registration = 'point',
      flipRows = false,
    } = options,
    origin = options.origin ?? ([-size[0] / 2, -size[1] / 2] as const);
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 2 ||
    height < 2 ||
    width > LIMIT ||
    height > LIMIT
  )
    throw new RangeError('Invalid grid height field; width and height are integers from 2 to 65536.');
  if (!heights || typeof heights.length !== 'number' || heights.length !== width * height)
    throw new RangeError(`Invalid grid height field; heights needs ${width * height} numbers, got ${heights?.length}.`);
  if (!Array.isArray(size) && !ArrayBuffer.isView(size))
    throw new RangeError('Invalid grid height field; size is [x, z].');
  if (size.length !== 2 || !(size[0] > 0) || !(size[1] > 0) || size[0] > 100000 || size[1] > 100000)
    throw new RangeError('Invalid grid height field; size is [x, z], each above 0 to 100000.');
  if (origin.length !== 2) throw new RangeError('Invalid grid height field; origin is [x, z].');
  finite(origin[0], 'origin x');
  finite(origin[1], 'origin z');
  finite(base, 'base');
  finite(exaggeration, 'exaggeration');
  if (noData !== undefined && typeof noData !== 'number')
    throw new RangeError('Invalid grid height field; noData is a number.');
  if (registration !== 'point' && registration !== 'area')
    throw new RangeError("Invalid grid height field; registration is 'point' or 'area'.");
  if (typeof fill === 'number') finite(fill, 'fill');
  else if (fill !== 'nearest' && fill !== 'min' && fill !== 'mean')
    throw new RangeError("Invalid grid height field; fill is a number, 'nearest', 'min' or 'mean'.");

  // Heights in world units, flipped to row 0 at the minimum z; a missing sample is NaN until it is filled.
  const count = width * height,
    grid = new Float32Array(count),
    missing = new Uint8Array(count),
    // A float32 grid holds its no-data value as float32, so compare in float32.
    hole = noData === undefined || Number.isNaN(noData) ? NaN : Math.fround(noData);
  let valid = 0,
    sum = 0,
    low = Infinity;
  for (let row = 0; row < height; row++) {
    const target = (flipRows ? height - 1 - row : row) * width;
    for (let column = 0; column < width; column++) {
      const value = Number(heights[row * width + column]);
      if (Number.isNaN(value) || Math.fround(value) === hole) {
        grid[target + column] = NaN;
        missing[target + column] = 1;
        continue;
      }
      if (!Number.isFinite(value))
        throw new RangeError(
          'Invalid grid height field; a height is infinite; mark missing samples with NaN or noData.',
        );
      const world = value * exaggeration + base;
      if (!Number.isFinite(Math.fround(world)))
        throw new RangeError('Invalid grid height field; a height times exaggeration plus base is not finite.');
      grid[target + column] = world;
      valid++;
      sum += world;
      if (world < low) low = world;
    }
  }
  const holes = count - valid;
  if (holes) {
    let stand: number;
    if (typeof fill === 'number') stand = fill;
    else if (!valid) throw new RangeError('Invalid grid height field; no sample is valid, so fill must be a number.');
    else if (fill === 'min') stand = low;
    else if (fill === 'mean') stand = sum / valid;
    else stand = NaN;
    if (fill === 'nearest') nearest(grid, missing, width, height);
    else for (let i = 0; i < count; i++) if (missing[i]) grid[i] = stand;
  }
  let min = Infinity,
    max = -Infinity;
  for (let i = 0; i < count; i++) {
    const v = grid[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  // Texel coordinates: point registration spans width - 1 cells over the box, area registration width cells with the
  // samples at their centres.
  const area = registration === 'area',
    ox = origin[0],
    oz = origin[1],
    sx = (area ? width : width - 1) / size[0],
    sz = (area ? height : height - 1) / size[1],
    shift = area ? 0.5 : 0,
    last = [width - 1, height - 1];
  const read = (x: number, z: number): number => {
    // NaN in, NaN out: the caller's own check (heightfield) reports a non-finite height.
    const u = Math.min(Math.max((x - ox) * sx - shift, 0), last[0]),
      v = Math.min(Math.max((z - oz) * sz - shift, 0), last[1]),
      i = Math.min(Math.floor(u), width - 2),
      j = Math.min(Math.floor(v), height - 2),
      fx = u - i,
      fz = v - j,
      a = grid[j * width + i],
      b = grid[j * width + i + 1],
      c = grid[(j + 1) * width + i],
      d = grid[(j + 1) * width + i + 1];
    return (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz;
  };
  return Object.assign(read, {
    min,
    max,
    origin: [ox, oz] as const,
    size: [size[0], size[1]] as const,
    filled: holes,
  });
}

/** Writes into each missing texel the value of the nearest valid one (an eight-neighbour sweep, ties to the first found). */
function nearest(grid: Float32Array, missing: Uint8Array, width: number, height: number): void {
  const queue = new Uint32Array(width * height);
  let head = 0,
    tail = 0;
  for (let i = 0; i < missing.length; i++) if (!missing[i]) queue[tail++] = i;
  const pending = missing.slice();
  while (head < tail) {
    const at = queue[head++],
      x = at % width,
      z = (at - x) / width;
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx,
          nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= width || nz >= height) continue;
        const n = nz * width + nx;
        if (!pending[n]) continue;
        pending[n] = 0;
        grid[n] = grid[at];
        queue[tail++] = n;
      }
  }
}
