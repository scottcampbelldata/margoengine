// The `plan` entry: a sampling planner for when local avoidance stalls. RRT is S. M. LaValle, "Rapidly-exploring random
// trees: a new tool for path planning", TR 98-11, Iowa State University, 1998. RRT-Connect is J. J. Kuffner and S. M.
// LaValle, "RRT-connect: an efficient approach to single-query path planning", ICRA 2000. The roadmap is L. E. Kavraki,
// P. Svestka, J.-C. Latombe and M. H. Overmars, "Probabilistic roadmaps for path planning in high-dimensional
// configuration spaces", IEEE Trans. Robotics and Automation 12(4), 1996. Shortcutting is the random shortcut of R. Geraerts
// and M. H. Overmars, "Creating high-quality paths for motion planning", IJRR 26(8), 2007. Every edge is proved by the
// swept check, not sampled. Written clean room from those publications.
import { rangeError, typeError } from '../../shared/errors.js';
import { JointLimitSolver, type JointLimitTarget } from './limits.js';
import { Robot } from './robot.js';
import { sweepRobot } from './swept.js';
import type { ConstraintVolume, Vec3View } from './types.js';

/** How a planner looks for a path. */
export type PlanAlgorithm = 'rrt-connect' | 'rrt' | 'prm';

/** Settings every planner shares. */
export interface PlanSettings {
  /** Default none. */
  colliders?: readonly ConstraintVolume[];
  /** Gap the whole path keeps from every collider, in scene units. Default 0.01. */
  minClearance?: number;
  /** Also keep the robot's shapes off each other along the path. Default false. */
  selfCollision?: boolean;
  /** Seed of the random numbers: the same seed and scene give the same path. Default 1. */
  seed?: number;
  /** Largest move of a tree edge, as a straight distance in joint space. Roadmap edges have no such limit. Default 0.3. */
  stepSize?: number;
  /** Sets the swept check's `tolerance` on every edge. Default 1e-4. */
  tolerance?: number;
  /** Sets the swept check's `maxSteps` on every edge; an edge that runs out counts as blocked. Default 4,096. */
  maxSteps?: number;
}

/** Options of {@link planPath}. */
export interface PlanOptions extends PlanSettings {
  /** Default `'rrt-connect'`. */
  algorithm?: PlanAlgorithm;
  /** Most random samples tried before giving up. Default 20,000. */
  maxSamples?: number;
  /** Share of samples aimed straight at the goal, on `'rrt'`. Default 0.1. */
  goalBias?: number;
  /** Neighbours each roadmap node tries to join, on `'prm'`. Default 10. */
  neighbors?: number;
  /** Rounds of random shortcutting on the path found. 0 keeps the raw path. Default 100. */
  shortcuts?: number;
  /** Stops the search: the promise rejects with the signal's reason. */
  signal?: AbortSignal;
}

/** Options of {@link planToPose}. */
export interface PoseGoalOptions extends PlanOptions {
  /** The joint carrying the end effector, by index or name. */
  tip: number | string;
  /** The end effector in that joint's frame. Default its origin. */
  point?: Vec3View;
  /** Random restarts of the joint-limit solver, looking for a clear pose at the target. Default 32. */
  goalAttempts?: number;
}

/** Why a plan ended. */
export type PlanStatus = 'found' | 'start-blocked' | 'goal-blocked' | 'no-path';

/** What a planner found. */
export interface PlanResult {
  /** `'no-path'` means the budget ran out, which is no proof that no path exists. */
  status: PlanStatus;
  /** Configurations from start to goal. Each straight joint-space step between two of them passed the swept check. Empty unless found. */
  path: Float64Array[];
  /** Length of the path in joint space. */
  length: number;
  /** Random samples tried. */
  samples: number;
  /** Swept checks of an edge. */
  edgeChecks: number;
}

