import type { PBRModel } from '@margoengine/gltf-pro/model';
import type { Animator } from '@margoengine/animator';
import type { Mesh } from '@margoengine/core/extension';
import { engineRuntime } from '@margoengine/core/extension';
import {
  conjugateQuaternion as inverse,
  multiplyQuaternions as multiply,
  normalizeQuaternion as normalized,
  rotateByQuaternion as rotate,
  interpolateQuaternions,
  splitTRS,
} from '@margoengine/math/quat';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { rotationBetween } from './ik.js';

type Quat = readonly [number, number, number, number];
const IDENTITY: Quat = [0, 0, 0, 1];
const axes = {
  X: [1, 0, 0],
  Y: [0, 1, 0],
  Z: [0, 0, 1],
  PositiveX: [1, 0, 0],
  NegativeX: [-1, 0, 0],
  PositiveY: [0, 1, 0],
  NegativeY: [0, -1, 0],
  PositiveZ: [0, 0, 1],
  NegativeZ: [0, 0, -1],
} as const;
/** A normalized constraint. Only weight is mutable, from zero through one. */
export interface VRMNodeConstraint {
  readonly target: number;
  readonly source: number;
  readonly kind: 'rotation' | 'roll' | 'aim';
  readonly axis?: keyof typeof axes;
  weight: number;
}
/** The glTF node data this optional entry reads, without taking ownership. */
export interface VRMConstraintDocument {
  nodes?: readonly {
    children?: readonly number[];
    rotation?: readonly number[];
    matrix?: readonly number[];
    extensions?: Record<string, unknown>;
  }[];
}
/** Rest and current transforms for a stateless constraint evaluation. World fields are needed only by aim. */
export interface VRMConstraintFrame {
  sourceRest: ArrayLike<number>;
  destinationRest: ArrayLike<number>;
  sourceRotation: ArrayLike<number>;
  parentWorldRotation?: ArrayLike<number>;
  sourceWorldPosition?: ArrayLike<number>;
  destinationWorldPosition?: ArrayLike<number>;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
function vector(value: ArrayLike<number> | undefined, count: number): number[] {
  if (!value || value.length !== count || Array.from(value).some((v) => !Number.isFinite(v)))
    throw rangeError('VRM constraint transforms need finite vectors of the declared length', 'transform');
  return Array.from(value);
}
function quaternion(value: ArrayLike<number>): [number, number, number, number] {
  const q = vector(value, 4);
  if (!q.some((v) => v !== 0)) throw rangeError('VRM constraint quaternion must be nonzero', 'transform');
  return normalized(q);
}
function checkWeight(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1)
    throw rangeError('VRM constraint weight must be finite from zero through one', 'transform');
}
function checkKind(value: Pick<VRMNodeConstraint, 'kind' | 'axis' | 'weight'>): void {
  if (!value) throw typeError('VRM constraint needs a rotation, roll or aim record', 'transform');
  checkWeight(value.weight);
  if (
    !['rotation', 'roll', 'aim'].includes(value.kind) ||
    (value.kind === 'roll' && !['X', 'Y', 'Z'].includes(value.axis ?? '')) ||
    (value.kind === 'aim' &&
      !['PositiveX', 'NegativeX', 'PositiveY', 'NegativeY', 'PositiveZ', 'NegativeZ'].includes(value.axis ?? ''))
  )
    throw typeError('VRM constraint needs rotation, roll with X/Y/Z, or aim with a signed axis', 'transform');
}
/** Read independent VRMC_node_constraint 1.0 records, validating references, hierarchy and constraint dependencies. */
export function readVRMConstraints(document: VRMConstraintDocument): readonly VRMNodeConstraint[] {
  if (!object(document) || (document.nodes !== undefined && !Array.isArray(document.nodes)))
    throw typeError('VRM constraints need a parsed glTF document with a nodes array', 'transform');
  const nodes = document.nodes ?? [],
    result: VRMNodeConstraint[] = [];
  nodes.forEach((node, target) => {
    if (!object(node) || (node.children !== undefined && !Array.isArray(node.children)))
      throw typeError('VRM constraints need object nodes with child-index arrays', 'transform');
    if (node.extensions !== undefined && !object(node.extensions))
      throw typeError('VRM node extensions must be an object; pass parsed extension records', 'transform');
    const extension = object(node.extensions) ? node.extensions.VRMC_node_constraint : undefined;
    if (extension === undefined) return;
    if (!object(extension) || extension.specVersion !== '1.0' || !object(extension.constraint))
      throw typeError('VRM node constraint needs specVersion 1.0 and one constraint object', 'transform');
    const entries = Object.entries(extension.constraint).filter(([key]) => ['rotation', 'roll', 'aim'].includes(key));
    if (entries.length !== 1 || !object(entries[0][1]))
      throw typeError('VRM node constraint must contain exactly one roll, aim or rotation', 'transform');
    const [kind, payload] = entries[0] as [VRMNodeConstraint['kind'], Record<string, unknown>];
    const source = payload.source as number,
      weight = (payload.weight === undefined ? 1 : payload.weight) as number;
    if (!Number.isSafeInteger(source) || source < 0 || source >= nodes.length || source === target)
      throw rangeError('VRM constraint source must name another existing node', 'transform');
    const record: VRMNodeConstraint = {
      target,
      source,
      kind,
      weight,
      axis: (kind === 'roll' ? payload.rollAxis : payload.aimAxis) as VRMNodeConstraint['axis'],
    };
    checkKind(record);
    for (const key of ['target', 'source', 'kind', 'axis'] as const)
      Object.defineProperty(record, key, { writable: false, configurable: false });
    result.push(record);
  });
  dependencyOrder(document, result);
  return Object.freeze(result);
}
function dependencyOrder(document: VRMConstraintDocument, constraints: readonly VRMNodeConstraint[]): number[] {
  const nodes = document.nodes ?? [],
    parents = new Int32Array(nodes.length).fill(-1);
  for (let i = 0; i < nodes.length; i++)
    for (const child of nodes[i].children ?? []) {
      if (!Number.isSafeInteger(child) || child < 0 || child >= nodes.length || child === i || parents[child] !== -1)
        throw rangeError(
          'VRM constraint hierarchy must be a forest of existing nodes with one parent each',
          'transform',
        );
      parents[child] = i;
    }
  const ancestors = (node: number): number[] => {
    const path: number[] = [],
      seen = new Set<number>();
    for (let i = node; i !== -1; i = parents[i]) {
      if (seen.has(i))
        throw fault('state', 'VRM node hierarchy contains a cycle; remove the circular parent', 'hierarchy');
      seen.add(i);
      path.push(i);
    }
    return path;
  };
  const hierarchyDone = new Uint8Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    const path: number[] = [];
    let at = i;
    while (at !== -1 && hierarchyDone[at] === 0) {
      hierarchyDone[at] = 1;
      path.push(at);
      at = parents[at];
    }
    if (at !== -1 && hierarchyDone[at] === 1)
      throw fault('state', 'VRM node hierarchy contains a cycle; remove the circular parent', 'hierarchy');
    for (const node of path) hierarchyDone[node] = 2;
  }
  const byTarget = new Map(constraints.map((c, i) => [c.target, i]));
  const edges = constraints.map((c) => {
    const dependencies = c.kind === 'aim' ? [...ancestors(c.source), ...ancestors(parents[c.target])] : [c.source];
    return [...new Set(dependencies.filter((n) => byTarget.has(n)).map((n) => byTarget.get(n)!))];
  });
  const order: number[] = [],
    done = new Uint8Array(constraints.length);
  for (let i = 0; i < constraints.length; i++) {
    const stack: { node: number; next: number }[] = [{ node: i, next: 0 }];
    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (done[frame.node] === 2) {
        stack.pop();
        continue;
      }
      done[frame.node] = 1;
      const edge = edges[frame.node][frame.next++];
      if (edge !== undefined) {
        if (done[edge] === 1)
          throw fault('state', 'VRM constraints contain a circular dependency; remove the cycle', 'hierarchy');
        if (done[edge] !== 2) stack.push({ node: edge, next: 0 });
      } else {
        done[frame.node] = 2;
        order.push(frame.node);
        stack.pop();
      }
    }
  }
  return order;
}
/** Evaluate the standard rest-relative rotation, swing-free roll or shortest world-space aim, without mutating inputs. */
export function evaluateVRMConstraint(
  constraint: Pick<VRMNodeConstraint, 'kind' | 'axis' | 'weight'>,
  frame: VRMConstraintFrame,
): [number, number, number, number] {
  checkKind(constraint);
  if (!frame) throw typeError('VRM constraint evaluation needs rest and current transforms', 'transform');
  const rest = quaternion(frame.destinationRest),
    sourceRest = quaternion(frame.sourceRest),
    source = quaternion(frame.sourceRotation);
  let target: [number, number, number, number];
  if (constraint.kind === 'aim') {
    const parent = quaternion(frame.parentWorldRotation ?? IDENTITY),
      from = rotate(axes[constraint.axis!], multiply(parent, rest)),
      a = vector(frame.sourceWorldPosition, 3),
      b = vector(frame.destinationWorldPosition, 3),
      direction = a.map((v, k) => v - b[k]);
    target =
      Math.hypot(...direction) === 0
        ? rest
        : multiply(multiply(multiply(inverse(parent), rotationBetween(from, direction)), parent), rest);
  } else {
    const delta = multiply(inverse(sourceRest), source);
    if (constraint.kind === 'rotation') target = multiply(rest, delta);
    else {
      const inDestination = normalized(
          multiply(multiply(inverse(rest), sourceRest), multiply(delta, multiply(inverse(sourceRest), rest))),
        ),
        axis = axes[constraint.axis!],
        projection = inDestination[0] * axis[0] + inDestination[1] * axis[1] + inDestination[2] * axis[2],
        twist = [axis[0] * projection, axis[1] * projection, axis[2] * projection, inDestination[3]];
      // At a pure half-turn swing the twist is indeterminate; identity is the continuous zero-twist convention.
      target = multiply(rest, Math.hypot(...twist) === 0 ? IDENTITY : normalized(twist));
    }
  }
  return interpolateQuaternions(rest, normalized(target), constraint.weight, 1 - Number.EPSILON);
}
/** Attach after this model's Animator; omit to run as a scene pre-update plugin. */
export interface VRMConstraintsOptions {
  animator?: Animator;
}
/** Borrowed model controller. Weights are live; disposal restores the captured pre-attachment target rotations. */
export interface VRMConstraintsHandle {
  readonly constraints: readonly VRMNodeConstraint[];
  readonly disposed: boolean;
  update(): void;
  dispose(): void;
  [Symbol.dispose](): void;
}
let serial = 0;
/** Install the authored constraints in dependency order, after animation and before skin matrices are uploaded. */
export function addVRMConstraints(model: PBRModel, options: VRMConstraintsOptions = {}): VRMConstraintsHandle {
  if (!model || model.disposed) throw fault('disposed', 'VRM constraints need a live PBRModel; load it again');
  if (options.animator && options.animator.animation.model !== model)
    throw typeError('VRM constraints and Animator must belong to the same model', 'transform');
  const document = model.asset.doc as VRMConstraintDocument,
    constraints = readVRMConstraints(document),
    order = dependencyOrder(document, constraints),
    engine = engineRuntime(model.root.engine),
    scene = engine.sceneOf(model),
    store = engine.store;
  if (!scene) throw fault('state', 'VRM constraints need a registered model; load it into a scene first');
  const read = (mesh: Mesh): [number, number, number, number] => {
    mesh.syncRotation();
    const t = store.transforms,
      id = mesh.id;
    return quaternion([t.qx[id], t.qy[id], t.qz[id], t.qw[id]]);
  };
  const worldRotation = (mesh: Mesh | undefined): [number, number, number, number] => {
    let q: [number, number, number, number] = [0, 0, 0, 1];
    for (let at = mesh; at; at = engine.meshes.get(store.parents[at.id])) q = multiply(read(at), q);
    return normalized(q);
  };
  const rest = (document.nodes ?? []).map((node) => {
    if (!node.matrix) return quaternion(node.rotation ?? IDENTITY);
    const result = splitTRS(node.matrix);
    if (!result.ok)
      throw typeError('VRM constraint rest matrix must have nonsingular TRS; remove shear or zero scale', 'transform');
    return result.rotation;
  });
  const before = constraints.map((c) => read(model.nodes[c.target])),
    name = 'vrm-constraints:' + serial++;
  let dead = false,
    remove: (() => void) | undefined,
    unsubscribe: (() => void) | undefined;
  const write = (target: number, q: readonly number[]) =>
    options.animator
      ? options.animator.writeNodeRotation(model.nodes[target], q)
      : model.nodes[target].setQuaternion(q);
  const update = (): void => {
    if (dead || model.disposed) throw fault('disposed', 'VRM constraints are disposed; attach a new controller');
    for (const constraint of constraints) checkWeight(constraint.weight);
    store.tick(false);
    for (const index of order) {
      const constraint = constraints[index],
        source = model.nodes[constraint.source],
        target = model.nodes[constraint.target],
        parent = engine.meshes.get(store.parents[target.id]);
      const q = evaluateVRMConstraint(constraint, {
        sourceRest: rest[constraint.source],
        destinationRest: rest[constraint.target],
        sourceRotation: read(source),
        parentWorldRotation: worldRotation(parent),
        sourceWorldPosition: source.matrix.subarray(12, 15),
        destinationWorldPosition: target.matrix.subarray(12, 15),
      });
      write(constraint.target, q);
      store.tick(false);
    }
  };
  const dispose = (): void => {
    if (dead) return;
    dead = true;
    unsubscribe?.();
    unsubscribe = undefined;
    remove?.();
    remove = undefined;
    if (!model.disposed && !engine.disposed) {
      constraints.forEach((c, i) => model.nodes[c.target].setQuaternion(before[i]));
      store.tick(false);
    }
  };
  if (options.animator) remove = options.animator.addSolver(update);
  else {
    scene.use({ name, setup() {}, onPreUpdate: update, dispose });
    remove = () => engine.removePlugin(name, scene);
  }
  unsubscribe = model.onDispose(dispose);
  return {
    constraints,
    get disposed() {
      return dead;
    },
    update,
    dispose,
    [Symbol.dispose]: dispose,
  };
}
