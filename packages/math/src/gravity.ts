// The one gravity of the engine (docs/physics-framework.md, section 4, the gravity field; docs/physics-audit.md, PA-08).
// Every solver and shader that needs gravity takes it from here, or from the world that holds it, instead of writing its
// own 9.81 or 9.80665, so a world with the Moon's gravity changes the waves, the spray, the floods and the hail as it
// changes the bodies.
//
// The default is 9.81 m/s^2 down the y axis: the physics kernel's default, which the replay goldens and the
// tests of every solver already hold. Standard gravity is 9.80665 m/s^2 (3rd CGPM, 1901, declaration on the unit of mass
// and the definition of weight); the two differ by 0.03 percent, under what any shot can show, and one value matters more
// than which one.

/** A gravity vector in m/s^2, world axes, `[x, y, z]`. */
export type Gravity = readonly [number, number, number];

/** Standard gravity, m/s^2 (3rd CGPM, 1901): for units (a weight in newtons from kilograms-force, say), not the default. */
export const STANDARD_GRAVITY = 9.80665;

/** The engine's gravity: 9.81 m/s^2 down the y axis, frozen. Pass it, or a world's own, to every solver and shader. */
export const DEFAULT_GRAVITY: Gravity = Object.freeze([0, -9.81, 0] as const);

/**
 * `gravity` checked: three finite numbers, returned as a new frozen vector.
 * @throws TypeError for anything that is not three numbers; RangeError for a component that is not finite.
 */
export function checkGravity(gravity: ArrayLike<number>, name = 'Gravity'): Gravity {
  if (!gravity || typeof gravity !== 'object' || gravity.length !== 3)
    throw new TypeError(`${name} must be [x, y, z] in m/s^2.`);
  const [x, y, z] = [gravity[0], gravity[1], gravity[2]];
  for (const v of [x, y, z]) {
    if (typeof v !== 'number') throw new TypeError(`${name} must be [x, y, z] in m/s^2.`);
    if (!Number.isFinite(v)) throw new RangeError(`${name} must be finite; got [${x}, ${y}, ${z}].`);
  }
  return Object.freeze([x as number, y as number, z as number] as const);
}

/** The strength of `gravity`, m/s^2: 9.81 for the default. */
export function gravityMagnitude(gravity: Gravity = DEFAULT_GRAVITY): number {
  return Math.sqrt(gravity[0] * gravity[0] + gravity[1] * gravity[1] + gravity[2] * gravity[2]);
}

/** The unit vector gravity pulls along (`[0, -1, 0]` for the default), and `[0, 0, 0]` for no gravity. */
export function gravityDown(gravity: Gravity = DEFAULT_GRAVITY): [number, number, number] {
  const g = gravityMagnitude(gravity);
  return g > 0 ? [gravity[0] / g, gravity[1] / g, gravity[2] / g] : [0, 0, 0];
}

/**
 * `gravity` as the four floats of a WGSL `vec4<f32>` uniform: x, y, z and the strength, so a shader reads both without a
 * `length` of its own. Written into `out` at `offset` (a new array of 4 by default), rounded once to f32 on the CPU, as the
 * framework's rule for per-tick inputs to GPU solvers asks (section 2).
 */
export function gravityUniform(
  gravity: Gravity = DEFAULT_GRAVITY,
  out: Float32Array = new Float32Array(4),
  offset = 0,
): Float32Array {
  out[offset] = gravity[0];
  out[offset + 1] = gravity[1];
  out[offset + 2] = gravity[2];
  out[offset + 3] = gravityMagnitude(gravity);
  return out;
}
