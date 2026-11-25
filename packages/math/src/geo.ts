// WGS84 geodesy: geodetic <-> ECEF, the local east-north-up frame, geodesics and orbit poses.
// Angles are RADIANS (longitude, latitude, bearing, heading, pitch); lengths are METRES; ECEF is the right-handed
// Earth-centred frame of EPSG:4978 (+Z north pole, +X through lon 0 / lat 0). Written from:
// - NIMA TR8350.2, "Department of Defense World Geodetic System 1984", 3rd ed. (2000): a, 1/f, the conversions.
// - B. R. Bowring, "Transformation from spatial to geographical coordinates", Survey Review 23 (181), 1976.
// - T. Vincenty, "Direct and inverse solutions of geodesics on the ellipsoid with application of nested equations",
//   Survey Review 23 (176), 1975, https://www.ngs.noaa.gov/PUBS_LIB/inverse.pdf
// - C. F. F. Karney, "Algorithms for geodesics", J. Geodesy 87, 2013, https://doi.org/10.1007/s00190-012-0578-z
//   (geodesics: see the notes above geodesicInverse).

/** WGS84 semi-major axis, metres. */
export const WGS84_A = 6378137;
/** WGS84 flattening. */
export const WGS84_F = 1 / 298.257223563;
/** WGS84 semi-minor axis, metres. */
export const WGS84_B = WGS84_A * (1 - WGS84_F);
const E2 = WGS84_F * (2 - WGS84_F),
  EP2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B);

/** Degrees to radians. */
export const degToRad = (degrees: number): number => (degrees * Math.PI) / 180;
/** Radians to degrees. */
export const radToDeg = (radians: number): number => (radians * 180) / Math.PI;

/** Geodetic coordinates: longitude and latitude in radians, height above the ellipsoid in metres. */
export interface Cartographic {
  longitude: number;
  latitude: number;
  height: number;
}

/** Geodetic (radians, metres) to ECEF metres. */
export function cartographicToEcef(longitude: number, latitude: number, height = 0): [number, number, number] {
  const sinLat = Math.sin(latitude),
    cosLat = Math.cos(latitude),
    n = WGS84_A / Math.sqrt(1 - E2 * sinLat * sinLat);
  return [
    (n + height) * cosLat * Math.cos(longitude),
    (n + height) * cosLat * Math.sin(longitude),
    (n * (1 - E2) + height) * sinLat,
  ];
}

/**
 * ECEF metres to geodetic. Bowring's closed form (1976) followed by two fixed-point refinements: sub-millimetre from
 * the centre of the earth to geostationary heights, and exact at the poles.
 */
export function ecefToCartographic(x: number, y: number, z: number): Cartographic {
  const p = Math.hypot(x, y),
    longitude = Math.atan2(y, x);
  if (p === 0 && z === 0) return { longitude: 0, latitude: 0, height: -WGS84_A };
  const theta = Math.atan2(z * WGS84_A, p * WGS84_B),
    st = Math.sin(theta),
    ct = Math.cos(theta);
  let latitude = Math.atan2(z + EP2 * WGS84_B * st * st * st, p - E2 * WGS84_A * ct * ct * ct);
  // Two fixed-point steps of tan(lat) = (z / p) / (1 - e2 N / (N + h)), in the stable p cos + z sin form for h.
  for (let i = 0; i < 2; i++) {
    const s = Math.sin(latitude),
      c = Math.cos(latitude),
      n = WGS84_A / Math.sqrt(1 - E2 * s * s),
      h = p * c + z * s - WGS84_A * Math.sqrt(1 - E2 * s * s);
    latitude = Math.atan2(z * (n + h), p * (n * (1 - E2) + h));
  }
  const s = Math.sin(latitude);
  return {
    longitude,
    latitude,
    height: p * Math.cos(latitude) + z * s - WGS84_A * Math.sqrt(1 - E2 * s * s),
  };
}

