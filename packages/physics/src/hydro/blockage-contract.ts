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
   * Each extent must fit its grid spacing. Small fluid volumes merge with an open neighbour.
   */
  readonly footprint: ReadonlyArray<readonly [number, number]>;
}

/**
 * The two fields of a shallow-water blockage: the motion the water reads and the reaction impulse it hands back.
 */
export interface ShallowBlockageFields {
  /** Layout 1 f64: ticket, end x, end z, centre-of-mass elevation. Layout 2 appends rigid vx, vz and inverse mass. */
  readonly motion: FieldDescriptor;
  /** Layout 1 f64 record: accepted ticket, rigid row, world linear then angular impulse (N·s, N·m·s). */
  readonly reaction: FieldDescriptor;
}

/** Layout version 1 of the shallow-water blockage fields. */
export const SHALLOW_BLOCKAGE_LAYOUT = 1;
/** f64 words in a layout-1 blockage motion record: ticket, end x, end z, centre-of-mass elevation. */
export const SHALLOW_BLOCKAGE_MOTION_WORDS = 4;
/**
 * f64 words in a layout-1 blockage reaction record: accepted ticket, rigid row, world linear impulse and world
 * angular impulse.
 */
export const SHALLOW_BLOCKAGE_REACTION_WORDS = 8;
/**
 * Layout version 2 of the shallow-water blockage fields, which add the rigid body's velocity and inverse mass.
 */
export const SHALLOW_RIGID_BLOCKAGE_LAYOUT = 2;
/** f64 words in a layout-2 blockage motion record: the layout-1 words plus rigid vx, vz and inverse mass. */
export const SHALLOW_RIGID_BLOCKAGE_MOTION_WORDS = 7;
