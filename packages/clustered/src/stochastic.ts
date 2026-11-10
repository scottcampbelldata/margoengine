/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type FrameGraph } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import type { Clustered, ClusteredStochastic } from './index.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };

/** `StochasticLights` settings, fixed at construction; invalid values throw RangeError or TypeError. */
export interface StochasticLightOptions {
  /** The clustered lights whose shadowed point and spot lights are sampled. */
  lights: Clustered;
  /**
   * Shadow lookups per pixel, an integer 1 to 8 (default 2). A pixel reached by this many shadowed lights or fewer is
   * shaded exactly; with more, this many of them are sampled.
   */
  samples?: number;
  /**
   * A new random pattern every frame (default true), so temporal anti-aliasing (`@margoengine/taa`) averages the noise
   * away; false keeps one pattern (stable pictures for tests and stills).
   */
  temporal?: boolean;
  /**
   * Share the visibility estimate across each 2 x 2 pixel quad (default true): four times the samples for the same
   * lookups, at the cost of blurring a shadow edge by one pixel inside a triangle (quads never span two triangles).
   * Uses fragment derivatives, so turn it off for a shader that calls the light loop outside a fragment stage.
   */
  quad?: boolean;
}
/** Most samples per pixel (`StochasticLightOptions.samples`). */
export const MAX_STOCHASTIC_SAMPLES = 8;
const BINDING = 151,
  LUMINANCE = 'vec3f(0.2126,0.7152,0.0722)';
// The light loop for a cluster with shadowed lights (Clustered.shadow or the integrated maps):
// - Every light's unshadowed radiance u is exact (the loop's own `result+=` term, so materials that rewrite it and
//   physical lobes still apply). A light that casts a shadow adds u to `sum` instead of `result`.
// - Its shadow is looked up only for picks: `samples` independent weighted reservoirs (Chao 1982) over the shadowed
//   lights with weight w = luminance(u), so a light is picked with probability w / W (W the summed weights): resampled
//   importance (Talbot, Cline & Egbert 2005) with an exact normaliser. The first `samples` shadowed lights are kept as
//   well, and when no more reach the pixel they are shaded exactly instead.
// - Each pick's chroma c = u / w and visibility V give the per-channel sums N = sum c V and D = sum c. Since
//   E[W N / samples] is the exact shadowed sum and E[W D / samples] the unshadowed one, sum * N / D is the ratio
//   estimator of Heitz, Hill & McGuire 2018: exact when the picks share one visibility or (per channel) one colour,
//   consistent otherwise, with noise only where the shadowed lights disagree.
// - Denoising: N and D are summed over the 2 x 2 quad with fine derivatives (a neighbour's value is x +/- dpdxFine(x)),
//   so each ratio has four pixels' picks, and the seed changes each frame for temporal accumulation. The quad sum needs
//   every lane of the quad live, so the cluster lookup's early return waits until after it.
// Random numbers: a PCG hash (Jarzynski & Olano 2020) of the pixel and the frame's seed.
const declarations = (group: number, quad: boolean) => /* wgsl */ `
struct ClusterStochastic {seed:u32,samples:u32,pad0:u32,pad1:u32}
@group(${group}) @binding(${BINDING}) var<uniform> clusterStochastic:ClusterStochastic;
fn clusterStochasticHash(v:u32)->u32 {let s=v*747796405u+2891336453u;let w=((s>>((s>>28u)+4u))^s)*277803737u;return (w>>22u)^w;}
fn clusterStochasticNext(state:ptr<function,u32>)->f32 {*state=clusterStochasticHash(*state);return f32(*state>>8u)*(1.0/16777216.0);}
fn clusterStochasticRatio(n:vec3f,d:vec3f)->vec3f {
  let dl=dot(d,${LUMINANCE});let mean=select(1.0,dot(n,${LUMINANCE})/dl,dl>0.0);
  return select(vec3f(mean),n/max(d,vec3f(1e-30)),d>vec3f(1e-20));
}
${
  quad
    ? `@diagnostic(off,derivative_uniformity) fn clusterStochasticQuad(x:vec4f,pixel:vec2f)->vec4f {
  let s=1.0-2.0*vec2f(vec2u(max(pixel,vec2f(0)))&vec2u(1u));let row=x+x+dpdxFine(x)*s.x;let sum=row+row+dpdyFine(row)*s.y;
  return select(x,sum,sum==sum);
}`
    : 'fn clusterStochasticQuad(x:vec4f,pixel:vec2f)->vec4f {return x;}'
}
`;
/**
 * The light loop's text with stochastic shadows (see the comment above `declarations`).
 * @param cell The cluster lookup (`clusterCell`), whose early return is deferred.
 * @param head The loop body up to the light's radiance, declaring `index`, `light`, `l` and the BRDF terms.
 * @param radiance The unshadowed radiance expression, the loop's `result+=` term.
 * @param visibility The shadow factor of the light named `light`, starting with `*`.
 * @param shadowed Whether `light` casts a shadow here (a bool WGSL expression).
 */
