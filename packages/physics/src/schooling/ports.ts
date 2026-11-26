import type { FieldDescriptor } from '../world/solver.js';

/** Layout version of the school ports. Kinematics rows are six f64 words. Intent rows are three f64 words. */
export const SCHOOL_LAYOUT = 1;
/** School member input for an intent-only solver. Rows are x, y, z, vx, vy, vz in the writer's cell. */
export const SCHOOL_KINEMATICS_FIELD: FieldDescriptor = Object.freeze({
  name: 'schoolKinematics',
  kind: 'particleSet',
  centring: 'particle',
  quantity: 'position and linear velocity',
  unit: 'm, m/s',
});
/** Predators: rows are x, y, z, vx, vy, vz in the writer's cell. */
export const SCHOOL_PREDATORS_FIELD: FieldDescriptor = Object.freeze({
  ...SCHOOL_KINEMATICS_FIELD,
  name: 'schoolPredators',
});
/** Desired medium-relative velocity, three f64 words per member in input row order. */
export const SCHOOL_INTENT_FIELD: FieldDescriptor = Object.freeze({
  name: 'schoolIntent',
  kind: 'particleSet',
  centring: 'particle',
  quantity: 'velocity',
  unit: 'm/s',
});
