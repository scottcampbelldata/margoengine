/// <reference lib="esnext.disposable" preserve="true" />
// Planar captures shared by Reflector (mirror) and Refractor (glass): a rectangle in a transform node's local XY plane,
// facing +Z, that shows a capture of the scene through projective texture coordinates. Each capture renders the scene
// with an oblique near plane on the surface plane (Lengyel, JGT 2005), so nothing on the wrong side of the plane shows.
import type { EngineKernel, Mesh } from '@margoengine/core';
import {
  Camera,
  engineRuntime,
  meshRuntime,
  type FrameGraph,
  type PassContext,
  type Vec3,
} from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { composeMatrix, multiplyMatrices } from '@margoengine/math/mat4';
import { displayShader } from '../../shared/display.js';
import { linearColor, type ColorInput } from './color.js';
import {
  CaptureTarget,
  activeCapture,
  captureScene,
  obliqueNearPlane,
  perspective,
  scenePasses,
  viewPlane,
  type CapturePassContext,
  type CapturePassFilter,
} from './capture.js';
import { checkLayers } from '../../shared/view-rect.js';
import { hiddenInTree } from '../../shared/visibility.js';
import { webgpuPass } from '../../shared/pass.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number; RENDER_ATTACHMENT: number };

type PlanarContext = Extract<PassContext, { backend: 'webgpu' }>;

/** RGBA8 pixels, 4 bytes per pixel, row 0 first: a tangent-space normal map as stored in image files. */
export interface NormalMapImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array | Uint8ClampedArray;
}

/** Options shared by {@link Reflector} and {@link Refractor}; invalid values throw TypeError or RangeError. */
export interface PlanarOptions {
  /** Width along the node's local X, in local units (the node's scale applies). Default 1. */
  width?: number;
  /** Height along the node's local Y. Default 1. */
  height?: number;
  /** Parent of the transform node `node`. Default none. */
  parent?: Mesh | null;
  /** Tint multiplied into the captured image: `'#rrggbb'`, `0xrrggbb` (sRGB) or linear `[r, g, b]`. Default white. */
  color?: ColorInput;
  /** Capture size as a fraction of the canvas, over 0 and at most 2. Default 1. */
  resolution?: number;
  /** World distance the clip plane sits from the surface into the captured side; positive hides geometry that touches the surface, negative lets some through. Default 0. */
  clipBias?: number;
  /** Blur of the captured image, 0 (sharp) to 1 (the coarsest mip). Default 0. */
  roughness?: number;
  /** Tangent-space normal map that distorts the image: a `GPUTexture` (2D, filterable) or RGBA8 pixels. Default none. */
  normalMap?: GPUTexture | NormalMapImage;
  /** Image offset, in screen fractions, per unit of normal-map x and y. Default 0.03. */
  distortion?: number;
  /** Normal-map repeats across the surface (u, v). Default [1, 1]. */
  normalRepeat?: readonly [number, number];
  /** Normal-map scroll in repeats per second (u, v), for flowing water. Default [0, 0]. */
  normalScroll?: readonly [number, number];
  /** Layer mask the capture draws (@margoengine/cameras/layers). Default every layer. */
  layers?: number;
  /** Meshes left out of the capture. */
  exclude?: Iterable<Mesh>;
  /** Capture before every engine frame (`engine.start`). With your own `engine.render()` loop call `update()` first. Default true. */
  autoUpdate?: boolean;
  /** Frame-graph passes the capture runs. Default {@link scenePasses}. */
  passes?: CapturePassFilter;
  /** Frame-graph order of the surface draw, after core's main pass. Default 1. */
  order?: number;
  /** Plugin and pass name. Default 'reflector-N' or 'refractor-N'. */
  name?: string;
}

