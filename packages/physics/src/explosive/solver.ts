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
import { BED_FIELD, BED_LAYOUT, type BedShape, bedVertexCount } from '../earth/bed.js';
import { canShareMemory, isShared, STACK_BYTES } from '../world/memory.js';
import { rateOf } from '../world/solver.js';
import { BODIES_FIELD, BODY_IMPULSES_FIELD, BODY_WORDS, IMPULSE_WORDS } from '../world/solvers/rigid.js';
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
import { type FlightBed, flyFragments } from './flight.js';
import { type Firing, fireGun, type GunOptions, HISTORY_WORDS } from './gun.js';

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

/** A gun placed in the world, on a rigid body (a carrier: a ship, a carriage) or fixed. */
export interface GunMount extends Omit<GunOptions, 'recoilMass'> {
  /** When it fires, seconds of world time (default 0). */
  readonly time?: number;
  /**
   * The rigid body row it is mounted on. Its mass is the recoiling mass, its pose aims the bore, and the recoil goes into
   * it through `bodyImpulses` (the solver must be made with `carriers: true`). Leave it out for a gun fixed in the world.
   */
  readonly body?: number;
  /** The breech, m: in the body's frame on a carrier, else in the world. */
  readonly breech: Vec3;
  /** The bore's direction, in the same frame as `breech`. */
  readonly axis: Vec3;
  /** The shot's drag coefficient on the bore's area (default 0.3). */
  readonly shotDrag?: number;
}

/** What an {@link ExplosionSolver} is made from. */
export interface ExplosionParams {
  /** Charges (default none); a solver needs charges or guns. */
  readonly charges?: readonly ChargeOptions[];
  /** Guns (default none): each fires its shot, recoils into its carrier and makes a muzzle blast. */
  readonly guns?: readonly GunMount[];
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
  /** Integration steps of the guns fired, in the bore and the blowdown. */
  readonly gunSteps: number;
}

/** What an {@link ExplosionSolver} is made with. */
export interface ExplosionSolverOptions {
  /** True when guns are mounted on rigid bodies: the solver reads `bodies` and adds the recoil to `bodyImpulses`. */
  readonly carriers?: boolean;
  /**
   * The terrain bed's shape: the fragments land on the world's `bed` field (a `TerrainBed` of this shape, in the solver's
   * cell) rather than on a flat `groundHeight`.
   */
  readonly terrain?: BedShape;
}

type Native = {
  __stack_pointer: WebAssembly.Global;
  fly(
    fragments: number,
    drag: number,
    launch: number,
    count: number,
    dt: number,
    end: number,
    gx: number,
    gy: number,
    gz: number,
    ground: number,
    bed: number,
    columns: number,
    rows: number,
    width: number,
    depth: number,
    cx: number,
    cz: number,
    counts: number,
  ): void;
};

async function compile(url: URL, signal?: AbortSignal): Promise<WebAssembly.Module> {
  signal?.throwIfAborted();
  if (url.protocol === 'file:') {
    const fs = 'node:fs/promises';
    const { readFile } = await import(/* @vite-ignore */ fs);
    return WebAssembly.compile(await readFile(url, { signal }));
  }
  const response = await fetch(url, { signal });
  if (!response.ok)
    throw new MargoError('failed', 'The explosive kernel could not load. Serve its optional Wasm assets.');
  return WebAssembly.compile(await response.arrayBuffer());
}

/** Words of a gun's state: fired (0 or 1), fire time, the shot's muzzle time and the recoil's duration (s), then samples. */
const GUN_HEAD = 4;
/** Samples of a gun's backward momentum, uniform over its recoil's duration. */
export const GUN_SAMPLES = 128;
const GUN_WORDS = GUN_HEAD + GUN_SAMPLES;
const SHOT_GUN = -1;

interface Gun {
  readonly options: GunOptions;
  readonly time: number;
  readonly body: number;
  readonly breech: Vec3;
  readonly axis: Vec3;
}

