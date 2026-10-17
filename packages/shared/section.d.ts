import type { PassContext } from '@margoengine/core/extension';
export function sectionState(context: Extract<PassContext, { backend: 'webgpu' }>): GPUBufferBinding | undefined;
export function sectionShader(source: string, group: number, binding: number): string;
