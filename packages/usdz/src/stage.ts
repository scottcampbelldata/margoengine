// USD composition: layer stacks, then a tree of sites for each prim, strongest first, built from the Composition chapter
// of the AOUSD USD Core Specification v1.1.0 (local, inherits, variants, references, payloads, specializes). What comes
// out is one flat spec map of the same shape a single static layer gives. The result is compared with what OpenUSD
// reports for the same files, not with a writer of ours. Anything the specification does not settle says so where it
// sits; docs/clean-room.md names each source.
import type { ArcItem, ListOp, Specs, TimeSamples } from './crate.js';

/** Time in a layer to time in the stage: `scale * t + offset`. */
interface Offset {
  offset: number;
  scale: number;
}
/** A layer as composition reads it, with its children and properties listed by prim. */
export interface Layer {
  id: string;
  specs: Specs;
  children: Map<string, string[]>;
  properties: Map<string, string[]>;
}
/** One layer of a stack, with the time offset from it to the stack's root layer. */
interface StackLayer {
  layer: Layer;
  offset: Offset;
}
interface Stack {
  id: string;
  root: Layer;
  layers: StackLayer[];
}
/** One step of namespace from an arc's far side to its near side. Paths outside `from` have no place unless `open`. */
interface Step {
  from: string;
  to: string;
  open: boolean;
  /**
   * On an implied class arc: the authored arc's own pair at the prim that authored it, when the arcs above cannot map
   * that prim. Seen on OpenUSD (black-box stages, KB1942b); the specification does not say.
   */
  also?: [string, string][];
}
type ArcKind = 'root' | 'inherit' | 'variant' | 'reference' | 'payload' | 'specialize';
const ORDER: Record<ArcKind, number> = { root: 0, inherit: 1, variant: 2, reference: 3, payload: 4, specialize: 5 };
/** A site that may hold opinions on a prim. */
interface Node {
  stack: Stack;
  path: string;
  kind: ArcKind;
  /** Namespace depth of the prim that brought the arc: deeper is stronger between arcs of one kind. */
  depth: number;
  /** Order in the arc's list. */
  order: number;
  /** This site to the root of the tree it was built for, nearest arc first. */
  steps: Step[];
  offset: Offset;
  children: Node[];
  parent?: Node;
  /** Variant sets already settled here, by name. */
  settled: Set<string>;
  /** Implied by a class arc in a stack this one brought in, not authored here: weaker than an authored arc of equal depth. */
  implied?: boolean;
  /** One object shared by a specializes arc and the arcs it implies: the specification keeps them together. */
  family?: object;
  /**
   * Namespace depth of the stage prim this arc first reached, set on the stage's own trees. Seen on OpenUSD, and the
   * specification's "deeper in namespace" does not say which namespace: this is what orders specializes arcs.
   */
  reached?: number;
  /** Namespace depth, in its own stack, of the prim that authored this arc when it was placed. */
  intro?: number;
  /** On an implied arc: `intro` of the authored arc it stands for. */
  source?: number;
  /** Carried down from the parent prim's tree, not placed for this prim. */
  anc?: boolean;
  /** When it was made in its prim index; carried down, it keeps the number. The first live node made for a site holds it. */
  born: number;
  /** Gives no opinions and follows no arcs: the placeholder an arc leaves where its site is held, or a moved specializes. */
  inert?: boolean;
  /** On a specializes node moved under the index root: the placeholder it left where it was authored. */
  stub?: Node;
  /** On an implied class arc: the node of the arc it was implied from. */
  of?: Node;
  /** On a class node: a specializes arc of its prim to the same site made no node, as this node held it. */
  shadow?: boolean;
}
/** What composition could not do. It goes on, as OpenUSD does, and the caller may read these. */
export interface ComposeIssue {
  code: 'missing-layer' | 'missing-default-prim' | 'cycle' | 'unsupported-layer' | 'invalid-offset';
  message: string;
}
export interface ComposeOptions {
  /** Preserve value provenance and merge/anchor clip dictionaries for optional clip resolution. Default false. */
  trackValueSources?: boolean;
  /** A layer by its id (a path from the root layer's folder), or nothing when it cannot be had. */
  layer(id: string): Specs | undefined;
  /** Variant selections that beat the file's, by prim path: `{'/Model': {shadingVariant: 'red'}}`. */
  variants?: Record<string, Record<string, string>>;
  /** Payloads to leave out. Default: none, as `UsdStage.Open` loads all. */
  payloads?: boolean;
  issues?: ComposeIssue[];
  signal?: AbortSignal;
  /** Most composed prims. */
  maxPrims?: number;
}

const IDENTITY: Offset = { offset: 0, scale: 1 };
const after = (outer: Offset, inner: Offset): Offset => ({
  offset: outer.offset + outer.scale * inner.offset,
  scale: outer.scale * inner.scale,
});
const child = (parent: string, name: string) => (parent === '/' ? '/' : parent + '/') + name;
const parentOf = (path: string) => {
  const cut = path.lastIndexOf('/');
  return cut <= 0 ? '/' : path.slice(0, cut);
};
const stripVariants = (path: string) => (path.includes('{') ? path.replace(/\{[^}]*\}/g, '') : path);
const under = (path: string, root: string) =>
  path === root ||
  (path.startsWith(root) &&
    (root === '/' || path[root.length] === '/' || path[root.length] === '.' || path[root.length] === '['));

type Pair = [string, string];
/** The pair whose source (side 0) or target (side 1) is the longest root holding the path. */
const longestPair = (pairs: Pair[], side: 0 | 1, at: string) =>
  pairs.reduce<Pair | undefined>(
    (best, pair) => (under(at, pair[side]) && (!best || pair[side].length > best[side].length) ? pair : best),
    undefined,
  );
/** A path through one map function: the longest source maps it, and the result must map back by the same pair. */
function mapBy(pairs: Pair[], path: string, side: 0 | 1 = 0): string | undefined {
  const by = longestPair(pairs, side, path);
  if (!by) return undefined;
  const mapped = by[1 - side] + path.slice(by[side].length);
  return longestPair(pairs, (1 - side) as 0 | 1, mapped) === by ? mapped : undefined;
}
/**
 * One step's map function: its own pair, the pairs an implied class arc keeps (KB1942b) and, on an internal reference or
 * class arc, the identity on the root namespace that its own pairs shadow.
 */
const pairsOf = (step: Step): Pair[] => [
  [step.from, step.to],
  ...(step.also ?? []),
  ...(step.open ? [['/', '/'] as Pair] : []),
];
/**
 * inner then outer as one map function. Seen on OpenUSD (black-box stages, KB1942c): through a chain of internal arcs a
 * target is mapped once by the composed function, not arc by arc, so a path the first arc's own pair shadows still maps
 * through the chain's identity. Each inner pair goes on through outer, and each outer pair comes back through inner.
 */
function compose(inner: Pair[], outer: Pair[]): Pair[] {
  const out: Pair[] = [];
  const add = (from: string | undefined, to: string | undefined) => {
    if (from !== undefined && to !== undefined && !out.some(([a, b]) => a === from && b === to)) out.push([from, to]);
  };
  for (const [from, to] of inner) add(from, mapBy(outer, to));
  for (const [from, to] of outer) add(mapBy(inner, from, 1), to);
  return out;
}
const composed = new WeakMap<Step[], Pair[]>();
/** A path through the steps of a node, or nothing when it has no place in the root namespace. */
function mapPath(steps: Step[], path: string): string | undefined {
  if (!steps.length) return stripVariants(path);
  let pairs = composed.get(steps);
  if (!pairs) {
    pairs = steps.slice(1).reduce((f, step) => compose(f, pairsOf(step)), pairsOf(steps[0]));
    composed.set(steps, pairs);
  }
  return mapBy(pairs, stripVariants(path));
}

