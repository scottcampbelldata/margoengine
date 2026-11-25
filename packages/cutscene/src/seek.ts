// @margoengine/cutscene/seek: start a world at film time T showing what a continuous run shows at T. Every engine clock
// (cloud drift, wind, waves, wetness, lightning) adds up frame deltas, so a fresh process starts each at 0 and the sky
// jumps at every cut of a film rendered scene by scene. A closed form `setTime(t)` cannot fix that: n additions of
// 1/fps and n * (1/fps) differ in the last bits (Goldberg 1991), and wind, wetness and storms integrate over state that
// changes on the way. So a seek replays the clocks: the same `advanceTime(1 / fps)` calls in the same order that a
// continuous run made, with no draw (fixed steps make a simulation repeatable, Fiedler 2004). Equal by construction.
// A clock is any plugin with `advanceTime(delta)`, the CPU part of its frame update (no GPU call, no listener call),
// which its own `onPreUpdate(delta)` runs too, so a live frame and a replayed step do the same arithmetic.
import type { EnginePlugin, Scene } from '@margoengine/core';
import { MargoError } from '@margoengine/math/errors';

/** Something with its own clock that a seek can replay: a time-driven plugin, or one passed as `extra`. */
export interface Clock {
  /** Seconds on this clock since it started. A fresh clock reads 0. */
  readonly time: number;
  /** Moves the clock by `delta` seconds: the CPU part of one frame update, with no GPU call and no listener call. */
  advanceTime(delta: number): void;
}

/** Options of {@link advanceTime}. */
export interface AdvanceTimeOptions {
  /** Scenes whose plugins step, in this order. Default `[engine.scene]`. */
  scenes?: Iterable<Pick<Scene, 'plugins'>>;
  /** Clocks that are not plugins (an unattached WeatherMachine, a mixer), stepped after the plugins, in order. */
  extra?: Iterable<Clock>;
}

/** Options of {@link seek}. */
export interface SeekOptions extends AdvanceTimeOptions {
  /** Steps per second; each step advances every clock by `1 / fps`. Use the rate the film renders at. Default 60. */
  fps?: number;
  /** The steps themselves, in seconds, in place of `Math.round(seconds * fps)` steps of `1 / fps`: the deltas a
   * sub-framed film's renders gave its clocks (`subFrameSteps` from `@margoengine/headless/accumulate`). Each is
   * from 0 to 1. `onStep` then gets the running sum as its film time. Default none. */
  steps?: Iterable<number>;
  /** Runs before each step with the step number from 0 and its film time, so film code can set what clocks read. */
  onStep?: (step: number, time: number) => unknown;
  /** Stops the seek between steps with the signal's reason. */
  signal?: AbortSignal;
}

/** What {@link seek} did. */
export interface SeekResult {
  /** Steps run: `Math.round(seconds * fps)`, or the number of `steps` given. */
  steps: number;
  /** Names of the clocks it moved: plugin names, then `extra[i]` (or the clock's own string `name`). */
  clocks: string[];
  /** Plugins with a frame update but no `advanceTime`: they restart at a seek and show it, so list them in your report. */
  unseekable: string[];
}

/** What a seek reads of an engine: the plugins of its scene. An `Engine` fits, and so does `{ scene: { plugins: new Map() } }`. */
type Engine = { readonly scene: Pick<Scene, 'plugins'> };

const isClock = (value: unknown): value is Clock =>
  typeof (value as { advanceTime?: unknown } | null)?.advanceTime === 'function';

/** The clocks a step moves, in step order, with their names; plugins with an update but no clock go to `unseekable`. */
function collect(engine: Engine, options: AdvanceTimeOptions, unseekable?: string[]): [string, Clock][] {
  const clocks: [string, Clock][] = [];
  for (const scene of options.scenes ?? [engine.scene])
    for (const [name, plugin] of scene.plugins as ReadonlyMap<string, EnginePlugin>)
      if (isClock(plugin)) clocks.push([name, plugin]);
      else if (typeof plugin.onPreUpdate === 'function') unseekable?.push(name);
  let i = 0;
  for (const clock of options.extra ?? []) {
    if (!isClock(clock))
      throw new TypeError(`extra[${i}] needs advanceTime(delta); pass a clock such as a WeatherMachine`);
    const own = (clock as { name?: unknown }).name;
    clocks.push([typeof own === 'string' && own ? own : `extra[${i}]`, clock]);
    i++;
  }
  return clocks;
}

