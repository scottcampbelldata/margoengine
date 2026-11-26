import { MargoError } from '@margoengine/math/errors';
import { hypot } from '@margoengine/math/pinned';
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
import { BODIES_FIELD, BODY_IMPULSES_FIELD, BODY_WORDS, IMPULSE_WORDS } from '../world/solvers/rigid.js';
import { girderTangent, resolveGirder, type GirderFiber } from './girder.js';
import { positive } from './material.js';
import { GIRDER_SEAM_BROKEN_WORD, GIRDER_SEAM_LAYOUT, GIRDER_SEAM_QUANTITY, GIRDER_SEAM_WORDS } from './port.js';
import {
  add,
  angularAt,
  applyCouple,
  atContact,
  cross,
  dot,
  impulseAt,
  inertiaProduct,
  rotation,
  rowIndex,
  scale,
  sub,
  triple,
  vector,
  ZERO,
  type CrushVector,
} from './rigid-contact.js';

const BODIES_LAYOUT = 2;
const AXES = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
] as const;
const F64 = Float64Array.BYTES_PER_ELEMENT;

/** One side of a breakable section between independent rigid bodies. */
export interface GirderJointEnd {
  /** Rigid body row carrying the end. */
  readonly body: number;
  /** Body-local interface point, m. */
  readonly anchor: CrushVector;
}

/** A reduced one-axis bending section between prebuilt rigid structure parts. */
export interface GirderJoint {
  readonly first: GirderJointEnd;
  readonly second: GirderJointEnd;
  /** Bending axis in the first body frame. Both body frames align at rest. */
  readonly axis: CrushVector;
  /** Distance between section orientations used to resolve curvature, m. */
  readonly gaugeLength: number;
  /** Translational stiffness holding the interface points together, N/m. */
  readonly anchorStiffness: number;
  /** Tensile failure strain of the connected section. */
  readonly failureStrain: number;
  /** Plate and stiffener curves in section order. */
  readonly fibers: readonly GirderFiber[];
}

/** Settings for GirderJointSolver. */
export interface GirderJointParams {
  /** Same body capacity as RigidSolver. */
  readonly bodyCapacity: number;
  /** Breakable sections in stable order. */
  readonly joints: readonly GirderJoint[];
}

/** Current bending and durable failure state of one section. */
export interface GirderJointState {
  /** Signed curvature from the end orientations, retained after failure, 1/m. */
  readonly curvature: number;
  /** Connected resisting moment at this tick, N m. */
  readonly bendingMoment: number;
  /** Largest tensile strain seen at any element. */
  readonly peakTension: number;
  /** Distance between the section's current anchors, m. */
  readonly separation: number;
  /** Whether the seam permanently released its two rigid parts. */
  readonly broken: boolean;
}

function prepare(joint: GirderJoint, capacity: number): GirderJoint {
  const first = { body: rowIndex(joint.first.body, capacity), anchor: vector(joint.first.anchor, 'girder anchor') };
  const second = { body: rowIndex(joint.second.body, capacity), anchor: vector(joint.second.anchor, 'girder anchor') };
  if (first.body === second.body)
    throw new MargoError('state', 'Choose distinct body rows on either side of a girder joint.');
  const direction = vector(joint.axis, 'girder bending axis');
  const axis = scale(direction, 1 / positive(hypot(...direction), 'girder axis length')); // float division
  const fibers = joint.fibers.map(({ offset, area, curve }) => ({
    offset,
    area,
    curve: curve.map((sample) => ({ ...sample })),
  }));
  if (!resolveGirder(fibers, 0))
    throw new MargoError('state', 'Give the girder fibers an equilibrated section at zero curvature.');
  return {
    first,
    second,
    axis,
    fibers,
    gaugeLength: positive(joint.gaugeLength, 'girder gauge length'),
    anchorStiffness: positive(joint.anchorStiffness, 'girder anchor stiffness'),
    failureStrain: positive(joint.failureStrain, 'girder failure strain'),
  };
}