/** v rotated by the unit quaternion q = (x, y, z, w). */
function rotate(q: ArrayLike<number>, v: Vec3): Vec3 {
  const x = q[0]!,
    y = q[1]!,
    z = q[2]!,
    w = q[3]!;
  const tx = 2 * (y * v[2] - z * v[1]),
    ty = 2 * (z * v[0] - x * v[2]),
    tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

function vec(value: unknown, what: string, unit = false): Vec3 {
  if (!Array.isArray(value) || value.length !== 3 || !value.every((v) => typeof v === 'number' && Number.isFinite(v)))
    throw new RangeError(`${what} must be three finite numbers; got ${String(value)}.`);
  if (!unit) return [value[0], value[1], value[2]];
  const n = hypot(value[0], value[1], value[2]);
  if (!(n > 0)) throw new RangeError(`${what} must not be zero; give the bore's direction.`);
  return [value[0] / n, value[1] / n, value[2] / n];
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
  private dragRegion: Region | null = null;
  private launchRegion: Region | null = null;
  private countsRegion: Region | null = null;
  private fragmentCount = 0;
  private native: Native | null = null;
  private readonly terrain: BedShape | null;
  private ground = 0;
  private steps = 0;
  private flyingNow = 0;
  private guns: Gun[] = [];
  private gunRegion: Region | null = null;
  private impulseRegion: Region | null = null;
  private gunSteps = 0;
  private readonly carriers: boolean;

  /**
   * A solver that flies its fragments in TypeScript; {@link ExplosionSolver.load} gives one that flies them in the
   * explosive kernel (Rust and Wasm, the same bits).
   */
  constructor(
    readonly id = 'explosion',
    options: ExplosionSolverOptions = {},
    private readonly modules?: { plain: WebAssembly.Module; shared?: WebAssembly.Module },
  ) {
    this.carriers = options.carriers === true;
    this.terrain = options.terrain ?? null;
    if (this.terrain) bedVertexCount(this.terrain);
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

  /** Loads the explosive kernel and makes a solver that flies its fragments in it. */
  static async load(
    options: ExplosionSolverOptions & { id?: string; signal?: AbortSignal } = {},
  ): Promise<ExplosionSolver> {
    const { signal, id, ...rest } = options;
    const [plain, shared] = await Promise.all([
      compile(new URL(/* @vite-ignore */ './explosive-kernel.wasm?no-inline', import.meta.url), signal),
      canShareMemory()
        ? compile(new URL(/* @vite-ignore */ './explosive-kernel-shared.wasm?no-inline', import.meta.url), signal)
        : undefined,
    ]);
    signal?.throwIfAborted();
    return new ExplosionSolver(id ?? 'explosion', rest, { plain, shared });
  }

  /** Whether the fragments fly in the explosive kernel. */
  get kernel(): boolean {
    return this.modules !== undefined;
  }

  describe(): SolverDescription {
    return {
      id: this.id,
      rate: 0,
      stableRate: () => 0,
      fields: [
        { field: this.explosionsField, access: 'write' },
        { field: this.fragmentsField, access: 'write' },
        ...(this.carriers
          ? [
              { field: BODIES_FIELD, access: 'read' as const },
              { field: BODY_IMPULSES_FIELD, access: 'accumulate' as const },
            ]
          : []),
        ...(this.terrain ? [{ field: BED_FIELD, access: 'read' as const }] : []),
      ],
    };
  }

  init(host: SolverHost, params: ExplosionParams): void {
    const charges = params?.charges ?? [];
    const guns = params?.guns ?? [];
    if (!Array.isArray(charges) || !Array.isArray(guns) || charges.length + guns.length === 0)
      throw new TypeError(
        'An ExplosionSolver needs charges or guns: world.add(solver, {charges: [{position, mass}]}) or {guns: [...]}.',
      );
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
    const rows = this.carriers ? host.bodyRows() : 0;
    this.guns = guns.map((mount, index) => {
      const at = `Gun ${index}`;
      const time = finite(mount.time ?? 0, `${at} time`, 'Give the firing time in seconds of world time.');
      let body = -1;
      if (mount.body !== undefined) {
        if (!this.carriers)
          throw new MargoError(
            'state',
            `${at} is on body ${mount.body}; make the solver with new ExplosionSolver(id, {carriers: true}) so the recoil reaches it.`,
          );
        if (!(Number.isInteger(mount.body) && mount.body >= 0 && mount.body < rows))
          throw new RangeError(`${at} body must be a rigid body row from 0 to ${rows - 1}; got ${mount.body}.`);
        body = mount.body;
      }
      const { time: _t, body: _b, breech, axis, shotDrag, ...options } = mount;
      // A trial firing on a fixed mount checks the load now, with its fix, rather than at the firing.
      fireGun(options);
      const drag = finite(shotDrag ?? 0.3, `${at} shot drag`, 'Pass a coefficient such as 0.3.');
      const area = (Math.PI * options.bore * options.bore) / 4;
      fragments.push([0, 0, 0, 0, 0, 0, options.shotMass, WAITING]);
      drags.push((AIR_DENSITY * drag * area) / (2 * options.shotMass));
      owners.push(SHOT_GUN - index);
      return { options, time, body, breech: vec(breech, `${at} breech`), axis: vec(axis, `${at} axis`, true) };
    });
    this.host = host;
    this.gunRegion = host.allocate('guns', Math.max(1, this.guns.length) * GUN_WORDS * 8, 'f64', EXPLOSION_LAYOUT);
    if (this.carriers) this.impulseRegion = host.allocate('recoil', rows * IMPULSE_WORDS * 8, 'f64', 1);
    this.explosionRegion = host.allocate(
      'explosions',
      (this.placed.length + this.guns.length) * EXPLOSION_WORDS * 8,
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
    const count = Math.max(1, fragments.length) * 8;
    this.dragRegion = host.allocate('fragment-drag', count, 'f64', EXPLOSION_LAYOUT);
    this.launchRegion = host.allocate('fragment-launch', count, 'f64', EXPLOSION_LAYOUT);
    this.countsRegion = host.allocate('flight-counts', 16, 'f64', EXPLOSION_LAYOUT);
    this.words(this.dragRegion).set(drags);
    // A case fragment leaves when its charge detonates; a shot when its gun's shot reaches the muzzle (set at the firing).
    this.words(this.launchRegion).set(owners.map((owner) => (owner >= 0 ? this.placed[owner]!.time : Infinity)));
    if (this.modules) {
      const module = isShared(host.memory) ? this.modules.shared : this.modules.plain;
      if (!module)
        throw new MargoError(
          'failed',
          'The shared explosive kernel is unavailable. Create the world with plain memory.',
        );
      const stack = host.allocate('explosive-stack', STACK_BYTES, 'u8', EXPLOSION_LAYOUT);
      const native = new WebAssembly.Instance(module, { env: { memory: host.memory } }).exports as unknown as Native;
      if (!(native.__stack_pointer instanceof WebAssembly.Global) || typeof native.fly !== 'function')
        throw new MargoError('failed', 'Unexpected explosive kernel ABI. Rebuild both native assets.');
      native.__stack_pointer.value = Math.floor((stack.byteOffset + stack.byteLength) / 16) * 16;
      this.native = native;
    }
    const table = this.explosions();
    this.placed.forEach((c, i) =>
      table.set(
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
    // A gun's muzzle blast row waits with no time until the gun fires.
    for (let k = 0; k < this.guns.length; k++) table[(this.placed.length + k) * EXPLOSION_WORDS + 3] = Infinity;
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
      (this.placed.length + this.guns.length) * EXPLOSION_WORDS,
    );
  }
  private words(region: Region): Float64Array {
    return new Float64Array(this.live().memory.buffer, region.byteOffset, region.byteLength / 8);
  }
  private gunWords(): Float64Array {
    return new Float64Array(this.live().memory.buffer, this.gunRegion!.byteOffset, this.guns.length * GUN_WORDS);
  }

  /** The gun's backward momentum, kg m/s, `t` seconds after it fired, from its samples. */
  private recoilAt(words: Float64Array, o: number, t: number): number {
    const duration = words[o + 3]!;
    if (t <= 0) return 0;
    const x = Math.min(t / duration, 1) * (GUN_SAMPLES - 1);
    const i = Math.min(Math.floor(x), GUN_SAMPLES - 2);
    const a = words[o + GUN_HEAD + i]!,
      b = words[o + GUN_HEAD + i + 1]!;
    return a + (b - a) * (x - i);
  }

  /** Fire gun `k`: its ballistics with its carrier's mass, its recoil samples, its shot and its muzzle blast. */
  private fire(k: number, bodies: Float32Array | null, words: Float64Array): void {
    const gun = this.guns[k]!;
    let origin: Vec3 = gun.breech,
      axis = gun.axis,
      velocity: Vec3 = [0, 0, 0],
      recoilMass: number | undefined;
    if (gun.body >= 0 && bodies) {
      const at = gun.body * BODY_WORDS;
      const q = bodies.subarray(at + 3, at + 7);
      const local = rotate(q, gun.breech);
      origin = [bodies[at]! + local[0], bodies[at + 1]! + local[1], bodies[at + 2]! + local[2]];
      axis = rotate(q, gun.axis);
      velocity = [bodies[at + 10]!, bodies[at + 11]!, bodies[at + 12]!];
      const inverse = bodies[at + 16]!;
      if (inverse > 0) recoilMass = 1 / inverse;
    }
    const firing: Firing = fireGun({ ...gun.options, recoilMass });
    this.gunSteps += firing.steps;
    const o = k * GUN_WORDS;
    const duration = firing.muzzleTime + firing.blowdownTime;
    words[o] = 1;
    words[o + 1] = gun.time;
    words[o + 2] = firing.muzzleTime;
    words[o + 3] = duration;
    // Resample the history's momentum uniformly over the duration (the history's times only increase).
    const h = firing.history;
    let r = 0;
    for (let i = 0; i < GUN_SAMPLES; i++) {
      const t = (duration * i) / (GUN_SAMPLES - 1);
      while (r + 2 * HISTORY_WORDS <= h.length && h[r + HISTORY_WORDS]! <= t) r += HISTORY_WORDS;
      const t0 = h[r]!,
        m0 = h[r + 4]!;
      if (r + HISTORY_WORDS >= h.length) words[o + GUN_HEAD + i] = m0;
      else {
        const t1 = h[r + HISTORY_WORDS]!,
          m1 = h[r + HISTORY_WORDS + 4]!;
        words[o + GUN_HEAD + i] = t1 > t0 ? m0 + ((m1 - m0) * (t - t0)) / (t1 - t0) : m1;
      }
    }
    const travel = gun.options.travel;
    const muzzle: Vec3 = [origin[0] + axis[0] * travel, origin[1] + axis[1] * travel, origin[2] + axis[2] * travel];
    // The shot: from the muzzle, at the carrier's velocity plus its own over the ground.
    const f = this.fragmentWords();
    const shot = this.fragmentCount - this.guns.length + k;
    this.words(this.launchRegion!)[shot] = gun.time + firing.muzzleTime;
    f.set(
      [
        ...muzzle,
        velocity[0] + axis[0] * firing.shotVelocity,
        velocity[1] + axis[1] * firing.shotVelocity,
        velocity[2] + axis[2] * firing.shotVelocity,
        gun.options.shotMass,
        WAITING,
      ],
      shot * FRAGMENT_WORDS,
    );
    // The muzzle blast: the gas's energy as the shot leaves, all into the air.
    const row = (this.placed.length + k) * EXPLOSION_WORDS;
    this.explosions().set(
      [
        ...muzzle,
        gun.time + firing.muzzleTime,
        firing.muzzleGasEnergy,
        firing.muzzleGasEnergy,
        0,
        0,
        firing.muzzleGasMass,
        0,
        0,
        0,
        0,
        0,
      ],
      row,
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
    const rate = rateOf(context.level);
    const start = context.tick / rate,
      end = (context.tick + 1) / rate;
    if (this.guns.length > 0) this.stepGuns(context, start, end);
    const rows = this.explosions();
    for (let i = 0; i < this.placed.length + this.guns.length; i++)
      if (rows[i * EXPLOSION_WORDS + 3]! < end) rows[i * EXPLOSION_WORDS + 9] = 1;
    const g = host.gravity;
    let bed: FlightBed | null = null;
    let bedOffset = 0;
    if (this.terrain) {
      const port = context.inputs.get(BED_FIELD.name);
      const vertices = bedVertexCount(this.terrain);
      if (
        !port ||
        port.region.layout !== BED_LAYOUT ||
        port.region.type !== 'f32' ||
        port.region.byteLength !== vertices * 4
      )
        throw new MargoError(
          'state',
          `The fragments land on a ${this.terrain.columns} by ${this.terrain.rows} terrain bed; add a TerrainBed of that shape to the world.`,
        );
      const memory = port.region.memory ?? host.memory;
      if (memory !== host.memory && this.native)
        throw new MargoError('state', 'The terrain bed must live in the world memory for the explosive kernel.');
      bedOffset = port.region.byteOffset;
      bed = { ...this.terrain, elevations: new Float32Array(memory.buffer, bedOffset, vertices) };
    }
    let flying: number;
    if (this.native) {
      const t = this.terrain;
      this.native.fly(
        this.fragmentRegion!.byteOffset,
        this.dragRegion!.byteOffset,
        this.launchRegion!.byteOffset,
        this.fragmentCount,
        dt,
        end,
        g[0],
        g[1],
        g[2],
        this.ground,
        bed ? bedOffset : 0,
        t?.columns ?? 0,
        t?.rows ?? 0,
        t?.width ?? 0,
        t?.depth ?? 0,
        t?.centre[0] ?? 0,
        t?.centre[1] ?? 0,
        this.countsRegion!.byteOffset,
      );
      const counts = this.words(this.countsRegion!);
      flying = counts[0]!;
      this.steps += counts[1]!;
    } else {
      const [now, steps] = flyFragments(
        this.fragmentWords(),
        this.words(this.dragRegion!),
        this.words(this.launchRegion!),
        this.fragmentCount,
        dt,
        end,
        [g[0], g[1], g[2]],
        this.ground,
        bed,
      );
      flying = now;
      this.steps += steps;
    }
    this.flyingNow = flying;
  }

  /** Fire the guns whose time has come and push their carriers back by the recoil this step holds. */
  private stepGuns(context: StepContext, start: number, end: number): void {
    const host = this.live();
    const words = this.gunWords();
    let bodies: Float32Array | null = null;
    let impulses: Float64Array | null = null;
    if (this.carriers) {
      const source = context.inputs.get(BODIES_FIELD.name)?.region;
      if (!source || source.type !== 'f32' || source.layout !== 2)
        throw new MargoError(
          'state',
          "The guns need the rigid solver's layout-2 bodies field; add a RigidSolver to the world before the ExplosionSolver.",
        );
      bodies = new Float32Array((source.memory ?? host.memory).buffer, source.byteOffset, source.byteLength / 4);
      impulses = new Float64Array(
        host.memory.buffer,
        this.impulseRegion!.byteOffset,
        this.impulseRegion!.byteLength / 8,
      );
      impulses.fill(0);
    }
    for (let k = 0; k < this.guns.length; k++) {
      const gun = this.guns[k]!;
      const o = k * GUN_WORDS;
      if (words[o] !== 1 && gun.time < end) this.fire(k, bodies, words);
      if (words[o] !== 1 || gun.body < 0 || !bodies || !impulses) continue;
      const since = words[o + 1]!;
      const pushed = this.recoilAt(words, o, end - since) - this.recoilAt(words, o, Math.max(start - since, 0));
      if (pushed === 0) continue;
      // Backward along the bore as it points now, at the breech: the linear impulse and its moment about the centre of mass.
      const at = gun.body * BODY_WORDS;
      const q = bodies.subarray(at + 3, at + 7);
      const axis = rotate(q, gun.axis);
      const local = rotate(q, gun.breech);
      const arm: Vec3 = [
        bodies[at]! + local[0] - bodies[at + 7]!,
        bodies[at + 1]! + local[1] - bodies[at + 8]!,
        bodies[at + 2]! + local[2] - bodies[at + 9]!,
      ];
      const j: Vec3 = [-axis[0] * pushed, -axis[1] * pushed, -axis[2] * pushed];
      const row = gun.body * IMPULSE_WORDS;
      impulses[row] = impulses[row]! + j[0];
      impulses[row + 1] = impulses[row + 1]! + j[1];
      impulses[row + 2] = impulses[row + 2]! + j[2];
      impulses[row + 3] = impulses[row + 3]! + (arm[1] * j[2] - arm[2] * j[1]);
      impulses[row + 4] = impulses[row + 4]! + (arm[2] * j[0] - arm[0] * j[2]);
      impulses[row + 5] = impulses[row + 5]! + (arm[0] * j[1] - arm[1] * j[0]);
    }
  }

  exportPorts(tick: number): readonly Port[] {
    this.live();
    return [
      { field: this.explosionsField.name, region: this.explosionRegion!, tick, cell: [0, 0, 0] },
      { field: this.fragmentsField.name, region: this.fragmentRegion!, tick, cell: [0, 0, 0] },
      ...(this.impulseRegion
        ? [
            {
              field: BODY_IMPULSES_FIELD.name,
              region: this.impulseRegion,
              tick,
              cell: [0, 0, 0] as [number, number, number],
            },
          ]
        : []),
    ];
  }

  importPorts(_tick: number): void {}

  stateRegions(): readonly Region[] {
    this.live();
    return [
      this.explosionRegion!,
      this.fragmentRegion!,
      this.gunRegion!,
      this.launchRegion!,
      ...(this.impulseRegion ? [this.impulseRegion] : []),
    ];
  }

  extraState(): readonly Region[] {
    return [];
  }

  /** The work the last steps did (the fragment steps are counted since the solver was made). */
  get counts(): ExplosionCounts {
    return { flying: this.flyingNow, fragmentSteps: this.steps, gunSteps: this.gunSteps };
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

  /**
   * Gun `index`: whether it has fired, when, when its shot left the muzzle, and its backward momentum so far (kg m/s, the
   * impulse its gas has given its carrier or mounting). @throws RangeError for an index out of range.
   */
  gun(index: number): { fired: boolean; time: number; muzzleTime: number; recoilMomentum: number } {
    if (!(Number.isInteger(index) && index >= 0 && index < this.guns.length))
      throw new RangeError(`ExplosionSolver has guns 0 to ${this.guns.length - 1}; got ${index}.`);
    const w = this.gunWords(),
      o = index * GUN_WORDS;
    return {
      fired: w[o] === 1,
      time: w[o + 1]!,
      muzzleTime: w[o + 2]!,
      recoilMomentum: w[o] === 1 ? w[o + GUN_HEAD + GUN_SAMPLES - 1]! : 0,
    };
  }

  /**
   * Gun `index`'s muzzle blast as the `explosions` field publishes it (its row follows the charges'): where and when the
   * shot left, the gas's energy and mass then, and whether that time has come. Before the gun fires its time is Infinity.
   * @throws RangeError for an index out of range.
   */
  muzzleBlast(index: number): { position: Vec3; time: number; energy: number; gasMass: number; detonated: boolean } {
    if (!(Number.isInteger(index) && index >= 0 && index < this.guns.length))
      throw new RangeError(`ExplosionSolver has guns 0 to ${this.guns.length - 1}; got ${index}.`);
    const o = (this.placed.length + index) * EXPLOSION_WORDS;
    const r = this.explosions().subarray(o, o + EXPLOSION_WORDS);
    return { position: [r[0]!, r[1]!, r[2]!], time: r[3]!, energy: r[4]!, gasMass: r[8]!, detonated: r[9] === 1 };
  }

  /** A copy of the fragments: rows of {@link FRAGMENT_WORDS} words (x, y, z, vx, vy, vz, mass, state). */
  fragments(): Float64Array {
    return Float64Array.from(this.fragmentWords());
  }
}
