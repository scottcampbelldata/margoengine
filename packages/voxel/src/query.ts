// @margoengine/voxel/query: ray casts, swept boxes and a player body against a VoxelWorld (design:
// packages/voxel/DESIGN.md, phase 7). Cells are half-open unit boxes: cell (x, y, z) holds the points whose floors are
// (x, y, z). Unloaded cells and cells outside the world's minY..maxY are air.
import type { BoxLike, MutableVec3, Vec3 } from '@margoengine/math';
import type { BlockType } from './blocks.js';
import type { VoxelWorld } from './world.js';

/** A hit from {@link raycastVoxels}. */
export interface VoxelHit {
  /** The cell hit. */
  cell: MutableVec3;
  /**
   * Outward normal of the face the ray entered through: one unit axis (at an exact edge or corner, the first crossed
   * axis in x, y, z order), or [0, 0, 0] when the ray starts inside the cell.
   */
  normal: MutableVec3;
  /** `cell + normal`: the cell in front of that face, where a placed block goes (`cell` itself for a zero normal). */
  adjacent: MutableVec3;
  /** Where the ray enters the cell, exactly on its face (that coordinate is an integer), or the origin. */
  point: MutableVec3;
  /** From the origin to `point`, in blocks. */
  distance: number;
  /** Block state of the cell. */
  state: number;
}

/** Result of {@link sweepBox}. */
export interface VoxelSweep {
  /** Where the box's min corner ends up: `box.min` plus the motion the solid blocks allowed. */
  position: MutableVec3;
  /** Per axis (x, y, z): a solid block stopped the move along it, or touched the box at the end of it. */
  hit: [x: boolean, y: boolean, z: boolean];
  /** The box stands on a solid block: its downward move was stopped, or with motion y 0, it rests on one. */
  onGround: boolean;
}

/** Options of {@link VoxelCharacter}. Distances in blocks, times in seconds. */
export interface VoxelCharacterOptions {
  /** Body box `[width (x), height (y), depth (z)]`. Default [0.6, 1.8, 0.6]. */
  size?: Vec3;
  /** Tallest ledge walked onto without jumping. Default 0.6. */
  stepHeight?: number;
  /** Downward acceleration, blocks/s². Default 32 (Minecraft-like: the default 9 blocks/s jump rises 1.27 blocks). */
  gravity?: number;
  /** Speeds in blocks/s. Defaults: walk 4.317, sprint 5.612, swim 2, fly 11, jump 9 (the take-off speed). */
  speeds?: { walk?: number; sprint?: number; swim?: number; fly?: number; jump?: number };
}

/** What the player asks a {@link VoxelCharacter} to do during one {@link VoxelCharacter.update}. Every field is optional. */
export interface VoxelMoveIntent {
  /**
   * World-space wish direction; its length (clamped to 1) scales the speed, so a half-tilted stick walks at half speed.
   * Walking uses x and z only (flatten the camera's forward first); swimming and flying use all three.
   */
  direction?: Vec3;
  /** Jump off the ground; in liquid swim up (against a wall: climb out); flying, rise. */
  jump?: boolean;
  /** Swim or fly down. Ignored when walking. */
  descend?: boolean;
  /** Walk at `speeds.sprint` instead of `speeds.walk`. */
  sprint?: boolean;
}

const EPS = 1e-6, // contact tolerance in blocks: a box may touch, or overlap by this much, a solid cell
  STEP = 1 / 120, // the character's fixed step, seconds
  MAX_TIME = 0.25, // most time one update simulates; the rest of a longer stall (a background tab) is dropped
  TERMINAL = 78.4, // fall speed limit, blocks/s (Minecraft's)
  SINK = 0.2, // share of gravity left in liquid after buoyancy
  // Share of the gap to the wished velocity closed per step at k/s: acceleration, and friction when the wish is 0.
  rate = (k: number) => 1 - Math.exp(-k * STEP),
  GROUND = rate(20),
  AIR = rate(2),
  SWIM = rate(6),
  FLY = rate(8),
  CELL = [0, 0, 0],
  PROBE = new Float64Array(6);
let blocked = false; // set by clip: a solid cell stopped or touched the last move

