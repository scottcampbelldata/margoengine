/// <reference lib="esnext.disposable" preserve="true" />
// Wide-angle projections as an LDR PostStack stage: the scene is drawn rectilinear at a wide field of view and this
// stage resamples it, so edges that a plain perspective stretches keep their shape. The maths is written here from
// the published definitions: Sharpless, Postle and German, "Pannini: A New Projection for Rendering Wide Angle
// Perspective Images" (Computational Aesthetics 2010), and the usual fisheye mappings r = f g(theta).
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, PassContext } from '@margoengine/core/extension';
import type { PostStack } from '@margoengine/post';
import { group, fullscreen, render } from '../../shared/gpu.js';
import { margoError } from '../../shared/errors.js';
import type { StackHost, StackStage, StageOutput } from '../../shared/stack.js';
import { applyView, viewLoadOp } from '../../shared/view-rect.js';
import { GAIN, INVERSE, MODES, type WideAngleMode } from './wide-laws.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
type WideContext = Extract<PassContext, { backend: 'webgpu' }>;

export type { WideAngleMode } from './wide-laws.js';

/** Options of {@link WideAngleMap} and {@link WideAngle}. */
export interface WideAngleOptions {
  /** Default 'panini'. The fisheye modes are r = θ (equidistant), 2 sin(θ/2) (equisolid), 2 tan(θ/2) (stereographic) and sin θ (orthographic). */
  mode?: WideAngleMode;
  /** Panini compression d: 0 is the plain rectilinear picture, 1 the classic Panini, larger bends verticals toward a cylinder. 0 or more, default 1. */
  distance?: number;
  /** Zoom in just enough that no output pixel falls outside the source picture. Default true; false leaves black where the source ends. */
  crop?: boolean;
  /** False passes the picture through. Default true. Also `effect.enabled`. */
  enabled?: boolean;
}

const EPS = 1e-9;

/**
 * The mapping between the wide picture a camera draws (rectilinear, `fov` degrees vertical) and the projected output,
 * both as normalised device coordinates (x right and y up, -1 to 1). The same maths runs in the shader; use it to turn a
 * pointer position on the output into a position on the source for `engine.pick`, or to place overlays.
 */
export class WideAngleMap {
  readonly mode: WideAngleMode;
  readonly distance: number;
  /** Tangent of the half angle across and up the source picture. */
  readonly tx: number;
  readonly ty: number;
  /** Half extent of the output plane before `zoom`, across and up. */
  readonly halfWidth: number;
  readonly halfHeight: number;
  /** Factor the output plane is shrunk by so it stays inside the source (1 when `crop` is false or nothing is outside). */
  readonly zoom: number;
  constructor(fov: number, aspect: number, { mode = 'panini', distance = 1, crop = true }: WideAngleOptions = {}) {
    if (!(mode in MODES))
      throw new RangeError(
        "Invalid wide angle mode; use 'panini', 'equidistant', 'equisolid', 'stereographic' or 'orthographic'",
      );
    if (!(distance >= 0 && distance < Infinity))
      throw new RangeError('Invalid wide angle distance; use a finite number from 0');
    if (!(aspect > 0 && aspect < Infinity) || !(fov > 0 && fov < 180))
      throw new RangeError(
        'Invalid wide angle view; use a field of view between 0 and 180 degrees and an aspect above 0',
      );
    this.mode = mode;
    this.distance = distance;
    this.ty = Math.tan((fov * Math.PI) / 360);
    this.tx = this.ty * aspect;
    const half = Math.atan(this.tx);
    this.halfWidth =
      mode === 'panini' ? ((distance + 1) * Math.sin(half)) / (distance + Math.cos(half)) : GAIN[mode](half);
    this.halfHeight = this.halfWidth / aspect;
    this.zoom = 1;
    if (crop) this.zoom = this.fitZoom();
  }
  /** Source position (normalised, x right and y up) shown at output position (`u`, `v`), or null where the output shows nothing. */
  toSource(u: number, v: number): [number, number] | null {
    return this.sourceOf(u, v, this.zoom);
  }
  /** Output position of the source position (`x`, `y`), or null when it falls outside the output. */
  toOutput(x: number, y: number): [number, number] | null {
    const sx = x * this.tx,
      sy = y * this.ty;
    let px: number, py: number;
    if (this.mode === 'panini') {
      const d = this.distance,
        phi = Math.atan(sx),
        cos = Math.cos(phi),
        s = (d + 1) / (d + cos);
      px = s * Math.sin(phi);
      py = s * sy * cos;
    } else {
      const length = Math.hypot(sx, sy),
        r = length ? GAIN[this.mode](Math.atan(length)) / length : 0;
      px = sx * r;
      py = sy * r;
    }
    const u = px / (this.halfWidth * this.zoom),
      v = py / (this.halfHeight * this.zoom);
    return Math.abs(u) <= 1 + EPS && Math.abs(v) <= 1 + EPS ? [u, v] : null;
  }
  private sourceOf(u: number, v: number, zoom: number): [number, number] | null {
    const px = u * this.halfWidth * zoom,
      py = v * this.halfHeight * zoom;
    let sx: number, sy: number;
    if (this.mode === 'panini') {
      const d = this.distance,
        xp = px / (d + 1),
        phi = Math.atan(xp) + Math.asin(Math.max(-1, Math.min(1, (xp * d) / Math.sqrt(1 + xp * xp)))),
        cos = Math.cos(phi);
      if (!(cos > EPS)) return null;
      sx = Math.tan(phi);
      sy = py / (((d + 1) / (d + cos)) * cos);
    } else {
      const r = Math.hypot(px, py),
        theta = INVERSE[this.mode](r);
      if (theta === null || !(theta < Math.PI / 2 - EPS)) return null;
      const k = r ? Math.tan(theta) / r : 0;
      sx = px * k;
      sy = py * k;
    }
    const x = sx / this.tx,
      y = sy / this.ty;
    return Math.abs(x) <= 1 + EPS && Math.abs(y) <= 1 + EPS ? [x, y] : null;
  }
  // The largest zoom (at most 1) at which the whole border of the output lies inside the source, by bisection.
  private fitZoom(): number {
    const inside = (zoom: number): boolean => {
      for (let i = 0; i <= 64; i++) {
        const t = (i / 64) * 2 - 1;
        for (const [u, v] of [
          [t, 1],
          [t, -1],
          [1, t],
          [-1, t],
        ] as const)
          if (!this.sourceOf(u, v, zoom)) return false;
      }
      return true;
    };
    if (inside(1)) return 1;
    let low = 0,
      high = 1;
    for (let i = 0; i < 40; i++) {
      const mid = (low + high) / 2;
      if (inside(mid)) low = mid;
      else high = mid;
    }
    return low;
  }
}

