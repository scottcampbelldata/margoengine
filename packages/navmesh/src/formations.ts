// Troops and cavalry in formation: line, column, square and wedge; marching that holds its spacing; wheeling on a
// flank; re-forming; film time that seeks. Each member steers to its slot in the moving formation, avoids its
// neighbours, and is kept out of every other member's body:
// - slot following: C. W. Reynolds, "Flocks, herds and schools: a distributed behavioral model", SIGGRAPH 1987, and
//   C. W. Reynolds, "Steering behaviors for autonomous characters", Game Developers Conference 1999 (seek, arrival with a
//   slowing radius, offset pursuit of a leader: the slot velocity is fed forward and the slot error closed by arrival);
// - neighbour avoidance: J. van den Berg, S. J. Guy, M. Lin and D. Manocha, "Reciprocal n-body collision avoidance",
//   ISRR 2009 (Springer STAR 70, 2011), the solver of ./orca.js;
// - no interpenetration: a position projection between body shapes (discs for men, capsules for horses) after each
//   step, M. Mueller, B. Heidelberger, M. Hennix and J. Ratcliff, "Position based dynamics", JVRIR 3(2), 2007, as
//   T. Weiss, A. Litteneker, C. Jiang and D. Terzopoulos, "Position-based multi-agent dynamics for real-time crowd
//   simulation", MIG 2017, uses it for crowds;
// - routing over open ground: a formation can march down any direction field, such as a `@margoengine/behavior/flowfield`
//   field whose integration solves the eikonal equation as A. Treuille, S. Cooper and Z. Popovic, "Continuum crowds",
//   SIGGRAPH 2006, section 4.3, sets out, or along a path from this package's navmesh queries.
// Spacing defaults are the close-order figures of the U.S. Infantry Drill Regulations (1911): a front of about 22 inches
// (0.56 m) a file, 40 inches between ranks, the quick step of 30 inches at 120 a minute (1.52 m/s, as in U.S. Army
// FM 3-21.5, "Drill and Ceremonies", 2003); cavalry about one yard of front a trooper, ranks a horse length plus a
// metre apart. Squares are four ranks deep, as the infantry squares of the Napoleonic wars. A skirmish line is one
// rank in extended order, two paces (1.52 m) between men by default, the normal interval of the Regulations' extended
// order, and a charge goes in at double time (180 steps of 36 inches a minute, 2.74 m/s; mounted, the gallop), the speed
// built up at a set rate so a mounted line walks, trots, canters and gallops in turn.
import { avoid, type Agent } from './orca.js';

/** The shape a formation takes. */
export type FormationShape = 'line' | 'column' | 'square' | 'wedge' | 'skirmish';
/** Every shape. */
export const FORMATION_SHAPES: readonly FormationShape[] = ['line', 'column', 'square', 'wedge', 'skirmish'];
/** The normal interval between skirmishers, m: two paces of 30 inches (Infantry Drill Regulations 1911, extended order). */
export const SKIRMISH_GAP = 1.524;
/** Options of {@link Formation.charge}. */
export interface ChargeOptions {
  /** Where the charge goes in, `[x, z]`; it halts within a rank of it. Default straight ahead until halted. */
  goal?: readonly [number, number];
  /** Charging speed, m/s. Default the formation's `maxSpeed`: double time on foot, 7 m/s (a gallop) mounted. */
  speed?: number;
  /** How fast the speed builds, m/s^2. Default 1 on foot, 0.6 mounted (a walk to a gallop over about 40 m). */
  acceleration?: number;
}
/** Men on foot, or horses. */
export type FormationKind = 'infantry' | 'cavalry';

/** Options of {@link Army.add}. Only `count` is needed. */
export interface FormationOptions {
  /** Members, 1 to 4096. */
  count: number;
  /** Default `'infantry'`. Cavalry members are capsules along their heading and cannot step sideways. */
  kind?: FormationKind;
  /** Default `'line'`. */
  shape?: FormationShape;
  /** Open space between skirmishers on top of the file interval, m. Default {@link SKIRMISH_GAP}, two paces. */
  gap?: number;
  /** Members a rank (line, column) or a face (square). Default: line count/ranks, column 4, square count/(4 ranks). */
  files?: number;
  /** Ranks deep. Default 2 (line), 4 (square); a column is as deep as it needs to be. */
  ranks?: number;
  /** File spacing centre to centre, m. Default 0.56 infantry, 0.95 cavalry. */
  interval?: number;
  /** Rank spacing centre to centre, m. Default 1.32 infantry, 3.4 cavalry. */
  distance?: number;
  /** Where the middle of the front rank (the centre of a square) starts, `[x, z]`. Default `[0, 0]`. */
  position?: readonly [number, number];
  /** Facing in radians about +Y, 0 facing +Z. Default 0. */
  heading?: number;
  /** Marching speed, m/s. Default 1.52 infantry (quick time), 1.7 cavalry (walk). */
  speed?: number;
  /** Fastest a member may go to keep its place, m/s. Default 2.74 infantry (double time), 7 cavalry. */
  maxSpeed?: number;
  /** Body half width, m. Default 0.25 infantry, 0.33 cavalry. */
  radius?: number;
  /** Body length along the heading, m (a capsule); 0 for a disc. Default 0 infantry, 2.2 cavalry. */
  length?: number;
  /** Fastest a member turns, radians a second. Default 4 infantry, 1.6 cavalry. */
  turnRate?: number;
}

/** A direction field to march down: `@margoengine/behavior/flowfield`'s FlowField fits. */
export interface DirectionField {
  direction(position: ArrayLike<number>, out?: [number, number, number]): [number, number, number];
}

