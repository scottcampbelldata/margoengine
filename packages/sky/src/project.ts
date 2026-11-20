// Projection onto nine spherical harmonics (Ramamoorthi and Hanrahan 2001) from the 32 x 16 mip, one workgroup.
// Each coefficient is pre-scaled by its basis constant squared and the clamped-cosine factor over pi (1, 2/3, 1/4), so
// a shader gets irradiance over pi as a plain polynomial in the normal: 1, y, z, x, xy, yz, 3z^2-1, xz, x^2-y^2.
// The ground: with an albedo rho (light[10].w above 0) the lower half is the light the ground reflects, not the map's
// dark below-horizon colour. The ground is a level Lambertian plane lit by the sky's upper half and the sun, so its
// radiance is rho (E_sky + E_sun) / pi (the uniform ground of the CIE and Perez daylight models, ground reflectance
// 0.2 by default: CIE 110-1994, "Spatial distribution of daylight: luminance distributions of various reference
// skies"; Perez, Seals and Michalsky, "All-weather model for sky luminance distribution", Solar Energy 50(3), 1993;
// the isotropic ground-reflected term of Liu and Jordan, "Daily insolation on surfaces tilted towards the equator",
// ASHRAE Journal 3(10), 1961). E_sky is the map's upper half summed against the cosine; light[10].rgb holds the sun's
// E / pi on level ground in the sky's units. A uniform lower half adds only to the first two coefficients: its
// integral against 1 over the lower hemisphere is 2 pi, against y is -pi, and against the other seven is 0.
export const project = `
@group(0) @binding(0) var level:texture_2d<f32>;
@group(0) @binding(1) var<storage,read_write> light:array<vec4f,11>;
var<workgroup> sums:array<array<vec3f,10>,64>;
@compute @workgroup_size(64) fn main(@builtin(local_invocation_index) t:u32){
 var c=array<vec3f,10>();
 let ground=light[10].w>0.0;
 for(var k=t;k<512u;k+=64u){
  let x=k%32u;let y=k/32u;let phi=((f32(x)+0.5)/32.0-0.5)*6.2831853;let theta=(f32(y)+0.5)/16.0*3.14159265;
  let w=vec3f(sin(theta)*cos(phi),cos(theta),sin(theta)*sin(phi));
  // Radiance times the texel's solid angle, (2 pi / 32)(pi / 16) sin(theta); the lower half is the ground's below.
  let l=select(textureLoad(level,vec2i(i32(x),i32(y)),0).rgb*sin(theta)*0.0385531,vec3f(0),ground&&w.y<0.0);
  c[0]+=l;c[1]+=l*w.y;c[2]+=l*w.z;c[3]+=l*w.x;c[4]+=l*(w.x*w.y);c[5]+=l*(w.y*w.z);c[6]+=l*(3.0*w.z*w.z-1.0);c[7]+=l*(w.x*w.z);c[8]+=l*(w.x*w.x-w.y*w.y);
  c[9]+=l*max(w.y,0.0);
 }
 sums[t]=c;
 for(var s=32u;s>0u;s=s>>1u){workgroupBarrier();if(t<s){for(var i=0u;i<10u;i++){sums[t][i]+=sums[t+s][i];}}}
 workgroupBarrier();
 var scale=array<f32,9>(0.0795775,0.1591549,0.1591549,0.1591549,0.2984155,0.2984155,0.0248680,0.2984155,0.0746039);
 let lg=select(vec3f(0),light[10].w*(sums[0][9]/3.14159265+light[10].rgb),ground);
 var add=array<vec3f,9>(lg*6.2831853,-lg*3.14159265,vec3f(0),vec3f(0),vec3f(0),vec3f(0),vec3f(0),vec3f(0),vec3f(0));
 if(t<9u){light[t]=vec4f((sums[0][t]+add[t])*scale[t],0);}
}`;
