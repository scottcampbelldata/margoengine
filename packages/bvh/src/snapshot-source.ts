import type { Camera, Mesh } from '@margoengine/core';
import { invertMatrix, multiplyMatrices } from '@margoengine/math/mat4';
import { MeshBVH } from './bvh.js';
import type { BVHBuildOptions } from './build.js';
import type { Side } from './math.js';
import {
  boundingSphere,
  deformedError,
  deformedNode,
  getMeshLayers,
  isModel,
  meshSide,
  modelMeshLayers,
  primitiveSide,
  worldSphere,
  type ModelLike,
  type ModelPrimitiveLike,
  type PickProxy,
} from './raycaster.js';
import { meshTriangles } from '../../shared/mesh-source.js';
import { hiddenInTree } from '../../shared/visibility.js';

/** @internal Structural runtime supplied by core's public extension. No core runtime import. */
export interface SnapshotRuntime {
  disposed: boolean;
  meshes: Map<number, SnapshotNode>;
  store: { matrices: Float32Array; parents: Float32Array; hidden: Uint8Array; tick(culling?: boolean): void };
  camera: Camera;
  canvas: HTMLCanvasElement;
  backend: 'webgpu' | 'webgl2';
}
/** @internal Original handles remain identity fields; captured numeric data is separately owned. */
interface SnapshotNode {
  id: number;
  geometry: { vertices: Float32Array; indices: Uint32Array } | null;
  material: { data: Float32Array };
}
/** @internal Owned local geometry, shared by every draw of the same source arrays and layout. */
interface SnapshotGeometry {
  vertices: Float32Array;
  bvh: MeshBVH;
  sphere: Float64Array;
}
/** @internal One captured draw or analytic proxy. */
export interface SnapshotEntry {
  node: SnapshotNode;
  id: number;
  model: ModelLike | null;
  primitive: ModelPrimitiveLike | null;
  root?: SnapshotNode;
  rootId?: number;
  index: number;
  nodeIndex?: number;
  instance?: number;
  mask: number;
  side: Side;
  matrix: Float32Array;
  inverse: Float64Array;
  /** World bounding sphere (x, y, z, radius). */
  sphere: Float64Array;
  /** Local proxy sphere; set for pick proxies, which have no geometry. */
  proxy?: Float64Array;
  geometry: SnapshotGeometry | null;
}

const SIDES: readonly Side[] = ['front', 'back', 'double'];

/**
 * @internal Captures the static draw sources of `objects` (core meshes, static PBR models and their instances) and the
 * pick proxies anchored on them. Geometry is copied once per source arrays and layout. Throws before returning
 * anything, so the caller publishes only a complete capture.
 */
