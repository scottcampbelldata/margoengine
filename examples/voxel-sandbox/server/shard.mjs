// One Plaza world in one process, forked by router.mjs: a VoxelServer on 127.0.0.1 with the square's edit rule, names
// from the word lists, identities from identity.mjs, rolling snapshots and a fixed span. A world's state is on disk and
// its end time is absolute, so a shard killed at any moment restarts into the same world from its newest snapshot.
// When the span ends it writes the final snapshot, closes every client with 1001 (a page sees that on its own socket
// and asks /join again) and exits; the router forks the next world.
import { randomInt } from 'node:crypto';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VoxelServer } from '@margoengine/voxel-net/server';
import { defineBlocks } from '../src/blocks.ts';
import { encodeCounts } from '../src/counts.ts';
import { plazaFinds } from '../src/finds.ts';
import { isPlazaName, randomName } from '../src/names.ts';
import { isPlazaProtected, PLAZA_RING_CANDIDATES, plazaFloor, plazaSpawnRing } from '../src/plaza.ts';
import { GEM_TOTAL } from '../src/plaza-area.ts';
import { PlazaCounts } from './counts.mjs';
import { HOST, identityOfRequest, loadSalt } from './identity.mjs';
import { areaOf } from './reports.mjs';
import { listRolling, pruneRolling, rollingAtOrBefore, writeRolling, writeSnapshot, writeWhole } from './snapshots.mjs';

export { HOST };

/** The application close code of a player idle for `idleMs`, sent with the reason `IDLE_REASON`. A page must not rejoin on it. */
export const IDLE_CLOSE_CODE = 4410;
export const IDLE_REASON = 'idle';

export const SHARD_DEFAULTS = Object.freeze({
  capacity: 200, // plan: 200 until the real network bench measures it
  spanMs: 6 * 3600_000,
  snapshotMs: 10 * 60_000,
  keepMs: 6 * 3600_000,
  freezeMs: 5 * 60_000,
  maxEditedChunks: 16_384, // about 160 MB at worst; past it edits to further chunks are refused
  perIdentity: 8, // same as nginx's limit_conn
  workers: 1, // generator threads
  beatMs: 1000,
  idleMs: 10 * 60_000, // no movement and no edit for this long closes the player; 0 turns the limit off
  countsSaveMs: 30_000, // finds are written this often when they changed, so a crash loses at most this much of them
  greetMs: 250, // how often new players are looked for: the server has no event for a spawn
});
const TICKS_KEPT = 1200; // 60 s at 20 ticks a second
const MOVED = 0.05; // blocks; less than this between two looks is a player standing still
const END_DELIVERY_MS = 500; // at most this long for one tick to carry the world's last message

