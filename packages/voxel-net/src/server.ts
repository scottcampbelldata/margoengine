// @margoengine/voxel-net/server: the authoritative Node server (design: packages/voxel-net/DESIGN.md, "Server").
// One VoxelWorld holds the chunks within simulation distance of some player; chunks a client only sees go out from a
// cache of finished messages, made by worker threads that run the generator and encodeChunk. Every tick it runs the
// players' movement steps and edits in arrival order, moves each client's view, and writes corrections, block changes,
// players and paced chunks to each client in one corked write. This module is also the generator thread's script.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { MargoError } from '@margoengine/math/errors';
import { type BlockType, BlockTypes, chunkKey, type PackedChunk, VoxelChunk, VoxelWorld } from '@margoengine/voxel';
import { encodeBlockChanges, encodeChunk, EntityCodec, type PreparedEntity } from '@margoengine/voxel/codec';
import { type NoiseTerrainOptions, noiseTerrain, type VoxelGenerate } from '@margoengine/voxel/generate';
import { VoxelCharacter, type VoxelCharacterOptions } from '@margoengine/voxel/query';
import {
  blockTableHash,
  type ClientMessage,
  decodeClientMessage,
  encodeServerMessage,
  Keys,
  moveIntent,
  PLAYER_SCHEMA,
  PROTOCOL_VERSION,
  STEP_SECONDS,
  type ServerMessage,
} from './protocol.js';
import { acceptWebSocket, type WebSocketConnection } from './websocket.js';

/** Options of {@link VoxelServer}. Distances in chunks unless named otherwise. */
export interface VoxelServerOptions {
  /** The game's block types; clients must use the same ones. */
  blocks: BlockTypes;
  /**
   * Where chunks come from: options of the built-in `noiseTerrain` (default `{}`), or the path or file URL of an ES
   * module whose default export is a `VoxelGenerate` function, run in worker threads.
   */
  generator?: NoiseTerrainOptions | string | URL;
  /** Generator worker threads. Default a quarter of the logical cores, 1 to 8. */
  workers?: number;
  /** Ticks per second, 1..60. Default 20. */
  tickRate?: number;
  /** View distance a client gets when it asks for none, across (a circle). Default 6. */
  view?: number;
  /** Largest view distance a client may ask for (the least is 2). Default 8. */
  maxView?: number;
  /** View distance up and down. Default 3. */
  viewHeight?: number;
  /** Chunks held in full around each player (physics, edits), across. Default 3. */
  simulation?: number;
  /** Simulation distance up and down. Default 2. */
  simulationHeight?: number;
  /** Other players a client hears about, in blocks. Default 96. */
  playerDistance?: number;
  /** Most players at once. Default 1000. */
  maxPlayers?: number;
  /** Whether players may fly. Default false. */
  flight?: boolean;
  /** Edit reach in blocks from the eye to the cell centre (one more block of slack is allowed). Default 6. */
  reach?: number;
  /** Edits per second a player may make on average. Default 10. */
  editRate?: number;
  /** Edits a player may make at once. Default 5. */
  editBurst?: number;
  /** Spawn column (x, z) of player `id`. Default a random column within 64 blocks of the origin. */
  spawn?: (id: number) => readonly [x: number, z: number];
  /** Bytes of finished chunk messages to keep. Default 256 MiB. */
  cacheBytes?: number;
  /**
   * Which web pages may connect, by their `Origin` header. Default: only pages served from the server's own host (the
   * Origin must be `http://` or `https://` plus the `Host` header). `'*'` allows any page; a list allows exactly those
   * origins (and refuses clients that send none). Without a list, clients that send no Origin (Node, bots) connect.
   * A refused page gets HTTP 403 with a message that names this option.
   */
  origins?: readonly string[] | '*';
  /**
   * Connections that have not yet joined (no hello yet, or still being authenticated), all addresses together. The
   * next upgrade is answered with HTTP 503 before any player object exists. Default 64.
   */
  maxPending?: number;
  /**
   * Such connections from one IP address; the next gets HTTP 429. Default 8. Behind a reverse proxy every client has
   * the proxy's address: raise it there and limit per address in the proxy.
   */
  maxPerAddress?: number;
  /** Milliseconds a new connection has to send its hello before it is closed with 1008. Default 3,000. */
  helloTimeout?: number;
  /**
   * Your login check. Called on the upgrade request (`hello` undefined: read a cookie or a token header), then again
   * on the hello. `true` lets the client on; a non-empty string does too and becomes the player's `identity` (the
   * hello's answer wins); anything else closes it with 1008 `'not authorized'`. A hook that throws, or does not settle
   * within `authTimeout`, closes the client with 1011 and a reason starting `auth-failed` or `auth-timeout`, and the
   * error goes to `onError`. Default none: every client is let on.
   */
  authenticate?: VoxelAuthenticate;
  /** Milliseconds each `authenticate` call may take. Default 5,000. */
  authTimeout?: number;
  /**
   * Edited chunks held in memory. Past it the least recently used edited chunk is saved to `store` and dropped; it is
   * read back from `store` when it is needed again. Without a store, a player edit that would edit one more chunk is
   * refused and `onError` gets a MargoError `'failed'` naming this option (once). Default 65,536.
   */
  maxEditedChunks?: number;
  /**
   * Where edited chunks go when more than `maxEditedChunks` are held, and on {@link VoxelServer.close}: disk, a
   * database, anything with `save` and `load`. Also read when a chunk loads, so a world persists across restarts.
   * Default none (edits last as long as the process).
   */
  store?: VoxelEditStore;
  /** Body of every player; clients must use the same options. */
  character?: VoxelCharacterOptions;
  /** Game rules for edits, after the built-in ones: return false to refuse. */
  allowEdit?: (player: VoxelServerPlayer, x: number, y: number, z: number, state: number, previous: number) => boolean;
}

/**
 * The login check of {@link VoxelServerOptions.authenticate}: `hello` is undefined on the upgrade request and holds
 * the player's chosen name on the hello. Return (or resolve) `true`, or a non-empty string that becomes the player's
 * `identity`, to let the client on; anything else refuses it.
 */
export type VoxelAuthenticate = (
  req: IncomingMessage,
  hello: { name: string } | undefined,
) => boolean | string | Promise<boolean | string>;

/**
 * Storage for edited chunks beyond {@link VoxelServerOptions.maxEditedChunks}: a folder, a key-value database, a
 * cloud bucket. `key` is the chunk position `'cx,cy,cz'`; `chunk` is `VoxelChunk.pack()` output (typed arrays, so
 * `structuredClone`, `v8.serialize` or your own encoding store it). Both may be async.
 *
 * ```ts
 * import { readFile, writeFile } from 'node:fs/promises';
 * import { deserialize, serialize } from 'node:v8';
 * import type { VoxelEditStore } from '@margoengine/voxel-net/server';
 *
 * const store: VoxelEditStore = {
 *   save: (key, chunk) => writeFile(`world/${key}.chunk`, serialize(chunk)),
 *   load: (key) => readFile(`world/${key}.chunk`).then(deserialize, () => undefined),
 * };
 * ```
 */
export interface VoxelEditStore {
  /** Keeps `chunk` under `key`, replacing what was there. A throw or rejection goes to `onError`; the chunk stays in memory. */
  save(key: string, chunk: PackedChunk): void | Promise<void>;
  /** The chunk last saved under `key`, or undefined when there is none (the generator makes it). */
  load(key: string): PackedChunk | undefined | Promise<PackedChunk | undefined>;
}

