// Goal-oriented action planning after J. Orkin, "Symbolic Representation of Game World State: Toward Real-Time Planning
// in Games", AAAI Workshop on Challenges in Game AI, 2004, on the operators of R. Fikes and N. Nilsson, "STRIPS: A New
// Approach to the Application of Theorem Proving to Problem Solving", SRI Technical Note 43, 1970. Goals
// and actions never name each other: the planner works backward from a goal's symbols with an A* search, trying the
// actions whose effects supply a symbol still needed, and an agent plans again only when its plan breaks or its most
// relevant goal changes.
import type { Status } from './spec.js';

/** One symbol's value. */
export type WorldValue = boolean | number | string;
/** Symbols of the world as an agent sees them. A symbol that is not set does not match any value, `false` included. */
export type WorldState = Readonly<Record<string, WorldValue>>;

/** Something an agent can do. */
export interface GoapAction {
  /** Unique name, shown in plans. */
  readonly name: string;
  /** Above 0; the planner finds the cheapest sequence (default 1). */
  readonly cost?: number;
  /** Symbols that must hold before it runs (default none). */
  readonly preconditions?: WorldState;
  /** Symbols it sets. At least one. */
  readonly effects: WorldState;
  /**
   * A test no action could make true, such as a ray or a clearance check, run once per plan with the current state
   * (default always true). Keep it cheap: move anything slow to a sensor that writes a symbol.
   */
  readonly available?: (state: WorldState) => boolean;
  /**
   * Do the work, called each `update` while the action is current (default finishes at once). Return `'failure'` when
   * it cannot be done, and write a symbol saying why, or the next plan will try the same thing.
   */
  readonly run?: (state: Record<string, WorldValue>, delta: number) => Status;
  /** Called when a running action is dropped, because the plan changed or the agent was halted. */
  readonly stop?: (state: WorldState) => void;
}

/** Something an agent wants. */
export interface GoapGoal {
  /** Unique name. */
  readonly name: string;
  /** The symbols that satisfy it. */
  readonly desired: WorldState;
  /** How much it matters now; at 0 or below it is left alone (default 1). */
  readonly relevance?: number | ((state: WorldState) => number);
}

/** A plan: the actions in the order to run them. */
export interface GoapPlan {
  /** The actions, first to run first. Empty when the goal already holds. */
  readonly actions: readonly GoapAction[];
  /** Sum of their costs, the lowest of any plan. */
  readonly cost: number;
  /** Search nodes expanded, for tuning. */
  readonly expanded: number;
}

/** Options of {@link planActions}. */
export interface PlanOptions {
  /** Stop and return `null` after this many search nodes (default 10,000). */
  maxNodes?: number;
}

const has = (state: WorldState, symbol: string): boolean => Object.hasOwn(state, symbol);
const holds = (state: WorldState, wanted: WorldState): boolean => {
  for (const symbol of Object.keys(wanted)) if (!has(state, symbol) || state[symbol] !== wanted[symbol]) return false;
  return true;
};
const checkState = (state: WorldState, label: string): void => {
  if (state == null || typeof state !== 'object') throw new TypeError(`${label} must be an object of symbol: value`);
  for (const symbol of Object.keys(state)) {
    if (symbol === '__proto__') throw new RangeError(`${label} must not use the symbol name '__proto__'; rename it`);
    const type = typeof state[symbol];
    if (type !== 'boolean' && type !== 'string' && !(type === 'number' && Number.isFinite(state[symbol])))
      throw new RangeError(`${label} symbol '${symbol}' must be a boolean, a string or a finite number`);
  }
};
const checkActions = (actions: readonly GoapAction[]): void => {
  if (!Array.isArray(actions)) throw new TypeError('GOAP actions must be an array');
  const names = new Set<string>();
  for (const action of actions) {
    if (action == null || typeof action.name !== 'string' || !action.name)
      throw new TypeError('A GOAP action must have a non-empty name');
    if (names.has(action.name)) throw new RangeError(`GOAP action names must be unique; rename '${action.name}'`);
    names.add(action.name);
    const cost = action.cost ?? 1;
    if (!(cost > 0) || !Number.isFinite(cost)) throw new RangeError(`Action '${action.name}' cost must be above 0`);
    checkState(action.effects, `Action '${action.name}' effects`);
    if (Object.keys(action.effects).length === 0)
      throw new RangeError(`Action '${action.name}' must have at least one effect`);
    checkState(action.preconditions ?? {}, `Action '${action.name}' preconditions`);
  }
};

interface SearchNode {
  /** What must hold before the steps below can run. */
  required: Record<string, WorldValue>;
  /** Steps found so far, the action that runs first at the head of the chain. */
  action: GoapAction | null;
  next: SearchNode | null;
  cost: number;
  estimate: number;
  order: number;
}

