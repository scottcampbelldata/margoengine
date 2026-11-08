/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type FrameGraph, type PassContext } from '@margoengine/core/extension';
import {
  LabelRenderer,
  type Label,
  type CSS3DObject,
  type LabelRendererOptions,
  type LabelOptions,
} from '@margoengine/labels';
import { margoError } from '../../shared/errors.js';
import { acquireDepth, compute, group, dispatch } from '../../shared/gpu.js';
import { resolveMSAA } from '../../shared/msaa.js';
export type { Label, CSS3DObject } from '@margoengine/labels';
export type { LabelOptions, CSS3DOptions, LabelInfo } from '@margoengine/labels';
declare const GPUBufferUsage: {
  STORAGE: number;
  COPY_DST: number;
  COPY_SRC: number;
  MAP_READ: number;
  UNIFORM: number;
};
declare const GPUMapMode: { READ: number };
/**
 * Options of HTML: label renderer options plus optional depth-texture occlusion, the anchor capacity and a depth bias.
 */
export interface HTMLOptions extends LabelRendererOptions {
  depth?: false | (() => GPUTexture | undefined);
  capacity?: number;
  depthBias?: number;
  /**
   * Fade an anchor as geometry covers it instead of hiding it at once: its element's opacity follows the share of a
   * grid of depth tests around the anchor that pass. `true` uses the defaults of {@link HTMLFadeOptions}. Default off.
   */
  fade?: boolean | HTMLFadeOptions;
}
/** How HTML fades partly occluded anchors. */
export interface HTMLFadeOptions {
  /** Half the side of the sampled square around the anchor, in CSS pixels, 0 to 256. Default 8. */
  radius?: number;
  /** Depth tests per side of the square's grid, 2 to 8. Default 4 (16 tests an anchor). */
  samples?: number;
  /** Seconds the opacity takes to go from 1 to 0, 0 to 10; 0 follows each result at once. Default 0.15. */
  duration?: number;
}
interface Fade {
  radius: number;
  samples: number;
  duration: number;
}
const shader = `
@group(0) @binding(0) var depth:texture_depth_2d;
@group(0) @binding(1) var<storage,read> points:array<vec4f>;
@group(0) @binding(2) var<storage,read_write> output:array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=arrayLength(&points)){return;}let point=points[id.x];let p=vec2i(point.xy);let size=vec2i(textureDimensions(depth));
 output[id.x]=0u;if(any(p<vec2i(0))||any(p>=size)){return;}
 let d=textureLoad(depth,p,0);output[id.x]=select(0u,1u,d>point.z+point.w);
}`;
// Percentage-closer occlusion: the share of an n x n grid of depth tests over a square around the anchor that geometry
// covers (Reeves, Salesin and Cook 1987 filter shadow-map tests the same way). Samples off the target count as clear.
const fadeShader = (samples: number) => `
@group(0) @binding(0) var depth:texture_depth_2d;
@group(0) @binding(1) var<storage,read> points:array<vec4f>;
@group(0) @binding(2) var<storage,read_write> output:array<u32>;
@group(0) @binding(3) var<uniform> radius:vec4f;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=arrayLength(&points)){return;}let point=points[id.x];let size=vec2i(textureDimensions(depth));var covered=0u;
 for(var j=0u;j<${samples}u;j++){for(var i=0u;i<${samples}u;i++){
  let o=(vec2f(f32(i),f32(j))+.5)*(2./${samples}.)-1.;let p=vec2i(floor(point.xy+o*radius.xy));
  if(all(p>=vec2i(0))&&all(p<size)){if(textureLoad(depth,p,0)>point.z+point.w){covered++;}}
 }}
 output[id.x]=covered;
}`;
interface Record {
  label: Label;
  index: number;
  hidden: boolean;
  x: number;
  y: number;
  z: number;
  /** Fade: the visible share of the last fresh depth result, the opacity moving toward it and the opacity written. */
  target: number;
  opacity: number;
  written: number;
}
function fadeOptions(fade: HTMLOptions['fade']): Fade | undefined {
  if (fade === undefined || fade === false) return undefined;
  const o = fade === true ? {} : fade;
  if (typeof o !== 'object' || o === null)
    throw new RangeError('Invalid HTML fade options; pass fade: true or an object of radius, samples and duration');
  const radius = o.radius ?? 8,
    samples = o.samples ?? 4,
    duration = o.duration ?? 0.15;
  if (
    !(radius >= 0 && radius <= 256) ||
    !Number.isInteger(samples) ||
    samples < 2 ||
    samples > 8 ||
    !(duration >= 0 && duration <= 10)
  )
    throw new RangeError(
      'Invalid HTML fade options; pass radius 0 to 256 CSS pixels, samples a whole number 2 to 8 and duration 0 to 10 seconds',
    );
  return { radius, samples, duration };
}
/** DOM projection from labels, with asynchronous rendered-depth occlusion for 2D anchors. */
export class HTML extends LabelRenderer {
  private runtime?: Engine;
  private readonly records = new Map<Label, Record>();
  private slots: (Record | undefined)[];
  private readonly values: Float32Array;
  private readonly capacity: number;
  private shared?: ReturnType<typeof acquireDepth>;
  private source?: () => GPUTexture | undefined;
  private input?: GPUBuffer;
  private output?: GPUBuffer;
  private read?: GPUBuffer;
  private pipeline?: GPUComputePipeline;
  private pending = false;
  private generation = 0;
  private disposed = false;
  private sampledDepth?: GPUTexture;
  private depthGroup?: GPUBindGroup;
  /** Snapshot of the slots submitted with the current depth read. The next sample waits until that read finishes. */
  private readonly depthRequests: ({ record: Record; x: number; y: number; z: number } | undefined)[] = [];
  private readonly fade?: Fade;
  private radius?: GPUBuffer;
  private readonly radiusValues = new Float32Array(4);
  private delta = 0;
  constructor(private readonly settings: HTMLOptions = {}) {
    super({ ...settings, name: settings.name ?? 'html', order: 1000 });
    const capacity = settings.capacity ?? 1024,
      bias = settings.depthBias ?? 0.0001;
    if (
      !Number.isInteger(capacity) ||
      capacity < 1 ||
      capacity > 4096 ||
      !Number.isFinite(bias) ||
      bias < 0 ||
      bias > 0.05 ||
      (settings.depth !== undefined && settings.depth !== false && typeof settings.depth !== 'function')
    )
      throw new RangeError(
        'Invalid HTML depth options; pass depth: false or a function returning a depth texture, and a finite depthBias',
      );
    this.fade = fadeOptions(settings.fade);
    this.capacity = capacity;
    this.values = new Float32Array(capacity * 4);
    this.slots = new Array(capacity);
  }
  static override attach(engine: EngineKernel, options: HTMLOptions = {}): HTML {
    const overlay = new HTML(options);
    engineRuntime(engine).use(overlay);
    return overlay;
  }
  override add(element: HTMLElement, options: LabelOptions = {}): Label {
    if (this.disposed) throw margoError('disposed', 'HTML is disposed; create a new HTML renderer');
    const index = this.slots.findIndex((record) => !record);
    if (index < 0) throw new RangeError('HTML anchor capacity exceeded; raise capacity or remove anchors');
    const label = super.add(element, {
      ...options,
      occlude: (item, info) => {
        const record = this.records.get(item)!;
        record.x = info.x;
        record.y = info.y;
        record.z = 1 - info.depth;
        const canvas = this.runtime?.canvas;
        if (canvas) {
          // Hook coordinates are CSS pixels from the view's corner; the depth test reads drawing-buffer pixels.
          const view = this.view,
            scaleX = canvas.width / (canvas.clientWidth || canvas.width),
            scaleY = canvas.height / (canvas.clientHeight || canvas.height),
            at = index * 4;
          this.values[at] = info.x * scaleX + (view ? view.viewport[0] * (view.pixels ? 1 : canvas.width) : 0);
          this.values[at + 1] = info.y * scaleY + (view ? view.viewport[1] * (view.pixels ? 1 : canvas.height) : 0);
          this.values[at + 2] = record.z;
          this.values[at + 3] = this.settings.depthBias ?? 0.0001;
        }
        return !!(options.occlude ?? this.settings.occlude)?.(item, info) || record.hidden;
      },
    });
    const record = { label, index, hidden: false, x: 0, y: 0, z: 0, target: 1, opacity: 1, written: 1 };
    this.records.set(label, record);
    this.slots[index] = record;
    return label;
  }
  override remove(item: Label | CSS3DObject): void {
    const record = this.records.get(item as Label);
    if (record) {
      this.slots[record.index] = undefined;
      this.records.delete(item as Label);
      this.values.set([-1, -1, 0, 0], record.index * 4);
    }
    super.remove(item);
  }
  override setup(instance: EngineKernel): void {
    if (this.disposed) throw margoError('disposed', 'HTML is disposed; create a new HTML renderer');
    this.runtime = engineRuntime(instance);
    super.setup(instance);
    this.setupGPU();
  }
  private setupGPU(): void {
    const engine = this.runtime!;
    if (!engine.gpu || this.settings.depth === false) return;
    this.shared = this.settings.depth ? undefined : acquireDepth(engine);
    this.source = this.settings.depth || this.shared!.texture;
    this.input = engine.gpu.createBuffer({
      size: this.values.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.output = engine.gpu.createBuffer({
      size: this.capacity * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    this.read = engine.gpu.createBuffer({
      size: this.capacity * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    if (this.fade)
      this.radius = engine.gpu.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.pipeline = compute(engine.gpu, this.fade ? fadeShader(this.fade.samples) : shader);
  }
  onPreUpdate(delta: number): void {
    this.delta += delta;
  }
  /** Positions every anchor; with `fade`, first moves each opacity toward its visible share, then writes it. */
  override update(): void {
    const fade = this.fade;
    if (fade) {
      const step = fade.duration > 0 ? this.delta / fade.duration : Infinity;
      this.delta = 0;
      for (const record of this.records.values()) {
        const gap = record.target - record.opacity;
        record.opacity = Math.abs(gap) <= step ? record.target : record.opacity + Math.sign(gap) * step;
        record.hidden = record.opacity <= 0;
      }
    }
    super.update();
    if (fade)
      for (const record of this.records.values()) {
        const value = Math.round(record.opacity * 1000) / 1000;
        if (record.label.onScreen && value !== record.written) {
          record.written = value;
          record.label.element.style.opacity = value === 1 ? '' : String(value);
        }
      }
  }
  override registerPasses(graph: FrameGraph): void {
    super.registerPasses(graph);
    graph.add({
      name: this.name + ':depth',
      order: 1001,
      execute: (c) => {
        if (c.backend === 'webgpu' && this.pipeline && !this.pending) this.sample(c);
      },
    });
  }
  private sample(c: Extract<PassContext, { backend: 'webgpu' }>): void {
    resolveMSAA(c);
    const depth = this.source!();
    if (!depth || depth.width !== c.width || depth.height !== c.height || !depth.format.startsWith('depth'))
      throw margoError(
        'state',
        'HTML requires viewport-sized scene depth; pass a depth texture that matches the canvas, or depth: false',
      );
    if (!this.records.size) return;
    for (let i = 0; i < this.capacity; i++)
      if (!this.slots[i] || !this.slots[i]!.label.visible || !this.slots[i]!.label.screen.inFrustum) {
        const at = i * 4;
        this.values[at] = this.values[at + 1] = -1;
        this.values[at + 2] = this.values[at + 3] = 0;
      }
    c.device.queue.writeBuffer(this.input!, 0, this.values as Float32Array<ArrayBuffer>);
    if (this.fade) {
      // The square's half side in drawing-buffer pixels, kept to its CSS size as the canvas scale changes.
      const canvas = this.runtime!.canvas,
        r = this.radiusValues,
        x = (this.fade.radius * canvas.width) / (canvas.clientWidth || canvas.width),
        y = (this.fade.radius * canvas.height) / (canvas.clientHeight || canvas.height);
      if (r[0] !== x || r[1] !== y || !this.depthGroup) {
        r[0] = x;
        r[1] = y;
        c.device.queue.writeBuffer(this.radius!, 0, r as Float32Array<ArrayBuffer>);
      }
    }
    if (!this.depthGroup || depth !== this.sampledDepth) {
      const entries: GPUBindingResource[] = [
        depth.createView({ aspect: 'depth-only' }),
        { buffer: this.input! },
        { buffer: this.output! },
      ];
      if (this.radius) entries.push({ buffer: this.radius });
      this.depthGroup = group(c.device, this.pipeline!, entries);
      this.sampledDepth = depth;
    }
    dispatch(c, this.pipeline!, this.depthGroup, Math.ceil(this.capacity / 64));
    const read = this.read!,
      generation = this.generation,
      requests = this.depthRequests;
    for (let i = 0; i < this.capacity; i++) {
      const record = this.slots[i];
      if (!record) {
        requests[i] = undefined;
        continue;
      }
      let request = requests[i];
      if (!request) requests[i] = request = { record, x: 0, y: 0, z: 0 };
      request.record = record;
      request.x = record.x;
      request.y = record.y;
      request.z = record.z;
    }
    requests.length = this.capacity;
    c.encoder.copyBufferToBuffer(this.output!, 0, read, 0, this.capacity * 4);
    this.pending = true;
    queueMicrotask(async () => {
      try {
        await read.mapAsync(GPUMapMode.READ);
        if (this.disposed || generation !== this.generation) return;
        const result = new Uint32Array(read.getMappedRange()),
          fade = this.fade,
          // A result is fresh while the anchor stays within 4 CSS pixels (or the faded square) of where it was taken.
          near = fade ? Math.max(4, fade.radius) : 4,
          tests = fade ? fade.samples * fade.samples : 1;
        for (let i = 0; i < this.capacity; i++) {
          const request = requests[i];
          if (!request || this.slots[i] !== request.record) continue;
          const record = request.record,
            fresh =
              Math.abs(request.x - record.x) + Math.abs(request.y - record.y) < near &&
              Math.abs(request.z - record.z) < 0.001;
          // A stale result shows the anchor: one moving fast is never hidden by where it was.
          if (fade) record.target = fresh ? 1 - Math.min(result[i], tests) / tests : 1;
          else record.hidden = fresh && !!result[i];
        }
      } catch {
        for (const record of this.records.values()) {
          record.hidden = false;
          record.target = 1;
        }
      } finally {
        if (read.mapState === 'mapped') read.unmap();
        if (generation === this.generation) this.pending = false;
      }
    });
  }
  private release(): void {
    this.generation++;
    this.pending = false;
    this.shared?.release();
    this.shared = undefined;
    this.input?.destroy();
    this.output?.destroy();
    this.read?.destroy();
    this.radius?.destroy();
    this.input = this.output = this.read = this.radius = undefined;
    this.pipeline = undefined;
    this.sampledDepth = this.depthGroup = undefined;
  }
  onDeviceRestored(): void {
    this.release();
    for (const record of this.records.values()) {
      record.hidden = false;
      record.target = 1;
    }
    this.setupGPU();
  }
  override dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.runtime?.removePlugin(this.name);
    this.release();
    super.dispose();
    this.records.clear();
    this.slots.fill(undefined);
    this.runtime = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