/** One member of an army, as the simulation has it now. */
export interface Member {
  /** Its formation's index in {@link Army.formations}. */
  readonly formation: number;
  /** Its slot in the formation's shape. */
  readonly slot: number;
  readonly x: number;
  readonly z: number;
  /** Facing, radians about +Y, 0 facing +Z. */
  readonly heading: number;
  /** Ground speed now, m/s. */
  readonly speed: number;
  /** Metres walked since time 0: a stride phase is this over the stride length, so feet never slide. */
  readonly distance: number;
  readonly radius: number;
  readonly length: number;
}

interface MemberState {
  formation: number;
  slot: number;
  x: number;
  z: number;
  vx: number;
  vz: number;
  heading: number;
  speed: number;
  distance: number;
  radius: number;
  length: number;
  maxSpeed: number;
  /** Top speed now: maxSpeed, or more while its formation charges. */
  surge: number;
  turnRate: number;
  cavalry: boolean;
}

type Command =
  | { at: number; formation: number; kind: 'form'; shape: FormationShape; files?: number; ranks?: number; gap?: number }
  | {
      at: number;
      formation: number;
      kind: 'charge';
      goal?: readonly [number, number];
      speed: number;
      acceleration: number;
    }
  | {
      at: number;
      formation: number;
      kind: 'march';
      path?: readonly (readonly [number, number])[];
      field?: DirectionField;
      goal?: readonly [number, number];
      speed?: number;
    }
  | { at: number; formation: number; kind: 'wheel'; angle: number; pivot: 'left' | 'right' }
  | { at: number; formation: number; kind: 'face'; heading: number }
  | { at: number; formation: number; kind: 'halt' };

/** Slots of a shape in the formation's frame: `[lateral (+ left), forward, heading offset]` each. */
export function formationSlots(
  shape: FormationShape,
  count: number,
  options: { files?: number; ranks?: number; interval?: number; distance?: number; gap?: number } = {},
): [number, number, number][] {
  if (!FORMATION_SHAPES.includes(shape))
    throw new RangeError(`Formation shape must be one of ${FORMATION_SHAPES.join(', ')}`);
  if (!(Number.isInteger(count) && count >= 1 && count <= 4096))
    throw new RangeError('A formation needs 1 to 4096 members');
  const iv = options.interval ?? 0.56,
    d = options.distance ?? 1.32;
  if (!(iv > 0) || !(d > 0)) throw new RangeError('Formation interval and distance must be above 0 metres');
  const out: [number, number, number][] = [];
  if (shape === 'skirmish') {
    // Extended order: one rank (or as many as asked), each man his file's front plus the open gap from the next.
    const gap = options.gap ?? SKIRMISH_GAP,
      ranks = options.ranks ?? 1;
    if (!(gap >= 0 && gap <= 50)) throw new RangeError('Skirmish gap must be 0 to 50 metres');
    if (!(Number.isInteger(ranks) && ranks >= 1))
      throw new RangeError('Formation ranks must be a whole number, 1 or more');
    const files = options.files ?? Math.ceil(count / ranks);
    if (!(Number.isInteger(files) && files >= 1))
      throw new RangeError('Formation files must be a whole number, 1 or more');
    for (let i = 0; i < count; i++) {
      const r = Math.floor(i / files),
        c = i % files,
        inRank = Math.min(files, count - r * files);
      // Later ranks stand in the gaps of the rank ahead (half a spacing over), so nobody's line of fire is blocked.
      out.push([((inRank - 1) / 2 - c + (r % 2) / 2) * (iv + gap), -r * d, 0]);
    }
  } else if (shape === 'line' || shape === 'column') {
    const ranks = shape === 'line' ? (options.ranks ?? 2) : undefined,
      files = options.files ?? (shape === 'column' ? 4 : Math.ceil(count / ranks!));
    if (!(Number.isInteger(files) && files >= 1))
      throw new RangeError('Formation files must be a whole number, 1 or more');
    if (ranks !== undefined && !(Number.isInteger(ranks) && ranks >= 1))
      throw new RangeError('Formation ranks must be a whole number, 1 or more');
    for (let i = 0; i < count; i++) {
      const r = Math.floor(i / files),
        c = i % files,
        inRank = Math.min(files, count - r * files);
      out.push([((inRank - 1) / 2 - c) * iv, -r * d, 0]);
    }
  } else if (shape === 'square') {
    const ranks = options.ranks ?? 4,
      files = options.files ?? Math.max(2, Math.ceil(count / (4 * ranks)));
    if (!(Number.isInteger(ranks) && ranks >= 1) || !(Number.isInteger(files) && files >= 1))
      throw new RangeError('Square ranks and files must be whole numbers, 1 or more');
    const half = ((files - 1) / 2) * iv + ranks * d + 0.5 * iv;
    for (let i = 0; i < count; i++) {
      const face = i % 4,
        k = Math.floor(i / 4),
        r = Math.floor(k / files) % ranks,
        c = k % files,
        lat = ((files - 1) / 2 - c) * iv,
        out1 = half - r * d - (Math.floor(k / (files * ranks)) * d) / 2,
        a = (face * Math.PI) / 2,
        // Face 0 faces forward; the faces go round to the left.
        s = lat * Math.cos(a) + out1 * Math.sin(a),
        f = -lat * Math.sin(a) + out1 * Math.cos(a);
      out.push([s, f, a]);
    }
  } else {
    let r = 0,
      i = 0;
    while (i < count) {
      const inRank = Math.min(2 * r + 1, count - i);
      for (let j = 0; j < inRank; j++, i++) out.push([((inRank - 1) / 2 - j) * iv, -r * d, 0]);
      r++;
    }
  }
  return out;
}