/** A small seeded generator (mulberry32), so a plan repeats exactly. */
function generator(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function distanceBetween(a: ArrayLike<number>, b: ArrayLike<number>, n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

function pathLength(path: readonly Float64Array[], n: number): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += distanceBetween(path[i - 1], path[i], n);
  return total;
}

/** The scene and the budget. */
class Space {
  readonly dof: number;
  readonly colliders: readonly ConstraintVolume[];
  readonly minClearance: number;
  readonly selfCollision: boolean;
  readonly stepSize: number;
  readonly tolerance: number;
  readonly random: () => number;
  private readonly low: Float64Array;
  private readonly high: Float64Array;
  private readonly sweep: { minClearance: number; tolerance: number; maxSteps: number; selfCollision: boolean };
  samples = 0;
  edgeChecks = 0;

  constructor(
    readonly robot: Robot,
    options: PlanSettings | undefined,
    around: ArrayLike<number> | null,
  ) {
    if (!(robot instanceof Robot)) throw typeError('A planner needs a Robot', 'kinematics');
    this.dof = robot.dof;
    this.colliders = [...(options?.colliders ?? [])];
    this.minClearance = options?.minClearance ?? 0.01;
    this.selfCollision = options?.selfCollision === true;
    this.stepSize = options?.stepSize ?? 0.3;
    this.tolerance = options?.tolerance ?? 1e-4;
    if (!(this.minClearance >= 0) || !Number.isFinite(this.minClearance))
      throw rangeError('Plan minClearance must be 0 or more', 'kinematics');
    if (!(this.stepSize > 0) || !Number.isFinite(this.stepSize))
      throw rangeError('Plan stepSize must be above 0', 'kinematics');
    this.sweep = {
      minClearance: this.minClearance,
      tolerance: this.tolerance,
      maxSteps: options?.maxSteps ?? 4096,
      selfCollision: this.selfCollision,
    };
    this.random = generator(options?.seed ?? 1);
    this.low = new Float64Array(this.dof);
    this.high = new Float64Array(this.dof);
    // A continuous joint has no range, so one turn each way from the start is the box to sample.
    for (let i = 0; i < this.dof; i++) {
      const centre = around ? around[i] : 0;
      this.low[i] = Number.isFinite(robot.lower[i]) ? robot.lower[i] : centre - Math.PI;
      this.high[i] = Number.isFinite(robot.upper[i]) ? robot.upper[i] : centre + Math.PI;
    }
  }

  sample(out: Float64Array): void {
    this.samples++;
    for (let i = 0; i < this.dof; i++) out[i] = this.low[i] + (this.high[i] - this.low[i]) * this.random();
  }

  /** The pose keeps the gap and its joints are in range. */
  valid(q: ArrayLike<number>): boolean {
    return (
      this.robot.within(q) &&
      this.robot.clearance(q, this.colliders, this.selfCollision) > this.minClearance + this.sweep.tolerance
    );
  }

  /** The straight move from `a` to `b` is clear. */
  free(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
    this.edgeChecks++;
    return sweepRobot(this.robot, a, b, this.colliders, this.sweep).clear;
  }
}

class Tree {
  private nodes: Float64Array;
  private parents: Int32Array;
  size = 0;

  constructor(
    private readonly dof: number,
    root: ArrayLike<number>,
  ) {
    this.nodes = new Float64Array(dof * 256);
    this.parents = new Int32Array(256);
    this.add(root, -1);
  }

  add(q: ArrayLike<number>, parent: number): number {
    const { dof } = this;
    if (this.size === this.parents.length) {
      const nodes = new Float64Array(this.nodes.length * 2),
        parents = new Int32Array(this.parents.length * 2);
      nodes.set(this.nodes);
      parents.set(this.parents);
      this.nodes = nodes;
      this.parents = parents;
    }
    for (let i = 0; i < dof; i++) this.nodes[this.size * dof + i] = q[i];
    this.parents[this.size] = parent;
    return this.size++;
  }

  node(index: number): Float64Array {
    return this.nodes.subarray(index * this.dof, (index + 1) * this.dof);
  }

  nearest(q: ArrayLike<number>): number {
    const { dof, nodes } = this;
    let found = 0,
      best = Infinity;
    for (let i = 0; i < this.size; i++) {
      let sum = 0;
      for (let k = 0; k < dof; k++) sum += (nodes[i * dof + k] - q[k]) ** 2;
      if (sum < best) {
        best = sum;
        found = i;
      }
    }
    return found;
  }

  /** Copies of the configurations from the root to `index`. */
  rootTo(index: number): Float64Array[] {
    const out: Float64Array[] = [];
    for (let i = index; i >= 0; i = this.parents[i]) out.push(this.node(i).slice());
    return out.reverse();
  }
}

const TRAPPED = 0,
  ADVANCED = 1,
  REACHED = 2;

/** One step of a tree toward `target`. The new node, or the node at `target`, is in `tree.size - 1`. */
function extend(space: Space, tree: Tree, target: Float64Array, scratch: Float64Array): number {
  const near = tree.nearest(target),
    from = tree.node(near),
    gap = distanceBetween(from, target, space.dof),
    reach = gap <= space.stepSize,
    share = reach ? 1 : space.stepSize / gap;
  for (let i = 0; i < space.dof; i++) scratch[i] = from[i] + (target[i] - from[i]) * share;
  if (!space.free(from, scratch)) return TRAPPED;
  tree.add(scratch, near);
  return reach ? REACHED : ADVANCED;
}

function* rrtConnect(
  space: Space,
  start: Float64Array,
  goal: Float64Array,
  maxSamples: number,
): Generator<void, Float64Array[] | null> {
  let a = new Tree(space.dof, start),
    b = new Tree(space.dof, goal),
    swapped = false;
  const target = new Float64Array(space.dof),
    scratch = new Float64Array(space.dof),
    joined = new Float64Array(space.dof);
  if (space.free(start, goal)) return [start.slice(), goal.slice()];
  while (space.samples < maxSamples) {
    yield;
    space.sample(target);
    if (extend(space, a, target, scratch) !== TRAPPED) {
      joined.set(a.node(a.size - 1));
      let state = ADVANCED;
      while (state === ADVANCED) state = extend(space, b, joined, scratch);
      if (state === REACHED) {
        const first = a.rootTo(a.size - 1),
          second = b.rootTo(b.size - 1).reverse();
        second.shift();
        const path = first.concat(second);
        return swapped ? path.reverse() : path;
      }
    }
    const held = a;
    a = b;
    b = held;
    swapped = !swapped;
  }
  return null;
}

function* rrt(
  space: Space,
  start: Float64Array,
  goal: Float64Array,
  maxSamples: number,
  goalBias: number,
): Generator<void, Float64Array[] | null> {
  const tree = new Tree(space.dof, start),
    target = new Float64Array(space.dof),
    scratch = new Float64Array(space.dof);
  while (space.samples < maxSamples) {
    yield;
    if (space.random() < goalBias) {
      target.set(goal);
      space.samples++;
    } else space.sample(target);
    if (extend(space, tree, target, scratch) === TRAPPED) continue;
    const last = tree.node(tree.size - 1);
    if (distanceBetween(last, goal, space.dof) <= space.stepSize && space.free(last, goal)) {
      const path = tree.rootTo(tree.size - 1);
      if (distanceBetween(last, goal, space.dof) > 0) path.push(goal.slice());
      return path;
    }
  }
  return null;
}

/** Options of {@link Roadmap}. */
export interface RoadmapOptions extends PlanSettings {
  /** Neighbours each node tries to join. Default 10. */
  neighbors?: number;
  /** Where to centre the box of samples on a joint with no range, one turn each way. Default all zero. */
  around?: ArrayLike<number>;
}

/**
 * A probabilistic roadmap: a graph of clear poses joined by proved edges, built once and asked many times. Grow it for
 * a scene that holds still, then each {@link query} only has to reach the graph from its two ends.
 *
 * @example
 * ```ts
 * import { SphereVolume } from 'margoengine/kinematics-constraints';
 * import { Roadmap } from 'margoengine/kinematics-constraints/plan';
 * import { Robot } from 'margoengine/kinematics-constraints/robot';
 *
 * const arm = new Robot({
 *   joints: [{ lower: -3, upper: 3 }],
 *   shapes: [{ joint: 0, end: [1, 0, 0], radius: 0.05 }],
 * });
 * const roadmap = new Roadmap(arm, { colliders: [new SphereVolume({ center: [0, 1, 0], radius: 0.1 })] });
 * roadmap.grow(100);
 * const route = roadmap.query([-1], [1]);
 * ```
 */
export class Roadmap {
  private readonly space: Space;
  private readonly neighbors: number;
  private readonly nodes: Float64Array[] = [];
  private readonly edges: { to: number; cost: number }[][] = [];
  /** Union-find parent per node: the graph's connected parts. */
  private readonly parts: number[] = [];

  constructor(robot: Robot, options?: RoadmapOptions) {
    this.space = new Space(robot, options, options?.around ?? null);
    this.neighbors = options?.neighbors ?? 10;
    if (!Number.isSafeInteger(this.neighbors) || this.neighbors < 1)
      throw rangeError('Roadmap neighbors must be a positive integer', 'kinematics');
  }

  /** Poses in the graph. */
  get size(): number {
    return this.nodes.length;
  }

  /** Tries `samples` random poses and joins each clear one to the graph. */
  grow(samples: number): this {
    const q = new Float64Array(this.space.dof);
    for (let i = 0; i < samples; i++) {
      this.space.sample(q);
      if (this.space.valid(q)) this.insert(q);
    }
    return this;
  }

  /**
   * Adds poses known to be clear, `dof` numbers each in `poses`, as a batch check on the GPU gives them. `gaps[i]`, when
   * passed, is pose `i`'s gap: one at or below `minClearance` is left out.
   */
  addPoses(poses: ArrayLike<number>, gaps?: ArrayLike<number>): this {
    const { dof, minClearance } = this.space,
      q = new Float64Array(dof);
    for (let i = 0; i * dof < poses.length; i++) {
      if (gaps && !(gaps[i] > minClearance)) continue;
      for (let k = 0; k < dof; k++) q[k] = poses[i * dof + k];
      if (this.space.valid(q)) this.insert(q);
    }
    return this;
  }

  /** Writes `count` random poses in the joints' ranges, for a batch check of your own. */
  samplePoses(count: number, out: Float64Array = new Float64Array(count * this.space.dof)): Float64Array {
    const q = new Float64Array(this.space.dof);
    for (let i = 0; i < count; i++) {
      this.space.sample(q);
      out.set(q, i * this.space.dof);
    }
    return out;
  }

  /** The shortest route on the graph from `start` to `goal`, or status `'no-path'` while they are in separate parts. */
  query(start: ArrayLike<number>, goal: ArrayLike<number>): PlanResult {
    const space = this.space,
      from = Float64Array.from(start),
      to = Float64Array.from(goal),
      result = (status: PlanStatus, path: Float64Array[] = []): PlanResult => ({
        status,
        path,
        length: pathLength(path, space.dof),
        samples: space.samples,
        edgeChecks: space.edgeChecks,
      });
    if (!space.valid(from)) return result('start-blocked');
    if (!space.valid(to)) return result('goal-blocked');
    if (space.free(from, to)) return result('found', [from, to]);
    const entries = this.entry(from),
      exits = this.entry(to);
    for (const exit of exits) {
      const route = this.route(entries, exit);
      if (route) return result('found', [from, ...route, to]);
    }
    return result('no-path');
  }

  /** The graph's nodes in reach of `q` by a clear edge, nearest first. */
  private entry(q: Float64Array): number[] {
    return this.closest(q, this.neighbors * 2).filter((i) => this.space.free(q, this.nodes[i]));
  }

  private closest(q: ArrayLike<number>, count: number): number[] {
    const { dof } = this.space;
    return this.nodes
      .map((node, index) => ({ index, gap: distanceBetween(node, q, dof) }))
      .sort((a, b) => a.gap - b.gap || a.index - b.index)
      .slice(0, count)
      .map((item) => item.index);
  }

  private find(i: number): number {
    while (this.parts[i] !== i) {
      this.parts[i] = this.parts[this.parts[i]];
      i = this.parts[i];
    }
    return i;
  }

  private insert(q: Float64Array): void {
    const index = this.nodes.length,
      { dof } = this.space,
      copy = q.slice(),
      near = this.closest(q, this.neighbors);
    this.nodes.push(copy);
    this.edges.push([]);
    this.parts.push(index);
    for (const other of near) {
      // Two nodes already in one part need no second way between them, for a graph that stays small.
      if (this.find(other) === this.find(index)) continue;
      if (!this.space.free(copy, this.nodes[other])) continue;
      const cost = distanceBetween(copy, this.nodes[other], dof);
      this.edges[index].push({ to: other, cost });
      this.edges[other].push({ to: index, cost });
      this.parts[this.find(index)] = this.find(other);
    }
  }

  /** Dijkstra from any of `entries` to `exit`; the configurations on the way, or null. */
  private route(entries: readonly number[], exit: number): Float64Array[] | null {
    const count = this.nodes.length,
      cost = new Float64Array(count).fill(Infinity),
      from = new Int32Array(count).fill(-1),
      done = new Uint8Array(count),
      part = this.find(exit);
    for (const entry of entries) if (this.find(entry) === part) cost[entry] = 0;
    for (;;) {
      let node = -1,
        best = Infinity;
      for (let i = 0; i < count; i++) {
        if (!done[i] && cost[i] < best) {
          best = cost[i];
          node = i;
        }
      }
      if (node < 0) return null;
      if (node === exit) break;
      done[node] = 1;
      for (const edge of this.edges[node]) {
        if (best + edge.cost < cost[edge.to]) {
          cost[edge.to] = best + edge.cost;
          from[edge.to] = node;
        }
      }
    }
    const out: Float64Array[] = [];
    for (let i = exit; i >= 0; i = from[i]) out.push(this.nodes[i].slice());
    return out.reverse();
  }
}

function* prm(
  space: Space,
  roadmap: Roadmap,
  start: Float64Array,
  goal: Float64Array,
  maxSamples: number,
): Generator<void, Float64Array[] | null> {
  while (space.samples < maxSamples) {
    yield;
    roadmap.grow(Math.min(64, maxSamples - space.samples));
    const answer = roadmap.query(start, goal);
    if (answer.status === 'found') return answer.path;
  }
  return null;
}

/** Random shortcuts: two points on the path, joined straight if the swept check allows. */
function* shorten(space: Space, path: Float64Array[], rounds: number): Generator<void, Float64Array[]> {
  const n = space.dof;
  let current = path;
  for (let round = 0; round < rounds && current.length > 2; round++) {
    yield;
    const total = pathLength(current, n),
      one = space.random() * total,
      two = space.random() * total,
      a = cut(current, Math.min(one, two), n),
      b = cut(current, Math.max(one, two), n);
    if (b.index <= a.index) continue;
    if (!space.free(a.point, b.point)) continue;
    const next = current.slice(0, a.index + 1);
    if (distanceBetween(next[next.length - 1], a.point, n) > 0) next.push(a.point);
    if (distanceBetween(a.point, b.point, n) > 0) next.push(b.point);
    for (let i = b.index + 1; i < current.length; i++) next.push(current[i]);
    current = next;
  }
  return current;
}

/** The point `distance` along a path; `index` is the path node before it. */
function cut(path: readonly Float64Array[], distance: number, n: number): { index: number; point: Float64Array } {
  let left = distance;
  for (let i = 0; i + 1 < path.length; i++) {
    const length = distanceBetween(path[i], path[i + 1], n);
    if (left <= length) {
      const share = length > 0 ? left / length : 0,
        point = new Float64Array(n);
      for (let k = 0; k < n; k++) point[k] = path[i][k] + (path[i + 1][k] - path[i][k]) * share;
      return { index: i, point };
    }
    left -= length;
  }
  return { index: path.length - 2, point: path[path.length - 1].slice() };
}

function* search(
  robot: Robot,
  start: ArrayLike<number>,
  goal: ArrayLike<number>,
  options: PlanOptions | undefined,
): Generator<void, PlanResult> {
  const algorithm = options?.algorithm ?? 'rrt-connect',
    maxSamples = options?.maxSamples ?? 20000,
    goalBias = options?.goalBias ?? 0.1,
    shortcuts = options?.shortcuts ?? 100,
    from = Float64Array.from(start),
    to = Float64Array.from(goal);
  if (algorithm !== 'rrt-connect' && algorithm !== 'rrt' && algorithm !== 'prm')
    throw rangeError(`Unknown plan algorithm ${String(algorithm)}; use rrt-connect, rrt or prm`, 'kinematics');
  if (!Number.isSafeInteger(maxSamples) || maxSamples < 1)
    throw rangeError('Plan maxSamples must be a positive integer', 'kinematics');
  if (!(goalBias >= 0 && goalBias <= 1)) throw rangeError('Plan goalBias must be from 0 to 1', 'kinematics');
  if (!Number.isSafeInteger(shortcuts) || shortcuts < 0)
    throw rangeError('Plan shortcuts must be 0 or more', 'kinematics');
  const roadmap = algorithm === 'prm' ? new Roadmap(robot, { ...options, around: from }) : null,
    space = roadmap ? roadmap['space'] : new Space(robot, options, from),
    done = (status: PlanStatus, path: Float64Array[] = []): PlanResult => ({
      status,
      path,
      length: pathLength(path, space.dof),
      samples: space.samples,
      edgeChecks: space.edgeChecks,
    });
  if (from.length !== space.dof || to.length !== space.dof)
    throw typeError(`Plan poses need ${space.dof} numbers`, 'kinematics');
  if (!space.valid(from)) return done('start-blocked');
  if (!space.valid(to)) return done('goal-blocked');
  let path: Float64Array[] | null;
  if (algorithm === 'rrt-connect') path = yield* rrtConnect(space, from, to, maxSamples);
  else if (algorithm === 'rrt') path = yield* rrt(space, from, to, maxSamples, goalBias);
  else path = yield* prm(space, roadmap!, from, to, maxSamples);
  if (!path) return done('no-path');
  return done('found', yield* shorten(space, path, shortcuts));
}

function drive(run: Generator<void, PlanResult>): PlanResult {
  for (;;) {
    const step = run.next();
    if (step.done) return step.value;
  }
}

const SLICE_MS = 8;

async function driveAsync(run: Generator<void, PlanResult>, signal: AbortSignal | undefined): Promise<PlanResult> {
  let mark = performance.now();
  for (;;) {
    signal?.throwIfAborted();
    const step = run.next();
    if (step.done) return step.value;
    if (performance.now() - mark >= SLICE_MS) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      mark = performance.now();
    }
  }
}

