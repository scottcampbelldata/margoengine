const zero = [0, 0, 0], identity = [0, 0, 0, 1];
export interface Snapshot {position: Float64Array; rotation: Float64Array; velocity: Float64Array}
export function createSnapshot(): Snapshot {return {position: new Float64Array(3), rotation: new Float64Array(identity), velocity: new Float64Array(3)};}
const valid = (value: ArrayLike<number>, size: number): void => {
  if (value.length !== size) throw new TypeError('Invalid snapshot vector size');
  for (let i = 0; i < size; i++) if (!Number.isFinite(value[i])) throw new RangeError('Snapshot values must be finite');
};

export class SnapshotBuffer {
  readonly samples: Float64Array;
  private readonly output = createSnapshot();
  private count = 0;
  private head = 0;
  constructor(readonly capacity = 32, readonly maxPrediction = 0.25) {
    if (!Number.isInteger(capacity) || capacity < 2 || capacity > 65536 || !Number.isFinite(maxPrediction) || maxPrediction < 0 || maxPrediction > 10) throw new RangeError('Invalid snapshot buffer');
    this.samples = new Float64Array(capacity * 11);
  }
  /** Timestamp and velocity use seconds. Duplicate/out-of-order packets are ignored. */
  push(time: number, position: ArrayLike<number>, rotation: ArrayLike<number> = identity, velocity: ArrayLike<number> = zero): boolean {
    if (!Number.isFinite(time)) throw new RangeError('Invalid snapshot timestamp'); valid(position, 3); valid(rotation, 4); valid(velocity, 3);
    let length = Math.hypot(rotation[0], rotation[1], rotation[2], rotation[3]); if (!length) throw new RangeError('Zero snapshot quaternion');
    // Keep ordinary normalization exact; scale only overflowing or subnormal magnitudes.
    const scale = Number.isFinite(length) && length >= 2.2250738585072014e-308 ? 1 : Math.max(Math.abs(rotation[0]), Math.abs(rotation[1]), Math.abs(rotation[2]), Math.abs(rotation[3]));
    if (scale !== 1) length = Math.hypot(rotation[0] / scale, rotation[1] / scale, rotation[2] / scale, rotation[3] / scale);
    if (this.count && time <= this.samples[((this.head - 1 + this.capacity) % this.capacity) * 11]) return false;
    const offset = this.head * 11; this.samples[offset] = time;
    for (let i = 0; i < 3; i++) {this.samples[offset + 1 + i] = position[i]; this.samples[offset + 8 + i] = velocity[i];}
    if (scale === 1) for (let i = 0; i < 4; i++) this.samples[offset + 4 + i] = rotation[i] / length;
    else for (let i = 0; i < 4; i++) this.samples[offset + 4 + i] = rotation[i] / scale / length;
    this.head = (this.head + 1) % this.capacity; this.count = Math.min(this.capacity, this.count + 1); return true;
  }
  sample(time: number, output: Snapshot = this.output): Snapshot | null {
    if (!Number.isFinite(time)) throw new RangeError('Invalid playback time');
    if (output.position.length !== 3 || output.rotation.length !== 4 || output.velocity.length !== 3) throw new TypeError('Invalid snapshot output');
    if (!this.count) return null;
    const data = this.samples, oldest = (this.head - this.count + this.capacity) % this.capacity;
    let low = 0, high = this.count - 1;
    while (low < high) {const mid = (low + high) >>> 1; if (data[((oldest + mid) % this.capacity) * 11] >= time) high = mid; else low = mid + 1;}
    const b = ((oldest + low) % this.capacity) * 11;
    if (low === 0 || time >= data[b]) {
      const delta = Math.min(this.maxPrediction, Math.max(0, time - data[b]));
      for (let i = 0; i < 3; i++) {output.position[i] = data[b + 1 + i] + data[b + 8 + i] * delta; output.velocity[i] = data[b + 8 + i];}
      for (let i = 0; i < 4; i++) output.rotation[i] = data[b + 4 + i]; return output;
    }
    const a = ((oldest + low - 1) % this.capacity) * 11, span = data[b] - data[a], u = (time - data[a]) / span, u2 = u * u, u3 = u2 * u;
    for (let i = 0; i < 3; i++) {
      output.position[i] = (2 * u3 - 3 * u2 + 1) * data[a + 1 + i] + (u3 - 2 * u2 + u) * span * data[a + 8 + i] + (-2 * u3 + 3 * u2) * data[b + 1 + i] + (u3 - u2) * span * data[b + 8 + i];
      output.velocity[i] = (1 - u) * data[a + 8 + i] + u * data[b + 8 + i];
    }
    let dot = 0; for (let i = 0; i < 4; i++) dot += data[a + 4 + i] * data[b + 4 + i];
    const sign = dot < 0 ? -1 : 1; dot = Math.abs(dot);
    let p = 1 - u, q = u;
    if (dot <= 0.9995) {const angle = Math.acos(dot), sine = Math.sin(angle); p = Math.sin((1 - u) * angle) / sine; q = Math.sin(u * angle) / sine;}
    let length = 0;
    for (let i = 0; i < 4; i++) {output.rotation[i] = p * data[a + 4 + i] + q * sign * data[b + 4 + i]; length += output.rotation[i] ** 2;}
    length = Math.sqrt(length); for (let i = 0; i < 4; i++) output.rotation[i] /= length;
    return output;
  }
  clear(): void {this.count = this.head = 0;}
}