const checkWorld = (world: unknown, what: string): void => {
  if (typeof (world as VoxelWorld)?.getBlock !== 'function' || !(world as VoxelWorld).blocks?.table)
    throw new TypeError(`${what} needs a VoxelWorld: pass the world to query`);
};
const finite = (value: unknown, what: string): number => {
  if (typeof value !== 'number') throw new TypeError(`${what} must be a number`);
  if (!Number.isFinite(value)) throw new RangeError(`${what} is ${value}; pass a finite number`);
  return value;
};
const vector = (v: unknown, what: string): Vec3 => {
  if (!v || typeof v !== 'object' || (v as Vec3).length !== 3)
    throw new TypeError(`${what} must be an [x, y, z] array of numbers`);
  const a = v as Vec3;
  return [finite(a[0], `${what} x`), finite(a[1], `${what} y`), finite(a[2], `${what} z`)];
};
const amount = (value: unknown, what: string, fallback: number): number => {
  if (value === undefined) return fallback;
  if (finite(value, what) < 0) throw new RangeError(`${what} ${value} is negative; pass a number >= 0`);
  return value as number;
};

// Picks what a player can target: drawn blocks except liquids (cross blocks such as flowers count, as their cell box).
const picks = (_state: number, type: BlockType): boolean => type.layer !== 'invisible' && !type.liquid;
// A ray's first cell on one axis: the floor, except that a ray leaving an integer coordinate downwards starts below it.
const first = (o: number, d: number): number => {
  const c = Math.floor(o);
  return d < 0 && c === o ? c - 1 : c;
};
// The ray parameter at which a ray leaves cell `c` on one axis (computed afresh, so exact ties stay exact).
const exit = (c: number, o: number, d: number): number =>
  d > 0 ? (c + 1 - o) / d : d < 0 ? (c - o) / d : Number.POSITIVE_INFINITY;

/**
 * Casts a ray from `origin` along `dir` (any non-zero length) up to `max` blocks and returns the first cell it passes
 * through whose block `filter` accepts, or null. Traverses cell by cell (J. Amanatides and A. Woo, "A Fast Voxel
 * Traversal Algorithm for Ray Tracing", Eurographics 1987), stepping every tied axis at once, so a ray through an
 * exact edge or corner skips the cells it only touches there, and a ray in a face plane runs in the cells on its
 * positive side (a cell is the half-open box [x, x + 1) x [y, y + 1) x [z, z + 1)). A ray that starts inside an
 * accepted cell hits it at distance 0; one that starts on its face and points in enters through that face.
 * By default `filter` accepts every block that is drawn and is not a liquid (`layer !== 'invisible' && !liquid`):
 * solid or not, so cross-shaped blocks are hit as their whole cell box; pass `(state, type) => type.liquid` to pick
 * water. Air (state 0) and unknown ids are never hit. Cost: one {@link VoxelWorld.getBlock} per cell crossed.
 * @throws TypeError when `world` is not a VoxelWorld, `origin` or `dir` is not three numbers, `max` is not a
 * number or `filter` is not a function.
 * @throws RangeError for a non-finite value, a zero `dir`, a negative `max`, or an origin outside the 32-bit cells.
 */
