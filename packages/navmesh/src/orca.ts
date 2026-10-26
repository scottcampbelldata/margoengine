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
  /**
   * As a neighbour: false when it does not avoid back (a static or scripted obstacle, a player-driven character), so
   * the agent takes all of the avoidance instead of half. Default true.
   */
  reciprocal?: boolean;
}

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
    (agent.reciprocal !== undefined && typeof agent.reciprocal !== 'boolean')
  )
    throw new RangeError(
      'Invalid ORCA agent: give a safe-integer id, two finite components for position, velocity and preferred, and a finite radius and maxSpeed >= 0',
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
 * Paper section 5.2: the velocity in the disc that minimises the largest violation c_i - n_i . w over all
 * constraints, refining the optimum of constraints 0..first-1 incrementally. Where constraint i's violation exceeds
 * the running maximum, the new optimum has i as (one of) the most violated constraints: maximise n_i . w subject to
 * violation_j(w) <= violation_i(w) for every earlier j, i.e. (n_j - n_i) . w >= c_j - c_i, a 2D problem again.
 */
function leastViolation(count: number, first: number, radius: number): void {
  let worst = 0;
  for (let i = first; i < count; i++) {
    const nx = lines[3 * i],
      nz = lines[3 * i + 1],
      c = lines[3 * i + 2];
    if (c - (nx * bestX + nz * bestZ) <= worst + SLACK) continue;
    let size = 0;
    for (let j = 0; j < i; j++) {
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
 * `agent.maxSpeed` that avoids every neighbor for `horizon` seconds, assuming each neighbor takes half the
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
  if (lines.length < 3 * neighbors.length) {
    const size = 3 * Math.max(neighbors.length, (lines.length / 3) * 2);
    lines = new Float64Array(size);
    ridges = new Float64Array(size);
  }
  const ax = agent.position[0],
    az = agent.position[1],
    vx = agent.velocity[0],
    vz = agent.velocity[1];
  let count = 0;
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
    // Half the responsibility (paper eq. 5): the boundary passes through v + u/2 with normal n. A neighbour that does
    // not avoid back leaves all of it to the agent: v + u, as the paper does for static obstacles.
    const share = other.reciprocal === false ? 1 : 0.5;
    lines[3 * count] = nx;
    lines[3 * count + 1] = nz;
    lines[3 * count + 2] = nx * (vx + ux * share) + nz * (vz + uz * share);
    count++;
  }
  const speed = agent.maxSpeed,
    failed = solve(lines, count, speed, agent.preferred[0], agent.preferred[1], false);
  if (failed < count) leastViolation(count, failed, speed);
  output[0] = bestX;
  output[1] = bestZ;
  return output;
}
