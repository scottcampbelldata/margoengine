// The water's loads on the segments of a slender structure that moves (SEA-12 for SOFT-02): a rod's links, a hose, a mooring
// line, a tentacle. The same member physics as `LoadSolver`'s members (morison.ts: DNV-RP-C205's coefficients by roughness and
// Keulegan-Carpenter number with the drag of the Reynolds number below the drag crisis, Eames's tangential drag, the
// Facchinetti wake oscillator, water.ts's flow and acceleration), handed to the structure per segment as forces held for a
// step, an added mass, and the drag as a damping toward the flow, which the structure solves implicitly with its own
// stiffness (a rod's links in its multibody's direct solve): a light segment in a hard flow, or one its joints hold still,
// then feels the whole drag and stays stable, where an explicit drag force on it does neither.
//
// Each segment's wake oscillator is driven by the segment's own acceleration across the flow (Facchinetti, de Langre and
// Biolley 2004, eq. 2, A = 12), so a cable free across a flow locks onto its own frequency. A second wake oscillator at twice
// the shedding frequency gives the fluctuating drag along the flow, driven by the segment's acceleration along it (Srinil
// and Zanganeh 2012, eq. 6, Lambda = 12, C_D0 = 0.2). The drag on the flow relative to the moving segment already raises
// the mean drag as it swings across; Vandiver's fit of the measured growth, C_D (1 + 1.043 (2 y_rms / D)^0.65) (Vandiver
// 1983), y_rms the swing's root mean square over the last five shedding periods, can be added on top (`amplify`), which
// counts that kinematic part twice: on a towed pipe it bowed the pipe 50 % past the measurement, where without it the bow is
// within 19 % (packages/physics/tests/rod-viv.test.js).
import type { FlowCell, FlowField, FlowSample } from '@margoengine/math/fields';
import { atan2, cos, hypot, pow, sin } from '@margoengine/math/pinned';
import { invalidLoad } from './errors.js';
import { cylinderCoefficients, reynoldsDrag, tangentialDrag, wakeStep } from './morison.js';
import { SEA_WATER_VISCOSITY, type LoadWater } from './solver.js';
import { waterAcceleration, waterVelocity } from './water.js';

type Vec3 = [number, number, number];

/** Where a segment is and how it moves, as the structure hands it over before a step. World axes, SI units. */
export interface SegmentState {
  /** The segment's centre of mass, m. */
  readonly position: readonly [number, number, number];
  /** Unit vector along the segment. */
  readonly tangent: readonly [number, number, number];
  /** The centre's velocity, m/s, and the segment's spin, rad/s. */
  readonly velocity: readonly [number, number, number];
  readonly angularVelocity: readonly [number, number, number];
  /** Its diameter and length, m. */
  readonly diameter: number;
  readonly length: number;
}

/** The water's load on one segment for the coming step, written by a {@link SegmentLoads} provider. */
export interface SegmentLoad {
  /** A force, N, and a moment about the centre of mass, N m, held for every substep of the step. */
  force: [number, number, number];
  moment: [number, number, number];
  /**
   * Drag as a damping toward the flow: c (u_flow - v_at) with `across` and `along` in kg/s across and along the tangent,
   * `flow` the water's velocity at the world point `at`. The structure solves it implicitly.
   */
  drag: { across: number; along: number; flow: [number, number, number]; at: [number, number, number] };
  /** Mass of water the segment carries across its tangent, kg, and that water's turning inertia across it, kg m^2. */
  addedMass: number;
  addedInertia: number;
}

/** What a structure's loads provider is asked for before each step. */
export interface SegmentLoadContext {
  /** Seconds on the water's clock at the start of the step, and the step, s. */
  readonly time: number;
  readonly dt: number;
  /** The world's gravity, m/s^2. */
  readonly gravity: readonly [number, number, number];
}