const KIND_DEFAULTS = {
  infantry: {
    interval: 0.56,
    distance: 1.32,
    speed: 1.524,
    maxSpeed: 2.743,
    radius: 0.25,
    length: 0,
    turnRate: 4,
    acceleration: 1,
  },
  cavalry: {
    interval: 0.95,
    distance: 3.4,
    speed: 1.7,
    maxSpeed: 7,
    radius: 0.33,
    length: 2.2,
    turnRate: 1.6,
    acceleration: 0.6,
  },
};

/** A formation in an {@link Army}: give it orders; they are kept on the film timeline. */
export class Formation {
  /** The middle of the front rank (the centre of a square), `[x, z]`. */
  readonly anchor: [number, number];
  heading: number;
  shape: FormationShape;
  files?: number;
  ranks?: number;
  /** Member indices into {@link Army.members}, by slot. */
  readonly members: number[] = [];
  /** Slots in the formation's frame. */
  slots: [number, number, number][] = [];
  /** `'halt'`, `'march'`, `'wheel'`, `'face'` or `'charge'`. */
  mode: 'halt' | 'march' | 'wheel' | 'face' | 'charge' = 'halt';
  /** The formation's speed now, m/s: the marching speed, or a charge's speed as it builds. */
  speed: number;
  /** Open space between skirmishers, m. */
  gap: number;
  /** @internal The speed a charge builds to. */ chargeSpeed = 0;
  /** @internal How fast it builds, m/s^2. */ chargeAcceleration = 0;
  /** @internal The marching speed the formation goes back to after a charge. */ marchSpeed = 0;
  /** @internal */ path?: readonly (readonly [number, number])[];
  /** @internal */ waypoint = 0;
  /** @internal */ field?: DirectionField;
  /** @internal */ goal?: readonly [number, number];
  /** @internal */ wheelLeft = 0;
  /** @internal */ wheelPivot: 'left' | 'right' = 'left';
  /** @internal */ wheelThen: 'halt' | 'march' = 'halt';
  /** @internal */ faceTo = 0;
  readonly kind: FormationKind;
  readonly interval: number;
  readonly distance: number;
  constructor(
    readonly army: Army,
    readonly index: number,
    readonly options: Readonly<FormationOptions>,
  ) {
    const k = KIND_DEFAULTS[options.kind ?? 'infantry'];
    this.kind = options.kind ?? 'infantry';
    this.interval = options.interval ?? k.interval;
    this.distance = options.distance ?? k.distance;
    this.anchor = [options.position?.[0] ?? 0, options.position?.[1] ?? 0];
    this.heading = options.heading ?? 0;
    this.shape = options.shape ?? 'line';
    this.files = options.files;
    this.ranks = options.ranks;
    this.speed = options.speed ?? k.speed;
    this.gap = options.gap ?? SKIRMISH_GAP;
    this.slots = [];
    this.reset();
  }
  /** @internal Back to the start: position, heading, shape, halted, no members. */
  reset(): void {
    const options = this.options;
    this.anchor[0] = options.position?.[0] ?? 0;
    this.anchor[1] = options.position?.[1] ?? 0;
    this.heading = options.heading ?? 0;
    this.shape = options.shape ?? 'line';
    this.files = options.files;
    this.ranks = options.ranks;
    this.speed = options.speed ?? KIND_DEFAULTS[this.kind].speed;
    this.gap = options.gap ?? SKIRMISH_GAP;
    this.mode = 'halt';
    this.path = this.field = this.goal = undefined;
    this.members.length = 0;
    this.slots = formationSlots(this.shape, options.count, {
      files: this.files,
      ranks: this.ranks,
      interval: this.interval,
      distance: this.distance,
      gap: this.gap,
    });
  }
  /** Width of the front, m. */
  get front(): number {
    let lo = Infinity,
      hi = -Infinity;
    for (const s of this.slots) {
      lo = Math.min(lo, s[0]);
      hi = Math.max(hi, s[0]);
    }
    return hi - lo;
  }
  /** Where slot `i` is in the world now: `[x, z, heading]`. */
  slot(i: number): [number, number, number] {
    const s = this.slots[i]!,
      c = Math.cos(this.heading),
      n = Math.sin(this.heading);
    return [this.anchor[0] + s[0] * c + s[1] * n, this.anchor[1] - s[0] * n + s[1] * c, this.heading + s[2]];
  }
  /** Re-forms into another shape; members take the nearest new slots. `gap` opens a skirmish line wider or closer. */
  form(shape: FormationShape, options: { files?: number; ranks?: number; gap?: number } = {}): this {
    formationSlots(shape, this.options.count, {
      ...options,
      interval: this.interval,
      distance: this.distance,
      gap: options.gap ?? this.gap,
    });
    return this.army.order({ at: this.army.time, formation: this.index, kind: 'form', shape, ...options }), this;
  }
  /**
   * Marches: along `path` (`[x, z]` points, such as a navmesh path), down a direction `field` until within a rank of
   * `goal`, or straight ahead when given neither.
   */
  march(
    options: {
      path?: readonly (readonly [number, number])[];
      field?: DirectionField;
      goal?: readonly [number, number];
      speed?: number;
    } = {},
  ): this {
    if (
      options.path !== undefined &&
      (!Array.isArray(options.path) || options.path.some((p) => !(Number.isFinite(p?.[0]) && Number.isFinite(p?.[1]))))
    )
      throw new RangeError('march path must be [x, z] points');
    if (options.field !== undefined && typeof options.field?.direction !== 'function')
      throw new TypeError('march field needs a direction(position) method');
    if (options.speed !== undefined && !(options.speed > 0 && options.speed <= 25))
      throw new RangeError('march speed must be above 0 and at most 25 m/s');
    return this.army.order({ at: this.army.time, formation: this.index, kind: 'march', ...options }), this;
  }
  /** Wheels by `angle` radians (positive to the left) on the `pivot` flank; the outer flank keeps the marching speed. */
  wheel(angle: number, pivot?: 'left' | 'right'): this {
    if (!Number.isFinite(angle) || angle === 0) throw new RangeError('wheel needs a non-zero finite angle in radians');
    const p = pivot ?? (angle > 0 ? 'left' : 'right');
    if (p !== 'left' && p !== 'right') throw new RangeError("wheel pivot must be 'left' or 'right'");
    return this.army.order({ at: this.army.time, formation: this.index, kind: 'wheel', angle, pivot: p }), this;
  }
  /** Every member turns where it stands to face `heading`; the formation turns about its centre. */
  face(heading: number): this {
    if (!Number.isFinite(heading)) throw new RangeError('face needs a finite heading in radians');
    return this.army.order({ at: this.army.time, formation: this.index, kind: 'face', heading }), this;
  }
  /**
   * Charges: straight ahead, or at `goal`, the speed building from the formation's speed now to the charge speed at
   * `acceleration`, so horses go through their gaits. It halts within a rank of the goal and takes up its marching
   * speed again. While charging every member may go a sixth over the charge speed to close up on its slot.
   */
  charge(options: ChargeOptions = {}): this {
    const k = KIND_DEFAULTS[this.kind],
      speed = options.speed ?? this.options.maxSpeed ?? k.maxSpeed,
      acceleration = options.acceleration ?? k.acceleration;
    if (options.goal !== undefined && !(Number.isFinite(options.goal?.[0]) && Number.isFinite(options.goal?.[1])))
      throw new RangeError('charge goal must be [x, z]');
    if (!(speed > 0 && speed <= 25)) throw new RangeError('charge speed must be above 0 and at most 25 m/s');
    if (!(acceleration > 0 && acceleration <= 20))
      throw new RangeError('charge acceleration must be above 0 and at most 20 m/s^2');
    return (
      this.army.order({
        at: this.army.time,
        formation: this.index,
        kind: 'charge',
        goal: options.goal,
        speed,
        acceleration,
      }),
      this
    );
  }
  halt(): this {
    return this.army.order({ at: this.army.time, formation: this.index, kind: 'halt' }), this;
  }
}
/** A charging member may go this much over the charge speed to close up on its slot. */
const SURGE = 7 / 6;