const checkDelta = (delta: number): void => {
  if (!Number.isFinite(delta) || delta < 0 || delta > 1)
    throw new RangeError('advanceTime needs a delta from 0 to 1 second, as a frame delta');
};

/**
 * Moves every clock one step of `delta` seconds without drawing: the plugins of each scene in attach order (the order
 * the engine updates them), then `extra`. Plugins without `advanceTime` are left alone. Run it where a continuous run
 * would draw a frame; a draw does not move any clock that `advanceTime` moves.
 */
export function advanceTime(engine: Engine, delta: number, options: AdvanceTimeOptions = {}): void {
  checkDelta(delta);
  for (const [, clock] of collect(engine, options)) clock.advanceTime(delta);
}

/**
 * Brings a fresh world to film time `seconds`: runs `Math.round(seconds * fps)` steps of `1 / fps` over every clock,
 * as {@link advanceTime} does, so the next live frame draws what a run started at 0 draws there, bit for bit. Every
 * clock must read 0 (a fresh start); a seek does not go back. Resolves with the step count and the clocks it moved.
 * Cost: steps x clocks `advanceTime` calls (15 minutes at 60 fps is 54,000 steps), CPU only.
 */
/** Checks a seek and collects its clocks, before any step: the part {@link seek} and {@link seekSync} share. */
function prepare(engine: Engine, seconds: number, options: SeekOptions) {
  const { fps = 60 } = options;
  if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError('seek needs a finite time of 0 or more seconds');
  if (!Number.isFinite(fps) || fps < 1) throw new RangeError('seek needs fps of 1 or more steps per second');
  options.signal?.throwIfAborted();
  const unseekable: string[] = [],
    clocks = collect(engine, options, unseekable);
  const moved = clocks.filter(([, clock]) => clock.time !== 0).map(([name]) => name);
  if (moved.length)
    throw new MargoError(
      'state',
      `seek needs a fresh start, and ${moved.join(', ')} already moved; seek before the first frame; see https://margoengine.com/errors#film-seek`,
    );
  const delta = 1 / fps;
  checkDelta(delta);
  const steps = options.steps ? [...options.steps] : undefined;
  if (steps) for (const step of steps) checkDelta(step);
  return { clocks, unseekable, steps: steps?.length ?? Math.round(seconds * fps), list: steps, delta, fps };
}

/**
 * Brings a fresh world to film time `seconds`: runs `Math.round(seconds * fps)` steps of `1 / fps` over every clock,
 * as {@link advanceTime} does, so the next live frame draws what a run started at 0 draws there, bit for bit. Every
 * clock must read 0 (a fresh start); a seek does not go back. Resolves with the step count and the clocks it moved.
 * Cost: steps x clocks `advanceTime` calls (15 minutes at 60 fps is 54,000 steps), CPU only.
 */
export async function seek(engine: Engine, seconds: number, options: SeekOptions = {}): Promise<SeekResult> {
  const { onStep, signal } = options,
    { clocks, unseekable, steps, list, delta, fps } = prepare(engine, seconds, options);
  let time = 0;
  for (let step = 0; step < steps; step++) {
    if (onStep) await onStep(step, list ? time : step / fps);
    const d = list ? list[step] : delta;
    time += d;
    for (const [, clock] of clocks) clock.advanceTime(d);
    // Let a timer or an abort run during a long seek: one turn of the event loop per 1,000 steps.
    if (signal && step % 1000 === 999) await new Promise((done) => setTimeout(done, 0));
    signal?.throwIfAborted();
  }
  return { steps, clocks: clocks.map(([name]) => name), unseekable };
}

/**
 * {@link seek} without waiting, for code that cannot await (a generator of frames): the same steps in the same order,
 * with no `onStep` and no turn of the event loop; a `signal` is checked before it starts.
 */
export function seekSync(engine: Engine, seconds: number, options: Omit<SeekOptions, 'onStep'> = {}): SeekResult {
  const { clocks, unseekable, steps, list, delta } = prepare(engine, seconds, options);
  for (let step = 0; step < steps; step++) for (const [, clock] of clocks) clock.advanceTime(list ? list[step] : delta);
  return { steps, clocks: clocks.map(([name]) => name), unseekable };
}
