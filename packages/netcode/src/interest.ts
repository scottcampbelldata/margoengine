// Interest management and bandwidth budgets: each client gets only the entities near it, the most important first,
// within a byte budget per snapshot. It is the `view` of a GameServer, so nothing it leaves out reaches that client.
// The area of interest is the Euclidean circle of Boulanger, Kienzle and Verbrugge (NetGames 2006, section 3.1), with a
// hashed grid only as the index, so the result is the exact circle and not the square tiles of their section 3.2.
// The order is the priority accumulator of Fiedler's "State Synchronization" (2015).
import type { Game } from './game.js';
import { SNAPSHOT_HEADER_BYTES } from './protocol.js';
import type { NormalizedField } from './schema.js';

/** How one map of the state is shared out. `Value` is the type of the map's entries. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface InterestCollection<Value = any> {
  /** Where an entity is: [x, y] or [x, y, z], the same length for every entity. */
  position(value: Value, id: number): ArrayLike<number>;
  /**
   * What is added to the entity's accumulator on each snapshot it waits, 0 or more: bigger goes more often. Default
   * `radius / distance`, from 1 at the edge up to 16 close by.
   */
  priority?(value: Value, id: number, player: number, distance: number): number;
  /** Return true to send the entity at any distance: team mates, objectives, a boss. */
  always?(value: Value, id: number, player: number): boolean;
  /** Return false to hide an entity inside the circle: behind a wall, stealthed. Runs for each one in the circle. */
  visible?(value: Value, id: number, player: number, distance: number): boolean;
}

/** Options of {@link InterestManager}. */
export interface InterestOptions<State> {
  /** The maps of the state to manage, by field name; any other field goes to every client whole. */
  collections: { readonly [field: string]: InterestCollection };
  /** Radius of the area of interest around the player, in world units. */
  radius: number;
  /** An entity in the area stays until it is this far away, so one on the edge does not flicker (default radius x 1.1). */
  leaveRadius?: number;
  /** Size of a grid cell of the index (default `radius`). It changes the speed, never the result. */
  cell?: number;
  /**
   * Most bytes of one snapshot message, or a function of the player (default no limit). For a rate, pass bytes per
   * second divided by snapshots per second. Read on every snapshot, so a function can follow the link as it changes.
   */
  budget?: number | ((player: number) => number);
  /** The id of the player's own entity, always sent and never held back (default the player id). */
  self?(player: number): number;
  /** The centre of the player's area: a camera, say (default the position of its own entity). */
  focus?(state: State, player: number): ArrayLike<number> | undefined;
}

/** What {@link InterestManager.stats} reports of a player's newest snapshot. */
export interface InterestStats {
  /** Entities in the area of interest. */
  inScope: number;
  /** Entities written with their newest value. */
  sent: number;
  /** Entities with something new that the budget held back; their accumulators grew. */
  deferred: number;
  /** Entities the client is told to drop. */
  removed: number;
  /** The most bytes the snapshot message can take: never less than the real size. */
  bytes: number;
  /** Bytes over the budget: the part of the state that always goes (own entity, other fields) did not fit. */
  over: number;
}

interface Managed {
  field: string;
  entry: string;
  reserve: number;
  rules: InterestCollection;
  cells: Map<number, number[]>;
  places: Map<number, ArrayLike<number>>;
}

interface Track {
  acc: Map<number, number>;
  last: Map<number, unknown>;
  scoped: Set<number>;
}

interface Viewer {
  round: number;
  tracks: Track[];
  stats: InterestStats;
}

interface Item {
  track: Track;
  out: Map<number, unknown>;
  entry: string;
  id: number;
  value: unknown;
  held: unknown;
  base: unknown;
  cost: number;
  acc: number;
}

const varint = (v: number): number => {
  let n = 1;
  for (; v >= 128; n++) v = Math.floor(v / 128);
  return n;
};

const positive = (what: string, v: number): number => {
  if (!(v > 0) || !Number.isFinite(v)) throw new RangeError(`InterestManager ${what} is ${v}; pass a number above 0`);
  return v;
};