/** Options of {@link Army}. */
export interface ArmyOptions {
  /** Fixed simulation step, seconds. Default 1/60. */
  step?: number;
  /** ORCA time horizon, seconds. Default 1.5. */
  horizon?: number;
  /** Neighbours each member avoids, nearest first. Default 10. */
  neighbours?: number;
  /** Ground height under a point, for {@link Army.heightAt}. Default flat at 0. */
  ground?: (x: number, z: number) => number;
}

/**
 * Any number of formations on one field, stepped together on a fixed clock so members of different formations avoid
 * each other. Orders are kept with their film time, so {@link Army.seek} replays to any time exactly.
 * @example
 * const army = new Army();
 * const foot = army.add({count: 80, shape: 'line'});
 * foot.march();
 * army.advanceTime(1 / 30); // or army.seek(20)
 */
export class Army {
  readonly formations: Formation[] = [];
  private states: MemberState[] = [];
  private commands: Command[] = [];
  private obstacles: { x: number; z: number; radius: number }[] = [];
  /** Film time asked for. */
  private clock = 0;
  /** Whole fixed steps simulated: the state is on this grid, shown interpolated toward the film time. */
  private ticks = 0;
  /** Each member's state one step before the grid state, for the interpolated view. */
  private previous: Float64Array = new Float64Array(0);
  private view: Member[] = [];
  private viewAt = -1;
  private next = 0;
  readonly step: number;
  readonly horizon: number;
  readonly neighbours: number;
  readonly ground: (x: number, z: number) => number;
  constructor(options: ArmyOptions = {}) {
    this.step = options.step ?? 1 / 60;
    this.horizon = options.horizon ?? 1.5;
    this.neighbours = options.neighbours ?? 10;
    this.ground = options.ground ?? (() => 0);
    if (!(this.step > 0 && this.step <= 0.1)) throw new RangeError('Army step must be above 0 and at most 0.1 s');
    if (!(this.horizon > 0 && this.horizon < Infinity)) throw new RangeError('Army horizon must be above 0 seconds');
    if (!(Number.isInteger(this.neighbours) && this.neighbours >= 1 && this.neighbours <= 64))
      throw new RangeError('Army neighbours must be 1 to 64');
    if (typeof this.ground !== 'function') throw new TypeError('Army ground must be a function (x, z) => height');
  }
  /** Film time, seconds. */
  get time(): number {
    return this.clock;
  }
  /** Every member now. */
  /**
   * Every member at the film time: the fixed-step state, interpolated between the two steps around the film time, so
   * the same film time always shows the same thing however time was advanced.
   */
  get members(): readonly Member[] {
    const grid = this.ticks * this.step,
      a = Math.min(1, Math.max(0, (this.clock - grid) / this.step));
    if (a <= 1e-12 || this.previous.length !== this.states.length * 5) return this.states;
    if (this.viewAt !== this.clock) {
      // The state at grid + a step is not simulated yet; extrapolating would differ from playing, so show the blend of
      // the last two grid states shifted forward by a: previous -> current covers one step.
      this.view = this.states.map((s, i) => {
        const p = this.previous,
          o = i * 5,
          dh = Math.atan2(Math.sin(s.heading - p[o + 2]!), Math.cos(s.heading - p[o + 2]!));
        return {
          ...s,
          x: s.x + (s.x - p[o]!) * a,
          z: s.z + (s.z - p[o + 1]!) * a,
          heading: s.heading + dh * a,
          distance: s.distance + (s.distance - p[o + 3]!) * a,
        };
      });
      this.viewAt = this.clock;
    }
    return this.view;
  }
  /** Ground height at a point. */
  heightAt(x: number, z: number): number {
    return this.ground(x, z);
  }
  /** Adds a formation at its start position, members on their slots. Formations are added before time runs. */
  add(options: FormationOptions): Formation {
    if (this.clock > 0 || this.ticks > 0)
      throw new RangeError('Add formations at time 0, before advanceTime or seek moves the army');
    const kind = options?.kind ?? 'infantry';
    if (kind !== 'infantry' && kind !== 'cavalry')
      throw new RangeError("Formation kind must be 'infantry' or 'cavalry'");
    const k = KIND_DEFAULTS[kind];
    for (const key of ['interval', 'distance', 'speed', 'maxSpeed', 'radius', 'turnRate'] as const)
      if (options[key] !== undefined && !(options[key]! > 0 && options[key]! < 1000))
        throw new RangeError(`Formation ${key} must be a positive number`);
    if (options.length !== undefined && !(options.length >= 0 && options.length < 20))
      throw new RangeError('Formation length must be 0 to 20 metres');
    if (options.gap !== undefined && !(options.gap >= 0 && options.gap <= 50))
      throw new RangeError('Skirmish gap must be 0 to 50 metres');
    const f = new Formation(this, this.formations.length, { ...options });
    this.formations.push(f);
    this.place(f, k);
    return f;
  }
  /** A disc nobody enters (a tree, a wall post), `[x, z]` and radius. Added before time runs. */
  addObstacle(position: readonly [number, number], radius: number): void {
    if (!(Number.isFinite(position?.[0]) && Number.isFinite(position?.[1]) && radius > 0))
      throw new RangeError('addObstacle needs [x, z] and a radius above 0');
    this.obstacles.push({ x: position[0], z: position[1], radius });
  }
  private place(f: Formation, k: (typeof KIND_DEFAULTS)[FormationKind]): void {
    const o = f.options;
    for (let i = 0; i < o.count; i++) {
      const [x, z, h] = f.slot(i);
      f.members.push(this.states.length);
      this.states.push({
        formation: f.index,
        slot: i,
        x,
        z,
        vx: 0,
        vz: 0,
        heading: h,
        speed: 0,
        distance: 0,
        radius: o.radius ?? k.radius,
        length: o.length ?? k.length,
        maxSpeed: o.maxSpeed ?? k.maxSpeed,
        surge: o.maxSpeed ?? k.maxSpeed,
        turnRate: o.turnRate ?? k.turnRate,
        cavalry: f.kind === 'cavalry',
      });
    }
  }
  /** @internal Records an order at the current time; orders after now are cut (a re-shot from here). */
  order(c: Command): void {
    this.commands = this.commands.filter((x) => x.at <= this.clock + 1e-9);
    this.next = Math.min(this.next, this.commands.length);
    this.commands.push(c);
    // On the grid the order takes effect now (so its state shows at once); between steps it waits for the next step,
    // exactly as a replay applies it.
    if (Math.abs(c.at - this.ticks * this.step) < 1e-9 && this.next === this.commands.length - 1)
      this.apply(this.commands[this.next++]!);
  }
  private apply(c: Command): void {
    const f = this.formations[c.formation]!;
    if (c.kind === 'form') {
      f.shape = c.shape;
      f.files = c.files;
      f.ranks = c.ranks;
      if (c.gap !== undefined) f.gap = c.gap;
      f.slots = formationSlots(c.shape, f.options.count, {
        files: c.files,
        ranks: c.ranks,
        interval: f.interval,
        distance: f.distance,
        gap: f.gap,
      });
      // Nearest free slot for each member, members in slot order: deterministic.
      const free = new Set(f.slots.map((_, i) => i)),
        order = [...f.members];
      f.members.length = 0;
      const assigned: number[] = new Array(f.slots.length);
      for (const m of order) {
        const s = this.states[m]!;
        let best = -1,
          bd = Infinity;
        for (const i of free) {
          const [x, z] = f.slot(i),
            d = (x - s.x) ** 2 + (z - s.z) ** 2;
          if (d < bd) {
            bd = d;
            best = i;
          }
        }
        free.delete(best);
        assigned[best] = m;
        s.slot = best;
      }
      f.members.push(...assigned);
    } else if (c.kind === 'charge') {
      if (f.mode !== 'charge') f.marchSpeed = f.speed;
      // From a halt the charge builds from a standstill.
      if (f.mode === 'halt' || f.mode === 'face') f.speed = 0;
      f.mode = 'charge';
      f.path = f.field = undefined;
      f.goal = c.goal;
      f.chargeSpeed = c.speed;
      f.chargeAcceleration = c.acceleration;
      for (const m of f.members) this.states[m]!.surge = Math.max(this.states[m]!.maxSpeed, c.speed * SURGE);
    } else if (c.kind === 'march') {
      if (f.mode === 'charge') this.endCharge(f);
      f.mode = 'march';
      f.path = c.path;
      f.waypoint = 0;
      f.field = c.field;
      f.goal = c.goal;
      if (c.speed !== undefined) f.speed = c.speed;
    } else if (c.kind === 'wheel') {
      if (f.mode === 'charge') {
        this.endCharge(f);
        f.mode = 'march';
      }
      f.wheelThen = f.mode === 'march' ? 'march' : 'halt';
      f.mode = 'wheel';
      f.wheelLeft = c.angle;
      f.wheelPivot = c.pivot;
    } else if (c.kind === 'face') {
      if (f.mode === 'charge') this.endCharge(f);
      f.mode = 'face';
      f.faceTo = c.heading;
    } else {
      if (f.mode === 'charge') this.endCharge(f);
      f.mode = 'halt';
    }
  }
  /** Back to the marching speed and the members' own top speed. */
  private endCharge(f: Formation): void {
    f.speed = f.marchSpeed;
    for (const m of f.members) this.states[m]!.surge = this.states[m]!.maxSpeed;
  }
  /** Moves the anchors of every formation one step. */
  private moveAnchors(dt: number): void {
    for (const f of this.formations) {
      if (f.mode === 'charge') {
        f.speed = Math.min(f.chargeSpeed, f.speed + f.chargeAcceleration * dt);
        if (f.goal) {
          const ex = f.goal[0] - f.anchor[0],
            ez = f.goal[1] - f.anchor[1],
            l = Math.hypot(ex, ez);
          if (l < Math.max(f.distance, f.speed * dt)) {
            this.endCharge(f);
            f.mode = 'halt';
            continue;
          }
          // Turn toward the goal no faster than the outer flank can keep up, as on the march.
          let dh = Math.atan2(ex, ez) - f.heading;
          dh = Math.atan2(Math.sin(dh), Math.cos(dh));
          const half = Math.max(f.interval, f.front / 2),
            rate = Math.max(0.02, (f.chargeSpeed * SURGE - f.speed) / half);
          f.heading += Math.max(-rate * dt, Math.min(rate * dt, dh));
        }
        f.anchor[0] += Math.sin(f.heading) * f.speed * dt;
        f.anchor[1] += Math.cos(f.heading) * f.speed * dt;
      } else if (f.mode === 'march') {
        let dx = Math.sin(f.heading),
          dz = Math.cos(f.heading);
        if (f.path && f.waypoint < f.path.length) {
          const p = f.path[f.waypoint]!,
            ex = p[0] - f.anchor[0],
            ez = p[1] - f.anchor[1],
            l = Math.hypot(ex, ez);
          if (l < Math.max(0.5, f.speed * dt * 2)) {
            f.waypoint++;
            if (f.waypoint >= f.path.length) {
              f.mode = 'halt';
              continue;
            }
          }
          if (l > 1e-9) {
            dx = ex / l;
            dz = ez / l;
          }
        } else if (f.path) {
          f.mode = 'halt';
          continue;
        } else if (f.field) {
          if (f.goal && Math.hypot(f.goal[0] - f.anchor[0], f.goal[1] - f.anchor[1]) < f.distance) {
            f.mode = 'halt';
            continue;
          }
          const d = f.field.direction([f.anchor[0], 0, f.anchor[1]]),
            l = Math.hypot(d[0], d[2]);
          if (l < 1e-9) {
            f.mode = 'halt';
            continue;
          }
          dx = d[0] / l;
          dz = d[2] / l;
        }
        // Turn toward the way to go no faster than the outer flank can keep up.
        const want = Math.atan2(dx, dz);
        let dh = want - f.heading;
        dh = Math.atan2(Math.sin(dh), Math.cos(dh));
        const half = Math.max(f.interval, f.front / 2),
          rate = Math.max(0.02, (this.maxSpeedOf(f) - f.speed) / half);
        f.heading += Math.max(-rate * dt, Math.min(rate * dt, dh));
        const go = Math.cos(dh) > 0.7 ? f.speed : f.speed * Math.max(0, Math.cos(dh));
        f.anchor[0] += Math.sin(f.heading) * go * dt;
        f.anchor[1] += Math.cos(f.heading) * go * dt;
      } else if (f.mode === 'wheel') {
        // The pivot is the end of the front rank on that side; the outer flank marches at the formation's speed.
        let lo = Infinity,
          hi = -Infinity;
        for (const s of f.slots) {
          if (s[1] !== 0) continue;
          lo = Math.min(lo, s[0]);
          hi = Math.max(hi, s[0]);
        }
        const pivotLat = f.wheelPivot === 'left' ? hi : lo,
          radius = Math.max(f.interval, hi - lo),
          step = Math.min(Math.abs(f.wheelLeft), (f.speed / radius) * dt) * Math.sign(f.wheelLeft),
          c = Math.cos(f.heading),
          n = Math.sin(f.heading),
          px = f.anchor[0] + pivotLat * c,
          pz = f.anchor[1] - pivotLat * n,
          ax = f.anchor[0] - px,
          az = f.anchor[1] - pz,
          // A positive angle turns left: heading grows, the frame rotates the same way about +Y.
          cs = Math.cos(step),
          sn = Math.sin(step);
        f.anchor[0] = px + ax * cs + az * sn;
        f.anchor[1] = pz - ax * sn + az * cs;
        f.heading += step;
        f.wheelLeft -= step;
        if (Math.abs(f.wheelLeft) < 1e-9) f.mode = f.wheelThen;
      } else if (f.mode === 'face') {
        let dh = f.faceTo - f.heading;
        dh = Math.atan2(Math.sin(dh), Math.cos(dh));
        const states = f.members.map((m) => this.states[m]!),
          rate = Math.min(...states.map((s) => s.turnRate)) * 0.5,
          step = Math.max(-rate * dt, Math.min(rate * dt, dh));
        // Turn about the formation's centre.
        let cx = 0,
          cz = 0;
        for (let i = 0; i < f.slots.length; i++) {
          const [x, z] = f.slot(i);
          cx += x / f.slots.length;
          cz += z / f.slots.length;
        }
        const ax = f.anchor[0] - cx,
          az = f.anchor[1] - cz,
          cs = Math.cos(step),
          sn = Math.sin(step);
        f.anchor[0] = cx + ax * cs + az * sn;
        f.anchor[1] = cz - ax * sn + az * cs;
        f.heading += step;
        if (Math.abs(dh - step) < 1e-9) f.mode = 'halt';
      }
    }
  }
  private maxSpeedOf(f: Formation): number {
    return this.states[f.members[0]!]?.maxSpeed ?? KIND_DEFAULTS[f.kind].maxSpeed;
  }
  /** Gap between two members' bodies (negative when they overlap) and the unit normal from b to a. */
  private gap(a: MemberState, b: MemberState): [number, number, number] {
    const seg = (s: MemberState) => {
      const h = Math.max(0, s.length / 2 - s.radius),
        dx = Math.sin(s.heading) * h,
        dz = Math.cos(s.heading) * h;
      return [s.x - dx, s.z - dz, s.x + dx, s.z + dz];
    };
    const [p, q] = closestSegments(seg(a), seg(b)),
      nx = p[0] - q[0],
      nz = p[1] - q[1],
      l = Math.hypot(nx, nz);
    if (l < 1e-9) {
      // Exactly on top of each other: part along the member order, deterministically.
      return [-(a.radius + b.radius), 1, 0];
    }
    return [l - a.radius - b.radius, nx / l, nz / l];
  }
  /** Steps the whole army by one fixed step. */
  private tick(dt: number): void {
    const start = this.ticks * this.step;
    while (this.next < this.commands.length && this.commands[this.next]!.at <= start + 1e-9)
      this.apply(this.commands[this.next++]!);
    if (this.previous.length !== this.states.length * 5) this.previous = new Float64Array(this.states.length * 5);
    this.states.forEach((s, i) => this.previous.set([s.x, s.z, s.heading, s.distance, s.speed], i * 5));
    this.moveAnchors(dt);
    const states = this.states,
      n = states.length,
      reach = 2 * Math.max(...states.map((s) => s.length / 2 + s.radius), 0.5) + 2;
    // Uniform grid of members for neighbour queries.
    const grid = new Map<number, number[]>(),
      key = (ix: number, iz: number) => ix * 73856093 + iz * 19349663;
    states.forEach((s, i) => {
      const k = key(Math.floor(s.x / reach), Math.floor(s.z / reach));
      const cell = grid.get(k);
      if (cell) cell.push(i);
      else grid.set(k, [i]);
    });
    const near = (i: number): number[] => {
      const s = states[i]!,
        ix = Math.floor(s.x / reach),
        iz = Math.floor(s.z / reach),
        found: [number, number][] = [];
      for (let a = -1; a <= 1; a++)
        for (let b = -1; b <= 1; b++)
          for (const j of grid.get(key(ix + a, iz + b)) ?? [])
            if (j !== i) found.push([j, (states[j]!.x - s.x) ** 2 + (states[j]!.z - s.z) ** 2]);
      found.sort((p, q) => p[1] - q[1] || p[0] - q[0]);
      return found.map((f) => f[0]);
    };
    // Preferred velocities: the slot's own velocity fed forward plus arrival on the slot error.
    const next = new Float64Array(2 * n),
      agents: Agent[] = states.map((s, i) => ({
        id: i,
        position: [s.x, s.z],
        velocity: [s.vx, s.vz],
        preferred: [0, 0],
        radius: s.radius,
        maxSpeed: s.surge,
      }));
    for (const f of this.formations) {
      const moving = f.mode !== 'halt',
        c = Math.cos(f.heading),
        sn = Math.sin(f.heading);
      for (let k = 0; k < f.members.length; k++) {
        const i = f.members[k]!,
          s = states[i]!,
          [tx, tz] = f.slot(k),
          ex = tx - s.x,
          ez = tz - s.z,
          e = Math.hypot(ex, ez),
          // Arrival: full catch-up speed beyond 2 m, slowing linearly inside it (Reynolds 1999).
          catchUp = Math.min(s.surge, (s.surge * e) / 2),
          ahead = moving && (f.mode === 'march' || f.mode === 'charge'),
          fx = ahead ? sn * f.speed : 0,
          fz = ahead ? c * f.speed : 0;
        let px = fx + (e > 1e-9 ? (ex / e) * catchUp : 0),
          pz = fz + (e > 1e-9 ? (ez / e) * catchUp : 0);
        const l = Math.hypot(px, pz);
        if (l > s.surge) {
          px *= s.surge / l;
          pz *= s.surge / l;
        }
        agents[i]!.preferred = [px, pz];
      }
    }
    const out = new Float64Array(2),
      obstacleAgents = this.obstacles.map((o, k) => ({
        id: -1 - k,
        position: [o.x, o.z] as [number, number],
        velocity: [0, 0] as [number, number],
        preferred: [0, 0] as [number, number],
        radius: o.radius,
        maxSpeed: 0,
        reciprocal: false,
      }));
    for (let i = 0; i < n; i++) {
      const nb = near(i)
        .slice(0, this.neighbours)
        .map((j) => agents[j]!);
      for (const o of obstacleAgents)
        if (Math.hypot(o.position[0] - states[i]!.x, o.position[1] - states[i]!.z) < reach + o.radius) nb.push(o);
      avoid(agents[i]!, nb, dt, this.horizon, out);
      next[2 * i] = out[0]!;
      next[2 * i + 1] = out[1]!;
    }
    // Integrate: men step any way; horses go where they face, with a little sideways give.
    const before = states.map((s) => [s.x, s.z]);
    for (let i = 0; i < n; i++) {
      const s = states[i]!;
      let vx = next[2 * i]!,
        vz = next[2 * i + 1]!;
      const v = Math.hypot(vx, vz),
        f = this.formations[s.formation]!,
        slotHeading = f.slot(s.slot)[2],
        want = v > 0.3 ? Math.atan2(vx, vz) : slotHeading;
      let dh = want - s.heading;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      s.heading += Math.max(-s.turnRate * dt, Math.min(s.turnRate * dt, dh));
      if (s.cavalry) {
        const hx = Math.sin(s.heading),
          hz = Math.cos(s.heading),
          ahead = Math.max(-0.5, vx * hx + vz * hz),
          side = Math.max(-0.4, Math.min(0.4, vx * hz - vz * hx));
        vx = hx * ahead + hz * side;
        vz = hz * ahead - hx * side;
      }
      s.vx = vx;
      s.vz = vz;
      s.x += vx * dt;
      s.z += vz * dt;
    }
    // Projection: no two bodies overlap, nobody stands in an obstacle.
    // Gauss-Seidel passes; a horse (about 500 kg) moves a man (about 80 kg) more than he moves it.
    const near2 = states.map((_, i) => near(i).filter((j) => j > i));
    // Until no pair overlaps by more than 0.1 mm, at most 40 passes.
    for (let it = 0, deep = Infinity; it < 40 && deep > 1e-4; it++) {
      deep = 0;
      for (let i = 0; i < n; i++) {
        const a = states[i]!;
        for (const j of near2[i]!) {
          const b = states[j]!,
            [g, nx, nz] = this.gap(a, b);
          if (g >= 0) continue;
          deep = Math.max(deep, -g);
          const wa = a.cavalry ? 80 : 500,
            wb = b.cavalry ? 80 : 500,
            push = -g + 2e-4,
            ka = (push * wa) / (wa + wb),
            kb = (push * wb) / (wa + wb);
          a.x += nx * ka;
          a.z += nz * ka;
          b.x -= nx * kb;
          b.z -= nz * kb;
        }
        for (const o of this.obstacles) {
          const ox = a.x - o.x,
            oz = a.z - o.z,
            l = Math.hypot(ox, oz),
            g = l - o.radius - a.radius - Math.max(0, a.length / 2 - a.radius);
          if (g < 0 && l > 1e-9) {
            deep = Math.max(deep, -g);
            a.x -= (ox / l) * g;
            a.z -= (oz / l) * g;
          }
        }
      }
    }
    for (let i = 0; i < n; i++) {
      const s = states[i]!,
        moved = Math.hypot(s.x - before[i]![0]!, s.z - before[i]![1]!);
      s.speed = moved / dt;
      s.distance += moved;
    }
    this.ticks++;
  }
  /** Moves film time forward by `delta` seconds in fixed steps (the last step is shortened to land on time). */
  advanceTime(delta: number): this {
    if (!(delta >= 0 && delta < Infinity))
      throw new RangeError('advanceTime needs a finite number of seconds, 0 or more');
    // Float drift from many small advances is snapped to the microsecond, so they land on the time one seek reaches; a
    // time that is not near a microsecond (a third) is left as it is.
    const end = this.clock + delta,
      snap = Math.round(end * 1e6) / 1e6;
    this.clock = Math.abs(snap - end) < 1e-9 ? snap : end;
    // Whole steps only, counted, so float sums never drift: the grid is ticks x step.
    while ((this.ticks + 1) * this.step <= this.clock + 1e-9) this.tick(this.step);
    this.viewAt = -1;
    return this;
  }
  /** Jumps to film time `time`: every formation back to its start, then every order replayed. The same as playing to it. */
  seek(time: number): this {
    if (!(time >= 0 && time < Infinity)) throw new RangeError('seek needs a finite film time in seconds, 0 or more');
    this.states = [];
    this.clock = 0;
    this.ticks = 0;
    this.next = 0;
    this.previous = new Float64Array(0);
    this.viewAt = -1;
    for (const f of this.formations) {
      f.reset();
      this.place(f, KIND_DEFAULTS[f.kind]);
    }
    return this.advanceTime(time);
  }
}

