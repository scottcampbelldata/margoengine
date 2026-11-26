import { MargoError } from '@margoengine/math/errors';
import { hypot } from '@margoengine/math/pinned';
import { regionWords } from '../world/memory.js';
import type {
  Cell,
  FieldDescriptor,
  Port,
  Region,
  Solver,
  SolverDescription,
  SolverHost,
  StepContext,
} from '../world/solver.js';
import { BODIES_FIELD, BODY_IMPULSES_FIELD, BODY_WORDS, IMPULSE_WORDS } from '../world/solvers/rigid.js';
import { crushMaterial, crushPrepared, positive, type CrushMaterial } from './material.js';

export { resolveCrush, type CrushMaterial, type CrushResult } from './material.js';

/** Read-only Cartesian coordinates in X/Y/Z. */
export type CrushVector = readonly [number, number, number];
const ZERO: CrushVector = [0, 0, 0];
const F64 = Float64Array.BYTES_PER_ELEMENT;
const F32 = Float32Array.BYTES_PER_ELEMENT;
const BODIES_LAYOUT = 2;
const IMPULSES_LAYOUT = 1;

/** One fixed barrier or a local anchor carried by a rigid body. */
export interface CrushSupport {
  /** Body row for a moving support. Omit for a fixed barrier. */
  readonly body?: number;
  /** Body-local point in metres, or barrier position relative to the supplied origin cell. */
  readonly point: CrushVector;
  /** Origin cell for fixed barriers. Default [0, 0, 0]. */
  readonly cell?: Cell;
}

/** One known pair of civil contact surfaces and its measured effective normal loading curve. */
export interface CrushPatch {
  /** Rigid body row on the crush side. */
  readonly body: number;
  /** Undeformed body-local anchor, m. */
  readonly anchor: CrushVector;
  /** Outward body-local normal towards the other surface. Normalized at initialization. */
  readonly normal: CrushVector;
  readonly support: CrushSupport;
  /** Transverse contact radius about the support's anchor, m. */
  readonly radius: number;
  readonly material: CrushMaterial;
  /** Permanent stroke at which the barrier can no longer maintain its seal. Default the material's stroke. */
  readonly sealStroke?: number;
}

/** Optional entry and registry settings. */
export interface CrushOptions {
  /** Solver ID and output prefix. Default 'crush'. */
  readonly id?: string;
}

/** Parameters for auto-detecting near-contact patch events from a RigidSolver. */
export interface CrushParams {
  /** Same capacity as the RigidSolver's bodies port. */
  readonly bodyCapacity: number;
  /** Width of one world origin cell, required for barriers in another cell. */
  readonly cellSize?: number;
  /** Stable ordering of configured contact surfaces. */
  readonly patches: readonly CrushPatch[];
}

/** Layout-1 f64 data, in patch order. */
export const CRUSH_LAYOUT = 1;
/** Each row stores permanent, total work, peak stroke, peak force, impulse, elastic work, seal loss, and count. */
export const CRUSH_WORDS = 8;

/** State of one contact patch. Peak and impulse fields describe its most recent impact. */
export interface CrushPatchState {
  readonly permanentStroke: number;
  readonly absorbedEnergy: number;
  readonly peakStroke: number;
  readonly peakForce: number;
  readonly impulse: number;
  readonly elasticEnergy: number;
  readonly sealLoss: number;
  readonly impacts: number;
}

interface Patch extends CrushPatch {
  readonly material: Required<CrushMaterial>;
  readonly sealStroke: number;
}

interface State {
  readonly host: SolverHost;
  readonly patches: readonly Patch[];
  readonly capacity: number;
  readonly cellSize?: number;
  readonly damage: Region;
  readonly contacts: Region;
  readonly reactions: Region;
}

function vector(v: CrushVector, label: string): CrushVector {
  if (!v.every(Number.isFinite)) throw new MargoError('state', `Choose finite coordinates for the crush ${label}.`);
  return [v[0], v[1], v[2]];
}

function rowIndex(row: number, capacity: number): number {
  if (!Number.isSafeInteger(row) || row < 0 || row >= capacity)
    throw new MargoError('state', 'Choose existing body rows within the crush RigidSolver capacity.');
  return row;
}

const add = (a: CrushVector, b: CrushVector): CrushVector => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: CrushVector, b: CrushVector): CrushVector => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: CrushVector, factor: number): CrushVector => [a[0] * factor, a[1] * factor, a[2] * factor];
const dot = (a: CrushVector, b: CrushVector): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: CrushVector, b: CrushVector): CrushVector => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const triple = (words: Float32Array | Float64Array, at: number): CrushVector => [
  words[at]!,
  words[at + 1]!,
  words[at + 2]!,
];

