// Perception for game agents: sight shapes with a detection timer, hearing, and a memory of last seen targets that
// feeds a blackboard. Sight and hearing follow M. Walsh, "Modeling Perception and Awareness in Tom Clancy's Splinter
// Cell Blacklist", Game AI Pro 2, chapter 28, 2015: a cone or a coffin-shaped box, several test points on the body, a
// timer scaled by distance inside the shape, and sounds with a radius and a priority. OccupancyMap is the Probabilistic
// Occupancy Map of D. Isla and B. Blumberg, "Object Persistence for Synthetic Creatures", AAMAS 2002.
import { type Blackboard, type BlackboardKey, blackboardKey } from './blackboard.js';

/** A position or direction, `[x, y, z]`. */
export type Point = ArrayLike<number>;
/** A target id. */
export type TargetId = string | number;
/** True when nothing blocks the straight line from `from` to `to`. `NavVolume.lineOfSight` fits as it is. */
export type LineOfSight = (from: Point, to: Point) => boolean;
/** How far a sound travels from `from` to `to`; `Infinity` when it cannot get there. */
export type SoundDistance = (from: Point, to: Point) => number;
/** What the agent makes of what it senses: nothing yet, something to look into, or a known target. */
export type AwarenessLevel = 'calm' | 'suspicious' | 'aware';

/** A sight shape: a cone, or a box that widens like a cone and then narrows again, shaped like a coffin. */
export type SightShape = SightCone | SightCoffin;

interface SightShapeBase {
  /** Farthest distance seen along the agent's forward direction. */
  range: number;
  /** Seconds to notice a target right next to the agent (default 0.2). */
  nearTime?: number;
  /** Seconds to notice a target at `range`; distances between scale linearly (default 1.5). */
  farTime?: number;
}
/** Everything within `range` of the eye and `fov` of forward. */
export interface SightCone extends SightShapeBase {
  kind: 'cone';
  /** Full opening angle in radians, up to `2 * Math.PI` for all round. */
  fov: number;
}
/** A round cross section that grows to `width` at distance `shoulder`, then shrinks to nothing at `range`. */
export interface SightCoffin extends SightShapeBase {
  kind: 'coffin';
  /** Distance along forward of the widest part, between 0 and `range`. */
  shoulder: number;
  /** Full width at the shoulder. */
  width: number;
}

/** The agent that perceives. The object is read on every call, so move it freely. */
export interface PerceivingAgent {
  /** World position. */
  readonly position: Point;
  /** Direction it looks in; any length above 0. */
  readonly forward: Point;
}

/** Something an agent may see. */
export interface PerceptionTarget {
  /** Stable id, the key of its memory. */
  readonly id: TargetId;
  /** World position; the sight shapes test this point. */
  readonly position: Point;
  /** World velocity, used to guess where it went (default at rest). */
  readonly velocity?: Point;
  /** Body points tested for line of sight, for example bones (default `[position]`). */
  readonly points?: readonly Point[];
  /** How many of `points` must be in view before detection starts (default 1). Raise it for a target in cover. */
  readonly pointsNeeded?: number;
  /** How easy it is to see, above 0: 1 is normal, 0.5 in shadow takes twice as long (default 1). */
  readonly visibility?: number;
}

/** A noise. */
export interface PerceptionSound {
  /** Where it was made. */
  readonly position: Point;
  /** Farthest sound distance it carries. */
  readonly radius: number;
  /** How much it alarms a listener, 0 to 1: awareness rises to at least this (default 0.5). */
  readonly priority?: number;
  /** Who made it, when that is known to the listener; its memory is updated (default a shared `'sound'` memory). */
  readonly source?: TargetId;
}

