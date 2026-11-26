// Optimal reciprocal collision avoidance: J. van den Berg, S. J. Guy, M. Lin and D. Manocha, "Reciprocal n-Body
// Collision Avoidance", ISRR 2009 (Springer STAR 70, 2011). Section 4 builds one half-plane of permitted velocities per
// neighbour from the velocity obstacle truncated at the time horizon; section 5 picks the permitted velocity closest to
// the preferred one inside the speed disc, and 5.2 minimises the largest violation when no velocity is permitted.
//
// Constraints are stored as unit normal n and offset c, meaning n . w >= c for a velocity w. The solver is the
// incremental method of the paper (and of Seidel-style LP in general): when the running optimum breaks a new
// constraint, the new optimum lies on that constraint's boundary line, which is a 1D problem over an interval.

/**
 * A disc agent for `avoid`, in the XZ plane (world units, seconds). Invalid fields make `avoid` throw a
 * RangeError.
 */
export interface Agent {
  /** Safe integer identity; neighbors with the agent's own id are skipped. */
  id: number;
  /** Current XZ position. */
  position: readonly [number, number];
  /** Current XZ velocity in world units per second. */
  velocity: readonly [number, number];
  /** Desired XZ velocity in world units per second. */
  preferred: readonly [number, number];
  /** Disc radius in world units, non-negative. */
  radius: number;
  /** Speed limit in world units per second, non-negative. */
  maxSpeed: number;
  /** Positive inertial mass in kg (default 75). A lighter reciprocal agent takes more of a correction. */
  mass?: number;
  /**
   * As a neighbour: false when it does not avoid back (a static or scripted obstacle, a player-driven character), so
   * the agent takes all of the avoidance instead of half. Default true.
   */
  reciprocal?: boolean;
}

export const DEFAULT_AGENT_MASS = 75;

/** Below this |sin| between two boundary lines they count as parallel (our own floor, unit normals). */
const PARALLEL = 1e-9;
/** Slack for "this constraint already holds" and for parallel infeasibility, in velocity units. */
const SLACK = 1e-12;

/** ORCA half-planes for the current call, three numbers each (nx, nz, c); grows, never shrinks. */
let lines = new Float64Array(3 * 16);
/** Scratch for the minimax step: the same layout, one entry per earlier constraint. */
let ridges = new Float64Array(3 * 16);
/** Result of the last `solve` call. */
let bestX = 0,
  bestZ = 0;

const vector = (v: unknown): boolean => {
  if (v == null || (v as ArrayLike<number>).length !== 2) return false;
  const x = (v as ArrayLike<number>)[0],
    z = (v as ArrayLike<number>)[1];
  return typeof x === 'number' && typeof z === 'number' && Number.isFinite(x) && Number.isFinite(z);
};
function check(agent: Agent): void {
  if (
    agent == null ||
    !Number.isSafeInteger(agent.id) ||
    !vector(agent.position) ||
    !vector(agent.velocity) ||
    !vector(agent.preferred) ||
    typeof agent.radius !== 'number' ||
    !(agent.radius >= 0) ||
    !Number.isFinite(agent.radius) ||
    typeof agent.maxSpeed !== 'number' ||
    !(agent.maxSpeed >= 0) ||
    !Number.isFinite(agent.maxSpeed) ||
    (agent.mass !== undefined && !(Number.isFinite(agent.mass) && agent.mass > 0)) ||
    (agent.reciprocal !== undefined && typeof agent.reciprocal !== 'boolean')
  )
    throw new RangeError(
      'Invalid ORCA agent: give a safe-integer id, two finite components for position, velocity and preferred, finite radius and maxSpeed >= 0, and positive finite mass when supplied',
    );
}

/**
 * Optimum over the disc |w| <= radius and constraints 0..count-1 of `set`. With `linear` false the objective is the
 * point closest to (tx, tz); with `linear` true it is the point furthest along the unit direction (tx, tz).
 * Leaves the optimum in bestX/bestZ and returns `count`, or the index of the first constraint that made the
 * problem infeasible (bestX/bestZ then hold the optimum of the constraints before it).
 */
