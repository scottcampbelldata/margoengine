import { MargoError } from '@margoengine/math/errors';
import { regionWords } from '../world/memory.js';
import type { FieldDescriptor, Port } from '../world/solver.js';

export const ENTRY_CAVITY_WORDS = 4;
export const ENTRY_CAVITY_LAYOUT = 1;

/** An activity flag and direction of motion through the water, at each rigid-body row. */
export function entryCavityField(id: string): FieldDescriptor {
  return Object.freeze({
    name: id + '.cavityPressure',
    kind: 'bodySet',
    centring: 'particle',
    quantity: 'entryCavityPlane',
    unit: '1',
  });
}

export function isEntryCavityField(field: FieldDescriptor): boolean {
  return field.kind === 'bodySet' && field.centring === 'particle' && field.quantity === 'entryCavityPlane' && field.unit === '1';
}

export function entryCavityRows(memory: WebAssembly.Memory, port: Port, capacity: number): Float64Array {
  const region = port.region;
  if (
    region.type !== 'f64' ||
    region.layout !== ENTRY_CAVITY_LAYOUT ||
    region.byteLength !== capacity * ENTRY_CAVITY_WORDS * Float64Array.BYTES_PER_ELEMENT
  )
    throw new MargoError('state', 'Connect the layout-1 EntrySolver cavity field with the same rigid capacity as HullSolver.');
  return regionWords(region.memory ?? memory, region) as Float64Array;
}
