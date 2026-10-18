// Face surfaces (ISO 10303-42 parameterizations): plane, cylinder, cone, sphere, torus, surface of revolution,
// surface of linear extrusion, B-spline (rational or not) and offset surface. Each evaluates point and first
// derivatives, inverts a point to its (u, v), and tells the tessellator its periods, its poles and how finely to sample.
import { Enum, type STEPFile, type STEPValue } from '../step/file.js';
import { angleStep, type Curve } from './curves.js';
import { clamped, knotVector, spanBreaks, surfaceAt, type SplineSurface } from './nurbs.js';
import { direction, frame, list, num, point, ref, unsupported, vector, type Frame } from './read.js';
import { add, cross, distance, dot, length, scale, sub, unit, type V3 } from './vec.js';

const TAU = 2 * Math.PI;
const wrap = (a: number) => (a < 0 ? a + TAU : a);

/** A parametric surface S(u, v). */
export interface Surface {
  /** Period in u and v (2 pi for angles, a closed B-spline's domain length), 0 when open. */
  readonly uPeriod: number;
  readonly vPeriod: number;
  /** Parameter domain (infinite for planes, and in v for cylinders and cones). */
  readonly uDomain: readonly [number, number];
  readonly vDomain: readonly [number, number];
  /** Point and first partial derivatives: [x, y, z, Su (3), Sv (3)]. */
  at(u: number, v: number): number[];
  /** Unit normal along Su x Sv, defined at poles and apexes too. */
  normal(u: number, v: number): V3;
  /** (u, v) of `p`, a point on or very near the surface; `hint` is a nearby (u, v). */
  parameters(p: readonly number[], hint?: readonly number[]): [number, number];
  /** Steps (du, dv) for interior points over the box [u0, u1, v0, v1]; Infinity where the surface is straight. */
  steps(box: readonly number[], deflection: number, turn: number): [number, number];
  /** v of the pole or apex on side +1 (high v) or -1 (low v), when the surface collapses to a point there. */
  pole(side: 1 | -1): number | undefined;
  /** u of a pole on side +1 (high u) or -1 (low u), where v has no meaning (a B-spline row collapsed at a u end). */
  uPole?(side: 1 | -1): number | undefined;
  /** Whether (u, v) is a pole or apex, where u has no meaning. */
  singular(u: number, v: number): boolean;
}

/** Su x Sv made unit; at a degenerate point, the normal a little way into the domain. */
function normalOf(s: Surface, u: number, v: number): V3 {
  const d = s.at(u, v),
    n = unit(cross(d.slice(3, 6), d.slice(6, 9)));
  if (n) return n;
  const [v0, v1] = s.vDomain,
    dv = Number.isFinite(v1 - v0) ? (v1 - v0) * 1e-4 : 1e-4,
    e = s.at(u, v + (v + dv <= v1 ? dv : -dv));
  return unit(cross(e.slice(3, 6), e.slice(6, 9))) ?? [0, 0, 1];
}

/** Radial and tangential unit vectors of angle u in a frame's xy plane. */
const radial = (f: Frame, u: number): [V3, V3] => {
  const c = Math.cos(u),
    s = Math.sin(u);
  return [
    [c * f.x[0] + s * f.y[0], c * f.x[1] + s * f.y[1], c * f.x[2] + s * f.y[2]],
    [-s * f.x[0] + c * f.y[0], -s * f.x[1] + c * f.y[1], -s * f.x[2] + c * f.y[2]],
  ];
};
/** Angle of p about a frame's z axis, in [0, 2 pi), and its local coordinates. */
const local = (f: Frame, p: readonly number[]) => {
  const d = sub(p, f.origin),
    x = dot(d, f.x),
    y = dot(d, f.y),
    z = dot(d, f.z);
  return { u: wrap(Math.atan2(y, x)), x, y, z, r: Math.hypot(x, y) };
};

