import { timeFrames, type FrameTimers } from './resolution.js';

/** One thing the scaler can turn down, in `levels` steps from 0 (full quality). See {@link optionKnob}. */
export interface FeatureKnob {
  /** Unique name, used in reports. */
  name: string;
  /** Number of levels, 2 or more. */
  levels: number;
  /** Sets level `level`, 0 to `levels - 1`. Runs on a change and, with 0, on dispose. */
  apply(level: number): void;
  /** How much a viewer notices a step: of two steps that save enough, the lower weight goes first. Above 0. Default 1. */
  weight?: number;
}

/** Options of {@link FeatureScaler}. */
export interface FeatureScalerOptions {
  /** Frame cost in milliseconds above which a feature goes down; under 70% of it one may come back. Default 12. */
  budget?: number;
  /** Samples averaged before each decision. Default 30. */
  window?: number;
  /** Samples ignored after a change, while it reaches the GPU. A shader change can compile in these. Default 8. */
  settle?: number;
  /** A step that saved less than this share of the frame is given back and left alone for a while. Default 0.03. */
  minSaving?: number;
}

/** A change {@link FeatureScaler.push} made. */
export interface FeatureChange {
  name: string;
  level: number;
}

/** What one step of a knob measured. */
export interface FeatureCost {
  name: string;
  /** The level the step leaves. */
  level: number;
  /** Milliseconds per frame going one level down saves, undefined until tried. */
  saved: number | undefined;
}

interface Knob extends Required<FeatureKnob> {
  level: number;
  /** Measured milliseconds per step, by the level it leaves. */
  saved: (number | undefined)[];
  /** Decisions until a step that saved nothing may be tried again, by the level it leaves. */
  resting: number[];
}

// Decisions a step that saved nothing rests: about a minute at the default window and 60 FPS.
const REST = 120;

/**
 * Lowers features by what they measure, not by resolution alone. Over budget it takes a step, watches what the frame
 * cost did, and remembers the saving: a step that saved nothing is given back at once, and next time the step known
 * to cover the shortfall with the least visible loss goes first. With room to spare, the most visible feature whose
 * measured cost fits comes back. Free of timers and the DOM; feed it one frame cost per frame with
 * {@link FeatureScaler.push}.
 */
