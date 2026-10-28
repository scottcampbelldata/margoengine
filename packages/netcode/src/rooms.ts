// Rooms: the room-and-matchmaking API shape many web game servers use (a Room class with onCreate, onJoin, onLeave,
// onMessage handlers, a synced state and broadcast; clients that joinOrCreate a room by name). Written from public
// descriptions of that API shape only. State sync uses this package's schema: the room's state is a schema struct and
// clients receive deltas at the patch rate. Messages are JSON, typed by a string, with a size limit.
import type { SchemaCodec, SchemaShape, UntypedSchema } from './schema.js';
import { Reader, Writer } from './schema.js';
import { CloseCode, fault, type Connection } from './transport.js';

const JOIN = 48,
  SEND = 49,
  LEAVE = 50,
  JOINED = 56,
  REFUSED = 57,
  STATE = 58,
  PATCH = 59,
  MESSAGE = 60;
const METHODS = ['create', 'join', 'joinOrCreate', 'joinById'] as const;
/** How a client asks for a room. */
export type JoinMethod = (typeof METHODS)[number];
const encoder = new TextEncoder(),
  decoder = new TextDecoder('utf-8', { fatal: true });

const text = (w: Writer, s: string) => {
  const b = encoder.encode(s);
  w.varint(b.length);
  w.raw(b);
};
const readText = (r: Reader, max: number): string => {
  const n = r.count(max);
  r.need(n);
  const at = r.at;
  r.at += n;
  try {
    return decoder.decode(r.bytes.subarray(at, at + n));
  } catch {
    throw r.fail(`holds text that is not UTF-8 at byte ${at}`);
  }
};
const rest = (r: Reader): Uint8Array => {
  const out = r.bytes.slice(r.at);
  r.at = r.bytes.length;
  return out;
};
const json = (value: unknown): string => JSON.stringify(value ?? null);

/** One client in a room, on the server. */
export class RoomClient {
  /** Unique id of this seat. */
  readonly sessionId: string;
  /** Anything your room wants to keep per client. */
  userData: unknown = undefined;
  /** What `onAuth` returned. */
  auth: unknown = undefined;
  /** @internal */
  constructor(
    sessionId: string,
    /** @internal */ readonly connection: Connection,
    private readonly limit: number,
  ) {
    this.sessionId = sessionId;
  }
  /**
   * Sends message `type` with a JSON payload to this client, reliably.
   * @throws RangeError when the JSON is over the room's message limit.
   */
  send(type: string, message?: unknown): void {
    const w = new Writer();
    w.u8(MESSAGE);
    text(w, type);
    text(w, json(message));
    if (w.at > this.limit) throw new RangeError(`Room message '${type}' is ${w.at} bytes; keep it under ${this.limit}`);
    this.connection.send(w.done(), 'reliable');
  }
  /** Removes this client from the room (its `onLeave` sees `consented: false`). */
  leave(code: number = CloseCode.removed, reason = 'removed'): void {
    this.connection.close(code, reason);
  }
}

/** Options a room gets in `onCreate` and the client in `join`. JSON values only. */
export type RoomOptions = Record<string, unknown>;

/**
 * A room: subclass it, give it a schema and the struct of its state, and handle the lifecycle.
 *
 * @example
 * ```ts
 * class Lobby extends Room<{ players: Map<number, { x: number }> }> {
 *   schema = schema;
 *   stateType = 'State';
 *   maxClients = 8;
 *   onCreate() {
 *     this.setState({ players: new Map() });
 *     this.onMessage('move', (client, message: { x: number }) => {
 *       const player = this.state.players.get(this.idOf(client));
 *       if (player && Math.abs(message.x) <= 1) player.x += message.x;
 *     });
 *   }
 *   onJoin(client: RoomClient) { this.state.players.set(this.idOf(client), { x: 0 }); }
 *   onLeave(client: RoomClient) { this.state.players.delete(this.idOf(client)); }
 * }
 * ```
 */
