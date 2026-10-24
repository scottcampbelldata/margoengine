import type { PassContext } from '@margoengine/core/extension';
export function sectionState(context: Extract<PassContext, { backend: 'webgpu' }>): GPUBufferBinding | undefined;
/**
 * The WGSL statement that discards `position` (default `i.position`) against uniform `name`'s planes: the union of
 * their negative sides for SectionPlanes ('section'), else by settings.y (0 union, 1 intersection).
 */
export function clipStatement(name: string, position?: string): string;
/**
 * `source` with every `i:Out` fragment discarding points behind any of the uniform's planes ({planes: array<vec4f, 6>,
 * settings: vec4f}, plane count in settings.x) at `@group(group) @binding(binding)`, declared as `name` (default
 * 'section'; another name lets one shader carry two sets of planes).
 */
export function sectionShader(source: string, group: number, binding: number, name?: string): string;
