/// <reference lib="esnext.disposable" preserve="true" />
// Behaviour-tree runtime. Nodes are compiled once from the JSON description into small objects that keep their own
// running state; `tick(delta)` walks them depth first. Time is the sum of the deltas passed to `tick` and randomness is
// one seeded mulberry32 stream, so the same description, seed, handlers and deltas give the same statuses every run.
import { MargoError } from '@margoengine/math/errors';
import { createRandom } from '@margoengine/math/mathutils';
import { Blackboard } from './blackboard.js';
import { type NodeSpec, type ParallelPolicy, type Status, type TreeDocument, parseTree } from './spec.js';

/** What a handler receives on every call. `C` is the caller's context (the agent, its entity id, the world). */
export interface TickContext<C> {
  /** The tree's blackboard. */
  readonly blackboard: Blackboard;
  /** The context passed to the tree. */
  readonly context: C;
  /** Seconds passed to this `tick`. */
  readonly delta: number;
  /** Tree time: the sum of every `tick` delta so far, seconds. */
  readonly time: number;
  /** The tree's seeded random stream, floats in [0, 1). */
  readonly random: () => number;
  /**
   * Aborted when the running action is halted (a guard fails, a timeout, a higher-priority branch takes over,
   * `halt()` or `dispose()`). Pass it to `fetch`, timers and loaders so the work stops with the branch.
   */
  readonly signal: AbortSignal;
}

/** What an action returns: a status, a boolean (true = success), nothing (success) or a promise of one of these. */
export type ActionResult = Status | boolean | undefined | void;
/** An action handler: synchronous, or async (return a promise) for work that spans several ticks. */
export type ActionHandler<C> = (tick: TickContext<C>) => ActionResult | PromiseLike<ActionResult>;
/** A condition handler: true for `success`. */
export type ConditionHandler<C> = (tick: TickContext<C>) => boolean;
/** A utility score handler: a finite number, usually in [0, 1]; the best-scoring option runs. */
export type ScoreHandler<C> = (tick: TickContext<C>) => number;

/** The code a description's names refer to. */
export interface BehaviorHandlers<C> {
  actions?: Readonly<Record<string, ActionHandler<C>>>;
  conditions?: Readonly<Record<string, ConditionHandler<C>>>;
  scores?: Readonly<Record<string, ScoreHandler<C>>>;
}

/** Options of {@link BehaviorTree}. */
export interface BehaviorTreeOptions<C> {
  /** The handlers the description names. Every name must be present. */
  handlers: BehaviorHandlers<C>;
  /** Passed to every handler as `tick.context` (default undefined). */
  context?: C;
  /** Shared memory (default a new, empty {@link Blackboard}). */
  blackboard?: Blackboard;
  /** Seed of the random stream used by random selectors and `tick.random` (default 0). */
  seed?: number;
  /** Record a {@link TraceEntry} for every node ticked, readable as `tree.trace` after each tick (default false). */
  trace?: boolean;
}

/** One node visited during a tick, for debug views: depth-first order, so `depth` draws the tree. */
export interface TraceEntry {
  /** Path of the node in the description, e.g. `root.children[1].child`. */
  path: string;
  /** Nesting depth (0 for the root). */
  depth: number;
  /** Node type. */
  type: NodeSpec['type'];
  /** The node's `label`, else its handler name, else its type. */
  name: string;
  /** What the node returned this tick. */
  status: Status;
  /** Utility nodes: the score of each option this tick. */
  scores?: number[];
}

/**
 * Text view of a trace, one node per line, indented by depth: `[R] sequence`, `  [S] condition seesEnemy`.
 * `[S]` success, `[F]` failure, `[R]` running.
 */
export function formatTrace(trace: readonly TraceEntry[]): string {
  const mark = { success: 'S', failure: 'F', running: 'R' } as const;
  return trace
    .map(
      (entry) =>
        `${'  '.repeat(entry.depth)}[${mark[entry.status]}] ${entry.type}${entry.name === entry.type ? '' : ` ${entry.name}`}${
          entry.scores ? ` (${entry.scores.map((score) => +score.toFixed(3)).join(', ')})` : ''
        }`,
    )
    .join('\n');
}

