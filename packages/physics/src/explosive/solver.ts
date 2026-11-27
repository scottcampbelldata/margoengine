// The explosive source as a solver of the physics framework (FIRE-05; docs/physics-framework.md, sections 4 and 5).
// Charges are placed events: each detonates at its time, and its row of the `explosions` field gives the blast, crater and
// plume solvers what it released and where (charge.ts: the energy, its air and ground shares, the scaled depth, the gas).
// A cased charge at or above the surface throws its case as fragments, which fly here under gravity and air drag until
// they reach the ground: launched at Gurney's speed for the case to charge mass ratio, their masses drawn from Mott's
// distribution and scaled so they add up to the case mass, sent out in opposite pairs of equal mass so the launch adds
// no momentum. A buried charge keeps its case in the ground.
//
// Sources (docs/clean-room.md): Kennedy 1970 for Gurney's speed (charge.ts); N. F. Mott, "Fragmentation of shell cases",
// Proc. R. Soc. Lond. A 189, 1947, for the cumulative distribution N(>m) = N0 exp(-sqrt(m/mu)), sampled here by inverting
// it; quadratic air drag on a sphere of the fragment's mass and density, integrated exactly over a step for the drag alone.
//
// State: the fragments' positions, velocities, masses and flight states, and each charge's detonated flag.
import type { Vec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import { cos, hypot, ln, pow, sin } from '@margoengine/math/pinned';
import { RandomStream, solverNumber } from '@margoengine/math/random';
import type {
  FieldDescriptor,
  Port,
  Region,
  Solver,
  SolverDescription,
  SolverHost,
  StepContext,
} from '../world/solver.js';
import { rateOf } from '../world/solver.js';
import {
  chargeEnergy,
  energyBudget,
  type Explosive,
  EXPLOSIVES,
  type GroundOptions,
  type GurneyGeometry,
  gurneyVelocity,
  metalSpeed,
} from './charge.js';

/** The layout version of the explosion and fragment regions. */
export const EXPLOSION_LAYOUT = 2;
/**
 * Words of an `explosions` row: x, y, z (m), time (s), energy, air, ground (J), scaled depth (m J^-1/3), gas mass (kg),
 * detonated (0 or 1), then the ground's share split: ground shock, crater work, heat (J), and the crater's radius (m).
 */
export const EXPLOSION_WORDS = 14;
/** Words of a `fragments` row: x, y, z (m), vx, vy, vz (m/s), mass (kg), state (0 waiting, 1 flying, 2 landed). */
export const FRAGMENT_WORDS = 8;

const AIR_DENSITY = 1.225;
/** A cast high explosive's density, kg/m^3 (TNT 1630), for telling a charge on the ground from one in the air. */
const CHARGE_DENSITY = 1630;
const WAITING = 0;
const FLYING = 1;
const LANDED = 2;

/** A cased charge's case, which it throws as fragments when it detonates at or above the surface. */
export interface ChargeCase {
  /** The case's mass, kg; with the charge's mass it sets Gurney's M/C (0.2 to 10). */
  readonly mass: number;
  /** Its shape for Gurney's equations (default `cylinder`). */
  readonly geometry?: 'cylinder' | 'sphere';
  /** How many fragments it breaks into, an even number of 2 or more (default 200). */
  readonly fragments?: number;
  /** The cylinder's axis, the way the fragments do not fly (default up, [0, 1, 0]). */
  readonly axis?: Vec3;
  /** The fragments' density, kg/m^3 (default 7850, steel). */
  readonly density?: number;
  /** Their drag coefficient (default 1). */
  readonly dragCoefficient?: number;
}

/** One charge, placed in the world. */
export interface ChargeOptions {
  /** Where its centre is, metres, in the solver's cell. */
  readonly position: Vec3;
  /** When it detonates, seconds of world time (default 0). */
  readonly time?: number;
  /** Its explosive mass, kg; or give `energy` in joules (a TNT equivalent's mass times 4.184 MJ). */
  readonly mass?: number;
  readonly energy?: number;
  /** The explosive (default TNT). */
  readonly explosive?: Explosive;
  /** How far below the surface its centre is, metres (default 0: on or above the ground). */
  readonly depth?: number;
  /** Its case: fragments for a charge at or above the surface. */
  readonly case?: ChargeCase;
}

/** What an {@link ExplosionSolver} is made from. */
export interface ExplosionParams {
  readonly charges: readonly ChargeOptions[];
  /** The height of the ground fragments land on, metres (default 0). */
  readonly groundHeight?: number;
  /** The seed of the fragments' masses and directions (default 0): another seed breaks the same cases another way. */
  readonly seed?: number;
  /** The ground the charges sit in, for their energy budgets (density, seismic coupling, crater; see `energyBudget`). */
  readonly soil?: GroundOptions;
}

/** The work a step did. */
export interface ExplosionCounts {
  /** Fragments in the air after the last step. */
  readonly flying: number;
  /** Fragment steps taken in all. */
  readonly fragmentSteps: number;
}

interface Placed {
  readonly position: Vec3;
  readonly time: number;
  readonly energy: number;
  readonly air: number;
  readonly ground: number;
  readonly groundShock: number;
  readonly craterWork: number;
  readonly heat: number;
  readonly craterRadius: number;
  readonly scaledDepth: number;
  readonly gasMass: number;
  readonly fragments: number;
  readonly drag: number;
}

function finite(value: unknown, what: string, fix: string, positive = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (positive ? value <= 0 : value < 0))
    throw new RangeError(
      `${what} must be a finite number${positive ? ' above 0' : ' of 0 or more'}; got ${String(value)}. ${fix}`,
    );
  return value;
}

