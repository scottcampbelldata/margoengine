// Clean room: Snyder (1987), chapters 14, 15, 21, 31; Snyder and Voxland (1989), pp. 222-223.
import { rangeError } from '../../shared/errors.js';

/** Planar projections; longitude/latitude are always degrees, x/y use radius units. */
export type ClimateProjectionName =
  | 'lambert-conformal-conic'
  | 'albers'
  | 'polar-stereographic'
  | 'robinson'
  | 'mollweide'
  | 'plate'
  | 'mercator';
/** Snyder projection parameters. Input angles are degrees; false origins use radius units. */
export interface ClimateProjectionOptions {
  /** Default 6378137 metres. Use 1 for a unit sphere. */
  readonly radius?: number;
  /** Default WGS84 for conics/polar/mercator, zero for plate/Robinson/Mollweide. Set 0 for spherical formulas. */
  readonly flattening?: number;
  /** Default 0 degrees. Defines the dateline opposite the central meridian. */
  readonly centralMeridian?: number;
  /** Default 0 degrees, or 90 for polar stereographic; polar accepts only +/-90. */
  readonly latitudeOrigin?: number;
  /** Conics default [30,60]; polar default latitudeOrigin. One parallel gives a tangent cone. */
  readonly standardParallels?: readonly number[];
  /** Default 1. Polar scale at pole or Mercator equatorial scale; mutually exclusive with standardParallels. */
  readonly scaleFactor?: number;
  /** Default [0,0], in radius units. */
  readonly falseOrigin?: readonly [number, number];
}
/** Immutable forward/inverse transform with explicit singularity and domain handling. */
export interface ClimateProjection {
  readonly name: ClimateProjectionName;
  readonly centralMeridian: number;
  /** Returns undefined at a projection singularity. Invalid input throws. */
  forward(longitude: number, latitude: number): [number, number] | undefined;
  /** Returns undefined outside the map, never extrapolates an inverse. */
  inverse(x: number, y: number): [number, number] | undefined;
}
const rad = Math.PI / 180,
  half = Math.PI / 2;
