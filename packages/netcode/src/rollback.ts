// Rollback netcode for deterministic games (peer to peer, no server): every peer runs the whole game. A peer's own
// input is used `inputDelay` frames after it is sampled, which hides that much latency; inputs of other players that
// have not arrived are predicted (the player's last known input). When a real input arrives that differs from its
// prediction, the peer loads the state saved before that frame and simulates again up to the present. Checksums of
// confirmed frames (every input known) are exchanged to detect a desync.
import type { Game } from './game.js';
import { checksumOf, ROLLBACK_INPUTS as INPUTS } from './protocol.js';
import { Reader, Writer } from './schema.js';
import { CloseCode, fault, type Connection } from './transport.js';

/** Options of {@link RollbackSession}. */
export interface RollbackOptions<Input> {
  /** Ids of every player in the session (the same list on every peer, in any order). */
  players: readonly number[];
  /** This peer's player id, one of `players`. */
  local: number;
  /** A connection to each other player, by player id. */
  peers: ReadonlyMap<number, Connection>;
  /** This peer's input for frame `frame` (sampled `inputDelay` frames ahead of it). */
  input(frame: number): Input;
  /** Frames between sampling an input and using it, 0 to 30 (default 2). The same on every peer. */
  inputDelay?: number;
  /** Most frames simulated past the newest confirmed frame before the session waits, 1 to 60 (default 8). */
  maxRollback?: number;
  /** Exchange a checksum every this many confirmed frames, 0 for never (default 30). */
  checksumEvery?: number;
  /** How many of the newest inputs each message repeats, 1 to 32 (default 8); every 8th goes back to the oldest not acknowledged. */
  redundancy?: number;
  /** The clock in milliseconds for {@link RollbackSession.update} (default `performance.now`). */
  now?: () => number;
  /** Called once per confirmed frame with the FNV-1a checksum of its state bytes (replays, logs, tests). */
  onconfirm?(frame: number, checksum: number): void;
  /** Called when another peer's checksum for a frame differs from this peer's: the simulations diverged. */
  ondesync?(event: RollbackDesync): void;
}

/** A detected desync. */
export interface RollbackDesync {
  /** The confirmed frame whose states differ. */
  frame: number;
  /** The other player. */
  player: number;
  /** This peer's checksum. */
  local: number;
  /** The other peer's checksum. */
  remote: number;
}

/** Counts since the session started. */
export interface RollbackStats {
  /** Frames simulated forward. */
  frames: number;
  /** Rollbacks: a remote input differed from its prediction. */
  rollbacks: number;
  /** Frames simulated again during rollbacks. */
  resimulated: number;
  /** Most frames resimulated by one rollback. */
  deepest: number;
  /** Frames not run because the session was `maxRollback` frames past the confirmed frame. */
  stalls: number;
  /** Frames waited to let a slower peer catch up (time sync). */
  waits: number;
  /** Checksums compared with another peer's. */
  checked: number;
  /** Desyncs detected. */
  desyncs: number;
}

const CHECKSUM = 33,
  MAX_INPUTS = 32,
  // Every this many messages to a peer go back to the oldest input it has not acknowledged, however old.
  RESEND_EVERY = 8;
interface Remote<Input> {
  connection: Connection;
  inputs: Map<number, Input>;
  confirmed: number;
  ack: number;
  frame: number;
  advantage: number;
  checksums: Map<number, number>;
  sent: number;
}

/**
 * A rollback session: one peer of a deterministic game. Call {@link RollbackSession.update} every frame (or
 * {@link RollbackSession.advance} from your own fixed-step loop) and draw {@link RollbackSession.state}.
 *
 * @example
 * ```ts
 * const session = new RollbackSession(game, {
 *   players: [1, 2], local: 1, peers: new Map([[2, connectionToPlayer2]]),
 *   input: () => ({ x: keys.right - keys.left, y: 0 }),
 * });
 * engine.onFrame(() => { session.update(); draw(session.state); });
 * ```
 */
