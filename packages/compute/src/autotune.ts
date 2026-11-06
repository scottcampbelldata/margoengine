// @margoengine/compute/autotune: picks a kernel's workgroup size on this adapter by timing it. The fastest size depends
// on the GPU (its wave width, registers and caches) and on the kernel, so it is measured rather than guessed, once per
// adapter, kernel and problem, then remembered for the context and, given a `store`, across sessions.
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { aborted, type ComputeContext, type WaitOptions } from './context.js';
import type { Kernel } from './kernel.js';

/** A workgroup size as WGSL declares it: x, y, z. In a template string it reads `64,1,1`. */
export type WorkgroupSize = readonly [number, number, number];

/** Remembers results across sessions: `localStorage` fits, and so does anything with these two methods, async or not. */
export interface AutotuneStore {
  /** The value stored under `key`, or null. */
  getItem(key: string): string | null | undefined | Promise<string | null | undefined>;
  /** Stores `value` under `key`. */
  setItem(key: string, value: string): unknown;
}

/** What {@link autotune} measures. */
export interface AutotuneOptions extends WaitOptions {
  /** Names the kernel in the cache. */
  readonly name: string;
  /** The kernel's WGSL at a size: put `@workgroup_size(${size})` in it. */
  readonly source: (size: WorkgroupSize) => string;
  /** Runs the kernel once as the real work would; make the inputs the size the real work has. */
  readonly run: (kernel: Kernel, size: WorkgroupSize) => unknown;
  /**
   * Sizes to try, numbers for one dimension; on a tie the earlier wins. Those this device cannot run are dropped.
   * Default 256, 128, 64, 32, 512, 1024.
   */
  readonly candidates?: readonly (number | readonly number[])[];
  /** What the best size depends on besides the adapter and the source, such as the element count. Default ''. */
  readonly signature?: string;
  /** Timed runs of each size, of which the median counts. Default 7. */
  readonly trials?: number;
  /** Untimed runs of each size first, which also build its pipeline. Default 2. */
  readonly warmup?: number;
  /** Remembers results across sessions. Default none: they last as long as the context. */
  readonly store?: AutotuneStore;
  /** Measures again even if a result is known. Default false. */
  readonly refresh?: boolean;
  /** Entry point, when the source has several. */
  readonly entryPoint?: string;
}

/** The median time of one candidate. */
export interface AutotuneTiming {
  /** The size measured. */
  readonly workgroupSize: WorkgroupSize;
  /** Median milliseconds of one run: GPU time from timestamp queries, else wall clock up to `gpu.done()`. */
  readonly ms: number;
}

/** What {@link autotune} resolves. */
export interface AutotuneResult {
  /** The fastest size. */
  readonly workgroupSize: WorkgroupSize;
  /** The kernel compiled at that size. */
  readonly kernel: Kernel;
  /** Every candidate's time, in the order given; empty when the result was known. */
  readonly timings: readonly AutotuneTiming[];
  /** True when the result came from the cache and nothing ran. */
  readonly cached: boolean;
}

interface Tuner {
  readonly known: Map<string, WorkgroupSize>;
  tail: Promise<unknown>;
}

// Per context, so nothing outlives it. Runs take turns: profile() times one piece of work at a time.
const tuners = new WeakMap<ComputeContext, Tuner>();

const whole = (value: number, least: number, name: string): number => {
  if (!Number.isInteger(value) || value < least)
    throw rangeError(`autotune ${name} must be a whole number from ${least}, got ${value}`, 'compute');
  return value;
};

function candidatesOf(gpu: ComputeContext, options: AutotuneOptions): WorkgroupSize[] {
  const limits = gpu.device.limits,
    list = options.candidates ?? [256, 128, 64, 32, 512, 1024],
    sizes: WorkgroupSize[] = [];
  if (!Array.isArray(list) || !list.length) throw rangeError('autotune needs at least one candidate size', 'compute');
  for (const candidate of list) {
    const [x, y = 1, z = 1] = typeof candidate === 'number' ? [candidate] : candidate;
    for (const side of [x, y, z]) whole(side, 1, 'candidates');
    if (
      x <= limits.maxComputeWorkgroupSizeX &&
      y <= limits.maxComputeWorkgroupSizeY &&
      z <= limits.maxComputeWorkgroupSizeZ &&
      x * y * z <= limits.maxComputeInvocationsPerWorkgroup
    )
      sizes.push([x, y, z]);
  }
  if (!sizes.length) throw rangeError(`This device can run none of the ${list.length} candidate sizes`, 'compute');
  return sizes;
}

