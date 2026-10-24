/** WGSL `fn <name>(roughness:f32,nl:f32,nv:f32,nh:f32)->f32`: KHR_materials_sheen Charlie BRDF with the clamped Neubelt visibility. */
export function sheenBrdfWGSL(name: string): string;
/** WGSL `fn <name>(mu:f32,roughness:f32)->f32`: directional albedo min(E, 1) of that sheen BRDF (fitted closed form). */
export function sheenAlbedoWGSL(name: string): string;
