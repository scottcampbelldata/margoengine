/// <reference lib="esnext.disposable" preserve="true" />
// TrailTexture: pointer or object motion painted into a fading texture, for displacement, reveal and ripple effects.
// Each frame the previous trail (A) is faded into B (a full-screen pass), the frame's soft brush stamps are blended
// onto B, and B is copied back into A, so `texture` keeps one identity for the life of the device and a material or
// bind group made once keeps reading the latest trail. Moves are joined by stamps spaced at most half a radius apart,
// so fast moves leave no gaps, and a move's stamps are weighted by the frame's speed. Sources: R. Gonzalez and R. Woods,
// "Digital Image Processing" (4th ed., 2018), ch. 3, for the screen and lighten (max) blends; T. Porter and T. Duff,
// "Compositing Digital Images", SIGGRAPH 1984, https://doi.org/10.1145/800031.808606, for stamping as source-over
// compositing; R. G. Brown, "Smoothing, Forecasting and Prediction of Discrete Time Series" (1963), for the
// exponential smoothing of pointer samples.
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import { fullscreen, group, render } from '../../shared/gpu.js';
import { fault, rangeError, typeError } from '../../shared/errors.js';

type Context = Extract<PassContext, { backend: 'webgpu' }>;
/** How a stamp combines with the trail under it: `'screen'` (1 - (1 - a)(1 - b), stays within 0..1), `'add'`
 * (a + b, can pass 1) or `'max'` (the larger, never brighter than one stamp). */
export type TrailBlend = 'screen' | 'add' | 'max';

/** Options of {@link TrailTexture}. All but `size` and `order` are live: the object is kept and read every frame. */
export interface TrailTextureOptions {
  /** Texture width and height in texels, a number for a square; integers 1 to the device's maxTextureDimension2D.
   * Fixed at construction. Default 256. */
  readonly size?: number | readonly [number, number];
  /** Fraction of the trail kept per 1/60 s, in (0, 1]; scaled by the frame's delta, so trails last as long at any
   * frame rate. 1 never fades. Default 0.95 (half brightness after about 0.23 s). */
  decay?: number;
  /** Brush radius as a fraction of the texture width, above 0 and at most 1; brushes are round in texels. Default
   * 0.06. */
  radius?: number;
  /** Peak value of one stamp, finite and >= 0. Default 1. */
  intensity?: number;
  /** Exponential smoothing of `move` samples in [0, 1): 0 follows each sample exactly, 0.9 lags and rounds sharp
   * turns. Default 0. */
  smoothing?: number;
  /** How stamps combine with the trail. Default `'screen'`. */
  blend?: TrailBlend;
  /** Most stamps added between two `move` samples, an integer 0 to 256; they are spaced at most half a radius apart
   * up to this count. 0 stamps the samples only. Default 32. */
  interpolate?: number;
  /** Speed, in texture widths per second, at which a move's stamps reach full `intensity`; slower moves paint
   * fainter. 0 paints every move at full `intensity`. Finite and >= 0. Default 1. */
  speed?: number;
  /** False keeps the trail as it is (no fading, no stamps); queued stamps wait. Default true. */
  enabled?: boolean;
  /** Frame graph order of the update, before the main pass so materials read this frame's trail. Fixed at
   * construction. Default -20. */
  readonly order?: number;
}

/** Stamps one frame can draw; more in one frame are dropped (docs/limits.md). */
export const TRAIL_MAX_STAMPS = 4096;
const BLENDS = ['screen', 'add', 'max'] as const;
// Below this a texel is set to 0: float16 multiplication alone stalls at its smallest values and never reaches black.
const CUTOFF = 1 / 1024;

