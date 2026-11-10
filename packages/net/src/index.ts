import { normalizeQuaternion, slerpInto, TimeRing } from './timeline.js';

const zero = [0, 0, 0],
  identity = [0, 0, 0, 1];
/** One networked transform state. */
export interface Snapshot {
  /** x, y, z in world units. */
  position: Float64Array;
  /** Unit quaternion x, y, z, w. */
  rotation: Float64Array;
  /** x, y, z in world units per second. */
  velocity: Float64Array;
}
/** A zeroed snapshot with the identity rotation, for use as a reusable `sample` output. */
export function createSnapshot(): Snapshot {
  return { position: new Float64Array(3), rotation: new Float64Array(identity), velocity: new Float64Array(3) };
}
const valid = (value: ArrayLike<number>, size: number): void => {
  if (value.length !== size)
    throw new TypeError(
      'Snapshot vectors need 3 values (position, velocity) or 4 (rotation); pass arrays of the right length.',
    );
  for (let i = 0; i < size; i++) if (!Number.isFinite(value[i])) throw new RangeError('Snapshot values must be finite');
};

/**
 * Ring buffer of timestamped snapshots for interpolating remote objects. `capacity` is the number of
 * snapshots kept (an integer 2..65536, default 32); `maxPrediction` caps extrapolation past the newest
 * snapshot in seconds (0..10, default 0.25). Out-of-range arguments throw a RangeError.
 */
export class SnapshotBuffer {
  /** 11 floats per slot: time, position xyz, rotation xyzw, velocity xyz. */
  readonly samples: Float64Array;
  private readonly output = createSnapshot();
  private readonly ring: TimeRing;
  private readonly unit = new Float64Array(4);
  constructor(
    readonly capacity = 32,
    readonly maxPrediction = 0.25,
  ) {
    if (
      !Number.isInteger(capacity) ||
      capacity < 2 ||
      capacity > 65536 ||
      !Number.isFinite(maxPrediction) ||
      maxPrediction < 0 ||
      maxPrediction > 10
    )
      throw new RangeError(
        'SnapshotBuffer needs an integer capacity from 2 to 65536 and a maxPrediction between 0 and 10 seconds; fix the arguments.',
      );
    this.samples = new Float64Array(capacity * 11);
    this.ring = new TimeRing(capacity, this.samples, 11);
  }
  /** Timestamp and velocity use seconds. Duplicate/out-of-order packets are ignored. */
  push(
    time: number,
    position: ArrayLike<number>,
    rotation: ArrayLike<number> = identity,
    velocity: ArrayLike<number> = zero,
  ): boolean {
    if (!Number.isFinite(time))
      throw new RangeError('Snapshot time must be a finite number of seconds; pass a finite timestamp.');
    valid(position, 3);
    valid(rotation, 4);
    valid(velocity, 3);
    const unit = this.unit;
    normalizeQuaternion(rotation, unit, 0);
    const slot = this.ring.push(time);
    if (slot < 0) return false;
    const offset = slot * 11;
    for (let i = 0; i < 3; i++) {
      this.samples[offset + 1 + i] = position[i];
      this.samples[offset + 8 + i] = velocity[i];
    }
    for (let i = 0; i < 4; i++) this.samples[offset + 4 + i] = unit[i];
    return true;
  }
  /**
   * State at `time` seconds: Hermite position, its derivative as velocity, and slerped rotation between the surrounding
   * snapshots, or
   * linear extrapolation from the newest (up to `maxPrediction`). Before the oldest it returns the oldest.
   * Returns null while empty. The default output is reused by every call.
   * @throws RangeError for a non-finite time.
   * @throws TypeError for a malformed output.
   */
  sample(time: number, output: Snapshot = this.output): Snapshot | null {
    if (!Number.isFinite(time))
      throw new RangeError('Playback time must be a finite number of seconds; pass a finite time.');
    if (output.position.length !== 3 || output.rotation.length !== 4 || output.velocity.length !== 3)
      throw new TypeError(
        'Snapshot output needs position and velocity of length 3 and rotation of length 4; pass a Snapshot made by createSnapshot.',
      );
    const ring = this.ring;
    if (!ring.locate(time)) return null;
    const data = this.samples,
      b = ring.b * 11;
    if (ring.a === ring.b) {
      const delta = Math.min(this.maxPrediction, ring.past);
      for (let i = 0; i < 3; i++) {
        output.position[i] = data[b + 1 + i] + data[b + 8 + i] * delta;
        output.velocity[i] = data[b + 8 + i];
      }
      for (let i = 0; i < 4; i++) output.rotation[i] = data[b + 4 + i];
      return output;
    }
    const a = ring.a * 11,
      span = data[b] - data[a],
      u = ring.u,
      u2 = u * u,
      u3 = u2 * u;
    for (let i = 0; i < 3; i++) {
      output.position[i] =
        (2 * u3 - 3 * u2 + 1) * data[a + 1 + i] +
        (u3 - 2 * u2 + u) * span * data[a + 8 + i] +
        (-2 * u3 + 3 * u2) * data[b + 1 + i] +
        (u3 - u2) * span * data[b + 8 + i];
      // The derivative of that curve, so the velocity is the one the position moves at.
      output.velocity[i] =
        ((6 * u2 - 6 * u) * (data[a + 1 + i] - data[b + 1 + i])) / span +
        (3 * u2 - 4 * u + 1) * data[a + 8 + i] +
        (3 * u2 - 2 * u) * data[b + 8 + i];
    }
    slerpInto(output.rotation, 0, data, a + 4, b + 4, u);
    return output;
  }
  /** Drops every snapshot. */
  clear(): void {
    this.ring.clear();
  }
}