/** Loads on a structure's segments, filled in place before each step (`out[i]` for `segments[i]`). */
export interface SegmentLoads {
  apply(segments: readonly SegmentState[], context: SegmentLoadContext, out: SegmentLoad[]): void;
  /**
   * Sizes the provider's state for a rod of this many segments before its first step, so its state has its full length from
   * the start (a world that snapshots it sets aside room for it once).
   */
  prepare?(segments: number): void;
  /** The provider's own state (the wake oscillators), for a snapshot of the world it loads. */
  takeState?(): Float64Array;
  restoreState?(state: Float64Array): void;
}

/** Options of {@link segmentLoads}. Every field has a default. */
export interface SegmentLoadOptions {
  /** More water moving: currents, a ship's race, a river (default none). */
  readonly flows?: readonly FlowField[];
  /** Surface roughness k, m (default 5e-5; marine growth 5e-3 to 5e-2). */
  readonly roughness?: number;
  /**
   * The waves' period for the Keulegan-Carpenter number, s (default 8); `Infinity` for a steady current, where the drag is the
   * steady drag alone and the added mass a cylinder's in potential flow, 1, as it carries for its own small oscillations.
   */
  readonly period?: number;
  /** A drag coefficient across in place of the one from the Reynolds and Keulegan-Carpenter numbers (default none). */
  readonly drag?: number;
  /** An added mass coefficient in place of DNV's (default none). */
  readonly addedMass?: number;
  /**
   * Vortex shedding; `false` for none. `strouhal` (default 0.2) sets the shedding frequency; `lift` (default 0.3) is a held
   * cylinder's lift amplitude across the flow; `drag` (default 0.2) its fluctuating drag amplitude along the flow at twice
   * the frequency (0 for none); `amplify` (default false) adds Vandiver's growth of the mean drag with the segment's swing
   * across the flow, a measured fit that includes the growth the drag on the relative flow already gives.
   */
  readonly vortex?:
    | false
    | { readonly strouhal?: number; readonly lift?: number; readonly drag?: number; readonly amplify?: boolean };
  /** The water's kinematic viscosity, m^2/s (default 1.19e-6). */
  readonly viscosity?: number;
}

/** Facchinetti et al. 2004's coupling of the wake to the cylinder's acceleration, A (eq. 2). */
const COUPLING = 12;

// A segment's state words: the wake across (q, q'), the wake along (p, p'), its velocity before the step (3), and the mean and
// mean square deviation of its displacement across the flow (the square -1 until it is first wet).
const WORDS = 9;

class Provider implements SegmentLoads {
  private wakes = new Float64Array(0);
  private inLine = new Float64Array(0);
  private before = new Float64Array(0);
  private swing = new Float64Array(0);
  private readonly sample: FlowSample = { velocity: [0, 0, 0], density: 0, temperature: 0 };
  private readonly u: Vec3 = [0, 0, 0];
  private readonly a: Vec3 = [0, 0, 0];

  constructor(
    private readonly sea: LoadWater,
    private readonly options: SegmentLoadOptions,
  ) {}

  private size(n: number): void {
    if (this.wakes.length === 2 * n) return;
    this.wakes = new Float64Array(2 * n);
    this.inLine = new Float64Array(2 * n);
    this.before = new Float64Array(3 * n);
    this.swing = new Float64Array(2 * n);
    // The wake oscillators start at the free van der Pol cycle's amplitude, q = 2, as LoadSolver's members do.
    for (let i = 0; i < n; i++) this.rest(i);
  }

  /** Segment `i`'s wakes at rest and its swing unmeasured. */
  private rest(i: number): void {
    this.wakes[2 * i] = this.inLine[2 * i] = 2;
    this.wakes[2 * i + 1] = this.inLine[2 * i + 1] = 0;
    this.swing[2 * i] = 0;
    this.swing[2 * i + 1] = -1;
  }

  prepare(segments: number): void {
    this.size(segments);
  }

