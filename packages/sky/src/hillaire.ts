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
import { overlayPass } from '../../shared/pass.js';
import { applyView } from '../../shared/view-rect.js';
import {
  AtmosphereTables,
  atmosphereCommon,
  atmosphereLookups,
  atmosphereParameters,
  type AtmosphereParameters,
} from './atmosphere-luts.js';
import { sunDirection } from './clock.js';
import { night } from './night.js';
import type { SkyNightOptions } from './base.js';
export { EARTH_ATMOSPHERE, atmosphereParameters, type AtmosphereParameters } from './atmosphere-luts.js';
declare const GPUTextureUsage: { STORAGE_BINDING: number; TEXTURE_BINDING: number };
declare const GPUBufferUsage: {
  STORAGE: number;
  COPY_SRC: number;
  COPY_DST: number;
  MAP_READ: number;
  UNIFORM: number;
};
declare const GPUMapMode: { READ: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;
/** {@link HillaireSky} settings, read every frame from `sky.options`. */
export interface HillaireSkyOptions {
  /** Clock time in hours, 0 to 24, moving the sun as `Sky` does (rises at 6 in +x, noon overhead). Default 12. */
  hours?: number;
  /** Clock hours per second. Default 1 / 3600 (real time); 0 holds the time. */
  timeScale?: number;
  /** Direction toward the sun, in place of the clock; normalized. */
  sunDirection?: Vec3;
  /** Exposure in stops: the sky is multiplied by 2^exposure. Default 0. */
  exposure?: number;
  /** Sun illuminance at the top of the atmosphere, in the scene's light units. Default 20 (the Bruneton `Sky`'s scale). */
  sunIlluminance?: number;
  /** Metres per world unit, above 0 and at most 1,000,000. Default 1. */
  metersPerUnit?: number;
  /** Metres added to the camera's height above the ground, 0 to 100,000,000 (space). Default 0. */
  altitude?: number;
  /** Draw the sun's disc (0.27 degrees in radius, dimmed by the air in front of it). Default true. */
  sunDisc?: boolean;
  /** The planet's air, kilometres (Hillaire 2020); default Earth. Read when it changes. */
  atmosphere?: AtmosphereParameters;
}
const W = 192,
  H = 108,
  // The sun's angular radius, radians: 0.2666 degrees.
  SUN = 0.004653;
// WGSL shared by the sky-view table and the sky: the part of a ray inside the air (start, end, 1 when the ground ends
// it), the light it gathers with the sunlit ground it may end on (Lambert, the ground albedo), and the sun's azimuth.
const skyAlong = /* wgsl */ `
fn airSegment(a:Atmosphere,o:vec3f,d:vec3f)->vec3f {
 let l=length(o);let b=dot(o,d);let c=(l-a.radii.y)*(l+a.radii.y);let disc=b*b-c;if(disc<0.0){return vec3f(0,-1,0);}
 let s=sqrt(disc);let t1=-b+s;if(t1<=0.0){return vec3f(0,-1,0);}let g=sphereHit(o,d,a.radii.x);
 return select(vec3f(max(-b-s,0.0),t1,0),vec3f(max(-b-s,0.0),g,1),g>=0.0);
}
fn skyAlong(a:Atmosphere,o:vec3f,d:vec3f,n:u32)->array<vec3f,2> {
 let seg=airSegment(a,o,d);if(seg.y<=seg.x){return array<vec3f,2>(vec3f(0),vec3f(1));}
 var r=integrateScattering(a,o+d*seg.x,d,seg.y-seg.x,n,vec3f(1));
 if(seg.z>0.5){let up=normalize(o+d*seg.y);let mu=dot(up,a.sun.xyz);r[0]+=r[1]*transmittanceToTop(a,a.radii.x,mu)*max(mu,0.0)*a.ground.rgb/PI*a.radii.z;}
 return r;
}
fn sunAzimuth(a:Atmosphere)->vec2f {let h=length(a.sun.xz);return select(vec2f(1,0),a.sun.xz/h,h>1e-5);}
fn horizonZenith(a:Atmosphere)->f32 {return PI-asin(clamp(a.radii.x/a.view.y,0.0,1.0));}
`;
const tables = /* wgsl */ `${atmosphereCommon}
@group(0) @binding(0) var<uniform> atmosphere:Atmosphere;
@group(0) @binding(1) var transmittanceTable:texture_2d<f32>;
@group(0) @binding(2) var multipleTable:texture_2d<f32>;
@group(0) @binding(3) var lutSampler:sampler;
`;
/** Settings for a one-shot, linear HDR environment bake. No sun disc is baked. */
export interface HillaireEnvironmentOptions {
  /** Equirectangular columns, integer 1 to 2048. Default 256. */
  width?: number;
  /** Equirectangular rows, integer 1 to 1024. Default 128. */
  height?: number;
  /** Normalized internally; overrides hours. Default: the clock at noon. */
  sunDirection?: Vec3;
  /** Clock time in hours; wraps at 24. Default 12. */
  hours?: number;
  /** Height above the planet in metres, 0 to 100000000. Default 0. */
  altitude?: number;
  /** Sun illuminance above the atmosphere, 0 to 1000000. Default 20. */
  sunIlluminance?: number;
  /** Atmosphere; default Earth. Coefficients/albedo 0 to 1, radii at most 100000 km, vertical scattering depth at most 6. */
  atmosphere?: AtmosphereParameters;
  /** Include Hillaire's multiple-scattering table. False gives single scattering for comparisons. Default true. */
  multipleScattering?: boolean;
  /** Existing stylized night options, fixed at time zero with twinkle disabled. False disables night. Default {}. */
  night?: SkyNightOptions | false;
  /** Cancels compilation or readback and releases all temporary GPU resources. */
  signal?: AbortSignal;
}

/** Linear RGBA float environment, y-up: centre column -Z, three-quarter column +X. */
export interface HillaireEnvironment {
  /** Number of equirectangular columns. */
  width: number;
  /** Number of rows, from zenith to nadir. */
  height: number;
  /** Owned linear RGBA float texels; alpha is one. */
  data: Float32Array;
  /** Unit direction toward the separate sun. */
  sunDirection: Vec3;
  /** Sun transmittance from the bake altitude through the atmosphere. */
  sunColor: Vec3;
  /** Sun illuminance above the atmosphere. */
  sunIntensity: number;
}

const bakeShader = /* wgsl */ `${tables}
struct Bake {size:vec4f,nightZenith:vec4f,nightHorizon:vec4f,nightMoon:vec4f,nightMoonColor:vec4f,nightParams:vec4f,sunlight:vec4f,sun:vec4f}
@group(0) @binding(4) var<uniform> frame:Bake;
@group(0) @binding(5) var<storage,read_write> result:array<vec4f>;
${atmosphereLookups}${skyAlong}${night.wgsl}
fn bakedNight(d:vec3f,footprint:f32)->vec3f {
 var light=stylizedNight(d,footprint);
 if(d.y>0.258819){
  let scale=434.0/(1.0+d.y);let radius=max(0.0003,footprint*0.7);let size=radius*scale;
  // Unresolved cells retain their integrated starlight instead of disappearing.
  // Integral of 1-smoothstep(0,2s,r) on the plane is 1.2*pi*s*s.
  // E[random * 0.5 * (random > .975)] = (1-.975^2)/4.
  let mean=1.2*PI*0.0003*0.0003*scale*scale*0.01234375;
  let moon=clamp(dot(d,frame.nightMoon.xyz),-1.0,1.0);
  light+=vec3f(0.8,0.9,1.0)*mean*frame.nightParams.z*smoothstep(0.35,0.5,size)*smoothstep(0.258819,0.5,d.y)*(1.0-smoothstep(0.96,1.0,moon));
 }
 return light;
}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=vec2u(frame.size.xy))){return;}
 let uv=(vec2f(id.xy)+0.5)/frame.size.xy;let phi=(uv.x-0.5)*2.0*PI;let theta=uv.y*PI;
 let d=vec3f(sin(theta)*sin(phi),cos(theta),-sin(theta)*cos(phi));let a=atmosphere;
 let o=vec3f(0,a.view.y,0);let seg=airSegment(a,o,d);
 var light=skyAlong(a,o,d,64u)[0];
 // The planet hides the stars and moon. Retain twilight scattering, adding night as the sun sets.
 if(seg.z<0.5){let fade=1.0-smoothstep(-0.2,0.0,a.sun.y);let footprint=max(PI/frame.size.y,2.0*PI*sin(theta)/frame.size.x);light+=bakedNight(d,footprint)*frame.size.z*fade;}
 result[id.y*u32(frame.size.x)+id.x]=vec4f(light,1);
}
`;

/**
 * Bake the existing Hillaire atmosphere and night model on a WebGPU device.
 * Returns owned CPU floats; every temporary GPU allocation is released before settlement.
 * A plain WebGL2 context is refused with a coded error; a WebGL2 compatibility GPUDevice works.
 */
export async function bakeHillaireEnvironment(
  device: GPUDevice,
  options: HillaireEnvironmentOptions = {},
): Promise<HillaireEnvironment> {
  if (!options || typeof options !== 'object') throw new TypeError('Hillaire environment options must be an object');
  const { width = 256, height = 128, signal } = options;
  signal?.throwIfAborted();
  if (!Number.isInteger(width) || width < 1 || width > 2048 || !Number.isInteger(height) || height < 1 || height > 1024)
    throw new RangeError('Hillaire environment dimensions must be integers: width 1 to 2048, height 1 to 1024');
  if (options.multipleScattering !== undefined && typeof options.multipleScattering !== 'boolean')
    throw new TypeError('Hillaire environment multipleScattering must be boolean');
  if (options.night !== undefined && options.night !== false && (!options.night || typeof options.night !== 'object'))
    throw new TypeError('Hillaire environment night must be an options object or false');
  const sky = new HillaireSky({
    sunDirection: options.sunDirection,
    hours: options.hours,
    altitude: options.altitude,
    sunIlluminance: options.sunIlluminance,
    atmosphere: options.atmosphere,
  });
  const a = sky.resolvedAtmosphere;
  if (!(Math.fround(a.topRadius) > Math.fround(a.bottomRadius)))
    throw new RangeError('Hillaire environment atmosphere thickness must survive Float32 rounding; increase topRadius');
  // The LUTs use Float32 distances and half-float radiance. Keep the bake in their documented physical domain.
  if (
    a.topRadius > 100000 ||
    a.rayleighHeight > 100000 ||
    a.mieHeight > 100000 ||
    a.ozoneCenter > 100000 ||
    a.ozoneWidth > 100000 ||
    [
      ...a.rayleigh,
      ...a.ozone,
      ...(typeof a.mie === 'number' ? [a.mie] : a.mie),
      ...(typeof a.mieAbsorption === 'number' ? [a.mieAbsorption] : a.mieAbsorption),
      ...a.groundAlbedo,
    ].some((v) => v > 1)
  )
    throw new RangeError(
      'Hillaire environment atmosphere exceeds the bake domain; use radii/heights at most 100000 km and coefficients/albedo at most 1',
    );
  const n = options.night === false ? {} : (options.night ?? {});
  // A geometric series needs a representable escape probability. With vertical
  // scattering depth <= 6, the LUT's upward quarter-sphere (mu >= .625) keeps
  // escape >= exp(-6/.625)/4, well above Float32 subtraction error at one.
  const shell = a.topRadius - a.bottomRadius;
  const rayleighColumn = -a.rayleighHeight * Math.expm1(-shell / a.rayleighHeight);
  const mieColumn = -a.mieHeight * Math.expm1(-shell / a.mieHeight);
  if (a.rayleigh.some((v, c) => v * rayleighColumn + (typeof a.mie === 'number' ? a.mie : a.mie[c]) * mieColumn > 6))
    throw new RangeError(
      'Hillaire environment vertical scattering depth must be at most 6; reduce scattering or scale heights',
    );
  night.validate(n);
  if (n.moonSize !== undefined && n.moonSize < 1e-6)
    throw new RangeError('Hillaire environment moonSize must be at least 0.000001 radians; use a resolvable radius');
  for (const [key, value] of Object.entries(n)) {
    const values = Array.isArray(value) ? value : typeof value === 'number' ? [value] : [];
    if (key !== 'moonDirection' && values.some((v) => Math.abs(v) > 1000000))
      throw new RangeError('Hillaire environment night parameters must have magnitude at most 1000000');
  }
  if (!device || typeof device.createComputePipelineAsync !== 'function' || typeof device.createBuffer !== 'function')
    throw new MargoError(
      'unsupported',
      'Hillaire environment needs a WebGPU GPUDevice; see https://margoengine.com/errors#sky',
    );
  const bytes = width * height * 16;
  if (bytes > device.limits.maxStorageBufferBindingSize || bytes > device.limits.maxBufferSize)
    throw new RangeError('Hillaire environment exceeds the device buffer limit; reduce width or height');
  const table = new AtmosphereTables(device);
  const resources: GPUBuffer[] = [];
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal!.reason);
    signal?.addEventListener('abort', abort, { once: true });
  });
  const wait = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, cancelled]);
  try {
    table.medium(a as Required<AtmosphereParameters>, 1);
    table.values[34] = sky.sunIlluminance;
    table.values.set(sky.sun, 36);
    // Stay above the surface after Float32 rounding, also for large planets.
    const clearance = Math.max(0.001, a.bottomRadius * 2 ** -22);
    table.values[45] = a.bottomRadius + Math.max(clearance, (options.altitude ?? 0) / 1000);
    const values = new Float32Array(32),
      original = new Float32Array(64);
    night.write(original, { ...n, starTwinkleIntensity: 0 }, 0);
    values.set([width, height, +(options.night !== false), 0]);
    values.set(original.subarray(40, 64), 4);
    values.set(sky.sun, 28);
    const buffer = (size: number, usage: number) => {
      const b = device.createBuffer({ size, usage });
      resources.push(b);
      return b;
    };
    const params = buffer(values.byteLength, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const output = buffer(bytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const read = buffer(bytes, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(params, 0, values);
    // Disabling higher orders changes only the lookup contribution, never the atmospheric ray march.
    const code =
      options.multipleScattering === false
        ? bakeShader.replace('(sr+sm)*multipleScattering(a,r,dot(up,a.sun.xyz))', 'vec3f(0)')
        : bakeShader;
    const pipeline = await wait(
      device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module: device.createShaderModule({ code }), entryPoint: 'main' },
      }),
    );
    signal?.throwIfAborted();
    const encoder = device.createCommandEncoder();
    table.upload(encoder);
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: table.uniform } },
      { binding: 1, resource: table.transmittance.createView() },
      ...(options.multipleScattering === false ? [] : [{ binding: 2, resource: table.multiple.createView() }]),
      { binding: 3, resource: table.sampler },
      { binding: 4, resource: { buffer: params } },
      { binding: 5, resource: { buffer: output } },
    ];
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }));
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    pass.end();
    encoder.copyBufferToBuffer(output, 0, read, 0, bytes);
    device.queue.submit([encoder.finish()]);
    await wait(read.mapAsync(GPUMapMode.READ));
    signal?.throwIfAborted();
    const data = new Float32Array(read.getMappedRange().slice(0));
    read.unmap();
    const sunColor = new Float32Array(3);
    sunThrough(a as Required<AtmosphereParameters>, table.values[45], sky.sun[1], sunColor);
    return {
      width,
      height,
      data,
      sunDirection: [sky.sun[0], sky.sun[1], sky.sun[2]],
      sunColor: [sunColor[0], sunColor[1], sunColor[2]],
      sunIntensity: sky.sunIlluminance,
    };
  } finally {
    if (abort) signal?.removeEventListener('abort', abort);
    for (const buffer of resources) buffer.destroy();
    table.dispose();
    sky.dispose();
  }
}
// The sky-view table (Hillaire 2020 sec. 5.2): the sky around the camera by azimuth from the sun (0 to 180 degrees, the
// air being symmetric about the sun's plane) and zenith angle, squeezed toward the horizon, where the colour changes
// fastest: row v above the horizon is zenith angle h (1 - (1 - 2v)^2), below it h + (180 - h)(2v - 1)^2, where h is the
// horizon's zenith angle from the camera's height. 30 steps per texel, every frame.
const skyViewShader = /* wgsl */ `${tables}
@group(0) @binding(4) var skyView:texture_storage_2d<rgba16float,write>;
${atmosphereLookups}${skyAlong}
@compute @workgroup_size(8,4) fn main(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=${W}u||id.y>=${H}u){return;}let a=atmosphere;let zh=horizonZenith(a);
 let phi=f32(id.x)/${W - 1}.0*PI;let v=(f32(id.y)+0.5)/${H}.0;
 var theta=0.0;if(v<0.5){let t=1.0-2.0*v;theta=zh*(1.0-t*t);}else{let t=2.0*v-1.0;theta=zh+(PI-zh)*t*t;}
 let s=sunAzimuth(a);let st=sin(theta);let d=vec3f(st*(cos(phi)*s.x-sin(phi)*s.y),cos(theta),st*(cos(phi)*s.y+sin(phi)*s.x));
 textureStore(skyView,vec2i(id.xy),vec4f(skyAlong(a,vec3f(0,a.view.y,0),d,30u)[0],1));
}
`;
// The sky behind the scene: inside the air from the sky-view table, from space by marching each pixel's ray through
// the air (32 steps), plus the sun's disc through the air in front of it. view.y is the camera's radius, view.w the
// disc switch. Only where the scene left depth clear (reversed Z: 0), as the root Sky. The disc's true radiance (about
// 3e5 at illuminance 20) is past half-float range, so the light is held at 65504, the largest half float.
const drawShader = /* wgsl */ `${fullscreen}${tables}${displayShader}
@group(0) @binding(4) var skyView:texture_2d<f32>;
${atmosphereLookups}${skyAlong}
fn skyViewUV(a:Atmosphere,d:vec3f)->vec2f {
 let zh=horizonZenith(a);let theta=acos(clamp(d.y,-1.0,1.0));
 let v=select((1.0+sqrt(max((theta-zh)/(PI-zh),0.0)))*0.5,(1.0-sqrt(max(1.0-theta/zh,0.0)))*0.5,theta<zh);
 let h=length(d.xz);let phi=select(0.0,acos(clamp(dot(d.xz/h,sunAzimuth(a)),-1.0,1.0)),h>1e-5);
 return vec2f((phi/PI*${W - 1}.0+0.5)/${W}.0,v);
}
@fragment fn fragment(i:Vertex)->@location(0) vec4f {
 let a=atmosphere;let ndc=vec2f(i.uv.x*2.0-1.0,1.0-i.uv.y*2.0);
 let pf=a.inverse*vec4f(ndc,0.000001,1);let pn=a.inverse*vec4f(ndc,1.0,1);let d=normalize(pf.xyz/pf.w-pn.xyz/pn.w);
 let o=vec3f(0,a.view.y,0);var light=vec3f(0);var through=vec3f(1);
 if(a.view.y<a.radii.y){light=textureSampleLevel(skyView,lutSampler,skyViewUV(a,d),0.0).rgb;through=transmittanceToTop(a,a.view.y,d.y);}
 else{let s=skyAlong(a,o,d,32u);light=s[0];through=s[1];}
 let q=sqrt(2.0*max(1.0-dot(d,a.sun.xyz),0.0));let disc=clamp(((${SUN}-q)/${SUN * 0.1}+0.5),0.0,1.0)*a.view.w;
 if(sphereHit(o,d,a.radii.x)<0.0){light+=through*a.radii.z*disc/(PI*${SUN}*${SUN});}
 light=min(light*a.sun.w,vec3f(65504.0));if(a.view.z>0.5){light=toDisplay(light);}return vec4f(light,1);
}
`;
const inRange = (value: number, low: number, high: number) => Number.isFinite(value) && value >= low && value <= high;
/**
 * Light from the sun reaching a point `r` km from the planet's centre with the sun's zenith cosine `mu`, through
 * `a`: Beer-Lambert over 256 midpoint steps spaced as the square of their index, dense near the camera where the air
 * is thickest, 0 behind the planet. Writes rgb into `out`.
 */
