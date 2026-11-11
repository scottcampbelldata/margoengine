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
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;
// Luma-driven edge anti-aliasing after T. Lottes, "FXAA", NVIDIA whitepaper (2009, revised 2011): find local contrast
// in luma, decide the edge's orientation and side, walk along the edge to both ends, then shift one bilinear fetch
// across the edge by how close the pixel sits to the nearer end (or by a sub-pixel aliasing estimate). Built from the
// paper's prose; the thresholds, step schedule and filter weights below are this file's own choices.
// - Luma: ITU-R BT.601 weights (0.299, 0.587, 0.114) on the display-encoded colour, which is already perceptual.
// - RELATIVE 0.15: skip pixels whose contrast is under 15% of the brightest neighbour (soft gradients stay sharp).
// - FLOOR 0.05: absolute floor (about 13 of 255 codes) so near-black noise is not smoothed.
// - The gate is continuous: the final shift is scaled by smoothstep(gate, 2 * gate, contrast), so a pixel whose
//   contrast crosses the gate fades in instead of jumping from untouched to fully blended (a one-code change used to
//   move an isolated dot by nine codes, which made noise near the gate flicker). Taken from the native Rust engine's
//   presentation filter, which found the jump; Lottes' FXAA 3.11 keeps the hard cut.
// - END 0.25: an edge ends where the along-edge luma leaves the edge's mid luma by a quarter of the step across it.
// - Steps: 1, 1, 1, 1 then 2, 3, 4, 5, 6, 7 pixels (10 fetches per side, 31 pixels reach): exact near the pixel,
//   coarser far away where the shift is small anyway. Steps are whole pixels so each fetch stays on the boundary.
// - Sub-pixel: tent low-pass (direct neighbours weight 2, diagonals 1, over 12); strength 0.75 so an isolated dot is
//   softened but never fully replaced by its surroundings.
const shader =
  fullscreen +
  `
@group(0) @binding(0) var image:texture_2d<f32>;
@group(0) @binding(1) var bilinear:sampler;
const RELATIVE=0.15;
const FLOOR=0.05;
const END=0.25;
const SUBPIXEL=0.75;
fn luma(c:vec4f)->f32 {return dot(c.rgb,vec3f(0.299,0.587,0.114));}
fn texel(q:vec2i)->f32 {return luma(textureLoad(image,clamp(q,vec2i(0),vec2i(textureDimensions(image))-1),0));}
fn along(uv:vec2f)->f32 {return luma(textureSampleLevel(image,bilinear,uv,0));}
@fragment fn fragment(v:Vertex)->@location(0) vec4f {
 let q=vec2i(v.position.xy);
 let centre=textureLoad(image,q,0);
 let m=luma(centre);
 let n=texel(q+vec2i(0,-1));let s=texel(q+vec2i(0,1));let w=texel(q+vec2i(-1,0));let e=texel(q+vec2i(1,0));
 let hi=max(m,max(max(n,s),max(w,e)));let lo=min(m,min(min(n,s),min(w,e)));
 let contrast=hi-lo;
 let gate=max(FLOOR,hi*RELATIVE);
 if(contrast<gate){return centre;}
 let nw=texel(q+vec2i(-1,-1));let ne=texel(q+vec2i(1,-1));let sw=texel(q+vec2i(-1,1));let se=texel(q+vec2i(1,1));
 // Orientation: total luma change across rows against across columns (centre row/column counts twice).
 let rows=2*(abs(n-m)+abs(s-m))+abs(nw-w)+abs(sw-w)+abs(ne-e)+abs(se-e);
 let columns=2*(abs(w-m)+abs(e-m))+abs(nw-n)+abs(ne-n)+abs(sw-s)+abs(se-s);
 let horizontal=rows>=columns;
 let size=1/vec2f(textureDimensions(image));
 // Side: the neighbour across the edge with the larger step; 'across' points at it, one pixel long.
 let before=select(w,n,horizontal);let after=select(e,s,horizontal);
 let toBefore=abs(before-m)>=abs(after-m);
 let gradient=max(abs(before-m),abs(after-m));
 let mid=0.5*(m+select(after,before,toBefore));
 var across=select(vec2f(size.x,0),vec2f(0,size.y),horizontal);
 if(toBefore){across=-across;}
 let tangent=select(vec2f(0,size.y),vec2f(size.x,0),horizontal);
 // End search from the pixel boundary, where each bilinear fetch averages both sides of the edge.
 let start=v.position.xy*size+0.5*across;
 let limit=END*gradient;
 var back=0.0;var forth=0.0;var backDelta=0.0;var forthDelta=0.0;var backDone=false;var forthDone=false;
 for(var i=0u;i<10u;i++){
  let stride=select(1.0,f32(i)-2.0,i>=4u);
  if(!backDone){back+=stride;backDelta=along(start-tangent*back)-mid;backDone=abs(backDelta)>=limit;}
  if(!forthDone){forth+=stride;forthDelta=along(start+tangent*forth)-mid;forthDone=abs(forthDelta)>=limit;}
  if(backDone&&forthDone){break;}
 }
 // Edge shift: largest beside an end, zero mid-span, and only where the end turns toward this pixel's own side.
 let nearBack=back<forth;
 let nearest=min(back,forth);
 let endDelta=select(forthDelta,backDelta,nearBack);
 let endFound=select(forthDone,backDone,nearBack);
 var shift=0.0;
 if(endFound&&((m-mid)<0)!=(endDelta<0)){shift=0.5-nearest/(back+forth);}
 // Sub-pixel shift: how far the centre stands out from a low-pass of its neighbourhood, relative to the contrast.
 let low=(2*(n+s+w+e)+nw+ne+sw+se)/12;
 let blend=smoothstep(0.0,1.0,clamp(abs(low-m)/contrast,0.0,1.0));
 shift=max(shift,SUBPIXEL*blend*blend)*smoothstep(gate,2*gate,contrast);
 if(shift<=0){return centre;}
 return textureSampleLevel(image,bilinear,v.position.xy*size+across*shift,0);
}`;