export function raycastVoxels(
  world: VoxelWorld,
  origin: Vec3,
  dir: Vec3,
  max: number,
  filter: (state: number, type: BlockType) => boolean = picks,
): VoxelHit | null {
  checkWorld(world, 'raycastVoxels');
  const [ox, oy, oz] = vector(origin, 'Ray origin'),
    [dx, dy, dz] = vector(dir, 'Ray direction'),
    length = Math.hypot(dx, dy, dz);
  if (!length) throw new RangeError('Ray direction is [0, 0, 0]; pass a non-zero direction such as [0, 0, -1]');
  if (finite(max, 'Ray max distance') < 0)
    throw new RangeError(`Ray max distance ${max} is negative; pass a distance >= 0`);
  if (typeof filter !== 'function') throw new TypeError('Ray filter must be a function (state, type) => boolean');
  if (!(Math.abs(ox) < 2 ** 31 && Math.abs(oy) < 2 ** 31 && Math.abs(oz) < 2 ** 31))
    throw new RangeError(`Ray origin (${ox}, ${oy}, ${oz}) is outside the world's 32-bit cells; move it closer`);
  const table = world.blocks.table,
    { minY, maxY } = world,
    end = max / length,
    sx = Math.sign(dx),
    sy = Math.sign(dy),
    sz = Math.sign(dz);
  let x = first(ox, dx),
    y = first(oy, dy),
    z = first(oz, dz),
    tx = exit(x, ox, dx),
    ty = exit(y, oy, dy),
    tz = exit(z, oz, dz),
    t = 0,
    stepped = 0; // axes crossed into the current cell: bit 0 x, 1 y, 2 z
  // Starting on a face of the first cell and pointing in counts as entering through it.
  if (dx && ox === (dx > 0 ? x : x + 1)) stepped = 1;
  else if (dy && oy === (dy > 0 ? y : y + 1)) stepped = 2;
  else if (dz && oz === (dz > 0 ? z : z + 1)) stepped = 4;
  for (;;) {
    if (y >= minY && y <= maxY) {
      const state = world.getBlock(x, y, z),
        type = state ? table[state & 0xffff] : undefined;
      if (type && filter(state, type)) {
        const cell: MutableVec3 = [x, y, z],
          normal: MutableVec3 = [0, 0, 0],
          point: MutableVec3 = [ox + dx * t, oy + dy * t, oz + dz * t],
          axis: number = stepped & 1 ? 0 : stepped & 2 ? 1 : stepped & 4 ? 2 : -1,
          d = [dx, dy, dz];
        if (t) for (let a = 0; a < 3; a++) if (stepped & (1 << a)) point[a] = d[a] > 0 ? cell[a] : cell[a] + 1;
        if (axis >= 0) normal[axis] = -Math.sign(d[axis]);
        return {
          cell,
          normal,
          adjacent: [x + normal[0], y + normal[1], z + normal[2]],
          point,
          distance: t * length,
          state,
        };
      }
    } else if (sy === 0 || (sy > 0 ? y > maxY : y < minY)) return null; // outside minY..maxY, moving away
    t = Math.min(tx, ty, tz);
    if (t > end) return null;
    stepped = 0;
    if (tx === t) {
      x += sx;
      tx = exit(x, ox, dx);
      stepped |= 1;
    }
    if (ty === t) {
      y += sy;
      ty = exit(y, oy, dy);
      stepped |= 2;
    }
    if (tz === t) {
      z += sz;
      tz = exit(z, oz, dz);
      stepped |= 4;
    }
    if ((x | 0) !== x || (z | 0) !== z) return null; // left the 32-bit cells
  }
}

// Moves box `b` (min x, y, z, max x, y, z) along axis `a` by up to `m` blocks and returns the distance moved. It stops
// at the first solid cell ahead that overlaps the box's cross-section by more than EPS, scanning every cell layer the
// move sweeps (no speed tunnels). Cells the box already overlaps are ignored, so a box can leave a block placed inside
// it. `m` 0 probes for a solid cell touching the bottom face. Sets `blocked`.
function clip(world: VoxelWorld, b: Float64Array, a: number, m: number): number {
  const table = world.blocks.table,
    u = a ? 0 : 1,
    v = a === 2 ? 1 : 2,
    u0 = Math.floor(b[u] + EPS),
    v0 = Math.floor(b[v] + EPS),
    up = m > 0,
    face = up ? b[a + 3] : b[a],
    from = up ? Math.ceil(face - EPS) : Math.floor(face + EPS) - 1,
    to = up ? Math.floor(face + m + EPS) : Math.ceil(face + m - EPS) - 1,
    cell = CELL;
  blocked = false;
  layers: for (let n = from; up ? n <= to : n >= to; n += up ? 1 : -1) {
    cell[a] = n;
    for (let i = u0; i < b[u + 3] - EPS; i++)
      for (let j = v0; j < b[v + 3] - EPS; j++) {
        cell[u] = i;
        cell[v] = j;
        if (table[world.getBlock(cell[0], cell[1], cell[2]) & 0xffff]?.solid) {
          blocked = true;
          m = up ? Math.min(m, n - face) : Math.max(m, n + 1 - face);
          break layers;
        }
      }
  }
  b[a] += m;
  b[a + 3] += m;
  return m;
}
// clip along one axis unless `m` is 0; returns whether a solid cell stopped or touched the move.
const slide = (world: VoxelWorld, b: Float64Array, a: number, m: number): boolean =>
  m !== 0 && (clip(world, b, a, m), blocked);
