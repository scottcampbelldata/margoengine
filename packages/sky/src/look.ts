// Live art direction and physical air for `Sky` (`look` and `atmosphere` options), compiled only while one is set: the
// sky's WGSL is rewritten here, so a sky without them sends the GPU the program and data it always did
// (test/defaults-unchanged.test.js checks the SHA-256 of both against figures recorded before this entry existed).
//
// Sources, read as papers and public documentation (no code): the air is the Bruneton and Neyret model the sky already
// draws (E. Bruneton and F. Neyret, "Precomputed Atmospheric Scattering", Computer Graphics Forum 27(4), 2008,
// https://doi.org/10.1111/j.1467-8659.2008.01245.x) with its coefficients exposed as Hillaire does (S. Hillaire, "A
// Scalable and Production Ready Sky and Atmosphere Rendering Technique", Computer Graphics Forum 39(4), EGSR 2020,
// https://doi.org/10.1111/cgf.14050, Table 1: Rayleigh (5.802, 13.558, 33.1)e-6 /m, Mie 3.996e-6 /m, Mie asymmetry
// 0.8, ozone absorption (0.650, 1.881, 0.085)e-6 /m in a tent 25 km up, 15 km wide, from E. Bruneton, "A Qualitative
// and Quantitative Evaluation of 8 Clear Sky Models", IEEE TVCG 23(12), 2017, https://doi.org/10.1109/TVCG.2016.2622272),
// so a Rayleigh scale and spectrum, a Mie amount, spectrum and Cornette-Shanks asymmetry (W. M. Cornette and J. G.
// Shanks, "Physically reasonable analytic expression for the single-scattering phase function", Applied Optics 31(16),
// 1992) and an ozone layer are what the controls move, as in the public Unreal Engine SkyAtmosphere documentation's
// "Rayleigh Scattering Scale", "Mie Anisotropy" and "Absorption" settings. The Preetham fit (A. J. Preetham, P.
// Shirley and B. Smits, "A Practical Analytic Model for Daylight", SIGGRAPH 1999, https://doi.org/10.1145/311535.311545)
// and the Hosek and Wilkie fit (L. Hosek and A. Wilkie, "An Analytic Model for Full Spectral Sky-Dome Radiance", ACM
// TOG 31(4), 2012, https://doi.org/10.1145/2185520.2185591) have turbidity and ground albedo only, so under `preetham`
// the dome keeps its fit and only the sun (its transmittance) follows the air.
//
// The look is art direction over the physical result, the layering of the public Unity HDRP documentation's
// Physically Based Sky (physics, then tints) and Gradient Sky (top, middle and bottom colours): zenith, horizon and
// ground tints that recolour at the same luminance (Rec. 709 luma, ITU-R BT.709-6), a gradient of up to eight stops
// by elevation mixed over the sky, a horizon glow, the sun disc's size, colour and strength, and the cloud sheet's
// colour and density. Every strength is 0 and every scale 1 by default, so with the option set and nothing moved the
// sky is the physical one.
import type { SkyAtmosphereOptions, SkyFeatures, SkyLookOptions, SkyOptions } from './base.js';
import type { Vec3 } from '@margoengine/math';
import { margoError } from '../../shared/errors.js';

/** Earth's Rayleigh spectrum normalised to its blue (Hillaire 2020 Table 1): `rayleighColor`'s default. */
export const EARTH_RAYLEIGH_COLOR: Vec3 = [0.005802 / 0.0331, 0.013558 / 0.0331, 1];
/** Floats of the extra uniform block that follows the sky's 64 at byte 256. */
export const LOOK_FLOATS = 76;
// The Frame struct grows by the block; each later field is one vec4 unless noted.
const FIELDS =
  ',air0:vec4f,air1:vec4f,air2:vec4f,lookZenith:vec4f,lookHorizon:vec4f,lookGround:vec4f,lookGlow:vec4f,lookShape:vec4f,lookSun:vec4f,lookCloud:vec4f,lookStops:array<vec4f,8>,air3:vec4f}';
