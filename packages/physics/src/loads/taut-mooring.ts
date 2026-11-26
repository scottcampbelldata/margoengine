import { hypot } from '@margoengine/math/pinned';
import { rotateByQuaternion } from '@margoengine/math/quat';
import { add, dot, scale, sub } from '@margoengine/math/vec3';
import { atContact, impulseAt } from '../crush/rigid-contact.js';
import {
  type Port,
  type RateLevel,
  RATE_LEVELS,
  type Region,
  type Solver,
  type SolverDescription,
  type SolverHost,
  type StepContext,
} from '../world/solver.js';
import { BODIES_FIELD, BODY_IMPULSES_FIELD, BODY_WORDS, IMPULSE_WORDS } from '../world/solvers/rigid.js';
import { invalidLoad } from './errors.js';

type Vector = readonly [number, number, number];
const zero: Vector = [0, 0, 0];
const LOAD_WORDS = 4;

/** A pinned line attachment on a rigid row. Use a fixed body to model a pile anchored in the bed. */
export interface TautMooringEnd {
  /** Rigid body row. */
  readonly row: number;
  /** Attachment in metres in the body's local frame, relative to its origin. Defaults to the origin. */
  readonly point?: Vector;
}

/** A short, taut line with negligible weight, drag and line inertia. Its attachments can rotate freely. */
export interface TautMooringLine {
  /** The holding structure or fixed pile. */
  readonly anchor: TautMooringEnd;
  /** The connection on the floating body. */
  readonly fairlead: TautMooringEnd;
  /** Unstretched length, in m. Shorter end-to-end spans are slack. */
  readonly length: number;
  /** Measured or specified line axial rigidity EA, in N. */
  readonly axialRigidity: number;
}

export interface TautMooringParams {
  /** Lines in their solve order. Lines sharing bodies account for impulses staged by earlier lines. */
  readonly lines: readonly TautMooringLine[];
  /** Match the staggered RigidSolver's rate level. Defaults to zero (60 Hz). */
  readonly rate?: RateLevel;
}

/** The last line impulse expressed as the average force over its step. */
export interface TautMooringLoad {
  readonly tension: number;
  /** Reaction on the anchor, in world axes and newtons, including reactions on fixed rows. */
  readonly anchorForce: Vector;
}

function attachment(end: TautMooringEnd | undefined, rows: number): Required<TautMooringEnd> {
  if (!end || !Number.isSafeInteger(end.row) || end.row < 0 || end.row >= rows)
    throw invalidLoad('Choose an existing rigid body row for each mooring anchor and fairlead.');
  const point = end.point ?? zero;
  if (point.length !== 3 || !point.every(Number.isFinite))
    throw invalidLoad('Provide three finite body-local coordinates for each mooring attachment.');
  return { row: end.row, point: [point[0], point[1], point[2]] };
}

function attachmentPoint(values: Float32Array, end: TautMooringEnd): Vector {
  const at = end.row * BODY_WORDS;
  const rotation = values.subarray(at + 3, at + 7);
  if (!rotation.some((word) => word !== 0))
    throw invalidLoad(
      'Keep each mooring end attached to a live rigid body; recreate the mooring after removing a body.',
    );
  return add(values.subarray(at, at + 3), rotateByQuaternion(end.point ?? zero, rotation));
}

/** Elastic tension-only tether between rigid bodies, including the holding reaction at a fixed seabed pile.
 * Hall (2024), Generalized Quasi-Static Mooring System Modeling, §2.1: the zero-wet-weight, straight-line limit.
 * The local material law is also the axial elasticity term of Hall and Goupee (2015), Ocean Engineering 104.
 * Use a distributed rod with water and seabed loads when catenary sag, touchdown or line inertia are significant.
 */
export class TautMooringSolver implements Solver<TautMooringParams> {
  private host?: SolverHost;
  private impulses?: Region;
  private loads?: Region;
  private rate: RateLevel = 0;
  private lines: readonly TautMooringLine[] = [];

  constructor(readonly id = 'tautMooring') {}

  describe(): SolverDescription {
    return {
      id: this.id,
      rate: this.rate,
      stableRate: () => this.rate,
      fields: [
        { field: BODIES_FIELD, access: 'read' },
        { field: BODY_IMPULSES_FIELD, access: 'accumulate' },
      ],
    };
  }

