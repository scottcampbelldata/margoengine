/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel, Mesh as MeshHandle, Geometry, PbrMaterial } from '@margoengine/core';
import { engineRuntime, meshRuntime, type Engine, type Mesh } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { blockState, type BlockTypeOptions } from './blocks.js';
import { chunkKey, type VoxelWorld } from './world.js';
import type { VoxelOrigin } from './render.js';
import { checkOrigin, originPoint } from './origin.js';

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
/** Options of {@link VoxelObjects.attach}. */
export interface VoxelObjectsOptions {
  /**
   * Origin rebasing for worlds far from zero, as `VoxelRendererOptions.origin` (pass the same object): an object whose
   * `origin` is the float64 world point (blocks) drawn at engine zero, such as a `FloatingOrigin` of
   * `@margoengine/cameras/origin`; read every update. Placements sit at their cell minus the origin in float64, so
   * their float32 positions stay small wherever the world is. Default null (world and engine space are the same).
   */
  origin?: VoxelOrigin | null;
}
const xyz = (v: { x: number; y: number; z: number }): [number, number, number] => [v.x, v.y, v.z];

/**
 * Core mesh instances at object-block cells, owned and streamed by their chunks. Shared Geometry identities use
 * core's existing instanced batches; its normal per-mesh frustum tests cull individual placements, including objects
 * extending outside a chunk. Call update after block edits and before rendering. No GPU allocation on construction.
 */
export class VoxelObjects {
  /**
   * Subscribes object-block placement to this world. Call update before rendering.
   * @throws TypeError when `origin` is not null or an object with `origin`.
   */
  static attach(engine: EngineKernel, world: VoxelWorld, options: VoxelObjectsOptions = {}): VoxelObjects {
    return new VoxelObjects(engine, world, options);
  }
  /** Live {@link VoxelObjectsOptions.origin}; null for none. */
  origin: VoxelOrigin | null;
  private placed: [number, number, number] = [0, 0, 0];
  private readonly engine: Engine;
  private readonly templates = new Map<number, readonly Node[]>();
  private readonly pending = new Set<string>();
  private readonly chunks = new Map<string, Map<number, Cell>>();
  private readonly off: (() => void)[];
  private disposed = false;
  constructor(
    engine: EngineKernel,
    readonly world: VoxelWorld,
    options: VoxelObjectsOptions = {},
  ) {
    this.engine = engineRuntime(engine);
    this.origin = checkOrigin(options?.origin, 'VoxelObjects');
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
    // Each placement adds one parent above the copied nodes, and core allows 63 parents above a mesh.
    const depth = (n: Node): number => (n.parent < 0 ? 0 : 1 + depth(nodes[n.parent]));
    if (nodes.some((n) => depth(n) >= 63))
      throw new RangeError(
        'Object source nests 64 or more meshes deep; placements add one level and core allows 63, so flatten the graph',
      );
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
  /**
   * Moves every placement when the origin moved, then reconciles changed chunks. Unchanged cells retain their handles
   * and GPU instance rows.
   * @throws RangeError when the origin holds a value that is not a finite number.
   */
  update(): void {
    this.check();
    const shift = originPoint(this.origin, 'VoxelObjects');
    if (shift.some((v, a) => v !== this.placed[a])) {
      this.placed = shift;
      for (const [key, cells] of this.chunks) {
        const [cx, cy, cz] = key.split(',').map(Number);
        for (const [i, cell] of cells) cell.meshes[0].setPosition(this.cellPosition(cx, cy, cz, i, shift));
      }
    }
    for (const key of this.pending) {
      const [cx, cy, cz] = key.split(',').map(Number),
        chunk = this.world.getChunk(cx, cy, cz),
        cells = this.chunks.get(key) ?? new Map<number, Cell>();
      if (!chunk) {
        for (const c of cells.values()) this.remove(c);
        this.chunks.delete(key);
        continue;
      }
      // The chunk's cell map is stored even when a placement throws part way, so the placements made before it stay
      // owned (dispose releases them, the retry keeps them); the key stays pending and the next update finishes it.
      try {
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
            .setPosition(this.cellPosition(cx, cy, cz, i, shift))
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
      } finally {
        if (cells.size) this.chunks.set(key, cells);
        else this.chunks.delete(key);
      }
    }
    this.pending.clear();
  }
  // A placement's position: the bottom centre of cell i of chunk (cx, cy, cz) minus the origin, in float64.
  private cellPosition(
    cx: number,
    cy: number,
    cz: number,
    i: number,
    shift: readonly number[],
  ): [number, number, number] {
    return [
      cx * 32 + (i & 31) + 0.5 - shift[0],
      cy * 32 + (i >> 10) - shift[1],
      cz * 32 + ((i >> 5) & 31) + 0.5 - shift[2],
    ];
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