export function captureEntries(
  objects: Iterable<Mesh | ModelLike>,
  proxies: readonly PickProxy[],
  runtime: SnapshotRuntime,
  buildOptions?: BVHBuildOptions,
): SnapshotEntry[] {
  const given = new Set(objects),
    models = new Set<ModelLike>(),
    meshes: SnapshotNode[] = [],
    entries: SnapshotEntry[] = [],
    copies = new WeakMap<Float32Array, Map<Uint32Array, Map<number, SnapshotGeometry>>>();
  for (const object of given) {
    if (!object || typeof object !== 'object')
      throw new TypeError('Snapshot objects must be meshes or static models; remove the invalid entries.');
    if (isModel(object)) models.add(object);
    else meshes.push(object as unknown as SnapshotNode);
  }
  const live = (node: SnapshotNode) => runtime.meshes.get(node.id) === node && !hiddenInTree(runtime.store, node.id);
  const worldOf = (node: SnapshotNode) => runtime.store.matrices.subarray(node.id * 16, node.id * 16 + 16);

  const geometry = (vertices: Float32Array, indices: Uint32Array, stride: number): SnapshotGeometry | null => {
    if (!(vertices instanceof Float32Array) || !(indices instanceof Uint32Array))
      throw new TypeError(
        'Snapshot geometry needs Float32Array vertices and Uint32Array indices; convert the source buffers first.',
      );
    if (!indices.length) return null;
    if (!vertices.length || vertices.length % stride || indices.length % 3 || !vertices.every(Number.isFinite))
      throw new RangeError(
        'Snapshot geometry needs finite whole vertices and whole triangles; repair the source buffers.',
      );
    let byIndex = copies.get(vertices);
    if (!byIndex) copies.set(vertices, (byIndex = new Map()));
    let byStride = byIndex.get(indices);
    if (!byStride) byIndex.set(indices, (byStride = new Map()));
    let data = byStride.get(stride);
    if (!data) {
      const v = vertices.slice(),
        index = indices.slice();
      data = {
        vertices: v,
        // PBR vertices keep the normal at offset 4, core geometry at 3.
        bvh: MeshBVH.build(
          { positions: v, normals: v.subarray(stride === 20 ? 4 : 3), indices: index, stride },
          buildOptions,
        ),
        sphere: boundingSphere(v, stride),
      };
      byStride.set(stride, data);
    }
    return data;
  };

  const add = (
    node: SnapshotNode,
    model: ModelLike | null,
    primitive: ModelPrimitiveLike | null,
    index: number,
    mask: number,
    side: Side,
    source: SnapshotGeometry | null,
    world: ArrayLike<number>,
    instance?: number,
    proxy?: Float64Array,
  ) => {
    const matrix = Float32Array.from(world),
      inverse = new Float64Array(16);
    if (
      matrix.length !== 16 ||
      !matrix.every(Number.isFinite) ||
      matrix[3] ||
      matrix[7] ||
      matrix[11] ||
      matrix[15] !== 1
    )
      throw new RangeError('Snapshot world matrices need 16 finite affine values; repair the mesh transform.');
    if (!invertMatrix(matrix, inverse)) return;
    const nodeIndex = primitive?.nodeIndex;
    if (nodeIndex !== undefined && (!Number.isSafeInteger(nodeIndex) || nodeIndex < 0))
      throw new RangeError('Snapshot nodeIndex must be a non-negative integer; repair the primitive metadata.');
    const root = model?.root as unknown as SnapshotNode | undefined;
    if (root && runtime.meshes.get(root.id) !== root) return;
    entries.push({
      node,
      id: node.id,
      model,
      primitive,
      root,
      rootId: root?.id,
      index,
      nodeIndex,
      instance,
      mask,
      side,
      matrix,
      inverse,
      geometry: source,
      proxy,
      sphere: worldSphere(matrix, 0, proxy ?? source!.sphere, new Float64Array(4)),
    });
  };

  const modelPrimitive = (
    node: SnapshotNode,
    model: ModelLike,
    primitive: ModelPrimitiveLike,
    index: number,
    mask: number,
  ) => {
    if (!live(node)) return;
    if (deformedNode(node as unknown as Mesh)) throw deformedError();
    const data = geometry(primitive.vertices, primitive.indices, 20);
    if (!data) return;
    const side = primitiveSide(primitive.material);
    if (!SIDES.includes(side))
      throw new TypeError("Snapshot material side must be 'front', 'back' or 'double'; repair the material.");
    const world = worldOf(node),
      instances = primitive.instances;
    if (!instances) return add(node, model, primitive, index, mask, side, data, world);
    if (
      !(instances.data instanceof Float32Array) ||
      !Number.isSafeInteger(instances.count) ||
      instances.count < 0 ||
      instances.count * 24 > instances.data.length
    )
      throw new RangeError(
        'Snapshot instances need a valid count of complete 24-float rows; repair the instance data.',
      );
    for (let i = 0; i < instances.count; i++)
      add(
        node,
        model,
        primitive,
        index,
        mask,
        side,
        data,
        multiplyMatrices(world, instances.data.subarray(i * 24, i * 24 + 16), new Float32Array(16)),
        i,
      );
  };

  for (const node of meshes) {
    if (!live(node)) continue;
    const mesh = node as unknown as Mesh,
      source = meshTriangles(mesh);
    if (source?.kind === 'pbr') {
      const owner = source.source.model as unknown as ModelLike;
      if (!models.has(owner))
        for (const p of source.source.primitives) {
          const primitive = p as unknown as ModelPrimitiveLike;
          modelPrimitive(node, owner, primitive, owner.primitives.indexOf(primitive), getMeshLayers(mesh));
        }
    }
    if (!node.geometry) continue;
    const data = geometry(node.geometry.vertices, node.geometry.indices, 6);
    if (data) add(node, null, null, -1, getMeshLayers(mesh), meshSide(node.material), data, worldOf(node));
  }
  for (const model of models) {
    if (model.disposed) continue;
    model.primitives.forEach((p, index) =>
      modelPrimitive(p.node as unknown as SnapshotNode, model, p, index, modelMeshLayers(p.node, model.root)),
    );
  }
  for (const p of proxies) {
    if (!given.has(p.anchor) && !given.has(p.model as Mesh | ModelLike)) continue;
    const node = p.anchor as unknown as SnapshotNode;
    if (!live(node)) continue;
    const proxy = Float64Array.from(p.sphere);
    if (proxy.length !== 4 || !proxy.every(Number.isFinite) || proxy[3] < 0)
      throw new RangeError(
        'Snapshot proxy spheres need four finite values and a non-negative radius; repair the proxy.',
      );
    add(
      node,
      isModel(p.model) ? p.model : null,
      null,
      -1,
      getMeshLayers(p.anchor),
      'double',
      null,
      worldOf(node),
      undefined,
      proxy,
    );
  }
  return entries;
}
