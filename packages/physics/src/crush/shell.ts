import { MargoError } from '@margoengine/math/errors';
import { regionWords } from '../world/memory.js';
import type {
  FieldDescriptor,
  Port,
  Region,
  Solver,
  SolverDescription,
  SolverHost,
  StepContext,
} from '../world/solver.js';
import { isRateLevel, type RateLevel, rateOf } from '../world/solver.js';
import { BODIES_FIELD, BODY_FORCES_FIELD, BODY_IMPULSES_FIELD } from '../world/solvers/rigid.js';
import { type CrushVector, triple, ZERO } from './rigid-contact.js';
import { instanceFor, loadShell, type ShellBuilds } from './shell-kernel.js';
import { type CrushShellContact, type CrushShellSphere, ShellRigid } from './shell-rigid.js';
import {
  type CrushSheetSeam,
  type CrushSheetSeamReading,
  prepareSeams,
  readSeamRow,
  SEAM_STATE_WORDS,
} from './shell-seam.js';
import { makeShell, type Triangle } from './shell-topology.js';

const MAX_SUBSTEPS = 8192;
const FACE_STATE_WORDS = 8;

/** Uniform thin-sheet material in SI units. */
export interface CrushShellMaterial {
  readonly thickness: number;
  readonly density: number;
  readonly youngModulus: number;
  readonly poissonRatio: number;
  readonly yieldStress: number;
  /** Linear isotropic hardening slope in Pa. Default 0, ideal plasticity. */
  readonly hardeningModulus?: number;
}

/** Authored rest sheet, constraints and initial velocities. */
export interface CrushShellParams {
  readonly positions: readonly CrushVector[];
  /** Outward-wound zero-based faces. Open sheets are supported. */
  readonly triangles: readonly Triangle[];
  readonly material: CrushShellMaterial;
  /** Vertices fixed at their rest positions. Default none. */
  readonly pinned?: readonly number[];
  /** Initial vertex velocities in m/s. Default zero. */
  readonly velocities?: readonly CrushVector[];
  /** Raise the automatically chosen explicit substep count by an integer factor. Default 1. */
  readonly resolution?: number;
  /** Centered rigid spheres, available after calling `CrushShellSolver.loadRigid()`. */
  readonly spheres?: readonly CrushShellSphere[];
  /** Width of each position cell in metres when rigid spheres and the shell have different cells. */
  readonly cellSize?: number;
  /** Optional initially bonded pairs of coincident boundary edges. */
  readonly seams?: readonly CrushSheetSeam[];
}

export interface CrushShellFace {
  /** In-plane normal and shear second Piola–Kirchhoff stress in local rest coordinates, Pa. */
  readonly stress: CrushVector;
  readonly equivalentPlasticStrain: number;
  /** Irreversible initial-yield work per rest cubic metre, J/m³. */
  readonly dissipatedDensity: number;
}

/** Distributed structural energy ledger in joules. */
export interface CrushShellBudget {
  readonly kinetic: number;
  readonly membrane: number;
  readonly bending: number;
  readonly hardening: number;
  readonly plasticDissipation: number;
  /** Cumulative work from authored vertex forces. Gravity is supplied by the world. */
  readonly appliedWork: number;
}

interface ShellState {
  readonly host: SolverHost;
  readonly kernel: ReturnType<typeof instanceFor>['kernel'];
  readonly descriptor: Region;
  readonly positions: Region;
  readonly velocities: Region;
  readonly faceState: Region;
  readonly applied: Region;
  readonly reactions: Region;
  readonly energy: Region;
  readonly triangles: Uint32Array;
  readonly maxStep: number;
  readonly resolution: number;
  readonly rigid?: ShellRigid;
  readonly maxNodeInverseMass: number;
  readonly seams?: Region;
}

function finiteVector(v: CrushVector, label: string): CrushVector {
  if (v.length !== 3 || !v.every(Number.isFinite))
    throw new MargoError('state', `Give each shell ${label} three finite Cartesian components.`);
  return v;
}

function indexIn(index: number, count: number, label: string): number {
  if (!Number.isSafeInteger(index) || index < 0 || index >= count)
    throw new MargoError('state', `Choose a ${label} index from 0 to ${count - 1}.`);
  return index;
}

