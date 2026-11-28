import { MargoError } from '@margoengine/math/errors';
import type { FlowSample, Wind } from '@margoengine/math/fields';
import { cos, sin } from '@margoengine/math/pinned';

type Vector = readonly [number, number, number];

/** A one-cosine wind event placed in space and on the world clock. */
export interface TravellingGustOptions {
  /** The leading edge passes this point at `start`, in metres in the base wind's construction cell. Default [0, 0, 0]. */
  readonly origin?: Vector;
  /** World cell side in metres. Match the base wind's world. Default 4096. */
  readonly cellSize?: number;
  /** Time in seconds when the leading edge passes the origin. Default 0. */
  readonly start?: number;
  /** Direction of travel, in radians from +x toward +z. Default 0. */
  readonly direction?: number;
  /** Speed of the leading edge, in m/s. */
  readonly speed: number;
  /** Extent from leading to trailing edge, in metres. Peak speed is halfway through. */
  readonly length: number;
  /** Peak additional air velocity [x, y, z], in m/s on the world axes. */
  readonly amplitude: Vector;
  /** Optional vertical envelope [bottom, top], in metres relative to origin. It peaks midway and vanishes at both ends. */
  readonly height?: readonly [number, number];
}

function vector(value: unknown): value is Vector {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1]) &&
    Number.isFinite(value[2])
  );
}

function cell(value: unknown): value is Vector {
  return vector(value) && value.every(Number.isSafeInteger);
}

// sin²(pi f) is (1 - cos(2 pi f))/2, and retains the small increments near the ends.
function pulse(fraction: number): number {
  const wave = sin(Math.PI * fraction);
  return wave * wave;
}

/** Add a finite one-cosine event to a wind field. It preserves the base air density, temperature and current cell. */
export function travellingGust(base: Wind, options: TravellingGustOptions): Wind {
  if (base?.medium !== 'air' || typeof base.sample !== 'function' || !cell(base.cell))
    throw new MargoError(
      'state',
      'Invalid gust base wind. Pass an air field with a signed integer cell and a sampler.',
    );
  if (!options || typeof options !== 'object')
    throw new MargoError('state', 'Missing gust settings. Pass an extent, front speed and peak velocity.');
  const { origin = [0, 0, 0], cellSize = 4096, start = 0, direction = 0, speed, length, amplitude, height } = options;
  if (!vector(origin) || !vector(amplitude) || !Number.isFinite(start) || !Number.isFinite(direction))
    throw new MargoError(
      'state',
      'Invalid gust origin, amplitude, start or direction. Use finite metres, metres per second, seconds and radians.',
    );
  if (!(cellSize > 0 && speed > 0 && length > 0 && [cellSize, speed, length].every(Number.isFinite)))
    throw new MargoError('state', 'Invalid gust size or speed. Use finite positive cell size, length and front speed.');
  if (
    height !== undefined &&
    !(
      Array.isArray(height) &&
      height.length === 2 &&
      height.every(Number.isFinite) &&
      height[1] > height[0] &&
      Number.isFinite(height[1] - height[0])
    )
  )
    throw new MargoError(
      'state',
      'Invalid gust height interval. Use finite bottom and top with a positive finite span.',
    );
  const [ox, oy, oz] = origin;
  const [cx, cy, cz] = base.cell;
  const [ax, ay, az] = amplitude;
  const bottom = height?.[0] ?? 0;
  const span = height === undefined ? 0 : height[1] - bottom;
  const heading = direction % (2 * Math.PI);
  const alongX = cos(heading);
  const alongZ = sin(heading);
  const scratch: FlowSample = { velocity: [0, 0, 0], density: 0, temperature: 0 };
  return {
    medium: 'air',
    get cell() {
      return base.cell;
    },
    sample(x, y, z, t, out) {
      const currentCell = base.cell;
      if (![x, y, z, t].every(Number.isFinite) || !cell(currentCell))
        throw new MargoError(
          'state',
          'Invalid gust sample position, cell or time. Use finite local metres and seconds in a signed integer cell.',
        );
      const dx = x - ox + (currentCell[0] - cx) * cellSize;
      const dz = z - oz + (currentCell[2] - cz) * cellSize;
      const distance = (t - start) * speed - (dx * alongX + dz * alongZ);
      const aboveBottom = span === 0 ? 0 : y - oy + (currentCell[1] - cy) * cellSize - bottom;
      if (!Number.isFinite(distance) || !Number.isFinite(aboveBottom))
        throw new MargoError(
          'state',
          'Gust position exceeds numeric range. Place the event nearer the active cell or use a shorter elapsed time.',
        );
      if (distance <= 0 || distance >= length || (span > 0 && (aboveBottom <= 0 || aboveBottom >= span)))
        return base.sample(x, y, z, t, out);

      const weight = pulse(distance / length) * (span === 0 ? 1 : pulse(aboveBottom / span));
      const sample = base.sample(x, y, z, t, scratch);
      const vx = sample.velocity[0] + ax * weight;
      const vy = sample.velocity[1] + ay * weight;
      const vz = sample.velocity[2] + az * weight;
      if (![vx, vy, vz].every(Number.isFinite))
        throw new MargoError(
          'state',
          'Resulting gust velocity exceeds numeric range. Reduce the peak gust or base wind speed.',
        );
      const result = out ?? { velocity: [0, 0, 0], density: 0, temperature: 0 };
      result.velocity[0] = vx;
      result.velocity[1] = vy;
      result.velocity[2] = vz;
      result.density = sample.density;
      result.temperature = sample.temperature;
      return result;
    },
  };
}
