// Dither for 8-bit output (Gjol, "Low Complexity, High Fidelity: INSIDE", GDC 2016): triangular noise from -1 to 1, a hash of
// the pixel, so a frame repeats exactly. Hash: C. Wellons' "lowbias32" ("Prospecting for Hash Functions", 2018, public
// domain), seeded with the golden-ratio and MurmurHash3 fmix constants.
export const ditherShader = `fn dither(p:vec2f)->f32{
 var x=(u32(p.x)*0x9e3779b9u)^(u32(p.y)*0x85ebca6bu);x=(x^(x>>16u))*0x7feb352du;x=(x^(x>>15u))*0x846ca68bu;x^=x>>16u;
 return f32(x&0xffffu)/65536.0+f32(x>>16u)/65536.0-1.0;
}`;
