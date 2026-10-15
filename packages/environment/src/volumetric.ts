/// <reference lib="esnext.disposable" preserve="true" />
// Froxel volumetric fog and light shafts (`@margoengine/environment/volumetric`): a camera-frustum 3D grid lit by the sun
// (through @margoengine/shadows' cascades) and clustered point/spot lights (with their LocalShadows), reprojected over
// time, integrated along view rays and composited over opaque surfaces and the sky in its own full-screen pass. It never
// patches a lit shader, so it adds no texture to the 16-per-stage budget, and nothing changes while it is not attached.
import type {EngineKernel} from '@margoengine/core';
import {engineRuntime, type Engine, type EnginePlugin, type FrameGraph, type PassContext, type Vec3} from '@margoengine/core/extension';
import {invertMatrix} from '@margoengine/math/mat4';
import {sceneTarget} from '../../shared/msaa.js';
import {preset} from '../../shared/preset.js';

declare const GPUBufferUsage: {UNIFORM: number; COPY_DST: number};
declare const GPUTextureUsage: {TEXTURE_BINDING: number; STORAGE_BINDING: number; COPY_SRC: number};
type Context = Extract<PassContext, {backend: 'webgpu'}>;

/** What VolumetricFog reads from `Shadows` (@margoengine/shadows) or `Clustered` (@margoengine/clustered): their WGSL and bindings. */
export interface VolumetricLightSource {pbr(group: number): {readonly declarations: string}; bindings(): GPUBindGroupEntry[]}

export interface VolumetricFogOptions {
  /** Extinction per metre at and below `height` (default 0.02). */
  density?: number;
  /** Height fog: density times `exp(-heightFalloff * (y - height))` above `height` (default 0 = uniform). */
  heightFalloff?: number;
  /** World height below which the fog has its full density (default 0). */
  height?: number;
  /** Scattering albedo, linear RGB 0..1 (default [1, 1, 1]: no absorption). */
  color?: Vec3;
  /** Henyey-Greenstein anisotropy, -0.95..0.95; positive scatters forward, brightening shafts toward the light (default 0.5). */
  anisotropy?: number;
  /** Isotropic ambient radiance scattered by the fog, linear RGB (default: the engine's ambient, `lighting.radiance[3]`, as grey). */
  ambient?: Vec3;
  /** Density noise 0..1 (default 0: smooth fog). */
  noise?: number;
  /** Noise feature size in metres (default 8). */
  noiseScale?: number;
  /** Noise drift in metres per second (default [0, 0, 0]). */
  wind?: Vec3;
  /** Metres beyond the near plane the froxel grid covers (default 100); farther surfaces and the sky get the fog up to it. */
  range?: number;
  /** Froxels across, down and in depth (default [160, 90, 64]); slices are spaced quadratically, finer near the camera. */
  grid?: readonly [number, number, number];
  /** Weight of the reprojected previous frame, 0..0.98 (default 0.9; 0 turns reprojection and sub-froxel jitter off). */
  temporal?: number;
  /** Directional cascades (`Shadows` from @margoengine/shadows): sunlight is shadowed in the fog, giving light shafts. */
  shadows?: VolumetricLightSource;
  /** Clustered point and spot lights (`Clustered`); a `LocalShadows` attached to them shadows the fog too. */
  lights?: VolumetricLightSource;
  /**
   * Sampleable reversed-Z scene depth when no post capture (Tonemap, Bloom, PostStack, SSAO, TAA) owns the scene target,
   * e.g. `() => water.depthTexture`. With a capture attached the fog reads its depth and this is not needed.
   */
  depth?: () => GPUTexture | undefined;
}

