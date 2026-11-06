// Foot placement: legs follow uneven ground while the clip keeps its stride. Each foot is raised or lowered by how far
// the ground under it is from the character's flat ground (so a swing foot still lifts), the pelvis drops so the
// lowest foot can reach, and two-bone IK bends each leg. Kept out of the Animator class so an app that never adds it
// does not bundle it.
import type { Mesh, Vec3 } from '@margoengine/core/extension';
import { multiplyQuaternions } from '@margoengine/math/quat';
import { finiteVector } from '@margoengine/math/validate';
import { quaternionBlend } from './blend.js';
import { rotationBetween } from './ik.js';
import type { Animator, GroundHit } from './index.js';
import { poseTools } from './pose-tools.js';

/** One leg of {@link FootPlacement}: a direct hip, knee, ankle chain. */
export interface PlacedLeg {
  /** glTF node index of the hip (thigh) bone. */
  hip: number;
  /** glTF node index of the knee; a child of `hip`. */
  knee: number;
  /** glTF node index of the ankle; a child of `knee`. */
  ankle: number;
  /** World point the knee bends toward; mutate it per frame (for example in front of the character). */
  pole: Vec3;
}

/** Options of {@link addFootPlacement}. The Animator keeps the object and reads it every frame. */
export interface FootPlacement {
  /** glTF node index of the pelvis (hips) bone, an ancestor of every leg. It drops so the lowest foot reaches. */
  pelvis: number;
  /** The legs, 1-8. */
  legs: readonly PlacedLeg[];
  /** Casts a ray from a world-space `origin` along `direction` (down); returns the hit or `null` (no change). */
  raycast: (origin: Vec3, direction: Vec3) => GroundHit | null;
  /** Node whose world height is the flat ground the clips were made on (default the model's root node). */
  ground?: Mesh;
  /** How far above the ankle the ray starts, metres (default 0.5). Higher steps than this are not found. */
  probeHeight?: number;
  /** How far below the ankle the ray reaches, metres (default 0.5): the deepest drop a foot follows. */
  probeDepth?: number;
  /** Most the pelvis may drop, metres (default 0.5). */
  maxPelvisDrop?: number;
  /** Tilt each foot to the ground normal (default true). */
  alignFeet?: boolean;
  /** Blend from the animated pose (0) to fully placed (1); default 1. */
  weight?: number;
}

/** A foot-placement handle: what the last frame did, and its remover. */
export interface FootPlacementHandle {
  /** Last frame's pelvis offset in metres (0 or negative: how far the pelvis dropped). */
  readonly pelvisOffset: number;
  /** Last frame's per-leg vertical foot offsets in metres, index-aligned with `legs` (0 where nothing was hit). */
  readonly footOffsets: readonly number[];
  /** Removes the placement; the legs play their animated pose again. */
  dispose(): void;
  [Symbol.dispose](): void;
}

const UP: Vec3 = [0, 1, 0],
  DOWN: Vec3 = [0, -1, 0];

/**
 * Adds foot placement to `animator`, solved every frame after the pose, layers, foot IK and the solvers added before
 * it. For each leg a ray is cast down through the animated ankle; the foot moves up or down by the hit's height above
 * the `ground` node (the flat floor the clip was made on), so stairs and slopes raise and lower feet while lifted swing
 * feet stay lifted. The pelvis drops by the largest downward offset (at most `maxPelvisDrop`) so that foot can reach,
 * then two-bone IK bends every leg toward its pole and, with `alignFeet`, tilts each planted foot to the surface.
 * Bones and their ancestors need positive uniform scales. Returns the handle; dispose it to stop.
 * @throws RangeError for invalid joints or settings; TypeError for a leg that is not a direct chain below the pelvis.
 */
