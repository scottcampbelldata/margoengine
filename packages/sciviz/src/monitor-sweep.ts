import { rangeError } from '../../shared/errors.js';
import type { FigureStatsSnapshot } from './monitor.js';

/** One independently prepared size. frame() must include GPU completion when measuring frame latency. */
export interface SweepCase {
  frame(signal: AbortSignal): Promise<void>;
  stats(): FigureStatsSnapshot;
  dispose(): void | Promise<void>;
}
/** Environment attached to every observation, with load and diagnostic status supplied by the host. */
export interface SweepMetadata {
  readonly commit: string;
  readonly gpu: Readonly<Record<string, string>>;
  readonly browser: string;
  readonly cpuLoad: number;
  readonly machine: string;
  readonly diagnostic: boolean;
  /** Host digest of fixture and implementation sources when observing an uncommitted build. */
  readonly sourceDigest?: string;
  readonly workingTree?: boolean;
}
/** A bounded, cancellable sweep plan. Timing is opt-in and off during the build phase. */
export interface SweepOptions {
  readonly kind: 'points' | 'voxels' | 'cells' | 'edges' | 'rows' | 'load';
  /** Increasing positive sizes. No extrapolation beyond the final tested size. */
  readonly sizes: readonly number[];
  readonly prepare: (size: number, signal: AbortSignal) => Promise<SweepCase>;
  readonly metadata: SweepMetadata;
  /** Default false during the build phase. No clocks or timing assertions in allocation mode. */
  readonly timing?: boolean;
  /** Quiet speed-phase defaults: 16.7 ms, three warmups, nine samples. */
  readonly frameBudgetMs?: number;
  readonly warmupFrames?: number;
  readonly sampleFrames?: number;
  /** Per-size hard limit, default 120000 ms. Cancellation uses the supplied reason. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly format?: string;
}
/** A completed size or a preserved allocation/load/driver failure, never an extrapolated limit. */
export interface SweepRow {
  readonly size: number;
  readonly status: 'passed' | 'failed';
  readonly memory?: FigureStatsSnapshot;
  readonly loadMs?: number;
  readonly frameMs?: readonly number[];
  readonly minimumFrameMs?: number;
  readonly medianFrameMs?: number;
  readonly error?: { readonly name: string; readonly message: string; readonly code?: string };
}
/** Versioned JSON contract for the comparison page and quiet-machine speed phase. */
export interface SweepReport {
  readonly schema: 'margo-sciviz-limits/1';
  readonly mode: 'allocation' | 'timed';
  readonly kind: SweepOptions['kind'];
  readonly format?: string;
  readonly metadata: SweepMetadata;
  readonly frameBudgetMs: number;
  readonly firstOverBudget: number | null;
  readonly firstFailure: number | null;
  readonly stop: 'failure' | 'size-ceiling';
  readonly rows: readonly SweepRow[];
}

/** Deterministic counts by default. Timed sweeps continue past the first missed budget until failure or size ceiling. */
export async function sweepLimits(options: SweepOptions): Promise<SweepReport> {
  const { sizes, metadata, timing = false } = options;
  const budget = options.frameBudgetMs ?? 16.7,
    warmup = options.warmupFrames ?? 3,
    samples = options.sampleFrames ?? 9,
    timeout = options.timeoutMs ?? 120000;
  if (!sizes.length || sizes.some((n, i) => !Number.isSafeInteger(n) || n <= 0 || (i > 0 && n <= sizes[i - 1])))
    throw rangeError('Sweep sizes must be strictly increasing positive safe integers', 'sciviz');
  if (
    !(budget > 0 && Number.isFinite(budget) && timeout > 0 && Number.isFinite(timeout)) ||
    !Number.isSafeInteger(warmup) ||
    warmup < 0 ||
    !Number.isSafeInteger(samples) ||
    samples < 1
  )
    throw rangeError('Invalid sweep budget, sample count or timeout', 'sciviz');
  if (!Number.isFinite(metadata.cpuLoad) || metadata.cpuLoad < 0 || metadata.cpuLoad > 1)
    throw rangeError('Sweep CPU load must be a fraction in [0, 1]', 'sciviz');
  const rows: SweepRow[] = [];
  let firstOverBudget: number | null = null,
    firstFailure: number | null = null;
  for (const size of sizes) {
    options.signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal!.reason);
    options.signal?.addEventListener('abort', abort, { once: true });
    const timeoutError = new DOMException(`Sweep size ${size} exceeded ${timeout} ms`, 'TimeoutError');
    const timer = setTimeout(() => controller.abort(timeoutError), timeout);
    let item: SweepCase | undefined;
    let timedOut = false;
    const run = async (): Promise<SweepRow> => {
      const start = timing ? performance.now() : 0;
      item = await options.prepare(size, controller.signal);
      // A prepare that ignores cancellation still releases its eventual result.
      if (controller.signal.aborted) {
        await item.dispose();
        item = undefined;
        throw controller.signal.reason;
      }
      const current = item;
      await current.frame(controller.signal);
      const loadMs = timing ? performance.now() - start : undefined;
      const frameMs: number[] = [];
      if (timing) {
        for (let i = 0; i < warmup; i++) {
          controller.signal.throwIfAborted();
          await current.frame(controller.signal);
        }
        for (let i = 0; i < samples; i++) {
          controller.signal.throwIfAborted();
          const before = performance.now();
          await current.frame(controller.signal);
          frameMs.push(performance.now() - before);
        }
      }
      const sorted = [...frameMs].sort((a, b) => a - b);
      controller.signal.throwIfAborted();
      return {
        size,
        status: 'passed',
        memory: current.stats(),
        ...(timing
          ? {
              loadMs,
              frameMs,
              minimumFrameMs: sorted[0],
              medianFrameMs: sorted[Math.floor(sorted.length / 2)],
            }
          : {}),
      };
    };
    let off = () => {};
    try {
      const interrupted = new Promise<never>((_, reject) => {
        const fail = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', fail, { once: true });
        off = () => controller.signal.removeEventListener('abort', fail);
      });
      const row = await Promise.race([run(), interrupted]);
      rows.push(row);
      if (firstOverBudget === null && row.medianFrameMs !== undefined && row.medianFrameMs > budget)
        firstOverBudget = size;
    } catch (error) {
      options.signal?.throwIfAborted();
      timedOut = controller.signal.aborted;
      const e = error as { name?: string; message?: string; code?: unknown };
      rows.push({
        size,
        status: 'failed',
        error: {
          name: e?.name ?? 'Error',
          message: e?.message ?? String(error),
          ...(typeof e?.code === 'string' ? { code: e.code } : {}),
        },
      });
      firstFailure = size;
    } finally {
      clearTimeout(timer);
      off();
      options.signal?.removeEventListener('abort', abort);
      // On timeout the caller's outer process limit also guards a driver or disposal hang.
      if (item) {
        const current = item;
        item = undefined;
        await current.dispose();
      }
    }
    if (firstFailure !== null || timedOut) break;
  }
  return {
    schema: 'margo-sciviz-limits/1',
    mode: timing ? 'timed' : 'allocation',
    kind: options.kind,
    ...(options.format ? { format: options.format } : {}),
    metadata,
    frameBudgetMs: budget,
    firstOverBudget,
    firstFailure,
    stop: firstFailure === null ? 'size-ceiling' : 'failure',
    rows,
  };
}