const struct = /* wgsl */ `
struct Volume {inverse:mat4x4f,previous:mat4x4f,plane:vec4f,previousPlane:vec4f,grid:vec4f,shape:vec4f,scatter:vec4f,sun:vec4f,sunColor:vec4f,ambient:vec4f,wind:vec4f,jitter:vec4f,screen:vec4f}
@group(0) @binding(0) var<uniform> volume:Volume;
fn unproject(ndc:vec3f)->vec3f {let p=volume.inverse*vec4f(ndc,1);return p.xyz/p.w;}
fn sliceDepth(s:f32)->f32 {let x=s/volume.grid.z;return volume.shape.x*x*x;}
`;
// t = distance beyond the near plane along the view axis: dot(plane, (p, 1)), for perspective and orthographic cameras.
// A screen point's ray runs from its near-plane point n through the depth-0.5 point; p(t) = n + d * t / dot(d, plane.xyz).
const compute = (lights: string | undefined, shadows: string | undefined) => struct + (lights ?? '') + (shadows ?? '') + /* wgsl */ `
@group(0) @binding(1) var history:texture_3d<f32>;
@group(0) @binding(2) var linearSampler:sampler;
@group(0) @binding(3) var current:texture_storage_3d<rgba16float,write>;
@group(0) @binding(4) var scattering:texture_3d<f32>;
@group(0) @binding(5) var integrated:texture_storage_3d<rgba16float,write>;
fn phase(c:f32,g:f32)->f32 {let k=1.0+g*g-2.0*g*c;return (1.0-g*g)/(12.5663706*k*sqrt(k));}
fn hash(x:vec3f)->f32 {var p=fract(x*0.1031);p+=dot(p,p.zyx+31.32);return fract((p.x+p.y)*p.z);}
fn noise(x:vec3f)->f32 {
  let i=floor(x);let f=fract(x);let u=f*f*(3.0-2.0*f);
  return mix(mix(mix(hash(i),hash(i+vec3f(1,0,0)),u.x),mix(hash(i+vec3f(0,1,0)),hash(i+vec3f(1,1,0)),u.x),u.y),
    mix(mix(hash(i+vec3f(0,0,1)),hash(i+vec3f(1,0,1)),u.x),mix(hash(i+vec3f(0,1,1)),hash(i+vec3f(1,1,1)),u.x),u.y),u.z);
}
${shadows ? `fn sunShadow(p:vec3f)->f32 {
  let depth=-(shadowFrame.view*vec4f(p,1)).z;if(depth<0.0||depth>shadowFrame.splits.w){return 1.0;}
  let cascade=u32(depth>shadowFrame.splits.x)+u32(depth>shadowFrame.splits.y)+u32(depth>shadowFrame.splits.z);
  let q=shadowFrame.matrices[cascade]*vec4f(p,1);let uv=q.xy*vec2f(0.5,-0.5)+0.5;
  if(any(uv<vec2f(0))||any(uv>vec2f(1))||q.z<=0.0||q.z>=1.0){return 1.0;}
  return textureSampleCompareLevel(shadowMap,shadowSampler,uv,i32(cascade),q.z-shadowFrame.settings.y);
}` : ''}
${lights ? `fn localLight(pixel:vec2f,p:vec3f,v:vec3f,g:f32)->vec3f {
  let grid=clusterFrame.grid.xyz;let depth=-(clusterFrame.view*vec4f(p,1)).z;
  if(depth<clusterFrame.depth.x||depth>clusterFrame.depth.y){return vec3f(0);}
  let screenPixel=pixel-clusterFrame.depth.zw*clusterFrame.screen.xy;
  let xy=min(vec2u(max(screenPixel,vec2f(0))/clusterFrame.screen.xy*vec2f(grid.xy)),grid.xy-vec2u(1));
  let near=clusterFrame.depth.x;let far=clusterFrame.depth.y;
  let z=min(u32(max(0.0,select(log(depth/near)/log(far/near),(depth-near)/(far-near),clusterFrame.intensity.w>0.5)*f32(grid.z))),grid.z-1);
  let cell=xy.x+grid.x*(xy.y+grid.y*z);let count=clusterCounts[cell];var result=vec3f(0);
  for(var j=0u;j<count;j++){
    let light=clusterLights[clusterIndices[cell*1024u+j]];let delta=light.positionRange.xyz-p;let distance=length(delta);
    if(distance>=light.positionRange.w){continue;}let l=delta/max(distance,0.0001);
    let falloff=pow(max(0.0,1-pow(distance/light.positionRange.w,4.0)),2.0)/max(distance*distance,0.01);
    var cone=1.0;if(light.params.y>0.5){cone=clamp((dot(-l,light.directionOuter.xyz)-light.directionOuter.w)/max(light.params.x-light.directionOuter.w,0.00001),0.0,1.0);cone*=cone*(3-2*cone);}
    result+=light.colorIntensity.rgb*light.colorIntensity.w*falloff*cone*phase(dot(-l,v),g)${lights.includes('fn clusterShadow(') ? '*clusterShadow(light,p,vec3f(0))' : ''};
  }
  return result*clusterFrame.intensity.x;
}` : ''}
// Scattered light (rgb) and extinction (a) per froxel, blended with the previous frame's value at the same world point.
@compute @workgroup_size(4,4,4) fn inject(@builtin(global_invocation_id) id:vec3u) {
  if(any(id>=vec3u(volume.grid.xyz))){return;}
  let uv=(vec2f(id.xy)+0.5+volume.jitter.xy)/volume.grid.xy;let ndc=vec2f(uv.x*2-1,1-uv.y*2);
  let n=unproject(vec3f(ndc,1));let d=unproject(vec3f(ndc,0.5))-n;let v=normalize(-d);
  let p=n+d*(sliceDepth(f32(id.z)+0.5+volume.jitter.z)/dot(d,volume.plane.xyz));
  var sigma=volume.shape.y*exp(-volume.shape.z*max(p.y-volume.shape.w,0.0));
  if(volume.sunColor.w>0.0){let x=(p-volume.wind.xyz)*volume.ambient.w;sigma*=max(0.0,1.0+volume.sunColor.w*(1.3333*noise(x)+0.6667*noise(x*2.03+17.0)-1.0));}
  var light=volume.ambient.rgb;
  if(any(volume.sunColor.rgb>vec3f(0))){
    var lit=1.0;
    ${shadows ? `// Four stratified shadow samples along the froxel's depth: shaft walls the view ray crosses obliquely stay steady.
    lit=0.0;for(var k=0u;k<4u;k++){lit+=0.25*sunShadow(n+d*(sliceDepth(f32(id.z)+(f32(k)+0.5+volume.jitter.z)*0.25)/dot(d,volume.plane.xyz)));}` : ''}
    light+=volume.sunColor.rgb*phase(dot(-volume.sun.xyz,v),volume.scatter.w)*lit;
  }
  ${lights ? 'light+=localLight(uv*volume.screen.xy,p,v,volume.scatter.w);' : ''}
  var value=vec4f(sigma*volume.scatter.rgb*light,sigma);
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
@compute @workgroup_size(8,8) fn integrate(@builtin(global_invocation_id) id:vec3u) {
  let size=vec3u(volume.grid.xyz);if(any(id.xy>=size.xy)){return;}
  let uv=(vec2f(id.xy)+0.5)/volume.grid.xy;let ndc=vec2f(uv.x*2-1,1-uv.y*2);
  let n=unproject(vec3f(ndc,1));let d=unproject(vec3f(ndc,0.5))-n;let stretch=length(d)/dot(d,volume.plane.xyz);
  var light=vec3f(0);var optical=0.0;let texel=0.5/volume.grid.xyz;
  for(var z=0u;z<size.z;z++){
    // 3x3 tent filter across the column (four bilinear taps): steadies jittered shadow edges between frames.
    let w=(f32(z)+0.5)/volume.grid.z;
    let s=0.25*(textureSampleLevel(scattering,linearSampler,vec3f(uv-texel.xy,w),0)+textureSampleLevel(scattering,linearSampler,vec3f(uv+vec2f(texel.x,-texel.y),w),0)
      +textureSampleLevel(scattering,linearSampler,vec3f(uv+vec2f(-texel.x,texel.y),w),0)+textureSampleLevel(scattering,linearSampler,vec3f(uv+texel.xy,w),0));let step=(sliceDepth(f32(z+1))-sliceDepth(f32(z)))*stretch;
    let through=exp(-s.a*step);
    light+=exp(-optical)*select(s.rgb*step,(s.rgb-s.rgb*through)/s.a,s.a>0.00001);optical+=s.a*step;
    textureStore(integrated,vec3u(id.xy,z),vec4f(light,optical));
  }
}`;
// Premultiplied over the scene: rgb = in-scattered light, a = 1 - transmittance. Tone mapped like sky fog on a display target.
const composite = struct + /* wgsl */ `
@group(0) @binding(1) var fogVolume:texture_3d<f32>;
@group(0) @binding(2) var linearSampler:sampler;
@group(0) @binding(3) var sceneDepth:texture_depth_2d;
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {return vec4f(array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i],0,1);}
@fragment fn fragment(@builtin(position) position:vec4f)->@location(0) vec4f {
  let depth=textureLoad(sceneDepth,vec2i(position.xy),0);let uv=position.xy/volume.screen.xy;var t=volume.shape.x;
  if(depth>0.0){let p=volume.inverse*vec4f(uv.x*2-1,1-uv.y*2,depth,1);t=clamp(dot(volume.plane,vec4f(p.xyz/p.w,1)),0.0,t);}
  let s=textureSampleLevel(fogVolume,linearSampler,vec3f(uv,(sqrt(t/volume.shape.x)*volume.grid.z-0.5)/volume.grid.z),0);
  let opacity=1.0-exp(-s.a);var light=s.rgb;
  if(volume.wind.w<0.5&&opacity>0.0){let c=s.rgb/opacity;light=pow(c/(1.0+c),vec3f(1.0/2.2))*opacity;}
  return vec4f(light,opacity);
}`;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(Math.fround(value));
const vector = (value: Vec3 | undefined, min: number, max = Infinity): boolean => value === undefined || Array.isArray(value) && value.length === 3 && value.every(v => finite(v) && v >= min && v <= max);
const halton = (index: number, base: number): number => {let f = 1, r = 0; for (let i = index; i > 0; i = Math.floor(i / base)) {f /= base; r += f * (i % base);} return r;};