export function addFootPlacement(animator: Animator, placement: FootPlacement): FootPlacementHandle {
  const model = animator.animation.model,
    nodes = model.nodes,
    parents = model.root.engine.store.parents,
    { rotationOf, setWorldRotation, moveBy, placeLimb } = poseTools(animator, 'Foot placement');
  const node = (index: unknown, label: string): Mesh => {
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= nodes.length)
      throw new RangeError(`Foot placement ${label} ${index} is not one of the model's ${nodes.length} glTF nodes`);
    return nodes[index as number];
  };
  const pelvis = node(placement?.pelvis, 'pelvis'),
    legs = placement.legs;
  if (!Array.isArray(legs) || legs.length < 1 || legs.length > 8)
    throw new RangeError('Foot placement needs 1-8 legs: {legs: [{hip, knee, ankle, pole}]}');
  if (typeof placement.raycast !== 'function')
    throw new TypeError('Foot placement needs a raycast(origin, direction) function that returns {position} or null');
  const chains = legs.map((leg, i) => {
    const hip = node(leg?.hip, `leg ${i} hip`),
      knee = node(leg.knee, `leg ${i} knee`),
      ankle = node(leg.ankle, `leg ${i} ankle`);
    if (parents[knee.id] !== hip.id || parents[ankle.id] !== knee.id)
      throw new TypeError(
        `Foot placement leg ${i} is not a direct chain; pass a knee that is a child of the hip and an ankle that is a child of the knee`,
      );
    let at = parents[hip.id];
    while (at !== -1 && at !== pelvis.id) at = parents[at];
    if (at === -1 && hip !== pelvis)
      throw new TypeError(
        `Foot placement leg ${i} hip is not below the pelvis; pass the pelvis that carries both legs`,
      );
    return { hip, knee, ankle };
  });
  const read = () => {
    const weight = placement.weight ?? 1,
      probeHeight = placement.probeHeight ?? 0.5,
      probeDepth = placement.probeDepth ?? 0.5,
      maxDrop = placement.maxPelvisDrop ?? 0.5;
    if (!(weight >= 0 && weight <= 1)) throw new RangeError('Foot placement weight must be from 0 to 1');
    if (!(probeHeight > 0 && probeHeight < Infinity) || !(probeDepth >= 0 && probeDepth < Infinity))
      throw new RangeError('Foot placement probeHeight must be above 0 and probeDepth 0 or more, in metres');
    if (!(maxDrop >= 0 && maxDrop < Infinity)) throw new RangeError('Foot placement maxPelvisDrop must be 0 or more');
    for (const leg of legs) finiteVector(leg.pole, 3, 'Foot placement pole');
    return { weight, probeHeight, probeDepth, maxDrop };
  };
  read();
  const offsets = legs.map(() => 0),
    normals: (Vec3 | null)[] = legs.map(() => null),
    animated: number[][] = legs.map(() => [0, 0, 0]),
    rotations: number[][] = legs.map(() => [0, 0, 0, 1]);
  let pelvisOffset = 0,
    removed = false;
  const remove = animator.addSolver(() => {
    const { weight, probeHeight, probeDepth, maxDrop } = read();
    pelvisOffset = 0;
    offsets.fill(0);
    if (weight === 0) return;
    const ground = (placement.ground ?? model.root).matrix[13];
    // 1. Where the ground is under each animated ankle, relative to the flat floor the clip was made on.
    let drop = 0;
    for (let i = 0; i < chains.length; i++) {
      const m = chains[i].ankle.matrix,
        a = animated[i];
      a[0] = m[12];
      a[1] = m[13];
      a[2] = m[14];
      rotations[i] = rotationOf(m);
      normals[i] = null;
      const hit = placement.raycast([a[0], a[1] + probeHeight, a[2]], DOWN);
      if (!hit) continue;
      finiteVector(hit.position, 3, 'Ground hit');
      if (hit.normal) finiteVector(hit.normal, 3, 'Ground normal');
      const offset = hit.position[1] - ground;
      if (offset < -probeDepth || hit.position[1] > a[1] + probeHeight) continue;
      offsets[i] = offset * weight;
      normals[i] = hit.normal ?? null;
      drop = Math.min(drop, offsets[i]);
    }
    // 2. Drop the pelvis so the lowest foot can reach.
    pelvisOffset = Math.max(drop, -maxDrop);
    if (pelvisOffset !== 0) moveBy(pelvis, [0, pelvisOffset, 0]);
    // 3. Bend each leg so its ankle lands at the animated position plus its offset.
    for (let i = 0; i < chains.length; i++) {
      if (offsets[i] === 0 && pelvisOffset === 0 && !normals[i]) continue;
      const { hip, knee, ankle } = chains[i],
        a = animated[i],
        target: Vec3 = [a[0], a[1] + offsets[i], a[2]];
      placeLimb(hip, knee, ankle, target, legs[i].pole);
      // The foot keeps its animated world orientation (the leg's turn would carry it along), tilted to the slope.
      const normal = normals[i];
      let world = rotations[i];
      if (normal && (placement.alignFeet ?? true)) {
        const tilt = rotationBetween(UP, normal);
        world = multiplyQuaternions(weight < 1 ? quaternionBlend([0, 0, 0, 1], tilt, weight) : tilt, world);
      }
      setWorldRotation(ankle, world);
    }
  });
  const dispose = () => {
    if (removed) return;
    removed = true;
    remove();
  };
  return {
    get pelvisOffset() {
      return pelvisOffset;
    },
    footOffsets: offsets,
    dispose,
    [Symbol.dispose]: dispose,
  };
}
