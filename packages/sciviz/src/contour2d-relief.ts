// Shaded relief with isolines for a gridded height field: a hypsometric tint, Horn's hillshade and anti-aliased contour
// lines (thicker index contours) baked into one RGBA8 image, and a matching terrain mesh with skirts. CPU only, so the
// picture is the same on WebGPU and the WebGL2 layer. Research and sources: docs/clean-room.md (G04).
import type { GeometryData } from '@margoengine/geometry';
import { SRGBToLinear, LinearToSRGB } from '@margoengine/math';
import { linearToOklab, oklabToLinear } from './oklab.js';
import type { ContourGrid2D } from './contour2d.js';
import { rangeError } from '../../shared/errors.js';

/** One hypsometric colour stop: a value and an encoded sRGB colour (`#rrggbb` or `[r, g, b]` 0 to 1). */
export interface ReliefStop {
  readonly at: number;
  readonly color: string | readonly [number, number, number];
}

/** Options of {@link reliefImage}. */
export interface ReliefImageOptions {
  /** Image width in pixels, 2..8192. Default 1024. */
  readonly width?: number;
  /** Image height in pixels, 2..8192. Default `width` scaled by the grid's aspect. */
  readonly height?: number;
  /** Hypsometric tint stops in ascending `at`, blended in OKLab; at least two. Default a green to sand to snow ramp over the data range. */
  readonly stops?: readonly ReliefStop[];
  /** Step the tint once per contour band instead of blending smoothly. Default false. */
  readonly stepped?: boolean;
  /** Contour spacing in data units; 0 or absent draws no lines. Default 0. */
  readonly interval?: number;
  /** The value one contour passes through. Default 0. */
  readonly base?: number;
  /** Every n-th contour from `base` is an index contour, drawn wider. Default 5; 0 for none. */
  readonly index?: number;
  /** Contour line width in pixels; index contours are 2.2 times as wide. Default 1.2. */
  readonly lineWidth?: number;
  /** Contour colour. Default '#25362f'. */
  readonly lineColor?: string | readonly [number, number, number];
  /** Contour opacity, 0..1. Default 0.6. */
  readonly lineOpacity?: number;
  /** Hillshade light: compass azimuth and altitude in degrees (Horn 1981). Default 315 and 45, the cartographic north-west light. */
  readonly light?: readonly [number, number];
  /** Vertical exaggeration of the hillshade (values per horizontal unit). Default 1. */
  readonly exaggeration?: number;
  /** How much the hillshade darkens, 0..1; 0 keeps the flat tint. Default 0.55. */
  readonly shade?: number;
  readonly signal?: AbortSignal;
}

/** An RGBA8 image in encoded sRGB, row 0 at the grid's first y; ready for a `{ data, width, height }` texture. */
export interface ReliefImage {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}

const DEFAULT_STOPS = ['#1f4a4c', '#457a72', '#93a97b', '#d9b073', '#fad9ac', '#fbf6ee'];

function color(c: string | readonly [number, number, number], name: string): [number, number, number] {
  const rgb = typeof c === 'string' && /^#[\da-f]{6}$/i.test(c)
    ? [1, 3, 5].map((k) => parseInt(c.slice(k, k + 2), 16) / 255)
    : Array.isArray(c) && c.length === 3 && c.every((v) => Number.isFinite(v) && v >= 0 && v <= 1) ? c : null;
  if (!rgb) throw rangeError(`${name} must be #rrggbb or [r, g, b] in 0 to 1`, 'sciviz');
  return [SRGBToLinear(rgb[0]), SRGBToLinear(rgb[1]), SRGBToLinear(rgb[2])];
}

function axisOf(a: ArrayLike<number>, name: string): Float64Array {
  if (!a || a.length < 2) throw rangeError(`Relief ${name} needs at least two coordinates`, 'sciviz');
  const out = Float64Array.from(a as ArrayLike<number>);
  const up = out[1] > out[0];
  for (let i = 1; i < out.length; i++)
    if (!Number.isFinite(out[i]) || (up ? !(out[i] > out[i - 1]) : !(out[i] < out[i - 1])))
      throw rangeError(`Relief ${name} must be finite and strictly ascending or descending`, 'sciviz');
  return out;
}

/** The grid's value at fractional sample indices (bilinear), NaN where a corner is masked. */
function bilinear(values: ArrayLike<number>, nx: number, ny: number, fx: number, fy: number): number {
  const i = Math.min(nx - 2, Math.max(0, Math.floor(fx))),
    j = Math.min(ny - 2, Math.max(0, Math.floor(fy))),
    u = Math.min(1, Math.max(0, fx - i)),
    v = Math.min(1, Math.max(0, fy - j));
  const k = j * nx + i;
  return (values[k] * (1 - u) + values[k + 1] * u) * (1 - v) + (values[k + nx] * (1 - u) + values[k + nx + 1] * u) * v;
}

