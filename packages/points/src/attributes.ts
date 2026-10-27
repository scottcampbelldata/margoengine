// Colouring and measuring helpers for scanned point clouds: ASPRS classification colours, intensity and elevation
// ramps, 16-bit RGB to 8-bit, and distance / path / area / height measures between picked points. Plain data in,
// RGBA bytes out (pass them as `colors` with `colorComponents: 4`).

/** ASPRS standard point classes (LAS 1.4 R15, table 17), by class number. */
export const ASPRS_CLASSES: Readonly<Record<number, string>> = {
  0: 'Created, never classified',
  1: 'Unclassified',
  2: 'Ground',
  3: 'Low vegetation',
  4: 'Medium vegetation',
  5: 'High vegetation',
  6: 'Building',
  7: 'Low point (noise)',
  8: 'Model key-point',
  9: 'Water',
  10: 'Rail',
  11: 'Road surface',
  12: 'Overlap',
  13: 'Wire guard (shield)',
  14: 'Wire conductor (phase)',
  15: 'Transmission tower',
  16: 'Wire-structure connector (insulator)',
  17: 'Bridge deck',
  18: 'High noise',
};

/** Default classification colours (sRGB), by class; classes without one are grey. */
export const CLASSIFICATION_COLORS: Readonly<Record<number, readonly [number, number, number]>> = {
  0: [160, 160, 160],
  1: [200, 200, 200],
  2: [166, 118, 64],
  3: [140, 210, 90],
  4: [70, 170, 60],
  5: [20, 110, 40],
  6: [220, 80, 60],
  7: [255, 0, 255],
  8: [255, 220, 0],
  9: [50, 120, 230],
  10: [120, 80, 150],
  11: [90, 90, 100],
  12: [255, 160, 0],
  13: [240, 240, 120],
  14: [250, 250, 60],
  15: [180, 180, 240],
  16: [120, 220, 220],
  17: [150, 100, 70],
  18: [255, 40, 160],
};

/** Options of `classificationColors`. */
export interface ClassificationColorOptions {
  /** Colours per class (sRGB 0..255), merged over `CLASSIFICATION_COLORS`. */
  palette?: Readonly<Record<number, readonly [number, number, number]>>;
  /** Classes drawn with alpha 0 (pair with `alphaTest` on the material to hide them). Default none. */
  hidden?: readonly number[];
}

/** RGBA bytes per point from ASPRS classes. */
export function classificationColors(classes: ArrayLike<number>, options: ClassificationColorOptions = {}): Uint8Array {
  const palette = { ...CLASSIFICATION_COLORS, ...options.palette },
    hidden = new Set(options.hidden ?? []),
    out = new Uint8Array(classes.length * 4);
  for (let i = 0; i < classes.length; i++) {
    const c = palette[classes[i]] ?? [128, 128, 128];
    out[i * 4] = c[0];
    out[i * 4 + 1] = c[1];
    out[i * 4 + 2] = c[2];
    out[i * 4 + 3] = hidden.has(classes[i]) ? 0 : 255;
  }
  return out;
}

/** Options of `rampColors` (intensity, elevation or any scalar). */
export interface RampOptions {
  /** Value mapped to the start of the ramp. Default: the 1st percentile. */
  min?: number;
  /** Value mapped to the end. Default: the 99th percentile. */
  max?: number;
  /** Exponent on the normalised value (below 1 brightens dark scans). Default 1. */
  gamma?: number;
  /** Colour stops (sRGB 0..255) spread evenly. Default black to white. */
  stops?: readonly (readonly [number, number, number])[];
}

function percentile(values: ArrayLike<number>, p: number): number {
  const n = values.length;
  if (!n) return 0;
  // A sample of at most 65,536 values keeps this O(n) for huge clouds.
  const step = Math.max(1, Math.floor(n / 65536)),
    sample: number[] = [];
  for (let i = 0; i < n; i += step) if (Number.isFinite(values[i])) sample.push(values[i]);
  sample.sort((a, b) => a - b);
  return sample.length ? sample[Math.min(sample.length - 1, Math.floor(p * (sample.length - 1)))] : 0;
}

