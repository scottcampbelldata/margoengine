/** What moves, for {@link advance}. `C` is the collider type the motion measures against. */
export interface SweptMotion<C> {
  /** Moving shapes. */
  count: number;
  /** The most any point of each shape moves per unit of time. */
  speed: Float64Array;
  /** Puts the shapes at time `t`. */
  place(t: number): void;
  /** Signed gap of one shape to one collider. */
  gap(shape: number, volume: C): number;
  /** Pairs of shapes that may not meet, two per pair, and their gap. */
  pairs?: Int32Array;
  pairGap?(a: number, b: number): number;
}

/** What a swept check found; each field is documented on the SweepResult of kinematics-constraints. */
export interface SweptAdvanceResult {
  clear: boolean;
  exhausted: boolean;
  time: number;
  clearance: number;
  steps: number;
  shape: number;
  collider: number;
}

/** The settings of every swept check, with their defaults, checked. */
export function sweepSettings(
  options: { minClearance?: number; tolerance?: number; maxSteps?: number } | undefined,
): { minClearance: number; tolerance: number; maxSteps: number };

/** Steps `motion` from time 0 to 1 against still colliders, never past a contact. */
export function advance<C>(
  motion: SweptMotion<C>,
  colliders: readonly C[],
  minClearance: number,
  tolerance: number,
  maxSteps: number,
): SweptAdvanceResult;