  apply(segments: readonly SegmentState[], context: SegmentLoadContext, out: SegmentLoad[]): void {
    this.size(segments.length);
    const { sea, options } = this,
      { time: t, dt, gravity: g } = context,
      flows = options.flows ?? [],
      nu = options.viscosity ?? SEA_WATER_VISCOSITY,
      period = options.period ?? 8,
      vortex = options.vortex === false ? undefined : (options.vortex ?? {}),
      rho = sea.density;
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i]!,
        load = out[i]!,
        e = s.tangent,
        half = s.length / 2,
        D = s.diameter,
        // The segment's ends and the depth of each below the surface; the surface is taken straight across one segment.
        p0: Vec3 = [s.position[0] - e[0] * half, s.position[1] - e[1] * half, s.position[2] - e[2] * half],
        p1: Vec3 = [s.position[0] + e[0] * half, s.position[1] + e[1] * half, s.position[2] + e[2] * half],
        d0 = sea.elevation(p0[0], p0[2], t) - p0[1],
        d1 = sea.elevation(p1[0], p1[2], t) - p1[1];
      load.force[0] = load.force[1] = load.force[2] = 0;
      load.moment[0] = load.moment[1] = load.moment[2] = 0;
      load.drag.across = load.drag.along = 0;
      load.addedMass = load.addedInertia = 0;
      if (d0 <= 0 && d1 <= 0) {
        // Out of the water: the wakes rest, and the segment's speed is kept for its acceleration when it next goes in.
        this.rest(i);
        this.before.set(s.velocity, 3 * i);
        continue;
      }
      const from = d0 < 0 ? -d0 / (d1 - d0) : 0,
        to = d1 < 0 ? d0 / (d0 - d1) : 1,
        wet = (to - from) * s.length,
        mid = (from + to) / 2,
        at: Vec3 = [p0[0] + (p1[0] - p0[0]) * mid, p0[1] + (p1[1] - p0[1]) * mid, p0[2] + (p1[2] - p0[2]) * mid],
        area = (Math.PI * D * D) / 4,
        volume = area * wet,
        u = waterVelocity(sea, flows, at[0], at[1], at[2], t, this.sample, this.u),
        a = waterAcceleration(sea, flows, at[0], at[1], at[2], t, this.sample, this.a),
        arm: Vec3 = [at[0] - s.position[0], at[1] - s.position[1], at[2] - s.position[2]],
        w = s.angularVelocity,
        vp: Vec3 = [
          s.velocity[0] + w[1] * arm[2] - w[2] * arm[1],
          s.velocity[1] + w[2] * arm[0] - w[0] * arm[2],
          s.velocity[2] + w[0] * arm[1] - w[1] * arm[0],
        ],
        vr: Vec3 = [u[0] - vp[0], u[1] - vp[1], u[2] - vp[2]],
        along = vr[0] * e[0] + vr[1] * e[1] + vr[2] * e[2],
        vrN: Vec3 = [vr[0] - along * e[0], vr[1] - along * e[1], vr[2] - along * e[2]],
        speedN = hypot(vrN[0], vrN[1], vrN[2]),
        speed = hypot(vr[0], vr[1], vr[2]),
        aAlong = a[0] * e[0] + a[1] * e[1] + a[2] * e[2],
        aN: Vec3 = [a[0] - aAlong * e[0], a[1] - aAlong * e[1], a[2] - aAlong * e[2]],
        // DNV's coefficients by roughness and KC; below the drag crisis, the drag of the Reynolds number in place of the
        // post-critical steady drag (a hose or a tentacle is subcritical, a pile is not).
        relative = (options.roughness ?? 5e-5) / D,
        re = (speedN * D) / nu,
        coefficients =
          period === Infinity
            ? { drag: reynoldsDrag(re, relative), addedMass: 1 }
            : cylinderCoefficients((speedN * period) / D, relative, 0, 1, re),
        cd = options.drag ?? coefficients.drag,
        amplified = this.amplification(i, s, u, speedN, dt, vortex),
        ca = options.addedMass ?? coefficients.addedMass,
        added = rho * ca * volume;
      // Buoyancy and the pressure gradient that accelerates the water itself (Froude-Krylov, rho V (a - g)), and the added
      // mass's share of the water's acceleration across the segment (rho C_A V a_n); the segment's own acceleration's share
      // is the added mass the structure carries.
      const force: Vec3 = [
        rho * volume * (a[0] - g[0]) + added * aN[0],
        rho * volume * (a[1] - g[1]) + added * aN[1],
        rho * volume * (a[2] - g[2]) + added * aN[2],
      ];
      // Drag across, 1/2 rho C_D D |u_n| u_n per length, and Eames's tangential drag 1/2 rho C_Dn (m + n sin phi) cos phi D
      // |u|^2 along, each as the damping c that gives it on the relative velocity: c_n = 1/2 rho C_D D L |u_n|, and along,
      // with |u_t| = |u| cos phi, c_t = 1/2 rho C_Dn (m + n sin phi) D L |u|.
      const sinPhi = speed > 0 ? speedN / speed : 0;
      load.drag.across = 0.5 * rho * cd * D * wet * speedN;
      load.drag.along = 0.5 * rho * tangentialDrag(cd, sinPhi, 1) * D * wet * speed;
      load.drag.flow[0] = u[0];
      load.drag.flow[1] = u[1];
      load.drag.flow[2] = u[2];
      load.drag.at[0] = at[0];
      load.drag.at[1] = at[1];
      load.drag.at[2] = at[2];
      load.addedMass = added;
      load.addedInertia = (added * wet * wet) / 12;
      // The mean drag's growth with the swing across the flow: Vandiver's fit is of the mean in-line drag, so the excess is a
      // steady load along the water's own flow across the segment, on the water's speed, adding no damping (a damping held
      // explicitly over a step would make a light segment unstable).
      if (amplified > 1) {
        const uAlong = u[0] * e[0] + u[1] * e[1] + u[2] * e[2],
          un: Vec3 = [u[0] - uAlong * e[0], u[1] - uAlong * e[1], u[2] - uAlong * e[2]],
          flowSpeed = hypot(un[0], un[1], un[2]),
          extra = 0.5 * rho * cd * (amplified - 1) * D * wet * flowSpeed;
        force[0] += un[0] * extra;
        force[1] += un[1] * extra;
        force[2] += un[2] * extra;
      }
      // Vortex lift across the flow and the segment: the wake q at 2 pi St U / D, driven by the segment's acceleration
      // across the flow, the lift 1/2 rho U^2 D (C_L0 / 2) q on the wetted length; and the fluctuating drag along the flow:
      // the wake p at twice that, driven by the acceleration along, the drag 1/2 rho U^2 D (C_D0 / 2) p.
      if (vortex && speedN > 1e-9) {
        const lift: Vec3 = [
            (e[1] * vrN[2] - e[2] * vrN[1]) / speedN,
            (e[2] * vrN[0] - e[0] * vrN[2]) / speedN,
            (e[0] * vrN[1] - e[1] * vrN[0]) / speedN,
          ],
          k = 3 * i,
          change: Vec3 = [
            s.velocity[0] - this.before[k]!,
            s.velocity[1] - this.before[k + 1]!,
            s.velocity[2] - this.before[k + 2]!,
          ],
          across = (change[0] * lift[0] + change[1] * lift[1] + change[2] * lift[2]) / dt,
          omega = (2 * Math.PI * (vortex.strouhal ?? 0.2) * speedN) / D,
          pressure = 0.5 * rho * D * wet * speedN * speedN;
        const q = wakeStep(this.wakes, i, omega, (COUPLING / D) * across, dt),
          f = pressure * ((vortex.lift ?? 0.3) / 2) * q;
        force[0] += lift[0] * f;
        force[1] += lift[1] * f;
        force[2] += lift[2] * f;
        const fluctuating = vortex.drag ?? 0.2;
        if (fluctuating > 0) {
          const flow: Vec3 = [vrN[0] / speedN, vrN[1] / speedN, vrN[2] / speedN],
            alongFlow = (change[0] * flow[0] + change[1] * flow[1] + change[2] * flow[2]) / dt,
            p = wakeStep(this.inLine, i, omega, (COUPLING / D) * alongFlow, dt, 2),
            fd = pressure * (fluctuating / 2) * p;
          force[0] += flow[0] * fd;
          force[1] += flow[1] * fd;
          force[2] += flow[2] * fd;
        }
      }
      this.before.set(s.velocity, 3 * i);
      load.force[0] = force[0];
      load.force[1] = force[1];
      load.force[2] = force[2];
      load.moment[0] = arm[1] * force[2] - arm[2] * force[1];
      load.moment[1] = arm[2] * force[0] - arm[0] * force[2];
      load.moment[2] = arm[0] * force[1] - arm[1] * force[0];
    }
  }

  /**
   * The mean drag's growth with segment `i`'s swing across the flow, 1 + 1.043 (2 y_rms / D)^0.65 (Vandiver 1983), y_rms
   * measured as an exponential mean over five shedding periods of the segment's displacement about its mean, across the
   * water's own flow `u` (not the flow relative to the segment, whose direction turns with the segment's swing and would
   * count its bow along the flow as swing).
   */
  private amplification(
    i: number,
    s: SegmentState,
    u: Vec3,
    speedN: number,
    dt: number,
    vortex: Exclude<SegmentLoadOptions['vortex'], false> | undefined,
  ): number {
    if (!vortex || vortex.amplify !== true || !(speedN > 1e-9)) return 1;
    const e = s.tangent,
      across: Vec3 = [e[1] * u[2] - e[2] * u[1], e[2] * u[0] - e[0] * u[2], e[0] * u[1] - e[1] * u[0]],
      size = hypot(across[0], across[1], across[2]);
    if (!(size > 1e-9)) return 1;
    const lift: Vec3 = [across[0] / size, across[1] / size, across[2] / size],
      y = s.position[0] * lift[0] + s.position[1] * lift[1] + s.position[2] * lift[2],
      k = 2 * i;
    if (this.swing[k + 1]! < 0) {
      this.swing[k] = y;
      this.swing[k + 1] = 0;
      return 1;
    }
    const period = s.diameter / ((vortex.strouhal ?? 0.2) * speedN),
      alpha = Math.min(1, dt / (5 * period)),
      deviation = y - this.swing[k]!;
    this.swing[k]! += alpha * deviation;
    this.swing[k + 1]! += alpha * (deviation * deviation - this.swing[k + 1]!);
    const rms = Math.sqrt(this.swing[k + 1]!);
    return rms > 0 ? 1 + 1.043 * pow((2 * rms) / s.diameter, 0.65) : 1;
  }

  takeState(): Float64Array {
    const n = this.wakes.length / 2,
      state = new Float64Array(n * WORDS);
    state.set(this.wakes);
    state.set(this.inLine, 2 * n);
    state.set(this.before, 4 * n);
    state.set(this.swing, 7 * n);
    return state;
  }

  restoreState(state: Float64Array): void {
    if (
      !(state instanceof Float64Array) ||
      state.length % WORDS !== 0 ||
      (this.wakes.length > 0 && state.length !== (this.wakes.length / 2) * WORDS)
    )
      throw invalidLoad('A segment loads state is the Float64Array its takeState() gave; pass that one.');
    const n = state.length / WORDS;
    this.wakes = state.slice(0, 2 * n);
    this.inLine = state.slice(2 * n, 4 * n);
    this.before = state.slice(4 * n, 7 * n);
    this.swing = state.slice(7 * n);
  }
}

