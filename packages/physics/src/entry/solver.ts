// Bodies going into the water and coming out of it (SEA-14) as a solver of the physics framework (docs/physics-framework.md,
// sections 4 and 5): a cannonball, a diver, a launched hull, a whale breaching and falling back. Each step it reads where
// each body is from the rigid solver's `bodies` port and holds it, over the rigid solver's next step through `bodyForces`,
// with the water's load:
// - the pressure of the sea itself over the wetted surface (seakeeping's `wettedLoads`: hydrostatic and the waves'
//   Froude-Krylov pressure), except over the part of the body inside an open air cavity, where the pressure is the
//   air's (0 gauge): the contact line is pinned at the widest section (Duclaux et al. 2007);
// - the water's impact on the faces that move into it, 1/2 rho (U . n)^2 on each (Birkhoff et al. 1944, as W. Johnson and
//   S. R. Reid, J. Mech. Eng. Sci. 17, 71-81, 1975, and I. M. Hutchings, Int. J. Mech. Sci. 18, 243-248, 1976, use it
//   for the ricochet of spheres; the same pressure gives a sphere's drag of about 0.5 and a cavity-running drag), with the
//   velocity relative to the water's own (a wave's orbital motion);
// - the slam as it strikes (slam.ts): along the surface's normal, the larger of the modified Logvinovich model's force and
//   the impact pressure's, while Wagner's wetted radius is inside the widest section;
// - the water it carries: the wetted disc's added mass (4/3) rho c^3 along the normal while it strikes, and its added mass
//   under water (H. Lamb, Hydrodynamics, 6th ed., 1932, section 373, for the spheroid of its length and breadth) for the
//   share of it under water, through the same solve as the hull solver's, F_held = M (M + A)^-1 (F + W) - W.
// Under water and with no cavity, a body longer than twice its breadth takes S. F. Hoerner's streamlined drag (Fluid-Dynamic
// Drag, 1965, ch. 6: C_D = C_f (1 + 1.5 (d/l)^1.5 + 7 (d/l)^3) on its wetted area, C_f the ITTC 1957 line) in place of the
// impact pressure, which overstates a slender body's.
//
// It also reports what it does to the water (cavity.ts for the air cavity):
// - splashes, as events: the entry (the crown sheet thrown at the cavity's opening speed), the deep seal (the Worthington
//   jet), the exit (the water riding up with the body), a skip (a ricochet);
// - the volume it pushes into the surface each step (`seaSources`): the water the body and its open cavity displace,
//   taken out where it went in and put back around it (P. Ward and E. Asphaug, Icarus 145, 64-78, 2000: a transient
//   cavity's water in its rim), for a WakeSolver's `sources`, so the entry and the cavity's collapse make their waves;
// - foam where it splashes, through a FoamSolver's `addFoam`.
//
// State: per body, its phase, where and how it went in, its cavity's sections and its events; snapshot, restore and hash
// with the world.
import { MargoError } from '@margoengine/math/errors';
import type { SeaSource, SeaSurface, SeaSurfaceSample } from '@margoengine/math/fields';
import { hypot, ln, pow } from '@margoengine/math/pinned';
import {
  type FieldDescriptor,
  type Port,
  type RateLevel,
  type Region,
  rateOf,
  type Solver,
  type SolverDescription,
  type SolverHost,
  type StepContext,
} from '../world/solver.js';
import { regionWords } from '../world/memory.js';
import { BODIES_FIELD, BODY_FORCES_FIELD, BODY_WORDS, bodyRowsOf, FORCE_WORDS } from '../world/solvers/rigid.js';
import { type HullMesh, type SeaQuery, wettedLoads, type WettedLoads } from '../seakeeping/wetted.js';
import { entryCavityField, ENTRY_CAVITY_LAYOUT, ENTRY_CAVITY_WORDS } from './cavity-port.js';
import { CAVITY_ALPHA, cavityThreshold, constantSpeedPinch, SECTION_WORDS, sectionRadius2 } from './cavity.js';
import { slam, slamProfile, type Slam } from './slam.js';

type Vec3 = readonly [number, number, number];
type V3 = [number, number, number];

/** A body that may go into the water: its kernel body row, its closed surface in the body's frame (wound outward). */
export interface EntryBody {
  readonly row: number;
  readonly mesh: HullMesh;
  /** Its surface's contact angle with water, degrees (default 30, a wetting surface; above 90 water-repellent). */
  readonly contactAngle?: number;
  /** Follow the rigid body for cavity, splash and foam. Another solver supplies its loads and displacement. Default false. */
  readonly effectsOnly?: boolean;
}

/** Something that takes foam over a box: a FoamSolver of `@margoengine/physics/foam`. */
export interface EntryFoam {
  addFoam(
    min: readonly [number, number],
    max: readonly [number, number],
    whiteness?: number,
    persistence?: number,
  ): void;
}

/** What an {@link EntrySolver} is made from. */
export interface EntryParams {
  /** The bodies, each on its own body row. */
  readonly bodies: readonly EntryBody[];
  /**
   * The water: a `SeaSurface` (`SpectralSea` of `@margoengine/physics/sea`, its waves and their motion) in the solver's
   * origin cell, or anything with `elevation` (still water then moves with no orbital velocity).
   */
  readonly sea: SeaSurface | SeaQuery;
  /** The solver's rate level, 60 * 2^level steps a second (default 0); step with the rigid solver. */
  readonly level?: RateLevel;
  /**
   * Body rows its `bodyForces` port covers: the world's (`PhysicsWorld.bodyRows`, the rigid world's capacity), which it reads;
   * given, it must be the same.
   */
  readonly capacity?: number;
  /** The water's surface tension, N/m (default 0.072), and dynamic viscosity, Pa s (default 1.0e-3). */
  readonly surfaceTension?: number;
  readonly viscosity?: number;
  /** Lays foam where the bodies splash (default none). */
  readonly foam?: EntryFoam;
  /** Splash events kept, the most recent (default 64). */
  readonly events?: number;
}

/** What happened at the water, from {@link EntrySolver.splashes}. */
export interface EntrySplash {
  /** 'entry' (goes in), 'seal' (its cavity pinches and throws its jet), 'exit' (comes out), 'skip' (glances off). */
  kind: 'entry' | 'seal' | 'exit' | 'skip';
  /** The body's row. */
  row: number;
  /** World time, s. */
  time: number;
  /** Where, on the surface, m from the solver's cell. */
  position: V3;
  /** The body's velocity relative to the water there, m/s. */
  velocity: V3;
  /** Its speed, m/s. */
  speed: number;
  /** The sine of its angle to the surface (1 straight down or up). */
  sine: number;
  /** The body's widest radius across its path, m. */
  radius: number;
  /** The crown sheet's speed and the height its drops reach (an entry or a skip), m/s and m. */
  crownSpeed: number;
  crownHeight: number;
  /** The column's speed and height (the jet of a seal, the water lifted by an exit), m/s and m. */
  columnSpeed: number;
  columnHeight: number;
  /** An entry's cavity: true when it drags one down. */
  cavity: boolean;
}