export class FeatureScaler {
  /** Current budget in milliseconds; set it to change it, as `watchPower` does. */
  budget: number;
  private readonly knobs: Knob[];
  private readonly window: number;
  private readonly settleFrames: number;
  private readonly minSaving: number;
  private sum = 0;
  private count = 0;
  private skip = 0;
  private calm = 0;
  private holdOff = 2;
  private sinceRise = Infinity;
  private trial?: { knob: Knob; step: number; before: number; down: boolean };
  /**
   * @throws RangeError when `budget` is not above 0, `window` is below 1, `settle` is negative, `minSaving` is not in
   * [0, 1), or a knob has fewer than 2 levels, a weight not above 0 or a repeated name.
   */
  constructor(
    knobs: readonly FeatureKnob[],
    { budget = 12, window = 30, settle = 8, minSaving = 0.03 }: FeatureScalerOptions = {},
  ) {
    if (
      !(Number.isFinite(budget) && budget > 0) ||
      !Number.isInteger(window) ||
      window < 1 ||
      !Number.isInteger(settle) ||
      settle < 0 ||
      !(minSaving >= 0 && minSaving < 1)
    )
      throw new RangeError(
        'Invalid feature options; use budget > 0, an integer window >= 1, an integer settle >= 0 and minSaving in [0, 1)',
      );
    const names = new Set<string>();
    this.knobs = knobs.map(({ name, levels, apply, weight = 1 }) => {
      if (!name || names.has(name) || !Number.isInteger(levels) || levels < 2 || !(weight > 0))
        throw new RangeError(
          `Invalid feature knob '${name}'; use a unique name, an integer levels >= 2 and a weight above 0`,
        );
      names.add(name);
      return { name, levels, apply, weight, level: 0, saved: [], resting: [] };
    });
    this.budget = budget;
    this.window = window;
    this.settleFrames = settle;
    this.minSaving = minSaving;
  }
  /** Each knob's current level by name; 0 is full quality. */
  get levels(): Record<string, number> {
    return Object.fromEntries(this.knobs.map((knob) => [knob.name, knob.level]));
  }
  /** Every step of every knob with what it measured, cheapest knob level first. */
  get costs(): FeatureCost[] {
    return this.knobs.flatMap(({ name, levels, saved }) =>
      Array.from({ length: levels - 1 }, (_, level) => ({ name, level, saved: saved[level] })),
    );
  }
  /** Forget the running window and any step on trial, after a change the scaler did not make (a new scene). Measured savings stay. */
  restart(): void {
    this.sum = this.count = 0;
    this.trial = undefined;
    this.skip = this.settleFrames;
  }
  /**
   * Record one frame's cost in milliseconds. Returns the change when this sample made one, after applying it.
   * Non-finite or negative samples are ignored.
   */
  push(ms: number): FeatureChange | undefined {
    if (!Number.isFinite(ms) || ms < 0) return undefined;
    if (this.skip > 0) {
      this.skip--;
      return undefined;
    }
    this.sum += ms;
    if (++this.count < this.window) return undefined;
    const average = this.sum / this.count;
    this.sum = this.count = 0;
    return this.decide(average);
  }
  private decide(average: number): FeatureChange | undefined {
    for (const knob of this.knobs)
      knob.resting.forEach((left, step) => {
        if (left) knob.resting[step] = left - 1;
      });
    const trial = this.trial;
    this.trial = undefined;
    if (trial) {
      const { knob, step, before, down } = trial,
        measured = Math.max(0, down ? before - average : average - before),
        known = knob.saved[step];
      knob.saved[step] = known === undefined ? measured : (known + measured) / 2;
      if (down && measured < before * this.minSaving) {
        knob.resting[step] = REST;
        return this.move(knob, step);
      }
    }
    this.sinceRise++;
    if (average > this.budget) {
      this.calm = 0;
      const knob = this.lower(average - this.budget * 0.95);
      if (!knob) return undefined;
      // A drop soon after a rise means the rise was too eager: wait longer before trying again.
      if (this.sinceRise <= 3) this.holdOff = Math.min(32, this.holdOff * 2);
      this.trial = { knob, step: knob.level, before: average, down: true };
      return this.move(knob, knob.level + 1);
    }
    if (average < this.budget * 0.7) {
      if (++this.calm < this.holdOff) return undefined;
      const knob = this.raise(average);
      if (!knob) return undefined;
      this.calm = 0;
      this.sinceRise = 0;
      this.trial = { knob, step: knob.level - 1, before: average, down: false };
      return this.move(knob, knob.level - 1);
    }
    this.calm = Math.max(0, this.calm - 1);
    return undefined;
  }
  /** The step to take for a shortfall of `need` milliseconds, if any is left. */
  private lower(need: number): Knob | undefined {
    const open = this.knobs.filter((k) => k.level < k.levels - 1 && !k.resting[k.level]),
      saving = (k: Knob) => k.saved[k.level],
      enough = open
        .filter((k) => saving(k)! >= need)
        .sort((a, b) => a.weight - b.weight || saving(a)! - saving(b)!);
    return (
      enough[0] ??
      open.find((k) => saving(k) === undefined) ??
      open.sort((a, b) => saving(b)! / b.weight - saving(a)! / a.weight)[0]
    );
  }
  /** The most visible lowered knob whose measured cost fits under the budget, with a margin. */
  private raise(average: number): Knob | undefined {
    return this.knobs
      .filter((k) => k.level > 0 && average + (k.saved[k.level - 1] ?? 0) <= this.budget * 0.9)
      .sort((a, b) => b.weight - a.weight)[0];
  }
  private move(knob: Knob, level: number): FeatureChange {
    knob.level = level;
    knob.apply(level);
    this.skip = this.settleFrames;
    return { name: knob.name, level };
  }
  /** Puts every knob back at level 0. */
  reset(): void {
    for (const knob of this.knobs) if (knob.level) this.move(knob, 0);
    this.trial = undefined;
  }
}

/** Hooks of {@link watchFeatures}; timers default to the browser's own, so tests can inject them. */
export interface WatchFeaturesOptions extends FeatureScalerOptions, FrameTimers {
  /** Told each change. */
  onChange?: (change: FeatureChange) => void;
}

/** Stops {@link watchFeatures}. */
export interface FeatureWatch {
  /** The scaler at work: `levels`, `costs`, `budget`. */
  readonly scaler: FeatureScaler;
  /** Stop measuring and put every feature back. Also runs on `using` disposal. */
  dispose(): void;
  [Symbol.dispose](): void;
}

/**
 * While the scene runs, time each frame's GPU work and turn features down and up through a {@link FeatureScaler}.
 *
 * ```ts
 * using features = watchFeatures(featureKnobs({shadows, ssao, camera: engine.camera}), {budget: 12});
 * ```
 * @throws RangeError for invalid options (see {@link FeatureScaler}).
 */
export function watchFeatures(
  knobs: readonly FeatureKnob[],
  { request, queue, now, onChange, ...options }: WatchFeaturesOptions = {},
): FeatureWatch {
  const scaler = new FeatureScaler(knobs, options);
  let stopped = false;
  const stop = timeFrames({ request, queue, now }, (ms) => {
      if (stopped) return;
      const change = scaler.push(ms);
      if (change) onChange?.(change);
    }),
    dispose = () => {
      if (stopped) return;
      stopped = true;
      stop();
      scaler.reset();
    };
  return { scaler, dispose, [Symbol.dispose]: dispose };
}

/** A knob that writes `values[level]` to `target[key]`: `values[0]` is full quality. Use it for anything that reads an option live. */
export function optionKnob<T extends object, K extends keyof T>(
  name: string,
  target: T,
  key: K,
  values: readonly T[K][],
  weight = 1,
): FeatureKnob {
  return { name, levels: values.length, weight, apply: (level) => void (target[key] = values[level]) };
}

