// Variance shadow maps (Donnelly and Lauritzen 2006) with light-bleeding reduction (Lauritzen 2007). The depth map is turned
// into mean depth and mean squared depth, blurred once per change by two separable passes, and a receiver reads one bilinear
// moment pair and bounds the lit share with Chebyshev's inequality. Blur costs per map texel, not per lit pixel, so a wide
// edge costs what a narrow one does at the receiver.
import type { ShadowEffectFrame, ShadowEffectMap, ShadowFilterEffect } from './shader.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { STORAGE_BINDING: number; TEXTURE_BINDING: number };
/** {@link varianceFilter} settings. `blur`, `bleed` and `minVariance` are read every frame from the effect's `options`. */
export interface VarianceFilterOptions {
  /**
   * Moment map size in texels, a side, 16 to the device's `maxTextureDimension2D`. Default 1024. Memory is two `rg32float`
   * arrays of size x size x one layer per cascade: 64 MiB at 1024 with four cascades.
   */
  size?: number;
  /** Blur radius in moment map texels, a whole number from 0 to 32. Default 4: an edge about nine texels wide. */
  blur?: number;
  /** Light bleeding removed, 0 to 1 of the Chebyshev bound (Lauritzen 2007): more darkens and narrows the edge. Default 0.2. */
  bleed?: number;
  /** The least variance, in squared 0 to 1 map depth: a floor against self-shadowing. Default 0.000001. */
  minVariance?: number;
}
/** The filter `varianceFilter` returns, with live `options`. */
export interface VarianceFilter<Context = unknown> extends ShadowFilterEffect<Context> {
  readonly options: VarianceFilterOptions;
}
// Moments of the depth map: each thread reads the depth at its own texel, sums a tent over `radius` along x, and the second
// pass does the same along y on the first's result. Weights 1 - |i| / (radius + 1).
const blurCode = (first: boolean) => /* wgsl */ `struct Blur {radius:u32}
@group(0) @binding(0) var<uniform> blur:Blur;
@group(0) @binding(1) var source:${first ? 'texture_depth_2d_array' : 'texture_2d_array<f32>'};
@group(0) @binding(2) var blurred:texture_storage_2d_array<rg32float,write>;
fn moments(at:vec2i,layer:i32,size:vec2i)->vec2f {
${
  first
    ? `  let mapSize=vec2i(textureDimensions(source));let c=clamp(at,vec2i(0),size-1)*mapSize/size;
  let d=textureLoad(source,c,layer,0);return vec2f(d,d*d);`
    : `  return textureLoad(source,clamp(at,vec2i(0),size-1),layer,0).rg;`
}
}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
  let size=vec2i(textureDimensions(blurred));let at=vec2i(id.xy);let layer=i32(id.z);
  if(any(at>=size)){return;}
  let r=i32(blur.radius);var sum=vec2f(0);var total=0.0;
  for(var i=-r;i<=r;i++){
    let w=1.0-f32(abs(i))/f32(r+1);
    sum+=w*moments(at+${first ? 'vec2i(i,0)' : 'vec2i(0,i)'},layer,size);total+=w;
  }
  textureStore(blurred,at,layer,vec4f(sum/total,0,1));
}`;
/**
 * A filterable shadow map: very soft, wide edges at a fixed cost per lit pixel, alongside PCSS and PCF.
 * `Shadows.attach(engine, {filter: varianceFilter({blur: 8})})`. Its width does not grow with blocker distance as PCSS's
 * does, and overlapping casters at different depths let some light bleed through, which `bleed` trades against width.
 * Adds one sampled texture to every receiver. Throws RangeError for an invalid `size`.
 */