const fadeShader = `${fullscreen}
struct U { fade:vec4f, brush:vec4f }
@group(0) @binding(0) var<uniform> u:U;
@group(0) @binding(1) var previous:texture_2d<f32>;
@fragment fn fragment(@builtin(position) at:vec4f)->@location(0) vec4f {
 if (u.fade.y!=0.0) {return vec4f(0.0);}
 let v=textureLoad(previous,vec2i(at.xy),0)*u.fade.x;
 return select(v,vec4f(0.0),v<vec4f(u.fade.z));
}`;

// A quad per instance (x, y, weight, unused), corners from the vertex index of a 4-vertex strip; v grows downwards
// like texture coordinates, so NDC y is 1 - 2v. The falloff (1 - d^2)^2 is smooth at the rim.
const stampShader = `
struct U { fade:vec4f, brush:vec4f }
@group(0) @binding(0) var<uniform> u:U;
struct Out { @builtin(position) position:vec4f, @location(0) q:vec2f, @location(1) w:f32 }
@vertex fn vertex(@builtin(vertex_index) i:u32, @location(0) s:vec4f)->Out {
 let corner=vec2f(f32(i&1u),f32(i>>1u))*2.0-1.0;
 let p=s.xy+corner*u.brush.xy;
 var o:Out;
 o.position=vec4f(p.x*2.0-1.0,1.0-p.y*2.0,0.0,1.0);
 o.q=corner;
 o.w=s.z;
 return o;
}
@fragment fn fragment(o:Out)->@location(0) vec4f {
 let d=min(dot(o.q,o.q),1.0);
 return vec4f((1.0-d)*(1.0-d)*o.w);
}`;

const blendState = (mode: TrailBlend): GPUBlendState => {
  const c: GPUBlendComponent =
    mode === 'max'
      ? { srcFactor: 'one', dstFactor: 'one', operation: 'max' }
      : { srcFactor: mode === 'add' ? 'one' : 'one-minus-dst', dstFactor: 'one', operation: 'add' };
  return { color: c, alpha: mode === 'screen' ? { ...c, srcFactor: 'one-minus-dst-alpha' } : c };
};

let instances = 0;

/**
 * A fading trail texture: `move` (UV samples), `trackPointer` (an element's pointer) or `stamp` paint soft round
 * brushes, and every frame the whole trail fades by `decay`. `texture` is `rgba16float`, the same value in all four
 * channels, (0, 0) at the top-left texel; it keeps its identity until a device restore, so bind it once (a material
 * `Texture` takes `trail.source`). The update runs once a frame before the main pass, also in multi-view frames.
 * @throws TypeError for an option of the wrong type; RangeError for a value out of range (checked now and every
 * frame); MargoError `'unsupported'` without WebGPU or the WebGL2 layer, `'disposed'` after `dispose()`, `'attached'`
 * when attached twice.
 */
export class TrailTexture implements EnginePlugin {
  readonly name = `trail-texture:${++instances}`;
  /** Texture width and height in texels. */
  readonly width: number;
  readonly height: number;
  private engine?: Engine;
  private disposed = false;
  private device?: GPUDevice;
  private textures: GPUTexture[] = [];
  private uniform?: GPUBuffer;
  private instanceBuffer?: GPUBuffer;
  private fadePipeline?: GPURenderPipeline;
  private fadeGroup?: GPUBindGroup;
  private target?: GPUTextureView;
  private stampPipeline?: GPURenderPipeline;
  private stampGroup?: GPUBindGroup;
  private stampBlend?: TrailBlend;
  private readonly values = new Float32Array(8);
  private readonly queue = new Float32Array(TRAIL_MAX_STAMPS * 4);
  /** 1 for stamps from `move`, weighted by the frame's speed; 0 for `stamp`. */
  private readonly moved = new Uint8Array(TRAIL_MAX_STAMPS);
  private count = 0;
  private path = 0;
  private last?: [number, number];
  private fresh = true;
  private pending?: number;
  private readonly fadeAttachment: GPURenderPassColorAttachment = {
    view: undefined!,
    loadOp: 'clear',
    storeOp: 'store',
  };
  private readonly descriptor: GPURenderPassDescriptor = { colorAttachments: [this.fadeAttachment] };

