export type HeightField = (x: number, z: number) => number;
export interface LocomotionOptions {bounds?: readonly [minX: number, maxX: number, minZ: number, maxZ: number]; minHeight?: number; walkSpeed?: number; runSpeed?: number}
const defaults: LocomotionOptions = {};

/** state: xyz, heading, camera yaw/pitch, gait phase, speed; actions: strafe, forward, look xy, sprint. */
export function stepLocomotion(state: Float32Array, actions: Float32Array, delta: number, height: HeightField, options: LocomotionOptions = defaults): void {
  const speed = actions[4] > 0 ? options.runSpeed ?? 7 : options.walkSpeed ?? 3.4, bounds = options.bounds;
  if (state.length !== 8 || actions.length !== 5 || !state.every(Number.isFinite) || !actions.every(Number.isFinite) || !Number.isFinite(delta) || delta < 0 || typeof height !== 'function' || !Number.isFinite(options.walkSpeed ?? 3.4) || (options.walkSpeed ?? 3.4) < 0 || !Number.isFinite(options.runSpeed ?? 7) || (options.runSpeed ?? 7) < 0 || options.minHeight !== undefined && !Number.isFinite(options.minHeight) || bounds && (bounds.length !== 4 || !Number.isFinite(bounds[0]) || !Number.isFinite(bounds[1]) || !Number.isFinite(bounds[2]) || !Number.isFinite(bounds[3]) || bounds[0] >= bounds[1] || bounds[2] >= bounds[3])) throw new RangeError('Invalid locomotion inputs');
  const dt = Math.min(0.05, delta);
  const yaw = state[4] - actions[2], pitch = Math.max(-1.4, Math.min(0.9, state[5] + actions[3]));
  const length = Math.max(1, Math.hypot(actions[0], actions[1]));
  const dx = (actions[0] * Math.cos(yaw) - actions[1] * Math.sin(yaw)) / length;
  const dz = (-actions[0] * Math.sin(yaw) - actions[1] * Math.cos(yaw)) / length;
  const velocity = state[7] + (Math.min(1, Math.hypot(actions[0], actions[1])) * speed - state[7]) * (1 - Math.exp(-14 * dt));
  let x = state[0] + dx * velocity * dt, z = state[2] + dz * velocity * dt;
  if (bounds) {x = Math.max(bounds[0], Math.min(bounds[1], x)); z = Math.max(bounds[2], Math.min(bounds[3], z));}
  const ground = height(x,z);
  if (!Number.isFinite(ground)) throw new RangeError('Locomotion ground height must be finite');
  state[0] = x; state[1] = Math.max(options.minHeight ?? -Infinity, ground); state[2] = z; state[4] = yaw; state[5] = pitch; state[7] = velocity;
  if (Math.hypot(dx, dz) > 0.001) {
    const heading = Math.atan2(dx, dz), angle = Math.atan2(Math.sin(heading - state[3]), Math.cos(heading - state[3]));
    state[3] += angle * (1 - Math.exp(-10 * dt));
  }
  state[6] += velocity * dt * 2.6;
}
