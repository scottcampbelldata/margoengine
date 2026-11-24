import type { SkyFeatures } from './base.js';
const field = /* wgsl */ `
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
// Octaves first..last-1 of cloudNoise. Each octave is 2.13x finer, turned 49 degrees and shifted, so no two lattices
// line up; weights halve per octave and the sum is divided by the weights used, keeping it in 0..1 around 0.5. An octave
// fades to its mean 0.5 as the footprint, in that octave's cells, grows from 0.35 to 1 cell, so it never aliases.
fn cloudOctaves(p:vec2f,footprint:f32,first:u32,last:u32)->f32 {
 var q=p;var cells=footprint;var weight=1.0;var sum=0.0;var total=0.0;
 for(var octave=0u;octave<last;octave++){
  if(octave>=first){sum+=weight*mix(cloudNoise(q),0.5,smoothstep(0.35,1.0,cells));total+=weight;}
  q=mat2x2f(1.39741,1.60753,-1.60753,1.39741)*q+vec2f(-31.4,12.6);cells*=2.13;weight*=0.5;
 }
 return sum/max(total,0.000001);
}
`;
// The overcast deck (KB-SKY-OVERCAST1, 2026-11-17). A sky all under cloud is one stratus deck seen from below: no sun
// disc, no holes, a soft grey whose brightness falls toward the horizon. Its light is the two-stream diffuse light a
// slab of optical depth tau passes, T = 1 / (1 + tau (1 - g) / 2), g 0.85 (Meador and Weaver 1980, "Two-stream
// approximations to radiative transfer in planetary atmospheres", J. Atmos. Sci. 37; Bohren 1987, Am. J. Phys. 55;
// cloudTransmission in cloud-types.ts), of the light falling on its top: the sun on a level surface, E / pi = 2.2 a unit
// of the clouds' sun at the zenith (4 pi x 0.55, the Preetham sky's calibration in base.ts), plus the clear sky's own
// light on that level surface, in its own colour. Under the deck that light is spread as the CIE standard overcast
// sky, L(h) = Lz (1 + 2 sin h) / 3 (P. Moon and D. E. Spencer, "Illumination from a non-uniform sky", Illuminating
// Engineering 37, 1942; CIE S 011/E:2003 sky type 1), whose zenith Lz is 9 / 7 of E / pi (the gradation integrates to
// 7 pi / 9 over the hemisphere), so the level ground under it gets exactly T of the light above. Gentle variation: the
// sheet's shape octaves shade it within +-DECK_VARIATION, fading into the haze with distance, as the base of a real
// stratus deck shows soft, low-contrast undulations (WMO International Cloud Atlas, stratus opacus). The moon and the
// sheet's sky floor light it at night, both through T.
// KB-SKY-OVERCAST2 (Fauld recut, 2026-11-24): until then the clear sky's share was a scalar of the SUN's colour
// (E above = 2.2 sin h / (1 - 0.165), the noon diffuse share of D. G. Erbs, S. A. Klein and J. A. Duffie, "Estimation
// of the diffuse radiation fraction for hourly, daily and monthly-average global radiation", Solar Energy 28(4), 1982),
// so under a 4 to 15 degree November sun the deck, the ambient it lights and the fog under it all took the low sun's
// orange. The diffuse share is largest exactly then (Erbs et al.: it rises as the clearness index falls) and it has the
// blue sky's colour, which is why measured overcast daylight sits near D65 and turns bluer, not redder, under thicker
// cloud (S. T. Henderson and D. Hodgkiss, "The spectral energy distribution of daylight", Br. J. Appl. Phys. 14, 1963;
// J. Hernandez-Andres, J. Romero, J. L. Nieves and R. L. Lee, "Color and spectral analysis of daylight in southern
// Europe", JOSA A 18(6), 2001). The clear sky's light is now integrated from the sky model itself: E / pi, the integral
// of L cos over the hemisphere over pi, is the integral over u = sin^2(zenith) from 0 to 1 of the azimuthal mean of L,
// taken by three-point Gauss-Legendre in u (M. Abramowitz and I. A. Stegun, "Handbook of Mathematical Functions", 1964,
// 25.4.29) times an eight-point trapezoid in azimuth about the sun's vertical (exact for a periodic integrand up to its
// seventh harmonic; P. J. Davis and P. Rabinowitz, "Methods of Numerical Integration", 1984, sec. 2.9), mirrored about
// that plane: 15 evaluations of the day sky. Against a 400 x 400 midpoint integral of the Preetham reference it stays
// within 5 percent for suns 2 to 80 degrees up at turbidity 2 and 6 (test/overcast.test.js).
/** E / pi of the sun on a level surface, per unit of the clouds' sun at the zenith and sine of its elevation. */
export const DECK_ABOVE = 2.2;
/** How far the deck's shading strays from the CIE overcast gradation, a share of it: the gentle variation. */
export const DECK_VARIATION = 0.12;
/** Optical depth of the overcast deck when the `clouds` option gives no `depth`: a stratus deck (cloud-types.ts). */
export const DECK_DEPTH = 20;
const GAUSS = Math.sqrt(3 / 5) / 2;
/**
 * The clear-sky quadrature's directions relative to the sun's azimuth (x toward it, z to its side, y up), each with its
 * weight; the weights sum to 1, so the sum of weight times radiance is E / pi of the clear sky on level ground.
 * Mirror-paired azimuths (45, 90 and 135 degrees) carry both sides' weight: a clear sky is symmetric about the sun's
 * vertical.
 */