interface Runtime {
  tick: TickContext<unknown>;
  trace: TraceEntry[] | null;
}

abstract class Node {
  open = false;
  constructor(
    readonly spec: NodeSpec,
    readonly path: string,
    readonly depth: number,
  ) {}
  get name(): string {
    const spec = this.spec as { label?: string; name?: string; condition?: string };
    return spec.label ?? spec.name ?? spec.condition ?? this.spec.type;
  }
  run(rt: Runtime): Status {
    const at = rt.trace ? rt.trace.push(undefined as never) - 1 : -1;
    const status = this.step(rt);
    this.open = status === 'running';
    if (rt.trace)
      rt.trace[at] = {
        path: this.path,
        depth: this.depth,
        type: this.spec.type,
        name: this.name,
        status,
        ...this.extra(),
      };
    return status;
  }
  /** Stop the node if it is running (aborting its tasks) and forget its progress. */
  halt(): void {
    if (this.open) this.stop();
    this.open = false;
    this.reset();
  }
  protected extra(): Partial<TraceEntry> {
    return {};
  }
  protected stop(): void {}
  protected reset(): void {}
  protected abstract step(rt: Runtime): Status;
}

class Composite extends Node {
  current = 0;
  order: number[] | null = null;
  constructor(
    spec: NodeSpec,
    path: string,
    depth: number,
    readonly children: Node[],
    readonly stopOn: Status,
    readonly reactive: boolean,
    readonly weights: number[] | null,
  ) {
    super(spec, path, depth);
  }
  protected step(rt: Runtime): Status {
    const children = this.children;
    if (this.weights && !this.order) this.order = shuffle(this.weights, rt.tick.random);
    const start = this.reactive ? 0 : this.current;
    for (let i = start; i < children.length; i++) {
      const child = children[this.order ? this.order[i] : i];
      const status = child.run(rt);
      if (status === 'running' || status === this.stopOn) {
        // A reactive re-check that settled on an earlier child halts the one that was running further on.
        for (let j = i + 1; j < children.length; j++) children[this.order ? this.order[j] : j].halt();
        if (status === 'running') this.current = i;
        else this.finish();
        return status;
      }
    }
    this.finish();
    return this.stopOn === 'failure' ? 'success' : 'failure';
  }
  private finish(): void {
    this.current = 0;
    this.order = null;
  }
  protected override stop(): void {
    for (const child of this.children) child.halt();
  }
  protected override reset(): void {
    this.finish();
  }
}

/** Weighted random order without replacement: repeatedly draw a remaining index with probability by weight. */
function shuffle(weights: readonly number[], random: () => number): number[] {
  const left = weights.map((_, index) => index),
    order: number[] = [];
  while (left.length) {
    let total = 0;
    for (const index of left) total += weights[index];
    let pick = left.length - 1;
    if (total > 0) {
      let r = random() * total;
      for (let k = 0; k < left.length; k++) {
        r -= weights[left[k]];
        if (r < 0) {
          pick = k;
          break;
        }
      }
    } else pick = 0;
    order.push(left.splice(pick, 1)[0]);
  }
  return order;
}

const needed = (policy: ParallelPolicy, total: number): number =>
  policy === 'all' ? total : policy === 'any' ? 1 : policy;

class Parallel extends Node {
  private readonly done: (Status | null)[];
  constructor(
    spec: NodeSpec,
    path: string,
    depth: number,
    readonly children: Node[],
    readonly successes: number,
    readonly failures: number,
  ) {
    super(spec, path, depth);
    this.done = children.map(() => null);
  }
  protected step(rt: Runtime): Status {
    let succeeded = 0,
      failed = 0;
    this.children.forEach((child, index) => {
      if (this.done[index] === null) {
        const status = child.run(rt);
        if (status !== 'running') this.done[index] = status;
      }
      if (this.done[index] === 'success') succeeded++;
      else if (this.done[index] === 'failure') failed++;
    });
    const result: Status = failed >= this.failures ? 'failure' : succeeded >= this.successes ? 'success' : 'running';
    if (result === 'running' && succeeded + failed === this.children.length) {
      // Every child finished and neither count was reached (e.g. success 'all' with failure 'all' and a mix).
      this.stop();
      this.reset();
      return 'failure';
    }
    if (result !== 'running') {
      this.stop();
      this.reset();
    }
    return result;
  }
  protected override stop(): void {
    for (const child of this.children) child.halt();
  }
  protected override reset(): void {
    this.done.fill(null);
  }
}

