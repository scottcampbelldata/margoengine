// Steering behaviours after C. W. Reynolds, "Steering Behaviors For Autonomous Characters", Game Developers Conference
// 1999, and "Flocks, herds and schools: a distributed behavioral model", SIGGRAPH 1987 (separation, alignment,
// cohesion). Each behaviour writes a steering force (a desired change of velocity, world units per second squared)
// into `out`; `Steering` blends them by weight inside priority groups, and `integrate` applies the result. Agents are
// structural, so a navmesh `CrowdAgent`, an ECS row view or a plain object all fit.
import type { MutableVec3, Vec3 } from '@margoengine/math';

export type { MutableVec3, Vec3 };

/** Anything that steers: a position, a velocity and a top speed. A navmesh `CrowdAgent` fits as it is. */
export interface SteeringAgent {
  /** World position, `[x, y, z]`. `integrate` writes it. */
  readonly position: ArrayLike<number> & { [index: number]: number };
  /** World velocity, units per second. `integrate` writes it. */
  readonly velocity: ArrayLike<number> & { [index: number]: number };
  /** Top speed, units per second. */
  maxSpeed: number;
  /** Largest steering force (default unlimited). */
  maxForce?: number;
}

/** A moving body another agent reacts to (pursue, evade, flocking neighbours). */
export interface Mover {
  readonly position: ArrayLike<number>;
  readonly velocity: ArrayLike<number>;
}

/** A sphere to steer around. */
export interface SteeringObstacle {
  readonly position: ArrayLike<number>;
  readonly radius: number;
}

const set = (out: MutableVec3, x: number, y: number, z: number): MutableVec3 => {
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
};
const vector = (value: ArrayLike<number>, label: string): void => {
  if (
    value == null ||
    value.length < 3 ||
    !Number.isFinite(value[0]) ||
    !Number.isFinite(value[1]) ||
    !Number.isFinite(value[2])
  )
    throw new RangeError(`${label} must be [x, y, z] with finite numbers`);
};
const speed = (agent: SteeringAgent): number => {
  if (agent == null || typeof agent !== 'object')
    throw new TypeError('Steering agent must be {position, velocity, maxSpeed}');
  vector(agent.position, 'Agent position');
  vector(agent.velocity, 'Agent velocity');
  const max = agent.maxSpeed;
  if (!(max >= 0) || !Number.isFinite(max)) throw new RangeError('Agent maxSpeed must be a finite number of 0 or more');
  return max;
};
const positive = (value: number, label: string, zero = false): number => {
  if (!(zero ? value >= 0 : value > 0) || !Number.isFinite(value))
    throw new RangeError(`${label} must be a finite number ${zero ? 'of 0 or more' : 'above 0'}`);
  return value;
};

/** Force toward a desired direction `(dx, dy, dz)` at top speed (zero direction: brake to a stop). */
function toward(
  agent: SteeringAgent,
  dx: number,
  dy: number,
  dz: number,
  desiredSpeed: number,
  out: MutableVec3,
): MutableVec3 {
  const length = Math.hypot(dx, dy, dz),
    scale = length > 1e-12 ? desiredSpeed / length : 0,
    v = agent.velocity;
  return set(out, dx * scale - v[0], dy * scale - v[1], dz * scale - v[2]);
}

/** Steer straight at `target` at top speed. */
export function seek(agent: SteeringAgent, target: Vec3, out: MutableVec3 = [0, 0, 0]): MutableVec3 {
  const max = speed(agent);
  vector(target, 'Seek target');
  const p = agent.position;
  return toward(agent, target[0] - p[0], target[1] - p[1], target[2] - p[2], max, out);
}

/** Steer straight away from `threat` at top speed; nothing beyond `panicDistance` (default unlimited). */
export function flee(
  agent: SteeringAgent,
  threat: Vec3,
  out: MutableVec3 = [0, 0, 0],
  panicDistance = Number.POSITIVE_INFINITY,
): MutableVec3 {
  const max = speed(agent);
  vector(threat, 'Flee threat');
  if (!(panicDistance > 0)) throw new RangeError('Flee panicDistance must be above 0');
  const p = agent.position,
    dx = p[0] - threat[0],
    dy = p[1] - threat[1],
    dz = p[2] - threat[2];
  if (Math.hypot(dx, dy, dz) > panicDistance) return set(out, 0, 0, 0);
  return toward(agent, dx, dy, dz, max, out);
}

