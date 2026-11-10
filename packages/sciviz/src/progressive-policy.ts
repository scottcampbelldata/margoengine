import { rangeError } from '../../shared/errors.js';

/** Adaptive interaction settings. Resting frames always converge to the original full quality. */
export interface ProgressiveOptions {
  /** Soft submitted-frame latency target in milliseconds. Default 16.7; never a hard GPU deadline. */
  readonly frameBudgetMs?: number;
  /** Initial moving render dimension multiplier, (0,1]. Default 0.5. */
  readonly movingResolution?: number;
  /** Initial moving ray/lighting sample multiplier, (0,1]. Default 0.25. */
  readonly movingSamples?: number;
  /** Smallest adaptive dimension multiplier, (0,movingResolution]. Default min(0.25,movingResolution). */
  readonly minResolution?: number;
  /** Smallest adaptive sample multiplier, (0,movingSamples]. Default min(0.125,movingSamples). */
  readonly minSamples?: number;
  /** Unchanged camera frames before refinement, integer 0..120. Default 2. */
  readonly settleFrames?: number;
  /** Frames to reach full dimensions and samples after settling, integer 1..120. Default 8. */
  readonly refinementFrames?: number;
}

/** Quality used by the most recently submitted view. */
export interface ProgressiveState {
  /** True on a changed-camera frame and during the settling interval. */
  readonly moving: boolean;
  /** Internal dimensions relative to the original target. */
  readonly resolutionScale: number;
  /** Ray and optional lighting integration samples relative to user settings. */
  readonly sampleScale: number;
  /** Refinement fraction, 0 during interaction and 1 at original quality. */
  readonly progress: number;
}

// The controller is frame-count based. Timing is feedback, never a correctness gate or an idle timer.
export class ProgressivePolicy {
  readonly options: Required<ProgressiveOptions>;
  #resolution: number;
  #samples: number;
  #still = 0;
  constructor(options: ProgressiveOptions) {
    const resolution = options.movingResolution ?? 0.5,
      samples = options.movingSamples ?? 0.25;
    this.options = {
      frameBudgetMs: options.frameBudgetMs ?? 16.7,
      settleFrames: options.settleFrames ?? 2,
      refinementFrames: options.refinementFrames ?? 8,
      movingResolution: resolution,
      movingSamples: samples,
      minResolution: options.minResolution ?? Math.min(0.25, resolution),
      minSamples: options.minSamples ?? Math.min(0.125, samples),
    };
    const o = this.options;
    if (
      !Number.isFinite(o.frameBudgetMs) ||
      o.frameBudgetMs <= 0 ||
      ![resolution, samples, o.minResolution, o.minSamples].every((v) => Number.isFinite(v) && v > 0 && v <= 1) ||
      o.minResolution > resolution ||
      o.minSamples > samples ||
      !Number.isInteger(o.settleFrames) ||
      o.settleFrames < 0 ||
      o.settleFrames > 120 ||
      !Number.isInteger(o.refinementFrames) ||
      o.refinementFrames < 1 ||
      o.refinementFrames > 120
    )
      throw rangeError(
        'Progressive rendering needs positive finite budget, scales in (0,1], ordered minima and integer frame counts; correct the options',
        'sciviz',
      );
    this.#resolution = resolution;
    this.#samples = samples;
  }
  feedback(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0)
      throw rangeError('Frame latency must be finite and positive; supply milliseconds', 'sciviz');
    const o = this.options;
    // Pixel count is quadratic and ray work linear. Limit each feedback step to avoid oscillation.
    const ratio = milliseconds / o.frameBudgetMs;
    if (ratio > 0.85 && ratio < 1.15) return;
    const step = Math.max(0.8, Math.min(1.1, Math.cbrt(1 / ratio)));
    this.#resolution = Math.max(o.minResolution, Math.min(o.movingResolution, this.#resolution * step));
    this.#samples = Math.max(o.minSamples, Math.min(o.movingSamples, this.#samples * step));
  }
  next(changed: boolean): ProgressiveState {
    this.#still = changed ? 0 : this.#still + 1;
    const progress = Math.min(
      1,
      Math.max(0, (this.#still - this.options.settleFrames) / this.options.refinementFrames),
    );
    return {
      moving: this.#still <= this.options.settleFrames,
      progress,
      resolutionScale: this.#resolution + (1 - this.#resolution) * progress,
      sampleScale: this.#samples + (1 - this.#samples) * progress,
    };
  }
}
