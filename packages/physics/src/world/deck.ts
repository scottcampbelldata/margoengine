// The deck's ports (green water on a hull's deck): where the sea comes over a hull's bulwark, and which hulls a
// grid-particle deck volume owns. The hull's exceedance solver (SEA-08) writes `deckInflow`, the liquid (FLUID-03)
// writes `deckClaims`; each reads the other's. Body frame, SI units.
import type { FieldDescriptor } from './solver.js';

/**
 * `deckInflow`: the sea coming over the bulwarks, one record a bulwark segment, DECK_INFLOW_WORDS f64 words each: the
 * hull's body row; the segment's ends a and b (x, y, z each, m, in the body's frame); its inward normal (unit, body
 * frame); the inflow's height over the segment h (m); its velocity u (x, y, z, m/s, body frame); its volume flux q
 * (m^3/s, 0 or more); the tick it is for. The records follow a count word.
 */
export const DECK_INFLOW_FIELD: FieldDescriptor = {
  name: 'deckInflow',
  kind: 'surfaceSampleSet',
  quantity: 'inflow',
  unit: 'm, m/s, m^3/s',
  centring: 'particle',
};
/** f64 words of a `deckInflow` record. */
export const DECK_INFLOW_WORDS = 16;

/**
 * `deckClaims`: one f64 word a body row, 1 where a grid-particle deck volume owns that hull's on-deck water and its load
 * (the exceedance solver then leaves its own deck load out), 0 elsewhere.
 */
export const DECK_CLAIMS_FIELD: FieldDescriptor = {
  name: 'deckClaims',
  kind: 'bodySet',
  quantity: 'claim',
  unit: '1',
  centring: 'particle',
};