function sunThrough(a: Required<AtmosphereParameters>, r: number, mu: number, out: Float32Array): void {
  const b = r * mu,
    disc = b * b - (r - a.topRadius) * (r + a.topRadius);
  out.fill(1);
  if (mu < 0 && r * r * (1 - mu * mu) < a.bottomRadius * a.bottomRadius) {
    out.fill(0);
    return;
  }
  if (disc < 0 || -b + Math.sqrt(disc) <= 0) return;
  const start = Math.max(-b - Math.sqrt(disc), 0),
    length = -b + Math.sqrt(disc) - start,
    depth = [0, 0, 0];
  for (let i = 0; i < 256; i++) {
    const u = (i + 0.5) / 256,
      t = start + length * u * u,
      dt = (2 * length * u) / 256,
      h = Math.sqrt(r * r + t * t + 2 * r * t * mu) - a.bottomRadius,
      rayleigh = Math.exp(-h / a.rayleighHeight),
      mie = Math.exp(-h / a.mieHeight),
      ozone = Math.max(0, 1 - Math.abs(h - a.ozoneCenter) / a.ozoneWidth);
    for (let c = 0; c < 3; c++) {
      const scatter = typeof a.mie === 'number' ? a.mie : a.mie[c],
        absorb = typeof a.mieAbsorption === 'number' ? a.mieAbsorption : a.mieAbsorption[c];
      depth[c] += (a.rayleigh[c] * rayleigh + (scatter + absorb) * mie + a.ozone[c] * ozone) * dt;
    }
  }
  for (let c = 0; c < 3; c++) out[c] = Math.exp(-depth[c]);
}
/**
 * A physically based sky from the ground to space (Hillaire 2020, "A Scalable and Production Ready Sky and Atmosphere
 * Rendering Technique"): Rayleigh, Mie and ozone, single scattering toward the sun plus multiple scattering, with
 * transmittance (256 x 64) and multiple scattering (32 x 32) tables made once per atmosphere and a 192 x 108 sky-view
 * table each frame. Above the atmosphere the sky marches each pixel instead, so the planet's lit limb and its
 * ground show from orbit. Draws behind the scene, where its depth is clear, like `Sky`; `AerialPerspective` and
 * `VolumetricClouds` take it as their `sky`. `HillaireSky.attach(engine, {hours: 18})`.
 * @throws TypeError / RangeError on invalid options; MargoError `'unsupported'` on a WebGL engine, `'disposed'` after
 * `dispose()`, `'state'` when the camera matrix is not invertible.
 */
