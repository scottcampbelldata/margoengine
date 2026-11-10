import { LobbyRoom, RoomLobby, type LobbyFilter, type LobbyListing, type SeatReservation } from './lobby.js';
import type { RoomOptions, RoomServer } from './rooms.js';
import { fault } from './transport.js';

/** Atomic expiring string-store contract. Adapters must honor signal and exclude expired records from reads. */
export interface PresenceStore {
  /** Replace a record until its Unix-millisecond expiry. */
  set(key: string, value: string, expiresAt: number, signal?: AbortSignal): Promise<void>;
  /** Read a live record, or undefined. */
  get(key: string, signal?: AbortSignal): Promise<string | undefined>;
  /** Sorted live keys beginning with prefix. */
  keys(prefix: string, signal?: AbortSignal): Promise<string[]>;
  /** Atomically remove and return a live record, once across every process. */
  take(key: string, signal?: AbortSignal): Promise<string | undefined>;
  /** Remove a record; missing is a no-op. */
  delete(key: string, signal?: AbortSignal): Promise<void>;
  /** Release adapter resources. */
  [Symbol.dispose](): void;
}
/** A directory record; server-only, including private and full rooms for explicit routing. */
export interface PresenceRoom extends LobbyListing {
  /** Whether ordinary matchmaking may pick this room. */
  joinable: boolean;
  /** Hidden from public discovery. */
  privateRoom: boolean;
}
/** One leased process and its authoritative room routes. */
export interface PresenceProcess {
  /** Unique process incarnation. Never reuse an old id. */
  processId: string;
  /** Public connection URL. */
  endpoint: string;
  /** Room directory snapshot. */
  rooms: PresenceRoom[];
}
/** Join credential routed to its room's owning process. */
export interface RoutedReservation extends SeatReservation {
  /** Connect here before RoomsClient.joinById. */
  endpoint: string;
  /** Owning process incarnation. */
  processId: string;
}
/** Authoritative reservation handler. */
export type PresenceReservationHandler = (
  roomId: string,
  options: RoomOptions,
  lifetime: number,
) => SeatReservation | Promise<SeatReservation>;
/** Replaceable multi-process directory and request transport. No engine or GPU dependencies. */
export interface RoomPresence {
  /** Publish/renew one process lease. */
  publish(process: PresenceProcess, leaseMs: number, signal?: AbortSignal): Promise<void>;
  /** Withdraw one process. */
  remove(processId: string, signal?: AbortSignal): Promise<void>;
  /** Live process directory, detached from the store. */
  processes(signal?: AbortSignal): Promise<PresenceProcess[]>;
  /** Route a bounded reservation request to the owner. Never retry an uncertain request. */
  request(
    processId: string,
    roomId: string,
    options: RoomOptions,
    lifetime: number,
    signal?: AbortSignal,
  ): Promise<SeatReservation>;
  /** Serve owner requests until abort. Resolves on cancellation, rejects on adapter/handler transport failure. */
  serve(processId: string, handler: PresenceReservationHandler, signal: AbortSignal): Promise<void>;
}
const id = (): string =>
  [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
const duration = (value: number): number => {
  if (!Number.isInteger(value) || value < 1 || value > 2_147_483_647)
    throw new RangeError('Presence duration must be 1..2147483647 ms; pass an integer in range');
  return value;
};
const pause = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });

/** In-process expiring atomic store, with detached string values. */
export class MemoryPresenceStore implements PresenceStore {
  private readonly records = new Map<string, { value: string; expiresAt: number }>();
  private closed = false;
  private check(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (this.closed) throw fault('disposed', 'Presence store is closed; create a new store');
  }
  /** Replace a record. */
  async set(key: string, value: string, expiresAt: number, signal?: AbortSignal): Promise<void> {
    this.check(signal);
    for (const [key, row] of this.records) if (row.expiresAt <= Date.now()) this.records.delete(key);
    this.records.set(key, { value, expiresAt });
  }
  /** Read a live record. */
  async get(key: string, signal?: AbortSignal): Promise<string | undefined> {
    this.check(signal);
    const row = this.records.get(key);
    if (row && row.expiresAt > Date.now()) return row.value;
    this.records.delete(key);
    return undefined;
  }
  /** List live keys. */
  async keys(prefix: string, signal?: AbortSignal): Promise<string[]> {
    this.check(signal);
    return [...this.records]
      .filter(([key, row]) => key.startsWith(prefix) && row.expiresAt > Date.now())
      .map(([key]) => key)
      .sort();
  }
  /** Atomic consume before the first await. */
  async take(key: string, signal?: AbortSignal): Promise<string | undefined> {
    this.check(signal);
    const row = this.records.get(key);
    this.records.delete(key);
    return row && row.expiresAt > Date.now() ? row.value : undefined;
  }
  /** Remove a record. */
  async delete(key: string, signal?: AbortSignal): Promise<void> {
    this.check(signal);
    this.records.delete(key);
  }
  /** Clear and close. */
  [Symbol.dispose](): void {
    this.closed = true;
    this.records.clear();
  }
}