const shader = `${fullscreen}
struct Wide {a:vec4f,b:vec4f}
@group(0) @binding(0) var<uniform> w:Wide;
@group(0) @binding(1) var frame:texture_2d<f32>;
@group(0) @binding(2) var smp:sampler;
const HALF_PI=1.5707963267948966;
// a: mode (-1 passes the picture through), panini distance; b: half width and half height of the output plane after
// zoom, then the tangent of the half angle across and up the source.
@fragment fn fragment(v:Vertex)->@location(0) vec4f {
 let mode=i32(w.a.x);
 if (mode<0) {return textureSampleLevel(frame,smp,v.uv,0);}
 let d=w.a.y;
 let p=(v.uv*2-1)*vec2f(1,-1)*w.b.xy;
 var s=vec2f(0);
 if (mode==0) {
  let xp=p.x/(d+1);
  let phi=atan(xp)+asin(clamp(xp*d/sqrt(1+xp*xp),-1,1));
  let c=cos(phi);
  if (c<=1e-9) {return vec4f(0,0,0,1);}
  s=vec2f(tan(phi),p.y/(((d+1)/(d+c))*c));
 } else {
  let r=length(p);
  var theta=r;
  if (mode==2) {if (r>2) {return vec4f(0,0,0,1);} theta=2*asin(r/2);}
  else if (mode==3) {theta=2*atan(r/2);}
  else if (mode==4) {if (r>1) {return vec4f(0,0,0,1);} theta=asin(r);}
  if (theta>=HALF_PI-1e-9) {return vec4f(0,0,0,1);}
  if (r>0) {s=p*(tan(theta)/r);}
 }
 let q=s/w.b.zw;
 if (abs(q.x)>1.0000001||abs(q.y)>1.0000001) {return vec4f(0,0,0,1);}
 return textureSampleLevel(frame,smp,vec2f(q.x*0.5+0.5,0.5-q.y*0.5),0);
}`;

/**
 * Panini and fisheye projection as a stage of `PostStack`, after the display effect: draw the scene with a wide
 * perspective camera (for example `camera.fov = 100`) and this resamples it. It reads `engine.camera.fov` and the
 * frame's shape each frame, so a camera with a lens (`CameraProjection.focalLength`) works unchanged. Perspective
 * cameras only. The source is one rectilinear picture, so a fisheye reaches only as far as that picture does (under
 * 180 degrees across), and the corners are cropped unless `crop` is false. `WideAngleCube` in
 * `@margoengine/cameras/wide-cube` reads a cube capture and reaches past that.
 * @throws RangeError for an unknown `mode`, a negative `distance` or a field of view outside 0 to 180; MargoError
 * `'state'` outside a PostStack, `'unsupported'` on a WebGL engine, `'attached'` when joined twice, `'disposed'`
 * after `dispose()`.
 */
