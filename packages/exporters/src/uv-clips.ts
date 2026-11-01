// What the engine UV exports share: a scene's material animations as per-material key lists, each with the node paths
// that draw that material, and every node's collision tag. Godot has its own player (godot-flipbook).
import { collisionBase, collisionTag, type CollisionTag } from './import-names.js';
import type { ExportNode, ExportScene, MaterialAnimationData, MaterialData } from './scene.js';

/** One held state of a UV clip: from `time` until the next key. */
export interface UVKey {
  /** Seconds. */
  time: number;
  offset: [number, number];
  scale: [number, number];
}
/** One material's part of a UV clip. */
export interface UVClip {
  clip: string;
  material: MaterialData;
  materialName: string;
  /** Slash-joined node names from the scene root, of every node that draws the material. */
  paths: string[];
  keys: UVKey[];
}

function walk(nodes: readonly ExportNode[], visit: (node: ExportNode, path: string) => void, prefix = ''): void {
  for (const node of nodes) {
    const path = `${prefix}${node.name ?? ''}`;
    visit(node, path);
    if (node.children) walk(node.children, visit, `${path}/`);
  }
}

/**
 * Every material animation channel of a scene, grouped by clip and material. Offset and scale keys merge in time order,
 * each holding its last value.
 * @throws TypeError for a clip Margo cannot map, naming the fix: a channel that is not a STEP base-color offset or scale,
 * or a material no node draws.
 */
export function uvClips(scene: ExportScene): UVClip[] {
  const animations: readonly MaterialAnimationData[] = scene?.materialAnimations ?? [],
    users = new Map<MaterialData, string[]>();
  walk(scene?.nodes ?? [], (node, path) => {
    for (const material of [node.material, ...(node.primitives ?? []).map((p) => p.material)]) {
      if (!material) continue;
      const paths = users.get(material as MaterialData) ?? [];
      if (!paths.includes(path)) paths.push(path);
      users.set(material as MaterialData, paths);
    }
  });
  return animations.flatMap((animation, a) => {
    const clip = animation.name ?? `clip${a}`,
      byMaterial = new Map<MaterialData, MaterialAnimationData['channels'][number][]>();
    for (const channel of animation.channels) {
      if (channel.interpolation !== 'STEP')
        throw new TypeError(`UV clip ${clip} has ${channel.interpolation} keys; bake it to STEP cels first`);
      if (channel.texture !== 'baseColorTexture' || (channel.property !== 'offset' && channel.property !== 'scale'))
        throw new TypeError(
          `UV clip ${clip} animates ${channel.texture} ${channel.property}; animate base-color offset or scale`,
        );
      const list = byMaterial.get(channel.material) ?? [];
      list.push(channel);
      byMaterial.set(channel.material, list);
    }
    return [...byMaterial].map(([material, channels]): UVClip => {
      const materialName = material.name ?? `material${a}`,
        paths = users.get(material);
      if (!paths)
        throw new TypeError(
          `UV clip ${clip} animates ${materialName}, which no node draws; assign it or drop the channel`,
        );
      const times = [...new Set(channels.flatMap((channel) => Array.from(channel.times)))].sort((p, q) => p - q),
        held = (property: 'offset' | 'scale', time: number, fallback: [number, number]): [number, number] => {
          const channel = channels.find((c) => c.property === property);
          if (!channel) return fallback;
          let at = 0;
          for (let i = 0; i < channel.times.length && channel.times[i] <= time; i++) at = i;
          return [channel.values[at * 2], channel.values[at * 2 + 1]];
        };
      return {
        clip,
        material,
        materialName,
        paths,
        keys: times.map((time) => ({ time, offset: held('offset', time, [0, 0]), scale: held('scale', time, [1, 1]) })),
      };
    });
  });
}

/** A node whose name carries a collision suffix. */
export interface CollisionNode {
  /** The node's name, with its suffix. */
  name: string;
  /** Without the suffix. */
  base: string;
  tag: CollisionTag;
  /** True for `-convcol` and `-convcolonly`. */
  convex: boolean;
  /** False for `-colonly` and `-convcolonly`: the node is a collider and never draws. */
  visible: boolean;
  path: string;
}

/** Every node of a scene whose name carries a collision suffix, in scene order. */
export function collisionNodes(scene: ExportScene): CollisionNode[] {
  const out: CollisionNode[] = [];
  walk(scene?.nodes ?? [], (node, path) => {
    const tag = node.name ? collisionTag(node.name) : null;
    if (tag)
      out.push({
        name: node.name!,
        base: collisionBase(node.name!),
        tag,
        convex: tag.startsWith('conv'),
        visible: !tag.endsWith('only'),
        path,
      });
  });
  return out;
}
