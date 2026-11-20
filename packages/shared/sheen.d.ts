/** WGSL `fn <name>(roughness:f32,nl:f32,nv:f32,nh:f32)->f32`: KHR_materials_sheen Charlie BRDF with Estevez and Kulla 2017 shadowing. */
export function sheenBrdfWGSL(name: string): string;
/** WGSL `fn <name>(nv:f32,nl:f32,v:vec3f,l:vec3f)->f32`: n.h for that BRDF from the clamped cosines, (nv + nl) / |v + l|. */
export function sheenHalfWGSL(name: string): string;
/** Layout of the albedo table: size x size nodes over u = (mu (R + k) / (R + k mu))^p and v = sqrt(r). */
export const sheenAlbedoGrid: { readonly size: number; readonly k: number; readonly p: number };
/** ln(E R) at the table nodes, row after row (fitted by scripts/sheen-albedo-fit.mjs). */
export const sheenAlbedoTable: readonly number[];
/** WGSL `const <name>Table` and `fn <name>(mu:f32,roughness:f32)->f32`: directional albedo min(E, 1) of that sheen BRDF. */
export function sheenAlbedoWGSL(name: string, table?: readonly number[]): string;