/**
 * Plans a clear path between two configurations, in short slices so a page stays alive. Every straight step of the
 * result passes the swept check, so it holds the gap the whole way, not at sampled points. Start from it when
 * {@link JointLimitSolver} reports `blocked`.
 *
 * @example
 * ```ts
 * import { ConvexHullVolume } from 'margoengine/kinematics-constraints';
 * import { planPath } from 'margoengine/kinematics-constraints/plan';
 * import { Robot } from 'margoengine/kinematics-constraints/robot';
 *
 * const arm = new Robot({
 *   joints: [{ lower: -3, upper: 3 }, { lower: -3, upper: 3, origin: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1] }],
 *   shapes: [{ joint: 1, end: [1, 0, 0], radius: 0.05 }],
 * });
 * const wall = new ConvexHullVolume({ points: [1.5, -0.2, -1, 1.5, -0.2, 1, 3, -0.2, -1, 3, -0.2, 1] });
 * const plan = await planPath(arm, [0.3, 0], [-0.3, 0], { colliders: [wall], seed: 7 });
 * if (plan.status === 'found') console.log(plan.path.length, plan.length);
 * ```
 */
export function planPath(
  robot: Robot,
  start: ArrayLike<number>,
  goal: ArrayLike<number>,
  options?: PlanOptions,
): Promise<PlanResult> {
  return driveAsync(search(robot, start, goal, options), options?.signal);
}