export const CLEAR_SKY_RULE: readonly (readonly [number, number, number, number])[] = (() => {
  const rule: [number, number, number, number][] = [];
  for (const [u, w] of [
    [0.5 - GAUSS, 5 / 18],
    [0.5, 8 / 18],
    [0.5 + GAUSS, 5 / 18],
  ]) {
    const y = Math.sqrt(1 - u),
      h = Math.sqrt(u);
    for (let k = 0; k <= 4; k++) {
      const phi = (k * Math.PI) / 4;
      rule.push([h * Math.cos(phi), y, h * Math.sin(phi), (w * (k === 0 || k === 4 ? 1 : 2)) / 8]);
    }
  }
  return rule;
})();
/**
 * E / pi of the clear sky on level ground: `radiance` (unit direction to linear RGB, the day sky without its sun disc)
 * integrated by `CLEAR_SKY_RULE` about the unit sun direction `sun`. The sky's shaders evaluate the same rule.
 * @example clearSkyLevel(() => [1, 1, 1], [0, 1, 0]); // [1, 1, 1]: an even sky of radiance 1 gives E / pi = 1
 */
export function clearSkyLevel(
  radiance: (direction: [number, number, number]) => readonly number[],
  sun: readonly number[],
): [number, number, number] {
  const flat = Math.hypot(sun[0], sun[2]),
    ax = flat > 1e-4 ? sun[0] / flat : 1,
    az = flat > 1e-4 ? sun[2] / flat : 0,
    out: [number, number, number] = [0, 0, 0];
  for (const [x, y, z, w] of CLEAR_SKY_RULE) {
    const l = radiance([x * ax - z * az, y, x * az + z * ax]);
    for (let i = 0; i < 3; i++) out[i] += w * l[i];
  }
  return out;
}
/**
 * The radiance of the overcast deck (`clouds.coverage` 1) seen along a view ray of sine of elevation `up`, for the
 * clouds' sun `sunlight` (linear RGB) at sine of elevation `sunUp`, a deck of optical depth `depth` and shade 0 (its
 * mean): the CIE overcast gradation of the two-stream light under it, before the sky's exposure. The sky draws this.
 * `units` is the sky model's zenith sun on the ground over the Preetham sky's (4 pi x 0.55 sky units): 1 for Preetham,
 * 20 x the zenith transmittance over 4 pi x 0.55 for Bruneton (about 2.6), so the deck is in the units of the sky it
 * closes over. `clear` is the clear sky's own E / pi on level ground in those units (`clearSkyLevel` of the day sky);
 * the sky always adds it, the default 0 leaves the sun's share alone.
 * @example overcastDeck([1, 1, 1], Math.SQRT1_2, 1, 20); // the zenith of a deck under a sun 45 degrees up, sun only
 */