/** Closest points between segments [ax, az, bx, bz] (Ericson, "Real-Time Collision Detection", 2005, 5.1.9). */
function closestSegments(s1: number[], s2: number[]): [[number, number], [number, number]] {
  const d1x = s1[2]! - s1[0]!,
    d1z = s1[3]! - s1[1]!,
    d2x = s2[2]! - s2[0]!,
    d2z = s2[3]! - s2[1]!,
    rx = s1[0]! - s2[0]!,
    rz = s1[1]! - s2[1]!,
    a = d1x * d1x + d1z * d1z,
    e = d2x * d2x + d2z * d2z,
    f = d2x * rx + d2z * rz;
  let s = 0,
    t = 0;
  if (a <= 1e-12 && e <= 1e-12) {
    s = t = 0;
  } else if (a <= 1e-12) {
    t = Math.min(1, Math.max(0, f / e));
  } else {
    const c = d1x * rx + d1z * rz;
    if (e <= 1e-12) s = Math.min(1, Math.max(0, -c / a));
    else {
      const b = d1x * d2x + d1z * d2z,
        den = a * e - b * b;
      s = den > 1e-12 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.min(1, Math.max(0, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.min(1, Math.max(0, (b - c) / a));
      }
    }
  }
  return [
    [s1[0]! + d1x * s, s1[1]! + d1z * s],
    [s2[0]! + d2x * t, s2[1]! + d2z * t],
  ];
}
