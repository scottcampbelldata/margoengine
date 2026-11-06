// Root motion: the travel a clip gives its root (hips) bone is taken out of the pose and given to the character node
// instead, so a walk cycle plays in place while the character moves by exactly the clip's stride, through loops and
// blend trees. Kept out of the Animator class so an app that never uses it does not bundle it.
import type { Mesh, Vec3 } from '@margoengine/core/extension';
import { sampleTrackInto } from '@margoengine/animation/sampling';
import { treeWeights } from './blend.js';
import type { Animator } from './index.js';

/** Options for {@link addRootMotion}. */
export interface RootMotionOptions {
  /** glTF node index of the bone whose clip translation is the character's travel (the hips or a root bone). */
  joint: number;
  /** Node moved by the travel. Default the model's root node. */
  target?: Mesh;
  /** `xz` (default) takes the ground-plane travel and leaves the bone's height animated; `xyz` takes all of it. */
  axes?: 'xz' | 'xyz';
  /** Also take the bone's turn about +Y (yaw) and turn the target by it. Default false. */
  rotation?: boolean;
  /** Move the target (default true). False only reports the travel in `translation` and `yaw`, e.g. for a physics character controller. */
  apply?: boolean;
}

/** A root-motion handle: the last frame's travel, and its remover. */
export interface RootMotion {
  /** Last frame's travel in the target's parent space (what was added to the target's position). */
  readonly translation: Vec3;
  /** Last frame's turn about +Y, radians. */
  readonly yaw: number;
  /** Stops taking root motion; the bone animates its travel again. */
  dispose(): void;
  [Symbol.dispose](): void;
}

type Clip = Animator['animation']['clips'][number];
type Track = Clip['tracks'][number];

/** Yaw (about +Y) of a unit quaternion's forward (+Z) direction. */
const yawOf = (q: ArrayLike<number>): number => {
  const [x, y, z, w] = [q[0], q[1], q[2], q[3]];
  // Third column of the rotation matrix: where +Z goes.
  return Math.atan2(2 * (x * z + w * y), 1 - 2 * (x * x + y * y));
};
const wrap = (angle: number) => angle - 2 * Math.PI * Math.round(angle / (2 * Math.PI));

/**
 * Takes root motion from `animator`'s clips: every frame the travel the current state's clips give `options.joint`
 * between the previous and the current time (summed over loops and weighted by the blend tree) is removed from that
 * bone's pose and added to `options.target`, rotated into the target's parent space. With `rotation`, the bone's yaw
 * is taken the same way. A transition starts the new state's travel from its time 0; during a crossfade the travel
 * follows the new state. Returns the handle; dispose it to stop.
 * @throws RangeError for an invalid joint.
 */