/**
 * The water's loads on a moving slender structure's segments, for a `Rod` (`@margoengine/physics/rod`) or any structure that
 * takes {@link SegmentLoads}: `new Rod(physics, {points, loads: segmentLoads(sea)})`. Buoyancy of the wetted length,
 * Morison's inertia with DNV's added mass, drag across and Eames's drag along as a damping toward the flow, and vortex lift
 * from a wake oscillator per segment driven by its own motion.
 * @param sea The water: a `SeaSurface` (a SpectralSea) or any `{elevation(x, z, t), water, density}`.
 * @throws MargoError (code `unsupported`) for water without a surface and a flow, or an option out of range, naming the fix.
 */
export function segmentLoads(sea: LoadWater, options: SegmentLoadOptions = {}): SegmentLoads {
  if (!sea || typeof sea.elevation !== 'function' || typeof sea.water?.sample !== 'function')
    throw invalidLoad(
      'Segment loads need the water: pass a SeaSurface (a SpectralSea) or {elevation, water, density}.',
    );
  if (!(sea.density > 0)) throw invalidLoad(`The water's density is above 0 (got ${sea.density}); pass kg/m^3.`);
  for (const key of ['roughness', 'drag', 'addedMass', 'viscosity'] as const) {
    const value = options[key];
    if (value !== undefined && !(value >= 0 && Number.isFinite(value)))
      throw invalidLoad(`Segment loads' ${key} is a finite number of 0 or more (got ${value}); pass one.`);
  }
  if (options.viscosity === 0) throw invalidLoad("Segment loads' viscosity is above 0; pass m^2/s, or leave it out.");
  if (options.period !== undefined && !(options.period > 0))
    throw invalidLoad(
      `Segment loads' period is above 0 s, or Infinity for a steady current (got ${options.period}); pass one.`,
    );
  if (options.vortex !== undefined && options.vortex !== false) {
    const { strouhal = 0.2, lift = 0.3, drag = 0.2 } = options.vortex;
    if (
      !(
        strouhal > 0 &&
        Number.isFinite(strouhal) &&
        lift >= 0 &&
        Number.isFinite(lift) &&
        drag >= 0 &&
        Number.isFinite(drag)
      )
    )
      throw invalidLoad(
        "Segment loads' vortex takes a Strouhal number above 0 and a lift and a drag of 0 or more; pass them.",
      );
  }
  return new Provider(sea, options);
}