export abstract class Room<State = unknown> {
  /** The schema that encodes the state. */
  abstract schema: SchemaCodec<SchemaShape> | UntypedSchema;
  /** The state's struct name in `schema`. */
  abstract stateType: string;
  /** Most clients at once (default 64); a full room refuses joins and matchmaking skips it. */
  maxClients = 64;
  /** Dispose of the room once the last client leaves (default true). */
  autoDispose = true;
  /** Largest message (either way) in bytes (default 4096). */
  maxMessageBytes = 4096;
  /**
   * Messages per second a client may send on average (default: the RoomServer's `limits.messagesPerSecond`, 120). A
   * client past it, once its burst is spent, is closed with `CloseCode.rateLimit`.
   */
  maxMessagesPerSecond: number | undefined = undefined;
  /** Messages a client may send at once (default: the RoomServer's `limits.burst`, 60). */
  messageBurst: number | undefined = undefined;
  /** The room's id. */
  roomId = '';
  /** The name it was defined under. */
  roomName = '';
  /** The clients in the room, in join order. */
  readonly clients: RoomClient[] = [];
  private current: State | undefined;
  private sent = new Map<RoomClient, Uint8Array>();
  private handlers = new Map<string, (client: RoomClient, message: unknown) => void>();
  private patchTimer: ReturnType<typeof setInterval> | undefined;
  private patchRate = -1;
  private simulationTimer: ReturnType<typeof setInterval> | undefined;
  private lockedByHand = false;
  private disposed = false;
  private ids = new WeakMap<RoomClient, number>();
  /** Each client's message bucket: tokens left and when it was last refilled. */
  private buckets = new WeakMap<RoomClient, { tokens: number; at: number }>();
  private nextId = 1;
  /** @internal */ onEmpty: (() => void) | null = null;
  /** @internal Where errors thrown by this room's hooks and handlers go (its RoomServer's `onerror`). */
  report: (error: unknown) => void = (error) => console.error(error);

  /** The synced state (set it with {@link Room.setState}). */
  get state(): State {
    return this.current as State;
  }
  /** Whether the room accepts no more joins (locked by hand, or full). */
  get locked(): boolean {
    return this.lockedByHand || this.clients.length >= this.maxClients;
  }
  /** A small integer id for `client`, unique in this room (handy as a map key in the state). */
  idOf(client: RoomClient): number {
    return this.ids.get(client) ?? 0;
  }
  /** Sets the state clients see; it is sent in full to each client, then as deltas at the patch rate. */
  setState(state: State): void {
    this.current = state;
    if (this.patchRate < 0) this.setPatchRate(50);
  }
  /**
   * Milliseconds between state patches (default 50); 0 stops automatic patches (call {@link Room.patch}). When a
   * timed patch throws (a state the schema cannot encode), the room is stopped as for `setSimulationInterval`.
   */
  setPatchRate(ms: number): void {
    if (this.patchTimer !== undefined) clearInterval(this.patchTimer);
    this.patchRate = ms;
    this.patchTimer = ms > 0 ? setInterval(() => this.guard(() => this.patch()), ms) : undefined;
  }
  /**
   * Runs `step(deltaMs)` every `ms` milliseconds (default 1000 / 60) until the room is disposed. When `step` throws
   * (or returns a promise that rejects), the error goes to the RoomServer's `onerror(error, room)`, every client is
   * closed with `CloseCode.error` and the room is disposed.
   */
  setSimulationInterval(step: (deltaMs: number) => void, ms = 1000 / 60): void {
    if (this.simulationTimer !== undefined) clearInterval(this.simulationTimer);
    let last = performance.now();
    this.simulationTimer = setInterval(() => {
      const now = performance.now(),
        delta = now - last;
      last = now;
      this.guard(() => step(delta));
    }, ms);
  }
  /** Runs a timer's work; a throw or a rejection stops the room instead of escaping as an uncaught error. */
  private guard(run: () => unknown): void {
    if (this.disposed) return;
    try {
      const result = run();
      if (result instanceof Promise) result.catch((error) => this.stop(error));
    } catch (error) {
      this.stop(error);
    }
  }
  /** Reports `error`, closes every client with CloseCode.error and disposes of the room. */
  private stop(error: unknown): void {
    if (this.disposed) return;
    this.report(error);
    for (const client of [...this.clients]) client.connection.close(CloseCode.error, 'room stopped by an error');
    this.release();
  }
  /** Handles client messages of `type` (`'*'` for any type without its own handler). */
  onMessage<T = unknown>(type: string, handler: (client: RoomClient, message: T) => void): void {
    this.handlers.set(type, handler as (client: RoomClient, message: unknown) => void);
  }
  /** Sends message `type` to every client (but `except`). */
  broadcast(type: string, message?: unknown, { except }: { except?: RoomClient | RoomClient[] } = {}): void {
    const skip = new Set(Array.isArray(except) ? except : except ? [except] : []);
    for (const client of this.clients) if (!skip.has(client)) client.send(type, message);
  }
  /** Stops matchmaking from putting new clients here. */
  lock(): void {
    this.lockedByHand = true;
  }
  /** Lets matchmaking put new clients here again. */
  unlock(): void {
    this.lockedByHand = false;
  }
  /** Sends every client the change since its last patch (or the whole state the first time). */
  patch(): void {
    if (this.current === undefined || this.disposed) return;
    const schema = this.schema as UntypedSchema,
      type = this.stateType,
      bytes = schema.encode(type, this.current),
      state = schema.decode(type, bytes);
    for (const client of this.clients) {
      const before = this.sent.get(client);
      if (before && sameBytes(before, bytes)) continue;
      const w = new Writer(bytes.length + 8);
      if (before) {
        w.u8(PATCH);
        w.raw(schema.encodeDelta(type, state, schema.decode(type, before)));
      } else {
        w.u8(STATE);
        w.raw(bytes);
      }
      this.sent.set(client, bytes);
      client.connection.send(w.done(), 'reliable');
    }
  }
  /** Closes every client and disposes of the room. */
  disconnect(): void {
    for (const client of [...this.clients]) client.leave(CloseCode.removed, 'room closed');
    this.release();
  }
  /** Same as {@link Room.disconnect}, for `using`. */
  [Symbol.dispose](): void {
    this.disconnect();
  }

