/// <reference lib="esnext.disposable" preserve="true" />
// Froxel volumetric fog and light shafts (`@margoengine/environment/volumetric`): a camera-frustum 3D grid lit by the sun
// (through @margoengine/shadows' cascades) and clustered point/spot lights (with their LocalShadows), reprojected over
// time, integrated along view rays and composited over opaque surfaces and the sky in its own full-screen pass. It never
// patches a lit shader, so it adds no texture to the 16-per-stage budget, and nothing changes while it is not attached.
import type { EngineKernel } from '@margoengine/core';
import { keepBindings } from '../../shared/keep-bindings.js';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
  type Vec3,
} from '@margoengine/core/extension';
import { invertMatrix } from '@margoengine/math/mat4';
import { MargoError } from '@margoengine/math/errors';
import { perSample, sceneTarget } from '../../shared/msaa.js';
import { surfaceDepth } from '../../shared/surface-depth.js';
import { preset } from '../../shared/preset.js';
import { displayShader } from '../../shared/display.js';
import { clusterCell, decayTerms, legacyTerms } from '../../shared/light-terms.js';
import { applyView, viewRect, ViewStates } from '../../shared/view-rect.js';
import { alphaBlend, groupCode, overlayPass, type SurfaceTransparency } from '../../shared/pass.js';
import { linearHdr } from '../../shared/hdr-format.js';
import { compatTier } from '../../shared/compat.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; STORAGE_BINDING: number; COPY_SRC: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;
const defaultGrid = [160, 90, 64] as const,
  // Koschmieder: a black object at visibility V shows contrast exp(-sigma V) = 2% against the horizon, sigma = ln 50 / V.
  koschmieder = Math.log(50),
  // Clear air: 23 km visibility (the "clear" standard of LOWTRAN 7, Kneizys et al. 1988) with the 1.2 km scale height
  // of the haze (Mie) layer (Bruneton and Neyret 2008; Hillaire 2020).
  clearAir = 23000,
  hazeFalloff = 1 / 1200,
  white = [1, 1, 1],
  jitterBases = [2, 3, 5];

/** What VolumetricFog reads from `Shadows` (@margoengine/shadows) or `Clustered` (@margoengine/clustered): their WGSL and bindings. */
export interface VolumetricLightSource {
  pbr(group: number): { readonly declarations: string };
  bindings(): GPUBindGroupEntry[];
}

/**
 * A local fog medium VolumetricFog adds to its froxel grid (`FogVolumes` from @margoengine/environment/fog-volumes):
 * WGSL defining `fogMedium(p:vec3f)->vec4f` (scattering rgb, extinction a) and the bindings it reads.
 */
export interface VolumetricMediumSource {
  medium(group: number): string;
  bindings(device: GPUDevice): GPUBindGroupEntry[];
}

// The local lights' shadow in the fog: LocalShadows (`@margoengine/clustered/shadows`) declares `clusterShadow`,
// Clustered's own `shadows` option `clusterShadowVisibility`; either takes a zero normal (no offset in a medium).
// Until 2026-11-14 only the first was called, so with Clustered's own shadows the light passed through walls into the
// fog, and the shadow bindings (28 to 30), declared but unused, fell out of the inject pass's automatic layout: the
// light group failed to build and every frame after it was lost (found building Cabin Hearth).
const localShadow = (lights: string): string =>
  lights.includes('fn clusterShadow(')
    ? '*clusterShadow(light,p,vec3f(0))'
    : lights.includes('fn clusterShadowVisibility(')
      ? '*clusterShadowVisibility(light,p,vec3f(0))'
      : '';

/** The light source's WGSL declares rectangular area lights (`AreaLights` attached to the same Clustered). */
const area = (lights: string | undefined): boolean => !!lights && lights.includes('var<storage,read> areaLights');

/** `VolumetricFog` settings (froxel-grid scattering with shadowed light shafts); invalid values throw RangeError. */
export interface VolumetricFogOptions {
  /** Whether the fog draws (default true). Live: false skips its pass from the next frame and keeps its grid. */
  enabled?: boolean;
  /**
   * Extinction per metre at and below `height`. Give this or `visibility`, not both (default: from `visibility`). Until
   * 2026-11-16 the default was 0.02, a fog of 196 m visibility; pass `density: 0.02` (or `visibility: 196`) for it.
   */
  density?: number;
  /**
   * Visibility in metres at and below `height`: the distance at which a black object shows 2% contrast against the
   * horizon (Koschmieder), so the extinction is 3.912 / visibility per metre. Clear air is 23,000 (the default when
   * `density` is not given), haze 5,000, mist 1,000, fog 200 and less. Give this or `density`, not both.
   */
  visibility?: number;
  /**
   * Height fog: density times `exp(-heightFalloff * (y - height))` above `height`. Default: 0 (uniform) when `density`
   * is given; otherwise 1 / 1,200 per metre, the 1.2 km scale height of the air's haze (aerosols), so clear air thins
   * upward and the sky overhead stays clear.
   */
  heightFalloff?: number;
  /** World height below which the fog has its full density (default 0). */
  height?: number;
  /** Scattering albedo, linear RGB 0..1 (default [1, 1, 1]: no absorption). */
  color?: Vec3;
  /** Henyey-Greenstein anisotropy, -0.95..0.95; positive scatters forward, brightening shafts toward the light (default 0.5). */
  anisotropy?: number;
  /**
   * Isotropic ambient radiance scattered by the fog, linear RGB. Default: the horizon sky in each view direction when the
   * fog has a sky (`sky`), so the fog takes the sky's light and a fully fogged far surface shows the horizon sky;
   * otherwise the engine's ambient, `lighting.radiance[3]`, as grey.
   */
  ambient?: Vec3;
  /**
   * Multiple scattering: the distance in metres over which light already scattered by the fog can scatter again before it
   * leaves (about the size of the fog bank; default 0 = single scattering only). Thick fog then glows and brightens, also
   * looking away from the sun; the shaders and the uniform are what they were without the option while it is 0.
   */
  multipleScattering?: number;
  /** Density noise 0..1 (default 0: smooth fog). */
  noise?: number;
  /** Noise feature size in metres (default 8). */
  noiseScale?: number;
  /** Noise drift in metres per second (default [0, 0, 0]). */
  wind?: Vec3;
  /**
   * Metres beyond the near plane the froxel grid covers (default 100): the near air, with shafts, local lights, noise
   * and `volumes`. Past it every opaque pixel, the sky and water included, gets the same fog analytically (its density,
   * height falloff and colour, without shafts, noise or volumes) out to the surface, or to the sky, so far things keep
   * fading with distance. Until 2026-11-16 the fog stopped at `range`: a sea 3 km out got the fog of one 480 m out.
   */
  range?: number;
  /**
   * The sky whose light the fog takes past `range`: an object with `reflectionTexture`, the sky's 64 x 32 linear HDR
   * environment (`Sky` from @margoengine/sky). Default: the scene's plugin named `sky`, if any. The fog past `range`
   * then shines with the horizon sky in each view direction, times `color`, so a fully fogged far sea or hill meets the
   * sky at the horizon with no step. `null`, or no sky in the scene: the fog's own light (`ambient` and the sun through
   * `anisotropy`, times `color`), as in the froxels.
   */
  sky?: { readonly reflectionTexture?: GPUTexture | undefined } | null;
  /** Froxels across, down and in depth (default [160, 90, 64]); slices are spaced quadratically, finer near the camera. */
  grid?: readonly [number, number, number];
  /** Weight of the reprojected previous frame, 0..0.98 (default 0.9; 0 turns reprojection and sub-froxel jitter off). */
  temporal?: number;
  /** Directional cascades (`Shadows` from @margoengine/shadows): sunlight is shadowed in the fog, giving light shafts. */
  shadows?: VolumetricLightSource;
  /**
   * Clustered point and spot lights (`Clustered`), with the falloff and cone clustered lights surfaces with (each light's
   * decay, cone and unlimited range); a `LocalShadows` attached to them shadows the fog too.
   */
  lights?: VolumetricLightSource;
  /**
   * Sampleable reversed-Z scene depth when no post capture (Tonemap, Bloom, PostStack, SSAO, TAA) owns the scene target,
   * e.g. `() => water.depthTexture`. With a capture attached the fog reads its depth, and a Water's surface drawn this
   * frame with it, so this is not needed.
   */
  depth?: () => GPUTexture | undefined;
  /**
   * Local fog (`FogVolumes` from @margoengine/environment/fog-volumes): boxes and spheres with their own density,
   * colour and noise, added to this fog and lit like it. Without it the fog's shaders are unchanged.
   */
  volumes?: VolumetricMediumSource;
  /**
   * Lightning over the fog (`weather.lightningLight` from @margoengine/sky/weather), read every frame: the cloud deck
   * its flash lights sends light back down, which the fog scatters as ambient light (see
   * {@link VolumetricFogLightning}). The light itself, given to `lights` as well, lights the fog directly. Default none.
   */
  lightning?: VolumetricFogLightning;
}

/**
 * {@link VolumetricFogOptions.lightning}. A Lambertian surface of albedo rho under illuminance E has radiance
 * rho E / pi (Lambert); a deck over the fog lit by the flash fills the upper half of the fog's sphere of directions, so
 * the flash adds rho E / (2 pi) of isotropic ambient radiance, with E = intensity / d^2 of the light d metres from the
 * camera (inverse square, 1 m at the least).
 */
