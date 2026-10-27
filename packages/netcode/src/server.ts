// The authoritative server: a fixed-timestep loop over the game's deterministic step. Clients send only inputs; the
// server validates them, buffers them by tick, runs every tick once, and sends each client delta-compressed snapshots
// against the newest one that client confirmed. Nothing a client says changes state except through validated input.
import type { Game } from './game.js';
import { decodeEnvelope, encodeEnvelope, ENVELOPE_VERSION, type Envelope } from './protocol.js';
import { CloseCode, fault, type Delivery, type Connection } from './transport.js';

/** Limits on what one client may send. */
export interface RateLimits {
  /** Messages per second refilled into the client's bucket (default 120). */
  messagesPerSecond?: number;
  /** Bucket size: the most messages in a burst (default 60). */
  burst?: number;
  /** Largest message in bytes (default 4096). */
  maxMessageBytes?: number;
}

/** Options of {@link GameServer}. */
export interface GameServerOptions<State, Input> {
  /** Most players at once, 1 to 65,536 (default 64); one more is closed with `CloseCode.full`. */
  maxPlayers?: number;
  /** Send a snapshot every this many ticks, 1 to 60 (default 1). */
  snapshotEvery?: number;
  /** Ticks of snapshots kept as delta baselines, 2 to 1024 (default 64). */
  history?: number;
  /** Inputs more than this many ticks ahead of the server are dropped (default 2 seconds of ticks). */
  maxInputAhead?: number;
  /**
   * Called for every decoded input before it is buffered; return false to drop it (it counts in
   * `stats.rejectedInputs`). The schema already checked its types and ranges.
   */
  validateInput?(input: Input, player: number, state: State): boolean;
  /** The part of the state player `player` may see (interest management, hidden information); default all of it. */
  view?(state: State, player: number): State;
  /** Per-client limits; a client over them is closed with `CloseCode.rateLimit`. */
  limits?: RateLimits;
  /** Milliseconds of silence after which a client is closed with `CloseCode.timeout` (default 10,000). */
  timeout?: number;
  /** The clock in milliseconds (default `performance.now`); a test passes the loopback network's time. */
  now?: () => number;
  /** Called with each game message (`client.send`) once its schema bytes decoded. */
  onmessage?(player: number, type: string, value: unknown): void;
}

/** Counts since the server started. */
export interface GameServerStats {
  /** Ticks run. */
  ticks: number;
  /** Inputs buffered. */
  inputs: number;
  /** Inputs that arrived after their tick ran. */
  lateInputs: number;
  /** Inputs dropped by `validateInput`, as duplicates, or as too far ahead. */
  rejectedInputs: number;
  /** Ticks a playing client had no input for (its last input was used). */
  missedInputs: number;
  /** Snapshots sent; `deltaSnapshots` of them against a baseline. */
  snapshots: number;
  /** Snapshots sent against a baseline. */
  deltaSnapshots: number;
  /** Snapshot bytes sent. */
  snapshotBytes: number;
  /** Clients closed for breaking the protocol, the limits or the timeout. */
  dropped: number;
}

interface Peer<State, Input> {
  connection: Connection;
  player: number;
  playing: boolean;
  inputs: Map<number, Input>;
  last?: Input;
  newest: number;
  missed: number;
  ack: number;
  sent: Map<number, State>;
  tokens: number;
  refilled: number;
  heard: number;
}

const integer = (what: string, v: number, min: number, max: number) => {
  if (!Number.isInteger(v) || v < min || v > max)
    throw new RangeError(`GameServer ${what} is ${v}; pass an integer from ${min} to ${max}`);
  return v;
};

/**
 * The authoritative server of a {@link Game}. Hand it connections with {@link GameServer.accept}; run ticks with
 * {@link GameServer.run} (real time) or {@link GameServer.step} (one tick, for tests and your own loop).
 *
 * @example
 * ```ts
 * const server = new GameServer(game);
 * listener.onconnection = (connection) => server.accept(connection);
 * const stop = new AbortController();
 * await server.run({ signal: stop.signal });
 * ```
 */