/** Seek `target`, slowing linearly inside `slowingRadius` (default 1) to stop on it. */
export function arrive(
  agent: SteeringAgent,
  target: Vec3,
  out: MutableVec3 = [0, 0, 0],
  slowingRadius = 1,
): MutableVec3 {
  const max = speed(agent);
  vector(target, 'Arrive target');
  positive(slowingRadius, 'Arrive slowingRadius');
  const p = agent.position,
    dx = target[0] - p[0],
    dy = target[1] - p[1],
    dz = target[2] - p[2],
    distance = Math.hypot(dx, dy, dz);
  return toward(agent, dx, dy, dz, max * Math.min(1, distance / slowingRadius), out);
}

/** Predicted position of `mover` after the time the agent needs to reach it, at most `maxPrediction` seconds. */
function predict(agent: SteeringAgent, mover: Mover, maxPrediction: number, max: number): [number, number, number] {
  vector(mover?.position, 'Target position');
  vector(mover.velocity, 'Target velocity');
  positive(maxPrediction, 'maxPrediction', true);
  const p = agent.position,
    q = mover.position,
    v = mover.velocity,
    distance = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]),
    t = max > 0 ? Math.min(maxPrediction, distance / max) : maxPrediction;
  return [q[0] + v[0] * t, q[1] + v[1] * t, q[2] + v[2] * t];
}

/** Seek where a moving `quarry` will be, looking ahead at most `maxPrediction` seconds (default 1). */
export function pursue(
  agent: SteeringAgent,
  quarry: Mover,
  out: MutableVec3 = [0, 0, 0],
  maxPrediction = 1,
): MutableVec3 {
  const max = speed(agent),
    at = predict(agent, quarry, maxPrediction, max),
    p = agent.position;
  return toward(agent, at[0] - p[0], at[1] - p[1], at[2] - p[2], max, out);
}

/** Flee where a moving `threat` will be, looking ahead at most `maxPrediction` seconds (default 1). */
export function evade(
  agent: SteeringAgent,
  threat: Mover,
  out: MutableVec3 = [0, 0, 0],
  maxPrediction = 1,
): MutableVec3 {
  const max = speed(agent),
    at = predict(agent, threat, maxPrediction, max),
    p = agent.position;
  return toward(agent, p[0] - at[0], p[1] - at[1], p[2] - at[2], max, out);
}

/** State of {@link wander}: the angle of the wander target on its circle. Keep one per agent. */
export interface WanderState {
  angle: number;
}

/** Options of {@link wander}. */
export interface WanderOptions {
  /** Radius of the circle the wander target moves on (default 1). */
  radius?: number;
  /** How far ahead of the agent the circle sits (default 2). */
  distance?: number;
  /** Largest change of the target's angle per call, radians (default 0.5). */
  jitter?: number;
}

/**
 * Reynolds' wander on the ground plane (XZ): a target on a circle ahead of the agent drifts by a random jitter each
 * call, and the agent seeks it, so it meanders smoothly. `random` returns floats in [0, 1) (seed one for replays).
 */
export function wander(
  agent: SteeringAgent,
  state: WanderState,
  random: () => number,
  options: WanderOptions = {},
  out: MutableVec3 = [0, 0, 0],
): MutableVec3 {
  const max = speed(agent),
    radius = positive(options.radius ?? 1, 'Wander radius', true),
    distance = positive(options.distance ?? 2, 'Wander distance', true),
    jitter = positive(options.jitter ?? 0.5, 'Wander jitter', true);
  if (state == null || !Number.isFinite(state.angle))
    throw new RangeError('Wander state must be {angle} with a finite angle');
  state.angle += (random() * 2 - 1) * jitter;
  const v = agent.velocity,
    planar = Math.hypot(v[0], v[2]),
    fx = planar > 1e-12 ? v[0] / planar : 1,
    fz = planar > 1e-12 ? v[2] / planar : 0;
  return toward(
    agent,
    fx * distance + Math.cos(state.angle) * radius,
    0,
    fz * distance + Math.sin(state.angle) * radius,
    max,
    out,
  );
}