export class HillaireSky implements EnginePlugin {
  readonly name: string = 'sky:hillaire';
  /** Unit direction toward the sun this frame. */
  readonly sun = new Float32Array(3);
  /** The share of the sun's light (rgb) that reaches the camera through the air, 0 behind the planet; set when drawn. */
  readonly sunTransmittance = new Float32Array([1, 1, 1]);
  private engine?: Engine;
  private table?: AtmosphereTables;
  private skyView?: GPUTexture;
  private view?: { pipeline: GPUComputePipeline; group: GPUBindGroup };
  private render?: GPURenderPipeline;
  private bind?: GPUBindGroup;
  private key = '';
  private parameters!: Required<AtmosphereParameters>;
  private parameterSource?: AtmosphereParameters | null;
  private disposed = false;
  private readonly presentation = overlayPass();
  private readonly scratch = new Float64Array(52);
  constructor(readonly options: HillaireSkyOptions = {}) {
    this.validate();
    this.place();
  }
  static attach(engine: EngineKernel, options: HillaireSkyOptions = {}): HillaireSky {
    const sky = new HillaireSky(options);
    engineRuntime(engine).use(sky);
    return sky;
  }
  /** Sun illuminance in use, for effects that follow this sky. */
  get sunIlluminance(): number {
    return this.options.sunIlluminance ?? 20;
  }
  /** The atmosphere in use, every default filled in, for effects that follow this sky. */
  get resolvedAtmosphere(): Readonly<Required<AtmosphereParameters>> {
    return this.parameters;
  }
  private validate(): void {
    const o = this.options;
    if (typeof o !== 'object' || o === null) throw new TypeError('HillaireSky options must be an object');
    if (o.sunDirection) finiteVector(o.sunDirection, 3, 'HillaireSky sunDirection');
    if (o.sunDirection && !(Math.hypot(...o.sunDirection) > 0))
      throw new RangeError('HillaireSky sunDirection needs a nonzero length');
    if (o.sunDisc !== undefined && typeof o.sunDisc !== 'boolean')
      throw new TypeError('HillaireSky sunDisc must be true or false');
    if (
      !Number.isFinite(o.hours ?? 12) ||
      !Number.isFinite(o.timeScale ?? 0) ||
      !inRange(o.exposure ?? 0, -32, 32) ||
      !inRange(o.sunIlluminance ?? 20, 0, 1e6) ||
      !(inRange(o.metersPerUnit ?? 1, 0, 1e6) && (o.metersPerUnit ?? 1) > 0) ||
      !inRange(o.altitude ?? 0, 0, 1e8)
    )
      throw new RangeError(
        'Invalid HillaireSky options; keep hours and timeScale finite, exposure -32 to 32, sunIlluminance 0 to 1000000, metersPerUnit above 0 to 1000000 and altitude 0 to 100000000.',
      );
    if (this.parameterSource !== (o.atmosphere ?? null)) {
      this.parameters = atmosphereParameters(o.atmosphere);
      this.parameterSource = o.atmosphere ?? null;
    }
  }
  private place(): void {
    const s = this.options.sunDirection;
    if (s) {
      const length = Math.hypot(...s);
      for (let i = 0; i < 3; i++) this.sun[i] = s[i] / length;
    } else sunDirection(this.options.hours ?? 12, this.sun);
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'HillaireSky requires WebGPU; attach a new HillaireSky to a WebGPU engine; see https://margoengine.com/errors#webgpu',
      );
    this.engine = engine;
    const d = engine.gpu;
    this.table = new AtmosphereTables(d);
    this.skyView = d.createTexture({
      size: [W, H],
      format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
  }
  registerPasses(graph: FrameGraph): void {
    // Where the root Sky draws: after opaque surfaces (depth known), before clouds (3), the air (4) and fog (5).
    graph.add({
      name: 'sky:hillaire',
      order: 2,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c);
      },
    });
  }
  onPreUpdate(delta: number): void {
    this.validate();
    if (!Number.isFinite(delta) || delta < 0)
      throw new RangeError('Invalid HillaireSky delta; pass a finite delta of 0 or more seconds.');
    const o = this.options;
    o.hours = ((((o.hours ?? 12) + delta * (o.timeScale ?? 1 / 3600)) % 24) + 24) % 24;
    this.place();
  }
  private write(c: Context): void {
    const o = this.options,
      t = this.table!,
      v = t.values,
      a = this.parameters,
      perUnit = o.metersPerUnit ?? 1;
    if (!invertMatrixStable(c.camera.matrix, v.subarray(0, 16), this.scratch))
      throw new MargoError('state', 'Invalid HillaireSky camera; give the camera a finite, invertible projection');
    t.medium(a, 1);
    v[34] = this.sunIlluminance;
    v.set(this.sun, 36);
    v[39] = 2 ** (o.exposure ?? 0);
    v.set(c.camera.position, 40);
    v[43] = perUnit / 1000;
    // The planet's centre lies under the camera: radius = ground + height (km), at least a metre up.
    v[45] = a.bottomRadius + Math.max(0.001, (c.camera.position[1] * perUnit + (o.altitude ?? 0)) / 1000);
    v[46] = +(c.format !== 'rgba16float');
    v[47] = +(o.sunDisc ?? true);
    sunThrough(a, v[45], this.sun[1], this.sunTransmittance);
  }
  private draw(c: Context): void {
    if (!this.table) return;
    this.write(c);
    const t = this.table,
      d = c.device;
    t.upload(c.encoder);
    const entries = (last: GPUBindingResource): GPUBindGroupEntry[] => [
      { binding: 0, resource: { buffer: t.uniform } },
      { binding: 1, resource: t.transmittance.createView() },
      { binding: 2, resource: t.multiple.createView() },
      { binding: 3, resource: t.sampler },
      { binding: 4, resource: last },
    ];
    this.view ??= (() => {
      const pipeline = d.createComputePipeline({
        layout: 'auto',
        compute: { module: d.createShaderModule({ code: skyViewShader }), entryPoint: 'main' },
      });
      return {
        pipeline,
        group: d.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: entries(this.skyView!.createView()),
        }),
      };
    })();
    // The table is needed only inside the air; from space every pixel marches.
    if (t.values[45] < this.parameters.topRadius) {
      const compute = c.encoder.beginComputePass();
      compute.setPipeline(this.view.pipeline);
      compute.setBindGroup(0, this.view.group);
      compute.dispatchWorkgroups(W / 8, Math.ceil(H / 4));
      compute.end();
    }
    const key = `${c.format}:${c.descriptor.multisample?.count ?? 1}:${c.descriptor.depthStencil!.format}`;
    if (this.key !== key) {
      const module = d.createShaderModule({ code: drawShader });
      this.render = d.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format }] },
        multisample: c.descriptor.multisample,
        depthStencil: {
          format: c.descriptor.depthStencil!.format,
          depthCompare: 'greater-equal',
          depthWriteEnabled: false,
        },
      });
      this.bind = d.createBindGroup({
        layout: this.render.getBindGroupLayout(0),
        entries: entries(this.skyView!.createView()),
      });
      this.key = key;
    }
    this.presentation.colorAttachments[0].view = c.color;
    this.presentation.depthStencilAttachment.view = c.depth;
    const pass = c.encoder.beginRenderPass(this.presentation);
    applyView(pass, c);
    pass.setPipeline(this.render!);
    pass.setBindGroup(0, this.bind!);
    pass.draw(3);
    pass.end();
  }
  private release(): void {
    this.table?.dispose();
    this.skyView?.destroy();
    this.table = this.skyView = this.view = this.render = this.bind = undefined;
    this.key = '';
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.removePlugin(this.name);
    this.release();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