function coefficients(m: CrushShellMaterial): readonly number[] {
  const hardening = m.hardeningModulus ?? 0;
  if (
    ![m.thickness, m.density, m.youngModulus, m.yieldStress].every((value) => value > 0 && Number.isFinite(value)) ||
    !(m.poissonRatio > -1 && m.poissonRatio < 0.5) ||
    !(hardening >= 0 && Number.isFinite(hardening))
  )
    throw new MargoError(
      'state',
      'Use positive SI sheet dimensions and moduli, -1 < Poisson ratio < 0.5, and nonnegative hardening.',
    );
  return [m.youngModulus, m.poissonRatio, m.yieldStress, hardening];
}

/** A thin-sheet solver with plane-stress plasticity and elastic bending hinges. */
export class CrushShellSolver implements Solver<CrushShellParams> {
  /** Layout 1 positions, three f64 metre offsets per vertex. */
  readonly positionField: FieldDescriptor;
  private state: ShellState | undefined;

  private constructor(
    private readonly builds: ShellBuilds,
    readonly id: string,
    private readonly rigid: boolean,
    private readonly rate: RateLevel,
  ) {
    this.positionField = {
      name: `${id}:vertices`,
      kind: 'meshVertexSet',
      quantity: 'position',
      unit: 'm',
      centring: 'vertex',
    };
  }

  /** Loads the optional native kernel. Default id 'crush-shell'. */
  static async load(options: { readonly id?: string; readonly signal?: AbortSignal } = {}): Promise<CrushShellSolver> {
    return new CrushShellSolver(await loadShell(options.signal), options.id ?? 'crush-shell', false, 0);
  }

  /** Loads the shell with rigid-sphere coupling. Default id 'crush-shell'. */
  static async loadRigid(
    options: {
      readonly id?: string;
      readonly signal?: AbortSignal;
      /** Dyadic world rate. Match RigidSolver when coupled. Default 0 (60 Hz). */
      readonly rate?: RateLevel;
    } = {},
  ): Promise<CrushShellSolver> {
    const rate = options.rate ?? 0;
    if (!isRateLevel(rate)) throw new MargoError('state', 'Choose a shell world rate level from 0 to 7.');
    return new CrushShellSolver(await loadShell(options.signal), options.id ?? 'crush-shell', true, rate);
  }

  describe(): SolverDescription {
    return {
      id: this.id,
      rate: this.rate,
      stableRate: () => 0,
      fields: [
        { field: this.positionField, access: 'write' },
        ...(this.rigid
          ? ([
              { field: BODIES_FIELD, access: 'read' },
              { field: BODY_IMPULSES_FIELD, access: 'accumulate' },
              { field: BODY_FORCES_FIELD, access: 'accumulate' },
            ] as const)
          : []),
      ],
    };
  }

