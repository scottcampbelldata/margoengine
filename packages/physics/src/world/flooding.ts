// The breaches' port (flooding, SEA-10): what leaves a damaged hull through each opening to the outside, for the solvers
// that draw it, the tracers (the cargo carried out, SEA-15) and the foam and bubbles (the air vented, SEA-13). The hull
// solver writes `hullBreaches`; world frame, SI units.
import type { FieldDescriptor } from './solver.js';

/**
 * `hullBreaches`: one record an opening to the outside of a flooding hull, HULL_BREACH_WORDS f64 words each, after a count
 * word: the hull's body row; the opening's index among the hull's openings; its centre (x, y, z, m, world); its outward
 * normal (unit, world); its open area (m^2, 0 while shut); the water through it (m^3/s, out positive); the air through it
 * (kg/s, out positive) and that air's volume at the atmosphere's pressure (m^3/s); the cargo carried out (kg/s); the
 * cargo's code (an index into BREACH_CARGO); the depth of its centre under the sea's surface (m, negative above it); the
 * tick it is for.
 */
export const HULL_BREACHES_FIELD: FieldDescriptor = {
  name: 'hullBreaches',
  kind: 'surfaceSampleSet',
  quantity: 'outflow',
  unit: 'm, m^2, m^3/s, kg/s',
  centring: 'particle',
};
/** f64 words of a `hullBreaches` record. */
export const HULL_BREACH_WORDS = 16;

/** The cargoes a hold can carry, by code: the names of the tracers' materials (`TRACER_MATERIALS`), 'none' first. */
export const BREACH_CARGO = ['none', 'dye', 'silt', 'sand', 'ironOre', 'coal', 'grain', 'oil'] as const;
/** A cargo a hold can carry. */
export type BreachCargo = (typeof BREACH_CARGO)[number];