/** A player as the server holds it. */
export interface VoxelServerPlayer {
  /** Its id, as other clients see it. */
  readonly id: number;
  /** Its display name. */
  readonly name: string;
  /** What `authenticate` returned for it when that was a string (its account), else undefined. */
  readonly identity: string | undefined;
  /** Its body in the server's world, after the steps run so far. */
  readonly character: VoxelCharacter;
  /** Whether it has spawned and moves. */
  readonly spawned: boolean;
}

/** What a {@link VoxelServer} counted since the last {@link VoxelServer.resetMetrics}. */
export interface VoxelServerMetrics {
  /** Milliseconds of work of each tick. */
  tickTimes: number[];
  /** `performance.now()` at the start of each tick. */
  tickStarts: number[];
  /** Times the loop fell more than 5 ticks behind and skipped ahead. */
  skipped: number;
  /** Bytes written to clients by message type, WebSocket frame headers included. */
  bytesOut: Record<ServerMessage['type'], number>;
  /** Bytes read from clients, frame headers included. */
  bytesIn: number;
  /** Corrections sent. */
  corrections: number;
  /** Edits applied. */
  editsAccepted: number;
  /** Edits refused. */
  editsDenied: number;
  /** Chunks made by the generator. */
  chunksGenerated: number;
  /** Players who joined. */
  joins: number;
}

// A chunk position; `d` orders a view nearest first.
interface Spot {
  key: string;
  cx: number;
  cy: number;
  cz: number;
  d: number;
}
// A generator job's result.
interface Generated {
  packed: PackedChunk;
  message: Uint8Array;
  ceiling?: number;
}
// A connection and its player.
interface Client extends VoxelServerPlayer {
  conn: WebSocketConnection;
  name: string;
  identity: string | undefined;
  // 'auth': the hello came and authenticate is running.
  phase: 'hello' | 'auth' | 'joining' | 'spawning' | 'playing' | 'gone';
  // Counted in maxPending and maxPerAddress until it joins or leaves.
  pending: boolean;
  address: string;
  // The upgrade request, kept for authenticate until the client joins.
  request: IncomingMessage | undefined;
  // The upgrade request's authenticate call: true when it let the client on.
  upgradeAuth: Promise<boolean> | undefined;
  view: number;
  queue: ClientMessage[];
  step: number;
  bank: number;
  credited: number;
  correction: number;
  yaw: number;
  pitch: number;
  centered: boolean;
  cx: number;
  cy: number;
  cz: number;
  verified: string;
  sim: Set<string>;
  sent: Map<string, Spot>;
  want: Spot[];
  cursor: number;
  loadedSent: boolean;
  out: Uint8Array[];
  denied: number[];
  baseline: Map<number, PreparedEntity>;
  tokens: number;
  tokenTime: number;
  bytesIn: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const NAMES: Record<number, ServerMessage['type']> = {
    16: 'welcome',
    17: 'chunk',
    18: 'unload',
    19: 'state',
    20: 'blocks',
    21: 'players',
    22: 'loaded',
  },
  BANK = 60, // movement steps a client may save up: 0.5 s
  DRIFT = 1 / 64, // blocks of disagreement before a correction
  EYE = 1.62,
  HIGH_WATER = 256 * 1024, // stop sending chunks to a socket holding this much
  TOO_SLOW = 8 * 1024 * 1024, // drop a client this far behind
  WINDOW = 64, // unsent chunks looked at per client per tick
  CHUNKS_PER_TICK = 64,
  BYTES_PER_TICK = 128 * 1024,
  MAX_STEPS = 240, // movement steps in one input message
  GENERATE_TRIES = 3, // a chunk's generation is tried this often before the players who need it are closed
  RETRY_MS = 250, // wait before the second try; it doubles for each further one
  FAILED_KEPT = 4096; // most chunks whose failures are remembered
const TIMED_OUT: unique symbol = Symbol('timed out');

const later = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms).unref());

const integer = (name: string, value: unknown, min: number, max: number): number => {
  if (typeof value !== 'number') throw new TypeError(`VoxelServer ${name} must be a number`);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new RangeError(`VoxelServer ${name} is ${value}; pass an integer in ${min}..${max}`);
  return value;
};
const positive = (name: string, value: unknown): number => {
  if (typeof value !== 'number') throw new TypeError(`VoxelServer ${name} must be a number`);
  if (!(value > 0 && value < Number.POSITIVE_INFINITY))
    throw new RangeError(`VoxelServer ${name} is ${value}; pass a finite number > 0`);
  return value;
};
const header = (n: number): number => (n < 126 ? 2 : n < 65536 ? 4 : 10);
// A look rotation from the 16-bit yaw and 8-bit pitch: yaw about +y, then pitch about +x.
const rotation = (yaw: number, pitch: number): [number, number, number, number] => {
  const a = (yaw * Math.PI) / 65536,
    b = ((pitch / 127) * Math.PI) / 4,
    cy = Math.cos(a),
    sy = Math.sin(a),
    cp = Math.cos(b),
    sp = Math.sin(b);
  return [cy * sp, sy * cp, -sy * sp, cy * cp];
};

/** The wire message of chunk (cx, cy, cz): its encodeChunk bytes without light, deflated unless they are tiny. */
async function chunkMessage(chunk: VoxelChunk, cx: number, cy: number, cz: number): Promise<Uint8Array> {
  // Both encodes read the chunk now, before either awaits.
  const raw = encodeChunk(chunk, { light: false, compress: false }),
    deflated = encodeChunk(chunk, { light: false }),
    small = await raw;
  return encodeServerMessage({ type: 'chunk', cx, cy, cz, data: small.length <= 64 ? small : await deflated });
}

// The generator thread: this module, started by GeneratorPool with workerData.voxelNetGenerator.
interface GeneratorData {
  voxelNetGenerator: true;
  blocks: BlockType[];
  terrain?: NoiseTerrainOptions;
  module?: string;
}
if (!isMainThread && (workerData as GeneratorData | undefined)?.voxelNetGenerator) void generatorThread(workerData);
async function generatorThread(data: GeneratorData): Promise<void> {
  const port = parentPort as NonNullable<typeof parentPort>,
    generate: VoxelGenerate = data.module ? (await import(data.module)).default : noiseTerrain(data.terrain);
  port.on('message', async ({ id, cx, cy, cz }: { id: number; cx: number; cy: number; cz: number }) => {
    try {
      if (typeof generate !== 'function')
        throw new TypeError('The voxel-net generator module must export a VoxelGenerate function as its default');
      const chunk = new VoxelChunk(),
        ceiling = await generate(chunk, cx, cy, cz, { blocks: data.blocks }),
        packed = chunk.pack(),
        message = await chunkMessage(chunk, cx, cy, cz),
        transfer: ArrayBuffer[] = [packed.palette.buffer as ArrayBuffer, packed.words.buffer as ArrayBuffer];
      if (typeof packed.light !== 'number') transfer.push(packed.light.buffer as ArrayBuffer);
      transfer.push(message.buffer as ArrayBuffer);
      port.postMessage({ id, packed, message, ceiling: Number.isInteger(ceiling) ? ceiling : undefined }, transfer);
    } catch (error) {
      port.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    }
  });
}

