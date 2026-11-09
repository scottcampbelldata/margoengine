// Lag compensation (design: packages/voxel-net/DESIGN.md, "Lag compensation"). A client draws other players about
// `interpolationDelay` behind the newest snapshot, so it aims at where they were, not where they are. The server keeps
// every player's body box at each recent tick (netcode HitboxRewind) and checks a shot against the boxes at the tick
// the shooter saw, clamped to `maxRewind`. The shot leaves the shooter's eye where the server has it: shots arrive in
// order with the shooter's inputs, so that is where the client was when it fired. Blocks are not rewound: a shot stops
// at the first solid block of the world as it is now.
import type { Vec3 } from '@margoengine/math';
import { HitboxRewind, type RewindShape } from '@margoengine/netcode/hitboxes';
import type { BlockType } from '@margoengine/voxel';
import { raycastVoxels, type VoxelHit } from '@margoengine/voxel/query';
import { ByteReader, ByteWriter } from '../../shared/bytes.js';
import type { VoxelNetClient } from './client.js';
import type { VoxelServer, VoxelServerPlayer } from './server.js';

// Only solid blocks stop a shot: not plants, water or other blocks a body walks through.
const solid = (_state: number, type: BlockType): boolean => type.solid;

/** First bytes of every shot app message: `MRW` and format 1. */
export const SHOT_PREFIX: Uint8Array = Uint8Array.of(0x4d, 0x52, 0x57, 1);

/** A shot as the shooter saw it. */
export interface VoxelShot {
  /** The fractional server tick the shooter saw other players at: {@link VoxelNetClient.viewTick}. */
  readonly viewTick: number;
  /** Where it aimed, from its eye (any non-zero length). */
  readonly direction: Vec3;
}

/** What a shot hit. */
export interface VoxelShotHit {
  /** The player hit, or undefined for a miss or a shot stopped by a block. */
  readonly player: VoxelServerPlayer | undefined;
  /** The block that stopped the shot before any player, or undefined. */
  readonly block: VoxelHit | undefined;
  /** Blocks from the eye to what it hit; Infinity for a miss. */
  readonly distance: number;
  /** The point hit, or undefined for a miss. */
  readonly point: number[] | undefined;
  /** The tick the players were rewound to: `viewTick` clamped to `maxRewind` and to now. */
  readonly tick: number;
  /** Where the shot left from: the shooter's eye on the server. */
  readonly origin: [number, number, number];
}

/** Options of {@link VoxelRewind}. */
export interface VoxelRewindOptions {
  /** Most seconds a shot may be rewound. A shot that saw further back is checked this far back. Default 0.5. */
  maxRewind?: number;
  /** Eye height above the feet, in blocks. Default 1.62. */
  eyeHeight?: number;
  /** Longest shot, in blocks. Default 64. */
  maxDistance?: number;
  /** A player's hit shape at its feet `position`. Default its body box (`character.size`). */
  hitbox?: (player: VoxelServerPlayer, position: readonly number[]) => RewindShape;
}

const encode = (shot: VoxelShot): Uint8Array => {
  if (!shot || typeof shot !== 'object') throw new TypeError('A shot must be { viewTick, direction }');
  const { viewTick, direction } = shot;
  if (!Number.isFinite(viewTick) || viewTick < 0)
    throw new RangeError(`Shot viewTick is ${viewTick}; pass client.viewTick(), a finite tick of 0 or more`);
  if (!Array.isArray(direction) || direction.length !== 3 || !direction.every(Number.isFinite))
    throw new TypeError('Shot direction must be [x, y, z] of finite numbers');
  if (!(Math.hypot(direction[0], direction[1], direction[2]) > 0))
    throw new RangeError('Shot direction is [0, 0, 0]; pass where the player aims');
  const w = new ByteWriter(48);
  w.raw(SHOT_PREFIX);
  w.room(32);
  for (const v of [viewTick, direction[0], direction[1], direction[2]]) {
    w.view.setFloat64(w.at, v, true);
    w.at += 8;
  }
  return w.done();
};
/**
 * The app message bytes of `shot`, for `VoxelNetClient.sendApp`.
 * @throws TypeError for a direction that is not 3 finite numbers; RangeError for a zero direction or a viewTick that
 * is not a finite 0 or more.
 */