const percentile = (sorted, p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;

/** The chunk keys of the 3 x 3 areas around area (cx, cz) that `edits` holds. */
export const inArea = (key, cx, cz) => {
  const [kx, , kz] = key.split(',').map(Number);
  return Math.abs(kx - cx) <= 1 && Math.abs(kz - cz) <= 1;
};

export class PlazaShard {
  /** @type {VoxelServer | undefined} */
  server;
  /** The world on disk: `{ id, shard, seed, floor, startedAt, endsAt, edits, frozen }`. */
  world;
  /** Called with the numbers of each beat. */
  onBeat = () => {};
  /** Called with `{ id, finished }` when the world is over, its final snapshot written and every client closed. */
  onEnded = () => {};
  /** Called when a timer's job failed so that this process cannot go on; the router restarts it from the last snapshot. */
  onFailed = (error) => {
    throw error;
  };
  #o;
  #blocks = defineBlocks().blocks;
  #salt;
  #timers = new Set();
  #queue = Promise.resolve(); // snapshots, rollbacks and the world's end run one at a time
  #gate = false; // true while no edit may land: a rollback or the end of the world
  #edits = 0; // edits accepted, metrics resets included
  #saved = -1; // #edits at the last snapshot
  #ticks = [];
  #beatAt = performance.now();
  #closed = false;
  #snapshotFailures = 0;
  #ring = [];
  // The last sign of life of each player: when it last moved or edited, and where it stood. Keyed by the server's own
  // player object, so an entry goes with its player.
  #activity = new WeakMap();
  #idleClosed = 0;
  #resume = {
    parked: { socket: 0, clientSilent: 0 },
    resumed: 0,
    resumeFailed: { unknown: 0, expired: 0 },
    replaced: 0,
    chunksResent: 0,
    fullResends: 0,
  };
  /** @type {PlazaCounts | undefined} */
  #counts;
  #savedCounts; // what state.json held, until the counts are made from it
  // Players who have had their first counts. Keyed by the server's own player object, so an entry goes with its player.
  #greeted = new WeakSet();
  #flushing = false;

  /**
   * @param {object} options
   * @param {number} options.index The shard's number.
   * @param {string} options.dataDir The installation's data folder.
   * @param {number} [options.port] 0 for any free port.
   * @param {boolean} [options.proxied] Behind nginx: identity comes from its header. Default false.
   * @param {readonly string[] | '*'} [options.origins] Pages that may connect.
   * @param {() => number} [options.now] The clock, in ms. Default Date.now.
   * @param {(id: number) => readonly [number, number]} [options.spawn] Replaces the ring (tests).
   * @param {boolean} [options.quiet] Logs nothing (tests).
   * @param {number} [options.idleMs] A player with no movement and no edit for this long is closed with
   *   `IDLE_CLOSE_CODE` and reason `'idle'`, freeing its place. Heartbeats and pongs do not count. Default 10 minutes; 0 is no limit.
   * @param {number} [options.idleCheckMs] How often idle players are looked for. Default a quarter of `idleMs`, at most 10 s.
   * @param {number} [options.seed] The world's seed instead of a random one (tests).
   * @param {number} [options.countsSaveMs] How often changed finds are written to state.json. Default 30 s.
   * @param {number} [options.greetMs] How often players who just spawned are looked for, to send their counts. Default 250 ms.
   */
  constructor(options) {
    this.#o = { ...SHARD_DEFAULTS, port: 0, proxied: false, origins: [], now: Date.now, log: console.log, ...options };
    if (this.#o.quiet) this.#o.log = () => {};
    this.#salt = loadSalt(this.#o.dataDir);
  }

  get #dir() {
    return join(this.#o.dataDir, `shard-${this.#o.index}`);
  }
  get #worldDir() {
    return join(this.#dir, this.world.id);
  }
  get #stateFile() {
    return join(this.#dir, 'state.json');
  }
  get #finalDir() {
    return join(this.#o.dataDir, 'final');
  }

  /** Loads or makes the world and starts serving. Resolves false when the world was already over: it ended instead. */
  async start() {
    await mkdir(this.#dir, { recursive: true });
    this.world = await this.#loadWorld();
    if (!this.world) await this.#newWorld();
    const restored = await rollingAtOrBefore(this.#worldDir, Number.MAX_SAFE_INTEGER, (path, error) =>
      this.#o.log(`shard ${this.#o.index}: snapshot ${path} is damaged, using an older one: ${error.message}`),
    );
    this.#counts = new PlazaCounts({
      blocks: this.#blocks,
      isGem: (x, y, z) => plazaFinds(this.world.seed).isGem(x, y, z),
      saved: this.#savedCounts,
    });
    this.#edits = this.world.edits ?? 0;
    this.#saved = this.#edits;
    if (this.#o.now() >= this.world.endsAt) {
      await this.#finish(restored.edits);
      this.onEnded({ id: this.world.id, finished: restored.edits.size > 0 });
      return false;
    }
    this.#ring = plazaSpawnRing(this.world.seed, this.#blocks.table);
    const url = new URL('../src/server-generator.ts', import.meta.url);
    url.search = `?seed=${this.world.seed}&plaza=1`;
    this.server = new VoxelServer({
      blocks: this.#blocks,
      generator: url,
      workers: this.#o.workers,
      flight: true,
      origins: this.#o.origins,
      maxPlayers: this.#o.capacity,
      maxPending: 256,
      // Every client has nginx's address here: nginx limits per client, and identities are limited below.
      maxPerAddress: 256,
      maxEditedChunks: this.#o.maxEditedChunks,
      spawn: this.#o.spawn ?? (() => this.#ringSpawn()),
      authenticate: (req) => this.#authenticate(req),
      filterName: (name) => (isPlazaName(name) ? name : randomName()),
      allowEdit: (player, x, y, z, state, previous) => {
        // An edit tried is a sign of life, whether or not the rule lets it land.
        this.#touch(player);
        return this.canEdit(x, y, z) && this.#counts.allow(player.identity, x, y, z, state, previous);
      },
    });
    this.server.world.onChange((x, y, z, state) => {
      if (this.#counts.landed(x, y, z, state)) this.#flushSoon();
    });
    // Worked out here, once, rather than in the middle of a tick when the first opal is dug.
    plazaFinds(this.world.seed).gems;
    this.server.onError = (error) => this.#o.log(`shard ${this.#o.index}: ${error?.message ?? error}`);
    if (restored.edits.size) await this.server.importEdits(restored.edits);
    // The counts are saved more often than the chunks, so after a crash they can be ahead of this world.
    if (this.#counts.reconcile(restored.edits)) await this.#writeState();
    this.address = await this.server.listen(this.#o.port, HOST);
    this.#later(this.world.endsAt - this.#o.now(), () => this.endWorld());
    // A failed snapshot (a full disk) must not end a live world: it is logged and counted in /metrics, and tried again.
    this.#every(this.#o.snapshotMs, () =>
      this.snapshot().catch((error) => {
        this.#snapshotFailures++;
        this.#o.log(`shard ${this.#o.index}: snapshot failed: ${error.message}`);
      }),
    );
    this.#every(this.#o.beatMs, () => this.#beat());
    this.#every(this.#o.greetMs, () => this.#greet());
    this.#every(this.#o.countsSaveMs, () => this.#saveCounts());
    if (this.#o.idleMs > 0)
      this.#every(this.#o.idleCheckMs ?? Math.min(10_000, Math.ceil(this.#o.idleMs / 4)), () => this.closeIdle());
    this.#o.log(
      `shard ${this.#o.index}: world ${this.world.id} seed ${this.world.seed} on ${HOST}:${this.address.port}, ${restored.edits.size} edited chunks restored`,
    );
    return true;
  }

  /** Whether an edit of cell (x, y, z) may land now; the rule VoxelServer's allowEdit asks. */
  canEdit(x, y, z) {
    if (this.#gate || isPlazaProtected(x, y, z, this.world.floor)) return false;
    const frozen = this.world.frozen;
    if (frozen.length) {
      const now = this.#o.now(),
        cx = areaOf(x),
        cz = areaOf(z);
      for (const area of frozen)
        if (area.until > now && Math.abs(cx - area.cx) <= 1 && Math.abs(cz - area.cz) <= 1) return false;
    }
    return true;
  }

  /**
   * Closes every player with no movement and no edit for `idleMs`, and returns how many. Runs on a timer, on the
   * `now` clock of the options; a first look at a player counts as its first sign of life. Movement is a change of
   * position since the last look, because the server tells its hooks about edits and nothing else: a player holding a
   * key against a wall, or only turning its head, counts as idle.
   */
  closeIdle() {
    if (!this.server || this.#closed || !(this.#o.idleMs > 0)) return 0;
    const now = this.#o.now();
    let closed = 0;
    for (const player of this.server.players) {
      // A parked player has no socket to close, and may be on its way back.
      if (!player.connected) continue;
      const [x, y, z] = player.character.position,
        seen = this.#activity.get(player);
      if (!seen) {
        this.#activity.set(player, { at: now, x, y, z });
        continue;
      }
      if ((x - seen.x) ** 2 + (y - seen.y) ** 2 + (z - seen.z) ** 2 > MOVED * MOVED) {
        seen.at = now;
        seen.x = x;
        seen.y = y;
        seen.z = z;
      } else if (now - seen.at >= this.#o.idleMs && !seen.closed) {
        // VoxelServer has no public way to close one player, so this uses the connection on the object it hands out.
        // The place is freed when the socket has finished closing.
        seen.closed = true;
        player.conn.close(IDLE_CLOSE_CODE, IDLE_REASON);
        this.#idleClosed++;
        closed++;
      }
    }
    return closed;
  }
  #touch(player) {
    const seen = this.#activity.get(player);
    if (seen) seen.at = this.#o.now();
    else {
      const [x, y, z] = player.character.position;
      this.#activity.set(player, { at: this.#o.now(), x, y, z });
    }
  }

  /** Whether a player with `identity` is in this world within `distance` blocks of column (x, z). */
  isNear(identity, x, z, distance) {
    return (this.server?.players ?? []).some((player) => {
      if (!player.connected || player.identity !== identity) return false;
      const [px, , pz] = player.character.position;
      return (px - x) ** 2 + (pz - z) ** 2 <= distance * distance;
    });
  }

  /** Opals dug out of the ground in this world. */
  get found() {
    return this.#counts?.found ?? 0;
  }

  /** Writes a rolling snapshot when something changed since the last, and forgets those past the keep time. */
  snapshot() {
    return this.#serial(async () => {
      if (!this.server || this.#gate) return;
      const edits = this.#countedEdits();
      if (edits === this.#saved) return;
      await this.#save(await this.server.exportEdits(), edits);
    });
  }

  /**
   * Rolls the 3 x 3 areas around `area` (`{ cx, cz }`; undefined for the whole world) back to the newest snapshot taken
   * at or before `at`, or to the generator's world when none is that old, then refuses edits there for `freezeMs`.
   * Resolves `{ at, chunks }`: the snapshot's time, and how many chunks it held in the areas.
   */
  rollback(area, at, freezeMs = this.#o.freezeMs) {
    return this.#serial(async () => {
      if (!this.server || this.#closed) throw new Error('This shard is not serving; start it first');
      // exportEdits copies at the call and importEdits works on its own time, so an edit landing anywhere between them
      // would be lost. The gate refuses them for those milliseconds; a refused edit goes back to its player.
      this.#gate = true;
      try {
        const old = await rollingAtOrBefore(this.#worldDir, at),
          edits = area ? await this.server.exportEdits() : old.edits;
        let chunks = old.edits.size;
        if (area) {
          chunks = 0;
          for (const key of [...edits.keys()]) if (inArea(key, area.cx, area.cz)) edits.delete(key);
          for (const [key, packed] of old.edits)
            if (inArea(key, area.cx, area.cz)) {
              edits.set(key, packed);
              chunks++;
            }
        }
        await this.server.importEdits(edits);
        // A rare block the rollback took away goes back to its owner; one it brought back pays nobody a second time.
        this.#counts.reconcile(edits);
        this.#flushSoon();
        const now = this.#o.now();
        this.world.frozen = this.world.frozen.filter((held) => held.until > now);
        if (area && freezeMs > 0) this.world.frozen.push({ cx: area.cx, cz: area.cz, until: now + freezeMs });
        // A crash from here on must not bring the damage back.
        await this.#save(edits, this.#countedEdits());
        this.#o.log(`shard ${this.#o.index}: rolled back ${area ? `area ${area.cx},${area.cz}` : 'the world'}`);
        return { at: old.at ?? null, chunks };
      } finally {
        this.#gate = false;
      }
    });
  }

  /** The snapshots this world can roll back to, as times. */
  async snapshots() {
    return (await listRolling(this.#worldDir)).map((snap) => snap.at);
  }

  /** Ends the world now: final snapshot, every client closed with 1001, `onEnded`. */
  endWorld() {
    return this.#serial(async () => {
      if (!this.server || this.#closed) return;
      this.#gate = true;
      this.#clearTimers();
      await this.#sayEnded();
      const edits = await this.server.exportEdits();
      this.#edits = this.#countedEdits();
      await this.#finish(edits);
      this.#closed = true;
      await this.server.close();
      this.onEnded({ id: this.world.id, finished: edits.size > 0 });
    });
  }

  /** Stops serving and keeps the world: a last snapshot, then every timer and thread gone. */
  shutdown() {
    return this.#serial(async () => {
      if (this.#closed) return;
      this.#closed = true;
      this.#clearTimers();
      if (!this.server) return;
      const edits = this.#countedEdits();
      if (edits !== this.#saved) await this.#save(await this.server.exportEdits(), edits);
      await this.server.close();
    });
  }

  #serial(job) {
    const run = this.#queue.then(job);
    this.#queue = run.then(
      () => {},
      () => {},
    );
    return run;
  }
  #later(ms, job) {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      job().catch((error) => this.#fail(error));
    }, ms);
    this.#timers.add(timer);
  }
  #every(ms, job) {
    const timer = setInterval(() => {
      Promise.resolve()
        .then(job)
        .catch((error) => this.#fail(error));
    }, ms);
    this.#timers.add(timer);
  }
  #clearTimers() {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }
  // A timer's job failed: a full disk or a broken world. Say so and stop, so that the router restarts from the last
  // good snapshot instead of this process running on without saving.
  #fail(error) {
    this.#o.log(`shard ${this.#o.index}: ${error?.stack ?? error}`);
    this.onFailed(error);
  }

  #authenticate(req) {
    const identity = identityOfRequest(req, { proxied: this.#o.proxied, salt: this.#salt });
    if (!identity) return false;
    // Connected only: every tab of one line can come back after a CDN cut, while their parked places wait. So one line
    // holds up to twice perIdentity for at most the server's resumeTimeout, and no longer.
    const mine = this.server.players.filter((player) => player.connected && player.identity === identity).length;
    return mine < this.#o.perIdentity ? identity : false;
  }

  // A dry column on the ring. #chooseSeed gives every new world some; a world still has them after a restart.
  #ringSpawn() {
    return this.#ring[Math.floor(Math.random() * this.#ring.length)];
  }

  // A seed whose ring is mostly dry, so that nobody starts on a sea floor and the square is not an island.
  #chooseSeed() {
    if (this.#o.seed !== undefined) return this.#o.seed;
    for (let tries = 0; ; tries++) {
      const seed = randomInt(2 ** 31 - 1);
      if (tries >= 64 || plazaSpawnRing(seed, this.#blocks.table).length >= PLAZA_RING_CANDIDATES / 2) return seed;
    }
  }

  // Sends the counts to players who have spawned since the last look.
  #greet() {
    if (this.#closed) return;
    for (const player of this.server.players)
      if (player.spawned && !this.#greeted.has(player)) {
        this.#greeted.add(player);
        this.server.send(player, this.#message(player.identity));
      }
  }
  #message(identity, ended = false) {
    return encodeCounts({
      found: this.#counts.found,
      total: GEM_TOTAL,
      counts: this.#counts.countsOf(identity),
      ended,
    });
  }
  // Counts go out at most once per tick, however many edits a tick holds.
  #flushSoon() {
    if (this.#flushing) return;
    this.#flushing = true;
    setImmediate(() => {
      this.#flushing = false;
      if (!this.#closed) this.#flush();
    });
  }
  #flush() {
    const { identities, found } = this.#counts.takeChanges();
    if (found) this.server.broadcast(encodeCounts({ found: this.#counts.found, total: GEM_TOTAL }));
    if (!identities.size) return;
    const messages = new Map();
    for (const player of this.server.players) {
      // One who has not had its first counts gets them from #greet, with these changes in them.
      if (!identities.has(player.identity) || !this.#greeted.has(player)) continue;
      let message = messages.get(player.identity);
      if (!message) messages.set(player.identity, (message = this.#message(player.identity)));
      this.server.send(player, message);
    }
  }
  // Every player's last counts, delivered with a tick, so before the close that follows.
  async #sayEnded() {
    for (const player of this.server.players) this.server.send(player, this.#message(player.identity, true));
    const tick = this.server.tick,
      deadline = performance.now() + END_DELIVERY_MS;
    while (this.server.tick === tick && performance.now() < deadline) await new Promise((done) => setTimeout(done, 5));
  }
  #saveCounts() {
    return this.#serial(async () => {
      if (!this.#closed && !this.#gate && this.#counts.dirty) await this.#writeState();
    });
  }

  #countedEdits() {
    return this.#edits + (this.server?.metrics.editsAccepted ?? 0);
  }

  #beat() {
    const server = this.server,
      m = server.metrics,
      counted = this.#countedEdits();
    const time = performance.now(),
      perSecond = (m.tickTimes.length * 1000) / Math.max(1, time - this.#beatAt);
    this.#beatAt = time;
    this.#ticks.push(...m.tickTimes);
    if (this.#ticks.length > TICKS_KEPT) this.#ticks.splice(0, this.#ticks.length - TICKS_KEPT);
    const sorted = [...this.#ticks].sort((a, b) => a - b),
      bytesOut = Object.values(m.bytesOut).reduce((sum, n) => sum + n, 0),
      beat = {
        players: server.counts.players,
        pending: server.counts.pending,
        editedChunks: server.counts.editedChunks,
        edits: counted - this.#edits,
        ticks: {
          count: sorted.length,
          perSecond,
          p50: percentile(sorted, 0.5),
          p95: percentile(sorted, 0.95),
          max: sorted.at(-1) ?? 0,
          skipped: m.skipped,
        },
        bytesOut,
        bytesIn: m.bytesIn,
        corrections: m.corrections,
        editsDenied: m.editsDenied,
        joins: m.joins,
        chunksGenerated: m.chunksGenerated,
        snapshotFailures: this.#snapshotFailures,
        found: this.#counts.found,
        idleClosed: this.#idleClosed,
        parkedNow: server.counts.parked,
        resume: this.#resume,
        rss: process.memoryUsage.rss(),
      };
    // Kept over the shard's life, because one drop must still show on a /metrics read minutes later.
    const r = this.#resume;
    r.parked.socket += m.parked.socket;
    r.parked.clientSilent += m.parked.clientSilent;
    r.resumed += m.resumed;
    r.resumeFailed.unknown += m.resumeFailed.unknown;
    r.resumeFailed.expired += m.resumeFailed.expired;
    r.replaced += m.replaced;
    r.chunksResent += m.chunksResent;
    r.fullResends += m.fullResends;
    // The metrics arrays grow with every tick: this reset is what keeps them from holding six hours of ticks.
    this.#edits = counted;
    server.resetMetrics();
    this.onBeat(beat);
  }

  // Writes one rolling snapshot and the state that goes with it.
  async #save(edits, counted) {
    const at = this.#o.now();
    await writeRolling(this.#worldDir, at, edits);
    this.#saved = counted;
    this.world.edits = counted;
    await this.#writeState();
    await pruneRolling(this.#worldDir, at - this.#o.keepMs);
  }
  // The counts sit beside the world, not in it: `this.world` also goes to the router, and identities need not.
  async #writeState() {
    await writeWhole(this.#stateFile, JSON.stringify({ ...this.world, counts: this.#counts?.toJSON() }));
    this.#counts?.saved();
  }
  async #loadWorld() {
    const text = await readFile(this.#stateFile, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (text === undefined) return undefined;
    const { counts, ...world } = JSON.parse(text);
    this.#savedCounts = counts;
    return world;
  }
  async #newWorld() {
    // Whatever an earlier run left behind belongs to no world any more; a stale snapshot must never load into this one.
    for (const name of await readdir(this.#dir)) await rm(join(this.#dir, name), { recursive: true, force: true });
    const seed = this.#chooseSeed(),
      startedAt = this.#o.now();
    this.world = {
      id: `s${this.#o.index}-${startedAt.toString(36)}`,
      shard: this.#o.index,
      seed,
      floor: plazaFloor(seed, this.#blocks.table),
      startedAt,
      endsAt: startedAt + this.#o.spanMs,
      edits: 0,
      frozen: [],
    };
    await mkdir(this.#worldDir, { recursive: true });
    await this.#writeState();
  }
  // The world's last act. Safe to repeat after a crash: the state file goes last. A world nobody built in leaves nothing
  // to render or count.
  async #finish(edits) {
    if (edits.size) {
      await mkdir(this.#finalDir, { recursive: true });
      const base = join(this.#finalDir, this.world.id);
      await writeSnapshot(`${base}.bin`, edits);
      await writeWhole(
        `${base}.json`,
        JSON.stringify({
          id: this.world.id,
          shard: this.world.shard,
          seed: this.world.seed,
          floor: this.world.floor,
          startedAt: this.world.startedAt,
          endedAt: this.#o.now(),
          chunks: edits.size,
          edits: this.#edits,
          // The goal is all that outlives a world: who found what goes with its state file.
          found: this.#counts?.found ?? 0,
          total: GEM_TOTAL,
        }),
      );
    }
    await rm(this.#stateFile, { force: true });
    await rm(this.#worldDir, { recursive: true, force: true });
  }
}

// Forked by the router: options in argv as JSON, messages over IPC. Exit code 0 means the router asked, or the world
// ended and it said so first; anything else is a crash, and the router restarts this shard into the same world.
async function main() {
  const shard = new PlazaShard(JSON.parse(process.argv[2])),
    leave = (code) => {
      if (process.connected) process.disconnect();
      process.exit(code);
    },
    send = (message, then = () => {}) => (process.connected ? process.send(message, then) : then()),
    crash = (error) => {
      console.error(error);
      leave(1);
    };
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    shard.shutdown().then(() => leave(0), crash);
  };
  shard.onBeat = (beat) => send({ type: 'beat', beat });
  shard.onEnded = (ended) => send({ type: 'ended', ...ended }, () => leave(0));
  shard.onFailed = crash;
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  // The router died: nobody will restart or route to this process, so leave rather than linger as an orphan.
  process.on('disconnect', stop);
  process.on('message', async (message) => {
    if (message.type === 'shutdown') return stop();
    if (message.type !== 'request') return;
    try {
      let result;
      if (message.name === 'near') result = shard.isNear(message.identity, message.x, message.z, message.distance);
      else if (message.name === 'rollback') result = await shard.rollback(message.area, message.at);
      else if (message.name === 'snapshots') result = await shard.snapshots();
      else throw new TypeError(`Unknown shard request ${message.name}`);
      send({ type: 'reply', id: message.id, result });
    } catch (error) {
      send({ type: 'reply', id: message.id, error: error.message });
    }
  });
  if (await shard.start())
    send({
      type: 'ready',
      host: HOST,
      port: shard.address.port,
      world: shard.world,
      found: shard.found,
      total: GEM_TOTAL,
    });
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