/**
 * Volumetric fog and light shafts. Attach after a post capture that owns the scene target (Tonemap, Bloom, PostStack,
 * SSAO, TAA), or pass `depth`; it replaces environment `Fog` and sky's `fog` option (it throws while either is on, so the
 * scene is never fogged twice). `options` are read every frame.
 */
export class VolumetricFog implements EnginePlugin {
  readonly name = 'volumetric-fog';
  private engine?: Engine;
  private device?: GPUDevice;
  private uniform?: GPUBuffer;
  private sampler?: GPUSampler;
  private textures: GPUTexture[] = [];
  private gridKey = '';
  private computeKey = '';
  private inject?: GPUComputePipeline;
  private integrateStep?: GPUComputePipeline;
  private injectGroups: GPUBindGroup[] = [];
  private integrateGroups: GPUBindGroup[] = [];
  private lightGroup?: {entries: GPUBindGroupEntry[]; group: GPUBindGroup};
  private shadowGroup?: {entries: GPUBindGroupEntry[]; group: GPUBindGroup};
  private readonly composites = new Map<string, GPURenderPipeline>();
  private compositeGroup?: {pipeline: GPURenderPipeline; view: GPUTextureView; group: GPUBindGroup};
  private depthViews = new WeakMap<GPUTexture, GPUTextureView>();
  private frameIndex = 0;
  private valid = false;
  private disposed = false;
  private readonly values = new Float32Array(76);
  private readonly inverse = this.values.subarray(0, 16);
  private readonly previous = this.values.subarray(16, 32);
  private readonly offset = [0, 0, 0];
  private readonly attachment: GPURenderPassColorAttachment = {view: undefined!, loadOp: 'load', storeOp: 'store'};
  private readonly pass: GPURenderPassDescriptor = {colorAttachments: [this.attachment]};

