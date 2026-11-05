import { MargoError } from '@margoengine/math/errors';

/** What a system sees when it runs. One object is reused, so read it during the call and do not keep it. */
export interface ScheduleTime {
  /** Seconds this run covers: the fixed step in a fixed system, the frame's time otherwise. */
  delta: number;
  /** Seconds on this phase's clock: steps times the step for fixed systems, the sum of frame times otherwise. */
  elapsed: number;
  /** Runs of this phase so far, starting at 1: the step number in a fixed system, the frame number otherwise. */
  tick: number;
  /** Share of a step still waiting in the accumulator, in [0, 1): blend two fixed states with it. 0 in fixed systems. */
  alpha: number;
  /** True in a fixed system. */
  fixed: boolean;
}
/** A system: plain code that reads and writes components, usually through a closure over them. */
export type SystemRun = (time: Readonly<ScheduleTime>) => void;
/** Where and when a system runs. */
export interface SystemOptions {
  /** Names of systems this one runs before. Default none. */
  before?: readonly string[];
  /** Names of systems this one runs after. Default none. */
  after?: readonly string[];
  /** Run condition, asked before every run; the system is passed over when it returns false. Default: always run. */
  when?: (time: Readonly<ScheduleTime>) => boolean;
  /** Run in the fixed phase, zero or more times a frame at the schedule's step. Default false. */
  fixed?: boolean;
}
/** Settings of a {@link Schedule}. */
export interface ScheduleOptions {
  /** Seconds per fixed step, above 0. Default 1/60. */
  step?: number;
  /** Most fixed steps in one update; time past that is dropped, so a long stall cannot snowball. Default 8. */
  maxSteps?: number;
}

type Entry = {
  name: string;
  run: SystemRun;
  before: readonly string[];
  after: readonly string[];
  when: SystemOptions['when'];
  fixed: boolean;
  removed: boolean;
};

const names = (list: readonly string[] | undefined, what: string): readonly string[] => {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.some((name) => typeof name !== 'string'))
    throw new TypeError(`System ${what} is not a list of names; pass an array of system names`);
  return [...list];
};

/** Topological order, ties broken by the order systems were added, so the result never depends on anything else. */
function sort(entries: Entry[], edges: Map<Entry, Entry[]>): Entry[] {
  const waiting = new Map<Entry, number>(entries.map((entry) => [entry, 0]));
  for (const entry of entries)
    for (const next of edges.get(entry) ?? []) waiting.set(next, (waiting.get(next) as number) + 1);
  const sorted: Entry[] = [];
  while (sorted.length < entries.length) {
    const ready = entries.find((entry) => waiting.get(entry) === 0);
    if (!ready) {
      const stuck = entries.filter((entry) => (waiting.get(entry) as number) > 0).map((entry) => entry.name);
      throw new MargoError('state', `System order has a cycle among ${stuck.join(', ')}; remove a before or after`);
    }
    waiting.set(ready, -1);
    sorted.push(ready);
    for (const next of edges.get(ready) ?? []) waiting.set(next, (waiting.get(next) as number) - 1);
  }
  return sorted;
}

/**
 * Named systems in a dependable order. Each {@link Schedule.update} runs the fixed phase (every `fixed` system, once per
 * step the elapsed time pays for), then the frame phase (every other system, once). Order inside a phase comes from
 * `before` and `after`, then from the order of `add`.
 */
