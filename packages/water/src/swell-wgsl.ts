// Margo's three-component swell spectrum and crest bend as WGSL (all constants are Margo tuning), shared by Water's
// surface (coastal.ts `oceanWaves`) and the flood's sea sides (flood-shaders.ts), which feed the same swell trains in
// through the Flather boundary. It needs a `Wave {wave:vec4f,shape:vec4f}` struct in the module that includes it.
/** The Swell struct, the spectrum and the filter. */
export const swellWaves = `
struct Swell {direction:vec2f,gradient:vec2f,phase:f32,amplitude:f32}
// (turn, wavenumber scale, share of the amplitude, phase) of each of a wave's three components.
fn swellComponent(index:u32)->vec4f {
 let spectrum=array<vec4f,3>(vec4f(0,1,0.4,0),vec4f(-0.64,0.84,0.35,2.17),vec4f(0.81,1.18,0.25,4.91));return spectrum[index];
}
// The share of a component of wavenumber k that a mesh of this sample width keeps (none below two samples a wave).
fn swellFilter(k:f32,sampleWidth:f32)->f32 {let t=clamp((6.2831853/(k*1.114)/max(0.0001,sampleWidth)-2.0)*0.5,0.0,1.0);return t*t*(3.0-2.0*t);}
`;
/** The swell component at `time` seconds on any wave clock (Water reads its frame clock, the flood its swell clock). */
export const swellAtWave = `
// The component at \`time\` seconds on the wave clock (the surf reads it where and when the shoaling wave left deep water).
fn swellAt(w:Wave,xz:vec2f,index:u32,sampleWidth:f32,time:f32)->Swell {
 let component=swellComponent(index);
 let rotation=vec2f(cos(component.x),sin(component.x));let d=vec2f(w.wave.x*rotation.x-w.wave.y*rotation.y,w.wave.x*rotation.y+w.wave.y*rotation.x);let across=vec2f(-d.y,d.x);let k=w.wave.w*component.y;let speed=w.shape.y*sqrt(component.y);
 let bend=k*0.35*dot(across,xz)-speed*time*0.12+w.shape.z+component.w;
 // Filter against the maximum bend gradient so amplitudes stay constant along each crest.
 let gradient=k*(d+across*0.49*cos(bend));
 return Swell(d,gradient,k*dot(d,xz)-speed*time+w.shape.z+component.w+1.4*sin(bend),w.wave.z*component.z*min(w.shape.w,swellFilter(k,sampleWidth)));
}
`;
