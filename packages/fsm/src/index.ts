import { MargoError } from '@margoengine/math/errors';
import type { ParallelRegions } from './parallel.js';
// More delayed transitions than this in one update means a chain of very short delays; the caller's delta is at fault.
const MAX_FIRED = 100000;
/** One state of a {@link StateMachine}; `C` is the shared context passed to every hook. */
export interface State<C> {
  /** Name of the parent state; ancestors stay entered while moving between their children. */
  parent?: string;
  /** Descendant to go on to when this state is the target of a transition. Default none: the machine stops here. */
  initial?: string;
  /**
   * Remember where the machine was when it left this state, and return there when it comes back: `'shallow'` to the
   * child that was active, which then starts as usual; `'deep'` to the exact innermost state. Before the first visit,
   * `initial` applies. Default none.
   */
  history?: 'shallow' | 'deep';
  /** Called on entry, outermost ancestor first. */
  enter?: (context: C) => void;
  /** Called on exit, innermost state first. */
  exit?: (context: C) => void;
  /** Called by `StateMachine.update` for each state on the active path, outermost first, with `delta` in seconds. */
  update?: (context: C, delta: number) => void;
  /**
   * Offer an event to a machine nested in this state, such as parallel regions. Runs on the active path before this
   * state's own transitions, so what is nested wins. Return the action that carries the event out, or null to pass.
   */
  plan?: (event: string) => (() => void) | null;
  /** The regions this state runs, set by `ParallelRegions.asState`, for saving and tracing. */
  regions?: ParallelRegions<C>;
}
/** Edge between two states, taken on an event or after a delay; `C` is the shared context the guard gets. */
export interface Transition<C = unknown> {
  /** Source state; also matches while a descendant of it is active. */
  from: string;
  /** Target state. */
  to: string;
  /** Event name passed to `StateMachine.send`; must be non-empty. Give this or `after`, not both. */
  event?: string;
  /**
   * Seconds in `from` after which `StateMachine.update` takes this transition by itself; finite and above 0. Give this
   * or `event`, not both. The time counts from entering `from`, so moving between its children does not restart it,
   * and leaving it cancels it. A guard that declines is asked again on every update until it passes.
   */
  after?: number;
  /** Cross-fade time in seconds; finite and >= 0. Default 0 (no cross-fade). */
  duration?: number;
  /** Return false to decline the transition. */
  guard?: (context: C) => boolean;
}

