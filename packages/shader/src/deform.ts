// Skinning and morph targets as nodes: the deformation runs in the vertex stage of whichever pass draws the mesh, so a
// graph can add its own effect on top and shadows follow. Linear blend skinning and morph targets as glTF 2.0 defines them.
import { MargoError } from '@margoengine/math/errors';
import { storage, type StorageBuffer } from './compute.js';
import {
  cast,
  loop,
  modelMatrix,
  normalLocal,
  positionLocal,
  varying,
  vec4,
  vertexIndex,
  type Node,
  type NodeInput,
} from './node.js';

/** What {@link skinningFromModel} reads of a loaded model: `PBRModel` from `@margoengine/gltf-pro` is one. */
export interface SkinnedModel {
  readonly nodes: readonly { readonly matrix: ArrayLike<number> }[];
  readonly asset: {
    readonly doc: {
      readonly nodes?: readonly { readonly skin?: number }[];
      readonly skins?: readonly { readonly joints: readonly number[]; readonly inverseBindMatrices?: number }[];
    };
    accessor(index: number, type: string): ArrayLike<number>;
  };
}
/** What {@link skinningFromModel} reads of a primitive: an entry of `model.primitives`. */
export interface SkinnedPrimitive {
  readonly nodeIndex: number;
  /** Twenty floats a vertex, position first, then at 4 the normal and at 12 UV0, as gltf-pro packs them. */
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
  readonly definition: { readonly attributes: Readonly<Record<string, number>> };
}
/** A skin read from a loaded model, for `positionNode` and `normalNode` of a NodeMaterial. */
export interface ModelSkinning extends Skinning {
  /** The primitive's bind pose, for `createMesh`. Draw it at the world origin: the skin works in world space. */
  readonly geometry: {
    readonly positions: Float32Array;
    readonly normals: Float32Array;
    readonly uvs: Float32Array;
    readonly indices: Uint32Array;
  };
  /** The buffers `skinning()` reads, as `skinningFromModel` filled them. */
  readonly bones: StorageBuffer<'vec4f'>;
  readonly joints: StorageBuffer<'vec4u'>;
  readonly weights: StorageBuffer<'vec4f'>;
  /**
   * Copies the joints' world matrices to `bones`. Call it after the joints moved and the engine updated its transforms,
   * so after a render or `engine.store.tick(false)`.
   */
  update(): void;
}
/** Options for `skinning()`. All three are `storage()` buffers. */
export interface SkinningOptions {
  /** One 4 x 4 matrix per bone, four `vec4f` columns each: the joint's matrix times its inverse bind matrix, in mesh space. Update it to pose the mesh. */
  bones: StorageBuffer<'vec4f'>;
  /** Four bone numbers per vertex, in vertex order. */
  joints: StorageBuffer<'vec4u'>;
  /** Four weights per vertex that add up to 1, in vertex order. */
  weights: StorageBuffer<'vec4f'>;
}
/** What `skinning()` returns. Each function takes the bind-pose value, by default the mesh's own. */
export interface Skinning {
  /** The skinned position, in mesh space. Add effects before it to move the bind pose, or after it to move the pose. */
  position(position?: NodeInput<'vec3f'>): Node<'vec3f'>;
  /** The skinned unit normal, in mesh space. Bones with non-uniform scale skew it. */
  normal(normal?: NodeInput<'vec3f'>): Node<'vec3f'>;
}
/**
 * Reads a loaded glTF skin into {@link skinning}: its joints and weights, the bind pose as `geometry`, and a joint palette
 * that `update()` fills from the model's nodes. Whatever moves those nodes drives it, `Animation` included.
 * @throws MargoError `'state'` when the primitive's node has no skin, and `'unsupported'` for more than four influences a
 * vertex (`JOINTS_1`), which `skinning()` does not read.
 */
export function skinningFromModel(model: SkinnedModel, primitive: SkinnedPrimitive): ModelSkinning {
  const { doc } = model.asset,
    { attributes } = primitive.definition,
    skin = doc.skins?.[doc.nodes?.[primitive.nodeIndex]?.skin ?? -1];
  if (!skin || attributes.JOINTS_0 === undefined || attributes.WEIGHTS_0 === undefined)
    throw new MargoError('state', 'The primitive has no glTF skin; pick one whose node has a skin and JOINTS_0.');
  if (attributes.JOINTS_1 !== undefined)
    throw new MargoError('unsupported', 'skinning() reads four influences a vertex; limit the file to JOINTS_0.');
  const { vertices, indices } = primitive,
    count = vertices.length / 20,
    positions = new Float32Array(count * 3),
    normals = new Float32Array(count * 3),
    uvs = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const at = i * 20;
    positions.set(vertices.subarray(at, at + 3), i * 3);
    normals.set(vertices.subarray(at + 4, at + 7), i * 3);
    uvs.set(vertices.subarray(at + 12, at + 14), i * 2);
  }
  const { joints: nodes, inverseBindMatrices } = skin,
    inverseBind = inverseBindMatrices === undefined ? undefined : model.asset.accessor(inverseBindMatrices, 'MAT4'),
    palette = new Float32Array(nodes.length * 16),
    bones = storage(palette, 'vec4f'),
    joints = storage(Uint32Array.from(model.asset.accessor(attributes.JOINTS_0, 'VEC4')), 'vec4u'),
    weights = storage(Float32Array.from(model.asset.accessor(attributes.WEIGHTS_0, 'VEC4')), 'vec4f');
  const update = () => {
    nodes.forEach((node, bone) => {
      const a = model.nodes[node].matrix,
        at = bone * 16;
      if (!inverseBind) palette.set(a as Float32Array, at);
      else
        for (let column = 0; column < 4; column++)
          for (let row = 0; row < 4; row++) {
            let sum = 0;
            for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * inverseBind[at + column * 4 + k];
            palette[at + column * 4 + row] = sum;
          }
    });
    bones.update();
  };
  update();
  return { ...skinning({ bones, joints, weights }), geometry: { positions, normals, uvs, indices }, bones, joints, weights, update };
}
/**
 * Linear blend skinning in the vertex stage. `positionNode: skin.position()` draws the posed mesh in every pass, and the
 * normals follow it unless `positionNormals` says otherwise.
 */