class Plane implements Surface {
  readonly uPeriod = 0;
  readonly vPeriod = 0;
  readonly uDomain = [-Infinity, Infinity] as const;
  readonly vDomain = [-Infinity, Infinity] as const;
  constructor(private readonly f: Frame) {}
  at(u: number, v: number) {
    const { origin: o, x, y } = this.f;
    return [o[0] + u * x[0] + v * y[0], o[1] + u * x[1] + v * y[1], o[2] + u * x[2] + v * y[2], ...x, ...y];
  }
  normal() {
    return this.f.z;
  }
  parameters(p: readonly number[]): [number, number] {
    const d = sub(p, this.f.origin);
    return [dot(d, this.f.x), dot(d, this.f.y)];
  }
  steps(): [number, number] {
    return [Infinity, Infinity];
  }
  pole() {
    return undefined;
  }
  singular() {
    return false;
  }
}

/** Cylinder (cone with zero half angle) and cone: S = C + (R + v tan a)(cos u x + sin u y) + v z. */
class Cone implements Surface {
  readonly uPeriod = TAU;
  readonly vPeriod = 0;
  readonly uDomain = [0, TAU] as const;
  readonly vDomain = [-Infinity, Infinity] as const;
  private readonly tan: number;
  constructor(
    private readonly f: Frame,
    private readonly radius: number,
    halfAngle: number,
  ) {
    this.tan = Math.tan(halfAngle);
  }
  private rho(v: number) {
    return this.radius + v * this.tan;
  }
  at(u: number, v: number) {
    const [e, t] = radial(this.f, u),
      r = this.rho(v),
      z = this.f.z,
      o = this.f.origin;
    return [
      o[0] + r * e[0] + v * z[0],
      o[1] + r * e[1] + v * z[1],
      o[2] + r * e[2] + v * z[2],
      ...scale(t, r),
      ...add(scale(e, this.tan), z),
    ];
  }
  normal(u: number, v: number) {
    // Su x Sv = rho (e - tan z): defined at the apex too.
    const [e] = radial(this.f, u),
      n = unit(sub(e, scale(this.f.z, this.tan)))!;
    return this.rho(v) < 0 ? scale(n, -1) : n;
  }
  parameters(p: readonly number[], hint?: readonly number[]): [number, number] {
    const l = local(this.f, p);
    return [l.r > 0 ? l.u : (hint?.[0] ?? 0), l.z];
  }
  steps(box: readonly number[], deflection: number, turn: number): [number, number] {
    const r = Math.max(Math.abs(this.rho(box[2])), Math.abs(this.rho(box[3])));
    return [angleStep(r, deflection, turn), Infinity];
  }
  pole(side: 1 | -1) {
    if (!this.tan) return undefined;
    const apex = -this.radius / this.tan;
    return side * this.tan * Math.sign(this.radius || 1) < 0 ? apex : undefined;
  }
  singular(_u: number, v: number) {
    // Exported apex vertices sit within a rounding error of the true apex, not on it: 1e-7 of the cone's size there.
    return Math.abs(this.rho(v)) <= 1e-7 * Math.max(Math.abs(this.radius), Math.abs(v * this.tan)) + 1e-12;
  }
}

/** Sphere: S = C + R cos v (cos u x + sin u y) + R sin v z, v in [-pi/2, pi/2]. */
class Sphere implements Surface {
  readonly uPeriod = TAU;
  readonly vPeriod = 0;
  readonly uDomain = [0, TAU] as const;
  readonly vDomain = [-Math.PI / 2, Math.PI / 2] as const;
  constructor(
    private readonly f: Frame,
    private readonly radius: number,
  ) {}
  at(u: number, v: number) {
    const [e, t] = radial(this.f, u),
      R = this.radius,
      cv = Math.cos(v),
      sv = Math.sin(v),
      { origin: o, z } = this.f;
    return [
      o[0] + R * (cv * e[0] + sv * z[0]),
      o[1] + R * (cv * e[1] + sv * z[1]),
      o[2] + R * (cv * e[2] + sv * z[2]),
      ...scale(t, R * cv),
      ...add(scale(e, -R * sv), scale(z, R * cv)),
    ];
  }
  normal(u: number, v: number): V3 {
    const [e] = radial(this.f, u);
    return add(scale(e, Math.cos(v)), scale(this.f.z, Math.sin(v)));
  }
  parameters(p: readonly number[], hint?: readonly number[]): [number, number] {
    const l = local(this.f, p);
    return [l.r > 1e-12 * this.radius ? l.u : (hint?.[0] ?? 0), Math.atan2(l.z, l.r)];
  }
  steps(_box: readonly number[], deflection: number, turn: number): [number, number] {
    const a = angleStep(this.radius, deflection, turn);
    return [a, a];
  }
  pole(side: 1 | -1) {
    return (side * Math.PI) / 2;
  }
  singular(_u: number, v: number) {
    // Within 1e-7 of the radius of a pole (exported pole vertices carry rounding error).
    return Math.abs(Math.cos(v)) < 1e-7;
  }
}

