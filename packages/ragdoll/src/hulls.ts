// Body shapes from a skin: the vertices each bone carries, as a convex hull or a box in the bone's own frame, so hit boxes
// follow the mesh instead of a capsule around the bone. The hulls are rigging's jointHulls; skin joints the ragdoll has
// no body for count toward the nearest bone above them. The box is the smallest over turns about the bone, a plain search
// over the hull's corners. Our own design; no engine's source was read.
import type { Mesh } from '@margoengine/core/extension';
import { jointHulls } from '@margoengine/rigging/hulls';
import { normalizeQuaternion, rotateByQuaternion } from '@margoengine/math/quat';
import type { Ragdoll, RagdollPart, RagdollShape } from './ragdoll.js';

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];

/** A skinned mesh in its bind pose, for {@link fitRagdollShapes}. */
export interface RagdollSkin {
  /** Bind-pose vertex positions, xyz per vertex. */
  positions: ArrayLike<number>;
  /** Skin joint indices, `influences` per vertex: indices into `nodes`. */
  joints: Uint16Array;
  /** Skin weights, one per entry of `joints`. */
  weights: Float32Array;
  /** Slots per vertex. Default 4. */
  influences?: number;
  /** The skin's joint nodes, in skin order. */
  nodes: readonly Mesh[];
  /** Inverse bind matrices, 16 numbers per entry of `nodes`, column-major. */
  inverseBindMatrices: ArrayLike<number>;
}

/** What {@link fitRagdollShapes} reads of a glTF model (a `PBRModel`). */
export interface SkinnedModel {
  readonly nodes: readonly Mesh[];
  readonly primitives: readonly {
    readonly nodeIndex: number;
    readonly definition: { readonly attributes?: Record<string, unknown> };
  }[];
  readonly asset: {
    readonly doc: {
      readonly nodes?: readonly { readonly skin?: number }[];
      readonly skins?: readonly { readonly joints: readonly number[]; readonly inverseBindMatrices?: unknown }[];
    };
    accessor(id: unknown, type?: string): Float32Array;
  };
}

/** Options of {@link fitRagdollShapes}. */
export interface RagdollFitOptions {
  /** `'hull'`, a convex hull of the bone's vertices, or `'box'`, the smallest box around them that lies along the bone. Default `'hull'`. */
  shape?: 'hull' | 'box';
  /** A vertex counts toward a bone when the bone carries at least this share of it. Default 0.5. */
  minWeight?: number;
  /** Most corners a hull keeps, 8 to 1,024. Default 64. */
  maxPoints?: number;
}