function solve(set: Float64Array, count: number, radius: number, tx: number, tz: number, linear: boolean): number {
  if (linear) {
    bestX = tx * radius;
    bestZ = tz * radius;
  } else {
    const length = Math.hypot(tx, tz);
    const scale = length > radius ? radius / length : 1;
    bestX = tx * scale;
    bestZ = tz * scale;
  }
  for (let k = 0; k < count; k++) {
    const nx = set[3 * k],
      nz = set[3 * k + 1],
      c = set[3 * k + 2];
    if (nx * bestX + nz * bestZ >= c - SLACK) continue;
    // The boundary line is {c n + t d}, with d = n turned a quarter turn; c n is its point nearest the origin.
    const dx = -nz,
      dz = nx,
      half = radius * radius - c * c;
    if (half < 0) return k;
    let low = -Math.sqrt(half),
      high = -low;
    for (let j = 0; j < k; j++) {
      const mx = set[3 * j],
        mz = set[3 * j + 1],
        along = mx * dx + mz * dz,
        need = set[3 * j + 2] - c * (mx * nx + mz * nz);
      if (Math.abs(along) < PARALLEL) {
        if (need > SLACK) return k;
        continue;
      }
      const t = need / along;
      if (along > 0) low = Math.max(low, t);
      else high = Math.min(high, t);
      if (low > high) return k;
    }
    let t: number;
    if (linear) {
      const gain = tx * dx + tz * dz;
      t = gain > PARALLEL ? high : gain < -PARALLEL ? low : Math.min(high, Math.max(low, bestX * dx + bestZ * dz));
    } else t = Math.min(high, Math.max(low, tx * dx + tz * dz));
    bestX = c * nx + t * dx;
    bestZ = c * nz + t * dz;
  }
  return count;
}

/**
 * Paper section 5.2: the velocity in the disc that minimises the largest violation c_i - n_i . w over the soft
 * constraints, refining the optimum of constraints 0..first-1 incrementally. Where constraint i's violation exceeds
 * the running maximum, the new optimum has i as (one of) the most violated constraints: maximise n_i . w subject to
 * violation_j(w) <= violation_i(w) for every earlier soft j, i.e. (n_j - n_i) . w >= c_j - c_i, a 2D problem again.
 * The first `hard` constraints (walls; section 5.4: the constraints of obstacles are not relaxed) join every such
 * problem unchanged.
 */
function leastViolation(count: number, first: number, radius: number, hard: number): void {
  let worst = 0;
  for (let i = Math.max(first, hard); i < count; i++) {
    const nx = lines[3 * i],
      nz = lines[3 * i + 1],
      c = lines[3 * i + 2];
    if (c - (nx * bestX + nz * bestZ) <= worst + SLACK) continue;
    ridges.set(lines.subarray(0, 3 * hard));
    let size = hard;
    for (let j = hard; j < i; j++) {
      const mx = lines[3 * j] - nx,
        mz = lines[3 * j + 1] - nz,
        length = Math.hypot(mx, mz);
      // Same normal: the two violations differ by a constant and j's is already the smaller one.
      if (length < PARALLEL) continue;
      ridges[3 * size] = mx / length;
      ridges[3 * size + 1] = mz / length;
      ridges[3 * size + 2] = (lines[3 * j + 2] - c) / length;
      size++;
    }
    const keepX = bestX,
      keepZ = bestZ;
    // The running optimum is feasible here, so a failure can only come from rounding; keep it then.
    if (solve(ridges, size, radius, nx, nz, true) < size) {
      bestX = keepX;
      bestZ = keepZ;
    }
    worst = c - (nx * bestX + nz * bestZ);
  }
}

/**
 * Reciprocal velocity-obstacle avoidance (ORCA) in XZ: the velocity closest to `agent.preferred` within
 * `agent.maxSpeed` that avoids every neighbor for `horizon` seconds, assuming each neighbor takes its mass-weighted part of the
 * responsibility. When no such velocity exists (crowded or overlapping agents) it returns the velocity within
 * `maxSpeed` that breaks the constraints least. Neighbors with the agent's own `id` are skipped. Synchronous,
 * allocation-free on steady ticks, and not re-entrant.
 * @param delta Simulation step in seconds; overlapping agents are pushed apart within one step.
 * @param horizon Look-ahead time in seconds.
 * @param output Receives the velocity (x, z) and is returned.
 * @throws RangeError for an invalid agent or neighbor, `delta` or `horizon` not finite and > 0, an `output` that is
 * not length 2, or more than 4096 neighbors.
 */
export function avoid(
  agent: Agent,
  neighbors: readonly Agent[],
  delta = 1 / 60,
  horizon = 2,
  output = new Float64Array(2),
): Float64Array {
  return avoidAmong(agent, neighbors, NO_WALLS, 0, delta, horizon, output);
}

const NO_WALLS = new Float64Array(0);