function pointImpulse(
  bodies: Float32Array,
  staged: Float64Array,
  joint: GirderJoint,
  middle: CrushVector,
  gap: CrushVector,
  h: number,
): void {
  const { first, second, anchorStiffness: k } = joint;
  const a = atContact(bodies, staged, first.body, middle, AXES[0]);
  const b = atContact(bodies, staged, second.body, middle, AXES[0]);
  const armA = AXES.map((axis) => cross(a.arm, axis));
  const armB = AXES.map((axis) => cross(b.arm, axis));
  const rowA = first.body * BODY_WORDS;
  const rowB = second.body * BODY_WORDS;
  const inverse = bodies[rowA + 16]! + bodies[rowB + 16]!;
  const mobility = h * h * k;
  const diagonal = 1 + mobility * inverse;
  const matrix = (i: number, j: number): number =>
    (i === j ? diagonal : 0) +
    mobility *
      (dot(armA[i]!, inertiaProduct(bodies, rowA, armA[j]!)) + dot(armB[i]!, inertiaProduct(bodies, rowB, armB[j]!)));
  const rhs = scale(add(gap, scale(sub(b.velocity, a.velocity), h)), h * k);
  // Cholesky of the symmetric positive definite three-axis contact mobility.
  const l00 = Math.sqrt(matrix(0, 0));
  const l10 = matrix(1, 0) / l00; // float division
  const l20 = matrix(2, 0) / l00; // float division
  const l11 = Math.sqrt(matrix(1, 1) - l10 * l10);
  const l21 = (matrix(2, 1) - l20 * l10) / l11; // float division
  const l22 = Math.sqrt(matrix(2, 2) - l20 * l20 - l21 * l21);
  const x = rhs[0] / l00; // float division: forward triangular solve
  const y = (rhs[1] - l10 * x) / l11; // float division
  const z = (rhs[2] - l20 * x - l21 * y) / l22; // float division
  const third = z / l22; // float division: backward triangular solve
  const secondAxis = (y - l21 * third) / l11; // float division
  const firstAxis = (x - l10 * secondAxis - l20 * third) / l00; // float division
  const impulse: CrushVector = [firstAxis, secondAxis, third];
  if (!impulse.every(Number.isFinite))
    throw new MargoError(
      'state',
      'Choose girder anchor stiffness, body inertia and positions with a representable reaction.',
    );
  impulseAt(staged, first.body, impulse, a.arm);
  impulseAt(staged, second.body, scale(impulse, -1), b.arm);
}

function sectionRotation(bodies: Float32Array, atA: number, atB: number, axis: CrushVector) {
  const a = triple(bodies, atA + 3);
  const b = triple(bodies, atB + 3);
  const aw = bodies[atA + 6]!;
  const bw = bodies[atB + 6]!;
  const scalar = aw * bw + dot(a, b);
  const vectorPart = sub(sub(scale(b, aw), scale(a, bw)), cross(a, b));
  const sign = scalar < 0 || (scalar === 0 && dot(vectorPart, axis) < 0) ? -1 : 1;
  const normalize = sign / Math.sqrt(scalar * scalar + dot(vectorPart, vectorPart)); // float division
  const relative = scale(vectorPart, normalize);
  // The differential of the projected quaternion vector is half this gradient.
  const gradient = add(scale(axis, scalar * normalize), cross(relative, axis));
  return { gradient, halfSine: dot(relative, axis) };
}

function bendJoint(
  joint: GirderJoint,
  bodies: Float32Array,
  reactions: Float64Array,
  state: Float64Array,
  at: number,
  h: number,
): void {
  const { first, second } = joint;
  const rowA = first.body * BODY_WORDS;
  const rowB = second.body * BODY_WORDS;
  state[at + 1] = 0;
  if (bodies[rowA + 23] !== 1 || bodies[rowB + 23] !== 1) return;
  const rotateA = rotation(bodies, first.body);
  const rotateB = rotation(bodies, second.body);
  const pointA = add(triple(bodies, rowA), rotateA(first.anchor));
  const pointB = add(triple(bodies, rowB), rotateB(second.anchor));
  const gap = sub(pointB, pointA);
  state[at + 4] = hypot(...gap);
  if (state[at + GIRDER_SEAM_BROKEN_WORD] === 1) return;

  const { gradient, halfSine } = sectionRotation(bodies, rowA, rowB, joint.axis);
  const curvature = (2 * halfSine) / joint.gaugeLength; // float division: circular curvature from the chord
  state[at] = curvature;
  const section = resolveGirder(joint.fibers, curvature, { previousStrain: state[at + 2]! });
  if (section) {
    state[at + 2] = section.referenceStrain;
    for (const { strain } of section.fibers) state[at + 3] = Math.max(state[at + 3]!, strain);
  }
  if (!section || state[at + 3]! >= joint.failureStrain) {
    state[at + GIRDER_SEAM_BROKEN_WORD] = 1;
    return;
  }

  const magnitude = hypot(...gradient);
  if (magnitude > 0) {
    const axis = rotateA(scale(gradient, 1 / magnitude)); // float division: angular impulse direction
    const angleRate = dot(
      sub(angularAt(bodies, reactions, second.body), angularAt(bodies, reactions, first.body)),
      axis,
    );
    const angularInverse = dot(axis, add(inertiaProduct(bodies, rowA, axis), inertiaProduct(bodies, rowB, axis)));
    const spring = section.bendingMoment * magnitude;
    const tangent = Math.max(
      0,
      (girderTangent(joint.fibers, section.fibers) * magnitude * magnitude) / joint.gaugeLength -
        0.5 * section.bendingMoment * halfSine,
    ); // float division: curvature-based stiffness in the angular coordinate
    const moment = (spring + h * tangent * angleRate) / (1 + h * h * tangent * angularInverse); // float division
    if (!Number.isFinite(moment))
      throw new MargoError('state', 'Choose a girder section and body inertia with a representable bending moment.');
    state[at + 1] = moment;
    const couple = scale(axis, h * moment);
    applyCouple(reactions, first.body, couple);
    applyCouple(reactions, second.body, scale(couple, -1));
  }
  pointImpulse(bodies, reactions, joint, scale(add(pointA, pointB), 0.5), gap, h);
}

