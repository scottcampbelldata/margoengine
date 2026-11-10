/// <reference lib="esnext.disposable" preserve="true" />
// A weather state machine: it holds the current state, blends toward a target over time, follows a schedule or a seeded
// random walk between presets, and integrates how wet the ground is and how much snow lies on it.
import { MargoError } from '@margoengine/math/errors';
import {
  WEATHER_PRESETS,
  blendStates,
  isPresetName,
  resolveState,
  wrapAngle,
  type BlendEase,
  type WeatherPresetName,
  type WeatherState,
} from './state.js';
import { settledGround } from './surface.js';
import { WindField } from './wind.js';

/** Settings of a {@link WeatherMachine}. */
export interface MachineOptions {
  /** Seed of the wind field's gusts and turbulence. Default 1. */
  seed?: number;
}

/** A target for a transition: a preset name, or any fields of a state (the rest keep their current values). */
export type WeatherTarget = WeatherPresetName | Partial<WeatherState>;

/** Options of {@link WeatherMachine.transitionTo}. */
export interface TransitionOptions {
  /** Seconds to blend, 0 or more; 0 jumps. Default 30. */
  seconds?: number;
  /** `'smoothstep'` (default) or `'linear'`. */
  ease?: BlendEase;
}

/** One step of a schedule. */
export interface ScheduleStep extends TransitionOptions {
  /** Where this step goes. */
  to: WeatherTarget;
  /** Seconds to stay at the target before the next step, 0 or more. Default 60. */
  hold?: number;
}

/** What the machine reports to listeners. */
export interface WeatherEvent {
  /** `'start'` when a transition begins, `'arrive'` when it finishes. */
  type: 'start' | 'arrive';
  /** The target of the transition. */
  target: Readonly<WeatherState>;
  /** The preset name when the target came from one. */
  preset?: WeatherPresetName;
}

/** Settings of {@link WeatherMachine.randomWalk}. */
export interface RandomWalkOptions {
  /** Presets it may visit and the relative weight of moving from each to each other one. A preset missing from `chain` is never visited. Default {@link TEMPERATE}. */
  chain?: Readonly<Partial<Record<WeatherPresetName, Readonly<Partial<Record<WeatherPresetName, number>>>>>>;
  /** Range in seconds of how long each weather lasts once reached. Default `[120, 480]`. */
  hold?: readonly [number, number];
  /** Range in seconds of each blend. Default `[40, 120]`. */
  blend?: readonly [number, number];
  /** Seed: the same seed and the same updates give the same weather. Default 1. */
  seed?: number;
}

/**
 * A mild climate: from each weather, the weathers it can turn into and how likely each is. Plain authoring data, not a
 * model of any real place.
 */
export const TEMPERATE: NonNullable<RandomWalkOptions['chain']> = {
  clear: { partlyCloudy: 5, fog: 1 },
  partlyCloudy: { clear: 3, overcast: 3, drizzle: 1 },
  overcast: { partlyCloudy: 2, drizzle: 3, rain: 3, fog: 1, snow: 0.5 },
  fog: { clear: 2, overcast: 2 },
  drizzle: { overcast: 3, rain: 2, partlyCloudy: 1 },
  rain: { drizzle: 3, overcast: 2, storm: 1, thunderstorm: 1 },
  storm: { rain: 4, thunderstorm: 2, hail: 1 },
  thunderstorm: { storm: 2, rain: 3, hail: 1 },
  hail: { rain: 4, storm: 1, overcast: 1 },
  sleet: { snow: 2, rain: 2, overcast: 1 },
  snow: { overcast: 3, sleet: 1, blizzard: 1, partlyCloudy: 1 },
  blizzard: { snow: 4, overcast: 1 },
};

const number = (value: unknown, name: string, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new RangeError(`${name} must be a finite number from ${min} to ${max}; got ${String(value)}`);
  return value;
};

interface Transition {
  from: WeatherState;
  to: WeatherState;
  seconds: number;
  ease: BlendEase;
  elapsed: number;
  preset?: WeatherPresetName;
}

/** Time constants in seconds for the ground (see {@link WeatherMachine.wetness}). */
const WET_UP = 20,
  WET_DOWN = 90,
  SNOW_UP = 120,
  SNOW_DOWN = 300;