/**
 * Bakes a shaded relief of `grid`: a hypsometric tint (stops blended in OKLab, or stepped per band), Horn's
 * hillshade from the 3 x 3 neighbourhood (Horn 1981), and contour lines every `interval` with wider index contours,
 * anti-aliased by each pixel's distance to the nearest level over the local gradient. The image spans the grid's
 * first to last coordinates. Masked (NaN) samples come out transparent.
 *
 * ```js
 * const grid = { x: [0, 1, 2], y: [0, 1, 2], values: [0, 1, 0, 1, 2, 1, 0, 1, 0] };
 * const image = reliefImage(grid, { width: 256, interval: 0.25 });
 * ```
 */
export function reliefImage(grid: ContourGrid2D, options: ReliefImageOptions = {}): ReliefImage {
  options.signal?.throwIfAborted();
  const xs = axisOf(grid?.x, 'x'), ys = axisOf(grid?.y, 'y'), nx = xs.length, ny = ys.length,
    values = grid.values;
  if (!values || values.length !== nx * ny) throw rangeError(`Relief values need ${nx * ny} samples, x fastest`, 'sciviz');
  const spanX = Math.abs(xs[nx - 1] - xs[0]), spanY = Math.abs(ys[ny - 1] - ys[0]);
  const width = options.width ?? 1024,
    height = options.height ?? Math.max(2, Math.round((width * spanY) / spanX));
  if (![width, height].every((n) => Number.isInteger(n) && n >= 2 && n <= 8192))
    throw rangeError('Relief width and height must be whole numbers from 2 to 8192', 'sciviz');
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < values.length; i++) if (values[i] === values[i]) (lo = Math.min(lo, values[i])), (hi = Math.max(hi, values[i]));
  if (!(hi >= lo)) throw rangeError('Relief values need at least one finite sample', 'sciviz');
  const stops = (options.stops ?? DEFAULT_STOPS.map((c, i) => ({ at: lo + ((hi - lo) * i) / (DEFAULT_STOPS.length - 1), color: c })))
    .map((s, i) => {
      if (!Number.isFinite(s?.at)) throw rangeError('Relief stops need a finite at', 'sciviz');
      const c = color(s.color, `Relief stop ${i}`);
      return { at: s.at, lab: linearToOklab(c[0], c[1], c[2]) };
    });
  if (stops.length < 2 || stops.some((s, i) => i && !(s.at > stops[i - 1].at)))
    throw rangeError('Relief stops need at least two, in strictly ascending at', 'sciviz');
  const interval = options.interval ?? 0, base = options.base ?? 0, index = options.index ?? 5,
    lineWidth = options.lineWidth ?? 1.2, lineOpacity = options.lineOpacity ?? 0.6,
    [azimuth, altitude] = options.light ?? [315, 45], exaggeration = options.exaggeration ?? 1,
    shade = options.shade ?? 0.55, line = color(options.lineColor ?? '#25362f', 'Relief lineColor');
  if (!(interval >= 0 && interval < Infinity) || !Number.isFinite(base) || !Number.isInteger(index) || index < 0 ||
    !(lineWidth > 0 && lineWidth <= 32) || !(lineOpacity >= 0 && lineOpacity <= 1) || !Number.isFinite(azimuth) ||
    !(altitude > 0 && altitude <= 90) || !(exaggeration > 0 && exaggeration < Infinity) || !(shade >= 0 && shade <= 1))
    throw rangeError('Relief options out of range: interval >= 0, whole index >= 0, lineWidth in (0, 32], lineOpacity and shade in [0, 1], altitude in (0, 90], positive exaggeration', 'sciviz');
  const stepped = options.stepped ?? false;
  // The height at every pixel centre, then the per-pixel colour from it and its neighbours.
  const field = new Float64Array(width * height);
  for (let py = 0; py < height; py++) {
    const fy = ((py + 0.5) / height) * (ny - 1) - 0.0;
    for (let px = 0; px < width; px++)
      field[py * width + px] = bilinear(values, nx, ny, ((px + 0.5) / width) * (nx - 1), fy);
  }
  options.signal?.throwIfAborted();
  const dx = spanX / width, dy = spanY / height,
    lightX = Math.sin((azimuth * Math.PI) / 180) * Math.cos((altitude * Math.PI) / 180),
    lightY = Math.cos((azimuth * Math.PI) / 180) * Math.cos((altitude * Math.PI) / 180),
    lightZ = Math.sin((altitude * Math.PI) / 180),
    flipX = xs[nx - 1] < xs[0] ? -1 : 1, flipY = ys[ny - 1] < ys[0] ? -1 : 1;
  const tint = (h: number): [number, number, number] => {
    let v = h;
    if (stepped && interval > 0) v = base + (Math.floor((h - base) / interval) + 0.5) * interval;
    if (v <= stops[0].at) return oklabToLinear(...stops[0].lab);
    for (let s = 1; s < stops.length; s++)
      if (v <= stops[s].at) {
        const f = (v - stops[s - 1].at) / (stops[s].at - stops[s - 1].at),
          a = stops[s - 1].lab, b = stops[s].lab;
        return oklabToLinear(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f);
      }
    return oklabToLinear(...stops[stops.length - 1].lab);
  };
  const data = new Uint8Array(width * height * 4);
  const at = (x: number, y: number, fallback: number) => {
    const v = field[Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))];
    return v === v ? v : fallback;
  };
  for (let py = 0; py < height; py++)
    for (let px = 0; px < width; px++) {
      const h = field[py * width + px], o = (py * width + px) * 4;
      if (h !== h) continue;
      // Horn 1981: weighted 3 x 3 differences.
      const z = (ix: number, iy: number) => at(px + ix, py + iy, h);
      const gx = ((z(1, -1) + 2 * z(1, 0) + z(1, 1)) - (z(-1, -1) + 2 * z(-1, 0) + z(-1, 1))) / (8 * dx) * flipX * exaggeration,
        gy = ((z(-1, 1) + 2 * z(0, 1) + z(1, 1)) - (z(-1, -1) + 2 * z(0, -1) + z(1, -1))) / (8 * dy) * flipY * exaggeration;
      // The unit normal (-gx, -gy, 1) / |.| against the light (sin A cos alt, cos A cos alt, sin alt), x east, y north.
      const lit = Math.max(0, (-gx * lightX - gy * lightY + lightZ) / Math.sqrt(1 + gx * gx + gy * gy));
      // Flat ground keeps its tint; slopes turned away darken by up to shade, slopes facing the light brighten a little.
      const ratio = lit / lightZ, light = 1 - shade + shade * (ratio > 1 ? 1 + 0.25 * (ratio - 1) : ratio);
      let rgb = tint(h).map((c) => Math.max(0, c) * light);
      if (interval > 0) {
        const t = (h - base) / interval, k = Math.round(t), distance = Math.abs(t - k);
        // Levels per pixel: the gradient of t in pixels, as a shader's fwidth.
        const perPixel = Math.max(1e-9, Math.abs(at(px + 1, py, h) - at(px - 1, py, h)) / 2 + Math.abs(at(px, py + 1, h) - at(px, py - 1, h)) / 2) / interval;
        const w = (index > 0 && k % index === 0 ? 2.2 : 1) * lineWidth;
        const cover = Math.min(1, Math.max(0, w / 2 + 0.5 - distance / perPixel)) * lineOpacity;
        rgb = rgb.map((c, i) => c * (1 - cover) + line[i] * cover);
      }
      data[o] = Math.round(LinearToSRGB(Math.min(1, rgb[0])) * 255);
      data[o + 1] = Math.round(LinearToSRGB(Math.min(1, rgb[1])) * 255);
      data[o + 2] = Math.round(LinearToSRGB(Math.min(1, rgb[2])) * 255);
      data[o + 3] = 255;
    }
  return { data, width, height };
}

