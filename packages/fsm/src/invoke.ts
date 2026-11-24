import { FinalMachine, type FinalState, type FinalTransition } from './final.js';

/** An asynchronous service owned by one state's lifetime. */
export interface InvokedTask<C> {
  /** Unique non-empty id, used in done.invoke.id and error.invoke.id events. */
  id: string;
  /** Start work. Pass signal into fetch or other cancellable APIs; data is the entering event payload. */
  run: (context: C, signal: AbortSignal, data: unknown) => unknown | PromiseLike<unknown>;
}

/** State with one or several independently cancellable tasks. */
export interface InvokeState<C> extends FinalState<C> {
  /** Services started after the state reaches a stable configuration. Default none. */
  invoke?: InvokedTask<C> | readonly InvokedTask<C>[];
}

/** Inspectable lifecycle of one task instance. A re-entry creates a fresh record and signal. */
export interface Invocation {
  /** Owning state name. */
  state: string;
  /** Service id. */
  id: string;
  /** Signal aborted on state exit, top-level completion or disposal. */
  signal: AbortSignal;
  /** Current task state. */
  status: 'running' | 'done' | 'error' | 'cancelled';
  /** Resolved service value, if done. */
  output?: unknown;
  /** Rejected service value, if error. */
  error?: unknown;
  /** Resolves after delivery of done/error, or cancellation; rejects if an event handler throws. */
  settled: Promise<void>;
}

/** Options for the invoked-task runtime. */
export interface InvokeOptions {
  /** Abort the entire runtime and all its tasks. Default none. */
  signal?: AbortSignal;
}

/** FinalMachine with state-scoped promise tasks, cancellation and completion/error events. */
export class InvokeMachine<C> extends FinalMachine<C> {
  private readonly services: Readonly<Record<string, InvokeState<C>>>;
  private readonly live = new Map<string, { record: Invocation; abort: AbortController }>();
  private readonly detach: () => void;
  private closed = false;
  /** Latest invocation for each id, including finished and cancelled records. */
  readonly invocations = new Map<string, Invocation>();
  /** Build, settle initial transitions, then start services belonging to active nonfinal states. */
  constructor(states: Readonly<Record<string, InvokeState<C>>>, initial: string, context: C,
    transitions: readonly FinalTransition<C>[] = [], options: InvokeOptions = {}) {
    const ids = new Set<string>();
    for (const state of Object.values(states)) {
      const tasks = state.invoke === undefined ? [] : Array.isArray(state.invoke) ? state.invoke : [state.invoke];
      for (const task of tasks) {
        if (!task || typeof task.id !== 'string' || !task.id.length || ids.has(task.id) || typeof task.run !== 'function' || state.final)
          throw new TypeError('Invalid invoked task; give each service a unique non-empty id and run function on a nonfinal state');
        ids.add(task.id);
      }
    }
    let leaving: (name: string) => void = () => {};
    const adapted = Object.fromEntries(Object.entries(states).map(([name, state]) => [name, {
      ...state,
      exit: (c: C, data: unknown) => { state.exit?.(c, data); leaving(name); },
    }]));
    super(adapted, initial, context, transitions);
    this.services = states;
    leaving = name => {
      for (const [id, { record }] of this.live) if (record.state === name) this.cancel(id);
    };
    const stop = () => this.dispose();
    this.detach = () => options.signal?.removeEventListener('abort', stop);
    if (options.signal?.aborted) this.dispose();
    else {
      options.signal?.addEventListener('abort', stop, { once: true });
      this.onStable();
    }
  }
  /** Dispose all services. The underlying state definition remains available for inspection. */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.detach();
    for (const id of [...this.live.keys()]) this.cancel(id);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void { this.dispose(); }
  /** Closed runtimes no longer accept events. */
  override plan(event: string, data?: unknown): (() => void) | null {
    return this.closed ? null : super.plan(event, data);
  }
  /** Synchronize services with the stable active path, retaining services on common ancestors. */
  protected override onStable(data?: unknown): void {
    if (this.closed) return;
    for (const [id, { record }] of this.live) if (this.done || !this.matches(record.state)) this.cancel(id);
    if (this.done) return;
    const path: string[] = [];
    for (let at: string | undefined = this.state; at !== undefined; at = this.states[at].parent) path.unshift(at);
    for (const state of path) {
      const spec = this.services[state].invoke;
      const tasks: readonly InvokedTask<C>[] = spec === undefined ? [] : Array.isArray(spec) ? spec : [spec as InvokedTask<C>];
      for (const task of tasks) if (!this.live.has(task.id) && this.matches(state) && !this.closed) this.start(state, task, data);
    }
  }
  private cancel(id: string): void {
    const run = this.live.get(id)!;
    this.live.delete(id);
    if (run.record.status === 'running') run.record.status = 'cancelled';
    run.abort.abort();
  }
  private start(state: string, task: InvokedTask<C>, data: unknown): void {
    const abort = new AbortController();
    const record: Invocation = { state, id: task.id, signal: abort.signal, status: 'running', settled: Promise.resolve() };
    const run = { record, abort };
    this.live.set(task.id, run);
    this.invocations.set(task.id, record);
    let cancel!: () => void;
    const cancelled = new Promise<void>(resolve => { cancel = resolve; });
    const onAbort = () => { if (record.status === 'cancelled') cancel(); };
    abort.signal.addEventListener('abort', onAbort, { once: true });
    const result = new Promise<unknown>(resolve => resolve(task.run(this.context, abort.signal, data)));
    const delivered = result.then(
      output => {
        if (this.live.get(task.id) !== run || abort.signal.aborted) return;
        record.status = 'done'; record.output = output;
        this.send(`done.invoke.${task.id}`, { output });
      },
      error => {
        if (this.live.get(task.id) !== run || abort.signal.aborted) return;
        record.status = 'error'; record.error = error;
        this.send(`error.invoke.${task.id}`, { error });
      },
    );
    record.settled = Promise.race([delivered, cancelled]).finally(() => abort.signal.removeEventListener('abort', onAbort));
  }
}
