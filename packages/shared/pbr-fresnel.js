// The dielectric Fresnel of KHR_materials_specular, shared by gltf-pro's physical shader and materials' Transmission pass:
// specular * (f0 + (1 - f0) * (1 - c)^5), so a specular of 0 reflects nothing at any angle. `f0` is already weighted, so
// `weight` is the F90. What lies under it keeps 1 - max(F), one number for all channels.
export const dielectricFresnelWGSL = `fn margoDielectricFresnel(f0:vec3f,weight:f32,c:f32)->vec3f {return f0+(weight-f0)*pow(1.0-c,5.0);}
fn margoFresnelPeak(fresnel:vec3f)->f32 {return max(fresnel.r,max(fresnel.g,fresnel.b));}
`;
