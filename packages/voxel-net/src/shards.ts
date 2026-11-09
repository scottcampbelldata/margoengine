// @margoengine/voxel-net/shards: one world split across several VoxelServers (processes or machines) by region. A
// ShardMap cuts the x-z plane into square regions and gives each region to one shard. Each shard owns the edits of its
// regions (allowEdit refuses the rest) and spawns its players inside them. When a player walks past its shard's
// region by `margin` blocks, the shard sends it a handoff (an app message with the next shard's address and a signed
// ticket) and the client moves itself: it closes the old connection and connects to the next shard, which checks the
// ticket and spawns the player where it left. Tickets are HMAC-SHA-256 (RFC 2104, FIPS 198-1) over the player's name,
// identity, position and an expiry, with a one-time nonce, through Web Crypto, so this entry runs in browsers and Node.
import { MargoError } from '@margoengine/math/errors';
import type { VoxelWorld } from '@margoengine/voxel';
import { connectVoxelNet, type VoxelNetClient, type VoxelNetClientOptions, type VoxelNetClose } from './client.js';
import type { VoxelAuthenticate, VoxelServer, VoxelServerOptions, VoxelServerPlayer } from './server.js';

/** The app-message prefix of a handoff: bytes 'M', 'S', 'H', 1. Your own app messages must not start with it. */
export const SHARD_HANDOFF_PREFIX: Uint8Array = Uint8Array.of(0x4d, 0x53, 0x48, 1);

/** Options of {@link ShardMap}. */
export interface ShardMapOptions {
  /** The shards' WebSocket addresses, `ws://` or `wss://`, in shard index order. At least one. */
  shards: readonly string[];
  /** Region side in blocks along x and z, a multiple of the 32-block chunk. Default 256. */
  regionSize?: number;
  /**
   * Which shard index a region (rx, rz) goes to. Default: a hash of the region, so neighbours land on different shards
   * and every shard gets about the same share. Must give the same answer on every machine.
   */
  assign?: (rx: number, rz: number) => number;
}