/**
 * {@link avoid} with hard half-planes first: `walls` holds `wallCount` triples (nx, nz, c), each meaning n . w >= c
 * for the chosen velocity w, as {@link wallLine} builds them. They are not relaxed while some velocity meets them all;
 * the agents' constraints are relaxed instead (paper section 5.4). For the Crowd.
 * @internal
 */
export function avoidAmong(
  agent: Agent,
  neighbors: readonly Agent[],
  walls: Float64Array,
  wallCount: number,
  delta: number,
  horizon: number,
  output: Float64Array,
): Float64Array {
  check(agent);
  if (
    !(delta > 0) ||
    !Number.isFinite(delta) ||
    !(horizon > 0) ||
    !Number.isFinite(horizon) ||
    output == null ||
    output.length !== 2 ||
    neighbors == null ||
    !(neighbors.length <= 4096)
  )
    throw new RangeError(
      'Invalid ORCA timestep or neighbor budget: delta and horizon must be finite seconds > 0, output a length-2 array, and neighbors at most 4096',
    );
  const total = neighbors.length + wallCount;
  if (lines.length < 3 * total) {
    const size = 3 * Math.max(total, (lines.length / 3) * 2);
    lines = new Float64Array(size);
    ridges = new Float64Array(size);
  }
  lines.set(walls.subarray(0, 3 * wallCount));
  const ax = agent.position[0],
    az = agent.position[1],
    vx = agent.velocity[0],
    vz = agent.velocity[1];
  let count = wallCount;
  for (let i = 0; i < neighbors.length; i++) {
    const other = neighbors[i];
    check(other);
    if (other.id === agent.id) continue;
    // Relative position and velocity as seen by the agent.
    const px = other.position[0] - ax,
      pz = other.position[1] - az,
      rx = vx - other.velocity[0],
      rz = vz - other.velocity[1],
      reach = agent.radius + other.radius,
      distance2 = px * px + pz * pz;
    let ux: number, uz: number, nx: number, nz: number;
    if (distance2 > reach * reach) {
      // Truncated cone: cutoff disc of radius reach/horizon at p/horizon, tangent legs from the origin.
      const wx = rx - px / horizon,
        wz = rz - pz / horizon,
        toward = wx * px + wz * pz,
        w2 = wx * wx + wz * wz;
      if (toward < 0 && toward * toward > reach * reach * w2) {
        // Nearest boundary point is on the cutoff arc: push along the arc normal.
        const w = Math.sqrt(w2);
        nx = wx / w;
        nz = wz / w;
        const push = reach / horizon - w;
        ux = nx * push;
        uz = nz * push;
      } else {
        // Nearest boundary point is on a leg; the leg on v's side of p (ties take the right-hand leg).
        const tangent = Math.sqrt(distance2 - reach * reach);
        let ex: number, ez: number;
        if (px * wz - pz * wx > 0) {
          ex = (px * tangent - pz * reach) / distance2;
          ez = (px * reach + pz * tangent) / distance2;
          nx = -ez;
          nz = ex;
        } else {
          ex = (px * tangent + pz * reach) / distance2;
          ez = (pz * tangent - px * reach) / distance2;
          nx = ez;
          nz = -ex;
        }
        const along = rx * ex + rz * ez;
        ux = along * ex - rx;
        uz = along * ez - rz;
      }
    } else {
      // Already overlapping: cutoff disc of radius reach/delta at p/delta, so the pair separates within one step.
      const wx = rx - px / delta,
        wz = rz - pz / delta,
        w = Math.hypot(wx, wz);
      if (w > 0) {
        nx = wx / w;
        nz = wz / w;
      } else {
        // Coincident with equal velocities: opposite fixed directions for the two agents of the pair.
        nx = agent.id < other.id ? -1 : 1;
        nz = 0;
      }
      const push = reach / delta - w;
      ux = nx * push;
      uz = nz * push;
    }
    const ownMass = agent.mass ?? DEFAULT_AGENT_MASS;
    const otherMass = other.mass ?? DEFAULT_AGENT_MASS;
    // Partition u by the smallest mass-weighted change in kinetic velocity. Static
    // obstacles still put the entire relative-velocity correction on the moving agent.
    const scale = Math.max(ownMass, otherMass);
    const share = other.reciprocal === false ? 1 : otherMass / scale / (ownMass / scale + otherMass / scale);
    lines[3 * count] = nx;
    lines[3 * count + 1] = nz;
    lines[3 * count + 2] = nx * (vx + ux * share) + nz * (vz + uz * share);
    count++;
  }
  const speed = agent.maxSpeed,
    failed = solve(lines, count, speed, agent.preferred[0], agent.preferred[1], false);
  // Walls that leave no velocity at all (an agent wedged into a gap narrower than itself) are relaxed with the rest.
  if (failed < count) leastViolation(count, failed, speed, failed < wallCount ? 0 : wallCount);
  output[0] = bestX;
  output[1] = bestZ;
  return output;
}

