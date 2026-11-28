import { crushError } from './errors.js';
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
import { type CrushShellAnisotropy, shellAnisotropy } from './shell-anisotropy.js';
import {
  SHELL_APERTURE_LAYOUT,
  SHELL_APERTURE_WORDS,
  SHELL_PRESSURE_LAYOUT,
  SHELL_PRESSURE_WORDS,
  shellApertureField,
  shellPressureField,
} from './shell-aperture.js';
import { instanceFor, loadShell, type ShellBuilds, type ShellNativeWorkCounts } from './shell-kernel.js';
import { type CrushShellContact, type CrushShellFriction, type CrushShellSphere, ShellRigid } from './shell-rigid.js';
import {
  type CrushSheetSeam,
  type CrushSheetSeamReading,
  prepareSeams,
  readSeamRow,
  SEAM_STATE_WORDS,
} from './shell-seam.js';
import { makeShell, manifoldTopology, type Triangle } from './shell-topology.js';

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
  /** Optional Hill-48 yield. Omit for isotropic von Mises yield. */
  readonly anisotropy?: CrushShellAnisotropy;
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
  /** Record deterministic native work counts. Default false. */
  readonly recordWork?: boolean;
  /** Centered rigid spheres, available after calling `CrushShellSolver.loadRigid()`. */
  readonly spheres?: readonly CrushShellSphere[];
  /** Resolve separate local sphere contacts on folded or disconnected sheets. Default false. */
  readonly contactManifold?: boolean;
  /** Width of each position cell in metres when rigid spheres and the shell have different cells. */
  readonly cellSize?: number;
  /** Optional initially bonded pairs of coincident boundary edges. */
  readonly seams?: readonly CrushSheetSeam[];
  /** Outward-wound panel faces paired with a SEA-10 opening. Requires pressure feedback. */
  readonly pressurePatches?: readonly { readonly seam: number; readonly faces: readonly number[] }[];
}

/**
 * State of one shell face: in-plane second Piola-Kirchhoff stress in Pa, equivalent plastic strain and the
 * irreversible yield work per rest cubic metre in J/m³.
 */
export interface CrushShellFace {
  /** In-plane second Piola–Kirchhoff stress, Pa. Uses the material's rolling axes when set. */
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

/** Native work in the last completed shell interval. Empty before the first interval. */
export interface CrushShellWork {
  readonly substeps: number;
  readonly membraneEvaluations: number;
  readonly hingeEvaluations: number;
  readonly seamQuadraturePoints: number;
  /** Bounding-box tests for sphere contacts, including the optional friction manifold passes. */
  readonly sphereFaceChecks: number;
  /** Face visits for the optional pressure load, including visits to unassigned faces. */
  readonly pressureFaceVisits: number;
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
  readonly work?: Region;
  readonly triangles: Uint32Array;
  readonly maxStep: number;
  readonly resolution: number;
  readonly contactBound: number;
  readonly rigid?: ShellRigid;
  readonly maxNodeInverseMass: number;
  readonly seams?: Region;
  readonly apertures?: { readonly region: Region; readonly vertices: Uint32Array };
  readonly pressure?: {
    readonly region: Region;
    readonly cellSize: number | undefined;
    readonly pairs: readonly { readonly seam: number; readonly face: number }[];
  };
}

function finiteVector(v: CrushVector, label: string): CrushVector {
  if (v?.length !== 3 || !Number.isFinite(v[0]) || !Number.isFinite(v[1]) || !Number.isFinite(v[2]))
    throw crushError('state', `Give each shell ${label} three finite Cartesian components.`);
  return v;
}

function indexIn(index: number, count: number, label: string): number {
  if (!Number.isSafeInteger(index) || index < 0 || index >= count)
    throw crushError('state', `Choose a ${label} index from 0 to ${count - 1}.`);
  return index;
}

function coefficients(m: CrushShellMaterial): readonly number[] {
  const hardening = m.hardeningModulus ?? 0;
  if (
    ![m.thickness, m.density, m.youngModulus, m.yieldStress].every((value) => value > 0 && Number.isFinite(value)) ||
    !(m.poissonRatio > -1 && m.poissonRatio < 0.5) ||
    !(hardening >= 0 && Number.isFinite(hardening))
  )
    throw crushError(
      'state',
      'Use positive SI sheet dimensions and moduli, -1 < Poisson ratio < 0.5, and nonnegative hardening.',
    );
  return [m.youngModulus, m.poissonRatio, m.yieldStress, hardening];
}

/** A thin-sheet solver with plane-stress plasticity and elastic bending hinges. */
export class CrushShellSolver implements Solver<CrushShellParams> {
  /** Layout 1 positions, three f64 metre offsets per vertex. */
  readonly positionField: FieldDescriptor;
  /** Layout 1 seam openings. Published by the aperture-enabled loader. */
  readonly apertureField: FieldDescriptor;
  /** Layout 1 pressure samples consumed by a shell using aperture pressure feedback. */
  readonly aperturePressureField: FieldDescriptor;
  private state: ShellState | undefined;
  private pressureFeedback = false;
  private nativeWork?: ShellNativeWorkCounts;
  private disposed = false;