  /**
   * Called once when the room is made, with the creating client's options. Clients see the room only after it
   * resolves; if it throws, the room is disposed (`onDispose` runs) and the creating client is closed with
   * `CloseCode.error`.
   */
  onCreate(_options: RoomOptions): void | Promise<void> {}
  /** Return false (or throw) to refuse `client`; what it returns is kept as `client.auth`. */
  onAuth(_client: RoomClient, _options: RoomOptions): unknown {
    return true;
  }
  /** Called when `client` has joined. If it throws, the client is closed with `CloseCode.error` and `onLeave` runs. */
  onJoin(_client: RoomClient, _options: RoomOptions): void | Promise<void> {}
  /** Called when `client` left: `consented` is true when it called `leave()` itself. */
  onLeave(_client: RoomClient, _consented: boolean): void | Promise<void> {}
  /** Called once when the room is disposed. */
  onDispose(): void | Promise<void> {}

  /** @internal Seats a client: 'joined', 'refused' (by onAuth, or the room is full or gone) or 'failed' (onJoin threw). */
  async admit(
    connection: Connection,
    sessionId: string,
    options: RoomOptions,
  ): Promise<'joined' | 'refused' | 'failed'> {
    const client = new RoomClient(sessionId, connection, this.maxMessageBytes);
    let auth: unknown;
    try {
      auth = await this.onAuth(client, options);
    } catch {
      auth = false;
    }
    // A client that left while onAuth ran is not seated: its close has already passed, so it would never leave.
    if (auth === false || auth === undefined || auth === null || this.disposed || this.locked || !connection.open)
      return 'refused';
    client.auth = auth;
    this.ids.set(client, this.nextId++);
    this.buckets.set(client, { tokens: this.messageBurst ?? 60, at: performance.now() });
    this.clients.push(client);
    connection.onmessage = (data) => this.receive(client, data);
    // The RoomServer's own close handler (it counts open connections) runs first.
    const before = connection.onclose;
    connection.onclose = (code, reason) => {
      before?.(code, reason);
      this.drop(client, code === CloseCode.normal).catch((error) => this.report(error));
    };
    const w = new Writer(64);
    w.u8(JOINED);
    text(w, this.roomId);
    text(w, sessionId);
    w.u32((this.schema as UntypedSchema).hash);
    connection.send(w.done(), 'reliable');
    try {
      await this.onJoin(client, options);
      this.patch();
    } catch (error) {
      this.fail(client, error, 'onJoin failed');
      return 'failed';
    }
    return 'joined';
  }

  /** Reports `error` and closes `client` with CloseCode.error (its `onLeave` then runs). */
  private fail(client: RoomClient, error: unknown, reason: string): void {
    this.report(error);
    client.connection.close(CloseCode.error, reason);
  }

