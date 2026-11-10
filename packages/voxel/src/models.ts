/// <reference lib="esnext.disposable" preserve="true" />
import type { Engine } from '@margoengine/core';
import type { Material, MaterialMesh } from '@margoengine/materials';
import { MargoError } from '@margoengine/math/errors';
import { blockState, type BlockTypes, type BlockTypeOptions, type BlockType } from './blocks.js';
import type { ModelBox, ModelOrientation } from './model-data.js';
import { faceCorner, faceRectangles } from './model-surface.js';
import { lightVersion } from './chunk.js';
import { meshBlockModels } from './model-mesh.js';
export { meshBlockModels, type BlockModelSurface } from './model-mesh.js';
import { chunkKey, type VoxelWorld } from './world.js';

export type { ModelBox, ModelOrientation } from './model-data.js';
/** A box of a custom block. Coordinates are in its unit cell. */
export interface BlockModelBox {
  /** Minimum corner, each coordinate in [0,1]. */
  min: readonly [number, number, number];
  /** Maximum corner, strictly above min. */
  max: readonly [number, number, number];
  /** UV rectangle per face (+x,-x,+y,-y,+z,-z), default [0,0,1,1]. Flips are allowed. */
  uv?: readonly (readonly [number, number, number, number])[];
  /** Texture layer per face, default the block type's textures. */
  textures?: readonly [number, number, number, number, number, number];
}
/** Definition passed to defineBlockModel. */
export interface BlockModelOptions extends Omit<BlockTypeOptions, 'shape' | 'model' | 'waterlog'> {
  /** Union of 1 to 64 boxes. */
  boxes: readonly BlockModelBox[];
}

// All 24 proper signed axis permutations, identity first. No trigonometry or accumulated rotation error.
const rotations: number[][] = [];
for (const axes of [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
]) {
  const parity = ((axes[0] - axes[1]) * (axes[1] - axes[2]) * (axes[0] - axes[2])) / -2;
  for (const signs of [
    [1, 1, 1],
    [1, -1, -1],
    [-1, 1, -1],
    [-1, -1, 1],
    [-1, 1, 1],
    [1, -1, 1],
    [1, 1, -1],
    [-1, -1, -1],
  ]) {
    if (parity * signs[0] * signs[1] * signs[2] === 1) rotations.push(axes.map((a, i) => signs[i] * (a + 1)));
  }
}
const rotate = (p: readonly number[], r: readonly number[]) => r.map((a) => (a > 0 ? p[a - 1] : 1 - p[-a - 1]));

/** Defines a custom box union with 24 exact cube orientations and worker-safe metadata. */
export function defineBlockModel(blocks: BlockTypes, name: string, options: BlockModelOptions): number {
  if (!Array.isArray(options?.boxes) || !options.boxes.length || options.boxes.length > 64)
    throw new RangeError('Block model needs 1 to 64 boxes; pass {boxes:[{min:[0,0,0],max:[1,1,1]}]}');
  const texture = options.textures ?? 0,
    fallback = typeof texture === 'number' ? Array(6).fill(texture) : texture;
  const source: ModelBox[] = (options.boxes as readonly BlockModelBox[]).map((box): ModelBox => {
    if (
      !box ||
      box.min?.length !== 3 ||
      box.max?.length !== 3 ||
      box.min.some((n, a) => !Number.isFinite(n) || n < 0 || n >= box.max[a]) ||
      box.max.some((n) => !Number.isFinite(n) || n > 1)
    )
      throw new RangeError('Model boxes need finite 0 <= min < max <= 1 on every axis; correct the box bounds');
    const uv = box.uv ?? Array.from({ length: 6 }, () => [0, 0, 1, 1]);
    if (uv.length !== 6 || uv.some((r) => r.length !== 4 || r.some((n) => !Number.isFinite(n))))
      throw new RangeError('Model UVs need six finite [u0,v0,u1,v1] rectangles; correct the face UVs');
    const textures = box.textures ?? fallback;
    if (
      textures.length !== 6 ||
      textures.some((n) => !Number.isInteger(n) || n < 0 || n + (options.animation?.frames ?? 1) > 2048)
    )
      throw new RangeError(
        'Model textures need six layers in 0..2047 with room for animation frames; correct the layers',
      );
    return {
      min: [...box.min],
      max: [...box.max],
      textures: [...textures],
      uv: uv.map(([u, v, s, t]) => [u, v, s, v, s, t, u, t]),
    };
  });
  const model: ModelOrientation[] = rotations.map((r) => {
    const boxes = source.map((box) => {
      const lo = rotate(box.min, r),
        hi = rotate(box.max, r),
        min = lo.map((x, a) => Math.min(x, hi[a])) as [number, number, number],
        max = lo.map((x, a) => Math.max(x, hi[a])) as [number, number, number];
      const out: ModelBox = {
        min,
        max,
        uv: Array.from({ length: 6 }, () => [] as number[]),
        textures: Array(6).fill(0),
      };
      for (let d = 0; d < 6; d++) {
        const a = d >> 1,
          dest = r.findIndex((x) => Math.abs(x) === a + 1),
          nd = dest * 2 + (r[dest] > 0 === !(d & 1) ? 0 : 1);
        (out.textures as number[])[nd] = box.textures[d];
        for (let c = 0; c < 4; c++) {
          const p = rotate(faceCorner(box, d, c), r),
            nc = [0, 1, 2, 3].find((k) => faceCorner(out, nd, k).every((x, i) => x === p[i])) as number;
          (out.uv[nd] as number[])[nc * 2] = box.uv[d][c * 2];
          (out.uv[nd] as number[])[nc * 2 + 1] = box.uv[d][c * 2 + 1];
        }
      }
      return out;
    });
    let covered = 0;
    const unit: ModelBox = { min: [0, 0, 0], max: [1, 1, 1], uv: [], textures: [] };
    for (let d = 0; d < 6; d++) {
      const a = d >> 1,
        touching = boxes.filter((b) => (d & 1 ? b.min[a] : b.max[a]) === (d & 1 ? 0 : 1));
      // Extend touching boxes through the boundary to reuse exact rectangle subtraction.
      const blockers = touching.map((b) => ({
        ...b,
        min: b.min.map((n, i) => (i === a ? -1 : n)) as [number, number, number],
        max: b.max.map((n, i) => (i === a ? 2 : n)) as [number, number, number],
      }));
      if (!faceRectangles(unit, d, blockers).length) covered |= 1 << d;
    }
    return { boxes, covered };
  });
  return blocks.define(name, { ...options, shape: 'model', model, opacity: options.opacity ?? 0 });
}