export interface VolumetricFogLightning {
  /** The lightning's point light, read every frame: `position` (world), `color` (linear RGB) and `intensity`, in the units of the scene's lights. */
  light: { readonly position: ArrayLike<number>; readonly color: ArrayLike<number>; readonly intensity: number };
  /**
   * Albedo of the cloud deck's base, 0 to 1. Default {@link CLOUD_ALBEDO}, 0.8: a thick storm cloud's (its albedo
   * approaches 0.8 to 0.9 as its optical thickness passes 50; S. Twomey, "The influence of pollution on the shortwave
   * albedo of clouds", J. Atmos. Sci. 34(7):1149-1152, 1977). 0 turns the deck's light off.
   */
  albedo?: number;
}
/** Default {@link VolumetricFogLightning.albedo}: a thick storm cloud's albedo (Twomey 1977). */
export const CLOUD_ALBEDO = 0.8;

const struct = /* wgsl */ `
struct Volume {inverse:mat4x4f,previous:mat4x4f,plane:vec4f,previousPlane:vec4f,grid:vec4f,shape:vec4f,scatter:vec4f,sun:vec4f,sunColor:vec4f,ambient:vec4f,wind:vec4f,jitter:vec4f,screen:vec4f}
@group(0) @binding(0) var<uniform> volume:Volume;
fn unproject(ndc:vec3f)->vec3f {let p=volume.inverse*vec4f(ndc,1);return p.xyz/p.w;}
fn sliceDepth(s:f32)->f32 {let x=s/volume.grid.z;return volume.shape.x*x*x;}
`;
// t = distance beyond the near plane along the view axis: dot(plane, (p, 1)), for perspective and orthographic cameras.
// A screen point's ray runs from its near-plane point n through the depth-0.5 point; p(t) = n + d * t / dot(d, plane.xyz).
// Sources: Henyey & Greenstein 1941 phase (12.5663706 = 4 pi); froxel grid and reprojection after Wronski 2014;
// per-slice analytic, energy-conserving integration (S - S T) / sigma after Hillaire 2015, "Physically Based and
// Unified Volumetric Rendering in Frostbite". Noise weights 1.3333 / 0.6667, lacunarity 2.11, the offset and the four
// stratified shadow samples are Margo tuning.
// Multiple scattering (option): orders two and up summed as a geometric series with isotropic phase, after Hillaire 2020,
// "A Scalable and Production Ready Sky and Atmosphere Rendering Technique" (EGSR, section 5.5: F_ms = 1 / (1 - f_ms)).
// Here f_ms = albedo * (1 - exp(-sigma R)): the share of light scattered at a froxel that is scattered again within the
// distance R (Beer-Lambert) and not absorbed. Each order then adds f_ms times the last, so orders two and up add the
// isotropic first-order source (ambient plus the shadowed sun times 1 / 4 pi = 0.0795775) times f_ms / (1 - f_ms). The
// 0.95 cap on f_ms (at most 19 times the isotropic source) is Margo tuning: it keeps white fog of unbounded depth finite.
// Without a sky the shader text is the one before the sky option, byte for byte (its hash is pinned by the tests).
const multiple = (ambient: string) =>
  `let ms=min(volume.scatter.rgb*(1.0-exp(-sigma*volume.sun.w)),vec3f(0.95));light+=(${ambient}+sun*0.0795775)*ms/(1.0-ms);`;
