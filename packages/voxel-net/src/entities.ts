// @margoengine/voxel-net/entities: server-run entities (mobs, dropped items, anything that is not a player) with interest
// management. The server steps every entity each tick (its brain, then a VoxelCharacter body in the server's world)
// and sends each player only the entities near it: an entity enters a player's set within `radius` and leaves past
// `leaveRadius`, so one on the edge does not flicker (the circle of Boulanger, Kienzle and Verbrugge, NetGames 2006,
// with a hashed grid only as the index). States go as EntityCodec deltas against what the player last got.
// The client side, VoxelEntityView, decodes them and interpolates each entity as the client does other players.
import type { MutableVec3, Vec3 } from '@margoengine/math';
import { createSnapshot, type Snapshot, SnapshotBuffer } from '@margoengine/net';
import type { VoxelWorld } from '@margoengine/voxel';
import { EntityCodec, type EntityState, type PreparedEntity } from '@margoengine/voxel/codec';
import { VoxelCharacter, type VoxelCharacterOptions, type VoxelMoveIntent } from '@margoengine/voxel/query';

/** What an entity sends: feet position, rotation (yaw), and two numbers of yours: its kind and a state byte. */
export const ENTITY_SCHEMA = { position: 'position', rotation: 'rotation', kind: 'u16', state: 'u8' } as const;
/** One entity as {@link VoxelEntityView} decodes it with {@link ENTITY_SCHEMA}. */
export type EntityWireState = EntityState<typeof ENTITY_SCHEMA>;

/** What a brain gets each tick and may return: the move to make (a {@link VoxelMoveIntent}), or nothing to stand. */
export type EntityBrain = (entity: VoxelEntity, dt: number) => VoxelMoveIntent | undefined | void;

/** Options of {@link VoxelEntities.spawn}. */
export interface EntitySpawn {
  /** Your type id, 0 to 65,535 (a pig, an arrow, a dropped stone): clients pick the model by it. */
  kind: number;
  /** Feet position, blocks. */
  position: Vec3;
  /** Heading in radians, 0 looks along -z (as the client's yaw). Default 0. */
  yaw?: number;
  /** A byte of yours, 0 to 255, sent with every change (an animation, a health step). Default 0. */
  state?: number;
  /**
   * A body that falls and collides with blocks: true, or the {@link VoxelCharacterOptions} of its box and speeds
   * (default true). false for an entity you move yourself by writing `position`.
   */
  body?: boolean | VoxelCharacterOptions;
  /** Runs each tick before the body moves; see {@link wander}. Default none: the body only falls. */
  brain?: EntityBrain;
}

/** A server entity. Write `position`, `yaw` and `state` freely; the next tick sends what changed. */
export interface VoxelEntity {
  /** Its id, as clients see it: 1 and up, never reused while the server runs. */
  readonly id: number;
  /** Your type id. */
  readonly kind: number;
  /** Feet position: the body's position when it has a body. */
  position: MutableVec3;
  /** Heading in radians. */
  yaw: number;
  /** A byte of yours. */
  state: number;
  /** Its body, when it has one. */
  readonly body: VoxelCharacter | undefined;
  /** Its brain. */
  brain: EntityBrain | undefined;
}

/** A player as {@link VoxelEntities} needs it: `server.players` entries are these. */
export interface EntityViewer {
  readonly id: number;
  readonly spawned: boolean;
  readonly connected: boolean;
  readonly character: { readonly position: ArrayLike<number> };
}

/** What {@link VoxelEntities} needs of a server: a `VoxelServer` is one. */
export interface EntityHost {
  readonly world: VoxelWorld;
  readonly players: readonly EntityViewer[];
  readonly tick: number;
  onTick(listener: (tick: number, dt: number) => void): () => void;
  sendEntities(player: EntityViewer, tick: number, full: boolean, data: Uint8Array): boolean;
}

/** Options of {@link VoxelEntities}. */
export interface VoxelEntitiesOptions {
  /** A player gets the entities within this many blocks of its feet. Default 64. */
  radius?: number;
  /** An entity a player has stays until it is this far. Default radius x 1.1. */
  leaveRadius?: number;
  /** Most entities in the world. Default 4,096. */
  maxEntities?: number;
  /** Most entities one player gets, the nearest first. Default 256. */
  maxPerPlayer?: number;
}

const finite = (v: unknown, what: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v))
    throw new RangeError(`${what} ${v} is not a finite number; pass one`);
  return v;
};
const count = (v: unknown, what: string, min: number, max: number): number => {
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max)
    throw new RangeError(`${what} ${v} is not an integer from ${min} to ${max}; pass one`);
  return v as number;
};
const rotation = (yaw: number): [number, number, number, number] => [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];

