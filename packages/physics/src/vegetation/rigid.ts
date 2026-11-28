import { MargoError } from '@margoengine/math/errors';
import { hypot } from '@margoengine/math/pinned';
import type { PhysicsBody } from '../body.js';
import { RigidSolver, type RigidSolverParams } from '../world/solvers/rigid.js';
import type { Port, Region, Solver, SolverDescription, SolverHost, StepContext } from '../world/solver.js';
import { modeValues, PLANT_IMPULSE_WORDS, PLANT_SWAY_WORDS, stemModes } from './model.js';
import type { PlantSway } from '../vegetation.js';

/** An initially disabled dynamic rigid body representing the stem above a possible break section. */
export interface PlantRigidFragment {
  /** Its pivot is at the bottom of the detached segment, extending along local +Y. */
  readonly body: PhysicsBody;
  /** Height of that pivot above the standing plant's root, in metres. Zero for the whole stem. */
  readonly baseHeight: number;
}

/** A collider proxy and optional detached pieces for one plant. */
export interface PlantRigidBinding {
  /** The plant root, in the rigid and plant solvers' shared origin cell. */
  readonly root: readonly [number, number, number];
  /** Stem height, in metres. */
  readonly height: number;
  /** An enabled fixed contact collider on the standing trunk. */
  readonly standing: PhysicsBody;
  /** A detached rigid body for each modeled rupture section and, optionally, uprooting (baseHeight 0). */
  readonly fragments: readonly PlantRigidFragment[];
}

/** The rigid world and optional contact bindings in the same order as the plant set. */
export interface PlantRigidOptions extends RigidSolverParams {
  readonly plants: readonly (PlantRigidBinding | null)[];
}

type Binding = Omit<PlantRigidBinding, 'fragments'> & { fragments: ReadonlyMap<number, PhysicsBody> };
type Vector = [number, number, number];
type Modes = ReturnType<typeof stemModes>;

