import { MargoError } from '@margoengine/math/errors';
/** One state of a {@link StateMachine}; `C` is the shared context passed to every hook. */
export interface State<C> {
  /** Name of the parent state; ancestors stay entered while moving between their children. */
  parent?: string;
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
}
/** Event-driven edge between two states. */
export interface Transition {
  /** Source state; also matches while a descendant of it is active. */
  from: string;
  /** Target state. */
  to: string;
  /** Event name passed to `StateMachine.send`; must be non-empty. */
  event: string;
  /** Cross-fade time in seconds; finite and >= 0. Default 0 (no cross-fade). */
  duration?: number;
  /** Return false to decline the transition. */
  guard?: () => boolean;
}

/** Hierarchical state transitions retain common ancestors and expose cross-fade progress. */
export class StateMachine<C> {
  /** Name of the current (innermost) state. */
  state: string;
  /** State being cross-faded from, or null when no cross-fade is running. */
  previous: string | null = null;
  /** Seconds since the last state change. */
  elapsed = 0;
  private duration = 0;
  private changing = false;
  private readonly paths = new Map<string, readonly string[]>();
  /**
   * Build the machine and enter `initial` (and its ancestors).
   * @throws TypeError for an unknown parent, a hierarchy cycle, an unknown initial state, or an invalid transition.
   */
  constructor(
    readonly states: Readonly<Record<string, State<C>>>,
    initial: string,
    readonly context: C,
    readonly transitions: readonly Transition[] = [],
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
    if (!this.paths.has(initial)) throw new TypeError('Unknown initial state; name a state added with state()');
    for (const transition of transitions)
      if (
        !this.paths.has(transition.from) ||
        !this.paths.has(transition.to) ||
        !transition.event ||
        !Number.isFinite(transition.duration ?? 0) ||
        (transition.duration ?? 0) < 0
      )
        throw new TypeError('Invalid transition; give from and to as existing state names');
    this.state = initial;
    for (const name of this.paths.get(initial)!) states[name].enter?.(context);
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
        if (transition.event === event && transition.from === path[i] && (!transition.guard || transition.guard()))
          return () => this.goto(transition.to, transition.duration ?? 0);
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
   * Change to `next` directly, exiting and entering only the states below the common ancestor. No-op when already there.
   * @param duration Cross-fade time in seconds, finite and >= 0. Default 0.
   * @throws RangeError for an unknown state or invalid `duration`.
   * @throws MargoError `'state'` when called from an enter/exit hook.
   */
  goto(next: string, duration = 0): void {
    if (!this.paths.has(next) || !Number.isFinite(duration) || duration < 0)
      throw new RangeError('Invalid state transition; transition only to a state that exists');
    if (this.changing)
      throw new MargoError(
        'state',
        'Recursive state transition; call goto() after the current enter/exit callback returns',
      );
    if (next === this.state) return;
    const from = this.paths.get(this.state)!,
      to = this.paths.get(next)!;
    let common = 0;
    while (common < from.length && common < to.length && from[common] === to[common]) common++;
    this.changing = true;
    try {
      for (let i = from.length - 1; i >= common; i--) this.states[from[i]].exit?.(this.context);
      this.previous = duration > 0 ? this.state : null;
      this.state = next;
      this.duration = duration;
      this.elapsed = 0;
      for (let i = common; i < to.length; i++) this.states[to[i]].enter?.(this.context);
    } finally {
      this.changing = false;
    }
  }
  /**
   * Advance the cross-fade timer by `delta` seconds and run the active path's update hooks; stops if a hook changes state.
   * @throws RangeError when `delta` is negative or not finite.
   */
  update(delta: number): void {
    if (!Number.isFinite(delta) || delta < 0)
      throw new RangeError('Invalid state delta; pass a finite, non-negative number of seconds');
    this.elapsed += delta;
    if (this.previous && this.elapsed >= this.duration) this.previous = null;
    const path = this.paths.get(this.state)!;
    for (let i = 0; i < path.length; i++) {
      if (this.state !== path.at(-1)) break;
      this.states[path[i]].update?.(this.context, delta);
    }
  }
}
