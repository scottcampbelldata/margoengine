// Directing floating bodies for film (SEA-12, parity bar P12 point 7), without breaking the physics:
// - `waveHit` places a wave crest of a chosen height at a chosen place and time: a NewWave focused group (Tromans,
//   Jefferys and Barnes 1991), the most likely shape of a linear sea's crest of that height, from a JONSWAP spectrum of
//   the chosen peak period; with a `seed`, a random sea of that spectrum constrained to make the same crest there and
//   then (Taylor, Jonathan and Harland 1997, "constrained NewWave"). Its water moves, presses and draws as linear deep-water
//   waves (Airy theory), so a body meets it as it meets any sea, and `waveComponents` gives Water the same waves to draw.
// - `ballast` gives the mass and centre of mass that float a body at a chosen draft, heel and trim: the weight equals the
//   water the body displaces there and the centre of mass sits on the vertical through the centre of buoyancy, so the
//   pose is an equilibrium of the same buoyancy the LoadSolver applies, not a pose forced on it.
// - Placed pushes are the LoadSolver's `impulses` (solver.ts): an impulse at a time, held with the water the body carries.
import { createRandom } from '@margoengine/math/mathutils';
import { atan2, cos, exp, hypot, pow, sin } from '@margoengine/math/pinned';
import { meshBuoyancyCentre, meshHydrostatics } from './buoyancy.js';
import { invalidLoad } from './errors.js';
import type { LoadWater } from './solver.js';

type Vec3 = [number, number, number];
type Quat = readonly [number, number, number, number];

/** A placed wave crest: what {@link waveHit} makes. */
export interface WaveHitOptions {
  /** Where the crest peaks, [x, z] m. */
  readonly at: readonly [number, number];
  /** When it peaks, s on the sea's clock. */
  readonly time: number;
  /** The crest's height above the still level, m, above 0. */
  readonly crest: number;
  /** The spectrum's peak period, s (default 8). */
  readonly period?: number;
  /** The direction it travels, [x, z] (default [1, 0]). */
  readonly direction?: readonly [number, number];
  /** JONSWAP peak enhancement, 1 to 7 (default 3.3; 1 is Pierson-Moskowitz). */
  readonly peakedness?: number;
  /** Significant wave height of a random sea around the crest, m (default 0: the crest alone). */
  readonly background?: number;
  /** Seed of that random sea (default 1). The same seed gives the same sea, and every seed the same crest. */
  readonly seed?: number;
  /** Components of the group, 8 to 256 (default 64). */
  readonly components?: number;
  /** The sea the crest comes on (default still water of `density`): its waves, flow and pressure add. */
  readonly sea?: LoadWater & { pressure?(x: number, y: number, z: number, t: number): number };
  /** Water density, kg/m³ (default the sea's, else 1025). */
  readonly density?: number;
}

/** A sea with a placed crest: a LoadSolver `sea` and a Water `sea` (`waveComponents`). */
export interface WaveHit extends LoadWater {
  readonly cell: readonly [number, number, number];
  pressure(x: number, y: number, z: number, t: number): number;
  /** The crest's waves (and the sea's, when it draws) at time `t` for a renderer: kx, kz, amplitude, phase each. */
  waveComponents(t: number, out: Float32Array): number;
  /** How many waves `waveComponents` writes. */
  readonly componentCount: number;
}

const G = 9.81,
  TWO_PI = 2 * Math.PI;

/**
 * A sea with a wave crest placed at `at` and `time` (NewWave, or constrained NewWave with `background` and `seed`):
 * `world.add(loads, {sea: waveHit({at: [0, 0], time: 6, crest: 1.5, sea}), bodies})`.
 * @throws MargoError `unsupported` (errors#hydrodynamic-loads) for a crest, period or count out of range.
 */
