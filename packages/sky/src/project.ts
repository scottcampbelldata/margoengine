// Projection onto nine spherical harmonics (Ramamoorthi and Hanrahan 2001) from the 32 x 16 mip, one workgroup.
// Each coefficient is pre-scaled by its basis constant squared and the clamped-cosine factor over pi (1, 2/3, 1/4), so
// a shader gets irradiance over pi as a plain polynomial in the normal: 1, y, z, x, xy, yz, 3z^2-1, xz, x^2-y^2.
export const project = `
@group(0) @binding(0) var level:texture_2d<f32>;
@group(0) @binding(1) var<storage,read_write> light:array<vec4f,10>;
var<workgroup> sums:array<array<vec3f,9>,64>;
@compute @workgroup_size(64) fn main(@builtin(local_invocation_index) t:u32){
 var c=array<vec3f,9>();
 for(var k=t;k<512u;k+=64u){
  let x=k%32u;let y=k/32u;let phi=((f32(x)+0.5)/32.0-0.5)*6.2831853;let theta=(f32(y)+0.5)/16.0*3.14159265;
  let w=vec3f(sin(theta)*cos(phi),cos(theta),sin(theta)*sin(phi));
  // Radiance times the texel's solid angle, (2 pi / 32)(pi / 16) sin(theta).
  let l=textureLoad(level,vec2i(i32(x),i32(y)),0).rgb*sin(theta)*0.0385531;
  c[0]+=l;c[1]+=l*w.y;c[2]+=l*w.z;c[3]+=l*w.x;c[4]+=l*(w.x*w.y);c[5]+=l*(w.y*w.z);c[6]+=l*(3.0*w.z*w.z-1.0);c[7]+=l*(w.x*w.z);c[8]+=l*(w.x*w.x-w.y*w.y);
 }
 sums[t]=c;
 for(var s=32u;s>0u;s=s>>1u){workgroupBarrier();if(t<s){for(var i=0u;i<9u;i++){sums[t][i]+=sums[t+s][i];}}}
 workgroupBarrier();
 var scale=array<f32,9>(0.0795775,0.1591549,0.1591549,0.1591549,0.2984155,0.2984155,0.0248680,0.2984155,0.0746039);
 if(t<9u){light[t]=vec4f(sums[0][t]*scale[t],0);}
}`;