function lighting(cell: string, head: string, radiance: string, visibility: string, shadowed: string): string {
  return /* wgsl */ `  var clusterOutside=false;
${cell.replace('{return vec3f(0);}', '{clusterOutside=true;}').replace('let count=clusterCounts[cell];', 'let count=select(clusterCounts[cell],0u,clusterOutside);')}
  var stochasticSum=vec3f(0);var stochasticWeight=0.0;var stochasticCount=0u;let samples=min(clusterStochastic.samples,${MAX_STOCHASTIC_SAMPLES}u);
  var stochasticPick:array<u32,${MAX_STOCHASTIC_SAMPLES}>;var stochasticChroma:array<vec3f,${MAX_STOCHASTIC_SAMPLES}>;
  var stochasticExact:array<u32,${MAX_STOCHASTIC_SAMPLES}>;var stochasticLight:array<vec3f,${MAX_STOCHASTIC_SAMPLES}>;
  var state=clusterStochasticHash(u32(max(pixel.x,0.0))+clusterStochasticHash(u32(max(pixel.y,0.0))+clusterStochastic.seed));
  for(var j=0u;j<count;j++){
    ${head}
    let shadowedLight=${shadowed};let before=result;if(shadowedLight){result=vec3f(0);}
    result+=${radiance};
    if(shadowedLight){
      let u=result;result=before;let w=dot(u,${LUMINANCE});
      if(w>0.0){
        if(stochasticCount<samples){stochasticExact[stochasticCount]=index;stochasticLight[stochasticCount]=u;}
        stochasticCount++;stochasticSum+=u;stochasticWeight+=w;
        for(var r=0u;r<samples;r++){if(clusterStochasticNext(&state)*stochasticWeight<w){stochasticPick[r]=index;stochasticChroma[r]=u/w;}}
      }
    }
  }
  var stochasticN=vec3f(0);var stochasticD=vec3f(0);
  if(stochasticCount<=samples){
    for(var k=0u;k<stochasticCount;k++){let light=clusterLights[stochasticExact[k]];result+=stochasticLight[k]${visibility};}
  }else{
    for(var r=0u;r<samples;r++){let light=clusterLights[stochasticPick[r]];let c=stochasticChroma[r];stochasticD+=c;stochasticN+=c${visibility};}
  }
  let stochasticQuadN=clusterStochasticQuad(vec4f(stochasticN,0),pixel).xyz;let stochasticQuadD=clusterStochasticQuad(vec4f(stochasticD,0),pixel).xyz;
  if(clusterOutside){return vec3f(0);}
  if(stochasticCount>samples){result+=stochasticSum*clusterStochasticRatio(stochasticQuadN,stochasticQuadD);}`;
}
/**
 * Stochastic many-light shading: each pixel looks up the shadows of only `samples` of the shadowed point and spot lights
 * that reach it, chosen in proportion to the light each brings, and scales those lights' exact unshadowed light by the
 * visibility found (the ratio estimator of Heitz, Hill and McGuire 2018), so a pixel's shadow cost stays at `samples`
 * lookups however many shadowed lights reach it. Estimates are shared across each 2 x 2 pixel quad (`quad`) and the
 * pattern changes every frame (`temporal`) for `@margoengine/taa` to average. A pixel reached by `samples` shadowed
 * lights or fewer, unshadowed lights, and directional, area and shaped lights stay exact. Needs shadows on the lights
 * (`Clustered.shadow`, such as `LocalShadows`, or `ClusteredOptions.shadows`); without them it changes nothing.
 * `StochasticLights.attach(engine, {lights})`; WebGPU only.
 * @throws TypeError without the Clustered lights or for a non-boolean flag; RangeError for invalid samples.
 * @throws MargoError `'unsupported'` on a WebGL engine, `'disposed'` after `dispose()`, `'state'` when used before
 * attaching.
 */