  private receive(client: RoomClient, data: Uint8Array): void {
    // A token bucket per client: maxMessagesPerSecond refilled, messageBurst at most.
    const bucket = this.buckets.get(client);
    if (bucket) {
      const now = performance.now(),
        rate = this.maxMessagesPerSecond ?? 120;
      bucket.tokens = Math.min(this.messageBurst ?? 60, bucket.tokens + ((now - bucket.at) * rate) / 1000);
      bucket.at = now;
      if (bucket.tokens < 1) return client.connection.close(CloseCode.rateLimit, `over ${rate} messages per second`);
      bucket.tokens--;
    }
    let handler: ((client: RoomClient, message: unknown) => void) | undefined, message: unknown;
    try {
      if (data.length > this.maxMessageBytes)
        throw new RangeError('Room message is over maxMessageBytes; send smaller messages or raise the limit');
      const r = new Reader(data, 'Room message', 'send what the room client sends');
      const kind = r.u8();
      if (kind === LEAVE) return client.connection.close(CloseCode.normal, 'left');
      if (kind !== SEND) throw r.fail(`has kind ${kind}, not a message`);
      const type = readText(r, 256);
      message = JSON.parse(readText(r, this.maxMessageBytes));
      r.end();
      handler = this.handlers.get(type) ?? this.handlers.get('*');
    } catch (error) {
      // Bytes that do not decode are the client's fault; anything else here is the server's.
      if (error instanceof RangeError || error instanceof SyntaxError || error instanceof TypeError)
        return client.connection.close(CloseCode.protocol, error.message);
      return this.fail(client, error, 'room error');
    }
    if (!handler) return;
    // A handler that throws, or returns a promise that rejects, is reported and its client closed: the error never
    // escapes into the transport's receive callback or becomes an unhandled rejection.
    try {
      const result = handler(client, message) as unknown;
      if (result instanceof Promise) result.catch((error) => this.fail(client, error, 'message handler failed'));
    } catch (error) {
      this.fail(client, error, 'message handler failed');
    }
  }

  private async drop(client: RoomClient, consented: boolean): Promise<void> {
    const i = this.clients.indexOf(client);
    if (i < 0) return;
    this.clients.splice(i, 1);
    this.sent.delete(client);
    try {
      await this.onLeave(client, consented);
    } finally {
      if (!this.clients.length && this.autoDispose) this.release();
    }
  }

  /** @internal */
  release(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.patchTimer !== undefined) clearInterval(this.patchTimer);
    if (this.simulationTimer !== undefined) clearInterval(this.simulationTimer);
    this.onEmpty?.();
    try {
      const done = this.onDispose();
      if (done instanceof Promise) done.catch((error) => this.report(error));
    } catch (error) {
      this.report(error);
    }
  }
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/** A room class: what {@link RoomServer.define} takes. */
export type RoomClass = new () => Room<unknown>;

/** Per-client message rate of a {@link RoomServer}'s rooms; a room may set its own. */
export interface RoomRateLimits {
  /** Messages per second refilled into each client's bucket (default 120); `Room.maxMessagesPerSecond` overrides it. */
  messagesPerSecond?: number;
  /** Bucket size: the most messages at once (default 60); `Room.messageBurst` overrides it. */
  burst?: number;
}

/** Options of {@link RoomServer}. Every limit has a safe default. */
export interface RoomServerOptions {
  /** Milliseconds a new connection has to send its join; then it is closed with `CloseCode.timeout` (default 10,000). */
  joinTimeout?: number;
  /** Connections at once, in rooms or still joining (default 1,024); the next is closed with `CloseCode.full`. */
  maxConnections?: number;
  /**
   * Rooms at once, those still in `onCreate` included (default 256). Past it `create` rejects with MargoError
   * `'failed'`, and a client's `create` or `joinOrCreate` that would make one more is refused.
   */
  maxRooms?: number;
  /** Message rate per client (defaults 120 per second, bursts of 60); a client over it is closed with `CloseCode.rateLimit`. */
  limits?: RoomRateLimits;
}

const finite = (name: string, value: unknown, min: number, integer: boolean): number => {
  if (typeof value !== 'number' || !(value >= min && value < Number.POSITIVE_INFINITY) || (integer && value % 1))
    throw new RangeError(
      `RoomServer ${name} is ${String(value)}; pass ${integer ? 'an integer' : 'a number'} >= ${min}`,
    );
  return value;
};
const positive = (name: string, value: unknown): number => {
  if (typeof value !== 'number' || !(value > 0 && value < Number.POSITIVE_INFINITY))
    throw new RangeError(`${name} is ${String(value)}; pass a finite number > 0`);
  return value;
};