class Utility extends Node {
  private active = -1;
  private scores: number[] = [];
  constructor(
    spec: NodeSpec,
    path: string,
    depth: number,
    readonly children: Node[],
    readonly scorers: ScoreHandler<unknown>[],
    readonly inertia: number,
    readonly threshold: number,
  ) {
    super(spec, path, depth);
  }
  protected step(rt: Runtime): Status {
    let best = -1,
      bestScore = Number.NEGATIVE_INFINITY;
    this.scores = this.scorers.map((score, index) => {
      const value = score(rt.tick);
      if (typeof value !== 'number' || !Number.isFinite(value))
        throw new RangeError(
          `Utility score '${(this.spec as { options: { score: string }[] }).options[index].score}' returned ${String(value)}; return a finite number`,
        );
      const biased = index === this.active ? value + this.inertia : value;
      if (value > this.threshold && biased > bestScore) {
        best = index;
        bestScore = biased;
      }
      return value;
    });
    if (this.active !== -1 && this.active !== best) this.children[this.active].halt();
    this.active = best;
    if (best === -1) return 'failure';
    const status = this.children[best].run(rt);
    if (status !== 'running') this.active = -1;
    return status;
  }
  protected override extra(): Partial<TraceEntry> {
    return { scores: this.scores };
  }
  protected override stop(): void {
    for (const child of this.children) child.halt();
  }
  protected override reset(): void {
    this.active = -1;
  }
}

class Decorator extends Node {
  private count = 0;
  private started = 0;
  private readyAt = Number.NEGATIVE_INFINITY;
  constructor(
    spec: NodeSpec,
    path: string,
    depth: number,
    readonly child: Node,
    readonly check: ConditionHandler<unknown> | null,
  ) {
    super(spec, path, depth);
  }
  protected step(rt: Runtime): Status {
    const spec = this.spec,
      time = rt.tick.time;
    switch (spec.type) {
      case 'inverter': {
        const status = this.child.run(rt);
        return status === 'running' ? status : status === 'success' ? 'failure' : 'success';
      }
      case 'guard':
        if (!this.check!(rt.tick)) {
          this.child.halt();
          return 'failure';
        }
        return this.child.run(rt);
      case 'cooldown': {
        if (!this.child.open && time < this.readyAt) return 'failure';
        const status = this.child.run(rt);
        if (status !== 'running') this.readyAt = time + spec.seconds;
        return status;
      }
      case 'timeout': {
        if (!this.child.open) this.started = time;
        else if (time - this.started >= spec.seconds) {
          this.child.halt();
          return 'failure';
        }
        return this.child.run(rt);
      }
      case 'repeater': {
        const status = this.child.run(rt);
        if (status === 'running') return status;
        if (spec.until === status) {
          this.count = 0;
          return 'success';
        }
        if (++this.count >= (spec.count ?? Number.POSITIVE_INFINITY)) {
          this.count = 0;
          return 'success';
        }
        return 'running';
      }
      default:
        throw new MargoError('state', `Unknown decorator ${spec.type}; rebuild the tree from a validated description`);
    }
  }
  protected override stop(): void {
    this.child.halt();
  }
  protected override reset(): void {
    this.count = 0;
  }
}

class Condition extends Node {
  constructor(
    spec: NodeSpec,
    path: string,
    depth: number,
    readonly check: ConditionHandler<unknown>,
  ) {
    super(spec, path, depth);
  }
  protected step(rt: Runtime): Status {
    return this.check(rt.tick) ? 'success' : 'failure';
  }
}

class Wait extends Node {
  private until = 0;
  protected step(rt: Runtime): Status {
    if (!this.open) this.until = rt.tick.time + (this.spec as { seconds: number }).seconds;
    return rt.tick.time >= this.until ? 'success' : 'running';
  }
}