export function waveHit(options: WaveHitOptions): WaveHit {
  const {
    at,
    time,
    crest,
    period = 8,
    direction = [1, 0],
    peakedness = 3.3,
    background = 0,
    seed = 1,
    components = 64,
    sea,
  } = options ?? ({} as WaveHitOptions);
  const density = options?.density ?? sea?.density ?? 1025;
  if (!(Array.isArray(at) && at.length === 2 && at.every(Number.isFinite) && Number.isFinite(time)))
    throw invalidLoad('A wave hit needs a finite place [x, z] in metres and a time in seconds.');
  if (!(crest > 0 && crest < 100 && period > 0.1 && period < 60))
    throw invalidLoad('A wave hit takes a crest above 0 and below 100 m, and a peak period of 0.1 to 60 s.');
  if (!(peakedness >= 1 && peakedness <= 7 && background >= 0 && background < 100 && density > 0))
    throw invalidLoad('A wave hit takes peakedness 1 to 7, a background height of 0 to 100 m and a positive density.');
  if (!(Number.isInteger(components) && components >= 8 && components <= 256) || !Number.isInteger(seed))
    throw invalidLoad('A wave hit takes 8 to 256 whole components and a whole seed.');
  const length = hypot(direction[0], direction[1]);
  if (!(length > 0 && Number.isFinite(length))) throw invalidLoad('Give the wave hit a nonzero finite direction.');
  const [dx, dz] = [direction[0] / length, direction[1] / length],
    wp = TWO_PI / period,
    // JONSWAP's shape (Hasselmann et al. 1973) from 0.5 to 3 times the peak, evenly in frequency.
    low = 0.5 * wp,
    dw = (3 * wp - low) / components,
    omega = new Float64Array(components),
    s = new Float64Array(components);
  let variance = 0;
  for (let n = 0; n < components; n++) {
    const w = low + (n + 0.5) * dw,
      sigma = w <= wp ? 0.07 : 0.09,
      shape =
        pow(w, -5) *
        exp(-1.25 * pow(wp / w, 4)) *
        pow(peakedness, exp(-((w - wp) * (w - wp)) / (2 * sigma * sigma * wp * wp)));
    omega[n] = w;
    s[n] = shape * dw;
    variance += s[n]!;
  }
  // NewWave: each component s_n / sigma^2 of the crest, in phase at the focus. Constrained NewWave adds a random sea of
  // the spectrum (amplitudes sqrt(2 S dw), seeded phases) and removes its height and slope at the focus.
  const re = new Float64Array(components),
    im = new Float64Array(components);
  let height = 0,
    rate = 0,
    curvature = 0;
  if (background > 0) {
    const random = createRandom(seed),
      scale = ((background / 4) * (background / 4)) / variance;
    for (let n = 0; n < components; n++) {
      const a = Math.sqrt(2 * s[n]! * scale),
        phase = TWO_PI * random();
      re[n] = a * cos(phase);
      im[n] = a * sin(phase);
      // At the focus the component is re cos(-w tau) - im sin(-w tau): height re, rate of rise w im.
      height += re[n]!;
      rate += omega[n]! * im[n]!;
    }
  }
  for (let n = 0; n < components; n++) curvature += (s[n]! / variance) * omega[n]! * omega[n]!;
  for (let n = 0; n < components; n++) {
    const shape = s[n]! / variance;
    re[n]! += (crest - height) * shape;
    // rho' at the focus is the sum of shape w sin(theta), the component (0, -shape w) in (re, im) form; it cancels the rate.
    im[n]! -= (rate / curvature) * shape * omega[n]!;
  }
  const amp = Float64Array.from(re, (r, n) => hypot(r, im[n]!)),
    phase = Float64Array.from(re, (r, n) => atan2(im[n]!, r)),
    k = Float64Array.from(omega, (w) => (w * w) / G),
    theta = (n: number, x: number, z: number, t: number) =>
      k[n]! * ((x - at[0]) * dx + (z - at[1]) * dz) - omega[n]! * (t - time) + phase[n]!;
  const elevation = (x: number, z: number, t: number) => {
    let h = sea ? sea.elevation(x, z, t) : 0;
    for (let n = 0; n < components; n++) h += amp[n]! * cos(theta(n, x, z, t));
    return h;
  };
  const water: WaveHit['water'] = {
    medium: 'water',
    cell: [0, 0, 0],
    sample(x, y, z, t, out = { velocity: [0, 0, 0], density: 0, temperature: 288.15 }) {
      if (sea) sea.water.sample(x, y, z, t, out);
      else {
        out.velocity[0] = out.velocity[1] = out.velocity[2] = 0;
        out.temperature = 288.15;
      }
      const wet = y <= elevation(x, z, t);
      out.density = wet ? density : 0;
      if (!wet) {
        out.velocity[0] = out.velocity[1] = out.velocity[2] = 0;
        return out;
      }
      // Airy's deep-water orbits, taken at the still level above it (the same stretching as the pressure).
      const level = Math.min(0, y);
      for (let n = 0; n < components; n++) {
        const decay = amp[n]! * omega[n]! * exp(k[n]! * level),
          th = theta(n, x, z, t);
        out.velocity[0] += decay * cos(th) * dx;
        out.velocity[1] += decay * sin(th);
        out.velocity[2] += decay * cos(th) * dz;
      }
      return out;
    },
  };
  return {
    cell: [0, 0, 0],
    density,
    water,
    elevation,
    pressure(x, y, z, t) {
      const surface = elevation(x, z, t);
      if (y >= surface) return 0;
      // rho g (dynamic - y): the waves' e^(k y) pressure at the still level above the point, as SpectralSea's.
      const base = sea?.pressure
        ? sea.pressure(x, y, z, t)
        : sea
          ? density * G * Math.max(0, sea.elevation(x, z, t) - y)
          : -density * G * y;
      const level = Math.min(0, y);
      let dynamic = 0;
      for (let n = 0; n < components; n++) dynamic += amp[n]! * exp(k[n]! * level) * cos(theta(n, x, z, t));
      return Math.max(0, base + density * G * dynamic);
    },
    get componentCount() {
      return components + ((sea as { componentCount?: number } | undefined)?.componentCount ?? 0);
    },
    waveComponents(t: number, out: Float32Array): number {
      const own = (sea as { waveComponents?(t: number, out: Float32Array): number } | undefined)?.waveComponents,
        before = own ? own.call(sea, t, out) : 0;
      if (!(out.length >= 4 * (before + components)))
        throw invalidLoad(`waveComponents writes ${4 * (before + components)} numbers; pass a Float32Array that long.`);
      for (let n = 0; n < components; n++) {
        // amplitude cos(kx x + kz z + phase): the focus and the time folded into the phase, brought into [0, 2 pi).
        const p = phase[n]! - k[n]! * (at[0] * dx + at[1] * dz) - omega[n]! * (t - time),
          i = 4 * (before + n);
        out[i] = k[n]! * dx;
        out[i + 1] = k[n]! * dz;
        out[i + 2] = amp[n]!;
        out[i + 3] = p - TWO_PI * Math.floor(p / TWO_PI);
      }
      return before + components;
    },
  };
}

