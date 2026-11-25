// The follow-target contract of the physics framework (docs/physics-framework.md, section 4, "follow targets"): the pose,
// velocity and acceleration of anything a camera can follow, interpolated to the frame's time on the world clock and given
// in a large-world origin cell, so a following camera never jitters against the simulation. Moving solvers publish their
// targets; cameras read them. Types only.

/** A thing a camera can follow, at one frame's time, in SI units. Positions are offsets from `cell`. */
export interface FollowTarget {
  /** The target's id, stable within its solver (a body, a vehicle, a bird). */
  readonly id: string;
  /** The id of the solver that moves it. */
  readonly solver: string;
  /** The integer origin cell its position is an offset from. */
  readonly cell: readonly [number, number, number];
  /** Position from the cell's origin, m. */
  readonly position: readonly [number, number, number];
  /** Orientation as a unit quaternion [x, y, z, w]. */
  readonly rotation: readonly [number, number, number, number];
  /** Velocity, m/s. */
  readonly velocity: readonly [number, number, number];
  /** Acceleration, m/s^2, for a camera that eases. */
  readonly acceleration: readonly [number, number, number];
  /** Angular velocity, rad/s. */
  readonly angularVelocity: readonly [number, number, number];
}

/** Where follow targets come from: a world, asked at a frame of its film. */
export interface FollowSource {
  /** Every target at frame `frame` (plus `part`, a ratio p/q of the next frame, for motion blur), in solver then id order. */
  targets(frame: number, part?: readonly [number, number]): readonly FollowTarget[];
}