/** Fast approximate anti-aliasing for single-sampled (phone or light-tier) output. Alone it captures the finished frame
 * outside every other effect; in a PostStack it runs after the display effect.
 * @throws MargoError `'unsupported'` on a WebGL engine, `'disposed'` after `dispose()`, `'attached'` when attached
 * twice or next to SMAA. */
export class FXAA implements EnginePlugin {
  readonly name = 'fxaa';
  private engine?: Engine;
  private sampler?: GPUSampler;
  private pipeline?: GPURenderPipeline;
  private group?: GPUBindGroup;
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
  private readonly attachment: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'clear', storeOp: 'store' };
  private readonly descriptor: GPURenderPassDescriptor = { colorAttachments: [this.attachment] };
  static attach(instance: EngineKernel): FXAA {
    const effect = new FXAA();
    engineRuntime(instance).use(effect);
    return effect;
  }
  private joinStack(): StackStage {
    if (this.engine || this.stacked || this.disposed)
      throw margoError('attached', 'FXAA is already attached; create a new FXAA');
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
        'FXAA requires WebGPU and a live effect; attach a new FXAA to a WebGPU engine; see https://margoengine.com/errors#webgpu',
      );
    if (engine.hasPlugin('smaa'))
      throw margoError('attached', 'FXAA cannot run next to SMAA; remove SMAA or keep it instead of FXAA');
    this.engine = engine;
    this.sampler = engine.gpu.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  }
  registerPasses(graph: FrameGraph): void {
    if (this.stacked) return;
    graph.add({
      name: 'fxaa:capture',
      order: -80,
      execute: (c) => {
        if (c.backend === 'webgpu') this.capture(c);
      },
    });
    graph.add({
      name: 'fxaa:resolve',
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
      this.release();
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
    const key = format + ':' + (multisample?.count ?? 1);
    if (this.key !== key) {
      this.key = key;
      this.pipeline = render(c.device, shader, format, { multisample });
      this.input = undefined;
    }
    if (this.input !== input) {
      this.input = input;
      this.group = group(c.device, this.pipeline!, [input, this.sampler!]);
    }
    this.attachment.view = view;
    this.attachment.loadOp = viewLoadOp(c, 'clear');
    const pass = c.encoder.beginRenderPass(this.descriptor);
    pass.setPipeline(this.pipeline!);
    pass.setBindGroup(0, this.group!);
    applyView(pass, c);
    pass.draw(3);
    pass.end();
  }
  private release(): void {
    this.target?.dispose();
    this.color?.destroy();
    this.depth?.destroy();
    this.target = this.color = this.depth = this.view = this.input = undefined;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.key = '';
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.engine = this.sampler = this.pipeline = this.group = undefined;
    this.original = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  /** @deprecated Use dispose(); kept as an alias until 1.0. */
  destroy(): void {
    this.dispose();
  }
}
