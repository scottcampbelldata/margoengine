import type { Animator } from '@margoengine/animator';
import type { Quat, Vec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import { hypot } from '@margoengine/math/pinned';
import {
  conjugateQuaternion,
  multiplyQuaternions,
  normalizeQuaternion,
  rotateByQuaternion,
  rotationToQuaternion,
} from '@margoengine/math/quat';
import type { StrandCapsule, StrandParams, StrandSolver, StrandSpec } from '@margoengine/physics/strands';
import type { PhysicsWorld } from '@margoengine/physics/world';
import { springAccess, type SpringAccess, type SpringCollider } from './springs.js';

/** A weighted bone chain driven by an SI fibre guide. */
export interface StrandSpringChain extends Omit<StrandSpec, 'points'> {
  /** Ordered glTF node indices, each an ancestor of the next. Each node belongs to one chain. */
  readonly joints: readonly number[];
  /** A virtual tip in the last joint's local metres. Supply this for a single-joint accessory. */
  readonly tip?: Vec3;
}

/** Physics settings and the skin's guide chains. */
export interface StrandSpringRigOptions extends Omit<StrandParams, 'strands' | 'rate' | 'colliders'> {
  readonly chains: readonly StrandSpringChain[];
  /** Shared body capsules or spheres. Node-space shapes follow their attachment bone. */
  readonly colliders?: readonly SpringCollider[];
  readonly signal?: AbortSignal;
}

/** An active physical spring-bone attachment on an Animator. */
export interface StrandSpringAttachment {
  readonly rig: StrandSpringRig;
  dispose(): void;
  [Symbol.dispose](): void;
}

type Frame = { readonly position: Vec3; readonly rotation: Quat; readonly scale: number };
const ORIGIN: Frame = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: 1 };
const RATE = 240;
const ROUNDING = 16 / 8388608;
const difference = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const added = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (q: Vec3, factor: number): Vec3 => [q[0] * factor, q[1] * factor, q[2] * factor];

function rigidFrame(matrix: ArrayLike<number> | null): Frame {
  if (!matrix) return ORIGIN;
  const x = [matrix[0], matrix[1], matrix[2]] as [number, number, number];
  const y = [matrix[4], matrix[5], matrix[6]] as [number, number, number];
  const z = [matrix[8], matrix[9], matrix[10]] as [number, number, number];
  const sx = hypot(...x),
    sy = hypot(...y),
    sz = hypot(...z);
  const tolerance = sx * ROUNDING;
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const determinant = dot(x, [y[1] * z[2] - y[2] * z[1], y[2] * z[0] - y[0] * z[2], y[0] * z[1] - y[1] * z[0]]);
  if (
    !(
      determinant > 0 &&
      Number.isFinite(determinant) &&
      Math.abs(sx - sy) <= tolerance &&
      Math.abs(sx - sz) <= tolerance &&
      Math.abs(dot(x, y)) <= tolerance * sx &&
      Math.abs(dot(x, z)) <= tolerance * sx &&
      Math.abs(dot(y, z)) <= tolerance * sx
    )
  )
    throw new MargoError(
      'state',
      'Physical strand bones need uniformly scaled rigid transforms. Apply the skin and ancestor scales before binding.',
    );
  return {
    position: [matrix[12]!, matrix[13]!, matrix[14]!],
    rotation: normalizeQuaternion(
      rotationToQuaternion(matrix, [0, 0, 0, 0] as [number, number, number, number], sx, sy, sz),
    ),
    scale: sx,
  };
}

function toWorld(frame: Frame, local: Vec3): Vec3 {
  return added(frame.position, rotateByQuaternion(scale(local, frame.scale), frame.rotation));
}

function toLocalOffset(frame: Frame, world: Vec3): Vec3 {
  return scale(rotateByQuaternion(world, conjugateQuaternion(frame.rotation)), 1 / frame.scale);
}

/** Native physical spring bones on any {@link SpringAccess}, advanced at 240 frames per second. */
export class StrandSpringRig {
  private constructor(
    readonly world: PhysicsWorld,
    readonly solver: StrandSolver,
    private readonly access: SpringAccess,
    private readonly joints: readonly (readonly number[])[],
    private readonly frameToBone: readonly (readonly Quat[])[],
    private readonly initial: Uint8Array,
  ) {}

