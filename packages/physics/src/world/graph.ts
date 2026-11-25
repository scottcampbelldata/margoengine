// The coupling graph of a physics world: which solver's data reaches which, from what each declares it writes, reads and
// accumulates into; the coupling groups (its strongly connected components, Tarjan, "Depth-first search and linear graph
// algorithms", SIAM Journal on Computing 1(2), 1972); and the order the groups run in (topological, Kahn 1962). Every choice
// that a hash, a pointer or the order solvers were added could sway is made by the solvers' ids instead, so two worlds built
// from the same solvers in any order run in the same order.

/** What one solver declares about the fields it touches. */
export interface CouplingNode {
  /** The solver's id, unique in the world. */
  readonly id: string;
  /** Fields it alone writes. */
  readonly writes: readonly string[];
  /** Fields it reads. */
  readonly reads: readonly string[];
  /** Fields it adds to (impulses, heat, mass): an edge back to the field's writer. */
  readonly accumulates: readonly string[];
}

/** A directed edge: data of `from` reaches `to` through `field`. */
export interface CouplingEdge {
  readonly from: string;
  readonly to: string;
  readonly field: string;
  /** `read`: `to` reads what `from` writes; `accumulate`: `from` adds to a field `to` writes. */
  readonly kind: 'read' | 'accumulate';
}

/** The coupling graph and its groups, in the order they run. */
export interface CouplingGraph {
  readonly edges: readonly CouplingEdge[];
  /** Strongly connected components, each its solver ids in id order; the groups in the order they run. */
  readonly groups: readonly (readonly string[])[];
  /** For each solver, the index of its group in `groups`. */
  readonly groupOf: ReadonlyMap<string, number>;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Builds the coupling graph of `nodes`: an edge from a field's writer to each reader, and from each accumulator to the writer.
 * With `partial` a field nobody writes yet is no edge (a world while its solvers are being added); without, it is an error.
 * @throws RangeError for a repeated solver id, a field with two writers, or (unless `partial`) a field read or accumulated that
 * nobody writes.
 */
export function couplingGraph(nodes: readonly CouplingNode[], partial = false): CouplingGraph {
  const ids = nodes.map((n) => n.id).sort(byText),
    writer = new Map<string, string>();
  for (let i = 1; i < ids.length; i++)
    if (ids[i] === ids[i - 1])
      throw new RangeError(`Two solvers have the id "${ids[i]}"; give each solver its own id.`);
  for (const node of nodes)
    for (const field of node.writes) {
      const other = writer.get(field);
      if (other !== undefined)
        throw new RangeError(
          `Field "${field}" has two writers, "${other}" and "${node.id}"; one solver owns a field, and others read or accumulate into it.`,
        );
      writer.set(field, node.id);
    }
  const edges: CouplingEdge[] = [];
  for (const node of [...nodes].sort((a, b) => byText(a.id, b.id))) {
    for (const field of [...node.reads].sort(byText)) {
      const from = writer.get(field);
      if (from === undefined && partial) continue;
      if (from === undefined)
        throw new RangeError(
          `Solver "${node.id}" reads field "${field}", which no solver writes; add the solver that owns it.`,
        );
      if (from !== node.id) edges.push({ from, to: node.id, field, kind: 'read' });
    }
    for (const field of [...node.accumulates].sort(byText)) {
      const to = writer.get(field);
      if (to === undefined && partial) continue;
      if (to === undefined)
        throw new RangeError(
          `Solver "${node.id}" adds to field "${field}", which no solver writes; add the solver that owns it.`,
        );
      if (to !== node.id) edges.push({ from: node.id, to, field, kind: 'accumulate' });
    }
  }
  const components = stronglyConnected(ids, edges),
    groups = orderGroups(components, edges),
    groupOf = new Map<string, number>();
  groups.forEach((group, g) => {
    for (const id of group) groupOf.set(id, g);
  });
  return { edges, groups, groupOf };
}

/**
 * Tarjan's strongly connected components of the graph on `ids` (in id order) with `edges`, iteratively (no recursion, so a long
 * chain of solvers cannot overflow the stack). Each component's ids come back in id order.
 */
export function stronglyConnected(ids: readonly string[], edges: readonly CouplingEdge[]): string[][] {
  const out = new Map<string, string[]>();
  for (const id of ids) out.set(id, []);
  for (const e of edges) out.get(e.from)?.push(e.to);
  for (const list of out.values()) list.sort(byText);
  const index = new Map<string, number>(),
    low = new Map<string, number>(),
    onStack = new Set<string>(),
    stack: string[] = [],
    components: string[][] = [];
  let next = 0;
  for (const root of ids) {
    if (index.has(root)) continue;
    // Each frame: the node and how far through its successors the walk has gone.
    const walk: [string, number][] = [[root, 0]];
    index.set(root, next);
    low.set(root, next);
    next++;
    stack.push(root);
    onStack.add(root);
    while (walk.length) {
      const frame = walk[walk.length - 1]!,
        [v, at] = frame,
        successors = out.get(v)!;
      if (at < successors.length) {
        frame[1] = at + 1;
        const w = successors[at]!;
        if (!index.has(w)) {
          index.set(w, next);
          low.set(w, next);
          next++;
          stack.push(w);
          onStack.add(w);
          walk.push([w, 0]);
        } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
        continue;
      }
      walk.pop();
      if (walk.length) {
        const parent = walk[walk.length - 1]![0];
        low.set(parent, Math.min(low.get(parent)!, low.get(v)!));
      }
      if (low.get(v) === index.get(v)) {
        const component: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          component.push(w);
        } while (w !== v);
        components.push(component.sort(byText));
      }
    }
  }
  return components;
}

/**
 * The components in the order they run: every group after the groups whose data it reads (Kahn's topological sort of the
 * condensation), ties taken by the smallest solver id, so the order never depends on how the solvers were added.
 */
function orderGroups(components: string[][], edges: readonly CouplingEdge[]): string[][] {
  const of = new Map<string, number>();
  components.forEach((c, i) => {
    for (const id of c) of.set(id, i);
  });
  const after = components.map(() => new Set<number>()),
    waiting = components.map(() => 0);
  for (const e of edges) {
    const a = of.get(e.from)!,
      b = of.get(e.to)!;
    if (a !== b && !after[a]!.has(b)) {
      after[a]!.add(b);
      waiting[b]!++;
    }
  }
  const first = (i: number): string => components[i]![0]!,
    ready = components.map((_, i) => i).filter((i) => waiting[i] === 0),
    order: string[][] = [];
  while (ready.length) {
    ready.sort((a, b) => byText(first(a), first(b)));
    const i = ready.shift()!;
    order.push(components[i]!);
    for (const j of after[i]!) if (--waiting[j]! === 0) ready.push(j);
  }
  return order;
}