  private constructor(
    private readonly builds: ShellBuilds,
    readonly id: string,
    private readonly rigid: boolean,
    private readonly rate: RateLevel,
    private readonly threads: number,
    private readonly publishApertures = false,
  ) {
    this.apertureField = shellApertureField(id);
    this.aperturePressureField = shellPressureField(id);
    this.positionField = {
      name: `${id}:vertices`,
      kind: 'meshVertexSet',
      quantity: 'position',
      unit: 'm',
      centring: 'vertex',
    };
  }

  /** Loads the optional native kernel. Default id 'crush-shell'. */
  static async load(
    options: { readonly id?: string; readonly signal?: AbortSignal; readonly threads?: number } = {},
  ): Promise<CrushShellSolver> {
    const threads = options.threads ?? 1;
    return new CrushShellSolver(
      await loadShell(options.signal, threads),
      options.id ?? 'crush-shell',
      false,
      0,
      threads,
    );
  }

  /** Loads the shell with rigid-sphere coupling. Default id 'crush-shell'. */
  static async loadRigid(
    options: {
      readonly id?: string;
      readonly signal?: AbortSignal;
      /** Native material participants, including the caller. Choose 1 (default), 2 or 4. */
      readonly threads?: number;
      /** Dyadic world rate. Match RigidSolver when coupled. Default 0 (60 Hz). */
      readonly rate?: RateLevel;
    } = {},
  ): Promise<CrushShellSolver> {
    const rate = options.rate ?? 0;
    if (!isRateLevel(rate)) throw crushError('state', 'Choose a shell world rate level from 0 to 7.');
    const threads = options.threads ?? 1;
    return new CrushShellSolver(
      await loadShell(options.signal, threads),
      options.id ?? 'crush-shell',
      true,
      rate,
      threads,
    );
  }

  /** Loads a shell that publishes its released seam geometry for flooding or other readers. */
  static async loadWithApertures(
    options: {
      readonly id?: string;
      readonly signal?: AbortSignal;
      /** Native material participants, including the caller. Choose 1 (default), 2 or 4. */
      readonly threads?: number;
      /** Enable moving sphere contact at the given rigid world rate. Default disabled. */
      readonly rigid?: { readonly rate?: RateLevel };
    } = {},
  ): Promise<CrushShellSolver> {
    const rate = options.rigid?.rate ?? 0;
    if (!isRateLevel(rate)) throw crushError('state', 'Choose a shell aperture rate level from 0 to 7.');
    const threads = options.threads ?? 1;
    return new CrushShellSolver(
      await loadShell(options.signal, threads),
      options.id ?? 'crush-shell',
      !!options.rigid,
      rate,
      threads,
      true,
    );
  }

  /** Publishes live apertures and reads the previous hull head across selected panel faces. */
  static async loadWithAperturePressure(
    options: Parameters<typeof CrushShellSolver.loadWithApertures>[0] = {},
  ): Promise<CrushShellSolver> {
    const shell = await CrushShellSolver.loadWithApertures(options);
    shell.pressureFeedback = true;
    return shell;
  }