// The fog's ambient light seen along view direction w: the uniform's, or with a sky (`sky` option, no `ambient`) the
// horizon sky in w's azimuth, texel row 15 of the sky's 64 x 32 map (u turns round +Y from -X, v runs down from the
// zenith; row 15 is centred 2.8 degrees above the horizon), wrapping round in u.
const fogAmbient = (sky: boolean, map: number) =>
  sky
    ? `
@group(0) @binding(${map}) var skyMap:texture_2d<f32>;
@group(0) @binding(${map + 1}) var skySampler:sampler;
fn fogAmbient(w:vec3f)->vec3f {
  let u=select(atan2(w.z,w.x)*0.15915494+0.5,0.5,abs(w.x)+abs(w.z)<1e-6);
  return textureSampleLevel(skyMap,skySampler,vec2f(u,0.484375),0).rgb;
}`
    : `
fn fogAmbient(w:vec3f)->vec3f {return volume.ambient.rgb;}`;
// On the WebGL2 compatibility layer (`own`), each invocation integrates its own froxel instead of a whole column: the
// layer runs a compute entry point on the GPU only when every store writes the invocation's own texel (a fragment
// draw per slice), and the column loop's store at each slice sent `integrate` to its CPU tier (about 1 s a frame at
// the default grid: the scattering volume read back, 14,400 columns of 64 steps in JavaScript, the result uploaded).
// A froxel at slice z replays the column's steps 0 to z in the same order with the same arithmetic, so it stores the
// value the column loop stores there; the cost is z + 1 steps instead of 1, (n + 1) / 2 times the column's work, all
// on the GPU (the fragment-era prefix scan's O(n^2) work, Horn, "Stream Reduction Operations for GPGPU Applications",
// GPU Gems 2 ch. 36, 2005, as measured by Sengupta, Harris, Zhang and Owens, "Scan Primitives for GPU Computing",
// Graphics Hardware 2007). A log-step parallel scan (Hillis and Steele, "Data Parallel Algorithms", CACM 29(12), 1986;
// Blelloch, "Prefix Sums and Their Applications", CMU-CS-90-190, 1990) would do less work but add the terms in another
// order, which rounds differently (Higham, "The Accuracy of Floating Point Summation", SIAM J. Sci. Comput. 14(4), 1993).
const compute = (
  lights: string | undefined,
  shadows: string | undefined,
  medium?: string,
  ms?: boolean,
  own?: boolean,
  sky = false,
) =>
  struct +
  (lights ?? '') +
  (shadows ?? '') +
  (medium ?? '') +
  (sky ? fogAmbient(true, 6) : '') +
  /* wgsl */ `
@group(0) @binding(1) var history:texture_3d<f32>;
@group(0) @binding(2) var linearSampler:sampler;
@group(0) @binding(3) var current:texture_storage_3d<rgba16float,write>;
@group(0) @binding(4) var scattering:texture_3d<f32>;
@group(0) @binding(5) var integrated:texture_storage_3d<rgba16float,write>;
fn phase(c:f32,g:f32)->f32 {let k=1.0+g*g-2.0*g*c;return (1.0-g*g)/(12.5663706*k*sqrt(k));}
// 3D value noise (Perlin 1985; Ebert et al., "Texturing and Modeling: A Procedural Approach", ch. 2): one hashed value
// per integer lattice corner, blended trilinearly with the cubic fade 3t^2 - 2t^3. Corner values are the PCG hash
// (Jarzynski and Olano, JCGT 9(3), 2020) nested over the corner's integer coordinates, exact at any world position.
fn fogPcg(v:u32)->u32 {let s=v*747796405u+2891336453u;let w=((s>>((s>>28u)+4u))^s)*277803737u;return (w>>22u)^w;}
fn fogCorner(c:vec3i)->f32 {let u=bitcast<vec3u>(c);return f32(fogPcg(u.x+fogPcg(u.y+fogPcg(u.z)))>>8u)*5.9604645e-8;}
fn noise(x:vec3f)->f32 {
  let base=floor(x);let c=vec3i(base);let t=x-base;let w=t*t*(3.0-2.0*t);
  let lower=mix(mix(fogCorner(c),fogCorner(c+vec3i(1,0,0)),w.x),mix(fogCorner(c+vec3i(0,1,0)),fogCorner(c+vec3i(1,1,0)),w.x),w.y);
  let upper=mix(mix(fogCorner(c+vec3i(0,0,1)),fogCorner(c+vec3i(1,0,1)),w.x),mix(fogCorner(c+vec3i(0,1,1)),fogCorner(c+vec3i(1,1,1)),w.x),w.y);
  return mix(lower,upper,w.z);
}
${
  shadows
    ? `fn sunShadow(p:vec3f)->f32 {
  let depth=-(shadowFrame.view*vec4f(p,1)).z;if(depth<0.0||depth>shadowFrame.splits.w){return 1.0;}
  let cascade=u32(depth>shadowFrame.splits.x)+u32(depth>shadowFrame.splits.y)+u32(depth>shadowFrame.splits.z);
  let matrix=shadowFrame.matrices[cascade];let size=2.0/vec2f(textureDimensions(shadowMap));
  let world=max(size.x/length(vec3f(matrix[0].x,matrix[1].x,matrix[2].x)),size.y/length(vec3f(matrix[0].y,matrix[1].y,matrix[2].y)));
  let q=matrix*vec4f(p,1);let uv=q.xy*vec2f(0.5,-0.5)+0.5;
  if(any(uv<vec2f(0))||any(uv>vec2f(1))||q.z<=0.0||q.z>=1.0){return 1.0;}
  return textureSampleCompareLevel(shadowMap,shadowSampler,uv,i32(cascade),q.z-shadowFrame.settings.y-1*world*length(vec3f(matrix[0].z,matrix[1].z,matrix[2].z)));
}`
    : ''
}
${
  lights
    ? // The light scattered along the view ray's segment a + w u, u in [0, len], integrated, not point sampled (until
      // 2026-11-15 four points per slice: a beam narrower than their spacing lit the columns whose points fell inside it
      // and missed the rest, the separate blocks of the Storm Light short). Per light: the chord of the segment inside
      // the range sphere and the outer cone (a quadratic each; zero light outside both), then the airlight integral
      // over the chord. Its inverse square part has the closed form (atan(b) - atan(a)) / h over the closest approach
      // h (Sun, Ramamoorthi, Narasimhan and Nayar 2005; Pegoraro and Parker 2009); the smooth rest (cone edge, window,
      // decay other than 2, phase, extinction, shadow) is taken at points equally spaced in that angle, equiangular
      // sampling (Kulla and Fajardo 2012), whose weight is that closed form. Cone chord after Eberly, "Intersection of a
      // Line and a Cone" (Geometric Tools, 2000), written in the sine and cosine of the cone so a narrow cone keeps its
      // precision. Two points per segment, jittered with the frame: 8 made the same pictures within run noise (beam
      // checks 0.760 to 1.184 of the true light against 0.762 to 1.186, L1 0.140 both; Storm Light probe worst dip 0.14
      // against 0.13) at four times the light evaluations.
      // footprint: a cone narrower than the froxel it crosses is widened by the froxel's size seen from the light, its
      // half-angle spread added in quadrature to the penumbra's and its peak lowered by keep so the energy through the
      // cone stays the same: footprint prefiltering, as Toksvig ("Mipmapping Normal Maps", 2005) widens a lobe by the
      // variance under a texel and Kaplanyan, Hill, Patney and Lefohn ("Filtering Distributions of Normals for Shading
      // Antialiasing", HPG 2016) add a pixel footprint's variance to a lobe's. Without it a beam thinner than a froxel
      // row lit the rows its points fell in and skipped the rest.
      // spread: h is held to the radius whose ball the light is spread over within the froxel's cross-section (the mean
      // of 1/d^2 over a ball of radius R is 3 / R^2, so R / sqrt(3)). Without it a froxel holding a light took the light
      // at one point and drew a bright square around every bulb and lighthouse lens.
      // extinction: the fog's extinction at the froxel, taken along the whole path to the light, which the light crosses
      // before it scatters (exact in uniform fog). Until 2026-11-13 the light arrived unattenuated, so a beam stayed as
      // bright hundreds of metres out in thick fog as at the lens, and seen along its length it blew out the sky.
      `fn coneChord(o:vec3f,w:vec3f,k:vec3f,co:f32,lo:f32,hi:f32)->vec2f {
  let ok=dot(o,k);let wk=dot(w,k);var a=lo;var b=hi;
  if(abs(wk)>1e-7){let u=-ok/wk;if(wk>0.0){a=max(a,u);}else{b=min(b,u);}}else if(ok<0.0){return vec2f(1,0);}
  if(co<=0.0){return vec2f(a,b);}
  let s2=max(1.0-co*co,0.0);let c2=co*co;let op=o-k*ok;let wp=w-k*wk;
  let A=wk*wk*s2-c2*dot(wp,wp);let B=wk*ok*s2-c2*dot(op,wp);let C=ok*ok*s2-c2*dot(op,op);
  if(abs(A)<1e-9){if(abs(B)<1e-12){return select(vec2f(1,0),vec2f(a,b),C>=0.0);}let u=-C/(2.0*B);if(B>0.0){a=max(a,u);}else{b=min(b,u);}return vec2f(a,b);}
  let disc=B*B-A*C;
  if(A<0.0){if(disc<=0.0){return vec2f(1,0);}let r=sqrt(disc);let r0=(-B+r)/A;let r1=(-B-r)/A;return vec2f(max(a,min(r0,r1)),min(b,max(r0,r1)));}
  if(disc<=0.0){return vec2f(a,b);}
  let r=sqrt(disc);let first=vec2f(a,min(b,(-B-r)/A));let second=vec2f(max(a,(-B+r)/A),b);
  return select(second,first,first.y-first.x>second.y-second.x);
}
fn localLight(pixel:vec2f,a:vec3f,w:vec3f,len:f32,v:vec3f,g:f32,foot:f32,extinction:f32,jitter:f32)->vec3f {
  let p=a+w*(0.5*len);let spread=0.57735027*foot;
${/* @__PURE__ */ clusterCell('p')}
  for(var j=0u;j<count;j++){
    let light=clusterLights[clusterIndices[cell*1024u+j]];let o=a-light.positionRange.xyz;let range=light.positionRange.w;
    let closest=-dot(o,w);var chord=vec2f(0,len);
    if(range<3.0e38){let q=closest*closest-dot(o,o)+range*range;if(q<=0.0){continue;}let r=sqrt(q);chord=vec2f(max(0.0,closest-r),min(len,closest+r));}
    let spot=light.params.y>0.5;let outer=acos(clamp(light.directionOuter.w,-1.0,1.0));let inner=min(acos(clamp(light.params.x,-1.0,1.0)),outer);
    let mid=0.5*(outer+inner);let half=0.5*(outer-inner);let miss=length(o+w*closest);
    if(spot){let nearest=sqrt(miss*miss+pow(clamp(closest,chord.x,chord.y)-closest,2.0));
      let blur=foot/max(nearest,foot);chord=coneChord(o,w,light.directionOuter.xyz,cos(min(mid+sqrt(half*half+blur*blur),1.5707963)),chord.x,chord.y);}
    if(chord.y<=chord.x){continue;}
    let h=max(miss,spread);let t0=atan((chord.x-closest)/h);let t1=atan((chord.y-closest)/h);
    var sum=vec3f(0);
    for(var k=0u;k<2u;k++){
      let u=closest+h*tan(mix(t0,t1,(f32(k)+0.5+jitter)*0.5));let delta=-o-w*u;let distance=sqrt((u-closest)*(u-closest)+h*h);
      let reachOf=length(delta);let l=delta/max(reachOf,0.0001);
      let blur=foot/max(reachOf,foot);let edge=sqrt(half*half+blur*blur);
      let outerCos=select(light.directionOuter.w,cos(min(mid+edge,1.5707963)),spot);let innerCos=select(light.params.x,cos(abs(mid-edge)),spot);
      let keep=select(1.0,(mid*mid+half*half)/max(mid*mid+edge*edge,1e-18),spot);
      ${(lights.includes(decayTerms) ? decayTerms : legacyTerms).replaceAll('light.directionOuter.w', 'outerCos').replaceAll('light.params.x', 'innerCos')}
      sum+=falloff*distance*distance*cone*keep*exp(-extinction*reachOf)*phase(dot(-l,v),g)${localShadow(lights).replace(',p,', ',a+w*u,')};
    }
    result+=light.colorIntensity.rgb*light.colorIntensity.w*sum*(0.5*(t1-t0)/h);
  }
  return result*clusterFrame.intensity.x;
}`
    : ''
}
${
  area(lights)
    ? // The rectangular area lights (`AreaLights`, clustered/area) scatter in the fog too. Each light's radiance times
      // the solid angle of its rectangle seen from the froxel's centre (two triangles, each by Van Oosterom and Strackee,
      // "The Solid Angle of a Plane Triangle", IEEE Trans. Biomed. Eng. 30(2), 1983, doi:10.1109/TBME.1983.325207),
      // the phase toward its centre and the extinction along the way; a one-sided light lights only the space in front.
      // Until 2026-11-16 the fog left the area binding declared but unused: the inject pass's automatic layout dropped
      // it, its light group failed to build and every frame after it was lost (KB-CABIN-WINDOWGLOW1).
      `fn triangleSolidAngle(a:vec3f,b:vec3f,c:vec3f)->f32 {
  let la=length(a);let lb=length(b);let lc=length(c);
  return 2.0*abs(atan2(dot(a,cross(b,c)),la*lb*lc+dot(a,b)*lc+dot(a,c)*lb+dot(b,c)*la));
}
fn areaFog(p:vec3f,v:vec3f,g:f32,extinction:f32)->vec3f {
  var sum=vec3f(0);
  for(var j=0u;j<areaLights.count.x;j++){
    let light=areaLights.lights[j];let c=light.center.xyz-p;let r=light.right.xyz;let u=light.up.xyz;
    if(dot(cross(r,u),c)>0.0&&light.center.w<0.5){continue;}
    let omega=triangleSolidAngle(c-r-u,c+r-u,c+r+u)+triangleSolidAngle(c-r-u,c+r+u,c-r+u);
    let d=length(c);sum+=light.color.rgb*omega*phase(dot(-c/max(d,0.0001),v),g)*exp(-extinction*d);
  }
  return sum*clusterFrame.intensity.x;
}
`
    : ''
}// Scattered light (rgb) and extinction (a) per froxel, blended with the previous frame's value at the same world point.
@compute @workgroup_size(4,4,4) fn inject(@builtin(global_invocation_id) id:vec3u) {
  ${keepBindings(lights, shadows)}if(any(id>=vec3u(volume.grid.xyz))){return;}
  let uv=(vec2f(id.xy)+0.5+volume.jitter.xy)/volume.grid.xy;let ndc=vec2f(uv.x*2-1,1-uv.y*2);
  let n=unproject(vec3f(ndc,1));let d=unproject(vec3f(ndc,0.5))-n;let v=normalize(-d);
  let p=n+d*(sliceDepth(f32(id.z)+0.5+volume.jitter.z)/dot(d,volume.plane.xyz));
  var sigma=volume.shape.y*exp(-volume.shape.z*max(p.y-volume.shape.w,0.0));
  if(volume.sunColor.w>0.0){let x=(p-volume.wind.xyz)*volume.ambient.w;sigma*=max(0.0,1.0+volume.sunColor.w*(1.3333*noise(x)+0.6667*noise(x*2.11+vec3f(23.7,-11.3,5.9))-1.0));}
  ${sky ? 'let ambient=fogAmbient(-v);var light=ambient;' : 'var light=volume.ambient.rgb;'}${ms ? 'var sun=vec3f(0);' : ''}
  if(any(volume.sunColor.rgb>vec3f(0))){
    var lit=1.0;
    ${
      shadows
        ? `// Four stratified shadow samples along the froxel's depth: shaft walls the view ray crosses obliquely stay steady.
    lit=0.0;for(var k=0u;k<4u;k++){lit+=0.25*sunShadow(n+d*(sliceDepth(f32(id.z)+(f32(k)+0.5+volume.jitter.z)*0.25)/dot(d,volume.plane.xyz)));}`
        : ''
    }
    light+=volume.sunColor.rgb*phase(dot(-volume.sun.xyz,v),volume.scatter.w)*lit;${ms ? 'sun=volume.sunColor.rgb*lit;' : ''}
  }${ms ? multiple(sky ? 'ambient' : 'volume.ambient.rgb') : ''}${medium && lights ? '\n  let local=fogMedium(p);' : ''}
  ${
    lights
      ? // The slice's whole depth along the froxel's ray, integrated per light (localLight), in four parts with a
        // cluster lookup each (a deep slice spans several clusters near the camera); the mean over the slice is what
        // the froxel scatters. foot: half the froxel's width or height at the slice's centre, whichever is larger (the
        // neighbouring column's and row's rays; a portrait view's froxels are taller than wide).
        `let pixel=uv*volume.screen.xy+volume.screen.zw;let at=sliceDepth(f32(id.z)+0.5+volume.jitter.z);
  let side=(vec2f(id.xy)+vec2f(1.5,0.5)+volume.jitter.xy)/volume.grid.xy;let n2=unproject(vec3f(side.x*2-1,1-side.y*2,1));
  let d2=unproject(vec3f(side.x*2-1,1-side.y*2,0.5))-n2;
  let up=(vec2f(id.xy)+vec2f(0.5,1.5)+volume.jitter.xy)/volume.grid.xy;let n3=unproject(vec3f(up.x*2-1,1-up.y*2,1));
  let d3=unproject(vec3f(up.x*2-1,1-up.y*2,0.5))-n3;
  let foot=0.5*max(length(n2+d2*(at/dot(d2,volume.plane.xyz))-p),length(n3+d3*(at/dot(d3,volume.plane.xyz))-p));
  let ray=normalize(d);let stretch=length(d)/dot(d,volume.plane.xyz);let front=sliceDepth(f32(id.z));let back=sliceDepth(f32(id.z)+1.0);
  let part=0.25*(back-front)*stretch;
  if(part>0.0){for(var k=0u;k<4u;k++){light+=localLight(pixel,n+ray*((front+0.25*f32(k)*(back-front))*stretch),ray,part,v,volume.scatter.w,foot,sigma${medium ? '+local.a' : ''},volume.jitter.z)/(4.0*part);}}${
    area(lights)
      ? `
  light+=areaFog(p,v,volume.scatter.w,sigma${medium ? '+local.a' : ''});`
      : ''
  }`
      : ''
  }
  ${medium ? (lights ? '' : 'let local=fogMedium(p);') + 'var value=vec4f((sigma*volume.scatter.rgb+local.rgb)*light,sigma+local.a);' : 'var value=vec4f(sigma*volume.scatter.rgb*light,sigma);'}
  if(volume.grid.w>0.0){
    // Reproject the froxel's centre, not the jittered sample: a still camera reads its own texel unfiltered (no drift).
    let uc=(vec2f(id.xy)+0.5)/volume.grid.xy;let nc=unproject(vec3f(uc.x*2-1,1-uc.y*2,1));let dc=unproject(vec3f(uc.x*2-1,1-uc.y*2,0.5))-nc;
    let c=nc+dc*(sliceDepth(f32(id.z)+0.5)/dot(dc,volume.plane.xyz));
    let clip=volume.previous*vec4f(c,1);let t=dot(volume.previousPlane,vec4f(c,1));
    let coord=vec3f(clip.x/clip.w*0.5+0.5,0.5-clip.y/clip.w*0.5,sqrt(max(t,0.0)/volume.shape.x));
    if(clip.w>0.0&&t>=0.0&&all(coord>=vec3f(0))&&all(coord<=vec3f(1))){value=mix(value,textureSampleLevel(history,linearSampler,coord,0),volume.grid.w);}
  }
  textureStore(current,id,value);
}
// Front to back along each froxel column: in-scattered light reaching the camera (rgb) and optical depth (a) at each
// slice's far boundary, integrating each slice analytically (energy conserving for thick slices).
@compute @workgroup_size(${own ? '4,4,4' : '8,8'}) fn integrate(@builtin(global_invocation_id) id:vec3u) {
  let size=vec3u(volume.grid.xyz);if(any(id${own ? '' : '.xy'}>=size${own ? '' : '.xy'})){return;}
  let uv=(vec2f(id.xy)+0.5)/volume.grid.xy;let ndc=vec2f(uv.x*2-1,1-uv.y*2);
  let n=unproject(vec3f(ndc,1));let d=unproject(vec3f(ndc,0.5))-n;let stretch=length(d)/dot(d,volume.plane.xyz);
  var light=vec3f(0);var optical=0.0;let texel=0.5/volume.grid.xyz;
  for(var z=0u;z<${own ? '=id' : 'size'}.z;z++){
    // 3x3 tent filter across the column (four bilinear taps): steadies jittered shadow edges between frames.
    let w=(f32(z)+0.5)/volume.grid.z;
    let s=0.25*(textureSampleLevel(scattering,linearSampler,vec3f(uv-texel.xy,w),0)+textureSampleLevel(scattering,linearSampler,vec3f(uv+vec2f(texel.x,-texel.y),w),0)
      +textureSampleLevel(scattering,linearSampler,vec3f(uv+vec2f(-texel.x,texel.y),w),0)+textureSampleLevel(scattering,linearSampler,vec3f(uv+texel.xy,w),0));let step=(sliceDepth(f32(z+1))-sliceDepth(f32(z)))*stretch;
    let through=exp(-s.a*step);
    light+=exp(-optical)*select(s.rgb*step,(s.rgb-s.rgb*through)/s.a,s.a>0.00001);optical+=s.a*step;
  ${own ? '}\n  textureStore(integrated,id,vec4f(light,optical));' : '  textureStore(integrated,vec3u(id.xy,z),vec4f(light,optical));\n  }'}
}`;
// Opacity 1 - exp(-tau): Beer-Lambert.
// Premultiplied over the scene: rgb = in-scattered light, a = 1 - transmittance. Tone mapped like sky fog on a display target.
// The far air (`range` and past it): the froxel volume ends at t = range, where the ray is at a. From a on, the same
// medium is integrated in closed form along the ray to the surface (length len) or to infinity (the sky): the optical
// depth of sigma(y) = density exp(-falloff max(y - height, 0)) is density times the length under `height` plus, over the
// part above it, density exp(-falloff y_low) (1 - exp(-x)) / (falloff |w.y|), x = falloff |w.y| length, taken from its
// lower end so no exponential grows (series 1 - x / 2 below x = 1e-3). This is the exponential height fog integral of
// Wenzel, "Real-time Atmospheric Effects in Games" (SIGGRAPH 2006 course) and Quilez, "Better Fog" (2010), split at
// `height` for the flat layer under it. A ray that never leaves a layer of nonzero density (uniform fog to the sky, or
// a ray down into the layer forever) gets 1e9: fully fogged. The far air's light is the froxels' own source over its
// extinction (what a thick froxel slice converges to): the albedo times the ambient (fogAmbient: with a sky, the horizon
// sky in the view azimuth, as aerial perspective takes the far air's light from the sky-view at the horizon, Hillaire,
// EGSR 2020, section 5, and Bruneton and Neyret, EGSR 2008), the unshadowed sun through the phase function and the
// multiple-scattering series. So with a sky and no sun a fully fogged far surface shows the horizon sky. The pixel is
// the froxels' L + T_froxel (1 - T_tail) L_far over the scene times T_froxel T_tail: unchanged wherever the surface is
// nearer than `range`, and continuous across it.
// The far air's optical depth and light, shared by the composite and fogged transparents (KB-FOG-FAR-TRANSPARENT).
const farAir = /* wgsl */ `fn tailDepth(a:vec3f,w:vec3f,len:f32)->f32 {
  let s0=volume.shape.y;let k=volume.shape.z;let y0=a.y-volume.shape.w;let far=len<0.0;let wy=w.y;
  if(s0<=0.0){return 0.0;}
  if(k<=0.0||abs(wy)<1e-6){return select(s0*exp(-k*max(y0,0.0))*len,1e9,far);}
  let cross=-y0/wy;
  if(wy>0.0){
    let below=select(0.0,select(min(cross,len),cross,far),y0<0.0);let low=max(y0+wy*below,0.0);
    if(far){return s0*below+s0*exp(-k*low)/(k*wy);}
    let x=k*wy*(len-below);
    return s0*below+s0*exp(-k*low)*select((len-below)*(1.0-0.5*x),(1.0-exp(-x))/(k*wy),x>1e-3);
  }
  if(far){return 1e9;}
  let above=min(select(0.0,cross,y0>0.0),len);let low=max(y0+wy*above,0.0);let x=-k*wy*above;
  return s0*(len-above)+s0*exp(-k*low)*select(above*(1.0-0.5*x),(1.0-exp(-x))/(-k*wy),x>1e-3);
}
fn farLight(w:vec3f,a:vec3f)->vec3f {
  let ambient=fogAmbient(w);let c=dot(volume.sun.xyz,w);let g=volume.scatter.w;let k=1.0+g*g-2.0*g*c;
  let sigma=volume.shape.y*exp(-volume.shape.z*max(a.y-volume.shape.w,0.0));
  let ms=min(volume.scatter.rgb*(1.0-exp(-sigma*volume.sun.w)),vec3f(0.95));
  return volume.scatter.rgb*(ambient+volume.sunColor.rgb*(1.0-g*g)/(12.5663706*k*sqrt(k))+(ambient+volume.sunColor.rgb*0.0795775)*ms/(1.0-ms));
}
`;
const composite = (sky: boolean) =>
  struct +
  /* wgsl */ `
@group(0) @binding(1) var fogVolume:texture_3d<f32>;
@group(0) @binding(2) var linearSampler:sampler;
@group(0) @binding(3) var sceneDepth:texture_depth_2d;${fogAmbient(sky, 4)}
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {return vec4f(array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i],0,1);}
${displayShader}
${farAir}@fragment fn fragment(@builtin(position) position:vec4f)->@location(0) vec4f {
  let depth=textureLoad(sceneDepth,vec2i(position.xy),0);let uv=(position.xy-volume.screen.zw)/volume.screen.xy;var t=volume.shape.x;
  let ndc=vec2f(uv.x*2-1,1-uv.y*2);let n=unproject(vec3f(ndc,1));let d=unproject(vec3f(ndc,0.5))-n;let w=normalize(d);
  let a=n+d*(volume.shape.x/dot(d,volume.plane.xyz));var len=-1.0;
  if(depth>0.0){let p=volume.inverse*vec4f(ndc,depth,1);let q=p.xyz/p.w;let at=dot(volume.plane,vec4f(q,1));t=clamp(at,0.0,t);len=select(0.0,length(q-a),at>volume.shape.x);}
  let s=textureSampleLevel(fogVolume,linearSampler,vec3f(uv,(sqrt(t/volume.shape.x)*volume.grid.z-0.5)/volume.grid.z),0);
  var tail=0.0;if(len!=0.0){tail=tailDepth(a,w,len);}
  let through=exp(-s.a);let farOpacity=1.0-exp(-tail);
  var light=s.rgb;if(farOpacity>0.0){light+=through*farOpacity*farLight(w,a);}
  let opacity=1.0-through*(1.0-farOpacity);
  if(volume.wind.w<0.5&&opacity>0.0){let c=light/opacity;light=toDisplay(c)*opacity;}
  return vec4f(light,opacity);
}`;