const bad = (s: string) => rangeError(`Projection: ${s}`, 'sciviz');
/** Wraps to [centre-180,centre+180], preserving a supplied positive edge. */
export function wrapLongitude(longitude: number, centre = 0): number {
  if (!Number.isFinite(longitude) || !Number.isFinite(centre)) throw bad('longitude and centre must be finite');
  const d = longitude - centre;
  return Math.abs(d) <= 180 ? longitude : centre + ((((d + 180) % 360) + 360) % 360) - 180;
}
// Robinson's published defining table, not coefficients from another implementation.
const rx = [
  1, 0.9986, 0.9954, 0.99, 0.9822, 0.973, 0.96, 0.9427, 0.9216, 0.8962, 0.8679, 0.835, 0.7986, 0.7597, 0.7186, 0.6732,
  0.6213, 0.5722, 0.5322,
];
const ry = [
  0, 0.062, 0.124, 0.186, 0.248, 0.31, 0.372, 0.434, 0.4958, 0.5571, 0.6176, 0.6769, 0.7346, 0.7903, 0.8435, 0.8936,
  0.9394, 0.9761, 1,
];
// Shape-preserving cubic Hermite interpolation of the defining table. Slopes are harmonic means
// of like-signed secants, zero at an extremum. No fitted tables or rival code.
function table(values: readonly number[], degrees: number): number {
  const p = Math.abs(degrees) / 5,
    i = Math.min(17, Math.floor(p)),
    t = p - i;
  const slope = (k: number) => {
    if (k === 0) return values[1] - values[0];
    if (k === 18) return values[18] - values[17];
    const a = values[k] - values[k - 1],
      b = values[k + 1] - values[k];
    return a * b <= 0 ? 0 : (2 * a * b) / (a + b);
  };
  return (
    (2 * t ** 3 - 3 * t * t + 1) * values[i] +
    (t ** 3 - 2 * t * t + t) * slope(i) +
    (-2 * t ** 3 + 3 * t * t) * values[i + 1] +
    (t ** 3 - t * t) * slope(i + 1)
  );
}
function bisect(fn: (x: number) => number, goal: number, lo = -half, hi = half): number {
  for (let i = 0; i < 60; i++) {
    const m = (lo + hi) / 2;
    if (fn(m) < goal) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}
/** Creates a forward/inverse pair. Ellipsoidal conics, polar and Mercator; spherical world projections. */
export function climateProjection(
  name: ClimateProjectionName,
  options: ClimateProjectionOptions = {},
): ClimateProjection {
  if (
    ![
      'lambert-conformal-conic',
      'albers',
      'polar-stereographic',
      'robinson',
      'mollweide',
      'plate',
      'mercator',
    ].includes(name)
  )
    throw bad(`unknown name ${name}`);
  const a = options.radius ?? 6378137,
    f = options.flattening ?? (['plate', 'robinson', 'mollweide'].includes(name) ? 0 : 1 / 298.257223563),
    e = Math.sqrt(f * (2 - f)),
    lon0 = options.centralMeridian ?? 0,
    lat0 = options.latitudeOrigin ?? (name === 'polar-stereographic' ? 90 : 0),
    origin = options.falseOrigin ?? [0, 0],
    k = options.scaleFactor ?? 1;
  if (
    !(a > 0) ||
    !Number.isFinite(a) ||
    !(f >= 0 && f < 1) ||
    !Number.isFinite(lon0) ||
    !(lat0 >= -90 && lat0 <= 90) ||
    origin.length !== 2 ||
    !origin.every(Number.isFinite) ||
    !(k > 0) ||
    !Number.isFinite(k)
  )
    throw bad('invalid radius, flattening, origin or scale');
  if (f && ['plate', 'robinson', 'mollweide'].includes(name)) throw bad(`${name} is spherical; use flattening 0`);
  if (!['polar-stereographic', 'mercator'].includes(name) && options.scaleFactor !== undefined)
    throw bad('scaleFactor is only supported for polar stereographic and Mercator');
  const m = (p: number) => Math.cos(p) / Math.sqrt(1 - e * e * Math.sin(p) ** 2),
    t = (p: number) => Math.tan(Math.PI / 4 - p / 2) / ((1 - e * Math.sin(p)) / (1 + e * Math.sin(p))) ** (e / 2),
    q = (p: number) =>
      e
        ? (1 - e * e) *
          (Math.sin(p) / (1 - e * e * Math.sin(p) ** 2) -
            Math.log((1 - e * Math.sin(p)) / (1 + e * Math.sin(p))) / (2 * e))
        : 2 * Math.sin(p),
    fromT = (v: number) => (v === 0 ? half : bisect((p) => -t(p), -v));
  let forward: (l: number, p: number) => [number, number] | undefined,
    inverse: (x: number, y: number) => [number, number] | undefined;
  if (name === 'lambert-conformal-conic' || name === 'albers') {
    const parallels = options.standardParallels ?? [30, 60];
    if (parallels.length < 1 || parallels.length > 2 || parallels.some((p) => !Number.isFinite(p) || Math.abs(p) >= 90))
      throw bad('conic needs one or two standard parallels strictly inside the poles');
    const p1 = parallels[0] * rad,
      p2 = (parallels[1] ?? parallels[0]) * rad;
    const lambert = name === 'lambert-conformal-conic';
    const n =
      Math.abs(p1 - p2) < 1e-14
        ? Math.sin(p1)
        : lambert
          ? Math.log(m(p1) / m(p2)) / Math.log(t(p1) / t(p2))
          : (m(p1) ** 2 - m(p2) ** 2) / (q(p2) - q(p1));
    if (Math.abs(n) < 1e-14) throw bad('opposite standard parallels give a degenerate cone; choose plate or mercator');
    const c = lambert ? m(p1) / (n * t(p1) ** n) : m(p1) ** 2 + n * q(p1),
      rho = (p: number) =>
        lambert
          ? Math.abs(p - (n / Math.abs(n)) * half) < 1e-14
            ? 0
            : a * c * t(p) ** n
          : (a * Math.sqrt(Math.max(0, c - n * q(p)))) / n,
      r0 = rho(lat0 * rad),
      sign = Math.sign(n);
    if (!Number.isFinite(r0)) throw bad('latitudeOrigin is at the divergent pole');
    forward = (l, p) => {
      if (lambert && Math.abs(p + sign * half) < 1e-14) return undefined;
      const r = rho(p);
      return [r * Math.sin(n * l), r0 - r * Math.cos(n * l)];
    };
    inverse = (x, y) => {
      const r = sign * Math.hypot(x, r0 - y),
        theta = Math.atan2(sign * x, sign * (r0 - y));
      if (Math.abs(theta / n) > Math.PI + 1e-10) return undefined;
      if (lambert) return [theta / n, r === 0 ? sign * half : fromT((r / (a * c)) ** (1 / n))];
      const v = (c - ((r * n) / a) ** 2) / n,
        qp = q(half);
      if (Math.abs(v) > qp + 1e-12) return undefined;
      return [theta / n, bisect(q, Math.max(-qp, Math.min(qp, v)))];
    };
  } else if (name === 'polar-stereographic') {
    if (Math.abs(lat0) !== 90) throw bad('polar latitudeOrigin must be +90 or -90');
    if (options.scaleFactor !== undefined && options.standardParallels !== undefined)
      throw bad('choose standardParallels or scaleFactor');
    const sign = Math.sign(lat0),
      parallels = options.standardParallels ?? [lat0],
      p = parallels[0] * rad * sign;
    if (parallels.length !== 1 || !(p > 0 && p <= half))
      throw bad('polar standard parallel must be in the origin hemisphere');
    const c =
      Math.abs(p - half) < 1e-14 ? (2 * a * k) / Math.sqrt((1 + e) ** (1 + e) * (1 - e) ** (1 - e)) : (a * m(p)) / t(p);
    forward = (l, p) =>
      Math.abs(p + sign * half) < 1e-14
        ? undefined
        : [c * t(sign * p) * Math.sin(l), -sign * c * t(sign * p) * Math.cos(l)];
    inverse = (x, y) => [Math.atan2(x, -sign * y), sign * fromT(Math.hypot(x, y) / c)];
  } else if (name === 'robinson') {
    forward = (l, p) => [0.8487 * a * table(rx, p / rad) * l, 1.3523 * a * Math.sign(p) * table(ry, p / rad)];
    inverse = (x, y) => {
      const yy = Math.abs(y) / (1.3523 * a);
      if (yy > 1 + 1e-12) return undefined;
      const p = bisect((v) => table(ry, v / rad), Math.min(1, yy), 0, half),
        l = x / (0.8487 * a * table(rx, p / rad));
      return Math.abs(l) > Math.PI + 1e-10 ? undefined : [l, Math.sign(y) * p];
    };
  } else if (name === 'mollweide') {
    forward = (l, p) => {
      const theta = Math.abs(p) === half ? p : bisect((v) => 2 * v + Math.sin(2 * v), Math.PI * Math.sin(p));
      return [((2 * Math.SQRT2 * a) / Math.PI) * l * Math.cos(theta), Math.SQRT2 * a * Math.sin(theta)];
    };
    inverse = (x, y) => {
      if (Math.abs(y) > Math.SQRT2 * a * (1 + 1e-12)) return undefined;
      const th = Math.asin(Math.max(-1, Math.min(1, y / (Math.SQRT2 * a)))),
        cos = Math.cos(th),
        l = Math.abs(cos) < 1e-12 ? 0 : (x * Math.PI) / (2 * Math.SQRT2 * a * cos);
      if ((Math.abs(cos) < 1e-12 && Math.abs(x) > a * 1e-10) || Math.abs(l) > Math.PI + 1e-10) return undefined;
      return [l, Math.asin(Math.max(-1, Math.min(1, (2 * th + Math.sin(2 * th)) / Math.PI)))];
    };
  } else if (name === 'mercator') {
    const parallels = options.standardParallels;
    if (
      parallels &&
      (parallels.length !== 1 ||
        !Number.isFinite(parallels[0]) ||
        Math.abs(parallels[0]) >= 90 ||
        options.scaleFactor !== undefined)
    )
      throw bad('Mercator takes one standard parallel or scaleFactor');
    const scale = parallels ? m(parallels[0] * rad) : k;
    forward = (l, p) => (Math.abs(p) === half ? undefined : [a * scale * l, -a * scale * Math.log(t(p))]);
    inverse = (x, y) =>
      Math.abs(x) > a * scale * Math.PI * (1 + 1e-12)
        ? undefined
        : [x / (a * scale), fromT(Math.exp(-y / (a * scale)))];
  } else {
    forward = (l, p) => [a * l, a * (p - lat0 * rad)];
    inverse = (x, y) =>
      Math.abs(x) > a * Math.PI * (1 + 1e-12) || Math.abs(y / a + lat0 * rad) > half + 1e-12
        ? undefined
        : [x / a, y / a + lat0 * rad];
  }
  return Object.freeze({
    name,
    centralMeridian: lon0,
    forward(longitude: number, latitude: number) {
      if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(latitude) > 90)
        throw bad('needs finite longitude and latitude inside +/-90');
      const result = forward((wrapLongitude(longitude, lon0) - lon0) * rad, latitude * rad);
      return result?.every(Number.isFinite)
        ? ([result[0] + origin[0], result[1] + origin[1]] as [number, number])
        : undefined;
    },
    inverse(x: number, y: number) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw bad('inverse needs finite x and y');
      const result = inverse(x - origin[0], y - origin[1]);
      return result?.every(Number.isFinite)
        ? ([wrapLongitude(lon0 + result[0] / rad), result[1] / rad] as [number, number])
        : undefined;
    },
  });
}
