import { STANDARD_GRAVITY } from '@margoengine/math/atmosphere';
import type { FallingSphere } from '@margoengine/physics/falling';
import { precipitationError } from './precipitation-errors.js';
import { rainFallSpeed, WATER_DENSITY } from './precipitation.js';

/** A liquid drop’s volume-equivalent sphere and initial state in the falling solver’s origin cell. */
export interface RainSphereOptions {
  /** Volume-equivalent diameter, m. */
  readonly diameter: number;
  /** Initial centre, m. Defaults to the origin. */
  readonly position?: FallingSphere['position'];
  /** Initial world velocity, m/s. Defaults to rest. */
  readonly velocity?: FallingSphere['velocity'];
  /** Fraction of normal impact speed retained against a static boundary. Defaults to 0. */
  readonly restitution?: number;
}

/** Build a size-resolved liquid drop for the optional K23 FallingSolver. */
export function rainSphere(options: RainSphereOptions): FallingSphere {
  if (!options || typeof options !== 'object')
    throw precipitationError('A rain sphere needs a diameter in metres; pass {diameter}.');
  const { diameter, position, velocity, restitution = 0 } = options;
  if (!(diameter > 0 && Number.isFinite(diameter)))
    throw precipitationError('Choose a finite positive volume-equivalent rain diameter in metres.');
  for (const word of [position, velocity])
    if (word !== undefined && !(word?.length === 3 && word.every(Number.isFinite)))
      throw precipitationError('Use finite three-component rain positions and velocities in SI units.');
  if (!(restitution >= 0 && restitution <= 1)) throw precipitationError('Choose a rain restitution between 0 and 1.');
  const radius = diameter / 2;
  const area = Math.PI * radius * radius;
  const volume = (4 * area * radius) / 3;
  const mass = WATER_DENSITY * volume;
  if (!(mass > 0 && Number.isFinite(mass) && area > 0 && Number.isFinite(area)))
    throw precipitationError('Choose a rain diameter whose area and liquid mass fit finite positive SI values.');
  let previousDensity = 0;
  let previousTemperature = 0;
  let previousGravity = -1;
  let previousDrag = 0;
  return {
    kind: 'sphere',
    diameter,
    mass,
    position,
    velocity,
    restitution,
    drag(air) {
      const { density, temperature, gravity } = air;
      if (
        !(
          density > 0 &&
          density < WATER_DENSITY &&
          temperature > 0 &&
          Number.isFinite(temperature) &&
          gravity >= 0 &&
          Number.isFinite(gravity)
        )
      )
        throw precipitationError(
          'Supply finite positive air temperature and density below liquid water, and finite nonnegative gravity.',
        );
      const magn = gravity > 0 ? gravity : STANDARD_GRAVITY;
      if (density === previousDensity && temperature === previousTemperature && magn === previousGravity)
        return previousDrag;
      // Loftus & Wordsworth (2021), equations 3–7. K23 already subtracts the displaced air
      // from the drop's weight. Match its positive equilibrium relative speed using the same area.
      // In zero gravity, the reference coefficient still damps preexisting slip.
      const speed = rainFallSpeed(diameter, { density, temperature, gravity: magn });
      const drag = (4 * diameter * (WATER_DENSITY - density) * magn) / (3 * density * speed * speed);
      if (!(drag > 0 && Number.isFinite(drag) && area * drag > 0 && Number.isFinite(area * drag)))
        throw precipitationError('Choose a representable rain diameter and atmospheric sample for the terminal drag.');
      previousDensity = density;
      previousTemperature = temperature;
      previousGravity = magn;
      previousDrag = drag;
      return drag;
    },
  };
}
