/// <reference lib="esnext.disposable" preserve="true" />
// Screen-space outlines, an LDR PostStack stage: a Sobel filter (Sobel & Feldman 1968) over linear scene depth and,
// when given, surface normals. The depth gradient is relative to the pixel's own distance, so one threshold holds
// from near to far.
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, PassContext } from '@margoengine/core/extension';
import type { StackHost, StackStage, StageOutput } from '../../shared/stack.js';
import { fullscreen, render, group } from '../../shared/gpu.js';
import { margoError } from '../../shared/errors.js';
import { orthographic } from '../../shared/projection.js';
import { applyView, viewLoadOp } from '../../shared/view-rect.js';
import { PostStack } from './stack.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
type OutlinePassContext = Extract<PassContext, { backend: 'webgpu' }>;

/** Options of {@link Outline}; the object is kept and read every frame. */
export interface OutlineOptions {
  /** Line colour as display-encoded red, green, blue and opacity, each 0 to 1. Default `[0, 0, 0, 1]`. */
  color?: readonly [number, number, number, number];
  /** Filter radius in whole pixels, 1 to 16; a line covers about twice this. Default 1. */
  width?: number;
  /** Depth step that starts a line, as a share of the pixel's distance per pixel of width; above 0. Default 0.03. */
  depthThreshold?: number;
  /** Normal change that starts a line, above 0; about 0.4 is a 30 degree crease. Default 0.4. */
  normalThreshold?: number;
  /**
   * World normals in xyz, read at the frame's size, such as `() => targets.texture('normal')` from `SceneTargets`.
   * Finds creases, where depth alone sees nothing. Default none: depth edges only.
   */
  normal?: () => GPUTexture | undefined;
  /**
   * Limits lines to masked objects: red channel read at the frame's size, such as
   * `() => selection.maskTexture` from `@margoengine/selection`. The mask's own edges draw too, and no texture
   * means no lines. Default none: every edge.
   */
  mask?: () => GPUTexture | undefined;
  /** The red value that counts as masked, 0 to 1, for a mask holding several ids. Default any value above 0. */
  maskId?: number;
  /** False passes frames through. Default true. */
  enabled?: boolean;
}

const shader = (normal: boolean, mask: boolean) => `${fullscreen}
struct U {color:vec4f,edge:vec4f,z:vec4f}
@group(0) @binding(0) var<uniform> u:U;
@group(0) @binding(1) var scene:texture_2d<f32>;
@group(0) @binding(2) var depth:texture_depth_2d;
${normal ? '@group(0) @binding(3) var normals:texture_2d<f32>;' : ''}
${mask ? `@group(0) @binding(${normal ? 4 : 3}) var masks:texture_2d<f32>;` : ''}
const kernel=array<vec4f,8>(vec4f(-1,-1,-1,-1),vec4f(0,-1,0,-2),vec4f(1,-1,1,-1),vec4f(-1,0,-2,0),vec4f(1,0,2,0),vec4f(-1,1,-1,1),vec4f(0,1,0,2),vec4f(1,1,1,1));
fn away(p:vec2i)->f32 {let d=textureLoad(depth,p,0);return abs((u.z.x+u.z.y*d)/(u.z.z+u.z.w*d));}
${mask ? 'fn marked(p:vec2i)->bool {let v=textureLoad(masks,p,0).r;return select(abs(v-u.edge.w)<0.002,v>0,u.edge.w<0);}' : ''}
@fragment fn fragment(@builtin(position) at:vec4f)->@location(0) vec4f {
 let p=vec2i(at.xy);
 let now=textureLoad(scene,p,0);
 if (u.edge.x==0) {return now;}
 let top=vec2i(textureDimensions(depth))-1;
 let reach=i32(u.edge.x);
 var dz=vec2f(0);
 ${normal ? 'var nx=vec3f(0);var ny=vec3f(0);' : ''}
 ${mask ? 'var some=marked(p);var every=some;' : ''}
 for (var i=0;i<8;i++) {
  let k=kernel[i];
  let q=clamp(p+vec2i(k.xy)*reach,vec2i(0),top);
  dz+=away(q)*k.zw;
  ${normal ? 'let n=textureLoad(normals,q,0).xyz;nx+=n*k.z;ny+=n*k.w;' : ''}
  ${mask ? 'let m=marked(q);some=some||m;every=every&&m;' : ''}
 }
 var line=smoothstep(u.edge.y,u.edge.y*2,length(dz)/(8*u.edge.x*max(away(p),1e-6)));
 ${normal ? 'line=max(line,smoothstep(u.edge.z,u.edge.z*2,sqrt(dot(nx,nx)+dot(ny,ny))/4));' : ''}
 ${mask ? 'if (!some) {line=0;} else if (!every) {line=1;}' : ''}
 return vec4f(mix(now.rgb,u.color.rgb,line*u.color.a),now.a);
}`;

/**
 * Outlines from scene depth and optional normals, an LDR effect of a PostStack: place it after the display effect and
 * before SMAA or FXAA so they smooth the lines. The colour is display-encoded, so tonemapping never shifts it.
 * `attach` runs it alone in its own PostStack.
 * @throws TypeError when an option has the wrong type; RangeError when `width`, a threshold, `color` or `maskId` is out
 * of range (checked now and every frame); MargoError `'state'` outside a PostStack, `'unsupported'` without WebGPU,
 * `'disposed'` after `dispose()`, `'attached'` when joined twice.
 */
