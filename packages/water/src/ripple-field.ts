// The ripple field's arithmetic on the CPU (SEA-04): the same five-point wave stencil, absorbing strip, obstacle walls and
// drop profile as the compute shader in ripples.ts, step for step, so a `Ripples` with `cpu: true` answers height queries
// in the frame they are asked and a `RippleField` runs with no GPU at all (a server, a test, a replay).
// Clean room from the linear wave equation on a height field (Kass and Miller 1990; Müller 2008) and the sponge layer of
// Israeli and Orszag (1981); docs/clean-room.md, "Interactive water ripples".
import { fault } from '../../shared/errors.js';

/** Maximum number of solid reflecting obstacles supported simultaneously in a {@link Ripples} field. */
export const MAX_RIPPLE_OBSTACLES = 32;

/** A spherical solid obstacle that reflects ripples where it intersects the water plane. */
export interface RippleSphereObstacle {
  readonly kind: 'sphere';
  /** World-space centre [x, y, z] (or [x, z] at the water plane) in metres. */
  readonly center: readonly [number, number, number] | readonly [number, number];
  /** Sphere radius in metres, > 0. */
  readonly radius: number;
}
/** A vertical cylindrical solid obstacle (pier piling, buoy, post) that reflects ripples. */
export interface RippleCylinderObstacle {
  readonly kind: 'cylinder';
  /** World-space centre [x, z] or [x, y, z] in metres. */
  readonly center: readonly [number, number] | readonly [number, number, number];
  /** Cylinder radius in metres, > 0. */
  readonly radius: number;
  /** Optional lower Y bound in metres. Default -Infinity. */
  readonly minY?: number;
  /** Optional upper Y bound in metres. Default Infinity. */
  readonly maxY?: number;
}
/** An oriented rectangular box obstacle (hull, dock, pier) that reflects ripples. */
export interface RippleBoxObstacle {
  readonly kind: 'box';
  /** World-space centre [x, z] or [x, y, z] in metres. */
  readonly center: readonly [number, number] | readonly [number, number, number];
  /** Half-extents [hx, hz] or [hx, hy, hz] in metres, each > 0. */
  readonly halfExtents: readonly [number, number] | readonly [number, number, number];
  /** Y-axis yaw rotation in radians. Default 0. */
  readonly rotation?: number;
}
/** A solid wall segment in world XZ that reflects ripples without leakage. */
export interface RippleWallObstacle {
  readonly kind: 'wall';
  /** Start point [x, z] in metres. */
  readonly from: readonly [number, number];
  /** End point [x, z] in metres. */
  readonly to: readonly [number, number];
  /** Wall thickness in metres, > 0. Default 1.5 ripple cells. */
  readonly thickness?: number;
}
/** Solid obstacle in a {@link Ripples} field (sphere, cylinder, box, or wall segment). */
export type RippleObstacle = RippleSphereObstacle | RippleCylinderObstacle | RippleBoxObstacle | RippleWallObstacle;

/** A refusal of bad ripple input: a MargoError `unsupported` whose message names the fix and links to errors#ripples. */
export const rippleError = (message: string) => fault('unsupported', message, 'ripples');
/** `value` when finite and inside `low..high`, else a MargoError `unsupported` naming `name` and the range. */
export function finite(value: number, low: number, high: number, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high)
    throw rippleError(`Invalid ripple ${name}; pass a finite value in ${low}..${high}`);
  return value;
}

