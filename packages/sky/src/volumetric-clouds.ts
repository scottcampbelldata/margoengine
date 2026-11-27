/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { invertMatrixStable } from '@margoengine/math/mat4';
import { MargoError } from '@margoengine/math/errors';
import { finiteVector } from '@margoengine/math/validate';
import type { Vec3 } from '@margoengine/math';
import { fullscreen } from '../../shared/gpu.js';
import { displayShader } from '../../shared/display.js';
import { applyView } from '../../shared/view-rect.js';
import { sunlight } from './atmosphere.js';
import { depthWGSL, sceneDepth } from './depth.js';
import { linearHdr } from '../../shared/hdr-format.js';
import {
  cloudDeckTransmittance,
  cloudLayerFor,
  type CloudLayer,
  type CloudType,
  type CloudWeather,
  type MutableCloudLayer,
} from './cloud-types.js';
import type { Hurricane, HurricaneOptions } from './hurricane.js';
import type { StormField } from './storm-field.js';
export {
  cloudDeckTransmittance,
  cloudLayerFor,
  cloudTransmission,
  cloudTypeWeights,
  type CloudLayer,
  type CloudType,
  type CloudTypeWeights,
  type CloudWeather,
  type MutableCloudLayer,
} from './cloud-types.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { STORAGE_BINDING: number; TEXTURE_BINDING: number; COPY_DST: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;
/** Planet radius in metres, the sky's (6,360 km). */
export const PLANET_RADIUS = 6_360_000;
/**
 * What lights the clouds: `Sky` from `@margoengine/sky` (or `/base`) fits. Its sun, the sun's colour through its
 * atmosphere (turbidity), its backdrop exposure, its sky light (the `reflection` feature's 64 x 32 map, when the sky has
 * it) and its moon light all carry over, so the clouds match the sky they sit in. In turn the clouds give a sky with an
 * `environmentLayer` their deck, so what reflects the sky or takes its light sees them too.
 */