function rotation(values: Float32Array, row: number): (v: CrushVector) => CrushVector {
  const at = row * BODY_WORDS + 3;
  const axis = triple(values, at);
  const w = values[at + 3]!;
  const q2 = dot(axis, axis) + w * w;
  if (!(q2 > 0 && Number.isFinite(q2)))
    throw new MargoError('state', 'Use a live RigidSolver body row to each crush surface.');
  return (v: CrushVector) => {
    const twice = scale(cross(axis, v), 2 / q2); // float division: normalize the quaternion product
    return add(v, add(scale(twice, w), cross(axis, twice)));
  };
}

function inertiaProduct(bodies: Float32Array, at: number, w: CrushVector): CrushVector {
  const [x, y, z] = w;
  const xx = bodies[at + 17]!,
    xy = bodies[at + 18]!,
    xz = bodies[at + 19]!;
  const yy = bodies[at + 20]!,
    yz = bodies[at + 21]!,
    zz = bodies[at + 22]!;
  return [xx * x + xy * y + xz * z, xy * x + yy * y + yz * z, xz * x + yz * y + zz * z];
}

interface AtContact {
  readonly arm: CrushVector;
  readonly velocity: CrushVector;
  readonly inverseMass: number;
}

function atContact(
  bodies: Float32Array,
  applied: Float64Array,
  row: number,
  point: CrushVector,
  normal: CrushVector,
): AtContact {
  const at = row * BODY_WORDS;
  const reaction = row * IMPULSE_WORDS;
  const arm = sub(point, triple(bodies, at + 7));
  const inverse = bodies[at + 16]!;
  const linear = add(triple(bodies, at + 10), scale(triple(applied, reaction), inverse));
  const angular = add(triple(bodies, at + 13), inertiaProduct(bodies, at, triple(applied, reaction + 3)));
  const angularImpulse = cross(arm, normal);
  return {
    arm,
    velocity: add(linear, cross(angular, arm)),
    inverseMass: inverse + dot(angularImpulse, inertiaProduct(bodies, at, angularImpulse)),
  };
}

function impulseAt(out: Float64Array, row: number, force: CrushVector, arm: CrushVector): void {
  const at = row * IMPULSE_WORDS;
  out.set(add(triple(out, at), force), at);
  out.set(add(triple(out, at + 3), cross(arm, force)), at + 3);
}

function fixedAnchor(support: CrushSupport, cell: Cell, size: number | undefined): CrushVector {
  const difference = sub(support.cell ?? ZERO, cell);
  if (!size && difference.some((value) => value !== 0))
    throw new MargoError(
      'state',
      'Set the world cell size when a crush barrier is in a different cell from the rigid bodies.',
    );
  return add(support.point, scale(difference, size ?? 0));
}

function impact(
  state: State,
  patch: Patch,
  index: number,
  port: Port,
  bodies: Float32Array,
  out: Float64Array,
  damage: Float64Array,
  latched: Uint8Array,
  dt: number,
): void {
  const { body, support } = patch;
  const rotate = rotation(bodies, body);
  const normal = rotate(patch.normal);
  const anchor = add(triple(bodies, body * BODY_WORDS), rotate(patch.anchor));
  const other =
    support.body === undefined
      ? fixedAnchor(support, port.cell, state.cellSize)
      : add(triple(bodies, support.body * BODY_WORDS), rotation(bodies, support.body)(support.point));
  const separation = sub(other, anchor);
  const gap = dot(separation, normal);
  const at = CRUSH_WORDS * index;
  const permanent = damage[at]!;
  const clearance = gap + permanent;
  if (latched[index]) {
    if (clearance > 0) latched[index] = 0;
    else return;
  }
  const contact = add(anchor, scale(normal, 0.5 * gap));
  const a = atContact(bodies, out, body, contact, normal);
  const b = support.body === undefined ? undefined : atContact(bodies, out, support.body, contact, normal);
  const relative = sub(a.velocity, b?.velocity ?? ZERO);
  const closing = dot(relative, normal);
  const inverse = a.inverseMass + (b?.inverseMass ?? 0);
  if (!(closing > 0 && inverse > 0) || clearance > dt * closing) return;
  const delay = Math.max(0, clearance) / closing; // float division: time to the first normal contact
  const lateral = sub(separation, scale(normal, gap));
  const travel = sub(relative, scale(normal, closing));
  const offset = sub(lateral, scale(travel, delay));
  if (dot(offset, offset) > patch.radius * patch.radius) return;
  const result = crushPrepared(patch.material, 1 / inverse, closing, permanent); // float division: effective normal mass
  const force = scale(normal, result.impulse);
  impulseAt(out, body, scale(force, -1), a.arm);
  if (b && support.body !== undefined) impulseAt(out, support.body, force, b.arm);
  damage.set(
    [
      result.permanentStroke,
      damage[at + 1]! + result.absorbedEnergy,
      result.peakStroke,
      result.peakForce,
      result.impulse,
      result.elasticEnergy,
      Math.min(1, result.permanentStroke / patch.sealStroke),
      damage[at + 7]! + 1, // float division: seal threshold
    ],
    at,
  );
  latched[index] = 1;
}

