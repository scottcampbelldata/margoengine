// Hierarchical task network planning after T. Humphreys, "Exploring HTN Planners through Example", Game AI Pro, chapter
// 12, 2013: a total-order forward decomposition planner. Compound tasks hold methods in priority order, primitive tasks
// hold conditions and effects, and the planner walks a working copy of the world state forward, going back to the last
// decomposition when something fails. The runner checks the remaining plan against the world, keeps the plan through
// its own effects, and gives way only to a plan of higher priority by the method traversal record.
import type { WorldState, WorldValue } from './goap.js';
import type { Status } from './spec.js';

/** The world as a planner sees it. */
export type HtnState = Record<string, WorldValue>;
/** A test of the state: symbols that must match, or a function. A symbol that is not set matches nothing. */
export type HtnCondition = WorldState | ((state: Readonly<HtnState>) => boolean);
/** A change to the state: symbols to set, or a function that writes them, for `Health -= 1`. */
export type HtnEffect = WorldState | ((state: HtnState) => void);

/** A single step an agent can do. */
export interface PrimitiveTask {
  /** Unique name, which subtasks refer to. */
  readonly name: string;
  /** What must hold, in the plan as well as at run time (default always). */
  readonly preconditions?: HtnCondition;
  /** What success changes, in the plan and in the world (default nothing). */
  readonly effects?: HtnEffect;
  /**
   * What the world should do by itself while this runs, such as seeing the enemy on arrival. It counts in planning and
   * in checking a plan, and is never written to the world: a sensor has to make it true (default nothing).
   */
  readonly expected?: HtnEffect;
  /** Do the work, called each `update` while current (default finishes at once). */
  readonly run?: (state: HtnState, delta: number) => Status;
  /** Called when a running task is dropped, because the plan changed or the agent was halted. */
  readonly stop?: (state: Readonly<HtnState>) => void;
}

/** One way of doing a compound task. */
export interface HtnMethod {
  /** When this way can be used (default always). */
  readonly when?: HtnCondition;
  /** Names of the tasks to do, in order. A compound task may name itself, as long as effects end the recursion. */
  readonly subtasks: readonly string[];
}

/** A high level task with several ways of doing it, the first valid method winning. */
export interface CompoundTask {
  /** Unique name, which subtasks refer to. */
  readonly name: string;
  /** The ways of doing it, highest priority first. */
  readonly methods: readonly HtnMethod[];
}

/** A task of a domain. */
export type HtnTask = PrimitiveTask | CompoundTask;

/** A plan: primitive tasks in order. */
export interface HtnPlan {
  /** The tasks, first to run first. */
  readonly tasks: readonly PrimitiveTask[];
  /** Method traversal record: the method index chosen at each decomposition. See {@link compareRecords}. */
  readonly record: readonly number[];
  /** Tasks the planner looked at, for tuning. */
  readonly steps: number;
}

/** Options of {@link planTasks}. */
export interface HtnPlanOptions {
  /** Stop and return `null` after this many tasks, which also ends a recursion that never finishes (default 10,000). */
  maxSteps?: number;
}

const isCompound = (task: HtnTask): task is CompoundTask => 'methods' in task;

const checkCondition = (condition: unknown, label: string): void => {
  if (condition === undefined || typeof condition === 'function') return;
  if (condition === null || typeof condition !== 'object')
    throw new TypeError(`${label} must be symbols to match or a function`);
  for (const symbol of Object.keys(condition)) {
    if (symbol === '__proto__') throw new RangeError(`${label} must not use the symbol name '__proto__'; rename it`);
    const value = (condition as WorldState)[symbol];
    const type = typeof value;
    if (type !== 'boolean' && type !== 'string' && !(type === 'number' && Number.isFinite(value)))
      throw new RangeError(`${label} symbol '${symbol}' must be a boolean, a string or a finite number`);
  }
};

/** Name to task, checked once: unique names, and every subtask known. */
const indexDomain = (tasks: readonly HtnTask[]): Map<string, HtnTask> => {
  if (!Array.isArray(tasks)) throw new TypeError('An HTN domain must be an array of tasks');
  const domain = new Map<string, HtnTask>();
  for (const task of tasks) {
    if (task == null || typeof task.name !== 'string' || !task.name)
      throw new TypeError('An HTN task must have a non-empty name');
    if (domain.has(task.name)) throw new RangeError(`HTN task names must be unique; rename '${task.name}'`);
    domain.set(task.name, task);
    if (isCompound(task)) {
      if (!Array.isArray(task.methods) || task.methods.length === 0)
        throw new RangeError(`Compound task '${task.name}' must have at least one method`);
    } else {
      checkCondition(task.preconditions, `Task '${task.name}' preconditions`);
      checkCondition(task.effects, `Task '${task.name}' effects`);
      checkCondition(task.expected, `Task '${task.name}' expected`);
    }
  }
  for (const task of tasks) {
    if (!isCompound(task)) continue;
    for (const method of task.methods) {
      checkCondition(method?.when, `Task '${task.name}' method condition`);
      if (!Array.isArray(method?.subtasks)) throw new TypeError(`Task '${task.name}' methods must list their subtasks`);
      for (const name of method.subtasks)
        if (!domain.has(name)) throw new RangeError(`Task '${task.name}' names '${name}'; add a task of that name`);
    }
  }
  return domain;
};

