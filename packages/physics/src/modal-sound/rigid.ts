import type { PhysicsBody } from '../body.js';
import type { PhysicsJoint } from '../joints.js';
import type { KernelWorld } from '../kernel.js';
import type { ModalSoundSolver } from '../modal-sound.js';
import { regionWords } from '../world/memory.js';
import {
  rateOf,
  type Port,
  type Region,
  type SolverDescription,
  type SolverHost,
  type StepContext,
} from '../world/solver.js';
import { RigidSolver, type RigidSolverParams } from '../world/solvers/rigid.js';
import { modalSoundError } from './errors.js';
import { limited, MODAL_CONTACT_WORDS, modalFractureImpulse } from './model.js';

type Vector = readonly [number, number, number];
type Columns = KernelWorld['columns'];

const CENTRE = [0, 0, 0] as const;
const MOTION = 9;

/** Route the rupture of a real rigid joint to a fragment's modal track. */
export interface ModalJointSound {
  readonly joint: PhysicsJoint;
  /** Zero-based track. */
  readonly track: number;
  /** Released energy available at the fracture, in J. */
  readonly energy: number;
  /** Acoustically excited fragment's effective mass, in kg. */
  readonly effectiveMass: number;
  /** Fraction of the released energy carried by this fragment, 0..1. Default 1. */
  readonly energyFraction?: number;
}

/** How to publish contact transients and roughness motion from the rigid world. */
export interface ModalContactRigidSetup {
  /** Rigid solver ID. Default 'rigid'. */
  readonly id?: string;
  /** Optional fracture mapping, declared before adding the solver to the world. */
  readonly jointBreaks?: readonly ModalJointSound[];
}

/** Rigid world and its radiators. Null leaves a track free for other acoustic sources. */
export interface ModalContactRigidOptions extends RigidSolverParams {
  /** One collider-bearing body per track, in sound solver order. */
  readonly emitters: readonly (PhysicsBody | null)[];
  /** Minimum point approach speed for an impact, to omit residual support impulses. Default 0.25 m/s. */
  readonly impactSpeed?: number;
  /** Rolling resistance used to scale roughness excitation, dimensionless. Default 0.025. */
  readonly rollingResistance?: number;
}

interface Data {
  readonly host: SolverHost;
  readonly physics: ModalContactRigidOptions['physics'];
  readonly contact: Region;
  readonly fracture: Region | undefined;
  readonly impactSpeed: number;
  readonly rollingResistance: number;
  readonly trackByBody: ReadonlyMap<number, readonly [PhysicsBody, number]>;
  readonly breaks: readonly { readonly joint: PhysicsJoint; readonly track: number; readonly impulse: number }[];
  readonly wasBroken: Uint8Array;
  before: Float32Array;
  seen: Uint8Array;
}

