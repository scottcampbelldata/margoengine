// The serialisable description of a behaviour tree: plain JSON objects, the builders that make them and the validator.
// Leaves name their handlers instead of holding functions, so every tree can be saved, diffed and loaded.

/** Result of ticking a node. */
export type Status = 'success' | 'failure' | 'running';

/** How many children must succeed (or fail) for a {@link ParallelNode} to finish: all, any one, or a count. */
export type ParallelPolicy = 'all' | 'any' | number;

/** Runs children in order until one fails (`failure`) or all succeed (`success`). */
export interface SequenceNode {
  type: 'sequence';
  children: NodeSpec[];
  /** Re-check earlier children every tick, halting a running later child when one fails (default false: resume at the running child). */
  reactive?: boolean;
  /** Label shown in traces. */
  label?: string;
}
/** Runs children in order until one succeeds (`success`) or all fail (`failure`). */
export interface SelectorNode {
  type: 'selector';
  children: NodeSpec[];
  /** Re-check higher-priority children every tick, halting a running lower one when one succeeds (default false). */
  reactive?: boolean;
  /** Label shown in traces. */
  label?: string;
}
/** A selector whose order is shuffled by the tree's seeded random stream each time it starts, by optional weights. */
export interface RandomSelectorNode {
  type: 'randomSelector';
  children: NodeSpec[];
  /** One non-negative weight per child (default all 1); a larger weight is more likely to be tried first. */
  weights?: number[];
  /** Label shown in traces. */
  label?: string;
}
/** Ticks every child each tick; finishes by its success and failure policies, halting the children still running. */
export interface ParallelNode {
  type: 'parallel';
  children: NodeSpec[];
  /** Successes needed to succeed (default `'all'`). */
  success?: ParallelPolicy;
  /** Failures needed to fail (default `'any'`). Checked before `success`. */
  failure?: ParallelPolicy;
  /** Label shown in traces. */
  label?: string;
}
/** One option of a {@link UtilityNode}: a named score handler and the subtree it runs. */
export interface UtilityOption {
  /** Name of a score handler in {@link BehaviorHandlers.scores}. */
  score: string;
  child: NodeSpec;
}
/** Utility-AI selector: every tick it scores the options and runs the best one (ties go to the first). */
export interface UtilityNode {
  type: 'utility';
  options: UtilityOption[];
  /** Bonus added to the running option's score so close scores do not flip every tick (default 0). */
  inertia?: number;
  /** Options must score above this (before the inertia bonus) to run; when none does the node fails (default 0). */
  threshold?: number;
  /** Label shown in traces. */
  label?: string;
}
/** Flips `success` and `failure`; `running` passes through. */
export interface InverterNode {
  type: 'inverter';
  child: NodeSpec;
  /** Label shown in traces. */
  label?: string;
}
/** Runs its child again after it finishes, once per tick, `count` times or until it returns `until`. */
export interface RepeaterNode {
  type: 'repeater';
  child: NodeSpec;
  /** Runs before succeeding (default unlimited). */
  count?: number;
  /** Stop and succeed early when the child returns this (default: never). */
  until?: 'success' | 'failure';
  /** Label shown in traces. */
  label?: string;
}
/** After its child finishes, fails without ticking it until `seconds` of tree time have passed. */
export interface CooldownNode {
  type: 'cooldown';
  seconds: number;
  child: NodeSpec;
  /** Label shown in traces. */
  label?: string;
}
/** Condition guard: checks a named condition every tick and runs the child only while it holds (halting it otherwise). */
export interface GuardNode {
  type: 'guard';
  /** Name of a condition handler in {@link BehaviorHandlers.conditions}. */
  condition: string;
  child: NodeSpec;
  /** Label shown in traces. */
  label?: string;
}
/** Fails (halting the child, which aborts its tasks) when the child runs longer than `seconds` of tree time. */
export interface TimeoutNode {
  type: 'timeout';
  seconds: number;
  child: NodeSpec;
  /** Label shown in traces. */
  label?: string;
}
/** Leaf: a named condition, `success` when it returns true. */
export interface ConditionNode {
  type: 'condition';
  /** Name of a condition handler in {@link BehaviorHandlers.conditions}. */
  name: string;
  /** Label shown in traces. */
  label?: string;
}
/** Leaf: a named action, synchronous or async (a promise makes it a task that runs across ticks). */
export interface ActionNode {
  type: 'action';
  /** Name of an action handler in {@link BehaviorHandlers.actions}. */
  name: string;
  /** Label shown in traces. */
  label?: string;
}
/** Leaf: `running` for `seconds` of tree time, then `success`. */
export interface WaitNode {
  type: 'wait';
  seconds: number;
  /** Label shown in traces. */
  label?: string;
}