export class GameServer<State, Input> {
  /** Counts since the server started. */
  readonly stats: GameServerStats = {
    ticks: 0,
    inputs: 0,
    lateInputs: 0,
    rejectedInputs: 0,
    missedInputs: 0,
    snapshots: 0,
    deltaSnapshots: 0,
    snapshotBytes: 0,
    dropped: 0,
  };
  private current: State;
  private ticks = 0;
  private lastTickAt: number;
  private nextPlayer = 1;
  private closed = false;
  private readonly peers = new Set<Peer<State, Input>>();
  private readonly joins: number[] = [];
  private readonly leaves: number[] = [];
  private readonly now: () => number;
  private readonly maxPlayers: number;
  private readonly snapshotEvery: number;
  private readonly keep: number;
  private readonly ahead: number;
  private readonly timeout: number;
  private readonly rate: number;
  private readonly burst: number;
  private readonly maxBytes: number;

  /**
   * @throws RangeError for an option out of range.
   */
  constructor(
    readonly game: Game<State, Input>,
    private readonly options: GameServerOptions<State, Input> = {},
  ) {
    this.maxPlayers = integer('maxPlayers', options.maxPlayers ?? 64, 1, 65536);
    this.snapshotEvery = integer('snapshotEvery', options.snapshotEvery ?? 1, 1, 60);
    this.keep = integer('history', options.history ?? 64, 2, 1024);
    this.ahead = integer('maxInputAhead', options.maxInputAhead ?? 2 * game.tickRate, 1, 65536);
    this.timeout = options.timeout ?? 10_000;
    if (!(this.timeout > 0)) throw new RangeError(`GameServer timeout is ${this.timeout}; pass milliseconds > 0`);
    const limits = options.limits ?? {};
    this.rate = limits.messagesPerSecond ?? 120;
    this.burst = limits.burst ?? 60;
    this.maxBytes = integer('maxMessageBytes', limits.maxMessageBytes ?? 4096, 64, 1 << 24);
    if (!(this.rate > 0) || !(this.burst >= 1))
      throw new RangeError('GameServer limits need messagesPerSecond > 0 and burst >= 1; fix the limits');
    this.now = options.now ?? (() => performance.now());
    this.current = this.canonical(game.initial());
    this.lastTickAt = this.now();
  }

  /** The newest tick run (0 before the first). */
  get tick(): number {
    return this.ticks;
  }
  /** The authoritative state after {@link GameServer.tick}. Replaced every tick: read it again after each. */
  get state(): State {
    return this.current;
  }
  /** Ids of the players in the game. */
  get players(): number[] {
    return [...this.peers].filter((p) => p.playing).map((p) => p.player);
  }

  private canonical(state: State): State {
    return this.game.schema.clone(this.game.stateType, state) as State;
  }

  /**
   * Takes a new client connection: it joins the game once its hello matches this server's protocol and schema.
   * @throws MargoError `disposed` once the server is closed.
   */
  accept(connection: Connection): void {
    if (this.closed) throw fault('disposed', 'GameServer is closed; create a new GameServer');
    const peer: Peer<State, Input> = {
      connection,
      player: 0,
      playing: false,
      inputs: new Map(),
      newest: 0,
      missed: 0,
      ack: 0,
      sent: new Map(),
      tokens: this.burst,
      refilled: this.now(),
      heard: this.now(),
    };
    this.peers.add(peer);
    connection.onmessage = (data, channel) => this.receive(peer, data, channel);
    connection.onclose = () => this.remove(peer);
  }

  private drop(peer: Peer<State, Input>, code: number, reason: string): void {
    this.stats.dropped++;
    peer.connection.close(code, reason);
    this.remove(peer);
  }

  private remove(peer: Peer<State, Input>): void {
    if (!this.peers.delete(peer)) return;
    if (peer.playing) this.leaves.push(peer.player);
  }