/** Torus: S = C + (R + r cos v)(cos u x + sin u y) + r sin v z. */
class Torus implements Surface {
  readonly uPeriod = TAU;
  readonly vPeriod = TAU;
  readonly uDomain = [0, TAU] as const;
  readonly vDomain = [0, TAU] as const;
  constructor(
    private readonly f: Frame,
    private readonly major: number,
    private readonly minor: number,
  ) {}
  at(u: number, v: number) {
    const [e, t] = radial(this.f, u),
      cv = Math.cos(v),
      sv = Math.sin(v),
      ring = this.major + this.minor * cv,
      { origin: o, z } = this.f;
    return [
      o[0] + ring * e[0] + this.minor * sv * z[0],
      o[1] + ring * e[1] + this.minor * sv * z[1],
      o[2] + ring * e[2] + this.minor * sv * z[2],
      ...scale(t, ring),
      ...add(scale(e, -this.minor * sv), scale(z, this.minor * cv)),
    ];
  }
  normal(u: number, v: number): V3 {
    const [e] = radial(this.f, u),
      n = add(scale(e, Math.cos(v)), scale(this.f.z, Math.sin(v)));
    return this.major + this.minor * Math.cos(v) < 0 ? scale(n, -1) : n;
  }
  parameters(p: readonly number[], hint?: readonly number[]): [number, number] {
    const l = local(this.f, p);
    return [l.r > 0 ? l.u : (hint?.[0] ?? 0), wrap(Math.atan2(l.z, l.r - this.major))];
  }
  steps(_box: readonly number[], deflection: number, turn: number): [number, number] {
    return [angleStep(this.major + this.minor, deflection, turn), angleStep(this.minor, deflection, turn)];
  }
  pole() {
    return undefined;
  }
  singular() {
    return false;
  }
}

/** Steps along a curve's parameter: the shortest gap its own sampling uses over [a, b]. */
function curveStep(curve: Curve, a: number, b: number, deflection: number, turn: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return Infinity;
  const t = curve.sample(a, b, deflection, turn);
  let step = Infinity;
  for (let i = 1; i < t.length; i++) step = Math.min(step, Math.abs(t[i] - t[i - 1]));
  return t.length > 2 ? step : Infinity;
}