const holds = (condition: HtnCondition | undefined, state: Readonly<HtnState>): boolean => {
  if (condition === undefined) return true;
  if (typeof condition === 'function') return condition(state);
  for (const symbol of Object.keys(condition))
    if (!Object.hasOwn(state, symbol) || state[symbol] !== condition[symbol]) return false;
  return true;
};
const apply = (effect: HtnEffect | undefined, state: HtnState): void => {
  if (typeof effect === 'function') effect(state);
  else if (effect !== undefined) Object.assign(state, effect);
};

/** A shared tail list: going back to an older point costs nothing. */
interface Chain<T> {
  readonly value: T;
  readonly next: Chain<T> | null;
}
const toArray = <T>(chain: Chain<T> | null): T[] => {
  const out: T[] = [];
  for (let at = chain; at; at = at.next) out.push(at.value);
  return out.reverse();
};

/** A point to come back to: a compound task with methods left to try. */
interface Decomposition {
  readonly task: CompoundTask;
  readonly nextMethod: number;
  readonly state: Readonly<HtnState>;
  readonly pending: Chain<string> | null;
  readonly plan: Chain<PrimitiveTask> | null;
  readonly record: Chain<number> | null;
}

const search = (
  domain: ReadonlyMap<string, HtnTask>,
  root: string,
  start: Readonly<HtnState>,
  maxSteps: number,
): HtnPlan | null => {
  let state: HtnState = { ...start };
  let pending: Chain<string> | null = { value: root, next: null };
  let plan: Chain<PrimitiveTask> | null = null;
  let record: Chain<number> | null = null;
  const history: Decomposition[] = [];
  let steps = 0;

  /** The first valid method from `from` on: take it, or report that none is left. */
  const decompose = (task: CompoundTask, from: number): boolean => {
    for (let i = from; i < task.methods.length; i++) {
      const method = task.methods[i] as HtnMethod;
      if (!holds(method.when, state)) continue;
      if (i + 1 < task.methods.length)
        history.push({ task, nextMethod: i + 1, state: { ...state }, pending, plan, record });
      record = { value: i, next: record };
      for (let s = method.subtasks.length - 1; s >= 0; s--)
        pending = { value: method.subtasks[s] as string, next: pending };
      return true;
    }
    return false;
  };
  /** Go back to the last decomposition with a method left. */
  const backtrack = (): boolean => {
    while (history.length > 0) {
      const point = history.pop() as Decomposition;
      state = { ...point.state };
      pending = point.pending;
      plan = point.plan;
      record = point.record;
      if (decompose(point.task, point.nextMethod)) return true;
    }
    return false;
  };

  while (pending) {
    if (++steps > maxSteps) return null;
    const task = domain.get(pending.value) as HtnTask;
    pending = pending.next;
    let ok: boolean;
    if (isCompound(task)) ok = decompose(task, 0);
    else {
      ok = holds(task.preconditions, state);
      if (ok) {
        apply(task.effects, state);
        apply(task.expected, state);
        plan = { value: task, next: plan };
      }
    }
    if (!ok && !backtrack()) return null;
  }
  return { tasks: toArray(plan), record: toArray(record), steps };
};

const checkMaxSteps = (options: HtnPlanOptions): number => {
  const maxSteps = options.maxSteps ?? 10_000;
  if (!Number.isInteger(maxSteps) || maxSteps < 1) throw new RangeError('maxSteps must be a whole number of 1 or more');
  return maxSteps;
};

/**
 * Plan forward from `state`: take `root`, replace each compound task by the subtasks of its first valid method, and
 * keep each primitive task whose preconditions hold, applying its effects to a working copy. When a task fails, go back
 * to the last decomposition and try its next method. The first plan found is the one method order prefers; there are
 * no costs.
 * @returns The plan, or `null` when no decomposition works within `maxSteps`.
 * @throws TypeError or RangeError for a malformed domain, or a `root` the domain does not hold.
 */
