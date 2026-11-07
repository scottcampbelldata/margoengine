// A relay and spectators for rollback sessions. In a full mesh every peer holds a link to every other, which stops being
// practical at about 8. Here each peer holds one link, to the relay, and sees the other players through it as ordinary
// connections, so RollbackSession does not change. The relay also learns every input on its way through, and streams
// each frame to spectators once every player's input for it is known: they run the same game from the same inputs,
// with no rollback, and cost the players nothing.
import type { Game } from './game.js';
import { checksumOf, MAX_INPUT_BYTES, MAX_INPUTS_PER_MESSAGE, ROLLBACK_INPUTS } from './protocol.js';
import { Reader, Writer } from './schema.js';
import { CloseCode, fault, type Connection, type Delivery } from './transport.js';

const HELLO = 1,
  FORWARD = 2,
  FROM = 3,
  GONE = 4,
  WELCOME = 5,
  FRAME = 6;
/** How far past the newest complete frame the relay keeps a player's inputs. */
const AHEAD = 1024;

/** Options of {@link RollbackRelay}. */
export interface RollbackRelayOptions {
  /** Ids of every player of the session, the same list the sessions get. */
  players: readonly number[];
  /** The sessions' `inputDelay` (default 2). */
  inputDelay?: number;
  /** Frames spectators stay behind the players, so a spectator cannot help a player (default 0). */
  spectatorDelay?: number;
  /** Frames kept for spectators who arrive late, who replay from the start (default 216,000: an hour at 60 Hz). */
  history?: number;
  /** Most spectators at once (default 256); the next is closed with `CloseCode.full`. */
  maxSpectators?: number;
  /** Return false to refuse a connection; `player` is undefined for a spectator. Default: anyone. */
  authorize?(player: number | undefined, token: string): boolean;
}

/** Counts since the relay started. */
export interface RollbackRelayStats {
  /** Messages passed between players. */
  forwarded: number;
  /** Frames every player's input is known for. */
  frames: number;
  /** Frames sent to spectators, summed over them. */
  spectated: number;
}

const encoder = new TextEncoder(),
  decoder = new TextDecoder();

const hello = (player: number | undefined, token: string): Uint8Array => {
  const w = new Writer(32),
    bytes = encoder.encode(token);
  w.u8(HELLO);
  w.varint(player === undefined ? 0 : player + 1);
  w.varint(bytes.length);
  w.raw(bytes);
  return w.done();
};

/**
 * Where the players of a rollback session meet: pass it each peer's and spectator's connection with
 * {@link RollbackRelay.accept}. It trusts nothing a peer says about who it is once joined, and runs no game.
 *
 * @example
 * ```ts
 * const relay = new RollbackRelay({ players: [1, 2, 3, 4] });
 * listener.onconnection = (connection) => relay.accept(connection);
 * ```
 */
export class RollbackRelay {
  /** Counts since the relay started. */
  readonly stats: RollbackRelayStats = { forwarded: 0, frames: 0, spectated: 0 };
  private readonly players: number[];
  private readonly links = new Map<number, Connection>();
  private readonly inputs = new Map<number, Map<number, Uint8Array>>();
  private readonly spectators = new Map<Connection, number>();
  private readonly log: Uint8Array[] = [];
  private readonly delay: number;
  private readonly hold: number;
  private readonly history: number;
  private readonly maxSpectators: number;
  private base = 0;
  private complete: number;
  private closed = false;

  /** @throws TypeError for an empty player list; RangeError for an option out of range. */
  constructor(private readonly options: RollbackRelayOptions) {
    this.players = [...new Set(options?.players ?? [])].sort((a, b) => a - b);
    if (!this.players.length) throw new TypeError('RollbackRelay needs players; pass the list the sessions get');
    const range = (what: string, v: number, min: number, max: number) => {
      if (!Number.isInteger(v) || v < min || v > max)
        throw new RangeError(`RollbackRelay ${what} is ${v}; pass an integer from ${min} to ${max}`);
      return v;
    };
    this.delay = range('inputDelay', options.inputDelay ?? 2, 0, 30);
    this.hold = range('spectatorDelay', options.spectatorDelay ?? 0, 0, 1 << 20);
    this.history = range('history', options.history ?? 216_000, 1, 2 ** 31);
    this.maxSpectators = range('maxSpectators', options.maxSpectators ?? 256, 0, 65536);
    this.complete = this.delay;
    for (const player of this.players) this.inputs.set(player, new Map());
  }

