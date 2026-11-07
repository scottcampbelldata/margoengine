import { MargoError } from '@margoengine/math/errors';
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
  /** What each state with `history` remembers, by state name. Delete a key, or clear it, to forget. */
  readonly memory = new Map<string, string>();
  private duration = 0;
  private changing = false;
  private readonly paths = new Map<string, readonly string[]>();
  /**
   * Build the machine and enter `initial` (and its ancestors).
   * @throws TypeError for an unknown parent, a hierarchy cycle, an unknown initial state, a state's `initial` that is
   * not its descendant, an unknown `history`, or an invalid transition.
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
        !transition.event ||
        !Number.isFinite(transition.duration ?? 0) ||
        (transition.duration ?? 0) < 0
      )
        throw new TypeError('Invalid transition; give from and to as existing state names');
    this.state = initial;
    this.state = this.resolve(initial);
    for (const name of this.paths.get(this.state)!) states[name].enter?.(context);
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
   * Change to `next` directly, exiting and entering only the states below the common ancestor. A `next` being entered
   * goes on to what it remembers, else to its `initial`; one already active goes on to its `initial`. No-op when that
   * is where the machine already is.
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
    next = this.resolve(next);
    if (next === this.state) return;
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
        state.exit?.(this.context);
      }
      this.previous = duration > 0 ? this.state : null;
      this.state = next;
      this.duration = duration;
      this.elapsed = 0;
      for (let i = common; i < to.length; i++) this.states[to[i]].enter?.(this.context);
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
