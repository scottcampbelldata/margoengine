/// <reference lib="esnext.disposable" preserve="true" />
import { SceneTarget } from '../../shared/msaa.js';
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { fullscreen, render, group } from '../../shared/gpu.js';
import type { StackStage } from '../../shared/stack.js';
import { margoError } from '../../shared/errors.js';
import { applyView, viewLoadOp } from '../../shared/view-rect.js';
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number; COPY_DST: number };
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** SMAA quality presets: edge threshold, search steps and corner handling (see {@link SMAAOptions}). */
export type SMAAQuality = 'low' | 'medium' | 'high' | 'ultra';

/** Options of {@link SMAA}; all may change per frame. A preset sets the three tuning values; a value given here wins. */
export interface SMAAOptions {
  /** `'low'` (threshold 0.15, 4 steps), `'medium'` (0.1, 8), `'high'` (0.1, 16, corners kept at 0.25) or `'ultra'`
   * (0.05, 32, corners 0.25). Default `'high'`. */
  quality?: SMAAQuality;
  /** `'luma'` (default) compares the luma of the display-encoded colour; `'color'` the largest channel difference. Both
   * also compare alpha, so silhouettes on a transparent canvas are found. */
  edgeDetection?: 'luma' | 'color';
  /** Smallest contrast between neighbours that counts as an edge, 0.01-0.5. */
  threshold?: number;
  /** Bilinear search steps along an edge in each direction, two pixels per step, an integer 1-32. */
  maxSearchSteps?: number;
  /** Share of the blending kept where an edge meets a real corner (its crossing edge runs on), 0-1: 0 keeps corners
   * sharp, 1 rounds them like any other step (no corner detection). */
  cornerRounding?: number;
  /** False passes the frame through. Default true; also `smaa.enabled`. */
  enabled?: boolean;
}

// Preset thresholds and step counts as the SMAA authors publish them (Jimenez et al. 2012).
const presets: Record<SMAAQuality, readonly [number, number, number]> = {
  low: [0.15, 4, 1],
  medium: [0.1, 8, 1],
  high: [0.1, 16, 0.25],
  ultra: [0.05, 32, 0.25],
};
// The area table covers distances to an edge end of 0-64 pixels (two per search step, at most 32 steps). Heights of the
// rebuilt silhouette at an edge end, in pixels toward the far side of the edge, by the crossing edge found there:
// none, on the owner's side, on the far side, or both (a junction, no slope).
const reach = 64,
  side = reach + 1,
  heights = [0, -0.5, 0.5, 0];
let tables: { area: Uint8Array<ArrayBuffer>; search: Uint8Array<ArrayBuffer> } | undefined;
// Both lookup tables, built on first use from the morphological model of Jimenez et al. 2012 (after Reshetov 2009).
// Area: the edge is the pixel boundary from 0 to L = d0 + d1 + 1 along it; the silhouette runs from the crossing edge's
// middle at each end (height h0, h1) to the edge's middle, L/2, where it meets the boundary (so a Z, L or U shape).
// Texel (c0 * 65 + d0, c1 * 65 + d1) holds, for the pixel d0 from the near end (crossing code c0) and d1 from the far
// end (c1), the area between that line and the boundary over the pixel: red where the line runs on the far side (the
// far pixel takes the owner's colour), green on the owner's side (the owner takes the far pixel's), both times 2.
// Search: a walk reads two pixels per bilinear fetch, weighted 3:1 along the edge and 7:1 across it toward the owner's
// row, so each channel is a distinct sum of four flags in 32nds (21, 7, 3, 1). Texel (main, crossing) of those sums
// gives how many of the pair's pixels still belong to the edge, walking back (red) or forward (green).
function lookups() {
  if (tables) return tables;
  const width = 4 * side,
    area = new Uint8Array(width * width * 2),
    search = new Uint8Array(33 * 33 * 2);
  for (let c0 = 0; c0 < 4; c0++)
    for (let c1 = 0; c1 < 4; c1++)
      for (let d0 = 0; d0 < side; d0++)
        for (let d1 = 0; d1 < side; d1++) {
          const half = (d0 + d1 + 1) / 2;
          let far = 0,
            own = 0;
          // The line is h * |t / half - 1| on each half, linear, so its integral over a piece is length x middle value.
          for (const [from, to, h] of [
            [d0, Math.min(d0 + 1, half), heights[c0]],
            [Math.max(d0, half), d0 + 1, heights[c1]],
          ]) {
            if (to <= from || !h) continue;
            const a = (to - from) * h * Math.abs((from + to) / 2 / half - 1);
            if (a > 0) far += a;
            else own -= a;
          }
          const i = ((c1 * side + d1) * width + c0 * side + d0) * 2;
          area[i] = Math.round(far * 510);
          area[i + 1] = Math.round(own * 510);
        }
  for (let bits = 0; bits < 256; bits++) {
    const b = (n: number) => (bits >> n) & 1,
      main = 21 * b(0) + 7 * b(1) + 3 * b(2) + b(3),
      crossing = 21 * b(4) + 7 * b(5) + 3 * b(6) + b(7),
      first = b(4) | b(6),
      second = b(5) | b(7),
      i = (crossing * 33 + main) * 2;
    // Back: the pair is (pixel, the one behind it); a crossing on the first pixel's far side ends the edge after it.
    search[i] = b(0) ? (first || !b(1) ? 1 : 2) : 0;
    // Forward: each pixel's crossing flag is the boundary before it.
    search[i + 1] = b(0) && !first ? (b(1) && !second ? 2 : 1) : 0;
  }
  return (tables = { area, search });
}

