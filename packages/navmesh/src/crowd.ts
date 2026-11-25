/// <reference lib="esnext.disposable" preserve="true" />
// A crowd manager on a NavMesh: agents plan with A* and the funnel, steer toward their next corner, avoid each other
// and dynamic obstacles with ORCA, stay on the walkable polygons and cross off-mesh links. Kept out of NavMesh so an
// app that only queries paths does not bundle it.
import { MargoError } from '@margoengine/math/errors';
import type { NavFilter, NavSurface, Vec3 } from './index.js';
import { accelerate, avoidAmong, wallLine, type Agent } from './orca.js';

/** Where a crowd agent is in its journey. */
export type CrowdAgentState = 'idle' | 'moving' | 'offmesh' | 'arrived' | 'unreachable';

/** Options of {@link Crowd.addAgent}. Every field but `position` has a default. */
export interface CrowdAgentOptions {
  /** Start position; it is moved onto the mesh. */
  position: Vec3;
  /** Disc radius, world units (default 0.4). */
  radius?: number;
  /** Top speed, world units per second (default 3.5). */
  maxSpeed?: number;
  /** Largest change of velocity per second (default 8). */
  maxAcceleration?: number;
  /** Distance from the target at which the agent arrives and stops (default 0.1). */
  arrivalDistance?: number;
  /** Distance from the target over which it slows down (default 1). */
  slowDownDistance?: number;
  /** Anything to keep with the agent (a character, an entity id). */
  userData?: unknown;
  /** The mesh this agent walks on, for a body of another size than the crowd's mesh (default the crowd's). */
  navMesh?: NavSurface;
  /** What it may walk on: cost per area number (default all the same). */
  filter?: NavFilter;
}

/** Options of {@link Crowd}. Every field has a default. */
export interface CrowdOptions {
  /** Other agents and obstacles nearer than this are avoided (default 5). */
  neighborDistance?: number;
  /** Most neighbours each agent avoids, the nearest first (default 10). */
  maxNeighbors?: number;
  /** How far ahead avoidance looks, seconds (default 2). */
  timeHorizon?: number;
  /**
   * Walkers slow down in a dense crowd as measured pedestrians do: each agent's speed toward its next corner is capped
   * at `maxSpeed (1 - e^(-gamma (1 / rho - 1 / jam)))` (Weidmann 1993), rho the density of the people ahead of it, so a
   * crowd of hundreds keeps the speeds and flows of real crowds instead of every agent walking at full speed. `true` uses
   * Weidmann's fit, in metres; pass {@link CrowdDensityOptions} for another. Default false: agents keep their own speed.
   */
  density?: boolean | CrowdDensityOptions;
}

/** Weidmann's speed and density relation for {@link CrowdOptions.density}. Every field has a default. */
export interface CrowdDensityOptions {
  /** How fast speed falls with density, square world units (default 1.913, Weidmann's fit in m^2). */
  gamma?: number;
  /** Density at which a crowd stands still, people per square world unit (default 5.4, Weidmann's per m^2). */
  jam?: number;
  /** Width of the Gaussian that measures density round an agent, world units (default 1, in m). */
  radius?: number;
}

/** A dynamic obstacle for {@link Crowd.addObstacle}: a disc in XZ that agents steer around and do not push. */
export interface CrowdObstacle {
  /** Centre, world space (its height is ignored). */
  position: Vec3;
  /** Disc radius, world units. */
  radius: number;
  /** Velocity of a moving obstacle (a door swinging, a cart), world units per second (default still). */
  velocity?: Vec3;
}

/** Events a {@link Crowd} emits, keyed by type. */
export interface CrowdEventMap {
  /** An agent reached its target. */
  arrive: CrowdAgent;
  /** An agent's target has no route (off the mesh, blocked or disconnected). */
  unreachable: CrowdAgent;
}

/** A number for cell (i, j) of the density grid, unique for |i|, |j| below 2^20. */
const cellKey = (i: number, j: number): number => (i + 1048576) * 2097152 + (j + 1048576);
const positive = (value: number | undefined, fallback: number, label: string, zero = false): number => {
  const v = value ?? fallback;
  if (!(zero ? v >= 0 : v > 0) || !Number.isFinite(v))
    throw new RangeError(`${label} must be a finite number ${zero ? 'of 0 or more' : 'above 0'}`);
  return v;
};
/** XZ distance from (px, pz) to the segment from (ax, az) to (bx, bz). */
const segmentDistance = (px: number, pz: number, ax: number, az: number, bx: number, bz: number): number => {
  const ex = bx - ax,
    ez = bz - az,
    length2 = ex * ex + ez * ez,
    t = length2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * ex + (pz - az) * ez) / length2)) : 0;
  return Math.hypot(px - ax - t * ex, pz - az - t * ez);
};
const point = (value: unknown, label: string): Vec3 => {
  const v = value as ArrayLike<number> | null;
  if (!v || v.length !== 3 || !Number.isFinite(v[0]) || !Number.isFinite(v[1]) || !Number.isFinite(v[2]))
    throw new RangeError(`${label} must be [x, y, z] with finite numbers`);
  return [v[0], v[1], v[2]];
};