export class StochasticLights implements EnginePlugin, ClusteredStochastic {
  readonly name = 'clustered:stochastic';
  readonly lights: Clustered;
  readonly samples: number;
  readonly temporal: boolean;
  readonly quad: boolean;
  /** Frames drawn since attaching (the random seed when `temporal`). */
  frame = 0;
  private engine?: Engine;
  private device?: GPUDevice;
  private uniform?: GPUBuffer;
  private entries: GPUBindGroupEntry[] = [];
  private readonly values = new Uint32Array(4);
  private disposed = false;
  constructor(options: StochasticLightOptions) {
    if (!options?.lights || typeof options.lights.setLights !== 'function')
      throw new TypeError(
        'StochasticLights needs the Clustered lights; pass {lights} with the Clustered from Clustered.attach',
      );
    const samples = options.samples ?? 2;
    if (!Number.isInteger(samples) || samples < 1 || samples > MAX_STOCHASTIC_SAMPLES)
      throw new RangeError(`Invalid stochastic samples; use an integer from 1 to ${MAX_STOCHASTIC_SAMPLES}`);
    for (const flag of ['temporal', 'quad'] as const)
      if (options[flag] !== undefined && typeof options[flag] !== 'boolean')
        throw new TypeError(`Invalid stochastic ${flag}; use true or false`);
    this.lights = options.lights;
    this.samples = samples;
    this.temporal = options.temporal ?? true;
    this.quad = options.quad ?? true;
  }
  get owner(): Engine | undefined {
    return this.engine;
  }
  static attach(instance: EngineKernel, options: StochasticLightOptions): StochasticLights {
    const effect = new StochasticLights(options);
    engineRuntime(instance).use(effect);
    return effect;
  }
  /** @internal ClusteredStochastic: the uniform, random numbers and quad sum. */
  declarations(group: number): string {
    return declarations(group, this.quad);
  }
  /** @internal ClusteredStochastic: the light loop (see `lighting`). */
  lighting(cell: string, head: string, radiance: string, visibility: string, shadowed: string): string {
    return lighting(cell, head, radiance, visibility, shadowed);
  }
  /** @internal ClusteredStochastic: binding 151 of the lit shader's group. */
  bindings(): GPUBindGroupEntry[] {
    if (!this.uniform || this.disposed)
      throw new MargoError('state', 'Stochastic lights are not attached; attach them to an engine first');
    return this.entries;
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'Stochastic lights require WebGPU and a live effect; attach a new StochasticLights to a WebGPU engine; see https://margoengine.com/errors#webgpu',
      );
    this.engine = engine;
    this.device = engine.gpu;
    this.uniform = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.entries = [{ binding: BINDING, resource: { buffer: this.uniform } }];
    this.values[1] = this.samples;
    this.write();
    this.lights.stochastic = this;
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: -6,
      execute: (c) => {
        if (c.backend !== 'webgpu' || !this.temporal || !this.uniform) return;
        this.frame++;
        this.write();
      },
    });
  }
  private write(): void {
    // A hashed seed keeps consecutive frames' patterns unrelated.
    this.values[0] = this.temporal ? Math.imul(this.frame + 1, 0x9e3779b1) >>> 0 : 0x2545f491;
    this.device!.queue.writeBuffer(this.uniform!, 0, this.values as Uint32Array<ArrayBuffer>);
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  private release(): void {
    if (this.lights.stochastic === this) this.lights.stochastic = undefined;
    this.uniform?.destroy();
    this.uniform = undefined;
    this.entries = [];
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.removePlugin(this.name);
    this.release();
    this.engine = this.device = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