// Fogged transparents (`fog.add`): the fog between the camera and a transparent fragment, read from the integrated
// volume where the composite reads it at the scene depth. Drawn with straight alpha over the fogged frame, whose pixel
// already holds L (light scattered in front of the fragment) plus T (transmittance to it) times what is behind, so
// a (c T + L) + (1 - a) dst equals fogging the blended result exactly. Past `range` it adds the far air in closed form
// (farAir), lit from the sky map (bindings 123 and 124; a 1 x 1 blank when the fog has no sky). jitter.w is 2 while the
// fog applies with a sky, 1 while it applies with the uniform ambient, 0 when it
// skipped the frame (disabled, no depth): then colours pass through.
const transparentSurface = (group: number) => /* wgsl */ `
struct MargoTransparent {@location(0) color:vec4f}
${struct.slice(0, struct.indexOf('@group')).replace('Volume', 'MargoFog')}
@group(${group}) @binding(120) var<uniform> margoFog:MargoFog;
@group(${group}) @binding(121) var margoFogVolume:texture_3d<f32>;
@group(${group}) @binding(122) var margoFogSampler:sampler;
@group(${group}) @binding(123) var margoFogSky:texture_2d<f32>;
@group(${group}) @binding(124) var margoFogSkySampler:sampler;
${displayShader.replaceAll('pbrNeutral', 'margoFogNeutral').replace('toDisplay', 'margoFogDisplay')}
fn margoFogAmbient(w:vec3f)->vec3f {
  let u=select(atan2(w.z,w.x)*0.15915494+0.5,0.5,abs(w.x)+abs(w.z)<1e-6);
  return select(margoFog.ambient.rgb,textureSampleLevel(margoFogSky,margoFogSkySampler,vec2f(u,0.484375),0).rgb,margoFog.jitter.w>1.5);
}
${farAir
  .replaceAll('volume.', 'margoFog.')
  .replace('fn tailDepth(', 'fn margoFogTail(')
  .replace('fn farLight(', 'fn margoFogFar(')
  .replace('fogAmbient(w)', 'margoFogAmbient(w)')}
fn margoTransparentAt(color:vec4f,clip:vec4f,depth:f32)->MargoTransparent {
  var o:MargoTransparent;o.color=color;
  let uv=(clip.xy-margoFog.screen.zw)/margoFog.screen.xy;let ndc=vec2f(uv.x*2-1,1-uv.y*2);let p=margoFog.inverse*vec4f(ndc,clip.z,1);
  let q=p.xyz/p.w;let at=dot(margoFog.plane,vec4f(q,1));let t=clamp(at,0.0,margoFog.shape.x);
  let s=textureSampleLevel(margoFogVolume,margoFogSampler,vec3f(uv,(sqrt(t/margoFog.shape.x)*margoFog.grid.z-0.5)/margoFog.grid.z),0);
  var tail=0.0;var far=vec3f(0);
  if(at>margoFog.shape.x){
    let pn=margoFog.inverse*vec4f(ndc,1,1);let n=pn.xyz/pn.w;let ph=margoFog.inverse*vec4f(ndc,0.5,1);let d=ph.xyz/ph.w-n;let w=normalize(d);
    let a=n+d*(margoFog.shape.x/dot(d,margoFog.plane.xyz));tail=margoFogTail(a,w,length(q-a));far=margoFogFar(w,a);
  }
  let through=exp(-s.a);let farOpacity=1.0-exp(-tail);let opacity=1.0-through*(1.0-farOpacity);var light=s.rgb+through*farOpacity*far;
  if(margoFog.wind.w<0.5&&opacity>0.0){light=margoFogDisplay(light/opacity)*opacity;}
  if(margoFog.jitter.w>0.5){o.color=vec4f(color.rgb*(1.0-opacity)+light,color.a);}
  return o;
}
`;
// What a gltf/pbr surface passes on to margoTransparentAt (as @margoengine/oit's surfaces do).
const pbrLayer = `fn margoTransparent(color:vec4f,i:Out)->MargoTransparent {
  return margoTransparentAt(color,i.clip,-(f.view*vec4f(i.position,1)).z);
}
`;

