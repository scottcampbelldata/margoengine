// MSFT_lod under @margoengine/gltf/progressive: the loading order of each object's levels (coarsest first, as the
// extension's specification suggests for progressive loading) and which level shows until all of them have arrived.
// Internal: not an entry.
// Microsoft, "MSFT_lod" glTF 2.0 vendor extension, 2017,
// https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Vendor/MSFT_lod
import type { engineRuntime } from '@margoengine/core/extension';
import { worldRadius } from '../../shared/sphere.js';
import type { PBRModel } from './model.js';

/** What `LODSystem` asks a level before it shows it (`DeferredLevel.request` of @margoengine/lod). */
type Askable = { request?: () => boolean };

export function levelOrder(model: PBRModel, engine: ReturnType<typeof engineRuntime>) {
  const doc = model.asset.doc,
    nodes = model['nodes'],
    keys = new Map<object, number>();
  let count = 0;
  for (const mesh of doc.meshes ?? []) for (const p of mesh?.primitives ?? []) keys.set(p, count++);
  const arrived = new Set<number>(),
    inLevel = new Set<number>();
  const groups = model.lods.map((lod) => {
    const ids = lod.levels.map((node) => nodes.indexOf(node)),
      others = new Set(ids);
    // The primitives each level draws: its node's and its descendants', but not another level's.
    const levels = ids.map((id) => {
      const subtree = new Set<number>(),
        stack = [id];
      while (stack.length) {
        const at = stack.pop()!;
        if (subtree.has(at)) continue;
        subtree.add(at);
        for (const child of doc.nodes?.[at]?.children ?? []) if (!others.has(child)) stack.push(child);
      }
      const drawn = new Set<number>();
      for (const p of model.primitives) if (subtree.has(p.nodeIndex)) drawn.add(keys.get(p.definition)!);
      for (const key of drawn) inLevel.add(key);
      return drawn;
    });
    // The coarsest level that draws something (a last level may be empty, to hide the object).
    let coarsest = levels.length - 1;
    while (coarsest > 0 && !levels[coarsest].size) coarsest--;
    return { lod, levels, coarsest, visible: lod.levels[0].visible, taken: false };
  });
  type Group = (typeof groups)[number];
  const whole = (group: Group, level: number) => [...group.levels[level]].every((key) => arrived.has(key));
  const show = (group: Group, level: number) =>
    group.lod.levels.forEach((node, i) => {
      node.visible = i === level && group.visible;
    });
  for (const group of groups)
    group.lod.levels.forEach((node, level) => {
      // An LOD system asks before it shows a level. The first question hands it the object: this stops switching.
      (node as Askable).request = () => {
        if (!group.taken) {
          group.taken = true;
          for (const each of group.lod.levels) each.visible = false;
        }
        // Before anything has arrived, the coarsest level's stand-in boxes can show.
        return (
          whole(group, level) ||
          (level === group.coarsest && !group.levels.some((drawn, i) => drawn.size && whole(group, i)))
        );
      };
    });
  return {
    /** A primitive has all its geometry: each object not taken over shows its finest level that has. */
    arrived(key: number): void {
      arrived.add(key);
      for (const group of groups) {
        if (group.taken) continue;
        const finest = group.levels.findIndex((drawn, i) => drawn.size > 0 && whole(group, i));
        show(group, Math.max(finest, 0));
      }
    },
    /**
     * Raises each key's view score (0 to 2) by its tier: 8 for what the first whole picture needs (no levels, or a
     * coarsest level), 4 for the level this view calls for, else under 4 with coarser levels first.
     */
    rank(score: Float64Array): void {
      if (!groups.length) return;
      const tier = new Float64Array(score.length).fill(0);
      for (let key = 0; key < score.length; key++) if (!inLevel.has(key)) tier[key] = 8;
      const c = engine.camera.matrix,
        yScale = Math.hypot(c[1], c[5], c[9]);
      for (const group of groups) {
        // The finest level's size on screen, as LODSystem measures `screen` levels: radius * y scale / clip w.
        let screen = 0;
        for (const p of model.primitives) {
          if (!group.levels[0].has(keys.get(p.definition)!)) continue;
          const v = p.vertices,
            m = p.node.matrix,
            lo = [Infinity, Infinity, Infinity],
            hi = [-Infinity, -Infinity, -Infinity];
          // The stand-in box's 24 corners (or the geometry that has replaced it).
          for (let i = 0; i < v.length; i += 20)
            for (let a = 0; a < 3; a++) {
              lo[a] = Math.min(lo[a], v[i + a]);
              hi[a] = Math.max(hi[a], v[i + a]);
            }
          const at = [0, 1, 2].map(
              (r) =>
                (m[r] * (lo[0] + hi[0])) / 2 +
                (m[4 + r] * (lo[1] + hi[1])) / 2 +
                (m[8 + r] * (lo[2] + hi[2])) / 2 +
                m[12 + r],
            ),
            half = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2,
            radius = worldRadius(m, 0, half, at[0], at[1], at[2]),
            w = Math.abs(c[3] * at[0] + c[7] * at[1] + c[11] * at[2] + c[15]);
          screen = Math.max(screen, (yScale * radius) / Math.max(w, 1e-9));
        }
        const coverage = group.lod.screenCoverage;
        let wanted = 0;
        for (let i = 1; i < group.levels.length; i++)
          if (screen <= (coverage?.[i - 1] ?? 0.25 * 0.5 ** (i - 1))) wanted = i;
        group.levels.forEach((drawn, level) => {
          const own = level === group.coarsest ? 8 : level === wanted ? 4 : (2 * level) / group.levels.length;
          for (const key of drawn) tier[key] = Math.max(tier[key], own);
        });
      }
      for (let key = 0; key < score.length; key++) score[key] += tier[key];
    },
    /** The load is over: no level is waited for, and an object not taken over shows its level 0 as loaded. */
    release(): void {
      for (const group of groups) {
        for (const node of group.lod.levels) delete (node as Askable).request;
        if (!group.taken) show(group, 0);
      }
    },
  };
}