/** A validated, frozen copy of one obstacle (MargoError `unsupported` for a bad one). */
export function cloneObstacle(obs: RippleObstacle): RippleObstacle {
  if (!obs || typeof obs !== 'object')
    throw rippleError('Invalid ripple obstacle; pass sphere, cylinder, box, or wall objects');
  switch (obs.kind) {
    case 'sphere': {
      const c = obs.center;
      if (!Array.isArray(c) || (c.length !== 2 && c.length !== 3))
        throw rippleError('Invalid sphere obstacle center; pass [x, z] or [x, y, z]');
      for (const v of c) finite(v, -1e7, 1e7, 'obstacle center');
      const radius = finite(obs.radius, 1e-4, 1e6, 'obstacle radius');
      return Object.freeze({
        kind: 'sphere' as const,
        center: Object.freeze([...c]) as readonly [number, number] | readonly [number, number, number],
        radius,
      });
    }
    case 'cylinder': {
      const c = obs.center;
      if (!Array.isArray(c) || (c.length !== 2 && c.length !== 3))
        throw rippleError('Invalid cylinder obstacle center; pass [x, z] or [x, y, z]');
      for (const v of c) finite(v, -1e7, 1e7, 'obstacle center');
      const radius = finite(obs.radius, 1e-4, 1e6, 'obstacle radius');
      const minY = obs.minY === undefined ? -Infinity : finite(obs.minY, -1e7, 1e7, 'obstacle minY');
      const maxY = obs.maxY === undefined ? Infinity : finite(obs.maxY, -1e7, 1e7, 'obstacle maxY');
      if (minY > maxY) throw rippleError('Invalid cylinder obstacle Y range; ensure minY <= maxY');
      return Object.freeze({
        kind: 'cylinder' as const,
        center: Object.freeze([...c]) as readonly [number, number] | readonly [number, number, number],
        radius,
        ...(obs.minY !== undefined ? { minY } : {}),
        ...(obs.maxY !== undefined ? { maxY } : {}),
      });
    }
    case 'box': {
      const c = obs.center,
        h = obs.halfExtents;
      if (!Array.isArray(c) || (c.length !== 2 && c.length !== 3))
        throw rippleError('Invalid box obstacle center; pass [x, z] or [x, y, z]');
      if (!Array.isArray(h) || (h.length !== 2 && h.length !== 3))
        throw rippleError('Invalid box obstacle halfExtents; pass [hx, hz] or [hx, hy, hz]');
      for (const v of c) finite(v, -1e7, 1e7, 'obstacle center');
      for (const v of h) finite(v, 1e-4, 1e6, 'obstacle halfExtent');
      const rotation = obs.rotation === undefined ? 0 : finite(obs.rotation, -1e6, 1e6, 'obstacle rotation');
      return Object.freeze({
        kind: 'box' as const,
        center: Object.freeze([...c]) as readonly [number, number] | readonly [number, number, number],
        halfExtents: Object.freeze([...h]) as readonly [number, number] | readonly [number, number, number],
        rotation,
      });
    }
    case 'wall': {
      if (!Array.isArray(obs.from) || obs.from.length !== 2 || !Array.isArray(obs.to) || obs.to.length !== 2)
        throw rippleError('Invalid wall obstacle endpoints; pass from and to [x, z] pairs');
      for (const v of [...obs.from, ...obs.to]) finite(v, -1e7, 1e7, 'obstacle endpoint');
      const thickness =
        obs.thickness === undefined ? undefined : finite(obs.thickness, 1e-4, 1e6, 'obstacle thickness');
      return Object.freeze({
        kind: 'wall' as const,
        from: Object.freeze([obs.from[0], obs.from[1]]) as readonly [number, number],
        to: Object.freeze([obs.to[0], obs.to[1]]) as readonly [number, number],
        ...(thickness !== undefined ? { thickness } : {}),
      });
    }
    default:
      throw rippleError("Invalid ripple obstacle kind; use 'sphere', 'cylinder', 'box', or 'wall'");
  }
}

/** Floats a packed obstacle takes: centre or start XZ, size, rotation or wall end, kind (1 disc, 2 box, 3 wall). */
export const RIPPLE_OBSTACLE_FLOATS = 8;
/** Floats a queued drop or wake takes: from XZ, to XZ, radius, strength, two unused. */
export const RIPPLE_EVENT_FLOATS = 8;