/** A breakable bending seam that transfers actual impulses between RigidSolver bodies. */
export class GirderJointSolver implements Solver<GirderJointParams> {
  /** Published f64 rows: curvature, moment, reference strain, peak tension, separation, broken flag. */
  readonly seamField: FieldDescriptor;
  private state:
    | { host: SolverHost; joints: readonly GirderJoint[]; seam: Region; reactions: Region; capacity: number }
    | undefined;

  constructor(readonly id = 'girder-joint') {
    this.seamField = {
      name: `${id}:seams`,
      kind: 'surfaceSampleSet',
      quantity: GIRDER_SEAM_QUANTITY,
      unit: '1/m, N m, 1, 1, m, 1',
      centring: 'particle',
    };
  }

  describe(): SolverDescription {
    return {
      id: this.id,
      rate: 0,
      stableRate: () => 0,
      fields: [
        { field: BODIES_FIELD, access: 'read' },
        { field: BODY_IMPULSES_FIELD, access: 'accumulate' },
        { field: this.seamField, access: 'write' },
      ],
    };
  }

  init(host: SolverHost, params: GirderJointParams): void {
    const capacity = params.bodyCapacity;
    if (!Number.isSafeInteger(capacity) || capacity < 1 || !params.joints?.length)
      throw new MargoError('state', 'Give the RigidSolver body capacity and at least one girder joint.');
    const joints = params.joints.map((joint) => prepare(joint, capacity));
    this.state = {
      host,
      capacity,
      joints,
      seam: host.allocate('girder-seams', joints.length * GIRDER_SEAM_WORDS * F64, 'f64', GIRDER_SEAM_LAYOUT),
      reactions: host.allocate('girder-reactions', capacity * IMPULSE_WORDS * F64, 'f64', 1),
    };
  }

  step(context: StepContext, h: number): void {
    const { host, capacity, joints, seam, reactions } = this.requireState();
    const out = regionWords(host.memory, reactions) as Float64Array;
    out.fill(0);
    const input = context.inputs.get(BODIES_FIELD.name);
    if (!input) return;
    if (
      input.region.type !== 'f32' ||
      input.region.layout !== BODIES_LAYOUT ||
      input.region.byteLength !== capacity * BODY_WORDS * Float32Array.BYTES_PER_ELEMENT
    )
      throw new MargoError('state', 'Use the RigidSolver layout-2 bodies port and its body capacity for the girder.');
    const bodies = regionWords(input.region.memory ?? host.memory, input.region) as Float32Array;
    const values = regionWords(host.memory, seam) as Float64Array;
    for (let index = 0; index < joints.length; index++)
      bendJoint(joints[index]!, bodies, out, values, index * GIRDER_SEAM_WORDS, h);
  }

  importPorts(_tick: number): void {}

  exportPorts(tick: number): readonly Port[] {
    const { seam, reactions } = this.requireState();
    return [
      { field: this.seamField.name, region: seam, tick, cell: ZERO },
      { field: BODY_IMPULSES_FIELD.name, region: reactions, tick, cell: ZERO },
    ];
  }

  stateRegions(): readonly Region[] {
    return [this.requireState().seam];
  }

  extraState(): readonly Region[] {
    return [this.requireState().reactions];
  }

  /** Copies the current bend and persistent failure state for one configured joint. */
  read(index: number): GirderJointState {
    const { host, joints, seam } = this.requireState();
    if (!Number.isSafeInteger(index) || index < 0 || index >= joints.length)
      throw new MargoError('state', 'Choose an index in the configured girder joints.');
    const at = index * GIRDER_SEAM_WORDS;
    const values = regionWords(host.memory, seam) as Float64Array;
    return {
      curvature: values[at]!,
      bendingMoment: values[at + 1]!,
      peakTension: values[at + 3]!,
      separation: values[at + 4]!,
      broken: values[at + GIRDER_SEAM_BROKEN_WORD] === 1,
    };
  }

  private requireState() {
    if (!this.state) throw new MargoError('state', 'Add GirderJointSolver to a PhysicsWorld before reading it.');
    return this.state;
  }
}
