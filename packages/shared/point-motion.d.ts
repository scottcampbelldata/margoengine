import type { MutableVec3, Vec3 } from '@margoengine/math';

/** Optional SI point-mass settings for steering. Speeds and directions are relative to the local uniform medium. */
export interface SteeringMotion {
  /** Inertial mass, kg. Defaults to 1 kg. */
  readonly mass?: number;
  /** Quadratic drag coefficient times reference area times half the medium density, kg/m. Defaults to 0. */
  readonly dragFactor?: number;
  /** Velocity of the surrounding medium, m/s, on world axes. Defaults to [0, 0, 0]. */
  readonly fluidVelocity?: Vec3;
  /** Propulsive acceleration limit perpendicular to relative velocity, m/s². Defaults to unlimited. */
  readonly maxLateralAcceleration?: number;
  /** Smallest radius of a propulsive turn, m. Defaults to 0 (no limit). */
  readonly minimumTurnRadius?: number;
}

interface PointMotion {
  mass: number;
  dragRate: number;
  fluidVelocity: Vec3;
  maxLateralAcceleration: number;
  minimumTurnRadius: number;
}

/** Normalizes and validates point-mass settings before any state is written. */
export function pointMotion(options: SteeringMotion): PointMotion;

/** Integrates capped propulsive acceleration and then the exact quadratic drag flow over the step. */
export function pointVelocity(
  velocity: ArrayLike<number>,
  force: Vec3,
  dt: number,
  settings: PointMotion,
  maxSpeed: number,
  out: MutableVec3,
): MutableVec3;