/** Options of {@link avoidObstacles}. */
export interface AvoidOptions {
  /** The agent's own radius (default 0.5). */
  radius?: number;
  /** How far ahead to look, seconds of travel at the current speed (default 1); at least `minDistance` ahead. */
  lookAhead?: number;
  /** Shortest look-ahead distance (default 1). */
  minDistance?: number;
}

/**
 * Steer sideways away from the nearest obstacle in the agent's path: a cylinder of the agent's radius ahead of it,
 * `lookAhead` seconds long. The push is stronger the nearer the obstacle; zero when the path is clear.
 */
export function avoidObstacles(
  agent: SteeringAgent,
  obstacles: Iterable<SteeringObstacle>,
  options: AvoidOptions = {},
  out: MutableVec3 = [0, 0, 0],
): MutableVec3 {
  const max = speed(agent),
    radius = positive(options.radius ?? 0.5, 'Avoid radius', true),
    lookAhead = positive(options.lookAhead ?? 1, 'Avoid lookAhead', true),
    minDistance = positive(options.minDistance ?? 1, 'Avoid minDistance', true);
  const p = agent.position,
    v = agent.velocity,
    s = Math.hypot(v[0], v[1], v[2]);
  set(out, 0, 0, 0);
  if (s < 1e-12) return out;
  const fx = v[0] / s,
    fy = v[1] / s,
    fz = v[2] / s,
    reach = Math.max(minDistance, s * lookAhead);
  let nearest = Number.POSITIVE_INFINITY,
    lx = 0,
    ly = 0,
    lz = 0,
    clearance = 0;
  for (const obstacle of obstacles) {
    vector(obstacle?.position, 'Obstacle position');
    const r = positive(obstacle.radius, 'Obstacle radius', true) + radius,
      ox = obstacle.position[0] - p[0],
      oy = obstacle.position[1] - p[1],
      oz = obstacle.position[2] - p[2],
      along = ox * fx + oy * fy + oz * fz;
    if (along < -r || along > reach + r) continue;
    // Offset of the centre from the path's axis.
    const ax = ox - fx * along,
      ay = oy - fy * along,
      az = oz - fz * along,
      off = Math.hypot(ax, ay, az);
    if (off >= r || along >= nearest) continue;
    nearest = along;
    clearance = r - off;
    if (off > 1e-9) {
      lx = -ax / off;
      ly = -ay / off;
      lz = -az / off;
    } else {
      // Dead ahead: turn to the agent's right on the ground plane (a fixed choice keeps it deterministic).
      const planar = Math.hypot(fx, fz);
      lx = planar > 1e-9 ? -fz / planar : 1;
      ly = 0;
      lz = planar > 1e-9 ? fx / planar : 0;
    }
  }
  if (nearest === Number.POSITIVE_INFINITY) return out;
  const urgency = 1 + (reach - Math.max(0, nearest)) / reach,
    magnitude = Math.max(max, 1e-6) * urgency * Math.min(1, clearance / Math.max(radius, 1e-6) + 0.5);
  return set(out, lx * magnitude, ly * magnitude, lz * magnitude);
}

/** Options of {@link followPath}. */
export interface PathOptions {
  /** Half-width of the path: inside it the agent travels along the path without steering back to its centre (default 0.5). */
  radius?: number;
  /** How far ahead along the path to aim, world units (default 1). */
  ahead?: number;
  /** Seconds ahead to predict the agent's position (default 0.25). */
  predict?: number;
  /** Treat the last point as joined to the first (default false; an open path arrives at its end). */
  loop?: boolean;
  /** Slowing radius at the end of an open path (default 1). */
  slowingRadius?: number;
}

/**
 * Reynolds' path following: predict the agent's position, find the nearest point on the polyline, and seek a point
 * `ahead` further along it whenever the prediction leaves the path's `radius`. At the end of an open path it arrives.
 * A navmesh route (`crowd agent.path`, `navMesh.findPath`) is a valid `path`.
 */