/** The explosive source: placed charges, their energy for the blast, crater and plume, and their case fragments in flight. */
export class ExplosionSolver implements Solver<ExplosionParams> {
  readonly explosionsField: FieldDescriptor;
  readonly fragmentsField: FieldDescriptor;
  private host: SolverHost | null = null;
  private placed: Placed[] = [];
  private explosionRegion: Region | null = null;
  private fragmentRegion: Region | null = null;
  private fragmentDrag: Float64Array = new Float64Array(0);
  private fragmentCharge: Int32Array = new Int32Array(0);
  private fragmentCount = 0;
  private ground = 0;
  private steps = 0;
  private flyingNow = 0;

  constructor(readonly id = 'explosion') {
    this.explosionsField = {
      name: `${id}:explosions`,
      kind: 'particleSet',
      quantity: 'explosion source position, time, energy, air and ground energy, scaled depth, gas mass',
      unit: 'm, s, J, m J^-1/3, kg',
      centring: 'particle',
    };
    this.fragmentsField = {
      name: `${id}:fragments`,
      kind: 'particleSet',
      quantity: 'fragment position, velocity, mass and flight state',
      unit: 'm, m/s, kg',
      centring: 'particle',
    };
  }

  describe(): SolverDescription {
    return {
      id: this.id,
      rate: 0,
      stableRate: () => 0,
      fields: [
        { field: this.explosionsField, access: 'write' },
        { field: this.fragmentsField, access: 'write' },
      ],
    };
  }