const lookCode = /* wgsl */ `
// Recolour at the same Rec. 709 luminance toward tint.rgb, by tint.w times weight.
fn lookTint(c:vec3f,tint:vec4f,weight:f32)->vec3f {
 let luma=vec3f(0.2126,0.7152,0.0722);let toward=tint.rgb*dot(c,luma)/max(dot(tint.rgb,luma),0.0001);
 return mix(c,toward,clamp(tint.w*weight,0.0,1.0));
}
// The look over a sky colour c seen in direction w: tints by zone, the gradient, then the horizon glow.
fn lookSky(w:vec3f,c:vec3f)->vec3f {
 let e=clamp(w.y,-1.0,1.0);var o=c;
 o=lookTint(o,frame.lookZenith,max(e,0.0));
 o=lookTint(o,frame.lookHorizon,pow(1.0-abs(e),4.0));
 o=lookTint(o,frame.lookGround,clamp(-e*8.0,0.0,1.0));
 let n=i32(frame.lookShape.z);
 if(n>=2&&frame.lookShape.y>0.0){
  let a=degrees(asin(e));var g=frame.lookStops[0].rgb;
  for(var i=1;i<n;i++){let p=frame.lookStops[i-1];let q=frame.lookStops[i];if(a>p.w){g=mix(p.rgb,q.rgb,clamp((a-p.w)/max(q.w-p.w,0.001),0.0,1.0));}}
  o=mix(o,g,frame.lookShape.y);
 }
 let width=frame.lookGlow.w;let band=select(exp(e*4.0/width),exp(-e/width),e>=0.0);
 let h=w.xz;let sh=frame.sun.xz;
 let toward=select(1.0,0.5+0.5*dot(normalize(h),normalize(sh)),length(h)>0.0001&&length(sh)>0.0001);
 return o+frame.lookGlow.rgb*band*mix(1.0,toward,frame.lookShape.x);
}
// air3.rgb: the light a low haze layer scatters down (atmosphere.scatteredLight), its even radiance in sky units.
fn daySky(direction:vec3f)->vec3f {return lookSky(direction,physicalDaySky(direction)*frame.air2.rgb+frame.air3.rgb);}
fn nightSky(w:vec3f,footprint:f32)->vec3f {return lookSky(w,physicalNightSky(w,footprint));}
`;
/** Replaces `from` by `to` in `code`, and fails loudly when the sky's WGSL no longer holds `from` (a test pins every one). */
function swap(code: string, from: string | RegExp, to: string, optional = false): string {
  const found = typeof from === 'string' ? code.includes(from) : from.test(code);
  if (!found) {
    if (optional) return code;
    throw margoError(
      'state',
      `Sky look: the sky shader no longer contains ${String(from)}; update extendSky in @margoengine/sky/look to match it`,
    );
  }
  return code.replace(from as string, to);
}
/**
 * The sky's WGSL with the look and the air read from the uniform: the Frame struct with the extra block, Rayleigh,
 * Mie, its asymmetry and ozone from it; with `full` (the sky's own program, not its tables) the look over the day and
 * night skies, the sun disc's size and colour and the cloud sheet's colour and density.
 */