  private receive(peer: Peer<State, Input>, data: Uint8Array, _channel: Delivery): void {
    if (!this.peers.has(peer)) return;
    const now = this.now();
    peer.tokens = Math.min(this.burst, peer.tokens + ((now - peer.refilled) * this.rate) / 1000);
    peer.refilled = now;
    if (peer.tokens < 1) return this.drop(peer, CloseCode.rateLimit, 'too many messages');
    peer.tokens--;
    if (data.length > this.maxBytes) return this.drop(peer, CloseCode.rateLimit, 'message too large');
    peer.heard = now;
    let message: Envelope;
    try {
      message = decodeEnvelope(data);
    } catch (error) {
      return this.drop(peer, CloseCode.protocol, (error as Error).message.slice(0, 120));
    }
    if (!peer.player && message.kind !== 'hello') return this.drop(peer, CloseCode.protocol, 'hello first');
    try {
      this.handle(peer, message, now);
    } catch (error) {
      // Schema bytes inside the envelope that do not decode: the client is broken or hostile.
      if (error instanceof RangeError || error instanceof TypeError)
        return this.drop(peer, CloseCode.protocol, error.message.slice(0, 120));
      throw error;
    }
  }

  private handle(peer: Peer<State, Input>, message: Envelope, now: number): void {
    const game = this.game;
    switch (message.kind) {
      case 'hello': {
        if (peer.player) return this.drop(peer, CloseCode.protocol, 'hello twice');
        if (message.version !== ENVELOPE_VERSION || message.schema !== game.schema.hash)
          return this.drop(peer, CloseCode.mismatch, 'protocol or schema differs; update the client');
        if (this.players.length + this.joins.length >= this.maxPlayers)
          return this.drop(peer, CloseCode.full, 'server full');
        peer.player = this.nextPlayer++;
        peer.playing = true;
        this.joins.push(peer.player);
        peer.connection.send(
          encodeEnvelope({
            kind: 'welcome',
            player: peer.player,
            tickRate: game.tickRate,
            tick: this.ticks,
            snapshotEvery: this.snapshotEvery,
          }),
          'reliable',
        );
        return;
      }
      case 'ping': {
        const fraction = Math.min(Math.max((now - this.lastTickAt) / game.tickMs, 0), 0.999);
        peer.connection.send(
          encodeEnvelope({ kind: 'pong', time: message.time, tick: this.ticks, fraction }),
          'unreliable',
        );
        return;
      }
      case 'inputs': {
        if (message.ack <= this.ticks && message.ack > peer.ack) peer.ack = message.ack;
        message.inputs.forEach((bytes, i) => {
          const tick = message.first + i;
          if (tick <= this.ticks) {
            if (tick > peer.newest) this.stats.lateInputs++;
            return;
          }
          if (tick > this.ticks + this.ahead || peer.inputs.has(tick)) {
            if (!peer.inputs.has(tick)) this.stats.rejectedInputs++;
            return;
          }
          const input = game.schema.decode(game.inputType, bytes) as Input;
          if (this.options.validateInput && !this.options.validateInput(input, peer.player, this.current)) {
            this.stats.rejectedInputs++;
            return;
          }
          peer.inputs.set(tick, input);
          if (tick > peer.newest) peer.newest = tick;
          this.stats.inputs++;
        });
        return;
      }
      case 'message': {
        const type = game.schema.names[message.type];
        if (type === undefined) return this.drop(peer, CloseCode.protocol, 'unknown message type');
        const value = game.schema.decode(type, message.data);
        this.options.onmessage?.(peer.player, type, value);
        return;
      }
      default:
        return this.drop(peer, CloseCode.protocol, `unexpected ${message.kind}`);
    }
  }

  /**
   * Runs one tick: joins and leaves, then the game's step with each player's input for this tick (its last input
   * when this one has not arrived), then snapshots.
   * @throws MargoError `disposed` once the server is closed.
   */
  step(): void {
    if (this.closed) throw fault('disposed', 'GameServer is closed; create a new GameServer');
    const game = this.game,
      tick = this.ticks + 1,
      now = this.now(),
      state = this.current;
    for (const peer of [...this.peers])
      if (now - peer.heard > this.timeout) this.drop(peer, CloseCode.timeout, 'no messages');
    for (const player of this.leaves.splice(0)) game.leave(state, player);
    for (const player of this.joins.splice(0)) game.join(state, player);
    const inputs = new Map<number, Input>();
    for (const peer of this.peers) {
      if (!peer.playing) continue;
      const input = peer.inputs.get(tick);
      if (input !== undefined) {
        peer.inputs.delete(tick);
        peer.last = input;
      } else if (peer.last !== undefined) {
        peer.missed++;
        this.stats.missedInputs++;
      }
      if (peer.last !== undefined) inputs.set(peer.player, peer.last);
      for (const t of peer.inputs.keys()) if (t <= tick) peer.inputs.delete(t);
    }
    game.step(state, inputs, tick, 1 / game.tickRate);
    // Clients simulate from decoded snapshots, so the server simulates from exactly those values too.
    const bytes = game.schema.encode(game.stateType, state),
      settled = game.schema.decode(game.stateType, bytes) as State;
    this.current = game.schema.decode(game.stateType, bytes) as State;
    this.ticks = tick;
    this.lastTickAt = now;
    this.stats.ticks++;
    if (tick % this.snapshotEvery === 0) this.snapshot(tick, settled, bytes);
  }