/** Sea water's surface tension, N/m (about 15 degrees C). */
export const WATER_SURFACE_TENSION = 0.072;
/** Sea water's dynamic viscosity, Pa s (about 15 degrees C). */
export const WATER_VISCOSITY = 1.0e-3;
/**
 * The Worthington jet's speed as a share of the entry speed: 9.85, from S. Gekle and J. M. Gordillo's golf ball (20 m/s
 * from 2.03 m/s; J. Fluid Mech. 663, 2010). Calibrated on that sphere; their 22 mm disc threw 12.3 times its speed.
 */
export const JET_SPEED_RATIO = 9.85;
/** Terminal speeds of 2 mm and 5 mm drops in air, m/s (Gunn and Kinzer 1949): the crown's and the column's. */
const CROWN_DROP_FALL = 6.5;
const COLUMN_DROP_FALL = 9.1;

/** The layout version of the solver's regions. */
const ENTRY_LAYOUT = 1;
/** f64 words of a body's state. */
const STATE_WORDS = 25;
/** Cavity sections per body. */
const SECTIONS = 64;
/** f64 words of an event. */
const EVENT_WORDS = 17;
/** Heights in a slam profile. */
const PROFILE_LEVELS = 40;

// State words of a body.
const PHASE = 0; // 0 in the air, 1 through the surface, 2 under
const ENTRY_TIME = 1;
const ENTRY_X = 2; // 2, 3, 4: where it went in, on the surface
const ENTRY_SPEED = 5;
const ENTRY_RADIUS = 6;
const CAVITY = 7; // 0 none, 1 open
const SECTION_COUNT = 8;
const SPACING = 9; // path between sections
const DISPLACED = 10; // what it displaced near the surface at its last step, m^3
const SUBMERGED_ONCE = 11; // 1 once wholly under since it went in
const LAST_X = 12; // 12, 13, 14: the last section's centre
const ENTRY_SINE = 15;
const ENTRY_VX = 16; // 16, 17, 18
const CROWN = 19; // the entry's crown speed
const SOURCE_X = 20; // 20, 21: where its sources go
const SOURCE_R = 22;
const SOURCE_V = 23; // the volume it moves this step
const EMERGED = 24; // 1 once its centre has come up out of the water from under, until it falls back or leaves

/** The water's load on bodies entering and leaving it, for the rigid solver through `bodyForces`. `id` is `'entry'`. */
export class EntrySolver implements Solver<EntryParams> {
  private host: SolverHost | null = null;
  private bodies: readonly EntryBody[] = [];
  private sea: SeaSurface | SeaQuery | null = null;
  private level: RateLevel = 0;
  private capacity = 0;
  private forces: Region | null = null;
  private cavityPressure: Region | null = null;
  private state: Region | null = null;
  private sections: Region | null = null;
  private log: Region | null = null;
  private eventCount = 64;
  private gamma = WATER_SURFACE_TENSION;
  private mu = WATER_VISCOSITY;
  private foam: EntryFoam | undefined;
  private g = 9.81;
  /** Per body, made once from its mesh: volume, extents along its principal box, Lamb's coefficients, triangles. */
  private shapes: {
    volume: number;
    length: number;
    breadth: number;
    axis: number;
    k1: number;
    k2: number;
    wetted: number;
  }[] = [];
  private readonly loads: WettedLoads = { force: [0, 0, 0], torque: [0, 0, 0], area: 0 };
  private readonly slamOut: Slam = { c: 0, rate: 0, force: 0, addedMass: 0 };
  private readonly surface: SeaSurfaceSample = {
    height: 0,
    normal: [0, 1, 0],
    velocity: [0, 0, 0],
    current: [0, 0, 0],
    depth: Infinity,
    density: 1025,
  };

  /** Open air cavity directions for observer bodies. Enable this field with the cavityPressure option. */
  readonly cavityPressureField: FieldDescriptor;

  constructor(
    readonly id = 'entry',
    private readonly options: { readonly cavityPressure?: boolean } = {},
  ) {
    this.cavityPressureField = entryCavityField(id);
  }

  describe(): SolverDescription {
    return {
      id: this.id,
      fields: [
        { field: BODIES_FIELD, access: 'read' },
        { field: BODY_FORCES_FIELD, access: 'accumulate' },
        ...(this.options.cavityPressure ? [{ field: this.cavityPressureField, access: 'write' as const }] : []),
      ],
      rate: this.level,
      stableRate: () => (this.host ? this.level : 0),
    };
  }

  /**
   * @throws TypeError without bodies or a sea; RangeError for a body row, mesh, contact angle, capacity, surface tension,
   * viscosity or event count out of range, each naming the fix.
   */
  init(host: SolverHost, params: EntryParams): void {
    const { bodies, sea, level = 0 } = params ?? ({} as EntryParams);
    if (!Array.isArray(bodies) || bodies.length === 0)
      throw new TypeError(
        'An EntrySolver takes one or more bodies; pass them: world.add(new EntrySolver(), {bodies: [{row, mesh}], sea}).',
      );
    if (!sea || typeof sea.elevation !== 'function')
      throw new TypeError('An EntrySolver needs the water, a sea with elevation(x, z, t); pass {sea}.');
    for (const body of bodies) {
      if (!(Number.isInteger(body.row) && body.row >= 0))
        throw new RangeError(`A body's row is a kernel body row (got ${body.row}); pass a whole number of 0 or more.`);
      const { vertices, indices } = body.mesh ?? {};
      if (!vertices || !indices || vertices.length % 3 !== 0 || indices.length % 3 !== 0 || indices.length === 0)
        throw new RangeError(
          "A body's mesh is not whole; pass vertices (three numbers each) and triangles (three indices each, wound outward).",
        );
      for (let k = 0; k < indices.length; k++)
        if (!(Number.isInteger(indices[k]) && indices[k]! >= 0 && indices[k]! < vertices.length / 3))
          throw new RangeError(
            `Body triangle index ${indices[k]} names no vertex of the ${vertices.length / 3}; keep each index under the vertex count.`,
          );
      const angle = body.contactAngle ?? 30;
      if (!(angle >= 0 && angle <= 180))
        throw new RangeError(`A contact angle is 0 to 180 degrees (got ${angle}); pass one.`);
    }
    const capacity = bodyRowsOf(
      host,
      'An EntrySolver',
      bodies.map((b) => b.row),
      params.capacity,
    );
    const gamma = params.surfaceTension ?? WATER_SURFACE_TENSION,
      mu = params.viscosity ?? WATER_VISCOSITY,
      events = params.events ?? 64;
    if (!(gamma > 0 && Number.isFinite(gamma)))
      throw new RangeError(`Surface tension is a finite number of N/m above 0 (got ${gamma}); pass one.`);
    if (!(mu > 0 && Number.isFinite(mu)))
      throw new RangeError(`Viscosity is a finite number of Pa s above 0 (got ${mu}); pass one.`);
    if (!(Number.isInteger(events) && events >= 1 && events <= 4096))
      throw new RangeError(`An EntrySolver keeps 1 to 4096 events (got ${events}); pass a whole number.`);
    if (params.foam !== undefined && typeof params.foam?.addFoam !== 'function')
      throw new TypeError('Foam goes through addFoam(min, max, whiteness, persistence); pass a FoamSolver or none.');
    const [gx, gy, gz] = host.gravity;
    this.g = hypot(gx, gy, gz);
    if (!(this.g > 0)) throw new RangeError('Water entry needs gravity; give the world a gravity above 0.');
    this.host = host;
    this.bodies = bodies;
    this.sea = sea;
    this.level = level;
    this.capacity = capacity;
    this.gamma = gamma;
    this.mu = mu;
    this.foam = params.foam;
    this.eventCount = events;
    this.shapes = bodies.map((b) => shapeOf(b.mesh));
    this.forces = host.allocate(`${this.id}:forces`, capacity * FORCE_WORDS * 8, 'f64', ENTRY_LAYOUT);
    if (this.options.cavityPressure)
      this.cavityPressure = host.allocate(
        this.cavityPressureField.name,
        capacity * ENTRY_CAVITY_WORDS * Float64Array.BYTES_PER_ELEMENT,
        'f64',
        ENTRY_CAVITY_LAYOUT,
      );
    this.state = host.allocate(`${this.id}:state`, bodies.length * STATE_WORDS * 8, 'f64', ENTRY_LAYOUT);
    this.sections = host.allocate(
      `${this.id}:sections`,
      bodies.length * SECTIONS * SECTION_WORDS * 8,
      'f64',
      ENTRY_LAYOUT,
    );
    // The event ring: how many were ever written, then the events.
    this.log = host.allocate(`${this.id}:events`, (1 + events * EVENT_WORDS) * 8, 'f64', ENTRY_LAYOUT);
  }