/** One bone that got a new shape. */
export interface RagdollFit {
  /** The bone. */
  part: RagdollPart;
  /** Its shape now, in its own frame. */
  shape: RagdollShape;
  /** Vertices that counted toward it. */
  vertexCount: number;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** Turns about the bone tried for a box: 5 degrees apart over the quarter turn a box repeats in. */
const BOX_TURNS = 18;

/**
 * The bind pose of the skin that holds `root`, every primitive of it as one mesh. A model can hold several skins with
 * separate bind spaces, so one skin is read.
 */
function skinOf(model: SkinnedModel, root: Mesh): RagdollSkin {
  const { doc } = model.asset,
    id = (doc.skins ?? []).findIndex((skin) => skin.joints.some((joint) => model.nodes[joint] === root));
  if (id < 0)
    throw new RangeError("No skin of this model holds the ragdoll's root bone; pass the model the skeleton belongs to.");
  const primitives = model.primitives.filter((p) => doc.nodes?.[p.nodeIndex]?.skin === id);
  if (!primitives.length) throw new RangeError('No mesh of this model uses the skin; there is nothing to fit shapes to.');
  const { joints: ids, inverseBindMatrices } = doc.skins![id],
    sets = primitives.some((p) => p.definition.attributes?.JOINTS_1 !== undefined) ? 2 : 1,
    influences = sets * 4,
    positions = primitives.map((p) => model.asset.accessor(p.definition.attributes!.POSITION, 'VEC3')),
    count = positions.reduce((sum, list) => sum + list.length / 3, 0),
    joints = new Uint16Array(count * influences),
    weights = new Float32Array(count * influences),
    merged = new Float32Array(count * 3);
  let first = 0;
  primitives.forEach((p, i) => {
    const size = positions[i].length / 3;
    merged.set(positions[i], first * 3);
    for (let set = 0; set < sets; set++) {
      const attributes = p.definition.attributes!,
        jointId = attributes['JOINTS_' + set],
        weightId = attributes['WEIGHTS_' + set];
      if (jointId === undefined || weightId === undefined) continue;
      const from = model.asset.accessor(jointId, 'VEC4'),
        share = model.asset.accessor(weightId, 'VEC4');
      for (let v = 0; v < size; v++)
        for (let c = 0; c < 4; c++) {
          joints[(first + v) * influences + set * 4 + c] = from[v * 4 + c];
          weights[(first + v) * influences + set * 4 + c] = share[v * 4 + c];
        }
    }
    first += size;
  });
  // Weights stored as bytes can sum to a little off one, and minWeight compares shares.
  for (let v = 0; v < count; v++) {
    let sum = 0;
    for (let c = 0; c < influences; c++) sum += weights[v * influences + c];
    if (sum > 0) for (let c = 0; c < influences; c++) weights[v * influences + c] /= sum;
  }
  return {
    positions: merged,
    joints,
    weights,
    influences,
    nodes: ids.map((joint) => model.nodes[joint]),
    inverseBindMatrices:
      inverseBindMatrices === undefined
        ? Float32Array.from(ids.flatMap(() => IDENTITY))
        : model.asset.accessor(inverseBindMatrices, 'MAT4'),
  };
}

/** The bone `node` belongs to: its own, or the nearest one above it that the skin has a bind pose for. */
function ownerOf(node: Mesh, parts: ReadonlyMap<number, number>): number {
  const { parents } = node.engine.store;
  for (let id = node.id; id !== -1; id = parents[id]) {
    const part = parts.get(id);
    if (part !== undefined) return part;
  }
  return -1;
}

/** The rotation taking +y to the unit `axis`. */
function alongAxis(axis: ArrayLike<number>): Quat {
  if (axis[1] < -0.999999) return [1, 0, 0, 0];
  return normalizeQuaternion([axis[2], 0, -axis[0], 1 + axis[1]]) as Quat;
}
const multiply = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

/** The smallest box around `points` with its y axis along `axis`, over turns about that axis. */
function boxAround(points: ArrayLike<number>, axis: ArrayLike<number>): RagdollShape {
  const along = alongAxis(axis);
  let best: RagdollShape | undefined,
    smallest = Infinity;
  for (let turn = 0; turn < BOX_TURNS; turn++) {
    const half = ((turn / BOX_TURNS) * Math.PI) / 4,
      rotation = multiply(along, [0, Math.sin(half), 0, Math.cos(half)]),
      inverse: Quat = [-rotation[0], -rotation[1], -rotation[2], rotation[3]],
      low: Vec3 = [Infinity, Infinity, Infinity],
      high: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < points.length; i += 3) {
      const p = rotateByQuaternion([points[i], points[i + 1], points[i + 2]], inverse);
      for (let k = 0; k < 3; k++) {
        low[k] = Math.min(low[k], p[k]);
        high[k] = Math.max(high[k], p[k]);
      }
    }
    const size = (high[0] - low[0]) * (high[1] - low[1]) * (high[2] - low[2]);
    if (size >= smallest) continue;
    smallest = size;
    best = {
      type: 'box',
      center: rotateByQuaternion([0, 1, 2].map((k) => (low[k] + high[k]) / 2), rotation) as Vec3,
      halfExtents: [(high[0] - low[0]) / 2, (high[1] - low[1]) / 2, (high[2] - low[2]) / 2],
      rotation,
    };
  }
  return best!;
}

