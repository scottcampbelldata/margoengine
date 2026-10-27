// The client: predicts its own player by running the game's step ahead of the server with its own inputs,
// reconciles when a snapshot disagrees (back to the server's state, then replays the inputs the server has not
// seen), and draws everything else interpolated between snapshots a little in the past.
import { ClockSync } from './clock.js';
import type { Game } from './game.js';
import { decodeEnvelope, encodeEnvelope, MAX_INPUTS_PER_MESSAGE, ENVELOPE_VERSION } from './protocol.js';
import { CloseCode, fault, type Connection } from './transport.js';

/** Options of {@link GameClient.join}. */
export interface GameClientOptions<Input> {
  /** This player's input for tick `tick`, called once per predicted tick. */
  input(tick: number): Input;
  /** The clock in milliseconds (default `performance.now`); a test passes the loopback network's time. */
  now?: () => number;
  /** Extra ticks of input lead over the measured delay, to absorb jitter (default 1). */
  inputBuffer?: number;
  /** Ticks the interpolated view stays behind the newest snapshot (default 2 snapshot intervals). */
  interpolationDelay?: number;
  /** How many of the newest unconfirmed inputs each input message repeats, 1 to 32 (default 8). */
  redundancy?: number;
  /** Ticks of inputs, predictions and snapshots kept (default 128). */
  history?: number;
  /** Milliseconds between clock pings (default 500). */
  pingInterval?: number;
  /** Called with each game message the server sends. */
  onmessage?(type: string, value: unknown): void;
  /** Called once when the connection closes. */
  onclose?(code: number, reason: string): void;
  /** Aborts {@link GameClient.join} (it rejects with the signal's reason and closes the connection). */
  signal?: AbortSignal;
}

/** Counts and measures since the client joined. */
export interface GameClientStats {
  /** Snapshots applied. */
  snapshots: number;
  /** Snapshots that matched the prediction for their tick. */
  confirmed: number;
  /** Snapshots that did not: the client went back to the server's state and replayed its inputs. */
  mispredictions: number;
  /** Ticks replayed after mispredictions. */
  replayed: number;
  /** Snapshots ignored: older than one already applied, or against a baseline no longer held. */
  ignored: number;
  /** Round trip in milliseconds (smallest of the recent pings). */
  rtt: number;
  /** Ticks the server ran without this client's input (from the server). */
  missed: number;
}

/**
 * A client of a {@link GameServer}. `GameClient.join` resolves once the server welcomed it, the clock is synced and
 * the first snapshot arrived; then call {@link GameClient.update} every frame and draw `predicted` (your player) and
 * `interpolated()` (everyone else).
 *
 * @example
 * ```ts
 * const client = await GameClient.join(game, connection, { input: () => ({ x: keys.right - keys.left, jump: keys.space }) });
 * engine.onFrame(() => {
 *   client.update();
 *   drawMe(client.predicted.boxes.get(client.player));
 *   for (const [id, box] of client.interpolated().boxes) if (id !== client.player) drawOther(box);
 * });
 * ```
 */
export class GameClient<State, Input> {
  /** Counts and measures since joining. */
  readonly stats: GameClientStats = {
    snapshots: 0,
    confirmed: 0,
    mispredictions: 0,
    replayed: 0,
    ignored: 0,
    rtt: 0,
    missed: 0,
  };
  /** This client's player id (0 until welcomed). */
  player = 0;
  private readonly clock: ClockSync;
  private readonly now: () => number;
  private readonly keep: number;
  private readonly redundancy: number;
  private readonly buffer: number;
  private readonly pingEvery: number;
  private delay = 0;
  private snapshotEvery = 1;
  private predictedState: State | undefined;
  private predictedTick = 0;
  private clockTick = Number.NaN;
  private lastUpdate = Number.NaN;
  private lastPing = Number.NEGATIVE_INFINITY;
  private renderTick = Number.NaN;
  private lastRender = Number.NaN;
  private extra = 0;
  private extraSince = 0;
  private serverMissed = 0;
  private inputAck = 0;
  private newest = 0;
  private closed = false;
  private readonly inputs = new Map<number, Input>();
  private readonly predictions = new Map<number, Uint8Array>();
  private readonly snapshots = new Map<number, State>();
  private snapshotTicks: number[] = [];
  private readonly pings = new Map<number, number>();
  private ready: (() => void) | null = null;

