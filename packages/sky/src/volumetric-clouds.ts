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
import { fireSkyWgsl, writeFireSpots, writeHazeFires } from './fire-spots.js';
import type { SkyFireSpot } from './base.js';
import {
  CLOUD_LAYER_NAME,
  isCloudLayerName,
  cloudDeckTransmittance,
  cloudLayerFor,
  type CloudLayer,
  type CloudType,
  type CloudWeather,
  type MutableCloudLayer,
} from './cloud-types.js';
import type { Hurricane, HurricaneOptions } from './hurricane.js';
import type { StormField } from './storm-field.js';
import type { ScudField } from './scud-field.js';
import type { RainShafts } from './rain-shafts.js';
export {
  CLOUD_LAYER_NAME,
  isCloudLayerName,
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
      /** The fires' light on the layer (`atmosphere.fireSpots`), in front of the clouds as of the dome. */
      readonly fireSpots?: readonly SkyFireSpot[];
      /** How far across a low ray takes the layer's fire light (`atmosphere.fireSight`, 0 or absent: no limit). */
      readonly fireSight?: number;
    };
    /**
     * The sky's fog (`Sky` `fog`): its fires' glow on the haze (`fireSpots`, to the path end 2 / `density`) is in front of
     * the layer's, by the layer's opacity along the ray, as the dome draws it (KB-SKY-HAZEGLOW1).
     */
    readonly fog?: { readonly density?: number; readonly fireSpots?: readonly SkyFireSpot[] };
  };
  /** The zenith sun on level ground in sky units (`Sky.zenithSun`), the unit of `atmosphere.scatteredLight`. */
  readonly zenithSun?: number;
  /** The factor the sky draws in besides its exposure (`Sky.pictureScale`: sky units into the engine's). Default 1. */
  readonly pictureScale?: number;
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
  /**
   * The layer's plugin name, fixed for its lifetime. Each layer on one engine needs its own: a second layer under the
   * same name is refused by the engine. `Weather` (its lightning flash) and `WeatherDrive` (`@margoengine/weather`) find
   * every layer whose name is `'sky:volumetric-clouds'` or starts with `'sky:volumetric-clouds:'`, so keep that prefix
   * for a layer they should reach. Fixed text rather than a counter, so a world built again (a seek, a second shot) names
   * its layers the same. Default `'sky:volumetric-clouds'`.
   */
  name?: string;
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
   * `bottom`, `top` and `density` (and the stratus cover of the weather's `cloud`, 0.5 without a weather). `'scud'` is
   * fractus under a rain deck: ragged low shreds with no flat base, torn along the wind, cover 0.35 times the weather's
   * `rain` (none when dry), 300 to 500 m (with `above`, 0.4 of the deck's base and 200 m thick), and its own defaults
   * `scale` 2,200, `erosion` 1.8, `evolution` 10, `steps` 24, `lightSteps` 2, `shear` 1.5 times its thickness and
   * `name` `'sky:volumetric-clouds:scud'`; its shape loads by `import()` on first use (`ready`). Default unset: the
   * weather picks the type.
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
  /**
   * Lit ground under the deck that lights its base from below: a city, a town, a lit yard (at most eight). Each is a
   * disc of ground of `radius` metres round `x`, `z` that sends up `color`, the radiance of the lit ground seen from
   * above (linear RGB, the clouds' units). A cloud at height H above the disc's centre takes its light as a
   * Lambertian disc lights a plane over it (cosine at both ends over the distance squared): the base over the centre
   * receives `color` times rho^2 / (H^2 + rho^2), falling as ((H^2 + rho^2) / (H^2 + rho^2 + r^2))^2 with the distance r
   * across, which keeps the disc's whole flux (pi rho^2 times pi `color`) on the base. The light then spreads through the
   * cloud by the deck's two-stream, so a low overcast deck glows over the lights, brightest over the city and toward its
   * horizon, with the thin parts and gaps darker, as clouds amplify urban skyglow (C. C. M. Kyba, T. Ruhtz, J. Fischer
   * and F. Holker, "Cloud Coverage Acts as an Amplifier for Ecological Light Pollution in Urban Ecosystems", PLoS ONE 6,
   * e17307, 2011: overcast nights 10 times brighter than clear ones in Berlin). The light the base sends back down is
   * reflected up again by the ground (`groundAlbedo`), the series 1 / (1 - albedo x deck reflectance) (M. Kocifaj,
   * "Light-pollution model for cloudy and cloudless night skies with ground-based light sources", Applied Optics 46,
   * 3013, 2007; A. Jechow and F. Holker, "Snowglow", J. Imaging 5, 69, 2019: snow and cloud together raise it most).
   * Read every frame; default none, at no cost.
   */
  groundLights?: readonly CloudGroundLight[];
  /**
   * Rain, mist or haze in the air between the ground and the deck, over the sky the clouds draw (scene surfaces keep
   * their own fog): `visibility` metres, the distance at which it leaves 2 percent of what is behind it (Koschmieder
   * 1924: extinction 3.912 / visibility). The air takes the light round it: the ground's below it (the sky light's lower
   * half and the `groundLights` along the ray's ground track, as far as two extinction lengths, as the sky's fog takes its
   * fire spots) and the deck's above it, so the low sky toward a lit city glows and the deck dims into it toward the
   * horizon. Only while the camera is under the deck. Read every frame; default none.
   */
  mist?: CloudMist;
  /**
   * The layer over this one, for a second layer under a deck (low scud under a rain deck): this layer's tops must be at
   * or below its base (RangeError). The link is closed form, with no second march: the sun, moon and sky light reach
   * this layer through the upper deck (`cloudDeckTransmittance` of its layer at each light's height, the sky's at the
   * two-stream's mean slant), the upper base sends back down its reflectance of the ground lights' light at its height,
   * and the upper deck takes the ground lights through this layer's mean transmittance. So scud is dark against a
   * lighter base by day (WMO pannus) and takes the lamps more strongly near them by night. The sky's `deck` becomes the
   * product of both, the sky's environment map shows this layer over the upper's (or under it, from a camera above this
   * layer's tops), and each layer draws the air band from its base down to the next layer's top (the lowest one to the
   * ground) with its own cloud at its depth, in the camera's order: under this layer's tops the upper draws first. A
   * layer without its own `mist` takes the upper's. With `type: 'scud'` the base defaults to 0.4 of the upper's
   * (150 to 450 m) and the tops 200 m over it. Default none.
   */
  above?: VolumetricClouds;
  /**
   * Metres the tops lead the base along the wind (the shapes lean downwind with height, as wind shear tilts real
   * cloud), -20,000 to 20,000. Live. Default 0, or 1.5 times the layer's thickness for `type: 'scud'`.
   */
  shear?: number;
  /**
   * Rain shafts hanging from the base (`{cells, steps?, streaks?}`, at most 8 cells): each cell an exponential mound of
   * rain rate at the base, moving with its `velocity`, its water trailing downwind as it falls (the trail of
   * `PrecipitationField` in `@margoengine/weather`), drawn as a medium in the air under the base that dims what is behind
   * it by Marshall and Palmer's extinction (3.647e-4 R^0.63 per metre) and takes the light round it, the ground lights'
   * at its own place included. Over the sky and over scene surfaces alike. A layer under this one (`above`) draws the
   * rain in its own air band. Its code loads by `import()` on first use (`ready`). Read every frame; default none.
   */
  rain?: CloudRain;
}
/** {@link VolumetricCloudOptions.rain}: rain shafts under the base. */
export interface CloudRain {
  /** The rain cells, at most 8. */
  cells: readonly CloudRainCell[];
  /** Samples along each view ray through the air band, an integer 4 to 128. Default 16. */
  steps?: number;
  /** How much a streak noise carried down the fall line breaks the shafts into curtains, 0 (even) to 1. Default 0.6. */
  streaks?: number;
}
/** {@link CloudRain.cells}: one rain cell, as `RainCell` of `@margoengine/weather` with its centre split in two. */
export interface CloudRainCell {
  /** World x of the centre at the layer's time 0, metres. */
  x: number;
  /** World z of the centre at the layer's time 0, metres (north is -z). */
  z: number;
  /** Metres over which the rate at the base falls by a factor e, 1 to 1,000,000. */
  radius: number;
  /** Rate at the centre, mm/h of liquid water, 0 to 300. */
  rate: number;
  /** How the centre moves over the ground, [x, z] m/s. Default still. */
  velocity?: readonly [number, number];
  /** The lowest height the rain reaches, metres (virga stops above the ground), 0 to 20,000. Default 0. */
  reach?: number;
}
/** {@link VolumetricCloudOptions.groundLights}: one disc of lit ground that lights the cloud base from below. */
export interface CloudGroundLight {
  /** Radiance of the lit ground seen from above, linear RGB 0 to 10,000 in the clouds' units (the sky's when it has one). */
  color: Vec3;
  /** World x of the disc's centre, metres. */
  x: number;
  /** World z of the disc's centre, metres (north is -z). */
  z: number;
  /** Radius of the lit ground, 1 to 1,000,000 metres. Default 1000. */
  radius?: number;
}
/** {@link VolumetricCloudOptions.mist}: the air between the ground and the deck. */
export interface CloudMist {
  /** Distance at which the air leaves 2 percent of what is behind it, 10 to 1,000,000 metres. */
  visibility: number;
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
// What `type: 'scud'` changes of the defaults: fine shapes (fractus shreds are tens to hundreds of metres across), more
// erosion at every height, fast change, and fewer samples through a thin layer.
const scudDefaults = { scale: 2200, erosion: 1.8, evolution: 10, steps: 24, lightSteps: 2 } as const;
type TypedSetting = keyof typeof scudDefaults;
/** The option `key` as set, else the default of the layer's type. */
const setting = (o: VolumetricCloudOptions, key: TypedSetting): number =>
  o[key] ?? (o.type === 'scud' ? scudDefaults[key] : key === 'erosion' ? 1 : defaults[key]);
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
struct Clouds {inverse:mat4x4f,eye:vec4f,sun:vec4f,sunColor:vec4f,layer:vec4f,shape:vec4f,wind:vec4f,flags:vec4f,moon:vec4f,moonColor:vec4f,flash:vec4f,flashColor:vec4f,look:vec4f,storm:array<vec4f,8>,veil:vec4f,glow:vec4f,fires:array<vec4f,16>,hazeFires:array<vec4f,16>,ground:array<vec4f,16>,mist:vec4f,lift:vec4f,link:vec4f,linkGlow:vec4f,rain:array<vec4f,3>,rainCells:array<vec4f,16>}
fn cloudRemap(x:f32,a:f32,b:f32)->f32 {return (x-a)/max(b-a,0.00001);}
fn cloudAltitude(c:Clouds,p:vec3f)->f32 {let R=c.eye.w;return (dot(p,p)+2.0*R*p.y)/(length(vec3f(p.x,p.y+R,p.z))+R);}
fn cloudBase(s:vec4f)->f32 {let low=s.g*0.625+s.b*0.25+s.a*0.125;return clamp((clamp(cloudRemap(s.r,low-1.0,1.0),0.0,1.0)-0.67)/0.21,0.0,1.0);}
//[storm-fns]
//[scud-fns]
fn cloudDensityAt(c:Clouds,shape:texture_3d<f32>,detail:texture_3d<f32>,smp:sampler,p:vec3f,erode:bool)->f32 {
 let h=(cloudAltitude(c,p)-c.layer.x)/(c.layer.y-c.layer.x);if(h<=0.0||h>=1.0){return 0.0;}
//[storm-branch]
//[scud-branch]
 let lean=vec3f(c.lift.x,0.0,c.lift.y)*h;
 let q=(p+vec3f(c.wind.x,c.wind.z,c.wind.y)+lean)*c.shape.x;
 let s=textureSampleLevel(shape,smp,q.xzy,0.0);
 let weather=textureSampleLevel(shape,smp,vec3f((p.xz+c.flags.zw+lean.xz)*c.shape.x*${WEATHER},0.37),0.0).g;
 let cover=clamp(c.layer.z*(1.0+2.5*(weather-0.48)),0.0,1.0);
 let low=s.g*0.625+s.b*0.25+s.a*0.125;
 let base=clamp((clamp(cloudRemap(s.r,low-1.0,1.0),0.0,1.0)-0.67)/0.21,0.0,1.0);
 let profile=smoothstep(0.0,0.12,h)*smoothstep(1.0,0.45,h);
 let cloud=clamp(cloudRemap(base*profile,1.0-cover,1.0),0.0,1.0)*cover;
 if(cloud<=0.0||!erode){return cloud;}
 let e=textureSampleLevel(detail,smp,((p+vec3f(c.wind.x,c.wind.z*2.0,c.wind.y)*1.5+lean)*c.shape.y).xzy,0.0).rgb;
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
fn cloudGround(p:vec2f,h:f32)->vec3f {
 var light=vec3f(0);let h2=h*h;
 for(var i=0u;i<8u;i++){
  let spot=clouds.ground[2u*i];if(spot.w<=0.0){break;}let r=p-clouds.ground[2u*i+1u].xz;let R2=h2+spot.w;let f=R2/(R2+dot(r,r));
  light+=spot.rgb*(spot.w/R2)*f*f;
 }
 return light;
}
fn cloudGroundSpan(u:f32,a2:f32)->f32 {let a=sqrt(a2);return u/(a2+u*u)+atan(u/a)/a;}
fn cloudGroundTrack(start:vec2f,end:vec2f,h:f32)->vec3f {
 let path=end-start;let span=length(path);if(span<1.0){return cloudGround((start+end)*0.5,h);}
 var light=vec3f(0);let h2=h*h;let along=path/span;
 for(var i=0u;i<8u;i++){
  let spot=clouds.ground[2u*i];if(spot.w<=0.0){break;}let to=clouds.ground[2u*i+1u].xz-start;let R2=h2+spot.w;
  let s0=dot(to,along);let a2=R2+max(dot(to,to)-s0*s0,0.0);
  let mean=R2*R2/(2.0*a2)*(cloudGroundSpan(span-s0,a2)+cloudGroundSpan(s0,a2))/span;
  light+=spot.rgb*(spot.w/R2)*clamp(mean,0.0,1.0);
 }
 return light;
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
 var above=textureLoad(skyLight,vec2i(0,0),0).rgb;let below=textureLoad(skyLight,vec2i(1,0),0).rgb+clouds.look.w*above;
 above*=clouds.link.z;
 let m=clouds.moon.xyz;let nuMoon=dot(d,m);let moonLit=clouds.moon.w>0.0&&max(clouds.moonColor.r,max(clouds.moonColor.g,clouds.moonColor.b))>0.0;
 let lightN=u32(clouds.wind.w);let columnN=max(1u,(lightN+1u)/2u);let eyeHeight=max(cloudAltitude(clouds,clouds.eye.xyz),0.0);
 // The ground lit by the sun under the deck, as cloud-sun units (E / pi = 4k): look.w is the albedo times the deck's share.
 let sunW=clouds.sun.w*clouds.link.x;let moonW=clouds.moon.w*clouds.link.y;
 let ground=clouds.sunColor.rgb*sunW*4.0*clouds.look.w*max(s.y,0.0);
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
    sun=clouds.sunColor.rgb*sunW*cloudScatter(a,below0/slant,nu)+cloudSkyScatter(vec3f(0),ground,aUp,below0,nuUp);
   }
   var moon=vec3f(0);
   if(moonLit){
    let od=cloudLightDepth(clouds,shapeNoise,erosionNoise,noiseSampler,p,m,lightN);let slant=max(m.y,0.25);
    if(aUp<0.0){aUp=od*slant;}
    moon=clouds.moonColor.rgb*moonW*0.15*(cloudScatter(od,below0/slant,nuMoon)+0.5*(cloudHG(nuMoon,glow)-cloudPhaseK(nuMoon,1.0))*exp(-0.15*od));
   }
   if(aUp<0.0){aUp=cloudColumn(p,up,max(top-altitude,0.0),columnN);}
   var top=above;if(clouds.linkGlow.y>0.0){top+=clouds.linkGlow.y*cloudGround(p.xz,clouds.linkGlow.x);}
   let sky=cloudSkyScatter(top,below+cloudGround(p.xz,bottom),aUp,below0,nuUp);
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
// cloud's opacity in front (KB-SKY-PALLCLOUD1), and the fires' light on the layer toward the ray (fireLayer, the sky's
// atmosphere.fireSpots) with it, as the dome draws it at every hour (KB-SKY-FIREDAY1), seen through the haze under the
// layer with the haze's own glow in front (fireSky, the sky's fog.fireSpots, KB-SKY-HAZEGLOW1). 1 and 0 leave the cloud
// as it is.
${fireSkyWgsl('clouds')}fn cloudVeiled(light:vec3f,opacity:f32,d:vec3f)->vec3f {
 let t=pow(max(clouds.veil.rgb,vec3f(1e-30)),vec3f(1.0/max(d.y/max(length(d),1e-6),0.052336)));
 return light*t*clouds.veil.w+opacity*(clouds.glow.rgb+fireSky(d,t));
}
fn cloudMistBand(d:vec3f)->vec4f {
 let e=clouds.eye.xyz;let k=clouds.mist.x;let floor=clouds.lift.w;let base=clouds.layer.x;let altitude=cloudAltitude(clouds,e);
 if(altitude>=base){return vec4f(0,0,0,1);}
 let up=dot(d,normalize(vec3f(e.x,e.y+clouds.eye.w,e.z)))>0.0;var start=0.0;var end=0.0;
 if(altitude<floor){if(!up){return vec4f(0,0,0,1);}start=cloudShell(d,floor).y;end=cloudShell(d,base).y;}
 else {let low=cloudShell(d,floor);end=select(cloudShell(d,base).y,low.x,low.x>0.0);}
 end=min(end,start+clouds.shape.z);let s=max(end-start,0.0);let t=exp(-k*s);
 let above=textureLoad(skyLight,vec2i(0,0),0).rgb*clouds.link.z;
 let foot=e.xz+d.xz*start;
 let below=textureLoad(skyLight,vec2i(1,0),0).rgb+clouds.look.w*above+cloudGroundTrack(foot,foot+d.xz*min(s,2.0/k),clouds.mist.w);
 return vec4f(0.5*((1.0+clouds.mist.y)*below+clouds.mist.z*above)*(1.0-t),t);
}
fn cloudMist(d:vec3f)->vec4f {
 let e=clouds.eye.xyz;let k=clouds.mist.x;
 if(k>0.0&&clouds.lift.w>0.0){return cloudMistBand(d);}
 if(k<=0.0||cloudAltitude(clouds,e)>=clouds.layer.x){return vec4f(0,0,0,1);}
 let up=normalize(vec3f(e.x,e.y+clouds.eye.w,e.z));
 let s=select(clouds.shape.z,min(clouds.shape.z,cloudShell(d,clouds.layer.x).y),dot(d,up)>0.0);let t=exp(-k*s);
 let above=textureLoad(skyLight,vec2i(0,0),0).rgb;
 let below=textureLoad(skyLight,vec2i(1,0),0).rgb+clouds.look.w*above+cloudGroundTrack(e.xz,e.xz+d.xz*min(s,2.0/k),clouds.mist.w);
 return vec4f(0.5*((1.0+clouds.mist.y)*below+clouds.mist.z*above)*(1.0-t),t);
}
`;
// The clouds over the sky, with the mist under the deck (`mist`, cloudMist) in front of them over the sky's pixels: the
// air's transmittance t to the base along the ray, flat Beer-Lambert, and its light, isotropic single scattering of the
// mean radiance round it, the ground's below (the sky light's lower half plus the ground lights along the ray's ground
// track to two extinction lengths, cloudGroundTrack) and the deck's above (its reflectance mist.y of that, plus its
// transmittance mist.z of the light above it), times 1 - t. Behind it the cloud's light and the backdrop both take t.
const shader = (depthBinding: string) => /* wgsl */ `${fullscreen}${march}${displayShader}
${depthBinding}
//[rain-fns]
@fragment fn fragment(i:Vertex)->@location(0) vec4f {
 let ndc=vec2f(i.uv.x*2.0-1.0,1.0-i.uv.y*2.0);let far=clouds.inverse*vec4f(ndc,0.000001,1);
 let d=normalize(far.xyz/far.w-clouds.eye.xyz)*select(-1.0,1.0,far.w>=0.0);
 let span=cloudSpan(d);var end=span.y;var open=true;var sceneFar=clouds.shape.z*4.0;
 ${depthBinding ? `let z=sceneDepthAt(vec2i(i.position.xy));if(z>0.0){open=false;let w=clouds.inverse*vec4f(ndc,z,1);sceneFar=length(w.xyz/w.w-clouds.eye.xyz);end=min(end,sceneFar);}` : ''}
 var light=vec3f(0);var opacity=0.0;
 if(end>span.x){
  let m=cloudMarch(d,span.x,end,u32(clouds.shape.w),fract(cloudHash3(vec3u(vec2u(i.position.xy),7u)).x+clouds.flags.y),0.95);
  if(m.opacity>0.0){light=cloudVeiled(m.light,m.opacity,d);opacity=m.opacity;}
 }
//[rain-call]
 if(open&&clouds.mist.x>0.0){let air=cloudMist(d);light=air.rgb+air.a*light;opacity=1.0-air.a*(1.0-opacity);}
 if(opacity<=0.0){discard;}
 var color=light*clouds.sunColor.w;
 if(clouds.flags.x>0.5){color=toDisplay(color/opacity)*opacity;}
 return vec4f(color,opacity);
}
`;
// The deck as the sky's environment sees it (Sky.environmentLayer): each texel of the sky's 64 x 32 map, in its
// equirectangular layout (environmentDirection in environment.ts), holds the clouds' light at the sky's exposure,
// premultiplied, and their opacity: the mean of four rays across the texel at stratified starts, 32 steps each. The
// second map (Sky.environmentLightLayer) is the same deck as the scene's light takes it: its sky light, its bounce of
// the sky off the ground and its flash, and its sun and moon light only as `look.y` and `look.z` say (0 under
// dimLight, whose engine lights already carry them; else matched to the engine lights' units).
const deckShader = (linked: boolean) => /* wgsl */ `${march}
@group(0) @binding(5) var deck:texture_storage_2d<rgba16float,write>;
@group(0) @binding(6) var deckLight:texture_storage_2d<rgba16float,write>;
${linked ? '@group(0) @binding(7) var upperDeck:texture_2d<f32>;\n@group(0) @binding(8) var upperDeckLight:texture_2d<f32>;' : ''}
fn deckOver(own:vec4f,other:vec4f)->vec4f {
 if(clouds.link.w<0.5){return own;}
 if(clouds.link.w<1.5){return own+other*(1.0-own.a);}
 return other+own*(1.0-other.a);
}
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
 var view=vec4f(cloudVeiled(light,opacity,dir)*k,opacity*0.25);var lit=vec4f(cloudVeiled(scene,opacity,dir)*k,opacity*0.25);
 ${linked ? 'view=deckOver(view,textureLoad(upperDeck,vec2i(id.xy),0));lit=deckOver(lit,textureLoad(upperDeckLight,vec2i(id.xy),0));' : ''}
 textureStore(deck,vec2i(id.xy),view);
 textureStore(deckLight,vec2i(id.xy),lit);
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
  writeScratch: MutableCloudLayer = { coverage: 0, bottom: 0, top: 0, density: 0 },
  aboveLayer: MutableCloudLayer = { coverage: 0, bottom: 0, top: 0, density: 0 },
  rainLayer: MutableCloudLayer = { coverage: 0, bottom: 0, top: 0, density: 0 },
  linkLayer: MutableCloudLayer = { coverage: 0, bottom: 0, top: 0, density: 0 };
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
  const upper = options.above?.options;
  if (type === 'scud' && upper && options.bottom === undefined) {
    // Fractus forms in the moist air under the rain deck, well below its base (WMO pannus; AMS Glossary, "scud").
    const deck = layerOf(upper, upper.above ? undefined : aboveLayer);
    out.bottom = Math.min(450, Math.max(150, 0.4 * deck.bottom));
    if (options.top === undefined) out.top = out.bottom + 200;
  }
  return out;
}
/**
 * Writes the sky's low haze layer into the `Clouds` uniform (floats 96 to 231): its transmittance straight up
 * (`atmosphere.layerTransmittance`) and the sky's `sunIntensity`, then the layer's glow (`atmosphere.scatteredLight`
 * times `sunIntensity` times the zenith sun over pi, in sky units, as `@margoengine/sky/look` writes it for the dome),
 * then the fires' spots on it (`atmosphere.fireSpots` in the same units, `fireSight` in the first spot's spare float),
 * then the haze's (`fog.fireSpots` over 2 to the exposure times `pictureScale`, the path end 2 / density in the first
 * spot's spare float).
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
  writeFireSpots(v, 104, a?.fireSpots, unit);
  v[111] = a?.fireSight ?? 0;
  // The haze's spots (the sky's fog.fireSpots), from the fog's units into the sky's, as the dome writes them.
  writeHazeFires(v, 168, sky?.options.fog, 2 ** (sky?.options.exposure ?? 0) * (sky?.pictureScale ?? 1));
}
// The deck's diffuse reflectance for light from below: 1 less its transmittance at the two-stream's mean slant (the
// diffusivity factor 1.66, Elsasser 1942; cos 0.6), the deck taken as conservative scatterers.
const deckReflectance = (layer: CloudLayer): number => 1 - cloudDeckTransmittance(layer, 0.6);
/**
 * The ground-to-deck series: light the base sends back down is reflected up again by the ground of `albedo`, and so on,
 * 1 / (1 - albedo x reflectance) of the first pass (Kocifaj 2007; Jechow and Holker 2019).
 */
const groundGain = (options: VolumetricCloudOptions, layer: CloudLayer): number =>
  1 / (1 - (options.groundAlbedo ?? defaults.groundAlbedo) * deckReflectance(layer));
/**
 * Writes the ground lights (`groundLights`, floats 232 to 295: colour times the ground-to-deck series and radius
 * squared, then x, 0 and z) and the mist (`mist`, floats 296 to 299: extinction 3.912 / visibility per metre, the
 * deck's reflectance and transmittance for light from below, and the height the mist takes the ground lights at, a
 * quarter of the base). Without them all zero.
 */
export function writeGround(
  v: Float32Array,
  options: VolumetricCloudOptions,
  layer: CloudLayer = layerOf(options),
): void {
  v.fill(0, 232, 300);
  const lights = options.groundLights,
    gain = lights?.length ? groundGain(options, layer) : 0;
  lights?.forEach((g, i) => {
    const o = 232 + 8 * i;
    for (let k = 0; k < 3; k++) v[o + k] = g.color[k]! * gain;
    v[o + 3] = (g.radius ?? 1000) ** 2;
    v[o + 4] = g.x;
    v[o + 6] = g.z;
  });
  const mist = options.mist ?? options.above?.options.mist;
  if (mist) {
    const r = deckReflectance(layer);
    v[296] = 3.912 / mist.visibility;
    v[297] = r;
    v[298] = 1 - r;
    v[299] = 0.25 * layer.bottom;
  }
}
/**
 * The light the `groundLights` send up into the cloud base over world `x`, `z` (linear RGB, the clouds' units, as
 * radiance from below): each disc's Lambertian law on the base at its height, times the ground-to-deck series. The CPU
 * twin of the march's `cloudGround`; `out`, when given, receives it.
 * @example cloudGroundLight({ bottom: 800, groundLights: [{ color: [1, 0.6, 0.3], x: 0, z: 0, radius: 3000 }] }, 0, 0);
 */
export function cloudGroundLight(
  options: VolumetricCloudOptions,
  x: number,
  z: number,
  out: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  out[0] = out[1] = out[2] = 0;
  const lights = options.groundLights;
  if (!lights?.length) return out;
  const layer = layerOf(options),
    gain = groundGain(options, layer),
    h2 = layer.bottom ** 2;
  for (const g of lights) {
    const rho2 = (g.radius ?? 1000) ** 2,
      R2 = h2 + rho2,
      f = R2 / (R2 + (x - g.x) ** 2 + (z - g.z) ** 2),
      k = (rho2 / R2) * f * f * gain;
    for (let i = 0; i < 3; i++) out[i] += g.color[i]! * k;
  }
  return out;
}
/** Floats in the `Clouds` uniform ({@link cloudField}): the buffers of the clouds, their shadows and shafts hold this many. */
export const CLOUD_FLOATS = 388;

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
let loadedScud: ScudField | undefined, scudLoading: Promise<ScudField> | undefined, scudError: unknown;
/**
 * Loads the scud shape's WGSL (`type: 'scud'`; about 0.6 kB, kept out of other clouds). `VolumetricClouds` starts it
 * itself for a scud layer; its `ready` resolves once it is in.
 */
export function loadScudField(): Promise<ScudField> {
  return (scudLoading ??= import('./scud-field.js').then((m) => (loadedScud = m.scudField(WEATHER))));
}
/** The scud field once loaded, else undefined (starting the load when `options` are a scud layer's). */
export function scudFieldFor(options: VolumetricCloudOptions): ScudField | undefined {
  if (scudError !== undefined) throw scudError;
  if (!loadedScud && options.type === 'scud')
    loadScudField().catch((e: unknown) => (scudError = e ?? new Error('scud field failed to load')));
  return loadedScud;
}
/**
 * The cloud field's WGSL (or any shader holding it) with the storm's functions when `field` is given, and the scud
 * shape's when `scud` is.
 */
export const withStorm = (code: string, field?: StormField, scud?: ScudField, rain?: RainShafts): string => {
  const stormed = field ? code.replace('//[storm-fns]', field.fns).replace('//[storm-branch]', field.branch) : code,
    scudded = scud ? stormed.replace('//[scud-fns]', scud.fns).replace('//[scud-branch]', scud.branch) : stormed;
  return rain ? scudded.replace('//[rain-fns]', rain.fns).replace('//[rain-call]', rain.call) : scudded;
};
let loadedRain: RainShafts | undefined, rainLoading: Promise<RainShafts> | undefined, rainError: unknown;
/** Whether the options draw rain shafts: rain cells of their own or of the layer `above` them. */
export const wantsRain = (options: VolumetricCloudOptions): boolean =>
  (options.rain?.cells.length ?? 0) > 0 || (options.above?.options.rain?.cells.length ?? 0) > 0;
/** Loads the rain shafts' WGSL (`rain`; kept out of clouds without rain). `ready` resolves once it is in. */
export function loadRainShafts(): Promise<RainShafts> {
  return (rainLoading ??= import('./rain-shafts.js').then((m) => (loadedRain = m.rainShafts())));
}
/** The rain shafts once loaded, else undefined (starting the load when the options draw rain). */
export function rainShaftsFor(options: VolumetricCloudOptions): RainShafts | undefined {
  if (rainError !== undefined) throw rainError;
  if (!loadedRain && wantsRain(options))
    loadRainShafts().catch((e: unknown) => (rainError = e ?? new Error('rain shafts failed to load')));
  return loadedRain;
}
/** Extinction of rain of `rate` mm/h, per metre: Marshall and Palmer's drops at extinction efficiency 2, 3.647e-4 R^0.63. */
export const rainExtinction = (rate: number): number => 3.647e-4 * Math.max(rate, 0) ** 0.63;
/**
 * The fall speed, m/s, that carries the rain of `options.rain` down from the base: that of the median drop of its
 * strongest cell (Marshall and Palmer 1948, D0 = (3.67 / 4.1) R^0.21 mm; Atlas, Srivastava and Sekhon 1973, v = 9.65 -
 * 10.3 e^(-0.6 D); as `rainFall` of `@margoengine/sky/weather`). 9 m/s without cells.
 */
export function cloudRainFall(options: VolumetricCloudOptions): number {
  let peak = 0;
  for (const c of options.rain?.cells ?? []) peak = Math.max(peak, c.rate);
  return peak > 0 ? Math.max(0.1, 9.65 - 10.3 * Math.exp(-0.6 * (3.67 / 4.1) * Math.max(peak, 0.01) ** 0.21)) : 9;
}
/**
 * The CPU twin of the rain shafts: the rain rate, mm/h, at world (x, y, z) (y the height over the ground) at `seconds`
 * on the layer's clock under the layer `options` with `rain`: each cell's mound at the base, read where the water now
 * at height y left it, (base - y) / fall seconds ago and (wind - cell velocity) times that upwind, nothing under the
 * cell's `reach` or at and over the base. The shader draws the same rate.
 * @example cloudRainRate({ bottom: 650, top: 1300, wind: [0, 0], rain: { cells: [{ x: 0, z: 0, radius: 800, rate: 20 }] } }, 0, 0, 0); // 20
 */
export function cloudRainRate(options: VolumetricCloudOptions, x: number, y: number, z: number, seconds = 0): number {
  const cells = options.rain?.cells;
  if (!cells?.length) return 0;
  const base = layerOf(options, rainLayer).bottom;
  if (y >= base) return 0;
  const tau = (base - Math.max(y, 0)) / cloudRainFall(options),
    wind = options.wind ?? [10, 3];
  let rate = 0;
  for (const c of cells) {
    if (y < (c.reach ?? 0)) continue;
    const v = c.velocity ?? [0, 0],
      dx = x - (c.x + v[0] * seconds) - (wind[0] - v[0]) * tau,
      dz = z - (c.z + v[1] * seconds) - (wind[1] - v[1]) * tau;
    rate += c.rate * Math.exp(-Math.hypot(dx, dz) / c.radius);
  }
  return rate;
}
/** The rate, mm/h, of the rain cells of `options` at the base over world (x, z) at `seconds`: no trail, no reach. */
export function cloudRainBase(options: VolumetricCloudOptions, x: number, z: number, seconds = 0): number {
  let rate = 0;
  for (const c of options.rain?.cells ?? []) {
    const v = c.velocity ?? [0, 0];
    rate += c.rate * Math.exp(-Math.hypot(x - (c.x + v[0] * seconds), z - (c.z + v[1] * seconds)) / c.radius);
  }
  return rate;
}
/** Writes the rain of `options` (the layer that holds the cells) into `v` from 312: the band `low` to `high`. */
function writeRain(
  v: Float32Array,
  options: VolumetricCloudOptions,
  seconds: number,
  low: number,
  high: number,
  own: boolean,
): void {
  const rain = options.rain!,
    deck = layerOf(options, rainLayer),
    wind = options.wind ?? [10, 3];
  v[312] = rain.cells.length;
  v[313] = rain.steps ?? 16;
  v[314] = deck.bottom;
  v[315] = cloudRainFall(options);
  v[316] = wind[0];
  v[317] = wind[1];
  v[318] = low;
  v[319] = high;
  v[320] = rain.streaks ?? 0.6;
  v[321] = deckReflectance(deck);
  // The sun and moon through the deck onto the drops; a layer under the deck has them in its link already.
  v[322] = own ? cloudDeckTransmittance(deck, Math.max(v[21], 0.1)) : 1;
  v[323] = own ? cloudDeckTransmittance(deck, Math.max(v[45], 0.1)) : 1;
  rain.cells.forEach((c, i) => {
    const o = 324 + 8 * i,
      vel = c.velocity ?? [0, 0];
    v[o] = c.x + vel[0] * seconds;
    v[o + 1] = c.z + vel[1] * seconds;
    v[o + 2] = c.radius;
    v[o + 3] = c.rate;
    v[o + 4] = vel[0];
    v[o + 5] = vel[1];
    v[o + 6] = c.reach ?? 0;
  });
}
/** Height of a world point over the planet's surface, metres (the field's `cloudAltitude`, in double precision). */
const cameraAltitude = (p: ArrayLike<number>): number =>
  (p[0] * p[0] + p[1] * p[1] + p[2] * p[2] + 2 * PLANET_RADIUS * p[1]) /
  (Math.hypot(p[0], p[1] + PLANET_RADIUS, p[2]) + PLANET_RADIUS);
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
  const scale = setting(options, 'scale'),
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
  v[60] = setting(options, 'erosion');
  if (loadedStorm) loadedStorm.write(v, options, seconds, scale);
  else v.fill(0, 64, 96);
  // The lean along the wind (`shear`, metres over the layer's height) and the scud shape's branch.
  const wind = options.wind ?? [10, 3],
    speed = Math.hypot(wind[0], wind[1]),
    shear = options.shear ?? (options.type === 'scud' ? 1.5 * (layer.top - layer.bottom) : 0);
  v[300] = speed > 0 ? (wind[0] / speed) * shear : 0;
  v[301] = speed > 0 ? (wind[1] / speed) * shear : 0;
  v[302] = options.type === 'scud' ? 1 : 0;
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
  /** The plugin's name and its frame-graph pass's, from the `name` option (fixed at construction). */
  readonly name: string;
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
  // The storm field the pipelines were built with (undefined: without one), and the scud shape likewise.
  private built: StormField | undefined;
  private builtScud: ScudField | undefined;
  private builtRain: RainShafts | undefined;
  // Whether the environment map was marched this frame (the layer under this one lays its map over it).
  private mapped = false;
  // The upper deck's maps the linked deck pipeline's bind group reads (rebuilt when they change).
  private deckOver?: GPUTexture;
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
    const own = cloudDeckTransmittance(layer, up),
      upper = this.upper();
    return upper ? own * upper.deckOf(up) : own;
  };
  /**
   * Metres the shapes have moved along X and Z with the wind and risen through themselves, each wrapped at the shapes'
   * repeat (`scale`); then the wind's X and Z drift again, wrapped at the coverage map's repeat (`scale` / 0.17).
   */
  readonly drift = new Float64Array(5);
  constructor(readonly options: VolumetricCloudOptions = {}) {
    this.validate();
    const name = options.name ?? (options.type === 'scud' ? `${CLOUD_LAYER_NAME}:scud` : CLOUD_LAYER_NAME);
    if (typeof name !== 'string' || name.length === 0 || name.length > 200)
      throw new TypeError('VolumetricClouds name must be a non-empty string of at most 200 characters');
    this.name = name;
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
    if (o.groundLights !== undefined) {
      const lights = o.groundLights as readonly CloudGroundLight[];
      if (!Array.isArray(lights) || lights.length > 8)
        throw new RangeError(
          'Invalid VolumetricClouds groundLights; use a list of at most 8 lights {color, x, z, radius}',
        );
      for (const g of lights)
        if (
          typeof g !== 'object' ||
          g === null ||
          !Array.isArray(g.color) ||
          g.color.length !== 3 ||
          !g.color.every((c: number) => inRange(c, 0, 10000)) ||
          !inRange(g.x, -1e7, 1e7) ||
          !inRange(g.z, -1e7, 1e7) ||
          !inRange(g.radius ?? 1000, 1, 1e6)
        )
          throw new RangeError(
            'Invalid VolumetricClouds groundLights; each light is {color: three numbers 0 to 10000, x and z within 1e7, radius 1 to 1e6}',
          );
    }
    if (o.mist !== undefined && (typeof o.mist !== 'object' || o.mist === null || !inRange(o.mist.visibility, 10, 1e6)))
      throw new RangeError('Invalid VolumetricClouds mist; give {visibility: 10 to 1000000 metres}');
    if (o.rain !== undefined) {
      const r = o.rain,
        cells = typeof r === 'object' && r !== null ? r.cells : undefined,
        bad =
          !Array.isArray(cells) ||
          cells.length > 8 ||
          !Number.isInteger(r.steps ?? 16) ||
          !inRange(r.steps ?? 16, 4, 128) ||
          !inRange(r.streaks ?? 0.6, 0, 1) ||
          cells.some(
            (c: CloudRainCell) =>
              typeof c !== 'object' ||
              c === null ||
              !inRange(c.x, -1e7, 1e7) ||
              !inRange(c.z, -1e7, 1e7) ||
              !inRange(c.radius, 1, 1e6) ||
              !inRange(c.rate, 0, 300) ||
              !inRange(c.reach ?? 0, 0, 20000) ||
              (c.velocity !== undefined &&
                (!Array.isArray(c.velocity) ||
                  c.velocity.length !== 2 ||
                  !c.velocity.every((x: number) => inRange(x, -200, 200)))),
          );
      if (bad)
        throw new RangeError(
          'Invalid VolumetricClouds rain; give {cells: at most 8 of {x, z within 1e7, radius 1 to 1e6, rate 0 to 300 mm/h, velocity [x, z] within 200 m/s, reach 0 to 20000}, integer steps 4 to 128, streaks 0 to 1}',
        );
    }
    const { coverage, bottom, top, density } = layerOf(o, this.layer);
    if (o.above !== undefined) {
      if (!(o.above instanceof VolumetricClouds) || o.above === this)
        throw new TypeError('VolumetricClouds above must be the other VolumetricClouds layer, the one over this one');
      const upper = layerOf(o.above.options, linkLayer);
      if (top > upper.bottom)
        throw new RangeError(
          `Invalid VolumetricClouds above; this layer's tops (${top} m) must be at or below the base of the layer above (${upper.bottom} m)`,
        );
    }
    if (
      !inRange(coverage, 0, 1) ||
      !inRange(bottom, 100, 20000) ||
      !inRange(top, bottom + 1, 20000) ||
      !inRange(density, 1e-6, 1) ||
      !inRange(o.stepCap ?? defaults.stepCap, 10, 10000) ||
      !inRange(setting(o, 'erosion'), 0, 2) ||
      !inRange(o.groundAlbedo ?? defaults.groundAlbedo, 0, 1) ||
      !inRange(setting(o, 'scale'), 1000, 200000) ||
      !inRange(setting(o, 'evolution'), 0, 50) ||
      !Number.isInteger(setting(o, 'steps')) ||
      !inRange(setting(o, 'steps'), 8, 256) ||
      !Number.isInteger(setting(o, 'lightSteps')) ||
      !inRange(setting(o, 'lightSteps'), 1, 16) ||
      !inRange(o.shear ?? 0, -20000, 20000) ||
      !inRange(o.maxDistance ?? defaults.maxDistance, 1000, 400000) ||
      !inRange(o.sunIntensity ?? defaults.sunIntensity, 0, 1000)
    )
      throw new RangeError(
        'Invalid VolumetricClouds options; keep coverage 0 to 1, bottom 100 to 20000 below top (at most 20000), density above 0 to 1, scale 1000 to 200000, evolution 0 to 50, integer steps 8 to 256 and lightSteps 1 to 16, shear -20000 to 20000, maxDistance 1000 to 400000, stepCap 10 to 10000, groundAlbedo 0 to 1 and sunIntensity 0 or more.',
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
    // The pass takes the plugin's name, so a second layer adds its own pass (KB-SKY-CLOUDTWO1).
    graph.add({
      name: this.name,
      order: 3,
      execute: (c) => {
        if (c.backend === 'webgpu') this.run(c);
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
    const storm = wantsStorm(this.options) ? loadStormField().then((f) => void f.of(this.options)) : undefined,
      scud = this.options.type === 'scud' ? loadScudField().then(() => undefined) : undefined,
      rain = wantsRain(this.options) ? loadRainShafts().then(() => undefined) : undefined;
    return Promise.all([storm, scud, rain]).then(() => undefined);
  }
  // The layer over this one when both draw on one engine, else undefined.
  private upper(): VolumetricClouds | undefined {
    const above = this.options.above;
    return above && above.engine && above.engine === this.engine && !above.disposed ? above : undefined;
  }
  // The layer under this one: an attached layer on this engine whose `above` is this one.
  private lower(): VolumetricClouds | undefined {
    const plugins = this.engine?.plugins as ReadonlyMap<string, unknown> | undefined;
    if (!plugins) return undefined;
    for (const [name, plugin] of plugins)
      if (isCloudLayerName(name) && plugin instanceof VolumetricClouds && plugin.upper() === this) return plugin;
    return undefined;
  }
  // One frame of this layer, or of it and the layer under it in the camera's order: from under the lower layer's tops
  // the upper deck is the farther, so it draws first and the lower over it; from above them the lower draws first.
  private run(c: Context): void {
    if (this.upper()) return;
    const lower = this.lower();
    if (!lower) {
      if (this.prepare(c)) this.paint(c);
      return;
    }
    const mine = this.prepare(c),
      theirs = lower.prepare(c),
      p = c.camera.position,
      below = cameraAltitude(p) < layerOf(lower.options, linkLayer).top,
      order = below ? [mine && this, theirs && lower] : [theirs && lower, mine && this];
    for (const layer of order) if (layer) layer.paint(c);
  }
  /** Seconds on this layer's clock: the sum of the deltas given to `advanceTime` (each frame update runs it). */
  get time(): number {
    return this.seconds;
  }
  /**
   * The rain rate, mm/h, the shafts draw at a world `position` now (`cloudRainRate` at this layer's time): what
   * `@margoengine/sky/weather` `rainFrom` reads, so the rain on the ground falls where the shafts are. 0 without `rain`.
   */
  rainRateAt(position: readonly [number, number, number]): number {
    return cloudRainRate(this.options, position[0], position[1], position[2], this.seconds);
  }
  /**
   * The rain of this layer at its base as a `RainSource` of `@margoengine/weather` (`new PrecipitationField({ source:
   * clouds.rainSource(), base })`): `rate(x, z, t)` the cells' rate at the base at `t` seconds on this layer's clock,
   * `peak` the strongest cell's rate, `fall` the shafts' fall speed. The field then carries the rain down itself.
   */
  rainSource(): { rate(x: number, z: number, t: number): number; readonly peak: number; readonly fall: number } {
    const options = this.options;
    return {
      rate: (x, z, t) => cloudRainBase(options, x, z, t),
      get peak() {
        let peak = 0;
        for (const c of options.rain?.cells ?? []) peak = Math.max(peak, c.rate);
        return peak;
      },
      get fall() {
        return cloudRainFall(options);
      },
    };
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
      scale = setting(this.options, 'scale');
    // The shapes repeat every `scale` metres and the coverage map every scale / 0.17, so each drift wraps at its own
    // repeat in double precision and stays exact in f32. Until 2026-11-14 the coverage map took the shapes' wrap, 0.17
    // of its own repeat, and the whole sky's cloud cover jumped there (every 23 minutes in the default wind).
    const map = scale / WEATHER;
    this.drift[0] = (this.drift[0] + wind[0] * delta) % scale;
    this.drift[1] = (this.drift[1] + wind[1] * delta) % scale;
    this.drift[2] = (this.drift[2] + setting(this.options, 'evolution') * delta) % scale;
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
    // The sky's exposure with its picture scale (KB-SKY-SANDGREY1): the deck is drawn and written into the sky's maps in
    // the sky's picture units, and its reading of the sky's map takes both back out.
    v[27] = 2 ** (sky?.options.exposure ?? 0) * (sky?.pictureScale ?? 1);
    v[34] = o.maxDistance ?? defaults.maxDistance;
    v[35] = setting(o, 'steps');
    v[39] = setting(o, 'lightSteps');
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
    writeGround(v, o, layer);
    // The layers linked to this one (`above`): the share of each light the upper deck passes, its base's glow back down,
    // and the floor of this layer's air band (the lower layer's tops); without them 1, 0 and the ground, as before.
    v[303] = 0;
    v[304] = v[305] = v[306] = 1;
    v[307] = v[308] = v[309] = v[310] = v[311] = 0;
    const upper = this.upper(),
      lower = upper ? undefined : this.lower();
    if (upper) {
      const deck = layerOf(upper.options, linkLayer);
      v[304] = cloudDeckTransmittance(deck, Math.max(v[21], 0.1));
      v[305] = cloudDeckTransmittance(deck, Math.max(v[45], 0.1));
      v[306] = cloudDeckTransmittance(deck, 0.6);
      // The environment map: this layer's in front from under its tops, else the upper's (0: the upper drew none).
      v[307] = upper.mapped ? (cameraAltitude(c.camera.position) < layer.top ? 1 : 2) : 0;
      v[308] = deck.bottom;
      v[309] = deckReflectance(deck);
    } else if (lower) {
      const scud = layerOf(lower.options, linkLayer),
        through = cloudDeckTransmittance(scud, 0.6);
      v[303] = scud.top;
      for (let i = 0; i < 8; i++) for (let k = 0; k < 3; k++) v[232 + 8 * i + k] *= through;
    }
    // The rain shafts: this layer's cells in its air band, or the upper deck's from the ground through this layer's tops.
    v.fill(0, 312, CLOUD_FLOATS);
    if (o.rain?.cells.length) writeRain(v, o, this.seconds, v[303], layer.bottom, true);
    else if (upper?.options.rain?.cells.length) writeRain(v, upper.options, upper.seconds, 0, layer.top, false);
    c.device.queue.writeBuffer(this.uniform!, 0, v as Float32Array<ArrayBuffer>);
    return v[30] > 0 || v[296] > 0 || v[312] > 0;
  }
  // The sky light: from the sky's reflection map on the GPU when it has one, else the `ambient` option.
  private skyLight(c: Context): void {
    const map = this.options.sky?.reflectionTexture;
    if (map) {
      if (this.lightSource !== map) {
        this.lightPipeline ??= c.device.createComputePipeline({
          layout: 'auto',
          compute: {
            module: c.device.createShaderModule({ code: withStorm(skyLightShader, this.built, this.builtScud) }),
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
    const upper = this.upper(),
      over = upper?.mapped ? upper.deck : undefined;
    if (this.deckGroup && over !== this.deckOver) this.deckPipeline = this.deckGroup = undefined;
    if (!this.deckGroup) {
      this.deckPipeline ??= c.device.createComputePipeline({
        layout: 'auto',
        compute: {
          module: c.device.createShaderModule({ code: withStorm(deckShader(!!over), this.built, this.builtScud) }),
          entryPoint: 'main',
        },
      });
      this.deckOver = over;
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
          ...(over
            ? [
                { binding: 7, resource: over.createView() },
                { binding: 8, resource: upper!.deckLight!.createView() },
              ]
            : []),
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
    this.mapped = true;
  }
  // Takes the deck back from the sky it was given to: nothing drawn, another sky, or released.
  // Hands the deck to the options' sky (Sky.deck), taking it back from a sky it was given to before.
  private hookDeck(): void {
    const sky = this.engine ? this.options.sky : undefined;
    if (this.decked === sky) {
      // A layer under this one holds the sky's deck (the product of both); a layer above gives way to it.
      const upper = this.upper();
      if (sky && upper && sky.deck === upper.deckOf) sky.deck = this.deckOf;
      return;
    }
    this.unhookDeck();
    if (sky) sky.deck = this.deckOf;
    this.decked = sky;
  }
  private unhookDeck(): void {
    if (this.decked?.deck === this.deckOf) {
      const upper = this.options.above;
      this.decked.deck = upper && upper.decked === this.decked && !upper.disposed ? upper.deckOf : undefined;
    }
    this.decked = undefined;
  }
  private unlayer(): void {
    if (this.layered && this.layered.environmentLayer === this.deck) this.layered.environmentLayer = undefined;
    if (this.layered && this.layered.environmentLightLayer === this.deckLight)
      this.layered.environmentLightLayer = undefined;
    this.layered = undefined;
  }
  // The frame's uniform, sky light and environment map; false when the layer draws nothing this frame.
  private prepare(c: Context): boolean {
    this.mapped = false;
    if (!this.uniform) return false;
    // A storm's or scud's code loads on first use; until it has the layer draws nothing (`ready`).
    const field = stormFieldFor(this.options),
      scud = scudFieldFor(this.options),
      rain = wantsRain(this.options) ? rainShaftsFor(this.options) : undefined;
    if (
      (wantsStorm(this.options) && !field) ||
      (this.options.type === 'scud' && !scud) ||
      (wantsRain(this.options) && !rain)
    )
      return false;
    if (rain !== this.builtRain) {
      this.builtRain = rain;
      this.key = '';
    }
    if (field !== this.built || scud !== this.builtScud) {
      // The field arrived (or changed): the shaders are made again with it.
      this.lightPipeline = this.lightGroup = this.deckPipeline = this.deckGroup = this.lightSource = undefined;
      this.key = '';
      this.built = field;
      this.builtScud = scud;
    }
    this.hookDeck();
    if (!this.write(c)) {
      this.unlayer();
      return false;
    }
    this.volumes!.fill(c.device, c.encoder);
    this.skyLight(c);
    this.environment(c);
    return true;
  }
  private paint(c: Context): void {
    const depth = sceneDepth(c, this.options.depth, 'VolumetricClouds'),
      samples = c.descriptor.multisample?.count ?? 1,
      key = `${c.format}:${samples}:${depth?.samples ?? 0}:${c.descriptor.depthStencil?.format}`;
    if (this.key !== key) {
      const module = c.device.createShaderModule({
        code: withStorm(shader(depth ? depthWGSL(5, depth.samples) : ''), this.built, this.builtScud, this.builtRain),
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
          { binding: 0, resource: { buffer: this.uniform! } },
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
    this.bound = this.lightSource = this.deckOver = undefined;
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
