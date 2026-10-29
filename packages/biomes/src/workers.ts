/// <reference lib="esnext.disposable" preserve="true" />
// The worker pool of a biome world (B7, entry `@margoengine/biomes/workers`, loaded by BiomeWorld.create only when a
// world uses workers): each worker holds a replica of the world, made from the same options and kept in step with
// every change (paint and mask writes, updates, placements), so a tile made in a worker is byte for byte the tile the
// page's thread would make (the replica runs the same integer code). Jobs carry tile indices and come back as
// transferred typed arrays, so the page never copies a raster. Each worker runs one job at a time; jobs queue per
// worker by priority (nearest tile first), never across a change, and go to the worker that made the neighbouring
// tiles when it is not much busier than the others (its cached world tiles are the ones a placement reads). A queued
// job leaves the queue when its signal aborts; a running one finishes and its reply is dropped. A worker that crashes
// or runs past the time limit is replaced by a fresh one made from the current state, and its jobs reject with
// MargoError 'failed'.
import { fault } from '../../shared/errors.js';
import { reviveError, transferables } from '../../shared/worker.js';
import { umod } from './fixed.js';
import type { BiomeTile, BiomeWorld, LayerWrite, WorldState } from './world.js';
import type { RasterLayer } from './layers.js';

/** A message to a worker and what it answers: plain data and typed arrays. */
export type WorkerMessage = { readonly op: string } & Record<string, unknown>;

interface Job {
  readonly message: WorkerMessage;
  readonly priority: number;
  /** A change every later job must see: jobs never move ahead of it. */
  readonly barrier: boolean;
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  signal?: AbortSignal;
  abort?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  id: number;
}

interface Slot {
  worker: Worker;
  queue: Job[];
  busy?: Job;
}

/** Most milliseconds one job may run before its worker is replaced (a tile takes tens of milliseconds). */
const JOB_LIMIT = 60_000;

/** Default worker count: hardware threads less one for the page, at most 4; none without Web Workers (SSR, Node). */
export function defaultWorkers(): number {
  if (typeof Worker !== 'function' || typeof globalThis.location === 'undefined') return 0;
  return Math.max(1, Math.min(4, (globalThis.navigator?.hardwareConcurrency || 2) - 1));
}

/** The package's worker script, a prebuilt classic worker that bundlers copy as an asset. */
const spawn = (): Worker =>
  new Worker(new URL(/* @vite-ignore */ './workers/biomes.js?no-inline', import.meta.url), {
    name: 'margoengine-biomes',
  });

/** A classifier as a worker gets it: its name (the worker imports the zones entry for a zone classifier). */
const classifierName = (c: unknown) => (c === undefined || c === 'envelopes' ? c : (c as { kind: string }).kind);

/**
 * The workers of one world (`world.workers`), made by `BiomeWorld.create`. A worker started later (or restarted after
 * a crash) gets a replica of the world as it is then, with every placement registered so far; changes reach the
 * workers that exist in the order they happen.
 */
export class BiomeWorkers implements Disposable {
  /** Workers at most (they start when jobs need them). */
  readonly size: number;
  readonly #create: () => Worker;
  readonly #world: BiomeWorld;
  readonly #state: () => WorldState;
  readonly #placements = new Map<number, object>();
  readonly #slots: (Slot | undefined)[];
  #next = 1;
  #disposed = false;

  constructor(size: number, world: BiomeWorld, state: () => WorldState, create = spawn) {
    this.size = size;
    this.#world = world;
    this.#state = state;
    this.#create = create;
    this.#slots = new Array(size).fill(undefined);
  }

  /** The message that makes a replica of the world as it is now, and the copied arrays it moves. */
  #init(): { message: WorkerMessage; transfer: Transferable[] } {
    const w = this.#world,
      s = this.#state(),
      transfer: Transferable[] = [],
      copy = <T extends Int32Array | Float32Array | Uint8Array>(a: T): T => {
        const c = a.slice() as T;
        transfer.push(c.buffer);
        return c;
      },
      h = s.options.height,
      user: LayerWrite[] = [];
    for (const [name, tiles] of s.user)
      for (const [key, data] of tiles) {
        const [x, z] = key.split(',').map(Number);
        user.push({ name, x, z, data: copy(data) });
      }
    return {
      message: {
        op: 'init',
        state: {
          options: {
            seed: w.seed,
            origin: [w.bounds[0], w.bounds[1]],
            size: [w.bounds[2] - w.bounds[0], w.bounds[3] - w.bounds[1]],
            tileSize: w.tileSize,
            resolution: w.resolution,
            regionResolution: w.regionResolution,
            climate: s.options.climate,
            height: h && 'samples' in h ? { ...h, samples: copy(h.samples) } : h,
            biomes: s.biomes,
            classifier: classifierName(s.classifier),
            paint: s.paint,
          },
          user,
          placements: [...this.#placements].map(([pid, options]) => ({ pid, options })),
        },
      },
      transfer,
    };
  }