/** Effects and objects {@link featureKnobs} can turn down; pass what the app has. */
export interface FeatureTargets {
  /** Post effects that can be switched off, cheapest to lose first (`Bloom`, `DOF` and the like): their `enabled` goes false. */
  post?: readonly { name: string; enabled: boolean }[];
  /** `SSAO`: samples halve twice, then it switches off. */
  ssao?: { enabled: boolean; options: { samples?: number } };
  /** `SSR`: steps halve twice, then it switches off. */
  ssr?: { enabled: boolean; options: { steps?: number } };
  /**
   * `Shadows`: the filter goes soft, pcf, hard; a set `distance` falls to 70% and 50%; `resolution` halves twice;
   * `cascades` falls one at a time to two.
   */
  shadows?: {
    options: {
      filter?: 'soft' | 'pcf' | 'hard' | object;
      distance?: number;
      resolution?: number | readonly [number, number];
      cascades?: number;
      bounds?: unknown;
      frustum?: unknown;
    };
  };
  /** `VolumetricFog`: the grid halves, then it switches off. */
  volumetric?: { options: { enabled?: boolean; grid?: readonly [number, number, number] } };
  /** `LODSystem`: `bias` grows 1.5 and 2 times, so detail drops nearer the camera. */
  lod?: { bias: number };
  /** Camera: `far` falls to 75% and 50%. What lies past it stops drawing, so pair it with fog. */
  camera?: { far: number; near: number };
}

const halved = <K extends string>(
  name: string,
  effect: { enabled: boolean; options: Partial<Record<K, number>> },
  key: K,
  full: number,
  weight: number,
): FeatureKnob => ({
  name,
  levels: 4,
  weight,
  apply(level) {
    effect.enabled = level < 3;
    if (level < 3) effect.options[key] = Math.max(1, (full / 2 ** level) | 0) as never;
  },
});

/**
 * Knobs for the features an app passes, each starting from its current value, in the order they are tried before
 * anything is measured: post effects, ambient occlusion, reflections, shadows, volumetric fog, level of detail, view
 * distance. A feature already off gets no knob.
 */
export function featureKnobs({
  post = [],
  ssao,
  ssr,
  shadows,
  volumetric,
  lod,
  camera,
}: FeatureTargets): FeatureKnob[] {
  const knobs: FeatureKnob[] = post
    .filter((effect) => effect.enabled)
    .map((effect) => optionKnob(effect.name, effect, 'enabled', [true, false], 1));
  if (ssao?.enabled) knobs.push(halved('ssao', ssao, 'samples', ssao.options.samples ?? 32, 1));
  if (ssr?.enabled) knobs.push(halved('ssr', ssr, 'steps', ssr.options.steps ?? 64, 1));
  if (shadows) {
    const { options } = shadows,
      // A filter effect (`varianceFilter`) binds its own resources at construction: it is no step on this ladder.
      named = typeof options.filter === 'object' ? 'hard' : (options.filter ?? 'soft'),
      filters = (['soft', 'pcf', 'hard'] as const).slice(['soft', 'pcf', 'hard'].indexOf(named));
    if (filters.length > 1) knobs.push(optionKnob('shadow filter', options, 'filter', filters, 1.5));
    if (options.distance !== undefined) {
      const { distance } = options;
      knobs.push(optionKnob('shadow distance', options, 'distance', [distance, distance * 0.7, distance * 0.5], 1.5));
    }
    const { resolution = 2048, cascades = 4 } = options,
      smaller = (by: number) => {
        const edge = (size: number) => Math.max(16, size / by);
        return typeof resolution === 'number' ? edge(resolution) : ([edge(resolution[0]), edge(resolution[1])] as const);
      },
      sizes = [resolution, smaller(2), smaller(4)].filter(
        (size, i, all) => !i || JSON.stringify(size) !== JSON.stringify(all[i - 1]),
      );
    if (sizes.length > 1) knobs.push(optionKnob('shadow resolution', options, 'resolution', sizes, 2));
    if (!options.bounds && !options.frustum && cascades > 2) {
      const counts = Array.from({ length: cascades - 1 }, (_, i) => cascades - i);
      knobs.push(optionKnob('shadow cascades', options, 'cascades', counts, 2));
    }
  }
  if (volumetric && volumetric.options.enabled !== false) {
    const { options } = volumetric,
      grid = options.grid ?? ([160, 90, 64] as const),
      half = grid.map((size) => Math.max(2, size >> 1)) as unknown as readonly [number, number, number];
    knobs.push({
      name: 'volumetric fog',
      levels: 3,
      weight: 2,
      apply(level) {
        options.enabled = level < 2;
        if (level < 2) options.grid = level ? half : grid;
      },
    });
  }
  if (lod) knobs.push(optionKnob('level of detail', lod, 'bias', [lod.bias, lod.bias * 1.5, lod.bias * 2], 2));
  if (camera) {
    const far = [camera.far, camera.far * 0.75, camera.far * 0.5].filter((value) => value > camera.near);
    if (far.length > 1) knobs.push(optionKnob('view distance', camera, 'far', far, 3));
  }
  return knobs;
}