/** A gltf/pbr `PBRModel` or a transparent `@margoengine/materials` mesh: what `VolumetricFog.add` takes over. */
export interface FoggedModel {
  setTransparency(hook: VolumetricFog): () => void;
  onDispose(listener: () => void): () => void;
  draw(c: Context, mode: 'transparent', color: GPUTextureView, depth: GPUTextureView): void;
}
/** A `VFX`, `Splats` or `PointsPlugin`: an effect that can leave its transparent draw to a pass. */
export interface FoggedEffect {
  setTransparency(hook: SurfaceTransparency, released?: () => void): () => void;
  drawTransparent(c: Context, hook: SurfaceTransparency): void;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(Math.fround(value));
const vector = (value: Vec3 | undefined, min: number, max = Infinity): boolean =>
  value === undefined ||
  (Array.isArray(value) && value.length === 3 && value.every((v) => finite(v) && v >= min && v <= max));
// Halton 1960 low-discrepancy sequence for the froxel jitter.
const halton = (index: number, base: number): number => {
  let f = 1,
    r = 0;
  for (let i = index; i > 0; i = Math.floor(i / base)) {
    f /= base;
    r += f * (i % base);
  }
  return r;
};

/**
 * Volumetric fog and light shafts. Attach after a post capture that owns the scene target (Tonemap, Bloom, PostStack,
 * SSAO, TAA), or pass `depth`; it replaces environment `Fog` and sky's `fog` option (it throws while either is on, so the
 * scene is never fogged twice). `options` are read every frame.
 */
export class VolumetricFog implements EnginePlugin, SurfaceTransparency {
  readonly name = 'volumetric-fog';
  private engine?: Engine;
  private device?: GPUDevice;
  private uniform?: GPUBuffer;
  private sampler?: GPUSampler;
  private textures: GPUTexture[] = [];
  private gridSize: readonly number[] = [];
  private computeKey = '';
  private inject?: GPUComputePipeline;
  private integrateStep?: GPUComputePipeline;
  private injectGroups: GPUBindGroup[] = [];
  private integrateGroups: GPUBindGroup[] = [];
  private lightGroup?: { entries: GPUBindGroupEntry[]; group: GPUBindGroup };
  private shadowGroup?: { entries: GPUBindGroupEntry[]; group: GPUBindGroup };
  private mediumGroup?: { entries: GPUBindGroupEntry[]; group: GPUBindGroup };
  private readonly composites = new Map<string, GPURenderPipeline[]>();
  private compositeGroup?: {
    pipelines: GPURenderPipeline[];
    view: GPUTextureView;
    sky: GPUTexture | undefined;
    groups: GPUBindGroup[];
  };
  private skySampler?: GPUSampler;
  private injectSky?: GPUTexture;
  private entriesSky?: GPUTexture;
  private blankSky?: GPUTexture;
  private depthViews = new WeakMap<GPUTexture, GPUTextureView>();
  private frameIndex = 0;
  private valid = false;
  private viewGeometry = '';
  // Each engine view keeps its own froxel grid and history in a VolumetricFog of its own, which reads this one's live
  // options and wind offset; it is released when the view is not drawn for a frame.
  private readonly views = new ViewStates<VolumetricFog>(
    () => {
      const view = new VolumetricFog();
      (view as { options: VolumetricFogOptions }).options = this.options;
      view.offset = this.offset;
      try {
        view.setup(this.engine!);
      } catch (error) {
        view.release();
        throw error;
      }
      return view;
    },
    (view) => view.release(),
  );
  private activeView?: VolumetricFog;
  private disposed = false;
  private readonly values = new Float32Array(76);
  private readonly inverse = this.values.subarray(0, 16);
  private readonly previous = this.values.subarray(16, 32);
  private offset = [0, 0, 0];
  private elapsed = 0;
  private readonly attachment: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'load', storeOp: 'store' };
  private readonly pass: GPURenderPassDescriptor = { colorAttachments: [this.attachment] };
  private readonly models = new Map<FoggedModel, () => void>();
  private readonly effects = new Map<FoggedEffect, () => void>();
  private readonly overlay = overlayPass() as GPURenderPassDescriptor & {
    colorAttachments: [GPURenderPassColorAttachment];
    depthStencilAttachment: GPURenderPassDepthStencilAttachment;
  };
  private readonly code = new Map<number, string>();
  private readonly surfaceCode = new Map<number, string>();
  private readonly formats = new Map<string, GPUColorTargetState[]>();
  private format: GPUTextureFormat = 'rgba16float';
  private transparentPass?: GPURenderPassEncoder;
  private context?: Context;
  private entries?: GPUBindGroupEntry[];
  private readonly off = new Float32Array(1);
  /** @internal Effect hook: the bindings `surface` declares. */
  readonly layout: readonly GPUBindGroupLayoutEntry[] = [
    { binding: 120, visibility: 2, buffer: {} },
    { binding: 121, visibility: 2, texture: { viewDimension: '3d' } },
    { binding: 122, visibility: 2, sampler: {} },
    { binding: 123, visibility: 2, texture: {} },
    { binding: 124, visibility: 2, sampler: {} },
  ];