/** Surface of revolution: the profile c(v) rotated by u about an axis (point A, unit direction a). */
class Revolution implements Surface {
  readonly uPeriod = TAU;
  readonly vPeriod: number;
  readonly uDomain = [0, TAU] as const;
  readonly vDomain = [-Infinity, Infinity] as const;
  constructor(
    private readonly profile: Curve,
    private readonly axisPoint: V3,
    private readonly axis: V3,
  ) {
    this.vPeriod = profile.period;
  }
  /** Rotates w about the axis direction by angle u (Rodrigues). */
  private rotate(w: readonly number[], u: number): V3 {
    const c = Math.cos(u),
      s = Math.sin(u),
      a = this.axis;
    return add(add(scale(w, c), scale(cross(a, w), s)), scale(a, dot(a, w) * (1 - c)));
  }
  at(u: number, v: number) {
    const c = this.profile.at(v),
      w = this.rotate(sub(c, this.axisPoint), u),
      p = add(this.axisPoint, w);
    return [...p, ...cross(this.axis, w), ...this.rotate(c.slice(3), u)];
  }
  normal(u: number, v: number) {
    return normalOf(this, u, v);
  }
  parameters(p: readonly number[], hint?: readonly number[]): [number, number] {
    // Bring p into the profile's meridian plane (same height along the axis, same distance from it), find v there, then
    // u as the angle from the profile point to p about the axis.
    const a = this.axis,
      d = sub(p, this.axisPoint),
      h = dot(d, a),
      radialPart = sub(d, scale(a, h)),
      seed = this.profile.at(hint?.[1] ?? 0),
      seedRadial = sub(sub(seed, this.axisPoint), scale(a, dot(sub(seed, this.axisPoint), a))),
      e0 = unit(seedRadial) ?? unit(radialPart) ?? [1, 0, 0],
      meridian = add(add(this.axisPoint, scale(a, h)), scale(e0, length(radialPart))),
      v = this.profile.parameter(meridian, hint?.[1]),
      c = this.profile.at(v),
      from = sub(sub(c, this.axisPoint), scale(a, dot(sub(c, this.axisPoint), a)));
    if (length(radialPart) < 1e-12 || length(from) < 1e-12) return [hint?.[0] ?? 0, v];
    const u = Math.atan2(dot(cross(from, radialPart), a), dot(from, radialPart));
    return [wrap(u), v];
  }
  steps(box: readonly number[], deflection: number, turn: number): [number, number] {
    let radius = 0;
    for (const v of [box[2], (box[2] + box[3]) / 2, box[3]]) {
      const c = this.profile.at(v),
        d = sub(c, this.axisPoint);
      radius = Math.max(radius, length(sub(d, scale(this.axis, dot(d, this.axis)))));
    }
    return [angleStep(radius, deflection, turn), curveStep(this.profile, box[2], box[3], deflection, turn)];
  }
  pole() {
    return undefined;
  }
  singular(u: number, v: number) {
    const d = this.at(u, v);
    return length(d.slice(3, 6)) < 1e-12;
  }
}

/** Surface of linear extrusion: S = c(u) + v V. */
class Extrusion implements Surface {
  readonly uPeriod: number;
  readonly vPeriod = 0;
  readonly uDomain = [-Infinity, Infinity] as const;
  readonly vDomain = [-Infinity, Infinity] as const;
  constructor(
    private readonly profile: Curve,
    private readonly direction: V3,
  ) {
    this.uPeriod = profile.period;
  }
  at(u: number, v: number) {
    const c = this.profile.at(u);
    return [...add(c, scale(this.direction, v)), ...c.slice(3), ...this.direction];
  }
  normal(u: number, v: number) {
    return normalOf(this, u, v);
  }
  parameters(p: readonly number[], hint?: readonly number[]): [number, number] {
    const V = this.direction,
      vv = dot(V, V);
    let u = this.profile.parameter(p, hint?.[0]),
      v = dot(sub(p, this.profile.at(u)), V) / vv;
    for (let i = 0; i < 3; i++) {
      u = this.profile.parameter(sub(p, scale(V, v)), u);
      v = dot(sub(p, this.profile.at(u)), V) / vv;
    }
    return [u, v];
  }
  steps(box: readonly number[], deflection: number, turn: number): [number, number] {
    return [curveStep(this.profile, box[0], box[1], deflection, turn), Infinity];
  }
  pole() {
    return undefined;
  }
  singular() {
    return false;
  }
}