const ahead = (a: SearchNode, b: SearchNode): boolean => {
  const fa = a.cost + a.estimate;
  const fb = b.cost + b.estimate;
  return fa < fb || (fa === fb && a.order < b.order);
};
const heapPush = (heap: SearchNode[], node: SearchNode): void => {
  let at = heap.length;
  heap.push(node);
  while (at > 0) {
    const parent = (at - 1) >> 1;
    if (!ahead(node, heap[parent] as SearchNode)) break;
    heap[at] = heap[parent] as SearchNode;
    at = parent;
  }
  heap[at] = node;
};
const heapPop = (heap: SearchNode[]): SearchNode => {
  const top = heap[0] as SearchNode;
  const last = heap.pop() as SearchNode;
  if (heap.length > 0) {
    let at = 0;
    for (;;) {
      let child = at * 2 + 1;
      if (child >= heap.length) break;
      if (child + 1 < heap.length && ahead(heap[child + 1] as SearchNode, heap[child] as SearchNode)) child++;
      if (!ahead(heap[child] as SearchNode, last)) break;
      heap[at] = heap[child] as SearchNode;
      at = child;
    }
    heap[at] = last;
  }
  return top;
};
const keyOf = (required: Record<string, WorldValue>): string =>
  JSON.stringify(
    Object.keys(required)
      .sort()
      .map((symbol) => [symbol, required[symbol]]),
  );

/**
 * Find the cheapest sequence of actions from `state` to `desired`, or `null` when there is none within `maxNodes`.
 * The search runs backward from `desired`. Each step tries the actions with an effect that supplies a needed symbol
 * and none that contradicts one; the needed symbols then become what is left plus the action's preconditions. A symbol
 * that holds now stays needed, because an earlier step may undo it. The estimate counts symbols not yet true, divided
 * by the most any action sets, times the cheapest cost, so it never overestimates and the plan found is the cheapest.
 * @throws TypeError or RangeError for a malformed state, goal or action.
 */
export function planActions(
  state: WorldState,
  desired: WorldState,
  actions: readonly GoapAction[],
  options: PlanOptions = {},
): GoapPlan | null {
  checkState(state, 'World state');
  checkState(desired, 'Goal');
  checkActions(actions);
  const maxNodes = options.maxNodes ?? 10_000;
  if (!Number.isInteger(maxNodes) || maxNodes < 1) throw new RangeError('maxNodes must be a whole number of 1 or more');
  // Actions by the symbols they set, so a step looks only at actions that can help.
  const bySymbol = new Map<string, GoapAction[]>();
  let cheapest = Number.POSITIVE_INFINITY;
  let widest = 1;
  for (const action of actions) {
    if (action.available && !action.available(state)) continue;
    cheapest = Math.min(cheapest, action.cost ?? 1);
    const symbols = Object.keys(action.effects);
    widest = Math.max(widest, symbols.length);
    for (const symbol of symbols) {
      const list = bySymbol.get(symbol);
      if (list) list.push(action);
      else bySymbol.set(symbol, [action]);
    }
  }
  const estimate = (required: Record<string, WorldValue>): number => {
    let open = 0;
    for (const symbol of Object.keys(required)) if (!has(state, symbol) || state[symbol] !== required[symbol]) open++;
    return open === 0 ? 0 : Math.ceil(open / widest) * cheapest;
  };
  let order = 0;
  const start: SearchNode = {
    required: { ...desired },
    action: null,
    next: null,
    cost: 0,
    estimate: 0,
    order: order++,
  };
  start.estimate = estimate(start.required);
  const heap = [start];
  const best = new Map<string, number>([[keyOf(start.required), 0]]);
  let expanded = 0;
  while (heap.length > 0) {
    const node = heapPop(heap);
    if (node.estimate === 0 && holds(state, node.required)) {
      const steps: GoapAction[] = [];
      for (let at: SearchNode | null = node; at?.action; at = at.next) steps.push(at.action);
      return { actions: steps, cost: node.cost, expanded };
    }
    if (node.cost > (best.get(keyOf(node.required)) as number)) continue;
    if (++expanded > maxNodes) return null;
    const tried = new Set<GoapAction>();
    for (const symbol of Object.keys(node.required)) {
      for (const action of bySymbol.get(symbol) ?? []) {
        if (tried.has(action)) continue;
        tried.add(action);
        const required = regress(node.required, action);
        if (!required) continue;
        const key = keyOf(required);
        const cost = node.cost + (action.cost ?? 1);
        const known = best.get(key);
        if (known !== undefined && known <= cost) continue;
        best.set(key, cost);
        heapPush(heap, { required, action, next: node, cost, estimate: estimate(required), order: order++ });
      }
    }
  }
  return null;
}

