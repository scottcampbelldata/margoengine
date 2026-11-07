import { finiteVector } from '@margoengine/math/validate';
import type { SkyFeatures } from './base.js';
/** Stylized night (`night` option): gradient, twinkling stars and a phased moon with glow. */
export const night: NonNullable<SkyFeatures['night']> = {
  wgsl: `// Star-cell hash: the PCG hash (M. O'Neill, PCG, 2014; GPU form in Jarzynski and Olano, "Hash Functions for GPU
// Rendering", JCGT 9(3), 2020), applied to y and then to x plus that result. Integer cells hash exactly on every GPU;
// the top 24 bits give [0, 1) with full fine digits for the twinkle phase.
fn nightPcg(v:u32)->u32 {let s=v*747796405u+2891336453u;let w=((s>>((s>>28u)+4u))^s)*277803737u;return (w>>22u)^w;}
fn hash21(p:vec2f)->f32 {let c=bitcast<vec2u>(vec2i(p));return f32(nightPcg(c.x+nightPcg(c.y))>>8u)*5.9604645e-8;}
fn stylizedNight(r:vec3f,footprint:f32)->vec3f {
 let haze=frame.nightHorizon.w;let moon=frame.nightMoon;let params=frame.nightParams;
 var color=mix(frame.nightZenith.rgb,frame.nightHorizon.rgb,pow(1.0-clamp(r.y,0.0,1.0),2.5/max(haze,0.01))*min(haze,1.0));
 // Fog asks with a zero footprint for the gradient alone: stars and the moon belong to the sky, not to the haze.
 if(footprint<=0.0){return color;}
 let cosine=clamp(dot(r,moon.xyz),-1.0,1.0);
 if(r.y>0.258819){
  // Stereographic cells are square in angle, 434/(1+y) per radian: 3-5 px wide at 1080p down to the 15 degree cutoff.
  let scale=434.0/(1.0+r.y);let cell=r.xz*scale;
  // A star is drawn at least 0.7 px in radius (0.0003 rad when the view resolves it) and dimmed by the area it covers,
  // so its energy holds and a moving camera cannot make it pop between pixels. Stars outgrowing their cell fade out.
  let radius=max(0.0003,footprint*0.7);let size=radius*scale;
  let energy=0.0003*0.0003/(radius*radius)*(1.0-smoothstep(0.35,0.5,size));
  // The four cells around the sample hold every star whose disc reaches it; phases are decorrelated per star.
  let corner=floor(cell-0.5);var stars=0.0;
  for(var i=0u;i<4u;i++){
   let id=corner+vec2f(f32(i&1u),f32(i>>1u));let random=hash21(id);
   if(random>0.975){let twinkle=max(0.0,sin(params.w*2.0+fract(random*613.7)*6.2831853)*0.5*frame.nightZenith.w+0.5);
    stars+=(1.0-smoothstep(0.0,2.0*size,length(cell-id-0.5)))*random*twinkle;}
  }
  color+=vec3f(0.8,0.9,1.0)*stars*energy*params.z*smoothstep(0.258819,0.5,r.y)*(1.0-smoothstep(0.96,1.0,cosine));
 }
 // The disc goes down first, lit and dark parts alike; earthshine keeps the dark part a dim moon rather than a hole.
 var cover=0.0;
 if(cosine>0.0){
  var right=normalize(cross(moon.xyz,select(vec3f(0,1,0),vec3f(0,0,1),abs(moon.y)>0.99)));
  // moonLitBySun (flag 2): the lit limb faces the sun across the sky, as the real moon's does.
  if(frame.sunlight.w>1.5){let s=frame.sun.xyz-moon.xyz*dot(frame.sun.xyz,moon.xyz);if(dot(s,s)>1e-8){right=normalize(s);}}
  let disc=vec2f(dot(r,right),dot(r,cross(right,moon.xyz)))/frame.nightMoonColor.w;let radius=dot(disc,disc);
  // A 0.02 floor on the limb term lets the filtered rim just outside the disc take the lighting just inside it.
  let limb=sqrt(max(0.0004,1.0-radius));let lit=disc.x*sqrt(max(0.0,1.0-params.x*params.x))+limb*params.x;
  // The rim is filtered over half a footprint each side; a sample wider than the disc spreads its energy (celestialProfile).
  let edge=max(0.01,0.5*footprint/frame.nightMoonColor.w);
  cover=(1.0-smoothstep(1.0-edge,1.0+edge,sqrt(radius)))*min(1.0,1.0/(edge*edge));
  color=mix(color,frame.nightMoonColor.rgb*(0.8+0.2*limb)*(smoothstep(0.0,0.02,lit)+0.04),cover);
 }
 // The glow is atmosphere in front of the moon: added last, thinned to 40% over the disc so its dark side reads against it.
 return color+frame.nightMoonColor.rgb*pow(max(cosine,0.0),32.0)*params.y*0.35*(1.0-0.6*cover);
}
`,
  validate(n) {
    if (!n) return;
    for (const color of [n.zenithColor, n.horizonColor, n.moonColor])
      if (color !== undefined) {
        finiteVector(color, 3, 'Sky color');
        if (color.some((v) => v < 0)) throw new RangeError('Sky colors must be non-negative');
      }
    if (n.moonLitBySun !== undefined && typeof n.moonLitBySun !== 'boolean')
      throw new TypeError('Sky night moonLitBySun must be true or false');
    if (n.moonDirection !== undefined) {
      finiteVector(n.moonDirection, 3, 'Moon direction');
      if (!Math.hypot(...n.moonDirection)) throw new RangeError('Moon direction must be nonzero');
    }
    for (const v of [n.moonSize, n.moonPhase, n.glowIntensity, n.starIntensity, n.starTwinkleIntensity, n.hazeDensity])
      if (v !== undefined && !Number.isFinite(Math.fround(v)))
        throw new RangeError('Sky parameters must be finite Float32 numbers');
    if (n.moonSize !== undefined && !(Math.fround(n.moonSize) > 0 && Math.fround(n.moonSize) < Math.PI / 2))
      throw new RangeError('Moon size must be between 0 and PI / 2');
  },
  write(v, n, time) {
    const d = n.moonDirection ?? [0.4, 0.7, 0.5],
      length = Math.hypot(d[0], d[1], d[2]),
      size = n.moonSize ?? 0.038;
    v.set(n.zenithColor ?? [0.015, 0.025, 0.065], 40);
    v[43] = Math.max(0, n.starTwinkleIntensity ?? 1);
    v.set(n.horizonColor ?? [0.08, 0.09, 0.15], 44);
    v[47] = Math.max(0, n.hazeDensity ?? 1);
    for (let i = 0; i < 3; i++) v[48 + i] = d[i] / length;
    v[51] = Math.cos(size);
    v.set(n.moonColor ?? [0.92, 0.95, 1], 52);
    v[55] = Math.sin(size);
    v[56] = Math.max(-1, Math.min(1, n.moonPhase ?? 0.85));
    v[57] = Math.max(0, n.glowIntensity ?? 1.2);
    v[58] = Math.max(0, n.starIntensity ?? 0.8);
    v[59] = time;
    if (n.moonLitBySun) v[63] = 2;
  },
};