/** What an agent remembers about one target. */
export interface TargetMemory {
  /** The target's id. */
  readonly id: TargetId;
  /** Last known position; do not keep the array, it is reused. */
  readonly position: readonly [number, number, number];
  /** Last known velocity. */
  readonly velocity: readonly [number, number, number];
  /** How sure the agent is that the target is there: 0 to 1, reaching 1 means noticed. */
  readonly awareness: number;
  /** `awareness` as a level. */
  readonly level: AwarenessLevel;
  /** True while the target is in view right now. */
  readonly visible: boolean;
  /** Seconds since the target was last sensed. */
  readonly age: number;
  /** The sense that last updated this memory. */
  readonly sense: 'sight' | 'hearing';
}

/** Options of {@link Perception}. */
export interface PerceptionOptions {
  /** The sight shapes; a target held by several uses the shortest time (default one cone, 20 m, 110 degrees). */
  sight?: readonly SightShape[];
  /** Height of the eyes above `agent.position` on +Y (default 0: the position is the eye). */
  eyeHeight?: number;
  /** Blocks sight; see {@link sphereOcclusion} (default nothing blocks). */
  lineOfSight?: LineOfSight;
  /** Scales every sound's radius for this agent: 0.5 hears half as far (default 1). */
  hearing?: number;
  /** Measures sound around walls, for example along a navmesh route (default straight distance). */
  soundDistance?: SoundDistance;
  /** Awareness at which the agent turns suspicious, above 0 and below 1 (default 0.4). */
  suspiciousAt?: number;
  /** Seconds a memory takes to fade from full awareness to nothing while nothing is sensed (default 30). */
  forgetTime?: number;
  /** Longest time `predict` carries a target along its last velocity, in seconds (default 1.5). */
  predictTime?: number;
  /** Written after every `update` and `hear`, under the `perception*` keys. */
  blackboard?: Blackboard;
}

/** Blackboard key: id of the target the agent is most aware of, while it is suspicious or aware. */
export const perceptionTarget: BlackboardKey<TargetId | null> = blackboardKey<TargetId | null>(
  'perception.target',
  null,
);
/** Blackboard key: last known position of `perceptionTarget`, a new array only when it moved. */
export const perceptionPosition: BlackboardKey<readonly [number, number, number] | null> = blackboardKey<
  readonly [number, number, number] | null
>('perception.position', null);
/** Blackboard key: the level of `perceptionTarget`, or `'calm'`. */
export const perceptionLevel: BlackboardKey<AwarenessLevel> = blackboardKey<AwarenessLevel>('perception.level', 'calm');
/** Blackboard key: true while `perceptionTarget` is in view. */
export const perceptionVisible: BlackboardKey<boolean> = blackboardKey('perception.visible', false);

const point = (value: Point, label: string): void => {
  if (
    value == null ||
    value.length < 3 ||
    !Number.isFinite(value[0]) ||
    !Number.isFinite(value[1]) ||
    !Number.isFinite(value[2])
  )
    throw new RangeError(`${label} must be [x, y, z] with finite numbers`);
};
const positive = (value: number, label: string): number => {
  if (!(value > 0) || !Number.isFinite(value)) throw new RangeError(`${label} must be a finite number above 0`);
  return value;
};
const notNegative = (value: number, label: string): number => {
  if (!(value >= 0) || !Number.isFinite(value)) throw new RangeError(`${label} must be a finite number of 0 or more`);
  return value;
};

const checkShape = (shape: SightShape): void => {
  if (shape == null || typeof shape !== 'object')
    throw new TypeError("A sight shape must be {kind: 'cone' | 'coffin'}");
  positive(shape.range, 'Sight range');
  notNegative(shape.nearTime ?? 0, 'Sight nearTime');
  notNegative(shape.farTime ?? 0, 'Sight farTime');
  if (shape.kind === 'cone') {
    if (!(shape.fov > 0 && shape.fov <= 2 * Math.PI))
      throw new RangeError('Sight cone fov must be radians above 0 and up to 2 * Math.PI');
  } else if (shape.kind === 'coffin') {
    positive(shape.width, 'Sight coffin width');
    if (!(shape.shoulder > 0 && shape.shoulder < shape.range))
      throw new RangeError('Sight coffin shoulder must be between 0 and range');
  } else throw new RangeError(`Unknown sight shape '${(shape as { kind: string }).kind}'; use 'cone' or 'coffin'`);
};