const toStatus = (result: ActionResult, name: string): Status => {
  if (result === undefined || result === true || result === 'success') return 'success';
  if (result === false || result === 'failure') return 'failure';
  if (result === 'running') return 'running';
  throw new TypeError(
    `Action '${name}' returned ${JSON.stringify(result)}; return 'success', 'failure', 'running', a boolean or nothing`,
  );
};

class Action extends Node {
  private controller: AbortController | null = null;
  private pending: { settled: boolean; status?: Status; error?: unknown } | null = null;
  constructor(
    spec: NodeSpec,
    path: string,
    depth: number,
    readonly handler: ActionHandler<unknown>,
  ) {
    super(spec, path, depth);
  }
  protected step(rt: Runtime): Status {
    const name = (this.spec as { name: string }).name;
    if (this.pending) {
      const pending = this.pending;
      if (!pending.settled) return 'running';
      this.pending = null;
      this.controller = null;
      if ('error' in pending)
        throw Object.assign(
          new MargoError('failed', `Action '${name}' rejected; handle the error inside the task and return 'failure'`),
          {
            cause: pending.error,
          },
        );
      return pending.status!;
    }
    this.controller ??= new AbortController();
    const result = this.handler({ ...rt.tick, signal: this.controller.signal });
    if (result != null && typeof (result as PromiseLike<ActionResult>).then === 'function') {
      const pending: { settled: boolean; status?: Status; error?: unknown } = { settled: false };
      this.pending = pending;
      (result as PromiseLike<ActionResult>).then(
        (value) => {
          if (this.pending !== pending) return;
          try {
            pending.status = toStatus(value, name);
          } catch (error) {
            pending.error = error;
          }
          pending.settled = true;
        },
        (error) => {
          if (this.pending !== pending) return;
          pending.error = error;
          pending.settled = true;
        },
      );
      return 'running';
    }
    const status = toStatus(result as ActionResult, name);
    if (status !== 'running') this.controller = null;
    return status;
  }
  protected override stop(): void {
    this.controller?.abort(new MargoError('state', `Action '${(this.spec as { name: string }).name}' was halted`));
  }
  protected override reset(): void {
    this.controller = null;
    this.pending = null;
  }
}

function compile(spec: NodeSpec, handlers: BehaviorHandlers<unknown>, path: string, depth: number): Node {
  const missing = (kind: string, name: string): never => {
    throw new TypeError(`${path}: unknown ${kind} '${name}'; add it to handlers.${kind}s`);
  };
  switch (spec.type) {
    case 'sequence':
    case 'selector':
    case 'randomSelector': {
      const children = spec.children.map((child, i) => compile(child, handlers, `${path}.children[${i}]`, depth + 1));
      const weights = spec.type === 'randomSelector' ? (spec.weights ?? children.map(() => 1)) : null;
      return new Composite(
        spec,
        path,
        depth,
        children,
        spec.type === 'sequence' ? 'failure' : 'success',
        spec.type !== 'randomSelector' && spec.reactive === true,
        weights,
      );
    }
    case 'parallel': {
      const children = spec.children.map((child, i) => compile(child, handlers, `${path}.children[${i}]`, depth + 1));
      return new Parallel(
        spec,
        path,
        depth,
        children,
        needed(spec.success ?? 'all', children.length),
        needed(spec.failure ?? 'any', children.length),
      );
    }
    case 'utility': {
      const children = spec.options.map((option, i) =>
        compile(option.child, handlers, `${path}.options[${i}].child`, depth + 1),
      );
      const scorers = spec.options.map((option) => handlers.scores?.[option.score] ?? missing('score', option.score));
      return new Utility(
        spec,
        path,
        depth,
        children,
        scorers as ScoreHandler<unknown>[],
        spec.inertia ?? 0,
        spec.threshold ?? 0,
      );
    }
    case 'inverter':
    case 'repeater':
    case 'cooldown':
    case 'guard':
    case 'timeout': {
      const check =
        spec.type === 'guard' ? (handlers.conditions?.[spec.condition] ?? missing('condition', spec.condition)) : null;
      return new Decorator(
        spec,
        path,
        depth,
        compile(spec.child, handlers, `${path}.child`, depth + 1),
        check as ConditionHandler<unknown> | null,
      );
    }
    case 'condition':
      return new Condition(spec, path, depth, handlers.conditions?.[spec.name] ?? missing('condition', spec.name));
    case 'action':
      return new Action(spec, path, depth, handlers.actions?.[spec.name] ?? missing('action', spec.name));
    case 'wait':
      return new Wait(spec, path, depth);
  }
}