export function followPath(
  agent: SteeringAgent,
  path: readonly Vec3[],
  options: PathOptions = {},
  out: MutableVec3 = [0, 0, 0],
): MutableVec3 {
  speed(agent);
  const radius = positive(options.radius ?? 0.5, 'Path radius', true),
    ahead = positive(options.ahead ?? 1, 'Path ahead', true),
    lead = positive(options.predict ?? 0.25, 'Path predict', true),
    loop = options.loop === true;
  if (!Array.isArray(path) || path.length < 1) throw new RangeError('Path must hold at least one [x, y, z] point');
  path.forEach((point, index) => vector(point, `Path point ${index}`));
  if (path.length === 1) return arrive(agent, path[0], out, options.slowingRadius ?? 1);
  const p = agent.position,
    v = agent.velocity,
    px = p[0] + v[0] * lead,
    py = p[1] + v[1] * lead,
    pz = p[2] + v[2] * lead;
  const segments = loop ? path.length : path.length - 1;
  // Nearest point on the polyline, as arc length `best`.
  let best = 0,
    bestDistance = Number.POSITIVE_INFINITY,
    length = 0;
  const lengths: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a = path[i],
      b = path[(i + 1) % path.length],
      ex = b[0] - a[0],
      ey = b[1] - a[1],
      ez = b[2] - a[2],
      l2 = ex * ex + ey * ey + ez * ez,
      t = l2 > 0 ? Math.max(0, Math.min(1, ((px - a[0]) * ex + (py - a[1]) * ey + (pz - a[2]) * ez) / l2)) : 0,
      d = Math.hypot(a[0] + ex * t - px, a[1] + ey * t - py, a[2] + ez * t - pz),
      l = Math.sqrt(l2);
    lengths.push(l);
    if (d < bestDistance) {
      bestDistance = d;
      best = length + l * t;
    }
    length += l;
  }
  let target = best + ahead;
  if (!loop && target >= length) return arrive(agent, path[path.length - 1], out, options.slowingRadius ?? 1);
  if (bestDistance <= radius) {
    // On the path and heading forward: travel along it at top speed without correcting sideways.
    const at = pointAt(path, lengths, best, loop),
      next = pointAt(path, lengths, Math.min(best + 1e-3, loop ? best + 1e-3 : length), loop),
      dot = (next[0] - at[0]) * v[0] + (next[1] - at[1]) * v[1] + (next[2] - at[2]) * v[2];
    if (dot > 0) return toward(agent, next[0] - at[0], next[1] - at[1], next[2] - at[2], agent.maxSpeed, out);
  }
  if (loop && length > 0) target %= length;
  return seek(agent, pointAt(path, lengths, target, loop), out);
}

function pointAt(
  path: readonly Vec3[],
  lengths: readonly number[],
  s: number,
  loop: boolean,
): [number, number, number] {
  let rest = s;
  for (let i = 0; i < lengths.length; i++) {
    if (rest <= lengths[i] || i === lengths.length - 1) {
      const a = path[i],
        b = path[(i + 1) % path.length],
        t = lengths[i] > 0 ? Math.min(1, Math.max(0, rest / lengths[i])) : 0;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    }
    rest -= lengths[i];
  }
  const last = loop ? path[0] : path[path.length - 1];
  return [last[0], last[1], last[2]];
}

/** Push away from neighbours nearer than `radius`, harder the nearer they are. `agent` itself is skipped. */
export function separation(
  agent: SteeringAgent,
  neighbors: Iterable<Mover>,
  radius: number,
  out: MutableVec3 = [0, 0, 0],
): MutableVec3 {
  const max = speed(agent);
  positive(radius, 'Separation radius');
  const p = agent.position;
  let sx = 0,
    sy = 0,
    sz = 0,
    count = 0;
  for (const other of neighbors) {
    if (other === agent) continue;
    const q = other.position,
      dx = p[0] - q[0],
      dy = p[1] - q[1],
      dz = p[2] - q[2],
      d = Math.hypot(dx, dy, dz);
    if (d >= radius || d === 0) continue;
    // 1/d falloff: the unit offset divided by the distance.
    sx += dx / (d * d);
    sy += dy / (d * d);
    sz += dz / (d * d);
    count++;
  }
  if (!count) return set(out, 0, 0, 0);
  return toward(agent, sx, sy, sz, max, out);
}