  /** The newest frame every player's input is known for. */
  get frame(): number {
    return this.complete;
  }
  /** How many spectators are watching. */
  get watching(): number {
    return this.spectators.size;
  }

  /**
   * Takes a connection: its first reliable message says whether it is a player or a spectator.
   * @throws MargoError `disposed` once the relay is closed.
   */
  accept(connection: Connection): void {
    if (this.closed) throw fault('disposed', 'RollbackRelay is closed; create a new RollbackRelay');
    connection.onmessage = (data, channel) => {
      // Reliable delivery may take longer than unreliable, so a peer's first inputs can pass its hello.
      if (channel === 'unreliable') return;
      this.greet(connection, data);
    };
  }

  private refuse(connection: Connection, code: number, reason: string): void {
    connection.onmessage = null;
    connection.close(code, reason);
  }

  private greet(connection: Connection, data: Uint8Array): void {
    let player: number | undefined, token: string;
    try {
      const r = new Reader(data, 'Rollback relay hello', 'send what relayPeers or RollbackSpectator sends');
      if (r.u8() !== HELLO) throw r.fail('is not a hello');
      const id = r.varint(),
        n = r.count(1024);
      r.need(n);
      token = decoder.decode(data.subarray(r.at, (r.at += n)));
      r.end();
      player = id ? id - 1 : undefined;
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return this.refuse(connection, CloseCode.protocol, error.message.slice(0, 120));
    }
    if (this.options.authorize && !this.options.authorize(player, token))
      return this.refuse(connection, CloseCode.removed, 'not allowed');
    if (player === undefined) return this.watch(connection);
    if (!this.inputs.has(player)) return this.refuse(connection, CloseCode.protocol, `no player ${player} here`);
    if (this.links.has(player)) return this.refuse(connection, CloseCode.full, `player ${player} is already here`);
    this.links.set(player, connection);
    const id = player;
    connection.onmessage = (bytes, channel) => this.pass(id, connection, bytes, channel);
    connection.onclose = () => this.leave(id, connection);
  }

  private leave(player: number, connection: Connection): void {
    if (this.links.get(player) !== connection) return;
    this.links.delete(player);
    const w = new Writer(8);
    w.u8(GONE);
    w.varint(player);
    const message = w.done();
    for (const link of this.links.values()) link.send(message, 'reliable');
  }

  private pass(player: number, connection: Connection, data: Uint8Array, channel: Delivery): void {
    try {
      const r = new Reader(data, 'Rollback relay message', 'send what relayPeers sends');
      if (r.u8() !== FORWARD) throw r.fail('is not a forward');
      const to = r.varint(),
        at = r.at,
        link = this.links.get(to);
      this.learn(player, data.subarray(at));
      if (!link) return;
      const w = new Writer(data.length + 8);
      w.u8(FROM);
      w.varint(player);
      w.raw(data.subarray(at));
      link.send(w.done(), channel);
      this.stats.forwarded++;
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      connection.close(CloseCode.protocol, error.message.slice(0, 120));
    }
  }

  /** Keeps the inputs in a session message on its way through. Bytes that are not inputs are none of the relay's. */
  private learn(player: number, data: Uint8Array): void {
    const r = new Reader(data, 'Rollback message', 'send what RollbackSession sends');
    if (r.u8() !== ROLLBACK_INPUTS) return;
    r.varint();
    r.varint();
    r.varint();
    const first = r.varint(),
      n = r.count(MAX_INPUTS_PER_MESSAGE),
      inputs = this.inputs.get(player) as Map<number, Uint8Array>;
    for (let i = 0; i < n; i++) {
      const length = r.count(MAX_INPUT_BYTES);
      r.need(length);
      const frame = first + i,
        bytes = data.subarray(r.at, (r.at += length));
      if (frame > this.complete && frame <= this.complete + AHEAD && !inputs.has(frame)) inputs.set(frame, bytes.slice());
    }
    r.end();
    this.advance();
  }