/**
 * The ORCA half-plane of one wall segment from (ax, az) to (bx, bz) for an agent centre at (px, pz) that must stay on
 * its walkable side (paper section 5.4, equation 11, with radius 0: the navmesh border bounds the centre). The velocity
 * obstacle within `horizon` seconds is the segment as seen from the agent scaled by 1 / t for every t up to `horizon`;
 * with the optimisation velocity 0 of obstacles, the permitted half-plane is bounded by the tangent at the point of it
 * nearest 0, which is the segment's nearest point c scaled by 1 / horizon: the agent may close on c at no more than
 * d / horizon (d its distance from c) and slides along the wall freely, and 0 is always permitted. Only a wall the
 * agent stands in front of gives one: where the nearest point is an end of the segment, that end is a corner of the
 * border, and its half-plane would brake every agent walking at it, as every route corner on the border has it do;
 * the wall the agent passes in front of next takes over, and in a corner of a room the agent always stands in front
 * of one of its two walls. `inwardX`/`inwardZ` (unit, toward the walkable side) is the normal for an agent on the
 * wall. Writes (nx, nz, c), meaning n . w >= c, at `out[at..at+2]` and returns d, or Infinity for no half-plane.
 * @internal
 */
export function wallLine(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  inwardX: number,
  inwardZ: number,
  horizon: number,
  out: Float64Array,
  at: number,
): number {
  const ex = bx - ax,
    ez = bz - az,
    t = ((px - ax) * ex + (pz - az) * ez) / (ex * ex + ez * ez);
  // An agent level with an end of the wall (within a micrometre, as a route running along the wall's line is) is past
  // it: the end is a corner, and closing on it more slowly the nearer the agent comes would never let it round it.
  const slack = 1e-6 / Math.sqrt(ex * ex + ez * ez);
  if (t < slack || t > 1 - slack) return Infinity;
  const dx = px - ax - t * ex,
    dz = pz - az - t * ez,
    d = Math.hypot(dx, dz);
  // Standing on the corner itself: the walls on either side of it hold the agent once it is in front of them.
  if (d < 1e-6 && (t < 1e-6 || t > 1 - 1e-6)) return Infinity;
  out[at] = d > 1e-6 ? dx / d : inwardX;
  out[at + 1] = d > 1e-6 ? dz / d : inwardZ;
  out[at + 2] = -d / horizon;
  return d;
}

/**
 * The velocity nearest (tx, tz) within `most` of (vx, vz), the current velocity, that keeps the first `count` wall
 * half-planes of `walls`: ORCA's choice limited by the agent's acceleration without breaking a wall, the same linear
 * program in coordinates centred on the current velocity. When no such velocity exists (the walls need a larger change
 * than the acceleration allows), the walls win: the point of the step toward (tx, tz) nearest the current velocity that
 * keeps them, or (tx, tz) itself. Writes the velocity to `output`.
 * @internal
 */
export function accelerate(
  vx: number,
  vz: number,
  tx: number,
  tz: number,
  most: number,
  walls: Float64Array,
  count: number,
  output: Float64Array,
): Float64Array {
  if (ridges.length < 3 * count) ridges = new Float64Array(3 * Math.max(count, (ridges.length / 3) * 2));
  for (let k = 0; k < count; k++) {
    const nx = walls[3 * k],
      nz = walls[3 * k + 1];
    ridges[3 * k] = nx;
    ridges[3 * k + 1] = nz;
    ridges[3 * k + 2] = walls[3 * k + 2] - nx * vx - nz * vz;
  }
  if (solve(ridges, count, most, tx - vx, tz - vz, false) === count) {
    output[0] = vx + bestX;
    output[1] = vz + bestZ;
    return output;
  }
  let t = 0;
  const ax = tx - vx,
    az = tz - vz;
  for (let k = 0; k < count; k++) {
    const gain = walls[3 * k] * ax + walls[3 * k + 1] * az,
      short = ridges[3 * k + 2];
    if (short > 0) t = gain >= short ? Math.max(t, short / gain) : 1;
  }
  output[0] = vx + ax * t;
  output[1] = vz + az * t;
  return output;
}
