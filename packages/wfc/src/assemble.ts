import type { EngineKernel, Mesh as MeshHandle } from '@margoengine/core';
import { engineRuntime, meshRuntime, type Mesh } from '@margoengine/core/extension';
import { Quaternion } from '@margoengine/math';

/** A loaded glTF model, structurally compatible with gltf and gltf-pro models. Resources stay caller-owned. */
export interface TileModel {
  root: MeshHandle;
  meshes: readonly MeshHandle[];
}
/** A solver ID maps to a source model and an orthogonal column-major 3x3 orientation (including reflections). */
export interface AssemblyVariant {
  source: number;
  rotation: readonly number[];
}
/** Grid placement defaults: unit spacing, zero origin, no parent and no cancellation signal. */
export interface AssemblyOptions {
  spacing?: readonly number[];
  origin?: readonly number[];
  parent?: MeshHandle;
  signal?: AbortSignal;
}
/** Owns the placed mesh handles, sharing template geometry and materials for automatic core instancing. */
export class TileAssembly {
  /** @internal Created by assembleWFC. */
  constructor(
    readonly root: Mesh,
    readonly cells: readonly Mesh[],
    readonly meshes: readonly Mesh[],
  ) {}
  /** Releases placed handles only; the input models and their resources remain caller-owned. */
  dispose(): void {
    for (let i = this.meshes.length - 1; i >= 0; i--) this.meshes[i].dispose();
    for (let i = this.cells.length - 1; i >= 0; i--) this.cells[i].dispose();
    this.root.dispose();
  }
  /** Explicit resource management. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}

/**
 * Place an X-fast solved grid using loaded glTF templates. Templates must belong to this engine and be static.
 * Clones the complete primitive ancestry, retaining local TRS, materials, visibility and shadow flags.
 * @throws RangeError for malformed grids, IDs, transforms or more than one million cells; errors roll back all handles.
 */
export function assembleWFC(
  instance: EngineKernel,
  dimensions: readonly number[],
  grid: ArrayLike<number>,
  variants: readonly AssemblyVariant[],
  models: readonly TileModel[],
  { spacing = [1, 1, 1], origin = [0, 0, 0], parent, signal }: AssemblyOptions = {},
): TileAssembly {
  signal?.throwIfAborted();
  const vector = (v: readonly number[]) =>
    v.length === 3 && Array.from(v).every((n) => Number.isFinite(n) && Number.isFinite(Math.fround(n)));
  if (
    !vector(dimensions) ||
    dimensions.some((n) => !Number.isSafeInteger(n) || n < 1) ||
    dimensions.reduce((a, b) => a * b, 1) > 1_000_000 ||
    grid.length !== dimensions[0] * dimensions[1] * dimensions[2] ||
    !vector(spacing) ||
    spacing.some((n) => n <= 0) ||
    !vector(origin)
  )
    throw new RangeError(
      'Invalid WFC assembly grid or placement; provide three positive dimensions and finite spacing/origin',
    );
  const engine = engineRuntime(instance);
  parent?.check();
  if (parent && meshRuntime(parent).engine !== engine)
    throw new RangeError('WFC assembly parent belongs to another engine; use this engine parent');
  const sources = models.map((model) => ({ root: meshRuntime(model.root), meshes: model.meshes.map(meshRuntime) }));
  const templates = sources.map((model) => {
    model.root.check();
    if (model.root.engine !== engine)
      throw new RangeError('WFC tile model belongs to another engine; load it with this engine');
    const nodes = new Set<Mesh>([model.root]);
    for (const mesh of model.meshes) {
      mesh.check();
      if (mesh.engine !== engine)
        throw new RangeError('WFC primitive belongs to another engine; load it with this engine');
      let node: Mesh | undefined = mesh;
      while (node !== model.root) {
        if (!node) throw new RangeError('WFC primitive is outside its model root; provide a complete model');
        nodes.add(node);
        node = engine.meshes.get(engine.store.parents[node.id]);
      }
    }
    return nodes;
  });
  const orientations = Array.from(variants, (variant) => {
    if (!variant || !Number.isInteger(variant.source) || !templates[variant.source])
      throw new RangeError('Invalid WFC assembly source; provide an existing model index');
    const r = Array.from(variant.rotation);
    if (r.length !== 9 || r.some((n) => !Number.isFinite(n)))
      throw new RangeError('Invalid WFC orientation; provide nine finite matrix values');
    for (let a = 0; a < 3; a++)
      for (let b = 0; b < 3; b++)
        if (
          Math.abs(r[a * 3] * r[b * 3] + r[a * 3 + 1] * r[b * 3 + 1] + r[a * 3 + 2] * r[b * 3 + 2] - +(a === b)) > 1e-8
        )
          throw new RangeError('WFC orientation must be orthogonal; remove scale and shear');
    const sign = Math.sign(
      r[0] * (r[4] * r[8] - r[5] * r[7]) - r[3] * (r[1] * r[8] - r[2] * r[7]) + r[6] * (r[1] * r[5] - r[2] * r[4]),
    );
    for (let i = 0; i < 3; i++) r[i] *= sign;
    const q = new Quaternion().setFromRotationMatrix({ elements: r });
    return { source: variant.source, sign, q: [q.x, q.y, q.z, q.w] };
  });
  for (let i = 0; i < grid.length; i++)
    if (!Number.isInteger(grid[i]) || !orientations[grid[i]])
      throw new RangeError('Invalid WFC assembly tile ID; use an existing variant index');
  const root = engine.createMesh(parent ? meshRuntime(parent) : null),
    cells: Mesh[] = [],
    meshes: Mesh[] = [];
  const result = new TileAssembly(root, cells, meshes);
  try {
    for (let i = 0; i < grid.length; i++) {
      signal?.throwIfAborted();
      const v = orientations[grid[i]],
        tile = engine.createMesh(root);
      cells.push(tile);
      tile.setPosition([
        origin[0] + (i % dimensions[0]) * spacing[0],
        origin[1] + (Math.floor(i / dimensions[0]) % dimensions[1]) * spacing[1],
        origin[2] + Math.floor(i / (dimensions[0] * dimensions[1])) * spacing[2],
      ]);
      tile.setQuaternion(v.q).setScale([v.sign, 1, 1]);
      const clones = new Map<Mesh, Mesh>(),
        model = sources[v.source];
      const clone = (node: Mesh): Mesh => {
        let copy = clones.get(node);
        if (copy) return copy;
        const p = node === model.root ? tile : clone(engine.meshes.get(engine.store.parents[node.id])!);
        copy = engine.createMesh(p);
        meshes.push(copy);
        clones.set(node, copy);
        copy.name = node.name;
        copy.setPosition([node.position.x, node.position.y, node.position.z]);
        copy.setRotation([node.rotation.x, node.rotation.y, node.rotation.z]);
        copy.setScale([node.scale.x, node.scale.y, node.scale.z]);
        copy.setGeometry(node.geometry).setMaterial(node.material);
        copy.visible = node.visible;
        copy.receiveShadow = node.receiveShadow;
        return copy;
      };
      for (const node of templates[v.source]) clone(node);
    }
    return result;
  } catch (error) {
    result.dispose();
    throw error;
  }
}
