import { StateMachine, type State, type Transition } from './index.js';
import { MachineTrace, type TraceOptions, type TraceRecord } from './trace.js';

/** Payload-aware hooks. Initial entry, direct goto and timed updates receive undefined data. */
export interface EventState<C, D = unknown> extends Omit<State<C>, 'enter' | 'exit' | 'plan'> {
  /** Entry hook, receiving the exact payload supplied to send. */
  enter?: (context: C, data: D | undefined) => void;
  /** Exit hook, receiving the same payload as the guard. */
  exit?: (context: C, data: D | undefined) => void;
  /** Offer an event and its payload to a nested machine before the containing state's transitions. */
  plan?: (event: string, data: D | undefined) => (() => void) | null;
}

/** A transition whose guard can inspect event data. */
export interface EventTransition<C, D = unknown> extends Omit<Transition<C>, 'guard'> {
  /** Return true to accept this event and payload. */
  guard?: (context: C, data: D | undefined) => boolean;
}

/** Optional payload delivery over the existing hierarchy, history and delay runtime. */
export class EventMachine<C, D = unknown> extends StateMachine<C> {
  private readonly delivery: { data: D | undefined };
  /** Build and enter the machine. Data is passed by reference, never cloned or merged into context. */
  constructor(states: Readonly<Record<string, EventState<C, D>>>, initial: string, context: C,
    transitions: readonly EventTransition<C, D>[] = []) {
    const delivery: { data: D | undefined } = { data: undefined };
    const adapted = Object.fromEntries(Object.entries(states).map(([name, state]) => [name, {
      ...state,
      enter: state.enter && ((c: C) => state.enter!(c, delivery.data)),
      exit: state.exit && ((c: C) => state.exit!(c, delivery.data)),
      plan: state.plan && ((event: string) => state.plan!(event, delivery.data)),
    }]));
    super(adapted, initial, context, transitions.map(t => ({ ...t,
      guard: t.guard && ((c: C) => t.guard!(c, delivery.data)),
    })));
    this.delivery = delivery;
  }
  /** Payload of the delivery currently running; undefined outside delivery. */
  get data(): D | undefined { return this.delivery.data; }
  /** Choose with this payload and retain it in the returned action, even if other events intervene. */
  override plan(event: string, data?: D): (() => void) | null {
    const action = this.deliver(data, () => super.plan(event));
    return action && (() => this.deliver(data, action));
  }
  /** Deliver one event with optional data; returns whether a transition accepted it. */
  override send(event: string, data?: D): boolean {
    const action = this.plan(event, data);
    action?.();
    return action !== null;
  }
  private deliver<T>(data: D | undefined, action: () => T): T {
    const previous = this.delivery.data;
    this.delivery.data = data;
    try { return action(); } finally { this.delivery.data = previous; }
  }
}

/** Transition trace with the original event payload by reference. */
export interface EventTraceRecord<D = unknown> extends TraceRecord {
  /** Payload supplied to send; undefined for a direct or timed transition. */
  data: D | undefined;
}

/** Bounded trace retaining payloads alongside the ordinary machine trace fields. */
export class EventTrace<C, D = unknown> extends MachineTrace<C> {
  /** Attach a trace. As MachineTrace, dispose it before attaching another listener. */
  constructor(machine: EventMachine<C, D>, options: TraceOptions = {}) {
    super(machine, options);
    const listener = machine.listener!;
    machine.listener = (from, to, transition) => {
      listener(from, to, transition);
      Object.assign(super.records.at(-1)!, { data: machine.data });
    };
  }
  /** Records oldest first, including the exact payload of each accepted transition. */
  override get records(): EventTraceRecord<D>[] { return super.records as EventTraceRecord<D>[]; }
}