// Worker threads running the generator: urgent jobs (chunks a player stands in) go before the others.
class GeneratorPool {
  readonly #workers: { worker: Worker; busy: number }[] = [];
  readonly #urgent: (() => void)[] = [];
  readonly #normal: (() => void)[] = [];
  readonly #jobs = new Map<number, { resolve: (g: Generated) => void; reject: (e: Error) => void; worker: number }>();
  #next = 0;
  constructor(
    readonly size: number,
    readonly data: GeneratorData,
  ) {}
  run(cx: number, cy: number, cz: number, urgent: boolean): Promise<Generated> {
    return new Promise((resolve, reject) => {
      (urgent ? this.#urgent : this.#normal).push(() => {
        const index = this.#pick(),
          slot = this.#workers[index],
          id = ++this.#next;
        slot.busy++;
        this.#jobs.set(id, { resolve, reject, worker: index });
        slot.worker.postMessage({ id, cx, cy, cz });
      });
      this.#pump();
    });
  }
  get queued(): number {
    return this.#urgent.length + this.#normal.length;
  }
  close(): Promise<unknown> {
    return Promise.all(this.#workers.map(({ worker }) => worker.terminate()));
  }
  #pick(): number {
    if (this.#workers.length < this.size) {
      const index = this.#workers.length,
        worker = new Worker(new URL(import.meta.url), { workerData: this.data, name: 'voxel-net-generator' });
      worker.unref();
      worker.on('message', (reply: Generated & { id: number; error?: string }) => {
        const job = this.#jobs.get(reply.id);
        if (!job) return;
        this.#jobs.delete(reply.id);
        this.#workers[index].busy--;
        if (reply.error) job.reject(new MargoError('failed', `Chunk generation failed: ${reply.error}`));
        else job.resolve(reply);
        this.#pump();
      });
      worker.on('error', (error) => {
        for (const [id, job] of this.#jobs)
          if (job.worker === index) {
            this.#jobs.delete(id);
            job.reject(error);
          }
      });
      this.#workers.push({ worker, busy: 0 });
      return index;
    }
    let best = 0;
    for (let i = 1; i < this.#workers.length; i++) if (this.#workers[i].busy < this.#workers[best].busy) best = i;
    return best;
  }
  // Two jobs per worker at most, so one waits while the other compresses.
  #pump(): void {
    while (this.queued && (this.#workers.length < this.size || this.#workers.some((slot) => slot.busy < 2)))
      ((this.#urgent.length ? this.#urgent : this.#normal).shift() as () => void)();
  }
}

/**
 * A voxel-net server: the authoritative world, a WebSocket endpoint and a fixed-rate tick. Clients join through
 * `VoxelNetClient` (browser) or `VoxelBot` (Node).
 *
 * ```ts
 * import { VoxelServer } from '@margoengine/voxel-net/server';
 * const server = new VoxelServer({ blocks, generator: { seed: 7 } });
 * const { port } = await server.listen(8787, '0.0.0.0');
 * ```
 */
export class VoxelServer {
  /** The authoritative world: chunks within simulation distance of some player, and edited ones while needed. */
  readonly world: VoxelWorld;
  /** The block types. */
  readonly blocks: BlockTypes;
  /** Counters since the last {@link VoxelServer.resetMetrics}. */
  metrics: VoxelServerMetrics = VoxelServer.#emptyMetrics();
  /** Receives errors that do not belong to one call: a failed generation, a broken client. Default console.error. */
  onError: (error: unknown) => void = (error) => console.error(error);
  readonly #tickRate: number;
  readonly #view: number;
  readonly #maxView: number;
  readonly #viewHeight: number;
  readonly #simulation: number;
  readonly #simulationHeight: number;
  readonly #playerDistance: number;
  readonly #maxPlayers: number;
  readonly #flight: boolean;
  readonly #reach: number;
  readonly #editRate: number;
  readonly #editBurst: number;
  readonly #spawn: (id: number) => readonly [number, number];
  readonly #cacheBudget: number;
  readonly #origins: readonly string[] | '*' | undefined;
  readonly #maxPending: number;
  readonly #maxPerAddress: number;
  readonly #helloTimeout: number;
  readonly #authenticate: VoxelAuthenticate | undefined;
  readonly #authTimeout: number;
  readonly #maxEdited: number;
  readonly #store: VoxelEditStore | undefined;
  /** Connections not yet joined, all together and per address. */
  #pending = 0;
  readonly #perAddress = new Map<string, number>();
  /** Edited chunks on their way to the store (read back from here until the save finishes). */
  readonly #saving = new Map<string, PackedChunk>();
  /** The last store save of each key still running, so saves of one key run in order. */
  readonly #writes = new Map<string, Promise<void>>();
  #editLimitReported = false;
  readonly #characterOptions: VoxelCharacterOptions | undefined;
  readonly #allowEdit: VoxelServerOptions['allowEdit'];
  readonly #pool: GeneratorPool;
  readonly #codec = new EntityCodec(PLAYER_SCHEMA);
  readonly #hash: number;
  readonly #clients = new Set<Client>();
  readonly #refs = new Map<string, number>(); // players whose simulation range holds the chunk
  readonly #loading = new Map<string, Promise<void>>();
  readonly #edited = new Map<string, VoxelChunk>();
  readonly #versions = new Map<string, number>();
  readonly #cache = new Map<string, { message: Uint8Array; version: number }>();
  readonly #fetching = new Set<string>();
  /** View chunks whose generation failed: the tries so far and when the next may start. */
  readonly #failed = new Map<string, { tries: number; at: number }>();
  readonly #jobs = new Map<string, { job: Promise<Generated>; urgent: boolean }>();
  readonly #ceilings = new Map<string, number>();
  #cacheBytes = 0;
  #changes = new Map<string, number[]>();
  #grid = new Map<string, Client[]>();
  #air: Uint8Array = new Uint8Array(0);
  #nextId = 0;
  #http: Server | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #tick = 0;
  #start = 0;
  #closed = false;
  /**
   * @throws TypeError when `blocks` is not a BlockTypes or an option has the wrong type.
   * @throws RangeError for an option out of range.
   */
  constructor(options: VoxelServerOptions) {
    if (!(options?.blocks instanceof BlockTypes))
      throw new TypeError('VoxelServer needs {blocks}: pass the game BlockTypes');
    const o = options;
    this.blocks = o.blocks;
    this.world = new VoxelWorld({ blocks: o.blocks });
    this.#tickRate = integer('tickRate', o.tickRate ?? 20, 1, 60);
    this.#maxView = integer('maxView', o.maxView ?? 8, 2, 32);
    this.#view = integer('view', o.view ?? 6, 2, this.#maxView);
    this.#viewHeight = integer('viewHeight', o.viewHeight ?? 3, 0, 32);
    this.#simulation = integer('simulation', o.simulation ?? 3, 1, 32);
    this.#simulationHeight = integer('simulationHeight', o.simulationHeight ?? 2, 1, 32);
    this.#playerDistance = positive('playerDistance', o.playerDistance ?? 96);
    this.#maxPlayers = integer('maxPlayers', o.maxPlayers ?? 1000, 1, 65535);
    this.#flight = o.flight ?? false;
    this.#reach = positive('reach', o.reach ?? 6);
    this.#editRate = positive('editRate', o.editRate ?? 10);
    this.#editBurst = positive('editBurst', o.editBurst ?? 5);
    this.#cacheBudget = positive('cacheBytes', o.cacheBytes ?? 256 * 1024 * 1024);
    if (o.spawn !== undefined && typeof o.spawn !== 'function')
      throw new TypeError('VoxelServer spawn must be a function (id) => [x, z]');
    this.#spawn =
      o.spawn ?? (() => [Math.floor(Math.random() * 129) - 64, Math.floor(Math.random() * 129) - 64] as const);
    if (
      o.origins !== undefined &&
      o.origins !== '*' &&
      !(Array.isArray(o.origins) && o.origins.every((origin) => typeof origin === 'string'))
    )
      throw new TypeError("VoxelServer origins must be a list of origins such as ['https://game.example.com'], or '*'");
    this.#origins = o.origins;
    this.#maxPending = integer('maxPending', o.maxPending ?? 64, 1, 1 << 20);
    this.#maxPerAddress = integer('maxPerAddress', o.maxPerAddress ?? 8, 1, 1 << 20);
    this.#helloTimeout = integer('helloTimeout', o.helloTimeout ?? 3000, 1, 600_000);
    if (o.authenticate !== undefined && typeof o.authenticate !== 'function')
      throw new TypeError('VoxelServer authenticate must be a function (req, hello) => boolean | string');
    this.#authenticate = o.authenticate;
    this.#authTimeout = integer('authTimeout', o.authTimeout ?? 5000, 1, 600_000);
    this.#maxEdited = integer('maxEditedChunks', o.maxEditedChunks ?? 65_536, 1, 2 ** 31 - 1);
    if (o.store !== undefined && (typeof o.store?.save !== 'function' || typeof o.store?.load !== 'function'))
      throw new TypeError('VoxelServer store must have save(key, chunk) and load(key) functions');
    this.#store = o.store;
    this.#characterOptions = o.character;
    this.#allowEdit = o.allowEdit;
    this.#hash = blockTableHash(o.blocks);
    const generator = o.generator ?? {},
      data: GeneratorData = { voxelNetGenerator: true, blocks: o.blocks.table.map((type) => ({ ...type })) };
    if (typeof generator === 'string' || generator instanceof URL)
      data.module =
        generator instanceof URL || generator.startsWith('file:')
          ? String(generator)
          : pathToFileURL(resolve(generator)).href;
    else {
      if (!generator || typeof generator !== 'object')
        throw new TypeError('VoxelServer generator must be NoiseTerrainOptions or the path of a generator module');
      data.terrain = structuredClone(generator);
      // A chunk far above the ground: checks the options and block names now, where the error reaches the caller.
      noiseTerrain(data.terrain)(new VoxelChunk(), 0, 1 << 20, 0, { blocks: o.blocks.table });
    }
    this.#pool = new GeneratorPool(
      integer('workers', o.workers ?? Math.max(1, Math.min(8, availableParallelism() >> 2)), 1, 64),
      data,
    );
    this.world.onChange((x, y, z, state) => {
      const cx = x >> 5,
        cy = y >> 5,
        cz = z >> 5,
        key = chunkKey(cx, cy, cz);
      this.#versions.set(key, (this.#versions.get(key) ?? 0) + 1);
      // Most recently edited last: the first entries are the ones to save and drop past maxEditedChunks.
      const chunk = this.#edited.get(key) ?? (this.world.getChunk(cx, cy, cz) as VoxelChunk);
      this.#edited.delete(key);
      this.#edited.set(key, chunk);
      if (this.#edited.size > this.#maxEdited) this.#evict(key);
      const cached = this.#cache.get(key);
      if (cached) {
        this.#cacheBytes -= cached.message.length;
        this.#cache.delete(key);
      }
      let list = this.#changes.get(key);
      if (!list) this.#changes.set(key, (list = []));
      list.push(x, y, z, state);
    });
  }
  /** The players connected now, spawned or not. */
  get players(): VoxelServerPlayer[] {
    return [...this.#clients].filter((c) => c.phase !== 'hello' && c.phase !== 'auth');
  }
  /**
   * Sizes for monitoring: players, connections not yet joined (`pending`) and the addresses they come from, chunks in
   * the world, cached chunk messages and their bytes, edited chunks in memory and on their way to the store, jobs.
   */
  get counts(): {
    players: number;
    pending: number;
    pendingAddresses: number;
    worldChunks: number;
    cachedChunks: number;
    cacheBytes: number;
    editedChunks: number;
    savingChunks: number;
    queuedJobs: number;
  } {
    return {
      players: this.players.length,
      pending: this.#pending,
      pendingAddresses: this.#perAddress.size,
      worldChunks: this.#refs.size,
      cachedChunks: this.#cache.size,
      cacheBytes: this.#cacheBytes,
      editedChunks: this.#edited.size,
      savingChunks: this.#saving.size,
      queuedJobs: this.#pool.queued,
    };
  }
  /** Ticks run since {@link VoxelServer.listen}. */
  get tick(): number {
    return this.#tick;
  }
  /** Clears {@link VoxelServer.metrics}. */
  resetMetrics(): void {
    this.metrics = VoxelServer.#emptyMetrics();
  }
  /**
   * Starts accepting WebSocket clients on `port` (0: any free port) and `host`, and starts the tick.
   * @throws MargoError `'state'` (rejects) when already listening or closed; the server's error when it cannot listen.
   */
  async listen(port = 0, host = '127.0.0.1'): Promise<AddressInfo> {
    if (this.#http || this.#closed)
      throw new MargoError('state', 'VoxelServer is already listening or closed; create a new VoxelServer');
    this.#air = await encodeChunk(new VoxelChunk(), { light: false, compress: false });
    const http = createServer((_req, res) => {
      res.writeHead(426, { 'Content-Type': 'text/plain' });
      res.end('voxel-net: connect with a WebSocket\n');
    });
    http.on('upgrade', (req, socket, head) => {
      const address = req.socket.remoteAddress ?? '',
        conn = acceptWebSocket(req, socket, head, {
          origins: this.#origins,
          maxMessage: 4096,
          // Checked before the 101 answer: a refused flood costs no player object, timer or WebSocket.
          admit: () =>
            this.#pending >= this.#maxPending
              ? ['503 Service Unavailable', `server-busy: ${this.#pending} connections are joining (maxPending)`]
              : (this.#perAddress.get(address) ?? 0) >= this.#maxPerAddress
                ? ['429 Too Many Requests', `too-many: this address has ${this.#maxPerAddress} joining (maxPerAddress)`]
                : undefined,
        });
      if (conn) this.#connect(conn, req, address);
    });
    this.#http = http;
    await new Promise<void>((done, fail) => {
      http.once('error', fail);
      http.listen(port, host, () => done());
    });
    this.#start = performance.now();
    this.#timer = setTimeout(this.#run, 1000 / this.#tickRate);
    return http.address() as AddressInfo;
  }
  /**
   * Stops the tick, closes every connection (1001) and the listener, ends the generator threads and, with a `store`,
   * saves every edited chunk still in memory to it (failures go to `onError`).
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#timer);
    for (const c of [...this.#clients]) c.conn.close(1001, 'server closing');
    const saves = this.#store ? [...this.#edited].map(([key, chunk]) => this.#persist(key, chunk.pack())) : [];
    await Promise.all([
      new Promise<void>((done) => (this.#http ? this.#http.close(() => done()) : done())),
      this.#pool.close(),
      ...saves,
    ]);
  }

  static #emptyMetrics(): VoxelServerMetrics {
    return {
      tickTimes: [],
      tickStarts: [],
      skipped: 0,
      bytesOut: { welcome: 0, chunk: 0, unload: 0, state: 0, blocks: 0, players: 0, loaded: 0 },
      bytesIn: 0,
      corrections: 0,
      editsAccepted: 0,
      editsDenied: 0,
      chunksGenerated: 0,
      joins: 0,
    };
  }

  // Connections.
  #connect(conn: WebSocketConnection, req: IncomingMessage, address: string): void {
    const c: Client = {
      conn,
      id: ++this.#nextId,
      name: '',
      identity: undefined,
      pending: true,
      address,
      request: this.#authenticate ? req : undefined,
      upgradeAuth: undefined,
      phase: 'hello',
      spawned: false,
      character: new VoxelCharacter(this.world, this.#characterOptions),
      view: this.#view,
      queue: [],
      step: 0,
      bank: 0,
      credited: 0,
      correction: 0,
      yaw: 0,
      pitch: 0,
      centered: false,
      cx: 0,
      cy: 0,
      cz: 0,
      verified: '',
      sim: new Set(),
      sent: new Map(),
      want: [],
      cursor: 0,
      loadedSent: false,
      out: [],
      denied: [],
      baseline: new Map(),
      tokens: this.#editBurst,
      tokenTime: performance.now(),
      bytesIn: 0,
      timer: undefined,
    };
    this.#pending++;
    this.#perAddress.set(address, (this.#perAddress.get(address) ?? 0) + 1);
    c.timer = setTimeout(
      () => this.#kick(c, 1008, `no hello within ${this.#helloTimeout} ms (helloTimeout)`),
      this.#helloTimeout,
    );
    this.#clients.add(c);
    conn.onmessage = (bytes) => this.#receive(c, bytes);
    conn.onclose = () => this.#leave(c);
    if (this.#authenticate) c.upgradeAuth = this.#authorize(c, undefined);
  }
  // Takes a client out of maxPending and maxPerAddress, once: when it joins or leaves, whichever comes first.
  #settle(c: Client): void {
    if (!c.pending) return;
    c.pending = false;
    c.request = undefined;
    this.#pending--;
    const n = (this.#perAddress.get(c.address) ?? 1) - 1;
    if (n > 0) this.#perAddress.set(c.address, n);
    else this.#perAddress.delete(c.address);
  }
  #kick(c: Client, code: number, reason: string): void {
    c.conn.close(code, reason);
    this.#leave(c);
  }
  #leave(c: Client): void {
    if (c.phase === 'gone') return;
    c.phase = 'gone';
    (c as { spawned: boolean }).spawned = false;
    clearTimeout(c.timer);
    this.#settle(c);
    this.#clients.delete(c);
    for (const key of [...c.sim]) this.#unref(c, key);
  }
  // Runs authenticate once, within authTimeout; true when it let the client on. Otherwise the client is closed.
  async #authorize(c: Client, hello: { name: string } | undefined): Promise<boolean> {
    const hook = this.#authenticate as VoxelAuthenticate,
      ms = this.#authTimeout,
      when = hello ? 'hello' : 'upgrade request';
    let timer: ReturnType<typeof setTimeout> | undefined, result: unknown;
    try {
      result = await Promise.race([
        (async () => hook(c.request as IncomingMessage, hello))(),
        new Promise<typeof TIMED_OUT>((done) => (timer = setTimeout(() => done(TIMED_OUT), ms))),
      ]);
    } catch (error) {
      if (c.phase === 'gone') return false;
      this.onError(error);
      this.#kick(c, 1011, `auth-failed: authenticate threw on the ${when}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
    if (c.phase === 'gone') return false;
    if (result === TIMED_OUT) {
      this.onError(
        new MargoError(
          'failed',
          `VoxelServer authenticate did not settle within ${ms} ms on the ${when}; resolve it sooner or raise authTimeout`,
        ),
      );
      this.#kick(c, 1011, `auth-timeout: authenticate took over ${ms} ms`);
      return false;
    }
    if (typeof result === 'string' && result !== '') c.identity = result;
    else if (result !== true) {
      this.#kick(c, 1008, 'not authorized');
      return false;
    }
    return true;
  }
  #receive(c: Client, bytes: Uint8Array): void {
    this.metrics.bytesIn += c.conn.bytesIn - c.bytesIn;
    c.bytesIn = c.conn.bytesIn;
    let m: ClientMessage;
    try {
      m = decodeClientMessage(bytes);
    } catch {
      return this.#kick(c, 1002, 'unreadable message');
    }
    if (m.type === 'hello') {
      if (c.phase !== 'hello') return this.#kick(c, 1008, 'hello twice');
      return this.#hello(c, m);
    }
    if (c.phase !== 'playing') return this.#kick(c, 1008, `${m.type} before spawning`);
    if (c.queue.length >= 256) return this.#kick(c, 1008, 'too many messages');
    c.queue.push(m);
  }
  #hello(c: Client, m: Extract<ClientMessage, { type: 'hello' }>): void {
    clearTimeout(c.timer);
    if (m.version !== PROTOCOL_VERSION)
      return this.#kick(c, 1008, `protocol ${m.version}, server speaks ${PROTOCOL_VERSION}`);
    if (!this.#authenticate) return this.#join(c, m);
    c.phase = 'auth';
    void (async () => {
      if (!(await c.upgradeAuth) || c.phase !== 'auth') return;
      if ((await this.#authorize(c, { name: m.name })) && c.phase === 'auth') this.#join(c, m);
    })();
  }
  #join(c: Client, m: Extract<ClientMessage, { type: 'hello' }>): void {
    if (this.players.length >= this.#maxPlayers) return this.#kick(c, 1013, 'server full');
    this.#settle(c);
    c.name = m.name;
    c.view = Math.max(2, Math.min(this.#maxView, m.view || this.#view));
    c.phase = 'joining';
    this.metrics.joins++;
    this.#write(
      c,
      encodeServerMessage({
        type: 'welcome',
        version: PROTOCOL_VERSION,
        id: c.id,
        tickRate: this.#tickRate,
        view: c.view,
        viewHeight: this.#viewHeight,
        simulation: this.#simulation,
        simulationHeight: this.#simulationHeight,
        playerDistance: Math.round(this.#playerDistance),
        blocks: this.#hash,
        flight: this.#flight,
      }),
    );
    const [sx, sz] = this.#spawn(c.id),
      x = Math.floor(sx),
      z = Math.floor(sz);
    this.#ground(c, x, z).then(
      (y) => {
        if (c.phase !== 'joining') return;
        c.character.position = [x + 0.5, y, z + 0.5];
        c.phase = 'spawning';
      },
      (error) => {
        this.onError(error);
        this.#kick(c, 1011, 'could not find ground to spawn on');
      },
    );
  }
  // The cell y above the highest solid block of column (x, z), loading its chunks top down.
  async #ground(c: Client, x: number, z: number): Promise<number> {
    const cx = x >> 5,
      cz = z >> 5,
      column = `${cx},${cz}`,
      table = this.blocks.table;
    // Only for the ceiling: with a store the chunk may hold saved edits, so the generated message is not cached.
    if (!this.#ceilings.has(column))
      await this.#generate({ key: chunkKey(cx, 0, cz), cx, cy: 0, cz, d: 0 }, true, !this.#store);
    const top = Math.min(this.#ceilings.get(column) ?? 255, this.world.maxY);
    for (let cy = top >> 5; cy * 32 + 31 >= this.world.minY && c.phase === 'joining'; cy--) {
      const key = chunkKey(cx, cy, cz);
      this.#ref(c, { key, cx, cy, cz, d: 0 });
      await this.#loading.get(key);
      for (let y = Math.min(top, cy * 32 + 31); y >= cy * 32; y--)
        if (table[this.world.getBlock(x, y, z) & 0xffff]?.solid) return y + 1;
    }
    return top + 1;
  }

  // Chunks: simulation references, generation and the message cache.
  #ref(c: Client, spot: Spot): void {
    if (c.sim.has(spot.key)) return;
    c.sim.add(spot.key);
    const n = (this.#refs.get(spot.key) ?? 0) + 1;
    this.#refs.set(spot.key, n);
    if (n === 1) this.#load(spot);
  }
  #unref(c: Client, key: string): void {
    if (!c.sim.delete(key)) return;
    const n = (this.#refs.get(key) ?? 1) - 1;
    if (n > 0) return void this.#refs.set(key, n);
    this.#refs.delete(key);
    const [cx, cy, cz] = key.split(',').map(Number);
    this.world.removeChunk(cx, cy, cz); // an edited chunk lives on in #edited
  }
  #load(spot: Spot): void {
    const { key, cx, cy, cz } = spot;
    if (this.world.getChunk(cx, cy, cz) || this.#loading.has(key)) return;
    const edited = this.#edited.get(key);
    if (edited) {
      this.#edited.delete(key); // recently used again
      this.#edited.set(key, edited);
      return void this.world.addChunk(cx, cy, cz, edited);
    }
    if (!this.#store && this.#aboveCeiling(spot)) return void this.world.addChunk(cx, cy, cz);
    // A failed generation (or store read) is tried again while a player still needs the chunk; after GENERATE_TRIES
    // the players who need it are closed, since none of them can play (or spawn) without it.
    const done = (async () => {
      for (let tries = 1; ; tries++) {
        try {
          const stored = this.#store ? await this.#stored(key) : undefined;
          let chunk: VoxelChunk | undefined;
          if (stored) chunk = VoxelChunk.unpack(stored);
          else if (!this.#aboveCeiling(spot)) chunk = VoxelChunk.unpack((await this.#generate(spot, true)).packed);
          if (this.#refs.has(key) && !this.world.getChunk(cx, cy, cz))
            this.world.addChunk(cx, cy, cz, this.#edited.get(key) ?? chunk);
          return;
        } catch (error) {
          this.onError(error);
          if (tries >= GENERATE_TRIES) return this.#giveUp(spot);
          await later(RETRY_MS * 2 ** (tries - 1));
          if (this.#closed || !this.#refs.has(key) || this.world.getChunk(cx, cy, cz)) return;
        }
      }
    })().finally(() => this.#loading.delete(key));
    this.#loading.set(key, done);
  }
  // Closes, with 1011, every player whose simulation range or view needs the chunk that could not be generated.
  #giveUp(spot: Spot): void {
    const { key, cx, cy, cz } = spot;
    this.#failed.delete(key);
    for (const c of [...this.#clients])
      if (c.sim.has(key) || (!c.sent.has(key) && c.want.some((s) => s.key === key)))
        this.#kick(
          c,
          1011,
          `chunk ${cx},${cy},${cz} failed to generate ${GENERATE_TRIES} times; tell the server owner to check the generator`,
        );
  }
  #aboveCeiling(spot: Spot): boolean {
    const ceiling = this.#ceilings.get(`${spot.cx},${spot.cz}`);
    return ceiling !== undefined && spot.cy * 32 > ceiling;
  }
  // A generator job for the chunk; an urgent one overtakes a queued ordinary one (that one still runs and is dropped).
  // `cache`: put the message in the cache when the chunk was never edited.
  #generate(spot: Spot, urgent: boolean, cache = true): Promise<Generated> {
    const running = this.#jobs.get(spot.key);
    if (running && (running.urgent || !urgent)) return running.job;
    const job = this.#pool.run(spot.cx, spot.cy, spot.cz, urgent).then(
      (g) => {
        if (this.#jobs.get(spot.key)?.job === job) this.#jobs.delete(spot.key);
        this.metrics.chunksGenerated++;
        if (g.ceiling !== undefined) this.#ceilings.set(`${spot.cx},${spot.cz}`, g.ceiling);
        if (cache && !this.#versions.get(spot.key) && !this.#cache.has(spot.key)) this.#put(spot.key, g.message, 0);
        return g;
      },
      (error) => {
        if (this.#jobs.get(spot.key)?.job === job) this.#jobs.delete(spot.key);
        throw error;
      },
    );
    this.#jobs.set(spot.key, { job, urgent });
    return job;
  }
  // The current message of a chunk from the cache (marked recently used), or undefined.
  #cached(key: string): Uint8Array | undefined {
    const entry = this.#cache.get(key);
    if (!entry || entry.version !== (this.#versions.get(key) ?? 0)) return undefined;
    this.#cache.delete(key);
    this.#cache.set(key, entry);
    return entry.message;
  }
  #put(key: string, message: Uint8Array, version: number): void {
    const old = this.#cache.get(key);
    if (old) {
      this.#cacheBytes -= old.message.length;
      this.#cache.delete(key);
    }
    this.#cache.set(key, { message, version });
    this.#cacheBytes += message.length;
    for (const [oldest, entry] of this.#cache) {
      if (this.#cacheBytes <= this.#cacheBudget) break;
      this.#cache.delete(oldest);
      this.#cacheBytes -= entry.message.length;
    }
  }
  // Starts making the message of a chunk that is not cached: from the world, an edited chunk or the store, as air
  // above the column's ceiling, or by the generator.
  #fetch(spot: Spot): void {
    const { key, cx, cy, cz } = spot;
    if (this.#fetching.has(key)) return;
    const version = this.#versions.get(key) ?? 0,
      chunk = this.world.getChunk(cx, cy, cz) ?? this.#edited.get(key);
    let message: Promise<Uint8Array | undefined> | undefined;
    if (chunk) message = chunkMessage(chunk, cx, cy, cz);
    else if (this.#store)
      message = this.#stored(key).then((stored) =>
        stored ? chunkMessage(VoxelChunk.unpack(stored), cx, cy, cz) : this.#fresh(spot),
      );
    else message = this.#fresh(spot);
    if (!message) return;
    this.#fetching.add(key);
    message.then(
      (bytes) => {
        this.#fetching.delete(key);
        if (bytes && (this.#versions.get(key) ?? 0) === version) this.#put(key, bytes, version);
      },
      (error) => {
        this.#fetching.delete(key);
        this.onError(error);
      },
    );
  }
  // The message of a chunk nobody edited: air above the column's ceiling, or the generator's. Undefined while a job
  // already makes it (it caches it when done) or a failed one waits out its delay.
  #fresh(spot: Spot): Promise<Uint8Array> | undefined {
    const { key, cx, cy, cz } = spot;
    if (this.#aboveCeiling(spot))
      return Promise.resolve(encodeServerMessage({ type: 'chunk', cx, cy, cz, data: this.#air }));
    if (this.#jobs.has(key)) return undefined;
    {
      // #sendChunks asks again every tick: a chunk that failed waits out its delay, and is given up after GENERATE_TRIES.
      const failed = this.#failed.get(key);
      if (failed && performance.now() < failed.at) return undefined;
      return this.#generate(spot, false).then(
        (g) => {
          this.#failed.delete(key);
          return g.message;
        },
        (error) => {
          const tries = (this.#failed.get(key)?.tries ?? 0) + 1;
          this.#failed.delete(key);
          if (tries >= GENERATE_TRIES) this.#giveUp(spot);
          else {
            if (this.#failed.size >= FAILED_KEPT) this.#failed.delete(this.#failed.keys().next().value as string);
            this.#failed.set(key, { tries, at: performance.now() + RETRY_MS * 2 ** (tries - 1) });
          }
          throw error;
        },
      );
    }
  }
  // An edited chunk that is not in memory: on its way to the store, or read back from it.
  async #stored(key: string): Promise<PackedChunk | undefined> {
    return this.#saving.get(key) ?? (await (this.#store as VoxelEditStore).load(key)) ?? undefined;
  }
  // Saves the least recently edited chunks to the store and drops them, until maxEditedChunks are held. A chunk a
  // load, fetch or generator job is busy with stays, so no old message of it can be cached after it leaves.
  #evict(current: string): void {
    if (!this.#store) return;
    for (const [key, chunk] of this.#edited) {
      if (this.#edited.size <= this.#maxEdited) return;
      if (key === current || this.#loading.has(key) || this.#fetching.has(key) || this.#jobs.has(key)) continue;
      this.#edited.delete(key);
      this.#versions.delete(key);
      const cached = this.#cache.get(key);
      if (cached) {
        this.#cacheBytes -= cached.message.length;
        this.#cache.delete(key);
      }
      void this.#persist(key, chunk.pack());
    }
  }
  // One store save; saves of one key run in order. It never rejects: a failure goes to onError and the packed chunk
  // stays in #saving, so loads still find it.
  #persist(key: string, packed: PackedChunk): Promise<void> {
    const store = this.#store as VoxelEditStore,
      before = this.#writes.get(key) ?? Promise.resolve();
    this.#saving.set(key, packed);
    const done = before
      .then(() => store.save(key, packed))
      .then(
        () => {
          if (this.#saving.get(key) === packed) this.#saving.delete(key);
        },
        (error) => this.onError(error),
      )
      .finally(() => {
        if (this.#writes.get(key) === done) this.#writes.delete(key);
      });
    this.#writes.set(key, done);
    return done;
  }

  // The tick.
  #run = (): void => {
    if (this.#closed) return;
    const begin = performance.now();
    try {
      this.#step(begin);
    } catch (error) {
      this.onError(error);
    }
    const end = performance.now(),
      m = this.metrics;
    m.tickTimes.push(end - begin);
    m.tickStarts.push(begin);
    if (m.tickTimes.length > 72_000) {
      m.tickTimes.splice(0, 36_000);
      m.tickStarts.splice(0, 36_000);
    }
    this.#tick++;
    const interval = 1000 / this.#tickRate;
    let next = this.#start + this.#tick * interval;
    if (end - next > 5 * interval) {
      this.#start = end - this.#tick * interval;
      next = end;
      m.skipped++;
    }
    this.#timer = setTimeout(this.#run, Math.max(0, next - end));
  };
  #step(now: number): void {
    const clients = [...this.#clients];
    for (const c of clients) if (c.phase === 'playing') this.#process(c, now);
    for (const c of clients) if (c.phase === 'playing' || c.phase === 'spawning') this.#recenter(c);
    for (const c of clients) if (c.phase === 'spawning') this.#trySpawn(c, now);
    // One prepared (quantized) state per player per tick, shared by every client's players message; the grid finds
    // players near a column.
    const states = new Map<number, PreparedEntity>(),
      grid = new Map<string, Client[]>();
    for (const c of clients) {
      if (c.phase !== 'playing') continue;
      const p = c.character.position,
        column = `${Math.floor(p[0]) >> 5},${Math.floor(p[2]) >> 5}`;
      states.set(c.id, this.#codec.prepare({ position: [p[0], p[1], p[2]], rotation: rotation(c.yaw, c.pitch) }, c.id));
      const list = grid.get(column);
      if (list) list.push(c);
      else grid.set(column, [c]);
    }
    this.#grid = grid;
    const changes = this.#changes,
      reach = Math.ceil(this.#playerDistance / 32),
      d2 = this.#playerDistance ** 2;
    this.#changes = new Map();
    for (const c of clients) {
      if (c.phase === 'gone') continue;
      if (c.conn.buffered > TOO_SLOW) {
        this.#kick(c, 1008, 'too slow to keep up');
        continue;
      }
      c.conn.cork();
      for (const message of c.out) this.#write(c, message);
      c.out = [];
      // Edits in chunks this client has, after its refused edits (so a later change of the same cell wins).
      let list: number[] | undefined = c.denied.length ? c.denied : undefined;
      for (const [key, flat] of changes)
        if (c.sent.has(key)) {
          list ??= [];
          for (const v of flat) list.push(v);
        }
      c.denied = [];
      if (list) this.#write(c, encodeServerMessage({ type: 'blocks', data: encodeBlockChanges(list) }));
      if (c.phase === 'playing') {
        const p = c.character.position,
          px = Math.floor(p[0]) >> 5,
          pz = Math.floor(p[2]) >> 5,
          nearby = new Map<number, PreparedEntity>();
        for (let dz = -reach; dz <= reach; dz++)
          for (let dx = -reach; dx <= reach; dx++) {
            const list = grid.get(`${px + dx},${pz + dz}`);
            if (list)
              for (const other of list) {
                if (other === c) continue;
                const q = other.character.position;
                if ((q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2 <= d2)
                  nearby.set(other.id, states.get(other.id) as PreparedEntity);
              }
          }
        const data = this.#codec.encode(nearby, c.baseline);
        c.baseline = nearby;
        if (data.length > 1) this.#write(c, encodeServerMessage({ type: 'players', tick: this.#tick, data }));
      }
      if (c.phase === 'playing' || c.phase === 'spawning') this.#sendChunks(c);
      c.conn.uncork();
    }
  }
  // Runs a playing client's queued inputs and edits, in the order they came.
  #process(c: Client, now: number): void {
    const ch = c.character;
    c.bank = Math.min(BANK, c.bank + ((now - c.credited) * 120) / 1000);
    c.credited = now;
    while (c.queue.length) {
      const m = c.queue[0];
      if (m.type === 'edit') {
        c.queue.shift();
        this.#edit(c, m, now);
        continue;
      }
      if (m.type !== 'input' || !this.#around(c)) return; // wait for the chunks around the player
      c.queue.shift();
      if (m.step !== c.step + 1) return this.#kick(c, 1002, `input step ${m.step} does not follow ${c.step}`);
      let total = 0;
      for (const run of m.runs) total += run.steps;
      if (total > MAX_STEPS) return this.#kick(c, 1008, `${total} steps in one input`);
      for (const run of m.runs) {
        const intent = moveIntent(run.keys, run.yaw),
          flying = this.#flight && (run.keys & Keys.fly) !== 0;
        for (let i = 0; i < run.steps; i++)
          if (c.bank >= 1) {
            c.bank--;
            ch.flying = flying;
            ch.update(STEP_SECONDS, intent);
          }
        c.yaw = run.yaw;
        c.pitch = run.pitch;
      }
      c.step += total;
      if (m.acked !== c.correction) continue; // the client has not applied the last correction yet
      const p = ch.position,
        q = m.position;
      if ((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2 > DRIFT * DRIFT) {
        c.correction = c.step;
        this.metrics.corrections++;
        c.out.push(
          encodeServerMessage({
            type: 'state',
            spawn: false,
            step: c.step,
            position: p,
            velocity: ch.velocity,
            flying: ch.flying,
          }),
        );
      }
    }
  }
  // The chunks within one chunk of the player are in the world (checked again only when its chunk changes).
  #around(c: Client): boolean {
    const p = c.character.position,
      cx = Math.floor(p[0]) >> 5,
      cy = Math.floor(p[1]) >> 5,
      cz = Math.floor(p[2]) >> 5,
      key = chunkKey(cx, cy, cz);
    if (c.verified === key) return true;
    for (let dy = -1; dy <= 1; dy++) {
      const y = (cy + dy) * 32;
      if (y > this.world.maxY || y + 31 < this.world.minY) continue;
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++) if (!this.world.getChunk(cx + dx, cy + dy, cz + dz)) return false;
    }
    c.verified = key;
    return true;
  }
  #edit(c: Client, m: Extract<ClientMessage, { type: 'edit' }>, now: number): void {
    const { x, y, z, state } = m,
      world = this.world,
      table = this.blocks.table;
    c.tokens = Math.min(this.#editBurst, c.tokens + ((now - c.tokenTime) / 1000) * this.#editRate);
    c.tokenTime = now;
    // Cells the server cannot see (outside the world, unloaded chunks) are refused without an answer.
    if (y < world.minY || y > world.maxY || !world.getChunk(x >> 5, y >> 5, z >> 5)) {
      this.metrics.editsDenied++;
      return;
    }
    const previous = world.getBlock(x, y, z),
      was = table[previous & 0xffff],
      type = table[state & 0xffff],
      p = c.character.position,
      far = this.#reach + 1;
    let ok = c.tokens >= 1 && type !== undefined;
    if (ok) c.tokens--;
    ok &&= (x + 0.5 - p[0]) ** 2 + (y + 0.5 - p[1] - EYE) ** 2 + (z + 0.5 - p[2]) ** 2 <= far * far;
    if (ok)
      ok = state === 0 ? previous !== 0 : previous === 0 || !was || was.liquid || (!was.solid && was.shape === 'cross');
    if (ok && state !== 0 && type.solid && this.#occupied(x, y, z, c)) ok = false;
    if (ok && this.#allowEdit && !this.#allowEdit(c, x, y, z, state, previous)) ok = false;
    if (
      ok &&
      !this.#store &&
      this.#edited.size >= this.#maxEdited &&
      !this.#edited.has(chunkKey(x >> 5, y >> 5, z >> 5))
    ) {
      ok = false;
      if (!this.#editLimitReported) {
        this.#editLimitReported = true;
        this.onError(
          new MargoError(
            'failed',
            `VoxelServer holds maxEditedChunks (${this.#maxEdited}) edited chunks and has no store, so edits to further chunks are refused; pass a store to save them, or raise maxEditedChunks`,
          ),
        );
      }
    }
    if (ok) {
      world.setBlock(x, y, z, state);
      this.metrics.editsAccepted++;
    } else {
      c.denied.push(x, y, z, previous);
      this.metrics.editsDenied++;
    }
  }
  // Whether a player's body overlaps cell (x, y, z): the editor as it is now, others as of the last tick.
  #occupied(x: number, y: number, z: number, editor: Client): boolean {
    const hits = (c: Client): boolean => {
      const p = c.character.position,
        s = c.character.size;
      return (
        x < p[0] + s[0] / 2 &&
        x + 1 > p[0] - s[0] / 2 &&
        y < p[1] + s[1] &&
        y + 1 > p[1] &&
        z < p[2] + s[2] / 2 &&
        z + 1 > p[2] - s[2] / 2
      );
    };
    if (hits(editor)) return true;
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++)
        for (const c of this.#grid.get(`${(x >> 5) + dx},${(z >> 5) + dz}`) ?? [])
          if (c !== editor && hits(c)) return true;
    return false;
  }
  // When the player's chunk changed: its simulation range, its view (nearest first) and unloads past the view's edge.
  #recenter(c: Client): void {
    const p = c.character.position,
      cx = Math.floor(p[0]) >> 5,
      cy = Math.floor(p[1]) >> 5,
      cz = Math.floor(p[2]) >> 5;
    if (c.centered && cx === c.cx && cy === c.cy && cz === c.cz) return;
    c.centered = true;
    c.cx = cx;
    c.cy = cy;
    c.cz = cz;
    const sim = new Set<string>(),
      S = this.#simulation,
      fits = (y: number) => y * 32 <= this.world.maxY && y * 32 + 31 >= this.world.minY;
    for (let dz = -S; dz <= S; dz++)
      for (let dx = -S; dx <= S; dx++) {
        if (dx * dx + dz * dz > S * S) continue;
        for (let dy = -this.#simulationHeight; dy <= this.#simulationHeight; dy++) {
          if (!fits(cy + dy)) continue;
          const key = chunkKey(cx + dx, cy + dy, cz + dz);
          sim.add(key);
          this.#ref(c, { key, cx: cx + dx, cy: cy + dy, cz: cz + dz, d: 0 });
        }
      }
    for (const key of [...c.sim]) if (!sim.has(key)) this.#unref(c, key);
    const V = c.view,
      H = this.#viewHeight,
      want: Spot[] = [];
    for (let dz = -V; dz <= V; dz++)
      for (let dx = -V; dx <= V; dx++) {
        const flat = dx * dx + dz * dz;
        if (flat > V * V) continue;
        for (let dy = -H; dy <= H; dy++)
          if (fits(cy + dy))
            want.push({
              key: chunkKey(cx + dx, cy + dy, cz + dz),
              cx: cx + dx,
              cy: cy + dy,
              cz: cz + dz,
              d: flat + dy * dy,
            });
      }
    want.sort((a, b) => a.d - b.d);
    c.want = want;
    c.cursor = 0;
    for (const [key, s] of c.sent)
      if ((s.cx - cx) ** 2 + (s.cz - cz) ** 2 > (V + 1) ** 2 || Math.abs(s.cy - cy) > H + 1) {
        c.sent.delete(key);
        c.out.push(encodeServerMessage({ type: 'unload', cx: s.cx, cy: s.cy, cz: s.cz }));
      }
  }
  // Spawns a player once the server holds, and the client has been sent, the chunks within one chunk of it.
  #trySpawn(c: Client, now: number): void {
    const p = c.character.position,
      cx = Math.floor(p[0]) >> 5,
      cy = Math.floor(p[1]) >> 5,
      cz = Math.floor(p[2]) >> 5;
    for (let dy = -1; dy <= 1; dy++) {
      const y = (cy + dy) * 32;
      if (y > this.world.maxY || y + 31 < this.world.minY) continue;
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++)
          if (!c.sent.has(chunkKey(cx + dx, cy + dy, cz + dz)) || !this.world.getChunk(cx + dx, cy + dy, cz + dz))
            return;
    }
    c.phase = 'playing';
    (c as { spawned: boolean }).spawned = true;
    c.step = 0;
    c.bank = BANK / 2;
    c.credited = now;
    c.out.push(
      encodeServerMessage({
        type: 'state',
        spawn: true,
        step: 0,
        position: p,
        velocity: c.character.velocity,
        flying: false,
      }),
    );
  }
  // Sends the nearest unsent chunks of the view whose messages are ready, within the per-tick budget.
  #sendChunks(c: Client): void {
    if (c.conn.buffered > HIGH_WATER) return;
    const want = c.want;
    let count = 0,
      bytes = 0,
      scanned = 0;
    for (let i = c.cursor; i < want.length && scanned < WINDOW; i++) {
      const spot = want[i];
      if (c.sent.has(spot.key)) continue;
      scanned++;
      const message = this.#cached(spot.key);
      if (!message) {
        this.#fetch(spot);
        continue;
      }
      this.#write(c, message);
      c.sent.set(spot.key, spot);
      bytes += message.length;
      if (++count >= CHUNKS_PER_TICK || bytes >= BYTES_PER_TICK) break;
    }
    while (c.cursor < want.length && c.sent.has(want[c.cursor].key)) c.cursor++;
    if (c.cursor === want.length && !c.loadedSent && c.phase === 'playing') {
      c.loadedSent = true;
      this.#write(c, encodeServerMessage({ type: 'loaded' }));
    }
  }
  #write(c: Client, message: Uint8Array): void {
    c.conn.send(message);
    this.metrics.bytesOut[NAMES[message[0]]] += message.length + header(message.length);
  }
}

export type { AcceptWebSocketOptions, ConnectWebSocketOptions, WebSocketOptions } from './websocket.js';
export { acceptKey, acceptWebSocket, connectWebSocket, WebSocketConnection } from './websocket.js';
