// Runtime pose mirroring: one clip serves both sides. Left and right bones trade places across the character's plane of
// symmetry. Their local axes rarely mirror each other, so each bone keeps a fixed correction, worked out once from the
// rest pose: with M the reflection and G a bone's rest rotation from the model root, C_j = (M G_i M)^-1 G_j for bone j
// and its partner i. A pose's local rotation L then mirrors to C_parent(j)^-1 (M L_i M) C_j, which gives back the rest
// pose exactly for the rest pose. A translation mirrors the same way, as a change from its bone's rest place, so a rig
// whose two sides differ slightly keeps its own proportions.
import { multiplyQuaternions, rotateByQuaternion } from '@margoengine/math/quat';
import type { Animator, Pose } from './index.js';

/** Options of {@link addMirror}. The Animator keeps the object and reads `enabled` and `states` every frame. */
export interface Mirror {
  /** Mirrors while true (default true). Call `smooth()` on an inertialization first for a soft swap. */
  enabled?: boolean;
  /** Only these states mirror. Default all. */
  states?: readonly string[] | null;
  /** Axis across the plane of symmetry, in the model's space (default `x`, for a glTF character facing +Z). */
  axis?: 'x' | 'y' | 'z';
  /** Each node's partner by glTF node index. Default {@link mirrorPairs} of the model's node names. */
  pairs?: ArrayLike<number>;
  /** Pair morph targets by name as well (default true); targets come from each mesh's `extras.targetNames`. */
  morphs?: boolean;
}

/** A mirror handle. */
export interface MirrorHandle {
  /** The partner of each glTF node; a node on the plane of symmetry is its own. */
  readonly pairs: Int32Array;
  /** Stops mirroring. */
  dispose(): void;
  [Symbol.dispose](): void;
}

const SIDES: readonly (readonly [RegExp, 'L' | 'R'])[] = [
  [/left/i, 'L'],
  [/right/i, 'R'],
  [/(^|[^a-z0-9])l(?=$|[^a-z0-9])/i, 'L'],
  [/(^|[^a-z0-9])r(?=$|[^a-z0-9])/i, 'R'],
];

/** A name's side and the name with its side taken out; null side for a name with none. */
function sideOf(name: string): { side: 'L' | 'R' | null; key: string } {
  for (const [pattern, side] of SIDES) {
    const match = pattern.exec(name);
    if (match) return { side, key: name.replace(pattern, (found, lead = '') => `${typeof lead === 'string' ? lead : ''}*`).toLowerCase() };
  }
  return { side: null, key: name.toLowerCase() };
}

/**
 * Finds left and right partners from names: `LeftArm` and `RightArm`, `arm.L` and `arm.R`, `leg_joint_L_1` and
 * `leg_joint_R_1`. Ids at the end of a name are ignored when names do not pair without them (`b_LeftArm_09` and
 * `b_RightArm_06`).
 * @returns Each name's partner index; a name with no partner is its own.
 */
export function mirrorPairs(names: readonly string[]): Int32Array {
  const pairs = Int32Array.from(names, (_, i) => i),
    entries = names.map((name, index) => ({ index, ...sideOf(name ?? '') })),
    match = (key: (entry: (typeof entries)[number]) => string) => {
      const lefts = new Map<string, number[]>(),
        rights = new Map<string, number[]>();
      for (const entry of entries) {
        if (!entry.side || pairs[entry.index] !== entry.index) continue;
        const list = entry.side === 'L' ? lefts : rights,
          found = list.get(key(entry));
        if (found) found.push(entry.index);
        else list.set(key(entry), [entry.index]);
      }
      for (const [name, left] of lefts) {
        const right = rights.get(name);
        if (left.length === 1 && right?.length === 1) {
          pairs[left[0]] = right[0];
          pairs[right[0]] = left[0];
        }
      }
    };
  match((entry) => entry.key);
  match((entry) => entry.key.replace(/[._-]?\d+$/, ''));
  return pairs;
}

/**
 * Mirrors `animator`'s pose left to right at run time, whatever clip plays: partners trade rotations and translations
 * across the plane of symmetry, with each bone's local axes accounted for from the rest pose, and morph targets trade
 * by name. It runs on the finished pose, before foot IK and solvers, so those still meet their targets. Root motion
 * travels mirrored too. Returns the handle; dispose it to stop.
 * @throws RangeError for pairs of the wrong size, or a bone whose parent is not the partner of its partner's parent.
 */