/** Index one layer's spec map: children and properties by prim, variant paths included. */
export function indexLayer(id: string, specs: Specs): Layer {
  const children = new Map<string, string[]>(),
    properties = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string, name: string) => {
    const list = map.get(key);
    if (list) list.push(name);
    else map.set(key, [name]);
  };
  for (const path in specs) {
    const type = specs[path].specType;
    if (type === 1 || type === 8) {
      const dot = path.lastIndexOf('.', path.includes('[') ? path.indexOf('[') : undefined);
      add(properties, path.slice(0, dot), path.slice(dot + 1));
    } else if (type === 6) {
      const cut = path.lastIndexOf('/');
      add(children, cut <= 0 ? '/' : path.slice(0, cut), path.slice(cut + 1));
    }
  }
  return { id, specs, children, properties };
}
/** A path from `anchor`'s folder, in the ids layers go by. `..` past the top stays in the id. */
export function anchored(anchor: string, assetPath: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(assetPath) || assetPath.startsWith('/')) return assetPath;
  // Inside a package the folder is the package's: `a.usdz[b/c.usda]` anchors `d.png` at `a.usdz[b/d.png]`.
  const open = anchor.endsWith(']') ? anchor.lastIndexOf('[') : -1;
  const inside = open >= 0 ? anchor.slice(open + 1, -1) : anchor;
  const parts = inside.split('/').slice(0, -1);
  for (const part of assetPath.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length && parts[parts.length - 1] !== '..') parts.pop();
    else parts.push(part);
  }
  const path = parts.join('/');
  return open >= 0 ? `${anchor.slice(0, open)}[${path}]` : path;
}
/**
 * A list edit applied to the weaker result, in the order OpenUSD applies it (pinned black-box on usd-core 26.11 against
 * 1,900 random edits; 300 of them as stages in tests/list-edit.test.js): delete; add what is missing at the end; prepend moves its items, first
 * occurrence kept, to the front; append moves its items, last occurrence kept, to the end; reorder sorts the listed items
 * and each carries the unlisted items that follow it, while unlisted items before the first listed one stay in front.
 */
function apply<T>(list: T[], op: ListOp<T> | T[] | undefined, key: (item: T) => unknown = (v) => v): T[] {
  if (op === undefined) return list;
  if (Array.isArray(op)) return op.slice();
  if (op.explicit) return op.explicit.slice();
  const keys = (items: T[]) => new Set(items.map(key));
  const unique = (items: T[]) => {
    const seen = new Set<unknown>();
    return items.filter((v) => !seen.has(key(v)) && !!seen.add(key(v)));
  };
  const deleted = keys(op.delete ?? []);
  let out = list.filter((item) => !deleted.has(key(item)));
  for (const item of op.add ?? []) if (!out.some((v) => key(v) === key(item))) out.push(item);
  if (op.prepend?.length) {
    const front = unique(op.prepend),
      moved = keys(front);
    out = [...front, ...out.filter((v) => !moved.has(key(v)))];
  }
  if (op.append?.length) {
    const back = unique(op.append.slice().reverse()).reverse(),
      moved = keys(back);
    out = [...out.filter((v) => !moved.has(key(v))), ...back];
  }
  if (op.order?.length) {
    const order = unique(op.order),
      listed = keys(order),
      lead: T[] = [],
      runs = new Map<unknown, T[]>();
    let run = lead;
    for (const item of out) {
      if (listed.has(key(item))) runs.set(key(item), (run = [item]));
      else run.push(item);
    }
    out = [...lead, ...order.flatMap((item) => runs.get(key(item)) ?? [])];
  }
  return out;
}

export interface Composed {
  specs: Specs;
  /** Every layer that took part, by id. */
  layers: string[];
}