const uniforms = `
struct S {threshold:f32,steps:f32,rounding:f32,color:f32}
@group(0) @binding(0) var<uniform> s:S;
`;
// Pass 1, edges: red marks an edge on the pixel's left side, green on its top, where the contrast to that neighbour
// reaches the threshold and at least half the strongest contrast around it (local contrast adaptation).
const edgeShader =
  fullscreen +
  uniforms +
  `
@group(0) @binding(1) var image:texture_2d<f32>;
fn pixel(q:vec2i)->vec4f {return textureLoad(image,clamp(q,vec2i(0),vec2i(textureDimensions(image))-1),0);}
fn contrast(a:vec4f,b:vec4f)->f32 {let d=abs(a-b);return max(select(abs(dot(a.rgb-b.rgb,vec3f(0.2126,0.7152,0.0722))),max(d.r,max(d.g,d.b)),s.color>0.5),d.a);}
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {
 let q=vec2i(p.xy);let c=pixel(q);let left=pixel(q-vec2i(1,0));let top=pixel(q-vec2i(0,1));
 let d=vec2f(contrast(c,left),contrast(c,top));var e=step(vec2f(s.threshold),d);
 if(e.x+e.y==0){return vec4f(0);}
 let around=max(max(contrast(c,pixel(q+vec2i(1,0))),contrast(c,pixel(q+vec2i(0,1)))),max(contrast(left,pixel(q-vec2i(2,0))),contrast(top,pixel(q-vec2i(0,2)))));
 e*=step(vec2f(max(around,max(d.x,d.y))),2*d);
 return vec4f(e,0,0);
}`;
// Pass 2, blending weights per edge: walk to both ends, read the crossing edges there, look up the covered areas.
// Out: x, y for the edge on the pixel's top (the pixel above takes this one's colour by x; this one the above's by y),
// z, w alike for the edge on its left.
// Edge walk: bilinear double fetch after Jimenez et al., "Practical Morphological Antialiasing" (GPU Pro 2, 2011);
// its stop thresholds 0.83 and 0.015 follow from Margo's 21/7/3/1 (in 32nds) edge encoding.
const weightShader =
  fullscreen +
  uniforms +
  `
@group(0) @binding(1) var edges:texture_2d<f32>;
@group(0) @binding(2) var bilinear:sampler;
@group(0) @binding(3) var areas:texture_2d<f32>;
@group(0) @binding(4) var searches:texture_2d<u32>;
fn edge(q:vec2i)->vec2f {if(any(q<vec2i(0))||any(q>=vec2i(textureDimensions(edges)))){return vec2f(0);}return textureLoad(edges,q,0).rg;}
fn crosses(q:vec2i,h:bool)->bool {let e=edge(q);return select(e.y,e.x,h)>0.5;}
fn crossing(e:vec2i,across:vec2i,h:bool)->i32 {return select(0,1,crosses(e,h))+select(0,2,crosses(e-across,h));}
// Pixels of the edge from start in steps of dir, two per fetch; y = 1 when the walk reached its step limit.
fn walk(start:vec2i,dir:vec2i,across:vec2i,h:bool,back:bool)->vec2i {
 let size=vec2f(textureDimensions(edges));let offset=0.5+0.25*vec2f(dir)-0.125*vec2f(across);var a=start;var n=0;
 for(var j=0;j<i32(s.steps);j++){
  let v=textureSampleLevel(edges,bilinear,(vec2f(a)+offset)/size,0).rg;let m=select(v.x,v.y,h);let c=select(v.y,v.x,h);
  if(m<0.83||c>0.015){let k=textureLoad(searches,vec2i(round(vec2f(m,c)*32)),0).xy;return vec2i(n+i32(select(k.y,k.x,back)),0);}
  n+=2;a+=2*dir;
 }
 return vec2i(n,1);
}
// Where the crossing edge runs on past its pixel, the end is a corner of the shape, not a step: keep it sharper.
fn corner(e:vec2i,across:vec2i,h:bool,code:i32)->f32 {
 let on=(code==1&&crosses(e+across,h))||(code==2&&crosses(e-2*across,h));return select(1.0,s.rounding,on);
}
fn coverage(q:vec2i,h:bool)->vec2f {
 let along=select(vec2i(0,1),vec2i(1,0),h);let across=select(vec2i(1,0),vec2i(0,1),h);
 let back=walk(q,-along,across,h,true);let forward=walk(q+along,along,across,h,false);
 let at=dot(q,along);let last=dot(vec2i(textureDimensions(edges)),along)-1;
 var d0=back.x-1;var d1=forward.x;var open=vec2i(back.y,forward.y);
 if(d0>at){d0=at;open.x=1;}
 if(d1>last-at){d1=last-at;open.y=1;}
 let e0=q-d0*along;let e1=q+(d1+1)*along;
 let c0=crossing(e0,across,h)*(1-open.x);let c1=crossing(e1,across,h)*(1-open.y);
 let k0=corner(e0,across,h,c0);let k1=corner(e1,across,h,c1);
 let a=textureLoad(areas,vec2i(c0*${side}+d0,c1*${side}+d1),0).rg*0.5;
 return a*select(select(0.5*(k0+k1),k1,d1<d0),k0,d0<d1);
}
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {
 let q=vec2i(p.xy);let e=edge(q);var w=vec4f(0);
 if(e.y>0.5){w=vec4f(coverage(q,true),0,0);}
 if(e.x>0.5){w=vec4f(w.xy,coverage(q,false));}
 return w;
}`;
// Pass 3, neighbourhood blending: each pixel mixes with its neighbours by the weights of the edges it touches, along
// the stronger direction only; display-encoded and premultiplied as stored, so alpha stays valid.
const blendShader =
  fullscreen +
  `
@group(0) @binding(0) var image:texture_2d<f32>;
@group(0) @binding(1) var weights:texture_2d<f32>;
fn pixel(q:vec2i)->vec4f {return textureLoad(image,clamp(q,vec2i(0),vec2i(textureDimensions(image))-1),0);}
fn weight(q:vec2i)->vec4f {if(any(q>=vec2i(textureDimensions(weights)))){return vec4f(0);}return textureLoad(weights,q,0);}
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {
 let q=vec2i(p.xy);let w=weight(q);let c=pixel(q);
 let up=w.y;let down=weight(q+vec2i(0,1)).x;let left=w.w;let right=weight(q+vec2i(1,0)).z;
 if(max(max(up,down),max(left,right))==0){return c;}
 if(max(left,right)>max(up,down)){return c*(1-left-right)+pixel(q-vec2i(1,0))*left+pixel(q+vec2i(1,0))*right;}
 return c*(1-up-down)+pixel(q-vec2i(0,1))*up+pixel(q+vec2i(0,1))*down;
}`;

