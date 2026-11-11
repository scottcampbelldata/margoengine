import type { Engine, PassContext } from '@margoengine/core/extension';
type Context = Extract<PassContext, { backend: 'webgpu' }>;
export function acquireNativeGlass(engine: Engine, active: () => boolean): () => void;
export function nativeGlass(
  context: Context,
): { copy?(context: Context): void; reopen?(pass: GPURenderPassEncoder): GPURenderPassEncoder; entries: GPUBindGroupEntry[] } | undefined;
export function nativeGlassShader(code: string): string;
export interface ExternalNativeGlass {
  install(
    context: Context,
    hook: (pass: GPURenderPassEncoder, target: GPUTexture) => GPURenderPassEncoder,
  ): void;
  reopen(pass: GPURenderPassEncoder): GPURenderPassEncoder;
  finish(context: Context): void;
  release(): void;
}
export function externalNativeGlass(device: GPUDevice): ExternalNativeGlass;