export function extendSky(code: string, full: boolean): string {
  let c = swap(code, 'const BETA_R=vec3f(0.005802,0.013558,0.033100);', '');
  c = swap(c, /sunlight:vec4f\}/, 'sunlight:vec4f' + FIELDS);
  c = c.replace(/\bBETA_R\b/g, 'betaR()');
  c = swap(
    c,
    'fn mie()->f32{return 0.003996*max(0.25,(frame.settings.z-1.0)*0.5);}',
    'fn betaR()->vec3f{return frame.air0.rgb;}\nfn mie()->vec3f{return 0.003996*max(0.25,(frame.settings.z-1.0)*0.5)*frame.air1.rgb;}\n' +
      // Mie extinction stays grey (scattering / 0.9 of the haze amount): a coloured mieColor absorbs what it does not scatter.
      'fn mieExtinction()->f32{return 0.003996*max(0.25,(frame.settings.z-1.0)*0.5)*frame.air2.w/0.9;}\n' +
      'fn ozone(r:f32)->vec3f{return vec3f(0.00065,0.001881,0.000085)*frame.air0.w*max(0.0,1.0-abs(r-R-25.0)/15.0);}',
  );
  c = swap(c, 'return betaR()*d.x+vec3f(mie()/0.9*d.y);', 'return betaR()*d.x+vec3f(mieExtinction()*d.y)+ozone(r);');
  c = swap(c, 'let g=0.8;', 'let g=frame.air1.w;', true);
  if (!full) return c;
  c = swap(c, 'fn daySky(direction:vec3f)->vec3f {', 'fn physicalDaySky(direction:vec3f)->vec3f {');
  c = swap(c, 'fn nightSky(w:vec3f,footprint:f32)->vec3f {', 'fn physicalNightSky(w:vec3f,footprint:f32)->vec3f {');
  c = swap(c, 'celestialProfile(w,s,SUN_RADIUS,footprint)', 'celestialProfile(w,s,SUN_RADIUS*frame.lookSun.w,max(footprint,2.0*SUN_RADIUS*frame.lookSun.w*frame.lookShape.w))');
  c = swap(
    c,
    '*trans(transmission,R+clamp(frame.eye.w,0.001,99.9),s.y)*(1.0-frame.sun.w);',
    '*trans(transmission,R+clamp(frame.eye.w,0.001,99.9),s.y)*(1.0-frame.sun.w)*frame.lookSun.rgb;',
  );
  // The cloud sheet, when the sky has one (its stub otherwise).
  c = swap(
    c,
    'let opacity=(1.0-exp(-density*3.0/max(slant,0.25)))*haze;',
    'let opacity=(1.0-exp(-density*3.0*frame.lookCloud.w/max(slant,0.25)))*haze;',
    true,
  );
  c = swap(
    c,
    'return mix(color,lit+moon+backdrop*(1.0-0.4*density)+vec3f(0.006,0.01,0.02),opacity);',
    'return mix(color,(lit+moon+backdrop*(1.0-0.4*density)+vec3f(0.006,0.01,0.02))*frame.lookCloud.rgb,opacity);',
    true,
  );
  // The overcast deck takes the cloud colour too (KB-SKY-OVERCAST1).
  c = swap(
    c,
    'return (zenith*shade+moon)*grade+vec3f(0.006,0.01,0.02)*T;',
    'return ((zenith*shade+moon)*grade+vec3f(0.006,0.01,0.02)*T)*frame.lookCloud.rgb;',
    true,
  );
  return c + lookCode;
}
const isNumber = (v: unknown, lo: number, hi: number) => typeof v === 'number' && v >= lo && v <= hi;
const isColor = (v: unknown, hi: number) =>
  Array.isArray(v) && v.length === 3 && v.every((x) => isNumber(x, 0, hi));