/**
 * Holds the weather over time. Call `update(delta)` every frame (or from `onPreUpdate` of a plugin) and read `state`.
 * @example
 * const weather = new WeatherMachine('clear');
 * weather.transitionTo('thunderstorm', {seconds: 45});
 * weather.update(1 / 60);
 * weather.state.rain;
 */
export class WeatherMachine implements Disposable {
  private current: WeatherState;
  private transition: Transition | undefined;
  private steps:
    | { step: ScheduleStep; loop: boolean; index: number; list: readonly ScheduleStep[]; held: number; total: number }
    | undefined;
  private walk:
    | {
        options: Required<Omit<RandomWalkOptions, 'seed'>>;
        at: WeatherPresetName;
        held: number;
        total: number;
        state: number;
      }
    | undefined;
  private wet = 0;
  private snowLevel = 0;
  private clock = 0;
  private listeners = new Set<(event: WeatherEvent) => void>();
  private dispatching = false;
  private disposed = false;

  /** The wind in this weather: a field kept in step with the state's `wind`, `gust` and `windDirection` on every update. */
  readonly wind: WindField;

  /** @param initial A preset name or a state (default `'clear'`). */
  constructor(initial: WeatherTarget = 'clear', options: MachineOptions = {}) {
    this.current = resolveState(initial);
    this.wind = new WindField({ seed: options.seed ?? 1 });
    this.syncWind();
  }

  private syncWind(): void {
    const s = this.current;
    this.wind.set({ speed: s.wind, direction: s.windDirection, gust: s.gust, turbulence: 0.2 + 0.3 * s.gust });
  }

  /** The current blended state. A fresh copy each read, so changing it changes nothing. */
  get state(): WeatherState {
    return { ...this.current };
  }
  /** Seconds of weather time so far (the sum of the deltas). */
  get time(): number {
    return this.clock;
  }
  /** True while a transition is running. */
  get transitioning(): boolean {
    return this.transition !== undefined;
  }
  /** Progress of the running transition 0..1, or 1 when there is none. */
  get progress(): number {
    return this.transition
      ? this.transition.seconds === 0
        ? 1
        : this.transition.elapsed / this.transition.seconds
      : 1;
  }
  /**
   * How wet surfaces are, 0..1: rises under rain and hail (about 20 s), dries when it stops (about 90 s). Drive
   * roughness and darkening with it ({@link wetRoughness}).
   */
  get wetness(): number {
    return this.wet;
  }
  /** Snow lying on the ground, 0..1: builds under snow (about 2 minutes) and melts slowly (about 5 minutes). */
  get snowCover(): number {
    return this.snowLevel;
  }

  private alive(): void {
    if (this.disposed) throw new MargoError('disposed', 'WeatherMachine is disposed; create a new one');
  }

  /** Listens for transitions starting and arriving. Returns a function that stops listening. */
  on(listener: (event: WeatherEvent) => void): () => void {
    this.alive();
    if (typeof listener !== 'function')
      throw new TypeError('Weather listener must be a function; pass (event) => {...}');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: WeatherEvent): void {
    if (this.dispatching)
      throw new MargoError(
        'state',
        'A weather listener changed the weather it was called from; move the change out of the listener (for example to the next frame)',
      );
    this.dispatching = true;
    try {
      for (const listener of [...this.listeners]) listener(event);
    } finally {
      this.dispatching = false;
    }
  }

  /**
   * Starts blending from the current state to `target`. A running transition is replaced: the new one starts from
   * wherever the weather is now, so nothing jumps. A schedule or random walk is stopped.
   */
  transitionTo(target: WeatherTarget, { seconds = 30, ease = 'smoothstep' }: TransitionOptions = {}): this {
    this.alive();
    // Checked before anything stops: a rejected call leaves a running schedule or walk going.
    const to = this.checked(target, seconds, ease);
    this.steps = this.walk = undefined;
    this.begin(target, seconds, ease, to);
    return this;
  }

  private checked(target: WeatherTarget, seconds: number, ease: BlendEase): WeatherState {
    number(seconds, 'Transition seconds', 0, 86400);
    if (ease !== 'linear' && ease !== 'smoothstep')
      throw new TypeError(`Transition ease must be "linear" or "smoothstep"; got ${String(ease)}`);
    return resolveState(target, this.current);
  }

  private begin(
    target: WeatherTarget,
    seconds: number,
    ease: BlendEase,
    to = this.checked(target, seconds, ease),
  ): void {
    const preset = typeof target === 'string' ? target : undefined;
    const event: WeatherEvent = { type: 'start', target: Object.freeze({ ...to }), preset };
    this.transition = { from: { ...this.current }, to, seconds, ease, elapsed: 0, preset };
    this.emit(event);
    if (seconds === 0) this.finish();
  }