/** Steer toward the centre of the neighbours within `radius`. `agent` itself is skipped. */
export function cohesion(
  agent: SteeringAgent,
  neighbors: Iterable<Mover>,
  radius: number,
  out: MutableVec3 = [0, 0, 0],
): MutableVec3 {
  const max = speed(agent);
  positive(radius, 'Cohesion radius');
  const p = agent.position;
  let cx = 0,
    cy = 0,
    cz = 0,
    count = 0;
  for (const other of neighbors) {
    if (other === agent) continue;
    const q = other.position;
    if (Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) >= radius) continue;
    cx += q[0];
    cy += q[1];
    cz += q[2];
    count++;
  }
  if (!count) return set(out, 0, 0, 0);
  return toward(agent, cx / count - p[0], cy / count - p[1], cz / count - p[2], max, out);
}

/** Steer to match the mean heading of the neighbours within `radius`. `agent` itself is skipped. */
export function alignment(
  agent: SteeringAgent,
  neighbors: Iterable<Mover>,
  radius: number,
  out: MutableVec3 = [0, 0, 0],
): MutableVec3 {
  const max = speed(agent);
  positive(radius, 'Alignment radius');
  const p = agent.position;
  let vx = 0,
    vy = 0,
    vz = 0,
    count = 0;
  for (const other of neighbors) {
    if (other === agent) continue;
    const q = other.position;
    if (Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) >= radius) continue;
    vx += other.velocity[0];
    vy += other.velocity[1];
    vz += other.velocity[2];
    count++;
  }
  if (!count || Math.hypot(vx, vy, vz) < 1e-12) return set(out, 0, 0, 0);
  return toward(agent, vx, vy, vz, max, out);
}

/** A behaviour for {@link Steering}: writes its force for `agent` into `out`. */
export type SteeringBehavior<A extends SteeringAgent = SteeringAgent> = (agent: A, out: MutableVec3) => void;

/** How a behaviour takes part in {@link Steering.compute}. */
export interface SteeringEntry {
  /** Multiplies its force in the weighted sum of its group (default 1). */
  weight?: number;
  /** Higher groups are tried first; a lower group only acts when every higher one sums to (nearly) nothing (default 0). */
  priority?: number;
}

/**
 * Combines steering behaviours: weighted blending inside a priority group, and priority arbitration between groups
 * (the first group, highest priority first, whose blended force exceeds `epsilon` wins). The result is clamped to the
 * agent's `maxForce`. Typical use: obstacle avoidance at priority 1, the flock or the path at 0.
 */
export class Steering<A extends SteeringAgent = SteeringAgent> {
  private readonly entries: { behavior: SteeringBehavior<A>; weight: number; priority: number; order: number }[] = [];
  private readonly scratch: MutableVec3 = [0, 0, 0];
  /** @param epsilon A group whose blended force is at most this long counts as idle (default 1e-4). */
  constructor(readonly epsilon = 1e-4) {
    positive(epsilon, 'Steering epsilon', true);
  }
  /** Add a behaviour; returns this for chaining. */
  add(behavior: SteeringBehavior<A>, entry: SteeringEntry = {}): this {
    if (typeof behavior !== 'function')
      throw new TypeError('Steering behaviour must be a function (agent, out) => void');
    const weight = entry.weight ?? 1,
      priority = entry.priority ?? 0;
    if (!Number.isFinite(weight)) throw new RangeError('Steering weight must be a finite number');
    if (!Number.isFinite(priority)) throw new RangeError('Steering priority must be a finite number');
    this.entries.push({ behavior, weight, priority, order: this.entries.length });
    this.entries.sort((a, b) => b.priority - a.priority || a.order - b.order);
    return this;
  }
  /** The steering force for `agent`, written into `out`. */
  compute(agent: A, out: MutableVec3 = [0, 0, 0]): MutableVec3 {
    const entries = this.entries,
      f = this.scratch;
    set(out, 0, 0, 0);
    for (let i = 0; i < entries.length; ) {
      const priority = entries[i].priority;
      let x = 0,
        y = 0,
        z = 0;
      for (; i < entries.length && entries[i].priority === priority; i++) {
        set(f, 0, 0, 0);
        entries[i].behavior(agent, f);
        if (!Number.isFinite(f[0]) || !Number.isFinite(f[1]) || !Number.isFinite(f[2]))
          throw new RangeError('A steering behaviour wrote a non-finite force; check its inputs');
        const w = entries[i].weight;
        x += f[0] * w;
        y += f[1] * w;
        z += f[2] * w;
      }
      if (Math.hypot(x, y, z) > this.epsilon) {
        set(out, x, y, z);
        break;
      }
    }
    return truncate(out, agent.maxForce ?? Number.POSITIVE_INFINITY);
  }
}