  /** A tile made by a replica, its arrays moved here. */
  async tile(x: number, z: number, names: readonly string[]): Promise<BiomeTile> {
    const t = await this.run<{
        x: number;
        z: number;
        origin: readonly [number, number];
        cells: number;
        resolution: number;
        layers: RasterLayer[];
      }>({ op: 'tile', x, z, layers: names }, { near: [x, z] }),
      layers = new Map(t.layers.map((l) => [l.name, Object.freeze(l)]));
    return Object.freeze({
      x: t.x,
      z: t.z,
      origin: Object.freeze(t.origin),
      cells: t.cells,
      resolution: t.resolution,
      layers: Object.freeze(t.layers.map((l) => l.name)),
      layer: (name: string) => layers.get(name),
    });
  }

  /** The world's user layer writes, as copies (the caller may reuse its arrays). */
  write(writes: readonly LayerWrite[]): void {
    this.broadcast({
      op: 'write',
      writes: writes.map((w) => ({ name: w.name, x: w.x, z: w.z, data: w.data?.slice(), changed: w.changed })),
    });
  }

  /** A world update; false when it cannot reach a worker (a `field` height is a function). */
  change(changes: { classifier?: unknown; height?: object }): boolean {
    const h = changes.height as { samples?: Int32Array | Float32Array; field?: unknown } | undefined;
    if (h && 'field' in h) return false;
    this.broadcast({
      op: 'update',
      changes: {
        ...changes,
        ...('classifier' in changes ? { classifier: classifierName(changes.classifier) } : {}),
        ...(h?.samples ? { height: { ...h, samples: h.samples.slice() } } : {}),
      },
    });
    return true;
  }

  /** Registers a placement's replica (its id and options); a worker started later gets it too. */
  attach(pid: number, options: object): void {
    this.#placements.set(pid, options);
    this.broadcast({ op: 'placement', pid, options });
  }

  /** A placement's changes (merged into what a worker started later gets). */
  update(pid: number, changes: object): void {
    this.#placements.set(pid, { ...this.#placements.get(pid), ...changes });
    this.broadcast({ op: 'placement-update', pid, changes });
  }

  /** Drops a placement's replica. */
  detach(pid: number): void {
    this.#placements.delete(pid);
    this.broadcast({ op: 'placement-dispose', pid });
  }

