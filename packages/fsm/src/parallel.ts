import { MargoError } from '@margoengine/math/errors';
import { type State, StateMachine, type Transition } from './index.js';

/** One region of {@link ParallelRegions}: an ordinary machine's states, starting state and transitions. */
export interface Region<C> {
  /** The region's states, as for `StateMachine`. */
  states: Readonly<Record<string, State<C>>>;
  /** State the region starts in. */
  initial: string;
  /** The region's transitions. Default none. */
  transitions?: readonly Transition<C>[];
}
/** Options of {@link ParallelRegions}. */
export interface ParallelOptions {
  /** Each region resumes where it stopped instead of at its `initial` state. Default false. */
  history?: boolean;
  /**
   * Where an event from {@link ParallelRegions.raise} goes when no region takes it, usually the machine holding the
   * regions: `(event) => machine.send(event)`. Default none: the event is dropped.
   */
  forward?: (event: string) => void;
}

// A stopped region rests in this state, which has no hooks, so leaving and entering run the region's own hooks.
const STOPPED = '\0stopped';
// More raised events than this in one delivery means hooks are raising each other for ever.
const MAX_RAISED = 10000;

/**
 * Several state machines active at once, such as movement and weapon, sharing one context. Each region has one active
 * state of its own. An event reaches every region, and all regions choose before any of them moves, so the result does
 * not depend on the order of the regions. Regions are stopped until `start()`, or until the state from `asState()`
 * is entered.
 */