// Teschner et al. 2003, "Optimized Spatial Hashing for Collision Detection of Deformable Objects": a collision only
// costs a distance test, since every candidate is measured.
const hash = (x: number, y: number, z: number): number =>
  (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) | 0;

/**
 * Picks what each client of a `GameServer` sees. Pass {@link InterestManager.view} as the server's `view`.
 *
 * An entity the budget holds back keeps the value the client last got, so it stays on screen and catches up in its
 * turn. A value sent but not yet acknowledged is repeated until it is, because a snapshot is a delta against what the
 * client confirmed; that is also what makes loss harmless.
 *
 * @example
 * ```ts
 * const interest = new InterestManager(game, {
 *   collections: { boxes: { position: (box) => [box.x, box.y] } },
 *   radius: 50,
 *   budget: 1200,
 * });
 * const server = new GameServer(game, { view: interest.view });
 * ```
 */
export class InterestManager<State, Input = unknown> {
  private readonly managed: Managed[] = [];
  private readonly viewers = new Map<number, Viewer>();
  private readonly radius: number;
  private readonly leave: number;
  private readonly cell: number;
  private indexed: State | undefined;
  private round = 0;

  /**
   * @throws RangeError for a radius, leaveRadius, cell or budget out of range.
   * @throws TypeError for a collection that is not a map of structs at the top of the state.
   */
  constructor(
    readonly game: Game<State, Input>,
    private readonly options: InterestOptions<State>,
  ) {
    this.radius = positive('radius', options?.radius);
    this.leave = options.leaveRadius ?? this.radius * 1.1;
    if (!(this.leave >= this.radius) || !Number.isFinite(this.leave))
      throw new RangeError(`InterestManager leaveRadius is ${this.leave}; pass radius or more`);
    this.cell = positive('cell', options.cell ?? this.radius);
    if (typeof options.budget === 'number' && !(options.budget > 0))
      throw new RangeError(`InterestManager budget is ${options.budget}; pass bytes above 0`);
    const fields = game.schema.json.types[game.stateType];
    for (const [field, rules] of Object.entries(options.collections ?? {})) {
      const type: NormalizedField | undefined = fields[field];
      if (type?.type !== 'map' || type.of.type !== 'struct')
        throw new TypeError(`InterestManager collection '${field}' is not a map of structs in ${game.stateType}; fix it`);
      if (typeof rules?.position !== 'function')
        throw new TypeError(`InterestManager collection '${field}' needs position(value); pass it`);
      this.managed.push({
        field,
        entry: type.of.name,
        reserve: 2 * varint(type.maxSize),
        rules,
        cells: new Map(),
        places: new Map(),
      });
    }
    if (!this.managed.length) throw new TypeError('InterestManager needs at least one collection; pass { collections }');
  }

  /** What the newest snapshot of `player` held, undefined before its first or after it left. */
  stats(player: number): Readonly<InterestStats> | undefined {
    return this.viewers.get(player)?.stats;
  }

  private cellOf(v: number): number {
    return Math.floor(v / this.cell);
  }

  private index(state: State): void {
    this.indexed = state;
    this.round++;
    for (const [player, viewer] of this.viewers) if (viewer.round < this.round - 1) this.viewers.delete(player);
    for (const m of this.managed) {
      m.cells.clear();
      m.places.clear();
      for (const [id, value] of (state as Record<string, unknown>)[m.field] as Map<number, unknown>) {
        const p = m.rules.position(value, id);
        if (p.length < 2 || p.length > 3)
          throw new RangeError(`InterestManager position of ${m.field}(${id}) is not 2 or 3 numbers; return [x, y] or [x, y, z]`);
        for (let k = 0; k < p.length; k++)
          if (!Number.isFinite(p[k]))
            throw new RangeError(`InterestManager position of ${m.field}(${id}) is not finite; fix the position`);
        m.places.set(id, p);
        const key = hash(this.cellOf(p[0]), this.cellOf(p[1]), p.length > 2 ? this.cellOf(p[2]) : 0),
          bucket = m.cells.get(key);
        if (bucket) bucket.push(id);
        else m.cells.set(key, [id]);
      }
    }
  }

