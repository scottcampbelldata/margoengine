import type { PassContext } from '@margoengine/core/extension';

type Context = Extract<PassContext, { backend: 'webgpu' }>;
// Optional entries own their shaders, simulation and resources. The root only composes registered effects.
export interface SurfaceEffect {
  key: string;
  vertex: boolean;
  velocity?: string;
  count: number;
  shader(code: string, binding: number): string;
  prepare(context: Context): readonly GPUBindingResource[];
}
export const surfaceEffects = new WeakMap<object, SurfaceEffect[]>();
export function addSurfaceEffect(surface: object, effect: SurfaceEffect): () => void {
  const entries = surfaceEffects.get(surface) ?? [];
  entries.push(effect);
  surfaceEffects.set(surface, entries);
  return () => {
    const index = entries.indexOf(effect);
    if (index >= 0) entries.splice(index, 1);
    if (!entries.length) surfaceEffects.delete(surface);
  };
}