/** Air at sea level in the International Standard Atmosphere (15 C): density, kg/m^3, and kinematic viscosity, m^2/s. */
export const STANDARD_AIR = Object.freeze({ density: 1.225, viscosity: 1.4607e-5 });

/** Options of {@link segmentAirLoads}: those of the water's loads, and the air's density. */
export interface SegmentAirLoadOptions extends SegmentLoadOptions {
  /** Air density, kg/m^3 (default 1.225, the standard atmosphere at sea level). */
  readonly density?: number;
}

/**
 * The air's loads on a rod's segments: cables, rigging, vines and grass in the wind. The same loads as {@link segmentLoads}
 * in a medium with no surface: each segment's drag across and along by its Reynolds number (a cable at 10 m/s and 1 cm is
 * at Re 7,000), the air's added mass and buoyancy (a millionth of a rope's own, kept for honesty), and vortex lift at the
 * Strouhal frequency, which makes a taut wire sing (aeolian vibration). `air` is a wind field (medium `'air'`), such as an
 * ATMO wind; its velocity is sampled at each segment. Steady air by default (`period: Infinity`), air's viscosity.
 * @throws MargoError (code `unsupported`) for a field that is not air, or an option out of range, naming the fix.
 */
export function segmentAirLoads(air: FlowField, options: SegmentAirLoadOptions = {}): SegmentLoads {
  if (!air || typeof air.sample !== 'function' || air.medium !== 'air')
    throw invalidLoad("Segment air loads need a wind: pass a FlowField of medium 'air' (an ATMO wind or your own).");
  const { density = STANDARD_AIR.density, ...rest } = options;
  if (!(density > 0 && Number.isFinite(density)))
    throw invalidLoad(`The air's density is above 0 (got ${density}); pass kg/m^3, or leave it out for 1.225.`);
  return segmentLoads(
    // The loads only sample the medium's velocity and density, so a wind stands where the water would, under a surface
    // a light year up (finite, as the water's acceleration needs, and above anything a scene holds).
    { density, elevation: () => 9.46e15, water: air as unknown as LoadWater['water'] },
    { period: Number.POSITIVE_INFINITY, viscosity: STANDARD_AIR.viscosity, ...rest },
  );
}

