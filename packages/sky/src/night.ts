import { finiteVector } from '@margoengine/math/validate';
import type { SkyFeatures } from './base.js';
/** Stylized night (`night` option): gradient, twinkling stars and a phased moon with glow. */
export const night: NonNullable<SkyFeatures['night']> = {
  wgsl: `fn hash21(p:vec2f)->f32 {var q=fract(p.xyx*0.1031);q+=dot(q,q.yzx+33.33);return fract((q.x+q.y)*q.z);}
fn stylizedNight(r:vec3f)->vec3f {
 let haze=frame.nightHorizon.w;let moon=frame.nightMoon;let params=frame.nightParams;
 var color=mix(frame.nightZenith.rgb,frame.nightHorizon.rgb,pow(1.0-clamp(r.y,0.0,1.0),2.5/max(haze,0.01))*min(haze,1.0));
 let cosine=clamp(dot(r,moon.xyz),-1.0,1.0);
 if(r.y>0.258819){
  let cell=r.xz/(r.y+0.15)*250.0;let random=hash21(floor(cell));
  if(random>0.985){let twinkle=max(0.0,sin(params.w*2.0+random*6.28)*0.5*frame.nightZenith.w+0.5);
   color+=vec3f(0.8,0.9,1.0)*(1.0-smoothstep(0.01,0.12,length(fract(cell)-0.5)))*random*twinkle*params.z*smoothstep(0.258819,0.5,r.y)*(1.0-smoothstep(0.96,1.0,cosine));}
 }
 color+=frame.nightMoonColor.rgb*pow(max(cosine,0.0),32.0)*params.y*0.35;
 if(cosine>moon.w){
  let right=normalize(cross(moon.xyz,select(vec3f(0,1,0),vec3f(0,0,1),abs(moon.y)>0.99)));
  let disc=vec2f(dot(r,right),dot(r,cross(right,moon.xyz)))/frame.nightMoonColor.w;let radius=dot(disc,disc);let limb=sqrt(max(0.0,1.0-radius));
  let lit=disc.x*sqrt(max(0.0,1.0-params.x*params.x))+limb*params.x;
  color=mix(color,frame.nightMoonColor.rgb*(0.8+0.2*limb)*smoothstep(0.0,0.02,lit),1.0-smoothstep(0.96,1.0,radius));
 }
 return color;
}
`,
  validate(n) {
    if (!n) return;
    for (const color of [n.zenithColor, n.horizonColor, n.moonColor])
      if (color !== undefined) {
        finiteVector(color, 3, 'Sky color');
        if (color.some((v) => v < 0)) throw new RangeError('Sky colors must be non-negative');
      }
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
  },
};