/**
 * The server's entities. Each tick of `server` it runs every entity's brain and body, then sends each joined player the
 * entities near it as deltas. Entities in chunks the server has not loaded (no player near) wait where they are.
 * `dispose()` (or `using`) stops it; clients then drop the entities at their next message.
 * @throws TypeError for a server without `onTick` and `sendEntities`; RangeError for bad options.
 */
export class VoxelEntities {
  readonly radius: number;
  readonly leaveRadius: number;
  readonly #host: EntityHost;
  readonly #max: number;
  readonly #perPlayer: number;
  readonly #codec = new EntityCodec(ENTITY_SCHEMA);
  readonly #entities = new Map<number, VoxelEntity>();
  // Per player id: the entities it holds, as last sent.
  readonly #sent = new Map<number, Map<number, PreparedEntity>>();
  #next = 1;
  #stop: (() => void) | undefined;

  constructor(server: EntityHost, options: VoxelEntitiesOptions = {}) {
    if (!server || typeof server.onTick !== 'function' || typeof server.sendEntities !== 'function')
      throw new TypeError('VoxelEntities needs a VoxelServer; pass the server');
    if (!options || typeof options !== 'object') throw new TypeError('VoxelEntities options must be an object');
    this.#host = server;
    this.radius = finite(options.radius ?? 64, 'VoxelEntities radius');
    if (this.radius <= 0) throw new RangeError('VoxelEntities radius must be above 0; pass blocks');
    this.leaveRadius = finite(options.leaveRadius ?? this.radius * 1.1, 'VoxelEntities leaveRadius');
    if (this.leaveRadius < this.radius)
      throw new RangeError('VoxelEntities leaveRadius is below radius; pass radius or more');
    this.#max = count(options.maxEntities ?? 4096, 'VoxelEntities maxEntities', 1, 1 << 20);
    this.#perPlayer = count(options.maxPerPlayer ?? 256, 'VoxelEntities maxPerPlayer', 1, 65535);
    this.#stop = server.onTick((tick, dt) => this.#tick(tick, dt));
  }

  /** How many entities there are. */
  get size(): number {
    return this.#entities.size;
  }
  /** The entity of `id`, or undefined. */
  get(id: number): VoxelEntity | undefined {
    return this.#entities.get(id);
  }
  /** Every entity. */
  [Symbol.iterator](): IterableIterator<VoxelEntity> {
    return this.#entities.values();
  }