export const encodeShot: (shot: VoxelShot) => Uint8Array = encode;

/**
 * The {@link VoxelShot} in app message `data`, or undefined when it does not start with {@link SHOT_PREFIX}.
 * @throws RangeError for a shot of the wrong length, a non-finite number, a negative viewTick or a zero direction.
 */
export function decodeShot(data: Uint8Array): VoxelShot | undefined {
  if (!(data instanceof Uint8Array) || data.length < SHOT_PREFIX.length) return undefined;
  for (let i = 0; i < SHOT_PREFIX.length; i++) if (data[i] !== SHOT_PREFIX[i]) return undefined;
  const r = new ByteReader(data, 'shot message', 'send what encodeShot returned', SHOT_PREFIX.length),
    f = () => {
      r.need(8);
      const v = r.view.getFloat64(r.at, true);
      r.at += 8;
      if (!Number.isFinite(v)) throw r.fail('holds a non-finite number');
      return v;
    },
    viewTick = f(),
    direction: [number, number, number] = [f(), f(), f()];
  r.end();
  if (viewTick < 0) throw r.fail(`has viewTick ${viewTick}, below 0`);
  if (!(Math.hypot(...direction) > 0)) throw r.fail('has a zero direction');
  return { viewTick, direction };
}

/**
 * Sends a shot along `direction` from `client`'s player, with the tick it sees other players at (time `now`, seconds,
 * `performance.now() / 1000` by default, as for `samplePlayers`). Returns false when nothing was sent: before the first
 * players message, or a client that cannot send (see `VoxelNetClient.sendApp`).
 */
export function sendShot(client: VoxelNetClient, direction: Vec3, now?: number): boolean {
  const viewTick = client.viewTick(now);
  return viewTick !== undefined && client.sendApp(encode({ viewTick, direction }));
}

/**
 * Server lag compensation: it records every spawned player's hit shape each tick and checks shots against the shapes
 * as the shooter saw them. Shots come from clients through {@link sendShot} (to {@link VoxelRewind.onShot}) or from
 * your own code through {@link VoxelRewind.shoot}. Dispose to stop.
 */
