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

/** One trace dispatch: rows `y0`..`y0 + rows - 1` of the image, samples `s0`..`s0 + count - 1`. */
export interface TraceChunk {
  y0: number;
  rows: number;
  s0: number;
  count: number;
}

/**
 * The dispatches of `count` samples (from sample `s0`) over a `width` x `height` image, each at most `budget` paths
 * (unless one row step of one sample is more). Bands start at multiples of `rowStep` rows (a binding's offset into the
 * image buffers must be aligned). Sample runs are outer, so every band takes the samples in order.
 */
export function planTrace(
  width: number,
  height: number,
  s0: number,
  count: number,
  rowStep = 1,
  budget = DISPATCH_PATHS,
): TraceChunk[] {
  const fewest = Math.min(height, rowStep),
    perRun = Math.max(1, Math.min(count, Math.floor(budget / (fewest * width)))),
    rows = Math.min(height, Math.max(fewest, Math.floor(budget / (width * perRun) / rowStep) * rowStep)),
    chunks: TraceChunk[] = [];
  for (let s = 0; s < count; s += perRun)
    for (let y0 = 0; y0 < height; y0 += rows)
      chunks.push({ y0, rows: Math.min(rows, height - y0), s0: s0 + s, count: Math.min(perRun, count - s) });
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