/** Options of {@link swayFlow}. */
export interface SwayOptions {
  /** The sway's peak speed, m/s. */
  readonly speed: number;
  /** The slowest gust's period, s (default 6); two faster ones ride on it at 0.53 and 0.29 of it. */
  readonly period?: number;
  /** The seed: the same seed gives the same sway, bit for bit (default 1). */
  readonly seed?: number;
  /** The direction it sways along, horizontal (default [1, 0, 0]); each gust turns up to 30 degrees off it. */
  readonly direction?: readonly [number, number, number];
  /** The distance over which the sway's phase turns once, m (default 30): neighbouring stalks sway nearly together. */
  readonly wavelength?: number;
  /** What it moves (default 'water'): it only adds to the loads' flows, which take any medium. */
  readonly medium?: 'air' | 'water';
}

/** Mulberry32 (Tommy Ettinger, 2017): a 32-bit generator of integer operations only, the same on every engine. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A seeded sway: a director's flow that moves kelp, grass, vines and hanging cables gently and never the same way twice,
 * for {@link SegmentLoadOptions.flows} (on a rod's water or air loads). Three gusts of falling weight (0.6, 0.3, 0.1 of
 * `speed`), periods `period`, 0.53 and 0.29 of it (no common beat), each turned off `direction` and phased by the seed, and
 * each travelling along its direction with a `wavelength`, so a field of stalks sways as a wave crosses it. Its mean is
 * zero: it sways about the flow the scene already has. It is film direction, not a measured gust spectrum.
 * @throws MargoError (code `unsupported`) for a speed, period, wavelength or direction out of range.
 */
