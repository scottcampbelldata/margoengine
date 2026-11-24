// The cutting-plane search of Wei, Liu, Ling and Su 2022 (arXiv 2205.02961), section 6: Monte Carlo tree search over
// axis-aligned candidate planes (Algorithm 2), scored by Rv over a fixed number of cuts (Eq. 9), then the first plane
// refined by ternary search (section 6.5).
import { root } from '../next/hull.js';
import { cut, logarithm, type Plane, type Random, type Solid } from './mesh.js';

/** The plane id trial cuts tag their caps with; only a kept cut takes a real one. */
const TRIAL = 0x3fffffff;
/** A side under this volume (of the unit-sized mesh) is a sliver, never kept. */
const SLIVER = 1e-9;

export interface SearchSettings {
  /** m: candidate planes per axis. */
  planes: number;
  /** I: tree search iterations. */
  iterations: number;
  /** d: cuts looked ahead. */
  depth: number;
  random: Random;
  /** Throws once the time limit has passed. */
  check: () => void;
}

/** A cut into two parts that both have a hull, or null. */
function split(part: Solid, plane: Plane): [Solid, Solid] | null {
  const parts = cut(part, plane, TRIAL);
  if (!parts || parts[0].volume <= SLIVER || parts[1].volume <= SLIVER || !parts[0].hull() || !parts[1].hull()) return null;
  return parts;
}

const axisPlane = (axis: number, offset: number): Plane => ({
  normal: [axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0],
  offset,
});

/** The part with the largest Rv: the one each step cuts. */
function worst(parts: readonly Solid[]): number {
  let best = 0;
  for (let i = 1; i < parts.length; i++) if (parts[i].rv() > parts[best].rv()) best = i;
  return best;
}

/** One state of the search: a set of parts, after the cuts on the path to it. */
class Node {
  readonly children: Node[] = [];
  readonly target: number;
  /** Max Rv over the parts after each cut on the path, the terms of Eq. 9. */
  readonly maxima: number[];
  untried: Plane[] | null = null;
  visits = 0;
  value = -Infinity;
  /** The planes of the best playout through this node, from the root. */
  best: Plane[] = [];
  constructor(
    readonly parts: Solid[],
    readonly plane: Plane | null,
    readonly parent: Node | null,
    readonly depth: number,
  ) {
    this.target = worst(parts);
    this.maxima = parent ? [...parent.maxima, parts[this.target].rv()] : [];
  }
  planes(): Plane[] {
    const out: Plane[] = [];
    for (let node: Node | null = this; node?.plane; node = node.parent) out.unshift(node.plane);
    return out;
  }
}

/** Eq. 9: the mean over the d cuts of the largest concavity left after each, negated; a path that ran out keeps its last. */
function quality(maxima: readonly number[], depth: number): number {
  let sum = 0;
  for (let i = 0; i < depth; i++) sum += maxima.length ? maxima[i < maxima.length ? i : maxima.length - 1] : 0;
  return -sum / depth;
}

/** The m candidates per axis, equally spaced inside the part's bounds (section 6.1). */
function candidates(part: Solid, m: number): Plane[] {
  const out: Plane[] = [];
  for (let axis = 0; axis < 3; axis++)
    for (let j = 1; j <= m; j++) out.push(axisPlane(axis, part.min[axis] + (j / (m + 1)) * (part.max[axis] - part.min[axis])));
  return out;
}

/** TreePolicy (Algorithm 2, lines 10 to 22): down by UCB (Eq. 8) to a node with untried planes, then one new child. */
function treePolicy(top: Node, settings: SearchSettings, exploration: number): Node {
  let node = top;
  while (node.depth < settings.depth && node.parts[node.target].rv() > 0) {
    if (!node.untried) {
      // Shuffled once, so taking the last is a random untried plane (Fisher and Yates).
      const list = candidates(node.parts[node.target], settings.planes);
      for (let i = list.length - 1; i > 0; i--) {
        const j = (settings.random() * (i + 1)) | 0;
        [list[i], list[j]] = [list[j], list[i]];
      }
      node.untried = list;
    }
    while (node.untried.length) {
      const plane = node.untried.pop()!,
        halves = split(node.parts[node.target], plane);
      if (!halves) continue;
      const parts = [...node.parts];
      parts.splice(node.target, 1, halves[0], halves[1]);
      const child = new Node(parts, plane, node, node.depth + 1);
      node.children.push(child);
      return child;
    }
    if (!node.children.length) return node;
    let pick = node.children[0],
      score = -Infinity;
    const spread = 2 * logarithm(node.visits);
    for (const child of node.children) {
      const ucb = child.value + exploration * root(spread / child.visits);
      if (ucb > score) {
        score = ucb;
        pick = child;
      }
    }
    node = pick;
  }
  return node;
}

