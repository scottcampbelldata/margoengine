import type { Engine, PassContext } from '@margoengine/core/extension';
type Context = Extract<PassContext, { backend: 'webgpu' }>;
export function acquireNativeGlass(engine: Engine, active: () => boolean): () => void;
export function nativeGlass(
  context: Context,
): { copy(context: Context): void; entries: GPUBindGroupEntry[] } | undefined;
export function nativeGlassShader(code: string): string;
