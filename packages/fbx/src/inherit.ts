// FBX inherit types. The three modes and how each world matrix is made follow the public FBX SDK reference (FbxTransform
// EInheritType, and its transformation sample): 1 is a plain parent x local; 0 and 2 keep the parent's rotation and
// scale apart, which a chain of glTF TRS nodes cannot say on one node, so such a node gets a helper parent.
import type { ExportNode } from '@margoengine/exporters';
import { multiplyQuaternions } from '@margoengine/math/quat';
import { array, findChild, objectName, property, type FBXNode } from './document.js';
import {
  composeTRS,
  decomposeTRS,
  fbxLocalTransform,
  multiply,
  rotationAndScale,
  transformPoint,
  type TransformOverrides,
  type TRS,
} from './math.js';
import type { SceneContext } from './scene.js';

/** The parent's scale goes after the child's rotation. */
const RrSs = 0,
  /** The parent's scale goes before the child's rotation: a plain matrix product. */
  RSrs = 1,
  /** As RrSs without the parent's own local scale. */
  Rrs = 2,
  /** Below this a difference of scale is Float32 noise from the file. */
  SAME = 1e-6;

export interface InheritBinding {
  /** Parent of the node: at the FBX translation, it takes the parent's scale away. */
  helper?: ExportNode;
  /** The parent's world holds shear, which no glTF parent can take away, so the node left it for an empty parent of the hierarchy. */
  detached?: boolean;
}

/** A node at a moment: its FBX world matrix, and for a node with a helper, what the helper and it hold. */
export interface Placement {
  world: Float64Array;
  localScale: number[];
  helper?: Pick<TRS, 'translation' | 'scale'>;
  own?: Pick<TRS, 'rotation' | 'scale'>;
}

export type Placements = Map<bigint, Placement>;

function inheritType(model: FBXNode): number {
  const type = Number(property(model, 'InheritType', RrSs));
  if (type !== RrSs && type !== RSrs && type !== Rrs)
    throw new RangeError(
      `FBX unsupported InheritType ${type} on ${objectName(model)}; bake or remove it in your 3D tool before export`,
    );
  return type;
}

/** The node's world at a moment, parents first. `read` gives a node's animated values at that moment. */
export function place(
  ctx: SceneContext,
  key: bigint,
  read: (key: bigint) => TransformOverrides | undefined,
  memo: Placements,
): Placement {
  const known = memo.get(key);
  if (known) return known;
  ctx.budget.sample(64);
  const model = ctx.models.get(key)!,
    local = fbxLocalTransform(model, read(key)),
    parts = decomposeTRS(local),
    parent = ctx.parents.get(key),
    type = inheritType(model);
  let out: Placement;
  if (parent === undefined) out = { world: local, localScale: parts.scale };
  else {
    const up = place(ctx, parent, read, memo);
    if (type === RSrs) out = { world: multiply(up.world, local), localScale: parts.scale };
    else if (type === Rrs) {
      const helper = {
          translation: parts.translation,
          scale: up.localScale.map((v) => (v ? 1 / v : 1)),
        },
        own = { rotation: parts.rotation, scale: parts.scale };
      out = {
        world: multiply(up.world, multiply(composeTRS(helper.translation, [0, 0, 0, 1], helper.scale), composeTRS([0, 0, 0], own.rotation, own.scale))),
        localScale: parts.scale,
        helper,
        own,
      };
    } else {
      const above = rotationAndScale(up.world),
        scale = parts.scale.map((v, k) => v * above.scale[k]);
      out = {
        world: composeTRS(
          transformPoint(up.world, parts.translation[0], parts.translation[1], parts.translation[2]),
          multiplyQuaternions(above.rotation, parts.rotation),
          scale,
        ),
        localScale: parts.scale,
        helper: { translation: parts.translation, scale: above.scale.map((v) => 1 / v) },
        own: { rotation: parts.rotation, scale },
      };
    }
  }
  memo.set(key, out);
  return out;
}

/** Models whose local scale changes in some clip: a curve on it that moves further than Float32 noise. */
function animatedScale(ctx: SceneContext): Set<bigint> {
  const out = new Set<bigint>();
  ctx.budget.work(ctx.document.connections.length);
  for (const link of ctx.document.connections) {
    if (link.kind !== 'OP' || link.property !== 'Lcl Scaling' || !ctx.models.has(link.parent)) continue;
    for (const c of ctx.incoming.get(link.child) ?? []) {
      const source = ctx.document.objects.get(c.child)!;
      if (source.name !== 'AnimationCurve' || !findChild(source, 'KeyValueFloat')) continue;
      const values = array(source, 'KeyValueFloat');
      ctx.budget.work(values.length);
      let low = Infinity,
        high = -Infinity;
      for (let i = 0; i < values.length; i++) {
        low = Math.min(low, values[i]);
        high = Math.max(high, values[i]);
      }
      if (high - low > SAME) out.add(link.parent);
    }
  }
  return out;
}