const SURFACE = /* wgsl */ `
${displayShader}
struct Surface { viewProj:mat4x4f, capture:mat4x4f, model:mat4x4f, size:vec4f, tint:vec4f, normal:vec4f, flags:vec4f }
@group(0) @binding(0) var<uniform> u:Surface;
@group(0) @binding(1) var image:texture_2d<f32>;
@group(0) @binding(2) var normalMap:texture_2d<f32>;
@group(0) @binding(3) var clampSampler:sampler;
@group(0) @binding(4) var repeatSampler:sampler;
struct Out { @builtin(position) position:vec4f, @location(0) world:vec3f, @location(1) uv:vec2f }
@vertex fn vertex(@builtin(vertex_index) i:u32)->Out {
  let corner=array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(1,1),vec2f(-1,-1),vec2f(1,1),vec2f(-1,1))[i];
  let world=u.model*vec4f(corner*u.size.xy,0.0,1.0);
  var o:Out;o.position=u.viewProj*world;o.world=world.xyz;o.uv=vec2f(corner.x,-corner.y)*0.5+0.5;return o;
}
@fragment fn fragment(i:Out)->@location(0) vec4f {
  let clip=u.capture*vec4f(i.world,1.0);
  var uv=clip.xy/clip.w*vec2f(0.5,-0.5)+0.5;
  let n=textureSample(normalMap,repeatSampler,i.uv*u.normal.xy+u.normal.zw).xy*2.0-1.0;
  uv+=n*u.size.w*u.flags.x;
  let c=textureSampleLevel(image,clampSampler,uv,u.size.z).rgb*u.tint.rgb;
  if(u.flags.y>0.5){return vec4f(c,1.0);}
  return vec4f(toDisplay(c),1.0);
}`;
// 2x2 box reduction of the previous mip, for the roughness blur.
const REDUCE = /* wgsl */ `
@group(0) @binding(0) var source:texture_2d<f32>;
@group(0) @binding(1) var linearSampler:sampler;
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {return vec4f(array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i],0,1);}
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {
  return textureSampleLevel(source,linearSampler,p.xy*2.0/vec2f(textureDimensions(source,0)),0.0);
}`;

const finite = (value: unknown, label: string, min = -Infinity, max = Infinity, open = false): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (open && value === min)) {
    const low = min === -Infinity ? '' : open ? ` above ${min}` : ` of at least ${min}`,
      high = max === Infinity ? '' : ` and at most ${max}`;
    throw new RangeError(`${label} ${String(value)} is invalid; pass a finite number${low}${high}`);
  }
  return value;
};
const pair = (value: unknown, label: string): [number, number] => {
  if (!Array.isArray(value) || value.length !== 2 || !value.every((v) => typeof v === 'number' && Number.isFinite(v)))
    throw new TypeError(`${label} must be two finite numbers [u, v]`);
  return [value[0], value[1]];
};
const isTexture = (value: unknown): value is GPUTexture =>
  typeof (value as GPUTexture | undefined)?.createView === 'function';

interface DeviceState {
  device: GPUDevice;
  uniform: GPUBuffer;
  clampSampler: GPUSampler;
  repeatSampler: GPUSampler;
  placeholder: GPUTexture;
  pipelines: Map<string, GPURenderPipeline>;
  reduce?: GPURenderPipeline;
  normal?: { source: GPUTexture | NormalMapImage; texture: GPUTexture; view: GPUTextureView; owned: boolean };
  group?: { pipeline: GPURenderPipeline; image: GPUTextureView; normal: GPUTextureView; value: GPUBindGroup };
}
interface Blur {
  texture: GPUTexture;
  view: GPUTextureView;
  levels: GPUTextureView[];
  groups: GPUBindGroup[];
  key: string;
}