/**
 * Hosts rooms and matches clients to them. Hand it connections (`listener.onconnection = (c) => rooms.accept(c)`);
 * each connection's first message names the room it wants.
 *
 * @example
 * ```ts
 * const rooms = new RoomServer({ maxRooms: 100 });
 * rooms.define('lobby', Lobby);
 * listener.onconnection = (connection) => rooms.accept(connection);
 * ```
 */
export class RoomServer {
  private readonly classes = new Map<string, { Class: RoomClass; defaults: RoomOptions }>();
  private readonly live = new Map<string, Room>();
  /** Rooms whose onCreate is still running: not joinable yet, but joins for them wait for it. */
  private readonly creating = new Map<Room, Promise<void>>();
  /** Connections that have not sent their join yet. */
  private readonly joining = new Set<Connection>();
  private open = 0;
  private sessions = 0;
  private closed = false;
  private readonly joinTimeout: number;
  private readonly maxConnections: number;
  private readonly maxRooms: number;
  private readonly rate: number;
  private readonly burst: number;

  /**
   * Called with each error a room hook (`onCreate`, `onJoin`, `onLeave`, `onDispose`), message handler, timed patch
   * or `setSimulationInterval` step threw, and the room (undefined when its `onCreate` threw). The client concerned
   * is closed with `CloseCode.error`; a throwing patch or step stops its whole room (every client closed with
   * `CloseCode.error`, the room disposed). The server keeps running. Default: `console.error`.
   */
  onerror: ((error: unknown, room: Room | undefined) => void) | null = null;

  /** @throws RangeError for an option that is not a number in range. */
  constructor(options: RoomServerOptions = {}) {
    const o = options ?? {},
      limits = o.limits ?? {};
    this.joinTimeout = finite('joinTimeout', o.joinTimeout ?? 10_000, 1, false);
    this.maxConnections = finite('maxConnections', o.maxConnections ?? 1024, 1, true);
    this.maxRooms = finite('maxRooms', o.maxRooms ?? 256, 1, true);
    this.rate = positive('RoomServer limits.messagesPerSecond', limits.messagesPerSecond ?? 120);
    this.burst = finite('limits.burst', limits.burst ?? 60, 1, false);
  }

  /** Every live room. */
  get rooms(): Room[] {
    return [...this.live.values()];
  }
  /** Connections open now: in rooms, or still joining. */
  get connections(): number {
    return this.open;
  }

  private report(error: unknown, room: Room | undefined): void {
    if (this.onerror) this.onerror(error, room);
    else console.error(error);
  }

  /**
   * Makes rooms named `name` from `Class`, created with `defaults` merged under the client's options.
   * @throws TypeError for a name defined twice.
   */
  define(name: string, Class: RoomClass, defaults: RoomOptions = {}): this {
    if (this.classes.has(name)) throw new TypeError(`Room '${name}' is already defined; pick another name`);
    this.classes.set(name, { Class, defaults });
    return this;
  }

  /**
   * Creates a room named `name` now, without a client. The room is listed and joinable once its `onCreate` resolved;
   * when `onCreate` throws, the room is disposed and the promise rejects with that error.
   * @throws MargoError `failed` for an undefined name or when `maxRooms` rooms exist, `disposed` once the server is
   * closed; RangeError when the room class sets `maxMessagesPerSecond` or `messageBurst` out of range.
   */
  async create(name: string, options: RoomOptions = {}): Promise<Room> {
    const definition = this.classes.get(name);
    if (!definition) throw fault('failed', `No room named '${name}' is defined; call define('${name}', RoomClass)`);
    if (this.closed) throw fault('disposed', 'RoomServer is closed; create a new RoomServer');
    if (this.full)
      throw fault(
        'failed',
        `RoomServer holds maxRooms (${this.maxRooms}) rooms; raise maxRooms or wait for one to close`,
      );
    const room = new definition.Class();
    room.maxMessagesPerSecond = positive(`Room '${name}' maxMessagesPerSecond`, room.maxMessagesPerSecond ?? this.rate);
    room.messageBurst = room.messageBurst ?? this.burst;
    if (!(room.messageBurst >= 1 && room.messageBurst < Number.POSITIVE_INFINITY))
      throw new RangeError(`Room '${name}' messageBurst is ${room.messageBurst}; pass a finite number >= 1`);
    room.roomName = name;
    room.roomId = randomId();
    room.report = (error) => this.report(error, room);
    const ready = (async () => room.onCreate({ ...definition.defaults, ...options }))();
    this.creating.set(room, ready);
    try {
      await ready;
    } catch (error) {
      room.release();
      throw error;
    } finally {
      this.creating.delete(room);
    }
    if (this.closed) {
      room.release();
      throw fault('disposed', 'RoomServer closed while the room was being created; create a new RoomServer');
    }
    room.onEmpty = () => this.live.delete(room.roomId);
    this.live.set(room.roomId, room);
    return room;
  }