  private words(region: Region | null): Float64Array {
    if (!this.host || !region)
      throw new MargoError('state', 'EntrySolver is not in a world yet; add it with world.add(solver, {bodies, sea}).');
    return regionWords(this.host.memory, region) as Float64Array;
  }

  private sample(x: number, z: number, t: number): SeaSurfaceSample {
    const sea = this.sea!,
      s = this.surface;
    if ('sample' in sea && typeof sea.sample === 'function') return sea.sample(x, z, t, s);
    // A sea of heights alone: the normal from its slope, the water still.
    const e = 0.05,
      h = sea.elevation(x, z, t),
      sx = (sea.elevation(x + e, z, t) - sea.elevation(x - e, z, t)) / (2 * e),
      sz = (sea.elevation(x, z + e, t) - sea.elevation(x, z - e, t)) / (2 * e),
      n = hypot(sx, 1, sz);
    s.height = h;
    s.normal[0] = -sx / n;
    s.normal[1] = 1 / n;
    s.normal[2] = -sz / n;
    s.velocity[0] = s.velocity[1] = s.velocity[2] = 0;
    s.density = sea.density ?? 1025;
    return s;
  }

  step(context: StepContext, dt: number): void {
    const host = this.host;
    if (!host || !this.sea || !this.forces)
      throw new MargoError('state', 'EntrySolver is not in a world yet; add it with world.add(solver, {bodies, sea}).');
    const cell = (this.sea as Partial<SeaSurface>).cell;
    if (cell && (cell[0] !== context.cell[0] || cell[1] !== context.cell[1] || cell[2] !== context.cell[2]))
      throw new MargoError(
        'state',
        `The sea's origin cell is [${cell.join(', ')}] and the EntrySolver's is [${context.cell.join(', ')}]; make the sea in the solver's cell.`,
      );
    const out = this.words(this.forces);
    out.fill(0);
    const cavity = this.cavityPressure ? this.words(this.cavityPressure) : undefined;
    cavity?.fill(0);
    const port: Port | undefined = context.inputs.get(BODIES_FIELD.name);
    const state = this.words(this.state);
    for (let b = 0; b < this.bodies.length; b++) state[b * STATE_WORDS + SOURCE_V] = 0;
    if (!port) return;
    const memory = port.region.memory ?? host.memory,
      rows = new Float32Array(memory.buffer, port.region.byteOffset, port.region.byteLength / 4),
      t = (context.tick + 0.5) / rateOf(context.level);
    void dt;
    for (let b = 0; b < this.bodies.length; b++) {
      const body = this.bodies[b]!,
        at = body.row * BODY_WORDS;
      if (at + BODY_WORDS > rows.length || rows[at + 23] !== 1) continue;
      this.stepBody(b, body, rows, at, t, 1 / rateOf(context.level), out, cavity);
    }
  }