/** Shared-store presence with leased directory records, atomic IPC claims and bounded request/reply polling. */
export class StorePresence implements RoomPresence {
  private readonly prefix: string;
  private readonly timeout: number;
  private readonly poll: number;
  /** Takes ownership of store. Namespace defaults to margo-netcode, requestTimeout to 5000 ms, pollInterval to 20 ms. */
  constructor(
    private readonly store: PresenceStore,
    options: { namespace?: string; requestTimeout?: number; pollInterval?: number } = {},
  ) {
    this.prefix = `${options.namespace ?? 'margo-netcode'}/`;
    this.timeout = duration(options.requestTimeout ?? 5000);
    this.poll = duration(options.pollInterval ?? 20);
  }
  /** Publish one complete owner snapshot with a bounded lease. */
  publish(process: PresenceProcess, leaseMs: number, signal?: AbortSignal): Promise<void> {
    return this.store.set(
      `${this.prefix}process/${process.processId}`,
      JSON.stringify(process),
      Date.now() + duration(leaseMs),
      signal,
    );
  }
  /** Withdraw a process directory record. */
  remove(processId: string, signal?: AbortSignal): Promise<void> {
    return this.store.delete(`${this.prefix}process/${processId}`, signal);
  }
  /** Read detached directory records; expired processes cannot route new joins. */
  async processes(signal?: AbortSignal): Promise<PresenceProcess[]> {
    const rows: PresenceProcess[] = [];
    for (const key of await this.store.keys(`${this.prefix}process/`, signal)) {
      const value = await this.store.get(key, signal);
      if (value !== undefined) rows.push(JSON.parse(value) as PresenceProcess);
    }
    return rows;
  }
  /** Route once and await its response. @throws MargoError `failed` for a remote refusal; abort/timeout reason otherwise. */
  async request(
    processId: string,
    roomId: string,
    options: RoomOptions,
    lifetime: number,
    signal?: AbortSignal,
  ): Promise<SeatReservation> {
    signal?.throwIfAborted();
    const stop = AbortSignal.any([AbortSignal.timeout(this.timeout), ...(signal ? [signal] : [])]);
    const nonce = id(),
      key = `${this.prefix}request/${processId}/${nonce}`,
      reply = `${this.prefix}reply/${nonce}`;
    const expiresAt = Date.now() + this.timeout;
    try {
      await this.store.set(
        key,
        JSON.stringify({ roomId, options, lifetime: duration(lifetime), reply, expiresAt }),
        expiresAt,
        stop,
      );
      while (!stop.aborted) {
        const value = await this.store.take(reply, stop);
        if (value !== undefined) {
          const response = JSON.parse(value) as { result?: SeatReservation; error?: string };
          if (!response.result)
            throw fault('failed', `Remote room refused reservation: ${response.error}; choose another room`);
          return response.result;
        }
        await pause(this.poll, stop);
      }
      stop.throwIfAborted();
      throw fault('failed', 'Presence request ended without a response; choose another room');
    } finally {
      await this.store.delete(key);
      await this.store.delete(reply);
    }
  }
  /** Serve atomically claimed requests. Handler refusals are replies; store failures propagate to the owner. */
  async serve(processId: string, handler: PresenceReservationHandler, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      for (const key of await this.store.keys(`${this.prefix}request/${processId}/`, signal)) {
        if (signal.aborted) return;
        const value = await this.store.take(key, signal);
        if (value === undefined) continue;
        const request = JSON.parse(value) as {
          roomId: string;
          options: RoomOptions;
          lifetime: number;
          reply: string;
          expiresAt: number;
        };
        if (request.expiresAt <= Date.now()) continue;
        let response: { result: SeatReservation } | { error: string };
        try {
          response = { result: await handler(request.roomId, request.options, request.lifetime) };
        } catch (error) {
          response = { error: String(error) };
        }
        await this.store.set(request.reply, JSON.stringify(response), request.expiresAt, signal);
      }
      await pause(this.poll, signal);
    }
  }
  /** Close the underlying adapter after every owner using it has stopped. */
  [Symbol.dispose](): void {
    this.store[Symbol.dispose]();
  }
}

