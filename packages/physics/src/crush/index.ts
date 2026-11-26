import { MargoError } from '@margoengine/math/errors';
import type { Bed } from '@margoengine/math/fields';
import { hypot } from '@margoengine/math/pinned';
import { BED_FIELD, bedFromPort, bedVertexCount, type BedShape } from '../earth/bed.js';
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
import { type CompressionStep, stepCompression } from './continuous.js';
import { traceGround } from './ground.js';
import {
  CircularPlateIndentation,
  indentByImpulse,
  type CircularPlateParams,
  type CircularPlateReading,
} from './indentation.js';
import { crushMaterial, crushPrepared, positive, type CrushMaterial } from './material.js';
import { resolvePlateBuckling, type CrushPlate, type CrushPlateResponse } from './plate.js';
import { CRUSH_DAMAGE_QUANTITY, CRUSH_LAYOUT, CRUSH_SEAL_LOSS_WORD, CRUSH_WORDS } from './port.js';
import {
  type AtContact,
  type CrushVector,
  ZERO,
  add,
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
} from './rigid-contact.js';

export { CRUSH_LAYOUT, CRUSH_WORDS } from './port.js';
export { CircularPlateIndentation, type CircularPlateParams, type CircularPlateReading } from './indentation.js';
export {
  GirderJointSolver,
  type GirderJoint,
  type GirderJointEnd,
  type GirderJointParams,
  type GirderJointState,
} from './girder-joint.js';
export { resolvePlateBuckling, type CrushPlate, type CrushPlateResponse, type CrushPlateSurface } from './plate.js';
export { SHELL_APERTURE_LAYOUT, SHELL_APERTURE_WORDS } from './shell-aperture.js';
export type { CrushShellContact, CrushShellSphere } from './shell-rigid.js';
export type { CrushSheetSeam, CrushSheetSeamReading } from './shell-seam.js';
export {
  type CrushShellBudget,
  type CrushShellFace,
  type CrushShellMaterial,
  type CrushShellParams,
  CrushShellSolver,
} from './shell.js';
export {
  resolveGirder,
  type GirderFiber,
  type GirderLoading,
  type GirderResponse,
  type GirderSample,
} from './girder.js';

export {
  resolveCrush,
  resolveCrushStroke,
  squareTubeCrushMaterial,
  type CrushMaterial,
  type CrushResult,
  type CrushStrokeResult,
  type SquareCrushTube,
} from './material.js';

export type { CrushVector } from './rigid-contact.js';
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
  /** Default 'impact'. Use 'continuous' to advance yielding under the actual end stroke each tick. */
  readonly response?: 'impact' | 'continuous';
  /** Optional sampled plate shape for a continuous contact, driven by its live and residual stroke. */
  readonly plate?: CrushPlate;
  /** Dry sliding and sticking coefficient for the contact pair. Default 0. */
  readonly friction?: number;
  /** Permanent stroke at which the barrier can no longer maintain its seal. Default the material's stroke. */
  readonly sealStroke?: number;
}

/** A hull or chassis station that automatically finds a support on the world terrain bed. */
export type CrushGroundPatch = Omit<CrushPatch, 'support' | 'radius'>;

/** A circular membrane station loaded by a smooth spherical support. */
export type CrushIndentationPatch = Omit<CrushPatch, 'material' | 'response' | 'plate' | 'sealStroke'> & {
  readonly indentation: CircularPlateParams;
};

/** Optional entry and registry settings. */
export interface CrushOptions {
  /** Solver ID and output prefix. Default 'crush'. */
  readonly id?: string;
  /** Grid shape of the live TerrainBed to read when a ground patch is configured. */
  readonly terrain?: BedShape;
}

