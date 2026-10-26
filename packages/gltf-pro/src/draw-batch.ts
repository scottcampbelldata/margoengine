// Draws of one PBRDrawRun that would differ only in their node matrix (same material record, derivation, geometry and
// bind groups) draw as one instanced draw. 10,000 materials meshes of a few materials and one geometry were 10,000
// draws, each with its own uniform write, bind group, vertex and index buffer binds; they are now a few instanced draws
// whose instance rows are the meshes' world matrices, written only when a mesh moves. The instanced vertex stage is
// gltf-pro's own (PBRInstances): world = model x instance with the model rows set to identity, so positions are the
// same; normals come from the matrix cofactors instead of the CPU inverse transpose, the same direction once the
// fragment normalizes them. Opaque draws of a run may reorder between batches (as engines sort opaque draws by
// material); each batch keeps its meshes in draw order. Blended draws never reorder: one joins only the batch drawn
// last, so a batch is a run of consecutive draws (instances rasterize in order), and draws of materials that differ
// only in base colour fold into it with their colours as instance tints. Wireframe draws batch as line lists.
import { instanceLayout } from '../../shared/instances.js';
import { retire } from '../../shared/frame-resources.js';
import { instancedShader } from './instanced-shader.js';
import type { UniformSlot } from './uniform-arena.js';

declare const GPUBufferUsage: { VERTEX: number; COPY_DST: number };

/**
 * What gltf-pro's derivation reads of a batch's instancing (as of a `PBRInstances`): the instance layout, the
 * instanced vertex stage and whether the rows are mirrored. One per handedness, shared by every batch, so every batch
 * of a material shares one derivation and pipeline.
 */
export class BatchKind {
  readonly layout = instanceLayout as GPUVertexBufferLayout;
  constructor(readonly mirrored: boolean) {}
  shader(code: string): string {
    return instancedShader(code);
  }
}
const kinds = [new BatchKind(false), new BatchKind(true)];
/** The batch kind for draws whose node matrices are mirrored (negative determinant) or not. */
export const batchKind = (mirrored: boolean): BatchKind => kinds[+mirrored];

/** The instance rows of a batch of several meshes. */
export class BatchInstances {
  /** 24 floats a row: world matrix, tint (1), UV scale (1) and offset (0). */
  data = new Float32Array(0);
  buffer?: GPUBuffer;
  /** Rows the GPU buffer holds as uploaded. */
  private uploaded = 0;
  /** True when the rows hold exactly `matrices` and `tints` (see `write`), as uploaded. */
  holds(matrices: readonly ArrayLike<number>[], tints?: readonly ArrayLike<number>[]): boolean {
    if (matrices.length > this.uploaded) return false;
    const data = this.data;
    for (let i = 0; i < matrices.length; i++) {
      for (let k = 0; k < 16; k++) if (data[i * 24 + k] !== Math.fround(matrices[i][k])) return false;
      for (let k = 0; k < 4; k++) if (data[i * 24 + 16 + k] !== (tints ? Math.fround(tints[i][k]) : 1)) return false;
    }
    return true;
  }
  /**
   * Writes the rows' world matrices and tints (each member's base colour when the batch folds several materials, else
   * 1) and uploads the changed range. Returns the vertex buffer.
   */
  write(device: GPUDevice, matrices: readonly ArrayLike<number>[], tints?: readonly ArrayLike<number>[]): GPUBuffer {
    const count = matrices.length;
    if (this.data.length < count * 24) {
      const capacity = Math.max(count, Math.ceil((this.data.length / 24) * 1.5), 16),
        data = new Float32Array(capacity * 24);
      data.set(this.data);
      for (let i = this.data.length / 24; i < capacity; i++) {
        const o = i * 24;
        data[o + 16] = data[o + 17] = data[o + 18] = data[o + 19] = 1;
        data[o + 20] = data[o + 21] = 1;
      }
      this.data = data;
      if (this.buffer) retire(device, this.buffer);
      this.buffer = undefined;
      this.uploaded = 0;
    }
    const data = this.data;
    let lo = count,
      hi = 0;
    for (let i = 0; i < count; i++) {
      const m = matrices[i],
        o = i * 24;
      let changed = i >= this.uploaded;
      for (let k = 0; k < 16; k++)
        if (data[o + k] !== m[k]) {
          data[o + k] = m[k];
          changed = true;
        }
      const t = tints?.[i];
      for (let k = 0; k < 4; k++) {
        const value = t ? Math.fround(t[k]) : 1;
        if (data[o + 16 + k] !== value) {
          data[o + 16 + k] = value;
          changed = true;
        }
      }
      if (changed) {
        if (i < lo) lo = i;
        hi = i + 1;
      }
    }
    if (!this.buffer)
      this.buffer = device.createBuffer({
        label: 'gltf-pro draw batch',
        size: data.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    if (lo < hi) device.queue.writeBuffer(this.buffer, lo * 96, data, lo * 24, (hi - lo) * 24);
    if (count > this.uploaded) this.uploaded = count;
    return this.buffer;
  }
  destroy(device: GPUDevice): void {
    if (this.buffer) retire(device, this.buffer);
    this.buffer = undefined;
    this.uploaded = 0;
  }
}

/** A batch's GPU state, kept on its first draw's resource across frames (one per derivation and view). */
export interface BatchState {
  instances: BatchInstances;
  /** The batch's uniform: the derivation's rows with identity model rows. */
  uniform: UniformSlot;
  /** Group 0 by pipeline and uniform binding. */
  groups: Map<GPURenderPipeline, Map<GPUBufferBinding, GPUBindGroup>>;
  /** The frame and view that last drew it. */
  frame: number;
  view: object;
}
