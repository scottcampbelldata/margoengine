import type { PassContext } from '@margoengine/core/extension';
export function sectionState(context: Extract<PassContext, { backend: 'webgpu' }>): GPUBufferBinding | undefined;
/**
 * The WGSL statement that discards `position` (default `i.position`) against uniform `name`'s planes: the union of
 * their negative sides for a scene `section` plugin ('section'), else by settings.y (0 union, 1 intersection).
 */
export function clipStatement(name: string, position?: string): string;
/**
 * `source` with every `i:Out` fragment discarding points behind any of the uniform's planes ({planes: array<vec4f, N>,
 * settings: vec4f}, N = `planeCapacity(name)`, plane count in settings.x) at `@group(group) @binding(binding)`, declared as `name` (default
 * 'section'; another name lets one shader carry two sets of planes).
 */
/** How many planes uniform `name` holds: 6 for a scene's 'section' plugin, 16 for a material's (any other name). */
export function planeCapacity(name: string): number;
/** The most planes cut in the rasterizer through clip distances (8). */
export const hardwarePlanes: number;
export function sectionShader(source: string, group: number, binding: number, name?: string): string;
export function clipDeclaration(group: number, binding: number, name: string): string;
export function clipDistances(code: string, name: string, position?: string): string;
export function markClipDistances(code: string, group: number, binding: number, name: string): string;
export function markedClipDistances(code: string): string;
