import type { FieldDescriptor } from '../world/solver.js';

interface ShallowBlockageBody {
  /** Record this rigid row on the reaction port. */
  readonly bodyRow: number;
  /** Initial centre x and z in metres in the water grid's origin cell. */
  readonly centre: readonly [number, number];
}

/** A translating vertical cylinder cutting the entire water column in a periodic flat channel. */
export interface ShallowMovingCylinder extends ShallowBlockageBody {
  /** Radius in metres, at most half the narrower grid spacing. */
  readonly radius: number;
}

/** A translating, full-depth vertical obstacle with a fixed convex horizontal outline. */
export interface ShallowMovingFootprint extends ShallowBlockageBody {
  /**
   * Perimeter vertices in order, in fixed world X/Z axes relative to the rigid centre (metres).
   * Either winding is accepted. The origin must lie strictly inside the footprint.
   * Each extent must fit its grid spacing and the area at most π/4 of the cell.
   */
  readonly footprint: ReadonlyArray<readonly [number, number]>;
}

export interface ShallowBlockageFields {
  /** Layout 1 f64: ticket, end x, end z, centre-of-mass elevation. Layout 2 appends rigid vx, vz and inverse mass. */
  readonly motion: FieldDescriptor;
  /** Layout 1 f64 record: accepted ticket, rigid row, world linear then angular impulse (N·s, N·m·s). */
  readonly reaction: FieldDescriptor;
}

export const SHALLOW_BLOCKAGE_LAYOUT = 1;
export const SHALLOW_BLOCKAGE_MOTION_WORDS = 4;
export const SHALLOW_BLOCKAGE_REACTION_WORDS = 8;
export const SHALLOW_RIGID_BLOCKAGE_LAYOUT = 2;
export const SHALLOW_RIGID_BLOCKAGE_MOTION_WORDS = 7;
