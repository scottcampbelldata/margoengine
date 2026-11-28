// The bone a model's clips carry their travel on. A Mixamo or KayKit walk moves its hips; a Character Creator walk
// moves CC_Base_BoneRoot, the skin's top joint above the hips, and leaves the hips' own translation in place
// (KB-HUM-SKINDRIFT1), so taking the travel from the hips of such a rig takes nothing and the walk runs off ahead.
import { sampleTrackInto } from '@margoengine/animation/sampling';
import type { Animator } from './index.js';

/**
 * glTF node index of the bone whose clip translation is the travel: the node whose translation moves farthest from
 * its clip's start to its end, in any of `animation`'s clips; of nodes that move within 1 percent of that, the one
 * nearest the root. -1 when no clip moves any node. `addRootMotion` and `addWarping` use it when no joint is given.
 * @example
 * const joint = rootMotionJoint(animator.animation); // CC_Base_BoneRoot on a Character Creator walk, the hips on Mixamo
 */
export function rootMotionJoint(animation: Animator['animation']): number {
  const nodes = animation.model.nodes,
    store = animation.model.root.engine.store,
    index = new Map(nodes.map((node, i) => [node.id, i])),
    depth = (i: number) => {
      let n = 0;
      for (let at = store.parents[nodes[i].id]; at !== -1 && at !== undefined; at = store.parents[at]) n++;
      return n;
    },
    start = new Float32Array(3),
    end = new Float32Array(3),
    moved = new Map<number, number>();
  for (const clip of animation.clips)
    for (const track of clip.tracks) {
      if (track.path !== 'translation' || !(clip.duration > 0) || !index.has(nodes[track.node]?.id)) continue;
      const at = (time: number, out: Float32Array) =>
        sampleTrackInto(track.times, track.values, track.width, time, track.interpolation, false, out);
      at(0, start);
      at(clip.duration, end);
      const distance = Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]);
      if (distance > (moved.get(track.node) ?? 0)) moved.set(track.node, distance);
    }
  let far = 0;
  for (const distance of moved.values()) far = Math.max(far, distance);
  if (!(far > 0)) return -1;
  let best = -1;
  for (const [node, distance] of moved)
    if (distance >= far * 0.99 && (best === -1 || depth(node) < depth(best) || (depth(node) === depth(best) && node < best)))
      best = node;
  return best;
}