  /** Whether `maxRooms` rooms exist (those in `onCreate` count). */
  private get full(): boolean {
    return this.live.size + this.creating.size >= this.maxRooms;
  }

  /**
   * Takes a new client connection; its first message (a join) picks or creates the room. When a room hook throws
   * during the join, `onerror` gets the error and the connection closes with `CloseCode.error`. A connection past
   * `maxConnections` is closed at once with `CloseCode.full`; one that sends no join within `joinTimeout` is closed
   * with `CloseCode.timeout`.
   * @throws MargoError `disposed` once closed.
   */
  accept(connection: Connection): void {
    if (this.closed) throw fault('disposed', 'RoomServer is closed; create a new RoomServer');
    if (this.open >= this.maxConnections)
      return connection.close(CloseCode.full, `server full: ${this.maxConnections} connections (maxConnections)`);
    this.open++;
    this.joining.add(connection);
    const timer = setTimeout(
      () => connection.close(CloseCode.timeout, `no join within ${this.joinTimeout} ms (joinTimeout)`),
      this.joinTimeout,
    );
    let counted = true;
    connection.onclose = () => {
      clearTimeout(timer);
      this.joining.delete(connection);
      if (counted) this.open--;
      counted = false;
    };
    connection.onmessage = (data) => {
      connection.onmessage = null;
      clearTimeout(timer);
      this.joining.delete(connection);
      this.join(connection, data).catch((error) => {
        this.report(error, undefined);
        connection.close(CloseCode.error, 'room error');
      });
    };
  }

  private refuse(connection: Connection, message: string): void {
    const w = new Writer(64);
    w.u8(REFUSED);
    text(w, message);
    connection.send(w.done(), 'reliable');
    connection.close(CloseCode.normal, 'refused');
  }

  private async join(connection: Connection, data: Uint8Array): Promise<void> {
    let method: JoinMethod, name: string, roomId: string, options: RoomOptions;
    try {
      const r = new Reader(data, 'Room join', 'send what RoomsClient sends');
      if (r.u8() !== JOIN) throw r.fail('is not a join');
      method = METHODS[r.u8()];
      if (!method) throw r.fail('names an unknown join method');
      name = readText(r, 256);
      roomId = readText(r, 64);
      const parsed = JSON.parse(readText(r, 4096));
      r.end();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new TypeError('options must be a JSON object');
      options = parsed;
    } catch (error) {
      if (!(error instanceof RangeError || error instanceof SyntaxError || error instanceof TypeError)) throw error;
      return connection.close(CloseCode.protocol, (error as Error).message);
    }
    if (!this.classes.has(name) && method !== 'joinById') return this.refuse(connection, `no room named '${name}'`);
    const find = (): Room | undefined =>
      method === 'joinById'
        ? this.live.get(roomId)
        : [...this.live.values()].find((r) => r.roomName === name && !r.locked);
    let room = method === 'create' ? undefined : find();
    if (!room && method !== 'create') {
      // A matching room still in its onCreate is not joinable yet: wait for it, then look again. Its own creator
      // handles (and reports) a failed onCreate.
      const waits = [...this.creating]
        .filter(([r]) => (method === 'joinById' ? r.roomId === roomId : r.roomName === name))
        .map(([, ready]) =>
          ready.then(
            () => {},
            () => {},
          ),
        );
      if (waits.length) {
        await Promise.all(waits);
        room = find();
      }
    }
    if (!room && (method === 'create' || method === 'joinOrCreate')) {
      if (this.full) return this.refuse(connection, `the server holds its most rooms (${this.maxRooms}); try later`);
      room = await this.create(name, options);
    }
    if (!room) return this.refuse(connection, method === 'joinById' ? `no room '${roomId}'` : `no open '${name}' room`);
    const result = await room.admit(connection, `${randomId()}${(++this.sessions).toString(36)}`, options);
    if (result === 'refused') {
      this.refuse(connection, 'the room refused the join');
      if (!room.clients.length && room.autoDispose) room.release();
    }
  }