  private advance(): void {
    for (;;) {
      const frame = this.complete + 1,
        list: Uint8Array[] = [];
      for (const player of this.players) {
        const input = this.inputs.get(player)?.get(frame);
        if (input) list.push(input);
      }
      if (list.length < this.players.length) break;
      const w = new Writer(64);
      w.u8(FRAME);
      w.varint(frame);
      for (const input of list) {
        w.varint(input.length);
        w.raw(input);
      }
      for (const inputs of this.inputs.values()) inputs.delete(frame);
      this.log.push(w.done());
      if (this.log.length > this.history + this.hold) {
        this.log.shift();
        this.base++;
      }
      this.complete = frame;
      this.stats.frames++;
    }
    for (const connection of this.spectators.keys()) this.feed(connection);
  }

  /** Sends `connection` every frame it may see and has not had. */
  private feed(connection: Connection): void {
    const end = this.base + this.log.length - this.hold;
    let next = this.spectators.get(connection) as number;
    for (; next < end; next++) {
      connection.send(this.log[next - this.base], 'reliable');
      this.stats.spectated++;
    }
    this.spectators.set(connection, next);
  }

  private watch(connection: Connection): void {
    if (this.spectators.size >= this.maxSpectators)
      return this.refuse(connection, CloseCode.full, `the relay holds ${this.maxSpectators} spectators (maxSpectators)`);
    if (this.base > 0)
      return this.refuse(connection, CloseCode.full, 'the session passed the history; raise history to watch it');
    const w = new Writer(32);
    w.u8(WELCOME);
    w.varint(this.delay);
    w.varint(this.players.length);
    for (const player of this.players) w.varint(player);
    connection.send(w.done(), 'reliable');
    connection.onmessage = null;
    connection.onclose = () => this.spectators.delete(connection);
    this.spectators.set(connection, 0);
    this.feed(connection);
  }

  /** Closes every connection. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const link of [...this.links.values()]) link.close(CloseCode.removed, 'relay closed');
    for (const connection of [...this.spectators.keys()]) connection.close(CloseCode.removed, 'relay closed');
  }
  /** Same as {@link RollbackRelay.close}, for `using`. */
  [Symbol.dispose](): void {
    this.close();
  }
}

/** Options of {@link relayPeers}. */
export interface RelayPeersOptions {
  /** Ids of every player of the session. */
  players: readonly number[];
  /** This peer's player id. */
  local: number;
  /** What the relay's `authorize` gets. */
  token?: string;
}

/**
 * The other players of a session, seen through one `link` to a {@link RollbackRelay}: pass the result as the session's
 * `peers`. Closing them all closes the link.
 *
 * @example
 * ```ts
 * const session = new RollbackSession(game, {
 *   players: [1, 2, 3, 4],
 *   local: 1,
 *   peers: relayPeers(await openWebSocket(relayUrl), { players: [1, 2, 3, 4], local: 1 }),
 *   input: () => readInput(),
 * });
 * ```
 */
export function relayPeers(link: Connection, { players, local, token = '' }: RelayPeersOptions): Map<number, Connection> {
  if (!link || typeof link.send !== 'function')
    throw new TypeError('relayPeers needs a connection to the relay; pass one');
  if (!players?.includes(local)) throw new TypeError(`relayPeers local player ${local} is not in players; add it`);
  const peers = new Map<number, Connection>();
  let open = players.length - 1;
  for (const player of players) {
    if (player === local) continue;
    let closed = false;
    const finish = (code: number, reason: string) => {
      if (closed) return;
      closed = true;
      connection.onclose?.(code, reason);
      if (--open === 0) link.close(CloseCode.normal, 'left');
    };
    const connection: Connection = {
      get open() {
        return !closed && link.open;
      },
      send(data, channel = 'reliable') {
        if (closed) return;
        const w = new Writer(data.length + 8);
        w.u8(FORWARD);
        w.varint(player);
        w.raw(data);
        link.send(w.done(), channel);
      },
      close: (code = CloseCode.normal, reason = '') => finish(code, reason),
      onmessage: null,
      onclose: null,
    };
    peers.set(player, connection);
  }
  link.onmessage = (data, channel) => {
    const r = new Reader(data, 'Rollback relay message', 'update the client to the relay version'),
      kind = r.u8(),
      player = r.varint(),
      peer = peers.get(player);
    if (!peer) return;
    if (kind === FROM) peer.onmessage?.(data.subarray(r.at), channel);
    else if (kind === GONE) peer.close(CloseCode.normal, 'player left');
  };
  link.onclose = (code, reason) => {
    for (const peer of peers.values()) peer.close(code, reason);
  };
  link.send(hello(local, token), 'reliable');
  return peers;
}