export function skinning({ bones, joints, weights }: SkinningOptions): Skinning {
  const joint = joints.element(vertexIndex),
    weight = weights.element(vertexIndex),
    // Column `k` of the blended matrix: the weighted sum of column `k` of the four bones.
    column = (k: number) =>
      bones
        .element(joint.x.mul(4).add(k))
        .mul(weight.x)
        .add(bones.element(joint.y.mul(4).add(k)).mul(weight.y))
        .add(bones.element(joint.z.mul(4).add(k)).mul(weight.z))
        .add(bones.element(joint.w.mul(4).add(k)).mul(weight.w)),
    x = column(0),
    y = column(1),
    z = column(2),
    w = column(3);
  return {
    position(position = positionLocal) {
      const p = cast(position, 'vec3f', 'skin position');
      return x.mul(p.x).add(y.mul(p.y)).add(z.mul(p.z)).add(w).xyz;
    },
    normal(normal = normalLocal) {
      const n = cast(normal, 'vec3f', 'skin normal');
      return x.mul(n.x).add(y.mul(n.y)).add(z.mul(n.z)).xyz.normalize();
    },
  };
}
/** Options for `morphing()`. */
export interface MorphingOptions {
  /** How many targets the buffers hold. */
  count: number;
  /** How many vertices the mesh has. */
  vertices: number;
  /** Position offsets, target after target: `count * vertices` entries. */
  positions: StorageBuffer<'vec4f'>;
  /** Normal offsets in the same order, for `normal()`. */
  normals?: StorageBuffer<'vec4f'>;
  /** One weight per target. Update it to animate the mesh. */
  weights: StorageBuffer<'f32'>;
}
/** What `morphing()` returns. Each function takes the base value, by default the mesh's own. */
export interface Morphing {
  /** The base position plus each target's offset times its weight, in mesh space. */
  position(position?: NodeInput<'vec3f'>): Node<'vec3f'>;
  /** The same for the normal, renormalised. Without `normals` it is the base normal. */
  normal(normal?: NodeInput<'vec3f'>): Node<'vec3f'>;
}
/**
 * Morph targets in the vertex stage. `positionNode: morph.position()` draws the blended mesh in every pass; chain it into
 * `skinning()` with `skin.position(morph.position())`, the glTF order.
 */
export function morphing({ count, vertices, positions, normals, weights }: MorphingOptions): Morphing {
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(vertices) || vertices < 1)
    throw new RangeError('morphing() needs a whole count and vertices of at least 1');
  const blend = (base: Node<'vec3f'>, offsets: StorageBuffer<'vec4f'>) =>
    loop(count, base, (i, sum) => sum.add(offsets.element(i.toUint().mul(vertices).add(vertexIndex)).xyz.mul(weights.element(i))));
  return {
    position: (position = positionLocal) => blend(cast(position, 'vec3f', 'morph position'), positions),
    normal(normal = normalLocal) {
      const n = cast(normal, 'vec3f', 'morph normal');
      return normals ? blend(n, normals).normalize() : n;
    },
  };
}
/**
 * A mesh-space normal such as `skin.normal()` as `normalNode` wants it: world space, worked out per vertex and interpolated.
 * It uses the cofactors of the model matrix, so a scaled or mirrored mesh keeps its normals perpendicular to the surface.
 */
export function worldNormal(normal: NodeInput<'vec3f'>): Node<'vec3f'> {
  const n = cast(normal, 'vec3f', 'worldNormal'),
    x = modelMatrix.mul(vec4(1, 0, 0, 0)).xyz,
    y = modelMatrix.mul(vec4(0, 1, 0, 0)).xyz,
    z = modelMatrix.mul(vec4(0, 0, 1, 0)).xyz,
    yz = y.cross(z);
  return varying(yz.mul(n.x).add(z.cross(x).mul(n.y)).add(x.cross(y).mul(n.z)).mul(x.dot(yz).sign())).normalize();
}
