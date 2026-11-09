/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel, Mesh } from '@margoengine/core';
import {
  engineRuntime,
  meshRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import type { Vec3 } from '@margoengine/math';
import { ParticleOverlay } from '../../shared/particle-overlay.js';
import { viewSize } from '../../shared/view-rect.js';
import { rainCover } from './rain-cover.js';
import type { WeatherOcclusion } from './weather.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; STORAGE: number };
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;
/** The weather the effects follow: `Weather` from `@margoengine/sky/weather`. */
export interface WeatherFxSource {
  /** Visible precipitation, 0 to 1. */
  readonly amount: number;
  /** Seconds of weather time. */
  readonly elapsed: number;
  readonly options: {
    readonly precipitation?: string;
    readonly radius?: number;
    readonly height?: number;
    readonly color?: Vec3;
    readonly brightness?: number;
  };
  /** Share of the precipitation that is rain, 0 to 1 (`Weather` has it; without it rain is 1 and anything else 0). */
  readonly rainShare?: number;
  /** Set by {@link WeatherFX}: the cover map that keeps rain off what is under the occluders. */
  occlusion?: WeatherOcclusion;
}
/** One drawable primitive of an occluder that is not a core mesh: gltf-pro models and terrain expose them as `shadowPrimitives`. */
export interface OccluderPrimitive {
  readonly node: { readonly matrix: ArrayLike<number> };
  readonly vertex: GPUBuffer;
  readonly vertexOffset?: number;
  readonly index: GPUBuffer;
  readonly count: number;
  /** 24 (core vertices) or 80 (PBR vertices). */
  readonly stride: number;
}
/** What keeps the rain off: a core mesh, or a source of {@link OccluderPrimitive}s (a gltf-pro model, terrain). */
export type RainOccluder = Mesh | { readonly shadowPrimitives?: readonly OccluderPrimitive[] };
/** {@link WeatherFX} settings, read every frame from `fx.options`. */
export interface WeatherFxOptions {
  /** The weather whose rain splashes, wets the lens and is kept off under the occluders. */
  weather: WeatherFxSource;
  /** Roofs, bridges, trees and the ground: the topmost of them at each place is where rain lands. Default none. */
  occluders?: readonly RainOccluder[];
  /** Height of the ground where no occluder is below, for the splashes. Default 0. */
  ground?: number;
  /** Texels per side of the top-down cover map over the weather's box, 32 to 2048. Default 256. */
  resolution?: number;
  /** Splashes at full rain, 0 to 100,000; each lasts a third of a second where it lands. Default 3000. */
  splashes?: number;
  /** Height of a splash, metres, 0.01 to 2. Default 0.15. */
  splashSize?: number;
  /** Drops on the lens of a camera standing in full rain, 0 to 500. Default 40. */
  lensDrops?: number;
  /** Radius of a lens drop, a share of the view's height, 0.002 to 0.2. Default 0.03. */
  dropSize?: number;
}
const defaults = {
  ground: 0,
  resolution: 256,
  splashes: 3000,
  splashSize: 0.15,
  lensDrops: 40,
  dropSize: 0.03,
} as const;
// The cover map: a top-down orthographic depth over the weather's box, depth 0 at `top` (1 km over the camera) and 1 at
// the box's floor, so a texel's depth is the height of the topmost occluder there.
const ABOVE = 1000;
const coverShader = (stride: number) => /* wgsl */ `
@group(0) @binding(0) var<uniform> view:mat4x4f;
@group(0) @binding(1) var<storage,read> models:array<mat4x4f>;
@vertex fn vertex(@location(0) p:vec${stride === 80 ? 4 : 3}f,@builtin(instance_index) k:u32)->@builtin(position) vec4f {return view*(models[k]*vec4f(p.xyz,1));}
`;
// PCG hash (O'Neill 2014; GPU form Jarzynski and Olano 2020, JCGT 9(3)), as the weather's own particles.
const common = /* wgsl */ `
struct Fx {camera:mat4x4f,eye:vec4f,box:vec4f,screen:vec4f,colour:vec4f,lens:vec4f,seed:vec4f}
@group(0) @binding(0) var<uniform> fx:Fx;
struct Out {@builtin(position) position:vec4f,@location(0) uv:vec2f,@location(1) t:f32,@location(2) alpha:f32}
fn pcg(v:u32)->u32 {let s=v*747796405u+2891336453u;let x=((s>>((s>>28u)+4u))^s)*277803737u;return (x>>22u)^x;}
fn rnd(i:u32,k:u32)->f32 {return f32(pcg(i*8u+k+bitcast<u32>(fx.seed.x))>>8u)*5.9604645e-8;}
const corners=array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1));
const culled=Out(vec4f(2,2,2,1),vec2f(0),0.0,0.0);
`;
// Splashes: each slot lands once a period at a new place in the box, on the topmost surface the cover map holds there
// (the ground height where it holds none): a crown ring spreading at the base and four droplets thrown out on arcs.
const splashShader = /* wgsl */ `${common}${rainCover(1)}
@vertex fn vertex(@builtin(vertex_index) vi:u32,@builtin(instance_index) ii:u32)->Out {
 let clock=fx.eye.w/fx.box.z+rnd(ii,0u);let n=ii*65536u+u32(floor(clock))%65536u;
 let xz=fx.eye.xz+(vec2f(rnd(n,1u),rnd(n,2u))-0.5)*fx.box.x;
 let d=rainCoverDepth(xz);let y=select(fx.screen.w,rainCoverFrame.area.w-d*rainCoverFrame.depth.x,d<1.0);
 if(abs(y-fx.eye.y)>fx.box.y){return culled;}
 let size=fx.box.w*(0.6+0.8*rnd(n,3u));let c=fx.camera*vec4f(xz.x,y+0.02+size*0.5,xz.y,1);
 if(c.w<0.1){return culled;}
 let px=size*0.5*fx.screen.z/c.w;let corner=corners[vi];
 let edge=max(abs(xz.x-fx.eye.x),abs(xz.y-fx.eye.z))*2.0/fx.box.x;
 return Out(vec4f(c.xy+corner*max(px,0.5)*2.0/fx.screen.xy*c.w,c.z,c.w),corner,fract(clock),(1.0-smoothstep(0.7,1.0,edge))*min(1.0,px));
}
@fragment fn fragment(i:Out)->@location(0) vec4f {
 let t=i.t;let p=i.uv;let r=0.25+0.7*t;
 var a=1.0-smoothstep(0.0,0.12,abs(length(vec2f(p.x,(p.y+0.85)*4.0))-r));
 for(var k=0;k<4;k++){let s=f32(k)/1.5-1.0;let q=vec2f(s*0.85*t,-0.85+3.0*t*(1.0-t)*(0.7+0.3*abs(s)));a=max(a,1.0-smoothstep(0.06,0.14,length(p-q)));}
 a*=(1.0-t)*(1.0-t)*i.alpha*fx.colour.w;
 if(a<=0.004){discard;}
 return vec4f(fx.colour.rgb,a);
}
`;
// Lens drops: a slot is on the lens while the lens wetness is above its own random level, lives a few seconds at a
// random place, and one in three runs down as it ages. A drop is a clear disc with a dark rim and a highlight.
const lensShader = /* wgsl */ `${common}
@group(0) @binding(1) var<storage,read> lensState:vec4f;
@vertex fn vertex(@builtin(vertex_index) vi:u32,@builtin(instance_index) ii:u32)->Out {
 let wet=clamp((lensState.x-rnd(ii,1u))*8.0,0.0,1.0);if(wet<=0.0){return culled;}
 let clock=fx.eye.w/(fx.lens.y*(0.6+0.8*rnd(ii,2u)))+rnd(ii,0u);let n=ii*65536u+u32(floor(clock))%65536u;let t=fract(clock);
 let slide=select(0.0,t*t*0.6,rnd(n,3u)>0.67);
 let centre=vec2f(rnd(n,4u)*2.0-1.0,1.0-2.0*rnd(n,5u)-slide);
 let radius=fx.lens.x*(0.5+rnd(n,6u))*2.0;let corner=corners[vi];
 return Out(vec4f(centre+corner*vec2f(radius*fx.screen.y/fx.screen.x,radius),1,1),corner,t,wet*smoothstep(0.0,0.08,t)*(1.0-smoothstep(0.85,1.0,t)));
}
@fragment fn fragment(i:Out)->@location(0) vec4f {
 let d=length(i.uv);if(d>=1.0){discard;}
 let spot=1.0-smoothstep(0.0,0.3,length(i.uv-vec2f(-0.35,0.4)));let rim=smoothstep(0.7,0.95,d);
 let a=(0.12+0.45*rim+0.55*spot)*(1.0-smoothstep(0.92,1.0,d))*i.alpha;
 return vec4f(mix(fx.colour.rgb*0.3,fx.colour.rgb*1.8,spot),a);
}
`;
// Lens wetness: toward the rain's amount (rising in about 4 s) while the camera stands in the open, drying in about
// 25 s under cover or when it stops.
const wetShader = /* wgsl */ `struct Fx {camera:mat4x4f,eye:vec4f,box:vec4f,screen:vec4f,colour:vec4f,lens:vec4f,seed:vec4f}
@group(0) @binding(0) var<uniform> fx:Fx;
${rainCover(1)}
@group(0) @binding(3) var<storage,read_write> lensState:vec4f;
@compute @workgroup_size(1) fn main(){
 let goal=select(fx.seed.y,0.0,rainCovered(fx.eye.xyz));let s=lensState.x;
 lensState=vec4f(s+(goal-s)*(1.0-exp(-fx.lens.z/select(25.0,4.0,goal>s))),0,0,0);
}
`;
// The weather's particle shader under cover: a particle below the topmost occluder at its place is dropped.
const coveredShaders = new Map<string, string>();
const covered = (code: string): string => {
  let out = coveredShaders.get(code);
  if (!out) {
    out = code
      .replace('var<uniform> w:Weather;', `var<uniform> w:Weather;${rainCover(1)}`)
      .replace('let snow=w.params.x>0.5;', 'if(rainCovered(q)){return culled;}\n let snow=w.params.x>0.5;');
    coveredShaders.set(code, out);
  }
  return out;
};
const count = (value: number, low: number, high: number) => Number.isInteger(value) && value >= low && value <= high;
const inRange = (value: number, low: number, high: number) => Number.isFinite(value) && value >= low && value <= high;
/**
 * Rain that behaves like rain around the scene: no rain or snow falls under roofs, bridges and trees, splashes rise
 * where the rain lands, and drops gather on the lens of a camera standing in the open. A top-down depth of the
 * occluders over the weather's box (as a shadow map, from above) says what is covered and where the top surfaces are;
 * the `Weather` reads it to cull its particles.
 * `WeatherFX.attach(engine, {weather, occluders: [roof, ground]})`.
 * @throws TypeError / RangeError on invalid options; MargoError `'unsupported'` on a WebGL engine, `'disposed'` after
 * `dispose()`.
 */
export class WeatherFX implements EnginePlugin {
  readonly name: string = 'sky:weather-fx';
  private engine?: Engine;
  private readonly occlusion: {
    buffer: GPUBuffer | undefined;
    view: GPUTextureView | undefined;
    shader(code: string): string;
  } = {
    buffer: undefined,
    view: undefined,
    shader: covered,
  };
  private map?: GPUTexture;
  private viewUniform?: GPUBuffer;
  private uniform?: GPUBuffer;
  private state?: GPUBuffer;
  private models?: GPUBuffer;
  private pipelines = new Map<number, GPURenderPipeline>();
  private groups = new Map<number, GPUBindGroup>();
  private wet?: { pipeline: GPUComputePipeline; group: GPUBindGroup };
  private extra?: GPUBindGroupEntry[];
  private lensExtra?: GPUBindGroupEntry[];
  private readonly splashOverlay = new ParticleOverlay();
  private readonly lensOverlay = new ParticleOverlay();
  private readonly values = new Float32Array(40);
  private readonly frame = new Float32Array(8);
  private readonly mapView = new Float32Array(16);
  private matrices = new Float32Array(16 * 16);
  private readonly draws: { p: OccluderPrimitive; k: number }[] = [];
  private delta = 0;
  private disposed = false;
  constructor(readonly options: WeatherFxOptions) {
    this.validate();
    options.weather.occlusion = this.occlusion;
  }
  static attach(engine: EngineKernel, options: WeatherFxOptions): WeatherFX {
    const fx = new WeatherFX(options);
    engineRuntime(engine).use(fx);
    return fx;
  }
  /** The top-down cover map this frame (depth32float: 0 at 1 km over the camera, 1 at the weather box's floor). */
  get coverTexture(): GPUTexture | undefined {
    return this.map;
  }
  private validate(): void {
    const o = this.options;
    if (typeof o !== 'object' || o === null || typeof o.weather?.options !== 'object' || !('amount' in o.weather))
      throw new TypeError('WeatherFX needs a Weather; pass {weather}');
    if (o.occluders !== undefined && !Array.isArray(o.occluders))
      throw new TypeError('WeatherFX occluders must be an array of meshes or models; pass [] for none');
    if (
      !inRange(o.ground ?? defaults.ground, -1e6, 1e6) ||
      !count(o.resolution ?? defaults.resolution, 32, 2048) ||
      !count(o.splashes ?? defaults.splashes, 0, 100000) ||
      !inRange(o.splashSize ?? defaults.splashSize, 0.01, 2) ||
      !count(o.lensDrops ?? defaults.lensDrops, 0, 500) ||
      !inRange(o.dropSize ?? defaults.dropSize, 0.002, 0.2)
    )
      throw new RangeError(
        'Invalid WeatherFX options; keep ground finite, integer resolution 32 to 2048, integer splashes 0 to 100000, splashSize 0.01 to 2, integer lensDrops 0 to 500 and dropSize 0.002 to 0.2.',
      );
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'WeatherFX requires WebGPU; attach a new WeatherFX to a WebGPU engine; see https://margoengine.com/errors#webgpu',
      );
    this.engine = engine;
    const d = engine.gpu,
      uniform = (size: number) => d.createBuffer({ size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.viewUniform = uniform(64);
    this.uniform = uniform(this.values.byteLength);
    this.occlusion.buffer = uniform(this.frame.byteLength);
    this.state = d.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }
  registerPasses(graph: FrameGraph): void {
    // The cover map before the weather's particles (6) read it; splashes after them; lens drops after the flash (6.5).
    graph.add({
      name: 'sky:weather-fx:cover',
      order: 5.9,
      execute: (c) => {
        if (c.backend === 'webgpu') this.cover(c);
      },
    });
    graph.add({
      name: 'sky:weather-fx:splashes',
      order: 6.1,
      execute: (c) => {
        if (c.backend === 'webgpu') this.splash(c);
      },
    });
    graph.add({
      name: 'sky:weather-fx:lens',
      order: 6.6,
      execute: (c) => {
        if (c.backend === 'webgpu') this.lens(c);
      },
    });
  }
  onPreUpdate(delta: number): void {
    this.validate();
    if (!Number.isFinite(delta) || delta < 0)
      throw new RangeError('Invalid WeatherFX delta; pass a finite delta of 0 or more seconds.');
    this.delta += delta;
  }
  private rain(): number {
    const w = this.options.weather;
    return w.amount * (w.rainShare ?? +((w.options.precipitation ?? 'rain') === 'rain'));
  }
  // The occluders' primitives this frame, each with the index of its world matrix in `models`.
  private gather(): number {
    const draws = this.draws,
      engine = this.engine!;
    draws.length = 0;
    let k = 0;
    const add = (p: OccluderPrimitive) => {
      if (16 * (k + 1) > this.matrices.length) {
        const grown = new Float32Array(this.matrices.length * 2);
        grown.set(this.matrices);
        this.matrices = grown;
      }
      this.matrices.set(p.node.matrix, 16 * k);
      draws.push({ p, k: k++ });
    };
    for (const source of this.options.occluders ?? []) {
      if ('id' in source) {
        const mesh = meshRuntime(source as Mesh);
        if (mesh.engine !== engine)
          throw new MargoError(
            'attached',
            'WeatherFX occluder belongs to another engine; use meshes of the same engine',
          );
        const buffers = mesh.geometry && mesh.visible ? engine.geometryBuffers(mesh.geometry) : null;
        if (buffers)
          add({
            node: mesh,
            vertex: buffers.vertex,
            index: buffers.index,
            count: mesh.geometry!.indices.length,
            stride: 24,
          });
      } else
        for (const p of (source as { shadowPrimitives?: readonly OccluderPrimitive[] }).shadowPrimitives ?? []) add(p);
    }
    return k;
  }
  private cover(c: Context): void {
    if (!this.uniform) return;
    const o = this.options,
      d = c.device,
      w = o.weather.options,
      n = o.resolution ?? defaults.resolution,
      size = 2 * (w.radius ?? 25),
      height = w.height ?? 20,
      texel = size / n,
      e = c.camera.position,
      x0 = Math.floor(e[0] / texel) * texel - size / 2,
      z0 = Math.floor(e[2] / texel) * texel - size / 2,
      top = e[1] + ABOVE,
      range = ABOVE + height + 1;
    if (!this.map || this.map.width !== n) {
      this.map?.destroy();
      this.map = d.createTexture({
        size: [n, n],
        format: 'depth32float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      this.occlusion.view = this.map.createView();
      this.extra = this.lensExtra = this.wet = undefined;
    }
    const f = this.frame;
    f.set([x0, z0, 1 / size, top, range, n, 0, 0]);
    d.queue.writeBuffer(this.occlusion.buffer!, 0, f as Float32Array<ArrayBuffer>);
    // World to the map's clip space: x across, z down the texture, depth 0 at `top` falling to 1 at `top - range`.
    const m = this.mapView;
    m.fill(0);
    m[0] = 2 / size;
    m[12] = (-2 * x0) / size - 1;
    m[9] = -2 / size;
    m[13] = 1 + (2 * z0) / size;
    m[6] = -1 / range;
    m[14] = top / range;
    m[15] = 1;
    d.queue.writeBuffer(this.viewUniform!, 0, m as Float32Array<ArrayBuffer>);
    const k = this.gather();
    if (k && (!this.models || this.models.size < k * 64)) {
      this.models?.destroy();
      this.models = d.createBuffer({
        size: this.matrices.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.groups.clear();
    }
    if (k) d.queue.writeBuffer(this.models!, 0, this.matrices as Float32Array<ArrayBuffer>, 0, k * 16);
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: this.occlusion.view!,
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    for (const { p, k: index } of this.draws) {
      let pipeline = this.pipelines.get(p.stride);
      if (!pipeline) {
        const module = d.createShaderModule({ code: coverShader(p.stride) });
        pipeline = d.createRenderPipeline({
          layout: 'auto',
          vertex: {
            module,
            entryPoint: 'vertex',
            buffers: [
              {
                arrayStride: p.stride,
                attributes: [{ shaderLocation: 0, offset: 0, format: p.stride === 80 ? 'float32x4' : 'float32x3' }],
              },
            ],
          },
          depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
        });
        this.pipelines.set(p.stride, pipeline);
      }
      let group = this.groups.get(p.stride);
      if (!group) {
        group = d.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.viewUniform! } },
            { binding: 1, resource: { buffer: this.models! } },
          ],
        });
        this.groups.set(p.stride, group);
      }
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.setVertexBuffer(0, p.vertex, p.vertexOffset || undefined);
      pass.setIndexBuffer(p.index, 'uint32');
      pass.drawIndexed(p.count, 1, 0, 0, index);
    }
    pass.end();
    this.write(c, size, height);
    this.wet ??= (() => {
      const pipeline = d.createComputePipeline({
        layout: 'auto',
        compute: { module: d.createShaderModule({ code: wetShader }), entryPoint: 'main' },
      });
      return {
        pipeline,
        group: d.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.uniform! } },
            { binding: 1, resource: { buffer: this.occlusion.buffer! } },
            { binding: 2, resource: this.occlusion.view! },
            { binding: 3, resource: { buffer: this.state! } },
          ],
        }),
      };
    })();
    const compute = c.encoder.beginComputePass();
    compute.setPipeline(this.wet.pipeline);
    compute.setBindGroup(0, this.wet.group);
    compute.dispatchWorkgroups(1);
    compute.end();
    this.delta = 0;
  }
  private write(c: Context, size: number, height: number): void {
    const o = this.options,
      w = o.weather,
      v = this.values,
      [width, tall] = viewSize(c) as [number, number],
      colour = w.options.color ?? [0.62, 0.68, 0.76],
      brightness = w.options.brightness ?? 1;
    v.set(c.camera.matrix, 0);
    v.set(c.camera.position, 16);
    // Weather time wraps at a day, where f32 still holds a millisecond.
    v[19] = w.elapsed % 86400;
    v[20] = size;
    v[21] = height;
    v[22] = 1 / 3;
    v[23] = o.splashSize ?? defaults.splashSize;
    v[24] = width;
    v[25] = tall;
    v[26] = tall / (2 * Math.tan((c.camera.fov * Math.PI) / 360));
    v[27] = o.ground ?? defaults.ground;
    for (let i = 0; i < 3; i++) v[28 + i] = colour[i] * brightness;
    v[31] = 0.6;
    v[32] = o.dropSize ?? defaults.dropSize;
    v[33] = 6;
    v[34] = this.delta;
    new Uint32Array(v.buffer)[36] = 0x2545f491;
    v[37] = Math.min(1, this.rain());
    c.device.queue.writeBuffer(this.uniform!, 0, v as Float32Array<ArrayBuffer>);
  }
  private splash(c: Context): void {
    const n = Math.round((this.options.splashes ?? defaults.splashes) * Math.min(1, this.rain()));
    if (!this.uniform || !this.occlusion.view || n === 0) return;
    this.extra ??= [
      { binding: 1, resource: { buffer: this.occlusion.buffer! } },
      { binding: 2, resource: this.occlusion.view },
    ];
    this.splashOverlay.draw(c, splashShader, this.uniform, this.values as Float32Array<ArrayBuffer>, n, this.extra);
  }
  private lens(c: Context): void {
    const n = this.options.lensDrops ?? defaults.lensDrops;
    if (!this.state || n === 0) return;
    this.lensExtra ??= [{ binding: 1, resource: { buffer: this.state } }];
    this.lensOverlay.draw(c, lensShader, this.uniform!, this.values as Float32Array<ArrayBuffer>, n, this.lensExtra);
  }
  private release(): void {
    for (const b of [this.viewUniform, this.uniform, this.occlusion.buffer, this.state, this.models]) b?.destroy();
    this.map?.destroy();
    this.viewUniform = this.uniform = this.state = this.models = this.map = undefined;
    this.occlusion.buffer = this.occlusion.view = undefined;
    this.extra = this.lensExtra = this.wet = undefined;
    this.pipelines.clear();
    this.groups.clear();
    this.splashOverlay.release();
    this.lensOverlay.release();
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.options.weather.occlusion === this.occlusion) this.options.weather.occlusion = undefined;
    this.engine?.removePlugin(this.name);
    this.release();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
