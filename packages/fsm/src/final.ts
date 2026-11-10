import { MargoError } from '@margoengine/math/errors';
import { EventMachine, type EventState, type EventTransition } from './events.js';

const INTERNAL = '\0fsm.';
const ALWAYS = `${INTERNAL}always`;

/** A hierarchical state that may complete its containing state. */
export interface FinalState<C, D = unknown> extends EventState<C, D> {
  /** True for a terminal leaf. A top-level final stops the machine. Default false. */
  final?: boolean;
}

/** An ordinary transition or a guarded eventless transition. */
export interface FinalTransition<C, D = unknown> extends EventTransition<C, D> {
  /** Run without an external event when enabled. Give exactly one of always:true, event or after. */
  always?: boolean;
}

/** Run-to-completion state machine with final states, completion events and eventless transitions. */
export class FinalMachine<C, D = unknown> extends EventMachine<C, D> {
  private readonly definition: readonly FinalTransition<C, D>[];
  private readonly finalStates: Readonly<Record<string, FinalState<C, D>>>;
  private readonly queue: string[] = [];
  private lastFinal: string | null = null;
  private settling = false;
  private steps = 0;
  /** True after a top-level final state is entered. It accepts no more events or updates. */
  done = false;
  /** Build and settle initial eventless transitions and completion events before returning. */
  constructor(states: Readonly<Record<string, FinalState<C, D>>>, initial: string, context: C,
    transitions: readonly FinalTransition<C, D>[] = []) {
    for (const [name, state] of Object.entries(states)) {
      if (state.final !== undefined && typeof state.final !== 'boolean')
        throw new TypeError('Invalid final flag; use true or false');
      if (state.final && (state.initial !== undefined || state.regions ||
        Object.values(states).some(s => s.parent === name) || transitions.some(t => t.from === name)))
        throw new TypeError('Invalid final state; use a leaf with no outgoing transitions or regions');
    }
    for (const t of transitions) {
      if (Number(t.always === true) + Number(t.event !== undefined) + Number(t.after !== undefined) !== 1 ||
        (t.always !== undefined && t.always !== true) || t.event?.startsWith(INTERNAL) ||
        (t.after !== undefined && (!Number.isFinite(t.after) || t.after <= 0)))
        throw new TypeError('Invalid transition trigger; give event, positive after or always:true');
    }
    super(states, initial, context, transitions.map((t, i) => ({ ...t, after: undefined,
      event: t.always ? ALWAYS : t.after !== undefined ? `${INTERNAL}${i}` : t.event,
    })));
    this.definition = transitions;
    this.finalStates = states;
    this.stabilize(undefined);
  }
  /** Choose an external event and settle its complete macrostep when the returned action runs. */
  override plan(event: string, data?: D): (() => void) | null {
    if (event.startsWith(INTERNAL)) throw new TypeError('Reserved event name; use a name without a NUL prefix');
    if (this.done) return null;
    const action = super.plan(event, data);
    return action && (() => {
      action();
      this.stabilize(data);
      this.onStable(data);
    });
  }
  /** Deliver an event, then reconsider eventless guards even when no event transition accepts it. */
  override send(event: string, data?: D): boolean {
    const action = this.plan(event, data);
    action?.();
    if (!action && !this.done) { this.stabilize(data); this.onStable(data); }
    return action !== null;
  }
  /** Directly enter a state and settle its eventless and completion transitions. */
  override goto(next: string, duration = 0): void {
    super.goto(next, duration);
    this.done = false;
    this.stabilize(undefined);
    this.onStable();
  }
  /** Advance delays, settling each microstep before time can advance in the next state. */
  override update(delta: number): void {
    if (!Number.isFinite(delta) || delta < 0)
      throw new RangeError('Invalid state delta; pass finite non-negative seconds');
    if (this.done) return;
    this.stabilize(undefined);
    let left = delta, fired = 0;
    for (;;) {
      let taken = false;
      // Leaf priority and definition order, matching ordinary event selection.
      for (const name of this.activePath().reverse()) {
        for (let i = 0; i < this.definition.length; i++) {
          const t = this.definition[i];
          if (t.from !== name || t.after === undefined || this.clock < this.waitStart(i)! + t.after) continue;
          if (this.microstep(`${INTERNAL}${i}`, undefined)) {
            if (++fired > 100000) throw new MargoError('state', 'Too many delayed transitions; use longer delays or a shorter delta');
            if (this.entered.has(name)) this.waits.set(i, this.clock);
            this.stabilize(undefined);
            this.onStable();
            taken = true;
            break;
          }
        }
        if (taken) break;
      }
      if (this.done) break;
      if (taken) continue;
      if (left === 0) break;
      let step = left;
      for (let i = 0; i < this.definition.length; i++) {
        const t = this.definition[i], start = this.waitStart(i);
        if (start === undefined || t.after === undefined) continue;
        const distance = start + t.after - this.clock;
        if (distance > 0) step = Math.min(step, distance);
      }
      super.update(step);
      left -= step;
      this.stabilize(undefined);
    }
    this.onStable();
  }
  /** Extension point called once after a public operation reaches a stable configuration. */
  protected onStable(_data?: D): void {}
  private activePath(): string[] {
    const path: string[] = [];
    for (let name: string | undefined = this.state; name !== undefined; name = this.states[name].parent) path.unshift(name);
    return path;
  }
  private microstep(event: string, data: D | undefined): boolean {
    const action = super.plan(event, data);
    if (!action) return false;
    // Selection uses private event names; observers receive the public transition metadata.
    const saved = this.transitions.map(t => ({ event: t.event, after: t.after }));
    this.transitions.forEach((t, i) => { t.event = this.definition[i].event; t.after = this.definition[i].after; });
    try { action(); } finally { this.transitions.forEach((t, i) => Object.assign(t, saved[i])); }
    return true;
  }
  private stabilize(data: D | undefined): void {
    if (this.settling) return;
    this.settling = true;
    this.steps = 0;
    try {
      for (;;) {
        const state = this.finalStates[this.state];
        if (state.final && this.lastFinal !== this.state) {
          this.lastFinal = this.state;
          if (state.parent === undefined) { this.done = true; this.queue.length = 0; return; }
          this.queue.push(`done.state.${state.parent}`);
        } else if (!state.final) this.lastFinal = null;
        if (++this.steps > 10000)
          throw new MargoError('state', 'Eventless transitions do not settle; break the cycle with a guard or event');
        if (this.microstep(ALWAYS, data)) continue;
        const event = this.queue.shift();
        if (event === undefined) return;
        this.microstep(event, data);
      }
    } finally { this.settling = false; this.queue.length = 0; }
  }
}
