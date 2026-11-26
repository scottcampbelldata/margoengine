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
/**
 * How a scattered plant sways: `stiffness` (0.1 to 10, default 1) divides the reach, the most a tall plant's top moves at
 * full wind strength (1.2 m at stiffness 1), and `height` (above 0, mesh units) is the plant's top above its root
 * before the instance's scale, by default the meshes' highest vertex.
 */
export interface ScatterSway {
  stiffness?: number;
  height?: number;
}
/** The reach at stiffness 1: how far a tall plant's top moves at full wind strength, in metres (see docs/limits.md). */
export const SWAY_REACH = 1.2;
const BAD_SWAY =
  'Invalid scatter sway; pass { stiffness, height } with stiffness from 0.1 to 10 and height a positive finite number of mesh units.';
/** Checks a `sway` option and returns its reach in metres, 1.2 m / stiffness. */
export function validateSway(sway: ScatterSway | undefined): number {
  if (sway === undefined) return SWAY_REACH;
  if (!sway || typeof sway !== 'object') throw new RangeError(BAD_SWAY);
  const { stiffness = 1, height } = sway;
  if (
    typeof stiffness !== 'number' ||
    !(stiffness >= 0.1 && stiffness <= 10) ||
    (height !== undefined &&
      (typeof height !== 'number' ||
        !(height > 0) ||
        !Number.isFinite(Math.fround(height)) ||
        !(Math.fround(height) > 0)))
  )
    throw new RangeError(BAD_SWAY);
  return SWAY_REACH / stiffness;
}
/**
 * The most a plant `height` metres tall moves its top sideways at full wind strength: H^2 / (1 + H + H^2 / reach), with
 * reach = 1.2 m / `stiffness`. Short plants keep the blade bend H^2 / (1 + H) (a 0.3 m blade: 0.066 m) and tall ones
 * level off at the reach (a 25 m tree: 1.14 m at stiffness 1); never more than 0.354 H at stiffness 1.
 */
export function swayTip(height: number, stiffness = 1): number {
  if (!(height >= 0 && Number.isFinite(height)))
    throw new RangeError('swayTip needs a finite height of 0 or more metres');
  const reach = validateSway({ stiffness });
  return (height * height) / (1 + height + (height * height) / reach);
}
/**
 * A plant's own sway frequency in Hz for its `height` in metres: 2.55 H^-0.59 (Habel, Kusternig and Wimmer 2009, eq. 17,
 * after Coder 2000), so a 25 m conifer sways at 0.38 Hz and a 0.3 m blade at 5.2 Hz. The height floors at 0.01 m.
 */