  constructor(readonly options: VolumetricFogOptions = {}) {this.options = preset('volumetric', options); this.validate();}
  /** Same as `engine.use(new VolumetricFog(options))`; returns the VolumetricFog. */
  static attach(engine: EngineKernel, options: VolumetricFogOptions = {}): VolumetricFog {const fog = new VolumetricFog(options); engineRuntime(engine).use(fog); return fog;}
  /** The integrated volume (rgba16float 3D, grid sized): in-scattered light (rgb) and optical depth (a) from the camera to each slice's far edge, for custom shaders (particles). Changes on grid change and device restore. */
  get texture(): GPUTexture | undefined {return this.textures[2];}

  private validate(): void {
    const o = this.options, grid = o.grid ?? [160, 90, 64];
    const scalars: [number | undefined, number, number, number][] = [[o.density, 0.02, 0, 1e3], [o.heightFalloff, 0, 0, 1e3], [o.height, 0, -1e9, 1e9], [o.anisotropy, 0.5, -0.95, 0.95],
      [o.noise, 0, 0, 1], [o.noiseScale, 8, 1e-3, 1e6], [o.range, 100, 1e-3, 1e7], [o.temporal, 0.9, 0, 0.98]];
    if (scalars.some(([value, fallback, min, max]) => {const v = value ?? fallback; return !finite(v) || v < min || v > max;}) || !vector(o.color, 0, 1) || !vector(o.ambient, 0) || !vector(o.wind, -Infinity)
      || !Array.isArray(grid) || grid.length !== 3 || grid.some((v, i) => !Number.isInteger(v) || v < 2 || v > (i === 2 ? 256 : 512)) || o.depth !== undefined && typeof o.depth !== 'function'
      || [o.shadows, o.lights].some(s => s !== undefined && (typeof s?.pbr !== 'function' || typeof s.bindings !== 'function'))) throw new RangeError('Invalid volumetric fog options');
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu) throw new Error('VolumetricFog requires WebGPU and a live effect');
    this.engine = engine; this.device = engine.gpu;
    this.uniform = this.device.createBuffer({size: this.values.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
    this.sampler = this.device.createSampler({magFilter: 'linear', minFilter: 'linear'});
  }
  // After opaque meshes (0), sky (2) and water (4), where sky fog would run; before VFX (6) and post (10+).
  registerPasses(graph: FrameGraph): void {graph.add({name: this.name, order: 5, execute: c => {if (c.backend === 'webgpu') this.render(c);}});}

  private conflicts(): void {
    for (const plugin of this.engine!.plugins.values()) {
      const p = plugin as {heightFalloff?: unknown; enabled?: unknown; options?: {fog?: {density?: number; depth?: unknown}; atmosphere?: {density?: number}}};
      if ('heightFalloff' in p && p.enabled === true) throw new Error(`VolumetricFog replaces environment Fog '${plugin.name}': set its enabled = false or remove it`);
      const fog = p.options?.fog;
      if (fog && typeof fog.depth === 'function' && (fog.density ?? 0.01) > 0) throw new Error(`VolumetricFog replaces sky fog: remove ${plugin.name}.options.fog`);
      if ((p.options?.atmosphere?.density ?? 0) > 0) throw new Error(`VolumetricFog replaces creative atmosphere fog: set ${plugin.name}.options.atmosphere.density to 0`);
    }
  }
  private allocate(device: GPUDevice, grid: readonly number[]): void {
    for (const texture of this.textures) texture.destroy();
    const size = [grid[0], grid[1], grid[2]], usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC;
    if (size.some(v => v > device.limits.maxTextureDimension3D)) throw new RangeError('Volumetric grid exceeds device limit');
    this.textures = [0, 1, 2].map(() => device.createTexture({size, dimension: '3d', format: 'rgba16float', usage}));
    this.gridKey = grid.join(); this.injectGroups = []; this.integrateGroups = []; this.compositeGroup = undefined; this.valid = false;
  }
  private group(pipeline: GPUComputePipeline | GPURenderPipeline, index: number, entries: GPUBindGroupEntry[]): GPUBindGroup {return this.device!.createBindGroup({layout: pipeline.getBindGroupLayout(index), entries});}
  private render(c: Context): void {
    if (this.disposed || c.device !== this.device) return;
    this.validate(); this.conflicts();
    const o = this.options, device = c.device, target = sceneTarget(c);
    let depth: GPUTextureView | undefined, multisampled = false;
    if (o.depth) {
      const texture = o.depth(); if (!texture) return;
      if (!texture.format.startsWith('depth') || texture.dimension !== '2d' || texture.width !== c.width || texture.height !== c.height || !(texture.usage & GPUTextureUsage.TEXTURE_BINDING) || texture.sampleCount !== 1 && texture.sampleCount !== (c.descriptor.multisample?.count ?? 1)) throw new RangeError('VolumetricFog depth must be sampleable scene depth matching the viewport');
      multisampled = texture.sampleCount > 1; depth = this.depthView(texture);
    } else if (target) {multisampled = target.samples > 1; depth = multisampled ? target.depthSource : this.depthView(target.resolvedDepth);}
    if (!depth) throw new Error('VolumetricFog needs scene depth: attach a post capture (Tonemap, Bloom, PostStack, SSAO, TAA) first or pass options.depth');
    if (!invertMatrix(c.camera.matrix, this.inverse)) return;
    const grid = o.grid ?? [160, 90, 64];
    if (grid.join() !== this.gridKey) this.allocate(device, grid);
    const lights = o.lights?.pbr(1).declarations, shadows = o.shadows?.pbr(lights ? 2 : 1).declarations, key = (lights ?? '') + '\0' + (shadows ?? '');
    if (key !== this.computeKey || !this.inject) {
      const module = device.createShaderModule({code: compute(lights, shadows)});
      this.inject = device.createComputePipeline({layout: 'auto', compute: {module, entryPoint: 'inject'}});
      this.integrateStep = device.createComputePipeline({layout: 'auto', compute: {module, entryPoint: 'integrate'}});
      this.computeKey = key; this.injectGroups = []; this.integrateGroups = []; this.lightGroup = this.shadowGroup = undefined;
    }
    if (!this.injectGroups.length) {
      const views = this.textures.map(t => t.createView()), uniform = {binding: 0, resource: {buffer: this.uniform!}};
      for (let i = 0; i < 2; i++) {
        this.injectGroups.push(this.group(this.inject, 0, [uniform, {binding: 1, resource: views[1 - i]}, {binding: 2, resource: this.sampler!}, {binding: 3, resource: views[i]}]));
        this.integrateGroups.push(this.group(this.integrateStep!, 0, [uniform, {binding: 2, resource: this.sampler!}, {binding: 4, resource: views[i]}, {binding: 5, resource: views[2]}]));
      }
    }
    // Uniform: matrices, near planes, grid, density shape, scattering, sun, ambient, noise, jitter, screen.
    const m = c.camera.matrix, v = this.values, w = Math.hypot(m[3] - m[2], m[7] - m[6], m[11] - m[10]), temporal = o.temporal ?? 0.9;
    for (let i = 0; i < 4; i++) v[32 + i] = (m[i * 4 + 3] - m[i * 4 + 2]) / w;
    v[40] = grid[0]; v[41] = grid[1]; v[42] = grid[2]; v[43] = this.valid ? temporal : 0;
    v[44] = o.range ?? 100; v[45] = o.density ?? 0.02; v[46] = o.heightFalloff ?? 0; v[47] = o.height ?? 0;
    v.set(o.color ?? [1, 1, 1], 48); v[51] = o.anisotropy ?? 0.5;
    const lighting = this.engine!.lighting, direction = lighting.direction, radiance = lighting.radiance, length = Math.hypot(direction[0], direction[1], direction[2]), sun = length > 0 ? Math.max(0, direction[3]) : 0;
    for (let i = 0; i < 3; i++) {v[52 + i] = sun ? direction[i] / length : 0; v[56 + i] = radiance[i] * sun; v[60 + i] = o.ambient?.[i] ?? radiance[3]; this.offset[i] += (o.wind?.[i] ?? 0) * c.delta; v[64 + i] = this.offset[i];}
    v[59] = o.noise ?? 0; v[63] = 1 / (o.noiseScale ?? 8); v[67] = +(c.format === 'rgba16float' || c.format === 'rgba32float');
    const frame = this.frameIndex % 16 + 1;
    for (let i = 0; i < 3; i++) v[68 + i] = temporal > 0 ? halton(frame, [2, 3, 5][i]) - 0.5 : 0;
    v[72] = c.width; v[73] = c.height;
    device.queue.writeBuffer(this.uniform!, 0, v as Float32Array<ArrayBuffer>);
    // Froxel lighting and reprojection, then the per-column integration.
    const parity = this.frameIndex & 1, pass = c.encoder.beginComputePass();
    pass.setPipeline(this.inject); pass.setBindGroup(0, this.injectGroups[parity]);
    let index = 1;
    for (const [source, slot] of [[o.lights, 'lightGroup'], [o.shadows, 'shadowGroup']] as const) {
      if (!source) continue;
      const entries = source.bindings();
      if (this[slot]?.entries !== entries) this[slot] = {entries, group: this.group(this.inject, index, entries)};
      pass.setBindGroup(index++, this[slot]!.group);
    }
    pass.dispatchWorkgroups(Math.ceil(grid[0] / 4), Math.ceil(grid[1] / 4), Math.ceil(grid[2] / 4));
    pass.setPipeline(this.integrateStep!); pass.setBindGroup(0, this.integrateGroups[parity]); pass.dispatchWorkgroups(Math.ceil(grid[0] / 8), Math.ceil(grid[1] / 8)); pass.end();
    // Composite over the scene target (per sample when the depth is multisampled).
    const samples = c.descriptor.multisample?.count ?? 1, compositeKey = c.format + ':' + samples + ':' + multisampled;
    let pipeline = this.composites.get(compositeKey);
    if (!pipeline) {
      const code = multisampled ? composite.replace('sceneDepth:texture_depth_2d', 'sceneDepth:texture_depth_multisampled_2d').replace('position:vec4f)', 'position:vec4f,@builtin(sample_index) sample:u32)').replace('vec2i(position.xy),0)', 'vec2i(position.xy),i32(sample))') : composite;
      const module = device.createShaderModule({code}), blend: GPUBlendComponent = {srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add'};
      pipeline = device.createRenderPipeline({layout: 'auto', vertex: {module, entryPoint: 'vertex'}, fragment: {module, entryPoint: 'fragment', targets: [{format: c.format, blend: {color: blend, alpha: blend}}]}, multisample: {count: samples}});
      this.composites.set(compositeKey, pipeline);
    }
    if (this.compositeGroup?.pipeline !== pipeline || this.compositeGroup.view !== depth) this.compositeGroup = {pipeline, view: depth, group: this.group(pipeline, 0, [{binding: 0, resource: {buffer: this.uniform!}}, {binding: 1, resource: this.textures[2].createView()}, {binding: 2, resource: this.sampler!}, {binding: 3, resource: depth}])};
    this.attachment.view = c.color;
    const draw = c.encoder.beginRenderPass(this.pass); draw.setPipeline(pipeline); draw.setBindGroup(0, this.compositeGroup.group); draw.draw(3); draw.end();
    this.previous.set(m); v.copyWithin(36, 32, 36); this.valid = true; this.frameIndex++;
  }
  private depthView(texture: GPUTexture): GPUTextureView {let view = this.depthViews.get(texture); if (!view) this.depthViews.set(texture, view = texture.createView({aspect: 'depth-only'})); return view;}
  private release(): void {
    for (const texture of this.textures) texture.destroy();
    this.uniform?.destroy(); this.textures = []; this.uniform = this.sampler = this.inject = this.integrateStep = undefined; this.gridKey = this.computeKey = '';
    this.injectGroups = []; this.integrateGroups = []; this.lightGroup = this.shadowGroup = this.compositeGroup = undefined; this.composites.clear(); this.depthViews = new WeakMap(); this.valid = false;
  }
  onDeviceRestored(engine: Engine): void {this.release(); this.setup(engine);}
  dispose(): void {if (this.disposed) return; this.disposed = true; this.engine?.removePlugin(this.name); this.release(); this.engine = this.device = undefined;}
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {this.dispose();}
}
