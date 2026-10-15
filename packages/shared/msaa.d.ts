import type { PassContext } from '@margoengine/core/extension';
type Context = Extract<PassContext, { backend: 'webgpu' }>;
export class SceneTarget {
  constructor(device: GPUDevice, color: GPUTexture, depth: GPUTexture, samples?: number);
  readonly samples: number;
  readonly color: GPUTextureView;
  readonly depth: GPUTextureView;
  readonly resolvedColor: GPUTexture;
  readonly resolvedDepth: GPUTexture;
  readonly depthSource?: GPUTextureView;
  begin(context: Context): void;
  resolve(encoder: GPUCommandEncoder, final?: boolean): void;
  /** Copies reversed-Z depth; format defaults to the capture depth format. */
  copyDepth(encoder: GPUCommandEncoder, view: GPUTextureView, count: number, format?: GPUTextureFormat): void;
  restore(context: Context): void;
  present(context: Context): void;
  dispose(): void;
}
export function sceneTarget(context: Context): SceneTarget | undefined;
export function resolveMSAA(context: Context): void;

export function sceneSamples(): number;