  /** Entity id to distance for everything of `m` the player has in scope. */
  private scope(
    m: Managed,
    map: Map<number, unknown>,
    track: Track,
    origin: ArrayLike<number> | undefined,
    player: number,
  ): Map<number, number> {
    const found = new Map<number, number>(),
      { always, visible } = m.rules;
    const measure = (id: number): number => {
      const p = m.places.get(id) as ArrayLike<number>,
        o = origin as ArrayLike<number>;
      let sum = 0;
      for (let k = 0; k < Math.max(p.length, o.length); k++) sum += ((p[k] ?? 0) - (o[k] ?? 0)) ** 2;
      return Math.sqrt(sum);
    };
    const check = (id: number) => {
      const distance = measure(id);
      if (distance > (track.scoped.has(id) ? this.leave : this.radius)) return;
      if (!visible || visible(map.get(id), id, player, distance)) found.set(id, distance);
    };
    if (origin) {
      const r = Math.ceil(this.leave / this.cell),
        cx = this.cellOf(origin[0]),
        cy = this.cellOf(origin[1]),
        deep = origin.length > 2,
        cz = deep ? this.cellOf(origin[2]) : 0;
      for (let x = cx - r; x <= cx + r; x++)
        for (let y = cy - r; y <= cy + r; y++)
          for (let z = deep ? cz - r : 0; z <= (deep ? cz + r : 0); z++) {
            const bucket = m.cells.get(hash(x, y, z));
            if (bucket) for (const id of bucket) check(id);
          }
    }
    if (always)
      for (const [id, value] of map)
        if (!found.has(id) && always(value, id, player)) found.set(id, origin ? measure(id) : 0);
    return found;
  }

  private bytes(entry: string, id: number, value: unknown, base: unknown): number {
    const schema = this.game.schema;
    return (
      varint(id) + (base === undefined ? schema.encode(entry, value) : schema.encodeDelta(entry, value, base)).length
    );
  }

  private origin(state: State, player: number, self: number): ArrayLike<number> | undefined {
    if (this.options.focus) return this.options.focus(state, player);
    for (const m of this.managed) {
      const place = m.places.get(self);
      if (place) return place;
    }
    return undefined;
  }