export class RollbackSession<State, Input> {
  /** Counts since the session started. */
  readonly stats: RollbackStats = {
    frames: 0,
    rollbacks: 0,
    resimulated: 0,
    deepest: 0,
    stalls: 0,
    waits: 0,
    checked: 0,
    desyncs: 0,
  };
  private current: State;
  private frameNumber = 0;
  private readonly players: number[];
  private readonly remotes = new Map<number, Remote<Input>>();
  private readonly own = new Map<number, Input>();
  private readonly saved = new Map<number, Uint8Array>();
  private readonly used = new Map<number, Map<number, Input | undefined>>();
  private readonly checksums = new Map<number, number>();
  private rollbackTo = Number.POSITIVE_INFINITY;
  private confirmedFrame = 0;
  private waiting = 0;
  private syncedAt = 0;
  private clock = Number.NaN;
  private closed = false;
  private readonly delay: number;
  private readonly depth: number;
  private readonly every: number;
  private readonly redundancy: number;
  private readonly now: () => number;

  /**
   * @throws TypeError for a missing `input` or a `local` not in `players`; RangeError for an option out of range.
   */
  constructor(
    readonly game: Game<State, Input>,
    private readonly options: RollbackOptions<Input>,
  ) {
    if (typeof options?.input !== 'function')
      throw new TypeError('RollbackSession needs an input(frame) function; pass { input: (frame) => yourInput }');
    const players = [...new Set(options.players)].sort((a, b) => a - b);
    if (!players.includes(options.local))
      throw new TypeError(`RollbackSession local player ${options.local} is not in players; add it to players`);
    const range = (what: string, v: number, min: number, max: number) => {
      if (!Number.isInteger(v) || v < min || v > max)
        throw new RangeError(`RollbackSession ${what} is ${v}; pass an integer from ${min} to ${max}`);
      return v;
    };
    this.delay = range('inputDelay', options.inputDelay ?? 2, 0, 30);
    this.depth = range('maxRollback', options.maxRollback ?? 8, 1, 60);
    this.every = range('checksumEvery', options.checksumEvery ?? 30, 0, 1 << 20);
    this.redundancy = range('redundancy', options.redundancy ?? 8, 1, MAX_INPUTS);
    this.now = options.now ?? (() => performance.now());
    this.players = players;
    for (const player of players) {
      if (player === options.local) continue;
      const connection = options.peers.get(player);
      if (!connection) throw new TypeError(`RollbackSession has no connection to player ${player}; add it to peers`);
      const remote: Remote<Input> = {
        connection,
        inputs: new Map(),
        confirmed: this.delay,
        ack: this.delay,
        frame: 0,
        advantage: 0,
        checksums: new Map(),
        sent: 0,
      };
      this.remotes.set(player, remote);
      connection.onmessage = (data) => this.receive(player, remote, data);
    }
    const state = game.initial();
    for (const player of players) game.join(state, player);
    const bytes = game.schema.encode(game.stateType, state);
    this.current = game.schema.decode(game.stateType, bytes) as State;
    this.saved.set(0, bytes);
  }

  /** The newest frame simulated (0 before the first). */
  get frame(): number {
    return this.frameNumber;
  }
  /** The state after {@link RollbackSession.frame}, including predictions of inputs not yet arrived. */
  get state(): State {
    return this.current;
  }
  /** The newest frame for which every player's input is known: its state is final. */
  get confirmed(): number {
    return this.confirmedFrame;
  }

  private send(remote: Remote<Input>, bytes: Uint8Array, reliable: boolean): void {
    remote.connection.send(bytes, reliable ? 'reliable' : 'unreliable');
  }

  private receive(player: number, remote: Remote<Input>, data: Uint8Array): void {
    if (this.closed) return;
    try {
      const r = new Reader(data, 'Rollback message', 'send what RollbackSession sends');
      const kind = r.u8();
      if (kind === INPUTS) {
        const frame = r.varint(),
          advantage = r.varint() - 2 ** 16,
          ack = r.varint(),
          first = r.varint(),
          n = r.count(MAX_INPUTS),
          list: Uint8Array[] = [];
        for (let i = 0; i < n; i++) {
          const length = r.count(1024);
          r.need(length);
          list.push(data.subarray(r.at, (r.at += length)));
        }
        r.end();
        if (frame > remote.frame) {
          remote.frame = frame;
          remote.advantage = advantage;
        }
        remote.ack = Math.max(remote.ack, ack);
        list.forEach((bytes, i) => this.arrive(player, remote, first + i, bytes));
      } else if (kind === CHECKSUM) {
        const frame = r.varint(),
          hash = r.u32();
        r.end();
        // Only frames this peer can still compare are kept: a peer cannot confirm a frame past the inputs this one
        // sent, and older ones were pruned here already, so anything else would only grow the map.
        if (!this.every || frame % this.every || frame < this.confirmedFrame - 32 * this.every) return;
        if (frame > this.frameNumber + this.depth + this.delay + MAX_INPUTS) return;
        remote.checksums.set(frame, hash);
        this.compare(player, remote, frame);
      } else throw r.fail(`has unknown kind ${kind}`);
    } catch (error) {
      if (!(error instanceof RangeError || error instanceof TypeError)) throw error;
      remote.connection.close(CloseCode.protocol, error.message.slice(0, 120));
    }
  }