function dot(a: Vector, b: Vector): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function difference(a: Vector, b: Vector): Vector {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function pointVelocity(centre: Vector, linear: Vector, angular: Vector, point: Vector): Vector {
  const [x, y, z] = difference(point, centre);
  return [
    linear[0] + angular[1] * z - angular[2] * y,
    linear[1] + angular[2] * x - angular[0] * z,
    linear[2] + angular[0] * y - angular[1] * x,
  ];
}

function preVelocity(data: Data, row: number, point: Vector): Vector {
  if (!data.seen[row]) return CENTRE;
  const a = data.before;
  const i = row * MOTION;
  return pointVelocity(
    [a[i]!, a[i + 1]!, a[i + 2]!],
    [a[i + 3]!, a[i + 4]!, a[i + 5]!],
    [a[i + 6]!, a[i + 7]!, a[i + 8]!],
    point,
  );
}

function linearVelocity(c: Columns, row: number): Vector {
  return [c.linearX[row]!, c.linearY[row]!, c.linearZ[row]!];
}

function velocity(c: Columns, row: number, point: Vector): Vector {
  return pointVelocity(
    [c.centerX[row]!, c.centerY[row]!, c.centerZ[row]!],
    linearVelocity(c, row),
    [c.angularX[row]!, c.angularY[row]!, c.angularZ[row]!],
    point,
  );
}

function tangentSpeed(v: Vector, n: Vector): number {
  const normal = dot(v, n);
  const x = v[0] - normal * n[0];
  const y = v[1] - normal * n[1];
  const z = v[2] - normal * n[2];
  return Math.sqrt(x * x + y * y + z * z);
}

function captureBefore(data: Data, kernel: KernelWorld): void {
  const c = kernel.columns;
  if (data.seen.length < kernel.capacity) {
    data.before = new Float32Array(kernel.capacity * MOTION);
    data.seen = new Uint8Array(kernel.capacity);
  }
  data.seen.fill(0);
  for (let i = 0; i < kernel.awakeCount; i++) {
    const row = c.awake[i]!;
    data.seen[row] = 1;
    const at = row * MOTION;
    data.before[at] = c.centerX[row]!;
    data.before[at + 1] = c.centerY[row]!;
    data.before[at + 2] = c.centerZ[row]!;
    data.before[at + 3] = c.linearX[row]!;
    data.before[at + 4] = c.linearY[row]!;
    data.before[at + 5] = c.linearZ[row]!;
    data.before[at + 6] = c.angularX[row]!;
    data.before[at + 7] = c.angularY[row]!;
    data.before[at + 8] = c.angularZ[row]!;
  }
}

function emit(out: Float64Array, track: number | undefined, i: number, sp: number, s: number, rp: number, r: number) {
  if (track === undefined) return;
  const at = track * MODAL_CONTACT_WORDS;
  out[at] += i;
  out[at + 1] += sp;
  out[at + 2] += sp * s;
  out[at + 3] += rp;
  out[at + 4] += rp * r;
}

function contactLoads(data: Data, kernel: KernelWorld, dt: number): void {
  const c = kernel.columns;
  const out = regionWords(data.host.memory, data.contact) as Float64Array;
  out.fill(0);
  for (let order = 0; order < kernel.solvingPairs; order++) {
    const pair = c.solvePairs[order]!;
    const impulse = c.pairForce[pair]!;
    const count = c.pairContacts[pair]!;
    if (!(impulse > 0) || count === 0) continue;
    const a = c.colliderBody[c.pairA[pair]!]!;
    const b = c.colliderBody[c.pairB[pair]!]!;
    const sourceA = data.trackByBody.get(a);
    const sourceB = data.trackByBody.get(b);
    const trackA = sourceA?.[0].valid ? sourceA[1] : undefined;
    const trackB = sourceB?.[0].valid ? sourceB[1] : undefined;
    if (trackA === undefined && trackB === undefined) continue;
    const n: Vector = [c.pairNormalX[pair]!, c.pairNormalY[pair]!, c.pairNormalZ[pair]!];
    const surface: Vector = [c.pairSurfaceX[pair]!, c.pairSurfaceY[pair]!, c.pairSurfaceZ[pair]!];
    const relativeCentre = difference(difference(linearVelocity(c, b), linearVelocity(c, a)), surface);
    const travelSpeed = tangentSpeed(relativeCentre, n);
    const first = pair * 4;
    let weight = 0;
    for (let j = first; j < first + count; j++) weight += c.contactNormalImpulse[j]!;
    for (let j = first; j < first + count; j++) {
      const share = weight > 0 ? c.contactNormalImpulse[j]! / weight : 1 / count;
      if (!(share > 0)) continue;
      const point: Vector = [c.contactX[j]!, c.contactY[j]!, c.contactZ[j]!];
      const relative = difference(difference(velocity(c, b, point), velocity(c, a, point)), surface);
      const slip = tangentSpeed(relative, n);
      const spinSpeed = tangentSpeed(difference(relative, relativeCentre), n);
      const roll = travelSpeed > 0 ? Math.min(travelSpeed, spinSpeed) * Math.max(0, 1 - slip / travelSpeed) : 0;
      const approach = dot(difference(preVelocity(data, a, point), preVelocity(data, b, point)), n);
      const delivered = impulse * share;
      const impact = approach > data.impactSpeed ? delivered : 0;
      const normalForce = delivered / dt;
      const scrapePower = normalForce * c.pairFriction[pair]! * slip;
      const rollPower = normalForce * data.rollingResistance * roll;
      emit(out, trackA, impact, scrapePower, slip, rollPower, roll);
      emit(out, trackB, impact, scrapePower, slip, rollPower, roll);
    }
  }
}

/** Replace the world's rigid solver to drive matching modal tracks automatically from solved contacts and joint ruptures. */
export class ModalContactRigidSolver extends RigidSolver {
  readonly #sound: Pick<ModalSoundSolver, 'contactField' | 'fractureField' | 'rate'>;
  readonly #breaks: readonly ModalJointSound[];
  #data?: Data;

  constructor(
    sound: Pick<ModalSoundSolver, 'contactField' | 'fractureField' | 'rate'>,
    setup: ModalContactRigidSetup = {},
  ) {
    super(setup.id ?? 'rigid');
    this.#sound = sound;
    this.#breaks = setup.jointBreaks?.map((binding) => ({ ...binding })) ?? [];
  }

  override describe(): SolverDescription {
    const base = super.describe();
    return {
      ...base,
      fields: [
        ...base.fields,
        { field: this.#sound.contactField, access: 'write' },
        ...(this.#breaks.length ? [{ field: this.#sound.fractureField, access: 'write' as const }] : []),
      ],
    };
  }

  override init(host: SolverHost, options: ModalContactRigidOptions): void {
    const { physics, emitters } = options ?? {};
    if (!physics || physics.fixedTimestep * rateOf(this.#sound.rate) !== 1)
      throw modalSoundError('Match the rigid fixedTimestep to the dyadic rate passed to ModalSoundSolver.load.');
    if (!Array.isArray(emitters) || !emitters.length)
      throw modalSoundError('Pass at least one modal rigid emitter in track order.');
    const inWorld = (body: PhysicsBody) =>
      body.valid && body.colliders.some((collider) => physics.colliderOf(collider.handle) === collider);
    const trackByBody = new Map<number, readonly [PhysicsBody, number]>();
    for (const [track, body] of emitters.entries()) {
      if (body === null) continue;
      if (!body || !inWorld(body) || trackByBody.has(body.row))
        throw modalSoundError(
          'Pass distinct collider-bearing bodies from this Physics instance as modal rigid emitters.',
        );
      trackByBody.set(body.row, [body, track]);
    }
    const shares = new Map<PhysicsJoint, { energy: number; fraction: number }>();
    const breaks = this.#breaks.map(({ joint, track, energy, effectiveMass, energyFraction = 1 }) => {
      if (!joint?.valid || !physics.jointsOf(joint.bodyA).includes(joint))
        throw modalSoundError('Pass a live rigid joint from this Physics instance in each modal fracture mapping.');
      if (!Number.isInteger(track) || track < 0 || track >= emitters.length)
        throw modalSoundError('Set the modal fracture track to a zero-based index in the emitters array.');
      const impulse = modalFractureImpulse(energy, effectiveMass, energyFraction);
      const previous = shares.get(joint);
      const fraction = (previous?.fraction ?? 0) + energyFraction;
      if (fraction > 1 || (previous && previous.energy !== energy))
        throw modalSoundError(
          'Use one energy for each rupturing joint and keep its total energy fractions at or below 1.',
        );
      shares.set(joint, { energy, fraction });
      return { joint, track, impulse };
    });
    const impactSpeed = limited(options.impactSpeed ?? 0.25, 0, 100, 'impact approach speed in m/s');
    const rollingResistance = limited(options.rollingResistance ?? 0.025, 0, 1, 'rolling resistance');
    super.init(host, options);
    this.#data = {
      host,
      physics,
      contact: host.allocate('modal-rigid-contacts', emitters.length * MODAL_CONTACT_WORDS * 8, 'f64', 1),
      fracture: breaks.length ? host.allocate('modal-rigid-fractures', emitters.length * 8, 'f64', 1) : undefined,
      impactSpeed,
      rollingResistance,
      trackByBody,
      breaks,
      wasBroken: new Uint8Array(breaks.length),
      before: new Float32Array(0),
      seen: new Uint8Array(0),
    };
  }

  override step(context: StepContext, dt: number): void {
    const data = this.#data!;
    const kernel = data.physics.kernel;
    if (data.trackByBody.size) captureBefore(data, kernel);
    for (const [index, binding] of data.breaks.entries())
      data.wasBroken[index] = Number(!binding.joint.valid || binding.joint.broken);
    super.step(context, dt);
    if (data.trackByBody.size) contactLoads(data, kernel, dt);
    if (data.fracture) {
      const out = regionWords(data.host.memory, data.fracture) as Float64Array;
      out.fill(0);
      for (const [index, binding] of data.breaks.entries())
        if (!data.wasBroken[index] && binding.joint.valid && binding.joint.broken)
          out[binding.track] += binding.impulse;
    }
  }

  override exportPorts(tick: number): readonly Port[] {
    const { contact, fracture, host } = this.#data!;
    const cell = host.cell;
    return [
      ...super.exportPorts(tick),
      { field: this.#sound.contactField.name, region: contact, tick, cell },
      ...(fracture ? [{ field: this.#sound.fractureField.name, region: fracture, tick, cell }] : []),
    ];
  }

  override stateRegions(): readonly Region[] {
    const { contact, fracture } = this.#data!;
    return [...super.stateRegions(), contact, ...(fracture ? [fracture] : [])];
  }
}