  init(host: SolverHost, params: CrushShellParams): void {
    const { positions, triangles, material, velocities } = params;
    const nodeCount = positions.length;
    const faceCount = triangles.length;
    const resolution = params.resolution ?? 1;
    const spheres = params.spheres ?? [];
    if (this.rigid !== spheres.length > 0)
      throw new MargoError('state', 'Use CrushShellSolver.loadRigid() and give at least one sphere to enable contact.');
    if (nodeCount < 3 || faceCount === 0)
      throw new MargoError('state', 'Give the shell vertices and at least one face.');
    if (!Number.isSafeInteger(resolution) || resolution < 1)
      throw new MargoError('state', 'Choose a positive integer shell substep resolution.');
    if (velocities && velocities.length !== nodeCount)
      throw new MargoError('state', 'Give one initial velocity per shell vertex.');
    const pinned = new Set((params.pinned ?? []).map((index) => indexIn(index, nodeCount, 'pinned vertex')));
    positions.forEach((p) => finiteVector(p, 'position'));
    velocities?.forEach((v, index) => {
      finiteVector(v, 'velocity');
      if (pinned.has(index) && v.some((value) => value !== 0))
        throw new MargoError('state', 'Use zero initial velocity on fixed shell vertices.');
    });
    const steel = coefficients(material);
    const topology = makeShell(positions, triangles, material);
    const seams = params.seams ?? [];
    const cohesive = seams.length
      ? prepareSeams(seams, positions, topology.boundaryEdges, topology.nodeMass, material.thickness)
      : undefined;
    const maxStep = cohesive
      ? 0.5 / Math.sqrt((0.5 / topology.maxStep) ** 2 + cohesive.frequencySquared)
      : topology.maxStep;
    if (!(maxStep > 0) || substeps(1 / rateOf(this.rate), maxStep, resolution) > MAX_SUBSTEPS)
      throw new MargoError('state', 'Give the shell larger minimum elements or reduce its requested resolution.');
    const rigid = this.rigid ? new ShellRigid(host, spheres, material.thickness, params.cellSize) : undefined;
    const { kernel } = instanceFor(host, this.builds);
    const f64 = (name: string, count: number) => host.allocate(name, count * 8, 'f64', 1);
    const vertex = f64('shell-positions', 3 * nodeCount);
    const speed = f64('shell-velocities', 3 * nodeCount);
    const applied = f64('shell-forces', 3 * nodeCount);
    const reactions = f64('shell-reactions', 3 * nodeCount);
    const faceState = f64('shell-face-state', FACE_STATE_WORDS * faceCount);
    const energy = f64('shell-ledger', 6);
    const nodes = f64('shell-nodes', 2 * nodeCount);
    const faces = host.allocate('shell-faces', topology.faces.byteLength, 'u8', 1);
    // The runtime expects an aligned pointer even when the hinge count is zero.
    const hinges = host.allocate('shell-hinges', Math.max(8, topology.hinges.byteLength), 'u8', 1);
    const seamRecords = cohesive && host.allocate('shell-seams', cohesive.packed.byteLength, 'u8', 1);
    const seamState = cohesive && f64('shell-seam-history', SEAM_STATE_WORDS * seams.length);
    const scratch = f64('shell-work', 9 * nodeCount + FACE_STATE_WORDS * faceCount + SEAM_STATE_WORDS * seams.length);
    const descriptor = host.allocate('shell-descriptor', 136, 'u8', 1);
    const memory = host.memory;
    const x = values(host, vertex);
    const v = values(host, speed);
    const m = values(host, nodes);
    let maxNodeInverseMass = 0;
    for (let index = 0; index < nodeCount; index++) {
      x.set(positions[index]!, 3 * index);
      v.set(velocities?.[index] ?? ZERO, 3 * index);
      m.set([topology.nodeMass[index]!, Number(pinned.has(index))], 2 * index);
      if (!pinned.has(index)) maxNodeInverseMass = Math.max(maxNodeInverseMass, 1 / topology.nodeMass[index]!);
    }
    new Uint8Array(memory.buffer, faces.byteOffset, faces.byteLength).set(new Uint8Array(topology.faces));
    new Uint8Array(memory.buffer, hinges.byteOffset, hinges.byteLength).set(new Uint8Array(topology.hinges));
    if (seamRecords && cohesive)
      new Uint8Array(memory.buffer, seamRecords.byteOffset, seamRecords.byteLength).set(
        new Uint8Array(cohesive.packed),
      );
    new Uint32Array(memory.buffer, descriptor.byteOffset, 14).set([
      vertex.byteOffset,
      speed.byteOffset,
      faceState.byteOffset,
      applied.byteOffset,
      reactions.byteOffset,
      nodes.byteOffset,
      faces.byteOffset,
      hinges.byteOffset,
      scratch.byteOffset,
      energy.byteOffset,
      nodeCount,
      faceCount,
      topology.hinges.byteLength / 32,
      0,
    ]);
    new Float64Array(memory.buffer, descriptor.byteOffset + 56, 7).set([...host.gravity, ...steel]);
    new Uint32Array(memory.buffer, descriptor.byteOffset + 112, 5).set([
      rigid?.work.byteOffset ?? 0,
      rigid?.spheres.length ?? 0,
      seamRecords?.byteOffset ?? 0,
      seamState?.byteOffset ?? 0,
      seams.length,
    ]);
    if (kernel.crush_shell_advance(descriptor.byteOffset, 0, 0) !== 1)
      throw new MargoError('state', 'Use finite initial geometry and velocities for the shell.');
    this.state = {
      host,
      kernel,
      descriptor,
      positions: vertex,
      velocities: speed,
      applied,
      reactions,
      faceState,
      energy,
      triangles: Uint32Array.from(triangles.flat()),
      maxStep,
      resolution,
      rigid,
      maxNodeInverseMass,
      seams: seamState,
    };
  }

  step(_context: StepContext, dt: number): void {
    const { host, kernel, descriptor, velocities, maxStep, resolution, rigid, maxNodeInverseMass } =
      this.requireState();
    const contactStep = rigid?.stage(_context, dt, values(host, velocities), maxNodeInverseMass) ?? maxStep;
    const n = substeps(dt, Math.min(maxStep, contactStep), resolution);
    if (!Number.isFinite(n) || n > MAX_SUBSTEPS || n < 1)
      throw new MargoError('state', 'Use a positive shell step within the explicit integration budget.');
    if (kernel.crush_shell_advance(descriptor.byteOffset, dt, n) !== 1)
      throw new MargoError(
        'failed',
        'The loaded shell lost finite geometry. Reduce the load or use a finer time step.',
      );
    rigid?.publish(dt);
  }