/** True when a point `along` forward and `across` off that axis, `distance` from the eye, is inside `shape`. */
const insideShape = (shape: SightShape, along: number, across: number, distance: number): boolean => {
  if (shape.kind === 'cone') {
    if (distance > shape.range) return false;
    if (distance === 0) return true;
    return Math.acos(Math.max(-1, Math.min(1, along / distance))) <= shape.fov / 2;
  }
  if (along < 0 || along > shape.range) return false;
  const half = shape.width / 2;
  const allowed =
    along <= shape.shoulder
      ? (half * along) / shape.shoulder
      : (half * (shape.range - along)) / (shape.range - shape.shoulder);
  return across <= allowed;
};

/**
 * A {@link LineOfSight} over spheres, for example the `SteeringObstacle`s of `@margoengine/behavior/steering`. A sphere
 * blocks a line that passes through it; an end point inside a sphere does not count as blocked by that sphere, so an
 * agent leaning on a pillar still sees out. The array is read on every call.
 */
export function sphereOcclusion(spheres: readonly { position: Point; radius: number }[]): LineOfSight {
  return (from, to) => {
    const dx = (to[0] as number) - (from[0] as number);
    const dy = (to[1] as number) - (from[1] as number);
    const dz = (to[2] as number) - (from[2] as number);
    const length2 = dx * dx + dy * dy + dz * dz;
    if (length2 === 0) return true;
    for (const { position, radius } of spheres) {
      const r2 = radius * radius;
      const fx = (position[0] as number) - (from[0] as number);
      const fy = (position[1] as number) - (from[1] as number);
      const fz = (position[2] as number) - (from[2] as number);
      if (fx * fx + fy * fy + fz * fz <= r2) continue;
      const tx = (position[0] as number) - (to[0] as number);
      const ty = (position[1] as number) - (to[1] as number);
      const tz = (position[2] as number) - (to[2] as number);
      if (tx * tx + ty * ty + tz * tz <= r2) continue;
      const t = Math.max(0, Math.min(1, (fx * dx + fy * dy + fz * dz) / length2));
      const cx = fx - t * dx;
      const cy = fy - t * dy;
      const cz = fz - t * dz;
      if (cx * cx + cy * cy + cz * cz < r2) return false;
    }
    return true;
  };
}

interface MemoryRow {
  id: TargetId;
  position: [number, number, number];
  velocity: [number, number, number];
  awareness: number;
  level: AwarenessLevel;
  visible: boolean;
  age: number;
  sense: 'sight' | 'hearing';
}

const straight: SoundDistance = (a, b) =>
  Math.hypot(
    (a[0] as number) - (b[0] as number),
    (a[1] as number) - (b[1] as number),
    (a[2] as number) - (b[2] as number),
  );
const clear: LineOfSight = () => true;
const DEFAULT_SIGHT: readonly SightShape[] = [{ kind: 'cone', range: 20, fov: (110 * Math.PI) / 180 }];

/**
 * What one agent senses and remembers. Call {@link Perception.update} every tick with the targets in the world and
 * {@link Perception.hear} for each noise; read {@link Perception.memory} or the blackboard. Time comes only from the
 * `delta` you pass, so the same calls give the same results.
 * @example
 * const guard = { position: [0, 0, 0], forward: [0, 0, 1] };
 * const eyes = new Perception(guard, { blackboard: new Blackboard() });
 * eyes.update(1 / 60, [{ id: 'player', position: [0, 0, 5] }]);
 */