/** Any node of a behaviour-tree description. Every node is plain JSON. */
export type NodeSpec =
  | SequenceNode
  | SelectorNode
  | RandomSelectorNode
  | ParallelNode
  | UtilityNode
  | InverterNode
  | RepeaterNode
  | CooldownNode
  | GuardNode
  | TimeoutNode
  | ConditionNode
  | ActionNode
  | WaitNode;

/** A saved behaviour tree: `JSON.stringify` it to store it, {@link parseTree} to read it back. */
export interface TreeDocument {
  format: 'margo-behavior';
  version: 1;
  root: NodeSpec;
}

/** Handler names a description may use; pass them to {@link validateTree} to check that each one exists. */
export interface HandlerNames {
  actions?: Iterable<string> | Readonly<Record<string, unknown>>;
  conditions?: Iterable<string> | Readonly<Record<string, unknown>>;
  scores?: Iterable<string> | Readonly<Record<string, unknown>>;
}

/** One problem found by {@link validateTree}: where (`root.children[2].seconds`) and what to change. */
export interface TreeIssue {
  path: string;
  message: string;
}

/** Wrap a root node in a {@link TreeDocument}. */
export const treeDocument = (root: NodeSpec): TreeDocument => ({ format: 'margo-behavior', version: 1, root });
/** {@link SequenceNode} builder. */
export const sequence = (...children: NodeSpec[]): SequenceNode => ({ type: 'sequence', children });
/** Reactive {@link SequenceNode} builder: earlier children are re-checked every tick. */
export const reactiveSequence = (...children: NodeSpec[]): SequenceNode => ({
  type: 'sequence',
  children,
  reactive: true,
});
/** {@link SelectorNode} builder. */
export const selector = (...children: NodeSpec[]): SelectorNode => ({ type: 'selector', children });
/** Reactive {@link SelectorNode} builder: higher-priority children are re-checked every tick. */
export const reactiveSelector = (...children: NodeSpec[]): SelectorNode => ({
  type: 'selector',
  children,
  reactive: true,
});
/** {@link RandomSelectorNode} builder. */
export const randomSelector = (children: NodeSpec[], weights?: number[]): RandomSelectorNode =>
  weights ? { type: 'randomSelector', children, weights } : { type: 'randomSelector', children };
/** {@link ParallelNode} builder. */
export const parallel = (
  children: NodeSpec[],
  policy: { success?: ParallelPolicy; failure?: ParallelPolicy } = {},
): ParallelNode => ({ type: 'parallel', children, ...policy });
/** {@link UtilityNode} builder: `options` maps a score handler name to the subtree it picks. */
export const utility = (
  options: UtilityOption[],
  settings: { inertia?: number; threshold?: number } = {},
): UtilityNode => ({
  type: 'utility',
  options,
  ...settings,
});
/** {@link InverterNode} builder. */
export const inverter = (child: NodeSpec): InverterNode => ({ type: 'inverter', child });
/** {@link RepeaterNode} builder. */
export const repeater = (
  child: NodeSpec,
  options: { count?: number; until?: 'success' | 'failure' } = {},
): RepeaterNode => ({
  type: 'repeater',
  child,
  ...options,
});
/** {@link CooldownNode} builder. */
export const cooldown = (seconds: number, child: NodeSpec): CooldownNode => ({ type: 'cooldown', seconds, child });
/** {@link GuardNode} builder. */
export const guard = (condition: string, child: NodeSpec): GuardNode => ({ type: 'guard', condition, child });
/** {@link TimeoutNode} builder. */
export const timeout = (seconds: number, child: NodeSpec): TimeoutNode => ({ type: 'timeout', seconds, child });
/** {@link ConditionNode} builder. */
export const condition = (name: string): ConditionNode => ({ type: 'condition', name });
/** {@link ActionNode} builder. */
export const action = (name: string): ActionNode => ({ type: 'action', name });
/** {@link WaitNode} builder. */
export const wait = (seconds: number): WaitNode => ({ type: 'wait', seconds });