/** Each part's greedy cut, kept: it takes no random numbers, so a part shared by many playouts is cut once. */
const greedy = new WeakMap<Solid, { plane: Plane; halves: [Solid, Solid] } | null>();

/** One greedy cut (Algorithm 2, lines 27 to 32): the largest-Rv part through its middle along the axis that helps most. */
function greedyCut(parts: Solid[]): Plane | null {
  const target = worst(parts),
    part = parts[target];
  let kept = greedy.get(part);
  if (kept === undefined) greedy.set(part, (kept = middleCut(part)));
  if (kept) parts.splice(target, 1, kept.halves[0], kept.halves[1]);
  return kept ? kept.plane : null;
}

function middleCut(part: Solid): { plane: Plane; halves: [Solid, Solid] } | null {
  let best: [Solid, Solid] | null = null,
    plane: Plane | null = null,
    gain = -Infinity;
  for (let axis = 0; axis < 3; axis++) {
    const trial = axisPlane(axis, (part.min[axis] + part.max[axis]) / 2),
      halves = split(part, trial);
    if (!halves) continue;
    const left = halves[0].rv(),
      right = halves[1].rv(),
      reduction = part.rv() - (left > right ? left : right);
    if (reduction > gain) {
      gain = reduction;
      best = halves;
      plane = trial;
    }
  }
  return best && plane ? { plane, halves: best } : null;
}

/** DefaultPolicy (lines 23 to 34): greedy cuts until d + 1 parts, with Eq. 9's terms. */
function playout(node: Node, depth: number): { planes: Plane[]; maxima: number[] } {
  const parts = [...node.parts],
    maxima = [...node.maxima],
    planes = node.planes();
  for (let step = node.depth; step < depth; step++) {
    if (parts[worst(parts)].rv() <= 0) {
      maxima.push(0);
      continue;
    }
    const plane = greedyCut(parts);
    if (!plane) break;
    planes.push(plane);
    maxima.push(parts[worst(parts)].rv());
  }
  return { planes, maxima };
}

/** The score of a path of planes applied in turn, each to the part of largest Rv, for the refinement. */
function pathQuality(part: Solid, path: readonly Plane[], depth: number): number {
  const parts = [part],
    maxima: number[] = [];
  for (const plane of path) {
    const target = worst(parts),
      halves = split(parts[target], plane);
    if (halves) parts.splice(target, 1, halves[0], halves[1]);
    else if (plane === path[0]) return -Infinity;
    maxima.push(parts[worst(parts)].rv());
  }
  return quality(maxima, depth);
}

/**
 * MCTS (Algorithm 2, lines 1 to 9) for one part, then Refine (section 6.5): the best first plane, moved within one
 * candidate gap by ternary search with the rest of its path fixed. `concavity` is the part's own, for c = Concavity / d
 * (appendix D).
 * @returns the plane to cut with, or null when no candidate splits the part.
 */
export function searchPlane(part: Solid, concavity: number, settings: SearchSettings): Plane | null {
  const top = new Node([part], null, null, 0),
    exploration = concavity / settings.depth;
  for (let i = 0; i < settings.iterations; i++) {
    settings.check();
    const leaf = treePolicy(top, settings, exploration);
    if (leaf === top && !top.children.length) return null;
    const { planes, maxima } = playout(leaf, settings.depth),
      score = quality(maxima, settings.depth);
    // Backup (lines 35 to 39): visits, and the best score seen below each node.
    for (let node: Node | null = leaf; node; node = node.parent) {
      node.visits++;
      if (score > node.value) {
        node.value = score;
        node.best = planes;
      }
    }
  }
  let pick = top.children[0];
  for (const child of top.children) if (child.value > pick.value) pick = child;
  const path = pick.best.length ? pick.best : [pick.plane!],
    first = path[0],
    axis = first.normal[0] ? 0 : first.normal[1] ? 1 : 2,
    gap = (part.max[axis] - part.min[axis]) / (settings.planes + 1),
    score = (offset: number): number => pathQuality(part, [axisPlane(axis, offset), ...path.slice(1)], settings.depth);
  let lo = first.offset - gap,
    hi = first.offset + gap;
  for (let round = 0; round < 8; round++) {
    settings.check();
    const a = lo + (hi - lo) / 3,
      b = hi - (hi - lo) / 3;
    if (score(a) < score(b)) lo = a;
    else hi = b;
  }
  const refined = (lo + hi) / 2;
  return score(refined) > score(first.offset) ? axisPlane(axis, refined) : first;
}