  private finish(): void {
    const t = this.transition;
    if (!t) return;
    this.current = { ...t.to };
    this.transition = undefined;
    const holder = this.steps ?? this.walk;
    if (holder) {
      holder.held = 0;
      holder.total = this.steps ? (this.steps.step.hold ?? 60) : this.pick(this.walk!.options.hold);
    }
    this.emit({ type: 'arrive', target: Object.freeze({ ...t.to }), preset: t.preset });
  }

  /** Jumps to `target` at once, ending any transition, schedule or random walk. */
  set(target: WeatherTarget): this {
    this.alive();
    const next = resolveState(target, this.current);
    this.steps = this.walk = undefined;
    this.transition = undefined;
    this.current = next;
    this.syncWind();
    return this;
  }

  /**
   * Runs steps one after another: blend to `to`, stay `hold` seconds, go on. With `loop` the list repeats. An empty
   * list or a bad step throws before anything changes. Replaces a running transition, schedule or random walk.
   */
  schedule(list: readonly ScheduleStep[], { loop = false }: { loop?: boolean } = {}): this {
    this.alive();
    if (!Array.isArray(list) || list.length === 0)
      throw new RangeError('Schedule needs at least one step such as {to: "rain", hold: 120}; pass a non-empty array');
    for (const step of list) {
      resolveState(step.to, this.current);
      number(step.hold ?? 60, 'Schedule hold', 0, 86400);
      number(step.seconds ?? 30, 'Schedule seconds', 0, 86400);
    }
    if (loop && list.reduce((sum, step) => sum + (step.hold ?? 60) + (step.seconds ?? 30), 0) <= 0)
      throw new RangeError('A looping schedule needs some time in it; give a step a hold or seconds above 0');
    this.walk = undefined;
    this.steps = { step: list[0], loop, index: 0, list, held: 0, total: -1 };
    this.begin(list[0].to, list[0].seconds ?? 30, list[0].ease ?? 'smoothstep');
    return this;
  }

  /**
   * Wanders between presets by a weighted chain, forever: blend, hold, pick the next weather from the current one's
   * row, repeat. Deterministic for a seed. Starts from the nearest preset name given as `from`, or the first key.
   */
  randomWalk(from: WeatherPresetName, options: RandomWalkOptions = {}): this {
    this.alive();
    const chain = options.chain ?? TEMPERATE,
      hold = options.hold ?? [120, 480],
      blendRange = options.blend ?? [40, 120];
    if (!isPresetName(from))
      throw new TypeError(
        `randomWalk starts from a preset name; use one of ${Object.keys(WEATHER_PRESETS).join(', ')}`,
      );
    for (const [name, label] of [
      [hold, 'hold'],
      [blendRange, 'blend'],
    ] as const) {
      if (!Array.isArray(name) || name.length !== 2)
        throw new TypeError(`randomWalk ${label} must be [min, max] seconds`);
      number(name[0], `randomWalk ${label} min`, 0, 86400);
      number(name[1], `randomWalk ${label} max`, name[0], 86400);
    }
    for (const [name, row] of Object.entries(chain)) {
      if (!isPresetName(name))
        throw new TypeError(
          `randomWalk chain has the unknown preset "${name}"; use one of ${Object.keys(WEATHER_PRESETS).join(', ')}`,
        );
      for (const [next, weight] of Object.entries(row ?? {})) {
        if (!isPresetName(next))
          throw new TypeError(
            `randomWalk chain has the unknown preset "${next}"; use one of ${Object.keys(WEATHER_PRESETS).join(', ')}`,
          );
        number(weight, `randomWalk weight ${name} -> ${next}`, 0, 1e6);
      }
    }
    if (hold[1] + blendRange[1] <= 0)
      throw new RangeError('randomWalk needs some time in it; give hold or blend a maximum above 0');
    this.steps = undefined;
    const seed = options.seed ?? 1;
    number(seed, 'randomWalk seed', -2147483648, 4294967295);
    this.walk = {
      options: { chain, hold, blend: blendRange },
      at: from,
      held: 0,
      total: -1,
      state: ((seed | 0) ^ 0x9e3779b9) >>> 0,
    };
    this.begin(from, this.pick(blendRange), 'smoothstep');
    return this;
  }