  private constructor(
    readonly game: Game<State, Input>,
    readonly connection: Connection,
    private readonly options: GameClientOptions<Input>,
  ) {
    if (typeof options?.input !== 'function')
      throw new TypeError('GameClient needs an input(tick) function; pass { input: (tick) => yourInput }');
    this.now = options.now ?? (() => performance.now());
    this.keep = options.history ?? 128;
    this.redundancy = options.redundancy ?? 8;
    this.buffer = options.inputBuffer ?? 1;
    this.pingEvery = options.pingInterval ?? 500;
    if (!Number.isInteger(this.keep) || this.keep < 8 || this.keep > 4096)
      throw new RangeError(`GameClient history is ${this.keep}; pass an integer from 8 to 4096 ticks`);
    if (!Number.isInteger(this.redundancy) || this.redundancy < 1 || this.redundancy > MAX_INPUTS_PER_MESSAGE)
      throw new RangeError(`GameClient redundancy is ${this.redundancy}; pass an integer from 1 to 32`);
    if (!(this.buffer >= 0) || !(this.pingEvery > 0))
      throw new RangeError('GameClient needs inputBuffer >= 0 and pingInterval > 0; fix the options');
    this.clock = new ClockSync(game.tickMs);
  }

  /**
   * Joins the server on `connection`: sends hello, then resolves once the server welcomed this client, the clock is
   * synced and the first snapshot arrived.
   * @throws MargoError `failed` (as a rejection) when the connection closes first, with the server's reason; the
   * signal's reason when `options.signal` aborts.
   */
  static join<State, Input>(
    game: Game<State, Input>,
    connection: Connection,
    options: GameClientOptions<Input>,
  ): Promise<GameClient<State, Input>> {
    const client = new GameClient(game, connection, options),
      signal = options.signal;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        connection.close(CloseCode.normal, 'aborted');
        return reject(signal.reason);
      }
      const abort = () => {
        client.ready = null;
        client.close();
        reject(signal?.reason);
      };
      signal?.addEventListener('abort', abort, { once: true });
      client.ready = () => {
        signal?.removeEventListener('abort', abort);
        resolve(client);
      };
      connection.onmessage = (data) => client.receive(data);
      connection.onclose = (code, reason) => {
        client.closed = true;
        signal?.removeEventListener('abort', abort);
        if (client.ready)
          reject(fault('failed', `Game connection closed before joining (${code} ${reason}); check the server`));
        client.ready = null;
        options.onclose?.(code, reason);
      };
      connection.send(encodeEnvelope({ kind: 'hello', version: ENVELOPE_VERSION, schema: game.schema.hash }));
    });
  }

  /** The predicted tick: the newest tick this client simulated. */
  get tick(): number {
    return this.predictedTick;
  }
  /** The predicted state at {@link GameClient.tick}: draw your own player from this. Replaced as ticks run. */
  get predicted(): State {
    return this.predictedState as State;
  }
  /** The newest snapshot's tick. */
  get serverTick(): number {
    return this.newest;
  }
  /** The newest snapshot: the server's state at {@link GameClient.serverTick}. */
  get authoritative(): State {
    return this.snapshots.get(this.newest) as State;
  }
  /** Whether the connection is open. */
  get open(): boolean {
    return !this.closed;
  }
  /**
   * The fractional server tick that the last {@link GameClient.interpolated} call showed (NaN before the first): send
   * it with a shot so the server can check the shot against that moment (`LagCompensation`).
   */
  get viewTick(): number {
    return this.renderTick;
  }

  private ping(now: number): void {
    this.lastPing = now;
    this.pings.set(now, now);
    if (this.pings.size > 16) this.pings.delete(this.pings.keys().next().value as number);
    this.connection.send(encodeEnvelope({ kind: 'ping', time: now }), 'unreliable');
  }

  private receive(data: Uint8Array): void {
    if (this.closed) return;
    let message;
    try {
      message = decodeEnvelope(data);
    } catch (error) {
      this.connection.close(CloseCode.protocol, (error as Error).message.slice(0, 120));
      return;
    }
    const now = this.now(),
      game = this.game;
    switch (message.kind) {
      case 'welcome':
        if (this.player) break;
        if (message.tickRate !== game.tickRate) {
          this.connection.close(CloseCode.mismatch, 'tick rate differs');
          return;
        }
        this.player = message.player;
        this.snapshotEvery = Math.max(1, message.snapshotEvery);
        this.delay = this.options.interpolationDelay ?? 2 * this.snapshotEvery;
        this.ping(now);
        break;
      case 'pong': {
        const sent = this.pings.get(message.time);
        if (sent === undefined) break;
        this.pings.delete(message.time);
        this.clock.add(sent, now, message.tick, message.fraction);
        this.stats.rtt = this.clock.rtt;
        break;
      }
      case 'snapshot':
        this.snapshot(message.tick, message.baseline, message.input, message.missed, message.data, now);
        break;
      case 'message': {
        const type = game.schema.names[message.type];
        if (type === undefined) {
          this.connection.close(CloseCode.protocol, 'unknown message type');
          return;
        }
        this.options.onmessage?.(type, game.schema.decode(type, message.data));
        break;
      }
      default:
        this.connection.close(CloseCode.protocol, `unexpected ${message.kind}`);
        return;
    }
    if (this.ready && this.player && this.clock.synced && this.predictedState !== undefined) {
      const ready = this.ready;
      this.ready = null;
      this.lastUpdate = now;
      this.clockTick = Math.max(this.target(now), this.predictedTick);
      // The server runs the ticks up to the clock's target before any input of ours can reach it: they run with no
      // input of this player there, so predict them that way too.
      for (const due = Math.floor(this.clockTick); this.predictedTick < due; )
        this.simulate(++this.predictedTick, undefined);
      ready();
    }
  }

  private snapshot(tick: number, baseline: number, input: number, missed: number, data: Uint8Array, now: number) {
    const game = this.game;
    if (tick <= this.newest) {
      this.stats.ignored++;
      return;
    }
    const base = baseline ? this.snapshots.get(baseline) : undefined;
    if (baseline && base === undefined) {
      this.stats.ignored++;
      return;
    }
    const state = (
      base === undefined
        ? game.schema.decode(game.stateType, data)
        : game.schema.decodeDelta(game.stateType, data, base)
    ) as State;
    this.newest = tick;
    this.snapshots.set(tick, state);
    this.snapshotTicks.push(tick);
    while (this.snapshotTicks.length && this.snapshotTicks[0] <= tick - this.keep)
      this.snapshots.delete(this.snapshotTicks.shift() as number);
    this.inputAck = Math.max(this.inputAck, input);
    this.stats.snapshots++;
    if (missed > this.serverMissed) {
      // The server ran out of this client's inputs: lead by one more tick for a while.
      if (this.serverMissed || this.extra) this.extra = Math.min(this.extra + 1, 10);
      this.extraSince = now;
    } else if (this.extra && now - this.extraSince > 10_000) {
      this.extra--;
      this.extraSince = now;
    }
    this.serverMissed = missed;
    this.stats.missed = missed;
    this.reconcile(tick, state);
  }

  private reconcile(tick: number, state: State): void {
    const game = this.game,
      bytes = game.schema.encode(game.stateType, state);
    if (this.predictedState === undefined || tick > this.predictedTick) {
      this.predictedState = game.schema.decode(game.stateType, bytes) as State;
      this.predictedTick = tick;
      this.predictions.set(tick, bytes);
      return;
    }
    const predicted = this.predictions.get(tick);
    if (predicted && same(predicted, bytes)) {
      this.stats.confirmed++;
      return;
    }
    this.stats.mispredictions++;
    this.predictions.set(tick, bytes);
    this.predictedState = game.schema.decode(game.stateType, bytes) as State;
    for (let t = tick + 1; t <= this.predictedTick; t++) {
      this.simulate(t, this.inputs.get(t));
      this.stats.replayed++;
    }
  }

  private simulate(tick: number, input: Input | undefined): void {
    const game = this.game,
      inputs = new Map<number, Input>();
    if (input !== undefined) inputs.set(this.player, input);
    game.step(this.predictedState as State, inputs, tick, 1 / game.tickRate);
    const bytes = game.schema.encode(game.stateType, this.predictedState);
    this.predictedState = game.schema.decode(game.stateType, bytes) as State;
    this.predictions.set(tick, bytes);
    this.predictions.delete(tick - this.keep);
  }

  /** The tick the client should be predicting now: the server's tick plus the one-way delay plus a jitter margin. */
  private target(now: number): number {
    const ms = this.game.tickMs;
    return this.clock.serverTick(now) + (this.clock.rtt / 2 + 2 * this.clock.jitter) / ms + this.buffer + this.extra;
  }

  /**
   * Advances the client to the clock's time: runs every predicted tick that is due (sampling `input` for each),
   * sends the newest inputs and pings. Call it every frame.
   * @throws MargoError `state` before `join` resolved.
   */
  update(): void {
    if (this.closed) return;
    if (Number.isNaN(this.clockTick)) throw fault('state', 'GameClient is not joined; await GameClient.join first');
    const now = this.now(),
      elapsed = Math.max(0, now - this.lastUpdate) / this.game.tickMs,
      error = this.target(now) - this.clockTick;
    this.lastUpdate = now;
    // Small errors are absorbed by running up to 25% faster or slower; a large one (a stall) jumps.
    if (Math.abs(error) > 8) this.clockTick += error;
    else this.clockTick += elapsed * Math.min(1.25, Math.max(0.75, 1 + 0.05 * error));
    const due = Math.floor(this.clockTick);
    if (due - this.predictedTick > 4 * this.keep) this.predictedTick = due - this.keep;
    let ran = false;
    while (this.predictedTick < due) {
      const tick = this.predictedTick + 1,
        raw = this.options.input(tick),
        input = this.game.schema.decode(this.game.inputType, this.game.schema.encode(this.game.inputType, raw));
      this.inputs.set(tick, input as Input);
      this.inputs.delete(tick - 2 * this.keep);
      this.simulate(tick, input as Input);
      this.predictedTick = tick;
      ran = true;
    }
    if (ran) this.sendInputs();
    if (now - this.lastPing >= this.pingEvery) this.ping(now);
  }

  private sendInputs(): void {
    const game = this.game,
      last = this.predictedTick,
      inputs: Uint8Array[] = [];
    let first = Math.max(this.inputAck + 1, last - this.redundancy + 1, 1);
    while (first <= last && !this.inputs.has(first)) first++;
    for (let t = first; t <= last; t++) {
      const input = this.inputs.get(t);
      if (input === undefined) break;
      inputs.push(game.schema.encode(game.inputType, input));
    }
    if (!inputs.length) return;
    this.connection.send(encodeEnvelope({ kind: 'inputs', ack: this.newest, first, inputs }), 'unreliable');
  }

  /**
   * The state the server had `interpolationDelay` ticks before the newest snapshot should have arrived, blended
   * between the two snapshots around that time: draw other players and objects from this. Holds the newest snapshot
   * when the next is late (no extrapolation).
   */
  interpolated(): State {
    const ms = this.game.tickMs,
      now = this.now(),
      target = this.clock.serverTick(now) - (this.clock.rtt / 2 + 2 * this.clock.jitter) / ms - this.delay,
      ticks = this.snapshotTicks;
    // The view's clock runs smoothly: it follows the target by running up to 10% faster or slower, so a new clock
    // sample never makes the view jump back; only an error over 4 ticks (a stall) jumps.
    const error = target - this.renderTick;
    if (Number.isNaN(error) || Math.abs(error) > 4) this.renderTick = target;
    else this.renderTick += (Math.max(0, now - this.lastRender) / ms) * Math.min(1.1, Math.max(0.9, 1 + 0.1 * error));
    this.lastRender = now;
    const at = this.renderTick;
    if (!ticks.length) return this.predictedState as State;
    if (at >= ticks[ticks.length - 1]) return this.snapshots.get(ticks[ticks.length - 1]) as State;
    if (at <= ticks[0]) return this.snapshots.get(ticks[0]) as State;
    let i = ticks.length - 1;
    while (ticks[i - 1] > at) i--;
    const a = ticks[i - 1],
      b = ticks[i];
    return this.game.schema.interpolate(
      this.game.stateType,
      this.snapshots.get(a),
      this.snapshots.get(b),
      (at - a) / (b - a),
    ) as State;
  }

  /**
   * Sends game message `value` of schema struct `type` to the server, reliably.
   * @throws TypeError or RangeError when `value` does not fit `type`.
   */
  send(type: string, value: unknown): void {
    const index = this.game.schema.names.indexOf(type);
    if (index < 0)
      throw new TypeError(`Schema has no type '${type}'; send one of ${this.game.schema.names.join(', ')}`);
    this.connection.send(
      encodeEnvelope({ kind: 'message', type: index, data: this.game.schema.encode(type, value) }),
      'reliable',
    );
  }

  /** Leaves the game and closes the connection. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connection.close(CloseCode.normal, 'left');
  }
  /** Same as {@link GameClient.close}, for `using`. */
  [Symbol.dispose](): void {
    this.close();
  }
}

const same = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