// [name, low, high] of each number, [name, high] of each colour, per option.
const AIR_NUMBERS: [keyof SkyAtmosphereOptions, number, number][] = [
  ['sunIntensity', 0, 100],
  ['rayleigh', 0, 20],
  ['mie', 0, 50],
  ['mieAnisotropy', -0.95, 0.95],
  ['ozone', 0, 20],
];
const AIR_COLORS: [keyof SkyAtmosphereOptions, number][] = [
  ['sunColor', 4],
  ['rayleighColor', 4],
  ['mieColor', 1],
  ['scatteredLight', 4],
];
const LOOK_NUMBERS: [keyof SkyLookOptions, number, number][] = [
  ['zenithStrength', 0, 1],
  ['horizonStrength', 0, 1],
  ['groundStrength', 0, 1],
  ['gradientStrength', 0, 1],
  ['gradientIntensity', 0, 1000],
  ['sunDiscSize', 0.1, 20],
  ['sunDiscIntensity', 0, 100],
  ['sunDiscSoftness', 0, 1],
  ['glowStrength', 0, 100],
  ['glowWidth', 0.5, 90],
  ['glowSunward', 0, 1],
  ['cloudDensity', 0, 4],
];
const LOOK_COLORS: [keyof SkyLookOptions, number][] = [
  ['zenithColor', 1],
  ['horizonColor', 1],
  ['groundColor', 1],
  ['sunDiscColor', 4],
  ['glowColor', 1],
  ['cloudColor', 4],
];
function check<T extends object>(
  value: T | undefined,
  what: string,
  numbers: [keyof T, number, number][],
  colors: [keyof T, number][],
): void {
  if (value === undefined) return;
  if (typeof value !== 'object' || value === null) throw new RangeError(`Invalid sky ${what}; pass an object`);
  for (const [key, lo, hi] of numbers)
    if (value[key] !== undefined && !isNumber(value[key], lo, hi))
      throw new RangeError(`Invalid sky ${what}.${String(key)}; use a number from ${lo} to ${hi}`);
  for (const [key, hi] of colors)
    if (value[key] !== undefined && !isColor(value[key], hi))
      throw new RangeError(`Invalid sky ${what}.${String(key)}; use three numbers from 0 to ${hi} (linear RGB)`);
}
const DEFAULT_GRADIENT: SkyLookOptions['gradient'] = [
  { elevation: -90, color: [0.3, 0.27, 0.24] },
  { elevation: 0, color: [0.85, 0.85, 0.9] },
  { elevation: 90, color: [0.25, 0.45, 0.9] },
];
const set3 = (out: Float32Array, at: number, v: readonly number[], scale = 1) => {
  out[at] = v[0] * scale;
  out[at + 1] = v[1] * scale;
  out[at + 2] = v[2] * scale;
};
/** The sky's `look` feature: give `{look}` (with a day model) to `Sky` from `@margoengine/sky/base`. */
export const look: NonNullable<SkyFeatures['look']> = {
  extend: extendSky,
  validate(o: SkyOptions): void {
    check(o.atmosphere, 'atmosphere', AIR_NUMBERS, AIR_COLORS);
    check(o.look, 'look', LOOK_NUMBERS, LOOK_COLORS);
    const g = o.look?.gradient;
    if (
      g !== undefined &&
      !(
        Array.isArray(g) &&
        g.length >= 2 &&
        g.length <= 8 &&
        g.every(
          (s, i) =>
            typeof s === 'object' &&
            s !== null &&
            isNumber(s.elevation, -90, 90) &&
            isColor(s.color, 1) &&
            (i === 0 || s.elevation > g[i - 1].elevation),
        )
      )
    )
      throw new RangeError(
        'Invalid sky look.gradient; use 2 to 8 stops {elevation, color}, elevations -90 to 90 degrees rising, colours three numbers 0 to 1',
      );
  },
  air(o: SkyOptions, out: Float32Array): Float32Array {
    const a = o.atmosphere ?? {},
      rayleigh = (a.rayleigh ?? 1) * 0.0331;
    set3(out, 0, a.rayleighColor ?? EARTH_RAYLEIGH_COLOR, rayleigh);
    out[3] = a.ozone ?? 0;
    set3(out, 4, a.mieColor ?? [1, 1, 1], a.mie ?? 1);
    out[7] = a.mieAnisotropy ?? 0.8;
    out[8] = a.mie ?? 1;
    return out;
  },
  write(out: Float32Array, o: SkyOptions, air: Float32Array, zenith = 0): void {
    const a = o.atmosphere ?? {},
      l = o.look ?? {},
      sun = a.sunColor ?? [1, 1, 1],
      intensity = a.sunIntensity ?? 1;
    out.set(air.subarray(0, 8), 0);
    set3(out, 8, sun, intensity);
    out[11] = air[8];
    set3(out, 12, l.zenithColor ?? [0.25, 0.45, 1]);
    out[15] = l.zenithStrength ?? 0;
    set3(out, 16, l.horizonColor ?? [1, 0.8, 0.6]);
    out[19] = l.horizonStrength ?? 0;
    set3(out, 20, l.groundColor ?? [0.3, 0.25, 0.2]);
    out[23] = l.groundStrength ?? 0;
    set3(out, 24, l.glowColor ?? [1, 0.45, 0.15], l.glowStrength ?? 0);
    out[27] = Math.sin(((l.glowWidth ?? 8) * Math.PI) / 180);
    const stops = l.gradient ?? DEFAULT_GRADIENT!;
    out[28] = l.glowSunward ?? 0.5;
    out[29] = l.gradientStrength ?? 0;
    out[30] = stops.length;
    out[31] = l.sunDiscSoftness ?? 0;
    const disc = l.sunDiscColor ?? [1, 1, 1],
      d = l.sunDiscIntensity ?? 1;
    for (let i = 0; i < 3; i++) out[32 + i] = disc[i] * d * sun[i] * intensity;
    out[35] = l.sunDiscSize ?? 1;
    set3(out, 36, l.cloudColor ?? [1, 1, 1]);
    out[39] = l.cloudDensity ?? 1;
    out.fill(0, 40);
    stops.forEach((s, i) => {
      set3(out, 40 + 4 * i, s.color, l.gradientIntensity ?? 1);
      out[43 + 4 * i] = s.elevation;
    });
    // A Lambertian layer under irradiance E shines E / pi each way: the share of the zenith sun on the ground, in sky units.
    set3(out, 72, a.scatteredLight ?? [0, 0, 0], (intensity * zenith) / Math.PI);
  },
};