  private stepBody(
    b: number,
    body: EntryBody,
    rows: Float32Array,
    at: number,
    t: number,
    dt: number,
    out: Float64Array,
    cavity?: Float64Array,
  ) {
    const sea = this.sea!,
      state = this.words(this.state),
      s = b * STATE_WORDS,
      shape = this.shapes[b]!,
      // The pose at the middle of the step, carried on by the body's velocity and spin (as the hull solver takes it).
      v: V3 = [rows[at + 10]!, rows[at + 11]!, rows[at + 12]!],
      spin: V3 = [rows[at + 13]!, rows[at + 14]!, rows[at + 15]!],
      half = dt / 2,
      start = [rows[at + 3]!, rows[at + 4]!, rows[at + 5]!, rows[at + 6]!] as const,
      q = turn(start, spin, half),
      centre: V3 = [rows[at + 7]! + v[0] * half, rows[at + 8]! + v[1] * half, rows[at + 9]! + v[2] * half],
      offset = rotate(
        q,
        rotate(
          [-start[0], -start[1], -start[2], start[3]],
          [rows[at]! - rows[at + 7]!, rows[at + 1]! - rows[at + 8]!, rows[at + 2]! - rows[at + 9]!],
        ),
      ),
      origin: V3 = [centre[0] + offset[0], centre[1] + offset[1], centre[2] + offset[2]],
      { vertices, indices } = body.mesh,
      count = vertices.length / 3,
      world = new Float64Array(vertices.length);
    for (let i = 0; i < count; i++) {
      const p = rotate(q, [vertices[3 * i]!, vertices[3 * i + 1]!, vertices[3 * i + 2]!]);
      world[3 * i] = p[0] + origin[0];
      world[3 * i + 1] = p[1] + origin[1];
      world[3 * i + 2] = p[2] + origin[2];
    }
    // The local surface under the body: its height, normal and the water's velocity.
    const surf = this.sample(centre[0], centre[2], t),
      rho = surf.density > 0 ? surf.density : (sea.density ?? 1025),
      n: V3 = [surf.normal[0], surf.normal[1], surf.normal[2]],
      surfaceHeight = surf.height,
      p0: V3 = [centre[0], surf.height, centre[2]],
      level = n[0] * p0[0] + n[1] * p0[1] + n[2] * p0[2],
      vr: V3 = [v[0] - surf.velocity[0], v[1] - surf.velocity[1], v[2] - surf.velocity[2]],
      speed = hypot(vr[0], vr[1], vr[2]);
    let lowest = Infinity,
      highest = -Infinity,
      lowestAt = 0;
    for (let i = 0; i < count; i++) {
      const d = n[0] * world[3 * i]! + n[1] * world[3 * i + 1]! + n[2] * world[3 * i + 2]!;
      if (d < lowest) {
        lowest = d;
        lowestAt = i;
      }
      if (d > highest) highest = d;
    }
    const h = level - lowest,
      under = highest < level,
      phase = state[s + PHASE]!,
      vn = -(vr[0] * n[0] + vr[1] * n[1] + vr[2] * n[2]);
    // Out of the water: nothing to hold, but an exit or a skip as it leaves.
    if (h <= 0) {
      if (phase !== 0) this.leave(b, body, state, s, t, centre, vr, speed, vn, n, surf.height);
      state[s + PHASE] = 0;
      if (!body.effectsOnly) this.displace(state, s, 0, centre);
      return;
    }
    const centreUp = n[0] * centre[0] + n[1] * centre[1] + n[2] * centre[2] > level;
    if (phase === 0 || (state[s + EMERGED] === 1 && vn > 0 && !centreUp)) {
      // In from the air, or back in after breaking out, its centre coming down through the surface (a breaching whale
      // falling back on its flank): an entry.
      state[s + EMERGED] = 0;
      this.enter(b, body, state, s, t, world, indices, n, surfaceHeight, centre, vr, speed, vn);
    } else if (phase === 2 && !under && vn < 0) {
      // Out from under through the surface: the exit, the water riding up on it.
      this.breach(b, body, state, s, t, world, indices, centre, vr, speed, vn, surfaceHeight);
    }
    if (state[s + SUBMERGED_ONCE] === 1 && centreUp) state[s + EMERGED] = 1;
    state[s + PHASE] = under ? 2 : 1;
    if (under) state[s + SUBMERGED_ONCE] = 1;
    const R0 = state[s + ENTRY_RADIUS]!;
    // The cavity: sections opened as the widest section passes, and the pinch.
    let cavityVolume = 0;
    if (state[s + CAVITY] === 1) cavityVolume = this.cavity(b, state, s, t, centre, speed, R0, surfaceHeight);
    const open = state[s + CAVITY] === 1;
    // The sea's pressure over the wetted surface, the air's inside an open cavity: behind the plane through the centre
    // across the body's motion (its widest section, where the contact line is pinned).
    const ahead: V3 = speed > 0 ? [vr[0] / speed, vr[1] / speed, vr[2] / speed] : [0, -1, 0];
    if (body.effectsOnly) {
      if (open && cavity) cavity.set([1, ...ahead], body.row * ENTRY_CAVITY_WORDS);
      return;
    }
    const seaQuery: SeaQuery = open
        ? {
            elevation: (x, z, tt) => sea.elevation(x, z, tt),
            pressure: (x, y, z, tt) =>
              (x - centre[0]) * ahead[0] + (y - centre[1]) * ahead[1] + (z - centre[2]) * ahead[2] < 0
                ? 0
                : pressureOf(sea, x, y, z, tt, rho, this.g),
            density: rho,
          }
        : sea,
      loads = wettedLoads(body.mesh, { position: origin, rotation: q }, seaQuery, t, centre, this.loads),
      force: V3 = [loads.force[0], loads.force[1], loads.force[2]],
      torque: V3 = [loads.torque[0], loads.torque[1], loads.torque[2]];
    // The impact pressure on the faces moving into the water below the local surface, and what is under it.
    let submerged = 0;
    const slender = shape.length > 2 * shape.breadth;
    const streamlined = under && !open && slender;
    for (let k = 0; k < indices.length; k += 3) {
      const ia = 3 * indices[k]!,
        ib = 3 * indices[k + 1]!,
        ic = 3 * indices[k + 2]!,
        a: V3 = [world[ia]!, world[ia + 1]!, world[ia + 2]!],
        e1: V3 = [world[ib]! - a[0], world[ib + 1]! - a[1], world[ib + 2]! - a[2]],
        e2: V3 = [world[ic]! - a[0], world[ic + 1]! - a[1], world[ic + 2]! - a[2]],
        nx = 0.5 * (e1[1] * e2[2] - e1[2] * e2[1]),
        ny = 0.5 * (e1[2] * e2[0] - e1[0] * e2[2]),
        nz = 0.5 * (e1[0] * e2[1] - e1[1] * e2[0]),
        area = hypot(nx, ny, nz);
      if (!(area > 0)) continue;
      // The share of the triangle below the local surface, by its corners' depths, and its centroid there.
      const da = level - (n[0] * a[0] + n[1] * a[1] + n[2] * a[2]),
        db = level - (n[0] * world[ib]! + n[1] * world[ib + 1]! + n[2] * world[ib + 2]!),
        dc = level - (n[0] * world[ic]! + n[1] * world[ic + 1]! + n[2] * world[ic + 2]!),
        wet = wetShare(da, db, dc);
      // The volume under the surface: tetrahedra on the surface plane's point p0 (the cut's cap adds none there).
      submerged += clippedVolume(a, world, ib, ic, n, level, p0);
      if (!(wet > 0) || streamlined) continue;
      const un = (vr[0] * nx + vr[1] * ny + vr[2] * nz) / area;
      if (!(un > 0)) continue;
      const p = 0.5 * rho * un * un * wet,
        f: V3 = [-p * nx, -p * ny, -p * nz],
        cx = a[0] + (e1[0] + e2[0]) / 3,
        cy = a[1] + (e1[1] + e2[1]) / 3,
        cz = a[2] + (e1[2] + e2[2]) / 3;
      force[0] += f[0];
      force[1] += f[1];
      force[2] += f[2];
      addTorque(torque, [cx - centre[0], cy - centre[1], cz - centre[2]], f);
    }
    submerged = Math.max(0, Math.min(shape.volume, submerged));
    if (streamlined && speed > 0) {
      // Hoerner's streamlined drag: C_f (1 + 1.5 (d/l)^1.5 + 7 (d/l)^3) on the wetted area, C_f from ITTC 1957.
      const re = Math.max(1e4, (speed * shape.length * rho) / this.mu),
        lg = ln(re) / ln(10) - 2,
        cf = 0.075 / (lg * lg),
        ratio = shape.breadth / shape.length,
        cd = cf * (1 + 1.5 * pow(ratio, 1.5) + 7 * ratio * ratio * ratio),
        drag = 0.5 * rho * cd * shape.wetted * speed;
      force[0] -= drag * vr[0];
      force[1] -= drag * vr[1];
      force[2] -= drag * vr[2];
    }
    // The slam, while the wetted radius is inside the widest section across the normal.
    let slamMass = 0;
    if (vn > 0 && state[s + SUBMERGED_ONCE] === 0) {
      const profile = slamProfile(world, indices, n, lowest, Math.min(highest - lowest, 3.5 * h), PROFILE_LEVELS),
        widest = slamProfile(world, indices, n, lowest, highest - lowest, PROFILE_LEVELS).radii[PROFILE_LEVELS]!,
        sl = slam(profile, h, vn, rho, this.slamOut);
      if (sl.c < widest * (1 - 1e-6)) {
        slamMass = sl.addedMass;
        const along = force[0] * n[0] + force[1] * n[1] + force[2] * n[2],
          extra = sl.force - along;
        if (extra > 0) {
          const f: V3 = [extra * n[0], extra * n[1], extra * n[2]],
            lp: V3 = [world[3 * lowestAt]!, world[3 * lowestAt + 1]!, world[3 * lowestAt + 2]!];
          force[0] += f[0];
          force[1] += f[1];
          force[2] += f[2];
          addTorque(torque, [lp[0] - centre[0], lp[1] - centre[1], lp[2] - centre[2]], f);
        }
      }
    }
    // The water it carries, along its axes (Lamb's spheroid) for the share under water, the slam's disc along the normal.
    const share = submerged / shape.volume,
      mass = rows[at + 16]! > 0 ? 1 / rows[at + 16]! : Infinity,
      axis = rotate(q, [shape.axis === 0 ? 1 : 0, shape.axis === 1 ? 1 : 0, shape.axis === 2 ? 1 : 0]),
      m1 = shape.k1 * rho * shape.volume * share,
      m2 = shape.k2 * rho * shape.volume * share,
      A = new Float64Array(9);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) A[3 * i + j] = (i === j ? m2 : 0) + (m1 - m2) * axis[i]! * axis[j]!;
    if (slamMass > 0) {
      const along =
          n[0] * (A[0]! * n[0] + A[1]! * n[1] + A[2]! * n[2]) +
          n[1] * (A[3]! * n[0] + A[4]! * n[1] + A[5]! * n[2]) +
          n[2] * (A[6]! * n[0] + A[7]! * n[1] + A[8]! * n[2]),
        more = slamMass - along;
      if (more > 0) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) A[3 * i + j]! += more * n[i]! * n[j]!;
    }
    const w = body.row * FORCE_WORDS,
      held = mass < Infinity ? carried(mass, A, force, this.host!.gravity) : force;
    out[w]! += held[0];
    out[w + 1]! += held[1];
    out[w + 2]! += held[2];
    out[w + 3]! += torque[0];
    out[w + 4]! += torque[1];
    out[w + 5]! += torque[2];
    // What it displaces near the surface: its own volume under the surface while it is through it, and its open cavity.
    this.displace(state, s, (under ? 0 : submerged) + cavityVolume, centre);
  }

  /** It meets the water: the entry event, its widest radius, its cavity if it is fast enough, and foam. */
  private enter(
    b: number,
    body: EntryBody,
    state: Float64Array,
    s: number,
    t: number,
    world: Float64Array,
    indices: ArrayLike<number>,
    n: V3,
    contact: number,
    centre: V3,
    vr: V3,
    speed: number,
    vn: number,
  ): void {
    const ahead: V3 = speed > 0 ? [vr[0] / speed, vr[1] / speed, vr[2] / speed] : [-n[0], -n[1], -n[2]],
      // The widest radius across its path (the section across its motion).
      span = spanOf(world, indices, ahead),
      sine = speed > 0 ? Math.max(0, vn) / speed : 0,
      threshold = cavityThreshold(((body.contactAngle ?? 30) * Math.PI) / 180, this.gamma, this.mu),
      cavity = vn > threshold && sine > 0.5,
      // The crown sheet leaves at the cavity's opening speed, sqrt(alpha) U (Aristoff et al. 2010; L. Logvinovich's
      // U sqrt(C_D / 2) of a cavity-running sphere, 0.39 U, as A. May 1975 gives it, is the same within its spread), slower
      // as the body grazes (Margo's sqrt(sine), as ShotSplash takes it); under the sheet's retraction speed
      // sqrt(2 gamma / (rho delta)), delta = 0.2 mm (J. M. Aristoff and J. W. M. Bush, J. Fluid Mech. 619, 2009), none.
      sheet = Math.sqrt(CAVITY_ALPHA) * speed * Math.sqrt(sine),
      crown = sheet > Math.sqrt((2 * this.gamma) / (1025 * 2e-4)) ? sheet : 0;
    state[s + ENTRY_TIME] = t;
    state[s + ENTRY_X] = centre[0];
    state[s + ENTRY_X + 1] = contact;
    state[s + ENTRY_X + 2] = centre[2];
    state[s + ENTRY_SPEED] = speed;
    state[s + ENTRY_RADIUS] = span;
    state[s + ENTRY_SINE] = sine;
    state[s + ENTRY_VX] = vr[0];
    state[s + ENTRY_VX + 1] = vr[1];
    state[s + ENTRY_VX + 2] = vr[2];
    state[s + CROWN] = crown;
    state[s + SUBMERGED_ONCE] = 0;
    state[s + CAVITY] = cavity ? 1 : 0;
    state[s + SECTION_COUNT] = 0;
    // Sections a spacing apart along the path, enough to reach past the pinch a body at its entry speed would have.
    const pinch = constantSpeedPinch(Math.max(vn, 1e-3), Math.max(span, 1e-3), this.g);
    state[s + SPACING] = Math.max(span / 4, (2.5 * 2 * pinch.depth) / SECTIONS);
    state[s + LAST_X] = centre[0];
    state[s + LAST_X + 1] = contact + state[s + SPACING]!; // so the first section opens at the surface
    state[s + LAST_X + 2] = centre[2];
    if (!(vn > 0)) return;
    this.event(
      b,
      body.row,
      'entry',
      t,
      [centre[0], contact, centre[2]],
      vr,
      speed,
      sine,
      span,
      crown,
      dropHeight(crown, CROWN_DROP_FALL),
      0,
      0,
      cavity,
    );
    if (crown > 0)
      this.foam?.addFoam(
        [centre[0] - 2.5 * span, centre[2] - 2.5 * span],
        [centre[0] + 2.5 * span, centre[2] + 2.5 * span],
        1,
      );
  }

  /** It leaves the water: an exit (it was under) or a skip (it glanced off). */
  private leave(
    b: number,
    body: EntryBody,
    state: Float64Array,
    s: number,
    t: number,
    centre: V3,
    vr: V3,
    speed: number,
    vn: number,
    n: V3,
    height: number,
  ): void {
    void n;
    const R0 = state[s + ENTRY_RADIUS]!,
      sine = speed > 0 ? Math.max(0, -vn) / speed : 0,
      at: V3 = [centre[0], height, centre[2]];
    if (state[s + SUBMERGED_ONCE] === 1) {
      if (state[s + EMERGED] === 0) {
        const up = Math.max(0, -vn);
        this.event(b, body.row, 'exit', t, at, vr, speed, sine, R0, 0, 0, up, dropHeight(up, COLUMN_DROP_FALL), false);
        this.foam?.addFoam([at[0] - 1.5 * R0, at[2] - 1.5 * R0], [at[0] + 1.5 * R0, at[2] + 1.5 * R0], 0.8);
      }
    } else {
      const crown = state[s + CROWN]!;
      this.event(
        b,
        body.row,
        'skip',
        t,
        at,
        vr,
        speed,
        sine,
        R0,
        crown,
        dropHeight(crown, CROWN_DROP_FALL),
        0,
        0,
        false,
      );
    }
    state[s + CAVITY] = 0;
    state[s + SECTION_COUNT] = 0;
    state[s + EMERGED] = 0;
  }

  /** It breaks out from under: the exit splash, the water lifted with it at its speed, and foam. */
  private breach(
    b: number,
    body: EntryBody,
    state: Float64Array,
    s: number,
    t: number,
    world: Float64Array,
    indices: ArrayLike<number>,
    centre: V3,
    vr: V3,
    speed: number,
    vn: number,
    height: number,
  ): void {
    const ahead: V3 = speed > 0 ? [vr[0] / speed, vr[1] / speed, vr[2] / speed] : [0, 1, 0],
      span = spanOf(world, indices, ahead),
      up = -vn,
      at: V3 = [centre[0], height, centre[2]];
    state[s + ENTRY_RADIUS] = span;
    this.event(
      b,
      body.row,
      'exit',
      t,
      at,
      vr,
      speed,
      speed > 0 ? up / speed : 0,
      span,
      0,
      0,
      up,
      dropHeight(up, COLUMN_DROP_FALL),
      false,
    );
    this.foam?.addFoam([at[0] - 1.5 * span, at[2] - 1.5 * span], [at[0] + 1.5 * span, at[2] + 1.5 * span], 0.8);
  }

  /**
   * The open cavity: a section opens each spacing the widest section moves down, then closes under the water's weight;
   * the first one above the body to close is the deep seal, which throws the jet and ends the cavity. Returns the open
   * cavity's volume, m^3.
   */
  private cavity(
    b: number,
    state: Float64Array,
    s: number,
    t: number,
    centre: V3,
    speed: number,
    R0: number,
    surface: number,
  ): number {
    const sec = this.words(this.sections),
      base = b * SECTIONS * SECTION_WORDS,
      g = this.g;
    let n = state[s + SECTION_COUNT]!;
    const moved = hypot(
      centre[0] - state[s + LAST_X]!,
      centre[1] - state[s + LAST_X + 1]!,
      centre[2] - state[s + LAST_X + 2]!,
    );
    if (n < SECTIONS && centre[1] < surface && moved >= state[s + SPACING]!) {
      const k = base + n * SECTION_WORDS;
      sec[k] = centre[0];
      sec[k + 1] = centre[1];
      sec[k + 2] = centre[2];
      sec[k + 3] = t;
      sec[k + 4] = R0 * Math.sqrt(CAVITY_ALPHA) * speed;
      sec[k + 5] = R0;
      state[s + LAST_X] = centre[0];
      state[s + LAST_X + 1] = centre[1];
      state[s + LAST_X + 2] = centre[2];
      state[s + SECTION_COUNT] = ++n;
    }
    // The volume of the open sections (each a slice a spacing long) and the first above the body to close.
    let volume = 0;
    for (let i = 0; i < n; i++) {
      const k = base + i * SECTION_WORDS,
        depth = Math.max(0, state[s + ENTRY_X + 1]! - sec[k + 1]!),
        r2 = sectionRadius2(sec[k + 5]!, sec[k + 4]!, depth, g, t - sec[k + 3]!),
        behind = hypot(centre[0] - sec[k]!, centre[1] - sec[k + 1]!, centre[2] - sec[k + 2]!);
      if (r2 <= 0 && behind > 2 * R0 && depth > 0) {
        // The deep seal at this depth: the collapse above throws the Worthington jet up through the surface.
        const jet = JET_SPEED_RATIO * state[s + ENTRY_SPEED]! * state[s + ENTRY_SINE]!,
          entry: V3 = [state[s + ENTRY_X]!, state[s + ENTRY_X + 1]!, state[s + ENTRY_X + 2]!];
        this.event(
          b,
          this.bodies[b]!.row,
          'seal',
          t,
          entry,
          [0, jet, 0],
          jet,
          1,
          R0,
          0,
          0,
          jet,
          dropHeight(jet, COLUMN_DROP_FALL),
          true,
        );
        this.foam?.addFoam([entry[0] - 1.5 * R0, entry[2] - 1.5 * R0], [entry[0] + 1.5 * R0, entry[2] + 1.5 * R0], 1);
        state[s + CAVITY] = 0;
        state[s + SECTION_COUNT] = 0;
        return 0;
      }
      volume += Math.PI * Math.max(0, r2) * state[s + SPACING]!;
    }
    return volume;
  }

  /** What it displaces near the surface now; the change is this step's volume for the wake. */
  private displace(state: Float64Array, s: number, displaced: number, centre: V3): void {
    const before = state[s + DISPLACED]!,
      R0 = Math.max(state[s + ENTRY_RADIUS]!, 1e-3);
    state[s + DISPLACED] = displaced;
    state[s + SOURCE_V] = displaced - before;
    state[s + SOURCE_X] = state[s + CAVITY] === 1 ? state[s + ENTRY_X]! : centre[0];
    state[s + SOURCE_X + 1] = state[s + CAVITY] === 1 ? state[s + ENTRY_X + 2]! : centre[2];
    state[s + SOURCE_R] = R0;
  }

  private event(
    b: number,
    row: number,
    kind: EntrySplash['kind'],
    t: number,
    p: Vec3,
    v: Vec3,
    speed: number,
    sine: number,
    radius: number,
    crownSpeed: number,
    crownHeight: number,
    columnSpeed: number,
    columnHeight: number,
    cavity: boolean,
  ): void {
    void b;
    const log = this.words(this.log),
      written = log[0]!,
      k = 1 + (written % this.eventCount) * EVENT_WORDS;
    log.set(
      [
        ['entry', 'seal', 'exit', 'skip'].indexOf(kind),
        row,
        t,
        p[0],
        p[1],
        p[2],
        v[0],
        v[1],
        v[2],
        speed,
        sine,
        radius,
        crownSpeed,
        crownHeight,
        columnSpeed,
        columnHeight,
        cavity ? 1 : 0,
      ],
      k,
    );
    log[0] = written + 1;
  }

  /** The splashes so far, oldest first (the most recent `events` of them). */
  splashes(): EntrySplash[] {
    const log = this.words(this.log),
      written = log[0]!,
      first = Math.max(0, written - this.eventCount),
      kinds = ['entry', 'seal', 'exit', 'skip'] as const,
      list: EntrySplash[] = [];
    for (let e = first; e < written; e++) {
      const k = 1 + (e % this.eventCount) * EVENT_WORDS;
      list.push({
        kind: kinds[log[k]!]!,
        row: log[k + 1]!,
        time: log[k + 2]!,
        position: [log[k + 3]!, log[k + 4]!, log[k + 5]!],
        velocity: [log[k + 6]!, log[k + 7]!, log[k + 8]!],
        speed: log[k + 9]!,
        sine: log[k + 10]!,
        radius: log[k + 11]!,
        crownSpeed: log[k + 12]!,
        crownHeight: log[k + 13]!,
        columnSpeed: log[k + 14]!,
        columnHeight: log[k + 15]!,
        cavity: log[k + 16] === 1,
      });
    }
    return list;
  }

  /**
   * What the bodies pushed into the surface at the last step, for a WakeSolver's `sources`: for each body that moved
   * water, the volume taken out where it is (or where its cavity's mouth is) and put back in the ring around it.
   * `sources: (t) => entry.seaSources()`.
   */
  seaSources(): SeaSource[] {
    const state = this.words(this.state),
      list: SeaSource[] = [];
    for (let b = 0; b < this.bodies.length; b++) {
      const s = b * STATE_WORDS,
        volume = state[s + SOURCE_V]!;
      if (volume === 0) continue;
      const x = state[s + SOURCE_X]!,
        z = state[s + SOURCE_X + 1]!,
        r = state[s + SOURCE_R]!;
      list.push({ x, z, radius: 2 * r, pressure: 0, volume: -volume });
      list.push({ x, z, radius: 2 * Math.SQRT2 * r, pressure: 0, volume });
    }
    return list;
  }

  /** The body's state, for a view: its phase ('air', 'through', 'under') and whether its cavity is open. */
  bodyState(row: number): { phase: 'air' | 'through' | 'under'; cavity: boolean } {
    const b = this.bodies.findIndex((body) => body.row === row);
    if (b < 0) throw new RangeError(`No body of this EntrySolver is on row ${row}; pass one of its rows.`);
    const state = this.words(this.state),
      s = b * STATE_WORDS;
    return { phase: (['air', 'through', 'under'] as const)[state[s + PHASE]!]!, cavity: state[s + CAVITY] === 1 };
  }

  exportPorts(tick: number): readonly Port[] {
    if (!this.forces)
      throw new MargoError('state', 'EntrySolver is not in a world yet; add it with world.add(solver, {bodies, sea}).');
    const ports: Port[] = [{ field: BODY_FORCES_FIELD.name, region: this.forces, tick, cell: [0, 0, 0] }];
    if (this.cavityPressure)
      ports.push({ field: this.cavityPressureField.name, region: this.cavityPressure, tick, cell: [0, 0, 0] });
    return ports;
  }

  importPorts(): void {}

  stateRegions(): readonly Region[] {
    return [this.state, this.sections, this.log, this.cavityPressure].filter((r): r is Region => r !== null);
  }

  extraState(): readonly Region[] {
    return [];
  }
}