/** Hierarchical state transitions retain common ancestors and expose cross-fade progress. */
export class StateMachine<C> {
  /** Name of the current (innermost) state. */
  state: string;
  /** State being cross-faded from, or null when no cross-fade is running. */
  previous: string | null = null;
  /** Seconds since the last state change. */
  elapsed = 0;
  /** Seconds this machine has run, from every `update`. */
  clock = 0;
  /** Value of `clock` when each active state was entered, by state name, for delayed transitions. */
  readonly entered = new Map<string, number>();
  /** What each state with `history` remembers, by state name. Delete a key, or clear it, to forget. */
  readonly memory = new Map<string, string>();
  /** Length of the running cross-fade in seconds. */
  duration = 0;
  /** True while the hooks of a state change run. */
  changing = false;
  /** Called on every state change, before any hook, with the transition that caused it, or null for `goto`. */
  listener: ((from: string, to: string, transition: Transition<C> | null) => void) | null = null;
  private readonly paths = new Map<string, readonly string[]>();
  private readonly timed: readonly Transition<C>[];
  /**
   * Build the machine and enter `initial` (and its ancestors).
   * @throws TypeError for an unknown parent, a hierarchy cycle, an unknown initial state, a state's `initial` that is
   * not its descendant, an unknown `history`, or an invalid transition.
   */
  constructor(
    readonly states: Readonly<Record<string, State<C>>>,
    readonly initial: string,
    readonly context: C,
    readonly transitions: readonly Transition<C>[] = [],
  ) {
    for (const key of Object.keys(states)) {
      const path: string[] = [];
      let name: string | undefined = key;
      while (name !== undefined) {
        if (!Object.hasOwn(states, name) || path.includes(name))
          throw new TypeError('Unknown parent or hierarchy cycle; name an existing parent and avoid cycles');
        path.unshift(name);
        name = states[name].parent;
      }
      this.paths.set(key, path);
    }
    for (const key of Object.keys(states)) {
      const { initial: first, history } = states[key];
      if (first !== undefined && !(this.paths.get(first)?.includes(key) && first !== key))
        throw new TypeError(`Invalid initial of state ${key}; name one of its descendants`);
      if (history !== undefined && history !== 'shallow' && history !== 'deep')
        throw new TypeError(`Invalid history of state ${key}; use 'shallow' or 'deep'`);
    }
    if (!this.paths.has(initial)) throw new TypeError('Unknown initial state; name a state added with state()');
    for (const transition of transitions)
      if (
        !this.paths.has(transition.from) ||
        !this.paths.has(transition.to) ||
        !transition.event === (transition.after === undefined) ||
        !(transition.after === undefined || (Number.isFinite(transition.after) && transition.after > 0)) ||
        !Number.isFinite(transition.duration ?? 0) ||
        (transition.duration ?? 0) < 0
      )
        throw new TypeError(
          'Invalid transition; give from and to as existing state names, and either event or an after above 0',
        );
    this.timed = transitions.filter((transition) => transition.after !== undefined);
    this.state = initial;
    this.state = this.resolve(initial);
    for (const name of this.paths.get(this.state)!) {
      this.entered.set(name, 0);
      states[name].enter?.(context);
    }
  }
  /** Cross-fade progress in [0, 1]; 1 when no cross-fade is running. */
  get blend(): number {
    return this.previous && this.duration ? Math.min(1, this.elapsed / this.duration) : 1;
  }
  /** True while `name` is the current state or one of its ancestors. */
  matches(name: string): boolean {
    return this.paths.get(this.state)!.includes(name);
  }
  /**
   * Choose what `event` would do without doing it: guards run, nothing changes. Searches from the current state outward
   * to its ancestors, offering each state's `plan` hook first. Returns the action to run, or null when nothing matched.
   */
  plan(event: string): (() => void) | null {
    const path = this.paths.get(this.state)!;
    for (let i = path.length - 1; i >= 0; i--) {
      const nested = this.states[path[i]].plan?.(event);
      if (nested) return nested;
      for (const transition of this.transitions)
        if (transition.event === event && transition.from === path[i] && (!transition.guard || transition.guard(this.context)))
          return () => this.change(transition.to, transition.duration ?? 0, transition);
    }
    return null;
  }
  /**
   * Fire the first matching transition whose guard passes, searching as {@link StateMachine.plan} does.
   * Returns false when none matched. Throws as {@link StateMachine.goto} does.
   */
  send(event: string): boolean {
    const action = this.plan(event);
    action?.();
    return action !== null;
  }
  /**
   * Change to `next` directly, exiting and entering only the states below the common ancestor. A `next` being entered
   * goes on to what it remembers, else to its `initial`; one already active goes on to its `initial`. No-op when that
   * is where the machine already is.
   * @param duration Cross-fade time in seconds, finite and >= 0. Default 0.
   * @throws RangeError for an unknown state or invalid `duration`.
   * @throws MargoError `'state'` when called from an enter/exit hook.
   */
  goto(next: string, duration = 0): void {
    this.change(next, duration, null);
  }
  private change(next: string, duration: number, transition: Transition<C> | null): void {
    if (!this.paths.has(next) || !Number.isFinite(duration) || duration < 0)
      throw new RangeError('Invalid state transition; transition only to a state that exists');
    if (this.changing)
      throw new MargoError(
        'state',
        'Recursive state transition; call goto() after the current enter/exit callback returns',
      );
    next = this.resolve(next);
    if (next === this.state) return;
    this.listener?.(this.state, next, transition);
    const from = this.paths.get(this.state)!,
      to = this.paths.get(next)!;
    let common = 0;
    while (common < from.length && common < to.length && from[common] === to[common]) common++;
    this.changing = true;
    try {
      for (let i = from.length - 1; i >= common; i--) {
        const state = this.states[from[i]];
        if (state.history) {
          if (i === from.length - 1) this.memory.delete(from[i]);
          else this.memory.set(from[i], state.history === 'deep' ? this.state : from[i + 1]);
        }
        this.entered.delete(from[i]);
        state.exit?.(this.context);
      }
      this.previous = duration > 0 ? this.state : null;
      this.state = next;
      this.duration = duration;
      this.elapsed = 0;
      for (let i = common; i < to.length; i++) {
        this.entered.set(to[i], this.clock);
        this.states[to[i]].enter?.(this.context);
      }
    } finally {
      this.changing = false;
    }
  }
  // Where a transition to `name` ends: memory counts only for a state being entered, as one still active was never left.
  private resolve(name: string): string {
    const active = this.paths.get(this.state)!;
    for (;;) {
      const child = (active.includes(name) ? undefined : this.memory.get(name)) ?? this.states[name].initial;
      if (child === undefined) return name;
      name = child;
    }
  }
  /**
   * Advance the machine by `delta` seconds: the cross-fade timer, the active path's update hooks, and delayed
   * transitions. A delay that ends inside `delta` splits it: hooks get the time up to that moment, the transition runs,
   * and the rest goes to the new state, so one long update ends where many short ones do. Stops the hooks of a path if
   * a hook changes state.
   * @throws RangeError when `delta` is negative or not finite.
   * @throws MargoError `'state'` when delayed transitions fire over 100,000 times in one update.
   */
  update(delta: number): void {
    if (!Number.isFinite(delta) || delta < 0)
      throw new RangeError('Invalid state delta; pass a finite, non-negative number of seconds');
    let left = delta,
      fired = this.fire(0);
    do {
      const due = this.nextDue();
      if (due - this.clock < left) {
        const step = due - this.clock;
        this.clock = due;
        left -= step;
        this.advance(step);
      } else {
        const step = left;
        this.clock += step;
        left = 0;
        this.advance(step);
      }
      fired = this.fire(fired);
    } while (left > 0);
  }
  private advance(delta: number): void {
    this.elapsed += delta;
    if (this.previous && this.elapsed >= this.duration) this.previous = null;
    const path = this.paths.get(this.state)!;
    for (let i = 0; i < path.length; i++) {
      if (this.state !== path.at(-1)) break;
      this.states[path[i]].update?.(this.context, delta);
    }
  }
  // The next time a delay ends on the active path. One already over, held by its guard, does not stop the clock.
  private nextDue(): number {
    let due = Infinity;
    for (const transition of this.timed) {
      const entered = this.entered.get(transition.from);
      if (entered === undefined) continue;
      const end = entered + transition.after!;
      if (end > this.clock && end < due) due = end;
    }
    return due;
  }
  // Takes every delayed transition that is due, innermost first. Each waits again if its state stays active, so one
  // from a parent to its own child fires once per wait. Returns the count so far.
  private fire(count: number): number {
    if (!this.timed.length) return count;
    for (;;) {
      const transition = this.dueTransition();
      if (!transition) return count;
      if (++count > MAX_FIRED)
        throw new MargoError('state', 'Delayed transitions fire without end; use longer delays or a shorter delta');
      this.change(transition.to, transition.duration ?? 0, transition);
      if (this.entered.has(transition.from)) this.entered.set(transition.from, this.clock);
    }
  }
  private dueTransition(): Transition<C> | null {
    const path = this.paths.get(this.state)!;
    for (let i = path.length - 1; i >= 0; i--)
      for (const transition of this.timed)
        if (
          transition.from === path[i] &&
          this.clock >= this.entered.get(path[i])! + transition.after! &&
          (!transition.guard || transition.guard(this.context))
        )
          return transition;
    return null;
  }
}
