// Bounded trace dispatches. A driver resets the GPU when one piece of work runs past its watchdog (Windows TDR, about 2 s),
// so no trace dispatch may carry an unbounded number of paths. renderImage already bounds its work (tiles of at most
// 1024 x 1024 pixels plus the denoiser's margin, as many samples a submission as fit DISPATCH_PATHS pixel-samples). The
// viewport traced its whole image, every sample of the frame, in one dispatch: 8.3 million paths a frame at 4K (200 ms
// on this project's RTX A6000, several times that on a slower GPU) and 100 million with samplesPerFrame 64 on a
// 1440 x 1100 canvas. planTrace cuts a frame into row bands and, only when one band of the fewest rows still holds too
// many, into runs of samples.
//
// Output is unchanged: each pixel's samples come from its own sequence (seeded by pixel and sample index), so bands
// change nothing; a frame split into sample runs adds its samples in that many partial sums, as renderImage always has.

/** Paths (pixels x samples) one trace dispatch may carry: 15 to 25 ms on an RTX A6000 in the browser-check scenes. */
const DISPATCH_PATHS = 1 << 20;

/** Iterations of the path loop for `maxBounces`: the trace kernel's `limit` (compat-staged.ts checks it against the shader). */
export const loopLimit = (maxBounces: number): number => maxBounces * 4 + 16 + (maxBounces + 1) * 16;

// A path's cost grows with its loop: 2^20 paths at maxBounces 64 may run 1,312 iterations each, 6.8 times the work of
// the same paths at the default 8 (192). A GPU without dispatch-boundary preemption (AMD reports packet boundaries)
// resets when one submission runs past Windows' 2 s watchdog, and a small integrated GPU (Radeon 680M) runs the
// tracer about 10 times slower than the RTX A6000 the 2^20 figure was measured on. So the bound is on work, in
// path-iterations (paths x loop limit), per submission, and a tracer measures its own GPU's speed (WorkPacer).

/** Path-iterations one submission may carry at most: 2^20 paths at the default 8 bounces (about 201 million). */
export const SUBMIT_WORK = DISPATCH_PATHS * loopLimit(8);

/** Paths a submission may carry for `maxBounces` within `work` path-iterations (never over 2^20, at least 1). */
export function pathBudget(maxBounces: number, work = SUBMIT_WORK): number {
  return Math.max(1, Math.min(DISPATCH_PATHS, Math.floor(work / loopLimit(maxBounces))));
}

/** GPU time a submission is planned to take on the measured device, far below the 2 s watchdog. */
export const TARGET_MS = 50;

/**
 * The work a tracer puts in one submission on the GPU it runs on. It starts at a 128th of SUBMIT_WORK, and after each
 * measured group
 * of submissions moves to what that GPU does in TARGET_MS, growing at most twofold a step and never past
 * SUBMIT_WORK. Measured times include queue waits and readback latency, so the estimate only errs low. The budget
 * changes only how a tile is cut into bands and columns (they change no pixel's sums); sample runs follow SUBMIT_WORK
 * alone, so images do not depend on timing.
 *
 * The first figure is a 128th because GPUs differ by far more than their compute: an AMD Ryzen 9 9950X's two-unit
 * RDNA2 graphics took 554 to 2,410 ms for 16 rows of 480 pixels at 7 samples in the denoise-materials scene, which
 * the RTX A6000 traces in 4 ms (KB4037). A sixteenth (65,536 paths at 8 bounces) passed Windows' 2 s watchdog there
 * on the third submission; a 128th (8,192 paths) takes about 0.4 s at that cost.
 */
export class WorkPacer {
  budget = SUBMIT_WORK / 128;
  /** Work and milliseconds of one finished group of submissions (from its first submit to its completion). */
  observe(work: number, ms: number): void {
    if (!(work > 0) || !(ms > 0)) return;
    const fits = (work / ms) * TARGET_MS;
    this.budget = Math.max(SUBMIT_WORK / 4096, Math.min(SUBMIT_WORK, this.budget * 2, fits));
  }
}

/**
 * One trace dispatch: rows `y0`..`y0 + rows - 1` and columns `x0`..`x0 + cols - 1` of the image, samples
 * `s0`..`s0 + count - 1`.
 */
export interface TraceChunk {
  y0: number;
  rows: number;
  x0: number;
  cols: number;
  s0: number;
  count: number;
}

/**
 * The dispatches of `count` samples (from sample `s0`) over a `width` x `height` image. Sample runs hold at most
 * `budget` paths a band of the fewest rows (`budget` must not depend on timing: the runs set each pixel's partial
 * sums); bands hold at most `rows` paths (`rows`, at most `budget`, may follow the measured GPU: bands change no sum),
 * and never fewer than `rowStep` rows. Bands start at multiples of `rowStep` rows (a binding's offset into the image
 * buffers must be aligned). With `colStep` (0: whole rows), a band of the fewest rows that still holds more than `rows`
 * paths is cut into pieces of whole columns, a multiple of `colStep` wide (columns change no pixel's sums either), so
 * a slow GPU is never given more than its budget by the band's height alone (KB4037). Sample runs are outer, so every
 * band takes the samples in order.
 */
export function planTrace(
  width: number,
  height: number,
  s0: number,
  count: number,
  rowStep = 1,
  budget = DISPATCH_PATHS,
  rows = budget,
  colStep = 0,
): TraceChunk[] {
  return [...traceChunks(width, height, s0, count, rowStep, budget, () => rows, colStep)];
}

/**
 * planTrace's dispatches, made one at a time: `rows()` is read again before each band and each column piece, so a
 * budget that falls while a run is traced (WorkPacer, measured every few submissions) sizes the very next piece
 * instead of the next run's. The samples of each run stay fixed by `budget` alone, and every pixel takes each run once
 * whatever sizes the pieces get, so no sum depends on timing (KB4037: on an AMD Ryzen 9 9950X's graphics one run of
 * 7 samples at 480 x 300 is about 150 pieces and 45 s; pieces planned for the run's start took up to 1.2 s in the
 * image's costly middle).
 */
export function* traceChunks(
  width: number,
  height: number,
  s0: number,
  count: number,
  rowStep: number,
  budget: number,
  rows: () => number,
  colStep = 0,
): Generator<TraceChunk> {
  const fewest = Math.min(height, rowStep),
    perRun = Math.max(1, Math.min(count, Math.floor(budget / (fewest * width))));
  for (let s = 0; s < count; s += perRun) {
    const n = Math.min(perRun, count - s);
    for (let y0 = 0; y0 < height; ) {
      const paths = Math.min(rows(), budget),
        band = Math.min(height - y0, Math.max(fewest, Math.floor(paths / (width * perRun) / rowStep) * rowStep));
      for (let x0 = 0; x0 < width; ) {
        const left = Math.min(rows(), budget),
          cols =
            colStep > 0 && band * width * perRun > left
              ? Math.max(colStep, Math.floor(left / (band * perRun) / colStep) * colStep)
              : width;
        yield { y0, rows: band, x0, cols: Math.min(cols, width - x0), s0: s0 + s, count: n };
        x0 += cols;
      }
      y0 += band;
    }
  }
}

/** Rows a band's start must be a multiple of, so that its offset (y0 x width x 16 bytes) meets `alignment` (a power of two). */
export function bandRowStep(width: number, alignment: number): number {
  const bytes = width * 16;
  let a = bytes,
    b = alignment;
  while (b) [a, b] = [b, a % b];
  return alignment / a;
}