export class ParallelRegions<C> {
  /** The machine of each region, by name; use it for `blend`, `goto` and the like. */
  readonly machines: Readonly<Record<string, StateMachine<C>>>;
  /** True between `start()` and `stop()`. */
  running = false;
  private readonly list: readonly StateMachine<C>[];
  /** Where each region starts next, in region order. */
  readonly starts: string[];
  private readonly queue: string[] = [];
  private readonly forward: ((event: string) => void) | undefined;
  private readonly history: boolean;
  /** True during a delivery: while regions start, take an event or update. */
  busy = false;
  private draining = false;
  /**
   * @param regions The regions by name, in the order they enter and take updates.
   * @throws TypeError without a region, for an unknown `initial`, or for what `StateMachine` refuses.
   */
  constructor(
    readonly definition: Readonly<Record<string, Region<C>>>,
    readonly context: C,
    readonly options: ParallelOptions = {},
  ) {
    const names = Object.keys(definition);
    if (!names.length) throw new TypeError('ParallelRegions has no regions; name at least one region');
    this.list = names.map((name) => {
      const { states, initial, transitions } = definition[name];
      if (!Object.hasOwn(states, initial))
        throw new TypeError(`Unknown initial state of region ${name}; name one of the region's states`);
      return new StateMachine({ ...states, [STOPPED]: {} }, STOPPED, context, transitions);
    });
    // By entries, so a region may be called __proto__ when a document names it so.
    this.machines = Object.fromEntries(names.map((name, index) => [name, this.list[index]]));
    this.starts = names.map((name) => definition[name].initial);
    this.forward = options.forward;
    this.history = options.history ?? false;
  }
  /** The current state of each region, by name; null for all while stopped. */
  get active(): Record<string, string | null> {
    return Object.fromEntries(
      Object.entries(this.machines).map(([name, { state }]) => [name, state === STOPPED ? null : state]),
    );
  }
  /**
   * True while `region` is in `state` or a child of it. For a guard in another region, as in Harel's `in(S)`.
   * @throws RangeError for an unknown region.
   */
  matches(region: string, state: string): boolean {
    if (!Object.hasOwn(this.machines, region)) throw new RangeError('Unknown region; name a region of these regions');
    return this.machines[region].matches(state);
  }
  /**
   * Enter every region in order, each at its `initial` state, or where it stopped with `history`.
   * @throws MargoError `'state'` when already running.
   */
  start(): void {
    if (this.running) throw new MargoError('state', 'Regions already running; call stop() first');
    this.running = true;
    this.deliver(() => {
      for (let i = 0; i < this.list.length; i++) this.list[i].goto(this.starts[i]);
    });
  }
  /**
   * Leave every region, last region first. Events still waiting from `raise` are dropped.
   * @throws MargoError `'state'` when stopped, or when called from a region's hook during a delivery.
   */
  stop(): void {
    this.assertRunning();
    if (this.busy) throw new MargoError('state', 'Regions stopped from their own hook; use raise() and forward');
    this.queue.length = 0;
    this.running = false;
    for (let i = this.list.length - 1; i >= 0; i--) {
      if (this.history) this.starts[i] = this.list[i].state;
      this.list[i].goto(STOPPED);
    }
  }
  /**
   * Choose what every region would do with `event`, with no region moved yet: guards see the same states in all of
   * them. Returns the action that moves them, or null when no region takes the event.
   * @throws MargoError `'state'` when stopped.
   */
  plan(event: string): (() => void) | null {
    this.assertRunning();
    const actions: (() => void)[] = [];
    for (const machine of this.list) {
      const action = machine.plan(event);
      if (action) actions.push(action);
    }
    return actions.length
      ? () =>
          this.deliver(() => {
            for (const action of actions) action();
          })
      : null;
  }
  /**
   * Deliver `event` to every region. Returns true when at least one took it.
   * @throws MargoError `'state'` when stopped, or when called from a region's hook; use `raise` there.
   */
  send(event: string): boolean {
    if (this.busy) throw new MargoError('state', 'Event sent from a hook of these regions; use raise() there');
    const action = this.plan(event);
    action?.();
    return action !== null;
  }
  /**
   * Deliver `event` once what is running now has finished, after any events raised before it; at once if nothing is.
   * For a hook of one region to tell the others. An event no region takes goes to `forward`.
   * @throws MargoError `'state'` when stopped, or when hooks raise events for ever.
   */
  raise(event: string): void {
    this.assertRunning();
    this.queue.push(event);
    this.drain();
  }
  /**
   * Update every region in order, as `StateMachine.update` does. An update is a delivery: a hook uses `raise`.
   * @throws MargoError `'state'` when stopped. @throws RangeError when `delta` is negative or not finite.
   */
  update(delta: number): void {
    this.assertRunning();
    this.deliver(() => {
      for (const machine of this.list) machine.update(delta);
    });
  }
  /**
   * The state that runs these regions inside another machine: entering it starts them, leaving it stops them, and an
   * event reaches them before that state's own transitions. Spread it to add a `parent`: `{...regions.asState(), parent}`.
   */
  asState(): State<C> {
    return {
      enter: () => this.start(),
      exit: () => this.stop(),
      update: (_context, delta) => this.update(delta),
      plan: (event) => this.plan(event),
      regions: this,
    };
  }
  private assertRunning(): void {
    if (!this.running) throw new MargoError('state', 'Regions are stopped; call start() first');
  }
  // Runs one delivery and then every event raised during it. A hook that throws drops the events still waiting.
  private deliver(run: () => void): void {
    let finished = false;
    this.busy = true;
    try {
      run();
      finished = true;
    } finally {
      this.busy = false;
      if (!finished) this.queue.length = 0;
    }
    this.drain();
  }
  private drain(): void {
    if (this.busy || this.draining) return;
    let finished = false;
    this.draining = true;
    try {
      for (let count = 0; this.queue.length; count++) {
        if (count === MAX_RAISED)
          throw new MargoError('state', 'Hooks of these regions raise events for ever; end the chain of raise() calls');
        const event = this.queue.shift()!,
          action = this.plan(event);
        if (action) action();
        else this.forward?.(event);
      }
      finished = true;
    } finally {
      this.draining = false;
      if (!finished) this.queue.length = 0;
    }
  }
}