/** Options of {@link reliefGeometry}. */
export interface ReliefGeometryOptions {
  /** World size along x and z of the grid's extent. Default the data spans. */
  readonly size?: readonly [number, number];
  /** World height of a data value: y = (value - offset) * scale. Default scale 1, offset 0. */
  readonly scale?: number;
  readonly offset?: number;
  /** Skirt walls down to this world y round the edge, for a solid block; undefined for none. */
  readonly skirt?: number;
  /** Grid samples per mesh vertex along each axis (a whole number of at least 1). Default 1, every sample. */
  readonly stride?: number;
}

/**
 * A terrain mesh of `grid`, centred on the origin with x along the grid's x and z along its y, smooth normals from
 * central differences, UVs from 0 to 1 matching {@link reliefImage} (v along y), and optional skirt walls whose UVs
 * repeat the edge. With a skirt the result has two groups, the top (material 0) and the skirt (material 1), so a
 * material array can paint the walls apart. Masked samples are set to the lowest finite value.
 *
 * ```js
 * const grid = { x: [0, 1, 2], y: [0, 1, 2], values: [0, 1, 0, 1, 2, 1, 0, 1, 0] };
 * const mesh = reliefGeometry(grid, { size: [4, 4], scale: 0.5, skirt: -0.3 });
 * ```
 */