/** One agent of a {@link Crowd}. Read its pose every frame; steer it with `setTarget` and `stop`. */
export class CrowdAgent {
  /** Current position on the mesh. */
  readonly position: [number, number, number];
  /** Current velocity (XZ; y is 0). */
  readonly velocity: [number, number, number] = [0, 0, 0];
  /** Where it is in its journey. */
  state: CrowdAgentState = 'idle';
  /** The target it is walking to, or null. */
  target: Vec3 | null = null;
  /** Its current route corners (empty without a target). */
  path: Vec3[] = [];
  /** Whether the current route ends at the nearest reachable point instead of the requested target. */
  partial = false;
  /** Anything kept with the agent. */
  userData: unknown;
  readonly radius: number;
  maxSpeed: number;
  maxAcceleration: number;
  arrivalDistance: number;
  slowDownDistance: number;
  /** @internal next corner index into `path`. */
  corner = 1;
  /** @internal indices of `path` where an off-mesh link starts. */
  links: number[] = [];
  /** @internal polygon under the agent. */
  polygon: number;
  /** @internal mesh version the path was planned on (-1: plan again). */
  planned = -1;
  /** @internal mesh version the agent last stood on. */
  seen: number;
  /** @internal this frame's wall half-planes (nx, nz, c), the first `wallCount` of them. */
  walls = new Float64Array(3 * 16);
  /** @internal */
  wallCount = 0;
  /** @internal seconds ahead the walls are avoided: the time the agent takes to stop from its top speed. */
  wallHorizon = 1;
  /** The mesh it walks on. */
  readonly surface: NavSurface;
  /** Its cost per area number, if any. */
  readonly filter: NavFilter | undefined;
  /** @internal the ORCA disc. */
  readonly disc: {
    id: number;
    position: [number, number];
    velocity: [number, number];
    preferred: [number, number];
    radius: number;
    maxSpeed: number;
  };
  private removed = false;

  /** @internal */
  constructor(
    private readonly crowd: Crowd,
    readonly id: number,
    options: CrowdAgentOptions,
    position: Vec3,
    polygon: number,
    surface: NavSurface,
  ) {
    this.position = [position[0], position[1], position[2]];
    this.polygon = polygon;
    this.surface = surface;
    this.seen = surface.version;
    this.filter = options.filter;
    this.radius = positive(options.radius, 0.4, 'Agent radius');
    this.maxSpeed = positive(options.maxSpeed, 3.5, 'Agent maxSpeed', true);
    this.maxAcceleration = positive(options.maxAcceleration, 8, 'Agent maxAcceleration');
    this.arrivalDistance = positive(options.arrivalDistance, 0.1, 'Agent arrivalDistance');
    this.slowDownDistance = positive(options.slowDownDistance, 1, 'Agent slowDownDistance', true);
    this.userData = options.userData;
    this.disc = {
      id,
      position: [position[0], position[2]],
      velocity: [0, 0],
      preferred: [0, 0],
      radius: this.radius,
      maxSpeed: this.maxSpeed,
    };
  }
  /** False after `remove()` or the crowd's `dispose()`. */
  get valid(): boolean {
    return !this.removed;
  }
  /** Walks to `target` (moved onto the mesh); the route is planned on the next update. */
  setTarget(target: Vec3): this {
    this.check();
    this.target = point(target, 'Agent target');
    this.planned = -1;
    this.partial = false;
    this.state = 'moving';
    return this;
  }
  /** Stops where it is and forgets its target. */
  stop(): this {
    this.check();
    this.target = null;
    this.path = [];
    this.partial = false;
    this.links = [];
    this.state = 'idle';
    return this;
  }
  /** Places the agent at `position` (moved onto the mesh) and replans. */
  teleport(position: Vec3): this {
    this.check();
    const placed = this.crowd.place(point(position, 'Agent position'), this.surface);
    this.position[0] = placed.point[0];
    this.position[1] = placed.point[1];
    this.position[2] = placed.point[2];
    this.polygon = placed.polygon;
    this.velocity.fill(0);
    this.planned = -1;
    return this;
  }
  /** Removes the agent from its crowd. */
  remove(): void {
    if (this.removed) return;
    this.removed = true;
    this.crowd.removeAgent(this);
  }
  /** @internal */
  markRemoved(): void {
    this.removed = true;
  }
  private check(): void {
    if (this.removed) throw new MargoError('state', 'Crowd agent was removed; add a new one with crowd.addAgent.');
  }
}

/**
 * A crowd of agents walking on a {@link NavMesh}. `update(dt)` once per frame (or fixed step) plans routes, steers
 * every agent toward its next corner, slows it for arrival, avoids other agents and obstacles with ORCA (reciprocal
 * between agents, one-sided for obstacles), keeps it on the mesh and walks it across off-mesh links. Agents replan
 * when the mesh's area costs or links change. `using` works.
 */
