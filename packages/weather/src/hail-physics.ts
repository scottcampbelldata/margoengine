import { STANDARD_GRAVITY } from '@margoengine/math/atmosphere';
import type { FallingSolver, FallingSphere } from '@margoengine/physics/falling';
import type { HailSource } from './hail.js';
import { HAIL_DENSITY, hailFallSpeed } from './precipitation.js';

/** A hailstone for the world solver. Metres, kg/m³ and m/s. */
export interface HailSphereOptions {
  /** Stone diameter in metres. */
  readonly diameter: number;
  /** Stone bulk density in (0, 917] kg/m³. Defaults to 900. */
  readonly density?: number;
  /** Initial centre in the solver's origin cell. Defaults to [0, 0, 0]. */
  readonly position?: FallingSphere['position'];
  /** Initial world velocity. Defaults to [0, 0, 0]. */
  readonly velocity?: FallingSphere['velocity'];
  /** Fraction of normal speed retained after a static collision. Defaults to 0.2. */
  readonly restitution?: number;
}

/** Converts the measured hail terminal law into an equivalent local quadratic drag for arbitrary initial velocities. */
export function hailSphere(options: HailSphereOptions): FallingSphere {
  const { diameter, density = HAIL_DENSITY, position, velocity, restitution = 0.2 } = options;
  if (!(Number.isFinite(diameter) && diameter > 0 && density > 0 && density <= 917))
    throw new RangeError('Invalid hailstone geometry. Pass a positive finite diameter and density in (0, 917] kg/m³.');
  const mass = (Math.PI * density * diameter * diameter * diameter) / 6;
  if (!(Number.isFinite(mass) && mass > 0))
    throw new RangeError(
      'Hailstone mass rounds outside its representable range. Pass a representable diameter and density.',
    );
  return {
    kind: 'sphere',
    diameter,
    mass,
    position,
    velocity,
    restitution,
    drag(air) {
      const gravity = air.gravity > 0 ? air.gravity : STANDARD_GRAVITY;
      if (air.density >= density)
        throw new RangeError('The hail drag law needs air lighter than the stone. Supply an atmospheric Wind.');
      const speed = hailFallSpeed(diameter, { density: air.density, temperature: air.temperature, gravity }, density);
      return (4 * diameter * (density - air.density) * gravity) / (3 * air.density * speed * speed);
    },
  };
}

/** Sends the falling solver's sphere poses to Hail's renderer, in stable draw order. */
export function hailFromFalling(
  solver: FallingSolver,
  offset: readonly [number, number, number] = [0, 0, 0],
): HailSource {
  return {
    get count() {
      return solver.sphereCount;
    },
    write(out) {
      solver.writeSpheres(out, offset);
    },
  };
}