export function swayFrequency(height: number): number {
  if (!(height >= 0 && Number.isFinite(height)))
    throw new RangeError('swayFrequency needs a finite height of 0 or more metres');
  return 2.55 * Math.max(height, 0.01) ** -0.59;
}
// windBend(height, root, wind, sway): wind is (direction x, z, strength, wind clock) and sway (the plant's top H in
// metres, the reach in metres, the calm clock in seconds, the wind clock's rate). The tip moves s x strength x
// swayTip(H) along the wind, s in [-1, 1]; a vertex at height h follows the tapered beam shape u(x) = 0.74 x^2 +
// 0.26 x^4, x = h / H (Habel et al. 2009 eq. 7, taper 0.2, u(1) = 1), and sinks by half the integral of its slope
// squared, so the stem keeps its length to second order (Habel eq. 8 to 10). The gusts (1.7 and 0.73 rad/s on the wind
// clock) pass through the plant's response G(r) = 1 / sqrt(1 + r^4), r the gust's true frequency over the plant's own
// w0 = 2 pi 2.55 H^-0.59 (Habel eq. 15 and 17, Chuang et al. 2005), and what a trunk cannot follow sways at w0 on the
// calm clock at half that share: a tree keeps its own slow sway in a gale, grass still thrashes with the wind clock.
// Returns (offset x, offset z, slope d offset / d h, drop). windNormal: the bowed stem's normal, the shear by the slope
// along the wind and the length correction's vertical scale 1 - slope^2 / 2. windDeformation's drop is (how far the
// vertex sinks, its derivative along the height); its branch and leaf ripple rides on the rooted bend with amplitude
// detail x strength / 2 x swayTip(H) x h / H, its Jacobian bounded away from folds, so it stays within 1.5 times the
// rooted bound. The WGSL holds no comments: its text ships in the declarations as well (KB-WGSL1).
export const windShader = /* wgsl */ `
fn windSway(root:vec2f,wind:vec4f,sway:vec4f)->f32 {
 let phase=dot(root,vec2f(0.17,0.11));let w0=16.022122*pow(max(sway.x,0.01),-0.59);
 let r=vec2f(1.7,0.73)*(sway.w/w0);let r2=r*r;let g=vec2f(0.65,0.35)*inverseSqrt(1.0+r2*r2);
 return g.x*sin(wind.w*1.7+phase)+g.y*sin(wind.w*0.73+phase*1.9)+(1.0-g.x-g.y)*0.5*sin(w0*sway.z+phase*2.3);
}
fn windTip(top:f32,reach:f32)->f32 {return top*top/(1.0+top+top*top/max(reach,1e-6));}
fn windBend(height:f32,root:vec2f,wind:vec4f,sway:vec4f)->vec4f {
 let top=max(sway.x,1e-4);let x=clamp(height/top,0.0,1.0);let x2=x*x;
 let a=windSway(root,wind,sway)*wind.z*windTip(top,sway.y);let direction=wind.xy/max(length(wind.xy),0.0001);
 let slope=select(a*x*(1.48+1.04*x2)/top,0.0,height>=top);
 let drop=0.5*a*a/top*x2*x*(0.730133+x2*(0.61568+x2*0.154514));
 return vec4f(direction*(a*x2*(0.74+0.26*x2)),slope,drop);
}
fn windNormal(normal:vec3f,bend:vec4f,wind:vec4f)->vec3f {
 let direction=wind.xy/max(length(wind.xy),0.0001);
 return vec3f(normal.x,(normal.y-dot(normal.xz,direction)*bend.z)/(1.0-0.5*bend.z*bend.z),normal.z);
}
struct WindDeformation {offset:vec2f,gradient:vec3f,drop:vec2f}
fn windDeformation(position:vec3f,root:vec3f,wind:vec4f,detail:f32,sway:vec4f)->WindDeformation {
 let bend=windBend(position.y-root.y,root.xz,wind,sway);let sink=vec2f(bend.w,0.5*bend.z*bend.z);
 if(detail==0.0||wind.z==0.0){return WindDeformation(bend.xy,vec3f(0,bend.z,0),sink);}
 let top=max(sway.x,1e-4);let h=max(0.0,position.y-root.y);let radial=position.xz-root.xz;let r2=dot(radial,radial);let weight=r2/(1.0+r2);
 let phase=dot(root.xz,vec2f(0.17,0.11))+dot(radial,vec2f(0.7,0.5));
 let branch=wind.w*3.1+phase;let leaf=wind.w*7.7+phase*1.37;
 let wave=0.7*sin(branch)+0.3*sin(leaf);let derivative=0.7*cos(branch)+0.411*cos(leaf);
 let tip=windTip(top,sway.y);let amplitude=wind.z*detail*0.5;let height=tip*min(h/top,1.0);let direction=wind.xy/max(length(wind.xy),0.0001);
 let slope=amplitude*height*(2.0*radial/((1.0+r2)*(1.0+r2))*wave+weight*derivative*vec2f(0.7,0.5));
 let vertical=bend.z+select(0.0,amplitude*weight*wave*tip/top,h>0.0&&h<top);
 return WindDeformation(bend.xy+direction*amplitude*height*weight*wave,vec3f(slope.x,vertical,slope.y),sink);
}
fn windDetailNormal(normal:vec3f,deformation:WindDeformation,wind:vec4f)->vec3f {
 let direction=vec3f(wind.x,0,wind.y)/max(length(wind.xy),0.0001);
 let n=normal-deformation.gradient*dot(normal,direction)/(1.0+dot(deformation.gradient,direction));
 return vec3f(n.x,n.y/(1.0-deformation.drop.y),n.z);
}
`;