export interface VolumetricCloudSky {
  readonly sun: ArrayLike<number>;
  readonly options: {
    readonly turbidity?: number;
    readonly exposure?: number;
    /** The sky's light (`Sky` `lighting`): its `intensity` scales the engine sun the deck's light is matched to. */
    readonly lighting?: { readonly intensity?: number };
    /**
     * The sky's air (`Sky` `atmosphere`): the clouds stand above its low haze layer (smoke, ash, spray), so they are seen
     * through it, `layerTransmittance` to the power 1 / sin e along a ray e up, with the layer's glow
     * (`scatteredLight`) in front, as the sky draws what is above the layer (KB-SKY-PALLCLOUD1); `sunIntensity` scales
     * their light as it does the dome's.
     */
    readonly atmosphere?: {
      readonly sunIntensity?: number;
      readonly scatteredLight?: ArrayLike<number>;
      readonly layerTransmittance?: ArrayLike<number>;
    };
  };
  /** The zenith sun on level ground in sky units (`Sky.zenithSun`), the unit of `atmosphere.scatteredLight`. */
  readonly zenithSun?: number;
  readonly reflectionTexture?: GPUTexture | undefined;
  /**
   * Engine light units per sky unit (`Sky.lightScale`): the sky's lighting takes its map, this deck's light included,
   * into the engine light's units by it. A sky without it takes the map as it is, in the engine's units.
   */
  readonly lightScale?: number;
  readonly lights?: readonly { readonly direction: ArrayLike<number>; readonly radiance: ArrayLike<number> }[];
  /** Set by the clouds to their deck as the sky's map sees it (`Sky.environmentLayer`); a sky without it gets none. */
  environmentLayer?: GPUTexture | undefined;
  /**
   * Set by the clouds to their deck as the scene's light takes it (`Sky.environmentLightLayer`): the light no engine
   * light already carries. A sky without it lights the scene from `environmentLayer`.
   */
  environmentLightLayer?: GPUTexture | undefined;
  /**
   * Set by the clouds (`dimLight`, default on) to the share of a light at elevation sine `up` their deck passes
   * (`Sky.deck`): the sky scales its sun light and its moonlight under the cloud by it.
   */
  deck?: ((up: number) => number) | undefined;
}
/** {@link VolumetricClouds} settings, read every frame from `clouds.options`. Lengths are metres, speeds metres per second. */
export interface VolumetricCloudOptions {
  /** The sky that lights the clouds (sun, its colour, exposure, sky light, moon). Without one, `sunDirection` and `ambient` light them. */
  sky?: VolumetricCloudSky;
  /** Direction toward the sun when no `sky` is given; normalized. Default [0.3, 0.6, 0.4]. */
  sunDirection?: Vec3;
  /**
   * The weather the layer follows: its type (fair cumulus, stratus or storm, blended by `cloud`, `rain` and
   * `lightning`) gives `coverage`, `bottom`, `top` and `density` for each of them left unset (`cloudLayerFor`). A
   * weather drive writes its state here each frame. Default unset: the plain defaults below.
   */
  weather?: CloudWeather;
  /**
   * Forces the cloud type whatever the `weather` says: `'cumulus'`, `'stratus'` or `'storm'` give their own
   * `bottom`, `top` and `density` (and the stratus cover of the weather's `cloud`, 0.5 without a weather). Default unset:
   * the weather picks the type.
   */
  type?: CloudType;
  /**
   * A hurricane (`Hurricane` from `@margoengine/sky/hurricane`, or its options) shapes the layer: the clear eye, the
   * eyewall leaning out with height (the stadium), the moat, a concentric outer eyewall, the spiral rain bands, the
   * stratiform shield and the cirrus canopy, the cloud turning with the storm's wind and moving with the storm. With it
   * (or `type: 'hurricane'`, which uses the default storm at the origin) the layer is the hurricane deck, 500 to 15,000 m,
   * unless `type` names another; `coverage` then scales the storm's cover (default 1), and a weather drive leaves the
   * layer's coverage, density and drift to the storm. Give the same storm to `WeatherRegions`' `storms` so the wind and
   * rain follow the bands. Live. Default unset.
   */
  hurricane?: HurricaneOptions | Hurricane;
  /** Fraction of the sky the layer covers, 0 to 1. Default 0.5 (or the `weather`'s); 0 draws nothing. */
  coverage?: number;
  /**
   * Cloud base in metres above world y = 0, 100 to 20,000. Default 1500 (or the `weather`'s). Over ground that stands
   * high above y = 0, add its height, or the layer cuts the hills.
   */
  bottom?: number;
  /** Cloud tops, above `bottom`, at most 20,000. Default 4000 (or the `weather`'s). */
  top?: number;
  /** Extinction per metre inside the densest cloud, above 0 and at most 1. Default 0.04 (or the `weather`'s; cumulus is about 0.02 to 0.1). */
  density?: number;
  /** Width of one repeat of the cloud shapes, 1000 to 200,000. Default 14,000; the fine erosion repeats eight times as often. */
  scale?: number;
  /** Wind along world X and Z; the clouds drift with it. Default [10, 3]. */
  wind?: readonly [number, number];
  /** How fast the shapes change: the noise field rises through itself at this speed, 0 to 50. Default 3. */
  evolution?: number;
  /** Samples along each view ray inside the layer, 8 to 256. Default 64. */
  steps?: number;
  /** Samples toward the sun from each of them, 1 to 16. Default 6. */
  lightSteps?: number;
  /**
   * Longest stretch of each view ray marched inside the layer, from where the ray enters it, 1000 to 400,000. Default
   * 80,000. Clouds also fade into the haze, to half at 28 km from the camera.
   */
  maxDistance?: number;
  /**
   * Longest step of a view ray near the camera, in metres, 10 to 10,000. Default 150. Steps then grow with distance
   * (a power law of the step number) until `steps` of them reach the end of the ray, so the march costs the same and
   * the grain of far, grazing rays falls; a ray whose steps are all under it is marched evenly, as before. Live.
   */
  stepCap?: number;
  /**
   * Dim the sky's sun and moon light under the deck by the share of it a deck of this coverage, thickness and density
   * passes (`cloudDeckTransmittance`: the two-stream bound 1 / (1 + tau (1 - g) / 2), g 0.85), as the engine light
   * takes them, with no cloud shadows wired. Give `false` when `volumetricCloudShadows` already shades the scene.
   * Default true; needs the `sky` option.
   */
  dimLight?: boolean;
  /**
   * Amount of the fine erosion that eats the cloud edges, 0 to 2. Default 1. 0 leaves the rounded base shapes with clean
   * outlines (the animated look); 2 doubles the ragged detail. Live.
   */
  erosion?: number;
  /**
   * The sun on the clouds in the sky's units: its irradiance over 4 pi (thin cloud scatters this times its phase, 1 for
   * isotropic, per unit optical depth; a white plate square to the sun reads four times it). Default 0.55: the sun that
   * makes the clear noon sky (turbidity 2) give 0.165 of the light on level ground, the diffuse fraction of a clear sky
   * (Erbs, Klein and Duffie 1982). Until 2026-11-17 the default was 1.6, a look value of the old scattering.
   */
  sunIntensity?: number;
  /**
   * Sky light from above (`[0]`, the upper hemisphere's cosine-weighted mean radiance) and from below (`[1]`, the
   * ground's, before the sun's bounce of `groundAlbedo`), linear RGB, when the sky has no reflection map. Default a
   * clear day's above a dark ground.
   */
  ambient?: readonly [Vec3, Vec3];
  /**
   * Albedo of the ground under the clouds, 0 to 1: it sends back up into the cloud base the share of the sun and sky the
   * deck passes to it (fresh snow about 0.8, grass 0.25, forest 0.1). Default 0.2. Live. (The sky's own `groundAlbedo`
   * feeds only its Bruneton tables; set both for a snow scene.)
   */
  groundAlbedo?: number;
  /**
   * Override the active scene capture's reversed-Z depth. Omit to use the current frame from PostStack or another
   * scene capture. Clouds stop at that frame's surfaces. Without sampleable depth they draw over the empty sky.
   */
  depth?: () => GPUTexture | undefined;
  /**
   * A lightning flash in or under the layer, read every frame: a point light at world `position` of `color` times
   * `intensity` (the sky's radiance units at 1 metre, falling with the square of the distance past `radius`), lighting
   * the cloud round it from inside, dimmed by the cloud in between. Omitted or `intensity` 0: no flash, at no cost.
   */
  flash?: VolumetricCloudFlash;
  /**
   * A new start for each pixel's march every frame (default `'auto'`), so temporal anti-aliasing (`@margoengine/taa`)
   * averages the march's sampling noise on cloud edges away; off, each pixel keeps one start and the noise stays put.
   * Turn it on with TAA only: without TAA the noise then crawls from frame to frame. `'auto'` (the default) is on when
   * the scene has `@margoengine/taa` (a plugin named `taa`) and off otherwise.
   */
  temporal?: boolean | 'auto';
}
/** {@link VolumetricCloudOptions.flash}: a lightning flash that lights the clouds from inside. */
export interface VolumetricCloudFlash {
  /** World position of the flash, usually inside the layer. */
  position: Vec3;
  /** Brightness, 0 to 1e12; 0 turns it off. */
  intensity: number;
  /** Linear RGB, each 0 or more. Default a cool white [0.75, 0.82, 1]. */
  color?: Vec3;
  /** Size of the flash's core in metres, 1 to 100,000: the light stops growing closer than this. Default 200. */
  radius?: number;
}
const defaults = {
  coverage: 0.5,
  bottom: 1500,
  top: 4000,
  density: 0.04,
  scale: 14000,
  evolution: 3,
  steps: 64,
  lightSteps: 6,
  maxDistance: 80000,
  sunIntensity: 0.55,
  stepCap: 150,
  groundAlbedo: 0.2,
} as const;
const defaultSun: Vec3 = [0.3, 0.6, 0.4];
// The coverage map's frequency against the shapes': it repeats every scale / 0.17 metres.
const WEATHER = 0.17;
const defaultAmbient: readonly [Vec3, Vec3] = [
  [0.22, 0.3, 0.45],
  [0.015, 0.018, 0.012],
];
// Integer hash pcg3d (Jarzynski and Olano 2020, "Hash Functions for GPU Rendering", JCGT 9(3)): exact on every GPU.
const hash = /* wgsl */ `
fn cloudHash3(p:vec3u)->vec3f {
 var v=p*1664525u+1013904223u;
 v.x+=v.y*v.z;v.y+=v.z*v.x;v.z+=v.x*v.y;v^=v>>vec3u(16u);
 v.x+=v.y*v.z;v.y+=v.z*v.x;v.z+=v.x*v.y;
 return vec3f(v)*2.3283064e-10;
}
`;
// Tiling noise volumes, made once on the GPU (Schneider 2015, "The Real-Time Volumetric Cloudscapes of Horizon Zero
// Dawn", SIGGRAPH Advances in Real-Time Rendering): the shape volume holds Perlin-Worley in red and Worley fBm at three
// frequencies in green, blue and alpha; the erosion volume Worley fBm at three frequencies. Worley 1996 ("A Cellular
// Texture Basis Function"): one feature point per cell, value 1 minus the distance to the nearest. Perlin 2002
// ("Improving Noise"): gradients at lattice points, quintic fade. Both lattices wrap at the volume edge, so it tiles.
// Perlin-Worley: the Perlin field remapped from the Worley one's floor (Schneider 2015), billowy and connected.
const generate = /* wgsl */ `${hash}
@group(0) @binding(0) var volume:texture_storage_3d<rgba8unorm,write>;
fn wrapCell(c:vec3i,period:i32)->vec3u {return vec3u(((c%period)+period)%period);}
fn worley(p:vec3f,period:i32)->f32 {
 let cell=vec3i(floor(p));let f=fract(p);var best=3.0;
 for(var z=-1;z<=1;z++){for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
  let o=vec3i(x,y,z);let d=vec3f(o)+cloudHash3(wrapCell(cell+o,period))-f;best=min(best,dot(d,d));
 }}}
 return clamp(1.0-sqrt(best),0.0,1.0);
}
fn worleyFbm(p:vec3f,period:i32)->f32 {return worley(p,period)*0.625+worley(p*2.0,period*2)*0.25+worley(p*4.0,period*4)*0.125;}
fn gradientNoise(p:vec3f,period:i32)->f32 {
 let cell=vec3i(floor(p));let f=fract(p);let u=f*f*f*(f*(f*6.0-15.0)+10.0);var v=array<f32,8>();
 for(var i=0;i<8;i++){
  let o=vec3i(i&1,(i>>1)&1,(i>>2)&1);let g=normalize(cloudHash3(wrapCell(cell+o,period))*2.0-1.0+vec3f(0.0001));
  v[i]=dot(g,f-vec3f(o));
 }
 return mix(mix(mix(v[0],v[1],u.x),mix(v[2],v[3],u.x),u.y),mix(mix(v[4],v[5],u.x),mix(v[6],v[7],u.x),u.y),u.z);
}
fn perlinFbm(p:vec3f,period:i32)->f32 {
 var sum=0.0;var weight=0.5;var q=p;var n=period;
 for(var i=0;i<4;i++){sum+=gradientNoise(q,n)*weight;q*=2.0;n*=2;weight*=0.5;}
 return clamp(sum*1.1+0.5,0.0,1.0);
}
@compute @workgroup_size(4,4,4) fn shape(@builtin(global_invocation_id) id:vec3u){
 let size=textureDimensions(volume);if(any(id>=size)){return;}let p=(vec3f(id)+0.5)/vec3f(size);
 let w=worleyFbm(p*4.0,4);
 let perlinWorley=clamp((perlinFbm(p*4.0,4)-(w-1.0))/(2.0-w),0.0,1.0);
 textureStore(volume,vec3i(id),vec4f(perlinWorley,w,worleyFbm(p*8.0,8),worleyFbm(p*16.0,16)));
}
@compute @workgroup_size(4,4,4) fn erosion(@builtin(global_invocation_id) id:vec3u){
 let size=textureDimensions(volume);if(any(id>=size)){return;}let p=(vec3f(id)+0.5)/vec3f(size);
 textureStore(volume,vec3i(id),vec4f(worleyFbm(p*2.0,2),worleyFbm(p*4.0,4),worleyFbm(p*8.0,8),1));
}
`;
// Height above the planet of a world point (metres), written so f32 keeps it to a fraction of a metre at planet scale.
// Density 0 to 1 of the layer at world point p; erode adds the fine erosion (the view rays), without it the light rays
// use the cheaper base shape.
// Wind moves the field, evolution lifts it through itself, so the shapes drift and change.
// A coarse slice of the same volume (one repeat over 1 / 0.17 of the shapes) says where the clouds gather; it drifts
// by flags.zw, the wind's drift wrapped at its own repeat, as the shapes' wrap is not a whole number of its repeats.
// Its median is 0.48 and 90% of it lies in 0.29 to 0.67, so the local coverage runs from about half to one and a half times the
// option, and is 0 wherever the option is.
// Perlin-Worley over the Worley fBm (Schneider 2015) lies between 0.67 and 0.87 for 90% of the volume (measured from
// this generator on 4,000 points); stretching that span to 0..1 makes the coverage remap read as the share of sky covered.
// Rounded bases and tapering tops, then the coverage remap (Schneider 2015).
// Wispy erosion at the base, billows higher up (Schneider 2015).
// Optical depth (extinction x metres) from p toward the light l through the layer: n samples, spaced quadratically over
// three quarters of the layer's slant depth, of the base shape only.
/** WGSL of the cloud uniform and its density field, shared with `@margoengine/sky/cloud-shadows`. */
export const cloudField = /* wgsl */ `
struct Clouds {inverse:mat4x4f,eye:vec4f,sun:vec4f,sunColor:vec4f,layer:vec4f,shape:vec4f,wind:vec4f,flags:vec4f,moon:vec4f,moonColor:vec4f,flash:vec4f,flashColor:vec4f,look:vec4f,storm:array<vec4f,8>,veil:vec4f,glow:vec4f}
fn cloudRemap(x:f32,a:f32,b:f32)->f32 {return (x-a)/max(b-a,0.00001);}
fn cloudAltitude(c:Clouds,p:vec3f)->f32 {let R=c.eye.w;return (dot(p,p)+2.0*R*p.y)/(length(vec3f(p.x,p.y+R,p.z))+R);}
fn cloudBase(s:vec4f)->f32 {let low=s.g*0.625+s.b*0.25+s.a*0.125;return clamp((clamp(cloudRemap(s.r,low-1.0,1.0),0.0,1.0)-0.67)/0.21,0.0,1.0);}
//[storm-fns]
fn cloudDensityAt(c:Clouds,shape:texture_3d<f32>,detail:texture_3d<f32>,smp:sampler,p:vec3f,erode:bool)->f32 {
 let h=(cloudAltitude(c,p)-c.layer.x)/(c.layer.y-c.layer.x);if(h<=0.0||h>=1.0){return 0.0;}
//[storm-branch]
 let q=(p+vec3f(c.wind.x,c.wind.z,c.wind.y))*c.shape.x;
 let s=textureSampleLevel(shape,smp,q.xzy,0.0);
 let weather=textureSampleLevel(shape,smp,vec3f((p.xz+c.flags.zw)*c.shape.x*${WEATHER},0.37),0.0).g;
 let cover=clamp(c.layer.z*(1.0+2.5*(weather-0.48)),0.0,1.0);
 let low=s.g*0.625+s.b*0.25+s.a*0.125;
 let base=clamp((clamp(cloudRemap(s.r,low-1.0,1.0),0.0,1.0)-0.67)/0.21,0.0,1.0);
 let profile=smoothstep(0.0,0.12,h)*smoothstep(1.0,0.45,h);
 let cloud=clamp(cloudRemap(base*profile,1.0-cover,1.0),0.0,1.0)*cover;
 if(cloud<=0.0||!erode){return cloud;}
 let e=textureSampleLevel(detail,smp,((p+vec3f(c.wind.x,c.wind.z*2.0,c.wind.y)*1.5)*c.shape.y).xzy,0.0).rgb;
 let high=e.r*0.625+e.g*0.25+e.b*0.125;
 return clamp(cloudRemap(cloud,mix(high,1.0-high,clamp(h*4.0,0.0,1.0))*0.35*c.look.x,1.0),0.0,1.0);
}
fn cloudLightDepth(c:Clouds,shape:texture_3d<f32>,detail:texture_3d<f32>,smp:sampler,p:vec3f,l:vec3f,n:u32)->f32 {
 let reach=(c.layer.y-c.layer.x)*0.75/max(l.y,0.25);var od=0.0;var previous=0.0;
 for(var i=0u;i<n;i++){let f=(f32(i)+1.0)/f32(n);let t=reach*f*f;od+=cloudDensityAt(c,shape,detail,smp,p+l*(0.5*(t+previous)),false)*(t-previous);previous=t;}
 return od*c.layer.w;
}
`;
// Roots t of |o + t d| = R + h, o the eye from the planet centre, nearer first; (-1, -1) when the ray misses. The
// quadratic's constant is formed without |o|^2 - (R + h)^2 and its roots by the stable form, as f32 loses both at
// planet scale.
// Henyey-Greenstein, scaled so isotropic scattering is 1; two lobes, forward 0.8 and back -0.3 (weight 0.3), times k.
// The stretch of the view ray inside the layer: from below, above or within it.
// Each pixel starts at its own fraction of a step, so the steps do not band; with `temporal` that fraction moves on by
// the golden ratio each frame (flags.y), so every pixel walks a low-discrepancy sequence of starts for TAA to average.
// Light inside the cloud (KB-CLOUD-DECKLIGHT1, 2026-11-17; until then three octaves of exp(-b od) after Wrenninge,
// Kulla and Lundqvist 2013, "Oz: The Great and Volumetric", which left 1 percent of the light at optical depth 20 where
// diffusion leaves 40, so thick bases were near black and a deck lost three quarters of the sun). The source at a
// sample is first-order scattering plus the diffuse field of the two-stream approximation for a slab along the light
// (Meador and Weaver 1980, "Two-stream approximations to radiative transfer in planetary atmospheres", J. Atmos. Sci.
// 37; Bohren 1987, "Multiple scattering of light and some of its observable consequences", Am. J. Phys. 55), with a
// and b the optical depths from the sample to the lit face (the light march) and to the far face (the column to the
// base, cloudColumn, over the light's slant), on the scaled depths (1 - g) tau, g 0.85, of the delta-Eddington
// similarity (Joseph, Wiscombe and Weinman 1976, J. Atmos. Sci. 33): T = 2 / (2 + a' + b'), down plus up flux
// T (1 + b'), down minus up T (cloudTransmission's bound). The field leaving toward the viewer takes Eddington's linear
// angular form I = (F+ + F-) / 2 + 3/4 (F+ - F-) nu, so a deck's base is brightest overhead, as the CIE overcast sky
// (Moon and Spencer 1942). The first-order term keeps the two lobes: the forward lobe is the peak delta-Eddington folds
// into the beam, so it rides the scaled beam exp(-a'); the back lobe the unscattered exp(-a); the diffuse field is the
// two-stream total less what those carry (cloudTwoStream's u), so light is counted once. Sky light enters as a
// diffuse two-stream from above (`above`) and below (the ground: the map's lower half plus the ground albedo's bounce
// of what the deck passes), in one sum so an even surround gives exactly its own radiance (cloudSkyScatter). In units
// of the light's irradiance over pi: E / pi = 4 sunIntensity.
// Energy-conserving step (Hillaire 2016): the light scattered over the step, with single-scattering albedo 1. Far
// cloud thins into the haze as the sky's own layer does (half at 28 km of sea-level air): the air the ray crosses,
// sea-level equivalent, is its length times the mean of exp(-height / 8 km) between the eye and the sample (an
// exponential atmosphere of scale height 8 km, the straight-ray air mass; until 2026-11-17 the raw length, so a camera
// in an aircraft above a hurricane saw bands 100 km off as through 100 km of sea-level haze, 8 percent left).
// The view and the sky map share one march (cloudSpan, cloudMarch): bindings 0 to 4 as below.
// cloudMarch: the light (before the sky's exposure) and opacity along d from start to end in n steps, the first a
// fraction jitter of a step in. Steps sit at start + L ((k + jitter) / n)^p (cloudStepPower): p 1 (even) while L / n is
// at most the cap (clouds.moonColor.w, `stepCap`), else the power that makes the second step the cap, found by eight
// fixed-point rounds of p = log(L (2^p - 1) / cap) / log n (they converge, the map's slope is 2 ln 2 / ln n at p 1, under
// 1 for n of 8 or more). Each step is integrated on its own length (Hillaire 2016), and a moving start with TAA averages
// the sampling noise (Toft, Bowles and Zimmermann 2016, "Optimisations for Real-Time Volumetric Cloudscapes",
// arXiv:1609.05344), so near cloud is sampled finely and far, hazed cloud coarsely at the same cost. A lightning flash inside the cloud (VolumetricCloudOptions.flash): inverse-square past
// its core, through the base shape between it and the sample (three samples); the cloud's multiple scattering carries a
// flash far through thick cloud, so three octaves of weaker extinction (1, 0.3, 0.08) add up the light, after Wrenninge
// et al. 2013.
// The moon's first scattering also takes the diffraction peak of cloud droplets: about half the light a droplet much
// larger than the wavelength removes is diffracted into a cone a few degrees wide (the extinction paradox, extinction
// efficiency 2; van de Hulst 1957, "Light Scattering by Small Particles", 8.22). It is half the first octave's phase,
// a Henyey-Greenstein lobe of width `glow` (0.95: half its peak 2.3 degrees out; the 64 x 32 sky map, whose texels
// span 5.6 degrees, takes 0.8, the same energy spread over its texels), dimmed by the cloud toward the moon: a thin veil
// over the moon glows round the disc as it does in the night sky, a thick deck does not.
const march = /* wgsl */ `${hash}${cloudField}
@group(0) @binding(0) var<uniform> clouds:Clouds;
@group(0) @binding(1) var shapeNoise:texture_3d<f32>;
@group(0) @binding(2) var erosionNoise:texture_3d<f32>;
@group(0) @binding(3) var noiseSampler:sampler;
@group(0) @binding(4) var skyLight:texture_2d<f32>;
fn cloudShell(d:vec3f,h:f32)->vec2f {
 let e=clouds.eye.xyz;let R=clouds.eye.w;let b=dot(e,d)+R*d.y;let k=dot(e,e)+2.0*R*(e.y-h)-h*h;let disc=b*b-k;
 if(disc<0.0){return vec2f(-1.0);}
 let q=-(b+select(-sqrt(disc),sqrt(disc),b>=0.0));if(abs(q)<1e-6){return vec2f(0.0);}
 let roots=vec2f(q,k/q);return vec2f(min(roots.x,roots.y),max(roots.x,roots.y));
}
fn cloudHG(nu:f32,g:f32)->f32 {return (1.0-g*g)/pow(max(1.0+g*g-2.0*g*nu,0.0001),1.5);}
fn cloudPhaseK(nu:f32,k:f32)->f32 {return mix(cloudHG(nu,0.8*k),cloudHG(nu,-0.3*k),0.3);}
fn cloudTwoStream(a:f32,b:f32,nu:f32,u:f32)->f32 {
 let t=2.0/(2.0+0.15*(a+b));
 return max(0.0,0.5*(t*(1.0+0.15*b)-u)+0.75*(t-u)*nu);
}
fn cloudScatter(a:f32,b:f32,nu:f32)->f32 {
 let forward=exp(-0.15*a);let back=exp(-a);
 return 0.7*cloudHG(nu,0.8)*forward+0.3*cloudHG(nu,-0.3)*back+4.0*cloudTwoStream(a,b,nu,0.7*forward+0.3*back);
}
fn cloudSkyScatter(above:vec3f,below:vec3f,a:f32,b:f32,nu:f32)->vec3f {
 let t=2.0/(2.0+0.15*(a+b));
 return max(vec3f(0),t*(0.5*(above*(1.0+0.15*b)+below*(1.0+0.15*a))+0.75*nu*(above-below)));
}
fn cloudColumn(p:vec3f,dir:vec3f,reach:f32,n:u32)->f32 {
 var od=0.0;for(var i=0u;i<n;i++){od+=cloudDensityAt(clouds,shapeNoise,erosionNoise,noiseSampler,p+dir*(reach*(f32(i)+0.5)/f32(n)),false);}
 return od*reach/f32(n)*clouds.layer.w;
}
fn cloudAirPath(h0:f32,h1:f32,t:f32)->f32 {
 let a=exp(-h0/8000.0);let dh=max(h1,0.0)-h0;if(abs(dh)<1.0){return t*a;}return t*8000.0*(a-exp(-max(h1,0.0)/8000.0))/dh;
}
fn cloudStepPower(L:f32,n:f32,cap:f32)->f32 {
 if(cap<=0.0||L<=cap*n){return 1.0;}
 let ln=log(n);var p=max(1.0,log(L/cap)/ln);
 for(var i=0;i<8;i++){p=max(1.0,log(L*(exp2(p)-1.0)/cap)/ln);}
 return p;
}
fn cloudSpan(d:vec3f)->vec2f {
 let bottom=clouds.layer.x;let top=clouds.layer.y;let altitude=cloudAltitude(clouds,clouds.eye.xyz);
 var start=0.0;var end=-1.0;
 if(altitude<bottom){
  let up=normalize(vec3f(clouds.eye.x,clouds.eye.y+clouds.eye.w,clouds.eye.z));
  if(dot(d,up)>0.0){start=cloudShell(d,bottom).y;end=cloudShell(d,top).y;}
 } else if(altitude<=top){
  let low=cloudShell(d,bottom);end=select(cloudShell(d,top).y,low.x,low.x>0.0);
 } else {
  let high=cloudShell(d,top);
  if(high.x>0.0){start=high.x;let low=cloudShell(d,bottom);end=select(high.y,low.x,low.x>0.0);}
 }
 return vec2f(start,min(end,start+clouds.shape.z));
}
struct CloudLight {light:vec3f,scene:vec3f,opacity:f32}
fn cloudMarch(d:vec3f,start:f32,end:f32,n:u32,jitter:f32,glow:f32)->CloudLight {
 let bottom=clouds.layer.x;let top=clouds.layer.y;
 let span=end-start;let nf=f32(n);let power=cloudStepPower(span,nf,clouds.moonColor.w);let s=clouds.sun.xyz;let nu=dot(d,s);
 let lit=max(clouds.sunColor.r,max(clouds.sunColor.g,clouds.sunColor.b))>0.0;
 let above=textureLoad(skyLight,vec2i(0,0),0).rgb;let below=textureLoad(skyLight,vec2i(1,0),0).rgb+clouds.look.w*above;
 let m=clouds.moon.xyz;let nuMoon=dot(d,m);let moonLit=clouds.moon.w>0.0&&max(clouds.moonColor.r,max(clouds.moonColor.g,clouds.moonColor.b))>0.0;
 let lightN=u32(clouds.wind.w);let columnN=max(1u,(lightN+1u)/2u);let eyeHeight=max(cloudAltitude(clouds,clouds.eye.xyz),0.0);
 // The ground lit by the sun under the deck, as cloud-sun units (E / pi = 4k): look.w is the albedo times the deck's share.
 let ground=clouds.sunColor.rgb*clouds.sun.w*4.0*clouds.look.w*max(s.y,0.0);
 var t=start+span*pow(jitter/nf,power);
 var transmittance=1.0;var light=vec3f(0);var scene=vec3f(0);var opacity=0.0;
 for(var k=0u;k<n;k++){
  let next=start+span*pow((f32(k)+1.0+jitter)/nf,power);let dt=next-t;
  let p=clouds.eye.xyz+d*t;let density=cloudDensityAt(clouds,shapeNoise,erosionNoise,noiseSampler,p,true);
  if(density>0.0){
   let sigma=density*clouds.layer.w;
   let altitude=cloudAltitude(clouds,p);let up=normalize(vec3f(p.x,p.y+clouds.eye.w,p.z));let nuUp=dot(d,up);
   // Optical depth down the local vertical to the base, and toward each light to the layer's lit face.
   let below0=cloudColumn(p,-up,max(altitude-bottom,0.0),columnN);
   var sun=vec3f(0);var aUp=-1.0;
   if(lit){
    let a=cloudLightDepth(clouds,shapeNoise,erosionNoise,noiseSampler,p,s,lightN);let slant=max(s.y,0.25);aUp=a*slant;
    sun=clouds.sunColor.rgb*clouds.sun.w*cloudScatter(a,below0/slant,nu)+cloudSkyScatter(vec3f(0),ground,aUp,below0,nuUp);
   }
   var moon=vec3f(0);
   if(moonLit){
    let od=cloudLightDepth(clouds,shapeNoise,erosionNoise,noiseSampler,p,m,lightN);let slant=max(m.y,0.25);
    if(aUp<0.0){aUp=od*slant;}
    moon=clouds.moonColor.rgb*clouds.moon.w*0.15*(cloudScatter(od,below0/slant,nuMoon)+0.5*(cloudHG(nuMoon,glow)-cloudPhaseK(nuMoon,1.0))*exp(-0.15*od));
   }
   if(aUp<0.0){aUp=cloudColumn(p,up,max(top-altitude,0.0),columnN);}
   let sky=cloudSkyScatter(above,below,aUp,below0,nuUp);
   var flash=vec3f(0);
   if(clouds.flash.w>0.0){
    let toward=clouds.flash.xyz-p;let r2=dot(toward,toward);var od=0.0;
    for(var f=1u;f<=3u;f++){od+=cloudDensityAt(clouds,shapeNoise,erosionNoise,noiseSampler,p+toward*(f32(f)*0.25),false);}
    od*=clouds.layer.w*sqrt(r2)*0.25;
    flash=clouds.flashColor.rgb*clouds.flash.w*(exp(-od)+0.5*exp(-0.3*od)+0.25*exp(-0.08*od))/(r2+clouds.flashColor.w*clouds.flashColor.w);
   }
   let step=exp(-sigma*dt);let haze=exp(-cloudAirPath(eyeHeight,altitude,t)/40000.0);let w=transmittance*(1.0-step)*haze;
   light+=w*(sun+sky+moon+flash);scene+=w*(sky+flash+clouds.look.y*sun+clouds.look.z*moon);opacity+=w;transmittance*=step;
   if(transmittance<0.01){break;}
  }
  t=next;
 }
 return CloudLight(light,scene,opacity);
}
// The low haze layer under the deck (the sky's atmosphere.layerTransmittance and scatteredLight): the deck stands above
// it, so its premultiplied light is seen through it, the layer's transmittance straight up (veil.rgb) to the power
// 1 / sin e along the ray d e up (Beer-Lambert through a flat layer, e floored at 3 degrees, as the sky draws what is
// above the layer), times the sky's sunIntensity (veil.w), with the layer's glow in sky units (glow.rgb) over the
// cloud's opacity in front (KB-SKY-PALLCLOUD1). 1 and 0 leave the cloud as it is.
fn cloudVeiled(light:vec3f,opacity:f32,d:vec3f)->vec3f {
 let t=pow(max(clouds.veil.rgb,vec3f(1e-30)),vec3f(1.0/max(d.y/max(length(d),1e-6),0.052336)));
 return light*t*clouds.veil.w+opacity*clouds.glow.rgb;
}
`;
const shader = (depthBinding: string) => /* wgsl */ `${fullscreen}${march}${displayShader}
${depthBinding}
@fragment fn fragment(i:Vertex)->@location(0) vec4f {
 let ndc=vec2f(i.uv.x*2.0-1.0,1.0-i.uv.y*2.0);let far=clouds.inverse*vec4f(ndc,0.000001,1);
 let d=normalize(far.xyz/far.w-clouds.eye.xyz);
 let span=cloudSpan(d);var end=span.y;
 ${depthBinding ? `let z=sceneDepthAt(vec2i(i.position.xy));if(z>0.0){let w=clouds.inverse*vec4f(ndc,z,1);end=min(end,length(w.xyz/w.w-clouds.eye.xyz));}` : ''}
 if(end<=span.x){discard;}
 let m=cloudMarch(d,span.x,end,u32(clouds.shape.w),fract(cloudHash3(vec3u(vec2u(i.position.xy),7u)).x+clouds.flags.y),0.95);
 if(m.opacity<=0.0){discard;}
 var color=cloudVeiled(m.light,m.opacity,d)*clouds.sunColor.w;
 if(clouds.flags.x>0.5){color=toDisplay(color/m.opacity)*m.opacity;}
 return vec4f(color,m.opacity);
}
`;
// The deck as the sky's environment sees it (Sky.environmentLayer): each texel of the sky's 64 x 32 map, in its
// equirectangular layout (environmentDirection in environment.ts), holds the clouds' light at the sky's exposure,
// premultiplied, and their opacity: the mean of four rays across the texel at stratified starts, 32 steps each. The
// second map (Sky.environmentLightLayer) is the same deck as the scene's light takes it: its sky light, its bounce of
// the sky off the ground and its flash, and its sun and moon light only as `look.y` and `look.z` say (0 under
// dimLight, whose engine lights already carry them; else matched to the engine lights' units).
const deckShader = /* wgsl */ `${march}
@group(0) @binding(5) var deck:texture_storage_2d<rgba16float,write>;
@group(0) @binding(6) var deckLight:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=vec2u(64,32))){return;}
 var light=vec3f(0);var scene=vec3f(0);var opacity=0.0;
 for(var r=0u;r<4u;r++){
  let uv=(vec2f(id.xy)+vec2f(f32(r&1u),f32(r>>1u))*0.5+0.25)/vec2f(64,32);
  let phi=(uv.x-0.5)*6.2831853;let theta=uv.y*3.14159265;
  let d=vec3f(sin(theta)*cos(phi),cos(theta),sin(theta)*sin(phi));
  let span=cloudSpan(d);
  if(span.y>span.x){let m=cloudMarch(d,span.x,span.y,32u,(f32(r)+0.5)*0.25,0.8);light+=m.light;scene+=m.scene;opacity+=m.opacity;}
 }
 let k=0.25*clouds.sunColor.w;
 let mid=(vec2f(id.xy)+0.5)/vec2f(64,32);let mp=(mid.x-0.5)*6.2831853;let mt=mid.y*3.14159265;
 let dir=vec3f(sin(mt)*cos(mp),cos(mt),sin(mt)*sin(mp));
 textureStore(deck,vec2i(id.xy),vec4f(cloudVeiled(light,opacity,dir)*k,opacity*0.25));
 textureStore(deckLight,vec2i(id.xy),vec4f(cloudVeiled(scene,opacity,dir)*k,opacity*0.25));
}
`;
// The sky light the clouds receive, from the sky's 64 x 32 reflection map: the cosine-weighted mean radiance of the upper
// half (light from above) and of the lower half (the ground, light from below), with the sky's exposure taken back out.
const skyLightShader = /* wgsl */ `${cloudField}
@group(0) @binding(0) var<uniform> clouds:Clouds;
@group(0) @binding(1) var map:texture_2d<f32>;
@group(0) @binding(2) var lightOut:texture_storage_2d<rgba32float,write>;
var<workgroup> sums:array<vec4f,128>;
@compute @workgroup_size(64) fn main(@builtin(local_invocation_index) x:u32){
 var above=vec4f(0);var side=vec4f(0);
 for(var y=0u;y<16u;y++){let theta=(f32(y)+0.5)/32.0*3.14159265;let w=cos(theta)*sin(theta);above+=vec4f(textureLoad(map,vec2u(x,y),0).rgb*w,w);
  side+=vec4f(textureLoad(map,vec2u(x,31u-y),0).rgb*w,w);}
 sums[x]=above;sums[64u+x]=side;workgroupBarrier();
 for(var s=32u;s>0u;s=s>>1u){if(x<s){sums[x]+=sums[x+s];sums[64u+x]+=sums[64u+x+s];}workgroupBarrier();}
 if(x==0u){let unexpose=1.0/clouds.sunColor.w;
  textureStore(lightOut,vec2i(0,0),vec4f(sums[0].rgb/sums[0].w*unexpose,1));textureStore(lightOut,vec2i(1,0),vec4f(sums[64].rgb/sums[64].w*unexpose,1));}
}
`;
/**
 * The two tiling noise volumes of the cloud field (64³ shape, 32³ erosion) and their repeating sampler, filled by compute
 * on the first {@link CloudVolumes.fill}. The generator is deterministic, so every copy holds the same clouds: the
 * `@margoengine/sky/cloud-shadows` effect keeps its own copy and needs nothing from the clouds' GPU objects.
 */
