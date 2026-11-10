import { rangeError as makeRangeError } from '../../shared/errors.js';
import { colormap, type ColormapName } from './colormaps.js';
import type { RasterAggregate } from './aggregate-types.js';
const rangeError = (message: string, anchor: string) =>
  Object.assign(makeRangeError(message, anchor), { code: 'out-of-range' });

/** Shading changes pixels, never bin counts, statistics or hover data. */
export interface AggregateShadeOptions {
  /** Default count. A category label selects that category's counts. */ readonly reduction?:
    | 'count'
    | 'sum'
    | 'mean'
    | 'min'
    | 'max'
    | 'first'
    | 'last';
  readonly category?: string;
  /** Default eq-hist, empirical CDF with tied values sharing one colour. */ readonly transform?:
    | 'linear'
    | 'log'
    | 'cbrt'
    | 'eq-hist';
  readonly colormap?: ColormapName;
  /** Physical scalar display range. Default nonempty finite extrema. */ readonly range?: readonly [number, number];
  /** Circular dilation radius 0..32, default 0. Highest original alpha wins. */ readonly spread?: number;
  /** Grow sparse marks until this occupied-neighbour fraction, default disabled. */ readonly density?: number;
}
/** Packed RGBA8, bottom row first. Empty bins stay transparent before spreading. */
export function shadeAggregate(result: RasterAggregate, options: AggregateShadeOptions = {}): Uint32Array {
  const reduction = options.reduction ?? 'count',
    transform = options.transform ?? 'eq-hist',
    radius = options.spread ?? 0;
  if (
    !['count', 'sum', 'mean', 'min', 'max', 'first', 'last'].includes(reduction) ||
    !['linear', 'log', 'cbrt', 'eq-hist'].includes(transform) ||
    !Number.isInteger(radius) ||
    radius < 0 ||
    radius > 32 ||
    (options.density !== undefined && (!(options.density > 0) || options.density > 1))
  )
    throw rangeError('Invalid raster shading reduction, transform, spread or density', 'sciviz');
  const category = options.category === undefined ? -1 : result.categories.indexOf(options.category);
  if (options.category !== undefined && category < 0) throw rangeError('Unknown raster shading category', 'sciviz');
  const values =
    category < 0
      ? result[reduction]
      : Float64Array.from(result.count, (_, b) => result.categoricalCount[b * result.categories.length + category]);
  const occupied = (b: number) =>
    Number.isFinite(values[b]) &&
    (category >= 0 ? values[b] > 0 : reduction === 'count' ? result.count[b] > 0 : result.valid[b] > 0);
  const order: number[] = [];
  let lo = Infinity,
    hi = -Infinity;
  for (let i = 0; i < values.length; i++)
    if (occupied(i)) {
      lo = Math.min(lo, values[i]);
      hi = Math.max(hi, values[i]);
      order.push(values[i]);
    }
  if (options.range) {
    [lo, hi] = options.range;
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo)
      throw rangeError('Shade range must be finite and ordered', 'sciviz');
  }
  const cdf = new Map<number, number>();
  if (transform === 'eq-hist') {
    order.sort((a, b) => a - b);
    for (let i = 0; i < order.length; ) {
      let j = i + 1;
      while (j < order.length && order[j] === order[i]) j++;
      cdf.set(order[i], order.length === j - i ? 1 : (i + j - 1) / (2 * (order.length - 1)));
      i = j;
    }
  }
  const map = colormap(options.colormap ?? 'ember'),
    pixels = new Uint32Array(values.length);
  for (let b = 0; b < values.length; b++)
    if (occupied(b)) {
      const span = hi - lo;
      let t =
        hi > lo
          ? Math.max(
              0,
              Math.min(
                1,
                Number.isFinite(span) ? (values[b] - lo) / span : (values[b] / 2 - lo / 2) / (hi / 2 - lo / 2),
              ),
            )
          : 1;
      if (transform === 'eq-hist') t = cdf.get(values[b])!;
      if (transform === 'log') t = Math.log1p(255 * t) / Math.log(256);
      if (transform === 'cbrt') t = Math.cbrt(t);
      const [r, g, blue] = map.sample(t);
      pixels[b] =
        (Math.round(r * 255) | (Math.round(g * 255) << 8) | (Math.round(blue * 255) << 16) | (255 << 24)) >>> 0;
    }
  let chosen = radius;
  if (options.density && radius) {
    let neighbours = 0,
      occupiedCount = 0;
    for (let b = 0; b < pixels.length; b++)
      if (pixels[b]) {
        occupiedCount++;
        const x = b % result.width,
          y = Math.floor(b / result.width);
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++)
            if (
              (dx || dy) &&
              x + dx >= 0 &&
              y + dy >= 0 &&
              x + dx < result.width &&
              y + dy < result.height &&
              pixels[b + dy * result.width + dx]
            )
              neighbours++;
      }
    if (occupiedCount && neighbours / (8 * occupiedCount) >= options.density) chosen = 0;
  }
  if (!chosen) return pixels;
  const spread = pixels.slice();
  for (let b = 0; b < pixels.length; b++)
    if (pixels[b]) {
      const x = b % result.width,
        y = Math.floor(b / result.width);
      for (let dy = -chosen; dy <= chosen; dy++)
        for (let dx = -chosen; dx <= chosen; dx++) {
          const xx = x + dx,
            yy = y + dy;
          if (
            dx * dx + dy * dy <= chosen * chosen &&
            xx >= 0 &&
            yy >= 0 &&
            xx < result.width &&
            yy < result.height &&
            !pixels[yy * result.width + xx]
          )
            spread[yy * result.width + xx] = pixels[b];
        }
    }
  return spread;
}
