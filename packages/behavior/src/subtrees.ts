// Clean-room reference expansion. No registry or runtime changes on the root entry.
import { BehaviorTree, type BehaviorTreeOptions } from './tree.js';
import {
  MAX_TREE_DEPTH,
  MAX_TREE_NODES,
  type HandlerNames,
  type NodeSpec,
  type TreeDocument,
  type TreeIssue,
  validateTree as validateBase,
} from './spec.js';

/** A named reference, resolved independently for every occurrence at construction. */
export interface SubtreeNode {
  type: 'subtree';
  name: string;
  label?: string;
}
type WithReferences<T> = T extends { children: NodeSpec[] }
  ? Omit<T, 'children'> & { children: SubtreeSpec[] }
  : T extends { child: NodeSpec }
    ? Omit<T, 'child'> & { child: SubtreeSpec }
    : T extends { options: { score: string; child: NodeSpec }[] }
      ? Omit<T, 'options'> & { options: { score: string; child: SubtreeSpec }[] }
      : T;
/** All ordinary nodes, recursively allowing named references. */
export type SubtreeSpec = WithReferences<NodeSpec> | SubtreeNode;
/** JSON tree document before references are expanded. */
export interface SubtreeDocument {
  format: 'margo-behavior';
  version: 1;
  root: SubtreeSpec;
}
/** Explicit, caller-owned registry. No process-global registrations. */
export type SubtreeRegistry = Readonly<Record<string, SubtreeSpec | SubtreeDocument>>;
/** Build a reusable reference to a registered root. */
export const subtree = (name: string): SubtreeNode => ({ type: 'subtree', name });

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function expand(
  input: unknown,
  registry: SubtreeRegistry,
  handlers?: HandlerNames,
): { document: TreeDocument; issues: TreeIssue[] } {
  const issues: TreeIssue[] = [];
  let count = 0;
  const active = new Set<string>();
  const objects = new Set<object>();
  const visit = (value: unknown, path: string, depth: number): unknown => {
    const fail = (message: string): undefined => {
      issues.push({ path, message });
      return undefined;
    };
    if (++count > MAX_TREE_NODES)
      return count === MAX_TREE_NODES + 1
        ? fail(`expanded tree exceeds ${MAX_TREE_NODES} nodes; reduce reuse`)
        : undefined;
    if (depth > MAX_TREE_DEPTH) return fail(`expanded tree exceeds ${MAX_TREE_DEPTH} levels; flatten references`);
    if (!record(value)) return value;
    if (objects.has(value)) return fail('cyclic node object; use an acyclic tree');
    objects.add(value);
    try {
      if (value.type === 'subtree') {
        for (const key of Object.keys(value))
          if (!['type', 'name', 'label'].includes(key))
            issues.push({ path: `${path}.${key}`, message: 'unknown subtree field; remove it' });
        if (value.label !== undefined && typeof value.label !== 'string')
          issues.push({ path: `${path}.label`, message: 'label must be a string; replace it' });
        const name = value.name;
        if (typeof name !== 'string' || !name) return fail('subtree needs a non-empty name; supply a registered name');
        if (!Object.hasOwn(registry, name)) return fail(`unknown subtree '${name}'; register it`);
        if (active.has(name)) return fail(`subtree cycle at '${name}'; remove the recursive reference`);
        active.add(name);
        const target: unknown = registry[name];
        let resolved: unknown;
        if (record(target) && 'format' in target) {
          const header = { ...target, root: { type: 'wait', seconds: 0 } };
          issues.push(...validateBase(header).map((issue) => ({ ...issue, path: `${path}<${name}>.${issue.path}` })));
          resolved = visit(target.root, `${path}<${name}>`, depth + 1);
        } else resolved = visit(target, `${path}<${name}>`, depth + 1);
        active.delete(name);
        return record(resolved) && typeof value.label === 'string' ? { ...resolved, label: value.label } : resolved;
      }
      const copy = { ...value };
      if (Array.isArray(value.children))
        copy.children = value.children.map((child, i) => visit(child, `${path}.children[${i}]`, depth + 1));
      if ('child' in value) copy.child = visit(value.child, `${path}.child`, depth + 1);
      if (Array.isArray(value.options))
        copy.options = value.options.map((option, i) =>
          record(option) ? { ...option, child: visit(option.child, `${path}.options[${i}].child`, depth + 1) } : option,
        );
      return copy;
    } finally {
      objects.delete(value);
    }
  };
  const value =
    record(input) && 'format' in input
      ? { ...input, root: visit(input.root, 'root', 0) }
      : { format: 'margo-behavior', version: 1, root: visit(input, 'root', 0) };
  issues.push(...validateBase(value, handlers));
  return { document: value as unknown as TreeDocument, issues };
}

/** Validate reachable references, cycles, expanded size and ordinary nodes/handlers. */
export function validateTree(input: unknown, registry: SubtreeRegistry = {}, handlers?: HandlerNames): TreeIssue[] {
  return expand(input, registry, handlers).issues;
}
/** Expand JSON or a description into a detached standard runtime document.
 * @throws TypeError for invalid JSON, unknown references, cycles or invalid nodes; fix the reported path.
 */
export function resolveTree(
  input: SubtreeSpec | SubtreeDocument | string,
  registry: SubtreeRegistry = {},
  handlers?: HandlerNames,
): TreeDocument {
  let value: unknown = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      throw new TypeError('Invalid subtree JSON; supply a JSON tree document');
    }
  }
  const result = expand(value, registry, handlers);
  if (result.issues.length)
    throw new TypeError(`Invalid subtree tree; fix ${result.issues[0].path}: ${result.issues[0].message}`);
  return result.document;
}
/** BehaviorTree with explicit named subtree reuse; all runtime state is local to each occurrence. */
export class SubtreeTree<C = undefined> extends BehaviorTree<C> {
  /** Resolve references once, then use the ordinary deterministic runtime.
   * @throws TypeError for invalid references or descriptions; fix the reported path.
   */
  constructor(
    description: SubtreeSpec | SubtreeDocument | string,
    options: BehaviorTreeOptions<C> & { subtrees?: SubtreeRegistry },
  ) {
    super(resolveTree(description, options.subtrees), options);
  }
}
