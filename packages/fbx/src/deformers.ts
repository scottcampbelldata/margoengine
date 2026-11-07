// FBX skinning modes and in-between blend shapes. The fields follow the FbxSkin, FbxCluster and FbxBlendShapeChannel class
// reference; what a Blend skin and an in-between do between their numbers is checked against frames Maya wrote.
import { array, findChild, type FBXNode } from './document.js';
import type { ExtensionHooks, FBXExtension, SkinRead } from './extension.js';

/** Shapes of one channel with the percent each is at full strength, lowest first. */
function inbetweens(channel: FBXNode, sources: readonly FBXNode[]): { shape: FBXNode; percent: number }[] {
  const full = findChild(channel, 'FullWeights') ? Array.from(array(channel, 'FullWeights')) : [];
  if (full.length !== sources.length || full.some((v) => !Number.isFinite(v)))
    throw new RangeError('Invalid FBX blend shape weights; re-export the file, it looks damaged');
  return sources.map((shape, i) => ({ shape, percent: full[i] })).sort((a, b) => a.percent - b.percent);
}

/**
 * The weight of the shape at `percent` when the channel stands at `value`: the channel walks in straight lines from
 * stop to stop, with the base shape as a stop at 0, and goes on along its end segments beyond the last stops.
 */
export function inbetweenWeight(stops: readonly number[], percent: number, value: number): number {
  const all = [...new Set([...stops, 0])].sort((a, b) => a - b);
  let at = 0;
  while (at < all.length - 2 && value > all[at + 1]) at++;
  const a = all[at],
    b = all[at + 1],
    t = (value - a) / (b - a);
  return percent === a ? 1 - t : percent === b ? t : 0;
}

/** Records what a glTF skin cannot say, for a runtime that can: the mode and each vertex's share of dual quaternion. */
function skinned({ source, mesh, cpCount }: SkinRead): void {
  const type = String(findChild(source, 'SkinningType')?.properties[0] ?? 'Linear');
  if (type !== 'DualQuaternion' && type !== 'Blend') return;
  const record: { type: string; blendWeights?: number[] } = { type };
  if (type === 'Blend') {
    const indices = findChild(source, 'Indexes') ? array(source, 'Indexes') : [],
      values = findChild(source, 'BlendWeights') ? array(source, 'BlendWeights') : [],
      perPoint = new Float64Array(cpCount);
    for (let i = 0; i < indices.length; i++) if (indices[i] < cpCount) perPoint[indices[i]] = values[i];
    record.blendWeights = Array.from(mesh.controlPoints, (cp) => perPoint[cp]);
  }
  mesh.node.extras = { ...mesh.node.extras, fbxSkinning: record };
}

/**
 * Reads dual quaternion, blended and additive skins, total-one clusters and in-between blend shapes.
 * Pass it in `extensions`: `loadFBX(engine, url, {extensions: [deformers]})`.
 */
export const deformers: FBXExtension = { name: 'deformers', skinned, inbetweens, inbetweenWeight } as ExtensionHooks;