  constructor(readonly options: VolumetricFogOptions = {}) {
    this.options = preset('volumetric', options);
    this.validate();
  }
  /** Same as `engine.use(new VolumetricFog(options))`; returns the VolumetricFog. */
  static attach(engine: EngineKernel, options: VolumetricFogOptions = {}): VolumetricFog {
    const fog = new VolumetricFog(options);
    engineRuntime(engine).use(fog);
    return fog;
  }
  /** The integrated volume (rgba16float 3D, grid sized): in-scattered light (rgb) and optical depth (a) from the camera to each slice's far edge, for custom shaders (particles). Changes on grid change and device restore. */
  get texture(): GPUTexture | undefined {
    if (this.activeView) return this.activeView.texture;
    return this.textures[2];
  }

  private validate(): void {
    const o = this.options,
      grid = o.grid ?? defaultGrid;
    const scalars: [number | undefined, number, number, number][] = [
      [o.density, 0, 0, 1e3],
      [o.visibility, clearAir, koschmieder / 1e3, 1e9],
      [o.heightFalloff, 0, 0, 1e3],
      [o.height, 0, -1e9, 1e9],
      [o.anisotropy, 0.5, -0.95, 0.95],
      [o.multipleScattering, 0, 0, 1e7],
      [o.noise, 0, 0, 1],
      [o.noiseScale, 8, 1e-3, 1e6],
      [o.range, 100, 1e-3, 1e7],
      [o.temporal, 0.9, 0, 0.98],
    ];
    if (
      scalars.some(([value, fallback, min, max]) => {
        const v = value ?? fallback;
        return !finite(v) || v < min || v > max;
      }) ||
      (o.density !== undefined && o.visibility !== undefined) ||
      (o.sky !== undefined && o.sky !== null && typeof o.sky !== 'object') ||
      !vector(o.color, 0, 1) ||
      !vector(o.ambient, 0) ||
      !vector(o.wind, -Infinity) ||
      !Array.isArray(grid) ||
      grid.length !== 3 ||
      grid.some((v, i) => !Number.isInteger(v) || v < 2 || v > (i === 2 ? 256 : 512)) ||
      (o.depth !== undefined && typeof o.depth !== 'function') ||
      [o.shadows, o.lights].some(
        (s) => s !== undefined && (typeof s?.pbr !== 'function' || typeof s.bindings !== 'function'),
      ) ||
      (o.volumes !== undefined &&
        (typeof o.volumes?.medium !== 'function' || typeof o.volumes.bindings !== 'function')) ||
      (o.lightning !== undefined &&
        (typeof o.lightning !== 'object' ||
          o.lightning === null ||
          typeof o.lightning.light !== 'object' ||
          o.lightning.light === null ||
          !finite(o.lightning.albedo ?? CLOUD_ALBEDO) ||
          (o.lightning.albedo ?? CLOUD_ALBEDO) < 0 ||
          (o.lightning.albedo ?? CLOUD_ALBEDO) > 1))
    )
      throw new RangeError('Invalid volumetric fog options; pass finite, in-range values (see VolumetricFogOptions)');
  }
  /** The extinction per metre at and below `height`: `density`, or 3.912 / `visibility` (default clear air, 23 km). */
  get extinction(): number {
    const o = this.options;
    return o.density ?? koschmieder / (o.visibility ?? clearAir);
  }
  /** The height falloff per metre: `heightFalloff`, else 0 with `density` and the haze's 1 / 1,200 without. */
  get falloff(): number {
    const o = this.options;
    return o.heightFalloff ?? (o.density === undefined ? hazeFalloff : 0);
  }
  // The sky map whose horizon lights the far air: options.sky, or the scene's `sky` plugin. Reading it each frame
  // before the sky's step (onPreUpdate) keeps the sky drawing it, from the first frame on.
  // The sky map's bindings at `binding` and the next: the map, and a sampler that wraps round in azimuth.
  private skyEntries(device: GPUDevice, sky: GPUTexture | undefined, binding: number): GPUBindGroupEntry[] {
    if (!sky) return [];
    this.skySampler ??= device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat' });
    return [
      { binding, resource: sky.createView() },
      { binding: binding + 1, resource: this.skySampler },
    ];
  }
  private skyMap(): GPUTexture | undefined {
    const o = this.options.sky;
    if (o !== undefined) return o?.reflectionTexture ?? undefined;
    for (const plugin of this.engine?.plugins.values() ?? [])
      if (plugin.name === 'sky' && 'reflectionTexture' in plugin)
        return (plugin as { reflectionTexture?: GPUTexture }).reflectionTexture;
    return undefined;
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'VolumetricFog requires WebGPU and a live effect; attach a new VolumetricFog to a WebGPU engine; see https://margoengine.com/errors#webgpu',
      );
    this.engine = engine;
    this.device = engine.gpu;
    this.uniform = this.device.createBuffer({
      size: this.values.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.sampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  }
  // After opaque meshes (0), sky (2) and water (4), where sky fog would run; before VFX (6) and post (10+).
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: 5,
      execute: (c) => {
        if (c.backend !== 'webgpu') return;
        const view = this.forView(c),
          transparents = this.models.size + this.effects.size > 0;
        // A frame without fog breaks the history, so the next one starts from itself.
        if (this.options.enabled === false) view.valid = false;
        const fogged = this.options.enabled !== false && view.render(c, transparents);
        if (transparents) this.drawTransparents(c, view, fogged);
      },
    });
  }

  private forView(c: Context): VolumetricFog {
    return (this.activeView = c.view && this.views.get(c)) ?? this;
  }
  /** Seconds on the fog's wind clock: each frame update moves it (`advanceTime`), a draw does not. */
  get time(): number {
    return this.elapsed;
  }
  /** Back to time 0 and a fresh one's state, history dropped (GAP-FILM-RESET; `resetClocks` in `@margoengine/cutscene/seek`). */
  resetTime(): void {
    this.elapsed = this.frameIndex = 0;
    // In place: each view's fog shares this array.
    this.offset[0] = this.offset[1] = this.offset[2] = 0;
    this.valid = false;
    for (const view of this.views.values()) {
      view.frameIndex = 0;
      view.valid = false;
    }
  }
  /**
   * Moves the wind offset of the density noise by `wind` times `delta` seconds, without drawing (a delta of 0 or less
   * moves nothing). Each frame update runs it once, so `seek` from `@margoengine/cutscene/seek` replays
   * the drift exactly.
   */
  advanceTime(delta: number): void {
    if (!(delta > 0)) return;
    this.elapsed += delta;
    const wind = this.options.wind;
    for (let i = 0; i < 3; i++) this.offset[i] += (wind?.[i] ?? 0) * delta;
  }
  onPreUpdate(delta: number): void {
    this.advanceTime(delta);
    if (delta > 0) this.views.prune();
    if (this.options.enabled !== false) this.skyMap();
  }

  private conflicts(): void {
    for (const plugin of this.engine!.plugins.values()) {
      const p = plugin as {
        heightFalloff?: unknown;
        enabled?: unknown;
        options?: { fog?: { density?: number; depth?: unknown }; atmosphere?: { density?: number } };
      };
      if ('heightFalloff' in p && p.enabled === true)
        throw new MargoError(
          'state',
          `VolumetricFog replaces environment Fog '${plugin.name}': set its enabled = false or remove it`,
        );
      const fog = p.options?.fog;
      if (fog && typeof fog.depth === 'function' && (fog.density ?? 0.01) > 0)
        throw new MargoError('state', `VolumetricFog replaces sky fog: remove ${plugin.name}.options.fog`);
      if ((p.options?.atmosphere?.density ?? 0) > 0)
        throw new MargoError(
          'state',
          `VolumetricFog replaces creative atmosphere fog: set ${plugin.name}.options.atmosphere.density to 0`,
        );
    }
  }
  private allocate(device: GPUDevice, grid: readonly number[]): void {
    const size = [grid[0], grid[1], grid[2]],
      usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC;
    if (size.some((v) => v > device.limits.maxTextureDimension3D))
      throw new RangeError('Volumetric grid exceeds device limit; reduce the fog resolution or depth slices');
    const textures: GPUTexture[] = [];
    try {
      for (let i = 0; i < 3; i++)
        textures.push(device.createTexture({ size, dimension: '3d', format: 'rgba16float', usage }));
    } catch (error) {
      for (const texture of textures) texture.destroy();
      throw error;
    }
    for (const texture of this.textures) texture.destroy();
    this.textures = textures;
    this.gridSize = size;
    this.injectGroups = [];
    this.integrateGroups = [];
    this.compositeGroup = this.entries = undefined;
    this.valid = false;
  }
  private group(
    pipeline: GPUComputePipeline | GPURenderPipeline,
    index: number,
    entries: GPUBindGroupEntry[],
  ): GPUBindGroup {
    return this.device!.createBindGroup({ layout: pipeline.getBindGroupLayout(index), entries });
  }
  private render(c: Context, transparents = false): boolean {
    if (this.disposed || c.device !== this.device) return false;
    this.validate();
    this.conflicts();
    const rect = viewRect(c),
      geometry = [c.width, c.height, ...(rect ?? []), c.camera.fov, c.camera.near, c.camera.far].join(':');
    if (geometry !== this.viewGeometry) {
      this.valid = false;
      this.viewGeometry = geometry;
    }
    const o = this.options,
      device = c.device,
      target = sceneTarget(c);
    let depth: GPUTextureView | undefined,
      multisampled = false;
    if (o.depth) {
      const texture = o.depth();
      if (!texture) return false;
      if (
        !texture.format.startsWith('depth') ||
        texture.dimension !== '2d' ||
        texture.width !== c.width ||
        texture.height !== c.height ||
        !(texture.usage & GPUTextureUsage.TEXTURE_BINDING) ||
        (texture.sampleCount !== 1 && texture.sampleCount !== (c.descriptor.multisample?.count ?? 1))
      )
        throw new RangeError('VolumetricFog depth must be sampleable scene depth matching the viewport');
      multisampled = texture.sampleCount > 1;
      depth = this.depthView(texture);
    } else if (target) {
      // A Water drawn this frame (order 4) wrote its surface into its own copy of the scene depth, not the capture's:
      // read that copy, or every sea pixel would read as sky and take the infinite far air.
      const surface = surfaceDepth(c);
      multisampled = target.samples > 1;
      depth =
        surface?.sampleCount === target.samples
          ? this.depthView(surface)
          : multisampled
            ? target.depthSource
            : this.depthView(target.resolvedDepth);
    }
    if (!depth)
      throw new MargoError(
        'state',
        'VolumetricFog needs scene depth: attach a post capture (Tonemap, Bloom, PostStack, SSAO, TAA) first or pass options.depth',
      );
    if (!invertMatrix(c.camera.matrix, this.inverse)) return false;
    const grid = o.grid ?? defaultGrid;
    if (grid[0] !== this.gridSize[0] || grid[1] !== this.gridSize[1] || grid[2] !== this.gridSize[2])
      this.allocate(device, grid);
    const lights = o.lights?.pbr(1).declarations,
      shadows = o.shadows?.pbr(lights ? 2 : 1).declarations,
      medium = o.volumes?.medium(1 + +!!lights + +!!shadows),
      ms = (o.multipleScattering ?? 0) > 0,
      own = compatTier(device) === 'webgl2',
      // The sky lights the fog (its ambient, near and far) unless `ambient` is given.
      sky = o.ambient ? undefined : this.skyMap(),
      key =
        (sky ? 'sky' : '') +
        (lights ?? '') +
        '\0' +
        (shadows ?? '') +
        (medium === undefined ? '' : '\0' + medium) +
        (ms ? '\0ms' : '') +
        (own ? '\0own' : '');
    if (key !== this.computeKey || !this.inject) {
      const module = device.createShaderModule({ code: compute(lights, shadows, medium, ms, own, !!sky) });
      this.inject = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'inject' } });
      this.integrateStep = device.createComputePipeline({
        layout: 'auto',
        compute: { module, entryPoint: 'integrate' },
      });
      this.computeKey = key;
      this.injectGroups = [];
      this.integrateGroups = [];
      this.lightGroup = this.shadowGroup = this.mediumGroup = undefined;
    }
    if (!this.injectGroups.length || this.injectSky !== sky) {
      const views = this.textures.map((t) => t.createView()),
        uniform = { binding: 0, resource: { buffer: this.uniform! } },
        injectGroups: GPUBindGroup[] = [],
        integrateGroups: GPUBindGroup[] = [];
      for (let i = 0; i < 2; i++) {
        injectGroups.push(
          this.group(this.inject, 0, [
            uniform,
            { binding: 1, resource: views[1 - i] },
            { binding: 2, resource: this.sampler! },
            { binding: 3, resource: views[i] },
            ...this.skyEntries(device, sky, 6),
          ]),
        );
        integrateGroups.push(
          this.group(this.integrateStep!, 0, [
            uniform,
            { binding: 2, resource: this.sampler! },
            { binding: 4, resource: views[i] },
            { binding: 5, resource: views[2] },
          ]),
        );
      }
      this.injectGroups = injectGroups;
      this.injectSky = sky;
      this.integrateGroups = integrateGroups;
    }
    // Uniform: matrices, near planes, grid, density shape, scattering, sun (w: multiple scattering), ambient, noise, jitter, screen.
    const m = c.camera.matrix,
      v = this.values,
      w = Math.hypot(m[3] - m[2], m[7] - m[6], m[11] - m[10]),
      temporal = o.temporal ?? 0.9;
    for (let i = 0; i < 4; i++) v[32 + i] = (m[i * 4 + 3] - m[i * 4 + 2]) / w;
    v[40] = grid[0];
    v[41] = grid[1];
    v[42] = grid[2];
    v[43] = this.valid ? temporal : 0;
    v[44] = o.range ?? 100;
    v[45] = this.extinction;
    v[46] = this.falloff;
    v[47] = o.height ?? 0;
    v.set(o.color ?? white, 48);
    v[51] = o.anisotropy ?? 0.5;
    v[55] = o.multipleScattering ?? 0;
    const lighting = this.engine!.lighting,
      direction = lighting.direction,
      radiance = lighting.radiance,
      length = Math.hypot(direction[0], direction[1], direction[2]),
      sun = length > 0 ? Math.max(0, direction[3]) : 0,
      flash = o.lightning,
      bolt = flash?.light,
      // The deck the flash lights sends rho E / (2 pi) back down to the fog (VolumetricFogLightning).
      deck =
        bolt && bolt.intensity > 0
          ? ((flash!.albedo ?? CLOUD_ALBEDO) * bolt.intensity) /
            (2 *
              Math.PI *
              Math.max(
                1,
                (bolt.position[0] - c.camera.position[0]) ** 2 +
                  (bolt.position[1] - c.camera.position[1]) ** 2 +
                  (bolt.position[2] - c.camera.position[2]) ** 2,
              ))
          : 0;
    for (let i = 0; i < 3; i++) {
      v[52 + i] = sun ? direction[i] / length : 0;
      v[56 + i] = radiance[i] * sun;
      v[60 + i] = (o.ambient?.[i] ?? radiance[3]) + (deck ? deck * bolt!.color[i] : 0);
      v[64 + i] = this.offset[i];
    }
    v[59] = o.noise ?? 0;
    v[63] = 1 / (o.noiseScale ?? 8);
    v[67] = +linearHdr(c.format);
    const frame = (this.frameIndex % 16) + 1;
    for (let i = 0; i < 3; i++) v[68 + i] = temporal > 0 ? halton(frame, jitterBases[i]) - 0.5 : 0;
    // 2: fogged transparents read the sky map for the far air's light; 1: the uniform ambient.
    v[71] = transparents ? (sky ? 2 : 1) : 0;
    v[72] = rect?.[2] ?? c.width;
    v[73] = rect?.[3] ?? c.height;
    v[74] = rect?.[0] ?? 0;
    v[75] = rect?.[1] ?? 0;
    device.queue.writeBuffer(this.uniform!, 0, v as Float32Array<ArrayBuffer>);
    // Froxel lighting and reprojection, then the per-column integration.
    const parity = this.frameIndex & 1,
      pass = c.encoder.beginComputePass();
    pass.setPipeline(this.inject);
    pass.setBindGroup(0, this.injectGroups[parity]);
    let index = 1;
    for (const [source, slot] of [
      [o.lights, 'lightGroup'],
      [o.shadows, 'shadowGroup'],
    ] as const) {
      if (!source) continue;
      const entries = source.bindings();
      if (this[slot]?.entries !== entries) this[slot] = { entries, group: this.group(this.inject, index, entries) };
      pass.setBindGroup(index++, this[slot]!.group);
    }
    if (o.volumes) {
      const entries = o.volumes.bindings(device);
      if (this.mediumGroup?.entries !== entries)
        this.mediumGroup = { entries, group: this.group(this.inject, index, entries) };
      pass.setBindGroup(index, this.mediumGroup.group);
    }
    pass.dispatchWorkgroups(Math.ceil(grid[0] / 4), Math.ceil(grid[1] / 4), Math.ceil(grid[2] / 4));
    pass.setPipeline(this.integrateStep!);
    pass.setBindGroup(0, this.integrateGroups[parity]);
    if (own) pass.dispatchWorkgroups(Math.ceil(grid[0] / 4), Math.ceil(grid[1] / 4), Math.ceil(grid[2] / 4));
    else pass.dispatchWorkgroups(Math.ceil(grid[0] / 8), Math.ceil(grid[1] / 8));
    pass.end();
    // Composite over the scene target (per sample when the depth is multisampled).
    const samples = c.descriptor.multisample?.count ?? 1,
      compositeKey = c.format + ':' + samples + ':' + multisampled + (sky ? ':sky' : '');
    let pipelines = this.composites.get(compositeKey);
    if (!pipelines) {
      // One draw reading sample_index, or at the compatibility level, which has none, one masked draw per sample.
      pipelines = (multisampled ? perSample(device, samples) : [null]).map((sample) => {
        const shader = composite(!!sky),
          code = !multisampled
            ? shader
            : sample !== null
              ? shader
                  .replace('sceneDepth:texture_depth_2d', 'sceneDepth:texture_depth_multisampled_2d')
                  .replace('vec2i(position.xy),0)', `vec2i(position.xy),${sample})`)
              : shader
                  .replace('sceneDepth:texture_depth_2d', 'sceneDepth:texture_depth_multisampled_2d')
                  .replace('position:vec4f)', 'position:vec4f,@builtin(sample_index) sample:u32)')
                  .replace('vec2i(position.xy),0)', 'vec2i(position.xy),i32(sample))');
        const module = device.createShaderModule({ code }),
          blend: GPUBlendComponent = { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' };
        return device.createRenderPipeline({
          layout: 'auto',
          vertex: { module, entryPoint: 'vertex' },
          fragment: {
            module,
            entryPoint: 'fragment',
            targets: [{ format: c.format, blend: { color: blend, alpha: blend } }],
          },
          multisample: sample === null ? { count: samples } : { count: samples, mask: 1 << sample },
        });
      });
      this.composites.set(compositeKey, pipelines);
    }
    if (
      this.compositeGroup?.pipelines !== pipelines ||
      this.compositeGroup.view !== depth ||
      this.compositeGroup.sky !== sky
    ) {
      const volume = this.textures[2].createView(),
        entries: GPUBindGroupEntry[] = [
          { binding: 0, resource: { buffer: this.uniform! } },
          { binding: 1, resource: volume },
          { binding: 2, resource: this.sampler! },
          { binding: 3, resource: depth },
        ];
      entries.push(...this.skyEntries(device, sky, 4));
      this.compositeGroup = {
        pipelines,
        view: depth,
        sky,
        groups: pipelines.map((pipeline) => this.group(pipeline, 0, entries)),
      };
    }
    this.attachment.view = c.color;
    const draw = c.encoder.beginRenderPass(this.pass);
    applyView(draw, c);
    for (let i = 0; i < pipelines.length; i++) {
      draw.setPipeline(pipelines[i]);
      draw.setBindGroup(0, this.compositeGroup.groups[i]);
      draw.draw(3);
    }
    draw.end();
    this.previous.set(m);
    v.copyWithin(36, 32, 36);
    this.valid = true;
    this.frameIndex++;
    return true;
  }
  /**
   * Fogs a transparent drawable: a gltf/pbr model's BLEND primitives (or a transparent `@margoengine/materials` mesh),
   * or a `VFX`, `Splats` or `PointsPlugin`'s normally blended particles, splats and sprites. The fog takes over its
   * transparent draw and runs it right after the fog's composite, depth tested against the scene and not written, each
   * fragment fogged by the volume between the camera and it. Additive and multiply surfaces, native transmission and
   * additive point sprites keep their own draw. Returns a remover; disposing either side removes it too.
   * @throws TypeError for anything else; MargoError `'disposed'` after `dispose()`, `'state'` before `attach`.
   */
  add(target: FoggedModel | FoggedEffect): () => void {
    if (this.disposed || !this.engine)
      throw new MargoError(
        this.disposed ? 'disposed' : 'state',
        this.disposed ? 'VolumetricFog is disposed; create a new one' : 'VolumetricFog.add needs attach(engine) first',
      );
    const effect = typeof (target as FoggedEffect)?.drawTransparent === 'function';
    if (
      typeof target?.setTransparency !== 'function' ||
      (!effect &&
        (typeof (target as FoggedModel).draw !== 'function' || typeof (target as FoggedModel).onDispose !== 'function'))
    )
      throw new TypeError('VolumetricFog.add needs a gltf/pbr model, a materials mesh, VFX, Splats or a PointsPlugin');
    const map = (effect ? this.effects : this.models) as Map<object, () => void>;
    let release = map.get(target);
    if (!release) {
      const drop = () => {
        if (map.get(target) === release) map.delete(target);
      };
      let forget = () => {},
        restore: () => void;
      if (effect) restore = (target as FoggedEffect).setTransparency(this, drop);
      else {
        restore = (target as FoggedModel).setTransparency(this);
        forget = (target as FoggedModel).onDispose(drop);
      }
      const remove = () => {
        if (map.get(target) !== remove) return;
        map.delete(target);
        forget();
        restore();
      };
      map.set(target, (release = remove));
    }
    return release;
  }
  /** @internal gltf\/pbr transparency hook. */
  declarations(group: number): string {
    return groupCode(this.code, group, (g) => transparentSurface(g) + pbrLayer);
  }
  /** @internal Effect hook. */
  surface(group: number): string {
    return groupCode(this.surfaceCode, group, transparentSurface);
  }
  /** @internal Both hooks: this view's uniform, integrated volume and sampler. */
  bindings(): GPUBindGroupEntry[] {
    const view = this.activeView ?? this,
      device = this.device!,
      sky =
        view.injectSky ??
        (this.blankSky ??= device.createTexture({
          size: [1, 1],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING,
        }));
    if (view.entries && view.entriesSky !== sky) view.entries = undefined;
    view.entriesSky = sky;
    view.skySampler ??= device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat' });
    return (view.entries ??= [
      { binding: 120, resource: { buffer: view.uniform! } },
      { binding: 121, resource: view.textures[2].createView() },
      { binding: 122, resource: view.sampler! },
      { binding: 123, resource: sky.createView() },
      { binding: 124, resource: view.skySampler },
    ]);
  }
  /** @internal Both hooks: straight alpha into the frame's colour target. */
  get targets(): readonly GPUColorTargetState[] {
    let targets = this.formats.get(this.format);
    if (!targets) this.formats.set(this.format, (targets = [{ format: this.format, blend: alphaBlend }]));
    return targets;
  }
  /** @internal Both hooks: this frame's transparent pass over the fogged frame, depth read only. */
  begin(): GPURenderPassEncoder {
    if (this.transparentPass) return this.transparentPass;
    const c = this.context!;
    this.overlay.colorAttachments[0].view = c.color;
    this.overlay.depthStencilAttachment.view = c.depth;
    const pass = (this.transparentPass = c.encoder.beginRenderPass(this.overlay));
    applyView(pass, c);
    return pass;
  }
  private drawTransparents(c: Context, view: VolumetricFog, fogged: boolean): void {
    if (this.disposed || c.device !== this.device) return;
    if (!fogged) {
      // Not fogged this frame: the colours pass through (jitter.w 0), read from a volume that must exist to bind.
      if (!view.textures.length) view.allocate(c.device, this.options.grid ?? defaultGrid);
      c.device.queue.writeBuffer(view.uniform!, 284, this.off);
    }
    this.format = c.format as GPUTextureFormat;
    this.context = c;
    try {
      for (const model of this.models.keys()) model.draw(c, 'transparent', c.color, c.depth);
      for (const effect of this.effects.keys()) effect.drawTransparent(c, this);
    } finally {
      this.transparentPass?.end();
      this.transparentPass = this.context = undefined;
    }
  }
  private depthView(texture: GPUTexture): GPUTextureView {
    let view = this.depthViews.get(texture);
    if (!view) this.depthViews.set(texture, (view = texture.createView({ aspect: 'depth-only' })));
    return view;
  }
  private release(): void {
    this.views.clear();
    this.activeView = undefined;
    for (const texture of this.textures) texture.destroy();
    this.uniform?.destroy();
    this.textures = [];
    this.blankSky?.destroy();
    this.uniform =
      this.sampler =
      this.skySampler =
      this.inject =
      this.integrateStep =
      this.injectSky =
      this.entriesSky =
      this.blankSky =
        undefined;
    this.gridSize = [];
    this.computeKey = '';
    this.injectGroups = [];
    this.integrateGroups = [];
    this.lightGroup = this.shadowGroup = this.mediumGroup = this.compositeGroup = this.entries = undefined;
    this.composites.clear();
    this.depthViews = new WeakMap();
    this.valid = false;
    this.viewGeometry = '';
    this.frameIndex = 0;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const release of [...this.models.values(), ...this.effects.values()]) release();
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.engine = this.device = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