/** Shared base of {@link Reflector} and {@link Refractor}; create those instead. */
export abstract class PlanarSurface {
  readonly name: string;
  readonly order: number;
  /** The capture camera of the last `update()` (its `matrix` maps world points to the captured image). */
  readonly camera = new Camera();
  /** Capture before every engine frame. */
  autoUpdate: boolean;
  /** Frame-graph passes the capture runs. */
  passes: CapturePassFilter;
  /** Meshes left out of the capture. */
  exclude?: Iterable<Mesh>;
  /** Normal-map repeats (u, v) across the surface. */
  normalRepeat: [number, number];
  /** Normal-map scroll in repeats per second (u, v). */
  normalScroll: [number, number];
  protected engine?: EngineKernel;
  private nodeValue?: Mesh;
  private readonly parent: Mesh | null;
  private widthValue = 1;
  private heightValue = 1;
  private tint: [number, number, number] = [1, 1, 1];
  private resolutionValue = 1;
  private clipBiasValue = 0;
  private roughnessValue = 0;
  private distortionValue = 0.03;
  private layersValue = 0xffffffff;
  private normalSource?: GPUTexture | NormalMapImage;
  private readonly target = new CaptureTarget();
  private blur?: Blur;
  private state?: DeviceState;
  private captured = false;
  private readonly captureMatrix = new Float32Array(16);
  private readonly values = new Float32Array(64);
  private time = 0;
  private stopFrames?: () => void;
  private disposed = false;
  private readonly world = new Float64Array(16);
  private readonly plane = new Float64Array(4);
  private readonly projection = new Float64Array(16);
  private readonly local = new Float64Array(16);
  private readonly product = new Float64Array(16);
  private readonly corners = new Float64Array(12);
  /** Plane and normal of the last `aim()`: point `origin`, unit `normal` (the node's +Z side). */
  protected readonly origin: [number, number, number] = [0, 0, 0];
  protected readonly normal: [number, number, number] = [0, 0, 1];

  constructor(kind: string, count: number, options: PlanarOptions) {
    this.name = options.name ?? `${kind}-${count}`;
    if (typeof this.name !== 'string' || !this.name)
      throw new TypeError(`${kind} name must be a non-empty string; pass a name or omit it`);
    this.order = finite(options.order ?? 1, `${kind} order`, 0, Infinity, true);
    this.parent = options.parent ?? null;
    this.width = options.width ?? 1;
    this.height = options.height ?? 1;
    if (options.color !== undefined) this.color = options.color;
    this.resolution = options.resolution ?? 1;
    this.clipBias = options.clipBias ?? 0;
    this.roughness = options.roughness ?? 0;
    this.distortion = options.distortion ?? 0.03;
    this.layers = options.layers ?? 0xffffffff;
    this.exclude = options.exclude;
    this.autoUpdate = options.autoUpdate ?? true;
    this.passes = options.passes ?? scenePasses;
    if (typeof this.passes !== 'function')
      throw new TypeError(`${kind} passes must be a function (pass) => boolean; pass scenePasses or omit it`);
    this.normalRepeat = pair(options.normalRepeat ?? [1, 1], `${kind} normalRepeat`);
    this.normalScroll = pair(options.normalScroll ?? [0, 0], `${kind} normalScroll`);
    this.normalMap = options.normalMap;
  }