/** The node's ancestors, nearest first. */
export function ancestors(ctx: SceneContext, key: bigint): bigint[] {
  const out: bigint[] = [];
  for (let up = ctx.parents.get(key); up !== undefined; up = ctx.parents.get(up)) out.push(up);
  return out;
}

const uniform = (s: readonly number[]): boolean =>
  Math.abs(s[0] - s[1]) <= SAME * Math.abs(s[0]) && Math.abs(s[1] - s[2]) <= SAME * Math.abs(s[1]);

/** A TRS in the converted axes of a matrix in the file's, charged as work: animation calls this per sample. */
export function converted(ctx: SceneContext, m: ArrayLike<number>): TRS {
  ctx.budget.sample(64);
  return decomposeTRS(multiply(multiply(ctx.basis, m), ctx.basisInverse));
}

const helperMatrix = (p: Placement) => composeTRS(p.helper!.translation, [0, 0, 0, 1], p.helper!.scale),
  ownMatrix = (p: Placement) => composeTRS([0, 0, 0], p.own!.rotation, p.own!.scale);
/** What a node and its helper hold as glTF nodes; a detached node holds its whole world. */
export const helperParts = (ctx: SceneContext, p: Placement, binding: InheritBinding): { helper?: TRS; own: TRS } =>
  binding.detached
    ? { own: converted(ctx, p.world) }
    : { helper: converted(ctx, helperMatrix(p)), own: converted(ctx, ownMatrix(p)) };

/** Whether a plain product above this node can shear: a RSrs node below a scale that is not uniform or that moves. */
function shears(ctx: SceneContext, key: bigint, read: () => undefined, memo: Placements, moving: Set<bigint>): boolean {
  for (const up of [key, ...ancestors(ctx, key)]) {
    const parent = ctx.parents.get(up);
    if (parent === undefined || inheritType(ctx.models.get(up)!) !== RSrs) continue;
    const above = ancestors(ctx, up);
    if (above.some((a) => moving.has(a))) return true;
    if (!uniform(rotationAndScale(place(ctx, parent, read, memo).world).scale)) return true;
  }
  return false;
}

/**
 * The empty parent of a whole hierarchy, where its detached nodes go: at the scene root they would leave their
 * hierarchy, and every joint of a skin needs the same root.
 */
function holder(ctx: SceneContext, key: bigint, holders: Map<bigint, ExportNode>): ExportNode {
  let top = key;
  for (let up = ctx.parents.get(top); up !== undefined; up = ctx.parents.get(top)) top = up;
  let group = holders.get(top);
  if (!group) {
    const root = ctx.nodes.get(top)!;
    group = { name: `${root.name ?? 'Node'} group`, children: [root] };
    ctx.roots[ctx.roots.indexOf(root)] = group;
    holders.set(top, group);
  }
  return group;
}

/** Puts a helper above each node whose inherit type a plain parent and child cannot give. */
export function applyInheritance(ctx: SceneContext): void {
  const memo: Placements = new Map(),
    holders = new Map<bigint, ExportNode>(),
    read = () => undefined,
    moving = animatedScale(ctx);
  for (const [key, model] of ctx.models) {
    const parent = ctx.parents.get(key);
    if (parent === undefined || inheritType(model) === RSrs) continue;
    ctx.signal?.throwIfAborted();
    const up = place(ctx, parent, read, memo),
      type = inheritType(model);
    if (
      type === Rrs
        ? !moving.has(parent) && up.localScale.every((v) => Math.abs(v - 1) <= SAME)
        : !ancestors(ctx, key).some((a) => moving.has(a)) && uniform(rotationAndScale(up.world).scale)
    )
      continue;
    const node = ctx.nodes.get(key)!,
      siblings = ctx.nodes.get(parent)!.children as ExportNode[];
    if (type === RrSs && shears(ctx, parent, read, memo, moving)) {
      const binding = { detached: true };
      Object.assign(node, helperParts(ctx, place(ctx, key, read, memo), binding).own);
      siblings.splice(siblings.indexOf(node), 1);
      (holder(ctx, key, holders).children as ExportNode[]).push(node);
      ctx.inherit.set(key, binding);
      continue;
    }
    const plan = { helper: {} as ExportNode },
      { helper, own } = helperParts(ctx, place(ctx, key, read, memo), plan),
      binding: ExportNode = {
        name: `${node.name ?? 'Node'} inherit`,
        translation: helper!.translation,
        scale: helper!.scale,
        children: [node],
      };
    Object.assign(node, { translation: [0, 0, 0], rotation: own.rotation, scale: own.scale });
    siblings[siblings.indexOf(node)] = binding;
    ctx.inherit.set(key, { helper: binding });
  }
}