function cross(a: Vector, b: Vector): Vector {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function release(
  binding: Binding,
  body: PhysicsBody,
  section: number,
  state: Float64Array,
  at: number,
  modes: Modes,
): void {
  const [a, b] = modeValues(modes, section / binding.height);
  const x = state[at]!;
  const z = state[at + 1]!;
  const vx = state[at + 4]!;
  const vz = state[at + 5]!;
  const dx = state[at + 2]!;
  const dz = state[at + 3]!;
  const ux = state[at + 6]!;
  const uz = state[at + 7]!;
  const length = binding.height - section;
  const chord: Vector = [(1 - a[0]) * x + (1 - b[0]) * dx, length, (1 - a[0]) * z + (1 - b[0]) * dz];
  const chordRate: Vector = [(1 - a[0]) * vx + (1 - b[0]) * ux, 0, (1 - a[0]) * vz + (1 - b[0]) * uz];
  const span = hypot(...chord);
  const axis: Vector = [chord[0] / span, chord[1] / span, chord[2] / span];
  const spin = cross(axis, [chordRate[0] / span, 0, chordRate[2] / span]);
  const w = Math.sqrt((1 + axis[1]) / 2);
  const pivot: Vector = [
    binding.root[0] + a[0] * x + b[0] * dx,
    binding.root[1] + section,
    binding.root[2] + a[0] * z + b[0] * dz,
  ];
  body.setPosition(pivot).setRotation([axis[2] / (2 * w), 0, -axis[0] / (2 * w), w]);
  const centre = body.worldCenterOfMass;
  const centreVelocity = cross(spin, [centre[0] - pivot[0], centre[1] - pivot[1], centre[2] - pivot[2]]);
  body
    .setAngularVelocity(spin)
    .setLinearVelocity([
      a[0] * vx + b[0] * ux + centreVelocity[0],
      centreVelocity[1],
      a[0] * vz + b[0] * uz + centreVelocity[2],
    ]);
  body.enabled = true;
}

/**
 * Replace a world's RigidSolver with PlantRigidSolver to feed real contacts to a plant
 * set and release its configured rigid fragments. All bodies are created before adding
 * the solver. A release changes only snapshotted rigid state.
 */
export class PlantRigidSolver extends RigidSolver implements Solver<PlantRigidOptions> {
  readonly #sway: PlantSway['swayField'];
  readonly #impulse: PlantSway['impulseField'];
  #host?: SolverHost;
  #physics?: PlantRigidOptions['physics'];
  #bindings: readonly (Binding | null)[] = [];
  #proxyRows = new Map<number, number>();
  #output?: Region;
  #modes?: Modes;

  constructor(sway: Pick<PlantSway, 'swayField' | 'impulseField'>, id = 'rigid') {
    super(id);
    this.#sway = sway.swayField;
    this.#impulse = sway.impulseField;
  }

  override describe(): SolverDescription {
    const base = super.describe();
    return {
      ...base,
      fields: [
        ...base.fields,
        { field: this.#sway, access: 'read' as const },
        { field: this.#impulse, access: 'accumulate' as const },
      ],
    };
  }

  override init(host: SolverHost, options: PlantRigidOptions): void {
    if (!options || !Array.isArray(options.plants) || options.plants.length === 0)
      throw new MargoError('state', 'PlantRigidSolver needs a plant list. Pass bindings in the source solver order.');
    const all = new Set<PhysicsBody>();
    const bindBody = (body: PhysicsBody, enabled: boolean) => {
      if (
        !body.valid ||
        body.type !== (enabled ? 'fixed' : 'dynamic') ||
        body.enabled !== enabled ||
        body.colliders.length === 0 ||
        !body.colliders.every((collider) => options.physics.colliderOf(collider.handle) === collider) ||
        all.has(body)
      )
        throw new MargoError(
          'state',
          'Plant rigid bindings need distinct enabled fixed proxies and disabled dynamic fragments in this world.',
        );
      all.add(body);
    };
    const bindings = options.plants.map((plant) => {
      if (plant === null) return null;
      if (
        !(Number.isFinite(plant.height) && plant.height > 0) ||
        plant.root.length !== 3 ||
        !plant.root.every(Number.isFinite)
      )
        throw new MargoError('state', 'A rigid plant proxy needs a finite root and positive height.');
      bindBody(plant.standing, true);
      const fragments = new Map<number, PhysicsBody>();
      for (const { body, baseHeight } of plant.fragments) {
        if (!Number.isFinite(baseHeight) || baseHeight < 0 || baseHeight >= plant.height || fragments.has(baseHeight))
          throw new MargoError('state', 'Rigid plant fragments need distinct base heights below the tip.');
        bindBody(body, false);
        fragments.set(baseHeight, body);
      }
      return { ...plant, root: [...plant.root] as const, fragments };
    });
    super.init(host, options);
    this.#output = host.allocate('plant-rigid-impulses', options.plants.length * PLANT_IMPULSE_WORDS * 8, 'f64', 1);
    this.#bindings = bindings;
    for (const [i, binding] of bindings.entries())
      for (const collider of binding?.standing.colliders ?? []) this.#proxyRows.set(collider.handle, i);
    this.#modes = stemModes();
    this.#host = host;
    this.#physics = options.physics;
  }

  override step(context: StepContext, dt: number): void {
    const host = this.#host!;
    const sway = context.inputs.get(this.#sway.name);
    const bindings = this.#bindings;
    const output = this.#output!;
    const modes = this.#modes!;
    const physics = this.#physics!;
    if (
      !sway ||
      sway.region.type !== 'f64' ||
      sway.region.layout !== 1 ||
      sway.region.byteLength !== bindings.length * PLANT_SWAY_WORDS * 8 ||
      sway.cell.some((value, axis) => value !== context.cell[axis])
    )
      throw new MargoError('state', 'PlantRigidSolver needs a matching PlantSway port in the same cell.');
    {
      const state = new Float64Array(host.memory.buffer, sway.region.byteOffset, sway.region.byteLength / 8);
      for (const [i, binding] of bindings.entries()) {
        if (!binding?.standing.enabled) continue;
        const at = i * PLANT_SWAY_WORDS;
        if (state[at + 9] === 0) continue;
        const section = state[at + 10]!;
        const fragment = binding.fragments.get(section);
        if (fragment) {
          release(binding, fragment, section, state, at, modes);
          binding.standing.enabled = false;
        }
      }
    }

    super.step(context, dt);
    const impulses = new Float64Array(host.memory.buffer, output.byteOffset, output.byteLength / 8);
    impulses.fill(0);
    // This solver owns and steps the rigid kernel. The per-pair total includes CCD and
    // earlier rigid substeps. Public contactPair() only gives the final substep's points.
    const kernel = physics.kernel;
    const columns = kernel.columns;
    const add = (i: number | undefined, y: number, x: number, z: number) => {
      if (i === undefined) return;
      const binding = bindings[i]!;
      const h = Math.max(0, Math.min(1, (y - binding.root[1]) / binding.height));
      const [a, b] = modeValues(modes, h);
      const at = i * PLANT_IMPULSE_WORDS;
      impulses[at] += a[0] * x;
      impulses[at + 1] += a[0] * z;
      impulses[at + 2] += b[0] * x;
      impulses[at + 3] += b[0] * z;
    };
    for (let n = 0; n < kernel.solvingPairs; n++) {
      const row = columns.solvePairs[n]!;
      const total = columns.pairForce[row]!;
      const count = columns.pairContacts[row]!;
      if (!(total > 0) || count === 0) continue;
      const a = this.#proxyRows.get(columns.pairA[row]!);
      const b = this.#proxyRows.get(columns.pairB[row]!);
      if (a === undefined && b === undefined) continue;
      // Distribute the step impulse through the stored manifold. Speculative contacts
      // can overshoot their target during an earlier substep and end with zero impulse.
      let last = 0;
      for (let k = 0; k < count; k++) last += columns.contactNormalImpulse[row * 4 + k]!;
      for (let k = 0; k < count; k++) {
        const point = row * 4 + k;
        const fraction = last > 0 ? columns.contactNormalImpulse[point]! / last : 1 / count;
        if (fraction === 0) continue;
        const x = total * fraction * columns.pairNormalX[row]!;
        const z = total * fraction * columns.pairNormalZ[row]!;
        const y = columns.contactY[point]!;
        add(a, y, -x, -z);
        add(b, y, x, z);
      }
    }
  }

  override exportPorts(tick: number): readonly Port[] {
    return [
      ...super.exportPorts(tick),
      { field: this.#impulse.name, region: this.#output!, tick, cell: this.#host!.cell },
    ];
  }

  override stateRegions(): readonly Region[] {
    return [...super.stateRegions(), this.#output!];
  }
}
