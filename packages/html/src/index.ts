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
// WebGL2 occlusion (the preview backend draws straight to the canvas, whose depth cannot be sampled): one point per
// depth test, drawn after the scene with colour and depth writes off inside an ANY_SAMPLES_PASSED query (WebGL 2.0 and
// OpenGL ES 3.0 occlusion queries). The camera matrix is the renderer's own, so the point lands at the scene's depth.
const glVertex = `#version 300 es
uniform mat4 camera;uniform vec3 world;uniform vec2 offset;uniform float bias;
void main(){vec4 p=camera*vec4(world,1.0);p.xy+=offset*p.w;p.z-=2.0*bias*p.w;gl_Position=p;gl_PointSize=1.0;}`;
const glFragment = `#version 300 es
precision lowp float;out vec4 color;void main(){color=vec4(0.0);}`;
interface GLSlot {
  queries: WebGLQuery[];
  /** Tests this round actually drew (a sample off the view is not drawn and counts as clear). */
  drawn: boolean[];
  pending: boolean;
  record?: Record;
  x: number;
  y: number;
  z: number;
}
interface GLState {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  camera: WebGLUniformLocation | null;
  world: WebGLUniformLocation | null;
  offset: WebGLUniformLocation | null;
  bias: WebGLUniformLocation | null;
  slots: (GLSlot | undefined)[];
}
function glState(gl: WebGL2RenderingContext): GLState {
  const program = gl.createProgram()!,
    vertex = gl.createShader(gl.VERTEX_SHADER)!,
    fragment = gl.createShader(gl.FRAGMENT_SHADER)!;
  gl.shaderSource(vertex, glVertex);
  gl.shaderSource(fragment, glFragment);
  gl.compileShader(vertex);
  gl.compileShader(fragment);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost())
    throw margoError(
      'failed',
      `HTML could not build its WebGL2 occlusion shaders (${gl.getProgramInfoLog(program)}); pass depth: false to draw without occlusion`,
    );
  return {
    gl,
    program,
    vao: gl.createVertexArray()!,
    camera: gl.getUniformLocation(program, 'camera'),
    world: gl.getUniformLocation(program, 'world'),
    offset: gl.getUniformLocation(program, 'offset'),
    bias: gl.getUniformLocation(program, 'bias'),
    slots: [],
  };
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
  private glOcclusion?: GLState;
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
        if (c.backend === 'webgpu') {
          if (this.pipeline && !this.pending) this.sample(c);
        } else if (this.settings.depth !== false && !c.gl.isContextLost())
          this.query(c.gl, c.camera.matrix, c.view?.viewport);
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
  /**
   * WebGL2: reads every finished query round, then draws a new round for each anchor that has none in flight. Results
   * become available a frame or more later (WebGL 2.0 never makes them available in the frame that issued them).
   */
  private query(gl: WebGL2RenderingContext, camera: Float32Array | number[], viewport?: readonly number[]): void {
    let state = this.glOcclusion;
    if (state && state.gl !== gl) this.releaseGL();
    state = this.glOcclusion ??= glState(gl);
    const fade = this.fade,
      side = fade ? fade.samples : 1,
      tests = side * side,
      near = fade ? Math.max(4, fade.radius) : 4,
      canvas = this.runtime?.canvas,
      cssWidth = canvas ? canvas.clientWidth || canvas.width : 1,
      cssHeight = canvas ? canvas.clientHeight || canvas.height : 1,
      [vx, vy, vw, vh] = viewport ?? [0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight],
      // The labels' points are CSS pixels in the view; the view is drawing-buffer pixels.
      width = (vw * cssWidth) / gl.drawingBufferWidth,
      height = (vh * cssHeight) / gl.drawingBufferHeight,
      radius = fade?.radius ?? 0,
      bias = this.settings.depthBias ?? 0.0001;
    let drawing = false;
    for (let i = 0; i < this.capacity; i++) {
      const record = this.slots[i];
      let slot = state.slots[i];
      if (slot?.pending) {
        let ready = true;
        for (let k = 0; k < tests && ready; k++)
          ready = !slot.drawn[k] || !!gl.getQueryParameter(slot.queries[k], gl.QUERY_RESULT_AVAILABLE);
        if (!ready) continue;
        slot.pending = false;
        if (record && slot.record === record) {
          let covered = 0;
          for (let k = 0; k < tests; k++)
            if (slot.drawn[k] && !gl.getQueryParameter(slot.queries[k], gl.QUERY_RESULT)) covered++;
          const fresh =
            Math.abs(slot.x - record.x) + Math.abs(slot.y - record.y) < near && Math.abs(slot.z - record.z) < 0.001;
          if (fade) record.target = fresh ? 1 - covered / tests : 1;
          else record.hidden = fresh && covered > 0;
        }
      }
      if (!record || !record.label.visible || !record.label.screen.inFront || !record.label.screen.inFrustum) continue;
      if (!slot) {
        slot = state.slots[i] = { queries: [], drawn: [], pending: false, x: 0, y: 0, z: 0 };
        for (let k = 0; k < tests; k++) slot.queries.push(gl.createQuery()!);
      }
      if (!drawing) {
        drawing = true;
        gl.viewport(vx, gl.drawingBufferHeight - vy - vh, vw, vh);
        gl.useProgram(state.program);
        gl.bindVertexArray(state.vao);
        gl.colorMask(false, false, false, false);
        gl.depthMask(false);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LESS);
        gl.uniformMatrix4fv(state.camera, false, camera);
        gl.uniform1f(state.bias, bias);
      }
      const world = record.label.world;
      gl.uniform3f(state.world, world[0], world[1], world[2]);
      for (let k = 0; k < tests; k++) {
        // The same grid as the WebGPU shader: cell centres over [-radius, radius] on each axis, in CSS pixels.
        const ox = side > 1 ? (((k % side) + 0.5) * 2) / side - 1 : 0,
          oy = side > 1 ? ((Math.floor(k / side) + 0.5) * 2) / side - 1 : 0,
          sx = record.x + ox * radius,
          sy = record.y + oy * radius;
        slot.drawn[k] = sx >= 0 && sx < width && sy >= 0 && sy < height;
        if (!slot.drawn[k]) continue;
        gl.beginQuery(gl.ANY_SAMPLES_PASSED, slot.queries[k]);
        gl.uniform2f(state.offset, ((ox * radius) / width) * 2, (-(oy * radius) / height) * 2);
        gl.drawArrays(gl.POINTS, 0, 1);
        gl.endQuery(gl.ANY_SAMPLES_PASSED);
      }
      slot.pending = true;
      slot.record = record;
      slot.x = record.x;
      slot.y = record.y;
      slot.z = record.z;
    }
    if (drawing) {
      gl.colorMask(true, true, true, true);
      gl.depthMask(true);
      gl.bindVertexArray(null);
      gl.useProgram(null);
    }
  }
  private releaseGL(): void {
    const state = this.glOcclusion;
    this.glOcclusion = undefined;
    if (!state || state.gl.isContextLost()) return;
    for (const slot of state.slots) for (const query of slot?.queries ?? []) state.gl.deleteQuery(query);
    state.gl.deleteVertexArray(state.vao);
    state.gl.deleteProgram(state.program);
  }
  private release(): void {
    this.releaseGL();
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
