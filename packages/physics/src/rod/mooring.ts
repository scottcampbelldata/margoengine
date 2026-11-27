// A mooring line or anchor chain as lumped masses (Hall and Goupee 2015's lumped-mass mooring model, the method of MoorDyn):
// the line's mass in nodes, each segment between two nodes an axial spring that takes tension only (a chain or rope goes slack
// rather than pushing), with internal damping while taut; the water's loads per segment by Morison's equation on the
// segment's own normal and tangent (buoyancy of its wetted length, drag across and along, added mass across); and the seabed
// as a floor the nodes cannot pass, with Coulomb friction along and across the line on what rests there. Clump weights add
// mass and volume at a node. A segment pulled past the line's breaking load parts for good, so the line breaks where its
// tension is highest. Snap loads come of themselves: a slack line pulled taut stops what it holds within a segment's stretch.
//
// It steps itself in substeps the axial springs keep stable (explicit, semi-implicit Euler); the seabed and its friction are
// exact per substep: a node reaching the bed loses its speed into it, and friction takes off the speed along the bed up to
// mu times the bed's push over the substep, so a node stays where friction holds it.
import type { Vec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import type { FlowSample } from '@margoengine/math/fields';
import { hypot } from '@margoengine/math/pinned';
import type { LoadWater } from '../loads/solver.js';
import { waterAcceleration, waterVelocity } from '../loads/water.js';

function invalid(message: string): MargoError {
  return new MargoError('unsupported', `${message} See https://margoengine.com/errors#rods`);
}

type V = [number, number, number];

/** A weight or a float fixed on the line (a clump weight, a buoy). */
export interface MooringClump {
  /** The node it hangs at, from 0 at the line's start to `segments` at its end. */
  readonly node: number;
  /** Its mass, kg. */
  readonly mass: number;
  /** Its displaced volume, m^3 (default 0); a buoy displaces more than its mass. */
  readonly volume?: number;
}

/** The seabed: a horizontal floor at height `y`, with friction. */
export interface MooringSeabed {
  /** The bed's height, m (default 0). */
  readonly y?: number;
  /** Friction coefficient along the line (default 0). */
  readonly friction?: number;
  /** Friction coefficient across the line (default the one along). */
  readonly lateralFriction?: number;
}

export interface MooringLineOptions {
  /** Where the line starts (the anchor) and ends (the fairlead), m. */
  readonly start: Vec3;
  readonly end: Vec3;
  /** The line's unstretched length, m; it starts laid as a straight line or, longer than the span, as a parabola below it. */
  readonly length: number;
  /** Mass per unstretched metre, kg/m. */
  readonly massPerLength: number;
  /** Axial stiffness EA, N. */
  readonly axialStiffness: number;
  /** Number of segments (default 40). */
  readonly segments?: number;
  /** Density of its material, kg/m^3 (default 7850, steel): its volume is its mass over that. */
  readonly density?: number;
  /** Diameter the drag acts on, m (default the diameter of a rod of its volume). */
  readonly diameter?: number;
  /** Drag coefficients across and along the line (defaults 1.2 and 0.008, a rope; a chain is about 2.4 and 1.15 on its bar diameter). */
  readonly drag?: { readonly normal?: number; readonly tangential?: number };
  /** Added mass coefficient across the line, on its volume (default 1). */
  readonly addedMass?: number;
  /** Damping of the axial spring while taut, as a fraction of critical for one segment's stretch (default 0.5). */
  readonly damping?: number;
  /** Tension at which a segment parts, N (default none). */
  readonly breakingLoad?: number;
  /** The water the line hangs in (a SeaSurface, or `{elevation, water, density}`); default none, the line in air. */
  readonly water?: LoadWater;
  /** The seabed (default none). */
  readonly seabed?: MooringSeabed;
  /** Weights and floats on the line. */
  readonly clumps?: readonly MooringClump[];
  /** Which ends are held: their positions are set with `setEnd` (default both). */
  readonly fixed?: 'start' | 'end' | 'both' | 'none';
  /** Gravity, m/s^2 (default [0, -9.81, 0]). */
  readonly gravity?: Vec3;
  /** Every free node's velocity at the start, m/s (default at rest). */
  readonly velocity?: Vec3;
}

const sub = (a: readonly number[], b: readonly number[]): V => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

/**
 * A mooring line, anchor chain or cable as lumped masses on tension-only springs, in water and on a seabed with friction.
 * Hold its ends with `setEnd` (a fairlead that moves), step it with `step(dt)`, and read `tension(i)`, `endForce(end)`,
 * `position(i)` and `broken`.
 * @throws MargoError (code `unsupported`) for a length, mass, stiffness or segment count out of range, a clump on no node,
 * or a line shorter than the span between its ends, naming the fix.
 */
export class MooringLine {
  /** Segments of the line. */
  readonly segments: number;
  /** The segment that parted, or -1 while the line is whole. */
  broken = -1;
  private readonly x: Float64Array;
  private readonly v: Float64Array;
  private readonly force: Float64Array;
  /** Each node's mass and displaced volume (the line's share and its clumps'), kg and m^3. */
  private readonly mass: Float64Array;
  private readonly volume: Float64Array;
  private readonly tensions: Float64Array;
  /** The load on each held end's node in the last substep (its segment's pull, its weight and the water's), N. */
  private readonly ends = new Float64Array(6);
  private readonly rest: number;
  private readonly k: number;
  private readonly c: number;
  private readonly area: number;
  private readonly diameter: number;
  private readonly cdn: number;
  private readonly cdt: number;
  private readonly can: number;
  private readonly breaking: number;
  private readonly gravity: V;
  private readonly bed?: { y: number; mu: number; lateral: number };
  private readonly water?: LoadWater;
  private readonly hold: [boolean, boolean];
  private readonly sample: FlowSample = { velocity: [0, 0, 0], density: 0, temperature: 0 };
  private readonly u: V = [0, 0, 0];
  private readonly a: V = [0, 0, 0];
  private time = 0;
  /** The largest substep the axial springs keep stable, s. */
  readonly stableStep: number;

  constructor(options: MooringLineOptions) {
    const { start, end, length, massPerLength, axialStiffness } = options ?? ({} as MooringLineOptions);
    const n = options?.segments ?? 40;
    if (!Number.isInteger(n) || n < 2 || n > 4096)
      throw invalid('A mooring line has 2 to 4096 segments; pass a whole number in that range.');
    if (![...(start ?? []), ...(end ?? [])].every(Number.isFinite) || start?.length !== 3 || end?.length !== 3)
      throw invalid('A mooring line needs a start and an end, each [x, y, z] in metres; pass them.');
    for (const [name, value] of [
      ['length', length],
      ['massPerLength', massPerLength],
      ['axialStiffness', axialStiffness],
    ] as const)
      if (!(value > 0 && Number.isFinite(value)))
        throw invalid(`A mooring line's ${name} is above 0 and finite; pass one.`);
    const span = sub(end, start),
      reach = hypot(span[0], span[1], span[2]);
    if (length < reach * (1 - 1e-9))
      throw invalid(
        `A mooring line of ${length} m cannot reach between ends ${reach} m apart unstretched; lengthen it or bring the ends closer.`,
      );
    const density = options.density ?? 7850,
      damping = options.damping ?? 0.5,
      drag = options.drag ?? {};
    for (const [name, value] of [
      ['density', density],
      ['damping', damping],
      ['drag.normal', drag.normal ?? 1.2],
      ['drag.tangential', drag.tangential ?? 0.008],
      ['addedMass', options.addedMass ?? 1],
    ] as const)
      if (!(value >= 0 && Number.isFinite(value)) || (name === 'density' && value === 0))
        throw invalid(`A mooring line's ${name} is a finite number of 0 or more (density above 0); pass one.`);
    this.segments = n;
    this.rest = length / n;
    this.k = axialStiffness / this.rest;
    this.area = massPerLength / density;
    this.diameter = options.diameter ?? Math.sqrt((4 * this.area) / Math.PI);
    this.cdn = drag.normal ?? 1.2;
    this.cdt = drag.tangential ?? 0.008;
    this.can = options.addedMass ?? 1;
    this.breaking = options.breakingLoad ?? Infinity;
    if (!(this.breaking > 0)) throw invalid("A mooring line's breaking load is above 0 N; pass one, or leave it out.");
    this.gravity = options.gravity ? [options.gravity[0], options.gravity[1], options.gravity[2]] : [0, -9.81, 0];
    this.water = options.water;
    if (options.seabed) {
      const mu = options.seabed.friction ?? 0,
        lateral = options.seabed.lateralFriction ?? mu;
      if (!(mu >= 0 && lateral >= 0 && Number.isFinite(mu + lateral)))
        throw invalid("A seabed's friction is a finite number of 0 or more; pass one.");
      this.bed = { y: options.seabed.y ?? 0, mu, lateral };
    }
    const fixed = options.fixed ?? 'both';
    this.hold = [fixed === 'start' || fixed === 'both', fixed === 'end' || fixed === 'both'];
    this.x = new Float64Array(3 * (n + 1));
    this.v = new Float64Array(3 * (n + 1));
    this.force = new Float64Array(3 * (n + 1));
    this.mass = new Float64Array(n + 1);
    this.volume = new Float64Array(n + 1);
    this.tensions = new Float64Array(n);
    const segmentMass = massPerLength * this.rest;
    for (let i = 0; i <= n; i++) {
      const share = i === 0 || i === n ? 0.5 : 1;
      this.mass[i] = share * segmentMass;
      this.volume[i] = share * this.area * this.rest;
    }
    for (const clump of options.clumps ?? []) {
      if (!Number.isInteger(clump?.node) || clump.node < 0 || clump.node > n)
        throw invalid(`A clump hangs at a node from 0 to ${n}; pass one.`);
      if (!(clump.mass >= 0 && (clump.volume ?? 0) >= 0 && Number.isFinite(clump.mass + (clump.volume ?? 0))))
        throw invalid("A clump's mass and volume are finite numbers of 0 or more; pass them.");
      this.mass[clump.node]! += clump.mass;
      this.volume[clump.node]! += clump.volume ?? 0;
    }
    // Laid as a straight line between the ends, or, longer than the span, as a parabola sagging below it by the depth that
    // gives its length (s ~ c + 8 d^2 / (3 c)), cut off at the seabed.
    const sag = length > reach ? Math.sqrt((3 * reach * (length - reach)) / 8) : 0;
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      for (let a = 0; a < 3; a++) this.x[3 * i + a] = start[a]! + f * span[a]!;
      this.x[3 * i + 1]! -= 4 * sag * f * (1 - f);
      if (this.bed && this.x[3 * i + 1]! < this.bed.y) this.x[3 * i + 1] = this.bed.y;
    }
    const v0 = options.velocity ?? [0, 0, 0];
    if (!v0.every(Number.isFinite)) throw invalid("A mooring line's starting velocity is finite; pass m/s.");
    for (let i = 0; i <= n; i++)
      if (!((i === 0 && this.hold[0]) || (i === n && this.hold[1]))) this.v.set([v0[0], v0[1], v0[2]], 3 * i);
    // One segment's axial mode, two nodes of its mass on a spring of stiffness k: the substep and the damping follow from it.
    let lightest = Infinity;
    for (let i = 0; i <= n; i++) lightest = Math.min(lightest, this.mass[i]!);
    // Semi-implicit Euler holds an undamped spring below 2 / omega; the damping, explicit too, takes from that margin.
    const omega = Math.sqrt((2 * this.k) / lightest);
    this.stableStep = 1 / (omega * (1 + 2 * damping));
    this.c = damping * 2 * Math.sqrt(this.k * segmentMass);
  }

  /** Puts a held end at `position` with velocity `velocity` (default the change from where it was, over the next step). */
  setEnd(end: 'start' | 'end', position: Vec3, velocity?: Vec3): void {
    const i = end === 'start' ? 0 : this.segments;
    if (!this.hold[end === 'start' ? 0 : 1]) throw invalid(`The line's ${end} is free; hold it with fixed to set it.`);
    if (!position.every(Number.isFinite)) throw invalid('Set a line end to a finite position.');
    for (let a = 0; a < 3; a++) {
      this.pending[3 * (i === 0 ? 0 : 1) + a] = position[a]!;
      this.pendingVelocity[3 * (i === 0 ? 0 : 1) + a] = velocity?.[a] ?? Number.NaN;
    }
  }
  private readonly pending = new Float64Array(6).fill(Number.NaN);
  private readonly pendingVelocity = new Float64Array(6).fill(Number.NaN);

  /** Steps the line `dt` seconds, in as many substeps as its springs need. */
  step(dt: number): void {
    if (!(dt > 0 && Number.isFinite(dt))) throw invalid('Step a mooring line by a finite time above 0 s.');
    const steps = Math.ceil(dt / this.stableStep),
      h = dt / steps,
      n = this.segments;
    // Held ends move in a straight line to where they were set over the step, at the speed that takes them there.
    const from = [0, 1].map((e) => [...this.x.subarray(3 * e * n, 3 * e * n + 3)]),
      endVelocity = [0, 1].map((e) =>
        [0, 1, 2].map((a) => {
          const to = this.pending[3 * e + a]!;
          if (Number.isNaN(to)) return 0;
          const given = this.pendingVelocity[3 * e + a]!;
          return Number.isNaN(given) ? (to - from[e]![a]!) / dt : given;
        }),
      );
    for (let s = 0; s < steps; s++) {
      for (const e of [0, 1]) {
        if (!this.hold[e]) continue;
        const i = e * n;
        for (let a = 0; a < 3; a++) {
          const to = this.pending[3 * e + a]!,
            f = (s + 1) / steps;
          this.v[3 * i + a] = endVelocity[e]![a]!;
          if (!Number.isNaN(to)) this.x[3 * i + a] = from[e]![a]! + f * (to - from[e]![a]!);
        }
      }
      this.substep(h);
      this.time += h;
    }
    this.pending.fill(Number.NaN);
    this.pendingVelocity.fill(Number.NaN);
  }

  private substep(h: number): void {
    const n = this.segments,
      x = this.x,
      v = this.v,
      F = this.force,
      g = this.gravity,
      water = this.water,
      rho = water?.density ?? 0;
    F.fill(0);
    // Added mass across each segment, summed at its nodes: each node's mass matrix m I + sum a (I - t t^T), kept as its six
    // entries (xx, yy, zz, xy, xz, yz).
    const matrix = new Float64Array(6 * (n + 1));
    for (let i = 0; i <= n; i++) {
      matrix[6 * i] = matrix[6 * i + 1] = matrix[6 * i + 2] = this.mass[i]!;
      // Weight and the buoyancy of what is under water at the node (a clump's or a share of the line's), by its own depth.
      const wet = water ? (water.elevation(x[3 * i]!, x[3 * i + 2]!, this.time) > x[3 * i + 1]! ? 1 : 0) : 0;
      for (let a = 0; a < 3; a++) F[3 * i + a]! += (this.mass[i]! - rho * wet * this.volume[i]!) * g[a]!;
    }
    for (let i = 0; i < n; i++) {
      const p = 3 * i,
        q = p + 3,
        d: V = [x[q]! - x[p]!, x[q + 1]! - x[p + 1]!, x[q + 2]! - x[p + 2]!],
        l = hypot(d[0], d[1], d[2]);
      if (!(l > 0)) continue;
      const t: V = [d[0] / l, d[1] / l, d[2] / l],
        dv: V = [v[q]! - v[p]!, v[q + 1]! - v[p + 1]!, v[q + 2]! - v[p + 2]!],
        stretch = l - this.rest;
      // Tension only: a slack segment carries nothing; taut, its spring and its damping, never pushing.
      let T = 0;
      if (this.broken !== i && stretch > 0) T = Math.max(0, this.k * stretch + this.c * dot(dv, t));
      if (T > this.breaking && this.broken < 0) {
        this.broken = i;
        T = 0;
      }
      this.tensions[i] = T;
      for (let a = 0; a < 3; a++) {
        F[p + a]! += T * t[a]!;
        F[q + a]! -= T * t[a]!;
      }
      if (!water) continue;
      // The water's loads on the wetted part of the segment, by the depth of each end (the surface straight across it).
      const d0 = water.elevation(x[p]!, x[p + 2]!, this.time) - x[p + 1]!,
        d1 = water.elevation(x[q]!, x[q + 2]!, this.time) - x[q + 1]!;
      if (d0 <= 0 && d1 <= 0) continue;
      const lo = d0 < 0 ? -d0 / (d1 - d0) : 0,
        hi = d1 < 0 ? d0 / (d0 - d1) : 1,
        wet = (hi - lo) * l,
        mid = (lo + hi) / 2,
        at: V = [x[p]! + d[0] * mid, x[p + 1]! + d[1] * mid, x[p + 2]! + d[2] * mid],
        u = waterVelocity(water, [], at[0], at[1], at[2], this.time, this.sample, this.u),
        acc = waterAcceleration(water, [], at[0], at[1], at[2], this.time, this.sample, this.a),
        vm: V = [0, 1, 2].map((a) => v[p + a]! + mid * dv[a]!) as V,
        vr = sub(u, vm),
        along = dot(vr, t),
        vn: V = [vr[0] - along * t[0], vr[1] - along * t[1], vr[2] - along * t[2]],
        speedN = hypot(vn[0], vn[1], vn[2]),
        aAlong = dot(acc, t),
        an: V = [acc[0] - aAlong * t[0], acc[1] - aAlong * t[1], acc[2] - aAlong * t[2]],
        // The segment's wetted volume (its unstretched share of the material, by the fraction wet) and its added mass.
        share = (hi - lo) * this.area * this.rest,
        added = this.can * rho * share,
        f: V = [0, 0, 0];
      for (let a = 0; a < 3; a++)
        f[a] =
          0.5 * rho * this.cdn * this.diameter * wet * speedN * vn[a]! +
          0.5 * rho * this.cdt * this.diameter * wet * Math.abs(along) * along * t[a]! +
          rho * share * acc[a]! +
          added * an[a]!;
      for (let a = 0; a < 3; a++) {
        F[p + a]! += f[a]! * (1 - mid);
        F[q + a]! += f[a]! * mid;
      }
      for (const [node, weight] of [
        [i, 1 - mid],
        [i + 1, mid],
      ] as const) {
        const m = added * weight,
          o = 6 * node;
        matrix[o]! += m * (1 - t[0] * t[0]);
        matrix[o + 1]! += m * (1 - t[1] * t[1]);
        matrix[o + 2]! += m * (1 - t[2] * t[2]);
        matrix[o + 3]! -= m * t[0] * t[1];
        matrix[o + 4]! -= m * t[0] * t[2];
        matrix[o + 5]! -= m * t[1] * t[2];
      }
    }
    // What holds an end carries its node's load; each free node's velocity from its forces through its mass matrix; then the
    // seabed.
    this.ends.set(F.subarray(0, 3), 0);
    this.ends.set(F.subarray(3 * n, 3 * n + 3), 3);
    for (let i = 0; i <= n; i++) {
      if ((i === 0 && this.hold[0]) || (i === n && this.hold[1])) continue;
      const o = 6 * i,
        [xx, yy, zz, xy, xz, yz] = [
          matrix[o]!,
          matrix[o + 1]!,
          matrix[o + 2]!,
          matrix[o + 3]!,
          matrix[o + 4]!,
          matrix[o + 5]!,
        ],
        c00 = yy * zz - yz * yz,
        c01 = xz * yz - xy * zz,
        c02 = xy * yz - xz * yy,
        c11 = xx * zz - xz * xz,
        c12 = xy * xz - xx * yz,
        c22 = xx * yy - xy * xy,
        det = xx * c00 + xy * c01 + xz * c02,
        fx = F[3 * i]!,
        fy = F[3 * i + 1]!,
        fz = F[3 * i + 2]!;
      v[3 * i]! += (h * (c00 * fx + c01 * fy + c02 * fz)) / det;
      v[3 * i + 1]! += (h * (c01 * fx + c11 * fy + c12 * fz)) / det;
      v[3 * i + 2]! += (h * (c02 * fx + c12 * fy + c22 * fz)) / det;
      if (this.bed) this.seabed(i, h);
    }
    for (let i = 0; i <= n; i++) {
      if ((i === 0 && this.hold[0]) || (i === n && this.hold[1])) continue;
      for (let a = 0; a < 3; a++) x[3 * i + a]! += h * v[3 * i + a]!;
    }
  }

  /**
   * Node `i` against the seabed: where its step would take it into the bed, the speed into it goes, and the bed's push for
   * that, over the substep, holds back the speed along the bed by friction, along the line and across it each by its own
   * coefficient (a node stays where friction holds it, and slides losing mu times the push).
   */
  private seabed(i: number, h: number): void {
    const bed = this.bed!,
      x = this.x,
      v = this.v;
    if (x[3 * i + 1]! + h * v[3 * i + 1]! >= bed.y) return;
    // The speed that lands it on the bed this substep; what the bed takes away is its push over the substep, over the mass.
    const landing = (bed.y - x[3 * i + 1]!) / h,
      into = landing - v[3 * i + 1]!;
    v[3 * i + 1] = landing;
    // The line's direction along the bed at the node (from its neighbours), and across it.
    const n = this.segments,
      before = Math.max(0, i - 1),
      after = Math.min(n, i + 1),
      dx = x[3 * after]! - x[3 * before]!,
      dz = x[3 * after + 2]! - x[3 * before + 2]!,
      len = hypot(dx, 0, dz),
      ax = len > 0 ? dx / len : 1,
      az = len > 0 ? dz / len : 0,
      vAlong = v[3 * i]! * ax + v[3 * i + 2]! * az,
      vAcross = -v[3 * i]! * az + v[3 * i + 2]! * ax,
      // Friction along and across, each up to its share of mu times the push; on an isotropic bed together up to mu.
      speed = hypot(vAlong, 0, vAcross);
    if (!(speed > 0)) return;
    const along = Math.max(0, Math.abs(vAlong) - (bed.mu * into * Math.abs(vAlong)) / speed) * Math.sign(vAlong),
      across = Math.max(0, Math.abs(vAcross) - (bed.lateral * into * Math.abs(vAcross)) / speed) * Math.sign(vAcross);
    v[3 * i] = along * ax - across * az;
    v[3 * i + 2] = along * az + across * ax;
  }

  /** Node `i`'s position, m. */
  position(i: number): Vec3 {
    this.node(i);
    return [this.x[3 * i]!, this.x[3 * i + 1]!, this.x[3 * i + 2]!];
  }
  /** Node `i`'s velocity, m/s. */
  velocity(i: number): Vec3 {
    this.node(i);
    return [this.v[3 * i]!, this.v[3 * i + 1]!, this.v[3 * i + 2]!];
  }
  /** Segment `i`'s tension in the last substep, N (0 slack or parted). */
  tension(i: number): number {
    if (!Number.isInteger(i) || i < 0 || i >= this.segments)
      throw invalid(`Read a segment from 0 to ${this.segments - 1}.`);
    return this.tensions[i]!;
  }
  /**
   * The load of the line on what holds `end` in the last substep, N: its end segment's pull and the end node's own weight
   * and water loads (the node's inertia, a held end's being the holder's, is not in it).
   */
  endForce(end: 'start' | 'end'): Vec3 {
    const o = end === 'start' ? 0 : 3;
    return [this.ends[o]!, this.ends[o + 1]!, this.ends[o + 2]!];
  }
  /** Every node's position, packed x, y, z. */
  points(): Float64Array {
    return this.x.slice();
  }

  private node(i: number): void {
    if (!Number.isInteger(i) || i < 0 || i > this.segments) throw invalid(`Read a node from 0 to ${this.segments}.`);
  }
}
