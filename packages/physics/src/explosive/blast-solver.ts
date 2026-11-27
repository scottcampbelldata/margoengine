// The blast as a solver of the physics framework (FIRE-04): it reads an ExplosionSolver's `explosions` field (FIRE-05) and,
// for every charge gone off, loads the rigid bodies the blast reaches. Each body takes, over each step, the reflected
// positive-phase impulse that arrives in it (the closed-form Friedlander integral between the step's start and end, so a
// step's length does not change the total), times its box's area seen from the charge, along the line from the charge, at
// its box's centre, through `bodyImpulses`; a breakable target takes the same impulse as an impact. `pressureAt` gives the
// overpressure anywhere at any time for sound and camera shake (SOUND-01, PA-66).
import type { Vec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import { hypot } from '@margoengine/math/pinned';
import type { Physics } from '../physics.js';
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
import { BODIES_FIELD, BODY_IMPULSES_FIELD, BODY_WORDS, IMPULSE_WORDS } from '../world/solvers/rigid.js';
import {
  type Atmosphere,
  type BlastPoint,
  blastAt,
  impulseSoFar,
  overpressureAt,
  projectedArea,
  scaledOverpressure,
} from './blast.js';
import { freeAirEquivalent } from './charge.js';
import { invalidExplosive } from './errors.js';
import { EXPLOSION_WORDS, type ImpactTarget } from './solver.js';

/** What a {@link BlastSolver} is made from. */
export interface BlastParams {
  /** The rigid world whose bodies the blast loads (the Physics the RigidSolver steps). */
  readonly physics: Physics;
  /** The air (default 101,325 Pa, 288.15 K). */
  readonly air?: Atmosphere;
  /** The side-on overpressure below which the blast is not applied, Pa (default 200: a window pane's tenth). */
  readonly threshold?: number;
  /** What takes each body's blast impulse as an impact (a BreakableWorld, BREAK-01). */
  readonly breakables?: ImpactTarget;
}

/** The work a step did. */
export interface BlastCounts {
  /** Body loads applied in all (one a body a charge a step that had impulse). */
  readonly loads: number;
  /** The total impulse given to bodies so far, N s. */
  readonly impulse: number;
}

/** The air blast of explosions on the rigid bodies they reach. */
export class BlastSolver implements Solver<BlastParams> {
  private host: SolverHost | null = null;
  private physics: Physics | null = null;
  private air: Atmosphere = {};
  private threshold = 200;
  private breakables: ImpactTarget | null = null;
  private impulses: Region | null = null;
  /** The impulse per area each charge has delivered to each body so far, Pa s (charges by body rows). */
  private delivered: Region | null = null;
  private rows = 0;
  private loads = 0;
  private total = 0;

  /** @param explosions - the `explosionsField` of the ExplosionSolver whose charges make the blasts. */
  constructor(
    readonly explosions: FieldDescriptor,
    readonly id = 'blast',
  ) {
    if (!explosions || explosions.kind !== 'particleSet' || !explosions.name.endsWith(':explosions'))
      throw invalidExplosive("A BlastSolver reads an ExplosionSolver's explosionsField; pass it.");
  }

  describe(): SolverDescription {
    return {
      id: this.id,
      rate: 0,
      stableRate: () => 0,
      fields: [
        { field: this.explosions, access: 'read' },
        { field: BODIES_FIELD, access: 'read' },
        { field: BODY_IMPULSES_FIELD, access: 'accumulate' },
      ],
    };
  }

  init(host: SolverHost, params: BlastParams): void {
    if (!params?.physics || typeof params.physics.intersectAabb !== 'function')
      throw invalidExplosive('A BlastSolver needs the Physics whose bodies it loads: world.add(blast, {physics}).');
    const threshold = params.threshold ?? 200;
    if (!(Number.isFinite(threshold) && threshold > 0))
      throw invalidExplosive(`Blast threshold must be a finite number of pascals above 0; got ${threshold}.`);
    if (params.breakables !== undefined && typeof params.breakables?.applyImpact !== 'function')
      throw invalidExplosive('breakables must have applyImpact(point, impulse), as a BreakableWorld does.');
    // Check the air now, with its fix.
    blastAt(1, 1, params.air ?? {});
    this.physics = params.physics;
    this.air = params.air ?? {};
    this.threshold = threshold;
    this.breakables = params.breakables ?? null;
    this.host = host;
    this.rows = host.bodyRows();
    this.impulses = host.allocate('blast-impulses', this.rows * IMPULSE_WORDS * 8, 'f64', 1);
    // The charges are the explosions field's rows, so the explosive solver goes into the world first.
    const port = host.port(this.explosions.name);
    if (!port)
      throw invalidExplosive(
        'Add the ExplosionSolver to the world before the BlastSolver that reads its explosions field.',
      );
    const charges = Math.floor(port.region.byteLength / 8 / EXPLOSION_WORDS);
    this.delivered = host.allocate('blast-delivered', Math.max(1, charges * this.rows) * 8, 'f64', 1);
  }

  private live(): SolverHost {
    if (!this.host)
      throw new MargoError('state', 'BlastSolver is not in a world yet; add it with world.add(blast, {physics}).');
    return this.host;
  }

  /** The blast of a row of the explosions field: its free-air energy (twice the air energy for a hemisphere on the ground). */
  private static energyOf(row: Float64Array, o: number): number {
    return freeAirEquivalent({ air: row[o + 5]!, ground: row[o + 6]! });
  }

  /** The distance, m, beyond which the blast of `energy` J is under the threshold. */
  private reach(energy: number): number {
    const pa = this.air.pressure ?? 101325;
    let lo = 1e-3,
      hi = 1e5;
    for (let i = 0; i < 80; i++) {
      const mid = Math.sqrt(lo * hi);
      if (scaledOverpressure(mid) * pa > this.threshold) lo = mid;
      else hi = mid;
    }
    // Z in m kg^-1/3; back to metres in the reference air (Sachs's factor is close to 1 near the ground).
    return hi * Math.cbrt(energy / 4.184e6) * 1.05;
  }

  step(context: StepContext, _dt: number): void {
    const host = this.live();
    const rate = rateOf(context.level);
    const start = context.tick / rate,
      end = (context.tick + 1) / rate;
    const port = context.inputs.get(this.explosions.name);
    const bodiesPort = context.inputs.get(BODIES_FIELD.name)?.region;
    if (!port || !bodiesPort || bodiesPort.type !== 'f32' || bodiesPort.layout !== 2)
      throw new MargoError(
        'state',
        "The blast needs the ExplosionSolver's explosions and the rigid solver's layout-2 bodies; add both to the world.",
      );
    const rows = new Float64Array(
      (port.region.memory ?? host.memory).buffer,
      port.region.byteOffset,
      port.region.byteLength / 8,
    );
    const bodies = new Float32Array(
      (bodiesPort.memory ?? host.memory).buffer,
      bodiesPort.byteOffset,
      bodiesPort.byteLength / 4,
    );
    const impulses = new Float64Array(host.memory.buffer, this.impulses!.byteOffset, this.impulses!.byteLength / 8);
    impulses.fill(0);
    const delivered = new Float64Array(host.memory.buffer, this.delivered!.byteOffset, this.delivered!.byteLength / 8);
    for (let o = 0; o + EXPLOSION_WORDS <= rows.length; o += EXPLOSION_WORDS) {
      const time = rows[o + 3]!;
      if (!(time < end) || rows[o + 5]! <= 0) continue;
      const energy = BlastSolver.energyOf(rows, o);
      const reach = this.reach(energy);
      const src: Vec3 = [rows[o]!, rows[o + 1]!, rows[o + 2]!];
      const far = blastAt(energy, reach, this.air);
      // Past the reach's arrival and positive phase, nothing is left to apply.
      if (start - time > far.arrival + far.duration) continue;
      const found = this.physics!.intersectAabb(
        [src[0] - reach, src[1] - reach, src[2] - reach],
        [src[0] + reach, src[1] + reach, src[2] + reach],
      );
      for (const body of found) {
        if (body.type !== 'dynamic' || body.colliders.length === 0) continue;
        const row = body.row;
        if (row * BODY_WORDS + 16 >= bodies.length || !(bodies[row * BODY_WORDS + 16]! > 0)) continue;
        const min = [Infinity, Infinity, Infinity],
          max = [-Infinity, -Infinity, -Infinity];
        for (const collider of body.colliders) {
          const box = collider.aabb();
          for (let k = 0; k < 3; k++) {
            min[k] = Math.min(min[k]!, box.min[k]!);
            max[k] = Math.max(max[k]!, box.max[k]!);
          }
        }
        const centre: Vec3 = [(min[0]! + max[0]!) / 2, (min[1]! + max[1]!) / 2, (min[2]! + max[2]!) / 2];
        const half: Vec3 = [(max[0]! - min[0]!) / 2, (max[1]! - min[1]!) / 2, (max[2]! - min[2]!) / 2];
        const d: Vec3 = [centre[0] - src[0], centre[1] - src[1], centre[2] - src[2]];
        const r = hypot(d[0], d[1], d[2]);
        if (!(r > 0) || r > reach) continue;
        const n: Vec3 = [d[0] / r, d[1] / r, d[2] / r];
        const point = blastAt(energy, r, this.air);
        // What has arrived by the step's end, at the body's distance now, less what was already delivered: a body that moves
        // during the positive phase gets the whole impulse once, never its front twice.
        const slot = (o / EXPLOSION_WORDS) * this.rows + row;
        if (slot >= delivered.length) continue;
        const target = impulseSoFar(point, end - time - point.arrival, true);
        const dI = target - delivered[slot]!;
        if (!(dI > 0)) continue;
        delivered[slot] = target;
        const area = projectedArea(half, n);
        const j: Vec3 = [n[0] * dI * area, n[1] * dI * area, n[2] * dI * area];
        const at = row * BODY_WORDS,
          w = row * IMPULSE_WORDS;
        const arm: Vec3 = [centre[0] - bodies[at + 7]!, centre[1] - bodies[at + 8]!, centre[2] - bodies[at + 9]!];
        impulses[w] = impulses[w]! + j[0];
        impulses[w + 1] = impulses[w + 1]! + j[1];
        impulses[w + 2] = impulses[w + 2]! + j[2];
        impulses[w + 3] = impulses[w + 3]! + (arm[1] * j[2] - arm[2] * j[1]);
        impulses[w + 4] = impulses[w + 4]! + (arm[2] * j[0] - arm[0] * j[2]);
        impulses[w + 5] = impulses[w + 5]! + (arm[0] * j[1] - arm[1] * j[0]);
        this.breakables?.applyImpact(centre, j);
        this.loads++;
        this.total += dI * area;
      }
    }
  }

  exportPorts(tick: number): readonly Port[] {
    this.live();
    return [{ field: BODY_IMPULSES_FIELD.name, region: this.impulses!, tick, cell: [0, 0, 0] }];
  }

  importPorts(_tick: number): void {}

  stateRegions(): readonly Region[] {
    this.live();
    return [this.impulses!, this.delivered!];
  }

  extraState(): readonly Region[] {
    return [];
  }

  /** The work so far. */
  get counts(): BlastCounts {
    return { loads: this.loads, impulse: this.total };
  }

  /**
   * The side-on overpressure at `point` at world `time` (Pa), summed over every charge of the explosions field whose shock has
   * reached it and whose positive phase is not over: for a microphone, a listener or a camera's shake.
   */
  pressureAt(point: Vec3, time: number): number {
    const host = this.live();
    const port = host.port(this.explosions.name);
    if (!port) return 0;
    const rows = new Float64Array(
      (port.region.memory ?? host.memory).buffer,
      port.region.byteOffset,
      port.region.byteLength / 8,
    );
    let p = 0;
    for (let o = 0; o + EXPLOSION_WORDS <= rows.length; o += EXPLOSION_WORDS) {
      if (!(rows[o + 3]! <= time) || rows[o + 5]! <= 0) continue;
      const r = hypot(point[0] - rows[o]!, point[1] - rows[o + 1]!, point[2] - rows[o + 2]!);
      if (!(r > 0)) continue;
      const blast: BlastPoint = blastAt(BlastSolver.energyOf(rows, o), r, this.air);
      p += overpressureAt(blast, time - rows[o + 3]! - blast.arrival);
    }
    return p;
  }
}