/** The ellipsoid's outward unit normal (geodetic up) at an ECEF point. */
export function geodeticNormal(x: number, y: number, z: number): [number, number, number] {
  const nx = x / (WGS84_A * WGS84_A),
    ny = y / (WGS84_A * WGS84_A),
    nz = z / (WGS84_B * WGS84_B),
    l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

/** The unit east, north and up vectors of the local tangent frame at a geodetic position, as ECEF directions. */
export interface EnuBasis {
  east: [number, number, number];
  north: [number, number, number];
  up: [number, number, number];
}

/** The east-north-up basis (ECEF components) at longitude and latitude in radians. East at a pole is +Y. */
export function enuBasis(longitude: number, latitude: number): EnuBasis {
  const so = Math.sin(longitude),
    co = Math.cos(longitude),
    sa = Math.sin(latitude),
    ca = Math.cos(latitude);
  return { east: [-so, co, 0], north: [-sa * co, -sa * so, ca], up: [ca * co, ca * so, sa] };
}

/** A local east-north-up offset in metres (x east, y north, z up) to an ECEF position, about `origin`. */
export function enuToEcef(origin: Cartographic, east: number, north: number, up: number): [number, number, number] {
  const o = cartographicToEcef(origin.longitude, origin.latitude, origin.height),
    b = enuBasis(origin.longitude, origin.latitude);
  return [0, 1, 2].map((i) => o[i]! + b.east[i]! * east + b.north[i]! * north + b.up[i]! * up) as [number, number, number];
}

/** An ECEF position to its east-north-up offset in metres about `origin`. */
export function ecefToEnu(origin: Cartographic, x: number, y: number, z: number): [number, number, number] {
  const o = cartographicToEcef(origin.longitude, origin.latitude, origin.height),
    b = enuBasis(origin.longitude, origin.latitude),
    d = [x - o[0], y - o[1], z - o[2]];
  const dot = (v: number[]) => v[0]! * d[0]! + v[1]! * d[1]! + v[2]! * d[2]!;
  return [dot(b.east), dot(b.north), dot(b.up)];
}

const wrapPi = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
const finite = (what: string, ...v: number[]) => {
  if (!v.every(Number.isFinite)) throw new RangeError(`${what} needs finite numbers; pass longitude, latitude and angles in radians and distances in metres`);
};

/** The result of {@link geodesicInverse}. Bearings are radians clockwise from north in [0, 2 PI). */
export interface GeodesicInverse {
  /** Shortest-path length on the ellipsoid surface, metres. */
  distance: number;
  /** Bearing at the start point. */
  initialBearing: number;
  /** Bearing at the end point (the direction of travel there). */
  finalBearing: number;
}

const TAU = 2 * Math.PI;
const norm2pi = (a: number) => ((a % TAU) + TAU) % TAU;

// Geodesics, after Karney 2013 ("Algorithms for geodesics"): a geodesic maps to a great circle on the auxiliary sphere
// (reduced latitude beta, arc length sigma from the node, longitude omega, equatorial azimuth alpha0), and
//   s / b  = I1(sigma) = int sqrt(1 + k2 sin^2 s) ds
//   lambda = omega - f sin(alpha0) I3(sigma),  I3 = int (2 - f) / (1 + (1 - f) sqrt(1 + k2 sin^2 s)) ds
// with k2 = e'^2 cos^2(alpha0). The paper evaluates these integrals as Fourier series; here they are Gauss-Legendre
// quadrature of the same integrands (smooth and periodic, so a 16-point rule per quarter turn is exact to double
// precision). The direct problem is Newton on sigma; the inverse problem is the paper's one-dimensional root find of
// lambda12(alpha1) = lon12 over [0, PI], after reducing the pair to lat1 <= 0, |lat1| >= |lat2|, lon12 >= 0
// (section 4) with the equatorial case as a special geodesic (lon12 <= PI (1 - f)). The root find keeps a bracket on
// alpha1 (parametrised as PI/2 - delta, so that near-equatorial geodesics keep full precision), so it converges for
// every pair, including near-antipodal ones, where Vincenty's iteration diverges.
const GL_N = 16;
const GL: { x: number[]; w: number[] } = /* @__PURE__ */ (() => {
  const x: number[] = [],
    w: number[] = [];
  for (let i = 0; i < GL_N; i++) {
    let z = Math.cos((Math.PI * (i + 0.75)) / (GL_N + 0.5)),
      dp = 1;
    for (let it = 0; it < 100; it++) {
      let p0 = 1,
        p1 = z;
      for (let k = 2; k <= GL_N; k++) [p0, p1] = [p1, ((2 * k - 1) * z * p1 - (k - 1) * p0) / k];
      dp = (GL_N * (z * p1 - p0)) / (z * z - 1);
      const dz = p1 / dp;
      z -= dz;
      if (Math.abs(dz) < 1e-16) break;
    }
    x.push(z);
    w.push(2 / ((1 - z * z) * dp * dp));
  }
  return { x, w };
})();
/** The integrals I1 and I3 over [a, b] in sigma (b may be below a). */
function integrate(k2: number, a: number, b: number): [number, number] {
  const panels = Math.max(1, Math.ceil(Math.abs(b - a) / (Math.PI / 2))),
    h = (b - a) / panels;
  let i1 = 0,
    i3 = 0;
  for (let p = 0; p < panels; p++) {
    const mid = a + (p + 0.5) * h;
    for (let i = 0; i < GL_N; i++) {
      const s = Math.sin(mid + 0.5 * h * GL.x[i]!),
        r = Math.sqrt(1 + k2 * s * s),
        w = 0.5 * h * GL.w[i]!;
      i1 += w * r;
      i3 += (w * (2 - WGS84_F)) / (1 + (1 - WGS84_F) * r);
    }
  }
  return [i1, i3];
}
/** Longitude omega on the auxiliary sphere, continuous in sigma (tan omega = sin(alpha0) tan sigma). */
function omega(sa0: number, sigma: number): number {
  const k = Math.round(sigma / TAU),
    s = sigma - TAU * k;
  return Math.atan2(sa0 * Math.sin(s), Math.cos(s)) + TAU * k;
}

/**
 * Shortest distance and bearings between two surface points, Karney (2013): converges for every pair, including nearly
 * antipodal points. Latitudes and longitudes in radians. Heights are ignored (the path lies on the ellipsoid).
 */
export function geodesicInverse(lon1: number, lat1: number, lon2: number, lat2: number): GeodesicInverse {
  finite('geodesicInverse', lon1, lat1, lon2, lat2);
  let lam = wrapPi(lon2 - lon1),
    p1 = lat1,
    p2 = lat2;
  const swap = Math.abs(p1) < Math.abs(p2);
  if (swap) ([p1, p2] = [p2, p1]), (lam = -lam); // the reversed geodesic runs the other way round the pole axis
  const latFlip = p1 > 0;
  if (latFlip) (p1 = -p1), (p2 = -p2);
  const lonFlip = lam < 0;
  if (lonFlip) lam = -lam;
  const f = WGS84_F,
    reduced = (p: number): [number, number] => {
      const s = (1 - f) * Math.sin(p),
        c = Math.cos(p),
        h = Math.hypot(s, c);
      return [s / h, Math.max(c / h, 1e-150)];
    },
    [sb1, cb1] = reduced(p1),
    [sb2, cb2] = reduced(p2);
  let s: number, a1: number, a2: number;
  if (p1 === 0 && lam <= Math.PI * (1 - f)) {
    (s = WGS84_A * lam), (a1 = a2 = Math.PI / 2);
  } else {
    // alpha1 = PI/2 - delta: sin a1 = cos delta, cos a1 = sin delta, so a tiny cos a1 keeps its relative precision.
    const at = (delta: number) => {
      const sa1 = Math.cos(delta),
        ca1 = Math.sin(delta),
        dd = cb1 < -sb1 ? (cb2 - cb1) * (cb1 + cb2) : (sb1 - sb2) * (sb1 + sb2),
        ca2 = Math.sqrt(Math.max(0, ca1 * ca1 * cb1 * cb1 + dd)) / cb2,
        sa0 = sa1 * cb1,
        ca0 = Math.hypot(ca1, sa1 * sb1),
        sigma1 = Math.atan2(sb1, ca1 * cb1),
        k2 = EP2 * ca0 * ca0;
      // sigma12 in [0, PI] from its sine and cosine, so rounding noise around zero cannot wrap it to 2 PI.
      const c1 = ca1 * cb1,
        c2 = ca2 * cb2,
        sigma2 = sigma1 + Math.atan2(Math.max(0, c1 * sb2 - sb1 * c2), c1 * c2 + sb1 * sb2),
        [i1, i3] = integrate(k2, sigma1, sigma2);
      return {
        s: WGS84_B * i1,
        lambda: omega(sa0, sigma2) - omega(sa0, sigma1) - f * sa0 * i3,
        sa1,
        ca1,
        sa2: sa0 / cb2,
        ca2,
      };
    };
    // delta = PI/2 is alpha1 = 0 (lambda12 = 0); delta = -PI/2 is alpha1 = PI (lambda12 = PI).
    let x0 = Math.PI / 2,
      x1 = -Math.PI / 2,
      f0 = -lam,
      f1 = Math.PI - lam,
      side = 0,
      x = f0 === 0 ? x0 : x1;
    if (f0 !== 0 && f1 !== 0) {
      for (let i = 0; i < 1500; i++) {
        x = (x0 * f1 - x1 * f0) / (f1 - f0);
        // Every third step bisects, so the bracket at least halves every three steps even where lambda12 has a kink.
        if (i % 3 === 2 || !(x > Math.min(x0, x1) && x < Math.max(x0, x1))) x = 0.5 * (x0 + x1);
        const fx = at(x).lambda - lam;
        if (Math.abs(fx) <= 2e-16 || Math.abs(x1 - x0) <= 1e-16 * (Math.abs(x0) + Math.abs(x1))) break;
        // Illinois regula falsi: keep the sign change bracketed, halving the retained end's value after a repeat.
        if (fx * f1 > 0) {
          (x1 = x), (f1 = fx);
          if (side === -1) f0 /= 2;
          side = -1;
        } else {
          (x0 = x), (f0 = fx);
          if (side === 1) f1 /= 2;
          side = 1;
        }
      }
    }
    const r = at(x);
    (s = r.s), (a1 = Math.atan2(r.sa1, r.ca1)), (a2 = Math.atan2(r.sa2, r.ca2));
  }
  if (lonFlip) (a1 = -a1), (a2 = -a2);
  if (latFlip) (a1 = Math.PI - a1), (a2 = Math.PI - a2);
  if (swap) [a1, a2] = [a2 + Math.PI, a1 + Math.PI];
  return { distance: s, initialBearing: norm2pi(a1), finalBearing: norm2pi(a2) };
}

/** The result of {@link geodesicDirect}: radians, longitude in (-PI, PI], bearing in [0, 2 PI). */
export interface GeodesicDirect {
  longitude: number;
  latitude: number;
  /** Bearing of travel at the end point. */
  finalBearing: number;
}

/** Follow a geodesic from a surface point for `distance` metres on `bearing` (clockwise from north), Karney 2013. */
export function geodesicDirect(lon1: number, lat1: number, bearing: number, distance: number): GeodesicDirect {
  finite('geodesicDirect', lon1, lat1, bearing, distance);
  const f = WGS84_F,
    sb = (1 - f) * Math.sin(lat1),
    cb = Math.cos(lat1),
    h = Math.hypot(sb, cb),
    sb1 = sb / h,
    cb1 = Math.max(cb / h, 1e-150),
    sa1 = Math.sin(bearing),
    ca1 = Math.cos(bearing),
    target = distance / WGS84_B,
    sa0 = sa1 * cb1,
    ca0 = Math.hypot(ca1, sa1 * sb1),
    sigma1 = Math.atan2(sb1, ca1 * cb1),
    k2 = EP2 * ca0 * ca0;
  // Newton on sigma2: I1(sigma2) - I1(sigma1) = s / b, with I1' = sqrt(1 + k2 sin^2 sigma).
  let sigma2 = sigma1 + target / (1 + k2 / 4);
  for (let i = 0; i < 50; i++) {
    const step = (integrate(k2, sigma1, sigma2)[0] - target) / Math.sqrt(1 + k2 * Math.sin(sigma2) ** 2);
    sigma2 -= step;
    if (Math.abs(step) <= 1e-16 * Math.max(1, Math.abs(sigma2))) break;
  }
  const i3 = integrate(k2, sigma1, sigma2)[1],
    sbeta2 = ca0 * Math.sin(sigma2),
    cbeta2 = Math.hypot(sa0, ca0 * Math.cos(sigma2)),
    lambda = omega(sa0, sigma2) - omega(sa0, sigma1) - f * sa0 * i3;
  return {
    longitude: wrapPi(lon1 + lambda),
    latitude: Math.atan2(sbeta2, (1 - f) * cbeta2),
    finalBearing: norm2pi(Math.atan2(sa0, ca0 * Math.cos(sigma2))),
  };
}


/** An ECEF camera pose looking at a geodetic target. */
export interface OrbitPose {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
}

/**
 * The camera pose that orbits a geodetic `centre` at `range` metres. `heading` is the compass direction the camera
 * looks toward (radians clockwise from north); `pitch` is how far below the local horizon it looks (0 horizontal,
 * PI/2 straight down). `up` is screen-up in ECEF: toward the sky, or toward the heading direction when looking down.
 */
export function orbitPose(centre: Cartographic, heading: number, pitch: number, range: number): OrbitPose {
  finite('orbitPose', centre.longitude, centre.latitude, centre.height, heading, pitch, range);
  const target = cartographicToEcef(centre.longitude, centre.latitude, centre.height),
    b = enuBasis(centre.longitude, centre.latitude),
    sh = Math.sin(heading),
    ch = Math.cos(heading),
    sp = Math.sin(pitch),
    cp = Math.cos(pitch),
    mix = (e: number, n: number, u: number) =>
      [0, 1, 2].map((i) => b.east[i]! * e + b.north[i]! * n + b.up[i]! * u) as [number, number, number],
    view = mix(sh * cp, ch * cp, -sp);
  return {
    target,
    position: [target[0] - view[0] * range, target[1] - view[1] * range, target[2] - view[2] * range],
    up: mix(sh * sp, ch * sp, cp),
  };
}
