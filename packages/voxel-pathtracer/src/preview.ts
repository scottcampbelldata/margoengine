// Live preview budget: few samples while the model changes, more once it has been idle.
const count = (value: number | undefined, fallback: number, name: string, min: number): number => {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min)
    throw new RangeError(`PreviewBudget ${name} ${value} is invalid; pass an integer of ${min} or more`);
  return value;
};

/**
 * How many samples a live editor preview should ask the path tracer for. Call `markDirty` when the model, camera or
 * materials change and `tick` once per frame. It counts frames; it is not a GPU memory budget.
 */
export class PreviewBudget {
  /** Samples per frame while editing. */
  readonly dirtySamples: number;
  /** Samples per frame once idle. */
  readonly idleSamples: number;
  /** Frames without changes before the preview counts as idle. */
  readonly idleFrames: number;
  #frames = 0;

  /**
   * @param options - `dirtySamples` (default 4) and `idleSamples` (default 256), 1 or more; `idleFrames` (default 8),
   *   0 or more.
   * @throws RangeError for a value that is not a whole number in range.
   */
  constructor(options: { dirtySamples?: number; idleSamples?: number; idleFrames?: number } = {}) {
    this.dirtySamples = count(options.dirtySamples, 4, 'dirtySamples', 1);
    this.idleSamples = count(options.idleSamples, 256, 'idleSamples', 1);
    this.idleFrames = count(options.idleFrames, 8, 'idleFrames', 0);
  }

  /** Restarts the idle count after a change. */
  markDirty(): void {
    this.#frames = 0;
  }

  /** Advances one frame and returns the samples to request for it. */
  tick(): number {
    this.#frames++;
    return this.isIdle ? this.idleSamples : this.dirtySamples;
  }

  /** Whether the preview has switched to `idleSamples`. */
  get isIdle(): boolean {
    return this.#frames > this.idleFrames;
  }
}