/** Enhanced subpixel morphological anti-aliasing after Jimenez et al. 2012: edges from luma or colour with local
 * contrast adaptation, blending weights from a bilinear edge search and a coverage-area table (both lookup textures
 * built in code on first use), then neighbourhood blending. Alone it captures the finished frame outside every other
 * effect, like FXAA; in a PostStack it is an LDR effect after the display effect. Use SMAA or FXAA, not both.
 * @throws RangeError or TypeError for invalid options; MargoError `'unsupported'` on a WebGL engine, `'disposed'` after
 * `dispose()`, `'attached'` when attached twice or next to FXAA. */
export class SMAA implements EnginePlugin {
  readonly name = 'smaa';
  private engine?: Engine;
  private sampler?: GPUSampler;
  private uniform?: GPUBuffer;
  private area?: GPUTexture;
  private search?: GPUTexture;
  private edgePipeline?: GPURenderPipeline;
  private weightPipeline?: GPURenderPipeline;
  private blendPipeline?: GPURenderPipeline;
  private edgeGroup?: GPUBindGroup;
  private weightGroup?: GPUBindGroup;
  private blendGroup?: GPUBindGroup;
  private edges?: GPUTexture;
  private weights?: GPUTexture;
  private edgeView?: GPUTextureView;
  private weightView?: GPUTextureView;
  private input?: GPUTextureView;
  private key = '';
  private target?: SceneTarget;
  private color?: GPUTexture;
  private depth?: GPUTexture;
  private view?: GPUTextureView;
  private original?: GPUTextureView;
  private multisample?: GPUMultisampleState;
  private stacked = false;
  private disposed = false;
  private readonly values = new Float32Array(4);
  private readonly written = new Float32Array(4).fill(NaN);
  private readonly attachment: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'clear', storeOp: 'store' };
  private readonly descriptor: GPURenderPassDescriptor = { colorAttachments: [this.attachment] };
  constructor(readonly options: SMAAOptions = {}) {
    this.validate();
  }
  /** Attaches SMAA alone: it captures the finished frame (outside Bloom, SSAO, a PostStack) and anti-aliases it. */
  static attach(instance: EngineKernel, options: SMAAOptions = {}): SMAA {
    const effect = new SMAA(options);
    engineRuntime(instance).use(effect);
    return effect;
  }
  /** False passes the frame through; the same as `options.enabled`. */
  get enabled(): boolean {
    return this.options.enabled ?? true;
  }
  set enabled(value: boolean) {
    if (typeof value !== 'boolean') throw new TypeError('SMAA enabled must be boolean');
    this.options.enabled = value;
  }
  private validate(): void {
    const o = this.options,
      t = o.threshold ?? 0.1,
      n = o.maxSearchSteps ?? 1,
      r = o.cornerRounding ?? 0;
    if (
      (o.quality !== undefined && !Object.hasOwn(presets, o.quality)) ||
      (o.edgeDetection !== undefined && o.edgeDetection !== 'luma' && o.edgeDetection !== 'color') ||
      (o.enabled !== undefined && typeof o.enabled !== 'boolean')
    )
      throw new TypeError(
        "Invalid SMAA options; quality must be 'low', 'medium', 'high' or 'ultra', edgeDetection 'luma' or 'color', enabled a boolean.",
      );
    if (!(t >= 0.01 && t <= 0.5) || !(Number.isInteger(n) && n >= 1 && n <= 32) || !(r >= 0 && r <= 1))
      throw new RangeError(
        'Invalid SMAA options; threshold must be 0.01-0.5, maxSearchSteps an integer 1-32, cornerRounding 0-1.',
      );
  }
  private joinStack(): StackStage {
    if (this.engine || this.stacked || this.disposed)
      throw margoError('attached', 'SMAA is already attached; create a new SMAA');
    this.stacked = true;
    return {
      kind: 'ldr',
      render: (c, input, output) => this.paint(c, input, output.format, output.multisample, output.view),
    };
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw margoError(
        this.disposed ? 'disposed' : 'unsupported',
        'SMAA requires WebGPU and a live effect; attach a new SMAA to a WebGPU engine; see https://margoengine.com/errors#webgpu',
      );
    if (engine.hasPlugin('fxaa'))
      throw margoError('attached', 'SMAA cannot run next to FXAA; remove FXAA or keep it instead of SMAA');
    this.engine = engine;
    const device = engine.gpu,
      { area, search } = lookups(),
      usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.written.fill(NaN);
    this.area = device.createTexture({ size: [4 * side, 4 * side], format: 'rg8unorm', usage });
    device.queue.writeTexture({ texture: this.area }, area, { bytesPerRow: 8 * side }, [4 * side, 4 * side]);
    this.search = device.createTexture({ size: [33, 33], format: 'rg8uint', usage });
    device.queue.writeTexture({ texture: this.search }, search, { bytesPerRow: 66 }, [33, 33]);
  }
  registerPasses(graph: FrameGraph): void {
    if (this.stacked) return;
    graph.add({
      name: 'smaa:capture',
      order: -80,
      execute: (c) => {
        if (c.backend === 'webgpu') this.capture(c);
      },
    });
    graph.add({
      name: 'smaa:resolve',
      order: 50,
      execute: (c) => {
        if (c.backend !== 'webgpu') return;
        this.target!.resolve(c.encoder, true);
        this.paint(c, this.view!, this.color!.format, this.multisample, this.original!);
        this.target!.restore(c);
      },
    });
  }
  private capture(c: Context): void {
    const samples = c.descriptor.multisample?.count ?? 4,
      depth = c.descriptor.depthStencil!.format;
    if (
      this.color?.width !== c.width ||
      this.color.height !== c.height ||
      this.color.format !== c.format ||
      this.depth!.format !== depth ||
      this.target!.samples !== samples
    ) {
      this.releaseCapture();
      const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
      this.color = c.device.createTexture({ size: [c.width, c.height], format: c.format, usage });
      this.depth = c.device.createTexture({ size: [c.width, c.height], format: depth, usage });
      this.target = new SceneTarget(c.device, this.color, this.depth, samples);
      this.view = this.color.createView();
    }
    this.original = c.color;
    this.multisample = c.descriptor.multisample;
    this.target!.begin(c);
  }
  private paint(
    c: Context,
    input: GPUTextureView,
    format: GPUTextureFormat,
    multisample: GPUMultisampleState | undefined,
    view: GPUTextureView,
  ): void {
    this.validate();
    const o = this.options,
      d = c.device,
      v = this.values,
      preset = presets[o.quality ?? 'high'];
    v[0] = o.threshold ?? preset[0];
    v[1] = o.maxSearchSteps ?? preset[1];
    v[2] = o.cornerRounding ?? preset[2];
    v[3] = +(o.edgeDetection === 'color');
    if (v.some((value, i) => value !== this.written[i])) {
      this.written.set(v);
      d.queue.writeBuffer(this.uniform!, 0, v as Float32Array<ArrayBuffer>);
    }
    if (this.edges?.width !== c.width || this.edges.height !== c.height) {
      this.releaseTargets();
      const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
      this.edges = d.createTexture({ size: [c.width, c.height], format: 'rg8unorm', usage });
      this.weights = d.createTexture({ size: [c.width, c.height], format: 'rgba16float', usage });
      this.edgeView = this.edges.createView();
      this.weightView = this.weights.createView();
    }
    this.edgePipeline ??= render(d, edgeShader, 'rg8unorm');
    if (!this.weightPipeline) {
      this.weightPipeline = render(d, weightShader, 'rgba16float');
      this.weightGroup = undefined;
    }
    const key = format + ':' + (multisample?.count ?? 1);
    if (this.key !== key) {
      this.key = key;
      this.blendPipeline = render(d, blendShader, format, { multisample });
      this.input = undefined;
    }
    if (this.input !== input || !this.blendGroup) {
      this.input = input;
      this.edgeGroup = group(d, this.edgePipeline, [{ buffer: this.uniform! }, input]);
      this.blendGroup = group(d, this.blendPipeline!, [input, this.weightView!]);
    }
    this.weightGroup ??= group(d, this.weightPipeline, [
      { buffer: this.uniform! },
      this.edgeView!,
      this.sampler!,
      this.area!.createView(),
      this.search!.createView(),
    ]);
    if (this.enabled) {
      this.pass(c, this.edgeView!, this.edgePipeline, this.edgeGroup!);
      this.pass(c, this.weightView!, this.weightPipeline, this.weightGroup);
    } else this.pass(c, this.weightView!);
    this.pass(c, view, this.blendPipeline!, this.blendGroup, true);
  }
  // One fullscreen draw into a cleared target; without a pipeline only the clear. The blend into the output (`output`)
  // stays inside the current view's viewport and scissor and keeps the views drawn before it.
  private pass(
    c: Context,
    view: GPUTextureView,
    pipeline?: GPURenderPipeline,
    bindings?: GPUBindGroup,
    output = false,
  ): void {
    this.attachment.view = view;
    this.attachment.loadOp = output ? viewLoadOp(c, 'clear') : 'clear';
    const pass = c.encoder.beginRenderPass(this.descriptor);
    if (pipeline) {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindings!);
      if (output) applyView(pass, c);
      pass.draw(3);
    }
    pass.end();
  }
  private releaseTargets(): void {
    this.edges?.destroy();
    this.weights?.destroy();
    this.edges = this.weights = this.edgeView = this.weightView = undefined;
    this.weightGroup = this.blendGroup = undefined;
  }
  private releaseCapture(): void {
    this.target?.dispose();
    this.color?.destroy();
    this.depth?.destroy();
    this.target = this.color = this.depth = this.view = undefined;
  }
  private release(): void {
    this.releaseCapture();
    this.releaseTargets();
    this.uniform?.destroy();
    this.area?.destroy();
    this.search?.destroy();
    this.uniform = this.area = this.search = this.sampler = undefined;
    this.edgePipeline = this.weightPipeline = this.blendPipeline = this.edgeGroup = this.input = undefined;
    this.key = '';
    this.attachment.view = undefined!;
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
    this.original = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