  init(host: SolverHost, params: ExplosionParams): void {
    const charges = params?.charges;
    if (!Array.isArray(charges) || charges.length === 0)
      throw new TypeError('An ExplosionSolver needs charges: world.add(solver, {charges: [{position, mass}]}).');
    const ground = params.groundHeight ?? 0;
    if (!Number.isFinite(ground))
      throw new RangeError(`Ground height must be a finite number of metres; got ${ground}.`);
    this.ground = ground;
    const soil = params.soil ?? {};
    const seed = params.seed ?? 0;
    if (!(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff))
      throw new RangeError(`Seed must be a whole number from 0 to 2^32 - 1; got ${seed}.`);
    const random = new RandomStream(seed, solverNumber(this.id));
    const fragments: number[][] = [];
    const drags: number[] = [];
    const owners: number[] = [];
    this.placed = charges.map((charge, index) => {
      const at = `Charge ${index}`;
      const p = charge.position;
      if (!Array.isArray(p) || p.length !== 3 || !p.every((v) => Number.isFinite(v)))
        throw new RangeError(`${at} position must be three finite numbers in metres; got ${String(p)}.`);
      const time = finite(charge.time ?? 0, `${at} time`, 'Give the detonation time in seconds of world time.');
      const explosive = charge.explosive ?? EXPLOSIVES.tnt;
      if ((charge.mass === undefined) === (charge.energy === undefined))
        throw new TypeError(`${at} needs either mass (kg of explosive) or energy (J); give one of them.`);
      const mass =
        charge.mass !== undefined
          ? finite(charge.mass, `${at} mass`, 'Give the explosive mass in kilograms.', true)
          : finite(charge.energy, `${at} energy`, 'Give it in joules.', true) / explosive.heatOfDetonation;
      const energy = chargeEnergy(mass, explosive);
      const depth = finite(
        charge.depth ?? 0,
        `${at} depth`,
        'Give the depth of its centre below the surface in metres.',
      );
      // A charge at depth 0 whose centre is higher than its own radius over the ground is in the air: no crater, no shock.
      const radius = pow((3 * mass) / (4 * Math.PI * CHARGE_DENSITY), 1 / 3);
      const budget = energyBudget(energy, depth, soil, depth === 0 && p[1] - ground > radius);
      let count = 0;
      let drag = 0;
      if (charge.case && depth === 0) {
        const c = charge.case;
        const caseMass = finite(c.mass, `${at} case mass`, 'Give it in kilograms.', true);
        count = c.fragments ?? 200;
        if (!(Number.isInteger(count) && count >= 2 && count % 2 === 0))
          throw new RangeError(`${at} case fragments must be an even whole number of 2 or more; got ${count}.`);
        const geometry: GurneyGeometry = c.geometry ?? 'cylinder';
        if (geometry !== 'cylinder' && geometry !== 'sphere')
          throw new TypeError(`${at} case geometry is cylinder or sphere; got ${String(geometry)}.`);
        const speed = metalSpeed(gurneyVelocity(explosive), geometry, caseMass / mass);
        const density = finite(c.density ?? 7850, `${at} fragment density`, 'Give it in kg/m^3.', true);
        const cd = finite(c.dragCoefficient ?? 1, `${at} drag coefficient`, 'Pass a number such as 1.');
        drag = cd;
        const axis = c.axis ?? [0, 1, 0];
        const an = hypot(axis[0], axis[1], axis[2]);
        if (!(an > 0) || !Number.isFinite(an))
          throw new RangeError(`${at} case axis must be a finite vector that is not zero.`);
        const ax: Vec3 = [axis[0] / an, axis[1] / an, axis[2] / an];
        // Two unit vectors across the axis.
        const helper: Vec3 = Math.abs(ax[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        let u: Vec3 = [
          ax[1] * helper[2] - ax[2] * helper[1],
          ax[2] * helper[0] - ax[0] * helper[2],
          ax[0] * helper[1] - ax[1] * helper[0],
        ];
        const un = hypot(u[0], u[1], u[2]);
        u = [u[0] / un, u[1] / un, u[2] / un];
        const w: Vec3 = [ax[1] * u[2] - ax[2] * u[1], ax[2] * u[0] - ax[0] * u[2], ax[0] * u[1] - ax[1] * u[0]];
        // Mott: N(>m) = N0 exp(-sqrt(m / mu)), so m = mu ln(1/q)^2 for a uniform q; the scale mu drops out when the masses
        // are scaled to the case mass. One mass per pair.
        const pairs = count / 2;
        const draws: number[] = [];
        let total = 0;
        for (let k = 0; k < pairs; k++) {
          const q = random.uniform(0, owners.length + 2 * k, index);
          const l = ln(1 / q);
          draws.push(l * l);
          total += 2 * l * l;
        }
        for (let k = 0; k < pairs; k++) {
          const m = (caseMass * draws[k]!) / total;
          let dir: Vec3;
          if (geometry === 'sphere') {
            const z = 2 * random.uniform(0, owners.length + 2 * k + 1, index) - 1;
            const phi = 2 * Math.PI * random.uniform(1, owners.length + 2 * k + 1, index);
            const r = pow(1 - z * z, 0.5);
            dir = [
              r * cos(phi) * u[0] + r * sin(phi) * w[0] + z * ax[0],
              r * cos(phi) * u[1] + r * sin(phi) * w[1] + z * ax[1],
              r * cos(phi) * u[2] + r * sin(phi) * w[2] + z * ax[2],
            ];
          } else {
            const phi = 2 * Math.PI * random.uniform(0, owners.length + 2 * k + 1, index);
            dir = [
              cos(phi) * u[0] + sin(phi) * w[0],
              cos(phi) * u[1] + sin(phi) * w[1],
              cos(phi) * u[2] + sin(phi) * w[2],
            ];
          }
          // The sphere of the fragment's mass and density sets its drag: k = rho_air Cd A / (2 m).
          const radius = pow((3 * m) / (4 * Math.PI * density), 1 / 3);
          const k2 = (AIR_DENSITY * cd * Math.PI * radius * radius) / (2 * m);
          for (const sign of [1, -1]) {
            fragments.push([
              p[0],
              p[1],
              p[2],
              sign * speed * dir[0],
              sign * speed * dir[1],
              sign * speed * dir[2],
              m,
              WAITING,
            ]);
            drags.push(k2);
            owners.push(index);
          }
        }
      }
      return {
        position: [p[0], p[1], p[2]],
        time,
        energy,
        air: budget.air,
        ground: budget.ground,
        groundShock: budget.groundShock,
        craterWork: budget.craterWork,
        heat: budget.heat,
        craterRadius: budget.craterRadius,
        scaledDepth: budget.scaledDepth,
        gasMass: mass,
        fragments: count,
        drag,
      };
    });
    this.host = host;
    this.explosionRegion = host.allocate(
      'explosions',
      this.placed.length * EXPLOSION_WORDS * 8,
      'f64',
      EXPLOSION_LAYOUT,
    );
    this.fragmentCount = fragments.length;
    this.fragmentRegion = host.allocate(
      'fragments',
      Math.max(1, fragments.length) * FRAGMENT_WORDS * 8,
      'f64',
      EXPLOSION_LAYOUT,
    );
    this.fragmentDrag = Float64Array.from(drags);
    this.fragmentCharge = Int32Array.from(owners);
    const rows = this.explosions();
    this.placed.forEach((c, i) =>
      rows.set(
        [
          ...c.position,
          c.time,
          c.energy,
          c.air,
          c.ground,
          c.scaledDepth,
          c.gasMass,
          0,
          c.groundShock,
          c.craterWork,
          c.heat,
          c.craterRadius,
        ],
        i * EXPLOSION_WORDS,
      ),
    );
    const frag = this.fragmentWords();
    fragments.forEach((row, i) => frag.set(row, i * FRAGMENT_WORDS));
  }

  private live(): SolverHost {
    if (!this.host)
      throw new MargoError('state', 'ExplosionSolver is not in a world yet; add it with world.add(solver, {charges}).');
    return this.host;
  }
  private explosions(): Float64Array {
    return new Float64Array(
      this.live().memory.buffer,
      this.explosionRegion!.byteOffset,
      this.placed.length * EXPLOSION_WORDS,
    );
  }
  private fragmentWords(): Float64Array {
    return new Float64Array(
      this.live().memory.buffer,
      this.fragmentRegion!.byteOffset,
      this.fragmentCount * FRAGMENT_WORDS,
    );
  }

  step(context: StepContext, dt: number): void {
    const host = this.live();
    const end = (context.tick + 1) / rateOf(context.level);
    const rows = this.explosions();
    for (let i = 0; i < this.placed.length; i++) if (this.placed[i]!.time < end) rows[i * EXPLOSION_WORDS + 9] = 1;
    const f = this.fragmentWords();
    const g = host.gravity;
    let flying = 0;
    for (let i = 0; i < this.fragmentCount; i++) {
      const o = i * FRAGMENT_WORDS;
      let state = f[o + 7]!;
      if (state === WAITING && this.placed[this.fragmentCharge[i]!]!.time < end) state = FLYING;
      if (state !== FLYING) {
        f[o + 7] = state;
        continue;
      }
      // Quadratic drag alone over the step, exactly: speed s goes to s / (1 + k s dt) along the velocity; then gravity.
      const vx = f[o + 3]!,
        vy = f[o + 4]!,
        vz = f[o + 5]!;
      const s = pow(vx * vx + vy * vy + vz * vz, 0.5);
      const keep = 1 / (1 + this.fragmentDrag[i]! * s * dt);
      const nx = vx * keep + g[0] * dt,
        ny = vy * keep + g[1] * dt,
        nz = vz * keep + g[2] * dt;
      f[o] = f[o]! + nx * dt;
      f[o + 1] = f[o + 1]! + ny * dt;
      f[o + 2] = f[o + 2]! + nz * dt;
      f[o + 3] = nx;
      f[o + 4] = ny;
      f[o + 5] = nz;
      this.steps++;
      if (f[o + 1]! <= this.ground && ny < 0) {
        f[o + 1] = this.ground;
        f[o + 3] = f[o + 4] = f[o + 5] = 0;
        f[o + 7] = LANDED;
      } else {
        f[o + 7] = FLYING;
        flying++;
      }
    }
    this.flyingNow = flying;
  }

  exportPorts(tick: number): readonly Port[] {
    this.live();
    return [
      { field: this.explosionsField.name, region: this.explosionRegion!, tick, cell: [0, 0, 0] },
      { field: this.fragmentsField.name, region: this.fragmentRegion!, tick, cell: [0, 0, 0] },
    ];
  }

  importPorts(_tick: number): void {}

  stateRegions(): readonly Region[] {
    this.live();
    return [this.explosionRegion!, this.fragmentRegion!];
  }

  extraState(): readonly Region[] {
    return [];
  }

  /** The work the last steps did (the fragment steps are counted since the solver was made). */
  get counts(): ExplosionCounts {
    return { flying: this.flyingNow, fragmentSteps: this.steps };
  }

  /** Charge `index` as the `explosions` field publishes it. @throws RangeError for an index out of range. */
  charge(index: number): {
    position: Vec3;
    time: number;
    energy: number;
    air: number;
    ground: number;
    scaledDepth: number;
    gasMass: number;
    detonated: boolean;
    groundShock: number;
    craterWork: number;
    heat: number;
    craterRadius: number;
  } {
    if (!(Number.isInteger(index) && index >= 0 && index < this.placed.length))
      throw new RangeError(`ExplosionSolver has charges 0 to ${this.placed.length - 1}; got ${index}.`);
    const r = this.explosions().subarray(index * EXPLOSION_WORDS, (index + 1) * EXPLOSION_WORDS);
    return {
      position: [r[0]!, r[1]!, r[2]!],
      time: r[3]!,
      energy: r[4]!,
      air: r[5]!,
      ground: r[6]!,
      scaledDepth: r[7]!,
      gasMass: r[8]!,
      detonated: r[9] === 1,
      groundShock: r[10]!,
      craterWork: r[11]!,
      heat: r[12]!,
      craterRadius: r[13]!,
    };
  }

  /** A copy of the fragments: rows of {@link FRAGMENT_WORDS} words (x, y, z, vx, vy, vz, mass, state). */
  fragments(): Float64Array {
    return Float64Array.from(this.fragmentWords());
  }
}
