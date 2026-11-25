// The wind contract of the physics framework (docs/physics-framework.md, section 4, "wind"): air velocity, density and
// temperature anywhere, at any time on the world clock, from a pure synchronous query. The atmosphere owns it; sails,
// trees, birds, smoke, rain and the sea read it. Types only: this entry has no code, so importing it costs nothing.
//
// The same shape serves air and water (`FlowField`), so whatever responds to flow takes either: a tree in the wind and kelp
// in a current read the same interface, each with its medium's density.

/** An integer origin cell of a large world (docs/physics-framework.md, section 2): three whole numbers. */
export type FlowCell = readonly [number, number, number];

/** What a flow field gives at a point and a time, in SI units. */
export interface FlowSample {
  /** Velocity of the medium, m/s, on the world axes (y up). */
  velocity: [number, number, number];
  /** Density of the medium, kg/m^3. */
  density: number;
  /** Temperature of the medium, K. */
  temperature: number;
}

/**
 * A flow of air or water that can be sampled anywhere. `sample` is pure: the same point and time give the same answer, in
 * any order and on any thread, so a solver samples it at its own rate and a replay sees the same flow.
 */
export interface FlowField {
  /** What flows. */
  readonly medium: 'air' | 'water';
  /** The origin cell `sample`'s coordinates are offsets from; a reader in another cell converts through the cell difference. */
  readonly cell: FlowCell;
  /**
   * The flow at (x, y, z) metres from the field's cell, at time `t` seconds on the world clock. Writes into `out` when
   * given (no allocation) and returns it.
   */
  sample(x: number, y: number, z: number, t: number, out?: FlowSample): FlowSample;
}

/** The wind: a flow field of air. */
export interface Wind extends FlowField {
  readonly medium: 'air';
}