  private arrive(player: number, remote: Remote<Input>, frame: number, bytes: Uint8Array): void {
    if (frame <= this.delay || remote.inputs.has(frame) || frame <= remote.confirmed) return;
    if (frame > this.frameNumber + this.depth + this.delay + MAX_INPUTS) return;
    const game = this.game,
      input = game.schema.decode(game.inputType, bytes) as Input;
    remote.inputs.set(frame, input);
    while (remote.inputs.has(remote.confirmed + 1)) remote.confirmed++;
    const used = this.used.get(frame);
    if (used && !this.same(used.get(player), input)) this.rollbackTo = Math.min(this.rollbackTo, frame);
  }

  private same(a: Input | undefined, b: Input | undefined): boolean {
    if (a === undefined || b === undefined) return a === b;
    return this.game.schema.equals(this.game.inputType, a, b);
  }

  /** Player `player`'s input for `frame`: the real one, or the newest real one before it (a prediction). */
  private inputOf(player: number, frame: number): Input | undefined {
    if (frame <= this.delay) return undefined;
    if (player === this.options.local) return this.own.get(frame);
    const remote = this.remotes.get(player) as Remote<Input>;
    for (let f = frame; f > this.delay; f--) {
      const input = remote.inputs.get(f);
      if (input !== undefined) return input;
      if (f < frame - 2 * (this.depth + MAX_INPUTS)) break;
    }
    return undefined;
  }

  private simulate(frame: number): void {
    const game = this.game,
      inputs = new Map<number, Input>(),
      used = new Map<number, Input | undefined>();
    for (const player of this.players) {
      const input = this.inputOf(player, frame);
      used.set(player, input);
      if (input !== undefined) inputs.set(player, input);
    }
    game.step(this.current, inputs, frame, 1 / game.tickRate);
    const bytes = game.schema.encode(game.stateType, this.current);
    this.current = game.schema.decode(game.stateType, bytes) as State;
    this.saved.set(frame, bytes);
    this.used.set(frame, used);
    const old = frame - this.depth - 2;
    this.saved.delete(old);
    this.used.delete(old);
  }

  private compare(player: number, remote: Remote<Input>, frame: number): void {
    const mine = this.checksums.get(frame),
      theirs = remote.checksums.get(frame);
    if (mine === undefined || theirs === undefined) return;
    remote.checksums.delete(frame);
    this.stats.checked++;
    if (mine !== theirs) {
      this.stats.desyncs++;
      this.options.ondesync?.({ frame, player, local: mine, remote: theirs });
    }
  }