/** Parameters for auto-detecting near-contact patch events from a RigidSolver. */
export interface CrushParams {
  /** Same capacity as the RigidSolver's bodies port. */
  readonly bodyCapacity: number;
  /** Width of one world origin cell, required for barriers in another cell. */
  readonly cellSize?: number;
  /** Stable ordering of configured contact surfaces. */
  readonly patches: readonly CrushPatch[];
  /** Optional ground stations. Their damage records follow the ordinary patches. */
  readonly groundPatches?: readonly CrushGroundPatch[];
  /** Optional membrane stations. Their damage records follow the ordinary and ground patches. */
  readonly indentationPatches?: readonly CrushIndentationPatch[];
}

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

/** Current shape of a plate linked to a crush patch. */
export interface CrushPlateState {
  /** Current total contact stroke including permanent shortening, m. */
  readonly stroke: number;
  /** Lost seal fraction of the patch, from zero to one. */
  readonly sealLoss: number;
  /** Plate state while the imposed stroke leaves a positive span. */
  readonly buckling?: CrushPlateResponse;
}

type PatchInput = CrushPatch | (CrushGroundPatch & { readonly terrain: true });
type Patch =
  | (PatchInput & {
      readonly material: Required<CrushMaterial>;
      readonly response: 'impact' | 'continuous';
      readonly friction: number;
      readonly sealStroke: number;
    })
  | (Omit<CrushIndentationPatch, 'indentation'> & {
      readonly indentation: CircularPlateIndentation;
      readonly friction: number;
      readonly plate?: undefined;
    });

interface State {
  readonly host: SolverHost;
  readonly patches: readonly Patch[];
  readonly capacity: number;
  readonly cellSize?: number;
  readonly damage: Region;
  readonly contacts: Region;
  readonly reactions: Region;
  readonly plateStrokes?: Region;
}

function angularMass(
  bodies: Float32Array,
  row: number,
  arm: CrushVector,
  first: CrushVector,
  second: CrushVector,
): CrushVector {
  const left = cross(arm, first);
  const right = cross(arm, second);
  const at = row * BODY_WORDS;
  const leftResponse = inertiaProduct(bodies, at, left);
  const rightResponse = inertiaProduct(bodies, at, right);
  return [dot(left, leftResponse), dot(left, rightResponse), dot(right, rightResponse)];
}

function frictionImpulse(
  bodies: Float32Array,
  body: number,
  a: AtContact,
  other: number | undefined,
  b: AtContact | undefined,
  normal: CrushVector,
  limit: number,
): CrushVector {
  const relative = sub(a.velocity, b?.velocity ?? ZERO);
  const tangent = sub(relative, scale(normal, dot(relative, normal)));
  const speed = hypot(...tangent);
  if (speed === 0 || limit === 0) return ZERO;
  const first: CrushVector = [tangent[0] / speed, tangent[1] / speed, tangent[2] / speed]; // float division
  const second = cross(normal, first);
  const [xx, xy, yy] = add(
    angularMass(bodies, body, a.arm, first, second),
    b && other !== undefined ? angularMass(bodies, other, b.arm, first, second) : ZERO,
  );
  const inverse = bodies[body * BODY_WORDS + 16]! + (other === undefined ? 0 : bodies[other * BODY_WORDS + 16]!);
  // The first tangent points along the incoming slip, so the second component of the right side is zero.
  const opposing = (shift: number): readonly [number, number] => {
    const ratio = xy / (inverse + yy + shift); // float division: eliminate the second tangent component
    // The angular Schur term is nonnegative. Keep the translational mass separate from its roundoff.
    const primary = -speed / (inverse + shift + Math.max(0, xx - xy * ratio)); // float division: Schur complement
    return [primary, -ratio * primary];
  };
  let [along, across] = opposing(0);
  if (hypot(along, across) > limit) {
    // The constrained minimum has (W + lambda I) q = -v and |q| = limit. Its norm decreases with lambda.
    let low = 0;
    let high = speed / limit; // float division: positive semidefinite W bounds the norm by speed / lambda
    if (!Number.isFinite(high)) return scale(first, -limit);
    [along, across] = opposing(high);
    for (let i = 0; i < 52; i++) {
      const middle = low + 0.5 * (high - low);
      const [candidateAlong, candidateAcross] = opposing(middle);
      if (hypot(candidateAlong, candidateAcross) > limit) {
        low = middle;
      } else {
        high = middle;
        along = candidateAlong;
        across = candidateAcross;
      }
    }
  }
  return add(scale(first, along), scale(second, across));
}