/** Splits the x-z plane into square regions and names the shard of each. Every shard and client uses the same map. */
export class ShardMap {
  readonly shards: readonly string[];
  readonly regionSize: number;
  readonly #assign: (rx: number, rz: number) => number;
  constructor(options: ShardMapOptions) {
    const { shards, regionSize = 256, assign } = options ?? ({} as ShardMapOptions);
    if (!Array.isArray(shards) || shards.length === 0)
      throw new TypeError('ShardMap shards must be a non-empty array of addresses such as ["ws://10.0.0.2:8080"]');
    for (const url of shards)
      if (typeof url !== 'string' || !/^wss?:\/\//.test(url))
        throw new TypeError(`ShardMap shard address ${String(url)} must start with ws:// or wss://`);
    if (!(Number.isInteger(regionSize) && regionSize >= 32 && regionSize % 32 === 0))
      throw new RangeError(`ShardMap regionSize ${regionSize} must be a whole multiple of 32 blocks, such as 256`);
    if (assign !== undefined && typeof assign !== 'function')
      throw new TypeError('ShardMap assign must be a function (rx, rz) => shard index');
    this.shards = [...shards];
    this.regionSize = regionSize;
    this.#assign = assign ?? ((rx, rz) => hashRegion(rx, rz) % this.shards.length);
  }
  /** The region holding block column (x, z). */
  regionOf(x: number, z: number): [rx: number, rz: number] {
    return [Math.floor(x / this.regionSize), Math.floor(z / this.regionSize)];
  }
  /**
   * The shard index of block column (x, z).
   * @throws RangeError when `assign` gives something that is not a shard index.
   */
  shardAt(x: number, z: number): number {
    const [rx, rz] = this.regionOf(x, z),
      i = this.#assign(rx, rz);
    if (!(Number.isInteger(i) && i >= 0 && i < this.shards.length))
      throw new RangeError(
        `ShardMap assign(${rx}, ${rz}) gave ${i}; return a shard index 0 to ${this.shards.length - 1}`,
      );
    return i;
  }
  /**
   * Whether column (x, z) is more than `margin` blocks (along x or z) from every column of shard `index`. Exact for
   * margin up to half the region side: any region square near enough holds one of nine points `margin` apart.
   */
  outside(index: number, x: number, z: number, margin: number): boolean {
    for (const dx of [-margin, 0, margin])
      for (const dz of [-margin, 0, margin]) if (this.shardAt(x + dx, z + dz) === index) return false;
    return true;
  }
}

// A 32-bit integer hash of the region (the multiply-xorshift finalizer of MurmurHash3, Appleby), non-negative.
function hashRegion(rx: number, rz: number): number {
  let h = (Math.imul(rx | 0, 0x9e3779b1) ^ Math.imul(rz | 0, 0x85ebca77)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** What a ticket carries from one shard to the next. */
export interface ShardTicket {
  /** The player's name. */
  name: string;
  /** Its identity from your authenticate, when it had one. */
  identity?: string;
  /** Feet position where it left, blocks. */
  position: [number, number, number];
  /** The shard index it goes to. */
  to: number;
  /** Expiry, milliseconds since 1970. */
  expires: number;
  /** One-time random hex. */
  nonce: string;
}

const encoder = new TextEncoder(),
  decoder = new TextDecoder();
function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function unbase64url(s: string): Uint8Array {
  const bin = atob(s.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

/**
 * Signs a ticket: `<payload>.<mac>`, both base64url. Shards sign them for you on handoff; call it yourself to send a
 * player to a shard from a lobby.
 */
export async function signShardTicket(secret: string, ticket: ShardTicket): Promise<string> {
  const payload = encoder.encode(JSON.stringify(ticket)),
    mac = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), payload));
  return `${base64url(payload)}.${base64url(mac)}`;
}

/**
 * Checks a ticket's MAC and expiry. Returns the ticket, or undefined when it is forged, damaged or expired.
 * (Single use is the shard's job: {@link VoxelShard} remembers each nonce until it expires.)
 */
export async function verifyShardTicket(
  secret: string,
  token: string,
  now: number = Date.now(),
): Promise<ShardTicket | undefined> {
  const dot = typeof token === 'string' ? token.indexOf('.') : -1;
  if (dot <= 0) return undefined;
  let payload: Uint8Array, mac: Uint8Array;
  try {
    payload = unbase64url(token.slice(0, dot));
    mac = unbase64url(token.slice(dot + 1));
  } catch {
    return undefined; // not base64url: not a ticket
  }
  const key = await hmacKey(secret);
  if (!(await crypto.subtle.verify('HMAC', key, mac as Uint8Array<ArrayBuffer>, payload as Uint8Array<ArrayBuffer>)))
    return undefined;
  const t = JSON.parse(decoder.decode(payload)) as ShardTicket;
  return t.expires > now ? t : undefined;
}

/** Options of {@link VoxelShard}. */
export interface VoxelShardOptions {
  /** The map every shard shares. */
  map: ShardMap;
  /** This shard's index in `map.shards`. */
  index: number;
  /** The secret every shard shares, at least 16 characters; signs the tickets. Keep it off the clients. */
  secret: string;
  /** Blocks a player may stray past this shard's regions before it is handed off. Default 8. */
  margin?: number;
  /** How long a ticket is good for, ms. Default 10,000. */
  ticketLife?: number;
  /** How long a handed-off player may stay before it is closed with 4001 'shard-handoff', ms. Default 5,000. */
  grace?: number;
}

/** Counts of a {@link VoxelShard}. */
export interface VoxelShardStats {
  /** Players sent to another shard. */
  handedOff: number;
  /** Players that came in with a good ticket. */
  arrived: number;
  /** Tickets refused: forged, expired, used before, or for another shard. */
  refused: number;
}

/**
 * One shard of a world. Give its {@link VoxelShard.options} to a VoxelServer, then {@link VoxelShard.attach} it:
 *
 * ```ts
 * import { VoxelServer } from '@margoengine/voxel-net/server';
 * import { ShardMap, VoxelShard } from '@margoengine/voxel-net/shards';
 * const map = new ShardMap({ shards: ['ws://10.0.0.2:8080', 'ws://10.0.0.3:8080'] });
 * const shard = new VoxelShard({ map, index: 0, secret: process.env.SHARD_SECRET });
 * const server = new VoxelServer(shard.options({ blocks }));
 * shard.attach(server);
 * await server.listen(8080, '0.0.0.0');
 * ```
 */
export class VoxelShard implements Disposable {
  readonly map: ShardMap;
  readonly index: number;
  readonly stats: VoxelShardStats = { handedOff: 0, arrived: 0, refused: 0 };
  readonly #secret: string;
  readonly #margin: number;
  readonly #life: number;
  readonly #grace: number;
  // Nonces seen, with their expiry, so a ticket works once.
  readonly #used = new Map<string, number>();
  // identity -> where a ticketed player spawns; read once by spawn.
  readonly #arrivals = new Map<string, ShardTicket>();
  // players handed off -> when they must be gone
  readonly #leaving = new Map<VoxelServerPlayer, number>();
  #server: VoxelServer | undefined;
  #off: (() => void) | undefined;
  constructor(options: VoxelShardOptions) {
    const { map, index, secret, margin = 8, ticketLife = 10_000, grace = 5_000 } = options ?? ({} as VoxelShardOptions);
    if (!(map instanceof ShardMap)) throw new TypeError('VoxelShard map must be a ShardMap');
    if (!(Number.isInteger(index) && index >= 0 && index < map.shards.length))
      throw new RangeError(`VoxelShard index ${index} must be 0 to ${map.shards.length - 1}, a place in map.shards`);
    if (typeof secret !== 'string' || secret.length < 16)
      throw new TypeError('VoxelShard secret must be a string of at least 16 characters, the same on every shard');
    if (!(Number.isInteger(margin) && margin >= 0 && margin <= map.regionSize / 2))
      throw new RangeError(
        `VoxelShard margin ${margin} must be a whole number of blocks from 0 to half the regionSize`,
      );
    for (const [name, v] of [
      ['ticketLife', ticketLife],
      ['grace', grace],
    ] as const)
      if (!(v > 0 && v < Number.POSITIVE_INFINITY))
        throw new RangeError(`VoxelShard ${name} ${v} must be finite and > 0 ms`);
    this.map = map;
    this.index = index;
    this.#secret = secret;
    this.#margin = margin;
    this.#life = ticketLife;
    this.#grace = grace;
  }
  /**
   * `base` with this shard's rules folded in: `authenticate` takes tickets from the URL (`?shard-ticket=`) and runs
   * yours for players without one; `spawn` puts a ticketed player where it left and others at your spawn (default: the
   * middle of this shard's nearest region to the origin); `allowEdit` refuses edits outside this shard's regions,
   * then runs yours.
   */
  options(base: VoxelServerOptions): VoxelServerOptions {
    const authenticate = base.authenticate,
      allowEdit = base.allowEdit,
      spawn = base.spawn ?? this.#home(),
      server = (): VoxelServer => {
        if (!this.#server) throw new MargoError('state', 'VoxelShard is not attached; call shard.attach(server)');
        return this.#server;
      };
    const auth: VoxelAuthenticate = async (req, hello) => {
      const token = new URL(req.url ?? '/', 'http://shard').searchParams.get('shard-ticket');
      if (token === null) return authenticate ? authenticate(req, hello) : true;
      if (hello) return true; // checked on the upgrade request
      const t = await verifyShardTicket(this.#secret, token);
      this.#sweep();
      if (!t || t.to !== this.index || this.#used.has(t.nonce)) {
        this.stats.refused++;
        return false;
      }
      this.#used.set(t.nonce, t.expires);
      const identity = t.identity ?? `shard-ticket:${t.nonce}`;
      this.#arrivals.set(identity, t);
      this.stats.arrived++;
      return identity;
    };
    return {
      ...base,
      authenticate: auth,
      spawn: (id) => {
        const p = server().players.find((q) => q.id === id),
          t = p?.identity === undefined ? undefined : this.#arrivals.get(p.identity);
        if (!t) return spawn(id);
        this.#arrivals.delete(p?.identity as string);
        return [t.position[0], t.position[2]];
      },
      allowEdit: (player, x, y, z, state, previous) =>
        this.map.shardAt(x, z) === this.index && (!allowEdit || allowEdit(player, x, y, z, state, previous)),
    };
  }
  /** Starts handing players off on `server`'s ticks. Returns this. */
  attach(server: VoxelServer): this {
    if (this.#server) throw new MargoError('state', 'VoxelShard is attached already; one shard per server');
    this.#server = server;
    this.#off = server.onTick(() => this.#tick());
    return this;
  }
  /** Stops handing off. */
  [Symbol.dispose](): void {
    this.#off?.();
    this.#off = undefined;
  }
  #home(): (id: number) => readonly [number, number] {
    const s = this.map.regionSize;
    for (let r = 0; r < 64; r++)
      for (let rx = -r; rx <= r; rx++)
        for (const rz of [-r, r]) {
          const x = rx * s + s / 2,
            z = rz * s + s / 2;
          if (this.map.shardAt(x, z) === this.index) return () => [x, z];
        }
    throw new RangeError(`VoxelShard ${this.index} owns no region within 64 regions of the origin; pass a spawn`);
  }
  #sweep(): void {
    const now = Date.now();
    for (const [nonce, expires] of this.#used) if (expires <= now) this.#used.delete(nonce);
  }
  #tick(): void {
    const server = this.#server as VoxelServer,
      now = Date.now();
    for (const [p, until] of this.#leaving)
      if (!p.connected && !server.players.includes(p)) this.#leaving.delete(p);
      else if (now >= until) {
        this.#leaving.delete(p);
        server.disconnect(p, 4001, 'shard-handoff');
      }
    for (const p of server.players) {
      if (!p.spawned || !p.connected || this.#leaving.has(p)) continue;
      const [x, y, z] = p.character.position;
      if (!this.map.outside(this.index, Math.floor(x), Math.floor(z), this.#margin)) continue;
      const to = this.map.shardAt(Math.floor(x), Math.floor(z)),
        ticket: ShardTicket = {
          name: p.name,
          position: [x, y, z],
          to,
          expires: now + this.#life,
          nonce: randomHex(),
        };
      if (p.identity !== undefined) ticket.identity = p.identity;
      this.#leaving.set(p, now + this.#grace);
      this.stats.handedOff++;
      signShardTicket(this.#secret, ticket).then(
        (token) => server.send(p, encodeHandoff(this.map.shards[to] as string, token)),
        (error) => server.onError(error),
      );
    }
  }
}

function randomHex(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}
function encodeHandoff(url: string, token: string): Uint8Array {
  const body = encoder.encode(JSON.stringify({ url, token })),
    out = new Uint8Array(SHARD_HANDOFF_PREFIX.length + body.length);
  out.set(SHARD_HANDOFF_PREFIX);
  out.set(body, SHARD_HANDOFF_PREFIX.length);
  return out;
}
/** The address and ticket of a handoff app message, or undefined for any other app message. */
export function decodeShardHandoff(data: Uint8Array): { url: string; token: string } | undefined {
  if (data.length < SHARD_HANDOFF_PREFIX.length) return undefined;
  for (let i = 0; i < SHARD_HANDOFF_PREFIX.length; i++) if (data[i] !== SHARD_HANDOFF_PREFIX[i]) return undefined;
  const m = JSON.parse(decoder.decode(data.subarray(SHARD_HANDOFF_PREFIX.length))) as { url: unknown; token: unknown };
  if (typeof m.url !== 'string' || typeof m.token !== 'string')
    throw new RangeError('A shard handoff message has no url or token; it is damaged');
  return { url: m.url, token: m.token };
}

/**
 * A client that follows its player from shard to shard. `client` is the connection now; it changes on each handoff,
 * so set handlers here, not on it. Each handoff takes the old client's chunks out of the world before the next shard
 * sends its own.
 */
export class VoxelShardClient implements Disposable {
  /** The connection now. */
  client: VoxelNetClient;
  /** Your app messages (handoffs are taken out). */
  onApp: (data: Uint8Array) => void = () => {};
  /** Calls after each move to another shard, with the new shard's address. */
  onHandoff: (url: string) => void = () => {};
  /** How the last connection ended, as {@link VoxelNetClient.onClose}; not called for a handoff. */
  onClose: (event: VoxelNetClose) => void = () => {};
  /** Errors from every connection. */
  onError: (error: unknown) => void = (error) => console.error(error);
  readonly #world: VoxelWorld;
  readonly #options: VoxelNetClientOptions;
  constructor(url: string | URL, world: VoxelWorld, options: VoxelNetClientOptions = {}) {
    this.#world = world;
    this.#options = options;
    this.client = this.#open(url);
  }
  #open(url: string | URL): VoxelNetClient {
    const c = connectVoxelNet(url, this.#world, this.#options);
    c.onApp = (data) => {
      const handoff = decodeShardHandoff(data);
      if (!handoff) return this.onApp(data);
      const next = new URL(handoff.url);
      next.searchParams.set('shard-ticket', handoff.token);
      c.onClose = () => {};
      c.close();
      c.removeChunks();
      this.client = this.#open(next);
      this.onHandoff(handoff.url);
    };
    c.onClose = (event) => this.onClose(event);
    c.onError = (error) => this.onError(error);
    return c;
  }
  /** Closes the connection now. */
  close(): void {
    this.client.close();
  }
  [Symbol.dispose](): void {
    this.close();
  }
}

/**
 * Connects to the shard of the spawn point you know (`map.shards[0]` when unsure: a new player spawns at that shard's
 * spawn) and follows the player from then on.
 */
export function connectShards(
  map: ShardMap,
  world: VoxelWorld,
  options: VoxelNetClientOptions = {},
  index = 0,
): VoxelShardClient {
  if (!(map instanceof ShardMap)) throw new TypeError('connectShards map must be a ShardMap');
  const url = map.shards[index];
  if (url === undefined) throw new RangeError(`connectShards index ${index} is not in map.shards; pass 0 to ${map.shards.length - 1}`);
  return new VoxelShardClient(url, world, options);
}