function truncate(v: MutableVec3, limit: number): MutableVec3 {
  const length = Math.hypot(v[0], v[1], v[2]);
  if (length > limit) {
    const s = limit / length;
    v[0] *= s;
    v[1] *= s;
    v[2] *= s;
  }
  return v;
}

/**
 * Apply a steering force for `delta` seconds (semi-implicit Euler): velocity += force * delta, clamped to `maxSpeed`
 * (and the force to `maxForce`), then position += velocity * delta. Writes the agent's own arrays.
 */
export function integrate(agent: SteeringAgent, force: Vec3, delta: number): void {
  const max = speed(agent);
  vector(force, 'Steering force');
  positive(delta, 'Integrate delta', true);
  const f = truncate([force[0], force[1], force[2]], agent.maxForce ?? Number.POSITIVE_INFINITY),
    v = agent.velocity,
    p = agent.position;
  v[0] += f[0] * delta;
  v[1] += f[1] * delta;
  v[2] += f[2] * delta;
  const s = Math.hypot(v[0], v[1], v[2]);
  if (s > max) {
    const k = max / s;
    v[0] *= k;
    v[1] *= k;
    v[2] *= k;
  }
  p[0] += v[0] * delta;
  p[1] += v[1] * delta;
  p[2] += v[2] * delta;
}

/** Writable numeric arrays, one per axis: ECS component fields (`component.fields.x`), typed arrays or plain arrays. */
export interface FlockArrays {
  x: { [index: number]: number; readonly length: number };
  y: { [index: number]: number; readonly length: number };
  z: { [index: number]: number; readonly length: number };
  vx: { [index: number]: number; readonly length: number };
  vy: { [index: number]: number; readonly length: number };
  vz: { [index: number]: number; readonly length: number };
}

/** Options of {@link flock}. Every field has a default. */
export interface FlockOptions {
  /** Neighbourhood radius, world units (default 2). */
  radius?: number;
  /** Separation is felt only nearer than this (default `radius / 2`). */
  separationRadius?: number;
  /** Separation weight (default 1.5). */
  separation?: number;
  /** Alignment weight (default 1). */
  alignment?: number;
  /** Cohesion weight (default 1). */
  cohesion?: number;
  /** Top speed (default 3). */
  maxSpeed?: number;
  /** Largest steering force (default 6). */
  maxForce?: number;
}

/**
 * Step a whole flock stored as structure-of-arrays (ECS component fields fit as they are) by `delta` seconds:
 * separation, alignment and cohesion over the neighbours within `radius`, found with a uniform grid, then integration.
 * Forces are computed for every boid before any moves, so the result does not depend on the row order beyond
 * floating-point summation order, and the same input always gives the same output.
 */