// Moves box `b` by (mx, my, mz), y first, then x, then z; writes the hit axes and returns onGround.
function move(world: VoxelWorld, b: Float64Array, mx: number, my: number, mz: number, hit: boolean[]): boolean {
  hit[1] = slide(world, b, 1, my);
  const ground = my ? hit[1] && my < 0 : (PROBE.set(b), clip(world, PROBE, 1, 0), blocked);
  hit[0] = slide(world, b, 0, mx);
  hit[2] = slide(world, b, 2, mz);
  return ground;
}
// Whether box `b` overlaps a liquid cell by more than EPS.
function wet(world: VoxelWorld, b: Float64Array): boolean {
  const table = world.blocks.table;
  for (let x = Math.floor(b[0] + EPS); x < b[3] - EPS; x++)
    for (let y = Math.floor(b[1] + EPS); y < b[4] - EPS; y++)
      for (let z = Math.floor(b[2] + EPS); z < b[5] - EPS; z++)
        if (table[world.getBlock(x, y, z) & 0xffff]?.liquid) return true;
  return false;
}

/**
 * Moves `box` by `motion` through `world`'s solid blocks (`BlockType.solid`, each its whole cell) and reports where it
 * stops. Axis-separated: y first, then x, then z, each clipped at the first solid cell ahead after scanning every
 * cell layer the move crosses, so nothing tunnels at any speed (cost grows with the distance swept). Touching, or
 * overlapping by up to 1e-6 blocks, is not a collision; blocks the box already overlaps are ignored, so it can move
 * out of a block placed inside it.
 * @throws TypeError when `world` is not a VoxelWorld, `box` is not `{min: {x, y, z}, max: {x, y, z}}` (a Box3 works)
 * or `motion` is not three numbers.
 * @throws RangeError for a non-finite value or an empty box (a min above its max).
 */
export function sweepBox(world: VoxelWorld, box: BoxLike, motion: Vec3): VoxelSweep {
  checkWorld(world, 'sweepBox');
  if (!box?.min || !box.max || typeof box.min !== 'object' || typeof box.max !== 'object')
    throw new TypeError('sweepBox box must be {min: {x, y, z}, max: {x, y, z}}, such as a Box3');
  const b = new Float64Array(6);
  for (let i = 0; i < 6; i++) {
    const axis = 'xyz'[i % 3] as 'x' | 'y' | 'z';
    b[i] = finite((i < 3 ? box.min : box.max)[axis], `sweepBox box ${i < 3 ? 'min' : 'max'}.${axis}`);
  }
  if (b[0] > b[3] || b[1] > b[4] || b[2] > b[5])
    throw new RangeError('sweepBox box is empty (a min exceeds its max); pass min <= max on every axis');
  const [mx, my, mz] = vector(motion, 'sweepBox motion'),
    hit: [boolean, boolean, boolean] = [false, false, false],
    onGround = move(world, b, mx, my, mz, hit);
  return { position: [b[0], b[1], b[2]], hit, onGround };
}

/**
 * A player body in a voxel world: an axis-aligned box that walks with acceleration and friction, falls under
 * gravity, jumps, steps onto ledges up to `stepHeight` (only when the space above is clear, and only from the
 * ground, on landing or in liquid), swims in liquid blocks (buoyant, slower, jump against a wall to climb out) and
 * flies. {@link VoxelCharacter.update} runs fixed 1/120 s steps (G. Fiedler, "Fix Your Timestep!", 2004), so the
 * path does not depend on the frame rate; {@link VoxelCharacter.renderPosition} interpolates between steps for
 * smooth drawing. Collision is {@link sweepBox}, with step-up tried when a horizontal move is blocked.
 *
 * ```ts
 * const player = new VoxelCharacter(world);
 * player.position = [0, 80, 0];
 * engine.onFrame((_, dt) => {
 *   player.update(dt, { direction: [forwardX, 0, forwardZ], jump: keys.has('Space') });
 *   const [x, y, z] = player.renderPosition; // the eye is the game's choice: 1.62 above the feet here
 *   engine.camera.position = [x, y + 1.62, z];
 * });
 * ```
 */
