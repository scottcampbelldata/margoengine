/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel, Mesh as MeshHandle, Geometry, PbrMaterial } from '@margoengine/core';
import { engineRuntime, meshRuntime, type Engine, type Mesh } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { blockState, type BlockTypeOptions } from './blocks.js';
import { chunkKey, type VoxelWorld } from './world.js';

/** A core mesh, or the core mesh graph returned by the glTF loader. Source meshes remain caller owned. */
export type ObjectBlockSource = MeshHandle | { readonly root: MeshHandle; readonly meshes: readonly MeshHandle[] };
/** Object block storage, collision and light properties. Appearance comes from the source mesh materials. */
export type ObjectBlockOptions = Pick<BlockTypeOptions, 'solid' | 'light' | 'opacity'>;
/** Rotation about the cell centre: 0..3 positive quarter turns about +Y. */
export function objectState(id: number, turns = 0): number {
  if (!Number.isInteger(turns) || turns < 0 || turns > 3)
    throw new RangeError('Object turns must be 0..3; pass positive Y quarter turns');
  return blockState(id, turns);
}
interface Node {
  parent: number;
  geometry: Geometry | null;
  material: PbrMaterial;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  receiveShadow: boolean;
  name: string;
}
interface Cell {
  state: number;
  meshes: Mesh[];
}
const xyz = (v: { x: number; y: number; z: number }): [number, number, number] => [v.x, v.y, v.z];

/**
 * Core mesh instances at object-block cells, owned and streamed by their chunks. Shared Geometry identities use
 * core's existing instanced batches; its normal per-mesh frustum tests cull individual placements, including objects
 * extending outside a chunk. Call update after block edits and before rendering. No GPU allocation on construction.
 */
export class VoxelObjects {
  private readonly engine: Engine;
  private readonly templates = new Map<number, readonly Node[]>();
  private readonly pending = new Set<string>();
  private readonly chunks = new Map<string, Map<number, Cell>>();
  private readonly off: (() => void)[];
  private disposed = false;
  constructor(
    engine: EngineKernel,
    readonly world: VoxelWorld,
  ) {
    this.engine = engineRuntime(engine);
    this.off = [
      world.onChunk((cx, cy, cz) => this.pending.add(chunkKey(cx, cy, cz))),
      world.onChange((x, y, z) => this.pending.add(chunkKey(x >> 5, y >> 5, z >> 5))),
    ];
  }
  private check(): void {
    if (this.disposed) throw new MargoError('disposed', 'VoxelObjects is disposed; create a new VoxelObjects');
  }
  /**
   * Defines an object block from a snapshot of a mesh or glTF node graph. Geometry/materials are shared, transforms
   * copied. The source may then be hidden, moved or disposed. Default solid=false and opacity=0.
   */
  define(name: string, source: ObjectBlockSource, options: ObjectBlockOptions = {}): number {
    this.check();
    const model = 'root' in source ? source : undefined,
      root = model ? meshRuntime(model.root) : meshRuntime(source as MeshHandle),
      nodes: Node[] = [],
      seen = new Map<Mesh, number>();
    root.check();
    const visit = (mesh: Mesh): number => {
      mesh.check();
      const known = seen.get(mesh);
      if (known !== undefined) return known;
      let parent = -1;
      if (model && mesh !== root) {
        const p = mesh.engine.meshes.get(mesh.engine.store.parents[mesh.id]);
        if (!p) throw new TypeError('Object source meshes must descend from their model root; pass one glTF Model');
        parent = visit(p);
      }
      const index = nodes.length;
      seen.set(mesh, index);
      nodes.push({
        parent,
        geometry: mesh.geometry,
        material: mesh.material,
        position: xyz(mesh.position),
        rotation: xyz(mesh.rotation),
        scale: xyz(mesh.scale),
        receiveShadow: mesh.receiveShadow,
        name: mesh.name,
      });
      return index;
    };
    for (const mesh of model?.meshes ?? [root]) visit(meshRuntime(mesh));
    if (!nodes.some((n) => n.geometry))
      throw new RangeError('Object source has no geometry; pass a core mesh or loaded glTF Model');
    const id = this.world.blocks.define(name, { solid: false, opacity: 0, ...options, shape: 'object' });
    this.templates.set(id, nodes);
    return id;
  }
  /** Core handles of a placement, root first. Empty if unloaded, not an object, or update has not processed it. */
  at(x: number, y: number, z: number): readonly MeshHandle[] {
    this.check();
    this.world.getBlock(x, y, z);
    return (
      this.chunks.get(chunkKey(x >> 5, y >> 5, z >> 5))?.get((x & 31) | ((z & 31) << 5) | ((y & 31) << 10))?.meshes ??
      []
    );
  }
  /** Loaded chunk, object cell and mesh-node counts, including transform-only nodes. */
  get stats(): { chunks: number; cells: number; meshes: number } {
    let cells = 0,
      meshes = 0;
    for (const chunk of this.chunks.values())
      for (const c of chunk.values()) {
        cells++;
        meshes += c.meshes.length;
      }
    return { chunks: this.chunks.size, cells, meshes };
  }
  /** Reconciles changed chunks. Unchanged cells retain their handles and GPU instance rows. */
  update(): void {
    this.check();
    for (const key of this.pending) {
      const [cx, cy, cz] = key.split(',').map(Number),
        chunk = this.world.getChunk(cx, cy, cz),
        cells = this.chunks.get(key) ?? new Map<number, Cell>();
      if (!chunk) {
        for (const c of cells.values()) this.remove(c);
        this.chunks.delete(key);
        continue;
      }
      for (let i = 0; i < 32768; i++) {
        const x = i & 31,
          y = i >> 10,
          z = (i >> 5) & 31,
          state = chunk.get(x, y, z),
          nodes = this.templates.get(state & 65535),
          old = cells.get(i);
        if (old?.state === state) continue;
        if (old) {
          this.remove(old);
          cells.delete(i);
        }
        if (!nodes) continue;
        const placement = this.engine
          .createMesh()
          .setPosition([cx * 32 + x + 0.5, cy * 32 + y, cz * 32 + z + 0.5])
          .setRotation([0, (((state >>> 16) & 3) * Math.PI) / 2, 0]);
        const made = [placement],
          clones: Mesh[] = [];
        try {
          for (const n of nodes) {
            const mesh = this.engine
              .createMesh(n.parent < 0 ? placement : clones[n.parent])
              .setGeometry(n.geometry)
              .setMaterial(n.material)
              .setPosition(n.position)
              .setRotation(n.rotation)
              .setScale(n.scale);
            mesh.receiveShadow = n.receiveShadow;
            mesh.name = n.name;
            clones.push(mesh);
            made.push(mesh);
          }
        } catch (error) {
          this.remove({ state, meshes: made });
          throw error;
        }
        cells.set(i, { state, meshes: made });
      }
      if (cells.size) this.chunks.set(key, cells);
      else this.chunks.delete(key);
    }
    this.pending.clear();
  }
  private remove(cell: Cell): void {
    for (let i = cell.meshes.length - 1; i >= 0; i--) cell.meshes[i].dispose();
  }
  /** Removes placements and subscriptions. Borrowed geometry/materials and source meshes remain caller owned. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.off) off();
    for (const c of this.chunks.values()) for (const cell of c.values()) this.remove(cell);
    this.chunks.clear();
    this.templates.clear();
    this.pending.clear();
  }
  /** Releases placements with explicit resource management. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}