const NEVER = new AbortController().signal;

/**
 * A running behaviour tree for one agent. Build it from a description (a {@link TreeDocument}, a root node or JSON
 * text, validated first) and the handlers its names refer to, then call `tick(delta)` once per frame or fixed step.
 * After the root finishes, the next tick starts it again. `using` works (dispose halts running tasks).
 */
export class BehaviorTree<C = undefined> {
  /** The validated description the tree was built from. */
  readonly document: TreeDocument;
  /** The tree's shared memory. */
  readonly blackboard: Blackboard;
  /** The context passed to every handler. */
  readonly context: C;
  /** What the root returned on the last tick (`'running'` before the first). */
  status: Status = 'running';
  /** Tree time: the sum of every tick delta, seconds. */
  time = 0;
  /** Ticks so far. */
  ticks = 0;
  /** The nodes visited on the last tick, depth first, when built with `trace: true`; else empty. */
  trace: readonly TraceEntry[] = [];
  private readonly root: Node;
  private readonly random: () => number;
  private readonly tracing: boolean;
  private ticking = false;
  private disposed = false;
  /**
   * @throws TypeError for an invalid description (naming the first problem's path and fix) or a missing handler.
   */
  constructor(description: TreeDocument | NodeSpec | string, options: BehaviorTreeOptions<C>) {
    if (options == null || typeof options !== 'object' || options.handlers == null)
      throw new TypeError('BehaviorTree needs options.handlers; pass {handlers: {actions, conditions, scores}}');
    const handlers = options.handlers as BehaviorHandlers<unknown>;
    this.document = parseTree(description, {
      actions: handlers.actions ?? {},
      conditions: handlers.conditions ?? {},
      scores: handlers.scores ?? {},
    });
    this.root = compile(this.document.root, handlers, 'root', 0);
    this.blackboard = options.blackboard ?? new Blackboard();
    this.context = options.context as C;
    const seed = options.seed ?? 0;
    if (!Number.isInteger(seed)) throw new RangeError('BehaviorTree seed must be a whole number');
    this.random = createRandom(seed);
    this.tracing = options.trace === true;
  }
  /**
   * Advance the tree by `delta` seconds and return the root's status.
   * @throws RangeError for a negative or non-finite delta; MargoError `'disposed'` after dispose, `'state'` when called
   * from inside a handler, `'failed'` when an async action rejected (the error is its `cause`).
   */
  tick(delta = 1 / 60): Status {
    if (this.disposed) throw new MargoError('disposed', 'BehaviorTree is disposed; build a new BehaviorTree');
    if (!(delta >= 0) || !Number.isFinite(delta))
      throw new RangeError('Tick delta must be a finite number of seconds, 0 or more');
    if (this.ticking)
      throw new MargoError(
        'state',
        'BehaviorTree.tick called from inside a handler; tick once per frame from your game loop',
      );
    this.ticking = true;
    this.time += delta;
    this.ticks++;
    const trace = this.tracing ? [] : null;
    try {
      this.status = this.root.run({
        tick: {
          blackboard: this.blackboard,
          context: this.context,
          delta,
          time: this.time,
          random: this.random,
          signal: NEVER,
        },
        trace,
      });
    } finally {
      this.ticking = false;
      if (trace) this.trace = trace;
    }
    return this.status;
  }
  /** Stop everything that is running (async actions see their signal abort) and start from the root next tick. */
  halt(): void {
    this.root.halt();
    this.status = 'running';
  }
  /** Halt the tree; further ticks throw. */
  dispose(): void {
    if (this.disposed) return;
    this.halt();
    this.disposed = true;
  }
  /** Same as {@link BehaviorTree.dispose}, for `using`. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}