const COMPOSITES = new Set(['sequence', 'selector', 'randomSelector', 'parallel']);
const DECORATORS = new Set(['inverter', 'repeater', 'cooldown', 'guard', 'timeout']);
const KEYS: Record<string, readonly string[]> = {
  sequence: ['children', 'reactive'],
  selector: ['children', 'reactive'],
  randomSelector: ['children', 'weights'],
  parallel: ['children', 'success', 'failure'],
  utility: ['options', 'inertia', 'threshold'],
  inverter: ['child'],
  repeater: ['child', 'count', 'until'],
  cooldown: ['child', 'seconds'],
  guard: ['child', 'condition'],
  timeout: ['child', 'seconds'],
  condition: ['name'],
  action: ['name'],
  wait: ['seconds'],
};
/** Deepest nesting {@link validateTree} accepts, so a hostile file cannot overflow the stack. */
export const MAX_TREE_DEPTH = 256;
/** Most nodes {@link validateTree} accepts in one tree. */
export const MAX_TREE_NODES = 100_000;

const nameSet = (source: HandlerNames[keyof HandlerNames]): Set<string> | null => {
  if (source == null) return null;
  if (typeof (source as Iterable<string>)[Symbol.iterator] === 'function') return new Set(source as Iterable<string>);
  return new Set(Object.keys(source));
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const nonNegative = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * Check a tree description (a {@link TreeDocument} or a bare root node) without building it. Returns every problem
 * found, each with its path and the fix; an empty array means it is valid. With `handlers`, unknown action, condition
 * and score names are problems too. Never throws, whatever the input.
 */
export function validateTree(input: unknown, handlers?: HandlerNames): TreeIssue[] {
  const issues: TreeIssue[] = [];
  const actions = nameSet(handlers?.actions),
    conditions = nameSet(handlers?.conditions),
    scores = nameSet(handlers?.scores);
  let root: unknown = input,
    rootPath = 'root';
  if (isRecord(input) && 'format' in input) {
    if (input.format !== 'margo-behavior')
      issues.push({ path: 'format', message: "must be 'margo-behavior'; this is not a behaviour-tree document" });
    if (input.version !== 1)
      issues.push({
        path: 'version',
        message: 'must be 1; this file is from a newer version, update @margoengine/behavior',
      });
    root = input.root;
  } else rootPath = 'root';
  let count = 0;
  const handlerName = (set: Set<string> | null, value: unknown, path: string, kind: string): void => {
    if (typeof value !== 'string' || !value) issues.push({ path, message: `must be a non-empty ${kind} name` });
    else if (set && !set.has(value))
      issues.push({
        path,
        message: `unknown ${kind} '${value}'; register it in handlers.${kind === 'action' ? 'actions' : kind === 'condition' ? 'conditions' : 'scores'}`,
      });
  };
  const visit = (node: unknown, path: string, depth: number): void => {
    if (++count > MAX_TREE_NODES) {
      if (count === MAX_TREE_NODES + 1)
        issues.push({ path, message: `tree has more than ${MAX_TREE_NODES} nodes; split it` });
      return;
    }
    if (depth > MAX_TREE_DEPTH) {
      issues.push({ path, message: `nested deeper than ${MAX_TREE_DEPTH} levels; flatten the tree` });
      return;
    }
    if (!isRecord(node)) {
      issues.push({ path, message: 'must be a node object such as {"type": "action", "name": "attack"}' });
      return;
    }
    const type = node.type;
    if (typeof type !== 'string' || !Object.hasOwn(KEYS, type)) {
      issues.push({
        path: `${path}.type`,
        message: `unknown node type ${JSON.stringify(type)}; use one of ${Object.keys(KEYS).join(', ')}`,
      });
      return;
    }
    for (const key of Object.keys(node))
      if (key !== 'type' && key !== 'label' && !KEYS[type].includes(key))
        issues.push({ path: `${path}.${key}`, message: `is not a field of a ${type} node; remove it` });
    if ('label' in node && typeof node.label !== 'string')
      issues.push({ path: `${path}.label`, message: 'must be a string' });
    if (COMPOSITES.has(type)) {
      const children = node.children;
      if (!Array.isArray(children) || !children.length) {
        issues.push({ path: `${path}.children`, message: 'must be a non-empty array of nodes' });
        return;
      }
      if ('reactive' in node && typeof node.reactive !== 'boolean')
        issues.push({ path: `${path}.reactive`, message: 'must be true or false' });
      if (type === 'randomSelector' && 'weights' in node) {
        const weights = node.weights;
        if (!Array.isArray(weights) || weights.length !== children.length || !weights.every(nonNegative))
          issues.push({ path: `${path}.weights`, message: 'must hold one finite weight of 0 or more per child' });
      }
      if (type === 'parallel')
        for (const key of ['success', 'failure'] as const)
          if (key in node) {
            const policy = node[key];
            if (
              policy !== 'all' &&
              policy !== 'any' &&
              !(Number.isInteger(policy) && (policy as number) >= 1 && (policy as number) <= children.length)
            )
              issues.push({
                path: `${path}.${key}`,
                message: `must be 'all', 'any' or a whole count from 1 to ${children.length}`,
              });
          }
      children.forEach((child, index) => visit(child, `${path}.children[${index}]`, depth + 1));
    } else if (DECORATORS.has(type)) {
      if (type === 'repeater') {
        if ('count' in node && !(Number.isInteger(node.count) && (node.count as number) >= 1))
          issues.push({
            path: `${path}.count`,
            message: 'must be a whole number of 1 or more (omit it to repeat forever)',
          });
        if ('until' in node && node.until !== 'success' && node.until !== 'failure')
          issues.push({ path: `${path}.until`, message: "must be 'success' or 'failure'" });
      }
      if ((type === 'cooldown' || type === 'timeout') && !nonNegative(node.seconds))
        issues.push({ path: `${path}.seconds`, message: 'must be a finite number of seconds, 0 or more' });
      if (type === 'guard') handlerName(conditions, node.condition, `${path}.condition`, 'condition');
      visit(node.child, `${path}.child`, depth + 1);
    } else if (type === 'utility') {
      const options = node.options;
      if (!Array.isArray(options) || !options.length) {
        issues.push({ path: `${path}.options`, message: 'must be a non-empty array of {score, child}' });
        return;
      }
      for (const key of ['inertia', 'threshold'] as const)
        if (key in node && !(typeof node[key] === 'number' && Number.isFinite(node[key])))
          issues.push({ path: `${path}.${key}`, message: 'must be a finite number' });
      options.forEach((option, index) => {
        const at = `${path}.options[${index}]`;
        if (!isRecord(option)) {
          issues.push({ path: at, message: 'must be {score, child}' });
          return;
        }
        handlerName(scores, option.score, `${at}.score`, 'score');
        visit(option.child, `${at}.child`, depth + 1);
      });
    } else if (type === 'condition') handlerName(conditions, node.name, `${path}.name`, 'condition');
    else if (type === 'action') handlerName(actions, node.name, `${path}.name`, 'action');
    else if (type === 'wait' && !nonNegative(node.seconds))
      issues.push({ path: `${path}.seconds`, message: 'must be a finite number of seconds, 0 or more' });
  };
  visit(root, rootPath, 0);
  return issues;
}

/**
 * Read a saved tree: JSON text or an already-parsed object, checked with {@link validateTree}.
 * @throws TypeError naming the first problem's path and fix (`root.children[1].seconds must be ...`), or for text
 * that is not JSON.
 */
export function parseTree(input: string | unknown, handlers?: HandlerNames): TreeDocument {
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch (error) {
      throw new TypeError(
        `Behaviour tree is not valid JSON (${(error as Error).message}); save it with JSON.stringify(document)`,
      );
    }
  }
  const issues = validateTree(value, handlers);
  if (issues.length)
    throw new TypeError(
      `Invalid behaviour tree; fix ${issues[0].path}: ${issues[0].message}${issues.length > 1 ? ` (and ${issues.length - 1} more; see validateTree)` : ''}`,
    );
  return isRecord(value) && 'format' in value ? (value as unknown as TreeDocument) : treeDocument(value as NodeSpec);
}