export function planTasks(
  tasks: readonly HtnTask[],
  root: string,
  state: Readonly<HtnState>,
  options: HtnPlanOptions = {},
): HtnPlan | null {
  const domain = indexDomain(tasks);
  if (!domain.has(root)) throw new RangeError(`HTN root '${root}' must be a task of the domain`);
  if (state == null || typeof state !== 'object') throw new TypeError('World state must be an object of symbol: value');
  return search(domain, root, state, checkMaxSteps(options));
}

/**
 * Which of two method traversal records has priority: below 0 when `a` does, above 0 when `b` does, 0 when they match.
 * The first method index that differs decides, a lower index being a method listed earlier.
 */
export function compareRecords(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  return 0;
}

/** Options of {@link HtnAgent}. */
export interface HtnAgentOptions extends HtnPlanOptions {
  /** Starting symbols; sensors write `agent.state` afterwards (default none). */
  state?: HtnState;
}

/**
 * Runs a domain: plans from its root task, runs each primitive task, and writes its effects when it succeeds. It plans
 * again when it has no plan, when a task fails, and when a sensor has changed {@link HtnAgent.state}; a task's own
 * effects never cause it, since the plan already counted them. A new plan replaces the running one only when the
 * running one no longer checks out or the new one has priority by {@link compareRecords}.
 */
export class HtnAgent {
  /** The agent's symbols. Write sensor results here between updates. */
  readonly state: HtnState;
  /** Primitive tasks still to run, the current one first. */
  plan: PrimitiveTask[] = [];
  /** The method traversal record of the plan. */
  record: readonly number[] = [];
  /** How many times the agent has planned. */
  plans = 0;
  private running = false;
  /** The state as this agent last left it, to tell a sensor's change from its own. */
  private seen = '';
  /** The state in which the root gave nothing to do: no use planning again until it changes. */
  private idleIn: string | null = null;
  private readonly domain: ReadonlyMap<string, HtnTask>;
  private readonly root: string;
  private readonly maxSteps: number;

  /** @throws TypeError or RangeError for a malformed domain, or a `root` the domain does not hold. */
  constructor(tasks: readonly HtnTask[], root: string, options: HtnAgentOptions = {}) {
    this.domain = indexDomain(tasks);
    if (!this.domain.has(root)) throw new RangeError(`HTN root '${root}' must be a task of the domain`);
    this.root = root;
    this.maxSteps = checkMaxSteps(options);
    this.state = { ...options.state };
  }

  /** The task running now, or `null`. */
  get current(): PrimitiveTask | null {
    return this.plan[0] ?? null;
  }

  /** Drop the plan and stop the running task; the next `update` plans again. */
  halt(): void {
    if (this.running) this.current?.stop?.(this.state);
    this.running = false;
    this.plan = [];
    this.record = [];
    this.idleIn = null;
  }

  /** Whether the tasks left still work, each counting the effects of those before it. */
  private valid(): boolean {
    const working = { ...this.state };
    for (let i = 0; i < this.plan.length; i++) {
      const task = this.plan[i] as PrimitiveTask;
      // A running task passed its check when it began, and may well have changed what that check reads.
      if (!(i === 0 && this.running) && !holds(task.preconditions, working)) return false;
      apply(task.effects, working);
      apply(task.expected, working);
    }
    return true;
  }

  private replan(snapshot: string): void {
    if (this.plan.length > 0 && !this.valid()) this.halt();
    if (this.plan.length === 0 && this.idleIn === snapshot) return;
    const found = search(this.domain, this.root, this.state, this.maxSteps);
    this.plans++;
    if (this.plan.length > 0 && (!found || compareRecords(found.record, this.record) >= 0)) return;
    this.halt();
    if (found && found.tasks.length > 0) {
      this.plan = [...found.tasks];
      this.record = found.record;
    } else this.idleIn = snapshot;
  }

  /**
   * Plan if needed and run the current task for `delta` seconds. A task with no `run` finishes at once, and the next
   * one starts on the next update.
   * @returns The task that ran, or `null` when there is nothing to do.
   */
  update(delta = 1 / 60): PrimitiveTask | null {
    const snapshot = JSON.stringify(this.state);
    if (this.plan.length === 0 || snapshot !== this.seen) this.replan(snapshot);
    this.seen = snapshot;
    const task = this.current;
    if (!task) return null;
    this.running = true;
    const status = task.run ? task.run(this.state, delta) : 'success';
    if (status === 'running') {
      this.seen = JSON.stringify(this.state);
      return task;
    }
    this.running = false;
    if (status === 'failure') {
      this.plan = [];
      this.record = [];
    } else {
      apply(task.effects, this.state);
      this.plan.shift();
      if (this.plan.length === 0) this.record = [];
    }
    this.seen = JSON.stringify(this.state);
    return task;
  }
}