class SplinePatch implements Surface {
  readonly uPeriod: number;
  readonly vPeriod: number;
  readonly uDomain: readonly [number, number];
  readonly vDomain: readonly [number, number];
  private readonly uBreaks: number[];
  private readonly vBreaks: number[];
  private seeds?: { u: number; v: number; p: number[] }[];
  private readonly size: number;
  constructor(
    private readonly s: SplineSurface,
    uClosed: boolean,
    vClosed: boolean,
  ) {
    this.uDomain = [s.uKnots[s.uDegree], s.uKnots[s.nu]];
    this.vDomain = [s.vKnots[s.vDegree], s.vKnots[s.nv]];
    this.uBreaks = spanBreaks(s.uKnots, s.uDegree, s.nu - 1);
    this.vBreaks = spanBreaks(s.vKnots, s.vDegree, s.nv - 1);
    this.uPeriod = uClosed ? this.uDomain[1] - this.uDomain[0] : 0;
    this.vPeriod = vClosed ? this.vDomain[1] - this.vDomain[0] : 0;
    let lo = Infinity,
      hi = -Infinity;
    for (let i = 0; i < s.points.length; i += 4)
      for (let k = 0; k < 3; k++) {
        const c = s.points[i + k] / s.points[i + 3];
        lo = Math.min(lo, c);
        hi = Math.max(hi, c);
      }
    this.size = Math.max(hi - lo, 1e-12);
  }
  private fit(t: number, [lo, hi]: readonly [number, number], period: number) {
    if (period) return lo + ((((t - lo) % period) + period) % period);
    return Math.min(hi, Math.max(lo, t));
  }
  at(u: number, v: number) {
    return surfaceAt(this.s, this.fit(u, this.uDomain, this.uPeriod), this.fit(v, this.vDomain, this.vPeriod));
  }
  normal(u: number, v: number) {
    return normalOf(this, u, v);
  }
  parameters(p: readonly number[], hint?: readonly number[]): [number, number] {
    let u: number, v: number;
    if (hint) [u, v] = hint;
    else {
      // Seed from the nearest of 4 x 4 samples per knot span (at most 48 per direction).
      const samples = (breaks: number[]) => {
        const out: number[] = [],
          per = Math.max(1, Math.min(4, Math.floor(48 / Math.max(1, breaks.length - 1))));
        for (let i = 1; i < breaks.length; i++)
          for (let k = 0; k < per; k++) out.push(breaks[i - 1] + ((breaks[i] - breaks[i - 1]) * (k + 0.5)) / per);
        return out;
      };
      this.seeds ??= samples(this.uBreaks).flatMap((su) =>
        samples(this.vBreaks).map((sv) => ({ u: su, v: sv, p: this.at(su, sv) })),
      );
      let best = Infinity;
      [u, v] = [this.uDomain[0], this.vDomain[0]];
      for (const seed of this.seeds) {
        const d = distance(seed.p, p);
        if (d < best) {
          best = d;
          u = seed.u;
          v = seed.v;
        }
      }
    }
    // Gauss-Newton on |S(u, v) - p|^2.
    for (let i = 0; i < 50; i++) {
      const d = this.at(u, v),
        r = sub(d, p),
        su = d.slice(3, 6),
        sv = d.slice(6, 9),
        a = dot(su, su),
        b = dot(su, sv),
        c = dot(sv, sv),
        g1 = dot(su, r),
        g2 = dot(sv, r),
        det = a * c - b * b;
      if (!(det > 1e-30 * (a * c || 1))) {
        // Singular (a pole): move along whichever derivative exists.
        if (a > 0) u -= g1 / a;
        else if (c > 0) v -= g2 / c;
        else break;
      } else {
        const du = (-c * g1 + b * g2) / det,
          dv = (b * g1 - a * g2) / det;
        u += du;
        v += dv;
      }
      u = this.fit(u, this.uDomain, this.uPeriod);
      v = this.fit(v, this.vDomain, this.vPeriod);
      if (length(r) < 1e-12 * this.size) break;
    }
    return [u, v];
  }
  steps(box: readonly number[]): [number, number] {
    // Degree + 1 points per knot span to start with; the tessellator refines where the surface still strays.
    const step = (breaks: number[], degree: number, lo: number, hi: number) => {
      let span = Infinity;
      for (let i = 1; i < breaks.length; i++)
        if (breaks[i] > lo && breaks[i - 1] < hi) span = Math.min(span, breaks[i] - breaks[i - 1]);
      return span / (degree + 1);
    };
    return [step(this.uBreaks, this.s.uDegree, box[0], box[1]), step(this.vBreaks, this.s.vDegree, box[2], box[3])];
  }
  pole(side: 1 | -1) {
    // A control-point row collapsed to one point at the low or high v end.
    const j = side > 0 ? this.s.nv - 1 : 0,
      first = [0, 1, 2].map((k) => this.s.points[j * 4 + k] / this.s.points[j * 4 + 3]);
    for (let i = 1; i < this.s.nu; i++) {
      const o = (i * this.s.nv + j) * 4,
        q = [0, 1, 2].map((k) => this.s.points[o + k] / this.s.points[o + 3]);
      if (distance(q, first) > 1e-9 * this.size) return undefined;
    }
    return side > 0 ? this.vDomain[1] : this.vDomain[0];
  }
  uPole(side: 1 | -1) {
    // A control-point row collapsed to one point at the low or high u end.
    const i = side > 0 ? this.s.nu - 1 : 0,
      at = (j: number) =>
        [0, 1, 2].map((k) => this.s.points[(i * this.s.nv + j) * 4 + k] / this.s.points[(i * this.s.nv + j) * 4 + 3]),
      first = at(0);
    for (let j = 1; j < this.s.nv; j++) if (distance(at(j), first) > 1e-9 * this.size) return undefined;
    return side > 0 ? this.uDomain[1] : this.uDomain[0];
  }
  singular(u: number, v: number) {
    const d = this.at(u, v);
    return length(d.slice(3, 6)) < 1e-9 * this.size || length(d.slice(6, 9)) < 1e-9 * this.size;
  }
}

