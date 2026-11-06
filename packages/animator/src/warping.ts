// Warping: fits a clip to how the character really moves, so feet do not slide.
//
// Orientation warping turns the hips toward the direction of travel and hands the turn back along the spine, so a
// forward walk serves a strafe with the chest still facing front. Stride warping scales each foot's offset from the
// character along the direction of travel by actual speed over clip speed: a planted foot moves backward at clip speed
// in the clip, so at that ratio it stands still in the world. Past the ratio's limits the clip's rate makes up the rest.
// The pelvis drops when a longer stride would need legs longer than they are. Distance warping drives a stop or start
// clip by distance rather than time: the clip stands where its own root travel matches the distance left.
import type { Mesh, Vec3 } from '@margoengine/core/extension';
import { sampleTrackInto } from '@margoengine/animation/sampling';
import { finiteVector } from '@margoengine/math/validate';
import { treeWeights } from './blend.js';
import type { Animator } from './index.js';
import { position, poseTools } from './pose-tools.js';

/** One leg of {@link Warping}: a direct hip, knee, ankle chain. */
export interface WarpLeg {
  /** glTF node index of the hip (thigh) bone. */
  hip: number;
  /** glTF node index of the knee; a child of `hip`. */
  knee: number;
  /** glTF node index of the ankle; a child of `knee`. */
  ankle: number;
  /** World point the knee bends toward. Default: forward of the animated knee. */
  pole?: Vec3 | null;
}

/** Options of {@link addWarping}. The Animator keeps the object and reads it every frame. */
export interface Warping {
  /** glTF node index of the pelvis (hips) bone, an ancestor of every leg. */
  pelvis: number;
  /** The legs, 1-8. */
  legs: readonly WarpLeg[];
  /** How the character really moves, world units a second; write into it every frame. */
  velocity: Vec3;
  /**
   * The speed the current state's clips show, units a second. Default: measured from the `speedJoint` travel of the
   * state's clips, weighted by its blend tree. Set it for in-place clips, which have no travel to measure.
   */
  clipSpeed?: number;
  /** glTF node index of the bone whose clip translation is the travel (default `pelvis`). */
  speedJoint?: number;
  /** Node that stands for the character: its +Z is its facing, its position the stride's centre. Default the model's root. */
  character?: Mesh;
  /** Joints from the pelvis up that share the counter-turn, each a descendant of the last. Default none: the upper body turns with the hips. */
  spine?: readonly number[];
  /** Most the hips turn, radians, up to pi (default pi / 2). Past it a clip for that direction is needed. */
  maxTurn?: number;
  /** Seconds the hips take to settle on a new direction (default 0.1; 0 is instant). */
  turnTime?: number;
  /** Shortest stride as a fraction of the clip's, 0-1 (default 0.5). Below it the clip slows down. */
  minStride?: number;
  /** Longest stride as a multiple of the clip's, 1 or more (default 1.6). Above it the clip speeds up. */
  maxStride?: number;
  /** Change the clip's rate past the stride limits (default true). False leaves the feet to slide there. */
  adjustRate?: boolean;
  /** Most the pelvis may drop so legs can reach a longer stride, world units (default 0.2). */
  maxPelvisDrop?: number;
  /** Blend from the animated pose (0) to fully warped (1); default 1. */
  weight?: number;
}

/** A warping handle: what the last frame did, and its remover. */
export interface WarpingHandle {
  /** Last frame's stride as a multiple of the clip's. */
  readonly stride: number;
  /** Last frame's hip turn, radians, about world +Y. */
  readonly turn: number;
  /** The clip rate the warp has set. */
  readonly rate: number;
  /** Last frame's pelvis drop, world units, 0 or more. */
  readonly pelvisDrop: number;
  /** Removes the warp; the clip plays at its own rate and stride again. */
  dispose(): void;
  [Symbol.dispose](): void;
}

/** Options of {@link addDistanceWarp}. The Animator keeps the object and reads it every frame. */
export interface DistanceWarp {
  /** The state to drive; it must play one clip. */
  state: string;
  /** glTF node index of the bone whose clip translation is the travel. */
  joint: number;
  /** `stop` (default): `distance` is what is left to the stopping point. `start`: what has been covered since starting. */
  mode?: 'stop' | 'start';
  /** That distance, world units; write it every frame. */
  distance: number;
}

/** A distance warp handle. */
export interface DistanceWarpHandle {
  /** The clip's whole travel, units. */
  readonly length: number;
  /** Stops driving the state by distance. */
  dispose(): void;
  [Symbol.dispose](): void;
}

