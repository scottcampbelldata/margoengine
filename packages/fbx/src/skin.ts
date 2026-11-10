import type { SkinData } from '@margoengine/exporters';
import { array, findChild, id, objectName, type FBXNode } from './document.js';
import { multiply } from './math.js';
import { children, convertedMatrix, type SceneContext, type MeshBinding } from './scene.js';

interface PreparedSkin {
  name: string;
  cpCount: number;
  jointIds: Uint16Array;
  weights: Float64Array;
  joints: SkinData['joints'];
  binds: Float32Array;
  source: FBXNode;
}
const prepared = new WeakMap<SceneContext, Map<object, PreparedSkin | null>>();

function insertInfluence(
  jointIds: Uint16Array,
  weights: Float64Array,
  controlPoint: number,
  joint: number,
  weight: number,
): void {
  const start = controlPoint * 4;
  for (let slot = 0; slot < 4; slot++) {
    const at = start + slot;
    // Strict comparison keeps earlier joints first when weights tie. Inserting
    // shifts weaker influences down and drops the smallest of the five.
    if (weight <= weights[at]) continue;
    for (let k = 3; k > slot; k--) {
      weights[start + k] = weights[start + k - 1];
      jointIds[start + k] = jointIds[start + k - 1];
    }
    weights[at] = weight;
    jointIds[at] = joint;
    return;
  }
}

function prepare(ctx: SceneContext, mesh: MeshBinding): PreparedSkin | null {
  const skins = children(ctx, id(mesh.source.properties[0])).filter(
    (n) => n.name === 'Deformer' && n.properties[2] === 'Skin',
  );
  if (skins.length > 1) throw new TypeError('Multiple FBX skins on geometry; keep one per target when exporting');
  if (!skins.length) return null;
  const source = skins[0],
    type = findChild(source, 'SkinningType')?.properties[0];
  const entry = ctx.extensions.find((extension) => extension.skinned);
  if (type !== undefined && type !== 'Linear' && type !== 'Rigid' && type !== 0 && !entry)
    throw new TypeError(
      'FBX dual quaternion or blended skin; pass deformers from @margoengine/fbx/deformers, or bake it in your 3D tool',
    );
  const clusters = children(ctx, id(source.properties[0])).filter((n) => n.properties[2] === 'Cluster');
  if (!clusters.length || clusters.length > 65535)
    throw new RangeError('Invalid FBX skin cluster count; re-export the file, it looks damaged');
  const cpCount = array(mesh.source, 'Vertices').length / 3;
  if (!Number.isSafeInteger(cpCount) || cpCount < 1 || cpCount > ctx.budget.limits.vertices)
    throw new RangeError(
      'FBX geometry budget exceeded; simplify or split the scene, the import limits are listed in the README',
    );
  // Reserve control-point scratch once per source, before allocating it. Material
  // groups and instances reuse the same influence reduction and bind matrices.
  ctx.budget.reserve(cpCount * 44 + clusters.length * 144);
  ctx.budget.work(cpCount * 8 + clusters.length * 1024);
  const jointIds = new Uint16Array(cpCount * 4),
    weights = new Float64Array(cpCount * 4),
    used = new Uint32Array(cpCount);
  const joints: SkinData['joints'][number][] = [],
    binds = new Float32Array((clusters.length + 1) * 16),
    seen = new Set<bigint>();
  const jointKeys: bigint[] = [];
  let additive = false,
    meshAtBind: Float64Array | undefined;
  for (const cluster of clusters) {
    ctx.signal?.throwIfAborted();
    const label = objectName(cluster),
      mode = findChild(cluster, 'Mode')?.properties[0];
    if (mode !== undefined && mode !== 'Normalize' && !entry)
      throw new TypeError(
        `FBX cluster mode ${String(mode)}: ${label}; pass deformers from @margoengine/fbx/deformers, or bake it in your 3D tool`,
      );
    if (mode === 'Additive') additive = true;
    const links = children(ctx, id(cluster.properties[0])).filter((n) => n.name === 'Model');
    if (links.length !== 1) throw new TypeError(`FBX cluster needs one joint: ${label}`);
    const jointKey = id(links[0].properties[0]),
      joint = ctx.nodes.get(jointKey);
    if (!joint || seen.has(jointKey))
      throw new TypeError(`Invalid FBX cluster joint: ${label}; re-export the file, it looks damaged`);
    seen.add(jointKey);
    jointKeys.push(jointKey);
    const jointIndex = joints.length;
    joints.push(joint);
    let transform: ArrayLike<number>, link: ArrayLike<number>;
    try {
      transform = array(cluster, 'Transform');
      link = array(cluster, 'TransformLink');
    } catch {
      throw new TypeError(`Missing FBX bind matrix: ${label}; re-export the file, it looks damaged`);
    }
    if (transform.length !== 16 || link.length !== 16)
      throw new TypeError(`Invalid FBX bind matrix: ${label}; re-export the file, it looks damaged`);
    // Transform takes the mesh into the joint at bind, so it is the inverse bind matrix: link x Transform is the mesh's
    // world, the same on every cluster of a real file. Geometry transforms are already baked into vertices.
    ctx.budget.reserve(256);
    const bind = convertedMatrix(ctx, transform);
    binds.set(bind, jointIndex * 16);
    meshAtBind ??= multiply(convertedMatrix(ctx, link), bind);
    for (let i = 0; i < 16; i++)
      if (!Number.isFinite(binds[jointIndex * 16 + i]))
        throw new RangeError(`Invalid FBX bind matrix: ${label}; re-export the file, it looks damaged`);
    // A joint that moves no vertex has a cluster with no lists: writers keep it for the skeleton.
    const empty = !findChild(cluster, 'Indexes') && !findChild(cluster, 'Weights'),
      indices = empty ? [] : array(cluster, 'Indexes'),
      values = empty ? [] : array(cluster, 'Weights');
    if (indices.length !== values.length)
      throw new RangeError(`FBX cluster weight count mismatch: ${label}; re-export the file, it looks damaged`);
    ctx.budget.work(indices.length * 8);
    for (let i = 0; i < indices.length; i++) {
      const cp = indices[i],
        weight = values[i];
      // Writers leave entries for control points the mesh lost after binding; there is nothing to weight.
      if (cp >= cpCount) continue;
      if (
        !Number.isInteger(cp) ||
        cp < 0 ||
        used[cp] === jointIndex + 1 ||
        !Number.isFinite(weight) ||
        weight < 0
      )
        throw new RangeError(`Invalid FBX cluster weight: ${label}; re-export the file, it looks damaged`);
      used[cp] = jointIndex + 1;
      if (!weight) continue;
      insertInfluence(jointIds, weights, cp, jointIndex, weight);
    }
  }
  // An additive cluster moves a vertex by its share and leaves the rest of it where it was, and a joint that never moves,
  // at the mesh's place at bind, is how a glTF skin says so. Weights over one have no such form and stay normalized.
  let stay = false;
  if (additive && meshAtBind)
    for (let cp = 0; cp < cpCount; cp++) {
      const at = cp * 4,
        sum = weights[at] + weights[at + 1] + weights[at + 2] + weights[at + 3];
      if (sum <= 0 || sum >= 1) continue;
      insertInfluence(jointIds, weights, cp, joints.length, 1 - sum);
      stay = true;
    }
  if (stay) {
    // Joints need one root, and the skeleton's own may move: a new group holds it and the joint that stays.
    let top = jointKeys[0];
    while (ctx.parents.has(top)) top = ctx.parents.get(top)!;
    const rest: SkinData['joints'][number] = { name: `${objectName(source)} rest`, children: [] },
      root = ctx.nodes.get(top)!,
      at = ctx.roots.indexOf(root);
    ctx.roots[at] = { name: `${objectName(source)} group`, children: [root, rest] };
    binds.set(meshAtBind!, joints.length * 16);
    joints.push(rest);
  }
  return { name: objectName(source), cpCount, jointIds, weights, joints, binds: binds.subarray(0, joints.length * 16), source };
}

