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
 * The work a tracer puts in one submission on the GPU it runs on. It starts at a sixteenth of SUBMIT_WORK (a GPU
 * 16 times slower than the RTX A6000 still meets the target on its first submission), and after each measured group
 * of submissions moves to what that GPU does in TARGET_MS, growing at most twofold a step and never past
 * SUBMIT_WORK. Measured times include queue waits and readback latency, so the estimate only errs low. The budget
 * changes only how rows are banded (bands change no pixel's sums); sample runs follow SUBMIT_WORK alone, so images
 * do not depend on timing.
 */
export class WorkPacer {
  budget = SUBMIT_WORK / 16;
  /** Work and milliseconds of one finished group of submissions (from its first submit to its completion). */
  observe(work: number, ms: number): void {
    if (!(work > 0) || !(ms > 0)) return;
    const fits = (work / ms) * TARGET_MS;
    this.budget = Math.max(SUBMIT_WORK / 4096, Math.min(SUBMIT_WORK, this.budget * 2, fits));
  }
}

/** One trace dispatch: rows `y0`..`y0 + rows - 1` of the image, samples `s0`..`s0 + count - 1`. */
export interface TraceChunk {
  y0: number;
  rows: number;
  s0: number;
  count: number;
}

/**
 * The dispatches of `count` samples (from sample `s0`) over a `width` x `height` image. Sample runs hold at most
 * `budget` paths a band of the fewest rows (`budget` must not depend on timing: the runs set each pixel's partial
 * sums); bands hold at most `rows` paths (`rows`, at most `budget`, may follow the measured GPU: bands change no sum),
 * and never fewer than `rowStep` rows. Bands start at multiples of `rowStep` rows (a binding's offset into the image
 * buffers must be aligned). Sample runs are outer, so every band takes the samples in order.
 */
export function planTrace(
  width: number,
  height: number,
  s0: number,
  count: number,
  rowStep = 1,
  budget = DISPATCH_PATHS,
  rows = budget,
): TraceChunk[] {
  const fewest = Math.min(height, rowStep),
    perRun = Math.max(1, Math.min(count, Math.floor(budget / (fewest * width)))),
    band = Math.min(height, Math.max(fewest, Math.floor(Math.min(rows, budget) / (width * perRun) / rowStep) * rowStep)),
    chunks: TraceChunk[] = [];
  for (let s = 0; s < count; s += perRun)
    for (let y0 = 0; y0 < height; y0 += band)
      chunks.push({ y0, rows: Math.min(band, height - y0), s0: s0 + s, count: Math.min(perRun, count - s) });
  return chunks;
}

/** Rows a band's start must be a multiple of, so that its offset (y0 x width x 16 bytes) meets `alignment` (a power of two). */
export function bandRowStep(width: number, alignment: number): number {
  const bytes = width * 16;
  let a = bytes,
    b = alignment;
  while (b) [a, b] = [b, a % b];
  return alignment / a;
}