export class Schedule {
  /** Seconds per fixed step. */
  readonly step: number;
  /** Most fixed steps in one update. */
  readonly maxSteps: number;
  /** Seconds of frame time thrown away by the last update because of `maxSteps`. */
  dropped = 0;
  private readonly entries = new Map<string, Entry>();
  private fixedPhase: Entry[] | undefined;
  private framePhase: Entry[] = [];
  private accumulator = 0;
  private steps = 0;
  private frames = 0;
  private clock = 0;
  private running = false;
  private readonly time: ScheduleTime = { delta: 0, elapsed: 0, tick: 0, alpha: 0, fixed: false };
  /** @throws RangeError for a step that is not a finite number above 0, or a maxSteps that is not a positive integer. */
  constructor({ step = 1 / 60, maxSteps = 8 }: ScheduleOptions = {}) {
    if (!Number.isFinite(step) || step <= 0)
      throw new RangeError('Invalid schedule step; use a finite number of seconds above 0, e.g. 1 / 60');
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1)
      throw new RangeError('Invalid schedule maxSteps; use a positive integer, e.g. 8');
    this.step = step;
    this.maxSteps = maxSteps;
  }
  /**
   * Add a system. Added during an update, it first runs in the next one. Names in `before` and `after` are resolved by
   * the next update, so systems can be added in any order.
   * @throws TypeError for an empty or repeated name, or a `run`, `when`, `before` or `after` of the wrong type.
   */
  add(name: string, run: SystemRun, options: SystemOptions = {}): this {
    if (typeof name !== 'string' || !name) throw new TypeError('Invalid system name; pass a non-empty string');
    if (this.entries.has(name)) throw new TypeError(`System ${name} already exists; remove it or use another name`);
    if (typeof run !== 'function') throw new TypeError('Invalid system; pass a function');
    const { when, fixed = false } = options;
    if (when !== undefined && typeof when !== 'function')
      throw new TypeError('Invalid system condition; pass a function that returns a boolean');
    const before = names(options.before, 'before'),
      after = names(options.after, 'after');
    this.entries.set(name, { name, run, before, after, when, fixed: !!fixed, removed: false });
    this.fixedPhase = undefined;
    return this;
  }
  /** Remove a system; false when there is none. Removed during an update, it does not run again, in that update either. */
  remove(name: string): boolean {
    const entry = this.entries.get(name);
    if (!entry) return false;
    entry.removed = true;
    this.entries.delete(name);
    this.fixedPhase = undefined;
    return true;
  }
  /** True when a system has this name. */
  has(name: string): boolean {
    return this.entries.has(name);
  }
  /**
   * System names in run order, fixed phase first.
   * @throws MargoError `'state'` when `before` or `after` name a missing system, form a cycle, or ask a frame system to
   * run before a fixed one (the fixed phase always comes first).
   */
  order(): string[] {
    this.resolve();
    return [...(this.fixedPhase as Entry[]), ...this.framePhase].map((entry) => entry.name);
  }
  /**
   * Advance by `delta` seconds and run the systems; returns the number of fixed steps run. An error from a system
   * reaches the caller and ends the update; time not yet stepped stays in the accumulator.
   * @throws RangeError for a `delta` that is negative or not finite.
   * @throws MargoError `'state'` when called from inside a system, and for the order errors of {@link Schedule.order}.
   */
  update(delta: number): number {
    if (this.running) throw new MargoError('state', 'Schedule is already updating; do not call update from a system');
    if (!Number.isFinite(delta) || delta < 0)
      throw new RangeError('Invalid schedule delta; pass a finite number of seconds, 0 or more');
    this.resolve();
    const step = this.step,
      time = this.time,
      fixedPhase = this.fixedPhase as Entry[],
      framePhase = this.framePhase;
    this.running = true;
    try {
      this.accumulator += delta;
      let count = 0;
      time.delta = step;
      time.alpha = 0;
      time.fixed = true;
      while (this.accumulator >= step && count < this.maxSteps) {
        // Taken before the systems run: one that throws must not make the same step run twice.
        this.accumulator -= step;
        count++;
        time.tick = ++this.steps;
        time.elapsed = this.steps * step;
        this.pass(fixedPhase);
      }
      this.dropped = 0;
      if (this.accumulator >= step) {
        const left = this.accumulator % step;
        this.dropped = this.accumulator - left;
        this.accumulator = left;
      }
      this.clock += delta;
      time.delta = delta;
      time.elapsed = this.clock;
      time.tick = ++this.frames;
      time.alpha = this.accumulator / step;
      time.fixed = false;
      this.pass(framePhase);
      return count;
    } finally {
      this.running = false;
    }
  }
  private pass(phase: Entry[]): void {
    const time = this.time;
    for (let i = 0; i < phase.length; i++) {
      const entry = phase[i];
      if (!entry.removed && (!entry.when || entry.when(time))) entry.run(time);
    }
  }
  private resolve(): void {
    if (this.fixedPhase) return;
    const edges = new Map<Entry, Entry[]>();
    const link = (from: Entry, to: Entry): void => {
      // The fixed phase comes first, so this order always holds and needs no edge.
      if (from.fixed && !to.fixed) return;
      if (!from.fixed && to.fixed)
        throw new MargoError(
          'state',
          `Frame system ${from.name} cannot run before fixed system ${to.name}; the fixed phase runs first, so drop the order or make both fixed`,
        );
      const list = edges.get(from);
      if (list) list.push(to);
      else edges.set(from, [to]);
    };
    const find = (name: string, user: Entry): Entry => {
      const entry = this.entries.get(name);
      if (!entry)
        throw new MargoError('state', `System ${user.name} is ordered against ${name}, which is missing; add it`);
      return entry;
    };
    const all = [...this.entries.values()];
    for (const entry of all) {
      for (const name of entry.before) link(entry, find(name, entry));
      for (const name of entry.after) link(find(name, entry), entry);
    }
    const framePhase = sort(
      all.filter((entry) => !entry.fixed),
      edges,
    );
    this.fixedPhase = sort(
      all.filter((entry) => entry.fixed),
      edges,
    );
    this.framePhase = framePhase;
  }
}