  init(host: SolverHost, params: TautMooringParams): void {
    if (!params?.lines?.length)
      throw invalidLoad('Provide at least one line to attach the mooring anchor to a fairlead.');
    const rate = params.rate ?? 0;
    if (!Number.isInteger(rate) || rate < 0 || rate >= RATE_LEVELS)
      throw invalidLoad('Choose a mooring rate level from 0 to 7 that matches the rigid solver.');
    const rows = host.bodyRows();
    const lines = params.lines.map((line) => {
      const anchor = attachment(line?.anchor, rows);
      const fairlead = attachment(line?.fairlead, rows);
      if (anchor.row === fairlead.row) throw invalidLoad('Attach each mooring line to two distinct rigid body rows.');
      const { length, axialRigidity } = line;
      if (
        !(length > 0 && axialRigidity > 0 && Number.isFinite(length) && Number.isFinite(axialRigidity)) ||
        !(length / axialRigidity > 0 && Number.isFinite(length / axialRigidity))
      )
        throw invalidLoad(
          'Choose a positive finite mooring length and axial rigidity with finite positive compliance.',
        );
      return { anchor, fairlead, length, axialRigidity };
    });
    this.impulses = host.allocate('mooringImpulses', rows * IMPULSE_WORDS * 8, 'f64', 1);
    this.loads = host.allocate('mooringLoads', lines.length * LOAD_WORDS * 8, 'f64', 1);
    this.lines = lines;
    this.host = host;
    this.rate = rate;
  }

  private words(region: Region | undefined): Float64Array {
    if (!region || !this.host) throw invalidLoad('Add the mooring solver to a PhysicsWorld before using it.');
    return new Float64Array(this.host.memory.buffer, region.byteOffset, region.byteLength / 8);
  }

  step({ inputs }: StepContext, dt: number): void {
    const source = inputs.get(BODIES_FIELD.name)?.region;
    const impulses = this.words(this.impulses);
    const loads = this.words(this.loads);
    if (
      !source ||
      source.type !== 'f32' ||
      source.layout !== 2 ||
      source.byteLength / (4 * BODY_WORDS) !== impulses.length / IMPULSE_WORDS
    )
      throw invalidLoad('Use a matching layout-2 rigid body field and couple the mooring before the rigid solver.');
    const bodies = new Float32Array(
      (source.memory ?? this.host!.memory).buffer,
      source.byteOffset,
      source.byteLength / 4,
    );
    impulses.fill(0);
    loads.fill(0);
    for (let i = 0; i < this.lines.length; i++) {
      const { anchor, fairlead, length, axialRigidity } = this.lines[i]!;
      const a = attachmentPoint(bodies, anchor);
      const b = attachmentPoint(bodies, fairlead);
      const span = sub(b, a);
      const distance = hypot(span[0], span[1], span[2]);
      if (distance === 0) continue;
      const direction: Vector = [span[0] / distance, span[1] / distance, span[2] / distance];
      const first = atContact(bodies, impulses, anchor.row, a, direction);
      const second = atContact(bodies, impulses, fairlead.row, b, direction);
      const invMass = first.inverseMass + second.inverseMass;
      const rate = dot(sub(second.velocity, first.velocity), direction);
      // v' = v - dt T w, x' = x + dt v', T = (EA/L) max(x', 0). Eliminating x' and v' gives
      // the one-sided backward Euler spring. Zero tension never pushes the bodies apart.
      const tension = Math.max(0, distance - length + dt * rate) / (length / axialRigidity + dt * dt * invMass);
      const force = scale(direction, tension);
      const impulse = scale(force, dt);
      if (!force.every(Number.isFinite) || !impulse.every(Number.isFinite))
        throw invalidLoad('Choose mooring geometry, stiffness and velocities whose tension and impulse are finite.');
      impulseAt(impulses, anchor.row, impulse, first.arm);
      impulseAt(impulses, fairlead.row, scale(impulse, -1), second.arm);
      for (const row of [anchor.row, fairlead.row]) {
        if (!impulses.subarray(row * IMPULSE_WORDS, (row + 1) * IMPULSE_WORDS).every(Number.isFinite))
          throw invalidLoad(
            'Use mooring attachment lever arms and stiffnesses whose combined body impulses are finite.',
          );
      }
      loads.set([tension, force[0], force[1], force[2]], i * LOAD_WORDS);
    }
  }

  /** The last realized holding load, available for fixed and moving anchors alike. */
  readLine(line: number): TautMooringLoad {
    if (!Number.isSafeInteger(line) || line < 0 || line >= this.lines.length)
      throw invalidLoad('Choose a line index from the installed mooring lines.');
    const values = this.words(this.loads);
    const at = line * LOAD_WORDS;
    return { tension: values[at]!, anchorForce: [values[at + 1]!, values[at + 2]!, values[at + 3]!] };
  }

  exportPorts(tick: number): readonly Port[] {
    if (!this.impulses)
      throw invalidLoad('Add the mooring solver to a PhysicsWorld before exporting its impulse field.');
    return [{ field: BODY_IMPULSES_FIELD.name, region: this.impulses, tick, cell: [0, 0, 0] }];
  }

  importPorts(): void {}

  stateRegions(): readonly Region[] {
    if (!this.impulses || !this.loads) return [];
    return [this.impulses, this.loads];
  }

  extraState(): readonly Region[] {
    return [];
  }
}