const UP = [0, 1, 0],
  yaw = (angle: number) => [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)];
const wrap = (angle: number) => angle - 2 * Math.PI * Math.round(angle / (2 * Math.PI));

type Clip = Animator['animation']['clips'][number];
const trackOf = (clip: Clip, joint: number) =>
  clip.tracks.find((track) => track.node === joint && track.path === 'translation');

/**
 * Adds orientation and stride warping to `animator`, solved every frame after the pose, layers, foot IK and the solvers
 * added before it. Write the character's real `velocity` into the object each frame: the hips turn toward it, up to
 * `maxTurn`, the spine hands the turn back, and each foot's stride scales by real speed over clip speed, with the pelvis
 * dropping when legs would not reach. Past `minStride` and `maxStride` the clip's rate changes instead, from the next
 * frame, so a stopped character stops stepping. Bones and their ancestors need positive scales. Returns the
 * handle; dispose it to stop.
 * @throws RangeError for invalid joints or settings; TypeError for a leg that is not a direct chain below the pelvis.
 */
export function addWarping(animator: Animator, warp: Warping): WarpingHandle {
  const model = animator.animation.model,
    nodes = model.nodes,
    parents = model.root.engine.store.parents,
    tools = poseTools(animator, 'Warping');
  const node = (index: unknown, label: string): Mesh => {
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= nodes.length)
      throw new RangeError(`Warping ${label} ${index} is not one of the model's ${nodes.length} glTF nodes`);
    return nodes[index as number];
  };
  const pelvis = node(warp?.pelvis, 'pelvis');
  if (!Array.isArray(warp.legs) || warp.legs.length < 1 || warp.legs.length > 8)
    throw new RangeError('Warping needs 1-8 legs: {legs: [{hip, knee, ankle}]}');
  const below = (bone: Mesh, ancestor: Mesh) => {
    let at = parents[bone.id];
    while (at !== -1 && at !== ancestor.id) at = parents[at];
    return at !== -1;
  };
  const legs = warp.legs.map((leg, i) => {
    const hip = node(leg?.hip, `leg ${i} hip`),
      knee = node(leg.knee, `leg ${i} knee`),
      ankle = node(leg.ankle, `leg ${i} ankle`);
    if (parents[knee.id] !== hip.id || parents[ankle.id] !== knee.id)
      throw new TypeError(
        `Warping leg ${i} is not a direct chain; pass a knee that is a child of the hip and an ankle that is a child of the knee`,
      );
    if (!below(hip, pelvis)) throw new TypeError(`Warping leg ${i} hip is not below the pelvis; pass the pelvis that carries both legs`);
    return { hip, knee, ankle };
  });
  const spine = (warp.spine ?? []).map((joint, i) => node(joint, `spine ${i}`));
  spine.forEach((joint, i) => {
    if (!below(joint, i ? spine[i - 1] : pelvis))
      throw new TypeError(`Warping spine ${i} is not below the joint before it; list joints from the pelvis up`);
  });
  const speedJoint = warp.speedJoint ?? warp.pelvis;
  node(speedJoint, 'speedJoint');
  const read = () => {
    const weight = warp.weight ?? 1,
      maxTurn = warp.maxTurn ?? Math.PI / 2,
      turnTime = warp.turnTime ?? 0.1,
      minStride = warp.minStride ?? 0.5,
      maxStride = warp.maxStride ?? 1.6,
      maxDrop = warp.maxPelvisDrop ?? 0.2;
    finiteVector(warp.velocity, 3, 'Warping velocity');
    if (!(weight >= 0 && weight <= 1)) throw new RangeError('Warping weight must be from 0 to 1');
    if (!(maxTurn >= 0 && maxTurn <= Math.PI)) throw new RangeError('Warping maxTurn must be from 0 to pi radians');
    if (!(turnTime >= 0 && turnTime < Infinity)) throw new RangeError('Warping turnTime must be 0 or more seconds');
    if (!(minStride > 0 && minStride <= 1)) throw new RangeError('Warping minStride must be above 0, at most 1');
    if (!(maxStride >= 1 && maxStride < Infinity)) throw new RangeError('Warping maxStride must be 1 or more');
    if (!(maxDrop >= 0 && maxDrop < Infinity)) throw new RangeError('Warping maxPelvisDrop must be 0 or more');
    if (warp.clipSpeed !== undefined && !(warp.clipSpeed >= 0 && warp.clipSpeed < Infinity))
      throw new RangeError('Warping clipSpeed must be 0 or more');
    return { weight, maxTurn, turnTime, minStride, maxStride, maxDrop };
  };
  read();
  // Travel speed of each clip, once.
  const speeds = new Map<string, number>(),
    start = new Float32Array(3),
    end = new Float32Array(3);
  for (const clip of animator.animation.clips) {
    const track = trackOf(clip, speedJoint);
    if (!track || !(clip.duration > 0)) continue;
    const at = (time: number, out: Float32Array) =>
      sampleTrackInto(track.times, track.values, track.width, time, track.interpolation, false, out);
    at(0, start);
    at(clip.duration, end);
    speeds.set(clip.name, Math.hypot(end[0] - start[0], end[2] - start[2]) / clip.duration);
  }
  const measured = (): number => {
    const { clips, weights } = treeWeights(animator.options.states[animator.state], animator.parameters);
    let total = 0,
      sum = 0;
    for (let i = 0; i < clips.length; i++)
      if (weights[i] > 0) {
        total += weights[i];
        sum += weights[i] * (speeds.get(clips[i]) ?? 0);
      }
    return total > 0 ? sum / total : 0;
  };
  const animated: number[][] = legs.map(() => [0, 0, 0, 1]);
  let stride = 1,
    turned = 0,
    rate = 1,
    drop = 0,
    removed = false;
  const remove = animator.addSolver((step) => {
    const { weight, maxTurn, turnTime, minStride, maxStride, maxDrop } = read(),
      character = warp.character ?? model.root,
      m = character.matrix,
      velocity = warp.velocity,
      speed = Math.hypot(velocity[0], velocity[2]);
    if (weight === 0) {
      animator.clipRate = rate = 1;
      stride = 1;
      turned = 0;
      drop = 0;
      return;
    }
    // Facing is the character's +Z on the ground plane.
    const facing = Math.atan2(m[8], m[10]);
    // 1. Hips toward the direction of travel, spine handing the turn back.
    const heading = speed > 1e-4 ? Math.atan2(velocity[0], velocity[2]) : facing,
      wanted = Math.max(-maxTurn, Math.min(maxTurn, wrap(heading - facing))) * weight,
      blend = turnTime > 0 ? 1 - Math.exp(-step / turnTime) : 1;
    turned += (wanted - turned) * blend;
    if (turned !== 0) {
      tools.turn(pelvis, yaw(turned));
      for (const joint of spine) tools.turn(joint, yaw(-turned / spine.length));
    }
    // 2. Stride: what the speeds ask for, what the limits allow, and the clip rate for the rest.
    const clipSpeed = warp.clipSpeed ?? measured(),
      ratio = clipSpeed > 0 ? speed / clipSpeed : 1,
      limited = Math.max(minStride, Math.min(maxStride, ratio));
    stride = 1 + (limited - 1) * weight;
    rate = (warp.adjustRate ?? true) && clipSpeed > 0 ? 1 + (ratio / limited - 1) * weight : 1;
    animator.clipRate = rate;
    const dx = speed > 1e-4 ? velocity[0] / speed : Math.sin(facing + turned),
      dz = speed > 1e-4 ? velocity[2] / speed : Math.cos(facing + turned),
      px = m[12],
      pz = m[14],
      targets: Vec3[] = legs.map(({ ankle }, i) => {
        const a = position(ankle),
          along = ((a[0] - px) * dx + (a[2] - pz) * dz) * (stride - 1);
        animated[i] = tools.rotationOf(ankle.matrix);
        return [a[0] + dx * along, a[1], a[2] + dz * along];
      });
    // 3. The pelvis drops by what the longest reach is short of.
    drop = 0;
    legs.forEach(({ hip, knee, ankle }, i) => {
      const h = position(hip),
        k = position(knee),
        a = position(ankle),
        reach = Math.hypot(k[0] - h[0], k[1] - h[1], k[2] - h[2]) + Math.hypot(a[0] - k[0], a[1] - k[1], a[2] - k[2]),
        t = targets[i],
        flat = Math.hypot(t[0] - h[0], t[2] - h[2]);
      if (flat >= reach || Math.hypot(flat, t[1] - h[1]) <= reach) return;
      drop = Math.max(drop, h[1] - t[1] - Math.sqrt(reach * reach - flat * flat));
    });
    drop = Math.min(drop, maxDrop);
    if (drop > 0) tools.moveBy(pelvis, [0, -drop, 0]);
    // 4. Legs to their targets, feet keeping their world rotation.
    legs.forEach(({ hip, knee, ankle }, i) => {
      const pole = warp.legs[i].pole,
        k = position(knee),
        ahead = Math.hypot(k[0] - position(hip)[0], k[1] - position(hip)[1], k[2] - position(hip)[2]);
      tools.placeLimb(
        hip,
        knee,
        ankle,
        targets[i],
        pole ?? [k[0] + Math.sin(facing + turned) * ahead, k[1], k[2] + Math.cos(facing + turned) * ahead],
      );
      tools.setWorldRotation(ankle, animated[i]);
    });
  });
  const dispose = () => {
    if (removed) return;
    removed = true;
    remove();
    animator.clipRate = 1;
  };
  return {
    get stride() {
      return stride;
    },
    get turn() {
      return turned;
    },
    get rate() {
      return rate;
    },
    get pelvisDrop() {
      return drop;
    },
    dispose,
    [Symbol.dispose]: dispose,
  };
}

