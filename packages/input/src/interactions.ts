import type { ActionState } from './index.js';

/**
 * How a press counts:
 * - `tap`: pressed and released within `time`. Performed on release; held past `time` it cancels.
 * - `hold`: held for `time`. Performed while still held; released early it cancels.
 * - `slow-tap`: held for at least `time`, then released. Performed on release; released early it cancels.
 * - `double-press`: `count` presses, each shorter than `time` and each starting within `gap` of the last release.
 *   Performed on the last press; a press held too long or a gap too long cancels.
 */
export type InteractionType = 'tap' | 'hold' | 'slow-tap' | 'double-press';

/** One rule of {@link Interactions}, reading an action or one binding of it. */
export interface InteractionRule {
  type: InteractionType;
  /** The action to read. */
  action: string;
  /**
   * Read only this binding of the action, by its index in `input.actions[action]`, so one action can tap on the
   * keyboard and hold on the gamepad. A rebind keeps working: the index reads whatever is bound there. Default: the
   * whole action.
   */
  binding?: number;
  /** Milliseconds, as the type describes. Default 200 for `tap` and `double-press`, 400 for `hold`, 500 for `slow-tap`. */
  time?: number;
  /** `double-press`: longest gap in milliseconds between a release and the next press. Default 300. */
  gap?: number;
  /** `double-press`: presses needed, an integer of at least 2. Default 2. */
  count?: number;
  /** Magnitude that counts as pressed, above 0 and up to 1. It releases at three quarters of this. Default 0.5. */
  threshold?: number;
}

/** Result of one rule at the last {@link Interactions.update}. The object is reused across updates. */
export interface InteractionState {
  /** True on the update where a press began the rule. */
  started: boolean;
  /** True on the update where the rule succeeded. */
  performed: boolean;
  /** True on the update where the rule failed. */
  canceled: boolean;
  /** True from `started` until `performed` or `canceled`. */
  active: boolean;
  /** Share of `time` held so far, 0 to 1, for a charge bar; for `double-press`, the share of `count` pressed. */
  progress: number;
  /** Milliseconds since `started`. Keeps its last value once the rule ends. */
  duration: number;
}

/** What {@link Interactions} reads: an `Input`, or anything with the same two methods. */
export interface InteractionSource {
  state(action: string): Readonly<ActionState>;
  bindingValue(action: string, binding: number): number;
}

/** Options for {@link Interactions}. */
export interface InteractionOptions {
  /** Clock in milliseconds. Default `performance.now`. */
  now?: () => number;
}

const TIMES: Record<InteractionType, number> = { tap: 200, hold: 400, 'slow-tap': 500, 'double-press': 200 };

class Track {
  readonly state: InteractionState = {
    started: false,
    performed: false,
    canceled: false,
    active: false,
    progress: 0,
    duration: 0,
  };
  held = false;
  /** The rule has ended on this press; nothing starts until it is released. */
  spent = false;
  start = 0;
  /** `double-press`: when the current press began and the last one ended, and how many there have been. */
  pressAt = 0;
  releaseAt = 0;
  presses = 0;
  constructor(
    readonly type: InteractionType,
    readonly action: string,
    readonly binding: number | undefined,
    readonly time: number,
    readonly gap: number,
    readonly count: number,
    readonly threshold: number,
  ) {}
}

/**
 * Tap, hold, slow tap and double press rules over the actions of an `Input`. Rules are named, like actions, and read
 * after `input.update()`:
 *
 * ```ts
 * const rules = new Interactions(input, { open: { type: 'tap', action: 'use' }, inspect: { type: 'hold', action: 'use' } });
 * input.update();
 * rules.update();
 * if (rules.state('inspect').performed) inspect();
 * ```
 *
 * Rules are independent: one press can start several, and each ends by its own rule.
 */