export class VoxelRewind implements Disposable {
  /** Most ticks a shot may be rewound. */
  readonly maxRewindTicks: number;
  /** Called with each shot a client sent, after it was checked. Default does nothing. */
  onShot: (shooter: VoxelServerPlayer, hit: VoxelShotHit, shot: VoxelShot) => void = () => {};
  readonly #server: VoxelServer;
  readonly #rewind: HitboxRewind;
  readonly #eye: number;
  readonly #maxDistance: number;
  readonly #hitbox: (player: VoxelServerPlayer, position: readonly number[]) => RewindShape;
  readonly #stops: (() => void)[];
  constructor(server: VoxelServer, options: VoxelRewindOptions = {}) {
    if (!server || typeof server.onApp !== 'function')
      throw new TypeError('VoxelRewind needs a VoxelServer; pass new VoxelServer({...})');
    const positive = (what: string, v: number): number => {
      if (!(v > 0 && Number.isFinite(v)))
        throw new RangeError(`VoxelRewind ${what} is ${v}; pass a finite number above 0`);
      return v;
    };
    const maxRewind = positive('maxRewind', options.maxRewind ?? 0.5),
      rate = server.tickRate;
    this.maxRewindTicks = maxRewind * rate;
    if (this.maxRewindTicks > 4000)
      throw new RangeError(`VoxelRewind maxRewind ${maxRewind} s is over 4,000 ticks; pass a shorter one`);
    this.#eye = options.eyeHeight ?? 1.62;
    if (!Number.isFinite(this.#eye))
      throw new RangeError(`VoxelRewind eyeHeight is ${this.#eye}; pass a finite height`);
    this.#maxDistance = positive('maxDistance', options.maxDistance ?? 64);
    if (options.hitbox !== undefined && typeof options.hitbox !== 'function')
      throw new TypeError('VoxelRewind hitbox must be a function (player, position) => shape');
    this.#hitbox =
      options.hitbox ??
      ((player, [x, y, z]) => {
        const [w, h, d] = player.character.size;
        return { position: [x, y + h / 2, z], halfExtents: [w / 2, h / 2, d / 2] };
      });
    this.#server = server;
    this.#rewind = new HitboxRewind({ history: Math.ceil(this.maxRewindTicks) + 2 });
    this.#stops = [
      server.onTick((tick) => this.#record(tick)),
      server.onApp((player, data) => {
        let shot: VoxelShot | undefined;
        try {
          shot = decodeShot(data);
        } catch {
          server.disconnect(player, 4003, 'unreadable-shot');
          return;
        }
        if (shot) this.onShot(player, this.shoot(player, shot), shot);
      }),
    ];
  }
  #record(tick: number): void {
    const shapes: [number, RewindShape][] = [];
    for (const player of this.#server.players) {
      if (!player.spawned) continue;
      shapes.push([player.id, this.#hitbox(player, player.character.position)]);
    }
    this.#rewind.record(tick, shapes);
  }
  /** The hit shapes by player id at fractional tick `tick`, as a shot rewound there sees them. */
  at(tick: number): Map<number, RewindShape> {
    return this.#rewind.at(tick);
  }
  /**
   * Checks a shot by `shooter` along `shot.direction` from its eye against the players as they were at
   * `shot.viewTick` (clamped to `maxRewind` behind the newest recorded tick, and to it), stopped by the first block of
   * the world in the way, within `maxDistance` (default the option's).
   * @throws TypeError or RangeError for a shot that does not encode (see {@link encodeShot}).
   */
  shoot(shooter: VoxelServerPlayer, shot: VoxelShot, maxDistance = this.#maxDistance): VoxelShotHit {
    encode(shot);
    const p = shooter.character.position,
      origin: [number, number, number] = [p[0], p[1] + this.#eye, p[2]],
      d = shot.direction,
      length = Math.hypot(d[0], d[1], d[2]),
      direction: [number, number, number] = [d[0] / length, d[1] / length, d[2] / length],
      newest = this.#rewind.range?.[1] ?? this.#server.tick,
      tick = Math.min(newest, Math.max(newest - this.maxRewindTicks, shot.viewTick));
    // Players who have left since that tick are not hit: they are not in the way either.
    const here = new Map<number, VoxelServerPlayer>(),
      ignore = new Set<number>([shooter.id]);
    for (const player of this.#server.players) if (player.spawned) here.set(player.id, player);
    for (const id of this.#rewind.at(tick).keys()) if (!here.has(id)) ignore.add(id);
    const block = raycastVoxels(this.#server.world, origin, direction, maxDistance, solid) ?? undefined,
      found = this.#rewind.raycast(tick, origin, direction, {
        maxDistance: block ? block.distance : maxDistance,
        ignore,
      }),
      player = found && here.get(found.id);
    if (found && player)
      return { player, block: undefined, distance: found.distance, point: found.point, tick, origin };
    if (block) return { player: undefined, block, distance: block.distance, point: [...block.point], tick, origin };
    return { player: undefined, block: undefined, distance: Number.POSITIVE_INFINITY, point: undefined, tick, origin };
  }
  /** Stops recording and listening. */
  [Symbol.dispose](): void {
    for (const stop of this.#stops) stop();
    this.#rewind.clear();
  }
}