/** A body's widest radius across the direction `ahead`: the equivalent radius of its largest section across it. */
function spanOf(world: Float64Array, indices: ArrayLike<number>, ahead: Vec3): number {
  let lo = Infinity,
    hi = -Infinity;
  for (let i = 0; i < world.length; i += 3) {
    const d = -(ahead[0] * world[i]! + ahead[1] * world[i + 1]! + ahead[2] * world[i + 2]!);
    lo = Math.min(lo, d);
    hi = Math.max(hi, d);
  }
  return slamProfile(world, indices, [-ahead[0], -ahead[1], -ahead[2]], lo, hi - lo, PROFILE_LEVELS).radii[
    PROFILE_LEVELS
  ]!;
}

/** The sea's gauge pressure at a point: its own, or the still water's under its surface. */
function pressureOf(
  sea: SeaSurface | SeaQuery,
  x: number,
  y: number,
  z: number,
  t: number,
  rho: number,
  g: number,
): number {
  if (typeof sea.pressure === 'function') return sea.pressure(x, y, z, t);
  const below = sea.elevation(x, z, t) - y;
  return below > 0 ? rho * g * below : 0;
}

/** The height drops thrown up at `speed` reach against air drag, falling at `terminal`: vt^2 / (2 g) ln(1 + v^2 / vt^2). */
function dropHeight(speed: number, terminal: number): number {
  return ((terminal * terminal) / (2 * 9.81)) * ln(1 + (speed * speed) / (terminal * terminal));
}