export class VoxelCharacter {
  /** The world it moves in. */
  readonly world: VoxelWorld;
  /** Feet: the bottom centre of the body box, after the last fixed step. Write it (or assign an array) to teleport. */
  position: MutableVec3 = [0, 0, 0];
  /** Velocity, blocks/s. */
  readonly velocity: MutableVec3 = [0, 0, 0];
  /**
   * `position` interpolated between the last two fixed steps by the time left over: draw the body or the camera here
   * for smooth motion at any frame rate. It trails `position` by less than one step.
   */
  readonly renderPosition: MutableVec3 = [0, 0, 0];
  /** Body box `[width, height, depth]`; may change between updates (crouching). */
  readonly size: MutableVec3;
  /** Tallest ledge walked onto without jumping, blocks. */
  stepHeight: number;
  /** Downward acceleration, blocks/s². */
  gravity: number;
  /** Speeds, blocks/s; `jump` is the take-off speed. */
  readonly speeds: { walk: number; sprint: number; swim: number; fly: number; jump: number };
  /** Fly mode: no gravity; `jump` and `descend` move up and down. */
  flying = false;
  private ground = false;
  private liquid = false;
  private pushing = false; // the last step was blocked horizontally
  private time = 0; // simulated time not yet stepped, < STEP
  private readonly previous: MutableVec3 = [0, 0, 0];
  private readonly last: MutableVec3 = [0, 0, 0]; // position as the last update left it, to spot teleports
  private readonly box = new Float64Array(6);
  private readonly start = new Float64Array(6);
  private readonly stepped = new Float64Array(6);
  private readonly hits = [false, false, false];
  /**
   * @throws TypeError when `world` is not a VoxelWorld or an option has the wrong type.
   * @throws RangeError for a non-finite or negative option, or a size that is not positive.
   */
  constructor(world: VoxelWorld, options: VoxelCharacterOptions = {}) {
    checkWorld(world, 'VoxelCharacter');
    if (!options || typeof options !== 'object') throw new TypeError('VoxelCharacter options must be an object');
    this.world = world;
    const size = options.size === undefined ? [0.6, 1.8, 0.6] : vector(options.size, 'VoxelCharacter size');
    if (!(size[0] > 0 && size[1] > 0 && size[2] > 0))
      throw new RangeError(`VoxelCharacter size [${size}] must be positive on every axis, e.g. [0.6, 1.8, 0.6]`);
    this.size = [size[0], size[1], size[2]];
    this.stepHeight = amount(options.stepHeight, 'VoxelCharacter stepHeight', 0.6);
    this.gravity = amount(options.gravity, 'VoxelCharacter gravity', 32);
    const s = options.speeds ?? {};
    if (typeof s !== 'object') throw new TypeError('VoxelCharacter speeds must be {walk, sprint, swim, fly, jump}');
    this.speeds = {
      walk: amount(s.walk, 'VoxelCharacter speeds.walk', 4.317),
      sprint: amount(s.sprint, 'VoxelCharacter speeds.sprint', 5.612),
      swim: amount(s.swim, 'VoxelCharacter speeds.swim', 2),
      fly: amount(s.fly, 'VoxelCharacter speeds.fly', 11),
      jump: amount(s.jump, 'VoxelCharacter speeds.jump', 9),
    };
  }
  /** Standing on a solid block after the last step. */
  get onGround(): boolean {
    return this.ground;
  }
  /** The body overlapped a liquid block in the last step (it swam). */
  get inLiquid(): boolean {
    return this.liquid;
  }
  /**
   * Advances the body by `dt` seconds of `intent`: whole fixed steps of 1/120 s (the remainder carries to the next
   * call; at most 0.25 s per call, the rest of a longer stall is dropped), then updates `renderPosition`.
   * @throws TypeError when `dt` is not a number or `intent` is not an object of the {@link VoxelMoveIntent} fields.
   * @throws RangeError for a negative or non-finite `dt`, or a non-finite direction or teleported position.
   */
  update(dt: number, intent: VoxelMoveIntent = {}): void {
    if (finite(dt, 'VoxelCharacter update dt') < 0)
      throw new RangeError(`VoxelCharacter update dt ${dt} is negative; pass the frame time in seconds`);
    if (!intent || typeof intent !== 'object') throw new TypeError('VoxelCharacter update intent must be an object');
    const [wx, wy, wz] =
        intent.direction === undefined ? [0, 0, 0] : vector(intent.direction, 'VoxelCharacter intent direction'),
      p = this.position,
      q = this.previous;
    if (p[0] !== this.last[0] || p[1] !== this.last[1] || p[2] !== this.last[2]) {
      vector(p, 'VoxelCharacter position'); // teleported: start interpolating from here
      for (let i = 0; i < 3; i++) q[i] = p[i];
    }
    this.time = Math.min(this.time + dt, MAX_TIME);
    // A millionth of a step of slack so frame times that sum to whole steps (1/60 + 1/60) step exactly.
    for (; this.time + STEP * 1e-6 >= STEP; this.time -= STEP) {
      for (let i = 0; i < 3; i++) q[i] = p[i];
      this.step(intent, wx, wy, wz);
    }
    if (this.time < 0) this.time = 0;
    const alpha = this.time / STEP;
    for (let i = 0; i < 3; i++) {
      this.renderPosition[i] = q[i] + (p[i] - q[i]) * alpha;
      this.last[i] = p[i];
    }
  }
  private step(intent: VoxelMoveIntent, wx: number, wy: number, wz: number): void {
    const { world, box: b, start: a, size: s, velocity: v, speeds, hits } = this,
      p = this.position;
    b[0] = p[0] - s[0] / 2;
    b[1] = p[1];
    b[2] = p[2] - s[2] / 2;
    b[3] = p[0] + s[0] / 2;
    b[4] = p[1] + s[1];
    b[5] = p[2] + s[2] / 2;
    const liquid = (this.liquid = wet(world, b));
    if (this.flying || liquid) {
      const wish = wy + (intent.jump ? 1 : 0) - (intent.descend ? 1 : 0),
        speed = (this.flying ? speeds.fly : speeds.swim) / Math.max(1, Math.hypot(wx, wish, wz)),
        f = this.flying ? FLY : SWIM;
      v[0] += (wx * speed - v[0]) * f;
      v[1] += (wish * speed - v[1]) * f;
      v[2] += (wz * speed - v[2]) * f;
      if (!this.flying) {
        v[1] -= this.gravity * SINK * STEP;
        if (intent.jump && this.pushing) v[1] = Math.max(v[1], speeds.jump); // climb out onto a bank
      }
    } else {
      const speed = (intent.sprint ? speeds.sprint : speeds.walk) / Math.max(1, Math.hypot(wx, wz)),
        f = this.ground ? GROUND : AIR;
      v[0] += (wx * speed - v[0]) * f;
      v[2] += (wz * speed - v[2]) * f;
      if (intent.jump && this.ground) v[1] = speeds.jump;
      v[1] = Math.max(v[1] - this.gravity * STEP, -TERMINAL);
    }
    const mx = v[0] * STEP,
      my = v[1] * STEP,
      mz = v[2] * STEP;
    a.set(b);
    let ground = move(world, b, mx, my, mz, hits);
    // Step-up: from the start, rise (the ceiling clips it), move across, settle; kept when it got further across.
    if (this.stepHeight > 0 && (hits[0] || hits[2]) && (this.ground || ground || liquid)) {
      const c = this.stepped;
      c.set(a);
      const rise = clip(world, c, 1, this.stepHeight),
        hx = slide(world, c, 0, mx),
        hz = slide(world, c, 2, mz),
        down = my - rise,
        landed = slide(world, c, 1, down) && down < 0;
      if ((c[0] - a[0]) ** 2 + (c[2] - a[2]) ** 2 > (b[0] - a[0]) ** 2 + (b[2] - a[2]) ** 2 + EPS * EPS) {
        b.set(c);
        hits[0] = hx;
        hits[1] = landed;
        hits[2] = hz;
        ground = landed;
      }
    }
    for (let i = 0; i < 3; i++) if (hits[i]) v[i] = 0;
    this.ground = ground;
    this.pushing = hits[0] || hits[2];
    p[0] = (b[0] + b[3]) / 2;
    p[1] = b[1];
    p[2] = (b[2] + b[5]) / 2;
  }
}