  /** The transform node (a core mesh without geometry): move, rotate, scale and parent the surface through it. */
  get node(): Mesh {
    if (!this.nodeValue)
      throw new MargoError('state', `${this.name} is not attached; engine.use(${this.name}) before reading node`);
    return this.nodeValue;
  }
  get width(): number {
    return this.widthValue;
  }
  set width(value: number) {
    this.widthValue = finite(value, 'Surface width', 0, Infinity, true);
  }
  get height(): number {
    return this.heightValue;
  }
  set height(value: number) {
    this.heightValue = finite(value, 'Surface height', 0, Infinity, true);
  }
  /** Linear RGB tint. Assign any ColorInput. */
  get color(): readonly [number, number, number] {
    return this.tint;
  }
  set color(value: ColorInput) {
    this.tint = linearColor(value);
  }
  get resolution(): number {
    return this.resolutionValue;
  }
  set resolution(value: number) {
    this.resolutionValue = finite(value, 'Surface resolution', 0, 2, true);
  }
  get clipBias(): number {
    return this.clipBiasValue;
  }
  set clipBias(value: number) {
    this.clipBiasValue = finite(value, 'Surface clipBias');
  }
  get roughness(): number {
    return this.roughnessValue;
  }
  set roughness(value: number) {
    this.roughnessValue = finite(value, 'Surface roughness', 0, 1);
  }
  get distortion(): number {
    return this.distortionValue;
  }
  set distortion(value: number) {
    this.distortionValue = finite(value, 'Surface distortion');
  }
  get layers(): number {
    return this.layersValue;
  }
  set layers(value: number) {
    this.layersValue = checkLayers(value, 'Surface layers');
  }
  get normalMap(): GPUTexture | NormalMapImage | undefined {
    return this.normalSource;
  }
  set normalMap(value: GPUTexture | NormalMapImage | undefined) {
    if (value !== undefined && !isTexture(value)) {
      const image = value as NormalMapImage;
      if (
        !Number.isSafeInteger(image?.width) ||
        !Number.isSafeInteger(image?.height) ||
        image.width < 1 ||
        image.height < 1 ||
        !(image.data instanceof Uint8Array || image.data instanceof Uint8ClampedArray) ||
        image.data.length !== image.width * image.height * 4
      )
        throw new TypeError('Surface normalMap must be a GPUTexture or RGBA8 pixels {width, height, data}');
    }
    this.normalSource = value;
  }
  /** The latest captured image (linear `rgba16float`), or undefined before the first capture. */
  get texture(): GPUTexture | undefined {
    return this.captured ? this.target.color : undefined;
  }

  setup(engine: EngineKernel): void {
    if (this.disposed) throw new MargoError('disposed', `${this.name} is disposed; create a new one`);
    if (engine.backend !== 'webgpu')
      throw new MargoError(
        'unsupported',
        `${this.name} requires the WebGPU backend; use an engine on the WebGPU backend`,
      );
    if (this.engine) throw new MargoError('attached', `${this.name} is attached to an engine; create another surface`);
    this.engine = engine;
    this.nodeValue = engine.createMesh(this.parent);
    this.nodeValue.name = this.name;
    this.stopFrames = engine.onFrame(() => {
      if (this.autoUpdate) this.update();
    });
  }
  registerPasses(graph: FrameGraph): void {
    graph.add(webgpuPass(this.name, this.order, (c) => this.draw(c)));
  }
  onDeviceRestored(): void {
    this.release();
  }

  /** Points the capture camera for this frame: false when the surface shows nothing (seen from behind, edge-on). */
  protected abstract aim(main: Camera): boolean;
  /** True when the surface is drawn for an eye at signed distance `side` from its plane (positive on the +Z side). */
  protected abstract faces(side: number): boolean;
  /** Sets the oblique clip: keep points with `n · p + w >= 0` (world), then the capture camera's projection. */
  protected clip(main: Camera, n: Vec3, w: number): boolean {
    const camera = this.camera,
      canvas = this.engine!.canvas,
      aspect = canvas.width / canvas.height;
    if (!viewPlane(camera.position, camera.target, camera.up, n, w, this.plane)) return false;
    const project = main.project,
      plane = this.plane;
    const base = (out: Float64Array, ratio: number, webgpu: boolean) => {
      if (project) project(out, ratio, webgpu);
      else perspective(out, main.fov, ratio, main.near, main.far);
    };
    this.projection.fill(0);
    base(this.projection, aspect, true);
    if (!obliqueNearPlane(this.projection, plane)) return false;
    camera.fov = main.fov;
    camera.near = main.near;
    camera.far = main.far;
    camera.project = (out, ratio, webgpu) => {
      base(out, ratio, webgpu);
      if (webgpu) obliqueNearPlane(out, plane);
    };
    return true;
  }

