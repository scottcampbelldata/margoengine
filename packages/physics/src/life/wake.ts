import type { FieldDescriptor } from '../world/solver.js';

/** Layout of the swimming wake port. Two f64 rows per body, tail then pectoral fins, ordered by body index. */
export const SWIM_WAKE_LAYOUT = 1;
/** A water-side momentum source. Each row contains [x,y,z, ix,iy,iz, radius, wetFraction]. */
export const SWIM_WAKE_FIELD: FieldDescriptor = Object.freeze({
  name: 'swimWakeImpulse',
  kind: 'particleSet',
  centring: 'particle',
  quantity: 'position, linear impulse, smoothing radius and wetted fraction',
  unit: 'm, N s, m, 1',
});

export const SWIM_WAKE_WORDS = 8;