export function attachSkin(ctx: SceneContext, mesh: MeshBinding): void {
  let cache = prepared.get(ctx);
  if (!cache) {
    cache = new Map();
    prepared.set(ctx, cache);
  }
  let data = cache.get(mesh.source);
  if (data === undefined) {
    ctx.budget.reserve(128);
    data = prepare(ctx, mesh);
    cache.set(mesh.source, data);
  }
  if (!data) return;
  const { jointIds, weights, joints, binds } = data;
  ctx.budget.reserve(mesh.controlPoints.length * 24);
  ctx.budget.work(mesh.controlPoints.length * 8);
  const ids = new Uint16Array(mesh.controlPoints.length * 4),
    out = new Float32Array(ids.length);
  for (let i = 0; i < mesh.controlPoints.length; i++) {
    const point = mesh.controlPoints[i];
    if (!Number.isInteger(point) || point < 0 || point >= data.cpCount)
      throw new RangeError('Invalid FBX skin control point; re-export the file, it looks damaged');
    const cp = point * 4,
      sum = weights[cp] + weights[cp + 1] + weights[cp + 2] + weights[cp + 3];
    if (!(sum > 0) || !Number.isFinite(sum))
      throw new RangeError('FBX skin vertex has no positive weights; clean up the source model before export');
    for (let k = 0; k < 4; k++) {
      ids[i * 4 + k] = jointIds[cp + k];
      out[i * 4 + k] = weights[cp + k] / sum;
    }
  }
  mesh.geometry.joints = ids;
  mesh.geometry.weights = out;
  mesh.node.skin = { name: data.name, joints, inverseBindMatrices: binds };
  ctx.extensions.find((extension) => extension.skinned)?.skinned?.({ source: data.source, mesh, cpCount: data.cpCount });
}