/** True where world `(x, z)` lies inside one of the first `count` packed obstacles (the shader's `isObstacle`). */
export function insideObstacle(packed: Float32Array, count: number, x: number, z: number): boolean {
  for (let i = 0; i < count; i++) {
    const o = i * RIPPLE_OBSTACLE_FLOATS,
      kind = packed[o + 6]!;
    if (kind < 1.5) {
      const dx = x - packed[o]!,
        dz = z - packed[o + 1]!,
        r = packed[o + 2]!;
      if (dx * dx + dz * dz <= r * r) return true;
    } else if (kind < 2.5) {
      const dx = x - packed[o]!,
        dz = z - packed[o + 1]!,
        co = packed[o + 4]!,
        si = packed[o + 5]!,
        lx = dx * co + dz * si,
        lz = -dx * si + dz * co;
      if (Math.abs(lx) <= packed[o + 2]! && Math.abs(lz) <= packed[o + 3]!) return true;
    } else {
      const x0 = packed[o]!,
        z0 = packed[o + 1]!,
        sx = packed[o + 2]! - x0,
        sz = packed[o + 3]! - z0,
        t = Math.max(0, Math.min(1, ((x - x0) * sx + (z - z0) * sz) / Math.max(sx * sx + sz * sz, 1e-6))),
        dx = x - x0 - t * sx,
        dz = z - z0 - t * sz,
        ht = packed[o + 4]!;
      if (dx * dx + dz * dz <= ht * ht) return true;
    }
  }
  return false;
}

/** One step of the field, what the compute shader does for every cell. */
export interface RippleStep {
  /** Lower left world XZ of the grid after this step. */
  origin: readonly [number, number];
  /** Cell width, m. */
  cell: number;
  /** Seconds. */
  dt: number;
  /** Wave speed squared, m^2/s^2. */
  speed2: number;
  /** Velocity decay per second. */
  damping: number;
  /** Whole cells the grid moved since the last step (the old cell a new cell reads). */
  shift: readonly [number, number];
  /** Drops and wakes born in this step, RIPPLE_EVENT_FLOATS each. */
  events: Float32Array;
  /** How many events `events` holds. */
  eventCount: number;
  /** Packed obstacles, RIPPLE_OBSTACLE_FLOATS each. */
  obstacles: Float32Array;
  /** How many obstacles `obstacles` holds. */
  obstacleCount: number;
}

/** Event kind word (float 6 of an event): a zero-mean drop or wake. */
export const RIPPLE_DROP = 0;
/**
 * Event kind word: water displaced by a body, a ring around its footprint. The ring runs from `inner` (float 7) to the
 * event's radius, its height (1 - s^2)^2 across it (s from -1 at the inner edge to 1 at the outer), so nothing rises
 * under the body itself; it holds (32 / 15) pi w c of its peak height, w its half width and c its middle radius.
 */
export const RIPPLE_DISPLACED = 1;

/**
 * The peak height of a displaced-volume ring from `inner` to `outer` holding `volume` m^3 (signed).
 * @throws MargoError `unsupported` (errors#ripples) for a ring past 100 m high: give the body a wider radius.
 */
export function displacedHeight(volume: number, inner: number, outer: number): number {
  const w = (outer - inner) / 2,
    c = (outer + inner) / 2,
    height = (15 * volume) / (32 * Math.PI * w * c);
  if (!(Math.abs(height) <= 100))
    throw rippleError('Displaced volume too large for its radius (over 100 m of ring); pass a wider radius');
  return height;
}

/**
 * Steps `source` (height and vertical velocity pairs, row-major, `n` by `n`) into `target`: symplectic Euler on
 * dh/dt = v, dv/dt = c^2 laplacian(h), velocity decaying by `damping` plus a 12 /s strip over the 8 cells at the edge,
 * obstacle cells held at rest and their faces mirrored (a Neumann wall), then each event's profile added, q the squared
 * distance to its swept segment over its radius squared: a drop's zero-mean (1 - q)^2 (1 - 4 q), or the ring of a
 * body's displaced water (kind {@link RIPPLE_DISPLACED}), which adds exactly its volume up to the cells' quadrature.
 */