  private snapshot(tick: number, state: State, full: Uint8Array): void {
    const game = this.game,
      view = this.options.view;
    for (const peer of this.peers) {
      if (!peer.playing) continue;
      const seen = view ? (game.schema.clone(game.stateType, view(state, peer.player)) as State) : state;
      const baseline = peer.ack > 0 && peer.ack > tick - this.keep ? peer.sent.get(peer.ack) : undefined;
      const data =
        baseline === undefined
          ? view
            ? game.schema.encode(game.stateType, seen)
            : full
          : game.schema.encodeDelta(game.stateType, seen, baseline);
      peer.sent.set(tick, seen);
      peer.sent.delete(tick - this.keep);
      const bytes = encodeEnvelope({
        kind: 'snapshot',
        tick,
        baseline: baseline === undefined ? 0 : peer.ack,
        input: peer.newest,
        missed: peer.missed,
        data,
      });
      this.stats.snapshots++;
      if (baseline !== undefined) this.stats.deltaSnapshots++;
      this.stats.snapshotBytes += bytes.length;
      peer.connection.send(bytes, 'unreliable');
    }
  }

  /**
   * Sends game message `value` of schema struct `type` to player `player` (or to every player when `player` is
   * omitted), reliably.
   * @throws TypeError or RangeError when `value` does not fit `type`.
   */
  send(type: string, value: unknown, player?: number): void {
    const index = this.game.schema.names.indexOf(type);
    if (index < 0)
      throw new TypeError(`Schema has no type '${type}'; send one of ${this.game.schema.names.join(', ')}`);
    const bytes = encodeEnvelope({
      kind: 'message',
      type: index,
      data: this.game.schema.encode(type, value),
    });
    for (const peer of this.peers)
      if (peer.playing && (player === undefined || peer.player === player)) peer.connection.send(bytes, 'reliable');
  }

  /** Closes player `player`'s connection with `CloseCode.removed`; it leaves at the next tick. */
  kick(player: number, reason = 'removed'): void {
    for (const peer of this.peers) if (peer.player === player) this.drop(peer, CloseCode.removed, reason);
  }

  /**
   * Runs ticks in real time until `signal` aborts or the server closes. Each tick is scheduled from a fixed start
   * time, so the rate does not drift with timer error; after a stall of more than 5 ticks it skips ahead rather
   * than running a burst.
   */
  async run({ signal }: { signal?: AbortSignal } = {}): Promise<void> {
    const ms = this.game.tickMs;
    let next = this.now() + ms;
    while (!this.closed && !signal?.aborted) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.max(0, next - this.now()));
        function done() {
          signal?.removeEventListener('abort', done);
          clearTimeout(timer);
          resolve();
        }
        signal?.addEventListener('abort', done, { once: true });
      });
      if (this.closed || signal?.aborted) return;
      const now = this.now();
      if (now - next > 5 * ms) next = now;
      while (next <= now && !this.closed) {
        this.step();
        next += ms;
      }
    }
  }

  /** Closes every connection with `CloseCode.removed` and stops {@link GameServer.run}. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const peer of [...this.peers]) {
      this.peers.delete(peer);
      peer.connection.close(CloseCode.removed, 'server closed');
    }
  }
  /** Same as {@link GameServer.close}, for `using`. */
  [Symbol.dispose](): void {
    this.close();
  }
}
