// Sunlight seen through thin leaves and blades: wrapped back-light translucency (C. Barre-Brisebois and M. Bouchard,
// "Approximating Translucency for a Fast, Cheap and Convincing Subsurface Scattering Look", GDC 2011). A surface
// facing away from the sun glows when the camera looks toward the sun, plus a wrapped term on the side away from it.
// Shared by ScatterInstances' foliage and Scatter's grass blades.
export const translucencyShader = /* wgsl */ `
fn foliageTranslucency(n:vec3f,v:vec3f,l:vec3f,occlusion:f32,strength:f32)->f32 {
 let back=pow(clamp(dot(v,-normalize(l+n*0.4)),0.0,1.0),4.0);let wrap=clamp((0.5-dot(n,l))/1.5,0.0,1.0);
 return strength*occlusion*(back+0.3*wrap)/3.14159265;
}
`;
