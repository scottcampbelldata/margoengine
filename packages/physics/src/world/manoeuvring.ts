// Which hulls a manoeuvring model owns the horizontal-plane loads of. A ship solver (SEA-09) carries its hull's surge, sway
// and yaw by captive-test derivatives that already hold the water's damping (and, unless told otherwise, its added mass);
// a seakeeping hull solver (SEA-08) on the same body then leaves its own of those out, so each component has one owner.
import type { FieldDescriptor } from './solver.js';

/**
 * `manoeuvringClaims`: one f64 word a body row, the sum of the flags of what a manoeuvring model owns on that hull: 0
 * nothing, {@link CLAIM_DAMPING} its surge, sway and yaw damping, {@link CLAIM_ADDED_MASS} its surge, sway and yaw added
 * mass. A hull solver leaves the claimed force components out (the rows of surge, sway and yaw: their damping, and their
 * rows and columns of the added mass).
 */
export const MANOEUVRING_CLAIMS_FIELD: FieldDescriptor = {
  name: 'manoeuvringClaims',
  kind: 'bodySet',
  quantity: 'claim',
  unit: '1',
  centring: 'particle',
};
/** The flag of a claim on a hull's surge, sway and yaw damping. */
export const CLAIM_DAMPING = 1;
/** The flag of a claim on a hull's surge, sway and yaw added mass. */
export const CLAIM_ADDED_MASS = 2;