  /** Disconnects every room and closes connections still joining. */
  close(): void {
    this.closed = true;
    for (const connection of [...this.joining]) connection.close(CloseCode.removed, 'server closing');
    for (const room of [...this.live.values()]) room.disconnect();
  }
  /** Same as close, for `using`. */
  [Symbol.dispose](): void {
    this.close();
  }
}

const randomId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes]
    .map((b) => b.toString(36).padStart(2, '0'))
    .join('')
    .slice(0, 9);
};

/** A joined room, on the client. */
export class JoinedRoom<State = unknown> {
  /** The room's id (for `joinById`). */
  readonly roomId: string;
  /** This client's seat id. */
  readonly sessionId: string;
  private current: State | undefined;
  private readonly stateHandlers = new Set<(state: State) => void>();
  private readonly messageHandlers = new Map<string, Set<(message: unknown) => void>>();
  private readonly leaveHandlers = new Set<(code: number) => void>();
  /** @internal */
  constructor(
    private readonly connection: Connection,
    private readonly schema: UntypedSchema,
    private readonly stateType: string,
    roomId: string,
    sessionId: string,
  ) {
    this.roomId = roomId;
    this.sessionId = sessionId;
    connection.onmessage = (data) => this.receive(data);
    connection.onclose = (code) => {
      for (const handler of this.leaveHandlers) handler(code);
    };
  }
  /** The newest state (undefined until the first arrives). Treat it as read-only. */
  get state(): State {
    return this.current as State;
  }
  private receive(data: Uint8Array): void {
    try {
      const r = new Reader(data, 'Room message', 'update the client to the server version');
      const kind = r.u8();
      if (kind === STATE || kind === PATCH) {
        const bytes = rest(r);
        if (kind === PATCH && this.current === undefined) throw r.fail('patches a state it never sent');
        this.current = (
          kind === STATE
            ? this.schema.decode(this.stateType, bytes)
            : this.schema.decodeDelta(this.stateType, bytes, this.current)
        ) as State;
        for (const handler of this.stateHandlers) handler(this.current);
      } else if (kind === MESSAGE) {
        const type = readText(r, 256),
          message = JSON.parse(readText(r, 1 << 20));
        r.end();
        for (const handler of this.messageHandlers.get(type) ?? this.messageHandlers.get('*') ?? []) handler(message);
      } else throw r.fail(`has unknown kind ${kind}`);
    } catch (error) {
      if (!(error instanceof RangeError || error instanceof SyntaxError || error instanceof TypeError)) throw error;
      this.connection.close(CloseCode.protocol, error.message.slice(0, 120));
    }
  }
  /** Calls `handler` with each new state. Returns a function that removes it. */
  onStateChange(handler: (state: State) => void): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }
  /** Calls `handler` with each message of `type` (`'*'` for types without their own handler). Returns a remover. */
  onMessage<T = unknown>(type: string, handler: (message: T) => void): () => void {
    const set = this.messageHandlers.get(type) ?? new Set();
    set.add(handler as (message: unknown) => void);
    this.messageHandlers.set(type, set);
    return () => set.delete(handler as (message: unknown) => void);
  }
  /** Calls `handler` with the close code when this client leaves or is removed. Returns a remover. */
  onLeave(handler: (code: number) => void): () => void {
    this.leaveHandlers.add(handler);
    return () => this.leaveHandlers.delete(handler);
  }
  /** The states as an async iterator, until the client leaves or `signal` aborts. */
  async *states({ signal }: { signal?: AbortSignal } = {}): AsyncGenerator<State, void, undefined> {
    const queue: State[] = [];
    let wake: (() => void) | null = null,
      done = !this.connection.open;
    const notify = () => {
      const w = wake;
      wake = null;
      w?.();
    };
    const offState = this.onStateChange((state) => {
        queue.push(state);
        notify();
      }),
      offLeave = this.onLeave(() => {
        done = true;
        notify();
      }),
      abort = () => {
        done = true;
        notify();
      };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      while (true) {
        while (queue.length) yield queue.shift() as State;
        if (done) return;
        await new Promise<void>((resolve) => (wake = resolve));
      }
    } finally {
      offState();
      offLeave();
      signal?.removeEventListener('abort', abort);
    }
  }
  /** Sends message `type` with a JSON payload to the room. */
  send(type: string, message?: unknown): void {
    const w = new Writer();
    w.u8(SEND);
    text(w, type);
    text(w, json(message));
    this.connection.send(w.done(), 'reliable');
  }
  /** Leaves the room (its `onLeave` sees `consented: true`). */
  leave(): void {
    if (!this.connection.open) return;
    const w = new Writer(4);
    w.u8(LEAVE);
    this.connection.send(w.done(), 'reliable');
    this.connection.close(CloseCode.normal, 'left');
  }
  /** Same as leave, for `using`. */
  [Symbol.dispose](): void {
    this.leave();
  }
}

