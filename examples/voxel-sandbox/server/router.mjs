// Plaza's front door: forks one shard.mjs per world, restarts them, and answers the page.
//   GET /join                 where to connect, or full; ?peek=1 only looks, holding no place
//   GET /counters             online, blocksToday, worldsFinished, worldEndsAt
//   GET /finished/index.json  the finished worlds that have a render
//   GET /metrics              shards' numbers; needs the token (env PLAZA_METRICS_TOKEN) as a Bearer header
//   POST /report              a griefing report, { shard, x, z }
//   GET /peer/status          this box's room, and GET /peer/join a place on it; for the other box's router, with the
//                             secret (env PLAZA_PEER_SECRET) as a Bearer header; 404 without that env
// It listens on 127.0.0.1 only, behind nginx. `admin.mjs` talks to it over a local socket nginx cannot reach.
//   node examples/voxel-sandbox/server/router.mjs --data=DIR [--port=8790] [--shard-port=8800] [--proxied]
//     [--origins=a,b or * (default https://margoengine.com)] [--public-url=wss://host/s/{i}] [--capacity=200] [--max-shards=2] [--per-identity=8] [--idle-minutes=10] [--rate-burst=30] [--rate-per-second=5] [--workers=1] [--peer=https://box2.example]
// Run `npm run build:packages` first: the shards import the built packages.
import { fork } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { createServer as createHttp } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { cpus, loadavg } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST, identityOfRequest, loadSalt } from './identity.mjs';
import { areaOf, REPORT_WINDOW, ReportBook } from './reports.mjs';
import { hasWhole, readWhole, writeWhole } from './snapshots.mjs';

const SHARD_FILE = fileURLToPath(new URL('./shard.mjs', import.meta.url)),
  MAX_REPORT_BYTES = 256,
  MAX_COORDINATE = 30_000_000,
  REPORT_REACH = 300, // blocks: past the farthest a client can see (view 8 chunks)
  RESERVE_MS = 5000, // a /join holds a place this long, until the shard's count shows the player
  REQUEST_MS = 2000,
  ROLLBACK_MS = 60_000,
  READY_MS = 60_000,
  SILENT_MS = 30_000, // a shard that sends no beat for this long is stuck
  STABLE_MS = 60_000,
  STOP_MS = 15_000,
  RATE_KEPT = 100_000,
  FINISHED_KEPT = 64,
  ID = /^s\d+-[0-9a-z]+$/,
  SOCKET_URL = /^wss?:\/\//;

/** The page that talks to the router in production: the only origin allowed unless --origins says otherwise. */
export const PRODUCTION_ORIGIN = 'https://margoengine.com';

export const ROUTER_DEFAULTS = Object.freeze({
  port: 0,
  shardPort: 0, // 0: any free port. Fixed in production: nginx maps /s/{i} to shardPort + i.
  proxied: false,
  origins: [PRODUCTION_ORIGIN],
  publicUrl: undefined, // wss://host/s/{i}; default the shard's own ws://127.0.0.1:port
  capacity: 200,
  maxShards: 2,
  restartMs: 1000,
  sweepMs: 60_000,
  headersMs: 5000, // a client has this long to send its headers
  rateBurst: 30, // requests one identity may make at once, on top of ...
  ratePerSecond: 5, // ... this many a second
  now: Date.now,
  load: () => loadavg()[0],
  // The machine's cores, not availableParallelism: that follows the service's CPUQuota down (360% reads as 3), and the
  // free core this is asked about may be any core of the machine.
  cores: () => cpus().length,
  peerPollMs: 5000, // how often --peer is asked for its room; two misses in a row mark it down until a poll succeeds
  peerTimeoutMs: 1500, // the most a poll or a forwarded join may take
  log: console.log,
});

/** The shard a new player goes to: the fullest with room, so that people land together. Undefined when none has any. */
export function pickShard(shards, capacity, now = Date.now()) {
  let best;
  for (const shard of shards) {
    if (shard.state !== 'ready') continue;
    const taken = taking(shard, now);
    if (taken < capacity && (!best || taken > taking(best, now))) best = shard;
  }
  return best;
}
const taking = (shard, now) => {
  shard.reserved = shard.reserved.filter((at) => now - at < RESERVE_MS);
  return shard.online + shard.reserved.length;
};