export function reliefGeometry(grid: ContourGrid2D, options: ReliefGeometryOptions = {}): GeometryData {
  const xs = axisOf(grid?.x, 'x'), ys = axisOf(grid?.y, 'y'), values = grid.values,
    stride = options.stride ?? 1, scale = options.scale ?? 1, offset = options.offset ?? 0;
  if (!values || values.length !== xs.length * ys.length) throw rangeError('Relief values need nx * ny samples, x fastest', 'sciviz');
  if (!Number.isInteger(stride) || stride < 1 || !Number.isFinite(scale) || !Number.isFinite(offset) ||
    (options.skirt !== undefined && !Number.isFinite(options.skirt)))
    throw rangeError('Relief geometry needs a whole stride of at least 1 and finite scale, offset and skirt', 'sciviz');
  const [sx, sz] = options.size ?? [Math.abs(xs[xs.length - 1] - xs[0]), Math.abs(ys[ys.length - 1] - ys[0])];
  if (!(sx > 0 && sz > 0 && sx < Infinity && sz < Infinity)) throw rangeError('Relief size must be two positive numbers', 'sciviz');
  let low = Infinity;
  for (let i = 0; i < values.length; i++) if (values[i] === values[i]) low = Math.min(low, values[i]);
  const nx = Math.floor((xs.length - 1) / stride) + 1, nz = Math.floor((ys.length - 1) / stride) + 1;
  if (nx < 2 || nz < 2) throw rangeError('Relief stride leaves fewer than two samples per side', 'sciviz');
  const y = (i: number, j: number) => {
    const v = values[Math.min(ys.length - 1, j * stride) * xs.length + Math.min(xs.length - 1, i * stride)];
    return ((v === v ? v : low) - offset) * scale;
  };
  const skirt = options.skirt !== undefined, edge = skirt ? 2 * 2 * (nx + nz) : 0,
    count = nx * nz + edge, positions = new Float32Array(count * 3), normals = new Float32Array(count * 3),
    uvs = new Float32Array(count * 2), indices: number[] = [];
  const hx = sx / (nx - 1), hz = sz / (nz - 1);
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i,
        gx = (y(Math.min(nx - 1, i + 1), j) - y(Math.max(0, i - 1), j)) / ((Math.min(nx - 1, i + 1) - Math.max(0, i - 1)) * hx),
        gz = (y(i, Math.min(nz - 1, j + 1)) - y(i, Math.max(0, j - 1))) / ((Math.min(nz - 1, j + 1) - Math.max(0, j - 1)) * hz),
        l = Math.hypot(gx, 1, gz);
      positions.set([i * hx - sx / 2, y(i, j), j * hz - sz / 2], k * 3);
      normals.set([-gx / l, 1 / l, -gz / l], k * 3);
      uvs.set([i / (nx - 1), j / (nz - 1)], k * 2);
      if (i && j) indices.push(k - nx - 1, k - 1, k, k - nx - 1, k, k - nx);
    }
  const top = indices.length;
  if (skirt) {
    let next = nx * nz;
    const sides: [number[], readonly number[]][] = [
      [Array.from({ length: nx }, (_, i) => i), [0, 0, -1]],
      [Array.from({ length: nz }, (_, j) => j * nx + nx - 1), [1, 0, 0]],
      [Array.from({ length: nx }, (_, i) => nx * nz - 1 - i), [0, 0, 1]],
      [Array.from({ length: nz }, (_, j) => (nz - 1 - j) * nx), [-1, 0, 0]],
    ];
    for (const [ring, normal] of sides) {
      const first = next;
      for (const v of ring) {
        positions.set(positions.subarray(v * 3, v * 3 + 3), next * 3);
        positions.set([positions[v * 3], options.skirt!, positions[v * 3 + 2]], next * 3 + 3);
        normals.set(normal, next * 3);
        normals.set(normal, next * 3 + 3);
        uvs.set(uvs.subarray(v * 2, v * 2 + 2), next * 2);
        uvs.set(uvs.subarray(v * 2, v * 2 + 2), next * 2 + 2);
        next += 2;
      }
      for (let s = 1; s < ring.length; s++) {
        const a = first + (s - 1) * 2;
        indices.push(a, a + 2, a + 1, a + 2, a + 3, a + 1);
      }
    }
  }
  const data: GeometryData = { positions, normals, uvs, indices: Uint32Array.from(indices) };
  if (skirt) data.groups = [{ start: 0, count: top, materialIndex: 0 }, { start: top, count: indices.length - top, materialIndex: 1 }];
  return data;
}