export class Perception {
  /** The agent, read on every call. */
  readonly agent: PerceivingAgent;
  /** Everything remembered, by target id. */
  readonly memory: ReadonlyMap<TargetId, TargetMemory>;
  private readonly rows = new Map<TargetId, MemoryRow>();
  private readonly sight: readonly SightShape[];
  private readonly eyeHeight: number;
  private readonly lineOfSight: LineOfSight;
  private readonly hearing: number;
  private readonly soundDistance: SoundDistance;
  private readonly suspiciousAt: number;
  private readonly forgetTime: number;
  private readonly predictTime: number;
  private readonly blackboard: Blackboard | undefined;
  private readonly eye: [number, number, number] = [0, 0, 0];
  private readonly look: [number, number, number] = [0, 0, 1];

  /**
   * @param agent The position and facing to perceive from.
   * @throws TypeError or RangeError for a malformed agent or option.
   */
  constructor(agent: PerceivingAgent, options: PerceptionOptions = {}) {
    if (agent == null || typeof agent !== 'object') throw new TypeError('Perception agent must be {position, forward}');
    this.agent = agent;
    this.memory = this.rows;
    this.sight = options.sight ?? DEFAULT_SIGHT;
    if (!Array.isArray(this.sight)) throw new TypeError('Perception sight must be an array of shapes');
    for (const shape of this.sight) checkShape(shape);
    this.eyeHeight = options.eyeHeight ?? 0;
    if (!Number.isFinite(this.eyeHeight)) throw new RangeError('Perception eyeHeight must be a finite number');
    this.lineOfSight = options.lineOfSight ?? clear;
    this.soundDistance = options.soundDistance ?? straight;
    if (typeof this.lineOfSight !== 'function' || typeof this.soundDistance !== 'function')
      throw new TypeError('Perception lineOfSight and soundDistance must be functions');
    this.hearing = notNegative(options.hearing ?? 1, 'Perception hearing');
    this.suspiciousAt = options.suspiciousAt ?? 0.4;
    if (!(this.suspiciousAt > 0 && this.suspiciousAt < 1))
      throw new RangeError('Perception suspiciousAt must be above 0 and below 1');
    this.forgetTime = positive(options.forgetTime ?? 30, 'Perception forgetTime');
    this.predictTime = notNegative(options.predictTime ?? 1.5, 'Perception predictTime');
    this.blackboard = options.blackboard;
    this.pose();
  }

  private pose(): void {
    const { position, forward } = this.agent;
    point(position, 'Agent position');
    point(forward, 'Agent forward');
    const fx = forward[0] as number;
    const fy = forward[1] as number;
    const fz = forward[2] as number;
    const length = Math.hypot(fx, fy, fz);
    if (!(length > 0)) throw new RangeError('Agent forward must not be zero');
    this.eye[0] = position[0] as number;
    this.eye[1] = (position[1] as number) + this.eyeHeight;
    this.eye[2] = position[2] as number;
    this.look[0] = fx / length;
    this.look[1] = fy / length;
    this.look[2] = fz / length;
  }

  /** Seconds to notice something at `at`, or `Infinity` outside every shape. The agent's pose must be current. */
  private detectionTime(at: Point): number {
    const dx = (at[0] as number) - this.eye[0];
    const dy = (at[1] as number) - this.eye[1];
    const dz = (at[2] as number) - this.eye[2];
    const distance = Math.hypot(dx, dy, dz);
    const along = dx * this.look[0] + dy * this.look[1] + dz * this.look[2];
    const across = Math.sqrt(Math.max(0, distance * distance - along * along));
    let best = Number.POSITIVE_INFINITY;
    for (const shape of this.sight) {
      if (!insideShape(shape, along, across, distance)) continue;
      const near = shape.nearTime ?? 0.2;
      const far = shape.farTime ?? 1.5;
      const time = near + (far - near) * Math.min(1, distance / shape.range);
      if (time < best) best = time;
    }
    return best;
  }

  /** True when `at` is inside a sight shape with nothing in the way. Rules out places on an {@link OccupancyMap}. */
  canSee(at: Point): boolean {
    point(at, 'Point');
    this.pose();
    return this.detectionTime(at) !== Number.POSITIVE_INFINITY && this.lineOfSight(this.eye, at);
  }