/**
 * Fits each bone's collider to the mesh it carries: a vertex belongs to the bone that dominates its skin weights, skin
 * joints with no body counting toward the bone above them, and the bone's capsule gives way to the hull or the box of its
 * vertices. A bone's mass, friction, groups and joint stay as they are; a bone with no vertices that span a volume keeps
 * its capsule. Call it on a new ragdoll, before `addRagdollMotors`.
 * @example
 * const ragdoll = Ragdoll.attach(physics, { root: hips });
 * const fitted = fitRagdollShapes(ragdoll, model); // or { shape: 'box' }
 * console.log(`${fitted.length} of ${ragdoll.bones.length} bones fit the mesh`);
 * @param source The glTF model the skeleton belongs to, or a skinned mesh in its bind pose.
 * @returns The bones that got a shape.
 * @throws TypeError without a ragdoll or a source, RangeError for a model with no skin on these bones or a bad option.
 */
export function fitRagdollShapes(
  ragdoll: Ragdoll,
  source: SkinnedModel | RagdollSkin,
  options: RagdollFitOptions = {},
): RagdollFit[] {
  if (!ragdoll?.bones || !source)
    throw new TypeError('fitRagdollShapes needs a Ragdoll and a model: fitRagdollShapes(ragdoll, model).');
  const { shape = 'hull', minWeight, maxPoints } = options;
  if (shape !== 'hull' && shape !== 'box') throw new RangeError("fitRagdollShapes shape must be 'hull' or 'box'.");
  const skin = 'primitives' in source ? skinOf(source, ragdoll.bones[0].node) : source,
    { nodes, inverseBindMatrices } = skin,
    bones = new Map(ragdoll.bones.map((part, i) => [part.node.id, i])),
    // Only bones the skin has a bind pose for can hold vertices: the matrix is what brings them into the bone's frame.
    bound = new Map(nodes.flatMap((node) => (bones.has(node.id) ? [[node.id, bones.get(node.id)!] as const] : []))),
    matrices = new Float32Array(ragdoll.bones.length * 16);
  if (!bound.size) throw new RangeError('The skin holds none of the ragdoll bones; pass the model the skeleton belongs to.');
  for (let i = 0; i < ragdoll.bones.length; i++) matrices.set(IDENTITY, i * 16);
  nodes.forEach((node, j) => {
    const part = bound.get(node.id);
    if (part === undefined) return;
    for (let k = 0; k < 16; k++) matrices[part * 16 + k] = inverseBindMatrices[j * 16 + k];
  });
  const owners = nodes.map((node) => ownerOf(node, bound)),
    joints = new Uint16Array(skin.joints.length),
    weights = Float32Array.from(skin.weights);
  for (let i = 0; i < joints.length; i++) {
    const owner = owners[skin.joints[i]];
    if (owner === undefined) throw new RangeError(`Skin joint ${skin.joints[i]} has no node; pass one node per joint.`);
    // Weight on joints above every bone (a root under the hips' parent) belongs to no body.
    if (owner < 0) weights[i] = 0;
    else joints[i] = owner;
  }
  const hulls = jointHulls(
    { positions: skin.positions, skin: { joints, weights, influences: skin.influences ?? 4 } },
    { minWeight, maxPoints, inverseBindMatrices: matrices },
  );
  return hulls.map((hull) => {
    const part = ragdoll.bones[hull.joint],
      m = part.node.matrix,
      // Joint space is the bone's frame before its world scales; a body's frame is in world units.
      scales = [Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6]), Math.hypot(m[8], m[9], m[10])],
      points = hull.points.map((v, i) => v * scales[i % 3]);
    const fitted: RagdollShape = shape === 'box' ? boxAround(points, part.axis) : { type: 'hull', points };
    ragdoll.setShape(part, fitted);
    return { part, shape: fitted, vertexCount: hull.vertexCount };
  });
}