export class CloudVolumes {
  readonly shape: GPUTexture;
  readonly erosion: GPUTexture;
  readonly sampler: GPUSampler;
  private filled = false;
  constructor(device: GPUDevice) {
    const volume = (size: number) =>
      device.createTexture({
        size: [size, size, size],
        dimension: '3d',
        format: 'rgba8unorm',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      });
    this.shape = volume(64);
    this.erosion = volume(32);
    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      addressModeW: 'repeat',
    });
  }
  /** Encodes the generation once; later calls do nothing. */
  fill(device: GPUDevice, encoder: GPUCommandEncoder): void {
    if (this.filled) return;
    const code = device.createShaderModule({ code: generate });
    for (const [texture, entryPoint, groups] of [
      [this.shape, 'shape', 16],
      [this.erosion, 'erosion', 8],
    ] as const) {
      const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module: code, entryPoint } }),
        pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: texture.createView() }],
        }),
      );
      pass.dispatchWorkgroups(groups, groups, groups);
      pass.end();
    }
    this.filled = true;
  }
  /** Frees both volumes. */
  dispose(): void {
    this.shape.destroy();
    this.erosion.destroy();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
// What a forced type sees as its weather when no `weather` is given: half the sky under cloud.
const typeWeather: CloudWeather = { cloud: 0.5 },
  weatherLayer: MutableCloudLayer = { coverage: 0, bottom: 0, top: 0, density: 0 },
  writeScratch: MutableCloudLayer = { coverage: 0, bottom: 0, top: 0, density: 0 };
/**
 * The layer the options give: each of `coverage`, `bottom`, `top` and `density` as set, else the `weather`'s type
 * (`cloudLayerFor`), else the default. `out`, when given, receives the values and is returned (no allocation).
 * @example layerOf({ weather: { cloud: 1 }, coverage: 0.7 }); // stratus, 300 to 900 m, at 0.7 cover
 */
export function layerOf(
  options: VolumetricCloudOptions,
  out: MutableCloudLayer = { coverage: 0, bottom: 0, top: 0, density: 0 },
): CloudLayer {
  const type = options.type ?? (options.hurricane !== undefined ? 'hurricane' : undefined),
    w = options.weather || type ? cloudLayerFor(options.weather ?? typeWeather, weatherLayer, type) : undefined;
  out.coverage = options.coverage ?? w?.coverage ?? defaults.coverage;
  out.bottom = options.bottom ?? w?.bottom ?? defaults.bottom;
  out.top = options.top ?? w?.top ?? defaults.top;
  out.density = options.density ?? w?.density ?? defaults.density;
  return out;
}
/**
 * Writes the sky's low haze layer into the `Clouds` uniform (floats 96 to 103): its transmittance straight up
 * (`atmosphere.layerTransmittance`) and the sky's `sunIntensity`, then the layer's glow (`atmosphere.scatteredLight`
 * times `sunIntensity` times the zenith sun over pi, in sky units, as `@margoengine/sky/look` writes it for the dome).
 * Without a sky or its `atmosphere`: 1 and 0, the clouds as they are.
 */
export function writeVeil(v: Float32Array, sky: VolumetricCloudSky | undefined): void {
  const a = sky?.options.atmosphere,
    through = a?.layerTransmittance,
    glow = a?.scatteredLight,
    intensity = a?.sunIntensity ?? 1,
    unit = (intensity * (sky?.zenithSun ?? 0)) / Math.PI;
  for (let i = 0; i < 3; i++) {
    v[96 + i] = through ? through[i]! : 1;
    v[100 + i] = glow ? glow[i]! * unit : 0;
  }
  v[99] = intensity;
  v[103] = 0;
}
/** Floats in the `Clouds` uniform ({@link cloudField}): the buffers of the clouds, their shadows and shafts hold this many. */
export const CLOUD_FLOATS = 104;
let loadedStorm: StormField | undefined, loading: Promise<StormField> | undefined, loadError: unknown;
/** Whether the options draw a storm: a `hurricane`, or `type: 'hurricane'`. */
export const wantsStorm = (options: VolumetricCloudOptions): boolean =>
  options.hurricane !== undefined || options.type === 'hurricane';
/**
 * Loads the storm's WGSL and maths (about 3 kB, kept out of clouds without a storm). `VolumetricClouds` starts it itself
 * when its options draw a storm; its `ready` resolves with it. Cloud shadows and light shafts of a storm wait for it
 * themselves: they draw nothing of the storm until it has arrived, then compile it in.
 */
export function loadStormField(): Promise<StormField> {
  return (loading ??= import('./storm-field.js').then((m) => (loadedStorm = m.stormField(WEATHER))));
}
/** The storm field once loaded, else undefined (starting the load when `options` draw a storm). */
export function stormFieldFor(options: VolumetricCloudOptions): StormField | undefined {
  // A failed load is thrown by every draw that needs it (a draw never waits on it, so it cannot reject there).
  if (loadError !== undefined) throw loadError;
  if (!loadedStorm && wantsStorm(options))
    loadStormField().catch((e: unknown) => (loadError = e ?? new Error('storm field failed to load')));
  return loadedStorm;
}
/** The cloud field's WGSL (or any shader holding it) with the storm's functions when `field` is given. */
export const withStorm = (code: string, field?: StormField): string =>
  field ? code.replace('//[storm-fns]', field.fns).replace('//[storm-branch]', field.branch) : code;
/**
 * Writes the layer's fields of the `Clouds` uniform ({@link cloudField}) into `v` ({@link CLOUD_FLOATS} long): the
 * planet radius, base and tops, coverage, density, the noise scales, the drift and the storm at `seconds` on the layer's
 * clock. Shared by the clouds and their shadows, so both read one field.
 */
export function writeLayer(
  v: Float32Array,
  options: VolumetricCloudOptions,
  drift: ArrayLike<number>,
  seconds = 0,
): void {
  const scale = options.scale ?? defaults.scale,
    layer = layerOf(options, writeScratch);
  v[19] = PLANET_RADIUS;
  v[28] = layer.bottom;
  v[29] = layer.top;
  v[30] = layer.coverage;
  v[31] = layer.density;
  v[32] = 1 / scale;
  v[33] = 8 / scale;
  v[36] = drift[0];
  v[37] = drift[1];
  v[38] = drift[2];
  v[42] = drift[3] ?? 0;
  v[43] = drift[4] ?? 0;
  v[60] = options.erosion ?? 1;
  if (loadedStorm) loadedStorm.write(v, options, seconds, scale);
  else v.fill(0, 64, 96);
}
const inRange = (value: number, low: number, high: number) => Number.isFinite(value) && value >= low && value <= high;
/**
 * Volumetric clouds: a layer of real 3D cloud between `bottom` and `top`, ray marched through tiling noise volumes,
 * lit by the sun with self-shadowing and multiple scattering, so light breaks through gaps in shafts and the shapes
 * drift and change with the wind. A camera can fly into, through and above the layer.
 * `VolumetricClouds.attach(engine, {sky})`; leave the sky's own `clouds` option off with it.
 * @throws TypeError / RangeError on invalid options; MargoError `'unsupported'` on a WebGL engine, `'disposed'` after
 * `dispose()`, `'state'` when the camera matrix is not invertible.
 */
export class VolumetricClouds implements EnginePlugin {
  readonly name: string = 'sky:volumetric-clouds';
  private engine?: Engine;
  private uniform?: GPUBuffer;
  private volumes?: CloudVolumes;
  private light?: GPUTexture;
  private pipeline?: GPURenderPipeline;
  private bind?: GPUBindGroup;
  private key = '';
  private bound?: GPUTexture | GPUTextureView;
  private lightPipeline?: GPUComputePipeline;
  private lightGroup?: GPUBindGroup;
  private lightSource?: GPUTexture;
  private deck?: GPUTexture;
  private deckLight?: GPUTexture;
  private deckPipeline?: GPUComputePipeline;
  private deckGroup?: GPUBindGroup;
  private layered?: VolumetricCloudSky;
  private disposed = false;
  // Timed updates so far (the march start counter) and seconds, both moved by advanceTime. `extra` counts draws that
  // followed a zero-delta update since the last timed one (a still frame drawn again, a capture), and `pending` says a
  // zero-delta update came since the last draw; the next timed update drops them (KB-FILM-CLOUDPHASE1).
  private frames = 0;
  private extra = 0;
  private pending = false;
  private seconds = 0;
  private readonly values = new Float32Array(CLOUD_FLOATS);
  private readonly scratch = new Float64Array(52);
  private readonly color = new Float32Array(3);
  private readonly ambientValues = new Float32Array(8);
  // The layer the options give this frame (layerOf), and the sky whose sun and moon the deck dims (Sky.deck).
  private readonly layer: MutableCloudLayer = { coverage: 0, bottom: 0, top: 0, density: 0 };
  private decked: VolumetricCloudSky | undefined;
  // The storm field the pipelines were built with (undefined: without one).
  private built: StormField | undefined;
  /**
   * The share of a light at elevation sine `up` the deck passes (`cloudDeckTransmittance` of the options' layer), or 1
   * with `dimLight: false`. Handed to the sky as its `deck`.
   */
  private readonly deckOf = (up: number): number => {
    if (this.options.dimLight === false) return 1;
    const layer = layerOf(this.options, this.layer) as MutableCloudLayer,
      storm = loadedStorm?.of(this.options);
    if (storm) {
      // Under a storm the deck passes what the cloud over the camera passes: the sun shines into the clear eye.
      const p = this.engine?.camera.position ?? [0, 0, 0];
      layer.coverage *= Math.min(1, loadedStorm!.coverOver(storm, p[0], p[2], this.seconds, layer.top - layer.bottom));
    }
    return cloudDeckTransmittance(layer, up);
  };
  /**
   * Metres the shapes have moved along X and Z with the wind and risen through themselves, each wrapped at the shapes'
   * repeat (`scale`); then the wind's X and Z drift again, wrapped at the coverage map's repeat (`scale` / 0.17).
   */
  readonly drift = new Float64Array(5);
  constructor(readonly options: VolumetricCloudOptions = {}) {
    this.validate();
  }
  static attach(engine: EngineKernel, options: VolumetricCloudOptions = {}): VolumetricClouds {
    const clouds = new VolumetricClouds(options);
    engineRuntime(engine).use(clouds);
    return clouds;
  }
  private validate(): void {
    const o = this.options;
    if (typeof o !== 'object' || o === null) throw new TypeError('VolumetricClouds options must be an object');
    if (o.sky !== undefined && (typeof o.sky !== 'object' || o.sky === null || !(o.sky.sun?.length >= 3)))
      throw new TypeError(
        'VolumetricClouds sky must be a Sky (with a sun direction); pass the sky that lights the clouds',
      );
    if (o.temporal !== undefined && typeof o.temporal !== 'boolean' && o.temporal !== 'auto')
      throw new TypeError("VolumetricClouds temporal must be true, false or 'auto'");
    if (o.dimLight !== undefined && typeof o.dimLight !== 'boolean')
      throw new TypeError('VolumetricClouds dimLight must be true or false');
    if (o.weather !== undefined || o.type !== undefined) cloudLayerFor(o.weather ?? typeWeather, undefined, o.type);
    if (o.hurricane !== undefined && (typeof o.hurricane !== 'object' || o.hurricane === null))
      throw new TypeError('VolumetricClouds hurricane must be a Hurricane or its options');
    if (o.depth !== undefined && typeof o.depth !== 'function')
      throw new TypeError('VolumetricClouds depth must be a function returning the scene depth texture');
    if (o.sunDirection) finiteVector(o.sunDirection, 3, 'VolumetricClouds sunDirection');
    if (o.sunDirection && !(Math.hypot(...o.sunDirection) > 0))
      throw new RangeError('VolumetricClouds sunDirection needs a nonzero length');
    if (o.wind) finiteVector(o.wind, 2, 'VolumetricClouds wind');
    if (o.ambient) for (const c of o.ambient) finiteVector(c, 3, 'VolumetricClouds ambient');
    if (o.flash !== undefined) {
      if (typeof o.flash !== 'object' || o.flash === null)
        throw new TypeError('VolumetricClouds flash must be an object with a position and an intensity');
      finiteVector(o.flash.position, 3, 'VolumetricClouds flash position');
      if (o.flash.color) finiteVector(o.flash.color, 3, 'VolumetricClouds flash color');
      if (
        !inRange(o.flash.intensity, 0, 1e12) ||
        (o.flash.color && o.flash.color.some((c) => c < 0)) ||
        !inRange(o.flash.radius ?? 200, 1, 100000)
      )
        throw new RangeError(
          'Invalid VolumetricClouds flash; use an intensity of 0 to 1e12, a color of 0 or more and a radius of 1 to 100000',
        );
    }
    const { coverage, bottom, top, density } = layerOf(o, this.layer);
    if (
      !inRange(coverage, 0, 1) ||
      !inRange(bottom, 100, 20000) ||
      !inRange(top, bottom + 1, 20000) ||
      !inRange(density, 1e-6, 1) ||
      !inRange(o.stepCap ?? defaults.stepCap, 10, 10000) ||
      !inRange(o.erosion ?? 1, 0, 2) ||
      !inRange(o.groundAlbedo ?? defaults.groundAlbedo, 0, 1) ||
      !inRange(o.scale ?? defaults.scale, 1000, 200000) ||
      !inRange(o.evolution ?? defaults.evolution, 0, 50) ||
      !Number.isInteger(o.steps ?? defaults.steps) ||
      !inRange(o.steps ?? defaults.steps, 8, 256) ||
      !Number.isInteger(o.lightSteps ?? defaults.lightSteps) ||
      !inRange(o.lightSteps ?? defaults.lightSteps, 1, 16) ||
      !inRange(o.maxDistance ?? defaults.maxDistance, 1000, 400000) ||
      !inRange(o.sunIntensity ?? defaults.sunIntensity, 0, 1000)
    )
      throw new RangeError(
        'Invalid VolumetricClouds options; keep coverage 0 to 1, bottom 100 to 20000 below top (at most 20000), density above 0 to 1, scale 1000 to 200000, evolution 0 to 50, integer steps 8 to 256 and lightSteps 1 to 16, maxDistance 1000 to 400000, stepCap 10 to 10000, groundAlbedo 0 to 1 and sunIntensity 0 or more.',
      );
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'VolumetricClouds requires WebGPU; attach new VolumetricClouds to a WebGPU engine; see https://margoengine.com/errors#webgpu',
      );
    this.engine = engine;
    this.hookDeck();
    const d = engine.gpu;
    this.uniform = d.createBuffer({
      size: this.values.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.volumes = new CloudVolumes(d);
    this.light = d.createTexture({
      size: [2, 1],
      format: 'rgba32float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const map = () =>
      d.createTexture({
        size: [64, 32],
        format: 'rgba16float',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      });
    this.deck = map();
    this.deckLight = map();
  }
  registerPasses(graph: FrameGraph): void {
    // After the sky (2) and before its fog (5): the clouds composite over the sky backdrop, and fog over them.
    graph.add({
      name: 'sky:volumetric-clouds',
      order: 3,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c);
      },
    });
  }
  /**
   * Resolves once what the options draw is loaded: at once without a storm, else when the storm's WGSL and maths have
   * arrived (the layer draws nothing until then, and neither do its `volumetricCloudShadows` and `LightShafts`, which
   * take the storm in on their own once it is in). Await it before the first frame you keep.
   */
  get ready(): Promise<void> {
    // The storm's options are checked once its code is in; a bad one rejects here and throws in the next draw.
    return wantsStorm(this.options) ? loadStormField().then((f) => void f.of(this.options)) : Promise.resolve();
  }
  /** Seconds on this layer's clock: the sum of the deltas given to `advanceTime` (each frame update runs it). */
  get time(): number {
    return this.seconds;
  }
  onPreUpdate(delta: number): void {
    this.advanceTime(delta);
  }
  /**
   * Puts the layer's clocks back to 0 (the wind and evolution drift, the march start counter of `temporal` and its
   * capture steps), as a fresh layer has them, so a later `seek` (`resetClocks` from `@margoengine/cutscene/seek` calls
   * it on every clock) gives what a fresh world seeked there gives, and the next draw marches from the first start
   * (GAP-FILM-RESET).
   */
  resetTime(): void {
    this.seconds = 0;
    this.frames = 0;
    this.extra = 0;
    this.pending = false;
    this.drift.fill(0);
  }
  /**
   * Moves the layer's clocks by `delta` seconds without drawing: the wind and evolution drift (which cloud shadows and
   * shafts read too) and the march start counter of `temporal`. `seek` from `@margoengine/cutscene/seek` replays it.
   * A `delta` of 0 is the same instant drawn again (a Reflector, Refractor or CubeCamera capture renders the scene
   * inside the frame, and the clouds draw in it), so it moves no counter: the next draw marches from the next start,
   * for that draw only, and the next timed update drops that step again. So the frame's own draw marches from the
   * start a continuous run or a seek has there however many captures come first, and still frames drawn again still
   * move the start for temporal anti-aliasing (KB-FILM-CLOUDPHASE1).
   */
  advanceTime(delta: number): void {
    this.validate();
    if (!Number.isFinite(delta) || delta < 0)
      throw new RangeError('Invalid VolumetricClouds delta; pass a finite delta of 0 or more seconds.');
    if (!(delta > 0)) {
      this.pending = true;
      return;
    }
    this.hookDeck();
    this.seconds += delta;
    this.frames = (this.frames + 1) % 1024;
    this.extra = 0;
    this.pending = false;
    const wind = this.options.wind ?? [10, 3],
      scale = this.options.scale ?? defaults.scale;
    // The shapes repeat every `scale` metres and the coverage map every scale / 0.17, so each drift wraps at its own
    // repeat in double precision and stays exact in f32. Until 2026-11-14 the coverage map took the shapes' wrap, 0.17
    // of its own repeat, and the whole sky's cloud cover jumped there (every 23 minutes in the default wind).
    const map = scale / WEATHER;
    this.drift[0] = (this.drift[0] + wind[0] * delta) % scale;
    this.drift[1] = (this.drift[1] + wind[1] * delta) % scale;
    this.drift[2] = (this.drift[2] + (this.options.evolution ?? defaults.evolution) * delta) % scale;
    this.drift[3] = (this.drift[3] + wind[0] * delta) % map;
    this.drift[4] = (this.drift[4] + wind[1] * delta) % map;
  }
  private write(c: Context): boolean {
    const o = this.options,
      v = this.values,
      sky = o.sky;
    if (!invertMatrixStable(c.camera.matrix, v.subarray(0, 16), this.scratch))
      throw new MargoError('state', 'Invalid VolumetricClouds camera; give the camera a finite, invertible projection');
    const layer = layerOf(o, this.layer),
      { bottom, top } = layer,
      sun = sky?.sun ?? o.sunDirection ?? defaultSun,
      length = Math.hypot(sun[0], sun[1], sun[2]) || 1;
    v.set(c.camera.position, 16);
    writeLayer(v, o, this.drift, this.seconds);
    for (let i = 0; i < 3; i++) v[20 + i] = sun[i] / length;
    v[23] = o.sunIntensity ?? defaults.sunIntensity;
    // The sun's colour through the sky's atmosphere at the middle of the layer: warm and dim low down, 0 once it has set.
    sunlight(v[21], (bottom + top) / 2000, sky?.options.turbidity ?? 2, this.color);
    v.set(this.color, 24);
    v[27] = 2 ** (sky?.options.exposure ?? 0);
    v[34] = o.maxDistance ?? defaults.maxDistance;
    v[35] = o.steps ?? defaults.steps;
    v[39] = o.lightSteps ?? defaults.lightSteps;
    v[40] = +!linearHdr(c.format);
    // The march start's offset this frame (`temporal`): the golden ratio's fraction, f32 exact within 1024 frames. The
    // counter moves once per timed update, in advanceTime (until 2026-11-16 once per draw, so a seek could not move
    // it); a draw after a zero-delta update adds a step that the next timed update drops (KB-FILM-CLOUDPHASE1). The
    // first frame still marches from 0.
    if (this.pending) this.extra = (this.extra + 1) % 1024;
    this.pending = false;
    const temporal = o.temporal === true || (o.temporal !== false && !!this.engine?.hasPlugin('taa'));
    v[41] = temporal ? (((this.frames + this.extra + 1023) % 1024) * 0.6180339887498949) % 1 : 0;
    const moon = sky?.lights?.[1];
    for (let i = 0; i < 4; i++) v[44 + i] = moon ? moon.direction[i] : 0;
    for (let i = 0; i < 3; i++) v[48 + i] = moon ? moon.radiance[i] : 0;
    v[51] = o.stepCap ?? defaults.stepCap;
    const flash = o.flash;
    v.set(flash?.position ?? [0, 0, 0], 52);
    v[55] = flash?.intensity ?? 0;
    v.set(flash?.color ?? [0.75, 0.82, 1], 56);
    v[59] = flash?.radius ?? 200;
    // The deck's light as the scene takes it (Sky.environmentLightLayer): with dimLight the engine's sun and moon
    // lights already carry what the deck passes of them (Sky.deck), so their part stays out; without it, their part
    // comes in matched to the engine lights in the sky's units, which the sky's lighting takes into the engine's by
    // Sky.lightScale with the rest of the map (KB-SKY-SUNUNITS1; a sky without one takes the map as engine units): the
    // sun's zenith irradiance in sky units is the sky lighting's intensity over that scale, the moon's is the moon light
    // over it, where the clouds take 4 pi times sunIntensity and 4 pi times 0.15 of them.
    const dim = o.dimLight !== false && !!sky,
      k = v[23],
      scale = sky?.lightScale ?? 1,
      intensity = sky?.options.lighting ? (sky.options.lighting.intensity ?? 1) : 0;
    v[61] = dim || !(k > 0) || !(scale > 0) ? 0 : intensity / scale / (4 * Math.PI * k);
    v[62] = dim || !(scale > 0) ? 0 : 1 / (4 * Math.PI * 0.15) / scale;
    // The ground's albedo times the share of the light the deck passes to it (cloudDeckTransmittance at the sun's height).
    v[63] = (o.groundAlbedo ?? defaults.groundAlbedo) * cloudDeckTransmittance(layer, Math.max(v[21], 0.1));
    writeVeil(v, sky);
    c.device.queue.writeBuffer(this.uniform!, 0, v as Float32Array<ArrayBuffer>);
    return v[30] > 0;
  }
  // The sky light: from the sky's reflection map on the GPU when it has one, else the `ambient` option.
  private skyLight(c: Context): void {
    const map = this.options.sky?.reflectionTexture;
    if (map) {
      if (this.lightSource !== map) {
        this.lightPipeline ??= c.device.createComputePipeline({
          layout: 'auto',
          compute: {
            module: c.device.createShaderModule({ code: withStorm(skyLightShader, this.built) }),
            entryPoint: 'main',
          },
        });
        this.lightGroup = c.device.createBindGroup({
          layout: this.lightPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.uniform! } },
            { binding: 1, resource: map.createView() },
            { binding: 2, resource: this.light!.createView() },
          ],
        });
        this.lightSource = map;
      }
      const pass = c.encoder.beginComputePass();
      pass.setPipeline(this.lightPipeline!);
      pass.setBindGroup(0, this.lightGroup!);
      pass.dispatchWorkgroups(1);
      pass.end();
      return;
    }
    const [above, horizon] = this.options.ambient ?? defaultAmbient,
      a = this.ambientValues;
    a.set(above, 0);
    a.set(horizon, 4);
    a[3] = a[7] = 1;
    c.device.queue.writeTexture({ texture: this.light! }, a as Float32Array<ArrayBuffer>, { bytesPerRow: 32 }, [2, 1]);
  }
  /**
   * The deck in the sky's environment (docs/known-bugs.md, 2026-11-13: the sky's reflection map and scene light showed
   * only the sky behind it): marched into the sky's 64 x 32 layout once the clouds have taken their own light from the
   * clear map, and handed to the sky as its `environmentLayer`, which the sky lays over its reflection map in this frame
   * (before Water reads it) and over the scene light in the next frame's lighting pass.
   */
  private environment(c: Context): void {
    const sky = this.options.sky;
    if (this.layered !== sky) this.unlayer();
    if (!sky || !('environmentLayer' in sky)) return;
    if (!this.deckGroup) {
      this.deckPipeline ??= c.device.createComputePipeline({
        layout: 'auto',
        compute: {
          module: c.device.createShaderModule({ code: withStorm(deckShader, this.built) }),
          entryPoint: 'main',
        },
      });
      this.deckGroup = c.device.createBindGroup({
        layout: this.deckPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniform! } },
          { binding: 1, resource: this.volumes!.shape.createView() },
          { binding: 2, resource: this.volumes!.erosion.createView() },
          { binding: 3, resource: this.volumes!.sampler },
          { binding: 4, resource: this.light!.createView() },
          { binding: 5, resource: this.deck!.createView() },
          { binding: 6, resource: this.deckLight!.createView() },
        ],
      });
    }
    const pass = c.encoder.beginComputePass();
    pass.setPipeline(this.deckPipeline!);
    pass.setBindGroup(0, this.deckGroup);
    pass.dispatchWorkgroups(8, 4);
    pass.end();
    sky.environmentLayer = this.deck;
    if ('environmentLightLayer' in sky) sky.environmentLightLayer = this.deckLight;
    this.layered = sky;
  }
  // Takes the deck back from the sky it was given to: nothing drawn, another sky, or released.
  // Hands the deck to the options' sky (Sky.deck), taking it back from a sky it was given to before.
  private hookDeck(): void {
    const sky = this.engine ? this.options.sky : undefined;
    if (this.decked === sky) return;
    this.unhookDeck();
    if (sky) sky.deck = this.deckOf;
    this.decked = sky;
  }
  private unhookDeck(): void {
    if (this.decked?.deck === this.deckOf) this.decked.deck = undefined;
    this.decked = undefined;
  }
  private unlayer(): void {
    if (this.layered && this.layered.environmentLayer === this.deck) this.layered.environmentLayer = undefined;
    if (this.layered && this.layered.environmentLightLayer === this.deckLight)
      this.layered.environmentLightLayer = undefined;
    this.layered = undefined;
  }
  private draw(c: Context): void {
    if (!this.uniform) return;
    // A storm's code loads on first use; until it has the layer draws nothing (`ready`).
    const field = stormFieldFor(this.options);
    if (wantsStorm(this.options) && !field) return;
    if (field !== this.built) {
      // The field arrived (or changed): the shaders are made again with it.
      this.lightPipeline = this.lightGroup = this.deckPipeline = this.deckGroup = this.lightSource = undefined;
      this.key = '';
      this.built = field;
    }
    this.hookDeck();
    if (!this.write(c)) {
      this.unlayer();
      return;
    }
    this.volumes!.fill(c.device, c.encoder);
    this.skyLight(c);
    this.environment(c);
    const depth = sceneDepth(c, this.options.depth, 'VolumetricClouds'),
      samples = c.descriptor.multisample?.count ?? 1,
      key = `${c.format}:${samples}:${depth?.samples ?? 0}:${c.descriptor.depthStencil?.format}`;
    if (this.key !== key) {
      const module = c.device.createShaderModule({
        code: withStorm(shader(depth ? depthWGSL(5, depth.samples) : ''), this.built),
      });
      this.pipeline = c.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: {
          module,
          entryPoint: 'fragment',
          targets: [
            {
              format: c.format,
              // Premultiplied: the cloud's light over what is behind it times its transmittance; the alpha stays.
              blend: {
                color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
              },
            },
          ],
        },
        multisample: c.descriptor.multisample,
        // Without a depth texture the clouds draw only where the scene left the sky (reversed-Z depth still 0).
        ...(depth
          ? {}
          : {
              depthStencil: {
                format: c.descriptor.depthStencil!.format,
                depthCompare: 'greater-equal' as const,
                depthWriteEnabled: false,
              },
            }),
      });
      this.key = key;
      this.bound = undefined;
    }
    if (this.bound !== (depth?.texture ?? this.light)) {
      this.bind = c.device.createBindGroup({
        layout: this.pipeline!.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniform } },
          { binding: 1, resource: this.volumes!.shape.createView() },
          { binding: 2, resource: this.volumes!.erosion.createView() },
          { binding: 3, resource: this.volumes!.sampler },
          { binding: 4, resource: this.light!.createView() },
          ...(depth ? [{ binding: 5, resource: depth.resource }] : []),
        ],
      });
      this.bound = depth?.texture ?? this.light;
    }
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }],
      ...(depth ? {} : { depthStencilAttachment: { view: c.depth, depthReadOnly: true, stencilReadOnly: true } }),
    });
    applyView(pass, c);
    pass.setPipeline(this.pipeline!);
    pass.setBindGroup(0, this.bind!);
    pass.draw(3);
    pass.end();
  }
  private release(): void {
    this.unlayer();
    this.unhookDeck();
    this.uniform?.destroy();
    this.volumes?.dispose();
    this.light?.destroy();
    this.deck?.destroy();
    this.deckLight?.destroy();
    this.uniform = this.volumes = this.light = this.deck = this.deckLight = undefined;
    this.pipeline = this.bind = this.lightPipeline = this.lightGroup = this.deckPipeline = this.deckGroup = undefined;
    this.bound = this.lightSource = undefined;
    this.key = '';
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