export function swayFlow(options: SwayOptions): FlowField {
  const {
    speed,
    period = 6,
    seed = 1,
    direction = [1, 0, 0],
    wavelength = 30,
    medium = 'water',
  } = options ?? ({} as SwayOptions);
  if (!(speed >= 0 && Number.isFinite(speed)))
    throw invalidLoad(`A sway's speed is 0 or more m/s (got ${speed}); pass one.`);
  if (!(period > 0 && Number.isFinite(period)))
    throw invalidLoad(`A sway's period is above 0 s (got ${period}); pass one.`);
  if (!(wavelength > 0))
    throw invalidLoad(`A sway's wavelength is above 0 m (got ${wavelength}); pass one, or Infinity.`);
  const across = hypot(direction[0], 0, direction[2]);
  if (!(across > 0)) throw invalidLoad('A sway moves along a horizontal direction; pass one with an x or z part.');
  const random = seeded(Number.isSafeInteger(seed) ? seed : 1),
    base = atan2(direction[2], direction[0]),
    gusts = [0.6, 0.3, 0.1].map((weight, k) => {
      const angle = base + (random() * 2 - 1) * (Math.PI / 6),
        dx = cos(angle),
        dz = sin(angle);
      return {
        weight: weight * speed,
        omega: (2 * Math.PI) / (period * [1, 0.53, 0.29][k]!),
        phase: random() * 2 * Math.PI,
        dx,
        dz,
        k: (2 * Math.PI) / wavelength,
      };
    });
  const cell: FlowCell = [0, 0, 0];
  return {
    medium,
    cell,
    sample(
      x: number,
      _y: number,
      z: number,
      t: number,
      out: FlowSample = { velocity: [0, 0, 0], density: 0, temperature: 0 },
    ) {
      let u = 0,
        w = 0;
      for (const g of gusts) {
        const v = g.weight * sin(g.omega * t + g.phase - g.k * (g.dx * x + g.dz * z));
        u += v * g.dx;
        w += v * g.dz;
      }
      out.velocity[0] = u;
      out.velocity[1] = 0;
      out.velocity[2] = w;
      out.density = 0;
      out.temperature = 0;
      return out;
    },
  };
}
