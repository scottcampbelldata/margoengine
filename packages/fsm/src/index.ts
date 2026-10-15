export interface State<C> {
  parent?: string;
  enter?: (context: C) => void;
  exit?: (context: C) => void;
  update?: (context: C, delta: number) => void;
}
export interface Transition {
  from: string;
  to: string;
  event: string;
  duration?: number;
  guard?: () => boolean;
}

/** Hierarchical state transitions retain common ancestors and expose cross-fade progress. */
export class StateMachine<C> {
  state: string;
  previous: string | null = null;
  elapsed = 0;
  private duration = 0;
  private changing = false;
  private readonly paths = new Map<string, readonly string[]>();
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
          throw new TypeError('Unknown parent or hierarchy cycle');
        path.unshift(name);
        name = states[name].parent;
      }
      this.paths.set(key, path);
    }
    if (!this.paths.has(initial)) throw new TypeError('Unknown initial state');
    for (const transition of transitions)
      if (
        !this.paths.has(transition.from) ||
        !this.paths.has(transition.to) ||
        !transition.event ||
        !Number.isFinite(transition.duration ?? 0) ||
        (transition.duration ?? 0) < 0
      )
        throw new TypeError('Invalid transition');
    this.state = initial;
    for (const name of this.paths.get(initial)!) states[name].enter?.(context);
  }
  get blend(): number {
    return this.previous && this.duration ? Math.min(1, this.elapsed / this.duration) : 1;
  }
  send(event: string): boolean {
    const path = this.paths.get(this.state)!;
    for (let i = path.length - 1; i >= 0; i--)
      for (const transition of this.transitions) {
        if (transition.event === event && transition.from === path[i] && (!transition.guard || transition.guard())) {
          this.goto(transition.to, transition.duration ?? 0);
          return true;
        }
      }
    return false;
  }
  goto(next: string, duration = 0): void {
    if (!this.paths.has(next) || !Number.isFinite(duration) || duration < 0)
      throw new RangeError('Invalid state transition');
    if (this.changing) throw new Error('Recursive state transition');
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
  update(delta: number): void {
    if (!Number.isFinite(delta) || delta < 0) throw new RangeError('Invalid state delta');
    this.elapsed += delta;
    if (this.previous && this.elapsed >= this.duration) this.previous = null;
    const path = this.paths.get(this.state)!;
    for (let i = 0; i < path.length; i++) {
      if (this.state !== path.at(-1)) break;
      this.states[path[i]].update?.(this.context, delta);
    }
  }
}