export class Interactions {
  private readonly tracks = new Map<string, Track>();
  private readonly list: Track[] = [];
  private readonly source: InteractionSource;
  private readonly now: () => number;
  /**
   * @throws TypeError for an empty rule name, an unknown type or action, or a binding that is not an integer >= 0.
   * @throws RangeError for a `time` below 0 (0 only for `hold` and `slow-tap`), a `gap` not above 0, a `count` below 2,
   * or a `threshold` outside (0, 1].
   */
  constructor(
    source: InteractionSource,
    rules: Readonly<Record<string, InteractionRule>>,
    { now = () => performance.now() }: InteractionOptions = {},
  ) {
    if (typeof source?.state !== 'function' || typeof source.bindingValue !== 'function')
      throw new TypeError('Interactions reads an Input; pass one as the first argument');
    if (typeof now !== 'function') throw new TypeError('Interactions now must be a function returning milliseconds');
    this.source = source;
    this.now = now;
    for (const [name, rule] of Object.entries(rules)) {
      if (!name || !rule || !Object.hasOwn(TIMES, rule.type))
        throw new TypeError("Invalid interaction; use a named rule of type 'tap', 'hold', 'slow-tap' or 'double-press'");
      source.state(rule.action);
      const { binding, time = TIMES[rule.type], gap = 300, count = 2, threshold = 0.5 } = rule;
      if (binding !== undefined && (!Number.isInteger(binding) || binding < 0))
        throw new TypeError('Interaction binding must be an index into the bindings of the action, an integer >= 0');
      const instant = rule.type === 'hold' || rule.type === 'slow-tap';
      if (!Number.isFinite(time) || time < 0 || (!instant && time === 0))
        throw new RangeError('Interaction time is in milliseconds; only hold and slow-tap may use 0');
      if (!Number.isFinite(gap) || gap <= 0) throw new RangeError('Interaction gap must be in milliseconds, above 0');
      if (!Number.isInteger(count) || count < 2) throw new RangeError('Interaction count must be an integer of at least 2');
      if (!(threshold > 0 && threshold <= 1)) throw new RangeError('Interaction threshold must be above 0 and up to 1');
      const track = new Track(rule.type, rule.action, binding, time, gap, count, threshold);
      this.tracks.set(name, track);
      this.list.push(track);
    }
  }
  /**
   * Live state of a rule, refreshed by each {@link Interactions.update}.
   * @throws TypeError for an unknown rule.
   */
  state(rule: string): Readonly<InteractionState> {
    const track = this.tracks.get(rule);
    if (!track) throw new TypeError('Unknown interaction; add it to the rules given to the constructor');
    return track.state;
  }
  /** Advance every rule. Call once per tick, after `input.update()`. */
  update(): void {
    const now = this.now();
    for (let i = 0; i < this.list.length; i++) this.step(this.list[i], now);
  }
  /** Drop every press in progress, without a `canceled`: all rules are idle until the next press. */
  reset(): void {
    for (const track of this.list) {
      const state = track.state;
      state.started = state.performed = state.canceled = state.active = false;
      state.progress = state.duration = 0;
      track.spent = track.held;
    }
  }
  private step(track: Track, now: number): void {
    const state = track.state,
      value = Math.abs(
        track.binding === undefined
          ? this.source.state(track.action).value
          : this.source.bindingValue(track.action, track.binding),
      ),
      was = track.held,
      held = value >= (was ? track.threshold * 0.75 : track.threshold),
      released = was && !held;
    track.held = held;
    state.started = state.performed = state.canceled = false;
    if (track.spent) {
      if (!held) track.spent = false;
      return;
    }
    if (!state.active) {
      if (!held) return;
      state.active = state.started = true;
      state.progress = state.duration = 0;
      track.start = track.pressAt = now;
      track.presses = 1;
    }
    const elapsed = now - track.start;
    state.duration = elapsed;
    state.progress = track.time > 0 ? Math.min(1, elapsed / track.time) : 1;
    switch (track.type) {
      case 'hold':
        if (!held) this.end(track, false);
        else if (elapsed >= track.time) this.end(track, true);
        break;
      case 'tap':
        if (released) this.end(track, elapsed <= track.time);
        else if (elapsed > track.time) this.end(track, false);
        break;
      case 'slow-tap':
        if (released) this.end(track, elapsed >= track.time);
        break;
      case 'double-press':
        this.stepPresses(track, now, held, !was && held && !state.started, released);
        break;
    }
  }
  private stepPresses(track: Track, now: number, held: boolean, pressed: boolean, released: boolean): void {
    const state = track.state;
    if (pressed) {
      // A press after the gap ran out ends this sequence; the next update begins a new one from it.
      if (now - track.releaseAt > track.gap) {
        this.end(track, false);
        track.spent = false;
        return;
      }
      track.presses++;
      track.pressAt = now;
    }
    state.progress = track.presses / track.count;
    if (held && track.presses >= track.count) this.end(track, true);
    else if (held || released) {
      if (now - track.pressAt > track.time) this.end(track, false);
      else if (released) track.releaseAt = now;
    } else if (now - track.releaseAt > track.gap) this.end(track, false);
  }
  private end(track: Track, performed: boolean): void {
    const state = track.state;
    state.active = false;
    state.performed = performed;
    state.canceled = !performed;
    if (performed) state.progress = 1;
    track.spent = track.held;
  }
}
