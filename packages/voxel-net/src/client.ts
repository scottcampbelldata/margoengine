// The voxel-net client (design: packages/voxel-net/DESIGN.md, "Movement", "Block edits", "Other players"): it fills a
// VoxelWorld from the server's chunk messages, predicts its own player with VoxelCharacter at fixed steps and replays
// them on a correction, shows its edits at once, and smooths other players with @margoengine/net's SnapshotBuffer.
// The transport is the caller's: a browser WebSocket (connectVoxelNet) or a Node one (the bots).
import type { MutableVec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import { createSnapshot, type Snapshot, SnapshotBuffer } from '@margoengine/net';
import { chunkKey, type VoxelWorld } from '@margoengine/voxel';
import { decodeBlockChanges, decodeChunk, EntityCodec } from '@margoengine/voxel/codec';
import { VoxelCharacter, type VoxelCharacterOptions } from '@margoengine/voxel/query';
import {
  blockTableHash,
  decodeServerMessage,
  encodeClientMessage,
  type InputRun,
  Keys,
  moveIntent,
  PLAYER_SCHEMA,
  type PlayerState,
  PROTOCOL_VERSION,
  MAX_STALE_CHUNKS,
  quantizePitch,
  quantizeYaw,
  STEP_SECONDS,
  type ServerMessage,
} from './protocol.js';

/** Where a {@link VoxelNetClient} sends its bytes: a WebSocket or anything with the same two calls. */
export interface VoxelNetTransport {
  /** Sends one binary message. */
  send(data: Uint8Array): void;
  /** Closes the connection. */
  close(): void;
  /**
   * True when messages may be lost or come out of order (WebTransport datagrams): the client then sends each input
   * with copies of the ones before (`inputCopies`) and reads player snapshots each on its own, dropping late ones.
   */
  readonly datagrams?: boolean;
}

/** Options of {@link VoxelNetClient}. */
export interface VoxelNetClientOptions {
  /** Display name, at most 32 UTF-8 bytes. Default ''. */
  name?: string;
  /**
   * Over a transport with `datagrams`, how many earlier inputs each input message carries again, so a datagram lost
   * on the way costs no steps (0 to 8, default 3). A WebSocket ignores it.
   */
  inputCopies?: number;
  /** View distance to ask for, in chunks; the server clamps it to its own limits. Default 6. */
  view?: number;
  /**
   * Chunks within this many chunks of the player (on every axis) are decoded into the world; farther ones are kept as
   * bytes until the player comes near. Default Infinity (decode all: a renderer needs them). Bots use 1.
   */
  decodeDistance?: number;
  /** Decode the players messages into {@link VoxelNetClient.players}. Default true; false only counts their bytes. */
  players?: boolean;
  /** How far behind the newest player snapshot others are drawn, seconds. Default 0.1. */
  interpolationDelay?: number;
  /**
   * With {@link connectVoxelNet}: milliseconds of nothing from the server, from the start of the connection on, before
   * the page gives up on it (see {@link SERVER_SILENT_CODE}); 0 never does. Default 15,000. Keep it well above the
   * server's `heartbeatInterval` (default 5,000). A background tab whose timers are throttled takes longer to notice,
   * never less. {@link VoxelNetClient} with your own transport, and `VoxelBot`, ignore it.
   */
  serverTimeout?: number;
  /**
   * With {@link connectVoxelNet} and `VoxelBot`: taking the player back after a dropped connection, in place, with its
   * position, world and id. `attempts` is how many tries (default 5, spread over about 20 s); aborting `signal` during a
   * gap ends the connection with {@link VoxelNetClient.onClose} 1000 `'aborted'`, and after it no drop is resumed. `false`
   * turns it off, so `onClose` comes at the first drop. Default `{ attempts: 5 }`. {@link VoxelNetClient} with your own
   * transport ignores it: call {@link VoxelNetClient.detach} and {@link VoxelNetClient.attach} yourself.
   */
  resume?: false | { attempts?: number; signal?: AbortSignal };
  /** Options of the local player's body; the server's must match. */
  character?: VoxelCharacterOptions;
}

/** What the player does this frame: {@link Keys} bits and where it looks, radians. */
export interface VoxelNetControls {
  /** {@link Keys} bits held. */
  keys: number;
  /** Heading in radians: 0 looks along -z, positive turns left (towards -x). */
  yaw: number;
  /** Look up (positive) or down, radians. */
  pitch: number;
}

/** Another player as the client sees it. */
export interface RemotePlayer {
  /** The server's id of the player. */
  readonly id: number;
  /** Its display name as the server cleaned it, `''` when it has none. Show it as text, never as HTML. */
  name: string;
  /** Its snapshots, by server time in seconds. */
  readonly buffer: SnapshotBuffer;
  /** Where to draw it, filled by {@link VoxelNetClient.samplePlayers}. */
  readonly snapshot: Snapshot;
  /** Last position pushed, for velocity. */
  last?: { time: number; position: MutableVec3 };
}

/** How a connection ended, for {@link VoxelNetClient.onClose}. */
export interface VoxelNetClose {
  /**
   * The WebSocket close code: 1001 when the server shut down cleanly, 1006 when the connection was lost or never made,
   * {@link SERVER_SILENT_CODE} when the server went silent with the socket still open.
   */
  code: number;
  /** The reason the server gave, `''` for none. */
  reason: string;
  /** Whether this client started the close, through {@link VoxelNetClient.close} or after a message it could not read. */
  byClient: boolean;
  /** Set when the connection dropped and could not be taken back: why the last try failed. `code` is the first drop's. */
  resumeFailed?: string;
}

/** One try to take the player back, for {@link VoxelNetClient.onResume}. */
export interface VoxelNetResume {
  /** Which try, from 1. */
  attempt: number;
  /** Why the connection dropped: its close reason, or its code when it gave none. */
  cause: string;
  /** Milliseconds until this try starts. */
  delay: number;
}

/** A player taken back, for {@link VoxelNetClient.onResumed}. */
export interface VoxelNetResumed {
  /** Milliseconds from the drop until the server had the player again. */
  gapMs: number;
  /** Chunks the server sends again because the dead socket may have lost them. */
  chunksResent: number;
}

/** Bytes and events a client counted since it was created. */
export interface VoxelNetClientStats {
  /** Bytes of messages received, by message type. */
  received: Record<ServerMessage['type'], number>;
  /** Bytes of messages sent. */
  sent: number;
  /** Corrections applied. */
  corrections: number;
  /** Chunks received. */
  chunks: number;
  /** Connections that dropped and were not given up on at once. */
  drops: number;
  /** Tries to take the player back. */
  resumeAttempts: number;
  /** Times the player was taken back. */
  resumes: number;
  /** Drops that ended in giving up. */
  resumeFailed: number;
}

// A chunk the server sent: bytes until decoded, then in the world; edits that arrive before then wait in `changes`.
interface Entry {
  cx: number;
  cy: number;
  cz: number;
  bytes: Uint8Array | undefined;
  changes: number[];
  loaded: boolean;
  decoding: boolean;
  // Sent again while the old copy is in the world: that one stays until this one is decoded, so nobody falls through.
  swap: boolean;
}

const COPY_STEPS = 120, // most steps one input message carries with its copies, over datagrams
  NO_PLAYERS = new Map<number, never>(),
  HISTORY = 1200, // steps of input kept for replay: 10 s
  SEND_EVERY = 6, // steps per input message: one per 20 Hz tick
  SILENT_CHECKS = 15, // serverTimeout is watched by this many timer firings
  ATTEMPT_MS = 5000, // one try to take a player back may take this long
  GAP_MS = 30_000; // no new try after this long: the server's resumeTimeout has run out by then

/**
 * {@link VoxelNetClose.code} when {@link connectVoxelNet} gave up on a server that sent nothing for
 * {@link VoxelNetClientOptions.serverTimeout}, with reason `'server-silent'` and `byClient` false: a dead network, or a
 * server that stopped. From the private use range (4000 to 4999), like HTTP 408; no server ever sends it.
 */
export const SERVER_SILENT_CODE = 4408;

/**
 * The client half of voxel-net. Feed it the server's messages with {@link VoxelNetClient.receive}; call
 * {@link VoxelNetClient.update} every frame with the player's controls. It adds and removes the world's chunks as
 * the server says (lighting and rendering follow `world.onChunk`), moves {@link VoxelNetClient.player} at fixed
 * 1/120 s steps, sends those inputs once per tick and replays them when the server corrects it, applies everyone's
 * edits, and keeps a {@link RemotePlayer} per nearby player.
 *
 * ```ts
 * const client = connectVoxelNet('ws://127.0.0.1:8787', world, { name: 'Ada' });
 * engine.onFrame((_, dt) => {
 *   client.update(dt, { keys: Keys.forward, yaw, pitch });
 *   for (const other of client.samplePlayers().values()) drawBox(other.snapshot.position);
 * });
 * ```
 */
export class VoxelNetClient {
  /** The world the server's chunks go into. */
  readonly world: VoxelWorld;
  /** The local player, moved by {@link VoxelNetClient.update}. */
  readonly player: VoxelCharacter;
  /** The player's feet between its last two steps: draw the camera from here. */
  readonly renderPosition: MutableVec3 = [0, 0, 0];
  /** Other players in range, by id. */
  readonly players = new Map<number, RemotePlayer>();
  /** Counters for tests and benchmarks. */
  readonly stats: VoxelNetClientStats = {
    received: {
      welcome: 0,
      chunk: 0,
      unload: 0,
      state: 0,
      blocks: 0,
      players: 0,
      loaded: 0,
      names: 0,
      heartbeat: 0,
      app: 0,
      entities: 0,
    },
    sent: 0,
    corrections: 0,
    chunks: 0,
    drops: 0,
    resumeAttempts: 0,
    resumes: 0,
    resumeFailed: 0,
  };
  /** The server's welcome once it arrived. */
  welcome: Extract<ServerMessage, { type: 'welcome' }> | undefined;
  /** The server placed the player: it can move. */
  spawned = false;
  /** The whole view has arrived once. */
  loaded = false;
  /** Called once the player is placed. */
  onSpawn: () => void = () => {};
  /** Called once the whole view has arrived. */
  onLoaded: () => void = () => {};
  /**
   * Called with the payload of each `app` message the server's game sends with `VoxelServer.send` or `broadcast`, in
   * order with the other messages. The bytes are yours to keep. A throw goes to {@link VoxelNetClient.onError} and
   * closes the connection, as for any handler. Default does nothing.
   */
  onApp: (data: Uint8Array) => void = () => {};
  /**
   * Called with each `entities` message: server tick, whether it is in full (against no baseline), and `EntityCodec`
   * bytes. `VoxelEntityView` of `@margoengine/voxel-net/entities` takes it over. Default does nothing.
   */
  onEntities: (tick: number, full: boolean, data: Uint8Array) => void = () => {};
  /** Called with each block change list the server sends, flat `[x, y, z, state, ...]`, before it is applied. */
  onBlocks: (changes: Int32Array) => void = () => {};
  /**
   * Called once when the connection has ended, however it ended: read `code` and `reason` to rejoin after a server
   * shutdown (1001). {@link connectVoxelNet} calls it; with your own {@link VoxelNetTransport}, call it yourself when
   * the transport ends. Default does nothing.
   */
  onClose: (event: VoxelNetClose) => void = () => {};
  /** Called before each try to take the player back after a drop. Default does nothing. */
  onResume: (event: VoxelNetResume) => void = () => {};
  /** Called when the server has the player again, in the same place. Default does nothing. */
  onResumed: (event: VoxelNetResumed) => void = () => {};
  /**
   * Receives errors: a message the client cannot read, a chunk that fails to decode or cannot go into the world (one
   * the app already made at that key, with setBlock). Default console.error.
   */
  onError: (error: unknown) => void = (error) => console.error(error);
  #transport: VoxelNetTransport;
  readonly #view: number;
  readonly #name: string;
  readonly #decodeDistance: number;
  readonly #decodePlayers: boolean;
  readonly #delay: number;
  readonly #codec = new EntityCodec(PLAYER_SCHEMA);
  readonly #chunks = new Map<string, Entry>();
  #entities = new Map<number, PlayerState>();
  readonly #names = new Map<number, string>(); // by id, while the player is in range
  #step = 0; // last step simulated
  #acked = 0; // step of the last correction applied
  #time = 0; // simulated time not yet stepped
  readonly #previous: MutableVec3 = [0, 0, 0];
  readonly #keys = new Uint8Array(HISTORY);
  readonly #yaw = new Uint16Array(HISTORY);
  #runs: InputRun[] = [];
  #copies: { step: number; runs: InputRun[] }[] = []; // the last inputs sent, over datagrams
  #lastTick = -1; // tick of the newest players message, over datagrams
  readonly #inputCopies: number;
  #first = 0; // first step in #runs
  #pending = 0; // steps in #runs
  #center = ''; // chunk of the player when chunks near it were last decoded
  #offset = Number.POSITIVE_INFINITY; // local seconds minus server seconds, smallest seen
  #closed = false;
  #detachedAt = -1; // performance.now() of the drop, -1 while connected
  readonly #edited: (readonly [number, number, number])[] = []; // chunks of the latest edits, oldest first
  /**
   * @throws TypeError when `world` is not a VoxelWorld or `transport` lacks send and close.
   * @throws RangeError for a view outside 0..64 or a negative decode distance.
   */
  constructor(world: VoxelWorld, transport: VoxelNetTransport, options: VoxelNetClientOptions = {}) {
    if (typeof world?.getChunk !== 'function' || typeof world.addChunk !== 'function')
      throw new TypeError('VoxelNetClient needs a VoxelWorld: pass new VoxelWorld({blocks})');
    if (typeof transport?.send !== 'function' || typeof transport.close !== 'function')
      throw new TypeError('VoxelNetClient transport needs send(bytes) and close(); pass a WebSocket');
    const { decodeDistance = Number.POSITIVE_INFINITY, view = 6 } = options;
    if (!(decodeDistance >= 0)) throw new RangeError(`decodeDistance ${decodeDistance} must be >= 0 chunks`);
    this.world = world;
    this.player = new VoxelCharacter(world, options.character);
    this.#transport = transport;
    this.#decodeDistance = decodeDistance;
    this.#decodePlayers = options.players ?? true;
    this.#delay = options.interpolationDelay ?? 0.1;
    const copies = options.inputCopies ?? 3;
    if (!(Number.isInteger(copies) && copies >= 0 && copies <= 8))
      throw new RangeError(`VoxelNetClient inputCopies ${copies} must be a whole number from 0 to 8`);
    this.#inputCopies = copies;
    this.#view = view;
    this.#name = options.name ?? '';
    this.#send(encodeClientMessage({ type: 'hello', version: PROTOCOL_VERSION, view, name: this.#name }));
  }
  /**
   * Handles one message from the server.
   * @throws never: a message it cannot read goes to {@link VoxelNetClient.onError} and closes the connection.
   */
  receive(bytes: Uint8Array): void {
    if (this.#closed) return;
    let message: ServerMessage;
    try {
      message = decodeServerMessage(bytes);
      this.stats.received[message.type] += bytes.length;
      this.#handle(message);
    } catch (error) {
      this.onError(error);
      this.close();
    }
  }
  /**
   * Moves the player by `dt` seconds of `controls`, in whole 1/120 s steps (the rest carries over; at most 0.25 s per
   * call), sends the inputs once per 6 steps, and updates {@link VoxelNetClient.renderPosition}. The player holds still
   * until it has spawned and while the chunks around it have not arrived.
   * @throws RangeError for a negative or non-finite `dt`.
   */
  update(dt: number, controls: VoxelNetControls): void {
    if (!(dt >= 0 && dt < Number.POSITIVE_INFINITY))
      throw new RangeError(`VoxelNetClient update dt ${dt} must be finite and >= 0 seconds`);
    if (!this.spawned || this.#closed || this.detached) return;
    const p = this.player.position;
    this.#decodeNear();
    if (!this.#ready(p)) {
      this.#time = 0;
      for (let i = 0; i < 3; i++) this.renderPosition[i] = p[i];
      return;
    }
    const keys = controls.keys & (this.welcome?.flight ? 255 : 255 & ~Keys.fly),
      yaw = quantizeYaw(controls.yaw),
      pitch = quantizePitch(controls.pitch);
    this.#time = Math.min(this.#time + dt, 0.25);
    for (; this.#time + STEP_SECONDS * 1e-6 >= STEP_SECONDS; this.#time -= STEP_SECONDS) {
      for (let i = 0; i < 3; i++) this.#previous[i] = p[i];
      const step = ++this.#step,
        slot = step % HISTORY;
      this.#keys[slot] = keys;
      this.#yaw[slot] = yaw;
      this.#simulate(keys, yaw);
      const last = this.#runs[this.#runs.length - 1];
      if (last && last.keys === keys && last.yaw === yaw && last.pitch === pitch) last.steps++;
      else {
        if (!this.#runs.length) this.#first = step;
        this.#runs.push({ steps: 1, keys, yaw, pitch });
      }
      if (++this.#pending >= SEND_EVERY) this.flush();
    }
    if (this.#time < 0) this.#time = 0;
    const alpha = this.#time / STEP_SECONDS;
    for (let i = 0; i < 3; i++) this.renderPosition[i] = this.#previous[i] + (p[i] - this.#previous[i]) * alpha;
  }
  /** Sends the inputs of the steps since the last send now (an edit does this first, so the server sees them in order). */
  flush(): void {
    if (!this.#runs.length || this.#closed || this.detached) return;
    let step = this.#first,
      runs = this.#runs;
    if (this.#transport.datagrams) {
      // Each datagram carries the steps of the last few too, so one lost on the way costs nothing; the server cuts
      // the steps it has. Copies stop at COPY_STEPS steps, well inside the server's 240 a message.
      this.#copies.push({ step, runs });
      while (this.#copies.length > this.#inputCopies + 1) this.#copies.shift();
      let steps = 0;
      for (const run of runs) steps += run.steps;
      while (this.#copies.length > 1) {
        const [first] = this.#copies as [{ step: number; runs: InputRun[] }];
        if (step - first.step + steps <= COPY_STEPS) break;
        this.#copies.shift();
      }
      step = (this.#copies[0] as { step: number }).step;
      runs = this.#copies.flatMap((copy) => copy.runs);
    }
    this.#send(
      encodeClientMessage({
        type: 'input',
        step,
        acked: this.#acked,
        runs,
        position: this.player.position,
      }),
    );
    this.#runs = [];
    this.#pending = 0;
  }
  /**
   * Sets cell (x, y, z) to `state` at once and asks the server to make it so; the server answers with the cell's real
   * state if it refuses. Returns false (and changes nothing) before spawning, between a drop and its resume, or when the
   * cell's chunk is not loaded.
   * @throws as `VoxelWorld.setBlock` for a bad cell or state.
   */
  edit(x: number, y: number, z: number, state: number): boolean {
    if (!this.spawned || this.#closed || this.detached || !this.world.getChunk(x >> 5, y >> 5, z >> 5)) return false;
    this.world.setBlock(x, y, z, state);
    this.flush();
    this.#edited.push([x >> 5, y >> 5, z >> 5]);
    if (this.#edited.length > MAX_STALE_CHUNKS) this.#edited.shift();
    this.#send(encodeClientMessage({ type: 'edit', x, y, z, state }));
    return true;
  }
  /**
   * Fills each {@link RemotePlayer.snapshot} with where to draw that player at local time `now` (seconds,
   * `performance.now() / 1000` by default): {@link VoxelNetClientOptions.interpolationDelay} behind the newest
   * snapshot, interpolated. Returns {@link VoxelNetClient.players}.
   */
  samplePlayers(now: number = performance.now() / 1000): ReadonlyMap<number, RemotePlayer> {
    const time = now - this.#offset - this.#delay;
    if (Number.isFinite(time)) for (const other of this.players.values()) other.buffer.sample(time, other.snapshot);
    return this.players;
  }
  /** True from {@link VoxelNetClient.detach} until the server has the player again. */
  get detached(): boolean {
    return this.#detachedAt >= 0;
  }
  /**
   * The connection dropped. Until {@link VoxelNetClient.attach} brings the player back, {@link VoxelNetClient.update} holds
   * it where it is and sends nothing, {@link VoxelNetClient.edit} refuses, and the world, its chunks and the other players
   * stay as they are. {@link connectVoxelNet} and `VoxelBot` do this by themselves.
   */
  detach(): void {
    if (this.#closed || this.detached) return;
    this.#detachedAt = performance.now();
    this.#runs = [];
    this.#copies = [];
    this.#pending = 0;
    this.#time = 0;
    this.stats.drops++;
  }
  /**
   * Tries to take the player back over a new `transport`: says hello with the token of the last welcome. The server's
   * `state` answer ends the gap. A refusal closes `transport`; call this again with another one to try again.
   * @throws MargoError `'state'` when the client is not detached, or the server gave it no token.
   * @throws TypeError when `transport` lacks send and close.
   */
  attach(transport: VoxelNetTransport): void {
    const token = this.welcome?.resume;
    if (!this.detached || !token?.length)
      throw new MargoError(
        'state',
        'VoxelNetClient.attach needs a player that was spawned and then detached; call detach() first',
      );
    if (typeof transport?.send !== 'function' || typeof transport.close !== 'function')
      throw new TypeError('VoxelNetClient.attach transport needs send(bytes) and close(); pass a WebSocket');
    this.#transport = transport;
    this.#entities = new Map(); // the server starts its players messages over
    const stale = new Map(this.#edited.map((key) => [chunkKey(key[0], key[1], key[2]), key]));
    this.stats.resumeAttempts++;
    this.#send(
      encodeClientMessage({
        type: 'hello',
        version: PROTOCOL_VERSION,
        view: this.#view,
        name: this.#name,
        resume: { token, chunks: this.stats.chunks, stale: [...stale.values()] },
      }),
    );
  }
  /**
   * Takes every chunk this client put in the world out of it, and forgets them (so a later message for one is a new
   * chunk). For moving a world to another server, as `@margoengine/voxel-net/shards` does on a handoff.
   */
  removeChunks(): void {
    for (const key of [...this.#chunks.keys()]) this.#drop(key);
  }
  /** Closes the connection. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#transport.close();
  }
  #send(bytes: Uint8Array): void {
    this.stats.sent += bytes.length;
    this.#transport.send(bytes);
  }
  #handle(m: ServerMessage): void {
    switch (m.type) {
      case 'welcome':
        if (m.blocks !== blockTableHash(this.world.blocks))
          throw new MargoError('state', 'The server has other block types than this world; use the same BlockTypes');
        this.welcome = m;
        break;
      case 'chunk': {
        const key = chunkKey(m.cx, m.cy, m.cz),
          old = this.#chunks.get(key),
          swap = !!old && (old.loaded || old.swap);
        const entry: Entry = {
          cx: m.cx,
          cy: m.cy,
          cz: m.cz,
          bytes: m.data,
          changes: [],
          loaded: false,
          decoding: false,
          swap,
        };
        this.#chunks.set(key, entry);
        this.stats.chunks++;
        if (this.#near(entry)) this.#decode(key, entry);
        break;
      }
      case 'unload':
        this.#drop(chunkKey(m.cx, m.cy, m.cz));
        break;
      case 'state':
        this.#state(m);
        break;
      case 'blocks':
        this.#blocks(decodeBlockChanges(m.data));
        break;
      case 'players':
        if (this.#decodePlayers) this.#players(m.tick, m.data);
        break;
      case 'loaded':
        if (!this.loaded) {
          this.loaded = true; // a resume says it again
          this.onLoaded();
        }
        break;
      case 'names':
        if (this.#decodePlayers)
          for (const { id, name } of m.names) {
            this.#names.set(id, name);
            const other = this.players.get(id);
            if (other) other.name = name;
          }
        break;
      case 'heartbeat': // arriving was its whole job
        break;
      case 'app':
        this.onApp(m.data);
        break;
      case 'entities':
        this.onEntities(m.tick, m.full, m.data);
        break;
    }
  }
  #drop(key: string): void {
    const entry = this.#chunks.get(key);
    if (!entry) return;
    this.#chunks.delete(key);
    if (entry.loaded || entry.swap) this.world.removeChunk(entry.cx, entry.cy, entry.cz);
  }
  // Within decodeDistance of the player (before spawning, only when decoding everything).
  #near(e: Entry): boolean {
    if (this.#decodeDistance === Number.POSITIVE_INFINITY) return true;
    if (!this.spawned) return false;
    const p = this.player.position,
      d = this.#decodeDistance;
    return (
      Math.abs(e.cx - (Math.floor(p[0]) >> 5)) <= d &&
      Math.abs(e.cy - (Math.floor(p[1]) >> 5)) <= d &&
      Math.abs(e.cz - (Math.floor(p[2]) >> 5)) <= d
    );
  }
  #decodeNear(): void {
    if (this.#decodeDistance === Number.POSITIVE_INFINITY) return;
    const p = this.player.position,
      center = chunkKey(Math.floor(p[0]) >> 5, Math.floor(p[1]) >> 5, Math.floor(p[2]) >> 5);
    if (center === this.#center) return;
    this.#center = center;
    for (const [key, entry] of this.#chunks)
      if (!entry.loaded && !entry.decoding && this.#near(entry)) this.#decode(key, entry);
  }
  #decode(key: string, entry: Entry): void {
    const bytes = entry.bytes as Uint8Array;
    entry.decoding = true;
    // The catch comes after the then, so that a throw while the chunk goes into the world (a chunk the app made at that
    // key with setBlock, say) reaches onError like a chunk that fails to decode, instead of an unhandled rejection.
    decodeChunk(bytes)
      .then((chunk) => {
        if (this.#chunks.get(key) !== entry || this.#closed) return;
        if (entry.swap) this.world.removeChunk(entry.cx, entry.cy, entry.cz);
        entry.swap = false;
        this.world.addChunk(entry.cx, entry.cy, entry.cz, chunk);
        entry.loaded = true;
        entry.decoding = false;
        entry.bytes = undefined;
        if (entry.changes.length) this.world.setBlocks(entry.changes);
        entry.changes = [];
      })
      .catch((error) => this.onError(error));
  }
  // The chunks the player stands in and on are in the world.
  #ready(p: MutableVec3): boolean {
    const x = Math.floor(p[0]) >> 5,
      z = Math.floor(p[2]) >> 5;
    return !!this.world.getChunk(x, Math.floor(p[1]) >> 5, z) && !!this.world.getChunk(x, Math.floor(p[1] - 2) >> 5, z);
  }
  #simulate(keys: number, yaw: number): void {
    this.player.flying = (keys & Keys.fly) !== 0;
    this.player.update(STEP_SECONDS, moveIntent(keys, yaw));
  }
  #state(m: Extract<ServerMessage, { type: 'state' }>): void {
    const p = this.player;
    p.position = [m.position[0], m.position[1], m.position[2]];
    for (let i = 0; i < 3; i++) p.velocity[i] = m.velocity[i];
    p.flying = m.flying;
    if (m.spawn) {
      this.#step = m.step;
      this.#acked = m.step;
      this.#runs = [];
      this.#pending = 0;
      this.#time = 0;
      for (let i = 0; i < 3; i++) this.renderPosition[i] = this.#previous[i] = m.position[i];
      const back = this.spawned;
      this.spawned = true;
      this.#center = '';
      this.#decodeNear();
      if (!back) return this.onSpawn();
      const gapMs = performance.now() - this.#detachedAt;
      this.#detachedAt = -1;
      this.#edited.length = 0;
      this.stats.resumes++;
      this.onResumed({ gapMs, chunksResent: this.welcome?.resent ?? 0 });
      return;
    }
    // Replay the steps after the corrected one, when they are still in the history.
    this.stats.corrections++;
    this.#acked = m.step;
    if (this.#step - m.step < HISTORY)
      for (let step = m.step + 1; step <= this.#step; step++)
        this.#simulate(this.#keys[step % HISTORY], this.#yaw[step % HISTORY]);
    for (let i = 0; i < 3; i++) this.#previous[i] = p.position[i];
  }
  #blocks(changes: Int32Array): void {
    this.onBlocks(changes);
    const loaded: number[] = [];
    let key = '',
      entry: Entry | undefined;
    for (let i = 0; i < changes.length; i += 4) {
      const x = changes[i],
        y = changes[i + 1],
        z = changes[i + 2],
        k = chunkKey(x >> 5, y >> 5, z >> 5);
      if (k !== key) {
        key = k;
        entry = this.#chunks.get(k);
      }
      if (!entry) continue; // not ours: the server sends edits only for chunks we have
      (entry.loaded ? loaded : entry.changes).push(x, y, z, changes[i + 3]);
    }
    if (loaded.length) this.world.setBlocks(loaded);
  }
  #players(tick: number, data: Uint8Array): void {
    const rate = this.welcome?.tickRate || 20,
      time = tick / rate,
      now = performance.now() / 1000,
      lossy = this.#transport.datagrams === true;
    if (lossy && tick <= this.#lastTick) return; // a datagram that came late: a newer one is in
    this.#lastTick = tick;
    const decoded = this.#codec.decode(data, lossy ? NO_PLAYERS : this.#entities);
    // Server clock: the least delayed arrival so far, drifting up slowly in case the clocks run apart.
    this.#offset = Math.min(now - time, this.#offset + 0.0005);
    for (const [id, state] of decoded) {
      if (id === this.welcome?.id) continue;
      let other = this.players.get(id);
      if (!other) {
        other = {
          id,
          name: this.#names.get(id) ?? '',
          buffer: new SnapshotBuffer(32, 0.25),
          snapshot: createSnapshot(),
        };
        this.players.set(id, other);
      }
      // Every player every message (a still one too), so the buffer does not extrapolate a stopped player onwards.
      const p = state.position,
        last = other.last,
        span = last ? time - last.time : 0,
        velocity = last && span > 0 ? p.map((v, i) => (v - last.position[i]) / span) : [0, 0, 0];
      if (other.buffer.push(time, p, state.rotation, velocity)) other.last = { time, position: [p[0], p[1], p[2]] };
    }
    for (const id of this.players.keys())
      if (!decoded.has(id)) {
        this.players.delete(id);
        this.#names.delete(id); // the server names it again when it comes back
      }
    this.#entities = decoded;
  }
}

/**
 * Milliseconds to wait before try `attempt` to take a player back: 100 to 600 for the first, so a whole crowd cut at once
 * spreads out, then 1, 2, 4 and 8 s, each within half of that either way.
 * @internal
 */
const resumeDelay = (attempt: number, random: () => number = Math.random): number =>
  attempt < 2 ? 100 + 500 * random() : 1000 * 2 ** Math.min(attempt - 2, 3) * (0.5 + random());

/**
 * The tries to take a player back after a drop, for {@link connectVoxelNet} and `VoxelBot`: `open` makes a new
 * connection and `abandon` lets go of the current one, whose later events must not reach {@link ResumeLoop.drop}.
 * @internal
 */
export class ResumeLoop {
  readonly #client: VoxelNetClient;
  readonly #attempts: number;
  readonly #signal: AbortSignal | undefined;
  readonly #open: () => Promise<VoxelNetTransport>;
  readonly #abandon: () => void;
  readonly #end: (close: VoxelNetClose) => void;
  #first: VoxelNetClose | undefined; // the drop being resumed from
  #attempt = 0;
  #at = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #wake: (() => void) | undefined;
  constructor(
    client: VoxelNetClient,
    resume: VoxelNetClientOptions['resume'],
    open: () => Promise<VoxelNetTransport>,
    abandon: () => void,
    end: (close: VoxelNetClose) => void,
  ) {
    this.#client = client;
    const attempts = resume === false ? 0 : (resume?.attempts ?? 5);
    if (!Number.isInteger(attempts) || attempts < 0)
      throw new RangeError(`resume attempts ${attempts} must be a whole number >= 0; pass false to turn resuming off`);
    this.#attempts = attempts;
    this.#signal = resume ? resume.signal : undefined;
    this.#open = open;
    this.#abandon = abandon;
    this.#end = end;
  }
  /** Whether a drop is being resumed from. */
  get active(): boolean {
    return !!this.#first;
  }
  /** The socket ended. True while this handles it; false when the connection has ended for good. */
  drop(code: number, reason: string): boolean {
    const retry = code === 1006 || code === SERVER_SILENT_CODE;
    if (this.#first) {
      if (!retry) this.#give(reason || String(code));
      else this.#next();
      return true;
    }
    const client = this.#client;
    if (
      !this.#attempts ||
      this.#signal?.aborted ||
      !client.spawned ||
      !client.welcome?.resume.length ||
      !(retry || (code === 1008 && reason === 'client-silent'))
    )
      return false;
    this.#first = { code, reason, byClient: false };
    this.#attempt = 0;
    this.#at = performance.now();
    this.#signal?.addEventListener('abort', this.#aborted);
    client.detach();
    this.#abandon();
    this.#next();
    return true;
  }
  /** A message arrived: the gap ends when the client has its player again. */
  heard(): void {
    if (this.#first && !this.#client.detached) this.stop();
  }
  /** Stops trying. */
  stop(): void {
    this.#clear();
    this.#signal?.removeEventListener('abort', this.#aborted);
    this.#first = undefined;
    this.#attempt = -1;
  }
  readonly #aborted = (): void => {
    this.stop();
    this.#abandon();
    this.#end({ code: 1000, reason: 'aborted', byClient: true });
  };
  #clear(): void {
    clearTimeout(this.#timer);
    if (this.#wake) {
      globalThis.document?.removeEventListener('visibilitychange', this.#wake);
      globalThis.removeEventListener?.('online', this.#wake);
    }
    this.#wake = undefined;
  }
  #give(why: string): void {
    const first = this.#first as VoxelNetClose;
    this.stop();
    this.#client.stats.resumeFailed++;
    this.#abandon();
    this.#end({ ...first, resumeFailed: why });
  }
  #next(): void {
    this.#clear();
    const attempt = ++this.#attempt,
      first = this.#first as VoxelNetClose;
    if (attempt > this.#attempts || performance.now() - this.#at >= GAP_MS)
      return this.#give(`no answer in ${attempt - 1} tries`);
    const delay = resumeDelay(attempt);
    this.#client.onResume({ attempt, cause: first.reason || String(first.code), delay });
    if (this.#first) this.#wait(delay, attempt);
  }
  // Waits out `ms`, longer while the page is offline; a tab shown again or a network that came back ends it at once.
  #wait(ms: number, attempt: number): void {
    const offline = () => globalThis.navigator?.onLine === false,
      left = () => GAP_MS - (performance.now() - this.#at),
      fire = () => {
        this.#clear();
        if (offline() && left() > 0) return this.#wait(left(), attempt);
        this.#try(attempt);
      },
      wake = () => {
        if (globalThis.document?.visibilityState !== 'hidden' && !offline()) fire();
      };
    this.#wake = wake;
    this.#timer = setTimeout(fire, ms);
    globalThis.document?.addEventListener('visibilitychange', wake);
    globalThis.addEventListener?.('online', wake);
  }
  #try(attempt: number): void {
    const live = () => this.#attempt === attempt;
    this.#timer = setTimeout(() => {
      this.#abandon();
      this.drop(1006, 'no answer');
    }, ATTEMPT_MS);
    this.#open().then(
      (transport) => {
        if (live()) this.#client.attach(transport);
      },
      (error) => {
        if (live()) this.drop(1006, String(error?.message ?? error));
      },
    );
  }
}

/**
 * Connects a {@link VoxelNetClient} to a voxel-net server with the browser's WebSocket. When the server refuses or drops
 * the connection (any close but 1000 and 1001, for example another protocol version), `onError` gets a MargoError
 * `'failed'` holding the close code and reason. Every way the connection ends, a clean server shutdown included, calls
 * {@link VoxelNetClient.onClose} once, after any `onError`. A server silent for
 * {@link VoxelNetClientOptions.serverTimeout} ends it the same way, at once and without waiting for the socket, whose own
 * close can take a minute on a dead route: `onError` gets a MargoError `'failed'` and `onClose` gets
 * {@link SERVER_SILENT_CODE}.
 *
 * A connection that drops after the player has spawned (close 1006, a silent server, or the server's `client-silent`) is
 * not the end: the client holds the player (see {@link VoxelNetClient.detach}) and tries again as
 * {@link VoxelNetClientOptions.resume} says, telling {@link VoxelNetClient.onResume} and {@link VoxelNetClient.onResumed}.
 * `onError` and `onClose` come only if that fails, with the first drop's code and `resumeFailed`.
 *
 * Silence is counted in timer firings, not on a clock: one firing, however late, is one fifteenth of the timeout. So a
 * long frame or a throttled background tab, where messages wait behind the timer, is not taken for a dead server.
 * @throws MargoError `'unsupported'` where there is no global WebSocket.
 * @throws RangeError for a `serverTimeout` that is negative or not finite.
 * @throws as the {@link VoxelNetClient} constructor.
 */
export function connectVoxelNet(
  url: string | URL,
  world: VoxelWorld,
  options: VoxelNetClientOptions = {},
): VoxelNetClient {
  if (typeof WebSocket !== 'function')
    throw new MargoError('unsupported', 'connectVoxelNet needs a global WebSocket; use a browser or Node 22+');
  const { serverTimeout = 15_000 } = options;
  if (!(serverTimeout >= 0 && serverTimeout < Number.POSITIVE_INFINITY))
    throw new RangeError(`serverTimeout ${serverTimeout} must be finite and >= 0 milliseconds; 0 never gives up`);
  let closing = false,
    ended = false,
    silent = 0,
    socket: WebSocket | undefined,
    watch: ReturnType<typeof setInterval> | undefined;
  const close = (): void => {
    closing = true;
    clearInterval(watch);
    loop.stop();
    if (socket) socket.close();
    else end(1000, '', true, undefined); // in a gap there is no socket to report it
  };
  const open = (): VoxelNetTransport => {
    const ws = new WebSocket(url),
      queue: Uint8Array[] = [];
    socket = ws;
    silent = 0;
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', () => {
      for (const data of queue.splice(0)) ws.send(data as Uint8Array<ArrayBuffer>);
    });
    ws.addEventListener('message', (event) => {
      if (ws !== socket) return;
      silent = 0;
      client.receive(new Uint8Array(event.data as ArrayBuffer));
      loop.heard();
    });
    ws.addEventListener('close', ({ code, reason }) => {
      if (ws === socket) lost(code, reason);
    });
    return {
      send: (data) => (ws.readyState === 1 ? ws.send(data as Uint8Array<ArrayBuffer>) : queue.push(data)),
      close,
    };
  };
  const client = new VoxelNetClient(world, open(), options);
  const end = (
    code: number,
    reason: string,
    byClient: boolean,
    message: string | undefined,
    resumeFailed?: string,
  ): void => {
    if (ended) return;
    ended = true;
    clearInterval(watch);
    try {
      if (message) client.onError(new MargoError('failed', message));
    } finally {
      client.close();
      client.onClose({ code, reason, byClient, ...(resumeFailed ? { resumeFailed } : {}) });
    }
  };
  const said = (code: number, reason: string): string =>
    code === SERVER_SILENT_CODE
      ? `The voxel-net server sent nothing for ${serverTimeout} ms (serverTimeout); the network or the server is gone, so join again`
      : `The voxel-net server closed the connection with ${code}${reason ? ` (${reason})` : ''}; check that it is running and that server and client are the same version`;
  const loop = new ResumeLoop(
    client,
    options.resume,
    async () => open(),
    () => {
      const old = socket;
      socket = undefined;
      old?.close();
    },
    (c) => end(c.code, c.reason, c.byClient, c.resumeFailed && said(c.code, c.reason), c.resumeFailed),
  );
  const lost = (code: number, reason: string): void => {
    // Read first: an onError handler may call client.close(), which does not make this close the client's.
    const byClient = closing;
    if (byClient || !loop.drop(code, reason))
      end(code, reason, byClient, !byClient && code !== 1000 && code !== 1001 ? said(code, reason) : undefined);
  };
  if (serverTimeout > 0) {
    watch = setInterval(() => {
      if (!loop.active && ++silent >= SILENT_CHECKS) lost(SERVER_SILENT_CODE, 'server-silent');
    }, serverTimeout / SILENT_CHECKS);
    (watch as { unref?: () => void }).unref?.();
  }
  return client;
}
