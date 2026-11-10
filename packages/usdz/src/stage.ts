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

/** A path through the steps of a node, or nothing when it has no place in the root namespace. */
function mapPath(steps: Step[], path: string): string | undefined {
  let out = stripVariants(path);
  for (const step of steps) {
    if (under(out, step.from)) out = step.to + out.slice(step.from.length);
    // A path a class arc's own image shadows has no match: mapping back would give another prim.
    else if (!step.open || under(out, step.to)) return undefined;
  }
  return out;
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
function apply<T>(list: T[], op: ListOp<T> | T[] | undefined, key: (item: T) => unknown = (v) => v): T[] {
  if (op === undefined) return list;
  if (Array.isArray(op)) return op.slice();
  if (op.explicit) return op.explicit.slice();
  const drop = new Set([...(op.delete ?? []), ...(op.prepend ?? []), ...(op.append ?? [])].map(key));
  const out = list.filter((item) => !drop.has(key(item)));
  for (const item of op.add ?? []) if (!out.some((v) => key(v) === key(item))) out.push(item);
  out.unshift(...(op.prepend ?? []));
  out.push(...(op.append ?? []));
  if (op.order?.length) {
    const rank = new Map(op.order.map((item, i) => [key(item), i]));
    const listed = out.filter((item) => rank.has(key(item))).sort((a, b) => rank.get(key(a))! - rank.get(key(b))!);
    let next = 0;
    return out.map((item) => (rank.has(key(item)) ? listed[next++] : item));
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

  function attach(parent: Node, node: Node) {
    node.parent = parent;
    parent.children.push(node);
    parent.children.sort(
      (a, b) => ORDER[a.kind] - ORDER[b.kind] || b.depth - a.depth || +!!a.implied - +!!b.implied || a.order - b.order,
    );
  }
  /** A copy of a tree under new steps and a new offset, for a site reached by an arc. */
  function graft(tree: Node, kind: ArcKind, depth: number, order: number, steps: Step[], offset: Offset): Node {
    const families = new Map<object, object>();
    const copy = (node: Node, top: boolean): Node => {
      const out: Node = {
        ...node,
        reached: undefined,
        family: node.family && (families.get(node.family) ?? families.set(node.family, {}).get(node.family)),
        kind: top ? kind : node.kind,
        depth: top ? depth : node.depth,
        order: top ? order : node.order,
        steps: [...node.steps, ...steps],
        offset: after(offset, node.offset),
        children: [],
        parent: undefined,
        settled: new Set(node.settled),
      };
      for (const c of node.children) {
        const k = copy(c, false);
        k.parent = out;
        out.children.push(k);
      }
      return out;
    };
    return copy(tree, true);
  }
  const building = new Set<string>();
  const trees = new Map<string, Node>();
  /** The site tree of `path` in `stack`, its arcs followed, with steps up to that stack's namespace. */
  function tree(stack: Stack, path: string, settle: boolean): Node {
    const key = stack.id + '\0' + path + (settle ? '\0v' : '');
    const known = trees.get(key);
    if (known) return known;
    let root: Node;
    const depth = stripVariants(path).split('/').length - 1;
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
      };
    } else {
      // Arcs of an ancestor reach down: each of its sites has a site of the same name for the child.
      const name = path.slice(path.lastIndexOf('/') + 1),
        above = tree(stack, parentOf(path), true);
      const descend = (node: Node): Node => {
        const out: Node = {
          ...node,
          path: child(node.path, name),
          children: [],
          parent: undefined,
          settled: new Set(),
        };
        for (const c of node.children) {
          const k = descend(c);
          k.parent = out;
          out.children.push(k);
        }
        return out;
      };
      root = descend(above);
    }
    if (building.has(key)) return root;
    building.add(key);
    expandAll(root, root, depth);
    if (settle) {
      implied(root, depth);
      settleVariants(root, depth, stripVariants(path), stack === rootStack);
      if (stack === rootStack) {
        const stamp = (node: Node) => {
          node.reached ??= depth;
          node.children.forEach(stamp);
        };
        stamp(root);
      }
    }
    building.delete(key);
    trees.set(key, root);
    return root;
  }
  /** Follows the arcs authored at each site of `node`'s subtree. */
  function expandAll(top: Node, node: Node, depth: number) {
    for (const c of node.children.slice()) expandAll(top, c, depth);
    expand(top, node, depth);
  }
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
    const key = stack.id + '\0' + target;
    if (building.has(key) || building.has(key + '\0v')) return issue('cycle', `reference cycle at ${target}`);
    const far = codesPerSecond(stack.root),
      near = codesPerSecond(entry.layer),
      internal = !item.assetPath,
      own = checked({ offset: item.offset, scale: item.scale }, target),
      // Within one stack each layer's own offset already places its opinions.
      time = internal ? own : after(entry.offset, checked(after(own, { offset: 0, scale: near / far }), target));
    const site = tree(stack, target, false);
    attach(
      node,
      graft(
        site,
        kind,
        depth,
        order,
        [{ from: target, to: stripVariants(node.path), open: internal }, ...node.steps],
        after(node.offset, time),
      ),
    );
  }
  function placeClass(
    node: Node,
    depth: number,
    kind: 'inherit' | 'specialize',
    target: string,
    order: number,
    implied = false,
  ) {
    const path = stripVariants(target);
    if (under(stripVariants(node.path), path) || under(path, stripVariants(node.path))) return undefined;
    // One node holds a class site once: the arc that reached it first keeps it.
    const held = node.children.find((c) => c.stack === node.stack && stripVariants(c.path) === path);
    if (held) return held;
    const key = node.stack.id + '\0' + path;
    if (building.has(key) || building.has(key + '\0v')) {
      issue('cycle', `class cycle at ${target}`);
      return undefined;
    }
    const site = tree(node.stack, path, false);
    const placed = graft(
      site,
      kind,
      depth,
      order,
      [{ from: path, to: stripVariants(node.path), open: true }, ...node.steps],
      node.offset,
    );
    placed.implied = implied;
    attach(node, placed);
    return placed;
  }
  function expand(top: Node, node: Node, depth: number) {
    const { stack, path } = node;
    if (!stack.layers.some((entry) => specAt(entry, path))) return;
    listed<ArcItem>(stack, path, 'references', arcKey).forEach(({ item, entry }, i) =>
      placeReference(node, depth, 'reference', item, entry, i),
    );
    if (options.payloads !== false)
      listed<ArcItem>(stack, path, 'payload', arcKey).forEach(({ item, entry }, i) =>
        placeReference(node, depth, 'payload', item, entry, i),
      );
    listed<string>(stack, path, 'inheritPaths').forEach(({ item }, i) => placeClass(node, depth, 'inherit', item, i));
    listed<string>(stack, path, 'specializes').forEach(({ item }, i) => placeClass(node, depth, 'specialize', item, i));
    void top;
  }
  /** Every node, strongest first; specializes come after everything else. */
  function strength(top: Node): Node[] {
    const siteOf = (node: Node) => node.stack.id + '\0' + node.path,
      authored = new Set<string>();
    const mark = (node: Node) => {
      if (node.implied) return;
      authored.add(siteOf(node));
      node.children.forEach(mark);
    };
    mark(top);
    const out: Node[] = [],
      groups = new Map<object, { depth: number; rank: number; members: { level: number; nodes: Node[] }[] }>();
    let rank = 0;
    const walk = (node: Node, list: Node[], level: number, inImplied: boolean) => {
      const through = inImplied || !!node.implied;
      // Seen on OpenUSD; the specification does not say: a site an authored arc reaches gives no opinions through an implied arc.
      if (through && authored.has(siteOf(node))) return;
      list.push(node);
      for (const c of node.children) {
        if (c.kind === 'specialize') {
          const nodes: Node[] = [],
            family = c.family ?? c;
          let group = groups.get(family);
          if (!group) groups.set(family, (group = { depth: c.reached ?? c.depth, rank: Infinity, members: [] }));
          // Strength Ordering, Specializes: an arc ranks by how it came in, the opinions it implies go with it.
          if (!c.implied) {
            group.depth = c.reached ?? c.depth;
            group.rank = rank++;
          }
          group.members.push({ level, nodes });
          walk(c, nodes, level + 1, through);
        } else walk(c, list, level + 1, through);
      }
    };
    walk(top, out, 0, false);
    const late = [...groups.values()].sort((a, b) => b.depth - a.depth || a.rank - b.rank);
    const all = [...out],
      seen = new Map<string, number>();
    for (const group of late)
      for (const item of group.members.sort((a, b) => a.level - b.level))
        for (const node of item.nodes) {
          const site = siteOf(node),
            at = seen.get(site);
          // Seen on OpenUSD; the specification does not say: a class site met again counts once, through the later arc.
          if (node.kind === 'specialize' && at !== undefined) {
            all[at] = node;
            continue;
          }
          seen.set(site, all.length);
          all.push(node);
        }
    return all;
  }
  /** Picks each variant set's selection from the strongest opinion in the whole tree, then follows the variant. */
  function settleVariants(top: Node, depth: number, primPath: string, atRoot: boolean) {
    for (let guard = 0; guard < 256; guard++) {
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
      if (!found) return;
      const { node, set, order } = found;
      node.settled.add(set);
      let selection: string | undefined = atRoot ? options.variants?.[primPath]?.[set] : undefined;
      if (selection === undefined)
        search: for (const n of nodes)
          for (const entry of n.stack.layers) {
            const choices = specAt(entry, n.path)?.fields.variantSelection as Record<string, string> | undefined;
            const value = choices?.[set];
            if (typeof value === 'string') {
              selection = value;
              break search;
            }
          }
      if (!selection) continue;
      const path = `${node.path}{${set}=${selection}}`;
      if (!node.stack.layers.some((entry) => specAt(entry, path))) continue;
      const variant: Node = {
        stack: node.stack,
        path,
        kind: 'variant',
        depth,
        order,
        steps: node.steps,
        offset: node.offset,
        children: [],
        settled: new Set(),
      };
      attach(node, variant);
      expand(top, variant, depth);
      implied(top, depth);
    }
  }
  /**
   * Core Specification, Composition Arcs, Inherits: an authored class arc implies one in every upstream layer stack that
   * brought its stack in, on the prim that brought it, at the arc's path through the namespace mappings on the way. A hop
   * inside one stack that leaves the path as it was would name the site already held, so the mapping just goes on upward.
   */
  function implied(top: Node, depth: number) {
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
        at = near;
      }
      return undefined;
    };
    /** Places arc on near and on every stack above it, and the same for the class arcs that class has in turn. */
    const lift = (near: Node, arc: Node, path: string) => {
      const kind = arc.kind as 'inherit' | 'specialize',
        placed = placeClass(near, depth, kind, path, near.children.length, true);
      if (!placed) return;
      arc.family ??= {};
      if (placed.implied) placed.family ??= arc.family;
      for (const c of arc.children)
        if (c.kind === 'inherit' || c.kind === 'specialize') lift(placed, c, stripVariants(c.path));
      const up = upstream(near, path);
      if (up) lift(up[0], placed, up[1]);
    };
    // Strongest first, so implied arcs of equal depth keep the order of the arcs that imply them.
    const visit = (node: Node) => {
      if (node.kind !== 'inherit' && node.kind !== 'specialize')
        for (const c of node.children.slice()) {
          if (c.kind !== 'inherit' && c.kind !== 'specialize') continue;
          const up = upstream(node, stripVariants(c.path));
          if (up) lift(up[0], c, up[1]);
        }
      for (const c of node.children.slice()) visit(c);
    };
    visit(top);
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
  const throughClass = (node: Node): boolean =>
    node.kind === 'inherit' || node.kind === 'specialize' || (!!node.parent && throughClass(node.parent));
  /** `def` wins over `over`; a class stays a class. */
  function definition(nodes: Node[], _path: string): number {
    let inherited = false;
    for (const node of nodes)
      for (const entry of node.stack.layers) {
        const value = specAt(entry, node.path)?.fields.specifier;
        // A class reached by an arc gives way to any `def` weaker than it; the prim's own class does not.
        if (value === 0) return 0;
        if (value === 2) {
          if (!throughClass(node)) return 2;
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
  for (const entry of rootStack.layers)
    for (const name of entry.layer.children.get('/') ?? [])
      if (!trees.has(rootStack.id + '\0/' + name + '\0v')) prim('/' + name, site('/' + name));
  return { specs: out, layers: [...layers.keys()].filter((id) => layers.get(id)) };
}
