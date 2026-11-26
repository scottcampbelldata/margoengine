import { MargoError } from '@margoengine/math/errors';
import { regionWords } from '../world/memory.js';
import type { FieldDescriptor, Port } from '../world/solver.js';
import { cross, type CrushVector } from './rigid-contact.js';

export const WET_INERTIA_LAYOUT = 1;
export const WET_INERTIA_WORDS = 73;
export const WET_IMPULSE_WORDS = 6;

/** Paired fields for instantaneous wet contact response and its rigid accumulator receipt. */
export interface CrushInertiaChannel {
  readonly mobility: FieldDescriptor;
  readonly receipt: FieldDescriptor;
}

/** Creates the descriptors shared by the corresponding CrushSolver and HullSolver. */
export function crushInertiaChannel(id = 'wet-crush'): CrushInertiaChannel {
  return {
    mobility: {
      name: `${id}:mobility`,
      kind: 'bodySet',
      centring: 'particle',
      quantity: 'effectiveRigidMobility',
      unit: 'SI',
    },
    receipt: {
      name: `${id}:receipt`,
      kind: 'bodySet',
      centring: 'particle',
      quantity: 'mappedRigidImpulse',
      unit: 'N s, N m s',
    },
  };
}

export function wetInertiaWords(memory: WebAssembly.Memory, port: Port, rows: number, cols: number): Float64Array {
  const region = port.region;
  if (region.type !== 'f64' || region.layout !== WET_INERTIA_LAYOUT || region.byteLength !== rows * cols * 8)
    throw new MargoError('state', 'Use the layout-1 effective inertia coupling and matching rigid body capacity.');
  return regionWords(region.memory ?? memory, region) as Float64Array;
}

type Six = readonly [number, number, number, number, number, number];

export interface WetContactStep {
  readonly mobility: Float64Array;
  readonly receipt: Float64Array;
}

export function wetRow(step: WetContactStep | undefined, body: number): boolean {
  return step?.mobility[body * WET_INERTIA_WORDS] === 1;
}

function generalized(arm: CrushVector, direction: CrushVector): Six {
  return [...direction, ...cross(arm, direction)];
}

/** Bilinear point mobility of one wet body, in any two linear directions. */
export function wetPoint(
  step: WetContactStep,
  body: number,
  arm: CrushVector,
  first: CrushVector,
  second: CrushVector,
): number {
  const at = body * WET_INERTIA_WORDS + 1;
  const x = generalized(arm, first);
  const y = generalized(arm, second);
  let value = 0;
  for (let i = 0; i < 6; i++) {
    let response = 0;
    for (let j = 0; j < 6; j++) response += step.mobility[at + 6 * i + j]! * y[j]!;
    value += x[i]! * response;
  }
  return value;
}

/** Sends M (M+A)^-1 times the physical impulse to the rigid integrator and receipts that amount. */
export function wetPush(
  step: WetContactStep,
  out: Float64Array,
  body: number,
  arm: CrushVector,
  impulse: CrushVector,
): void {
  const at = body * WET_INERTIA_WORDS + 37;
  const input = generalized(arm, impulse);
  for (let i = 0; i < 6; i++) {
    let value = 0;
    for (let j = 0; j < 6; j++) value += step.mobility[at + 6 * i + j]! * input[j]!;
    out[body * WET_IMPULSE_WORDS + i]! += value;
    step.receipt[body * WET_IMPULSE_WORDS + i]! += value;
  }
}