  /** Release optional native helpers after the world finishes using this shell. */
  [Symbol.dispose](): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.state?.kernel[Symbol.dispose]();
    } finally {
      this.builds[Symbol.dispose]();
    }
  }

  describe(): SolverDescription {
    return {
      id: this.id,
      rate: this.rate,
      stableRate: () => 0,
      fields: [
        { field: this.positionField, access: 'write' },
        ...(this.publishApertures ? [{ field: this.apertureField, access: 'write' as const }] : []),
        ...(this.pressureFeedback ? [{ field: this.aperturePressureField, access: 'read' as const }] : []),
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
    if (this.disposed) throw crushError('disposed', 'This crush shell is closed. Load another shell solver.');
    if (this.state) throw crushError('attached', 'This crush shell belongs to a world. Load a separate shell solver.');
    try {
      this.initShell(host, params);
    } catch (cause) {
      if (this.threads > 1) this[Symbol.dispose]();
      throw cause;
    }
  }

  private initShell(host: SolverHost, params: CrushShellParams): void {
    if (!Array.isArray(params?.positions) || !Array.isArray(params?.triangles) || !params?.material)
      throw crushError(
        'unsupported',
        'A crush shell needs a mesh and material. Supply vertices, faces and finite material values.',
      );
    const { positions, triangles, material, velocities } = params;
    const nodeCount = positions.length;
    const faceCount = triangles.length;
    const resolution = params.resolution ?? 1;
    const spheres = params.spheres ?? [];
    if (this.rigid !== spheres.length > 0)
      throw crushError('state', 'Use CrushShellSolver.loadRigid() and give at least one sphere to enable contact.');
    if (nodeCount < 3 || faceCount === 0) throw crushError('state', 'Give the shell vertices and at least one face.');
    if (!Number.isSafeInteger(resolution) || resolution < 1)
      throw crushError('state', 'Choose a positive integer shell substep resolution.');
    if (velocities && velocities.length !== nodeCount)
      throw crushError('state', 'Give one initial velocity per shell vertex.');
    const pinned = new Set((params.pinned ?? []).map((index) => indexIn(index, nodeCount, 'pinned vertex')));
    positions.forEach((p) => finiteVector(p, 'position'));
    velocities?.forEach((v, index) => {
      finiteVector(v, 'velocity');
      if (pinned.has(index) && v.some((value) => value !== 0))
        throw crushError('state', 'Use zero initial velocity on fixed shell vertices.');
    });
    const steel = coefficients(material);
    const hill = material.anisotropy && shellAnisotropy(material.anisotropy);
    const topology = makeShell(positions, triangles, material, hill?.rolling);
    const seams = params.seams ?? [];
    if (this.publishApertures && seams.length === 0)
      throw crushError('state', 'Give an aperture-enabled shell at least one cohesive seam.');
    const patches = params.pressurePatches ?? [];
    if (this.pressureFeedback !== patches.length > 0)
      throw crushError('state', 'Use loadWithAperturePressure and provide pressurePatches together.');
    const claimedFaces = new Set<number>();
    const pairs = patches.flatMap(({ seam, faces }) => {
      indexIn(seam, seams.length, 'pressure seam');
      if (faces.length === 0) throw crushError('state', 'Give each shell pressure patch at least one face.');
      return faces.map((face) => {
        indexIn(face, faceCount, 'pressure face');
        if (claimedFaces.has(face)) throw crushError('state', 'Use one pressure patch per shell face.');
        claimedFaces.add(face);
        return { seam, face };
      });
    });
    if (
      this.pressureFeedback &&
      params.cellSize !== undefined &&
      !(params.cellSize > 0 && Number.isFinite(params.cellSize))
    )
      throw crushError('state', 'Use a positive finite cellSize for shell pressure feedback.');
    const cohesive = seams.length
      ? prepareSeams(seams, positions, topology.boundaryEdges, topology.nodeMass, material.thickness)
      : undefined;
    const maxStep = cohesive
      ? 0.5 / Math.sqrt((0.5 / topology.maxStep) * (0.5 / topology.maxStep) + cohesive.frequencySquared)
      : topology.maxStep;
    if (!(maxStep > 0) || substeps(1 / rateOf(this.rate), maxStep, resolution) > MAX_SUBSTEPS)
      throw crushError('state', 'Give the shell larger minimum elements or reduce its requested resolution.');
    const rigid = this.rigid ? new ShellRigid(host, spheres, material.thickness, params.cellSize) : undefined;
    if (params.contactManifold && !rigid)
      throw crushError('state', 'Enable rigid spheres before requesting a shell contact manifold.');
    const { kernel } = instanceFor(host, this.builds, faceCount);
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
    const apertures = this.publishApertures
      ? {
          region: host.allocate(
            'shell-apertures',
            seams.length * SHELL_APERTURE_WORDS * 8,
            'f64',
            SHELL_APERTURE_LAYOUT,
          ),
          vertices: Uint32Array.from(seams.flatMap(({ sides: [[a, b], [c, d]] }) => [a, b, d, c])),
        }
      : undefined;
    const scratch = f64('shell-work', 9 * nodeCount + FACE_STATE_WORDS * faceCount + SEAM_STATE_WORDS * seams.length);
    const descriptor = host.allocate('shell-descriptor', 176, 'u8', 1);
    const incidence = params.contactManifold ? manifoldTopology(triangles) : undefined;
    const contactTopology = incidence && host.allocate('shell-contact-topology', incidence.byteLength, 'u32', 1);
    const pressure = this.pressureFeedback
      ? { region: f64('shell-pressure-faces', 4 * faceCount), pairs, cellSize: params.cellSize }
      : undefined;
    const work = params.recordWork ? f64('shell-work-counts', 6) : undefined;
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
      pressure?.region.byteOffset ?? 0,
    ]);
    new Float64Array(memory.buffer, descriptor.byteOffset + 56, 7).set([...host.gravity, ...steel]);
    new Uint32Array(memory.buffer, descriptor.byteOffset + 112, 5).set([
      rigid?.work.byteOffset ?? 0,
      rigid?.spheres.length ?? 0,
      seamRecords?.byteOffset ?? 0,
      seamState?.byteOffset ?? 0,
      seams.length,
    ]);
    if (hill) new Float64Array(memory.buffer, descriptor.byteOffset + 136, 4).set(hill.metric);
    new DataView(memory.buffer).setUint32(descriptor.byteOffset + 168, rigid?.frictionWork?.byteOffset ?? 0, true);
    if (contactTopology && incidence) {
      (regionWords(memory, contactTopology) as Uint32Array).set(incidence);
      new DataView(memory.buffer).setUint32(descriptor.byteOffset + 172, contactTopology.byteOffset, true);
    }
    if (kernel.crush_shell_advance(descriptor.byteOffset, 0, 0, 0) !== 1)
      throw crushError('state', 'Use finite initial geometry and velocities for the shell.');
    const workReceipt = kernel.workCounts();
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
      work,
      triangles: Uint32Array.from(triangles.flat()),
      maxStep,
      resolution,
      contactBound: params.contactManifold ? faceCount : 1,
      rigid,
      maxNodeInverseMass,
      seams: seamState,
      apertures,
      pressure,
    };
    this.nativeWork = workReceipt;
  }

  step(_context: StepContext, dt: number): void {
    const {
      host,
      kernel,
      descriptor,
      velocities,
      maxStep,
      resolution,
      rigid,
      maxNodeInverseMass,
      contactBound,
      pressure,
      work,
    } = this.requireState();
    if (!(dt > 0 && Number.isFinite(dt) && Number.isFinite(1 / dt)))
      throw crushError('unsupported', 'The shell step is invalid. Use a finite positive world interval.');
    if (pressure) this.stagePressure(pressure, host, _context);
    const contactStep =
      rigid?.stage(_context, dt, values(host, velocities), maxNodeInverseMass, contactBound) ?? maxStep;
    const n = substeps(dt, Math.min(maxStep, contactStep), resolution);
    if (!Number.isFinite(n) || n > MAX_SUBSTEPS || n < 1)
      throw crushError('state', 'Use a positive shell step within the explicit integration budget.');
    if (kernel.crush_shell_advance(descriptor.byteOffset, dt, n, work?.byteOffset ?? 0) !== 1)
      throw crushError('failed', 'The loaded shell lost finite geometry. Reduce the load or use a finer time step.');
    rigid?.publish(dt);
    this.nativeWork = kernel.workCounts();
  }

  private stagePressure(pressure: NonNullable<ShellState['pressure']>, host: SolverHost, context: StepContext): void {
    const port = context.inputs.get(this.aperturePressureField.name);
    if (!port || port.tick !== context.tick - 1)
      throw crushError('state', 'Use the same rate and put the shell before the hull for pressure feedback.');
    const bytes = SHELL_PRESSURE_WORDS * 8;
    if (
      port.region.type !== 'f64' ||
      port.region.layout !== SHELL_PRESSURE_LAYOUT ||
      port.region.byteLength % bytes !== 0
    )
      throw crushError('state', 'Use the layout-1 HullSolver shell pressure port.');
    const delta = port.cell[1] - context.cell[1];
    if (delta !== 0 && pressure.cellSize === undefined)
      throw crushError('state', 'Set the common cellSize for pressure feedback across different vertical cells.');
    const offset = delta * (pressure.cellSize ?? 1);
    const input = regionWords(port.region.memory ?? host.memory, port.region) as Float64Array;
    const packed = values(host, pressure.region);
    packed.fill(0);
    for (const { seam, face } of pressure.pairs) {
      const at = seam * SHELL_PRESSURE_WORDS;
      if (at >= input.length) throw crushError('state', 'Choose pressurePatches that link to seams owned by the hull.');
      if (input[at] === 0 && context.tick === 0) continue;
      const outside = input[at + 1]! + offset;
      const inside = input[at + 2]! + offset;
      const air = input[at + 3]!;
      const weight = input[at + 4]!;
      if (input[at] !== 1 || weight <= 0 || ![outside, inside, air, weight].every(Number.isFinite))
        throw crushError('state', 'Provide an active finite hydrostatic sample for each shell pressure seam.');
      packed.set([outside, inside, air, weight], face * 4);
    }
  }

  importPorts(_tick: number): void {}

  exportPorts(tick: number): readonly Port[] {
    const state = this.requireState();
    const { positions, rigid, apertures } = state;
    const ports = [{ field: this.positionField.name, region: positions, tick, cell: ZERO }];
    if (rigid)
      ports.push(
        { field: BODY_IMPULSES_FIELD.name, region: rigid.reactions, tick, cell: ZERO },
        { field: BODY_FORCES_FIELD.name, region: rigid.forces, tick, cell: ZERO },
      );
    if (apertures) {
      writeApertures(state);
      ports.push({ field: this.apertureField.name, region: apertures.region, tick, cell: ZERO });
    }
    return ports;
  }

  stateRegions(): readonly Region[] {
    const { positions, velocities, faceState, applied, reactions, energy, rigid, seams, apertures, work } =
      this.requireState();
    const regions = [positions, velocities, faceState, applied, reactions, energy];
    if (rigid) regions.push(rigid.readings);
    if (rigid?.frictionReadings) regions.push(rigid.frictionReadings);
    if (seams) regions.push(seams);
    if (apertures) regions.push(apertures.region);
    if (work) regions.push(work);
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

  /** Copies the recorded native work counts for this completed interval. */
  readWork(): CrushShellWork {
    const { host, work } = this.requireState();
    if (!work) throw crushError('state', 'Enable recordWork before reading native shell work.');
    const counts = values(host, work);
    return {
      substeps: counts[0]!,
      membraneEvaluations: counts[1]!,
      hingeEvaluations: counts[2]!,
      seamQuadraturePoints: counts[3]!,
      sphereFaceChecks: counts[4]!,
      pressureFaceVisits: counts[5]!,
    };
  }

  /** Copies per-participant native face work for the last accepted step. Work receipts stay outside snapshot state. */
  readNativeWork(): ShellNativeWorkCounts {
    this.requireState();
    const work = this.nativeWork!;
    return { ...work, workers: work.workers.map((worker) => ({ ...worker })) };
  }

  /** Returns the last integrated sphere reaction and compliant interface state. */
  readSphereContact(index: number): CrushShellContact {
    const { rigid } = this.requireState();
    if (!rigid) throw crushError('state', 'Enable rigid-sphere coupling before reading contact.');
    return rigid.read(index);
  }

  /** Reads the last sphere contact's angular impulse and frictional energy loss. */
  readSphereFriction(index: number): CrushShellFriction {
    const { rigid } = this.requireState();
    if (!rigid) throw crushError('state', 'Enable rigid-sphere coupling before reading friction.');
    return rigid.readFriction(index);
  }

  /** Reads the cohesive state and live opening of a configured boundary pair. */
  readSeam(index: number): CrushSheetSeamReading {
    const { host, seams } = this.requireState();
    if (!seams) throw crushError('state', 'Give the shell cohesive seams before reading fracture.');
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
    if (this.disposed) throw crushError('disposed', 'This crush shell is closed. Load another shell solver.');
    if (!this.state) throw crushError('state', 'Add CrushShellSolver to a PhysicsWorld before using it.');
    return this.state;
  }
}

function values(host: SolverHost, region: Region): Float64Array {
  return regionWords(host.memory, region) as Float64Array;
}

function writeApertures({ host, positions, seams, apertures }: ShellState): void {
  if (!seams || !apertures) return;
  const x = values(host, positions);
  const history = values(host, seams);
  const out = values(host, apertures.region);
  const vertexRows = apertures.vertices;
  for (let i = 0; i < vertexRows.length / 4; i++) {
    const at = i * SHELL_APERTURE_WORDS;
    out[at] = history[i * SEAM_STATE_WORDS + 6]!;
    for (let corner = 0; corner < 4; corner++) {
      const vertex = vertexRows[4 * i + corner]!;
      out.set(triple(x, 3 * vertex), at + 1 + 3 * corner);
    }
  }
}

function substeps(dt: number, maxStep: number, resolution: number): number {
  return Math.ceil((dt * resolution) / maxStep);
}