export function addRootMotion(animator: Animator, options: RootMotionOptions): RootMotion {
  const model = animator.animation.model,
    nodes = model.nodes,
    joint = options?.joint;
  if (!Number.isInteger(joint) || joint < 0 || joint >= nodes.length)
    throw new RangeError(`Root motion joint ${joint} is not one of the model's ${nodes.length} glTF nodes`);
  const axes = options.axes ?? 'xz',
    turn = options.rotation ?? false,
    apply = options.apply ?? true,
    target = options.target ?? model.root;
  if (axes !== 'xz' && axes !== 'xyz') throw new RangeError("Root motion axes must be 'xz' or 'xyz'");
  if (typeof turn !== 'boolean' || typeof apply !== 'boolean')
    throw new TypeError('Root motion rotation and apply must be booleans');
  // Each clip's root translation and rotation tracks, found once.
  const tracks = new Map<Clip, { translation?: Track; rotation?: Track }>();
  for (const clip of animator.animation.clips) {
    const found: { translation?: Track; rotation?: Track } = {};
    for (const track of clip.tracks)
      if (track.node === joint && (track.path === 'translation' || track.path === 'rotation'))
        found[track.path] = track;
    tracks.set(clip, found);
  }
  const scratch3 = new Float32Array(3),
    scratch4 = new Float32Array(4),
    at = (track: Track, time: number, out: Float32Array) =>
      sampleTrackInto(track.times, track.values, track.width, time, track.interpolation, track.width === 4, out);
  const translation: [number, number, number] = [0, 0, 0];
  // Travel is measured from where the Animator is now, so a motion added mid-clip starts with no jump.
  let yaw = 0,
    lastState = animator.state,
    lastTime = animator.time,
    disposed = false;
  /** Travel of one clip from time a to time b (b >= a): whole loops plus the partial ones; adds weight x it. */
  const travel = (clip: Clip, a: number, b: number, weight: number, sum: number[], offset: number[]) => {
    const { translation: move, rotation: spin } = tracks.get(clip)!,
      loop = animator.animation.options.loop ?? true,
      d = clip.duration;
    const local = (time: number) => (loop && d > 0 ? time % d : Math.min(time, d)),
      loops = loop && d > 0 ? Math.floor(b / d) - Math.floor(a / d) : 0;
    if (move) {
      const start = Array.from(at(move, 0, scratch3)),
        end = Array.from(at(move, d, scratch3)),
        from = Array.from(at(move, local(a), scratch3)),
        to = Array.from(at(move, local(b), scratch3));
      for (let c = 0; c < 3; c++) {
        sum[c] += weight * (loops * (end[c] - start[c]) + to[c] - from[c]);
        offset[c] += weight * (to[c] - start[c]);
      }
    }
    if (spin && turn) {
      const start = yawOf(at(spin, 0, scratch4)),
        end = yawOf(at(spin, d, scratch4)),
        from = yawOf(at(spin, local(a), scratch4)),
        to = yawOf(at(spin, local(b), scratch4));
      sum[3] += weight * (loops * wrap(end - start) + wrap(to - from));
      offset[3] += weight * wrap(to - start);
    }
  };
  /** Travel of `state`'s clips, weighted, from state time `a` to `b`; false when no clip has weight. */
  const measure = (state: string, a: number, b: number, sum: number[], offset: number[]) => {
    const { clips, weights } = treeWeights(animator.options.states[state], animator.parameters);
    let total = 0;
    for (let i = 0; i < clips.length; i++) total += weights[i] > 0 ? weights[i] : 0;
    if (!(total > 0)) return false;
    for (let i = 0; i < clips.length; i++)
      if (weights[i] > 0) {
        const clip = animator.animation.clips.find((c) => c.name === clips[i])!;
        travel(
          clip,
          animator.clipTime(clips[i], a, state),
          animator.clipTime(clips[i], b, state),
          weights[i] / total,
          sum,
          offset,
        );
      }
    return true;
  };
  /** Keeps the bone in place: its pose less the travel since its clip's start. */
  const inPlace = (bone: number[], q: number[], offset: number[]) => {
    bone[0] -= offset[0];
    if (axes === 'xyz') bone[1] -= offset[1];
    bone[2] -= offset[2];
    if (turn && offset[3]) {
      const half = -offset[3] / 2,
        s = Math.sin(half),
        c = Math.cos(half);
      // (yaw by -offset) x q
      const x = c * q[0] + s * q[2],
        y = c * q[1] + s * q[3],
        z = c * q[2] - s * q[0],
        w = c * q[3] - s * q[1];
      q[0] = x;
      q[1] = y;
      q[2] = z;
      q[3] = w;
    }
  };
  const remove = animator.addPoseStep((position, rotation) => {
    const state = animator.state,
      time = animator.time,
      from = state === lastState && time >= lastTime ? lastTime : animator.entryTime;
    lastState = state;
    lastTime = time;
    const sum = [0, 0, 0, 0],
      offset = [0, 0, 0, 0];
    if (!measure(state, from, time, sum, offset)) return;
    inPlace(position[joint], rotation[joint], offset);
    if (axes === 'xz') sum[1] = 0;
    // The bone's travel is in its parent's space; carry it through world space into the target's parent space.
    const store = model.root.engine.store,
      parentOf = (mesh: Mesh) => store.parents[mesh.id],
      boneParent = parentOf(nodes[joint]),
      targetParent = parentOf(target),
      world = boneParent === -1 ? sum.slice(0, 3) : carry(store, boneParent, sum, false),
      moved = targetParent === -1 ? world : carry(store, targetParent, world, true);
    translation[0] = moved[0];
    translation[1] = moved[1];
    translation[2] = moved[2];
    yaw = turn ? sum[3] : 0;
    if (!apply) return;
    const t = store.transforms,
      id = target.id;
    target.setPosition([t.x[id] + moved[0], t.y[id] + moved[1], t.z[id] + moved[2]]);
    if (yaw) {
      const s = Math.sin(yaw / 2),
        c = Math.cos(yaw / 2),
        q = [t.qx[id], t.qy[id], t.qz[id], t.qw[id]];
      // q x (yaw about local +Y)
      target.setQuaternion([q[0] * c - q[2] * s, q[1] * c + q[3] * s, q[2] * c + q[0] * s, q[3] * c - q[1] * s]);
    }
  });
  // A crossfade that keeps the old state playing samples it past the pose step: the same travel comes out.
  const removeFade = animator.addFadeStep((position, rotation, state, time) => {
    const offset = [0, 0, 0, 0];
    if (measure(state, time, time, [0, 0, 0, 0], offset)) inPlace(position[joint], rotation[joint], offset);
  });
  const handle: RootMotion = {
    get translation() {
      return translation;
    },
    get yaw() {
      return yaw;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      remove();
      removeFade();
    },
    [Symbol.dispose]() {
      handle.dispose();
    },
  };
  return handle;
}

/**
 * `v` in node `id`'s local space carried out to world space (`out`) or, with `inverse`, a world vector carried into
 * node `id`'s local space, through the transform store's local rotations and scales (current this frame, unlike the
 * world matrices, which update after the pose).
 */
function carry(
  store: {
    parents: ArrayLike<number>;
    transforms: Animator['animation']['model']['root']['engine']['store']['transforms'];
  },
  id: number,
  v: ArrayLike<number>,
  inverse: boolean,
): number[] {
  const t = store.transforms,
    path: number[] = [];
  for (let at = id; at !== -1; at = store.parents[at]) path.push(at);
  if (inverse) path.reverse();
  let [x, y, z] = [v[0], v[1], v[2]];
  for (const n of path) {
    const s = [t.sx[n], t.sy[n], t.sz[n]];
    if (inverse && !(s[0] && s[1] && s[2]))
      throw new RangeError("Root motion target's parent has a zero scale; give it a nonzero scale");
    // Unit quaternion (conjugated for the inverse) rotating (x, y, z).
    const k = inverse ? -1 : 1,
      qx = t.qx[n] * k,
      qy = t.qy[n] * k,
      qz = t.qz[n] * k,
      qw = t.qw[n];
    if (!inverse) (x *= s[0]), (y *= s[1]), (z *= s[2]);
    const tx = 2 * (qy * z - qz * y),
      ty = 2 * (qz * x - qx * z),
      tz = 2 * (qx * y - qy * x);
    [x, y, z] = [x + qw * tx + qy * tz - qz * ty, y + qw * ty + qz * tx - qx * tz, z + qw * tz + qx * ty - qy * tx];
    if (inverse) (x /= s[0]), (y /= s[1]), (z /= s[2]);
  }
  return [x, y, z];
}
