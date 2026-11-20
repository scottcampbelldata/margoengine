// WGSL value noise shared by the effects that need a cheap, repeatable 3D noise: `hash1` (Jarzynski and Olano, "Hash
// Functions for GPU Rendering", JCGT 2020, the PCG output hash), `hash3` (Teschner et al., "Optimized Spatial Hashing
// for Collision Detection of Deformable Objects", 2003, the three primes), and `vnoise3`, trilinear value noise with a
// smoothstep fade. Each returns 0 to 1. Used by the flame and the heat haze, which must agree on the same field.
export const valueNoiseWgsl = `fn hash1(n:u32)->f32 {var x=n*747796405u+2891336453u;x=((x>>((x>>28u)+4u))^x)*277803737u;x=(x>>22u)^x;return f32(x)/4294967295.0;}
fn hash3(p:vec3i)->f32 {let q=bitcast<vec3u>(p);return hash1((q.x*73856093u)^(q.y*19349663u)^(q.z*83492791u));}
fn vnoise3(p:vec3f)->f32 {
  let i=vec3i(floor(p));let f=p-floor(p);let s=f*f*(3.0-2.0*f);
  let a=mix(mix(hash3(i),hash3(i+vec3i(1,0,0)),s.x),mix(hash3(i+vec3i(0,1,0)),hash3(i+vec3i(1,1,0)),s.x),s.y);
  let b=mix(mix(hash3(i+vec3i(0,0,1)),hash3(i+vec3i(1,0,1)),s.x),mix(hash3(i+vec3i(0,1,1)),hash3(i+vec3i(1,1,1)),s.x),s.y);
  return mix(a,b,s.z);
}`;
