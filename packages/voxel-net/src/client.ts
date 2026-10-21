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
}

/** Options of {@link VoxelNetClient}. */
export interface VoxelNetClientOptions {
  /** Display name, at most 32 UTF-8 bytes. Default ''. */
  name?: string;
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
  /** Its snapshots, by server time in seconds. */
  readonly buffer: SnapshotBuffer;
  /** Where to draw it, filled by {@link VoxelNetClient.samplePlayers}. */
  readonly snapshot: Snapshot;
  /** Last position pushed, for velocity. */
  last?: { time: number; position: MutableVec3 };
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
}

const HISTORY = 1200, // steps of input kept for replay: 10 s
  SEND_EVERY = 6; // steps per input message: one per 20 Hz tick

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
    received: { welcome: 0, chunk: 0, unload: 0, state: 0, blocks: 0, players: 0, loaded: 0 },
    sent: 0,
    corrections: 0,
    chunks: 0,
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
  /** Called with each block change list the server sends, flat `[x, y, z, state, ...]`, before it is applied. */
  onBlocks: (changes: Int32Array) => void = () => {};
  /** Receives errors: a message the client cannot read, a chunk that fails to decode. Default console.error. */
  onError: (error: unknown) => void = (error) => console.error(error);
  readonly #transport: VoxelNetTransport;
  readonly #decodeDistance: number;
  readonly #decodePlayers: boolean;
  readonly #delay: number;
  readonly #codec = new EntityCodec(PLAYER_SCHEMA);
  readonly #chunks = new Map<string, Entry>();
  #entities = new Map<number, PlayerState>();
  #step = 0; // last step simulated
  #acked = 0; // step of the last correction applied
  #time = 0; // simulated time not yet stepped
  readonly #previous: MutableVec3 = [0, 0, 0];
  readonly #keys = new Uint8Array(HISTORY);
  readonly #yaw = new Uint16Array(HISTORY);
  #runs: InputRun[] = [];
  #first = 0; // first step in #runs
  #pending = 0; // steps in #runs
  #center = ''; // chunk of the player when chunks near it were last decoded
  #offset = Number.POSITIVE_INFINITY; // local seconds minus server seconds, smallest seen
  #closed = false;
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
    this.#send(encodeClientMessage({ type: 'hello', version: PROTOCOL_VERSION, view, name: options.name ?? '' }));
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
    if (!this.spawned || this.#closed) return;
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
    if (!this.#runs.length || this.#closed) return;
    this.#send(
      encodeClientMessage({
        type: 'input',
        step: this.#first,
        acked: this.#acked,
        runs: this.#runs,
        position: this.player.position,
      }),
    );
    this.#runs = [];
    this.#pending = 0;
  }
  /**
   * Sets cell (x, y, z) to `state` at once and asks the server to make it so; the server answers with the cell's real
   * state if it refuses. Returns false (and changes nothing) before spawning or when the cell's chunk is not loaded.
   * @throws as `VoxelWorld.setBlock` for a bad cell or state.
   */
  edit(x: number, y: number, z: number, state: number): boolean {
    if (!this.spawned || this.#closed || !this.world.getChunk(x >> 5, y >> 5, z >> 5)) return false;
    this.world.setBlock(x, y, z, state);
    this.flush();
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
        const key = chunkKey(m.cx, m.cy, m.cz);
        this.#drop(key);
        const entry: Entry = {
          cx: m.cx,
          cy: m.cy,
          cz: m.cz,
          bytes: m.data,
          changes: [],
          loaded: false,
          decoding: false,
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
        this.loaded = true;
        this.onLoaded();
        break;
    }
  }
  #drop(key: string): void {
    const entry = this.#chunks.get(key);
    if (!entry) return;
    this.#chunks.delete(key);
    if (entry.loaded) this.world.removeChunk(entry.cx, entry.cy, entry.cz);
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
    decodeChunk(bytes).then(
      (chunk) => {
        if (this.#chunks.get(key) !== entry || this.#closed) return;
        this.world.addChunk(entry.cx, entry.cy, entry.cz, chunk);
        entry.loaded = true;
        entry.decoding = false;
        entry.bytes = undefined;
        if (entry.changes.length) this.world.setBlocks(entry.changes);
        entry.changes = [];
      },
      (error) => this.onError(error),
    );
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
      this.#runs = [];
      this.#pending = 0;
      this.#time = 0;
      for (let i = 0; i < 3; i++) this.renderPosition[i] = this.#previous[i] = m.position[i];
      this.spawned = true;
      this.#center = '';
      this.#decodeNear();
      this.onSpawn();
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
      decoded = this.#codec.decode(data, this.#entities);
    // Server clock: the least delayed arrival so far, drifting up slowly in case the clocks run apart.
    this.#offset = Math.min(now - time, this.#offset + 0.0005);
    for (const [id, state] of decoded) {
      if (id === this.welcome?.id) continue;
      let other = this.players.get(id);
      if (!other) {
        other = { id, buffer: new SnapshotBuffer(32, 0.25), snapshot: createSnapshot() };
        this.players.set(id, other);
      }
      // Every player every message (a still one too), so the buffer does not extrapolate a stopped player onwards.
      const p = state.position,
        last = other.last,
        span = last ? time - last.time : 0,
        velocity = last && span > 0 ? p.map((v, i) => (v - last.position[i]) / span) : [0, 0, 0];
      if (other.buffer.push(time, p, state.rotation, velocity)) other.last = { time, position: [p[0], p[1], p[2]] };
    }
    for (const id of this.players.keys()) if (!decoded.has(id)) this.players.delete(id);
    this.#entities = decoded;
  }
}

/**
 * Connects a {@link VoxelNetClient} to a voxel-net server with the browser's WebSocket.
 * @throws MargoError `'unsupported'` where there is no global WebSocket.
 * @throws as the {@link VoxelNetClient} constructor.
 */
export function connectVoxelNet(
  url: string | URL,
  world: VoxelWorld,
  options: VoxelNetClientOptions = {},
): VoxelNetClient {
  if (typeof WebSocket !== 'function')
    throw new MargoError('unsupported', 'connectVoxelNet needs a global WebSocket; use a browser or Node 22+');
  const socket = new WebSocket(url),
    queue: Uint8Array[] = [];
  socket.binaryType = 'arraybuffer';
  const client = new VoxelNetClient(
    world,
    {
      send: (data) => (socket.readyState === 1 ? socket.send(data as Uint8Array<ArrayBuffer>) : queue.push(data)),
      close: () => socket.close(),
    },
    options,
  );
  socket.addEventListener('open', () => {
    for (const data of queue.splice(0)) socket.send(data as Uint8Array<ArrayBuffer>);
  });
  socket.addEventListener('message', (event) => client.receive(new Uint8Array(event.data as ArrayBuffer)));
  socket.addEventListener('close', () => client.close());
  return client;
}
