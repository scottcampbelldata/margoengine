import type { PickHit } from './picking.js';

/** Extension contract for optional GPU surface attributes. Picking owns the query and mapping lifetime. */
export interface PickSurface {
  readonly targets: GPUColorTargetState[];
  readonly views: GPUTextureView[];
  setup(device: GPUDevice): void;
  shader(code: string, kind: 'core' | 'model' | 'primitive'): string;
  buffers(buffers: GPUVertexBufferLayout[], kind: 'core' | 'model' | 'primitive'): GPUVertexBufferLayout[];
  copy(encoder: GPUCommandEncoder, buffer: GPUBuffer, offset: number, origin: number[], size: number[]): void;
  decode(hit: PickHit, data: Uint32Array, offset: number, x: number, y: number, matrix: Float32Array, eye: readonly number[], origin: number[]): void;
  dispose(): void;
}