/** Options of a {@link RoomsClient} join. */
export interface JoinOptions<S> {
  /** The schema the room's state uses (the same as the server's). */
  schema: SchemaCodec<SchemaShape> | UntypedSchema;
  /** The state's struct name. */
  stateType: string;
  /** Aborts the join. */
  signal?: AbortSignal;
  /** @internal phantom type of the state */
  state?: S;
}

/**
 * Joins rooms. `connect` opens a new connection for each join (one room per connection), for example
 * `() => openWebSocket(url)`.
 *
 * @example
 * ```ts
 * const client = new RoomsClient(() => openWebSocket('wss://game.example.com'));
 * const room = await client.joinOrCreate('lobby', { mode: 'duel' }, { schema, stateType: 'State' });
 * room.onStateChange((state) => draw(state));
 * room.send('move', { x: 1 });
 * ```
 */
export class RoomsClient {
  /** @param connect Opens one connection to the room server. */
  constructor(private readonly connect: () => Promise<Connection>) {}
  /** Joins an open room named `name`, or creates one. */
  joinOrCreate<S>(name: string, options: RoomOptions, join: JoinOptions<S>): Promise<JoinedRoom<S>> {
    return this.open('joinOrCreate', name, '', options, join);
  }
  /** Creates a new room named `name`. */
  create<S>(name: string, options: RoomOptions, join: JoinOptions<S>): Promise<JoinedRoom<S>> {
    return this.open('create', name, '', options, join);
  }
  /** Joins an open room named `name`; fails when there is none. */
  join<S>(name: string, options: RoomOptions, join: JoinOptions<S>): Promise<JoinedRoom<S>> {
    return this.open('join', name, '', options, join);
  }
  /** Joins the room with id `roomId`. */
  joinById<S>(roomId: string, options: RoomOptions, join: JoinOptions<S>): Promise<JoinedRoom<S>> {
    return this.open('joinById', '', roomId, options, join);
  }

  private async open<S>(
    method: JoinMethod,
    name: string,
    roomId: string,
    options: RoomOptions,
    { schema, stateType, signal }: JoinOptions<S>,
  ): Promise<JoinedRoom<S>> {
    signal?.throwIfAborted();
    const connection = await this.connect(),
      untyped = schema as UntypedSchema;
    return new Promise((resolve, reject) => {
      // The abort reason wins: the close it causes must not reject the join with a close message first.
      const abort = () => {
        connection.onclose = null;
        connection.onmessage = null;
        connection.close(CloseCode.normal, 'aborted');
        reject(signal?.reason);
      };
      signal?.addEventListener('abort', abort, { once: true });
      const fail = (message: string) => {
        signal?.removeEventListener('abort', abort);
        reject(fault('failed', message));
      };
      connection.onclose = (code, reason) =>
        fail(`Room join closed (${code} ${reason}); check the room name and server`);
      connection.onmessage = (data) => {
        try {
          const r = new Reader(data, 'Room reply', 'update the client to the server version');
          const kind = r.u8();
          if (kind === REFUSED) return fail(`Room join refused: ${readText(r, 4096)}; check the name or try another`);
          if (kind !== JOINED) throw r.fail(`has kind ${kind}, not a join reply`);
          const id = readText(r, 64),
            session = readText(r, 64),
            hash = r.u32();
          r.end();
          if (hash !== untyped.hash) {
            connection.close(CloseCode.mismatch, 'schema differs');
            return fail('Room state schema differs from the server; use the same schema on both ends');
          }
          signal?.removeEventListener('abort', abort);
          resolve(new JoinedRoom<S>(connection, untyped, stateType, id, session));
        } catch (error) {
          connection.close(CloseCode.protocol, (error as Error).message.slice(0, 120));
          fail(`Room join failed: ${(error as Error).message}`);
        }
      };
      const w = new Writer(64);
      w.u8(JOIN);
      w.u8(METHODS.indexOf(method));
      text(w, name);
      text(w, roomId);
      text(w, json(options));
      connection.send(w.done(), 'reliable');
    });
  }
}