  importPorts(_tick: number): void {}

  exportPorts(tick: number): readonly Port[] {
    const { positions, rigid } = this.requireState();
    const ports = [{ field: this.positionField.name, region: positions, tick, cell: ZERO }];
    if (rigid)
      ports.push(
        { field: BODY_IMPULSES_FIELD.name, region: rigid.reactions, tick, cell: ZERO },
        { field: BODY_FORCES_FIELD.name, region: rigid.forces, tick, cell: ZERO },
      );
    return ports;
  }

  stateRegions(): readonly Region[] {
    const { positions, velocities, faceState, applied, reactions, energy, rigid, seams } = this.requireState();
    const regions = [positions, velocities, faceState, applied, reactions, energy];
    if (rigid) regions.push(rigid.readings);
    if (seams) regions.push(seams);
    return regions;
  }

  extraState(): readonly Region[] {
    const { rigid } = this.requireState();
    return rigid ? [rigid.reactions, rigid.forces] : [];
  }

  /** Sets a persistent vertex force in newtons before advancing the world. */
  setForce(vertex: number, force: CrushVector): void {
    const { host, applied } = this.requireState();
    const index = indexIn(vertex, applied.byteLength / 24, 'shell vertex');
    values(host, applied).set(finiteVector(force, 'force'), 3 * index);
  }

  /** Copies the live xyz offsets, xyz velocities and original triangle indices. */
  readMesh(): { positions: Float64Array; velocities: Float64Array; triangles: Uint32Array } {
    const { host, positions, velocities, triangles } = this.requireState();
    return {
      positions: values(host, positions).slice(),
      velocities: values(host, velocities).slice(),
      triangles: triangles.slice(),
    };
  }

  /** Reads the fixed support's endpoint force on a vertex in newtons, or zero on a free vertex. */
  supportReaction(vertex: number): CrushVector {
    const { host, reactions } = this.requireState();
    const index = indexIn(vertex, reactions.byteLength / 24, 'shell vertex');
    return triple(values(host, reactions), 3 * index);
  }

  /** Returns the last integrated sphere reaction and compliant interface state. */
  readSphereContact(index: number): CrushShellContact {
    const { rigid } = this.requireState();
    if (!rigid) throw new MargoError('state', 'Enable rigid-sphere coupling before reading contact.');
    return rigid.read(index);
  }

  /** Reads the cohesive state and live opening of a configured boundary pair. */
  readSeam(index: number): CrushSheetSeamReading {
    const { host, seams } = this.requireState();
    if (!seams) throw new MargoError('state', 'Give the shell cohesive seams before reading fracture.');
    const words = values(host, seams);
    const at = SEAM_STATE_WORDS * indexIn(index, words.length / SEAM_STATE_WORDS, 'shell seam');
    return readSeamRow(words, at);
  }

  readFace(face: number): CrushShellFace {
    const { host, faceState } = this.requireState();
    const words = values(host, faceState);
    const at = FACE_STATE_WORDS * indexIn(face, words.length / FACE_STATE_WORDS, 'shell face');
    return {
      equivalentPlasticStrain: words[at + 3]!,
      dissipatedDensity: words[at + 4]!,
      stress: triple(words, at + 5),
    };
  }

  readBudget(): CrushShellBudget {
    const { host, energy } = this.requireState();
    const [kinetic, membrane, bending, hardening, plasticDissipation, appliedWork] = values(host, energy);
    return {
      kinetic: kinetic!,
      membrane: membrane!,
      bending: bending!,
      hardening: hardening!,
      plasticDissipation: plasticDissipation!,
      appliedWork: appliedWork!,
    };
  }

  private requireState(): ShellState {
    if (!this.state) throw new MargoError('state', 'Add CrushShellSolver to a PhysicsWorld before using it.');
    return this.state;
  }
}

function values(host: SolverHost, region: Region): Float64Array {
  return regionWords(host.memory, region) as Float64Array;
}

function substeps(dt: number, maxStep: number, resolution: number): number {
  return Math.ceil((dt * resolution) / maxStep);
}