  constructor(readonly options: TrailTextureOptions = {}) {
    const size = options.size ?? 256,
      [w, h] = typeof size === 'number' ? [size, size] : Array.isArray(size) && size.length === 2 ? size : [NaN, NaN];
    if (![w, h].every((v) => Number.isInteger(v) && v >= 1))
      throw rangeError('TrailTexture size must be a whole number of texels >= 1, or [width, height]', 'trail-texture');
    if (options.order !== undefined && !Number.isFinite(options.order))
      throw rangeError('TrailTexture order must be a finite number', 'trail-texture');
    this.width = w;
    this.height = h;
    this.check();
  }

  /** Same as `engine.use(new TrailTexture(options))`; returns it. */
  static attach(engine: EngineKernel, options: TrailTextureOptions = {}): TrailTexture {
    const trail = new TrailTexture(options);
    engine.use(trail);
    return trail;
  }

  /** The trail (rgba16float); undefined before attaching and after `dispose()`. Replaced on a device restore. */
  get texture(): GPUTexture | undefined {
    return this.textures[0];
  }

  /** `(device) => GPUTexture` for a material `Texture` source: the trail on that device, made at once if needed, so
   * a material bound before the first frame or after a device restore reads the right texture. */
  readonly source = (device: GPUDevice): GPUTexture => this.ensure(device);