/** State of a model in orientation 0..23. Identity is 0; all rotations are right-handed. */
export function modelState(id: number, orientation = 0): number {
  if (!Number.isInteger(orientation) || orientation < 0 || orientation >= 24)
    throw new RangeError('Model orientation must be 0..23; use 0 for identity');
  return blockState(id, orientation);
}

/** Options of VoxelModelRenderer. */
export interface VoxelModelRendererOptions {
  /** Override the material per type and texture layer; default block colour/PBR factors. Materials remain caller owned. */
  material?: (type: BlockType, texture: number) => Material;
}

/** Chunk-streamed textured model meshes. Call update after lighting, before engine.render. */
export class VoxelModelRenderer {
  /** Loads the optional materials renderer. An aborted signal rejects with its original reason. */
  static async create(
    engine: Engine,
    world: VoxelWorld,
    options: VoxelModelRendererOptions = {},
    signal?: AbortSignal,
  ): Promise<VoxelModelRenderer> {
    signal?.throwIfAborted();
    const runtime = await import('@margoengine/materials');
    signal?.throwIfAborted();
    return new VoxelModelRenderer(engine, world, options, runtime);
  }
  private readonly pending = new Set<string>();
  private readonly meshes = new Map<string, MaterialMesh[]>();
  private readonly off: (() => void)[] = [];
  private readonly materials = new Map<string, Material>();
  private disposed = false;
  private readonly versions = new Map<string, number>();
  private readonly owned = new Set<Material>();
  private constructor(
    private readonly engine: Engine,
    readonly world: VoxelWorld,
    private readonly options: VoxelModelRendererOptions = {},
    private readonly runtime: typeof import('@margoengine/materials'),
  ) {
    this.off.push(world.onChunk((cx, cy, cz) => this.mark(cx, cy, cz)));
    this.off.push(world.onChange((x, y, z) => this.mark(x >> 5, y >> 5, z >> 5)));
  }
  private mark(cx: number, cy: number, cz: number): void {
    for (const [x, y, z] of [
      [0, 0, 0],
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ]) {
      const next = [cx + x, cy + y, cz + z];
      if (next.every((n) => (n << 5) >> 5 === n)) this.pending.add(chunkKey(next[0], next[1], next[2]));
    }
  }
  /** Rebuilds changed chunks. Dirty lighting keys are observed without consuming the main renderer's queue. */
  update(): void {
    if (this.disposed) throw new MargoError('disposed', 'Model renderer is disposed; create a new VoxelModelRenderer');
    for (const key of this.world.dirty) {
      const [cx, cy, cz] = key.split(',').map(Number),
        chunk = this.world.getChunk(cx, cy, cz);
      if (chunk && this.versions.get(key) !== lightVersion(chunk)) this.pending.add(key);
    }
    for (const key of this.pending) {
      for (const m of this.meshes.get(key) ?? []) m.destroy();
      this.meshes.delete(key);
      this.versions.delete(key);
      const [cx, cy, cz] = key.split(',').map(Number),
        made: MaterialMesh[] = [];
      for (const surface of meshBlockModels(this.world, cx, cy, cz)) {
        const t = surface.type,
          k = `${t.id}:${surface.texture}`;
        let material = this.materials.get(k);
        if (!material)
          this.materials.set(
            k,
            (material =
              this.options.material?.(t, surface.texture) ??
              new this.runtime.Material({
                color: [...t.color],
                roughness: t.roughness,
                metalness: t.metalness,
                emissive: [...t.color].map((c) => c * t.emissive) as [number, number, number],
                transparent: t.layer === 'translucent',
                alphaTest: t.layer === 'cutout' ? 0.5 : 0,
              })),
          );
        if (!this.options.material) this.owned.add(material);
        made.push(this.runtime.createMesh(this.engine, surface, material));
      }
      if (made.length) this.meshes.set(key, made);
      const chunk = this.world.getChunk(cx, cy, cz);
      if (chunk) this.versions.set(key, lightVersion(chunk));
    }
    this.pending.clear();
  }
  /** Releases all chunk meshes and subscriptions; caller materials and textures stay alive. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.off) off();
    for (const list of this.meshes.values()) for (const m of list) m.destroy();
    for (const m of this.owned) m.dispose();
    this.meshes.clear();
    this.pending.clear();
    this.materials.clear();
    this.owned.clear();
    this.versions.clear();
  }
  /** Releases the renderer for explicit resource management. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}
