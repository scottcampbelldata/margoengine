import type { Engine } from '@margoengine/core';
import type { Quat, Vec3 } from '@margoengine/math';
import { cos, sin } from '@margoengine/math/pinned';
import {
  conjugateQuaternion,
  multiplyQuaternions,
  normalizeQuaternion,
  rotateByQuaternion,
} from '@margoengine/math/quat';
import type { StrandSolver, StrandCapsule, StrandParams, StrandSpec } from '@margoengine/physics/strands';
import type { PhysicsWorld } from '@margoengine/physics/world';
import { addHorse, type Horse, type HorseFrame, type HorseOptions } from './index.js';
import { horseJointTranslation, type HorsePose, type HorseSkeleton } from './model.js';

/** Effective SI material and drag settings for a horsehair bundle. */
export type HorseFibreMaterial = Omit<StrandSpec, 'points' | 'anchor'>;

/** Physics controls for one horse's tail, mane and forelock. */
export interface HorseStrandSettings extends Omit<StrandParams, 'strands' | 'rate' | 'colliders'> {
  /** Main tail guide effective fibre-bundle properties. */
  readonly tail?: HorseFibreMaterial;
  /** Mane and forelock guide effective fibre-bundle properties. */
  readonly mane?: HorseFibreMaterial;
}

/** Options of {@link addStrandHorse}. */
export interface StrandHorseOptions extends Omit<HorseOptions, 'strandRig'> {
  /** Guide settings, including a shared wind and bed. Defaults to rod guides in still air. */
  readonly strands?: HorseStrandSettings;
  /** Cancels native module loading. */
  readonly signal?: AbortSignal;
}

/** The horse with its native solver and the clock advanced by the gait controller. */
export interface StrandHorse extends Horse {
  readonly strandSolver: StrandSolver;
  readonly strandWorld: PhysicsWorld;
}

type BoneFrame = { position: Vec3; rotation: Quat };
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const subtract = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

function placement(frame: HorseFrame): BoneFrame {
  return { position: frame.position, rotation: [0, sin(frame.heading / 2), 0, cos(frame.heading / 2)] };
}

function frames(skeleton: HorseSkeleton, pose: HorsePose, root: BoneFrame): BoneFrame[] {
  const solved: BoneFrame[] = [];
  for (const [i, joint] of skeleton.joints.entries()) {
    const parent = solved[joint.parent] ?? root;
    solved.push({
      position: add(parent.position, rotateByQuaternion(horseJointTranslation(skeleton, pose, i), parent.rotation)),
      rotation: normalizeQuaternion(multiplyQuaternions(parent.rotation, pose.rotations[i]!)),
    });
  }
  return solved;
}

function inWorld(frame: BoneFrame, localOffset: Vec3): Vec3 {
  return add(frame.position, rotateByQuaternion(localOffset, frame.rotation));
}

/**
 * Builds a horse whose weighted mane, forelock and tail follow elastic strand guides. Call the horse's normal
 * `advanceTime` and `seek` methods to step or replay its native physics alongside its gait. Dispose as usual.
 */
export async function addStrandHorse(engine: Engine, options: StrandHorseOptions = {}): Promise<StrandHorse> {
  const { strands: settings, signal, ...appearance } = options;
  signal?.throwIfAborted();
  const [{ StrandSolver }, { PhysicsWorld }] = await Promise.all([
    import('@margoengine/physics/strands'),
    import('@margoengine/physics/world'),
  ]);
  const solver = await StrandSolver.load({ signal });
  const horse = await addHorse(engine, { ...appearance, strandRig: true });
  try {
    signal?.throwIfAborted();
    const skeleton = horse.skeleton,
      chains = skeleton.strandChains;
    if (!chains?.length)
      throw new RangeError(
        'Supply an authored skin with a tail, mane and forelock strand rig, or use the procedural horse.',
      );
    const world = new PhysicsWorld({ rate: { num: 240, den: 1 }, cellSize: settings?.cellSize });
    const body = horse.body,
      bodyJoint = skeleton.index('body'),
      neckJoint = skeleton.index('neck1'),
      headJoint = skeleton.index('head');
    const { tail, mane, ...params } = settings ?? {};
    const initial = frames(skeleton, horse.pose, placement(horse.frame()));
    let anchored = initial;
    const drafts = chains.map((chain, index): StrandSpec => {
      const root = chain[0]!;
      const inverse = conjugateQuaternion(initial[root]!.rotation);
      const material =
        index === 0
          ? { radius: 0.018, density: 1150, young: 32e6, dragWidth: 0.083, ...tail }
          : { radius: 0.0045, density: 1100, young: 60e6, dragWidth: 0.027, ...mane };
      return {
        ...material,
        points: chain.map((joint) => initial[joint]!.position),
        anchor: () => ({
          position: anchored[root]!.position,
          rotation: normalizeQuaternion(multiplyQuaternions(anchored[root]!.rotation, inverse)),
        }),
      };
    });
    const barrel = (): StrandCapsule => {
      const torso = anchored[bodyJoint]!;
      return {
        start: inWorld(torso, [0, 0, -0.3 * body.bodyLength]),
        end: inWorld(torso, [0, 0, 0.31 * body.bodyLength]),
        radius: 0.44 * body.chestDepth,
      };
    };
    const neck = (): StrandCapsule => ({
      start: anchored[neckJoint]!.position,
      end: anchored[headJoint]!.position,
      radius: 0.073 * body.withers,
    });
    world.add(solver, {
      ...params,
      strands: drafts,
      rate: 2,
      damping: params.damping ?? 5,
      rodSolve: params.rodSolve ?? 'local',
      colliders: [barrel, neck],
    });
    const initialState = world.takeSnapshot();
    const frameToBone = chains.map((chain, g) =>
      chain.map((joint, j) =>
        multiplyQuaternions(conjugateQuaternion(solver.sample(g, j).rotation), initial[joint]!.rotation),
      ),
    );
    horse.onStep(
      (_dt, actor) => {
        anchored = frames(skeleton, actor.pose, placement(actor.frame()));
        world.advance(Math.round(actor.time * 240));
      },
      () => {
        anchored = initial;
        world.restoreSnapshot(initialState.bytes);
      },
    );
    horse.onPose((pose, actor) => {
      const root = placement(actor.frame()),
        current = frames(skeleton, pose, root),
        rotations = [...pose.rotations];
      const translations = new Map(pose.jointTranslations);
      for (const [g, chain] of chains.entries())
        for (const [j, joint] of chain.entries()) {
          const sample = solver.sample(g, j),
            parent = current[skeleton.joints[joint]!.parent] ?? root;
          const rotation = normalizeQuaternion(multiplyQuaternions(sample.rotation, frameToBone[g]![j]!));
          const parentInverse = conjugateQuaternion(parent.rotation);
          rotations[joint] = normalizeQuaternion(multiplyQuaternions(parentInverse, rotation));
          translations.set(joint, rotateByQuaternion(subtract(sample.position, parent.position), parentInverse));
          current[joint] = { position: sample.position, rotation };
        }
      return { ...pose, rotations, jointTranslations: translations };
    });
    horse.advanceTime(0);
    return Object.assign(horse, { strandSolver: solver, strandWorld: world });
  } catch (error) {
    horse.dispose();
    throw error;
  }
}