  /** Moves the brush to (`x`, `y`) in texture coordinates (0..1, top left 0, 0): stamps it there and, after an earlier
   * sample of the same stroke, along the way. Samples outside 0..1 are kept, so a stroke can leave and re-enter. */
  move(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y))
      throw rangeError('TrailTexture move needs finite x and y in texture coordinates', 'trail-texture');
    const o = this.check(),
      last = this.last;
    if (!last) {
      this.last = [x, y];
      this.push(x, y, 1);
      return;
    }
    const k = 1 - o.smoothing,
      nx = last[0] + (x - last[0]) * k,
      ny = last[1] + (y - last[1]) * k,
      dx = nx - last[0],
      dy = (ny - last[1]) * (this.height / this.width),
      length = Math.hypot(dx, dy),
      steps = Math.max(1, Math.min(o.interpolate + 1, Math.ceil(length / (o.radius / 2))));
    for (let i = 1; i <= steps; i++)
      this.push(last[0] + ((nx - last[0]) * i) / steps, last[1] + ((ny - last[1]) * i) / steps, 1);
    this.path += length;
    last[0] = nx;
    last[1] = ny;
  }

  /** Ends the stroke: the next `move` starts a new one instead of joining this one. */
  lift(): void {
    this.last = undefined;
  }

  /** One stamp at (`x`, `y`) of `strength` times `intensity` (default 1), not weighted by speed and not joined to a
   * stroke. */
  stamp(x: number, y: number, strength = 1): void {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !(Number.isFinite(strength) && strength >= 0))
      throw rangeError('TrailTexture stamp needs finite x and y and a strength >= 0', 'trail-texture');
    this.check();
    this.push(x, y, 0, strength);
  }

  /** Clears the trail on the next frame and drops queued stamps. */
  clear(): void {
    this.fresh = true;
    this.count = this.path = 0;
    this.last = undefined;
  }

  /** Paints `element`'s pointer moves (its box maps to the texture) until `signal` aborts or the returned function
   * runs; leaving the element or lifting the pointer ends the stroke. */
  trackPointer(element: HTMLElement, { signal }: { signal?: AbortSignal } = {}): () => void {
    const controller = new AbortController(),
      stop = () => controller.abort();
    if (signal?.aborted) return stop;
    signal?.addEventListener('abort', stop, { once: true, signal: controller.signal });
    const on = { signal: controller.signal, passive: true },
      lift = () => this.lift();
    element.addEventListener(
      'pointermove',
      (event: PointerEvent) => {
        if (this.disposed) return stop();
        const box = element.getBoundingClientRect();
        if (box.width > 0 && box.height > 0)
          this.move((event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height);
      },
      on,
    );
    for (const type of ['pointerleave', 'pointerup', 'pointercancel']) element.addEventListener(type, lift, on);
    return stop;
  }

  setup(engine: Engine): void {
    if (this.disposed) throw fault('disposed', 'TrailTexture is disposed; create a new one', 'disposed');
    if (this.engine) throw fault('attached', 'TrailTexture is already attached; create a new one', 'attached');
    if (!engine.gpu) throw fault('unsupported', 'TrailTexture needs WebGPU or the WebGL2 layer', 'webgpu');
    this.engine = engine;
    this.ensure(engine.gpu);
  }

  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: this.options.order ?? -20,
      execute: (c) => {
        if (c.backend === 'webgpu' && this.pending !== undefined) this.update(c, this.pending);
        this.pending = undefined;
      },
    });
  }

  /** Marks the frame: the pass updates the trail once, whatever the number of views. */
  onPreUpdate(delta: number): void {
    this.pending = delta;
  }

  onDeviceRestored(engine: Engine): void {
    this.release();
    this.ensure(engine.gpu!);
  }

  /** Releases the textures and buffers and removes the plugin. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const engine = this.engine;
    this.engine = undefined;
    engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
  }

  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  /** The options in effect, validated. */
  private check() {
    const o = this.options,
      v = {
        decay: o.decay ?? 0.95,
        radius: o.radius ?? 0.06,
        intensity: o.intensity ?? 1,
        smoothing: o.smoothing ?? 0,
        blend: o.blend ?? 'screen',
        interpolate: o.interpolate ?? 32,
        speed: o.speed ?? 1,
        enabled: o.enabled ?? true,
      };
    for (const key of ['decay', 'radius', 'intensity', 'smoothing', 'interpolate', 'speed'] as const)
      if (typeof v[key] !== 'number') throw typeError(`TrailTexture ${key} must be a number`, 'trail-texture');
    if (typeof v.enabled !== 'boolean') throw typeError('TrailTexture enabled must be a boolean', 'trail-texture');
    if (!BLENDS.includes(v.blend))
      throw typeError("TrailTexture blend must be 'screen', 'add' or 'max'", 'trail-texture');
    if (!(v.decay > 0 && v.decay <= 1)) throw rangeError('TrailTexture decay must be in (0, 1]', 'trail-texture');
    if (!(v.radius > 0 && v.radius <= 1))
      throw rangeError('TrailTexture radius must be above 0 and at most 1', 'trail-texture');
    if (!(Number.isFinite(v.intensity) && v.intensity >= 0))
      throw rangeError('TrailTexture intensity must be finite and >= 0', 'trail-texture');
    if (!(v.smoothing >= 0 && v.smoothing < 1))
      throw rangeError('TrailTexture smoothing must be in [0, 1)', 'trail-texture');
    if (!(Number.isInteger(v.interpolate) && v.interpolate >= 0 && v.interpolate <= 256))
      throw rangeError('TrailTexture interpolate must be a whole number 0 to 256', 'trail-texture');
    if (!(Number.isFinite(v.speed) && v.speed >= 0))
      throw rangeError('TrailTexture speed must be finite and >= 0', 'trail-texture');
    return v;
  }

  private push(x: number, y: number, moved: number, strength = 1): void {
    if (this.count === TRAIL_MAX_STAMPS) return;
    const i = this.count++;
    const q = this.queue;
    q[i * 4] = x;
    q[i * 4 + 1] = y;
    q[i * 4 + 2] = strength;
    this.moved[i] = moved;
  }

  /** The textures, buffers and pipelines on `device`, made when missing. */
  private ensure(device: GPUDevice): GPUTexture {
    if (this.disposed) throw fault('disposed', 'TrailTexture is disposed; create a new one', 'disposed');
    if (this.device !== device) this.release();
    if (this.textures[0]) return this.textures[0];
    const limit = device.limits?.maxTextureDimension2D ?? 8192;
    if (this.width > limit || this.height > limit)
      throw rangeError(`TrailTexture size is above this device's maxTextureDimension2D (${limit})`, 'trail-texture');
    this.device = device;
    const made = [0, 1].map(() =>
      device.createTexture({
        size: [this.width, this.height],
        format: 'rgba16float',
        // RENDER_ATTACHMENT | TEXTURE_BINDING | COPY_SRC | COPY_DST
        usage: 0x10 | 0x4 | 0x1 | 0x2,
      }),
    );
    this.textures = made;
    // UNIFORM | COPY_DST; VERTEX | COPY_DST
    this.uniform = device.createBuffer({ size: 32, usage: 0x40 | 0x8 });
    this.instanceBuffer = device.createBuffer({ size: TRAIL_MAX_STAMPS * 16, usage: 0x20 | 0x8 });
    this.fadePipeline = render(device, fadeShader, 'rgba16float');
    this.fadeGroup = group(device, this.fadePipeline, [{ buffer: this.uniform }, made[0].createView()]);
    this.fresh = true;
    return made[0];
  }

  private update(c: Context, delta: number): void {
    const o = this.check();
    if (!o.enabled) return;
    this.ensure(c.device);
    const device = c.device;
    if (this.stampBlend !== o.blend) {
      this.stampBlend = o.blend;
      const module = device.createShaderModule({ code: stampShader });
      this.stampPipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: {
          module,
          entryPoint: 'vertex',
          buffers: [
            {
              arrayStride: 16,
              stepMode: 'instance',
              attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }],
            },
          ],
        },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: 'rgba16float', blend: blendState(o.blend) }] },
        primitive: { topology: 'triangle-strip' },
      });
      this.stampGroup = group(device, this.stampPipeline, [{ buffer: this.uniform! }]);
    }
    const speed = delta > 0 && o.speed > 0 ? Math.min(1, this.path / delta / o.speed) : 1,
      n = this.count,
      q = this.queue;
    for (let i = 0; i < n; i++) q[i * 4 + 2] *= o.intensity * (this.moved[i] ? speed : 1);
    const v = this.values;
    v[0] = o.decay ** (delta * 60);
    v[1] = +this.fresh;
    v[2] = CUTOFF;
    v[4] = o.radius;
    v[5] = (o.radius * this.width) / this.height;
    device.queue.writeBuffer(this.uniform!, 0, v);
    if (n) device.queue.writeBuffer(this.instanceBuffer!, 0, q, 0, n * 4);
    this.fresh = false;
    this.count = this.path = 0;
    const [a, b] = this.textures;
    this.fadeAttachment.view = this.target ??= b.createView();
    const pass = c.encoder.beginRenderPass(this.descriptor);
    try {
      pass.setPipeline(this.fadePipeline!);
      pass.setBindGroup(0, this.fadeGroup!);
      pass.draw(3);
      if (n) {
        pass.setPipeline(this.stampPipeline!);
        pass.setBindGroup(0, this.stampGroup!);
        pass.setVertexBuffer(0, this.instanceBuffer!);
        pass.draw(4, n);
      }
    } finally {
      pass.end();
    }
    c.encoder.copyTextureToTexture({ texture: b }, { texture: a }, [this.width, this.height]);
  }

  private release(): void {
    for (const t of this.textures) t.destroy();
    this.uniform?.destroy();
    this.instanceBuffer?.destroy();
    this.textures = [];
    this.uniform = this.instanceBuffer = this.fadePipeline = this.fadeGroup = this.target = this.device = undefined;
    this.stampPipeline = this.stampGroup = this.stampBlend = undefined;
  }
}