/** What {@link ballast} gives: set it with `body.setMassProperties(ballast(...))`. */
export interface Ballast {
  /** The body's mass, kg: the water it displaces at the target. */
  readonly mass: number;
  /** Its centre of mass in its frame, m: on the vertical through the centre of buoyancy at the target, at `height`. */
  readonly centerOfMass: [number, number, number];
  /** The metacentric height of that pose in heel, m (above 0: it rights itself). */
  readonly stability: number;
}

/** Target pose for {@link ballast}. */
export interface BallastOptions {
  /** How deep the body's lowest point sits below the water, m, above 0. */
  readonly draft: number;
  /** Heel about its X axis and trim about its Z axis, rad (default 0 and 0). */
  readonly heel?: number;
  readonly trim?: number;
  /** The centre of mass's height in the body's frame, m (default its centroid's). */
  readonly height?: number;
  /** Water density, kg/m³ (default 1025). */
  readonly density?: number;
}

/**
 * The mass and centre of mass that float a closed mesh (the body's hull, in its frame) at `draft`, `heel` and `trim`
 * in still water: weight equal to the water displaced there, the centre of mass over the centre of buoyancy.
 * @throws MargoError `unsupported` (errors#hydrodynamic-loads) for a draft the hull cannot reach, or a pose that would
 *   capsize (no righting: lower the centre of mass, `height`).
 */