/** Options of {@link RollbackSpectator}. */
export interface RollbackSpectatorOptions {
  /** What the relay's `authorize` gets. */
  token?: string;
  /** Most frames one {@link RollbackSpectator.update} runs (default 8; a late arrival catches up at this pace). */
  maxFrames?: number;
  /** Called once per frame with the same FNV-1a checksum the players' `onconfirm` gets. */
  onconfirm?(frame: number, checksum: number): void;
}

/**
 * Watches a rollback session through a {@link RollbackRelay}: it runs the game on the players' confirmed inputs, so it
 * is behind them by what confirming takes, and what it shows is final. Call {@link RollbackSpectator.update} every
 * frame and draw {@link RollbackSpectator.state}; it starts at the first frame, however late it arrives.
 *
 * @example
 * ```ts
 * const watcher = new RollbackSpectator(game, await openWebSocket(relayUrl));
 * engine.onFrame(() => { watcher.update(); draw(watcher.state); });
 * ```
 */
export class RollbackSpectator<State, Input> {
  private current: State;
  private frameNumber = 0;
  private players: number[] | undefined;
  private delay = 0;
  private closed = false;
  private readonly queue: Uint8Array[][] = [];
  private readonly maxFrames: number;

  /** @throws RangeError for a `maxFrames` that is not an integer of 1 or more. */
  constructor(
    readonly game: Game<State, Input>,
    private readonly connection: Connection,
    private readonly options: RollbackSpectatorOptions = {},
  ) {
    this.maxFrames = options.maxFrames ?? 8;
    if (!Number.isInteger(this.maxFrames) || this.maxFrames < 1)
      throw new RangeError(`RollbackSpectator maxFrames is ${this.maxFrames}; pass an integer of 1 or more`);
    this.current = game.initial();
    connection.onmessage = (data) => this.receive(data);
    connection.onclose = () => (this.closed = true);
    connection.send(hello(undefined, options.token ?? ''), 'reliable');
  }

  /** The newest frame run. */
  get frame(): number {
    return this.frameNumber;
  }
  /** The state after {@link RollbackSpectator.frame}. Replaced as frames run. */
  get state(): State {
    return this.current;
  }
  /** Frames received and not run yet. */
  get behind(): number {
    return this.queue.length;
  }
  /** Whether the relay is still connected. */
  get open(): boolean {
    return !this.closed;
  }

  private receive(data: Uint8Array): void {
    const r = new Reader(data, 'Rollback spectator message', 'update the client to the relay version'),
      kind = r.u8();
    if (kind === WELCOME) {
      this.delay = r.varint();
      const players: number[] = [];
      for (let n = r.count(65536); n > 0; n--) players.push(r.varint());
      this.players = players;
      const state = this.game.initial();
      for (const player of players) this.game.join(state, player);
      const game = this.game;
      this.current = game.schema.decode(game.stateType, game.schema.encode(game.stateType, state)) as State;
      for (let frame = 1; frame <= this.delay; frame++) this.queue.push([]);
    } else if (kind === FRAME) {
      r.varint();
      const list: Uint8Array[] = [];
      for (let i = 0; i < (this.players as number[]).length; i++) {
        const length = r.count(MAX_INPUT_BYTES);
        r.need(length);
        list.push(data.subarray(r.at, (r.at += length)));
      }
      this.queue.push(list);
    }
  }

  /** Runs the frames that arrived, at most `maxFrames`. Returns how many ran. */
  update(): number {
    const game = this.game,
      players = this.players;
    let ran = 0;
    for (; players && ran < this.maxFrames && this.queue.length; ran++) {
      const list = this.queue.shift() as Uint8Array[],
        inputs = new Map<number, Input>(),
        frame = ++this.frameNumber;
      list.forEach((bytes, i) => inputs.set(players[i], game.schema.decode(game.inputType, bytes) as Input));
      game.step(this.current, inputs, frame, 1 / game.tickRate);
      const bytes = game.schema.encode(game.stateType, this.current);
      this.current = game.schema.decode(game.stateType, bytes) as State;
      this.options.onconfirm?.(frame, checksumOf(bytes));
    }
    return ran;
  }

  /** Stops watching. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connection.close(CloseCode.normal, 'left');
  }
  /** Same as {@link RollbackSpectator.close}, for `using`. */
  [Symbol.dispose](): void {
    this.close();
  }
}