  /**
   * Runs one frame if it may: samples this peer's input for `frame + inputDelay` and sends it, rolls back and
   * resimulates if a remote input contradicted a prediction, then simulates the next frame. Returns false (and runs
   * nothing) when the session is `maxRollback` frames past the confirmed frame, waiting for a remote input.
   * @throws MargoError `disposed` once closed.
   */
  advance(): boolean {
    if (this.closed) throw fault('disposed', 'RollbackSession is closed; create a new RollbackSession');
    const next = this.frameNumber + 1;
    let confirmed = next + this.delay;
    for (const remote of this.remotes.values()) confirmed = Math.min(confirmed, remote.confirmed);
    if (next - confirmed > this.depth) {
      this.stats.stalls++;
      this.sendInputs();
      return false;
    }
    // Own input for the frame `inputDelay` ahead.
    const sampled = next + this.delay,
      game = this.game;
    if (sampled > this.delay && !this.own.has(sampled)) {
      const raw = this.options.input(sampled);
      this.own.set(sampled, game.schema.decode(game.inputType, game.schema.encode(game.inputType, raw)) as Input);
      this.own.delete(sampled - 2 * (this.depth + MAX_INPUTS));
    }
    this.sendInputs();
    // Roll back to the earliest contradicted frame and simulate up to the present again.
    if (this.rollbackTo <= this.frameNumber) {
      const from = this.rollbackTo,
        base = this.saved.get(from - 1);
      if (!base) throw fault('failed', `RollbackSession lost the state before frame ${from}; raise maxRollback`);
      this.current = game.schema.decode(game.stateType, base) as State;
      for (let f = from; f <= this.frameNumber; f++) this.simulate(f);
      const depth = this.frameNumber - from + 1;
      this.stats.rollbacks++;
      this.stats.resimulated += depth;
      this.stats.deepest = Math.max(this.stats.deepest, depth);
    }
    this.rollbackTo = Number.POSITIVE_INFINITY;
    this.simulate(next);
    this.frameNumber = next;
    this.stats.frames++;
    // Frames whose every input is now known are final: report them and exchange checksums.
    const final = Math.min(confirmed, this.frameNumber);
    for (let f = this.confirmedFrame + 1; f <= final; f++) {
      const bytes = this.saved.get(f);
      if (!bytes) continue;
      const sum = checksumOf(bytes);
      this.options.onconfirm?.(f, sum);
      if (this.every && f % this.every === 0) {
        this.checksums.set(f, sum);
        const w = new Writer(12);
        w.u8(CHECKSUM);
        w.varint(f);
        w.u32(sum);
        const message = w.done();
        for (const [player, remote] of this.remotes) {
          this.send(remote, message, true);
          this.compare(player, remote, f);
        }
        for (const key of this.checksums.keys()) if (key < f - 32 * this.every) this.checksums.delete(key);
        for (const remote of this.remotes.values())
          for (const key of remote.checksums.keys()) if (key < f - 32 * this.every) remote.checksums.delete(key);
      }
    }
    this.confirmedFrame = Math.max(this.confirmedFrame, final);
    return true;
  }

  private sendInputs(): void {
    const game = this.game,
      last = this.frameNumber + 1 + this.delay;
    for (const remote of this.remotes.values()) {
      // After an outage the gap can be older than the newest inputs: without going back for it both peers stall for good.
      const newest = ++remote.sent % RESEND_EVERY ? last - this.redundancy + 1 : 0,
        first = Math.max(remote.ack + 1, newest, this.delay + 1);
      const w = new Writer(64);
      w.u8(INPUTS);
      w.varint(this.frameNumber);
      // Frames this peer is ahead of what it has from that player, offset so it stays a varint.
      w.varint(Math.min(Math.max(this.frameNumber - remote.frame, -(2 ** 15)), 2 ** 15) + 2 ** 16);
      w.varint(remote.confirmed);
      w.varint(first);
      const inputs: Uint8Array[] = [];
      for (let f = first; f <= last && inputs.length < MAX_INPUTS; f++) {
        const input = this.own.get(f);
        if (input === undefined) break;
        inputs.push(game.schema.encode(game.inputType, input));
      }
      w.varint(inputs.length);
      for (const bytes of inputs) {
        w.varint(bytes.length);
        w.raw(bytes);
      }
      this.send(remote, w.done(), false);
    }
  }

  /**
   * Runs every frame due by the clock (at the game's tick rate), at most 8 per call. When this peer runs ahead of the
   * others (each side's frame minus the frame it last heard from the other, compared), it waits a frame now and then
   * so peers stay level instead of one always rolling back. Returns the number of frames run.
   */
  update(): number {
    if (this.closed) return 0;
    const now = this.now(),
      ms = this.game.tickMs;
    if (Number.isNaN(this.clock)) this.clock = now - ms;
    let ran = 0;
    while (now - this.clock >= ms && ran < 8) {
      this.clock += ms;
      if (this.waiting > 0) {
        this.waiting--;
        this.stats.waits++;
        continue;
      }
      if (this.advance()) ran++;
    }
    if (now - this.clock > 8 * ms) this.clock = now - ms;
    // Time sync: half the difference of the two sides' advantages is how far ahead this peer runs.
    if (this.frameNumber - this.syncedAt >= 30) {
      let ahead = 0;
      for (const remote of this.remotes.values())
        ahead = Math.max(ahead, Math.floor((this.frameNumber - remote.frame - remote.advantage) / 2));
      if (ahead >= 2) {
        this.waiting = Math.min(ahead, 4);
        this.syncedAt = this.frameNumber;
      }
    }
    return ran;
  }

  /** Closes every peer connection. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const remote of this.remotes.values()) remote.connection.close(CloseCode.normal, 'left');
  }
  /** Same as {@link RollbackSession.close}, for `using`. */
  [Symbol.dispose](): void {
    this.close();
  }
}