export function ballast(
  mesh: { readonly vertices: ArrayLike<number>; readonly indices: ArrayLike<number> },
  options: BallastOptions,
): Ballast {
  const { draft, heel = 0, trim = 0, density = 1025 } = options ?? ({} as BallastOptions);
  if (!(draft > 0 && Number.isFinite(heel) && Number.isFinite(trim) && density > 0))
    throw invalidLoad('Ballast takes a positive draft, finite heel and trim in radians and a positive density.');
  const q = multiply(axisTurn([1, 0, 0], heel), axisTurn([0, 0, 1], trim)),
    v = mesh.vertices;
  let lowest = Infinity,
    highest = -Infinity,
    centroid = 0;
  for (let i = 0; i < v.length; i += 3) {
    const y = rotate(q, [v[i]!, v[i + 1]!, v[i + 2]!])[1];
    lowest = Math.min(lowest, y);
    highest = Math.max(highest, y);
    centroid += v[i + 1]!;
  }
  if (!(draft < highest - lowest)) throw invalidLoad('That draft is deeper than the body; give a smaller draft.');
  const level = lowest + draft,
    cb = meshBuoyancyCentre(mesh, q, level, [0, 0, 0]),
    volume = submergedVolume(mesh, q, level),
    height = options.height ?? centroid / (v.length / 3);
  // The centre of mass on the vertical through the centre of buoyancy (world axes about the body's origin), at `height`
  // along the body's own up: solve G = R^T (cb + t up) for the t that gives the body-frame height.
  const up = rotate(conjugate(q), [0, 1, 0]),
    base = rotate(conjugate(q), cb),
    t = (height - base[1]) / up[1],
    com: Vec3 = [base[0] + t * up[0], height, base[2] + t * up[2]];
  // GM in heel from a small extra heel: the top leans to +Z, that side goes under and B moves toward it; the body rights
  // itself when B moves further than G does (GZ = B_z - G_z above 0).
  const tilt = 1e-3,
    q2 = multiply(axisTurn([1, 0, 0], heel + tilt), axisTurn([0, 0, 1], trim)),
    level2 = solveLevel(mesh, q2, volume),
    b2 = meshBuoyancyCentre(mesh, q2, level2, [0, 0, 0]),
    g2 = rotate(q2, com),
    stability = (b2[2] - g2[2]) / sin(tilt);
  if (!(stability > 0))
    throw invalidLoad('At that ballast the body would capsize; lower its centre of mass (height) or heel it less.');
  return { mass: density * volume, centerOfMass: com, stability };
}

/** Volume of the turned mesh below `level` (world axes about its origin), by the unit-pressure wetted integral. */
function submergedVolume(mesh: Parameters<typeof ballast>[0], q: Quat, level: number): number {
  const out = { force: [0, 0, 0] as Vec3, torque: [0, 0, 0] as Vec3, area: 0 };
  meshHydrostatics(mesh, q, level, [0, 0, 0], out);
  return out.force[1];
}

function solveLevel(mesh: Parameters<typeof ballast>[0], q: Quat, volume: number): number {
  const v = mesh.vertices;
  let lo = Infinity,
    hi = -Infinity;
  for (let i = 0; i < v.length; i += 3) {
    const y = rotate(q, [v[i]!, v[i + 1]!, v[i + 2]!])[1];
    lo = Math.min(lo, y);
    hi = Math.max(hi, y);
  }
  // Bisection: the displaced volume grows with the level; 60 halvings reach the float's resolution.
  for (let step = 0; step < 60; step++) {
    const mid = (lo + hi) / 2;
    if (submergedVolume(mesh, q, mid) < volume) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function axisTurn(axis: Vec3, angle: number): Quat {
  const s = sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, cos(angle / 2)];
}

function multiply(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

const conjugate = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];

function rotate(q: Quat, p: Vec3): Vec3 {
  const [x, y, z] = p,
    tx = 2 * (q[1] * z - q[2] * y),
    ty = 2 * (q[2] * x - q[0] * z),
    tz = 2 * (q[0] * y - q[1] * x);
  return [
    x + q[3] * tx + (q[1] * tz - q[2] * ty),
    y + q[3] * ty + (q[2] * tx - q[0] * tz),
    z + q[3] * tz + (q[0] * ty - q[1] * tx),
  ];
}