export function overcastDeck(
  sunlight: readonly number[],
  sunUp: number,
  up: number,
  depth = DECK_DEPTH,
  units = 1,
  clear: readonly number[] = [0, 0, 0],
): [number, number, number] {
  const T = 1 / (1 + depth * 0.075),
    grade = (9 / 7) * ((1 + 2 * Math.max(up, 0)) / 3),
    k = DECK_ABOVE * Math.max(sunUp, 0) * units;
  return [0, 1, 2].map((i) => (sunlight[i] * k + clear[i]) * T * grade) as [number, number, number];
}
const f7 = (v: number): string => v.toFixed(7);
// The light on the deck's top over pi times its two-stream transmission, in the sky model's units, by day: the sun on
// level ground (frame.sunlight, relative to the zenith sun, times 2.2 sin h in Preetham units, times the model's units
// carried in moonColor.w) plus the clear sky's own (clearSkyLevel) faded out with the day. The units are 1 for Preetham;
// for Bruneton 20 x the luminance of the transmittance straight up from the eye over 4 pi x 0.55, by the same 64-step
// column as the CPU's zenithTransmittance (atmosphere.ts) through the sky's own extinction (the look's air included).
// The fog under a cover (fog.ts) reads the same overcastLight.
export const overcastLightWgsl = /* wgsl */ `
fn deckUnits()->f32 {
 if(frame.settings.x<0.5){return 1.0;}
 let r=R+clamp(frame.eye.w,0.001,99.9);let step=(TOP-r)/64.0;var optical=vec3f(0);
 for(var i=0u;i<64u;i++){optical+=extinction(r+(f32(i)+0.5)*step)*step;}
 return 20.0*dot(exp(-optical),vec3f(0.2126,0.7152,0.0722))/${f7(4 * Math.PI * 0.55)};
}
fn clearSkyLevel()->vec3f {
 let s=frame.sun.xyz;let flat=length(s.xz);var a=vec2f(1,0);if(flat>0.0001){a=s.xz/flat;}
 var sum=vec3f(0);
${CLEAR_SKY_RULE.map(([x, y, z, w]) => ` sum+=${f7(w)}*daySky(vec3f(${f7(x)}*a.x-${f7(z)}*a.y,${f7(y)},${f7(x)}*a.y+${f7(z)}*a.x));`).join('\n')}
 return sum;
}
// day: the clear sky's share by the day and night blend (the fog fades all of its deck light by it afterwards).
fn overcastLight(day:f32)->vec3f {
 let T=max(frame.moonColor.w,0.0);if(T<=0.0){return vec3f(0);}
 return (frame.sunlight.rgb*(${DECK_ABOVE.toFixed(6)}*max(frame.sun.y,0.0))+clearSkyLevel()*(day/deckUnits()))*T;
}
`;
const deckWgsl = /* wgsl */ `// The overcast deck along ray at its hit p (km): the CIE overcast gradation of the two-stream light under the deck.
// moonColor.w is the deck's two-stream transmission in the sky model's units: Sky sets units / (1 + 0.075 depth).
${overcastLightWgsl}
fn cloudDeck(ray:vec3f,p:vec2f,footprint:f32,haze:f32)->vec3f {
 let T=max(frame.moonColor.w,0.0);
 let zenith=overcastLight(1.0-clamp(frame.sun.w,0.0,1.0))*${(9 / 7).toFixed(6)};
 let grade=(1.0+2.0*max(ray.y,0.0))/3.0;
 let shade=1.0+${DECK_VARIATION.toFixed(3)}*(2.0*cloudOctaves(p,footprint,0u,4u)-1.0)*haze;
 let moon=frame.moonColor.rgb*frame.moon.w*0.15*T;
 return (zenith*shade+moon)*grade+vec3f(0.006,0.01,0.02)*T;
}
`;
/** Procedural cloud layer on a curved shell, lit by the sun through the atmosphere (`clouds` option). */
export const clouds: NonNullable<SkyFeatures['clouds']> = {
  field,
  // shortcut: one procedural cloud layer, use volumetric clouds for flight through the layer.
  wgsl: /* wgsl */ `${field}// Coverage remap (Schneider 2015): the low-frequency shape says where clouds are, coverage how much sky they fill.
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
 let haze=exp(-t/40.0);
 // Cosine between the ray and the shell's normal at the hit: grazing rays see longer, more opaque paths.
 let slant=max((r*mu+t)/shell,0.03);
 let p=frame.eye.xz*0.001+ray.xz*t+normalize(vec2f(1,0.35))*frame.clouds.y*0.001;
 let footprint=angularFootprint*t/slant;
 var sheet=color;if(haze>=0.01){sheet=cloudSheet(color,backdrop,ray,p,footprint,slant,haze);}
 // Past 80 percent cover the sheet closes into the overcast deck (cloudDeck), all of it at full cover.
 let deck=smoothstep(0.8,1.0,frame.clouds.x);if(deck<=0.0){return sheet;}
 return mix(sheet,cloudDeck(ray,p,footprint,haze),deck);
}
// The sheet's broken cloud at the hit p (km) of the ray on the shell.
fn cloudSheet(color:vec3f,backdrop:vec3f,ray:vec3f,p:vec2f,footprint:f32,slant:f32,haze:f32)->vec3f {
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
${deckWgsl}`,
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
      (c.height ?? 1500) > 10000 ||
      !Number.isFinite(c.depth ?? DECK_DEPTH) ||
      (c.depth ?? DECK_DEPTH) < 1 ||
      (c.depth ?? DECK_DEPTH) > 200
    )
      throw new RangeError(
        'Invalid sky clouds; keep coverage from 0 to 1, speed within ±100, height from 100 to 10000 and depth from 1 to 200.',
      );
  },
};