/** Offset surface: the basis moved along its normal by a distance. Derivatives by central differences. */
class Offset implements Surface {
  readonly uPeriod: number;
  readonly vPeriod: number;
  readonly uDomain: readonly [number, number];
  readonly vDomain: readonly [number, number];
  constructor(
    private readonly basis: Surface,
    private readonly distance: number,
  ) {
    this.uPeriod = basis.uPeriod;
    this.vPeriod = basis.vPeriod;
    this.uDomain = basis.uDomain;
    this.vDomain = basis.vDomain;
  }
  private point(u: number, v: number) {
    return add(this.basis.at(u, v).slice(0, 3), scale(this.basis.normal(u, v), this.distance));
  }
  at(u: number, v: number) {
    const h = 1e-6,
      du = sub(this.point(u + h, v), this.point(u - h, v)),
      dv = sub(this.point(u, v + h), this.point(u, v - h));
    return [...this.point(u, v), ...scale(du, 0.5 / h), ...scale(dv, 0.5 / h)];
  }
  normal(u: number, v: number) {
    return this.basis.normal(u, v);
  }
  parameters(p: readonly number[], hint?: readonly number[]): [number, number] {
    let uv = this.basis.parameters(p, hint);
    for (let i = 0; i < 3; i++)
      uv = this.basis.parameters(sub(p, scale(this.basis.normal(uv[0], uv[1]), this.distance)), uv);
    return uv;
  }
  steps(box: readonly number[], deflection: number, turn: number) {
    return this.basis.steps(box, deflection, turn);
  }
  pole(side: 1 | -1) {
    return this.basis.pole(side);
  }
  singular(u: number, v: number) {
    return this.basis.singular(u, v);
  }
}

/** A (rational) B-spline surface from STEP's simple or complex instance. */
function splineSurface(file: STEPFile, id: number): Surface {
  const entity = file.get(id),
    base = entity.parts ? entity.parts.get('B_SPLINE_SURFACE') : entity.args.slice(1, 8),
    knotted = entity.parts ? entity.parts.get('B_SPLINE_SURFACE_WITH_KNOTS') : entity.args.slice(8, 13),
    rational = entity.parts?.get('RATIONAL_B_SPLINE_SURFACE');
  if (!base || !knotted) throw unsupported(file, id, 'B-spline surface (knots implied, not listed)');
  const uDegree = num(base[0]),
    vDegree = num(base[1]),
    rows = list(base[2]).map((row) => list(row).map((v) => point(file, ref(v)))),
    nu = rows.length,
    nv = rows[0]?.length ?? 0,
    weights = rational ? list(rational[0]).map((row) => list(row).map((w) => num(w, 1))) : undefined,
    uKnots = knotVector(
      list(knotted[2]).map((k) => num(k)),
      list(knotted[0]).map((m) => num(m)),
    ),
    vKnots = knotVector(
      list(knotted[3]).map((k) => num(k)),
      list(knotted[1]).map((m) => num(m)),
    );
  if (
    !nu ||
    !nv ||
    rows.some((row) => row.length !== nv) ||
    uKnots.length !== nu + uDegree + 1 ||
    vKnots.length !== nv + vDegree + 1 ||
    uDegree < 1 ||
    vDegree < 1
  )
    throw new TypeError(`Invalid STEP file: #${id} B-spline surface knots do not match its control net and degrees`);
  const points = new Float64Array(nu * nv * 4);
  for (let i = 0; i < nu; i++)
    for (let j = 0; j < nv; j++) {
      const c = rows[i][j],
        w = weights?.[i]?.[j] ?? 1;
      points.set([c[0] * w, c[1] * w, c[2] * w, w], (i * nv + j) * 4);
    }
  // Closed in a direction when marked so, or when a clamped net's first and last rows meet (the flag is often false).
  const flag = (v: STEPValue | undefined) => v instanceof Enum && v.name === 'T';
  let size = 0;
  for (const row of rows) for (const c of row) size = Math.max(size, Math.abs(c[0]), Math.abs(c[1]), Math.abs(c[2]));
  const tolerance = 1e-9 * Math.max(size, 1e-30),
    uMeets = clamped(uKnots, uDegree) && rows[0].every((c, j) => distance(c, rows[nu - 1][j]) <= tolerance),
    vMeets = clamped(vKnots, vDegree) && rows.every((row) => distance(row[0], row[nv - 1]) <= tolerance);
  return new SplinePatch(
    { uDegree, vDegree, nu, nv, points, uKnots, vKnots },
    flag(base[4]) || uMeets,
    flag(base[5]) || vMeets,
  );
}