/** The share of a triangle below a plane, from its corners' depths below it (positive under). */
function wetShare(a: number, b: number, c: number): number {
  const under = (a > 0 ? 1 : 0) + (b > 0 ? 1 : 0) + (c > 0 ? 1 : 0);
  if (under === 3) return 1;
  if (under === 0) return 0;
  // The corner alone on its side and the two others: the cut triangle's area share is the product of the edge shares.
  const [lone, p, r] =
    under === 1
      ? a > 0
        ? [a, b, c]
        : b > 0
          ? [b, a, c]
          : [c, a, b]
      : a <= 0
        ? [a, b, c]
        : b <= 0
          ? [b, a, c]
          : [c, a, b];
  const share = (lone / (lone - p)) * (lone / (lone - r));
  return under === 1 ? share : 1 - share;
}

/** The signed volume under a plane of one triangle's tetrahedra on the plane's point `p0` (the triangle clipped below it). */
const CLIP = new Float64Array(12);
function clippedVolume(a: Vec3, world: Float64Array, ib: number, ic: number, n: Vec3, level: number, p0: Vec3): number {
  const xs = [a[0], world[ib]!, world[ic]!],
    ys = [a[1], world[ib + 1]!, world[ic + 1]!],
    zs = [a[2], world[ib + 2]!, world[ic + 2]!];
  let count = 0;
  for (let e = 0; e < 3; e++) {
    const f = (e + 1) % 3,
      dp = n[0] * xs[e]! + n[1] * ys[e]! + n[2] * zs[e]! - level,
      dr = n[0] * xs[f]! + n[1] * ys[f]! + n[2] * zs[f]! - level;
    if (dp <= 0) {
      CLIP[3 * count] = xs[e]! - p0[0];
      CLIP[3 * count + 1] = ys[e]! - p0[1];
      CLIP[3 * count + 2] = zs[e]! - p0[2];
      count++;
    }
    if (dp <= 0 !== dr <= 0) {
      const u = dp / (dp - dr);
      CLIP[3 * count] = xs[e]! + u * (xs[f]! - xs[e]!) - p0[0];
      CLIP[3 * count + 1] = ys[e]! + u * (ys[f]! - ys[e]!) - p0[1];
      CLIP[3 * count + 2] = zs[e]! + u * (zs[f]! - zs[e]!) - p0[2];
      count++;
    }
  }
  let v = 0;
  const ux = CLIP[0]!,
    uy = CLIP[1]!,
    uz = CLIP[2]!;
  for (let i = 1; i + 1 < count; i++) {
    const wx = CLIP[3 * i]!,
      wy = CLIP[3 * i + 1]!,
      wz = CLIP[3 * i + 2]!,
      yx = CLIP[3 * i + 3]!,
      yy = CLIP[3 * i + 4]!,
      yz = CLIP[3 * i + 5]!;
    v += (ux * (wy * yz - wz * yy) - uy * (wx * yz - wz * yx) + uz * (wx * yy - wy * yx)) / 6;
  }
  return v;
}

