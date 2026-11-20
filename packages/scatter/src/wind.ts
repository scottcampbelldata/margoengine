/**
 * Horizontal direction (x,z), maximum bend strength in [0,1] and, optionally, the mean wind speed in m/s at 10 m (0 to
 * 100), which sets how fast the plants thrash (`windClockRate`).
 */
export type ScatterWind = readonly [number, number, number] | readonly [number, number, number, number];
const BAD_WIND =
  'Invalid scatter wind; pass [x, z, strength] or [x, z, strength, speed] as finite numbers, a non-zero direction, strength from 0 to 1 and speed from 0 to 100 m/s.';
export function validateWind(wind: ScatterWind): number {
  if (
    (wind.length !== 3 && wind.length !== 4) ||
    wind[2] < 0 ||
    wind[2] > 1 ||
    !Math.hypot(Math.fround(wind[0]), Math.fround(wind[1])) ||
    (wind.length === 4 && !(wind[3]! >= 0 && wind[3]! <= 100))
  )
    throw new RangeError(BAD_WIND);
  for (let i = 0; i < wind.length; i++) if (!Number.isFinite(Math.fround(wind[i]!))) throw new RangeError(BAD_WIND);
  return Math.hypot(wind[0], wind[1]);
}

/**
 * The wind speed in m/s (10 m) up to which the plants keep their own sway: 5.4, the top of Beaufort force 3 (gentle
 * breeze) in the WMO table. Below it a plant sways near its natural frequency, whatever the wind (de Langre 2008).
 */
export const WIND_THRASH_FROM = 5.4;
/**
 * How many seconds of wind motion pass per second at a mean wind of `speed` m/s: 1 up to {@link WIND_THRASH_FROM},
 * then speed / 5.4, so the gusts and the leaf flutter come faster as the wind rises through the Beaufort forces (2 at
 * a force 6 strong breeze, 3.2 at a force 8 gale, 6.1 at hurricane force). The frequency of the gusts a canopy feels
 * grows in proportion to the mean speed (the canopy mixing layer's frequency U / h, Raupach, Finnigan and Brunet 1996;
 * the waving crop of Py, de Langre and Moulia 2006), and so does a leaf's flutter (vortex shedding, f = St U / d).
 */
export function windClockRate(speed: number): number {
  if (!(speed >= 0 && speed <= 100)) throw new RangeError('windClockRate needs a wind speed from 0 to 100 m/s');
  return Math.max(1, speed / WIND_THRASH_FROM);
}
export const windShader = /* wgsl */ `
fn windBend(height:f32,root:vec2f,wind:vec4f)->vec3f {
 let h=max(0.0,height);let phase=dot(root,vec2f(0.17,0.11));
 let gust=(0.65*sin(wind.w*1.7+phase)+0.35*sin(wind.w*0.73+phase*1.9))*wind.z;
 let direction=wind.xy/max(length(wind.xy),0.0001);
 return vec3f(direction*gust*h*h/(1.0+h),gust*h*(2.0+h)/((1.0+h)*(1.0+h)));
}
fn windNormal(normal:vec3f,bend:vec3f,wind:vec4f)->vec3f {
 let direction=wind.xy/max(length(wind.xy),0.0001);
 return vec3f(normal.x,normal.y-dot(normal.xz,direction)*bend.z,normal.z);
}
struct WindDeformation {offset:vec2f,gradient:vec3f}
fn windDeformation(position:vec3f,root:vec3f,wind:vec4f,detail:f32)->WindDeformation {
 let bend=windBend(position.y-root.y,root.xz,wind);
 if(detail==0.0||wind.z==0.0){return WindDeformation(bend.xy,vec3f(0,bend.z,0));}
 let h=max(0.0,position.y-root.y);let radial=position.xz-root.xz;let r2=dot(radial,radial);let weight=r2/(1.0+r2);
 let phase=dot(root.xz,vec2f(0.17,0.11))+dot(radial,vec2f(0.7,0.5));
 let branch=wind.w*3.1+phase;let leaf=wind.w*7.7+phase*1.37;
 let wave=0.7*sin(branch)+0.3*sin(leaf);let derivative=0.7*cos(branch)+0.411*cos(leaf);
 // Bound the detail Jacobian away from folds and keep displacement inside the rooted wind bound.
 let amplitude=wind.z*detail*0.5;let height=h/(1.0+h);let direction=wind.xy/max(length(wind.xy),0.0001);
 let slope=amplitude*height*(2.0*radial/((1.0+r2)*(1.0+r2))*wave+weight*derivative*vec2f(0.7,0.5));
 let vertical=bend.z+select(0.0,amplitude*weight*wave/((1.0+h)*(1.0+h)),h>0.0);
 return WindDeformation(bend.xy+direction*amplitude*height*weight*wave,vec3f(slope.x,vertical,slope.y));
}
fn windDetailNormal(normal:vec3f,deformation:WindDeformation,wind:vec4f)->vec3f {
 let direction=vec3f(wind.x,0,wind.y)/max(length(wind.xy),0.0001);
 return normal-deformation.gradient*dot(normal,direction)/(1.0+dot(deformation.gradient,direction));
}
`;
