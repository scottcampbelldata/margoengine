import { MargoError } from '@margoengine/math/errors';
import type { IncomingMessage } from 'node:http';
import type { VoxelServer, VoxelServerOptions } from './server.js';
import { signShardTicket, verifyShardTicket } from './shards.js';

/** Public, copied lobby listing. Reservations count toward capacity. */
export interface VoxelRoomInfo {
  /** Unique join code. */
  code: string;
  /** Display name. */
  name: string;
  /** Joined players, including temporarily disconnected players. */
  players: number;
  /** Seats not yet joined. */
  reserved: number;
  /** Maximum players and reserved seats together. */
  capacity: number;
  /** Whether new reservations are refused. */
  locked: boolean;
  /** Public WebSocket endpoint. */
  url: string;
}

/** Options for a room's independent authoritative world. */
export interface VoxelRoomOptions {
  /** Independent world/server configuration. */
  server: VoxelServerOptions;
  /** Display name. Default 'World'. */
  name?: string;
  /** Maximum occupied and reserved seats. Default 16. */
  capacity?: number;
  /** Custom unique code, 1 to 32 ASCII letters, digits, hyphens or underscores. Default random. */
  code?: string;
  /** Hide from list; joining by code still works. Default false. */
  private?: boolean;
  /** Bind port. Default 0, a free port. */
  port?: number;
  /** Bind host. Default '127.0.0.1'. */
  host?: string;
  /** Public endpoint behind a proxy. Default the bound loopback endpoint. */
  url?: string;
  /** Cancellation of room creation. */
  signal?: AbortSignal;
}

/** A reserved, expiring single-use seat; connect to url with the normal voxel client. */
export interface VoxelRoomSeat {
  /** Room code. */
  code: string;
  /** Endpoint containing a signed shard ticket. */
  url: string;
  /** Signed shard ticket, also present in url. */
  ticket: string;
  /** Expiry in milliseconds since 1970. */
  expires: number;
}

interface Seat {
  nonce: string;
  expires: number;
  claimed: boolean;
}
interface Room {
  code: string;
  name: string;
  index: number;
  capacity: number;
  private: boolean;
  locked: boolean;
  url: string;
  server: VoxelServer;
  seats: Map<string, Seat>;
}