/**
 * The surface of entity `id`. `angleUnit` is radians per plane-angle unit of the body's context (a cone's half angle
 * is written in it). Throws a TypeError for a surface the kernel lacks.
 */
export function surfaceOf(file: STEPFile, id: number, angleUnit: number, curves: (id: number) => Curve): Surface {
  const entity = file.get(id),
    type = entity.parts ? (entity.parts.has('B_SPLINE_SURFACE') ? 'B_SPLINE_SURFACE_WITH_KNOTS' : '') : entity.type,
    args = entity.args;
  switch (type) {
    case 'PLANE':
      return new Plane(frame(file, ref(args[1])));
    case 'CYLINDRICAL_SURFACE':
      return new Cone(frame(file, ref(args[1])), num(args[2]), 0);
    case 'CONICAL_SURFACE':
      return new Cone(frame(file, ref(args[1])), num(args[2]), num(args[3]) * angleUnit);
    case 'SPHERICAL_SURFACE':
      return new Sphere(frame(file, ref(args[1])), num(args[2]));
    case 'TOROIDAL_SURFACE':
    case 'DEGENERATE_TOROIDAL_SURFACE':
      return new Torus(frame(file, ref(args[1])), num(args[2]), num(args[3]));
    case 'SURFACE_OF_REVOLUTION': {
      const axis = ref(args[2]);
      if (axis === undefined || !file.is(axis, 'AXIS1_PLACEMENT')) throw unsupported(file, id, 'surface');
      const [, location, dir] = file.args(axis, 'AXIS1_PLACEMENT');
      return new Revolution(
        curves(ref(args[1]) ?? -1),
        point(file, ref(location)),
        ref(dir) !== undefined ? direction(file, ref(dir)) : [0, 0, 1],
      );
    }
    case 'SURFACE_OF_LINEAR_EXTRUSION':
      return new Extrusion(curves(ref(args[1]) ?? -1), vector(file, ref(args[2])));
    case 'B_SPLINE_SURFACE_WITH_KNOTS':
      return splineSurface(file, id);
    case 'OFFSET_SURFACE':
      return new Offset(surfaceOf(file, ref(args[1]) ?? -1, angleUnit, curves), num(args[2]));
    case 'RECTANGULAR_TRIMMED_SURFACE':
      return surfaceOf(file, ref(args[1]) ?? -1, angleUnit, curves);
    default:
      throw unsupported(file, id, 'surface');
  }
}

/** Evaluators for surfaces the modeler makes from parameters (no STEP entity behind them). */
export const makeSurface = {
  plane: (f: Frame): Surface => new Plane(f),
  /** A cylinder is a cone with zero half angle. */
  cone: (f: Frame, radius: number, halfAngle: number): Surface => new Cone(f, radius, halfAngle),
  sphere: (f: Frame, radius: number): Surface => new Sphere(f, radius),
  torus: (f: Frame, major: number, minor: number): Surface => new Torus(f, major, minor),
  spline: (s: SplineSurface, uClosed: boolean, vClosed: boolean): Surface => new SplinePatch(s, uClosed, vClosed),
};