  private level(awareness: number): AwarenessLevel {
    return awareness >= 1 ? 'aware' : awareness >= this.suspiciousAt ? 'suspicious' : 'calm';
  }

  private row(id: TargetId, position: Point): MemoryRow {
    let row = this.rows.get(id);
    if (!row) {
      row = {
        id,
        position: [position[0] as number, position[1] as number, position[2] as number],
        velocity: [0, 0, 0],
        awareness: 0,
        level: 'calm',
        visible: false,
        age: 0,
        sense: 'sight',
      };
      this.rows.set(id, row);
    }
    return row;
  }

  /**
   * Advance by `delta` seconds. A target in a sight shape with enough points in view fills its awareness over the
   * shape's detection time; everything else fades over `forgetTime` and is forgotten at 0.
   * @param delta Seconds since the last call, 0 or more.
   * @param targets Everything that could be seen.
   * @throws RangeError for a malformed target.
   */
  update(delta: number, targets: Iterable<PerceptionTarget>): void {
    notNegative(delta, 'Perception delta');
    this.pose();
    const sensed = new Set<TargetId>();
    for (const target of targets) {
      if (target == null || typeof target !== 'object')
        throw new TypeError('A perception target must be {id, position}');
      point(target.position, 'Target position');
      const needed = target.pointsNeeded ?? 1;
      if (!(needed >= 1)) throw new RangeError('Target pointsNeeded must be 1 or more');
      const ease = positive(target.visibility ?? 1, 'Target visibility');
      const velocity = target.velocity;
      if (velocity != null) point(velocity, 'Target velocity');
      const time = this.detectionTime(target.position);
      if (time === Number.POSITIVE_INFINITY) continue;
      const points = target.points ?? [target.position];
      let inView = 0;
      for (let i = 0; i < points.length && inView < needed; i++) {
        point(points[i] as Point, 'Target point');
        if (this.lineOfSight(this.eye, points[i] as Point)) inView++;
      }
      if (inView < needed) continue;
      const seenTime = time / ease;
      const row = this.row(target.id, target.position);
      sensed.add(target.id);
      row.awareness = seenTime > 0 ? Math.min(1, row.awareness + delta / seenTime) : 1;
      row.level = this.level(row.awareness);
      row.visible = true;
      row.age = 0;
      row.sense = 'sight';
      row.position[0] = target.position[0] as number;
      row.position[1] = target.position[1] as number;
      row.position[2] = target.position[2] as number;
      row.velocity[0] = velocity?.[0] ?? 0;
      row.velocity[1] = velocity?.[1] ?? 0;
      row.velocity[2] = velocity?.[2] ?? 0;
    }
    for (const row of this.rows.values()) {
      if (sensed.has(row.id)) continue;
      row.visible = false;
      row.age += delta;
      row.awareness -= delta / this.forgetTime;
      if (row.awareness <= 0) this.rows.delete(row.id);
      else row.level = this.level(row.awareness);
    }
    this.publish();
  }

  /**
   * Hear a noise: it reaches the agent when its sound distance is within `radius` (scaled by the `hearing` option).
   * Awareness rises to at least the sound's `priority` and the memory moves to where the sound was made, unless the
   * source is in plain view.
   * @returns True when the agent heard it.
   * @throws RangeError for a malformed sound.
   */
  hear(sound: PerceptionSound): boolean {
    if (sound == null || typeof sound !== 'object') throw new TypeError('A sound must be {position, radius}');
    point(sound.position, 'Sound position');
    notNegative(sound.radius, 'Sound radius');
    const priority = sound.priority ?? 0.5;
    if (!(priority >= 0 && priority <= 1)) throw new RangeError('Sound priority must be between 0 and 1');
    this.pose();
    if (!(this.soundDistance(sound.position, this.agent.position) <= sound.radius * this.hearing)) return false;
    const row = this.row(sound.source ?? 'sound', sound.position);
    if (!row.visible) {
      row.position[0] = sound.position[0] as number;
      row.position[1] = sound.position[1] as number;
      row.position[2] = sound.position[2] as number;
      row.velocity[0] = row.velocity[1] = row.velocity[2] = 0;
      row.age = 0;
      row.sense = 'hearing';
    }
    row.awareness = Math.max(row.awareness, priority);
    row.level = this.level(row.awareness);
    if (row.awareness <= 0) this.rows.delete(row.id);
    this.publish();
    return true;
  }