export class WideAngle implements EnginePlugin {
  readonly name = 'wide-angle';
  private engine?: Engine;
  private stack?: PostStack;
  private stacked = false;
  private disposed = false;
  private uniform?: GPUBuffer;
  private sampler?: GPUSampler;
  private pipeline?: GPURenderPipeline;
  private key = '';
  private group?: GPUBindGroup;
  private input?: GPUTextureView;
  private mapKey = '';
  private lastMap?: WideAngleMap;
  private readonly values = new Float32Array(8);
  private readonly attachment: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'clear', storeOp: 'store' };
  private readonly descriptor: GPURenderPassDescriptor = { colorAttachments: [this.attachment] };
  constructor(readonly options: WideAngleOptions = {}) {
    this.map(60, 1);
  }
  /**
   * Runs a new WideAngle alone in its own PostStack, which disposing it disposes too (needs `@margoengine/post`).
   * To combine it with other effects, add `new WideAngle()` after the display effect of your own `PostStack`.
   */
  static async attach(engine: EngineKernel, options: WideAngleOptions = {}): Promise<WideAngle> {
    const { PostStack } = await import('@margoengine/post'),
      effect = new WideAngle(options);
    effect.stack = PostStack.attach(engine, [effect]);
    return effect;
  }
  /** Whether the picture is projected (mirrors `options.enabled`). */
  get enabled(): boolean {
    return this.options.enabled ?? true;
  }
  set enabled(value: boolean) {
    if (typeof value !== 'boolean') throw new TypeError('WideAngle enabled must be a boolean; pass true or false');
    this.options.enabled = value;
  }
  /** The mapping for a camera of `fov` degrees (vertical) and a view of `aspect`, with these options. */
  map(fov: number, aspect: number): WideAngleMap {
    const o = this.options,
      key = `${fov}:${aspect}:${o.mode}:${o.distance}:${o.crop}`;
    if (key !== this.mapKey || !this.lastMap) {
      this.lastMap = new WideAngleMap(fov, aspect, o);
      this.mapKey = key;
    }
    return this.lastMap;
  }
  private joinStack(_host: StackHost): StackStage {
    if (this.engine || this.stacked || this.disposed)
      throw margoError('attached', 'WideAngle is already attached; create a new WideAngle');
    this.stacked = true;
    return { kind: 'ldr', render: (c, input, output) => this.draw(c, input, output) };
  }
  setup(engine: Engine): void {
    if (this.disposed) throw margoError('disposed', 'WideAngle is disposed; create a new WideAngle');
    if (!this.stacked)
      throw margoError('state', 'WideAngle runs inside a PostStack; add it to PostStack.attach(engine, [effect])');
    if (!engine.gpu)
      throw margoError('unsupported', 'WideAngle requires WebGPU; it does not run on the WebGL2 fallback');
    this.engine = engine;
    this.uniform = engine.gpu.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.sampler = engine.gpu.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.engine = undefined;
    this.setup(engine);
  }
  /** Removes the effect and releases its GPU resources. Safe to call twice. */
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
  private draw(c: WideContext, input: GPUTextureView, output: StageOutput): void {
    const device = c.device,
      engine = this.engine!,
      map = this.map(engine.camera.fov, c.width / c.height),
      v = this.values;
    v[0] = this.enabled ? MODES[map.mode] : -1;
    v[1] = map.distance;
    v[4] = map.halfWidth * map.zoom;
    v[5] = map.halfHeight * map.zoom;
    v[6] = map.tx;
    v[7] = map.ty;
    device.queue.writeBuffer(this.uniform!, 0, v);
    const pipeline = this.pipelineFor(device, output);
    if (this.input !== input) {
      this.input = input;
      this.group = group(device, pipeline, [{ buffer: this.uniform! }, input, this.sampler!]);
    }
    this.attachment.view = output.view;
    this.attachment.loadOp = viewLoadOp(c, 'clear');
    const pass = c.encoder.beginRenderPass(this.descriptor);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.group!);
    applyView(pass, c);
    pass.draw(3);
    pass.end();
  }
  // One pipeline per output format and sample count; a new one drops the bind group that belonged to the old.
  private pipelineFor(device: GPUDevice, output: StageOutput): GPURenderPipeline {
    const samples = output.multisample?.count ?? 1;
    if (this.key !== `${output.format}/${samples}`) {
      this.key = `${output.format}/${samples}`;
      this.pipeline = render(device, shader, output.format, { multisample: output.multisample });
      this.input = undefined;
    }
    return this.pipeline!;
  }
  private release(): void {
    this.uniform?.destroy();
    this.uniform = this.sampler = this.pipeline = this.group = this.input = undefined;
    this.key = '';
  }
}