function fixedAnchor(support: CrushSupport, cell: Cell, size: number | undefined): CrushVector {
  return add(support.point, cellOffset(support.cell ?? ZERO, cell, size));
}

function cellOffset(from: Cell, to: Cell, size: number | undefined): CrushVector {
  const difference = sub(from, to);
  if (!size && difference.some((value) => value !== 0))
    throw new MargoError(
      'state',
      'Set the world cell size when a crush support surface is in a different cell from the rigid bodies.',
    );
  return scale(difference, size ?? 0);
}

function preparedSupport(support: CrushSupport, body: number, capacity: number): CrushSupport {
  const other = support.body === undefined ? undefined : rowIndex(support.body, capacity);
  if (other === body) throw new MargoError('state', 'Choose opposing crush contacts on distinct rigid body rows.');
  const cell = support.cell && vector(support.cell, 'barrier cell');
  if (cell && !cell.every(Number.isSafeInteger))
    throw new MargoError('state', 'Use a crush barrier cell as three safe integer coordinates.');
  return { body: other, point: vector(support.point, 'support anchor'), cell };
}

function supportImpulse(depth: number, closing: number, inverseMass: number, stiffness: number, dt: number): number {
  if (depth === 0 && closing <= 0) return 0;
  const damping = 2 * Math.sqrt(stiffness / inverseMass); // float division: critical damping of the relative mass
  const rate = damping + dt * stiffness;
  // Backward Euler with end penetration d + h(v - Jw) and end inward speed v - Jw.
  const impulse = Math.max(0, (dt * (stiffness * depth + rate * closing)) / (1 + dt * rate * inverseMass)); // float division
  if (!Number.isFinite(impulse))
    throw new MargoError('state', 'Choose representable crush support stiffness, mass and compression.');
  return impulse;
}

function recordCompression(
  damage: Float64Array,
  at: number,
  step: CompressionStep,
  sealStroke: number,
  continuing: boolean,
): void {
  damage[at] = step.permanentStroke;
  damage[at + 1]! += step.absorbedEnergy;
  damage[at + 2] = Math.max(continuing ? damage[at + 2]! : 0, step.totalStroke);
  damage[at + 3] = Math.max(continuing ? damage[at + 3]! : 0, step.force);
  damage[at + 4] = (continuing ? damage[at + 4]! : 0) + step.impulse;
  damage[at + 5] = Math.max(continuing ? damage[at + 5]! : 0, step.elasticEnergy);
  damage[at + CRUSH_SEAL_LOSS_WORD] = Math.min(1, step.permanentStroke / sealStroke); // float division: normalised damage
  if (!continuing) damage[at + 7]! += 1;
}