  /** The target the agent is most aware of, or `null` while calm. Ties go to the most recently sensed. */
  focus(): TargetMemory | null {
    let best: MemoryRow | null = null;
    for (const row of this.rows.values()) {
      if (row.level === 'calm') continue;
      if (!best || row.awareness > best.awareness || (row.awareness === best.awareness && row.age < best.age))
        best = row;
    }
    return best;
  }

  /**
   * Where a remembered target probably is now: its last known position carried along its last velocity, for at most
   * `predictTime` seconds. Returns `null` for a target with no memory.
   */
  predict(id: TargetId, out: [number, number, number] = [0, 0, 0]): [number, number, number] | null {
    const row = this.rows.get(id);
    if (!row) return null;
    const time = Math.min(row.age, this.predictTime);
    out[0] = row.position[0] + row.velocity[0] * time;
    out[1] = row.position[1] + row.velocity[1] * time;
    out[2] = row.position[2] + row.velocity[2] * time;
    return out;
  }

  /** Forget one target, or everything when `id` is left out. */
  forget(id?: TargetId): void {
    if (id === undefined) this.rows.clear();
    else this.rows.delete(id);
    this.publish();
  }

  private publish(): void {
    const board = this.blackboard;
    if (!board) return;
    const focus = this.focus();
    board.set(perceptionTarget, focus ? focus.id : null);
    board.set(perceptionLevel, focus ? focus.level : 'calm');
    board.set(perceptionVisible, focus ? focus.visible : false);
    const held = board.get(perceptionPosition);
    if (!focus) board.set(perceptionPosition, null);
    else if (!held || held[0] !== focus.position[0] || held[1] !== focus.position[1] || held[2] !== focus.position[2])
      board.set(perceptionPosition, [focus.position[0], focus.position[1], focus.position[2]]);
  }
}

/** Options of {@link OccupancyMap}. */
export interface OccupancyMapOptions {
  /** Share of a node's chance that spreads to its neighbours each step, 0 to 1 (default 0.1). Fast targets want more. */
  diffusion?: number;
}

/** Options of {@link OccupancyMap.grid}. */
export interface OccupancyGridOptions extends OccupancyMapOptions {
  /** Lowest corner of the grid on the ground plane, `[x, z]`. */
  min: readonly [number, number];
  /** Cells along x and along z. */
  size: readonly [number, number];
  /** Cell width. */
  cell: number;
  /** Height of every node (default 0). */
  y?: number;
  /** True for a point a target cannot stand on or cross (default none). */
  blocked?: (position: readonly [number, number, number]) => boolean;
}

/**
 * Where a target that went out of sight could be: a Probabilistic Occupancy Map (Isla and Blumberg 2002). Each node
 * holds the chance the target is there. {@link OccupancyMap.diffuse} spreads it while the target moves unseen,
 * {@link OccupancyMap.observe} pins it where the target is seen, and {@link OccupancyMap.cull} clears places the agent
 * can see are empty, so the best guess moves on and a search falls out of walking to {@link OccupancyMap.best}.
 */
export class OccupancyMap {
  /** World position of each node, three numbers a node. */
  readonly positions: Float64Array;
  /** Chance per node; sums to 1 once observed. */
  readonly probability: Float64Array;
  private readonly next: Float64Array;
  private readonly neighbors: readonly (readonly number[])[];
  private readonly diffusion: number;

