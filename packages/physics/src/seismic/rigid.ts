import { regionWords } from '../world/memory.js';
import type { Cell, FieldDescriptor, Port, Region, Solver, SolverHost, StepContext } from '../world/solver.js';
import { BODIES_FIELD, BODY_FORCES_FIELD, BODY_WORDS, FORCE_WORDS } from '../world/solvers/rigid.js';
import { SEISMIC_LAYOUT, SEISMIC_SURFACE_WORDS } from './ports.js';

/** Maps selected moving bodies into the reference frame of their shaking supports. */
export interface SeismicInertialParams {
  /** The connected RigidSolver's published body capacity. */
  bodyCapacity: number;
  /** One support sample for each coupled rigid row. */
  supports: readonly { body: number; column: number }[];
}

/** Applies −m a_ground to selected bodies through the ordinary `bodyForces` accumulator. */
export class SeismicInertialLoad implements Solver<SeismicInertialParams> {
  private host!: SolverHost;
  private forces!: Region;
  private cell: Cell = [0, 0, 0];
  private supports: SeismicInertialParams['supports'] = [];

  constructor(
    private readonly ground: FieldDescriptor,
    readonly id = 'seismic-inertial-load',
  ) {}

  describe() {
    return {
      id: this.id,
      rate: 0 as const,
      stableRate: () => 0 as const,
      fields: [
        { field: this.ground, access: 'read' as const },
        { field: BODIES_FIELD, access: 'read' as const },
        { field: BODY_FORCES_FIELD, access: 'accumulate' as const },
      ],
    };
  }

  init(host: SolverHost, params: SeismicInertialParams): void {
    if (!Number.isSafeInteger(params.bodyCapacity) || params.bodyCapacity < 1)
      throw new RangeError('Seismic rigid coupling needs the published body capacity. Pass the RigidSolver capacity.');
    this.host = host;
    const seen = new Set<number>();
    this.supports = params.supports.map(({ body, column }) => {
      if (
        !Number.isSafeInteger(body) ||
        body < 0 ||
        body >= params.bodyCapacity ||
        seen.has(body) ||
        !Number.isSafeInteger(column) ||
        column < 0
      )
        throw new RangeError(
          'Invalid seismic support mapping. Pass unique rigid rows and nonnegative seismic columns.',
        );
      seen.add(body);
      return { body, column };
    });
    this.forces = host.allocate('seismic-inertial-forces', params.bodyCapacity * FORCE_WORDS * 8, 'f64', 1);
  }

  step(context: StepContext): void {
    this.cell = context.cell;
    const out = regionWords(this.host.memory, this.forces) as Float64Array;
    out.fill(0);
    const motion = context.inputs.get(this.ground.name)?.region;
    const bodies = context.inputs.get(BODIES_FIELD.name)?.region;
    if (!motion || !bodies) return;
    if (motion.type !== 'f64' || motion.layout !== SEISMIC_LAYOUT || motion.byteLength % (SEISMIC_SURFACE_WORDS * 8))
      throw new RangeError('Invalid seismic motion field. You must connect the groundField from a SeismicGround instance.');
    if (
      bodies.type !== 'f32' ||
      bodies.layout !== 2 ||
      bodies.byteLength / (BODY_WORDS * 4) !== out.length / FORCE_WORDS
    )
      throw new RangeError('Invalid rigid field for seismic loads. You must match the rigid solver body capacity and layout.');
    const ground = regionWords(motion.memory ?? this.host.memory, motion) as Float64Array;
    const bodyWords = regionWords(bodies.memory ?? this.host.memory, bodies) as Float32Array;
    for (const { body, column } of this.supports) {
      const at = column * SEISMIC_SURFACE_WORDS;
      if (at >= ground.length)
        throw new RangeError('Missing seismic support column. Choose a column published by the ground solver.');
      const invMass = bodyWords[body * BODY_WORDS + 16]!;
      if (!(invMass > 0)) continue;
      const outAt = body * FORCE_WORDS;
      out[outAt] = -ground[at + 5]! / invMass;
      out[outAt + 1] = -ground[at + 6]! / invMass;
    }
  }

  exportPorts(tick: number): readonly Port[] {
    return [{ field: BODY_FORCES_FIELD.name, region: this.forces, tick, cell: this.cell }];
  }

  importPorts(): void {}

  stateRegions(): readonly Region[] {
    return [this.forces];
  }

  extraState(): readonly Region[] {
    return [];
  }
}