function pushPair(
  bodies: Float32Array,
  out: Float64Array,
  body: number,
  other: number | undefined,
  contact: CrushVector,
  normal: CrushVector,
  a: AtContact,
  b: AtContact | undefined,
  normalImpulse: number,
  friction: number,
): void {
  const impulse = scale(normal, normalImpulse);
  impulseAt(out, body, scale(impulse, -1), a.arm);
  if (b && other !== undefined) impulseAt(out, other, impulse, b.arm);
  if (friction > 0) {
    const slide = frictionImpulse(
      bodies,
      body,
      atContact(bodies, out, body, contact, normal),
      other,
      other === undefined ? undefined : atContact(bodies, out, other, contact, normal),
      normal,
      friction * normalImpulse,
    );
    impulseAt(out, body, slide, a.arm);
    if (b && other !== undefined) impulseAt(out, other, scale(slide, -1), b.arm);
  }
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
  plateStrokes: Float64Array | undefined,
  dt: number,
  terrain: Bed | undefined,
): void {
  const { body } = patch;
  const support = 'support' in patch ? patch.support : undefined;
  const otherBody = support?.body;
  const rotate = rotation(bodies, body);
  const facing = rotate(patch.normal);
  const anchor = add(triple(bodies, body * BODY_WORDS), rotate(patch.anchor));
  const at = CRUSH_WORDS * index;
  const permanent = damage[at]!;
  const membrane = 'indentation' in patch;
  if (membrane && damage[at + CRUSH_SEAL_LOSS_WORD] === 1) return;
  if (patch.plate && plateStrokes) plateStrokes[index] = permanent;
  const ground =
    terrain && !support
      ? traceGround(
          terrain,
          add(anchor, cellOffset(port.cell, terrain.cell, state.cellSize)),
          atContact(bodies, out, body, anchor, facing).velocity,
          facing,
          permanent,
          dt,
        )
      : undefined;
  if (!support && !ground) {
    latched[index] = 0;
    return;
  }
  const other = support
    ? otherBody === undefined
      ? fixedAnchor(support, port.cell, state.cellSize)
      : add(triple(bodies, otherBody * BODY_WORDS), rotation(bodies, otherBody)(support.point))
    : undefined;
  const separation = other && sub(other, anchor);
  const normal = ground?.normal ?? facing;
  const gap = ground?.gap ?? dot(separation!, normal);
  const clearance = gap + permanent;
  const continuous = !membrane && patch.response === 'continuous';
  if (!continuous && clearance > 0) latched[index] = 0;
  const contact = add(anchor, scale(normal, ground ? gap : 0.5 * gap));
  const a = atContact(bodies, out, body, contact, normal);
  const b = otherBody === undefined ? undefined : atContact(bodies, out, otherBody, contact, normal);
  const relative = sub(a.velocity, b?.velocity ?? ZERO);
  const closing = dot(relative, normal);
  const inverse = a.inverseMass + (b?.inverseMass ?? 0);
  if (!(inverse > 0)) return;
  if (continuous) {
    if (clearance > 0 && clearance >= dt * closing) {
      latched[index] = 0;
      return;
    }
  } else if (!latched[index] && (!(closing > 0) || clearance > dt * closing)) return;
  const delay = ground?.delay ?? (clearance > 0 ? clearance / closing : 0); // float division: first normal contact
  if (separation && 'radius' in patch) {
    const lateral = sub(separation, scale(normal, gap));
    const travel = sub(relative, scale(normal, closing));
    const offset = sub(lateral, scale(travel, delay));
    if (dot(offset, offset) > patch.radius * patch.radius) {
      latched[index] = 0;
      return;
    }
  }
  if (membrane) {
    // The intact dent supports its prior loading force. Relative motion beyond
    // that reaction can do more irreversible work or reach the first rupture.
    const previous = damage[at + 1]!;
    let held = 0;
    if (latched[index] && closing > 0) {
      const force = patch.indentation.read(permanent).force!;
      const stop = closing / inverse; // float division: need no rebound from a rigid-plastic support
      held = Math.min(dt * force, stop);
    }
    const turn = indentByImpulse(patch.indentation, previous, closing - inverse * held, inverse);
    const reaction = held + (turn?.impulse ?? 0);
    if (reaction > 0) pushPair(bodies, out, body, otherBody, contact, normal, a, b, reaction, patch.friction);
    if (turn) {
      damage.set(
        [
          turn.stroke,
          turn.work,
          turn.stroke,
          turn.force,
          (latched[index] ? damage[at + 4]! : 0) + reaction,
          0,
          turn.fractured ? 1 : 0,
          damage[at + 7]! + (latched[index] ? 0 : 1),
        ],
        at,
      );
      latched[index] = 1;
    }
    return;
  }
  const step = continuous
    ? stepCompression(patch.material, permanent, Math.max(permanent, -gap), closing, inverse, dt - delay)
    : undefined;
  const result =
    continuous || latched[index] ? undefined : crushPrepared(patch.material, 1 / inverse, closing, permanent); // float division
  const normalImpulse = continuous
    ? (step?.impulse ?? 0)
    : (result?.impulse ?? supportImpulse(-clearance, closing, inverse, patch.material.backingStiffness, dt));
  if (normalImpulse === 0) return;
  pushPair(bodies, out, body, otherBody, contact, normal, a, b, normalImpulse, patch.friction);
  if (step) {
    recordCompression(damage, at, step, patch.sealStroke, latched[index] !== 0);
    if (patch.plate && plateStrokes) plateStrokes[index] = step.totalStroke;
    latched[index] = 1;
  }
  if (!result) return;
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

/** Ductile crush with normal and dry friction feedback to RigidSolver and a durable damage ledger. */
export class CrushSolver implements Solver<CrushParams> {
  readonly id: string;
  readonly damageField: FieldDescriptor;
  private readonly terrain: BedShape | undefined;
  private state: State | undefined;

  constructor({ id = 'crush', terrain }: CrushOptions = {}) {
    this.id = id;
    if (terrain) {
      bedVertexCount(terrain);
      this.terrain = { ...terrain, centre: [terrain.centre[0], terrain.centre[1]] };
    }
    this.damageField = {
      name: `${id}:damage`,
      kind: 'surfaceSampleSet',
      quantity: CRUSH_DAMAGE_QUANTITY,
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
        ...(this.terrain ? [{ field: BED_FIELD, access: 'read' as const }] : []),
      ],
    };
  }

  init(host: SolverHost, params: CrushParams): void {
    const capacity = params.bodyCapacity;
    if (
      !Number.isSafeInteger(capacity) ||
      capacity < 1 ||
      !(params.patches?.length || params.groundPatches?.length || params.indentationPatches?.length)
    )
      throw new MargoError(
        'state',
        'Choose the RigidSolver body capacity and provide at least one crush contact patch.',
      );
    const all: PatchInput[] = [
      ...(params.patches ?? []),
      ...(params.groundPatches ?? []).map((patch) => ({ ...patch, terrain: true as const })),
    ];
    const patches = all.map((patch): Patch => {
      const material = crushMaterial(patch.material);
      const response = patch.response ?? 'impact';
      if (response !== 'impact' && response !== 'continuous')
        throw new MargoError('state', 'Choose impact or continuous for the crush patch response.');
      const plate = patch.plate && { ...patch.plate };
      if (plate) {
        if (response !== 'continuous')
          throw new MargoError('state', 'Use a continuous crush patch response to sample the live plate shape.');
        resolvePlateBuckling(plate, 0);
      }
      const body = rowIndex(patch.body, capacity);
      const normal = vector(patch.normal, 'normal');
      const length = positive(hypot(...normal), 'normal length');
      const common = {
        body,
        material,
        response,
        plate,
        friction: positive(patch.friction ?? 0, 'friction coefficient', 0),
        normal: scale(normal, 1 / length), // float division: unit normal
        anchor: vector(patch.anchor, 'anchor'),
        sealStroke: positive(patch.sealStroke ?? material.stroke, 'seal stroke', Number.MIN_VALUE, material.stroke),
      };
      if ('terrain' in patch) {
        if (!this.terrain)
          throw new MargoError(
            'state',
            'Give CrushSolver the TerrainBed grid shape before configuring a ground patch.',
          );
        return { ...common, terrain: true };
      }
      return {
        ...common,
        radius: positive(patch.radius, 'contact radius'),
        support: preparedSupport(patch.support, body, capacity),
      };
    });
    for (const patch of params.indentationPatches ?? []) {
      const body = rowIndex(patch.body, capacity);
      const normal = vector(patch.normal, 'indentation normal');
      const length = positive(hypot(...normal), 'indentation normal length');
      patches.push({
        body,
        normal: scale(normal, 1 / length), // float division: unit normal
        anchor: vector(patch.anchor, 'indentation anchor'),
        radius: positive(patch.radius, 'indentation contact radius'),
        friction: positive(patch.friction ?? 0, 'indentation friction coefficient', 0),
        support: preparedSupport(patch.support, body, capacity),
        indentation: new CircularPlateIndentation(patch.indentation),
      });
    }
    this.state = {
      host,
      patches,
      capacity,
      cellSize: params.cellSize === undefined ? undefined : positive(params.cellSize, 'world cell width'),
      damage: host.allocate('crush-damage', patches.length * CRUSH_WORDS * F64, 'f64', CRUSH_LAYOUT),
      contacts: host.allocate('crush-contacts', patches.length, 'u8', CRUSH_LAYOUT),
      reactions: host.allocate('crush-reactions', capacity * IMPULSE_WORDS * F64, 'f64', IMPULSES_LAYOUT),
      plateStrokes: patches.some((patch) => patch.plate)
        ? host.allocate('crush-plate-strokes', patches.length * F64, 'f64', CRUSH_LAYOUT)
        : undefined,
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
    const terrainPort = this.terrain && context.inputs.get(BED_FIELD.name);
    if (this.terrain && !terrainPort)
      throw new MargoError('state', 'Add TerrainBed to the PhysicsWorld and couple it with the crush ground patches.');
    const terrain =
      terrainPort &&
      this.terrain &&
      bedFromPort(terrainPort.region.memory ?? state.host.memory, terrainPort, this.terrain);
    const damage = regionWords(state.host.memory, state.damage) as Float64Array;
    const contacts = regionWords(state.host.memory, state.contacts) as Uint8Array;
    const plateStrokes = state.plateStrokes && (regionWords(state.host.memory, state.plateStrokes) as Float64Array);
    for (let i = 0; i < state.patches.length; i++)
      impact(state, state.patches[i]!, i, port, bodies, out, damage, contacts, plateStrokes, dt, terrain);
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
    const { damage, contacts, plateStrokes } = this.requireState();
    return plateStrokes ? [damage, contacts, plateStrokes] : [damage, contacts];
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
      sealLoss: values[at + CRUSH_SEAL_LOSS_WORD]!,
      impacts: values[at + 7]!,
    };
  }

  /** Samples the current or unloaded residual shape in the linked plate's local coordinates. */
  readPlate(index: number, rest?: ArrayLike<number>): CrushPlateState {
    const { host, patches, plateStrokes, damage } = this.requireState();
    const plate = Number.isSafeInteger(index) ? patches[index]?.plate : undefined;
    if (!plate || !plateStrokes)
      throw new MargoError('state', 'Choose a configured continuous crush patch with a plate to sample its shape.');
    const stroke = (regionWords(host.memory, plateStrokes) as Float64Array)[index]!;
    const sealLoss = (regionWords(host.memory, damage) as Float64Array)[index * CRUSH_WORDS + CRUSH_SEAL_LOSS_WORD]!;
    return {
      stroke,
      sealLoss,
      buckling: stroke < plate.length ? resolvePlateBuckling(plate, stroke, rest) : undefined,
    };
  }

  /** Samples the permanent circular dent or the retained shape at the onset of rupture. */
  readIndentation(index: number, rest?: ArrayLike<number>): CircularPlateReading {
    const { host, patches, damage } = this.requireState();
    const patch = Number.isSafeInteger(index) ? patches[index] : undefined;
    if (!patch || !('indentation' in patch))
      throw new MargoError('state', 'Choose a configured circular indentation station to sample its dent.');
    const stroke = (regionWords(host.memory, damage) as Float64Array)[index * CRUSH_WORDS]!;
    return patch.indentation.read(stroke, rest);
  }

  private requireState(): State {
    if (!this.state)
      throw new MargoError('state', 'Add CrushSolver to a PhysicsWorld before calling its state methods.');
    return this.state;
  }
}
