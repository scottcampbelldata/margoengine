/// <reference lib="esnext.disposable" preserve="true" />
// A crowd manager on a NavMesh: agents plan with A* and the funnel, steer toward their next corner, avoid each other
// and dynamic obstacles with ORCA, stay on the walkable polygons and cross off-mesh links. Kept out of NavMesh so an
// app that only queries paths does not bundle it.
import { MargoError } from '@margoengine/math/errors';
import type { NavFilter, NavSurface, Vec3 } from './index.js';
import { avoid, type Agent } from './orca.js';

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

const positive = (value: number | undefined, fallback: number, label: string, zero = false): number => {
  const v = value ?? fallback;
  if (!(zero ? v >= 0 : v > 0) || !Number.isFinite(v))
    throw new RangeError(`${label} must be a finite number ${zero ? 'of 0 or more' : 'above 0'}`);
  return v;
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
  private readonly maxNeighbors: number;
  private readonly timeHorizon: number;
  private nextId = 1;
  private disposed = false;
  private readonly output = new Float64Array(2);
  private readonly neighbors: Agent[] = [];
  private readonly obstacleDiscs: Agent[] = [];
  private readonly candidates: { agent: Agent; distance: number }[] = [];

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
    for (const agent of this.agents) {
      if (agent.target && (agent.state !== 'arrived' || agent.partial) && agent.planned !== agent.surface.version)
        this.plan(agent, agent.surface.version);
      this.steer(agent, dt);
    }
    // 2. Avoidance: every agent picks its velocity from the same snapshot, then all move.
    const chosen = this.agents.map((agent) => {
      if (agent.state === 'offmesh') return [agent.disc.preferred[0], agent.disc.preferred[1]];
      const neighbors = this.near(agent);
      avoid(agent.disc, neighbors, dt, this.timeHorizon, this.output);
      // Limit the change of velocity to maxAcceleration.
      let ax = this.output[0] - agent.velocity[0],
        az = this.output[1] - agent.velocity[2];
      const change = Math.hypot(ax, az),
        most = agent.maxAcceleration * dt;
      if (change > most) {
        ax *= most / change;
        az *= most / change;
      }
      return [agent.velocity[0] + ax, agent.velocity[2] + az];
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
    // Corners within reach this frame are passed (the final one only by arriving).
    while (agent.state === 'moving' && agent.corner < last) {
      const c = path[agent.corner],
        reach = Math.max(agent.arrivalDistance, agent.maxSpeed * dt);
      if (Math.hypot(c[0] - p[0], c[2] - p[2]) > reach) break;
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
    else [ux, uz] = this.detour(agent, ux, uz, d);
    disc.preferred[0] = ux * speed;
    disc.preferred[1] = uz * speed;
  }

  /**
   * Steers the preferred direction past the nearest obstacle or standing agent that blocks the way to the next corner:
   * toward the tangent of its disc (grown by the agent's radius) on the side the way already leans to. ORCA alone
   * only slows an agent that heads straight at something that does not move aside, so it would stop in front of it.
   */
  private detour(agent: CrowdAgent, ux: number, uz: number, reach: number): [number, number] {
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
      if (other !== agent && (other.state === 'idle' || other.state === 'arrived'))
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
    // Try the full move, then each axis alone (sliding along a wall), else stay.
    let nx = p[0] + vx * dt,
      nz = p[2] + vz * dt,
      polygon = stand(nx, nz);
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
      if (Math.hypot(end[0] - nx, end[2] - nz) <= agent.arrivalDistance) this.arrive(agent);
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
