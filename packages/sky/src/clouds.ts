import type { SkyFeatures } from './base.js';
/** Procedural cloud layer on a curved shell, lit by the sun through the atmosphere (`clouds` option). */
export const clouds: NonNullable<SkyFeatures['clouds']> = {
  // shortcut: one procedural cloud layer, use volumetric clouds for flight through the layer.
  wgsl: /* wgsl */ `
// Integer hash pcg2d (Jarzynski and Olano 2020): exact on every GPU, where sin-based hashes lose precision far out.
fn cloudHash(p:vec2i)->f32 {
 var v=bitcast<vec2u>(p)*1664525u+1013904223u;
 v.x+=v.y*1664525u;v.y+=v.x*1664525u;v^=v>>vec2u(16u);
 v.x+=v.y*1664525u;v.y+=v.x*1664525u;v^=v>>vec2u(16u);
 return f32(v.x)*2.3283064e-10;
}
fn cloudNoise(p:vec2f)->f32 {
 let cell=vec2i(floor(p));let f=fract(p);let u=f*f*(3.0-2.0*f);
 return mix(mix(cloudHash(cell),cloudHash(cell+vec2i(1,0)),u.x),mix(cloudHash(cell+vec2i(0,1)),cloudHash(cell+vec2i(1)),u.x),u.y);
}
// Octaves first..last-1 of 1 km value noise, each 2.03x finer and turned 37 degrees so lattices never line up. A fine
// octave fades to its mean once a sample covers a cell (footprint in octave-0 cells), as before.
fn cloudOctaves(p:vec2f,footprint:f32,first:u32,last:u32)->f32 {
 var q=p;var fade=footprint;var weight=1.0;var sum=0.0;var total=0.0;
 for(var o=0u;o<last;o++){
  if(o>=first){sum+=mix(cloudNoise(q),0.5,smoothstep(0.35,1.0,fade))*weight;total+=weight;}
  q=mat2x2f(1.621,1.222,-1.222,1.621)*q+vec2f(17,29);fade*=2.03;weight*=0.5;
 }
 return sum/total;
}
// Coverage remap (Schneider 2015): the low-frequency shape says where clouds are, coverage how much sky they fill.
fn cloudCover(shape:f32)->f32 {return clamp((shape-1.0+frame.clouds.x)/max(frame.clouds.x,0.001),0.0,1.0);}
// Two Henyey-Greenstein lobes (Hillaire 2016), forward g=0.6 and back g=-0.25, scaled so isotropic scattering is 1.
fn cloudPhase(nu:f32)->f32 {return mix(0.9375/pow(1.0625+0.5*nu,1.5),0.64/pow(1.36-1.2*nu,1.5),0.6);}
// color: the sky so far (with sun and moon discs); backdrop: the sky alone, which lights the cloud from around it.
fn cloudSky(color:vec3f,backdrop:vec3f,ray:vec3f,angularFootprint:f32)->vec3f {
 // A curved shell at the cloud base around a planet of radius R (km), seen from the eye's altitude: clouds reach the
 // horizon instead of stopping at an angle, and only the ground hides them.
 let r=R+clamp(frame.eye.y*0.001,0.001,99.9);let shell=R+frame.clouds.z*0.001;let mu=ray.y;
 if(frame.clouds.x<=0.0||r>=shell||(mu<0.0&&r*r*(mu*mu-1.0)+R*R>=0.0)){return color;}
 let t=-r*mu+sqrt(r*r*(mu*mu-1.0)+shell*shell);
 // Aerial fade by distance: far clouds thin into the haze (half at 28 km, about 3 degrees up from a 1.5 km base).
 let haze=exp(-t/40.0);if(haze<0.01){return color;}
 // Cosine between the ray and the shell's normal at the hit: grazing rays see longer, more opaque paths.
 let slant=max((r*mu+t)/shell,0.03);
 let p=frame.eye.xz*0.001+ray.xz*t+normalize(vec2f(1,0.35))*frame.clouds.y*0.001;
 let footprint=angularFootprint*t/slant;
 let cover=cloudCover(cloudOctaves(p,footprint,0u,2u));if(cover<=0.0){return color;}
 // The two fine octaves erode the edges into wisps (Schneider 2015).
 let erode=cloudOctaves(p,footprint,2u,4u)*0.35;let density=clamp((cover-erode)/(1.0-erode),0.0,1.0);
 if(density<=0.0){return color;}
 let opacity=(1.0-exp(-density*3.0/max(slant,0.25)))*haze;
 // Sun: three samples toward it through a 0.8 km layer, Beer-Lambert absorption with the powder term (Schneider 2015)
 // where the view looks away from the sun, the two-lobe phase, and the atmosphere's sun colour (0 once it has set).
 let s=frame.sun.xyz;let nu=dot(ray,s);var lit=vec3f(0);
 if(max(frame.sunlight.r,max(frame.sunlight.g,frame.sunlight.b))>0.0){
  let step=s.xz/max(s.y,0.1)*0.13;var depth=density*0.5;
  for(var k=1;k<=3;k++){depth+=cloudCover(cloudOctaves(p+step*f32(k),footprint,0u,2u));}
  let tau=depth*1.2;let powder=mix(1.0-exp(-2.0*tau-0.3),1.0,0.5+0.5*nu);
  lit=frame.sunlight.rgb*1.6*(exp(-tau)*powder*cloudPhase(nu)+0.4*exp(-0.25*tau));
 }
 // Moonlight from the lighting moon, and the surrounding sky as ambient light.
 let moon=frame.moonColor.rgb*frame.moon.w*0.15*cloudPhase(dot(ray,frame.moon.xyz));
 return mix(color,lit+moon+backdrop*(1.0-0.4*density)+vec3f(0.006,0.01,0.02),opacity);
}
`,
  validate(c) {
    if (
      typeof c !== 'object' ||
      c === null ||
      !Number.isFinite(c.coverage ?? 0.45) ||
      (c.coverage ?? 0.45) < 0 ||
      (c.coverage ?? 0.45) > 1 ||
      !Number.isFinite(c.speed ?? 8) ||
      Math.abs(c.speed ?? 8) > 100 ||
      !Number.isFinite(c.height ?? 1500) ||
      (c.height ?? 1500) < 100 ||
      (c.height ?? 1500) > 10000
    )
      throw new RangeError('Invalid sky clouds');
  },
};