export function stepRipples(source: Float32Array, target: Float32Array, n: number, s: RippleStep): void {
  const { cell: c, dt, obstacles, obstacleCount, events, eventCount } = s,
    [ox, oz] = s.origin,
    [sx, sz] = s.shift,
    gain = (s.speed2 * dt) / (c * c),
    at = (x: number, z: number, field: number) =>
      x < 0 || z < 0 || x >= n || z >= n ? 0 : source[(z * n + x) * 2 + field]!;
  for (let z = 0; z < n; z++)
    for (let x = 0; x < n; x++) {
      const out = (z * n + x) * 2,
        wx = ox + (x + 0.5) * c,
        wz = oz + (z + 0.5) * c;
      if (obstacleCount > 0 && insideObstacle(obstacles, obstacleCount, wx, wz)) {
        target[out] = target[out + 1] = 0;
        continue;
      }
      const px = x + sx,
        pz = z + sz,
        h = at(px, pz, 0),
        v = at(px, pz, 1);
      let hE = at(px + 1, pz, 0),
        hW = at(px - 1, pz, 0),
        hN = at(px, pz + 1, 0),
        hS = at(px, pz - 1, 0);
      if (obstacleCount > 0) {
        if (insideObstacle(obstacles, obstacleCount, wx + c, wz)) hE = h;
        if (insideObstacle(obstacles, obstacleCount, wx - c, wz)) hW = h;
        if (insideObstacle(obstacles, obstacleCount, wx, wz + c)) hN = h;
        if (insideObstacle(obstacles, obstacleCount, wx, wz - c)) hS = h;
      }
      const edge = Math.min(x, z, n - 1 - x, n - 1 - z),
        e = Math.min(1, edge / 8),
        velocity =
          (v + (hE + hW + hN + hS - 4 * h) * gain) * Math.exp(-(s.damping + 12 * (1 - e * e * (3 - 2 * e))) * dt);
      let height = h + velocity * dt;
      for (let i = 0; i < eventCount; i++) {
        const o = i * RIPPLE_EVENT_FLOATS,
          ax = events[o]!,
          az = events[o + 1]!,
          dx = events[o + 2]! - ax,
          dz = events[o + 3]! - az,
          r = events[o + 4]!,
          t = Math.max(0, Math.min(1, ((wx - ax) * dx + (wz - az) * dz) / Math.max(dx * dx + dz * dz, 1e-6))),
          qx = wx - ax - t * dx,
          qz = wz - az - t * dz,
          q = (qx * qx + qz * qz) / (r * r);
        if (events[o + 6]! > 0.5) {
          const inner = events[o + 7]!,
            w = (r - inner) / 2,
            u = (Math.sqrt(q) * r - (r + inner) / 2) / w;
          if (u * u < 1) height += events[o + 5]! * (1 - u * u) * (1 - u * u);
        } else if (q < 1) height += events[o + 5]! * (1 - q) * (1 - q) * (1 - 4 * q);
      }
      target[out] = height;
      target[out + 1] = velocity;
    }
}

/** A ripple field's state: its place and its heights and vertical velocities. Restore it into a field of the same grid. */
export interface RippleSnapshot {
  /** Lower left world XZ of the grid. */
  readonly origin: readonly [number, number];
  /** Grid side. */
  readonly resolution: number;
  /** Film-clock ticks stepped (0 without a clock). */
  readonly ticks: number;
  /** Height and vertical velocity pairs, row-major. A copy. */
  readonly data: Float32Array;
}

/** What a ripple field gives at a point: its own displacement, on top of the surface it rides. */
export interface RippleSample {
  /** Height of the ripples, m, added to the water surface's own. */
  height: number;
  /** Unit normal of the ripples alone, pointing up. */
  normal: [number, number, number];
  /** Vertical velocity of the ripples, m/s. */
  velocity: number;
}

/** Bilinear sample of a field at world `(x, z)`, as the surface shader's `rippleSample` reads it (zero outside). */
export function sampleField(
  data: Float32Array,
  n: number,
  origin: readonly [number, number],
  cell: number,
  x: number,
  z: number,
  out: [number, number] = [0, 0],
): [number, number] {
  const px = (x - origin[0]) / cell - 0.5,
    pz = (z - origin[1]) / cell - 0.5,
    ix = Math.floor(px),
    iz = Math.floor(pz),
    tx = px - ix,
    tz = pz - iz;
  for (let f = 0; f < 2; f++) {
    const at = (i: number, k: number) => (i < 0 || k < 0 || i >= n || k >= n ? 0 : data[(k * n + i) * 2 + f]!),
      a = at(ix, iz) + (at(ix + 1, iz) - at(ix, iz)) * tx,
      b = at(ix, iz + 1) + (at(ix + 1, iz + 1) - at(ix, iz + 1)) * tx;
    out[f] = a + (b - a) * tz;
  }
  return out;
}