  /** Reads the current weighted rest rig and binds its joints to physical guides. */
  static async load(access: SpringAccess, options: StrandSpringRigOptions): Promise<StrandSpringRig> {
    const { chains, colliders = [], signal, ...physics } = options;
    signal?.throwIfAborted();
    const [{ StrandSolver }, { PhysicsWorld }] = await Promise.all([
      import('@margoengine/physics/strands'),
      import('@margoengine/physics/world'),
    ]);
    const solver = await StrandSolver.load({ signal });
    const world = new PhysicsWorld({ rate: { num: RATE, den: 1 }, cellSize: physics.cellSize });
    access.flush();
    const initial: Frame[][] = [],
      used = new Set<number>();
    const strands = chains.map((chain): StrandSpec => {
      const { joints, tip, anchor, ...material } = chain;
      if (joints.length < (tip ? 1 : 2))
        throw new MargoError(
          'state',
          'Provide two physical strand bone indices, or give a single rooted bone a virtual tip.',
        );
      for (const joint of joints) {
        if (!Number.isSafeInteger(joint) || joint < 0 || used.has(joint))
          throw new MargoError('state', 'Pass unique nonnegative bone indices to the physical strand rig.');
        used.add(joint);
      }
      const root = joints[0]!,
        start = joints.map((joint) => rigidFrame(access.world(joint)));
      const parent = rigidFrame(access.parentWorld(root));
      const rootOffset = toLocalOffset(parent, difference(start[0]!.position, parent.position));
      const startInverse = conjugateQuaternion(parent.rotation);
      const points = start.map((frame) => frame.position);
      if (tip) points.push(toWorld(start.at(-1)!, tip));
      initial.push(start);
      return {
        ...material,
        points,
        anchor:
          anchor ??
          (() => {
            const now = rigidFrame(access.parentWorld(root));
            return {
              position: toWorld(now, rootOffset),
              rotation: normalizeQuaternion(multiplyQuaternions(now.rotation, startInverse)),
            };
          }),
      };
    });
    const capsules = colliders.map(({ node, offset = [0, 0, 0], tail = null, radius }) => (): StrandCapsule => {
      const frame = node == null ? ORIGIN : rigidFrame(access.world(node));
      return { start: toWorld(frame, offset), end: toWorld(frame, tail ?? offset), radius: radius * frame.scale };
    });
    world.add(solver, { ...physics, strands, colliders: capsules, rate: 2 });
    const frameToBone = initial.map((chain, i) =>
      chain.map((bone, j) =>
        normalizeQuaternion(multiplyQuaternions(conjugateQuaternion(solver.sample(i, j).rotation), bone.rotation)),
      ),
    );
    return new StrandSpringRig(
      world,
      solver,
      access,
      chains.map((chain) => [...chain.joints]),
      frameToBone,
      world.takeSnapshot().bytes,
    );
  }

  /** Advance to a whole 240 Hz frame and apply the solved pose. Supply animation inputs before advancing. */
  advance(frame: number): this {
    this.access.flush();
    this.world.advance(frame);
    this.apply();
    return this;
  }

  /** Restore the initial state and replay. Time-sampled anchors and wind reproduce the original inputs. */
  seek(frame: number): this {
    this.world.restoreSnapshot(this.initial);
    return this.advance(frame);
  }

  /** Apply the current solved pose after restoring a caller-owned world snapshot. */
  apply(): void {
    const { access, solver } = this;
    access.flush();
    for (const [i, chain] of this.joints.entries())
      for (const [j, bone] of chain.entries()) {
        const sample = solver.sample(i, j);
        const parent = rigidFrame(access.parentWorld(bone));
        const current = rigidFrame(access.world(bone));
        const rotation = multiplyQuaternions(sample.rotation, this.frameToBone[i]![j]!);
        access.move(bone, toLocalOffset(parent, difference(sample.position, current.position)));
        access.rotate(bone, normalizeQuaternion(multiplyQuaternions(conjugateQuaternion(parent.rotation), rotation)));
        access.flush();
      }
  }
}

/** Attach native strand spring bones after an Animator's pose and foot placement. */
export async function addStrandSpringRig(
  animator: Animator,
  options: StrandSpringRigOptions,
): Promise<StrandSpringAttachment> {
  const model = animator.animation.model,
    parents = model.root.engine.store.parents;
  for (const chain of options.chains) {
    for (const [i, bone] of chain.joints.entries()) {
      const node = model.nodes[bone];
      if (!node) throw new MargoError('state', 'Pass strand joint indices from the Animator model.');
      if (i === 0) continue;
      const ancestor = model.nodes[chain.joints[i - 1]!]!.id;
      let parent = parents[node.id];
      while (parent !== -1 && parent !== ancestor) parent = parents[parent];
      if (parent !== ancestor) throw new MargoError('state', 'Order each physical chain from parent to descendant.');
    }
  }
  for (const volume of options.colliders ?? []) {
    if (volume.node != null && !model.nodes[volume.node])
      throw new MargoError('state', 'Pass collider node indices from the same Animator model.');
  }
  const access = springAccess(model, (node, rotation) => animator.writeNodeRotation(model.nodes[node]!, rotation));
  const rig = await StrandSpringRig.load(access, options);
  let seconds = 0;
  const remove = animator.addSolver((dt) => {
    seconds += dt;
    const frame = seconds * RATE;
    rig.advance(Math.floor(frame + 8 * Number.EPSILON * Math.max(1, frame)));
  });
  let removeDispose: (() => void) | undefined;
  const dispose = () => {
    remove();
    removeDispose?.();
    removeDispose = undefined;
  };
  removeDispose = animator.onDispose(dispose);
  return { rig, dispose, [Symbol.dispose]: dispose };
}
