/** Shared complementary screen-space threshold for mesh and imposter LOD transitions (Jimenez 2014). */
export const fadeTest = `fn lod_fade_keep(lod_at:vec2f,lod_f:f32)->bool {let d=fract(52.9829189*fract(dot(floor(lod_at),vec2f(0.06711056,0.00583715))));if(lod_f>0.0){return d<lod_f;}return lod_f==0.0||d>=-lod_f;}`;