  /**
   * Captures the scene for this frame now. Runs on its own before each engine frame while `autoUpdate` is on; call it
   * yourself before `engine.render()` otherwise. False (keeping the previous image) when the surface is hidden, outside
   * the view or seen edge-on (and, for a mirror, from behind). Not from inside a frame pass (the engine rejects
   * nested renders).
   * @throws MargoError `state` when another capture is rendering.
   */
  update(): boolean {
    const engine = this.engine,
      node = this.nodeValue;
    if (this.disposed || !engine || !node || engine.disposed) return false;
    const runtime = engineRuntime(engine);
    if (!runtime.gpu || !this.worldMatrix(node) || !this.inView(runtime.camera) || !this.aim(runtime.camera))
      return false;
    const canvas = engine.canvas,
      limit = Math.min(4096, runtime.gpu.limits.maxTextureDimension2D),
      width = Math.max(1, Math.min(limit, Math.round(canvas.width * this.resolutionValue))),
      height = Math.max(1, Math.min(limit, Math.round(canvas.height * this.resolutionValue)));
    const drawn = captureScene(engine, {
      camera: this.camera,
      target: this.target,
      width,
      height,
      layers: this.layersValue,
      exclude: this.exclude,
      filter: this.passes,
      owner: this,
      finish: (c) => this.mips(c),
    });
    if (drawn) {
      this.captureMatrix.set(this.camera.matrix);
      this.captured = true;
    }
    return drawn;
  }

  // World matrix of the node from its local transforms (fresh, not last frame's tick); false when hidden.
  private worldMatrix(node: Mesh): boolean {
    const runtime = engineRuntime(this.engine!),
      store = runtime.store,
      t = store.transforms,
      world = this.world;
    world.fill(0);
    world[0] = world[5] = world[10] = world[15] = 1;
    if (hiddenInTree(store, meshRuntime(node).id)) return false;
    for (let id = meshRuntime(node).id, depth = 0; id >= 0 && depth < 64; id = store.parents[id], depth++) {
      composeMatrix(
        [t.x[id], t.y[id], t.z[id]],
        [t.qx[id], t.qy[id], t.qz[id], t.qw[id]],
        [t.sx[id], t.sy[id], t.sz[id]],
        this.local,
      );
      multiplyMatrices(this.local, world, this.product);
      world.set(this.product);
    }
    const ax = [world[0], world[1], world[2]],
      ay = [world[4], world[5], world[6]];
    let nx = ax[1] * ay[2] - ax[2] * ay[1],
      ny = ax[2] * ay[0] - ax[0] * ay[2],
      nz = ax[0] * ay[1] - ax[1] * ay[0];
    // The node's +Z side is the front, also under a mirroring scale.
    const sign = Math.sign(nx * world[8] + ny * world[9] + nz * world[10]) || 1,
      length = Math.hypot(nx, ny, nz) * sign;
    if (!Number.isFinite(length) || !length) return false;
    nx /= length;
    ny /= length;
    nz /= length;
    this.normal[0] = nx;
    this.normal[1] = ny;
    this.normal[2] = nz;
    this.origin[0] = world[12];
    this.origin[1] = world[13];
    this.origin[2] = world[14];
    const w = this.widthValue / 2,
      h = this.heightValue / 2;
    for (let k = 0; k < 4; k++) {
      const x = k & 1 ? w : -w,
        y = k & 2 ? h : -h;
      for (let a = 0; a < 3; a++) this.corners[k * 3 + a] = world[a] * x + world[4 + a] * y + world[12 + a];
    }
    return true;
  }
  // Last frame's frustum planes of the main camera; all-zero planes (no frame yet) keep everything.
  private inView(main: Camera): boolean {
    const planes = main.planes;
    for (let p = 0; p < 6; p++) {
      let outside = 0;
      for (let k = 0; k < 4; k++) {
        const c = this.corners;
        if (
          planes[p * 4] * c[k * 3] +
            planes[p * 4 + 1] * c[k * 3 + 1] +
            planes[p * 4 + 2] * c[k * 3 + 2] +
            planes[p * 4 + 3] <
          0
        )
          outside++;
      }
      if (outside === 4) return false;
    }
    return true;
  }