export class Outline implements EnginePlugin {
  readonly name = 'outline';
  private host?: StackHost;
  private engine?: Engine;
  private stack?: PostStack;
  private stacked = false;
  private disposed = false;
  private uniform?: GPUBuffer;
  private readonly values = new Float32Array(12);
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private bindings?: GPUBindGroup;
  private bound: readonly unknown[] = [];
  private readonly attachment: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'clear', storeOp: 'store' };
  private readonly descriptor: GPURenderPassDescriptor = { colorAttachments: [this.attachment] };

  constructor(readonly options: OutlineOptions = {}) {
    this.validate();
  }

  /** Attaches a new Outline to `engine` alone in its own PostStack. */
  static attach(engine: EngineKernel, options: OutlineOptions = {}): Outline {
    const effect = new Outline(options);
    effect.stack = PostStack.attach(engine, [effect]);
    return effect;
  }

  private joinStack(host: StackHost): StackStage {
    if (this.engine || this.stacked || this.disposed)
      throw margoError('attached', 'Outline is already attached; create a new Outline');
    this.stacked = true;
    this.host = host;
    return { kind: 'ldr', render: (c, input, output) => this.draw(c, input, output) };
  }

  setup(engine: Engine): void {
    if (this.disposed) throw margoError('disposed', 'Outline is disposed; create a new Outline');
    if (!this.stacked)
      throw margoError('state', 'Outline runs inside a PostStack; use Outline.attach(engine) or add it to a PostStack');
    if (!engine.gpu) throw margoError('unsupported', 'Outline requires WebGPU; it does not run on the WebGL2 fallback');
    this.engine = engine;
    this.uniform = engine.gpu.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
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
    engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.stack?.dispose();
    this.stack = undefined;
  }

  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  private validate(): void {
    const o = this.options;
    if (o.enabled !== undefined && typeof o.enabled !== 'boolean')
      throw new TypeError('Outline enabled must be a boolean; pass true or false');
    for (const key of ['normal', 'mask'] as const)
      if (o[key] !== undefined && typeof o[key] !== 'function')
        throw new TypeError(`Outline ${key} must be a function returning a texture; pass () => texture`);
    const width = o.width ?? 1;
    if (!(Number.isInteger(width) && width >= 1 && width <= 16))
      throw new RangeError('Outline width must be a whole number of pixels from 1 to 16');
    for (const key of ['depthThreshold', 'normalThreshold'] as const) {
      const value = o[key];
      if (value !== undefined && !(Number.isFinite(value) && value > 0))
        throw new RangeError(`Outline ${key} must be finite and above 0`);
    }
    if (o.maskId !== undefined && !(o.maskId >= 0 && o.maskId <= 1))
      throw new RangeError('Outline maskId must be in 0..1');
    if (o.color !== undefined && (o.color.length !== 4 || !o.color.every((v) => v >= 0 && v <= 1)))
      throw new RangeError('Outline color must be four numbers from 0 to 1: red, green, blue, opacity');
  }

  private draw(c: OutlinePassContext, input: GPUTextureView, output: StageOutput): void {
    this.validate();
    const o = this.options,
      device = c.device,
      v = this.values,
      eye = orthographic(c.camera.matrix, c.camera.position),
      near = c.camera.near,
      far = c.camera.far;
    v.set(o.color ?? [0, 0, 0, 1]);
    v[5] = o.depthThreshold ?? 0.03;
    v[6] = o.normalThreshold ?? 0.4;
    v[7] = o.maskId ?? -1;
    // Distance from reversed-Z depth d as (x + y d) / (z + w d).
    if (eye) v.set([eye.far, eye.near - eye.far, 1, 0], 8);
    else v.set([near * far, 0, near, far - near], 8);
    const normal = o.normal?.(),
      mask = o.mask?.(),
      depth = this.host!.depthTexture!,
      live = (o.enabled ?? true) && (!o.mask || !!mask),
      key = `${output.format}:${output.multisample?.count ?? 1}:${+!!normal}${+!!mask}`;
    v[4] = live ? (o.width ?? 1) : 0;
    device.queue.writeBuffer(this.uniform!, 0, v);
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      pipeline = render(device, shader(!!normal, !!mask), output.format, { multisample: output.multisample });
      this.pipelines.set(key, pipeline);
    }
    const parts = [pipeline, input, depth, normal, mask];
    if (parts.some((part, i) => part !== this.bound[i])) {
      this.bound = parts;
      const resources: GPUBindingResource[] = [
        { buffer: this.uniform! },
        input,
        depth.createView({ aspect: 'depth-only' }),
      ];
      if (normal) resources.push(normal.createView());
      if (mask) resources.push(mask.createView());
      this.bindings = group(device, pipeline, resources);
    }
    this.attachment.view = output.view;
    this.attachment.loadOp = viewLoadOp(c, 'clear');
    const pass = c.encoder.beginRenderPass(this.descriptor);
    try {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, this.bindings!);
      applyView(pass, c);
      pass.draw(3);
    } finally {
      pass.end();
    }
  }

  private release(): void {
    this.uniform?.destroy();
    this.uniform = this.bindings = undefined;
    this.pipelines.clear();
    this.bound = [];
  }
}
