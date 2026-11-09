// @margoengine/voxel-net/bot: a headless player for load tests (design: packages/voxel-net/DESIGN.md, "Bots and the
// bench"). It joins over a Node WebSocket with the same VoxelNetClient a browser uses, walks in a random direction for
// 3 to 8 s at a time, jumps when blocked, swims up in water, and breaks or places a block within reach at a set rate.
// To stay light it decodes only the chunks within one chunk of itself and, by default, no player updates.
import type { BlockTypes } from '@margoengine/voxel';
import { VoxelWorld } from '@margoengine/voxel';
import { raycastVoxels } from '@margoengine/voxel/query';
import { ResumeLoop, VoxelNetClient, type VoxelNetClientOptions, type VoxelNetClose } from './client.js';
import { Keys } from './protocol.js';
import { type ConnectWebSocketOptions, connectWebSocket, type WebSocketConnection } from './websocket.js';

/** Options of {@link VoxelBot.connect}. */
export interface VoxelBotOptions {
  /** The server, `ws://host:port` or `wss://host/path`. */
  url: string | URL;
  /** The server's block types. */
  blocks: BlockTypes;
  /** Display name. Default `'bot'`. */
  name?: string;
  /** View distance to ask for, in chunks. Default 6. */
  view?: number;
  /** Seconds between edits, alternately a break and a place; 0 for none. Default 2. */
  editInterval?: number;
  /** Block state it places. Default the type named `'stone'`, else id 1. */
  place?: number;
  /** Decode player updates (a full client); otherwise only their bytes are counted. Default false. */
  players?: boolean;
  /** Column (x, z) it walks back towards whenever it is more than `leash` blocks away. Default none. */
  home?: readonly [x: number, z: number];
  /** See `home`, in blocks. Default 64. */
  leash?: number;
  /** Fly where the server allows it while past the leash, so a far `home` is reached over any terrain. Default false. */
  travelHome?: boolean;
  /** Extra request headers of the connection, such as the `Origin` a server's `origins` option asks for. Default none. */
  headers?: Record<string, string>;
  /** For a `wss://` url: the certificate checks, as `connectWebSocket`'s `tls`. Default the system's trusted CAs. */
  tls?: ConnectWebSocketOptions['tls'];
  /** Taking the bot back after a dropped connection, as in `connectVoxelNet`. Default `{ attempts: 5 }`. */
  resume?: VoxelNetClientOptions['resume'];
  /** Random numbers in [0, 1). Default Math.random. */
  random?: () => number;
}

/** An edit a bot asked for, at `time` (milliseconds since the epoch, sub-millisecond: `performance.timeOrigin + now`). */
export interface VoxelBotEdit {
  time: number;
  x: number;
  y: number;
  z: number;
  state: number;
}

/** Milliseconds since the epoch with sub-millisecond precision, comparable between processes on one machine. */
export const clock = (): number => performance.timeOrigin + performance.now();

/**
 * A headless voxel-net player. Create it with {@link VoxelBot.connect}, call {@link VoxelBot.update} at a steady
 * rate (60 per second suits), and read its timings and counters.
 */