/** Default local presence. Pass the same instance to several RoomNodes in one process. */
export class MemoryPresence extends StorePresence {
  /** Options and defaults are the same as StorePresence. */
  constructor(options: { namespace?: string; requestTimeout?: number; pollInterval?: number } = {}) {
    super(new MemoryPresenceStore(), options);
  }
}

/**
 * Open a shared SQLite WAL store through Node's built-in sqlite module, loaded only on this call.
 * All participating processes must be on the same host and use the same local file, not a network share.
 * @throws AbortError when aborted before opening; SQLite errors propagate without retries.
 */
export async function openSqlitePresence(
  path: string,
  options: { namespace?: string; requestTimeout?: number; pollInterval?: number; signal?: AbortSignal } = {},
): Promise<StorePresence> {
  options.signal?.throwIfAborted();
  const { DatabaseSync } = await import('node:sqlite');
  options.signal?.throwIfAborted();
  const db = new DatabaseSync(path, { timeout: 5000 });
  try {
    db.exec(
      'PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS margo_presence (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires REAL NOT NULL)',
    );
    const set = db.prepare(
      'INSERT INTO margo_presence VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, expires=excluded.expires',
    );
    const get = db.prepare('SELECT value FROM margo_presence WHERE key=? AND expires>?');
    const keys = db.prepare('SELECT key FROM margo_presence WHERE substr(key,1,?)=? AND expires>? ORDER BY key');
    const take = db.prepare('DELETE FROM margo_presence WHERE key=? AND expires>? RETURNING value');
    const remove = db.prepare('DELETE FROM margo_presence WHERE key=?');
    const sweep = db.prepare('DELETE FROM margo_presence WHERE expires<=?');
    const store: PresenceStore = {
      async set(key, value, expires, signal) {
        signal?.throwIfAborted();
        sweep.run(Date.now());
        set.run(key, value, expires);
      },
      async get(key, signal) {
        signal?.throwIfAborted();
        return get.get(key, Date.now())?.value as string | undefined;
      },
      async keys(prefix, signal) {
        signal?.throwIfAborted();
        return keys.all(prefix.length, prefix, Date.now()).map((row) => row.key as string);
      },
      async take(key, signal) {
        signal?.throwIfAborted();
        return take.get(key, Date.now())?.value as string | undefined;
      },
      async delete(key, signal) {
        signal?.throwIfAborted();
        remove.run(key);
      },
      [Symbol.dispose]() {
        db.close();
      },
    };
    return new StorePresence(store, options);
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Multi-process facade around a RoomServer. Directory reads are advisory; only its owner grants a seat. */
export class RoomNode {
  /** Random process incarnation; never reuses a stale owner's lease. */
  readonly processId = id();
  private readonly stop = new AbortController();
  private readonly presence: RoomPresence;
  private readonly lease: number;
  private readonly heartbeat: number;
  private readonly lobby: RoomLobby;
  private running: Promise<void> | undefined;
  /** endpoint is required; presence defaults to MemoryPresence, leaseMs to 10000, heartbeatMs to 1000. */
  constructor(
    private readonly server: RoomServer,
    private readonly options: { endpoint: string; presence?: RoomPresence; leaseMs?: number; heartbeatMs?: number },
  ) {
    const url = new URL(options.endpoint);
    if (!['ws:', 'wss:', 'http:', 'https:'].includes(url.protocol))
      throw new TypeError('Room endpoint must be ws/wss/http/https; pass the public connection URL');
    this.presence = options.presence ?? new MemoryPresence();
    this.lease = duration(options.leaseMs ?? 10_000);
    this.heartbeat = duration(options.heartbeatMs ?? 1000);
    if (this.heartbeat >= this.lease)
      throw new RangeError('Presence heartbeat must be shorter than its lease; reduce heartbeatMs');
    this.lobby = new RoomLobby(server);
  }
  /** Refresh directory immediately after room creation, disposal or metadata changes when needed. */
  async sync(signal?: AbortSignal): Promise<void> {
    this.stop.signal.throwIfAborted();
    const rooms = this.server.rooms.map(
      (room): PresenceRoom => ({
        roomId: room.roomId,
        name: room.roomName,
        metadata: room instanceof LobbyRoom ? room.metadata : {},
        clients: room.clients.length,
        reserved: room.dropped.length + (room instanceof LobbyRoom ? room.reservedSeats : 0),
        maxClients: room.maxClients,
        joinable: !room.locked,
        privateRoom: room instanceof LobbyRoom && room.privateRoom,
      }),
    );
    await this.presence.publish(
      { processId: this.processId, endpoint: this.options.endpoint, rooms },
      this.lease,
      signal,
    );
  }
  /** Public joinable rooms across live processes with exact filters. */
  async list(
    filter: LobbyFilter = {},
    signal?: AbortSignal,
  ): Promise<(LobbyListing & { endpoint: string; processId: string })[]> {
    const rows = [];
    for (const process of await this.presence.processes(signal))
      for (const room of process.rooms)
        if (
          room.joinable &&
          !room.privateRoom &&
          (!filter.name || room.name === filter.name) &&
          Object.entries(filter.metadata ?? {}).every(
            ([key, value]) => Object.hasOwn(room.metadata, key) && room.metadata[key] === value,
          )
        ) {
          const { joinable: _, privateRoom: __, ...listing } = room;
          rows.push({ ...listing, endpoint: process.endpoint, processId: process.processId });
        }
    return rows.sort((a, b) => (a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0));
  }
  /** Reserve on the actual owner even when called on another server. @throws MargoError `failed` if the route is gone. */
  async reserve(
    roomId: string,
    options: RoomOptions = {},
    lifetime = 15_000,
    signal?: AbortSignal,
  ): Promise<RoutedReservation> {
    const owner = (await this.presence.processes(signal)).find((process) =>
      process.rooms.some((room) => room.roomId === roomId),
    );
    if (!owner) throw fault('failed', 'Room process is no longer present; refresh the room list');
    const seat = await this.presence.request(owner.processId, roomId, options, lifetime, signal);
    return { ...seat, endpoint: owner.endpoint, processId: owner.processId };
  }
  /** Run heartbeat and reservation service until aborted/closed. Adapter failures reject and withdraw this process. */
  run(options: { signal?: AbortSignal } = {}): Promise<void> {
    if (this.running) throw fault('failed', 'RoomNode is already running; await its existing run promise');
    const signal = AbortSignal.any([this.stop.signal, ...(options.signal ? [options.signal] : [])]);
    this.running = this.work(signal);
    return this.running;
  }
  private async work(signal: AbortSignal): Promise<void> {
    const failed = new AbortController(),
      active = AbortSignal.any([signal, failed.signal]);
    const heartbeat = async () => {
      while (!active.aborted) {
        await this.sync(active);
        await pause(this.heartbeat, active);
      }
    };
    const tasks = [
      heartbeat(),
      this.presence.serve(
        this.processId,
        (room, options, lifetime) => this.lobby.reserve(room, options, lifetime),
        active,
      ),
    ];
    try {
      await Promise.all(tasks);
    } catch (error) {
      failed.abort(error);
      if (!signal.aborted) throw error;
    } finally {
      failed.abort();
      await Promise.allSettled(tasks);
      await this.presence.remove(this.processId);
    }
  }
  /** Stop serving and withdraw; does not close the RoomServer or caller-owned presence adapter. */
  async close(): Promise<void> {
    this.stop.abort();
    if (this.running) await this.running;
    else await this.presence.remove(this.processId);
  }
  /** Await shutdown, for await using. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
