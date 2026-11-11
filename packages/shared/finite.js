// WGSL for HDR input that may hold NaN or infinities (an overflowing emissive, a broken shader). bad() tests the
// exponent bits, since WGSL lets compilers assume finite floats and may fold x != x away (WGSL spec, floating-point
// evaluation); clean() reads NaN and -Inf as 0 and +Inf as 65504, the largest IEEE 754-2008 binary16, and clamps finite
// values to it. Used by post's Bloom and by Tonemap.
export const cleanShader = `
fn bad(c:vec3f)->vec3<bool>{return (bitcast<vec3u>(c)&vec3u(0x7f800000u))==vec3u(0x7f800000u);}
fn clean(c:vec3f)->vec3f{return select(min(c,vec3f(65504)),select(vec3f(0),vec3f(65504),bitcast<vec3u>(c)==vec3u(0x7f800000u)),bad(c));}
`;
