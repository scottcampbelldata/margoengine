// The one home of time-ordered snapshots: a ring of strictly increasing times, the search for the two entries around
// a moment, and the blends every interpolator here shares.

/**
 * A fixed-size ring of strictly increasing times. It keeps the order and finds the entries around a moment; what an
 * entry holds lives in your own storage at index {@link TimeRing.push} returned. `times` may be that storage: with a
 * `stride`, the time of slot `s` sits at `times[s * stride]`.
 */
export class TimeRing {
  /** First of the two slots around the last {@link TimeRing.locate}. */
  a = 0;
  /** Second of the two slots. Equal to `a` when the moment is on an entry or outside the ring. */
  b = 0;
  /** How far from `a` to `b` the moment lies, 0 to 1. */
  u = 0;
  /** How far past the newest entry the moment lies, 0 unless it is. */
  past = 0;
  /** Entries held. */
  count = 0;
  private head = 0;

  /** @throws RangeError for a capacity that is not an integer from 2 to 65536, or storage too small for it. */
  constructor(
    readonly capacity: number,
    readonly times: Float64Array = new Float64Array(capacity),
    readonly stride = 1,
  ) {
    if (!Number.isInteger(capacity) || capacity < 2 || capacity > 65536)
      throw new RangeError(`TimeRing capacity is ${capacity}; pass an integer from 2 to 65536`);
    if (!Number.isInteger(stride) || stride < 1 || times.length < capacity * stride)
      throw new RangeError(`TimeRing storage holds ${times.length} values; pass ${capacity} times the stride`);
  }

  private slot(index: number): number {
    return (this.head - this.count + index + 2 * this.capacity) % this.capacity;
  }
  private time(index: number): number {
    return this.times[this.slot(index) * this.stride];
  }

  /** The newest time (NaN while empty). */
  get newest(): number {
    return this.count ? this.time(this.count - 1) : Number.NaN;
  }
  /** The oldest time (NaN while empty). */
  get oldest(): number {
    return this.count ? this.time(0) : Number.NaN;
  }

  /**
   * Adds `time`, replacing the oldest entry when full.
   * @returns The entry's slot, or -1 for a time not newer than the newest, which changes nothing.
   */
  push(time: number): number {
    if (this.count && time <= this.newest) return -1;
    const slot = this.head;
    this.times[slot * this.stride] = time;
    this.head = (slot + 1) % this.capacity;
    this.count = Math.min(this.capacity, this.count + 1);
    return slot;
  }

  private search(time: number): number {
    let low = 0,
      high = this.count - 1;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.time(mid) >= time) high = mid;
      else low = mid + 1;
    }
    return low;
  }

  /** The slot holding exactly `time`, or -1. */
  find(time: number): number {
    if (!this.count) return -1;
    const index = this.search(time);
    return this.time(index) === time ? this.slot(index) : -1;
  }

  /**
   * Sets {@link TimeRing.a}, {@link TimeRing.b}, {@link TimeRing.u} and {@link TimeRing.past} for the moment `time`.
   * Before the oldest entry both slots are the oldest, past the newest both are the newest.
   * @returns False while empty.
   */
  locate(time: number): boolean {
    if (!this.count) return false;
    const index = this.search(time),
      b = this.slot(index),
      at = this.times[b * this.stride];
    this.b = b;
    if (index === 0 || time >= at) {
      this.a = b;
      this.u = 0;
      this.past = Math.max(0, time - at);
      return true;
    }
    this.a = this.slot(index - 1);
    const from = this.times[this.a * this.stride];
    this.u = (time - from) / (at - from);
    this.past = 0;
    return true;
  }

  /** The slot of the entry before the newest, or -1 with fewer than two. */
  get previous(): number {
    return this.count > 1 ? this.slot(this.count - 2) : -1;
  }
  /** The slot of the newest entry, or -1 while empty. */
  get last(): number {
    return this.count ? this.slot(this.count - 1) : -1;
  }

  /** Drops every entry. */
  clear(): void {
    this.count = this.head = 0;
  }
}

const TAU = Math.PI * 2;

/** The blend of angles `a` and `b` in radians at `t`, the short way round. The result is not wrapped. */
export function blendAngle(a: number, b: number, t: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  else if (d <= -Math.PI) d += TAU;
  return a + d * t;
}

/**
 * Writes `value` as a unit quaternion at `out[offset]`, safely for overflowing or subnormal magnitudes.
 * @throws RangeError for a zero quaternion.
 */
export function normalizeQuaternion(value: ArrayLike<number>, out: Float64Array, offset: number): void {
  let length = Math.hypot(value[0], value[1], value[2], value[3]);
  if (!length) throw new RangeError('Snapshot rotation has zero length; pass a non-zero quaternion [x, y, z, w].');
  // Keep ordinary normalization exact; scale only overflowing or subnormal magnitudes.
  const scale =
    Number.isFinite(length) && length >= 2.2250738585072014e-308
      ? 1
      : Math.max(Math.abs(value[0]), Math.abs(value[1]), Math.abs(value[2]), Math.abs(value[3]));
  if (scale === 1) {
    for (let i = 0; i < 4; i++) out[offset + i] = value[i] / length;
    return;
  }
  length = Math.hypot(value[0] / scale, value[1] / scale, value[2] / scale, value[3] / scale);
  for (let i = 0; i < 4; i++) out[offset + i] = value[i] / scale / length;
}

/**
 * Shortest-arc slerp of the unit quaternions at `data[a]` and `data[b]`, written to `out[offset]`.
 * Near-parallel pairs fall back to a normalized blend.
 */
export function slerpInto(
  out: Float64Array,
  offset: number,
  data: Float64Array,
  a: number,
  b: number,
  u: number,
): void {
  let dot = 0;
  for (let i = 0; i < 4; i++) dot += data[a + i] * data[b + i];
  const sign = dot < 0 ? -1 : 1;
  dot = Math.abs(dot);
  let p = 1 - u,
    q = u;
  if (dot <= 0.9995) {
    const angle = Math.acos(dot),
      sine = Math.sin(angle);
    p = Math.sin((1 - u) * angle) / sine;
    q = Math.sin(u * angle) / sine;
  }
  let length = 0;
  for (let i = 0; i < 4; i++) {
    out[offset + i] = p * data[a + i] + q * sign * data[b + i];
    length += out[offset + i] ** 2;
  }
  length = Math.sqrt(length);
  for (let i = 0; i < 4; i++) out[offset + i] /= length;
}