  private draw(c: PlanarContext): void {
    const node = this.nodeValue,
      engine = this.engine;
    if (this.disposed || !node || !engine || activeCapture() === this) return;
    if (activeCapture() === null) this.time += c.delta;
    const color = this.target.color;
    if (!this.captured || !color || this.target.device !== c.device) return;
    const runtime = engineRuntime(engine),
      store = runtime.store;
    if (hiddenInTree(store, meshRuntime(node).id)) return;
    const m = meshRuntime(node).matrix,
      eye = c.camera.position,
      nx = m[1] * m[6] - m[2] * m[5],
      ny = m[2] * m[4] - m[0] * m[6],
      nz = m[0] * m[5] - m[1] * m[4],
      facing = Math.sign(nx * m[8] + ny * m[9] + nz * m[10]) || 1;
    if (!this.faces(facing * (nx * (eye[0] - m[12]) + ny * (eye[1] - m[13]) + nz * (eye[2] - m[14])))) return;
    const state = this.stateFor(c.device),
      samples = c.descriptor.multisample?.count ?? 1,
      depthFormat = c.descriptor.depthStencil?.format ?? 'depth32float',
      key = `${c.format}:${samples}:${depthFormat}`;
    let pipeline = state.pipelines.get(key);
    if (!pipeline) {
      const module = c.device.createShaderModule({ label: 'planar surface', code: SURFACE });
      pipeline = c.device.createRenderPipeline({
        label: 'planar surface',
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format }] },
        depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: 'greater-equal' },
        multisample: { count: samples },
      });
      state.pipelines.set(key, pipeline);
    }
    const blur = this.roughnessValue > 0 ? this.blur : undefined,
      image = blur?.view ?? this.view(color),
      normal = this.normalView(state);
    if (
      !state.group ||
      state.group.pipeline !== pipeline ||
      state.group.image !== image ||
      state.group.normal !== normal
    )
      state.group = {
        pipeline,
        image,
        normal,
        value: c.device.createBindGroup({
          label: 'planar surface',
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: state.uniform } },
            { binding: 1, resource: image },
            { binding: 2, resource: normal },
            { binding: 3, resource: state.clampSampler },
            { binding: 4, resource: state.repeatSampler },
          ],
        }),
      };
    const v = this.values;
    v.set(c.camera.matrix, 0);
    v.set(this.captureMatrix, 16);
    v.set(m, 32);
    v[48] = this.widthValue / 2;
    v[49] = this.heightValue / 2;
    v[50] = blur ? this.roughnessValue * (blur.levels.length - 1) : 0;
    v[51] = this.distortionValue;
    v.set(this.tint, 52);
    v[55] = 1;
    v[56] = this.normalRepeat[0];
    v[57] = this.normalRepeat[1];
    v[58] = (this.normalScroll[0] * this.time) % 1;
    v[59] = (this.normalScroll[1] * this.time) % 1;
    v[60] = this.normalSource ? 1 : 0;
    v[61] = c.format === 'rgba16float' ? 1 : 0;
    v[62] = v[63] = 0;
    c.device.queue.writeBuffer(state.uniform, 0, v);
    const stencil = depthFormat.includes('stencil');
    const pass = c.encoder.beginRenderPass({
      label: this.name,
      colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: {
        view: c.depth,
        depthLoadOp: 'load',
        depthStoreOp: 'store',
        ...(stencil ? { stencilLoadOp: 'load' as const, stencilStoreOp: 'store' as const } : {}),
      },
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, state.group.value);
    pass.draw(6);
    pass.end();
  }
  private views = new WeakMap<GPUTexture, GPUTextureView>();
  private view(texture: GPUTexture): GPUTextureView {
    let view = this.views.get(texture);
    if (!view) this.views.set(texture, (view = texture.createView()));
    return view;
  }
  private normalView(state: DeviceState): GPUTextureView {
    const source = this.normalSource;
    if (!source) return this.view(state.placeholder);
    if (state.normal?.source !== source) {
      if (state.normal?.owned) state.normal.texture.destroy();
      state.normal = undefined;
      if (isTexture(source)) state.normal = { source, texture: source, view: source.createView(), owned: false };
      else {
        const texture = state.device.createTexture({
          label: 'planar normal map',
          size: [source.width, source.height],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        state.device.queue.writeTexture(
          { texture },
          source.data as Uint8Array<ArrayBuffer>,
          { bytesPerRow: source.width * 4, rowsPerImage: source.height },
          [source.width, source.height],
        );
        state.normal = { source, texture, view: texture.createView(), owned: true };
      }
    }
    return state.normal.view;
  }
  private stateFor(device: GPUDevice): DeviceState {
    if (this.state?.device === device) return this.state;
    this.releaseState();
    const placeholder = device.createTexture({
      label: 'planar flat normal',
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: placeholder },
      new Uint8Array([128, 128, 255, 255]),
      { bytesPerRow: 4 },
      [1, 1],
    );
    this.state = {
      device,
      uniform: device.createBuffer({
        label: 'planar surface',
        size: 256,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      }),
      clampSampler: device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' }),
      repeatSampler: device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'repeat',
        addressModeV: 'repeat',
      }),
      placeholder,
      pipelines: new Map(),
    };
    return this.state;
  }
  // Roughness blur: a box-filtered mip chain of the capture, rebuilt inside the capture's frame graph.
  private mips(c: CapturePassContext): void {
    const color = this.target.color;
    if (this.roughnessValue <= 0 || !color) return;
    const device = c.device,
      state = this.stateFor(device),
      count = Math.min(8, Math.floor(Math.log2(Math.max(color.width, color.height))) + 1),
      key = `${color.width}x${color.height}`;
    let blur = this.blur;
    if (!blur || blur.key !== key) {
      blur?.texture.destroy();
      const texture = device.createTexture({
        label: 'planar blur',
        size: [color.width, color.height],
        mipLevelCount: count,
        format: 'rgba16float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      state.reduce ??= (() => {
        const module = device.createShaderModule({ label: 'planar blur', code: REDUCE });
        return device.createRenderPipeline({
          label: 'planar blur',
          layout: 'auto',
          vertex: { module, entryPoint: 'vertex' },
          fragment: { module, entryPoint: 'fragment', targets: [{ format: 'rgba16float' }] },
        });
      })();
      const levels = Array.from({ length: count }, (_, level) =>
        texture.createView({ baseMipLevel: level, mipLevelCount: 1 }),
      );
      blur = this.blur = {
        texture,
        view: texture.createView(),
        levels,
        groups: levels.slice(0, -1).map((view) =>
          device.createBindGroup({
            layout: state.reduce!.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: view },
              { binding: 1, resource: state.clampSampler },
            ],
          }),
        ),
        key,
      };
    }
    c.encoder.copyTextureToTexture({ texture: color }, { texture: blur.texture }, [color.width, color.height]);
    for (let level = 1; level < blur.levels.length; level++) {
      const pass = c.encoder.beginRenderPass({
        label: 'planar blur',
        colorAttachments: [{ view: blur.levels[level], loadOp: 'clear', storeOp: 'store' }],
      });
      pass.setPipeline(state.reduce!);
      pass.setBindGroup(0, blur.groups[level - 1]);
      pass.draw(3);
      pass.end();
    }
  }
  private release(): void {
    this.target.dispose();
    this.blur?.texture.destroy();
    this.blur = undefined;
    this.captured = false;
    this.releaseState();
  }
  private releaseState(): void {
    const state = this.state;
    this.state = undefined;
    if (!state) return;
    state.uniform.destroy();
    state.placeholder.destroy();
    if (state.normal?.owned) state.normal.texture.destroy();
  }
  /** Releases the GPU resources and the transform node and detaches from the engine. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopFrames?.();
    this.stopFrames = undefined;
    this.release();
    const engine = this.engine;
    this.engine = undefined;
    if (engine && !engine.disposed) {
      if (
        this.nodeValue &&
        engineRuntime(engine).meshes.get(meshRuntime(this.nodeValue).id) === meshRuntime(this.nodeValue)
      )
        this.nodeValue.dispose();
      if (engineRuntime(engine).plugins.get(this.name) === (this as unknown)) engine.removePlugin(this.name);
    }
    this.nodeValue = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