// Compares without showing, through timing, how much of the secret matched; hashing first makes the lengths equal.
const sameSecret = (given, secret) =>
  timingSafeEqual(createHash('sha256').update(given).digest(), createHash('sha256').update(secret).digest());

const coordinate = (v) => Number.isFinite(v) && Math.abs(v) <= MAX_COORDINATE,
  count = (v) => Number.isInteger(v) && v >= 0;

function newPeer(address, secret) {
  if (!secret)
    throw new TypeError(`--peer=${address} needs the shared secret: set the env PLAZA_PEER_SECRET on both boxes`);
  const url = new URL(address);
  if (!/^https?:$/.test(url.protocol) || url.pathname !== '/' || url.search)
    throw new TypeError(`--peer=${address}: pass the router's base URL, such as https://box2.example`);
  return {
    url: url.origin,
    stop: new AbortController(),
    polling: false,
    up: false,
    misses: 0,
    online: 0,
    room: 0,
    canGrow: false,
    forwards: 0,
    failures: 0,
  };
}

/** Where admin.mjs reaches the router of data folder `dataDir`: a file only the service's user can open. */
export const adminPath = (dataDir) =>
  process.platform === 'win32'
    ? `\\\\.\\pipe\\plaza-admin-${createHash('sha256').update(dataDir).digest('hex').slice(0, 16)}`
    : join(dataDir, 'admin.sock');

export class PlazaRouter {
  /** @type {import('node:net').AddressInfo} */
  address;
  shards = [];
  book = new ReportBook();
  #o;
  #salt;
  #http;
  #admin;
  #timers = new Set();
  #closing = false;
  #totals = { date: '', blocks: 0 };
  #worldsFinished = 0;
  #finishedJson = '[]';
  #rates = new Map();
  #requestId = 0;
  #peer;