  /**
   * Adds an entity; players near it get it at the next tick.
   * @throws RangeError past `maxEntities`, for a kind, state or position out of range, or after dispose.
   */
  spawn(options: EntitySpawn): VoxelEntity {
    if (!this.#stop) throw new RangeError('VoxelEntities is disposed; make a new one');
    if (!options || typeof options !== 'object') throw new TypeError('VoxelEntities.spawn needs {kind, position}');
    if (this.#entities.size >= this.#max)
      throw new RangeError(`VoxelEntities holds maxEntities (${this.#max}); remove some or raise maxEntities`);
    const kind = count(options.kind, 'VoxelEntities.spawn kind', 0, 65535),
      state = count(options.state ?? 0, 'VoxelEntities.spawn state', 0, 255),
      yaw = finite(options.yaw ?? 0, 'VoxelEntities.spawn yaw'),
      p = options.position;
    if (!p || p.length !== 3) throw new TypeError('VoxelEntities.spawn position must be [x, y, z]');
    const position: MutableVec3 = [
      finite(p[0], 'VoxelEntities.spawn x'),
      finite(p[1], 'VoxelEntities.spawn y'),
      finite(p[2], 'VoxelEntities.spawn z'),
    ];
    if (options.brain !== undefined && typeof options.brain !== 'function')
      throw new TypeError('VoxelEntities.spawn brain must be a function (entity, dt) => intent');
    const shape = options.body ?? true;
    let body: VoxelCharacter | undefined;
    if (shape !== false) {
      body = new VoxelCharacter(this.#host.world, shape === true ? {} : shape);
      body.position = position;
    }
    const entity: VoxelEntity = { id: this.#next++, kind, position, yaw, state, body, brain: options.brain };
    if (body)
      Object.defineProperty(entity, 'position', {
        enumerable: true,
        get: () => body.position,
        set: (v: MutableVec3) => {
          body.position = v;
        },
      });
    this.#entities.set(entity.id, entity);
    return entity;
  }

  /** Removes an entity (or the entity of an id); players drop it at the next tick. Returns whether it was here. */
  remove(entity: VoxelEntity | number): boolean {
    return this.#entities.delete(typeof entity === 'number' ? entity : entity?.id);
  }

  /** The entities within `radius` blocks of `position`, nearest first. */
  near(position: ArrayLike<number>, radius: number): VoxelEntity[] {
    const r2 = finite(radius, 'VoxelEntities.near radius') ** 2,
      out: [number, VoxelEntity][] = [];
    for (const e of this.#entities.values()) {
      const d = dist2(e.position, position);
      if (d <= r2) out.push([d, e]);
    }
    return out.sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  }

  /** Stops stepping and sending, and tells every player to drop its entities; the entities stay readable here. */
  dispose(): void {
    if (!this.#stop) return;
    this.#stop();
    this.#stop = undefined;
    const empty = this.#codec.encode(new Map());
    for (const player of this.#host.players)
      if (this.#sent.has(player.id)) this.#host.sendEntities(player, this.#host.tick, true, empty);
    this.#sent.clear();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }

  #tick(tick: number, dt: number): void {
    const world = this.#host.world;
    for (const e of this.#entities.values()) {
      const p = e.position;
      // Only where the server holds the chunk: a body over an unloaded chunk would fall through it.
      if (!world.getChunk(Math.floor(p[0]) >> 5, Math.floor(p[1]) >> 5, Math.floor(p[2]) >> 5)) continue;
      const intent = e.brain?.(e, dt) ?? undefined;
      e.body?.update(dt, intent ?? {});
    }
    // One quantized state per entity per tick, shared by every player; a grid of radius-wide columns finds them.
    const cell = this.leaveRadius,
      grid = new Map<string, VoxelEntity[]>(),
      prepared = new Map<number, PreparedEntity>();
    for (const e of this.#entities.values()) {
      const p = e.position,
        key = `${Math.floor(p[0] / cell)},${Math.floor(p[2] / cell)}`;
      prepared.set(
        e.id,
        this.#codec.prepare(
          { position: [p[0], p[1], p[2]], rotation: rotation(e.yaw), kind: e.kind, state: e.state },
          e.id,
        ),
      );
      const list = grid.get(key);
      if (list) list.push(e);
      else grid.set(key, [e]);
    }
    const enter2 = this.radius ** 2,
      leave2 = this.leaveRadius ** 2,
      seen = new Set<number>();
    for (const player of this.#host.players) {
      seen.add(player.id);
      // A player away (parked) gets everything again, in full, when it is back.
      if (!player.spawned || !player.connected) {
        this.#sent.delete(player.id);
        continue;
      }
      const q = player.character.position,
        cx = Math.floor(q[0] / cell),
        cz = Math.floor(q[2] / cell),
        held = this.#sent.get(player.id),
        found: [number, number][] = [];
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++)
          for (const e of grid.get(`${cx + dx},${cz + dz}`) ?? []) {
            const d = dist2(e.position, q);
            if (d <= enter2 || (d <= leave2 && held?.has(e.id))) found.push([d, e.id]);
          }
      if (found.length > this.#perPlayer) found.sort((a, b) => a[0] - b[0]).length = this.#perPlayer;
      const now = new Map<number, PreparedEntity>();
      for (const [, id] of found) now.set(id, prepared.get(id) as PreparedEntity);
      const data = this.#codec.encode(now, held);
      // An empty delta (one byte) is not sent; a player's first message is, in full, so it starts from nothing.
      if (held && data.length <= 1) this.#sent.set(player.id, now);
      else if (this.#host.sendEntities(player, tick, !held, data)) this.#sent.set(player.id, now);
    }
    for (const id of this.#sent.keys()) if (!seen.has(id)) this.#sent.delete(id);
  }
}

function dist2(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

/** Options of {@link wander}. */
export interface WanderOptions {
  /** Seed of its choices, so a run repeats. Default the entity id. */
  seed?: number;
  /** Mean seconds between choices. Default 3. */
  every?: number;
  /** Share of choices that stand still, 0 to 1. Default 0.4. */
  rest?: number;
}

/**
 * A brain that walks about: every few seconds it picks a heading or a rest, and jumps when a wall stops it. Give each
 * mob its own (`brain: wander()`); a seed makes the walk repeat.
 */
export function wander(options: WanderOptions = {}): EntityBrain {
  const every = finite(options.every ?? 3, 'wander every'),
    rest = finite(options.rest ?? 0.4, 'wander rest');
  if (every <= 0) throw new RangeError('wander every must be above 0; pass seconds');
  if (rest < 0 || rest > 1) throw new RangeError('wander rest must be 0 to 1; pass a share');
  let seed = options.seed === undefined ? -1 : count(options.seed, 'wander seed', 0, 0xffffffff),
    left = 0,
    walking = false,
    last: [number, number] | undefined;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  return (entity, dt) => {
    if (seed < 0) seed = entity.id >>> 0;
    left -= dt;
    if (left <= 0) {
      left = every * (0.5 + random());
      walking = random() >= rest;
      if (walking) entity.yaw = random() * Math.PI * 2;
    }
    if (!walking) return undefined;
    const p = entity.position,
      stuck = last !== undefined && Math.abs(p[0] - last[0]) + Math.abs(p[2] - last[1]) < 0.25 * 4.317 * dt;
    last = [p[0], p[2]];
    return {
      direction: [-Math.sin(entity.yaw), 0, -Math.cos(entity.yaw)],
      jump: stuck && entity.body?.onGround === true,
    };
  };
}

/** An entity as a client sees it. */
export interface RemoteEntity {
  readonly id: number;
  /** Its kind, from the server. */
  kind: number;
  /** Its state byte, newest. */
  state: number;
  /** Its snapshots, by server time in seconds. */
  readonly buffer: SnapshotBuffer;
  /** Where to draw it, filled by {@link VoxelEntityView.sample}. */
  readonly snapshot: Snapshot;
  /** Last state pushed, for velocity. */
  last?: { time: number; position: MutableVec3 };
}

/** What {@link VoxelEntityView} needs of a client: a `VoxelNetClient` is one. */
export interface EntityClient {
  onEntities: (tick: number, full: boolean, data: Uint8Array) => void;
  readonly welcome?: { readonly tickRate: number } | undefined;
}

/**
 * The client's view of the server's entities: attach it to a `VoxelNetClient` (it takes `client.onEntities`), then call
 * `sample()` each frame and draw `entities`. Entities come and go as the server's interest management says.
 */
export class VoxelEntityView {
  /** The entities the server sent, by id. */
  readonly entities = new Map<number, RemoteEntity>();
  /** Called when an entity arrives, before it is first sampled. */
  onEnter: (entity: RemoteEntity) => void = () => {};
  /** Called when the server drops an entity (it went out of range or was removed). */
  onLeave: (entity: RemoteEntity) => void = () => {};
  readonly #client: EntityClient;
  readonly #codec = new EntityCodec(ENTITY_SCHEMA);
  readonly #delay: number;
  #states = new Map<number, EntityWireState>();
  #offset = Number.POSITIVE_INFINITY;

  /** @param options.delay seconds drawn behind the newest state (default 0.1, as other players). */
  constructor(client: EntityClient, options: { delay?: number } = {}) {
    if (!client || !('onEntities' in client))
      throw new TypeError('VoxelEntityView needs a VoxelNetClient; pass the client');
    this.#delay = finite(options?.delay ?? 0.1, 'VoxelEntityView delay');
    this.#client = client;
    client.onEntities = (tick, full, data) => this.#receive(tick, full, data);
  }

  /** Interpolates every entity to `now` (seconds, default performance.now) less the delay. Returns `entities`. */
  sample(now: number = performance.now() / 1000): ReadonlyMap<number, RemoteEntity> {
    const time = now - this.#offset - this.#delay;
    if (Number.isFinite(time)) for (const e of this.entities.values()) e.buffer.sample(time, e.snapshot);
    return this.entities;
  }

  /** Detaches from the client. */
  dispose(): void {
    this.#client.onEntities = () => {};
  }
  [Symbol.dispose](): void {
    this.dispose();
  }

  #receive(tick: number, full: boolean, data: Uint8Array): void {
    const time = tick / (this.#client.welcome?.tickRate || 20),
      decoded = this.#codec.decode(data, full ? undefined : this.#states);
    this.#offset = Math.min(performance.now() / 1000 - time, this.#offset + 0.0005);
    this.#states = decoded;
    for (const [id, state] of decoded) {
      let e = this.entities.get(id);
      const fresh = !e;
      if (!e) {
        e = {
          id,
          kind: state.kind,
          state: state.state,
          buffer: new SnapshotBuffer(32, 0.25),
          snapshot: createSnapshot(),
        };
        this.entities.set(id, e);
      }
      e.kind = state.kind;
      e.state = state.state;
      // Velocity from the last state pushed, so the buffer extrapolates a moving entity onwards and holds a still one.
      const p = state.position,
        last = e.last,
        span = last ? time - last.time : 0,
        velocity = last && span > 0 ? p.map((v, i) => (v - last.position[i]) / span) : [0, 0, 0];
      if (e.buffer.push(time, p, state.rotation, velocity)) e.last = { time, position: [p[0], p[1], p[2]] };
      if (fresh) this.onEnter(e);
    }
    for (const [id, e] of this.entities)
      if (!decoded.has(id)) {
        this.entities.delete(id);
        this.onLeave(e);
      }
  }
}
