// The sea-surface contract of the physics framework (docs/physics-framework.md, section 4; SEA-02, PA-11): the water's
// surface and the water's motion below it, from a pure synchronous query. The sea's surface solver owns it; hulls,
// floating bodies, swimmers, kelp, divers, sand and spray read it, and bodies hand back what they push into it. Types only:
// this entry has no code, so importing it costs nothing.
import type { FlowCell, FlowField } from './wind.js';

/** The surface of the water at a place and a time, in SI units on the world axes (y up). */
export interface SeaSurfaceSample {
  /** Height of the surface, m, above the still-water level. */
  height: number;
  /** Unit normal of the surface, pointing up out of the water. */
  normal: [number, number, number];
  /** Velocity of the water at the surface, m/s: the waves' orbital motion plus the current. */
  velocity: [number, number, number];
  /** The current alone (tide, river, wind drift), m/s, the part of `velocity` that is not the waves'. */
  current: [number, number, number];
  /** Still-water depth, m (Infinity for deep water; 0 or less on land). */
  depth: number;
  /** Density of the water, kg/m^3 (about 1000 fresh, 1025 sea). */
  density: number;
}

/**
 * The water below the surface: a flow field of water. `sample(x, y, z, t)` gives the water's velocity at depth (the waves'
 * orbital motion, which falls off with depth, plus the current) and its density; above the surface there is no water, and
 * the sample's density is 0 with a zero velocity.
 */
export interface SeaWater extends FlowField {
  readonly medium: 'water';
}

/**
 * Something a body pushes into the sea at a tick: a pressure patch or a volume it displaces, which the surface solver
 * turns into waves (a hull's bow wave and wake, a splash). Accumulated from every body in canonical order.
 */
export interface SeaSource {
  /** Where, m from the field's cell, on the still-water plane. */
  readonly x: number;
  readonly z: number;
  /** Radius of the patch, m. */
  readonly radius: number;
  /** Pressure on the surface, Pa (a hull's weight over its waterplane, a gust). */
  readonly pressure: number;
  /** Volume the body pushes into the water this tick, m^3 (negative as it leaves). */
  readonly volume: number;
}

/**
 * The sea: its surface and the water below it, sampled anywhere on the world clock. `sample` is pure: the same place and
 * time give the same answer, in any order and on any thread, so a hull, a fish and the drawn water agree.
 */
export interface SeaSurface {
  /** The origin cell `sample`'s coordinates are offsets from. */
  readonly cell: FlowCell;
  /** The surface at (x, z) m from the field's cell at time `t` s. Writes into `out` when given and returns it. */
  sample(x: number, z: number, t: number, out?: SeaSurfaceSample): SeaSurfaceSample;
  /** The water below the surface, with the same waves and current. */
  readonly water: SeaWater;
  /** Density of this body of water, kg/m^3 (about 1000 for a lake or river, 1025 for the sea). */
  readonly density: number;
  /** Height of the surface at (x, z) at time `t`, m: `sample(x, z, t).height` without the rest, for hulls that ask often. */
  elevation(x: number, z: number, t: number): number;
  /**
   * Gauge pressure of the water at (x, y, z) at time `t`, Pa: hydrostatic plus the waves' dynamic pressure, 0 at the
   * surface and above it.
   */
  pressure(x: number, y: number, z: number, t: number): number;
}
