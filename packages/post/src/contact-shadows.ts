/// <reference lib="esnext.disposable" preserve="true" />
// Screen-space contact shadows, an HDR PostStack stage: a short ray march on scene depth from each pixel toward the
// light, in the manner of screen-space ray tracing (McGuire & Mara 2014). Catches the small contact gaps a shadow map's
// texels miss. Start offset from interleaved gradient noise (Jimenez 2014).
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, PassContext } from '@margoengine/core/extension';
import { invertMatrixStable } from '@margoengine/math/mat4';
import { MargoError } from '@margoengine/math/errors';
import type { StackHost, StackStage, StageOutput } from '../../shared/stack.js';
import { displayShader } from '../../shared/display.js';
import { fullscreen, group, render } from '../../shared/gpu.js';
import { applyView, viewLoadOp } from '../../shared/view-rect.js';
import { PostStack } from './stack.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** Options of {@link ContactShadows}; the object is kept and read every frame. */
export interface ContactShadowsOptions {
  /** How far each ray reaches toward the light, world units, above 0. Default 0.4. */
  distance?: number;
  /** How thick a surface counts as, world units, above 0; larger joins gaps and can shade behind thin objects. Default 0.2. */
  thickness?: number;
  /** Share of the light a contact removes, 0 to 1. Default 0.7. */
  strength?: number;
  /** March steps per pixel, 1 to 64. Default 16. */
  steps?: number;
  /** False passes frames through. Default true. */
  enabled?: boolean;
}

const shader = (encode: boolean) => `${fullscreen}${encode ? displayShader : ''}
struct U {view:mat4x4f,inverse:mat4x4f,light:vec4f,march:vec4f}
@group(0) @binding(0) var<uniform> u:U;
@group(0) @binding(1) var scene:texture_2d<f32>;
@group(0) @binding(2) var depth:texture_depth_2d;
@fragment fn fragment(@builtin(position) at:vec4f)->@location(0) vec4f {
 let p=vec2i(at.xy);let size=vec2f(textureDimensions(depth));let now=textureLoad(scene,p,0);
 let d=textureLoad(depth,p,0);var lit=1.0;
 if(d>0&&u.march.z>0){
  let start=u.inverse*vec4f(at.xy/size*vec2f(2,-2)+vec2f(-1,1),d,1);let world=start.xyz/start.w;
  let step=u.light.xyz*u.march.x/u.march.w;
  let shift=fract(52.9829189*fract(dot(at.xy,vec2f(0.06711056,0.00583715))));
  let selfBias=u.march.x/u.march.w;
  for(var i=0.0;i<u.march.w;i+=1){
   let q=world+step*(i+shift)+u.light.xyz*selfBias*0.5;let clip=u.view*vec4f(q,1);
   if(clip.w<=0){break;}
   let ndc=clip.xyz/clip.w;let uv=ndc.xy*vec2f(0.5,-0.5)+0.5;
   if(any(uv<vec2f(0))||any(uv>=vec2f(1))){break;}
   let found=textureLoad(depth,vec2i(uv*size),0);
   if(found>ndc.z){
    let back=u.inverse*vec4f(ndc.xy,found,1);
    if(distance(back.xyz/back.w,q)<u.light.w){lit=1-u.march.z;break;}
   }
  }
 }
 let rgb=now.rgb*lit;
 return vec4f(${encode ? 'toDisplay(rgb)' : 'rgb'},now.a);
}`;

/**
 * Contact shadows in a PostStack (HDR effect): darkens pixels whose short ray toward the engine's light hits nearby
 * scene depth. Place it first among the HDR effects. It works from the frame's depth, so anything off screen casts
 * nothing, and it darkens ambient as well as direct light in the pixels it hits.
 * ```ts
 * PostStack.attach(engine, [new ContactShadows({distance: 0.3}), new Tonemap()]);
 * ```
 * @throws RangeError when an option is out of range (checked now and every frame); MargoError `'state'` outside a
 * PostStack, `'unsupported'` without WebGPU, `'disposed'` after `dispose()`, `'attached'` when joined twice.
 */
export class ContactShadows implements EnginePlugin {
  readonly name = 'contact-shadows';
  private engine?: Engine;
  private host?: StackHost;
  private stack?: PostStack;
  private stacked = false;
  private disposed = false;
  private uniform?: GPUBuffer;
  private readonly values = new Float32Array(40);
  private readonly workspace = new Float64Array(52);
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private bindings?: GPUBindGroup;
  private bound: readonly unknown[] = [];