  /**
   * @param {object} options Those of {@link ROUTER_DEFAULTS}, and:
   * @param {string} options.dataDir The installation's data folder.
   * @param {string} [options.metricsToken] Without one, /metrics answers 404.
   * @param {string} [options.peer] The base URL of the second box's router: a /join with no place here goes there. Without
   * one, nothing is asked of any other box.
   * @param {string} [options.peerSecret] The secret both boxes share. Without one, /peer/* answers 404.
   * @param {object} [options.shard] More options for each shard (spanMs, snapshotMs and so on).
   */
  constructor(options) {
    this.#o = { ...ROUTER_DEFAULTS, ...options };
    if (!this.#o.dataDir) throw new TypeError('PlazaRouter needs dataDir, the folder its worlds live in');
    mkdirSync(this.#o.dataDir, { recursive: true });
    this.#salt = loadSalt(this.#o.dataDir);
    if (this.#o.peer !== undefined) this.#peer = newPeer(this.#o.peer, this.#o.peerSecret);
  }

  async start() {
    await this.#loadTotals();
    await this.#writeFinishedIndex();
    // Node checks those limits every connectionsCheckingInterval; the default is 30 s.
    this.#http = createHttp({ connectionsCheckingInterval: 1000 }, (req, res) =>
      this.#handle(req, res).catch((error) => {
        this.#o.log(`router: ${error?.stack ?? error}`);
        if (!res.headersSent) this.#json(req, res, 500, { error: 'internal' });
        else res.destroy();
      }),
    );
    // Slow or endless requests hold nothing for long.
    this.#http.headersTimeout = this.#o.headersMs;
    this.#http.requestTimeout = this.#o.headersMs + 5000;
    this.#http.keepAliveTimeout = 5000;
    this.#http.maxHeadersCount = 64;
    this.#http.maxRequestsPerSocket = 1000;
    this.#http.maxConnections = 4096;
    await new Promise((done, fail) => {
      this.#http.once('error', fail);
      this.#http.listen(this.#o.port, HOST, done);
    });
    this.address = this.#http.address();
    await this.#listenAdmin();
    // Every shard that has a live world on disk comes back, and at least the first always runs.
    const live = readdirSync(this.#o.dataDir)
      .map((name) => name.match(/^shard-(\d+)$/))
      .filter((match) => match && Number(match[1]) < this.#o.maxShards)
      .map((match) => Number(match[1]))
      .filter((index) => hasWhole(join(this.#o.dataDir, `shard-${index}`, 'state.json')));
    for (const index of new Set([0, ...live])) this.#startShard(index);
    this.#every(5000, () => this.#watchdog());
    if (this.#peer) {
      void this.#pollPeer();
      this.#every(this.#o.peerPollMs, () => this.#pollPeer());
    }
    this.#every(this.#o.sweepMs, async () => {
      await this.#saveTotals();
      await this.#writeFinishedIndex();
    });
    return this.address;
  }

  /** Stops every shard (they save a snapshot), every timer and the listeners. */
  async close() {
    if (this.#closing) return;
    this.#closing = true;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    this.#peer?.stop.abort();
    await Promise.all(this.shards.map((shard) => this.#stopShard(shard)));
    await this.#saveTotals();
    await new Promise((done) => (this.#admin ? this.#admin.close(done) : done()));
    await new Promise((done) => {
      this.#http.close(done);
      this.#http.closeAllConnections();
    });
  }

  /** `{ online, blocksToday, worldsFinished, worldEndsAt }`. */
  counters() {
    const live = this.shards.filter((shard) => shard.world);
    return {
      online: this.#online() + this.#peerOnline(),
      blocksToday: this.#blocksToday(),
      worldsFinished: this.#worldsFinished,
      worldEndsAt: live.length ? Math.min(...live.map((shard) => shard.world.endsAt)) : null,
    };
  }

  /** The answer of /join for one new player; with `peek`, for a page that only asks whether there is room. */
  join({ peek = false } = {}) {
    const now = this.#o.now(),
      shard = pickShard(this.shards, this.#o.capacity, now);
    if (shard && !peek) shard.reserved.push(now);
    this.#growIfNeeded(now);
    if (!shard)
      // Between worlds or after a crash nothing is ready for a moment: that is not full.
      return this.shards.some((s) => s?.state === 'ready')
        ? { status: 200, body: { full: true, online: this.#online(), retryIn: 30 } }
        : { status: 503, body: { full: false, starting: true, retryIn: 2 } };
    const { index, world, port } = shard;
    return {
      status: 200,
      body: {
        full: false,
        url: this.#o.publicUrl ? this.#o.publicUrl.replace('{i}', String(index)) : `ws://${HOST}:${port}`,
        shard: index,
        world: world.id,
        seed: world.seed,
        floor: world.floor,
        worldEndsAt: world.endsAt,
        found: shard.found,
        total: shard.total,
        now,
        online: this.#online(),
      },
    };
  }

  /**
   * One griefing report from `identity`. Resolves `{ status, body }`; the body's `result` is `counted`, `cooldown` or
   * `rolled-back`.
   */
  async report(identity, { shard: index, x, z }) {
    const now = this.#o.now(),
      shard = this.shards[index];
    if (!this.book.take(identity, now)) return { status: 429, body: { error: 'one-report-a-minute' } };
    if (shard?.state !== 'ready') return { status: 503, body: { error: 'shard-not-ready' } };
    // Only someone standing in that world, near the place, can report it.
    const near = await this.#request(shard, { name: 'near', identity, x, z, distance: REPORT_REACH });
    if (!near) return { status: 403, body: { error: 'not-in-this-world' } };
    const added = this.book.add(shard.world.id, identity, x, z, now);
    if (added.status !== 'rollback') return { status: 202, body: { result: added.status } };
    const at = added.first - REPORT_WINDOW;
    await this.#request(shard, { name: 'rollback', area: { cx: added.cx, cz: added.cz }, at }, ROLLBACK_MS);
    this.#o.log(`router: shard ${index} area ${added.cx},${added.cz} rolled back by reports`);
    return { status: 202, body: { result: 'rolled-back' } };
  }

  // Shards.
  #startShard(index) {
    const shard = this.shards[index] ?? {
      index,
      state: 'stopped',
      child: undefined,
      port: 0,
      world: undefined,
      online: 0,
      reserved: [],
      beat: undefined,
      lastSeen: 0,
      startedAt: 0,
      restarts: 0,
      crashes: 0,
      restartTimer: undefined,
      ended: false,
      pending: new Map(),
    };
    this.shards[index] = shard;
    const port = this.#o.shardPort ? this.#o.shardPort + index : 0,
      options = {
        index,
        dataDir: this.#o.dataDir,
        port,
        proxied: this.#o.proxied,
        origins: this.#o.origins,
        capacity: this.#o.capacity,
        ...this.#o.shard,
      },
      child = fork(SHARD_FILE, [JSON.stringify(options)], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    Object.assign(shard, {
      child,
      state: 'starting',
      online: 0,
      reserved: [],
      beat: undefined,
      world: undefined,
      ended: false,
      restartTimer: undefined,
      startedAt: this.#o.now(),
      lastSeen: performance.now(),
    });
    child.on('message', (message) => this.#fromShard(shard, child, message));
    child.on('error', (error) => this.#o.log(`router: shard ${index}: ${error.message}`));
    // The last messages can still be on their way when 'exit' fires; 'disconnect' comes after they are all read.
    child.once('exit', (code, signal) => {
      if (child.connected) child.once('disconnect', () => this.#shardExited(shard, child, code, signal));
      else this.#shardExited(shard, child, code, signal);
    });
  }

  #fromShard(shard, child, message) {
    if (shard.child !== child) return;
    shard.lastSeen = performance.now();
    switch (message.type) {
      case 'ready':
        shard.state = 'ready';
        shard.port = message.port;
        shard.world = message.world;
        shard.found = message.found;
        shard.total = message.total;
        break;
      case 'beat':
        shard.beat = message.beat;
        shard.online = message.beat.players;
        shard.found = message.beat.found;
        this.#countBlocks(message.beat.edits);
        break;
      case 'ended':
        shard.ended = true;
        shard.state = 'stopped';
        shard.world = undefined;
        if (message.finished) this.#worldsFinished++;
        void this.#writeFinishedIndex().catch((error) => this.#o.log(`router: ${error.message}`));
        break;
      case 'reply': {
        const pending = shard.pending.get(message.id);
        if (!pending) break;
        shard.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.result);
        break;
      }
    }
  }

  #shardExited(shard, child, code, signal) {
    if (shard.child !== child) return;
    shard.child = undefined;
    shard.state = 'stopped';
    shard.online = 0;
    shard.world = undefined;
    for (const pending of shard.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Shard ${shard.index} exited`));
    }
    shard.pending.clear();
    if (this.#closing) return;
    if (shard.ended) {
      // A world ended. An extra shard with nobody to take goes away; otherwise the next world starts at once.
      shard.restarts = 0;
      if (shard.index > 0 && !this.#extraNeeded()) return;
      this.#startShard(shard.index);
      return;
    }
    // A crash: the same world comes back from its newest snapshot, slower each time it keeps failing.
    if (this.#o.now() - shard.startedAt >= STABLE_MS) shard.restarts = 0;
    const wait = Math.min(30_000, this.#o.restartMs * 2 ** shard.restarts);
    shard.restarts++;
    shard.crashes++;
    this.#o.log(`router: shard ${shard.index} exited (${signal ?? code}), restarting in ${wait} ms`);
    shard.restartTimer = setTimeout(() => {
      this.#timers.delete(shard.restartTimer);
      shard.restartTimer = undefined;
      if (!this.#closing) this.#startShard(shard.index);
    }, wait);
    this.#timers.add(shard.restartTimer);
  }

  #stopShard(shard) {
    const child = shard.child;
    if (!child) return Promise.resolve();
    return new Promise((done) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), STOP_MS);
      child.once('exit', () => {
        clearTimeout(timer);
        done();
      });
      if (child.connected) child.send({ type: 'shutdown' });
      else child.kill('SIGTERM');
    });
  }

  // A shard that said nothing for too long is stuck, and a stuck process cannot be told anything.
  #watchdog() {
    const now = performance.now();
    for (const shard of this.shards) {
      if (!shard?.child) continue;
      if (now - shard.lastSeen > (shard.state === 'starting' ? READY_MS : SILENT_MS)) {
        this.#o.log(`router: shard ${shard.index} is silent, killing it`);
        shard.child.kill('SIGKILL');
      }
    }
  }

  // Another shard starts when the rest are nearly full, only while a core is free.
  #growIfNeeded(now) {
    if (this.#canGrow(now)) this.#startShard(this.#freeShard());
  }
  #canGrow(now) {
    return (
      !this.#closing &&
      this.#extraNeeded(now) &&
      this.#o.load() < this.#o.cores() - 1 &&
      this.#freeShard() < this.#o.maxShards
    );
  }
  #freeShard() {
    let index = 0;
    while (index < this.#o.maxShards && (this.shards[index]?.child || this.shards[index]?.restartTimer)) index++;
    return index;
  }
  #extraNeeded(now = this.#o.now()) {
    // A shard on its way back is room on its way: a crash must not start a world beside the one coming back.
    const known = this.shards.filter(Boolean);
    if (known.some((shard) => shard.state === 'starting' || shard.restartTimer)) return false;
    const ready = known.filter((shard) => shard.state === 'ready');
    if (!ready.length) return false;
    const taken = ready.reduce((sum, shard) => sum + taking(shard, now), 0);
    return taken >= ready.length * this.#o.capacity * 0.9;
  }

  #request(shard, request, ms = REQUEST_MS) {
    return new Promise((resolve, reject) => {
      if (!shard.child?.connected) return reject(new Error(`Shard ${shard.index} is not running`));
      const id = ++this.#requestId,
        timer = setTimeout(() => {
          shard.pending.delete(id);
          reject(new Error(`Shard ${shard.index} did not answer ${request.name} within ${ms} ms`));
        }, ms);
      shard.pending.set(id, { resolve, reject, timer });
      shard.child.send({ type: 'request', id, ...request });
    });
  }

  #online() {
    return this.shards.reduce((sum, shard) => sum + (shard?.online ?? 0), 0);
  }

  // The second box. Its answers only ever add a place: whatever goes wrong there, this box answers as it would alone.
  #peerOnline() {
    return this.#peer?.up ? this.#peer.online : 0;
  }

  async #askPeer(path) {
    const { url, stop } = this.#peer,
      response = await fetch(url + path, {
        headers: { Authorization: `Bearer ${this.#o.peerSecret}` },
        redirect: 'error',
        signal: AbortSignal.any([stop.signal, AbortSignal.timeout(this.#o.peerTimeoutMs)]),
      });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error(`${path} answered ${response.status}`);
    }
    return response.json();
  }

  async #pollPeer() {
    const peer = this.#peer;
    if (peer.polling) return;
    peer.polling = true;
    try {
      const { online, room, canGrow } = await this.#askPeer('/peer/status');
      if (!count(online) || !count(room) || typeof canGrow !== 'boolean')
        throw new TypeError('/peer/status answered something else than { online, room, canGrow }');
      if (!peer.up) this.#o.log(`router: peer ${peer.url} is up`);
      Object.assign(peer, { up: true, misses: 0, online, room, canGrow });
    } catch (error) {
      if (this.#closing) return;
      peer.failures++;
      if (++peer.misses >= 2 && peer.up) {
        peer.up = false;
        this.#o.log(`router: peer ${peer.url} is down: ${error.message}`);
      }
    } finally {
      peer.polling = false;
    }
  }

  // A place on the second box, or undefined when it gave none. The place it holds is its own: its capacity, its 5 s hold
  // and its growth count as they do for its own /join.
  async #forwardJoin() {
    const peer = this.#peer;
    try {
      const body = await this.#askPeer('/peer/join');
      if (count(body?.online)) peer.online = body.online;
      if (body?.full === true) {
        peer.room = 0;
        return undefined;
      }
      if (body?.full !== false || typeof body.url !== 'string' || !SOCKET_URL.test(body.url))
        throw new TypeError('/peer/join answered something else than a place or full');
      peer.forwards++;
      return { status: 200, body: { ...body, router: peer.url, online: this.#online() + peer.online } };
    } catch (error) {
      peer.failures++;
      this.#o.log(`router: join forwarded to ${peer.url} failed: ${error.message}`);
      return undefined;
    }
  }

  // /join: a place here, else one on the second box. A peek only reads what the last poll said and holds nothing.
  async #joinEitherBox(peek) {
    const local = this.join({ peek }),
      peer = this.#peer;
    if (!peer) return local;
    if ((local.status !== 200 || local.body.full) && peer.up) {
      if (peek && peer.room > 0)
        return {
          status: 200,
          body: {
            full: false,
            url: peer.url.replace(/^http/, 'ws'),
            router: peer.url,
            online: this.#online() + peer.online,
          },
        };
      if (!peek && (peer.room > 0 || peer.canGrow)) {
        const forwarded = await this.#forwardJoin();
        if (forwarded) return forwarded;
      }
    }
    if (local.body.online !== undefined) local.body.online = this.#online() + this.#peerOnline();
    return local;
  }

  #peerRoute(req, res, route) {
    if (!sameSecret(req.headers.authorization ?? '', `Bearer ${this.#o.peerSecret}`))
      return this.#json(req, res, 401, { error: 'token' });
    if (route === 'GET /peer/join') {
      const { status, body } = this.join();
      return this.#json(req, res, status, body);
    }
    const now = this.#o.now();
    return this.#json(req, res, 200, {
      online: this.#online(),
      room: this.shards.reduce(
        (sum, shard) => (shard?.state === 'ready' ? sum + Math.max(0, this.#o.capacity - taking(shard, now)) : sum),
        0,
      ),
      canGrow: this.#canGrow(now),
    });
  }

  // Counters kept across restarts.
  #today() {
    return new Date(this.#o.now()).toISOString().slice(0, 10);
  }
  #blocksToday() {
    return this.#totals.date === this.#today() ? this.#totals.blocks : 0;
  }
  #countBlocks(edits) {
    const today = this.#today();
    if (this.#totals.date !== today) this.#totals = { date: today, blocks: 0 };
    this.#totals.blocks += edits;
  }
  async #loadTotals() {
    const dir = this.#o.dataDir;
    const text = await readWhole(join(dir, 'totals.json'), 'utf8');
    if (text !== undefined) this.#totals = JSON.parse(text);
    const finals = await this.#finals();
    this.#worldsFinished = finals.length;
  }
  #saveTotals() {
    return writeWhole(join(this.#o.dataDir, 'totals.json'), JSON.stringify(this.#totals));
  }
  // The ids of finished worlds. A world's .json stays when the capture removes its snapshot.
  async #finals() {
    const names = await readdir(join(this.#o.dataDir, 'final')).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    return names.filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5));
  }

  // finished/index.json lists worlds with a render in finished/, newest first. The capture puts <id>.webp there.
  async #writeFinishedIndex() {
    const dir = join(this.#o.dataDir, 'finished');
    await mkdir(dir, { recursive: true });
    const files = new Set(await readdir(dir)),
      entries = [];
    for (const id of await this.#finals()) {
      if (!ID.test(id) || !files.has(`${id}.webp`)) continue;
      const meta = JSON.parse(await readFile(join(this.#o.dataDir, 'final', `${id}.json`), 'utf8'));
      entries.push({
        id,
        seed: meta.seed,
        endedAt: meta.endedAt,
        edits: meta.edits,
        found: meta.found,
        total: meta.total,
        webp: `${id}.webp`,
        ...(files.has(`${id}.png`) ? { png: `${id}.png` } : {}),
      });
    }
    entries.sort((a, b) => b.endedAt - a.endedAt);
    const json = JSON.stringify(entries.slice(0, FINISHED_KEPT));
    if (json === this.#finishedJson && files.has('index.json')) return;
    this.#finishedJson = json;
    await writeWhole(join(dir, 'index.json'), json);
  }

  // HTTP.
  async #handle(req, res) {
    const url = new URL(req.url, 'http://plaza.invalid'),
      route = `${req.method} ${url.pathname}`;
    if (req.method === 'OPTIONS') return this.#preflight(req, res);
    // Before the per-identity bucket: the other box is one address, and it asks for every arrival it cannot place.
    if (this.#o.peerSecret && (route === 'GET /peer/status' || route === 'GET /peer/join'))
      return this.#peerRoute(req, res, route);
    const identity = identityOfRequest(req, { proxied: this.#o.proxied, salt: this.#salt });
    if (!this.#allowRate(identity ?? 'unknown')) return this.#json(req, res, 429, { error: 'slow-down' });
    switch (route) {
      case 'GET /counters':
        return this.#json(req, res, 200, this.counters(), { 'Cache-Control': 'max-age=5' });
      case 'GET /finished/index.json':
        return this.#json(req, res, 200, undefined, { 'Cache-Control': 'max-age=60' }, this.#finishedJson);
      case 'GET /metrics':
        return this.#metrics(req, res);
      case 'GET /join': {
        // Behind the proxy a request with no client address did not come through it.
        if (!identity) return this.#json(req, res, 400, { error: 'no-client-address' });
        const { status, body } = await this.#joinEitherBox(url.searchParams.has('peek'));
        return this.#json(req, res, status, body, status === 503 ? { 'Retry-After': '2' } : {});
      }
      case 'POST /report':
        return this.#reportRoute(req, res, identity);
      default:
        return this.#json(req, res, 404, { error: 'not-found' });
    }
  }

  async #reportRoute(req, res, identity) {
    const origin = req.headers.origin;
    if (this.#o.origins !== '*' && origin !== undefined && !this.#o.origins.includes(origin))
      return this.#json(req, res, 403, { error: 'origin' });
    if (!identity) return this.#json(req, res, 400, { error: 'no-client-address' });
    const body = await this.#readBody(req, res);
    if (body === undefined) return;
    let report;
    try {
      report = JSON.parse(body);
    } catch {
      return this.#json(req, res, 400, { error: 'not-json' });
    }
    const { shard, x, z } = report ?? {};
    if (!Number.isInteger(shard) || shard < 0 || shard >= this.#o.maxShards || !coordinate(x) || !coordinate(z))
      return this.#json(req, res, 400, { error: 'want-shard-x-z' });
    const answer = await this.report(identity, { shard, x, z }).catch((error) => {
      this.#o.log(`router: report: ${error.message}`);
      return { status: 503, body: { error: 'shard-not-ready' } };
    });
    return this.#json(req, res, answer.status, answer.body);
  }

  // The body, or undefined after answering 413 when it is over the limit.
  #readBody(req, res) {
    return new Promise((resolve, reject) => {
      if (Number(req.headers['content-length'] ?? 0) > MAX_REPORT_BYTES) {
        this.#tooLarge(req, res);
        return resolve(undefined);
      }
      const parts = [];
      let size = 0;
      req.on('data', (part) => {
        size += part.length;
        if (size > MAX_REPORT_BYTES) {
          req.removeAllListeners('data');
          this.#tooLarge(req, res);
          resolve(undefined);
        } else parts.push(part);
      });
      req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
      req.on('error', reject);
    });
  }
  #tooLarge(req, res) {
    // Answer, then drop the connection: the rest of the body is not read.
    res.once('finish', () => req.destroy());
    this.#json(req, res, 413, { error: 'too-large' }, { Connection: 'close' });
  }

  #metrics(req, res) {
    const token = this.#o.metricsToken,
      given = req.headers.authorization ?? '';
    if (!token) return this.#json(req, res, 404, { error: 'not-found' });
    if (!sameSecret(given, `Bearer ${token}`)) return this.#json(req, res, 401, { error: 'token' });
    return this.#json(
      req,
      res,
      200,
      {
        at: this.#o.now(),
        load: this.#o.load(),
        cores: this.#o.cores(),
        rss: process.memoryUsage.rss(),
        counters: this.counters(),
        shards: this.shards.filter(Boolean).map((shard) => ({
          index: shard.index,
          state: shard.state,
          world: shard.world?.id,
          seed: shard.world?.seed,
          online: shard.online,
          crashes: shard.crashes,
          ...shard.beat,
        })),
        ...(this.#peer
          ? {
              peer: {
                up: this.#peer.up,
                online: this.#peer.online,
                room: this.#peer.room,
                forwards: this.#peer.forwards,
                failures: this.#peer.failures,
              },
            }
          : {}),
      },
      { 'Cache-Control': 'no-store' },
    );
  }

  #allowRate(key) {
    const now = performance.now();
    let bucket = this.#rates.get(key);
    if (!bucket) {
      if (this.#rates.size >= RATE_KEPT) this.#rates.clear();
      bucket = { tokens: this.#o.rateBurst, at: now };
      this.#rates.set(key, bucket);
    }
    bucket.tokens = Math.min(this.#o.rateBurst, bucket.tokens + ((now - bucket.at) / 1000) * this.#o.ratePerSecond);
    bucket.at = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens--;
    return true;
  }

  // CORS for the page's calls (/join, /report, /counters, /finished): only the allowed origins, or any with `*`. Never
  // for /metrics, which is for the operator's token and not for pages, nor for /peer/*, which is for the other box.
  #cors(req) {
    const path = new URL(req.url, 'http://plaza.invalid').pathname;
    if (path === '/metrics' || (this.#o.peerSecret && path.startsWith('/peer/'))) return {};
    const origin = req.headers.origin;
    if (this.#o.origins === '*') return { 'Access-Control-Allow-Origin': '*' };
    return origin !== undefined && this.#o.origins.includes(origin)
      ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
      : {};
  }
  #preflight(req, res) {
    res.writeHead(204, {
      ...this.#cors(req),
      'Access-Control-Allow-Methods': 'GET, POST',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
    });
    res.end();
  }
  #json(req, res, status, body, headers = {}, text = JSON.stringify(body)) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      ...this.#cors(req),
      ...headers,
    });
    res.end(text);
  }

  #every(ms, job) {
    const timer = setInterval(() => {
      Promise.resolve()
        .then(job)
        .catch((error) => this.#o.log(`router: ${error?.stack ?? error}`));
    }, ms);
    this.#timers.add(timer);
  }

  // The admin socket, for admin.mjs over SSH: one JSON line in, one out.
  async #listenAdmin() {
    const path = adminPath(this.#o.dataDir);
    if (process.platform !== 'win32') await rm(path, { force: true });
    this.#admin = createSocketServer((socket) => {
      socket.setTimeout(ROLLBACK_MS + 5000, () => socket.destroy());
      socket.on('error', () => socket.destroy());
      let text = '';
      socket.on('data', (part) => {
        text += part;
        if (text.length > 4096) return socket.destroy();
        if (!text.includes('\n')) return;
        socket.removeAllListeners('data');
        this.#adminCommand(text).then(
          (answer) => socket.end(`${JSON.stringify(answer)}\n`),
          (error) => socket.end(`${JSON.stringify({ error: error.message })}\n`),
        );
      });
    });
    await new Promise((done, fail) => {
      this.#admin.once('error', fail);
      this.#admin.listen(path, done);
    });
    if (process.platform !== 'win32') await chmod(path, 0o600);
  }
  async #adminCommand(text) {
    const command = JSON.parse(text);
    if (command.name === 'status') return { counters: this.counters(), shards: this.#adminShards() };
    const shard = this.shards[command.shard];
    if (shard?.state !== 'ready') throw new Error(`Shard ${command.shard} is not running`);
    if (command.name === 'snapshots') return { snapshots: await this.#request(shard, { name: 'snapshots' }) };
    if (command.name === 'rollback') {
      const area = command.area ? { cx: areaOf(command.area[0]), cz: areaOf(command.area[1]) } : undefined;
      return await this.#request(shard, { name: 'rollback', area, at: command.at }, ROLLBACK_MS);
    }
    throw new TypeError(`Unknown admin command ${command.name}`);
  }
  #adminShards() {
    return this.shards.filter(Boolean).map(({ index, state, online, crashes, world }) => ({
      index,
      state,
      online,
      crashes,
      world: world?.id,
      endsAt: world?.endsAt,
    }));
  }
}

/** The router options that the command line asks for. */
export function fromArguments(argv) {
  const arg = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3),
    number = (name, fallback) => {
      const value = arg(name);
      if (value === undefined) return fallback;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) throw new RangeError(`--${name}=${value}; pass a whole number`);
      return parsed;
    },
    origins = arg('origins'),
    data = arg('data');
  if (!data) throw new TypeError('Pass --data=DIR, the folder the worlds live in');
  return {
    dataDir: data,
    port: number('port', 8790),
    shardPort: number('shard-port', 8800),
    proxied: argv.includes('--proxied'),
    origins:
      origins === undefined ? ROUTER_DEFAULTS.origins : origins === '*' ? '*' : origins.split(',').filter(Boolean),
    publicUrl: arg('public-url'),
    capacity: number('capacity', ROUTER_DEFAULTS.capacity),
    maxShards: number('max-shards', ROUTER_DEFAULTS.maxShards),
    metricsToken: process.env.PLAZA_METRICS_TOKEN || undefined,
    peer: arg('peer'),
    peerSecret: process.env.PLAZA_PEER_SECRET || undefined,
    rateBurst: number('rate-burst', ROUTER_DEFAULTS.rateBurst),
    ratePerSecond: number('rate-per-second', ROUTER_DEFAULTS.ratePerSecond),
    // The real network bench runs many bots from one address; everyone else keeps the default.
    shard: {
      ...(arg('per-identity') === undefined ? {} : { perIdentity: number('per-identity', 8) }),
      ...(arg('workers') === undefined ? {} : { workers: number('workers', 1) }),
      ...(arg('idle-minutes') === undefined ? {} : { idleMs: number('idle-minutes', 10) * 60_000 }),
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const router = new PlazaRouter(fromArguments(process.argv.slice(2))),
    { port } = await router.start();
  console.log(`Plaza router on ${HOST}:${port}`);
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      router.close().then(
        () => process.exit(0),
        (error) => {
          console.error(error);
          process.exit(1);
        },
      );
    });
}