export function varianceFilter<Context extends { device: GPUDevice; encoder: GPUCommandEncoder }>(
  options: VarianceFilterOptions = {},
): VarianceFilter<Context> {
  const size = options.size ?? 1024;
  if (!Number.isInteger(size) || size < 16)
    throw new RangeError('Invalid variance filter size; use a whole number of 16 or more');
  let device: GPUDevice | undefined,
    layers = 0,
    moments: GPUTexture | undefined,
    scratch: GPUTexture | undefined,
    view: GPUTextureView | undefined,
    settings: GPUBuffer | undefined,
    blurBuffer: GPUBuffer | undefined,
    pipelines: GPUComputePipeline[] = [],
    groups: GPUBindGroup[] = [],
    source: GPUTextureView | undefined,
    radius = -1,
    stale = true;
  const values = new Float32Array(4),
    radiusValue = new Uint32Array(4);
  const free = () => {
    moments?.destroy();
    scratch?.destroy();
    settings?.destroy();
    blurBuffer?.destroy();
    moments = scratch = view = settings = blurBuffer = source = undefined;
    pipelines = [];
    groups = [];
    radius = -1;
    stale = true;
  };
  return {
    options,
    // Read before `wgsl` runs, so its names carry no binding: a map has one filter.
    body: /* wgsl */ `
  let m=shadowFxMomentsAt(uv,layer);
  if(reference<=m.x){return 1;}
  let variance=max(m.y-m.x*m.x,shadowFxVariance.x);let gap=reference-m.x;
  let bound=variance/(variance+gap*gap);let bleed=shadowFxVariance.y;
  return clamp((bound-bleed)/(1.0-bleed),0.0,1.0);`,
    wgsl(group, at) {
      return /* wgsl */ `@group(${group}) @binding(${at}) var shadowFxMoments:texture_2d_array<f32>;
@group(${group}) @binding(${at + 1}) var<uniform> shadowFxVariance:vec4f;
fn shadowFxMomentsAt(uv:vec2f,layer:u32)->vec2f {
  let size=vec2i(textureDimensions(shadowFxMoments));let p=uv*vec2f(size)-0.5;let b=floor(p);let f=p-b;let c=vec2i(b);let hi=size-1;let l=i32(layer);
  let a=textureLoad(shadowFxMoments,clamp(c,vec2i(0),hi),l,0).rg;
  let d=textureLoad(shadowFxMoments,clamp(c+vec2i(1,0),vec2i(0),hi),l,0).rg;
  let e=textureLoad(shadowFxMoments,clamp(c+vec2i(0,1),vec2i(0),hi),l,0).rg;
  let g=textureLoad(shadowFxMoments,clamp(c+vec2i(1,1),vec2i(0),hi),l,0).rg;
  return mix(mix(a,d,f.x),mix(e,g,f.x),f.y);
}
`;
    },
    resources() {
      return [view!, { buffer: settings! }];
    },
    setup(gpu: GPUDevice, map: ShadowEffectMap) {
      if (size > gpu.limits.maxTextureDimension2D)
        throw new RangeError('Variance filter size exceeds the device limit; lower size');
      free();
      device = gpu;
      layers = map.layers;
      const texture = () =>
        gpu.createTexture({
          size: [size, size, layers],
          format: 'rg32float',
          usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
        });
      moments = texture();
      scratch = texture();
      view = moments.createView({ dimension: '2d-array' });
      settings = gpu.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      blurBuffer = gpu.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    },
    update(frame: ShadowEffectFrame<Context>) {
      const { blur = 4, bleed = 0.2, minVariance = 0.000001 } = this.options,
        gpu = device!;
      if (!Number.isInteger(blur) || blur < 0 || blur > 32)
        throw new RangeError('Invalid variance filter blur; use a whole number from 0 to 32');
      if (!(bleed >= 0 && bleed < 1)) throw new RangeError('Invalid variance filter bleed; use a number from 0 to under 1');
      if (!(minVariance >= 0)) throw new RangeError('Invalid variance filter minVariance; use 0 or more');
      values[0] = minVariance;
      values[1] = bleed;
      gpu.queue.writeBuffer(settings!, 0, values);
      if (!frame.changed && !stale && blur === radius && frame.map === source) return;
      if (blur !== radius) {
        radiusValue[0] = radius = blur;
        gpu.queue.writeBuffer(blurBuffer!, 0, radiusValue);
      }
      if (!pipelines.length)
        pipelines = [true, false].map((first) =>
          gpu.createComputePipeline({
            layout: 'auto',
            compute: { module: gpu.createShaderModule({ code: blurCode(first) }), entryPoint: 'main' },
          }),
        );
      if (frame.map !== source) {
        source = frame.map;
        const layerViews = (t: GPUTexture) => t.createView({ dimension: '2d-array' });
        groups = [
          [source!, layerViews(scratch!), 0],
          [layerViews(scratch!), layerViews(moments!), 1],
        ].map(([from, to, i]) =>
          gpu.createBindGroup({
            layout: pipelines[i as number].getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: blurBuffer! } },
              { binding: 1, resource: from as GPUTextureView },
              { binding: 2, resource: to as GPUTextureView },
            ],
          }),
        );
      }
      const pass = frame.context.encoder.beginComputePass(),
        count = Math.ceil(size / 8);
      for (let i = 0; i < 2; i++) {
        pass.setPipeline(pipelines[i]);
        pass.setBindGroup(0, groups[i]);
        pass.dispatchWorkgroups(count, count, layers);
      }
      pass.end();
      stale = false;
    },
    dispose: free,
  };
}