  /**
   * Runs `message` on a worker. `near` is the tile the job is about (it goes to that tile's worker unless that one is
   * busier by more than a job); `priority` orders queued jobs, lower first.
   */
  run<T>(
    message: WorkerMessage,
    options: {
      readonly near?: readonly [number, number];
      readonly priority?: number;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    if (this.#disposed)
      return Promise.reject(fault('disposed', 'The biome world is disposed; create a new world', 'biomes'));
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        message,
        priority: options.priority ?? 0,
        barrier: false,
        resolve: resolve as (v: unknown) => void,
        reject,
        signal: options.signal,
        id: this.#next++,
      };
      const slot = this.#pick(options.near);
      if (job.signal) {
        job.abort = () => {
          const at = slot.queue.indexOf(job);
          if (at >= 0) slot.queue.splice(at, 1);
          this.#settle(job);
          reject(job.signal!.reason);
        };
        job.signal.addEventListener('abort', job.abort, { once: true });
      }
      this.#enqueue(slot, job);
      this.#pump(slot);
    });
  }

  /** Sends a change to every worker that exists (a worker started later gets the state that includes it). */
  broadcast(message: WorkerMessage): void {
    if (this.#disposed) return;
    for (const slot of this.#slots) {
      if (!slot) continue;
      const job: Job = {
        message,
        priority: Number.NEGATIVE_INFINITY,
        barrier: true,
        resolve: () => {},
        reject: () => {},
        id: this.#next++,
      };
      slot.queue.push(job);
      this.#pump(slot);
    }
  }

  /** The slot for a job near tile (x, z): its affinity worker (blocks of 4 x 4 tiles), unless it is busier. */
  #pick(near?: readonly [number, number]): Slot {
    const load = (s: Slot | undefined) => (s ? s.queue.length + (s.busy ? 1 : 0) : 0);
    let at = 0;
    if (near) {
      const h = Math.imul(near[0] >> 2, 73856093) ^ Math.imul(near[1] >> 2, 19349663);
      at = umod(h, this.size);
    }
    let best = at;
    for (let i = 0; i < this.size; i++) if (load(this.#slots[i]) + 1 < load(this.#slots[best])) best = i;
    let slot = this.#slots[best];
    if (!slot) {
      slot = { worker: undefined as unknown as Worker, queue: [] };
      this.#spawn(slot);
      this.#slots[best] = slot;
    }
    return slot;
  }

  /** Starts a worker for `slot` and sends it the replica first: made from the current state, it holds every change. */
  #spawn(slot: Slot): void {
    const worker = this.#create(),
      { message, transfer } = this.#init();
    worker.onmessage = ({ data }: MessageEvent) => this.#reply(slot, data);
    worker.onerror = (event: ErrorEvent) => {
      event.preventDefault?.();
      this.#restart(slot, `Biome worker failed: ${event.message || 'unknown error'}; it was restarted`);
    };
    worker.onmessageerror = () => this.#restart(slot, 'Biome worker reply could not be read; it was restarted');
    worker.postMessage({ id: 0, ...message }, transfer);
    slot.worker = worker;
  }

  /** Queues by priority, never ahead of the last change. */
  #enqueue(slot: Slot, job: Job): void {
    const q = slot.queue;
    let at = q.length;
    while (at > 0 && !q[at - 1].barrier && q[at - 1].priority > job.priority) at--;
    q.splice(at, 0, job);
  }

  #pump(slot: Slot): void {
    if (slot.busy || !slot.queue.length || this.#disposed) return;
    const job = slot.queue.shift()!;
    slot.busy = job;
    job.timer = setTimeout(
      () => this.#restart(slot, `A biome worker job ran past ${JOB_LIMIT} ms; the worker was restarted`),
      JOB_LIMIT,
    );
    try {
      // A change goes to every worker as a copy; a job's own arrays move.
      slot.worker.postMessage({ id: job.id, ...job.message }, job.barrier ? [] : [...transferables(job.message)]);
    } catch (error) {
      slot.busy = undefined;
      clearTimeout(job.timer);
      this.#settle(job);
      job.reject(error);
      this.#pump(slot);
    }
  }

  #reply(
    slot: Slot,
    data: { id: number; result?: unknown; error?: { name: string; message: string; code?: string } },
  ): void {
    const job = slot.busy;
    if (!job || !data || data.id !== job.id) return;
    slot.busy = undefined;
    clearTimeout(job.timer);
    this.#settle(job);
    if (data.error) {
      // The worker's error as thrown there: its class by name, and a MargoError's code (the message has its link).
      const { name, message, code } = data.error,
        error = reviveError({ name: code ? 'Error' : name, message });
      job.reject(code ? Object.assign(error, { name: 'MargoError', code }) : error);
    } else job.resolve(data.result);
    this.#pump(slot);
  }

  /** Replaces a slot's worker: its running job rejects, its queued jobs wait for the new worker (changes are in its state). */
  #restart(slot: Slot, reason: string): void {
    slot.worker.onmessage = slot.worker.onerror = slot.worker.onmessageerror = null;
    slot.worker.terminate();
    const busy = slot.busy;
    slot.busy = undefined;
    if (busy) {
      clearTimeout(busy.timer);
      this.#settle(busy);
      busy.reject(fault('failed', reason, 'biomes'));
    }
    if (this.#disposed) return;
    this.#spawn(slot);
    // Changes queued for the old worker are in the new one's state already.
    slot.queue = slot.queue.filter((job) => !job.barrier);
    this.#pump(slot);
  }

  #settle(job: Job): void {
    if (job.abort) job.signal!.removeEventListener('abort', job.abort);
    job.abort = undefined;
  }

  /** Jobs queued or running over all workers. */
  get pending(): number {
    let n = 0;
    for (const s of this.#slots)
      if (s) n += s.queue.filter((j) => !j.barrier).length + (s.busy && !s.busy.barrier ? 1 : 0);
    return n;
  }

  /** Terminates the workers; queued and running jobs reject with MargoError 'disposed'. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const reason = fault('disposed', 'The biome world is disposed; create a new world', 'biomes');
    for (const slot of this.#slots) {
      if (!slot) continue;
      slot.worker.onmessage = slot.worker.onerror = slot.worker.onmessageerror = null;
      slot.worker.terminate();
      for (const job of [...(slot.busy ? [slot.busy] : []), ...slot.queue]) {
        clearTimeout(job.timer);
        this.#settle(job);
        job.reject(reason);
      }
      slot.queue = [];
      slot.busy = undefined;
    }
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