/**
 * Drives a stop or start clip by distance on `animator`: while in `warp.state`, the clip stands where the travel of
 * `warp.joint` in the clip matches `warp.distance`, so a stop lands on its mark from any speed with no slide. Time only
 * runs forward; a distance longer than the clip holds its first frame until the character is in range. Returns the
 * handle; dispose it to go back to time.
 * @throws RangeError for an unknown state, a state with a blend tree or another clock, or a clip with no travel on `joint`.
 */
export function addDistanceWarp(animator: Animator, warp: DistanceWarp): DistanceWarpHandle {
  const state = warp?.state;
  if (!Object.hasOwn(animator.options.states, state))
    throw new RangeError(`Distance warp state "${state}" is not one of this Animator's states; pass a key of options.states`);
  const name = animator.options.states[state];
  if (typeof name !== 'string') throw new RangeError(`Distance warp state "${state}" plays a blend; pass a state that plays one clip`);
  if (animator.hasStateClock(state))
    throw new RangeError(`Distance warp state "${state}" already has a clock; dispose the group or warp that drives it first`);
  const clip = animator.animation.clips.find((c) => c.name === name)!,
    track = trackOf(clip, warp.joint);
  if (warp.mode !== undefined && warp.mode !== 'stop' && warp.mode !== 'start')
    throw new RangeError("Distance warp mode must be 'stop' or 'start'");
  if (!track) throw new RangeError(`Distance warp clip "${name}" has no translation on joint ${warp.joint}; pass the bone that carries its travel`);
  // Keyed travel along the ground, summed so it only ever grows.
  const times = Array.from(track.times),
    travelled = new Float64Array(times.length),
    a = new Float32Array(3),
    b = new Float32Array(3);
  sampleTrackInto(track.times, track.values, track.width, times[0], track.interpolation, false, a);
  for (let i = 1; i < times.length; i++) {
    sampleTrackInto(track.times, track.values, track.width, times[i], track.interpolation, false, b);
    travelled[i] = travelled[i - 1] + Math.hypot(b[0] - a[0], b[2] - a[2]);
    a.set(b);
  }
  const length = travelled[times.length - 1];
  if (!(length > 0)) throw new RangeError(`Distance warp clip "${name}" does not travel on joint ${warp.joint}; pass the bone that carries its travel`);
  /** Clip seconds at `covered` units of travel. */
  const timeAt = (covered: number): number => {
    if (covered <= 0) return times[0];
    if (covered >= length) return times[times.length - 1];
    let low = 0,
      high = times.length - 1;
    while (low + 1 < high) {
      const mid = (low + high) >>> 1;
      if (travelled[mid] <= covered) low = mid;
      else high = mid;
    }
    const span = travelled[high] - travelled[low];
    return times[low] + (span > 0 ? (covered - travelled[low]) / span : 0) * (times[high] - times[low]);
  };
  animator.setStateClock(state, {
    advance(time) {
      const distance = warp.distance;
      if (!Number.isFinite(distance) || distance < 0) throw new RangeError('Distance warp distance must be 0 or more');
      return Math.max(time, timeAt((warp.mode ?? 'stop') === 'stop' ? length - distance : distance));
    },
    clipTime: (_, time) => time,
  });
  let removed = false;
  const dispose = () => {
    if (removed) return;
    removed = true;
    animator.setStateClock(state, null);
  };
  return { length, dispose, [Symbol.dispose]: dispose };
}