/** RGBA bytes per point from a scalar (intensity, height, an extra-bytes attribute) through a colour ramp. */
export function rampColors(values: ArrayLike<number>, options: RampOptions = {}): Uint8Array {
  const min = options.min ?? percentile(values, 0.01),
    max = options.max ?? percentile(values, 0.99),
    gamma = options.gamma ?? 1,
    stops = options.stops ?? [
      [0, 0, 0],
      [255, 255, 255],
    ];
  if (!(gamma > 0)) throw new RangeError('Invalid gamma; pass a number above 0');
  if (stops.length < 2) throw new RangeError('A ramp needs at least two stops');
  const range = max - min || 1,
    out = new Uint8Array(values.length * 4),
    last = stops.length - 1;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    let t = Number.isFinite(v) ? Math.min(1, Math.max(0, (v - min) / range)) : 0;
    t = t ** gamma;
    const f = t * last,
      k = Math.min(last - 1, Math.floor(f)),
      u = f - k,
      a = stops[k],
      b = stops[k + 1];
    out[i * 4] = Math.round(a[0] + (b[0] - a[0]) * u);
    out[i * 4 + 1] = Math.round(a[1] + (b[1] - a[1]) * u);
    out[i * 4 + 2] = Math.round(a[2] + (b[2] - a[2]) * u);
    out[i * 4 + 3] = Number.isFinite(v) ? 255 : 0;
  }
  return out;
}

/** A blue-cyan-green-yellow-red ramp for elevation. */
export const ELEVATION_STOPS: readonly (readonly [number, number, number])[] = [
  [40, 60, 200],
  [40, 200, 220],
  [60, 200, 80],
  [240, 220, 60],
  [220, 50, 40],
];

/**
 * RGBA bytes from 16-bit RGB (LAS, E57). Files that store 8-bit values in 16-bit fields (every value 255 or less) are
 * detected and kept as they are; otherwise the high byte is used.
 */
export function rgb16ToRgba8(rgb: ArrayLike<number>): Uint8Array {
  let max = 0;
  for (let i = 0; i < rgb.length; i++) if (rgb[i] > max) max = rgb[i];
  const shift = max > 255 ? 8 : 0,
    n = rgb.length / 3,
    out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = rgb[i * 3] >> shift;
    out[i * 4 + 1] = rgb[i * 3 + 1] >> shift;
    out[i * 4 + 2] = rgb[i * 3 + 2] >> shift;
    out[i * 4 + 3] = 255;
  }
  return out;
}

type P = ArrayLike<number>;
const sub = (a: P, b: P) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** Straight-line distance between two points. */
export function measurePointDistance(a: P, b: P): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Length of a path through the points in order (closed adds the last-to-first leg). */
export function measurePath(points: readonly P[], closed = false): number {
  let sum = 0;
  for (let i = 1; i < points.length; i++) sum += measurePointDistance(points[i - 1], points[i]);
  if (closed && points.length > 2) sum += measurePointDistance(points[points.length - 1], points[0]);
  return sum;
}

/** Area of a planar polygon through the points (Newell's normal; for a non-planar loop, its projected vector area). */
export function measureArea(points: readonly P[]): number {
  let x = 0,
    y = 0,
    z = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i],
      b = points[(i + 1) % points.length];
    x += (a[1] - b[1]) * (a[2] + b[2]);
    y += (a[2] - b[2]) * (a[0] + b[0]);
    z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return Math.hypot(x, y, z) / 2;
}

/** Height of b above a along `up` (default +y, the engine's up). */
export function measureHeight(a: P, b: P, up: P = [0, 1, 0]): number {
  const d = sub(b, a),
    l = Math.hypot(up[0], up[1], up[2]) || 1;
  return (d[0] * up[0] + d[1] * up[1] + d[2] * up[2]) / l;
}

/** Angle at b between the legs to a and c, in degrees. */
export function measureAngle(a: P, b: P, c: P): number {
  const u = sub(a, b),
    v = sub(c, b),
    lu = Math.hypot(u[0], u[1], u[2]),
    lv = Math.hypot(v[0], v[1], v[2]);
  if (!lu || !lv) return 0;
  const cos = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (lu * lv);
  return (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
}