/** Several isolated worlds in one process, with atomic capacity reservations and shard-compatible signed tickets. */
export class VoxelLobby implements AsyncDisposable {
  readonly #secret: string;
  readonly #life: number;
  readonly #rooms = new Map<string, Room>();
  readonly #creating = new Set<string>();
  #next = 0;
  #closed = false;
  /** secret stays on the server; reservation lifetime defaults to 15,000 ms. */
  constructor(options: { secret: string; reservationLife?: number }) {
    if (typeof options?.secret !== 'string' || options.secret.length < 16)
      throw new TypeError('VoxelLobby secret needs at least 16 characters; keep it on the server');
    this.#secret = options.secret;
    this.#life = options.reservationLife ?? 15_000;
    if (!(Number.isFinite(this.#life) && this.#life > 0))
      throw new RangeError('VoxelLobby reservationLife must be positive milliseconds; use 15000');
  }
  /** Creates and starts one independent world. Failure or cancellation closes its server. */
  async create(options: VoxelRoomOptions): Promise<VoxelRoomInfo> {
    this.#live();
    options.signal?.throwIfAborted();
    const code = options.code ?? crypto.randomUUID().replaceAll('-', '').slice(0, 12);
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(code) || this.#rooms.has(code) || this.#creating.has(code))
      throw new RangeError('Room code must be unique, 1 to 32 letters, digits, hyphens or underscores; choose another');
    const capacity = options.capacity ?? 16;
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new RangeError('Room capacity must be a positive safe integer; use 16');
    if (options.url && !/^wss?:$/.test(new URL(options.url).protocol))
      throw new TypeError('Room url must use ws or wss; pass a public WebSocket endpoint');
    this.#creating.add(code);
    let server: VoxelServer | undefined;
    try {
      const { VoxelServer: Server } = await import('./server.js');
      this.#live();
      options.signal?.throwIfAborted();
      const index = this.#next++,
        seats = new Map<string, Seat>();
      const admitted = new WeakMap<IncomingMessage, Seat>();
      const authenticate = options.server.authenticate;
      const room: Room = {
        code,
        index,
        name: options.name ?? 'World',
        capacity,
        private: options.private ?? false,
        locked: false,
        url: '',
        server: undefined as unknown as VoxelServer,
        seats,
      };
      server = new Server({
        ...options.server,
        authenticate: async (request, hello) => {
          if (hello) {
            const seat = admitted.get(request);
            if (!seat || seat.expires <= Date.now()) return false;
            const result = authenticate ? await authenticate(request, hello) : true;
            return seat.expires > Date.now() && (result === true || (typeof result === 'string' && result !== ''))
              ? `room:${seat.nonce}`
              : false;
          }
          const token = new URL(request.url ?? '/', 'http://room').searchParams.get('shard-ticket');
          if (!token) return false;
          const ticket = await verifyShardTicket(this.#secret, token);
          const seat = ticket && seats.get(ticket.nonce);
          if (!ticket || ticket.to !== index || !seat || seat.claimed || seat.expires <= Date.now()) return false;
          // Claim before any caller authentication awaits. Concurrent consumption cannot take the same seat.
          seat.claimed = true;
          admitted.set(request, seat);
          const result = authenticate ? await authenticate(request, undefined) : true;
          return result === true || (typeof result === 'string' && result !== '') ? `room:${seat.nonce}` : false;
        },
      });
      room.server = server;
      const address = await server.listen(options.port ?? 0, options.host ?? '127.0.0.1');
      this.#live();
      options.signal?.throwIfAborted();
      const host = address.address.includes(':') ? `[${address.address}]` : address.address;
      room.url = options.url ?? `${options.server.tls ? 'wss' : 'ws'}://${host}:${address.port}`;
      this.#rooms.set(code, room);
      return this.#info(room);
    } catch (error) {
      if (server) await server.close();
      throw error;
    } finally {
      this.#creating.delete(code);
    }
  }
  /** Lists public rooms in creation order. Full and explicitly locked rooms remain visible. */
  list(): VoxelRoomInfo[] {
    return [...this.#rooms.values()].filter((room) => !room.private).map((room) => this.#info(room));
  }
  /** Returns a room's listing by join code, including a private room. */
  get(code: string): VoxelRoomInfo | undefined {
    const room = this.#rooms.get(code);
    return room && this.#info(room);
  }
  /** Gets the owned server for game hooks, persistence and moderation. */
  server(code: string): VoxelServer {
    return this.#room(code).server;
  }
  /** Explicit lock, independent of the automatic capacity lock. Default true. */
  lock(code: string, locked = true): void {
    this.#room(code).locked = locked;
  }
  /** Reserves one seat before signing; concurrent callers cannot exceed capacity. */
  async join(code: string, name = '', options: { signal?: AbortSignal } = {}): Promise<VoxelRoomSeat> {
    this.#live();
    options.signal?.throwIfAborted();
    const room = this.#room(code),
      info = this.#info(room);
    if (info.locked) throw new MargoError('state', 'Room is locked or full; choose another room');
    const nonce = crypto.randomUUID(),
      expires = Date.now() + this.#life;
    room.seats.set(nonce, { nonce, expires, claimed: false });
    try {
      const ticket = await signShardTicket(this.#secret, { name, position: [0, 0, 0], to: room.index, expires, nonce });
      this.#live();
      options.signal?.throwIfAborted();
      if (this.#rooms.get(code) !== room) throw new MargoError('state', 'Room was removed; join another room');
      const url = new URL(room.url);
      url.searchParams.set('shard-ticket', ticket);
      return { code, url: url.href, ticket, expires };
    } catch (error) {
      room.seats.delete(nonce);
      throw error;
    }
  }
  /** Joins the first public, unlocked room with space and the requested name, or creates one. */
  async joinOrCreate(options: VoxelRoomOptions, name = ''): Promise<VoxelRoomSeat> {
    this.#live();
    const room = this.list().find((info) => !info.locked && info.name === (options.name ?? 'World'));
    if (room) return this.join(room.code, name, options);
    const created = await this.create(options);
    return this.join(created.code, name, options);
  }
  /** Removes the listing before closing sockets, workers and saved edits. */
  async remove(code: string): Promise<void> {
    const room = this.#room(code);
    this.#rooms.delete(code);
    await room.server.close();
  }
  /** Closes every owned world. No new worlds or reservations are accepted. */
  async close(): Promise<void> {
    this.#closed = true;
    const rooms = [...this.#rooms.values()];
    this.#rooms.clear();
    const results = await Promise.allSettled(rooms.map((room) => room.server.close()));
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length)
      throw new AggregateError(
        failed.map((r) => r.reason),
        'Room shutdown failed; inspect errors',
      );
  }
  /** await using closes every world. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
  #live(): void {
    if (this.#closed) throw new MargoError('state', 'VoxelLobby is closed; create a new lobby');
  }
  #room(code: string): Room {
    const room = this.#rooms.get(code);
    if (!room) throw new MargoError('state', 'Unknown room code; choose a room from list()');
    return room;
  }
  #info(room: Room): VoxelRoomInfo {
    const players = room.server.players;
    const identities = new Set(players.map((p) => p.identity));
    for (const [nonce, seat] of room.seats)
      if (
        identities.has(`room:${nonce}`) ||
        (seat.expires <= Date.now() && (!seat.claimed || room.server.counts.pending === 0))
      )
        room.seats.delete(nonce);
    const reserved = room.seats.size;
    return {
      code: room.code,
      name: room.name,
      players: players.length,
      reserved,
      capacity: room.capacity,
      locked: room.locked || players.length + reserved >= room.capacity,
      url: room.url,
    };
  }
}