function addTorque(torque: V3, r: Vec3, f: Vec3): void {
  torque[0] += r[1] * f[2] - r[2] * f[1];
  torque[1] += r[2] * f[0] - r[0] * f[2];
  torque[2] += r[0] * f[1] - r[1] * f[0];
}

/** The force held over the step so the body moves as if it carried the water A with it: M (M + A)^-1 (F + W) - W. */
function carried(mass: number, A: Float64Array, force: Vec3, gravity: Vec3): V3 {
  const m = new Float64Array(9);
  for (let i = 0; i < 9; i++) m[i] = A[i]!;
  m[0]! += mass;
  m[4]! += mass;
  m[8]! += mass;
  const rhs: V3 = [force[0] + mass * gravity[0], force[1] + mass * gravity[1], force[2] + mass * gravity[2]],
    a = solve3(m, rhs);
  return [mass * a[0] - mass * gravity[0], mass * a[1] - mass * gravity[1], mass * a[2] - mass * gravity[2]];
}

function solve3(m: Float64Array, r: Vec3): V3 {
  const [a, b, c, d, e, f, g, h, i] = m as unknown as number[],
    A = e! * i! - f! * h!,
    B = f! * g! - d! * i!,
    C = d! * h! - e! * g!,
    det = a! * A + b! * B + c! * C;
  if (!(det !== 0 && Number.isFinite(det))) return [0, 0, 0];
  return [
    (A * r[0] + (c! * h! - b! * i!) * r[1] + (b! * f! - c! * e!) * r[2]) / det,
    (B * r[0] + (a! * i! - c! * g!) * r[1] + (c! * d! - a! * f!) * r[2]) / det,
    (C * r[0] + (b! * g! - a! * h!) * r[1] + (a! * e! - b! * d!) * r[2]) / det,
  ];
}