export class Crowd {
  /** The agents, in the order they were added. */
  readonly agents: CrowdAgent[] = [];
  private readonly obstacles = new Map<number, CrowdObstacle>();
  private readonly listeners = new Map<keyof CrowdEventMap, Set<(event: never) => void>>();
  private readonly neighborDistance: number;
  private readonly density?: { readonly gamma: number; readonly jam: number; readonly radius: number };
  private readonly cells = new Map<number, CrowdAgent[]>();
  private readonly maxNeighbors: number;
  private readonly timeHorizon: number;
  private nextId = 1;
  private disposed = false;
  private readonly output = new Float64Array(2);
  private readonly neighbors: Agent[] = [];
  private readonly obstacleDiscs: Agent[] = [];
  private readonly candidates: { agent: Agent; distance: number }[] = [];
  /** Scratch of gatherWalls: polygons to visit, those already queued, and open spans of one edge. */
  private readonly queue: number[] = [];
  private readonly seen = new Set<number>();
  private readonly spans: number[] = [];

  /**
   * @param navMesh The walkable polygons the agents stay on: a `NavMesh` or a tiled mesh.
   * @param options Avoidance settings.
   */
  constructor(
    readonly navMesh: NavSurface,
    options: CrowdOptions = {},
  ) {
    if (typeof navMesh?.route !== 'function')
      throw new TypeError('A crowd needs a NavMesh: new Crowd(new NavMesh(vertices, polygons)).');
    this.neighborDistance = positive(options.neighborDistance, 5, 'Crowd neighborDistance');
    const density = options.density;
    if (density !== undefined && typeof density !== 'boolean' && (typeof density !== 'object' || density === null))
      throw new TypeError('Crowd density must be true, false or {gamma, jam, radius}; pass true for Weidmann\'s fit');
    if (density) {
      const fit = density === true ? {} : density;
      this.density = {
        gamma: positive(fit.gamma, 1.913, 'Crowd density gamma'),
        jam: positive(fit.jam, 5.4, 'Crowd density jam'),
        radius: positive(fit.radius, 1, 'Crowd density radius'),
      };
    }
    this.maxNeighbors = options.maxNeighbors ?? 10;
    if (!Number.isInteger(this.maxNeighbors) || this.maxNeighbors < 0 || this.maxNeighbors > 4096)
      throw new RangeError('Crowd maxNeighbors must be an integer from 0 to 4096');
    this.timeHorizon = positive(options.timeHorizon, 2, 'Crowd timeHorizon');
  }

  /** @internal a point moved onto the mesh, with its polygon. */
  place(position: Vec3, surface: NavSurface): { point: Vec3; polygon: number } {
    const placed = surface.closestPoint(position);
    if (!placed) throw new RangeError('Position has no walkable point nearby; place agents on the navmesh.');
    return placed;
  }