  /**
   * The state `player` may see, for the server's `view`. `baseline` is what the client confirmed, which the server
   * passes; a snapshot in full (no baseline) is held to the same budget.
   * @throws RangeError for a budget or priority function that returns something out of range.
   */
  readonly view = (state: State, player: number, baseline?: State): State => {
    if (state !== this.indexed) this.index(state);
    const game = this.game,
      schema = game.schema,
      options = this.options,
      budget = typeof options.budget === 'function' ? options.budget(player) : (options.budget ?? Infinity),
      self = options.self ? options.self(player) : player,
      origin = this.origin(state, player, self),
      seen = { ...state } as Record<string, unknown>,
      shell = { ...state } as Record<string, unknown>,
      stats: InterestStats = { inScope: 0, sent: 0, deferred: 0, removed: 0, bytes: 0, over: 0 };
    if (!(budget > 0))
      throw new RangeError(`InterestManager budget of player ${player} is ${budget}; pass bytes above 0`);
    let viewer = this.viewers.get(player);
    if (!viewer) {
      const tracks = this.managed.map(() => ({ acc: new Map(), last: new Map(), scoped: new Set<number>() }));
      viewer = { round: this.round, tracks, stats };
      this.viewers.set(player, viewer);
    }
    const { tracks } = viewer;
    viewer.round = this.round;
    viewer.stats = stats;
    let spent = SNAPSHOT_HEADER_BYTES;
    const repeats: Item[] = [],
      gone: Item[] = [],
      waiting: Item[] = [],
      outs: Map<number, unknown>[] = [];
    this.managed.forEach((m, c) => {
      const map = (state as Record<string, unknown>)[m.field] as Map<number, unknown>,
        base = (baseline as Record<string, unknown> | undefined)?.[m.field] as Map<number, unknown> | undefined,
        track = tracks[c],
        scope = this.scope(m, map, track, origin, player),
        out = new Map<number, unknown>(),
        priority = m.rules.priority,
        own = map.get(self);
      outs.push(out);
      shell[m.field] = base ?? new Map();
      seen[m.field] = out;
      spent += m.reserve;
      stats.inScope += scope.size;
      if (own !== undefined) {
        scope.delete(self);
        track.acc.delete(self);
        out.set(self, own);
        const held = base?.get(self);
        if (held === undefined || !schema.equals(m.entry, held, own)) spent += this.bytes(m.entry, self, own, held);
        stats.sent++;
      }
      for (const [id, distance] of scope) {
        const now = map.get(id),
          held = base?.get(id),
          last = track.last.get(id);
        if (held !== undefined && schema.equals(m.entry, held, now)) {
          out.set(id, held);
          track.acc.delete(id);
          continue;
        }
        const gain = priority
          ? priority(now, id, player, distance)
          : this.radius / Math.max(distance, this.radius / 16);
        if (!(gain >= 0) || !Number.isFinite(gain))
          throw new RangeError(`InterestManager priority of ${m.field}(${id}) is ${gain}; return 0 or more`);
        const acc = (track.acc.get(id) ?? 0) + gain;
        track.acc.set(id, acc);
        const item = { track, out, entry: m.entry, id, value: now, held, base: held, cost: 0, acc };
        if (last !== undefined && (held === undefined || !schema.equals(m.entry, last, held))) {
          item.held = last;
          item.cost = this.bytes(m.entry, id, last, held);
          repeats.push(item);
        } else {
          item.cost = this.bytes(m.entry, id, now, held);
          waiting.push(item);
        }
      }
      for (const [id, held] of base ?? [])
        if (id !== self && !scope.has(id))
          gone.push({ track, out, entry: m.entry, id, value: undefined, held, base: held, cost: varint(id), acc: 0 });
      for (const id of track.acc.keys()) if (!scope.has(id)) track.acc.delete(id);
      track.scoped = new Set(scope.keys());
      if (own !== undefined) track.scoped.add(self);
    });
    spent +=
      baseline === undefined
        ? schema.encode(game.stateType, shell).length
        : schema.encodeDelta(game.stateType, shell, baseline).length;

    // First what is already in flight, or the client would see it go back to the older value it confirmed.
    for (const item of repeats) {
      if (spent + item.cost <= budget) {
        spent += item.cost;
        item.out.set(item.id, item.held);
      } else {
        item.cost = 0;
        if (item.base !== undefined) item.out.set(item.id, item.base);
      }
    }
    for (const item of gone) {
      if (spent + item.cost <= budget) {
        spent += item.cost;
        stats.removed++;
      } else item.out.set(item.id, item.held);
    }
    const order = (a: Item, b: Item) => b.acc - a.acc || a.id - b.id;
    for (const item of waiting.sort(order)) {
      if (spent + item.cost <= budget) {
        spent += item.cost;
        item.out.set(item.id, item.value);
        item.track.acc.delete(item.id);
        stats.sent++;
      } else {
        // It does not fit; a smaller one further down still may.
        stats.deferred++;
        if (item.base !== undefined) item.out.set(item.id, item.base);
      }
    }
    // With nothing left waiting, bytes left over bring repeats up to date. Never while something waits: a repeat kept
    // current never settles, because the client cannot confirm a value that changes every snapshot, and it would hold
    // its bytes for good and starve what is behind it.
    const spare = stats.deferred === 0;
    for (const item of repeats.sort(order)) {
      const cost = spare ? this.bytes(item.entry, item.id, item.value, item.base) : Infinity;
      if (spent - item.cost + cost <= budget) {
        spent += cost - item.cost;
        item.out.set(item.id, item.value);
        item.track.acc.delete(item.id);
        stats.sent++;
      } else stats.deferred++;
    }
    tracks.forEach((track, c) => (track.last = outs[c]));
    stats.bytes = spent;
    stats.over = Math.max(0, spent - budget);
    return seen as State;
  };

  /** Forgets every player and the index. */
  clear(): void {
    this.viewers.clear();
    this.indexed = undefined;
  }
}