/** A body's volume, its box along its axes, Lamb's added-mass coefficients for the spheroid of its length and breadth. */
function shapeOf(mesh: HullMesh): EntrySolver['shapes'][number] {
  const { vertices, indices } = mesh,
    low = [Infinity, Infinity, Infinity],
    high = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertices.length; i++) {
    low[i % 3] = Math.min(low[i % 3]!, vertices[i]!);
    high[i % 3] = Math.max(high[i % 3]!, vertices[i]!);
  }
  let volume = 0,
    wetted = 0;
  for (let k = 0; k < indices.length; k += 3) {
    const a = 3 * indices[k]!,
      b = 3 * indices[k + 1]!,
      c = 3 * indices[k + 2]!,
      [ax, ay, az, bx, by, bz, cx, cy, cz] = [a, a + 1, a + 2, b, b + 1, b + 2, c, c + 1, c + 2].map(
        (i) => vertices[i]!,
      );
    volume += (ax! * (by! * cz! - bz! * cy!) - ay! * (bx! * cz! - bz! * cx!) + az! * (bx! * cy! - by! * cx!)) / 6;
    const ux = bx! - ax!,
      uy = by! - ay!,
      uz = bz! - az!,
      vx = cx! - ax!,
      vy = cy! - ay!,
      vz = cz! - az!;
    wetted += 0.5 * hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }
  if (!(volume > 0))
    throw new RangeError(
      `A body's mesh encloses ${volume} m^3; wind its triangles outward (counter-clockwise seen from outside) around a closed volume.`,
    );
  const extent = [0, 1, 2].map((i) => high[i]! - low[i]!),
    axis = extent.indexOf(Math.max(...extent)),
    length = extent[axis]!,
    others = extent.filter((_, i) => i !== axis),
    breadth = 0.5 * (others[0]! + others[1]!),
    { k1, k2 } = spheroid(length / Math.max(breadth, 1e-9));
  return { volume, length, breadth, axis, k1, k2, wetted };
}

/**
 * Lamb's added-mass coefficients of a prolate spheroid of length over breadth `ratio` (1 a sphere, 1/2 each): along its
 * axis k1 = alpha0 / (2 - alpha0), across it k2 = beta0 / (2 - beta0) (Hydrodynamics, section 373). A body broader
 * than long is taken as a sphere.
 */
export function spheroid(ratio: number): { k1: number; k2: number } {
  if (!(ratio > 1 + 1e-6)) return { k1: 0.5, k2: 0.5 };
  const e = Math.sqrt(1 - 1 / (ratio * ratio)),
    L = ln((1 + e) / (1 - e)),
    alpha0 = ((2 * (1 - e * e)) / (e * e * e)) * (0.5 * L - e),
    beta0 = 1 / (e * e) - ((1 - e * e) / (2 * e * e * e)) * L;
  return { k1: alpha0 / (2 - alpha0), k2: beta0 / (2 - beta0) };
}

function rotate(q: readonly [number, number, number, number], v: Vec3): V3 {
  const [x, y, z, w] = q,
    tx = 2 * (y * v[2] - z * v[1]),
    ty = 2 * (z * v[0] - x * v[2]),
    tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

/** The rotation `q` turned by the angular velocity `w` for `h` seconds, made a unit. */
function turn(q: readonly [number, number, number, number], w: Vec3, h: number): [number, number, number, number] {
  const [x, y, z, s] = q,
    a = (w[0] * h) / 2,
    b = (w[1] * h) / 2,
    c = (w[2] * h) / 2,
    nx = x + (s * a + b * z - c * y),
    ny = y + (s * b + c * x - a * z),
    nz = z + (s * c + a * y - b * x),
    ns = s - (a * x + b * y + c * z),
    length = Math.sqrt(nx * nx + ny * ny + nz * nz + ns * ns);
  return [nx / length, ny / length, nz / length, ns / length];
}