  /** Adds an agent at `options.position` (moved onto the mesh). */
  addAgent(options: CrowdAgentOptions): CrowdAgent {
    if (this.disposed) throw new MargoError('disposed', 'Crowd is disposed; create a new Crowd.');
    const surface = options?.navMesh ?? this.navMesh,
      placed = this.place(point(options?.position, 'Agent position'), surface);
    const agent = new CrowdAgent(this, this.nextId++, options, placed.point, placed.polygon, surface);
    this.agents.push(agent);
    return agent;
  }
  /** Removes an agent (same as `agent.remove()`). */
  removeAgent(agent: CrowdAgent): void {
    const index = this.agents.indexOf(agent);
    if (index < 0) return;
    this.agents.splice(index, 1);
    agent.markRemoved();
  }
  /**
   * Adds a dynamic obstacle that agents steer around (a crate, a moving cart). The crowd keeps the object and reads it
   * every update, so move it by writing into `position`. Returns a function that removes it. For a lasting blockage
   * that routes should plan around, block its polygons with `navMesh.setAreaCost(polygon, Infinity)` or rebuild with
   * `@margoengine/navmesh/build` obstacles.
   */
  addObstacle(obstacle: CrowdObstacle): () => void {
    if (this.disposed) throw new MargoError('disposed', 'Crowd is disposed; create a new Crowd.');
    point(obstacle?.position, 'Obstacle position');
    positive(obstacle.radius, 0, 'Obstacle radius');
    if (obstacle.velocity !== undefined) point(obstacle.velocity, 'Obstacle velocity');
    const id = -this.nextId++;
    this.obstacles.set(id, obstacle);
    return () => {
      this.obstacles.delete(id);
    };
  }
  /** Subscribes to arrivals and unreachable targets. Returns an unsubscribe function. */
  on<K extends keyof CrowdEventMap>(type: K, listener: (event: CrowdEventMap[K]) => void): () => void {
    if (typeof listener !== 'function')
      throw new TypeError("Crowd listener must be a function: crowd.on('arrive', (agent) => {})");
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener as (event: never) => void);
    return () => {
      set!.delete(listener as (event: never) => void);
    };
  }
  private emit<K extends keyof CrowdEventMap>(type: K, event: CrowdEventMap[K]): void {
    const set = this.listeners.get(type);
    if (set) for (const listener of [...set]) (listener as (event: CrowdEventMap[K]) => void)(event);
  }

  /** Advances every agent by `dt` seconds. */
  update(dt: number): void {
    if (this.disposed) throw new MargoError('disposed', 'Crowd is disposed; create a new Crowd.');
    if (!(dt >= 0) || !Number.isFinite(dt)) throw new RangeError('Crowd update needs a finite dt of 0 or more seconds');
    if (dt === 0) return;
    // A rebuilt tile renumbers its polygons and may have closed over an agent: stand each one on the mesh again.
    for (const agent of this.agents) {
      if (agent.seen === agent.surface.version || agent.state === 'offmesh') continue;
      agent.seen = agent.surface.version;
      const placed = this.place(agent.position, agent.surface);
      agent.position[0] = placed.point[0];
      agent.position[1] = placed.point[1];
      agent.position[2] = placed.point[2];
      agent.polygon = placed.polygon;
    }
    // 1. Obstacles as one-sided ORCA discs, then each agent's plan and preferred velocity.
    const obstacles = this.obstacleDiscs;
    obstacles.length = 0;
    for (const [id, o] of this.obstacles) {
      const v = o.velocity ?? [0, 0, 0];
      obstacles.push({
        id,
        position: [o.position[0], o.position[2]],
        velocity: [v[0], v[2]],
        preferred: [v[0], v[2]],
        radius: o.radius,
        maxSpeed: Math.hypot(v[0], v[2]),
        reciprocal: false,
      });
    }
    if (this.density) this.bin(this.density.radius * 3);
    for (const agent of this.agents) {
      if (agent.target && (agent.state !== 'arrived' || agent.partial) && agent.planned !== agent.surface.version)
        this.plan(agent, agent.surface.version);
      this.steer(agent, dt);
    }
    // 2. Avoidance: every agent picks its velocity from the same snapshot, then all move.
    const chosen = this.agents.map((agent) => {
      agent.wallCount = 0;
      if (agent.state === 'offmesh') return [agent.disc.preferred[0], agent.disc.preferred[1]];
      const neighbors = this.near(agent);
      this.gatherWalls(agent, dt);
      avoidAmong(agent.disc, neighbors, agent.walls, agent.wallCount, dt, this.timeHorizon, this.output);
      // Limit the change of velocity to maxAcceleration, keeping the walls.
      accelerate(
        agent.velocity[0],
        agent.velocity[2],
        this.output[0],
        this.output[1],
        agent.maxAcceleration * dt,
        agent.walls,
        agent.wallCount,
        this.output,
      );
      return [this.output[0], this.output[1]];
    });
    // 3. Move, staying on the mesh, and arrive.
    this.agents.forEach((agent, i) => this.move(agent, chosen[i][0], chosen[i][1], dt));
  }

  private plan(agent: CrowdAgent, version: number): void {
    agent.planned = version;
    agent.partial = false;
    const target = agent.surface.closestPoint(agent.target!),
      route = agent.surface.partialRoute
        ? agent.surface.partialRoute(agent.position, agent.target!, agent.filter)
        : target && agent.surface.route(agent.position, target.point, agent.filter);
    if (!route) {
      agent.state = 'unreachable';
      agent.path = [];
      agent.links = [];
      this.emit('unreachable', agent);
      return;
    }
    agent.path = route.points;
    agent.partial = route.partial ?? false;
    agent.links = route.offMesh;
    agent.corner = 1;
    if (agent.state !== 'offmesh') agent.state = 'moving';
  }

  private steer(agent: CrowdAgent, dt: number): void {
    const disc = agent.disc,
      p = agent.position;
    disc.position[0] = p[0];
    disc.position[1] = p[2];
    disc.velocity[0] = agent.velocity[0];
    disc.velocity[1] = agent.velocity[2];
    disc.maxSpeed = agent.maxSpeed;
    disc.preferred[0] = disc.preferred[1] = 0;
    if (agent.state !== 'moving' && agent.state !== 'offmesh') return;
    const path = agent.path,
      last = path.length - 1;
    // A corner is passed once it is within reach this frame, or once the point after it can be walked to straight from
    // here, so an agent that avoidance or a wall carried wide of a corner goes on instead of turning back to touch it
    // (the final corner only by arriving; the start of an off-mesh link only by reaching it).
    while (agent.state === 'moving' && agent.corner < last) {
      const c = path[agent.corner],
        reach = Math.max(agent.arrivalDistance, agent.maxSpeed * dt),
        link = agent.links.includes(agent.corner);
      if (
        Math.hypot(c[0] - p[0], c[2] - p[2]) > reach &&
        (link || !this.straight(agent, path[agent.corner + 1][0], path[agent.corner + 1][2]))
      )
        break;
      // Reaching an off-mesh link's start puts the agent on the link toward its landing point.
      agent.state = agent.links.includes(agent.corner) ? 'offmesh' : 'moving';
      agent.corner++;
    }
    const c = path[agent.corner],
      dx = c[0] - p[0],
      dz = c[2] - p[2],
      d = Math.hypot(dx, dz);
    if (d < 1e-9) return;
    let speed = agent.maxSpeed;
    if (agent.corner === last && agent.slowDownDistance > 0) speed *= Math.min(1, d / agent.slowDownDistance);
    let ux = dx / d,
      uz = dz / d;
    if (agent.state === 'offmesh') speed = Math.min(agent.maxSpeed, d / dt);
    else {
      [ux, uz] = this.detour(agent, ux, uz, d, agent.corner === last ? c : null);
      if (this.density) speed = Math.min(speed, agent.maxSpeed * this.crowding(agent, ux, uz));
    }
    disc.preferred[0] = ux * speed;
    disc.preferred[1] = uz * speed;
  }

  /**
   * Steers the preferred direction past the nearest obstacle or standing agent that blocks the way to the next corner:
   * toward the tangent of its disc (grown by the agent's radius) on the side the way already leans to. ORCA alone
   * only slows an agent that heads straight at something that does not move aside, so it would stop in front of it.
   * An agent standing on the target `end` of the last leg (covering it) is not passed but joined (see `joins`): going
   * round it would only carry the agent past its target and back.
   */
  private detour(agent: CrowdAgent, ux: number, uz: number, reach: number, end: Vec3 | null): [number, number] {
    const px = agent.position[0],
      pz = agent.position[2];
    let best = Infinity,
      cx = 0,
      cz = 0,
      radius = 0;
    const consider = (x: number, z: number, r: number) => {
      const ox = x - px,
        oz = z - pz,
        along = ox * ux + oz * uz,
        side = ox * uz - oz * ux,
        grown = r + agent.radius;
      // Ahead, before the corner, and across the way.
      if (along <= 0 || along - grown > reach || Math.abs(side) >= grown || along >= best) return;
      best = along;
      cx = ox;
      cz = oz;
      radius = grown;
    };
    for (const o of this.obstacleDiscs) consider(o.position[0], o.position[1], o.radius);
    for (const other of this.agents)
      if (
        other !== agent &&
        (other.state === 'idle' || other.state === 'arrived') &&
        !(end && Math.hypot(other.position[0] - end[0], other.position[2] - end[2]) < other.radius + agent.radius)
      )
        consider(other.position[0], other.position[2], other.radius);
    if (best === Infinity) return [ux, uz];
    const distance = Math.hypot(cx, cz);
    if (distance <= radius) return [ux, uz]; // already touching: ORCA separates them
    // Turn from the centre direction by the tangent angle, away from the side the centre is on (left on a tie).
    const angle = Math.asin(Math.min(1, (radius * 1.05) / distance)),
      sign = cx * uz - cz * ux > 0 ? 1 : -1,
      bx = cx / distance,
      bz = cz / distance,
      cos = Math.cos(angle * sign),
      sin = Math.sin(angle * sign);
    return [bx * cos - bz * sin, bx * sin + bz * cos];
  }

  /**
   * Whether `agent`, on the last leg to `end` and moving at (vx, vz) this step, has joined the people already there:
   * those that cover `end` (stand within the two radii of it, so `agent` cannot stand there) and stand still or walk
   * nearer `end` (they get there first; the lower id on a tie), and those that arrived for the same place (their own
   * target within the two radii of `end`). It has joined when it touches one of them (its disc within
   * `arrivalDistance` of theirs), or when it is held back close behind one (within its own radius more) and this step
   * took it no nearer `end`: the people between it and its target, and those pressing in beside it, leave it no way
   * on. A target several agents share, or seats closer together than two people, would otherwise leave every agent but
   * one pressing toward a point it cannot reach, circling it, turning back and forth on the spot or pushing into the
   * others; now each stops where it meets the group, as people gathering do.
   */
  private joins(agent: CrowdAgent, end: Vec3, vx: number, vz: number): boolean {
    const px = agent.position[0],
      pz = agent.position[2],
      own = Math.hypot(px - end[0], pz - end[2]),
      held = vx * (end[0] - px) + vz * (end[2] - pz) <= 0,
      slack = agent.arrivalDistance + (held ? agent.radius : 0);
    for (const other of this.agents) {
      if (other === agent || other.state === 'offmesh' || other.state === 'unreachable') continue;
      const x = other.position[0],
        z = other.position[2],
        r = agent.radius + other.radius;
      if (Math.hypot(x - px, z - pz) > r + slack) continue;
      const theirs = Math.hypot(x - end[0], z - end[2]);
      if (theirs < r && (other.state !== 'moving' || theirs < own || (theirs === own && other.id < agent.id)))
        return true;
      const target = other.state === 'arrived' && other.path.length ? other.path[other.path.length - 1] : null;
      if (target && Math.hypot(target[0] - end[0], target[2] - end[2]) < r) return true;
    }
    return false;
  }

  /**
   * Whether `agent` can walk straight from where it stands to (x, z) on ground it may use: the segment is followed
   * through the polygons it crosses, leaving each through the edge it exits by, which must be a portal (an open part of
   * one, at a tile seam) to allowed ground at the crossing. Touching a corner of the border counts as clear, as the
   * border bounds the agent's centre. False on a surface without `polygonPoints` and `polygonLinks`.
   */
  private straight(agent: CrowdAgent, x: number, z: number): boolean {
    const mesh = agent.surface,
      filter = agent.filter;
    if (!mesh.polygonPoints || !mesh.polygonLinks || agent.polygon < 0) return false;
    const px = agent.position[0],
      pz = agent.position[2],
      dx = x - px,
      dz = z - pz;
    let polygon = agent.polygon;
    // Each step leaves a polygon further along the segment; a mesh has fewer polygons than this many steps.
    for (let step = 0; step < 4096; step++) {
      const points = mesh.polygonPoints(polygon),
        n = points.length,
        a0 = points[0],
        a1 = points[1],
        a2 = points[2],
        winding = (a1[0] - a0[0]) * (a2[2] - a0[2]) - (a1[2] - a0[2]) * (a2[0] - a0[0]) > 0 ? 1 : -1;
      // Where the segment leaves this convex polygon: the first edge it crosses outward.
      let exit = Infinity,
        edge = -1;
      for (let i = 0; i < n; i++) {
        const a = points[i],
          b = points[(i + 1) % n],
          ex = b[0] - a[0],
          ez = b[2] - a[2],
          // Inside is where (ex * (z - az) - ez * (x - ax)) * winding >= 0; `toward` < 0 means the segment heads out.
          toward = (ex * dz - ez * dx) * winding;
        if (toward >= 0) continue;
        const t = ((ex * (pz - a[2]) - ez * (px - a[0])) * winding) / -toward;
        if (t < exit) {
          exit = t;
          edge = i;
        }
      }
      if (edge < 0 || exit >= 1) return true;
      const a = points[edge],
        b = points[(edge + 1) % n],
        cx = px + dx * exit,
        cz = pz + dz * exit,
        ex = b[0] - a[0],
        ez = b[2] - a[2],
        length2 = ex * ex + ez * ez,
        at = ((cx - a[0]) * ex + (cz - a[2]) * ez) / length2,
        slack = 1e-9 / Math.sqrt(length2);
      let next = -1;
      for (const link of mesh.polygonLinks(polygon)) {
        if (link.offMesh !== undefined || link.to === polygon) continue;
        if (filter && !((filter[mesh.polygonArea(link.to)] ?? 1) < Infinity)) continue;
        const l = link.left,
          r = link.right;
        if (
          Math.abs(ex * (l[2] - a[2]) - ez * (l[0] - a[0])) > 1e-6 * Math.sqrt(length2) ||
          Math.abs(ex * (r[2] - a[2]) - ez * (r[0] - a[0])) > 1e-6 * Math.sqrt(length2)
        )
          continue;
        const s = ((l[0] - a[0]) * ex + (l[2] - a[2]) * ez) / length2,
          e = ((r[0] - a[0]) * ex + (r[2] - a[2]) * ez) / length2;
        if (at >= Math.min(s, e) - slack && at <= Math.max(s, e) + slack) {
          next = link.to;
          break;
        }
      }
      if (next < 0) return false;
      polygon = next;
    }
    return false;
  }

  /** Puts every agent on the ground into square cells `size` wide, for {@link crowding}. */
  private bin(size: number): void {
    const cells = this.cells;
    for (const list of cells.values()) list.length = 0;
    for (const agent of this.agents) {
      if (agent.state === 'offmesh') continue;
      const key = cellKey(Math.floor(agent.position[0] / size), Math.floor(agent.position[2] / size));
      let list = cells.get(key);
      if (!list) cells.set(key, (list = []));
      list.push(agent);
    }
  }

  /**
   * The share of its top speed Weidmann's relation leaves an agent heading (ux, uz). Density is a Gaussian sum
   * e^(-d^2 / R^2) / (pi R^2) over the agents (Helbing, Johansson and Al-Abideen 2007), itself included, counting the
   * others only when ahead, and those twice, since a walker keeps its distance to the people in front (Chraibi, Seyfried
   * and Schadschneider 2010). Over people spaced s apart the sum misses the true density by about e^(-pi^2 R^2 / s^2)
   * (Poisson summation), under 1 % for R = 1 m down to half a person a square metre, and a lone walker reads 0.32 and keeps
   * 99.6 % of its speed.
   */
  private crowding(agent: CrowdAgent, ux: number, uz: number): number {
    const { gamma, jam, radius } = this.density!,
      size = radius * 3,
      x = agent.position[0],
      z = agent.position[2],
      cx = Math.floor(x / size),
      cz = Math.floor(z / size),
      inverse = 1 / (radius * radius);
    let rho = 1;
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++) {
        const list = this.cells.get(cellKey(cx + i, cz + j));
        if (list)
          for (const other of list) {
            if (other === agent) continue;
            const dx = other.position[0] - x,
              dz = other.position[2] - z,
              along = dx * ux + dz * uz;
            if (along < 0) continue;
            rho += (along > 0 ? 2 : 1) * Math.exp(-(dx * dx + dz * dz) * inverse);
          }
      }
    rho *= inverse / Math.PI;
    if (rho <= 0) return 1;
    if (rho >= jam) return 0;
    return 1 - Math.exp(-gamma * (1 / rho - 1 / jam));
  }

  /** The nearest agents and obstacles within `neighborDistance`, at most `maxNeighbors`. */
  private near(agent: CrowdAgent): Agent[] {
    const out = this.neighbors,
      candidates = this.candidates,
      range = this.neighborDistance,
      x = agent.position[0],
      z = agent.position[2];
    out.length = 0;
    candidates.length = 0;
    const consider = (disc: Agent) => {
      const d = Math.hypot(disc.position[0] - x, disc.position[1] - z) - disc.radius;
      if (d <= range) candidates.push({ agent: disc, distance: d });
    };
    for (const other of this.agents) if (other !== agent && other.state !== 'offmesh') consider(other.disc);
    for (const obstacle of this.obstacleDiscs) consider(obstacle);
    candidates.sort((a, b) => a.distance - b.distance);
    for (let i = 0; i < candidates.length && i < this.maxNeighbors; i++) out.push(candidates[i].agent);
    return out;
  }

  /**
   * The mesh border near `agent` as hard ORCA half-planes (van den Berg, Guy, Lin and Manocha 2011, section 5.4) in
   * `agent.walls`: every polygon edge, or part of one, that no portal to walkable ground opens, on the polygons reachable
   * through portals within reach, facing the agent. Ground the agent's filter forbids is a wall too. The border bounds
   * the agent's centre, as a navmesh built with the agent's radius means it to. Walls are avoided `wallHorizon` ahead,
   * the agent's own time to stop from top speed (maxSpeed / maxAcceleration), and at least one step, so a step never
   * crosses one; nothing further than the agent can close in that time matters. A surface without `polygonPoints` and
   * `polygonLinks` has no walls here, and the move alone keeps its agents on it.
   */
  private gatherWalls(agent: CrowdAgent, dt: number): void {
    const mesh = agent.surface;
    if (!mesh.polygonPoints || !mesh.polygonLinks || agent.polygon < 0) return;
    const horizon = Math.max(agent.maxSpeed / agent.maxAcceleration, dt),
      reach = agent.maxSpeed * horizon + 1e-6,
      px = agent.position[0],
      pz = agent.position[2],
      filter = agent.filter,
      queue = this.queue,
      seen = this.seen,
      spans = this.spans;
    agent.wallHorizon = horizon;
    const open = (to: number) => !filter || (filter[mesh.polygonArea(to)] ?? 1) < Infinity;
    queue.length = 0;
    seen.clear();
    queue.push(agent.polygon);
    seen.add(agent.polygon);
    for (let at = 0; at < queue.length; at++) {
      const p = queue[at],
        points = mesh.polygonPoints(p),
        links = mesh.polygonLinks(p),
        n = points.length;
      for (const link of links) {
        if (link.offMesh !== undefined || seen.has(link.to) || !open(link.to)) continue;
        if (segmentDistance(px, pz, link.left[0], link.left[2], link.right[0], link.right[2]) > reach) continue;
        seen.add(link.to);
        queue.push(link.to);
      }
      const a0 = points[0],
        a1 = points[1],
        a2 = points[2],
        winding = (a1[0] - a0[0]) * (a2[2] - a0[2]) - (a1[2] - a0[2]) * (a2[0] - a0[0]) > 0 ? 1 : -1;
      for (let i = 0; i < n; i++) {
        const a = points[i],
          b = points[(i + 1) % n],
          ex = b[0] - a[0],
          ez = b[2] - a[2],
          length2 = ex * ex + ez * ez,
          length = Math.sqrt(length2),
          inX = (-ez * winding) / length,
          inZ = (ex * winding) / length;
        // Only walls the agent stands in front of, and near enough to matter.
        if ((px - a[0]) * inX + (pz - a[2]) * inZ < -1e-6) continue;
        if (segmentDistance(px, pz, a[0], a[2], b[0], b[2]) > reach) continue;
        // The parts of the edge that portals to open ground leave closed (a tile seam may open only part of one).
        spans.length = 0;
        for (const link of links) {
          if (link.offMesh !== undefined || !open(link.to)) continue;
          const l = link.left,
            r = link.right;
          if (
            Math.abs(ex * (l[2] - a[2]) - ez * (l[0] - a[0])) > 1e-6 * length ||
            Math.abs(ex * (r[2] - a[2]) - ez * (r[0] - a[0])) > 1e-6 * length
          )
            continue;
          const s = ((l[0] - a[0]) * ex + (l[2] - a[2]) * ez) / length2,
            e = ((r[0] - a[0]) * ex + (r[2] - a[2]) * ez) / length2,
            low = Math.max(0, Math.min(s, e)),
            high = Math.min(1, Math.max(s, e));
          if (high - low > 1e-9) spans.push(low, high);
        }
        let from = 0;
        while (from < 1 - 1e-9) {
          // The next open span at or after `from`, by its start (few spans per edge: a linear pick keeps it in order).
          let next = -1;
          for (let k = 0; k < spans.length; k += 2)
            if (spans[k + 1] > from + 1e-9 && (next < 0 || spans[k] < spans[next])) next = k;
          const to = next < 0 ? 1 : Math.max(from, spans[next]);
          if (to > from + 1e-9) this.addWall(agent, px, pz, a, ex, ez, from, to, inX, inZ, horizon, reach);
          if (next < 0) break;
          from = Math.max(from, spans[next + 1]);
        }
      }
    }
  }

  private addWall(
    agent: CrowdAgent,
    px: number,
    pz: number,
    a: Vec3,
    ex: number,
    ez: number,
    from: number,
    to: number,
    inX: number,
    inZ: number,
    horizon: number,
    reach: number,
  ): void {
    let walls = agent.walls;
    if (walls.length < 3 * (agent.wallCount + 1)) {
      walls = new Float64Array(walls.length * 2);
      walls.set(agent.walls);
      agent.walls = walls;
    }
    const d = wallLine(
      px,
      pz,
      a[0] + ex * from,
      a[2] + ez * from,
      a[0] + ex * to,
      a[2] + ez * to,
      inX,
      inZ,
      horizon,
      walls,
      3 * agent.wallCount,
    );
    if (d <= reach) agent.wallCount++;
  }

  private move(agent: CrowdAgent, vx: number, vz: number, dt: number): void {
    const p = agent.position,
      mesh = agent.surface,
      filter = agent.filter;
    // Ground the agent's filter forbids is as good as no mesh, so it slides along the border like a wall.
    const stand = (x: number, z: number) => {
      const found = mesh.locate([x, p[1], z]);
      return found >= 0 && filter && !((filter[mesh.polygonArea(found)] ?? 1) < Infinity) ? -1 : found;
    };
    if (agent.state === 'offmesh') {
      // On a link: straight to the landing point, height included, without checking the mesh in between.
      const c = agent.path[agent.corner],
        d = Math.hypot(c[0] - p[0], c[1] - p[1], c[2] - p[2]),
        step = Math.min(d, agent.maxSpeed * dt);
      if (d > 1e-9) for (let a = 0; a < 3; a++) p[a] += ((c[a] - p[a]) / d) * step;
      agent.velocity[0] = vx;
      agent.velocity[2] = vz;
      if (step >= d - 1e-9) {
        agent.state = 'moving';
        const landed = mesh.closestPoint(p);
        if (landed) agent.polygon = landed.polygon;
        if (agent.corner === agent.path.length - 1) this.arrive(agent);
        else agent.corner++;
      }
      return;
    }
    // Try the full move; then along the walls it touches (rounding can still carry a step that grazes a wall off the
    // mesh); on a surface without walls, each axis alone; else stay.
    let nx = p[0] + vx * dt,
      nz = p[2] + vz * dt,
      polygon = stand(nx, nz);
    if (polygon < 0 && agent.wallCount) {
      const w = agent.walls,
        step = Math.hypot(vx, vz) * dt;
      for (let k = 0; k < agent.wallCount; k++) {
        const into = w[3 * k] * vx + w[3 * k + 1] * vz;
        if (into < 0 && -w[3 * k + 2] * agent.wallHorizon <= step + 1e-6) {
          vx -= into * w[3 * k];
          vz -= into * w[3 * k + 1];
        }
      }
      nx = p[0] + vx * dt;
      nz = p[2] + vz * dt;
      polygon = stand(nx, nz);
    }
    if (polygon < 0) {
      polygon = stand(nx, p[2]);
      if (polygon >= 0) {
        nz = p[2];
        vz = 0;
      } else {
        polygon = stand(p[0], nz);
        if (polygon >= 0) {
          nx = p[0];
          vx = 0;
        } else {
          nx = p[0];
          nz = p[2];
          vx = vz = 0;
          polygon = agent.polygon;
        }
      }
    }
    p[0] = nx;
    p[2] = nz;
    p[1] = mesh.heightAt(polygon, nx, nz);
    agent.polygon = polygon;
    agent.velocity[0] = vx;
    agent.velocity[2] = vz;
    if (agent.state === 'moving' && agent.path.length && agent.corner === agent.path.length - 1) {
      const end = agent.path[agent.corner];
      if (Math.hypot(end[0] - nx, end[2] - nz) <= agent.arrivalDistance || this.joins(agent, end, vx, vz)) this.arrive(agent);
    }
  }

  private arrive(agent: CrowdAgent): void {
    agent.state = 'arrived';
    agent.velocity.fill(0);
    this.emit('arrive', agent);
  }

  /** Removes every agent and obstacle. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const agent of this.agents) agent.markRemoved();
    this.agents.length = 0;
    this.obstacles.clear();
    this.listeners.clear();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