  /** Stops a schedule or random walk; a running blend finishes. */
  stop(): this {
    this.alive();
    this.steps = this.walk = undefined;
    return this;
  }

  private random(): number {
    // mulberry32
    const w = this.walk!;
    w.state = (w.state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(w.state ^ (w.state >>> 15), 1 | w.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  private pick(range: readonly [number, number]): number {
    return range[0] + (range[1] - range[0]) * this.random();
  }

  /**
   * Advances time by `delta` seconds: moves the blend, runs the schedule or walk, and integrates wetness and snow
   * cover. A long delta (a hidden tab) is applied in pieces of at most 5 s so the ground and the schedule behave as if
   * time had passed normally. Returns the new state.
   */
  update(delta: number): WeatherState {
    this.alive();
    if (typeof delta !== 'number' || !Number.isFinite(delta) || delta < 0)
      throw new RangeError(`Weather delta must be a finite number of seconds, 0 or more; got ${String(delta)}`);
    let left = delta;
    while (left > 0) {
      const dt = Math.min(left, 5);
      left -= dt;
      this.step(dt);
    }
    return this.state;
  }

  private step(dt: number): void {
    this.clock += dt;
    let remaining = dt;
    // Several short blends or holds can end inside one step; process them all, in order, until the step's time is
    // used. Only zero-length blends and holds pass without time, and a schedule or walk has time in every lap (checked
    // when it starts), so a run of them is bounded; past the bound something is wrong and it throws.
    for (let idle = 0; ; ) {
      const before = remaining;
      const t = this.transition,
        holder = this.steps ?? this.walk;
      if (t) {
        const used = Math.min(remaining, t.seconds - t.elapsed);
        t.elapsed += used;
        remaining -= used;
        if (t.elapsed < t.seconds) {
          this.current = blendStates(t.from, t.to, t.elapsed / t.seconds, t.ease);
          this.current.windDirection = wrapAngle(this.current.windDirection);
          break;
        }
        this.current = { ...t.to };
        this.finish();
      } else if (holder && holder.total >= 0) {
        const used = Math.min(remaining, holder.total - holder.held);
        holder.held += used;
        remaining -= used;
        if (holder.held < holder.total) break;
        holder.total = -1;
        this.advanceSchedule();
      } else break;
      idle = remaining === before ? idle + 1 : 0;
      if (idle > 2 * (this.steps?.list.length ?? 0) + 64)
        throw new RangeError('Weather schedule made no progress in time; give its steps a hold or seconds above 0');
    }
    this.ground(dt);
    this.syncWind();
  }

  private advanceSchedule(): void {
    if (this.steps) {
      const s = this.steps;
      let next = s.index + 1;
      if (next >= s.list.length) {
        if (!s.loop) {
          this.steps = undefined;
          return;
        }
        next = 0;
      }
      s.index = next;
      s.step = s.list[next];
      this.begin(s.step.to, s.step.seconds ?? 30, s.step.ease ?? 'smoothstep');
    } else if (this.walk) {
      const w = this.walk,
        row = Object.entries(w.options.chain[w.at] ?? {}).filter(([, weight]) => (weight ?? 0) > 0) as [
          WeatherPresetName,
          number,
        ][];
      const total = row.reduce((sum, [, weight]) => sum + weight, 0);
      if (total <= 0) {
        this.walk = undefined;
        return;
      }
      let r = this.random() * total,
        chosen = row[row.length - 1][0];
      for (const [name, weight] of row) {
        r -= weight;
        if (r < 0) {
          chosen = name;
          break;
        }
      }
      w.at = chosen;
      this.begin(chosen, this.pick(w.options.blend), 'smoothstep');
    }
  }

  private ground(dt: number): void {
    // First-order approach to a target: rain and hail wet the ground, snow settles, each with its own drying and melting.
    const approach = (value: number, goal: number, up: number, down: number) =>
      value + (goal - value) * (1 - Math.exp(-dt / (goal > value ? up : down)));
    const s = this.current;
    const goal = settledGround(s);
    this.wet = approach(this.wet, goal.wetness, WET_UP, WET_DOWN);
    this.snowLevel = approach(this.snowLevel, goal.snowCover, SNOW_UP, SNOW_DOWN);
  }

  /** Stops listening and ends all schedules. The machine cannot be used afterwards. */
  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.steps = this.walk = this.transition = undefined;
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