/** Ductile crush with normal impulse feedback to a real RigidSolver and a published durable damage ledger. */
export class CrushSolver implements Solver<CrushParams> {
  readonly id: string;
  readonly damageField: FieldDescriptor;
  private state: State | undefined;

  constructor({ id = 'crush' }: CrushOptions = {}) {
    this.id = id;
    this.damageField = {
      name: `${id}:damage`,
      kind: 'surfaceSampleSet',
      quantity: 'crushDamage',
      unit: 'm, J, N, N s, 1',
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
        { field: this.damageField, access: 'write' },
      ],
    };
  }

  init(host: SolverHost, params: CrushParams): void {
    const capacity = params.bodyCapacity;
    if (!Number.isSafeInteger(capacity) || capacity < 1 || !params.patches?.length)
      throw new MargoError(
        'state',
        'Choose the RigidSolver body capacity and provide at least one crush contact patch.',
      );
    const patches = params.patches.map((patch): Patch => {
      const material = crushMaterial(patch.material);
      const body = rowIndex(patch.body, capacity);
      const normal = vector(patch.normal, 'normal');
      const length = positive(hypot(...normal), 'normal length');
      const other = patch.support.body === undefined ? undefined : rowIndex(patch.support.body, capacity);
      if (other === body) throw new MargoError('state', 'Choose opposing crush contacts on distinct rigid body rows.');
      const cell = patch.support.cell && vector(patch.support.cell, 'barrier cell');
      if (cell && !cell.every(Number.isSafeInteger))
        throw new MargoError('state', 'Use a crush barrier cell as three safe integer coordinates.');
      return {
        body,
        material,
        normal: scale(normal, 1 / length),
        anchor: vector(patch.anchor, 'anchor'), // float division: unit normal
        radius: positive(patch.radius, 'contact radius'),
        sealStroke: positive(patch.sealStroke ?? material.stroke, 'seal stroke', Number.MIN_VALUE, material.stroke),
        support: { body: other, point: vector(patch.support.point, 'support anchor'), cell },
      };
    });
    this.state = {
      host,
      patches,
      capacity,
      cellSize: params.cellSize === undefined ? undefined : positive(params.cellSize, 'world cell width'),
      damage: host.allocate('crush-damage', patches.length * CRUSH_WORDS * F64, 'f64', CRUSH_LAYOUT),
      contacts: host.allocate('crush-contacts', patches.length, 'u8', CRUSH_LAYOUT),
      reactions: host.allocate('crush-reactions', capacity * IMPULSE_WORDS * F64, 'f64', IMPULSES_LAYOUT),
    };
  }

  step(context: StepContext, dt: number): void {
    const state = this.requireState();
    const out = regionWords(state.host.memory, state.reactions) as Float64Array;
    out.fill(0);
    const port = context.inputs.get(BODIES_FIELD.name);
    if (!port) return;
    if (
      port.region.type !== 'f32' ||
      port.region.layout !== BODIES_LAYOUT ||
      port.region.byteLength !== state.capacity * BODY_WORDS * F32
    )
      throw new MargoError('state', 'Set the crush body capacity to match the RigidSolver layout-2 bodies port.');
    const bodies = regionWords(state.host.memory, port.region) as Float32Array;
    const damage = regionWords(state.host.memory, state.damage) as Float64Array;
    const contacts = regionWords(state.host.memory, state.contacts) as Uint8Array;
    for (let i = 0; i < state.patches.length; i++)
      impact(state, state.patches[i]!, i, port, bodies, out, damage, contacts, dt);
  }

  importPorts(_tick: number): void {}

  exportPorts(tick: number): readonly Port[] {
    const { damage, reactions } = this.requireState();
    return [
      { field: this.damageField.name, region: damage, tick, cell: ZERO },
      { field: BODY_IMPULSES_FIELD.name, region: reactions, tick, cell: ZERO },
    ];
  }

  stateRegions(): readonly Region[] {
    const { damage, contacts } = this.requireState();
    return [damage, contacts];
  }

  extraState(): readonly Region[] {
    return [this.requireState().reactions];
  }

  /** Copies the cumulative and most recent damage state for one configured contact patch. */
  read(index: number): CrushPatchState {
    const state = this.requireState();
    if (!Number.isSafeInteger(index) || index < 0 || index >= state.patches.length)
      throw new MargoError('state', 'Use a crush patch index in the configured patch list.');
    const values = regionWords(state.host.memory, state.damage) as Float64Array;
    const at = index * CRUSH_WORDS;
    return {
      permanentStroke: values[at]!,
      absorbedEnergy: values[at + 1]!,
      peakStroke: values[at + 2]!,
      peakForce: values[at + 3]!,
      impulse: values[at + 4]!,
      elasticEnergy: values[at + 5]!,
      sealLoss: values[at + 6]!,
      impacts: values[at + 7]!,
    };
  }

  private requireState(): State {
    if (!this.state)
      throw new MargoError('state', 'Add CrushSolver to a PhysicsWorld before calling its state methods.');
    return this.state;
  }
}