export function flock(arrays: FlockArrays, count: number, options: FlockOptions = {}, delta = 1 / 60): void {
  const radius = positive(options.radius ?? 2, 'Flock radius'),
    separationRadius = positive(options.separationRadius ?? radius / 2, 'Flock separationRadius'),
    ws = positive(options.separation ?? 1.5, 'Flock separation weight', true),
    wa = positive(options.alignment ?? 1, 'Flock alignment weight', true),
    wc = positive(options.cohesion ?? 1, 'Flock cohesion weight', true),
    max = positive(options.maxSpeed ?? 3, 'Flock maxSpeed', true),
    maxForce = positive(options.maxForce ?? 6, 'Flock maxForce', true);
  positive(delta, 'Flock delta', true);
  if (!Number.isInteger(count) || count < 0) throw new RangeError('Flock count must be a whole number of 0 or more');
  const { x, y, z, vx, vy, vz } = arrays ?? ({} as FlockArrays);
  for (const [name, array] of Object.entries({ x, y, z, vx, vy, vz }))
    if (array == null || !(array.length >= count))
      throw new RangeError(`Flock array ${name} must hold at least count values`);
  for (let i = 0; i < count; i++)
    if (![x[i], y[i], z[i], vx[i], vy[i], vz[i]].every(Number.isFinite))
      throw new RangeError(`Flock boid ${i} has a non-finite position or velocity; give every boid finite numbers`);
  // Uniform grid keyed by integer cell; cells hold boid indices in row order. A cell spans the larger of the two radii,
  // so the 27 cells around a boid hold every neighbour either rule can feel.
  const reach = Math.max(radius, separationRadius),
    cells = new Map<string, number[]>(),
    key = (cx: number, cy: number, cz: number): string => `${cx},${cy},${cz}`;
  for (let i = 0; i < count; i++) {
    const k = key(Math.floor(x[i] / reach), Math.floor(y[i] / reach), Math.floor(z[i] / reach));
    let cell = cells.get(k);
    if (!cell) cells.set(k, (cell = []));
    cell.push(i);
  }
  const forces = new Float64Array(count * 3),
    r2 = radius * radius,
    s2 = separationRadius * separationRadius;
  const steer = (dx: number, dy: number, dz: number, i: number): [number, number, number] => {
    const l = Math.hypot(dx, dy, dz);
    if (l < 1e-12) return [0, 0, 0];
    return [(dx / l) * max - vx[i], (dy / l) * max - vy[i], (dz / l) * max - vz[i]];
  };
  for (let i = 0; i < count; i++) {
    const cx = Math.floor(x[i] / reach),
      cy = Math.floor(y[i] / reach),
      cz = Math.floor(z[i] / reach);
    let sx = 0,
      sy = 0,
      sz = 0,
      ns = 0,
      ax = 0,
      ay = 0,
      az = 0,
      mx = 0,
      my = 0,
      mz = 0,
      n = 0;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const cell = cells.get(key(cx + dx, cy + dy, cz + dz));
          if (!cell) continue;
          for (const j of cell) {
            if (j === i) continue;
            const ox = x[i] - x[j],
              oy = y[i] - y[j],
              oz = z[i] - z[j],
              d2 = ox * ox + oy * oy + oz * oz;
            if (d2 < r2) {
              ax += vx[j];
              ay += vy[j];
              az += vz[j];
              mx += x[j];
              my += y[j];
              mz += z[j];
              n++;
            }
            if (d2 < s2 && d2 > 0) {
              sx += ox / d2;
              sy += oy / d2;
              sz += oz / d2;
              ns++;
            }
          }
        }
    if (!n && !ns) continue;
    const s = ns ? steer(sx, sy, sz, i) : [0, 0, 0],
      a = n ? steer(ax, ay, az, i) : [0, 0, 0],
      c = n ? steer(mx / n - x[i], my / n - y[i], mz / n - z[i], i) : [0, 0, 0];
    const f = truncate(
      [s[0] * ws + a[0] * wa + c[0] * wc, s[1] * ws + a[1] * wa + c[1] * wc, s[2] * ws + a[2] * wa + c[2] * wc],
      maxForce,
    );
    forces[i * 3] = f[0];
    forces[i * 3 + 1] = f[1];
    forces[i * 3 + 2] = f[2];
  }
  for (let i = 0; i < count; i++) {
    let ux = vx[i] + forces[i * 3] * delta,
      uy = vy[i] + forces[i * 3 + 1] * delta,
      uz = vz[i] + forces[i * 3 + 2] * delta;
    const s = Math.hypot(ux, uy, uz);
    if (s > max) {
      ux *= max / s;
      uy *= max / s;
      uz *= max / s;
    }
    vx[i] = ux;
    vy[i] = uy;
    vz[i] = uz;
    x[i] += ux * delta;
    y[i] += uy * delta;
    z[i] += uz * delta;
  }
}