export class VoxelBot {
  /** The client it plays through. */
  readonly client: VoxelNetClient;
  /** Its own copy of the world (decoded near itself only). */
  readonly world: VoxelWorld;
  /** Its WebSocket, the latest one after a dropped connection was resumed. */
  connection: WebSocketConnection;
  /** {@link clock} times of joining: connect started, socket open, welcome, spawn, whole view received. */
  readonly times: { connect: number; open: number; welcome?: number; spawn?: number; loaded?: number };
  /** Every edit it asked for. */
  readonly edits: VoxelBotEdit[] = [];
  /** The close code once the connection ended. */
  closeCode: number | undefined;
  /** The close reason once the connection ended. */
  closeReason: string | undefined;
  /** Why it stopped trying, when a dropped connection could not be taken back. */
  resumeFailed: string | undefined;
  readonly #random: () => number;
  readonly #interval: number;
  readonly #place: number;
  readonly #home: readonly [number, number] | undefined;
  readonly #leash: number;
  readonly #travel: boolean;
  #yaw: number;
  #turn = 0;
  #editIn: number;
  #breaking = true;
  #jump = 0;
  #since = 0;
  #from: [number, number] = [0, 0];
  #stuck = 0;
  #bytesBefore = 0;
  #live: WebSocketConnection | undefined;
  #closing = false;
  readonly #loop: ResumeLoop;
  private constructor(
    connection: WebSocketConnection,
    options: VoxelBotOptions,
    times: { connect: number; open: number },
  ) {
    this.connection = connection;
    this.times = times;
    this.#random = options.random ?? Math.random;
    this.#interval = options.editInterval ?? 2;
    const { blocks } = options;
    this.#place = options.place ?? (blocks.table.some((t) => t.name === 'stone') ? blocks.id('stone') : 1);
    this.#home = options.home;
    this.#leash = options.leash ?? 64;
    this.#travel = options.travelHome ?? false;
    this.#yaw = this.#random() * 2 * Math.PI;
    this.#editIn = this.#interval * (0.5 + this.#random());
    this.world = new VoxelWorld({ blocks });
    this.client = new VoxelNetClient(this.world, this.#transport(connection), {
      name: options.name ?? 'bot',
      view: options.view ?? 6,
      decodeDistance: 1,
      players: options.players ?? false,
    });
    this.client.onSpawn = () => {
      this.times.spawn = clock();
    };
    this.client.onLoaded = () => {
      this.times.loaded = clock();
    };
    // Later tries ask the same way; one that comes in after its time is closed by #transport's caller.
    let opening = 0;
    this.#loop = new ResumeLoop(
      this.client,
      options.resume,
      async () => {
        const mine = ++opening,
          next = await connectWebSocket(options.url, { headers: options.headers, tls: options.tls });
        if (mine !== opening) {
          next.close();
          throw new RangeError('This connection came after its try was over; the next try makes its own');
        }
        return this.#transport(next);
      },
      () => {
        opening++;
        const old = this.#live;
        this.#live = undefined;
        old?.close();
      },
      (close) => this.#ended(close),
    );
  }
  // A connection's calls for the client, and its events for this bot.
  #transport(connection: WebSocketConnection): { send(data: Uint8Array): void; close(): void } {
    this.#live = connection;
    this.#bytesBefore += this.connection === connection ? 0 : this.connection.bytesIn;
    this.connection = connection;
    connection.onmessage = (data) => {
      if (this.#live !== connection) return;
      this.client.receive(data);
      this.#loop.heard();
      if (this.times.welcome === undefined && this.client.welcome) this.times.welcome = clock();
    };
    connection.onclose = (code, reason) => {
      if (this.#live !== connection) return;
      if (this.#closing || !this.#loop.drop(code, reason)) this.#ended({ code, reason, byClient: this.#closing });
    };
    return {
      send: (data) => connection.send(data),
      close: () => {
        this.#closing = true;
        this.#loop.stop();
        const live = this.#live;
        if (live) live.close();
        else this.#ended({ code: 1000, reason: '', byClient: true });
      },
    };
  }
  #ended(close: VoxelNetClose): void {
    if (this.closeCode !== undefined) return;
    this.closeCode = close.code;
    this.closeReason = close.reason;
    this.resumeFailed = close.resumeFailed;
    this.client.close();
    this.client.onClose(close);
  }
  /** Bytes read so far, over every connection it has had. */
  get bytesIn(): number {
    return this.#bytesBefore + this.connection.bytesIn;
  }
  /**
   * Opens a connection and joins.
   * @throws as `connectWebSocket` (rejects) when the server cannot be reached.
   */
  static async connect(options: VoxelBotOptions): Promise<VoxelBot> {
    const connect = clock(),
      connection = await connectWebSocket(options.url, { headers: options.headers, tls: options.tls });
    return new VoxelBot(connection, options, { connect, open: clock() });
  }
  /** Plays `dt` seconds: steers, moves through the client, and edits when its timer runs out. */
  update(dt: number): void {
    const client = this.client,
      player = client.player;
    if (!client.spawned || this.closeCode !== undefined) return;
    const p = player.position;
    // Steer: a new random heading every 3-8 s, or towards home when past the leash, or when stuck for a while.
    this.#turn -= dt;
    const away = !!this.#home && (p[0] - this.#home[0]) ** 2 + (p[2] - this.#home[1]) ** 2 > this.#leash ** 2;
    if (this.#home && away) {
      if (this.#turn <= 0) {
        this.#yaw = Math.atan2(-(this.#home[0] - p[0]), -(this.#home[1] - p[2])) + (this.#random() - 0.5);
        this.#turn = 2;
      }
    } else if (this.#turn <= 0 || this.#stuck >= 4) {
      this.#yaw = this.#random() * 2 * Math.PI;
      this.#turn = 3 + 5 * this.#random();
      this.#stuck = 0;
    }
    // Blocked: under 0.4 blocks of headway in half a second means jump for a moment.
    this.#since += dt;
    if (this.#since >= 0.5) {
      const moved = Math.hypot(p[0] - this.#from[0], p[2] - this.#from[1]);
      if (moved < 0.4) {
        this.#jump = 0.3;
        this.#stuck++;
      } else this.#stuck = 0;
      this.#from = [p[0], p[2]];
      this.#since = 0;
    }
    this.#jump -= dt;
    const keys =
      Keys.forward |
      (this.#jump > 0 || player.inLiquid ? Keys.jump : 0) |
      (away && this.#travel && client.welcome?.flight ? Keys.fly : 0);
    client.update(dt, { keys, yaw: this.#yaw, pitch: 0 });
    if (this.#interval > 0 && (this.#editIn -= dt) <= 0) {
      this.#editIn += this.#interval;
      this.#edit();
    }
  }
  /** Leaves: closes the connection. */
  close(): void {
    this.client.close();
  }
  // Looks down ahead and breaks the block it sees, or places one against it, alternately.
  #edit(): void {
    const p = this.client.player.position,
      pitch = -0.6 - 0.4 * this.#random(),
      yaw = this.#yaw + (this.#random() - 0.5),
      eye = [p[0], p[1] + 1.62, p[2]] as const,
      hit = raycastVoxels(
        this.world,
        eye,
        [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)],
        5,
      );
    if (!hit) return;
    const [x, y, z] = this.#breaking ? hit.cell : hit.adjacent,
      state = this.#breaking ? 0 : this.#place,
      size = this.client.player.size;
    if (!this.#breaking) {
      if (this.world.getBlock(x, y, z) !== 0) return;
      const inside =
        x < p[0] + size[0] / 2 &&
        x + 1 > p[0] - size[0] / 2 &&
        y < p[1] + size[1] &&
        y + 1 > p[1] &&
        z < p[2] + size[2] / 2 &&
        z + 1 > p[2] - size[2] / 2;
      if (inside) return;
    }
    if (this.client.edit(x, y, z, state)) {
      this.edits.push({ time: clock(), x, y, z, state });
      this.#breaking = !this.#breaking;
    }
  }
}