/** Composes the stage whose root layer is `rootId` into one flat spec map. */
export function composeStage(rootId: string, options: ComposeOptions): Composed {
  const issues = options.issues ?? [],
    issue = (code: ComposeIssue['code'], message: string) => {
      if (!issues.some((i) => i.message === message)) issues.push({ code, message });
    },
    layers = new Map<string, Layer | null>(),
    stacks = new Map<string, Stack | null>(),
    maxPrims = options.maxPrims ?? 2_000_000;

  function layerOf(id: string): Layer | undefined {
    const known = layers.get(id);
    if (known !== undefined) return known ?? undefined;
    const specs = options.layer(id);
    const layer = specs ? indexLayer(id, specs) : undefined;
    layers.set(id, layer ?? null);
    return layer;
  }
  const codesPerSecond = (layer: Layer) => {
    const fields = layer.specs['/']?.fields ?? {};
    const value = fields.timeCodesPerSecond ?? fields.framesPerSecond ?? 24;
    return typeof value === 'number' ? value : 24;
  };
  /** A scale at or below 0, or one a zero rate makes endless, is a composition error: the offset counts as the default. */
  const checked = (offset: Offset, where: string): Offset => {
    if (offset.scale > 0 && Number.isFinite(offset.scale)) return offset;
    issue('invalid-offset', `time scale ${offset.scale} at ${where} is not above 0; the default offset is used`);
    return IDENTITY;
  };
  function stackOf(id: string): Stack | undefined {
    const known = stacks.get(id);
    if (known !== undefined) return known ?? undefined;
    const root = layerOf(id);
    if (!root) {
      stacks.set(id, null);
      return undefined;
    }
    const stack: Stack = { id, root, layers: [] };
    stacks.set(id, stack);
    const walk = (layer: Layer, offset: Offset, seen: string[]) => {
      stack.layers.push({ layer, offset });
      const fields = layer.specs['/']?.fields ?? {},
        paths = (fields.subLayers ?? []) as string[],
        offsets = (fields.subLayerOffsets ?? []) as Offset[];
      paths.forEach((path, i) => {
        const sub = anchored(layer.id, path);
        if (seen.includes(sub)) return issue('cycle', `sublayer cycle at ${sub}`);
        const next = layerOf(sub);
        if (!next) return issue('missing-layer', `could not open layer ${sub}`);
        const rate = codesPerSecond(layer) / codesPerSecond(next);
        const own = checked(offsets[i] ?? IDENTITY, sub);
        walk(next, after(offset, checked(after(own, { offset: 0, scale: rate }), sub)), [...seen, sub]);
      });
    };
    walk(root, IDENTITY, [id]);
    return stack;
  }
  const specAt = (entry: StackLayer, path: string) => entry.layer.specs[path];
  /** The list op of `field` at a site over the whole stack, weakest first, each item with the layer that authored it. */
  function listed<T>(stack: Stack, path: string, field: string, key: (item: T) => unknown = (v) => v) {
    let out: { item: T; entry: StackLayer }[] = [];
    for (let i = stack.layers.length - 1; i >= 0; i--) {
      const entry = stack.layers[i],
        op = specAt(entry, path)?.fields[field] as ListOp<T> | T[] | undefined;
      if (op === undefined) continue;
      const wrap = (items?: T[]) => items?.map((item) => ({ item, entry }));
      out = apply(
        out,
        Array.isArray(op)
          ? { explicit: wrap(op) }
          : {
              explicit: wrap(op.explicit),
              add: wrap(op.add),
              prepend: wrap(op.prepend),
              append: wrap(op.append),
              delete: wrap(op.delete),
              order: wrap(op.order),
            },
        (v) => key(v.item),
      );
    }
    return out;
  }
  const arcKey = (item: ArcItem) => item.assetPath + '\0' + item.primPath;

  /** Whether `a` comes before `b` in their tree, strongest first. */
  const before = (a: Node, b: Node) => {
    const line = (n: Node) => {
      const out: Node[] = [];
      for (let up: Node | undefined = n; up; up = up.parent) out.unshift(up);
      return out;
    };
    const x = line(a),
      y = line(b);
    if (x[0] !== y[0]) return 0;
    let i = 0;
    while (i < x.length && i < y.length && x[i] === y[i]) i++;
    if (i === x.length || i === y.length) return x.length - y.length;
    const at = x[i - 1],
      X = x[i],
      Y = y[i];
    // An implied arc from deeper in the same stack ranks here as the placeholder it passes on the way up would.
    if (Y.implied && Y.of && isClass(Y) && !isClass(X) && X.stack === at.stack) return before(a, Y.of);
    if (X.implied && X.of && isClass(X) && !isClass(Y) && Y.stack === at.stack) return before(X.of, b);
    // Seen on OpenUSD (black-box prim indexes, KB1942c part 28), the specification does not say: a class arc under a
    // variant of this node's own stack implies an inert placeholder on this node on its way up, and the arcs implied
    // from it rank as that placeholder does among this node's class arcs.
    const viaVariant = (n: Node, V: Node) =>
      V.kind === 'variant' && V.stack === at.stack && isClass(n) && n.stack === at.stack && holderOf(n.parent) === at;
    const asPlaceholder = (p: Node, q: Node) =>
      ORDER[p.kind] - ORDER[q.kind] ||
      ns(q) - ns(p) ||
      1 - +!!q.implied ||
      at.children.indexOf(X) - at.children.indexOf(Y);
    if (isClass(Y) && viaVariant(a, X)) return asPlaceholder(a, Y);
    if (isClass(X) && viaVariant(b, Y)) return -asPlaceholder(b, X);
    return at.children.indexOf(X) - at.children.indexOf(Y);
  };
  /**
   * Seen on OpenUSD (black-box prim indexes, KB1942c), the specification does not say: two implied class arcs on one
   * node, of one kind and depth, rank as the arcs they were implied from do.
   */
  const byOrigin = (a: Node, b: Node) => (a.implied && b.implied && a.of && b.of ? before(a.of, b.of) : 0);
  /**
   * Namespace depth as sibling nodes rank by it. Seen on OpenUSD (black-box prim indexes, KB1942c parts 23 and 29), the
   * specification does not say which namespace: below the index root, a class arc, authored or implied, counts the
   * depth of its parent node's path (variant selections left out) when it was placed there, which a node carried down
   * to a child prim keeps. That is the depth in the parent node's own stack, not the stage prim's: an inherit implied
   * into a stack a payload brought in at `/R/a/c/b` (4) hangs from that payload's `/M/a` and counts 2.
   */
  const ns = (n: Node) => (isClass(n) && n.parent?.parent ? (n.intro ?? n.depth) : n.depth);
  function attach(parent: Node, node: Node) {
    node.parent = parent;
    parent.children.push(node);
    parent.children.sort(
      (a, b) =>
        ORDER[a.kind] - ORDER[b.kind] ||
        ns(b) - ns(a) ||
        +!!a.implied - +!!b.implied ||
        byOrigin(a, b) ||
        a.order - b.order,
    );
  }
  /** The kinds of arc a node's tasks follow, a higher kind always first. */
  const KINDS = ['reference', 'payload', 'inherit', 'specialize'] as const;
  type Kind = (typeof KINDS)[number];
  /**
   * One prim index while it is built (Core Specification, Composition: Overview and Outline): its task lists, the class
   * arcs still to imply upward, and the first live node made for each site.
   */
  interface Build {
    tasks: Record<Kind, Node[]>;
    lift: Node[];
    /** Grafted specializes nodes still to move under the root, after every task of the four kinds. */
    late: Node[];
    held: Map<string, Node>;
    settle: boolean;
    depth: number;
    top: Node;
    /** Sites whose variant selections come before the index's own, strongest first. */
    ctx?: Node[];
    /** The carried placeholders were implied again (`reimply`). */
    redone?: boolean;
    /** Implied class arcs carried down from the parent prim, not yet implied again by the arcs they stand for. */
    pending?: Set<Node>;
  }
  let build: Build | undefined;
  let births = 0;
  const siteKey = (node: Node) => node.stack.id + '\0' + node.path;
  const isClass = (node: Node) => node.kind === 'inherit' || node.kind === 'specialize';
  const depthOf = (path: string) => stripVariants(path).split('/').length - 1;
  /** Records a node in the index being built and queues its tasks: its own arcs, and its implied arc upward. */
  function queue(node: Node, arcs: boolean, lift = true) {
    const b = build!;
    if (!node.inert && !b.held.has(siteKey(node))) b.held.set(siteKey(node), node);
    if (arcs && !node.inert) for (const kind of KINDS) b.tasks[kind].push(node);
    if (lift && isClass(node) && node.parent && !isClass(node.parent)) b.lift.push(node);
  }
  /** Maps the placeholders, and the arcs implied ones come from, that copied nodes point at to their copies. */
  const restub = (made: [Node, Node][]) => {
    const copies = new Map(made);
    for (const [, n] of made) {
      if (n.stub) n.stub = copies.get(n.stub);
      if (n.of) n.of = copies.get(n.of);
    }
  };
  /**
   * A copy of a site's index, composed alone, under new steps and a new offset, numbered in tree order. Seen on OpenUSD
   * (black-box prim indexes, KB1942c), the specification does not say: it leaves out its class nodes whose site the
   * index it joins already holds, with what is under them.
   */
  /**
   * Held placeholders of a specializes arc authored on the root of a grafted index. Seen on OpenUSD (black-box prim
   * indexes, KB1942c), the specification does not say: such a placeholder implies its arc upward even where an inherit
   * of the same stack reaches the site, so the implied arc above is a specializes and the inherit implies nothing there.
   */
  const blocked = new WeakSet<Node>();
  function graft(tree: Node, kind: ArcKind, depth: number, order: number, steps: Step[], offset: Offset): Node {
    const families = new Map<object, object>();
    const made: [Node, Node][] = [];
    // Seen on OpenUSD (black-box prim indexes, KB1942c), the specification does not say: an implied class arc goes
    // with the arc it was implied from, so it is left out too, and so is what is under it.
    const dropped = new Set<Node>();
    const drop = (n: Node): void => {
      dropped.add(n);
      n.children.forEach(drop);
    };
    const mark = (n: Node): void => {
      for (const c of n.children)
        if (isClass(c) && !c.inert && build?.held.has(siteKey(c)) && (c.kind !== 'specialize' || c.implied || c.stub))
          drop(c);
        else mark(c);
    };
    mark(tree);
    const implied: Node[] = [];
    const list = (n: Node): void => {
      if (n.of && !dropped.has(n)) implied.push(n);
      n.children.forEach(list);
    };
    list(tree);
    for (let more = true; more; ) {
      more = false;
      for (const n of implied) if (!dropped.has(n) && dropped.has(n.of!)) drop(n), (more = true);
    }
    const copy = (node: Node, top: boolean): Node => {
      const out: Node = {
        ...node,
        reached: undefined,
        anc: top ? undefined : node.anc,
        family: node.family && (families.get(node.family) ?? families.set(node.family, {}).get(node.family)),
        kind: top ? kind : node.kind,
        depth: top ? depth : node.depth,
        order: top ? order : node.order,
        steps: [...node.steps, ...steps],
        offset: after(offset, node.offset),
        children: [],
        parent: undefined,
        settled: new Set(node.settled),
        born: ++births,
      };
      made.push([node, out]);
      for (const c of node.children) {
        // Seen on OpenUSD (black-box prim indexes, KB1942c), the specification does not say: an inherit left out as its
        // site is held no longer holds it for its prim's specializes arc to that site, which leaves its placeholder.
        if (dropped.has(c) && c.shadow && c.kind === 'inherit' && !c.implied && build?.held.has(siteKey(c))) {
          const k = copy({ ...c, kind: 'specialize', children: [], shadow: undefined }, false);
          k.inert = true;
          blocked.add(k);
          k.parent = out;
          out.children.push(k);
          continue;
        }
        if (dropped.has(c)) continue;
        if (isClass(c) && !c.inert && build?.held.has(siteKey(c))) {
          // A specializes arc authored on the graft's root leaves a placeholder; one moved up from deeper already did.
          if (c.kind !== 'specialize' || c.implied || c.stub) continue;
          const k = copy({ ...c, children: [] }, false);
          k.inert = true;
          blocked.add(k);
          k.parent = out;
          out.children.push(k);
          continue;
        }
        const k = copy(c, false);
        k.parent = out;
        out.children.push(k);
      }
      return out;
    };
    const top = copy(tree, true);
    restub(made);
    return top;
  }
  /** Grafted specializes nodes waiting for their late task to move them under the index root. */
  const promoted = new Set<Node>();
  /** The node a specializes placeholder left under the index root. */
  const realOf = new WeakMap<Node, Node>();
  /** Queues the nodes of a placed graft: none has arcs left to follow; its class arcs still imply theirs. */
  function settleGraft(top: Node, lift: boolean) {
    const walk = (n: Node) => {
      if (n !== top && n.kind === 'specialize' && !n.implied && !n.inert) {
        promoted.add(n);
        build!.late.push(n);
        return;
      }
      queue(n, false, n !== top || lift);
      n.children.forEach(walk);
    };
    walk(top);
  }
  const building = new Set<string>();
  const trees = new Map<string, Node>();
  /**
   * The prim index of `path` in `stack`, its arcs followed, with steps up to that stack's namespace. With `ctx`, its
   * variant selections are read from those sites first, and it is not kept.
   */
  function tree(stack: Stack, path: string, settle: boolean, ctx?: Node[]): Node {
    const key = stack.id + '\0' + path + (settle ? '\0v' : '');
    const known = ctx ? undefined : trees.get(key);
    if (known) return known;
    let root: Node;
    const depth = depthOf(path);
    if (depth <= 1) {
      root = {
        stack,
        path,
        kind: 'root',
        depth: 0,
        order: 0,
        steps: [],
        offset: IDENTITY,
        children: [],
        settled: new Set(),
        born: ++births,
      };
    } else {
      // Arcs of an ancestor reach down: each of its sites has a site of the same name for the child, made when it was.
      const name = path.slice(path.lastIndexOf('/') + 1),
        above = tree(stack, parentOf(path), true, ctx),
        made: [Node, Node][] = [];
      const descend = (node: Node): Node => {
        const out: Node = {
          ...node,
          path: child(node.path, name),
          anc: true,
          children: [],
          parent: undefined,
          settled: new Set(),
        };
        made.push([node, out]);
        carriedFrom.set(out, node);
        for (const c of node.children) {
          const k = descend(c);
          k.parent = out;
          out.children.push(k);
        }
        return out;
      };
      root = descend(above);
      restub(made);
    }
    if (building.has(key)) return root;
    building.add(key);
    const outer = build;
    build = {
      tasks: { reference: [], payload: [], inherit: [], specialize: [] },
      lift: [],
      late: [],
      held: new Map(),
      settle,
      depth,
      top: root,
      ctx,
    };
    // The nodes carried down are queued in tree order.
    const carry = (n: Node) => {
      queue(n, true);
      n.children.forEach(carry);
    };
    carry(root);
    drain();
    if (settle && stack === rootStack) {
      const stamp = (node: Node) => {
        node.reached ??= depth;
        node.children.forEach(stamp);
      };
      stamp(root);
    }
    build = outer;
    building.delete(key);
    if (!ctx) trees.set(key, root);
    return root;
  }
  /**
   * Runs the index's tasks. Seen on OpenUSD (black-box prim indexes, KB1942c), the specification orders strength, not
   * work: references, payloads, inherits and specializes, a higher kind always first and nodes in the order they were
   * queued; then the specializes arcs a graft carried in move under the root, so a site that a specializes arc of this
   * index's own nodes reaches is held by that arc even when the graft's branch is stronger; then the implied class
   * arcs, strongest node first; then, with nothing else left, one variant set at a time.
   */
  function drain() {
    const b = build!;
    for (;;) {
      const kind = KINDS.find((k) => b.tasks[k].length);
      if (kind) {
        expand(b.tasks[kind].shift()!, b.depth, kind);
        continue;
      }
      if (b.late.length) {
        expand(b.late.shift()!, b.depth, 'specialize');
        continue;
      }
      if (!b.settle) return;
      if (b.lift.length && !b.redone) {
        b.redone = true;
        reimply(b);
        unhold(b);
      }
      if (!b.lift.length && b.pending) settlePending(b);
      if (b.lift.length) {
        const rank = new Map<Node, number>();
        const number = (n: Node) => {
          rank.set(n, rank.size);
          n.children.forEach(number);
        };
        number(b.top);
        let best = 0;
        for (let i = 1; i < b.lift.length; i++) if (rank.get(b.lift[i])! < rank.get(b.lift[best])!) best = i;
        const start = b.lift.splice(best, 1)[0];
        const from = carriedFrom.get(start);
        const bare = !!b.pending && !!from && !!start.inert && start.kind === 'specialize' && !from.family;
        weak = bare;
        weakBorn = start.born;
        weakBare =
          !specsBelow(start) || !!start.parent?.children.some((c) => c.kind === 'specialize' && !c.anc && !c.implied);
        implied(start, b.depth);
        weak = false;
        if (b.pending) keepPending(b, start);
        continue;
      }
      if (!settleVariant(b.top, stripVariants(b.top.path), b.top.stack === rootStack)) return;
    }
  }
  /**
   * Seen on OpenUSD (black-box prim indexes, KB1942c), the specification does not say: at a child prim, the implied
   * inherits carried down from the parent prim below the index root are implied again, strongest carried authored arc
   * first, so a carried class arc that implies one of their sites first takes it and the carried inherit goes, with the
   * arcs implied from it. One the arc it stands for does not reach again keeps its site. A class arc placed for the child
   * prim itself takes no site from them. A carried specializes placeholder that made no family at the parent prim (an
   * arc held its site there) takes only the sites of carried inherits made before it, and none when its site has no
   * specs here or its node has a specializes arc of its own here.
   */
  const specsBelow = (n: Node): boolean => n.stack.layers.some((e) => specAt(e, n.path)) || n.children.some(specsBelow);
  let weak = false,
    weakBorn = 0,
    weakBare = false;
  /** A carried implied inherit the lift of such a placeholder leaves in place. */
  const stays = (p: Node) => weak && (weakBare || !(p.born < weakBorn));
  function unhold(b: Build) {
    const pending = new Set<Node>();
    const walk = (n: Node) => {
      if (n.kind === 'inherit' && n.implied && !n.inert && n.parent && n.parent !== b.top && carriedFrom.has(n))
        pending.add(n);
      n.children.forEach(walk);
    };
    walk(b.top);
    if (!pending.size) return;
    for (const n of pending) if (b.held.get(siteKey(n)) === n) b.held.delete(siteKey(n));
    b.lift = b.lift.filter((n) => !pending.has(n));
    b.pending = pending;
  }
  /** Drops a carried implied arc no arc implied again, with what is under it and the arcs implied from it. */
  function dropPending(b: Build, n: Node) {
    const gone = new Set<Node>();
    const drop = (x: Node): void => {
      gone.add(x);
      x.children.forEach(drop);
    };
    drop(n);
    for (let more = true; more; ) {
      more = false;
      for (const p of allNodes(b.top))
        if (!gone.has(p) && p.of && gone.has(p.of) && carriedFrom.has(p)) drop(p), (more = true);
    }
    for (const x of gone) {
      b.pending!.delete(x);
      if (x.parent && !gone.has(x.parent)) x.parent.children = x.parent.children.filter((c) => c !== x);
      if (b.held.get(siteKey(x)) === x) b.held.delete(siteKey(x));
    }
    b.lift = b.lift.filter((x) => !gone.has(x));
  }
  /** The authored class arc whose lift implies `n` again. */
  const ownerOf = (n: Node): Node => {
    let a = n;
    for (;;) {
      while (a.implied && a.of) a = a.of;
      while (a.parent && isClass(a.parent)) a = a.parent;
      if (!a.implied || !a.of) return a;
    }
  };
  /** After the lift of `start`, the carried implied arcs it stands for that it did not reach keep their sites. */
  function keepPending(b: Build, start: Node) {
    for (const n of [...b.pending!])
      if (ownerOf(n) === start) {
        b.pending!.delete(n);
        if (!b.held.has(siteKey(n))) b.held.set(siteKey(n), n);
      }
  }
  /** With no lifts left, the carried implied inherits not implied again keep their sites. */
  function settlePending(b: Build) {
    const left = [...b.pending!];
    b.pending = undefined;
    for (const n of left) if (!b.held.has(siteKey(n))) b.held.set(siteKey(n), n);
  }
  /** The node of the parent prim's index that each node carried down to a child prim was copied from. */
  const carriedFrom = new WeakMap<Node, Node>();
  /**
   * Seen on OpenUSD (black-box prim indexes, KB1942c), the specification does not say: a reference or payload carried
   * down to this prim that gets a class arc of its own here implies the specializes placeholders carried down with it
   * again, at this prim's depth, and on the index root such an arc takes its site from an implied arc that was carried
   * down for another arc. A placeholder carried into the parent prim too, with nothing there implied from it, is gone.
   */
  function reimply(b: Build) {
    const top = b.top,
      gone = new Set<Node>(),
      all: Node[] = [];
    if (!top.anc) return;
    const drop = (n: Node): void => {
      gone.add(n);
      n.children.forEach(drop);
    };
    const list = (n: Node): void => {
      all.push(n);
      n.children.forEach(list);
    };
    const stands = (n: Node) => {
      let up = n;
      while (up.parent) up = up.parent;
      const on = (m: Node): boolean => m.of === n || m.stub === n || m.children.some(on);
      return on(up);
    };
    for (const n of top.children) {
      if (n.kind !== 'reference' && n.kind !== 'payload') continue;
      if (!n.children.some((c) => isClass(c) && !c.anc && !c.implied)) continue;
      const step = n.steps[0];
      for (const p of n.children) {
        const from = carriedFrom.get(p);
        if (p.kind !== 'specialize' || !p.inert || !p.anc || p.implied || (from?.anc && !stands(from))) continue;
        const path = stripVariants(p.path),
          site = step && under(path, step.from) ? step.to + path.slice(step.from.length) : path;
        for (const x of top.children)
          if (isClass(x) && x.implied && x.anc && x.of !== p && x.stack === top.stack && stripVariants(x.path) === site)
            drop(x);
      }
    }
    if (!gone.size) return;
    list(top);
    // The implied arcs that stand for a dropped one go with it.
    for (let more = true; more; ) {
      more = false;
      for (const n of all) if (n.of && !gone.has(n) && gone.has(n.of)) drop(n), (more = true);
    }
    for (const n of all) {
      n.children = n.children.filter((c) => !gone.has(c));
      if (gone.has(n) && b.held.get(siteKey(n)) === n) b.held.delete(siteKey(n));
    }
    b.lift = b.lift.filter((n) => !gone.has(n));
  }
  /** Whether an arc to `path` in `stack` from `node` would lead back to a site on the way up. */
  const loops = (node: Node, stack: Stack, path: string) => {
    for (let up: Node | undefined = node; up; up = up.parent) {
      if (up.stack !== stack) continue;
      // An arc to an ancestor or a descendant of a site on the way up is a cycle too: `/M/a` referencing `/M` would
      // bring `/M/a` back under itself, one prim deeper each time. OpenUSD (black box) reports such an arc as a cycle
      // and composes the prim without it.
      const at = stripVariants(up.path);
      if (under(at, path) || under(path, at)) return true;
    }
    return false;
  };
  /**
   * A node for a site an arc reaches. Seen on OpenUSD (black-box prim indexes, KB1942c): a root prim is a bare node whose
   * own arcs this index follows; a deeper prim is its index composed alone.
   */
  function place(
    near: Node,
    stack: Stack,
    target: string,
    kind: ArcKind,
    depth: number,
    order: number,
    steps: Step[],
    offset: Offset,
    what: string,
  ): Node | undefined {
    const key = stack.id + '\0' + target;
    if (building.has(key) || building.has(key + '\0v') || loops(near, stack, target)) {
      issue('cycle', `${what} cycle at ${target}`);
      return undefined;
    }
    if (depthOf(target) <= 1)
      return {
        stack,
        path: target,
        kind,
        depth,
        order,
        steps,
        offset,
        children: [],
        settled: new Set(),
        born: ++births,
      };
    return graft(tree(stack, target, false), kind, depth, order, steps, offset);
  }
  /** Queues a node just placed: a bare one has its arcs to follow, a graft only its implied arcs. */
  const queuePlaced = (placed: Node, lift: boolean) =>
    depthOf(placed.path) > 1 ? settleGraft(placed, lift) : queue(placed, true, lift);
  function placeReference(
    node: Node,
    depth: number,
    kind: 'reference' | 'payload',
    item: ArcItem,
    entry: StackLayer,
    order: number,
  ) {
    const stack = item.assetPath ? stackOf(anchored(entry.layer.id, item.assetPath)) : node.stack;
    if (!stack) {
      const id = anchored(entry.layer.id, item.assetPath);
      return issue('missing-layer', `could not open layer ${id}`);
    }
    let target = stripVariants(item.primPath);
    if (!target) {
      const name = stack.root.specs['/']?.fields.defaultPrim;
      if (typeof name !== 'string' || !name)
        return issue('missing-default-prim', `${stack.id} has no defaultPrim for ${node.path}`);
      target = name.startsWith('/') ? name : '/' + name;
    }
    if (!item.assetPath && target === stripVariants(node.path)) return issue('cycle', `${node.path} references itself`);
    const far = codesPerSecond(stack.root),
      near = codesPerSecond(entry.layer),
      internal = !item.assetPath,
      own = checked({ offset: item.offset, scale: item.scale }, target),
      // Within one stack each layer's own offset already places its opinions.
      time = internal ? own : after(entry.offset, checked(after(own, { offset: 0, scale: near / far }), target));
    const placed = place(
      node,
      stack,
      target,
      kind,
      depth,
      order,
      [{ from: target, to: stripVariants(node.path), open: internal }, ...node.steps],
      after(node.offset, time),
      'reference',
    );
    if (!placed) return;
    placed.intro = depthOf(node.path);
    attach(node, placed);
    queuePlaced(placed, true);
  }
  function placeClass(
    node: Node,
    depth: number,
    kind: 'inherit' | 'specialize',
    target: string,
    order: number,
    implied = false,
    also?: [string, string][],
    stands?: Node,
  ) {
    const path = stripVariants(target);
    if (under(stripVariants(node.path), path) || under(path, stripVariants(node.path))) return undefined;
    // One node holds a class site once: the arc that reached it first keeps it.
    let held = node.children.find((c) => c.stack === node.stack && stripVariants(c.path) === path);
    const pb = build!;
    const fresh = !stands || !carriedFrom.has(ownerOf(stands));
    if (held && pb.pending?.has(held) && !stays(held) && !fresh) {
      const other = pb.held.get(siteKey(held));
      if (implied && stands && held.of === stands && held.kind === kind && !other) {
        pb.pending.delete(held);
        pb.held.set(siteKey(held), held);
        return held;
      }
      dropPending(pb, held);
      held = undefined;
    }
    if (held) {
      if (kind === 'specialize' && !implied && held.kind === 'inherit') held.shadow = true;
      return held;
    }
    const steps = [
      { from: path, to: stripVariants(node.path), open: true, ...(also?.length ? { also } : {}) },
      ...node.steps,
    ];
    const b = build!,
      stub = (family?: object): Node => {
        const out: Node = {
          stack: node.stack,
          path,
          kind,
          depth,
          order,
          steps,
          offset: node.offset,
          children: [],
          settled: new Set(),
          born: ++births,
          inert: true,
          intro: depthOf(node.path),
          ...(implied ? { implied } : {}),
          ...(family ? { family } : {}),
        };
        attach(node, out);
        return out;
      };
    // Seen on OpenUSD (black-box prim indexes, KB1942c), the specification does not say: the first live node made for a
    // site holds it in the index. A later inherit to it makes no node; a later specializes leaves an inert placeholder,
    // which still implies its arc upward unless it was itself implied.
    if (
      b.held.has(node.stack.id + '\0' + path) ||
      [...(b.pending ?? [])].some(
        (p) => (fresh || stays(p)) && p.stack === node.stack && stripVariants(p.path) === path,
      )
    ) {
      if (kind === 'inherit') return undefined;
      const placeholder = stub();
      if (!implied) queue(placeholder, false);
      return undefined;
    }
    // Seen on OpenUSD (black-box prim indexes, KB1942c): a specializes arc below the index root leaves an inert
    // placeholder where it was authored, which implies its arc upward, and its node goes under the index root.
    if (kind === 'specialize' && !implied && node !== b.top) {
      const placeholder = stub({});
      const real = place(node, node.stack, path, kind, depth, order, steps, node.offset, 'class');
      if (real) {
        real.intro = placeholder.intro;
        real.family = placeholder.family;
        real.stub = placeholder;
        realOf.set(placeholder, real);
        attach(b.top, real);
        queuePlaced(real, false);
      }
      queue(placeholder, false);
      return undefined;
    }
    const placed = place(node, node.stack, path, kind, depth, order, steps, node.offset, 'class');
    if (!placed) return undefined;
    placed.implied = implied;
    placed.intro = depthOf(node.path);
    if (implied && stands) placed.of = stands;
    if (stands) ancestral(placed, node, stands);
    attach(node, placed);
    if (build!.pending && !fresh)
      for (const p of [...build!.pending])
        if (!stays(p) && build!.pending.has(p) && p !== placed && siteKey(p) === siteKey(placed))
          dropPending(build!, p);
    queuePlaced(placed, !implied);
    return placed;
  }
  /**
   * Seen on OpenUSD (black-box prim indexes, KB1942c), the specification does not say: an implied class arc that stands
   * for an arc carried down from an ancestor prim A sets its ancestral variants with the selections of A in context, then
   * its own. A maps into the stack it joins where the arcs on the way can and is taken as authored where they cannot.
   * Below the index root, A's context is the site that authored the arc into that stack, at the path A maps to there,
   * and the nodes of other stacks in the index of the stage prim A maps to. At the index root it is A's own index there,
   * when that stack holds the layer that authored the arc; the node that stands for this same arc there does not count.
   */
  function ancestral(placed: Node, near: Node, arc: Node) {
    const step = arc.steps[0],
      site = stripVariants(arc.path),
      b = build!;
    // Seen on OpenUSD (black-box prim indexes, KB1942c): an implied inherit that stands for an implied arc, the chain
    // ending in an arc carried down from prim A, reads the selections at its class's parent in each other stack of
    // that chain, nearest first.
    let origin = arc;
    while (origin.implied && origin.of) origin = origin.of;
    if (!step || !arc.parent) return;
    const chain = arc.kind === 'inherit' && !!arc.implied && !arc.anc && !!origin.anc && !origin.implied;
    if (!chain && (!arc.anc || arc.implied || !under(site, step.from) || site === step.from)) return;
    const hop = arc.parent.steps.slice(0, Math.max(0, arc.parent.steps.length - near.steps.length)),
      authored = mapPath(hop, step.to) ?? step.to,
      counterpart = (n: Node) => n.kind === arc.kind && n.stack === near.stack && stripVariants(n.path) === site,
      open = (stack: Stack, path: string) =>
        !building.has(stack.id + '\0' + path) && !building.has(stack.id + '\0' + path + '\0v');
    const ctx: Node[] = [];
    if (chain) {
      for (let n: Node | undefined = arc; n; n = n.implied ? n.of : undefined)
        if (n.stack !== near.stack) ctx.push({ ...n, path: parentOf(n.path) });
    } else if (near.parent) {
      let into = near;
      while (into.parent && into.parent.stack === into.stack) into = into.parent;
      const by = into.parent,
        inner = mapPath(near.steps.slice(0, near.steps.length - into.steps.length), authored) ?? authored,
        there = by && into.steps.length ? mapPath([into.steps[0]], inner) : undefined;
      if (by && there !== undefined)
        ctx.push({
          ...by,
          path: by.path
            .split('/')
            .slice(0, depthOf(there) + 1)
            .join('/'),
        });
      const up = mapPath(near.steps, authored);
      if (up !== undefined && open(b.top.stack, up))
        for (const n of strength(tree(b.top.stack, up, true)))
          if (n.stack !== by?.stack && !counterpart(n)) ctx.push(n);
    } else if (near.stack.layers.some((e) => e.layer === arc.stack.root) && open(near.stack, authored))
      for (const n of strength(tree(near.stack, authored, true))) if (!counterpart(n)) ctx.push(n);
    const parent = parentOf(site);
    if (!ctx.length || !open(near.stack, parent)) return;
    // The class site's parent composed with those selections first: its variants, carried down to the site.
    const from = tree(near.stack, parent, true, ctx),
      name = site.slice(site.lastIndexOf('/') + 1),
      made: [Node, Node][] = [];
    const copy = (n: Node): Node => {
      const out: Node = {
        ...n,
        path: child(n.path, name),
        anc: true,
        children: [],
        parent: undefined,
        settled: new Set(n.settled),
        steps: [...n.steps, ...placed.steps],
        offset: after(placed.offset, n.offset),
        born: ++births,
        reached: undefined,
      };
      made.push([n, out]);
      for (const c of n.children) {
        const k = copy(c);
        k.parent = out;
        out.children.push(k);
      }
      return out;
    };
    const variants = from.children.filter((c) => c.kind === 'variant').map(copy);
    restub(made);
    placed.children = placed.children.filter((c) => c.kind !== 'variant' || !c.anc);
    for (const v of variants) attach(placed, v);
  }
  /**
   * The specializes task of a grafted specializes node: as one authored here, it moves under the index root. Seen on
   * OpenUSD (black-box prim indexes, KB1942c): one carried down from an ancestor of a deeper site is that site composed
   * alone, so an ancestral variant stays only when the class's own sites select it.
   */
  function promote(s: Node) {
    const b = build!,
      real: Node = { ...s, parent: undefined, children: s.children, family: (s.family ??= {}), stub: s.stub ?? s };
    s.inert = true;
    s.children = [];
    const path = stripVariants(s.path),
      key = s.stack.id + '\0' + path;
    if (s.anc && depthOf(path) > 1 && !building.has(key) && !building.has(key + '\0v'))
      real.children = graft(tree(s.stack, path, false), s.kind, s.depth, s.order, s.steps, s.offset).children;
    realOf.set(s, real);
    for (const c of real.children) c.parent = real;
    if (!b.held.has(siteKey(s))) {
      attach(b.top, real);
      settleGraft(real, false);
    } else if (!s.stub) blocked.add(s);
    queue(s, false);
  }
  /** Follows the arcs of one kind authored at `node`. */
  function expand(node: Node, depth: number, kind: Kind) {
    if (kind === 'specialize' && promoted.delete(node)) return promote(node);
    const { stack, path } = node;
    if (!stack.layers.some((entry) => specAt(entry, path))) return;
    if (kind === 'reference' || kind === 'payload') {
      // Strength Ordering, namespace depth, read as PcpNodeRef's namespace depth (the depth of the node that introduced
      // the arc): a reference or payload ranks by the depth of its prim in the node's own stack, so one authored inside
      // a referenced prim compares with the arcs that reference carries in the same namespace. Seen on OpenUSD
      // (black-box stages, KB1942c); class arcs keep the prim's depth on the stage.
      if (kind === 'reference' || options.payloads !== false)
        listed<ArcItem>(stack, path, kind === 'payload' ? kind : 'references', arcKey).forEach(({ item, entry }, i) =>
          placeReference(node, depthOf(stripVariants(path)), kind, item, entry, i),
        );
    } else
      listed<string>(stack, path, kind === 'inherit' ? 'inheritPaths' : 'specializes').forEach(({ item }, i) =>
        placeClass(node, depth, kind, item, i),
      );
  }
  /**
   * Seen on OpenUSD (black-box stages, KB1942 and KB1942c); the specification does not say. In one specializes family
   * each implied arc ranks against the authored arc by the outermost reference or payload around the authored arc's
   * node, counted up to the node the implied arc hangs from: the authored arc comes first when that reference was
   * authored on a prim deeper than the one that holds the arc (a reference in a variant counts from the variant's prim,
   * and the node the implied arc hangs from, when it is that reference, from the prim that authored it). The implied
   * arcs on each side keep the order of the stacks that hold them, strongest first. An authored arc in a variant first
   * implies a placeholder on the node that holds the variant, in the same stack, and the arcs it implies upward rank
   * against that placeholder in the same way: within a side, that ranking comes before the stacks' order. An implied arc
   * that hangs from a variant held by a node of the same stack implies a placeholder there too, and the arcs implied
   * above it rank against it in the same way, after the ranking against the authored arc's placeholder. Then each
   * implied arc ranks against the one implied into the root stack: before it when the node it hangs from has a smaller
   * namespace depth than the node the root stack's arc was implied from (above that node's variants in its own stack).
   * Last, the implied arcs order by the namespace depth of the node each hangs from, smaller first, and on a tie by the
   * order of the stacks that hold them.
   */
  const familyKey = (node: Node, stop: Node): number => {
    if (node.kind !== 'variant' && node.kind !== 'reference' && node.kind !== 'payload') return -1;
    let outer: Node | undefined;
    for (let up = node.parent; up; up = up.parent) {
      if (up.kind === 'reference' || up.kind === 'payload') outer = up;
      if (up === stop) break;
    }
    const inner = node.intro ?? node.depth;
    if (!outer) return -1;
    if (outer === stop) return (outer.intro ?? outer.depth) > inner ? 1 : -1;
    const from = outer.parent?.kind === 'variant' ? outer.parent.depth : outer.depth;
    return from > inner ? 1 : -1;
  };
  type Member = { arc: Node; at: Node; level: number; nodes: Node[] };
  /** The node itself, or above it the first node that is not one of its variants in its own stack. */
  const holderOf = (n?: Node) => {
    while (n?.kind === 'variant' && n.parent?.stack === n.stack) n = n.parent;
    return n;
  };
  const familyOrder = (members: Member[], top: Node): Member[] => {
    const own = members.find((m) => !m.arc.implied);
    // The node the placeholder hangs from: above the authored arc's variants in its own stack.
    const held = holderOf(own?.at);
    const side = (m: Member, from = own?.at) => (from && m.arc.implied ? -familyKey(from, m.at) : 0);
    // An implied arc at a variant held in the same stack: the arcs implied above it rank against it.
    const anchor = members.find((m) => m.arc.implied && holderOf(m.at) !== m.at);
    const above = (m: Member) => {
      if (!anchor || m === anchor) return 0;
      for (let up = anchor.at.parent; up; up = up.parent) if (up === m.at) return -familyKey(anchor.at, m.at);
      return 0;
    };
    // The family's arc in the root stack, and the node of the arc it stands for, above that node's same-stack variants.
    const R = members.find((m) => m.arc.implied && m.at.stack === top.stack),
      S = R && (R.at === top ? holderOf(R.arc.of?.parent) : R.at);
    const rk = (m: Member) => (!S || m === R || !m.arc.implied ? 0 : m.at.depth < S.depth ? 1 : -1);
    return members.sort(
      (x, y) =>
        side(y) - side(x) ||
        side(y, held) - side(x, held) ||
        above(y) - above(x) ||
        rk(y) - rk(x) ||
        x.at.depth - y.at.depth ||
        x.level - y.level,
    );
  };
  /** Every node, strongest first; specializes come after everything else. */
  function strength(top: Node): Node[] {
    const siteOf = (node: Node) => node.stack.id + '\0' + node.path;
    // Where each node sits in the tree, placeholders included: a specializes node under the root ranks from its own.
    const pos = new Map<Node, number>();
    const number = (n: Node) => {
      pos.set(n, pos.size);
      n.children.forEach(number);
    };
    number(top);
    const order = (holder?: Map<string, number>): Node[] => {
      const out: Node[] = [],
        groups = new Map<
          object,
          { depth: number; rank: number; members: { arc: Node; at: Node; level: number; nodes: Node[] }[] }
        >();
      const walk = (node: Node, list: Node[], level: number) => {
        if (holder && throughClass(node) && node.born !== holder.get(siteOf(node))) return;
        if (!node.inert) list.push(node);
        for (const c of node.children) {
          if (c.kind === 'specialize') {
            const nodes: Node[] = [],
              family = c.family ?? c;
            let group = groups.get(family);
            if (!group) groups.set(family, (group = { depth: c.reached ?? c.depth, rank: Infinity, members: [] }));
            // Strength Ordering, Specializes: an arc ranks by how it came in, the opinions it implies go with it.
            if (!c.implied) {
              group.depth = c.reached ?? c.depth;
              group.rank = pos.get(c.stub ?? c)!;
            }
            // A specializes node moved under the root ranks in its family from the placeholder it left.
            let at = node,
              from = level;
            if (c.stub?.parent) {
              at = c.stub.parent;
              from = 0;
              for (let up = at; up.parent; up = up.parent) from++;
            }
            group.members.push({ arc: c, at, level: from, nodes });
            walk(c, nodes, level + 1);
          } else walk(c, list, level + 1);
        }
      };
      walk(top, out, 0);
      for (const group of [...groups.values()].sort((a, b) => b.depth - a.depth || a.rank - b.rank))
        for (const item of familyOrder(group.members, top)) out.push(...item.nodes);
      return out;
    };
    // Seen on OpenUSD (black-box prim indexes, KB1942c), the specification does not say: of the nodes for one site, the
    // first made holds it, and a later one reached through a class arc gives no opinions. A site carried down from the
    // parent prim was made with the parent's index, so it holds against an arc placed for this prim.
    const holder = new Map<string, number>();
    for (const node of order()) {
      const site = siteOf(node),
        h = holder.get(site);
      if (h === undefined || node.born < h) holder.set(site, node.born);
    }
    return order(holder);
  }
  /** Settles the strongest unsettled variant set: its selection from the strongest opinion, then the variant's arcs. */
  function settleVariant(top: Node, primPath: string, atRoot: boolean): boolean {
    const nodes = strength(top);
    let found: { node: Node; set: string; order: number } | undefined;
    search: for (const node of nodes) {
      const sets = listed<string>(node.stack, node.path, 'variantSetNames');
      for (let i = 0; i < sets.length; i++)
        if (!node.settled.has(sets[i].item)) {
          found = { node, set: sets[i].item, order: i };
          break search;
        }
    }
    if (!found) return false;
    const { node, set, order } = found;
    node.settled.add(set);
    let selection: string | undefined = atRoot ? options.variants?.[primPath]?.[set] : undefined;
    if (selection === undefined)
      search: for (const n of [...(build!.ctx ?? []), ...nodes])
        for (const entry of n.stack.layers) {
          const choices = specAt(entry, n.path)?.fields.variantSelection as Record<string, string> | undefined;
          const value = choices?.[set];
          if (typeof value === 'string') {
            selection = value;
            break search;
          }
        }
    if (!selection) return true;
    const path = `${node.path}{${set}=${selection}}`;
    if (!node.stack.layers.some((entry) => specAt(entry, path))) return true;
    // Strength Ordering, namespace depth: a variant set ranks by the depth of the prim that holds it in its own
    // stack, so a set on the site itself beats one carried down from a parent of the site.
    const local = depthOf(node.path);
    const variant: Node = {
      stack: node.stack,
      path,
      kind: 'variant',
      depth: local,
      order,
      steps: node.steps,
      offset: node.offset,
      children: [],
      settled: new Set(),
      intro: local,
      born: ++births,
    };
    attach(node, variant);
    queue(variant, true);
    return true;
  }
  /**
   * Core Specification, Composition Arcs, Inherits: an authored class arc implies one in every upstream layer stack that
   * brought its stack in, on the prim that brought it, at the arc's path through the namespace mappings on the way. A hop
   * inside one stack that leaves the path as it was would name the site already held, so the mapping just goes on upward.
   */
  function implied(start: Node, depth: number) {
    /** `path`, authored at `site`, as the prim that first leads into another stack names it, with that prim's node. */
    const upstream = (site: Node, path: string): [Node, string] | undefined => {
      let at = site,
        out = path;
      while (at.parent) {
        const near = at.parent,
          step = at.steps[at.steps.length - near.steps.length - 1];
        const before = out;
        if (step && under(out, step.from)) out = step.to + out.slice(step.from.length);
        if (near.stack !== at.stack || out !== before) return [near, out];
        // Seen on OpenUSD (black-box stages, KB1942c), the specification does not say: a node of the same stack on the way
        // up that already holds the site stops the implied arc there.
        if (near.children.some((c) => c !== at && c.stack === near.stack && stripVariants(c.path) === out))
          return undefined;
        at = near;
      }
      return undefined;
    };
    /**
     * The pairs an implied arc keeps from the arc it stands for. Seen on OpenUSD (KB1942b): when the authored arc
     * reaches its prim through an ancestor's class arc, the ancestor's pair goes up with it, its prim mapped by the arcs
     * on the way where they can and left as authored where they cannot. A target under the class root then maps to the
     * ancestor's path, and one under the ancestor, which mapping back would not give again, drops. The arc it stands for
     * may itself be implied, carried down from an ancestor prim: its own pair goes up the same way (KB1942c part 25).
     */
    const carried = (near: Node, arc: Node): [string, string][] => {
      const step = arc.steps[0];
      if (!step || !arc.parent) return [];
      const hop = arc.parent.steps.slice(0, Math.max(0, arc.parent.steps.length - near.steps.length)),
        up = ([from, to]: [string, string]): [string, string] => [from, mapPath(hop, to) ?? to];
      const own = (step.also ?? []).map(up);
      // The first step of a site reached through an ancestor's class arc is that ancestor's pair.
      if (stripVariants(arc.parent.path) === step.to) return own;
      return [...own, up([step.from, step.to])];
    };
    /** Places arc on near and on every stack above it, and the same for the class arcs that class has in turn. */
    const lift = (near: Node, arc: Node, path: string) => {
      const kind = arc.kind as 'inherit' | 'specialize',
        placed = placeClass(near, depth, kind, path, near.children.length, true, carried(near, arc), arc);
      if (!placed) return;
      // Seen on OpenUSD (black-box prim indexes, KB1942c part 26), the specification does not say: an implied arc that
      // reaches a placeholder which itself implies nothing (its site held by an inherit of its stack) stops there.
      if (placed.inert && !blocked.has(placed) && inert(placed) && !near.children.some(active)) return;
      arc.family ??= {};
      if (placed.implied) {
        placed.of ??= arc;
        placed.family ??= arc.family;
        placed.source ??= arc.implied ? arc.source : arc.intro;
      }
      // A placeholder's class arcs are those of the node it left under the root.
      for (const c of (realOf.get(arc) ?? arc).children) if (isClass(c)) lift(placed, c, stripVariants(c.path));
      const up = upstream(near, path);
      if (up) lift(up[0], placed, up[1]);
    };
    const node = start.parent!,
      c = start;
    // A specializes arc whose site an inherit in the same stack reaches too, in this tree, is the later of the two.
    const inherited = new Set<string>();
    const note = (n: Node) => {
      if (n.kind === 'inherit') inherited.add(n.stack.id + '\0' + stripVariants(n.path));
      n.children.forEach(note);
    };
    note(build!.top);
    const inert = (x: Node) => x.kind === 'specialize' && inherited.has(x.stack.id + '\0' + stripVariants(x.path));
    /** A class arc placed for this prim, not carried down from the parent prim, that is not such a later specializes. */
    const active = (x: Node) => isClass(x) && !x.anc && !inert(x);
    // Seen on OpenUSD (black-box stages, KB1942c), the specification does not say: such a later specializes arc
    // implies nothing upstream unless another class arc of its node is active.
    if (!blocked.has(c) && inert(c) && !node.children.some(active)) return;
    const up = upstream(node, stripVariants(c.path));
    if (up) lift(up[0], c, up[1]);
  }

  const rootStack = stackOf(rootId)!;
  if (!rootStack) throw new TypeError('USD root layer missing; pass a layer function that returns the root file.');

  const out: Specs = Object.create(null);
  const rootFields = rootStack.root.specs['/']?.fields ?? {};
  out['/'] = { specType: 7, fields: { ...rootFields } };
  let count = 0;

  const value = (v: unknown, type: unknown, entry: StackLayer): unknown => {
    if (type === 'asset' && typeof v === 'string' && v) return anchored(entry.layer.id, v);
    if (type === 'asset[]' && Array.isArray(v)) return v.map((item) => (item ? anchored(entry.layer.id, item) : item));
    return v;
  };
  function propertyOf(path: string, name: string, nodes: Node[]) {
    const fields: Record<string, unknown> = Object.create(null);
    let specType = 1,
      settled = false,
      haveDefault = false;
    if (options.trackValueSources)
      fields._margoValueSources = nodes.flatMap((node) => node.stack.layers.map((entry) => entry.layer.id));
    const targets: { field: string; op: ListOp<string> | string[]; node: Node }[] = [];
    for (const node of nodes)
      for (const entry of node.stack.layers) {
        const spec = specAt(entry, node.path + '.' + name);
        if (!spec) continue;
        specType = spec.specType;
        const own = spec.fields;
        for (const key in own) {
          if (key === 'default' || key === 'timeSamples' || key === 'connectionPaths' || key === 'targetPaths')
            continue;
          if (!(key in fields)) fields[key] = own[key];
        }
        const type = fields.typeName;
        if (!settled) {
          if ((own.timeSamples as TimeSamples | undefined)?.times.length) {
            if (options.trackValueSources) fields._margoValueLayer = entry.layer.id;
            const samples = own.timeSamples as TimeSamples,
              time = after(node.offset, entry.offset),
              order = samples.times.map((t, i) => [time.scale * t + time.offset, i]).sort((a, b) => a[0] - b[0]);
            fields.timeSamples = {
              times: order.map(([t]) => t),
              values: order.map(([, i]) => value(samples.values[i], type, entry)),
            };
            settled = true;
          } else if (own.default !== undefined) {
            settled = true;
            if (options.trackValueSources) fields._margoValueLayer = entry.layer.id;
          }
        }
        if (!haveDefault && own.default !== undefined) {
          haveDefault = true;
          if (own.default !== null) fields.default = value(own.default, type, entry);
        }
        for (const field of ['connectionPaths', 'targetPaths'])
          if (own[field] !== undefined) targets.push({ field, op: own[field] as ListOp<string>, node });
      }
    // List edits: weakest first, each path taken to the stage's namespace.
    const lists: Record<string, string[]> = {};
    for (let i = targets.length - 1; i >= 0; i--) {
      const { field, op, node } = targets[i],
        through = (items?: string[]) =>
          items?.flatMap((item) => {
            const mapped = mapPath(node.steps, item);
            return mapped === undefined ? [] : [mapped];
          });
      const edit = Array.isArray(op)
        ? { explicit: through(op) }
        : {
            explicit: through(op.explicit),
            add: through(op.add),
            prepend: through(op.prepend),
            append: through(op.append),
            delete: through(op.delete),
            order: through(op.order),
          };
      lists[field] = apply(lists[field] ?? [], edit);
    }
    Object.assign(fields, lists);
    out[path + '.' + name] = { specType, fields };
  }
  function prim(path: string, top: Node): void {
    if (++count > maxPrims) throw new RangeError('USD stage has too many prims; raise maxPrims or leave payloads out.');
    options.signal?.throwIfAborted();
    const nodes = strength(top),
      fields: Record<string, unknown> = Object.create(null);
    const props = new Set<string>(),
      names = new Set<string>();
    const clipOrders: (ListOp<string> | string[])[] = [];
    for (const node of nodes)
      for (const entry of node.stack.layers) {
        const spec = specAt(entry, node.path);
        if (spec)
          for (const key in spec.fields) {
            if (options.trackValueSources && key === 'clipSets') {
              clipOrders.unshift(spec.fields[key] as ListOp<string>);
              continue;
            }
            if (options.trackValueSources && key === 'clips') {
              const out = (fields.clips ??= Object.create(null)) as Record<string, Record<string, unknown>>,
                time = after(node.offset, entry.offset);
              for (const [setName, definition] of Object.entries(
                spec.fields.clips as Record<string, Record<string, unknown>>,
              )) {
                const target = (out[setName] ??= Object.create(null));
                for (const [name, value] of Object.entries(definition))
                  if (!(name in target)) {
                    if (name.startsWith('_margo')) continue;
                    const asset = (v: unknown) => (typeof v === 'string' ? v : (v as { assetPath: string }).assetPath);
                    const flatPairs = (v: unknown): number[][] => {
                      const list = v as number[] | number[][];
                      return Array.isArray(list[0])
                        ? (list as number[][])
                        : Array.from({ length: list.length / 2 }, (_, i) => [
                            (list as number[])[i * 2],
                            (list as number[])[i * 2 + 1],
                          ]);
                    };
                    target[name] =
                      name === 'assetPaths'
                        ? (value as unknown[]).map((v) => anchored(entry.layer.id, asset(v)))
                        : name === 'manifestAssetPath' || name === 'templateAssetPath'
                          ? anchored(entry.layer.id, asset(value))
                          : name === 'active' || name === 'times'
                            ? flatPairs(value).map(([a, b]) => [a * time.scale + time.offset, b])
                            : value;
                    if (name === 'assetPaths' || (name === 'templateAssetPath' && !target._margoAnchor)) {
                      target._margoAnchor = entry.layer.id;
                      target._margoOffset = time;
                    }
                  }
              }
              continue;
            }
            if (key in fields) continue;
            if (key === 'specifier' || key === 'typeName') {
              if (spec.fields[key] === '') continue;
            }
            fields[key] = spec.fields[key];
          }
        for (const name of entry.layer.properties.get(node.path) ?? []) props.add(name);
        for (const name of entry.layer.children.get(node.path) ?? []) names.add(name);
      }
    fields.specifier = definition(nodes, path);
    if (clipOrders.length) fields.clipSets = clipOrders.reduce<string[]>((out, op) => apply(out, op), []);
    if (fields.specifier !== 0 || fields.active === false) return;
    out[path] = { specType: 6, fields };
    for (const name of props) propertyOf(path, name, nodes);
    for (const name of names) prim(child(path, name), site(child(path, name)));
  }
  const throughClass = (node: Node): boolean => isClass(node) || (!!node.parent && throughClass(node.parent));
  const throughSpecializes = (node: Node): boolean =>
    node.kind === 'specialize' || (!!node.parent && throughSpecializes(node.parent));
  /** `def` wins over `over`; a class stays a class. */
  function definition(nodes: Node[], _path: string): number {
    let inherited = false;
    for (const node of nodes)
      for (const entry of node.stack.layers) {
        const value = specAt(entry, node.path)?.fields.specifier;
        // A class reached by an inherit gives way to any `def` weaker than it; the prim's own class does not. Seen on
        // OpenUSD (black-box stages, KB1942c), the specification does not say: neither does a class reached through a
        // specializes arc, even before a `def` that a weaker specializes arc brings.
        if (value === 0) return 0;
        if (value === 2) {
          if (!throughClass(node) || throughSpecializes(node)) return 2;
          inherited = true;
        }
      }
    return inherited ? 2 : 1;
  }
  function site(path: string): Node {
    const key = rootStack.id + '\0' + path + '\0v';
    const known = trees.get(key);
    if (known) return known;
    return tree(rootStack, path, true);
  }
  // A root prim named by several layers is composed once; one whose index an arc already built is still composed.
  const tops = new Set<string>();
  for (const entry of rootStack.layers)
    for (const name of entry.layer.children.get('/') ?? [])
      if (!tops.has(name)) {
        tops.add(name);
        prim('/' + name, site('/' + name));
      }
  return { specs: out, layers: [...layers.keys()].filter((id) => layers.get(id)) };
}
/** Every node of a tree, in tree order. */
function allNodes(top: Node): Node[] {
  const out: Node[] = [];
  const walk = (n: Node) => {
    out.push(n);
    n.children.forEach(walk);
  };
  walk(top);
  return out;
}