/** What must hold before `action` so that `required` holds after it, or `null` when the action cannot be that step. */
const regress = (required: Record<string, WorldValue>, action: GoapAction): Record<string, WorldValue> | null => {
  const { effects, preconditions = {} } = action;
  let helps = false;
  const out: Record<string, WorldValue> = {};
  for (const symbol of Object.keys(required)) {
    if (has(effects, symbol)) {
      if (effects[symbol] !== required[symbol]) return null;
      helps = true;
    } else out[symbol] = required[symbol] as WorldValue;
  }
  if (!helps) return null;
  for (const symbol of Object.keys(preconditions)) {
    if (has(out, symbol) && out[symbol] !== preconditions[symbol]) return null;
    out[symbol] = preconditions[symbol] as WorldValue;
  }
  return out;
};

/** Options of {@link GoapAgent}. */
export interface GoapAgentOptions {
  /** Starting symbols; sensors write `agent.state` afterwards (default none). */
  state?: Record<string, WorldValue>;
  /** Passed to each planning call. */
  plan?: PlanOptions;
}

const relevanceOf = (goal: GoapGoal, state: WorldState): number => {
  const { relevance = 1 } = goal;
  return typeof relevance === 'function' ? relevance(state) : relevance;
};

/**
 * An agent that picks its most relevant goal, plans for it and runs the plan. It plans again only when it must: the
 * most relevant goal changed, an action failed, or the next action's preconditions no longer hold. Write sensor
 * results to {@link GoapAgent.state} between updates.
 */
export class GoapAgent {
  /** The agent's symbols. An action that succeeds writes its effects here. */
  readonly state: Record<string, WorldValue>;
  /** The goal being pursued, or `null`. */
  goal: GoapGoal | null = null;
  /** Actions still to run, the current one first. */
  plan: GoapAction[] = [];
  /** How many times the agent has planned. */
  plans = 0;
  private running = false;
  /** Goals with no plan, and the state they failed in: there is no use planning again until it changes. */
  private readonly stuck = new Map<GoapGoal, string>();
  private readonly goals: readonly GoapGoal[];
  private readonly actions: readonly GoapAction[];
  private readonly options: PlanOptions;

  /** @throws TypeError or RangeError for a malformed goal, action or state. */
  constructor(goals: readonly GoapGoal[], actions: readonly GoapAction[], options: GoapAgentOptions = {}) {
    if (!Array.isArray(goals)) throw new TypeError('GOAP goals must be an array');
    for (const goal of goals) {
      if (goal == null || typeof goal.name !== 'string' || !goal.name)
        throw new TypeError('A GOAP goal must have a non-empty name');
      checkState(goal.desired, `Goal '${goal.name}'`);
    }
    checkActions(actions);
    this.goals = goals;
    this.actions = actions;
    this.state = { ...options.state };
    checkState(this.state, 'World state');
    this.options = options.plan ?? {};
  }

  /** The action running now, or `null`. */
  get current(): GoapAction | null {
    return this.plan[0] ?? null;
  }

  /** Drop the plan and stop the running action; the next `update` chooses again. */
  halt(): void {
    if (this.running) this.current?.stop?.(this.state);
    this.running = false;
    this.plan = [];
    this.goal = null;
  }

  private choose(): void {
    const ranked = this.goals
      .map((goal, index) => ({ goal, index, relevance: relevanceOf(goal, this.state) }))
      .filter(({ relevance }) => relevance > 0)
      .sort((a, b) => b.relevance - a.relevance || a.index - b.index);
    for (const { goal } of ranked) {
      if (holds(this.state, goal.desired)) continue;
      if (goal === this.goal && this.plan.length > 0) return;
      const snapshot = JSON.stringify(this.state);
      if (this.stuck.get(goal) === snapshot) continue;
      const found = planActions(this.state, goal.desired, this.actions, this.options);
      this.plans++;
      if (!found) {
        this.stuck.set(goal, snapshot);
        continue;
      }
      this.stuck.delete(goal);
      this.halt();
      this.goal = goal;
      this.plan = [...found.actions];
      return;
    }
    this.halt();
  }

  /**
   * Choose, plan if needed and run the current action for `delta` seconds. Actions with no `run` finish at once, and
   * the next one starts on the next update.
   * @returns The goal being pursued, or `null` when no goal needs anything.
   */
  update(delta = 1 / 60): GoapGoal | null {
    this.choose();
    const action = this.current;
    if (!action) return null;
    if (!this.running && !holds(this.state, action.preconditions ?? {})) {
      this.halt();
      this.choose();
      return this.goal;
    }
    this.running = true;
    const status = action.run ? action.run(this.state, delta) : 'success';
    if (status === 'running') return this.goal;
    this.running = false;
    if (status === 'failure') {
      this.plan = [];
      this.goal = null;
      return null;
    }
    Object.assign(this.state, action.effects);
    this.plan.shift();
    return this.goal;
  }
}