// FNV-1a: a changed kernel must not meet the size measured for its old source.
const hash = (text: string): string => {
  let h = 0x811c9dc5;
  for (let k = 0; k < text.length; k++) h = Math.imul(h ^ text.charCodeAt(k), 0x01000193);
  return (h >>> 0).toString(16);
};

const mean = (values: number[]): number => values.reduce((sum, v) => sum + v, 0) / values.length;

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b),
    middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

async function timeOnce(gpu: ComputeContext, work: () => unknown, options: AutotuneOptions): Promise<number> {
  if (gpu.device.features.has('timestamp-query')) {
    const passes = await gpu.profile(work, options);
    return passes.reduce((sum, pass) => sum + pass.ms, 0);
  }
  await gpu.done(options);
  const start = performance.now();
  await work();
  await gpu.done(options);
  return performance.now() - start;
}

async function tune(gpu: ComputeContext, tuner: Tuner, options: AutotuneOptions): Promise<AutotuneResult> {
  if (gpu.backend === 'cpu') throw fault('unsupported', 'autotune measures WGSL kernels, which need a GPU', 'compute');
  const { source, run, store, entryPoint, signature = '', trials = 7, warmup = 2 } = options,
    sizes = candidatesOf(gpu, options),
    compile = (size: WorkgroupSize) => gpu.kernel(source(size), { entryPoint, label: options.name }),
    // Browsers without device.adapterInfo give no names, so adapters there share entries: a slower size at worst.
    { vendor, architecture, device, description } = gpu.device.adapterInfo ?? ({} as Partial<GPUAdapterInfo>),
    key = `margoengine/autotune/1/${[vendor, architecture, device, description].join('/')}/${options.name}/${signature}/${hash(source([1, 1, 1]))}/${sizes.join(' ')}`;
  whole(trials, 1, 'trials');
  whole(warmup, 0, 'warmup');
  if (!options.refresh) {
    const stored = tuner.known.get(key) ?? (await store?.getItem(key)),
      size = sizes.find((s) => s.join() === String(stored));
    if (size) {
      tuner.known.set(key, size);
      return { workgroupSize: size, kernel: compile(size), timings: [], cached: true };
    }
  }
  const kernels = sizes.map(compile),
    times = sizes.map((): number[] => []);
  for (let round = 0; round < warmup; round++)
    for (let k = 0; k < sizes.length; k++) {
      aborted(options.signal);
      await run(kernels[k], sizes[k]);
      await gpu.done(options);
    }
  // Sizes take turns within each round, so a GPU warming up or clocking down is not charged to whichever ran last.
  for (let round = 0; round < trials; round++)
    for (let k = 0; k < sizes.length; k++) {
      aborted(options.signal);
      times[k].push(await timeOnce(gpu, () => run(kernels[k], sizes[k]), options));
    }
  const timings = sizes.map((workgroupSize, k) => ({ workgroupSize, ms: median(times[k]) }));
  // Browsers round GPU timestamps, so short kernels can share a median; their means still differ below the step.
  let best = 0;
  timings.forEach((timing, k) => {
    const gain = timings[best].ms - timing.ms;
    if (gain > 0 || (gain === 0 && mean(times[k]) < mean(times[best]))) best = k;
  });
  tuner.known.set(key, sizes[best]);
  await store?.setItem(key, sizes[best].join());
  return { workgroupSize: sizes[best], kernel: kernels[best], timings, cached: false };
}

/**
 * Measures a kernel at each candidate workgroup size and resolves the fastest, compiled. Known results are reused without
 * running anything. Needs a GPU: the CPU backend throws a MargoError (`unsupported`), as for any WGSL kernel.
 * @example
 * const { kernel } = await autotune(gpu, {
 *   name: 'saxpy',
 *   signature: String(n),
 *   source: (size) => `... @compute @workgroup_size(${size}) fn main ...`,
 *   run: (kernel) => kernel.run({ x, y }, { count: n }),
 * });
 */
export async function autotune(gpu: ComputeContext, options: AutotuneOptions): Promise<AutotuneResult> {
  gpu.check();
  if (typeof options?.name !== 'string' || !options.name) throw typeError('autotune needs a name', 'compute');
  if (typeof options.source !== 'function' || typeof options.run !== 'function')
    throw typeError('autotune needs a source and a run function', 'compute');
  let tuner = tuners.get(gpu);
  if (!tuner) tuners.set(gpu, (tuner = { known: new Map(), tail: Promise.resolve() }));
  const turn = tuner.tail.then(() => tune(gpu, tuner, options));
  // The next call waits for this one to end either way; this call's caller receives its failure from `turn`.
  tuner.tail = turn.catch(() => undefined);
  return turn;
}