/** FNV-1a over a field's bytes and its origin: equal for equal states, bit for bit. */
export function rippleHash(data: Float32Array, origin: readonly [number, number], ticks: number): string {
  let h = 0x811c9dc5;
  const mix = (bytes: Uint8Array) => {
    for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193);
  };
  mix(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  mix(new Uint8Array(Float64Array.of(origin[0], origin[1], ticks).buffer));
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Packs `list` cut at the water plane `level` into `out` from obstacle `start` on, as the shader reads them, and returns
 * the obstacle count after it: a sphere becomes its waterline disc (none when it misses the plane), a cylinder a disc
 * while `level` is inside its Y range, a box its yawed rectangle while the plane crosses it, a wall a segment at least
 * 0.72 cells half thick (so a diagonal wall stays closed on the five-point stencil).
 */
export function packObstacleList(
  list: readonly RippleObstacle[],
  level: number,
  cell: number,
  out: Float32Array,
  start = 0,
): number {
  let count = start;
  const push = (...values: number[]) => {
    if (count >= MAX_RIPPLE_OBSTACLES) return;
    out.set(values, count++ * RIPPLE_OBSTACLE_FLOATS);
  };
  for (const obs of list) {
    if (obs.kind === 'sphere') {
      const cz = obs.center.length === 3 ? obs.center[2]! : obs.center[1]!,
        dy = obs.center.length === 3 ? obs.center[1]! - level : 0,
        r2 = obs.radius * obs.radius - dy * dy;
      if (r2 > 1e-8) push(obs.center[0]!, cz, Math.sqrt(r2), 0, 0, 0, 1, 0);
    } else if (obs.kind === 'cylinder') {
      const cz = obs.center.length === 3 ? obs.center[2]! : obs.center[1]!;
      if (level >= (obs.minY ?? -Infinity) && level <= (obs.maxY ?? Infinity))
        push(obs.center[0]!, cz, obs.radius, 0, 0, 0, 1, 0);
    } else if (obs.kind === 'box') {
      const cz = obs.center.length === 3 ? obs.center[2]! : obs.center[1]!,
        hz = obs.halfExtents.length === 3 ? obs.halfExtents[2]! : obs.halfExtents[1]!;
      if (
        obs.center.length === 3 &&
        obs.halfExtents.length === 3 &&
        Math.abs(obs.center[1]! - level) > obs.halfExtents[1]!
      )
        continue;
      const yaw = obs.rotation ?? 0;
      push(obs.center[0]!, cz, obs.halfExtents[0]!, hz, Math.cos(yaw), Math.sin(yaw), 2, 0);
    } else {
      const half = Math.max((obs.thickness ?? cell * 1.5) * 0.5, cell * 0.72);
      push(obs.from[0], obs.from[1], obs.to[0], obs.to[1], half, 0, 3, 0);
    }
  }
  out.fill(0, count * RIPPLE_OBSTACLE_FLOATS);
  return count;
}

/** Settings of a {@link RippleField}, copied at construction. Distances are metres. */
export interface RippleFieldOptions {
  /** Square field width, 1..10000. Default 64. */
  size?: number;
  /** Grid side, integer 16..512. Default 128. */
  resolution?: number;
  /** Wave speed, 0.01..100 m/s. Default 3. */
  speed?: number;
  /** Velocity decay per second, 0..100. Default 0.6. */
  damping?: number;
  /** World XZ of the field's centre. Default [0, 0]. */
  center?: readonly [number, number];
  /** World Y of the water plane the obstacles are cut at. Default 0. */
  level?: number;
  /** Reflecting obstacles, up to 32. Default none. */
  obstacles?: readonly RippleObstacle[];
}

/**
 * The ripple field on the CPU with no GPU: the same wave stencil, absorbing strip, obstacle walls and drop profile as
 * `Ripples`, so a server, a test or a replay steps the field a `Ripples` draws. `advance(seconds)` takes stable substeps
 * (at most 0.45 cells / speed and 1/120 s each); `disturb` and `wake` queue events for the next step.
 * @throws MargoError `unsupported` (errors#ripples) for a value outside its range.
 */
export class RippleField {
  /** Field width, m. */
  readonly size: number;
  /** Grid side. */
  readonly resolution: number;
  /** Wave speed, m/s. */
  readonly speed: number;
  /** Velocity decay per second. */
  readonly damping: number;
  /** Cell width, m. */
  readonly cellSize: number;
  private readonly level: number;
  private readonly corner: [number, number];
  private state: Float32Array;
  private spare: Float32Array;
  private readonly events: number[] = [];
  private readonly packed = new Float32Array(MAX_RIPPLE_OBSTACLES * RIPPLE_OBSTACLE_FLOATS);
  private packedCount = 0;
  private list: readonly RippleObstacle[] = [];
  private ticks = 0;
  constructor(options: RippleFieldOptions = {}) {
    this.size = finite(options.size ?? 64, 1, 10000, 'size');
    this.resolution = finite(options.resolution ?? 128, 16, 512, 'resolution');
    if (!Number.isInteger(this.resolution)) throw rippleError('Ripple resolution must be an integer; use 16..512');
    this.speed = finite(options.speed ?? 3, 0.01, 100, 'speed');
    this.damping = finite(options.damping ?? 0.6, 0, 100, 'damping');
    this.level = finite(options.level ?? 0, -1e7, 1e7, 'level');
    const center = options.center ?? [0, 0];
    if (!Array.isArray(center) || center.length !== 2) throw rippleError('Invalid ripple center; pass [x, z]');
    this.cellSize = this.size / this.resolution;
    this.corner = [
      finite(center[0], -1e7, 1e7, 'center') - this.size / 2,
      finite(center[1], -1e7, 1e7, 'center') - this.size / 2,
    ];
    this.state = new Float32Array(this.resolution ** 2 * 2);
    this.spare = new Float32Array(this.state.length);
    if (options.obstacles !== undefined) this.setObstacles(options.obstacles);
  }
  /** Lower left world XZ of the grid. A copy. */
  get origin(): readonly [number, number] {
    return Object.freeze([this.corner[0], this.corner[1]]) as readonly [number, number];
  }
  /** Steps taken since construction or the restored snapshot's count. */
  get steps(): number {
    return this.ticks;
  }
  /** Active obstacles. A frozen copy. */
  get obstacles(): readonly RippleObstacle[] {
    return Object.freeze([...this.list]);
  }
  /** Replaces the reflecting obstacles (up to 32), cut at the field's water plane. */
  setObstacles(obstacles: readonly RippleObstacle[]): this {
    if (!Array.isArray(obstacles) || obstacles.length > MAX_RIPPLE_OBSTACLES)
      throw rippleError(`Invalid ripple obstacles; pass an array of at most ${MAX_RIPPLE_OBSTACLES} obstacles`);
    this.list = Object.freeze(obstacles.map(cloneObstacle));
    this.packedCount = packObstacleList(this.list, this.level, this.cellSize, this.packed);
    return this;
  }
  /** Queues a circular drop for the next step. Radius covers at least one cell; strength is signed metres. */
  disturb(x: number, z: number, radius = 1, strength = 0.1): this {
    return this.wake([x, z], [x, z], radius, strength);
  }
  /** Queues a drop swept from `from` to `to` (a moving object's footprint) for the next step; at most 64 queued. */
  wake(from: readonly [number, number], to: readonly [number, number], radius = 1, strength = 0.1): this {
    if (!Array.isArray(from) || !Array.isArray(to) || from.length !== 2 || to.length !== 2)
      throw rippleError('Invalid wake path; pass two XZ pairs');
    for (const v of [...from, ...to]) finite(v, -1e7, 1e7, 'position');
    finite(radius, this.cellSize, this.size / 2, 'radius');
    finite(strength, -100, 100, 'strength');
    if (this.events.length >= 64 * RIPPLE_EVENT_FLOATS)
      throw rippleError('Ripple event queue full; advance before adding more than 64 events');
    this.events.push(from[0], from[1], to[0], to[1], radius, strength, 0, 0);
    return this;
  }
  /**
   * Queues the water a body pushed aside (or, negative, let back) for the next step: a ring from `radius` (the body's
   * footprint) out to twice that holding `volume` m^3, so the field's water grows by exactly that (to the cells'
   * quadrature) and none of it rises under the body.
   */
  displace(x: number, z: number, radius: number, volume: number): this {
    for (const v of [x, z]) finite(v, -1e7, 1e7, 'position');
    finite(radius, this.cellSize / 2, this.size / 4, 'radius');
    finite(volume, -1e9, 1e9, 'volume');
    const height = displacedHeight(volume, radius, 2 * radius);
    if (this.events.length >= 64 * RIPPLE_EVENT_FLOATS)
      throw rippleError('Ripple event queue full; advance before adding more than 64 events');
    this.events.push(x, z, x, z, 2 * radius, height, RIPPLE_DISPLACED, radius);
    return this;
  }
  /** Water volume the field holds above its level, m^3: the heights summed over the cells. */
  volume(): number {
    let sum = 0;
    for (let i = 0; i < this.state.length; i += 2) sum += this.state[i]!;
    return sum * this.cellSize * this.cellSize;
  }
  /** Advances the field `seconds` (0..3600) in equal stable substeps; queued events are born in the first. */
  advance(seconds: number): this {
    finite(seconds, 0, 3600, 'advance seconds');
    if (seconds === 0) return this;
    const limit = Math.min(1 / 120, (0.45 * this.cellSize) / this.speed),
      count = Math.ceil(seconds / limit),
      dt = seconds / count,
      events = Float32Array.from(this.events),
      none = new Float32Array(0);
    this.events.length = 0;
    for (let s = 0; s < count; s++)
      this.step({
        origin: this.corner,
        cell: this.cellSize,
        dt,
        speed2: this.speed ** 2,
        damping: this.damping,
        shift: [0, 0],
        events: s === 0 ? events : none,
        eventCount: s === 0 ? events.length / RIPPLE_EVENT_FLOATS : 0,
        obstacles: this.packed,
        obstacleCount: this.packedCount,
      });
    return this;
  }
  /** Takes one step of the given parameters (what `Ripples` drives its CPU copy with); `origin` becomes the field's. */
  step(step: RippleStep): this {
    stepRipples(this.state, this.spare, this.resolution, step);
    [this.state, this.spare] = [this.spare, this.state];
    this.corner[0] = step.origin[0];
    this.corner[1] = step.origin[1];
    this.ticks++;
    return this;
  }
  /** The ripples at world `(x, z)`: height, normal (from the slope over one cell each side) and vertical velocity. */
  sample(x: number, z: number): RippleSample {
    finite(x, -1e7, 1e7, 'position');
    finite(z, -1e7, 1e7, 'position');
    const n = this.resolution,
      c = this.cellSize,
      at = (px: number, pz: number) => sampleField(this.state, n, this.corner, c, px, pz),
      [height, velocity] = at(x, z),
      sx = (at(x + c, z)[0] - at(x - c, z)[0]) / (2 * c),
      sz = (at(x, z + c)[0] - at(x, z - c)[0]) / (2 * c),
      k = Math.hypot(sx, 1, sz);
    return { height, normal: [-sx / k, 1 / k, -sz / k], velocity };
  }
  /** Ripple height at world `(x, z)`, m. */
  sampleHeight(x: number, z: number): number {
    return this.sample(x, z).height;
  }
  /** A copy of the field's state, to restore later or to compare. */
  snapshot(): RippleSnapshot {
    return Object.freeze({
      origin: this.origin,
      resolution: this.resolution,
      ticks: this.ticks,
      data: this.state.slice(),
    });
  }
  /** Puts back a state taken from a field of this resolution; queued events are dropped. */
  restore(snapshot: RippleSnapshot): this {
    if (
      !snapshot ||
      snapshot.resolution !== this.resolution ||
      !(snapshot.data instanceof Float32Array) ||
      snapshot.data.length !== this.state.length ||
      !Number.isSafeInteger(snapshot.ticks) ||
      snapshot.ticks < 0
    )
      throw rippleError(`Invalid ripple snapshot; pass one taken from a field of resolution ${this.resolution}`);
    const x = finite(snapshot.origin?.[0], -1e7, 1e7, 'snapshot origin'),
      z = finite(snapshot.origin?.[1], -1e7, 1e7, 'snapshot origin');
    this.state.set(snapshot.data);
    this.corner[0] = x;
    this.corner[1] = z;
    this.ticks = snapshot.ticks;
    this.events.length = 0;
    return this;
  }
  /** FNV-1a of the state's bits, origin and step count: equal for equal fields, bit for bit. */
  stateHash(): string {
    return rippleHash(this.state, this.corner, this.ticks);
  }
}