  constructor(readonly options: ContactShadowsOptions = {}) {
    this.validate();
  }

  /** Attaches a new ContactShadows to `engine` alone in its own PostStack. */
  static attach(engine: EngineKernel, options: ContactShadowsOptions = {}): ContactShadows {
    const effect = new ContactShadows(options);
    effect.stack = PostStack.attach(engine, [effect]);
    return effect;
  }

  private validate(): void {
    const o = this.options,
      above = (value: number | undefined) => value === undefined || (Number.isFinite(value) && value > 0);
    if (!above(o.distance) || !above(o.thickness))
      throw new RangeError('ContactShadows distance and thickness must be finite and above 0; pass world units');
    if (o.strength !== undefined && !(o.strength >= 0 && o.strength <= 1))
      throw new RangeError('ContactShadows strength must be in 0..1; pass a share of the light');
    if (o.steps !== undefined && !(Number.isInteger(o.steps) && o.steps >= 1 && o.steps <= 64))
      throw new RangeError('ContactShadows steps must be a whole number from 1 to 64');
    if (o.enabled !== undefined && typeof o.enabled !== 'boolean')
      throw new TypeError('ContactShadows enabled must be a boolean; pass true or false');
  }

  private joinStack(host: StackHost): StackStage {
    if (this.engine || this.stacked || this.disposed)
      throw new MargoError('attached', 'ContactShadows is already attached; create a new ContactShadows');
    this.stacked = true;
    this.host = host;
    return { kind: 'hdr', render: (c, input, output) => this.draw(c, input, output) };
  }

  setup(engine: Engine): void {
    if (this.disposed) throw new MargoError('disposed', 'ContactShadows is disposed; create a new ContactShadows');
    if (!this.stacked) throw new MargoError('state', 'ContactShadows runs inside a PostStack; use ContactShadows.attach(engine) or add it to a PostStack');
    if (!engine.gpu)
      throw new MargoError('unsupported', 'ContactShadows requires WebGPU; it does not run on the WebGL2 fallback');
    this.engine = engine;
    this.uniform = engine.gpu.createBuffer({ size: 160, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  onDeviceRestored(engine: Engine): void {
    this.release();
    this.engine = undefined;
    this.setup(engine);
  }

  /** Removes the effect, releases its GPU resources and disposes the stack `attach` created. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const engine = this.engine;
    this.engine = undefined;
    engine?.removePlugin(this.name);
    this.release();
    this.stack?.dispose();
    this.stack = undefined;
  }

  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  private draw(c: Context, input: GPUTextureView, output: StageOutput): void {
    this.validate();
    const o = this.options,
      device = c.device,
      v = this.values,
      m = c.camera.matrix,
      light = this.engine!.lighting.direction;
    v.set(m);
    if (!invertMatrixStable(m, v.subarray(16, 32), this.workspace))
      throw new MargoError('state', 'Invalid ContactShadows camera; give the camera a finite, invertible projection');
    const length = Math.hypot(light[0], light[1], light[2]) || 1;
    v.set([light[0] / length, light[1] / length, light[2] / length, o.thickness ?? 0.2], 32);
    v.set([o.distance ?? 0.4, 0, (o.enabled ?? true) ? (o.strength ?? 0.7) : 0, o.steps ?? 16], 36);
    device.queue.writeBuffer(this.uniform!, 0, v);
    const key = `${output.format}:${output.multisample?.count ?? 1}:${+output.hdr}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      pipeline = render(device, shader(!output.hdr), output.format, { multisample: output.multisample });
      this.pipelines.set(key, pipeline);
    }
    const depth = this.host!.depthTexture!,
      parts = [pipeline, input, depth];
    if (parts.some((part, i) => part !== this.bound[i])) {
      this.bound = parts;
      this.bindings = group(device, pipeline, [
        { buffer: this.uniform! },
        input,
        depth.createView({ aspect: 'depth-only' }),
      ]);
    }
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [{ view: output.view, loadOp: viewLoadOp(c, 'clear'), storeOp: 'store' }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.bindings!);
    applyView(pass, c);
    pass.draw(3);
    pass.end();
  }

  private release(): void {
    this.uniform?.destroy();
    this.uniform = this.bindings = undefined;
    this.pipelines.clear();
    this.bound = [];
  }
}