export function addMirror(animator: Animator, mirror: Mirror = {}): MirrorHandle {
  const model = animator.animation.model,
    nodes = model.nodes,
    count = nodes.length,
    axis = mirror.axis ?? 'x',
    parents = model.root.engine.store.parents,
    doc = model.asset.doc;
  if (axis !== 'x' && axis !== 'y' && axis !== 'z') throw new RangeError("Mirror axis must be 'x', 'y' or 'z'");
  const pairs = mirror.pairs
    ? Int32Array.from(mirror.pairs)
    : mirrorPairs((doc.nodes ?? []).map((node) => node.name ?? ''));
  if (pairs.length !== count || pairs.some((partner) => !(partner >= 0 && partner < count)))
    throw new RangeError(`Mirror pairs must hold a node index for each of the model's ${count} nodes`);
  const indexOf = new Map(nodes.map((node, i) => [node.id, i])),
    parentOf = nodes.map((node) => indexOf.get(parents[node.id]) ?? -1);
  for (let i = 0; i < count; i++) {
    const partner = pairs[i],
      above = parentOf[i],
      other = parentOf[partner];
    if (pairs[partner] !== i)
      throw new RangeError(`Mirror pairs must go both ways; node ${i} names ${partner}, which names ${pairs[partner]}`);
    if ((above === -1 ? -1 : pairs[above]) !== other)
      throw new RangeError(
        `Mirror needs both sides built alike; the parents of nodes ${i} and ${partner} are not partners, so pass pairs that make them so`,
      );
  }
  // The reflection of a rotation: M q M keeps the part along the axis and flips the rest.
  const sign = axis === 'x' ? [1, -1, -1, 1] : axis === 'y' ? [-1, 1, -1, 1] : [-1, -1, 1, 1],
    flip = axis === 'x' ? 0 : axis === 'y' ? 1 : 2,
    reflect = (q: ArrayLike<number>) => [q[0] * sign[0], q[1] * sign[1], q[2] * sign[2], q[3]],
    inverse = (q: ArrayLike<number>) => [-q[0], -q[1], -q[2], q[3]];
  // Rest rotations from the model root, parents first.
  const restWorld: number[][] = [];
  const worldOf = (i: number): number[] => {
    if (restWorld[i]) return restWorld[i];
    const local = animator.restRotation(i) as number[];
    return (restWorld[i] = parentOf[i] === -1 ? local.slice() : multiplyQuaternions(worldOf(parentOf[i]), local));
  };
  const corrections = nodes.map((_, j) =>
    multiplyQuaternions(inverse(reflect(worldOf(pairs[j]))), worldOf(j)),
  );
  const undo = corrections.map(inverse),
    restPlaces = nodes.map((_, i) => animator.restPosition(i)),
    identity = [0, 0, 0, 1],
    undoAbove = (j: number) => (parentOf[j] === -1 ? identity : undo[parentOf[j]]);
  /** Node `j`'s mirror of the change `change` in its partner's translation. */
  const mirrored = (j: number, change: number[]) => {
    const v = change.slice();
    v[flip] = -v[flip];
    return rotateByQuaternion(v, undoAbove(j));
  };
  // Morph targets by name: each morphing node's own list of partners.
  const morphPairs = new Map<number, Int32Array>();
  if (mirror.morphs ?? true)
    (doc.nodes ?? []).forEach((node, i) => {
      const names = node.mesh === undefined ? undefined : (doc.meshes?.[node.mesh]?.extras as { targetNames?: string[] })?.targetNames;
      if (!names) return;
      const partners = mirrorPairs(names);
      if (partners.some((partner, target) => partner !== target)) morphPairs.set(i, partners);
    });
  const positions = nodes.map(() => [0, 0, 0]),
    rotations = nodes.map(() => [0, 0, 0, 1]),
    scales = nodes.map(() => [1, 1, 1]);
  const active = () =>
    (mirror.enabled ?? true) && (!mirror.states || mirror.states.includes(animator.state));
  const removeStep = animator.addLateStep((pose: Pose) => {
    if (!active()) return;
    for (let j = 0; j < count; j++) {
      const i = pairs[j],
        rest = restPlaces[i],
        p = pose.position[i],
        change = mirrored(j, [p[0] - rest[0], p[1] - rest[1], p[2] - rest[2]]),
        own = restPlaces[j],
        out = positions[j];
      out[0] = own[0] + change[0];
      out[1] = own[1] + change[1];
      out[2] = own[2] + change[2];
      rotations[j] = multiplyQuaternions(multiplyQuaternions(undoAbove(j), reflect(pose.rotation[i])), corrections[j]);
      const s = pose.scale[i],
        o = scales[j];
      o[0] = s[0];
      o[1] = s[1];
      o[2] = s[2];
    }
    for (let j = 0; j < count; j++) {
      const p = pose.position[j],
        q = pose.rotation[j],
        s = pose.scale[j];
      for (let c = 0; c < 3; c++) {
        p[c] = positions[j][c];
        s[c] = scales[j][c];
      }
      for (let c = 0; c < 4; c++) q[c] = rotations[j][c];
    }
    for (const [node, partners] of morphPairs) {
      const weights = pose.weights.get(node);
      if (!weights || weights.length !== partners.length) continue;
      for (let a = 0; a < partners.length; a++) {
        const b = partners[a];
        if (b > a) [weights[a], weights[b]] = [weights[b], weights[a]];
      }
    }
  });
  // A mirrored clip travels mirrored: the root bone's parent space, then the opposite turn.
  const removeTravel = animator.addTravelStep((travel, joint) => {
    if (!active()) return;
    const change = mirrored(joint, [travel[0], travel[1], travel[2]]);
    travel[0] = change[0];
    travel[1] = change[1];
    travel[2] = change[2];
    if (axis !== 'y') travel[3] = -travel[3];
  });
  let removed = false;
  const dispose = () => {
    if (removed) return;
    removed = true;
    removeStep();
    removeTravel();
  };
  return { pairs, dispose, [Symbol.dispose]: dispose };
}