/** {@link planPath} in one go, on the calling thread. `signal` is not read: no timer can fire during the call. */
export function planPathSync(
  robot: Robot,
  start: ArrayLike<number>,
  goal: ArrayLike<number>,
  options?: PlanOptions,
): PlanResult {
  return drive(search(robot, start, goal, options));
}

function* toPose(
  robot: Robot,
  start: ArrayLike<number>,
  target: JointLimitTarget,
  options: PoseGoalOptions,
): Generator<void, PlanResult> {
  const attempts = options.goalAttempts ?? 32;
  if (!Number.isSafeInteger(attempts) || attempts < 0)
    throw rangeError('Plan goalAttempts must be 0 or more', 'kinematics');
  const space = new Space(robot, options, start),
    ended = (status: PlanStatus): PlanResult => ({ status, path: [], length: 0, samples: 0, edgeChecks: 0 });
  if (!space.valid(start)) return ended('start-blocked');
  // No colliders here: the solver would refuse to cross an obstacle on its way, and only the pose it ends on has to be clear.
  const solver = new JointLimitSolver(robot, { tip: options.tip, point: options.point, maxIterations: 200 }),
    seedPose = new Float64Array(robot.dof);
  for (let attempt = 0; attempt <= attempts; attempt++) {
    yield;
    if (attempt === 0) seedPose.set(start);
    else space.sample(seedPose);
    const answer = solver.solve(seedPose, target);
    if (answer.reached && space.valid(answer.q)) return yield* search(robot, start, answer.q.slice(), options);
  }
  return ended('goal-blocked');
}

/**
 * Plans from a configuration to a tip target: the joint-limit solver looks for a pose at the target, from the start and
 * then from random restarts, until one is clear, and the planner finds the way there. Status `'goal-blocked'` means no
 * restart ended on a clear pose, which is no proof that none exists.
 */
export function planToPose(
  robot: Robot,
  start: ArrayLike<number>,
  target: JointLimitTarget,
  options: PoseGoalOptions,
): Promise<PlanResult> {
  return driveAsync(toPose(robot, start, target, options), options?.signal);
}