  /**
   * @param positions Three numbers a node.
   * @param neighbors For each node, the nodes a target can step to from it.
   * @throws RangeError for a malformed graph.
   */
  constructor(
    positions: ArrayLike<number>,
    neighbors: readonly (readonly number[])[],
    options: OccupancyMapOptions = {},
  ) {
    if (positions == null || positions.length === 0 || positions.length % 3 !== 0)
      throw new RangeError('OccupancyMap positions must be three numbers a node, at least one node');
    const count = positions.length / 3;
    if (!Array.isArray(neighbors) || neighbors.length !== count)
      throw new RangeError('OccupancyMap neighbors must list one array per node');
    for (const list of neighbors)
      for (const node of list)
        if (!Number.isInteger(node) || node < 0 || node >= count)
          throw new RangeError(`OccupancyMap neighbours must be node numbers below ${count}, not ${node}`);
    this.diffusion = options.diffusion ?? 0.1;
    if (!(this.diffusion >= 0 && this.diffusion <= 1)) throw new RangeError('OccupancyMap diffusion must be 0 to 1');
    this.positions = Float64Array.from(positions);
    this.neighbors = neighbors;
    this.probability = new Float64Array(count);
    this.next = new Float64Array(count);
  }

  /**
   * A square grid on the ground plane with four neighbours a cell. The paper uses a hexagonal grid; the update rules
   * do not depend on the shape.
   * @throws RangeError for a malformed grid or when `blocked` leaves no node.
   */
  static grid(options: OccupancyGridOptions): OccupancyMap {
    const { min, size, cell, y = 0, blocked } = options;
    positive(cell, 'OccupancyMap cell');
    const [nx, nz] = size;
    if (!Number.isInteger(nx) || !Number.isInteger(nz) || nx < 1 || nz < 1)
      throw new RangeError('OccupancyMap size must be two whole numbers of 1 or more');
    const index = new Int32Array(nx * nz).fill(-1);
    const positions: number[] = [];
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++) {
        const at: [number, number, number] = [min[0] + (x + 0.5) * cell, y, min[1] + (z + 0.5) * cell];
        if (blocked?.(at)) continue;
        index[z * nx + x] = positions.length / 3;
        positions.push(at[0], at[1], at[2]);
      }
    const neighbors: number[][] = [];
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++) {
        if ((index[z * nx + x] as number) < 0) continue;
        const list: number[] = [];
        const add = (cx: number, cz: number): void => {
          if (cx < 0 || cz < 0 || cx >= nx || cz >= nz) return;
          const node = index[cz * nx + cx] as number;
          if (node >= 0) list.push(node);
        };
        add(x - 1, z);
        add(x + 1, z);
        add(x, z - 1);
        add(x, z + 1);
        neighbors.push(list);
      }
    return new OccupancyMap(positions, neighbors, options);
  }

  /** The node nearest `at`. */
  nearest(at: Point): number {
    point(at, 'Point');
    const { positions } = this;
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < positions.length; i += 3) {
      const dx = (positions[i] as number) - (at[0] as number);
      const dy = (positions[i + 1] as number) - (at[1] as number);
      const dz = (positions[i + 2] as number) - (at[2] as number);
      const distance = dx * dx + dy * dy + dz * dz;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i / 3;
      }
    }
    return best;
  }

  /**
   * The target was seen at `at`: all probability moves to the nearest node (equations 1.5 and 1.6).
   * @returns How surprising that place was (equation 1.8): 0 for the likeliest node, higher the less expected,
   * `Infinity` for a node the map had ruled out, and 0 on the first sighting.
   */
  observe(at: Point): number {
    const node = this.nearest(at);
    const { probability } = this;
    let highest = 0;
    for (let i = 0; i < probability.length; i++) highest = Math.max(highest, probability[i] as number);
    const here = probability[node] as number;
    const surprise = highest === 0 ? 0 : here === 0 ? Number.POSITIVE_INFINITY : (highest - here) / here;
    probability.fill(0);
    probability[node] = 1;
    return surprise;
  }

  /**
   * One step of spread while the target is unseen (equation 1.3). Each node keeps the rest and gives equal shares to
   * its neighbours, so the total stays the same even at walls, where the paper's formula assumes six neighbours. With
   * `velocity` (world units per step) the shares favour that direction (equation 1.4), and when a node's shares add
   * up to more than 1 they are scaled back to 1.
   */
  diffuse(velocity?: Point): void {
    const { probability, next, positions, neighbors, diffusion } = this;
    if (velocity != null) point(velocity, 'Velocity');
    next.fill(0);
    const rates: number[] = [];
    for (let node = 0; node < probability.length; node++) {
      const chance = probability[node] as number;
      if (chance === 0) continue;
      const list = neighbors[node] as readonly number[];
      if (list.length === 0) {
        next[node] = (next[node] as number) + chance;
        continue;
      }
      let total = 0;
      for (let i = 0; i < list.length; i++) {
        let rate = diffusion / list.length;
        if (velocity != null) {
          const other = (list[i] as number) * 3;
          const lx = (positions[other] as number) - (positions[node * 3] as number);
          const ly = (positions[other + 1] as number) - (positions[node * 3 + 1] as number);
          const lz = (positions[other + 2] as number) - (positions[node * 3 + 2] as number);
          const length2 = lx * lx + ly * ly + lz * lz;
          if (length2 > 0)
            rate += Math.max(
              0,
              ((velocity[0] as number) * lx + (velocity[1] as number) * ly + (velocity[2] as number) * lz) / length2,
            );
        }
        rates[i] = rate;
        total += rate;
      }
      const scale = total > 1 ? 1 / total : 1;
      for (let i = 0; i < list.length; i++) {
        const other = list[i] as number;
        next[other] = (next[other] as number) + chance * (rates[i] as number) * scale;
      }
      next[node] = (next[node] as number) + chance * (1 - total * scale);
    }
    probability.set(next);
  }

  /**
   * The agent looked and the target is not there: nodes for which `visible` returns true are zeroed and the rest
   * scaled back up to a total of 1 (equations 1.9 to 1.11).
   * @param visible For example `(at) => perception.canSee(at)`.
   * @returns The share removed: how much of a surprise the target's absence is. A result of 1 means every place it
   * could be was seen empty; the map then holds nothing until the next `observe`.
   */
  cull(visible: (position: readonly [number, number, number]) => boolean): number {
    const { probability, positions } = this;
    let culled = 0;
    let left = 0;
    const at: [number, number, number] = [0, 0, 0];
    for (let node = 0; node < probability.length; node++) {
      const chance = probability[node] as number;
      if (chance === 0) continue;
      at[0] = positions[node * 3] as number;
      at[1] = positions[node * 3 + 1] as number;
      at[2] = positions[node * 3 + 2] as number;
      if (visible(at)) {
        culled += chance;
        probability[node] = 0;
      } else left += chance;
    }
    if (left > 0)
      for (let node = 0; node < probability.length; node++) probability[node] = (probability[node] as number) / left;
    return culled + left > 0 ? culled / (culled + left) : 0;
  }

  /** The likeliest place, or `null` while the map holds nothing. Ties go to the lowest node, so a search repeats. */
  best(out: [number, number, number] = [0, 0, 0]): [number, number, number] | null {
    const { probability, positions } = this;
    let node = -1;
    let highest = 0;
    for (let i = 0; i < probability.length; i++)
      if ((probability[i] as number) > highest) {
        highest = probability[i] as number;
        node = i;
      }
    if (node < 0) return null;
    out[0] = positions[node * 3] as number;
    out[1] = positions[node * 3 + 1] as number;
    out[2] = positions[node * 3 + 2] as number;
    return out;
  }
}
