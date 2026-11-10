// Internal task planning and packing. Reuse the existing binned SAH builder at every level.
import { buildBVH, INTERNAL_FLAG, resolveOptions, type BVHBuildOptions, type BVHData } from './build.js';
import type { BVHPositions } from './bvh.js';

export interface BuildPart {
  node: number;
  offset: number;
  count: number;
  depth: number;
}
export interface BuildPlan {
  top: BVHData;
  parts: BuildPart[];
}

export function planBuild(
  positions: BVHPositions,
  stride: number,
  indices: Uint32Array | null,
  options: BVHBuildOptions,
  workers: number,
): BuildPlan {
  const resolved = resolveOptions(options);
  const depth = Math.min(resolved.maxDepth, Math.max(1, Math.ceil(Math.log2(workers * 4))));
  const top = buildBVH(positions, stride, indices, { ...resolved, maxDepth: depth });
  const words = new Uint32Array(top.nodes),
    parts: BuildPart[] = [];
  const visit = (node: number, level: number): void => {
    const tag = words[node * 8 + 7];
    if (tag & INTERNAL_FLAG) {
      visit(node + 1, level + 1);
      visit(words[node * 8 + 6], level + 1);
    } else if (tag > resolved.maxLeafTriangles && level < resolved.maxDepth) {
      parts.push({ node, offset: words[node * 8 + 6], count: tag, depth: level });
    }
  };
  visit(0, 0);
  return { top, parts };
}

export function mergeBuild(plan: BuildPlan, results: BVHData[]): BVHData {
  const { top, parts } = plan;
  const replacements = new Map(parts.map((part, i) => [part.node, { part, result: results[i] }]));
  const count = top.nodes.byteLength / 32 + results.reduce((sum, result) => sum + result.nodes.byteLength / 32 - 1, 0);
  const nodes = new ArrayBuffer(count * 32),
    words = new Uint32Array(nodes);
  const original = new Uint32Array(top.nodes),
    index = top.index.slice(),
    triangles = top.triangles.slice();
  let next = 0;
  const visit = (node: number): void => {
    const replacement = replacements.get(node);
    if (replacement) {
      const { part, result } = replacement,
        start = next,
        source = new Uint32Array(result.nodes);
      words.set(source, start * 8);
      for (let i = 0; i < source.length; i += 8) {
        words[start * 8 + i + 6] += source[i + 7] & INTERNAL_FLAG ? start : part.offset;
      }
      next += source.length / 8;
      index.set(result.index, part.offset * 3);
      for (let i = 0; i < part.count; i++)
        triangles[part.offset + i] = top.triangles[part.offset + result.triangles[i]];
    } else {
      const out = next++;
      words.set(original.subarray(node * 8, node * 8 + 8), out * 8);
      if (original[node * 8 + 7] & INTERNAL_FLAG) {
        visit(node + 1);
        words[out * 8 + 6] = next;
        visit(original[node * 8 + 6]);
      }
    }
  };
  visit(0);
  return { nodes, index, triangles };
}
