/// <reference lib="esnext.disposable" preserve="true" />
import { SceneTarget, resolveMSAA, sceneTarget } from '../../shared/msaa.js';
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
  type Mesh,
} from '@margoengine/core/extension';
import { invertMatrixStable } from '@margoengine/math/mat4';
import { meshTriangles } from '../../shared/mesh-source.js';
import { halton, jitterProjection } from './jitter.js';
import { fullscreen, cameraVelocity, objectVelocity, snapshot, resolve, present } from './shader.js';
import { MargoError } from '@margoengine/math/errors';
import { applyView, fromTarget, toTarget, viewLoadOp, viewRect, viewSize, ViewStates } from '../../shared/view-rect.js';
export { halton, jitterProjection } from './jitter.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; COPY_SRC: number; STORAGE: number };
declare const GPUTextureUsage: {
  RENDER_ATTACHMENT: number;
  TEXTURE_BINDING: number;
  STORAGE_BINDING: number;
  COPY_SRC: number;
};
type Context = Extract<PassContext, { backend: 'webgpu' }>;
/** TAA settings, read every frame from `taa.options`; out of range throws RangeError before any GPU command. */
export interface TAAOptions {
  /** Share of the reprojected history in each frame, 0 <= w < 1 (0 disables accumulation). Default 0.9. */
  historyWeight?: number;
  /** Relative reversed-depth difference that rejects history, 0..1. Default 0.01. */
  depthThreshold?: number;
  /** Scene depth when another plugin replaces it, e.g. `() => dof.depthTexture`; sampleable and viewport-sized. */
  depth?: () => GPUTexture | undefined;
}
/** A drawable whose per-vertex motion TAA tracks: the `shadowPrimitives` contract of core and gltf-pro meshes. */
export interface VelocityPrimitive {
  /** The source primitive: keys TAA's per-draw record; static PBR sources keep their CPU `vertices` on it. */
  primitive?: object;
  /** The mesh whose world matrix (current and previous) moves the primitive. */
  node: Mesh;
  /** Current vertex buffer: 24-byte core or 80-byte PBR vertices (PBR: STORAGE or COPY_SRC usage, or CPU vertices). */
  vertex: GPUBuffer;
  /** Uint32 triangle indices. */
  index: GPUBuffer;
  /** Index count. */
  count: number;
  /** Vertex stride in bytes: 24 (core) or 80 (PBR). */
  stride: number;
  /** Base-colour texture for alpha masking (PBR). */
  alphaTexture?: GPUTextureView;
  /** Sampler of `alphaTexture`. */
  alphaSampler?: GPUSampler;
  /** Base-colour alpha factor. */
  alpha?: number;
  /** Alpha-mask cutoff, 0..1. Default 0 (nothing masked). */
  cutoff?: number;
  /** UV set of `alphaTexture`, 0 or 1. */
  texCoord?: number;
  /** UV transform of `alphaTexture` (PBR only): 8 finite floats, rows (a, b, offset, unused) for u and then v. */
  alphaTransform?: Float32Array;
  /** Instanced (gltf-pro PBRInstances) primitives get no object motion: camera reprojection covers static instances. */
  instances?: unknown;
}
/** TAA's motion vectors and resolved frame ({@link TAA.velocity}), for effects such as `MotionBlur` (@margoengine/post). */
export interface TAAVelocity {
  /** `rg16float`: current minus previous position per pixel, in uv (0..1 across the viewport), written at frame-graph
   * order 9. Both frames' projections carry TAA's Halton jitter, so every vector also holds the jitter difference
   * `jitter`; subtract it for the scene's own motion. Replaced on resize and device restoration. */
  readonly texture: GPUTexture;
  /** This frame's jitter offset minus the previous frame's, in uv (x, y): the part of each vector that is not motion.
   * Zero on a frame without history (first frame, reset, resize). Updated in place every frame. */
  readonly jitter: Float32Array;
  /** The resolved frame TAA presented last (linear `rgba16float`, the frame graph's order 40); after order 40 it is this
   * frame's. History reads it next frame, so an effect that changes the picture after TAA writes elsewhere. */
  readonly resolved: GPUTexture;
}
/** What `taa.add` takes: a model exposing its primitives (a gltf-pro `PBRModel`); dropped once `disposed` is true. */
export interface VelocitySource {
  /** Primitives read every frame (after skinning and morphing). */
  readonly shadowPrimitives: readonly VelocityPrimitive[];
  /** True once the source is disposed; TAA then forgets it. */
  readonly disposed?: boolean;
}
interface Draw {
  uniform: GPUBuffer;
  values: Float32Array;
  previous: Float32Array;
  vertices?: GPUBuffer;
  source?: GPUBuffer;
  snapshot?: GPUBindGroup;
  group: GPUBindGroup;
  pipeline: GPURenderPipeline;
  vertex: GPUBuffer;
  alpha?: GPUTextureView;
  sampler?: GPUSampler;
  frame: number;
}
/**
 * Temporal anti-aliasing: Halton (2,3) sub-pixel jitter, a velocity buffer (core meshes automatic, gltf-pro models via
 * `taa.add`), depth-tested history reprojection with YCoCg neighbourhood clamping; resolves at frame-graph order 40.
 * `TAA.attach(engine, options)`; call `reset()` after a camera cut. WebGPU only.
 * @throws RangeError when an option is out of range; TypeError for an invalid velocity source or primitive (wrong
 * engine or stride, bad alpha transform, missing PBR alpha bindings or buffer usage).
 * @throws MargoError `'unsupported'` on a WebGL engine, `'disposed'` after `dispose()`, `'attached'` for a source of
 * another engine or one added twice, `'state'` when the camera is not invertible, the scene depth it needs is missing
 * or not sampleable, or `gpuState` is read before a frame.
 */
export class TAA implements EnginePlugin {
  readonly name = 'taa';
  private engine?: Engine;
  private device?: GPUDevice;
  private uniform?: GPUBuffer;
  private cameraPipeline?: GPURenderPipeline;
  private snapshotPipeline?: GPUComputePipeline;
  private resolvePipeline?: GPUComputePipeline;
  private presentPipeline?: GPURenderPipeline;
  private cameraBinding?: GPUBindGroupEntry;
  private captureTarget?: SceneTarget;
  private textures: GPUTexture[] = [];
  private scene?: GPUTexture;
  private depth?: GPUTexture;
  private velocityTarget?: GPUTexture;
  private expected?: GPUTexture;
  private histories: GPUTexture[] = [];
  private historyDepths: GPUTexture[] = [];
  // Each engine view keeps its whole temporal state (captures, history, jitter, object snapshots) in a TAA of its own,
  // released when the view is not drawn for a frame.
  private readonly views = new ViewStates<TAA>(
    () => {
      const view = new TAA(this.options);
      view.sources = this.sources;
      try {
        view.setup(this.engine!);
      } catch (error) {
        view.release();
        throw error;
      }
      return view;
    },
    (view) => view.release(),
  );
  private activeView?: TAA;
  private captureReady = false;
  private colorView?: GPUTextureView;
  private depthView?: GPUTextureView;
  private sampledDepth?: GPUTextureView;
  private velocityView?: GPUTextureView;
  private expectedView?: GPUTextureView;
  private original?: GPUTextureView;
  private cameraGroup?: GPUBindGroup;
  private resolveGroups: GPUBindGroup[] = [];
  private presentGroups: GPUBindGroup[] = [];
  private depthSource?: GPUTexture;
  private motionViews: GPUTextureView[] = [];
  private motionResolve?: GPURenderPipeline;
  private motionGroup?: GPUBindGroup;
  private motionDepth?: GPUTextureView;
  private objectPipelines = new Map<string, GPURenderPipeline>();
  private draws = new Map<Mesh, Map<object, Draw>>();
  private sources = new Set<VelocitySource>();
  private readonly values = new Float32Array(52);
  private readonly jittered = new Float32Array(16);
  private readonly previous = new Float32Array(16);
  private readonly workspace = new Float64Array(52);
  // Halton offsets in uv of this frame and of the last resolved one; `vectors.jitter` is their difference.
  private readonly offset = new Float32Array(2);
  private readonly lastOffset = new Float32Array(2);
  private readonly vectors: { texture: GPUTexture; jitter: Float32Array; resolved: GPUTexture } = {
    texture: undefined!,
    jitter: new Float32Array(2),
    resolved: undefined!,
  };
  private originalCamera?: Context['camera'];
  private cameraView?: Context['camera'];
  private frame = 0;
  private front = 0;
  private valid = false;
  private disposed = false;
  private projection = '';
  private format?: GPUTextureFormat;
  constructor(readonly options: TAAOptions = {}) {
    this.validate();
  }
  static attach(instance: EngineKernel, options: TAAOptions = {}): TAA {
    const effect = new TAA(options);
    engineRuntime(instance).use(effect);
    return effect;
  }
  private validate(): void {
    const o = this.options;
    if (
      !Number.isFinite(o.historyWeight ?? 0.9) ||
      (o.historyWeight ?? 0.9) < 0 ||
      (o.historyWeight ?? 0.9) >= 1 ||
      !Number.isFinite(o.depthThreshold ?? 0.01) ||
      (o.depthThreshold ?? 0.01) < 0 ||
      (o.depthThreshold ?? 0.01) > 1 ||
      (o.depth !== undefined && typeof o.depth !== 'function')
    )
      throw new RangeError('Invalid TAA options');
  }
  add(source: VelocitySource): () => void {
    if (this.disposed || !source || source.disposed || !Array.isArray(source.shadowPrimitives))
      throw new TypeError('Invalid TAA velocity source');
    if (source.shadowPrimitives.some((p) => p.node.engine !== this.engine))
      throw new MargoError('attached', 'TAA source belongs to another engine; use objects created by the same engine');
    if (this.sources.has(source)) throw new MargoError('attached', 'Duplicate TAA source; add each source once');
    this.sources.add(source);
    this.reset();
    return () => {
      this.sources.delete(source);
      this.reset();
    };
  }
  reset(): void {
    this.valid = false;
    for (const view of this.views.values()) view.reset();
  }
  private forView(c: Context): TAA {
    return (this.activeView = c.view && this.views.get(c)) ?? this;
  }
  onPreUpdate(delta: number): void {
    if (delta > 0) this.views.prune();
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'TAA requires WebGPU and a live effect; attach a new TAA to a WebGPU engine',
      );
    this.engine = engine;
    this.device = engine.gpu;
    this.uniform = this.device.createBuffer({ size: 208, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // Renderers cache bind groups by resource identity; only restoration replaces this buffer.
    this.cameraBinding = { binding: 18, resource: { buffer: this.uniform, size: 64 } };
    const compute = (code: string) =>
      this.device!.createComputePipeline({
        layout: 'auto',
        compute: { module: this.device!.createShaderModule({ code }), entryPoint: 'main' },
      });
    this.snapshotPipeline = compute(snapshot);
    this.reset();
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: 'taa:capture',
      order: -70,
      execute: (c) => {
        if (c.backend === 'webgpu') this.forView(c).capture(c);
      },
    });
    graph.add({
      name: 'taa:velocity',
      order: 9,
      execute: (c) => {
        if (c.backend === 'webgpu') {
          const view = this.forView(c);
          try {
            view.motion(c);
          } catch (error) {
            view.restoreCamera(c);
            view.reset();
            throw error;
          }
        }
      },
    });
    graph.add({
      name: 'taa:resolve',
      order: 40,
      execute: (c) => {
        if (c.backend === 'webgpu') this.forView(c).finish(c);
      },
    });
  }
  private capture(c: Context): void {
    this.validate();
    this.resize(c);
    this.original = c.color;
    this.captureTarget!.begin(c);
    const camera = c.camera === this.cameraView ? this.originalCamera! : c.camera;
    if (this.originalCamera !== camera || !this.cameraView)
      this.cameraView = Object.assign(Object.create(camera), { matrix: this.jittered });
    this.originalCamera = camera;
    try {
      const [width, height] = viewSize(c);
      jitterProjection(this.jittered, camera.matrix, this.frame, width, height);
      c.camera = this.cameraView!;
      // jitterProjection's NDC offset in uv; the velocity passes see it in both matrices only with history.
      this.offset[0] = (halton((this.frame % 8) + 1, 2) - 0.5) / c.width;
      this.offset[1] = (halton((this.frame % 8) + 1, 3) - 0.5) / c.height;
      const projection = [c.camera.fov, c.camera.near, c.camera.far, ...(viewRect(c) ?? [])].join(':');
      if (projection !== this.projection) {
        this.reset();
        this.projection = projection;
      }
      this.values.set(c.camera.matrix);
      this.values.set(this.valid ? this.previous : c.camera.matrix, 16);
      if (!invertMatrixStable(c.camera.matrix, this.values.subarray(32, 48), this.workspace))
        throw new MargoError('state', 'Invalid TAA camera; give the camera a finite, invertible projection');
      toTarget(c, this.values, 16);
      fromTarget(c, this.values, 32);
      this.values.set([this.options.historyWeight ?? 0.9, this.options.depthThreshold ?? 0.01, +this.valid, 0], 48);
      const jitter = this.vectors.jitter;
      jitter[0] = this.valid ? this.offset[0] - this.lastOffset[0] : 0;
      jitter[1] = this.valid ? this.offset[1] - this.lastOffset[1] : 0;
      c.device.queue.writeBuffer(this.uniform!, 0, this.values as Float32Array<ArrayBuffer>);
      // Core uploads its frame before extension passes; use the jittered matrix through an existing shader binding.
      c.shader =
        '@group(0) @binding(18) var<uniform> taaCamera:mat4x4f;\n' +
        c.shader.replace('o.clip=frame.camera*p', 'o.clip=taaCamera*p');
      c.bindings.push(this.cameraBinding!);
    } catch (error) {
      this.restoreCamera(c);
      this.reset();
      throw error;
    }
  }
  private restoreCamera(c: Context): void {
    if (c.camera === this.cameraView) c.camera = this.originalCamera!;
  }
  private resize(c: Context): void {
    if (
      this.captureReady &&
      this.scene?.width === c.width &&
      this.scene.height === c.height &&
      this.format === c.format &&
      this.depth?.format === c.descriptor.depthStencil!.format &&
      this.captureTarget?.samples === (c.descriptor.multisample?.count ?? 4)
    )
      return;
    this.captureReady = false;
    this.captureTarget?.dispose();
    for (const t of this.textures) t.destroy();
    this.textures = [];
    this.histories = [];
    this.historyDepths = [];
    this.format = c.format;
    // Unorm canvas shaders write sRGB themselves; sRGB attachments and floating-point HDR targets supply linear samples.
    const manualSRGB = +(c.format === 'rgba8unorm' || c.format === 'bgra8unorm');
    this.resolvePipeline = c.device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: c.device.createShaderModule({ code: resolve }),
        entryPoint: 'main',
        constants: { manualSRGB },
      },
    });
    const texture = (format: GPUTextureFormat, usage: number) => {
      const t = c.device.createTexture({
        size: [c.width, c.height],
        format,
        usage: usage | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
      });
      this.textures.push(t);
      return t;
    };
    this.scene = texture(c.format, GPUTextureUsage.RENDER_ATTACHMENT);
    this.depth = texture(c.descriptor.depthStencil!.format, GPUTextureUsage.RENDER_ATTACHMENT);
    this.velocityTarget = texture('rg16float', GPUTextureUsage.RENDER_ATTACHMENT);
    this.expected = texture('r32float', GPUTextureUsage.RENDER_ATTACHMENT);
    for (let i = 0; i < 2; i++) {
      this.histories.push(texture('rgba16float', GPUTextureUsage.STORAGE_BINDING));
      this.historyDepths.push(texture('r32float', GPUTextureUsage.STORAGE_BINDING));
    }
    this.captureTarget = new SceneTarget(c.device, this.scene, this.depth, c.descriptor.multisample?.count ?? 4);
    this.colorView = this.scene.createView();
    this.depthView = this.depth.createView();
    this.velocityView = this.velocityTarget.createView();
    this.expectedView = this.expected.createView();
    this.motionViews = [];
    this.motionResolve = undefined;
    this.motionGroup = undefined;
    this.motionDepth = undefined;
    const cameraModule = c.device.createShaderModule({ code: cameraVelocity });
    this.cameraPipeline = c.device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: cameraModule, entryPoint: 'vertex' },
      fragment: {
        module: cameraModule,
        entryPoint: 'fragment',
        targets: [{ format: 'rg16float' }, { format: 'r32float' }],
      },
      multisample: c.descriptor.multisample,
    });
    if (this.captureTarget.samples === 4) {
      for (const format of ['rg16float', 'r32float'] as GPUTextureFormat[]) {
        const t = c.device.createTexture({
          size: [c.width, c.height],
          format,
          sampleCount: 4,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.textures.push(t);
        this.motionViews.push(t.createView());
      }
      const module = c.device.createShaderModule({
        code:
          fullscreen +
          `
@group(0) @binding(0) var velocity:texture_multisampled_2d<f32>;
@group(0) @binding(1) var expected:texture_multisampled_2d<f32>;
@group(0) @binding(2) var depth:texture_depth_multisampled_2d;
struct Motion {@location(0) velocity:vec2f,@location(1) depth:f32}
@fragment fn fragment(i:Fullscreen)->Motion {let p=vec2i(i.clip.xy);var sample=0;var nearest=textureLoad(depth,p,0);
 for(var n=1;n<4;n++){let d=textureLoad(depth,p,n);if(d>nearest){nearest=d;sample=n;}}
 var o:Motion;o.velocity=textureLoad(velocity,p,sample).xy;o.depth=textureLoad(expected,p,sample).r;return o;}`,
      });
      this.motionResolve = c.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: 'rg16float' }, { format: 'r32float' }] },
      });
    }
    const module = c.device.createShaderModule({ code: present });
    this.presentPipeline = c.device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vertex' },
      fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format }], constants: { manualSRGB } },
      multisample: c.descriptor.multisample,
    });
    this.presentGroups = this.histories.map((t) =>
      c.device.createBindGroup({
        layout: this.presentPipeline!.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: t.createView() }],
      }),
    );
    this.depthSource = undefined;
    this.reset();
    this.captureReady = true;
  }
  private motion(c: Context): void {
    resolveMSAA(c);
    const depth = c.depth === this.captureTarget!.depth ? this.depth : this.options.depth?.();
    if (
      !depth ||
      depth.width !== c.width ||
      depth.height !== c.height ||
      !(depth.usage & GPUTextureUsage.TEXTURE_BINDING) ||
      !depth.format.startsWith('depth')
    )
      throw new MargoError(
        'state',
        'TAA needs the current sampleable scene depth; provide options.depth for an HDR/SSAO capture',
      );
    if (depth !== this.depthSource) {
      this.sampledDepth = depth.createView({ aspect: 'depth-only' });
      const group = (p: GPUComputePipeline | GPURenderPipeline, resources: (GPUTextureView | GPUBufferBinding)[]) =>
        c.device.createBindGroup({
          layout: p.getBindGroupLayout(0),
          entries: resources.map((resource, binding) => ({ binding, resource })),
        });
      this.cameraGroup = group(this.cameraPipeline!, [{ buffer: this.uniform! }, this.sampledDepth]);
      this.resolveGroups = [0, 1].map((i) =>
        group(this.resolvePipeline!, [
          { buffer: this.uniform! },
          this.colorView!,
          this.velocityView!,
          this.expectedView!,
          this.sampledDepth!,
          this.histories[i].createView(),
          this.historyDepths[i].createView(),
          this.histories[1 - i].createView(),
          this.historyDepths[1 - i].createView(),
        ]),
      );
      this.depthSource = depth;
    }
    const views = this.motionViews.length ? this.motionViews : [this.velocityView!, this.expectedView!];
    const attachments = views.map((view) => ({ view, loadOp: 'clear' as const, storeOp: 'store' as const }));
    const camera = c.encoder.beginRenderPass({ colorAttachments: attachments });
    applyView(camera, c);
    camera.setPipeline(this.cameraPipeline!);
    camera.setBindGroup(0, this.cameraGroup!);
    camera.draw(3);
    camera.end();
    const submitted = new Map<Mesh, Set<object>>(),
      draw = (primitive: VelocityPrimitive) => {
        const key = primitive.primitive ?? primitive.index;
        let indices = submitted.get(primitive.node);
        if (indices?.has(key)) return;
        if (!indices) {
          indices = new Set();
          submitted.set(primitive.node, indices);
        }
        indices.add(key);
        this.drawMotion(c, primitive);
      };
    for (const mesh of this.engine!.meshes.values()) {
      const triangles = meshTriangles(mesh);
      if (triangles?.kind === 'core' && this.engine!.store.visible[mesh.id]) {
        const buffers = this.engine!.geometryBuffers(triangles.geometry)!;
        draw({ node: mesh, ...buffers, count: triangles.geometry.indices.length, stride: 24 });
      } else if (triangles?.kind === 'pbr') for (const primitive of triangles.source.shadowPrimitives) draw(primitive);
    }
    for (const source of this.sources) {
      if (source.disposed) {
        this.sources.delete(source);
        continue;
      }
      for (const primitive of source.shadowPrimitives) draw(primitive);
    }
    if (this.motionViews.length) {
      const depth = sceneTarget(c)!.depthSource!;
      if (this.motionDepth !== depth) {
        this.motionGroup = c.device.createBindGroup({
          layout: this.motionResolve!.getBindGroupLayout(0),
          entries: [...this.motionViews, depth].map((resource, binding) => ({ binding, resource })),
        });
        this.motionDepth = depth;
      }
      const pass = c.encoder.beginRenderPass({
        colorAttachments: [this.velocityView!, this.expectedView!].map((view) => ({
          view,
          loadOp: 'clear',
          storeOp: 'store',
        })),
      });
      pass.setPipeline(this.motionResolve!);
      pass.setBindGroup(0, this.motionGroup!);
      pass.draw(3);
      pass.end();
    }
    for (const [mesh, records] of this.draws)
      for (const [index, r] of records)
        if (r.frame !== this.frame) {
          r.uniform.destroy();
          r.vertices?.destroy();
          r.source?.destroy();
          records.delete(index);
          if (!records.size) this.draws.delete(mesh);
        }
  }
  private drawMotion(c: Context, p: VelocityPrimitive): void {
    // Per-instance previous transforms are unavailable; retain camera reprojection for these casters.
    if (p.instances) return;
    p.node.check();
    if (p.node.engine !== this.engine || ![24, 80].includes(p.stride))
      throw new TypeError('Invalid TAA velocity primitive; use a mesh of this engine with stride 24 or 80');
    for (let id = p.node.id; id !== -1; id = this.engine!.store.parents[id]) if (this.engine!.store.hidden[id]) return;
    const transform = p.alphaTransform;
    if (
      transform &&
      (!(transform instanceof Float32Array) ||
        transform.length !== 8 ||
        transform.some((value) => !Number.isFinite(value)) ||
        p.stride !== 80)
    )
      throw new TypeError('Invalid TAA alpha transform');
    const pbr = p.stride === 80,
      key =
        p.stride + ':' + !!transform + ':' + c.descriptor.depthStencil!.format + ':' + c.descriptor.multisample?.count;
    let pipeline = this.objectPipelines.get(key);
    if (!pipeline) {
      const module = c.device.createShaderModule({ code: objectVelocity(pbr, !!transform) });
      pipeline = c.device.createRenderPipeline({
        layout: 'auto',
        vertex: {
          module,
          entryPoint: 'vertex',
          buffers: [
            {
              arrayStride: p.stride,
              attributes: pbr
                ? [
                    { shaderLocation: 0, offset: 0, format: 'float32x4' },
                    { shaderLocation: 1, offset: 48, format: 'float32x4' },
                    { shaderLocation: 2, offset: 64, format: 'float32x4' },
                  ]
                : [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
            },
          ],
        },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: 'rg16float' }, { format: 'r32float' }] },
        primitive: { cullMode: 'none' },
        depthStencil: { format: c.descriptor.depthStencil!.format, depthWriteEnabled: false, depthCompare: 'equal' },
        multisample: c.descriptor.multisample,
      });
      this.objectPipelines.set(key, pipeline);
    }
    const identity = p.primitive ?? p.index;
    let records = this.draws.get(p.node);
    if (!records) {
      records = new Map();
      this.draws.set(p.node, records);
    }
    let r = records.get(identity);
    if (
      !r ||
      !r.group ||
      r.pipeline !== pipeline ||
      r.vertex !== p.vertex ||
      r.alpha !== p.alphaTexture ||
      r.sampler !== p.alphaSampler
    ) {
      r?.uniform.destroy();
      r?.vertices?.destroy();
      r?.source?.destroy();
      const uniform = c.device.createBuffer({
        size: transform ? 320 : 288,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      r = {
        uniform,
        values: new Float32Array(transform ? 80 : 72),
        previous: p.node.matrix.slice(),
        group: undefined!,
        pipeline,
        vertex: p.vertex,
        alpha: p.alphaTexture,
        sampler: p.alphaSampler,
        frame: -2,
      };
      records.set(identity, r);
      if (pbr) {
        if (!p.alphaTexture || !p.alphaSampler || p.vertex.size > c.device.limits.maxStorageBufferBindingSize)
          throw new TypeError('TAA PBR source needs alpha bindings and a storage-sized vertex buffer');
        let source = p.vertex;
        if (p.vertex.usage !== undefined && !(p.vertex.usage & GPUBufferUsage.STORAGE)) {
          const primitive = p.primitive as { vertices?: Float32Array; deformed?: GPUBuffer } | undefined,
            vertices = primitive?.vertices;
          if (
            !(p.vertex.usage & GPUBufferUsage.COPY_SRC) &&
            (primitive?.deformed === p.vertex ||
              !(vertices instanceof Float32Array) ||
              vertices.byteLength !== p.vertex.size)
          )
            throw new TypeError(
              'TAA deformed sources require STORAGE or COPY_SRC; static PBR sources need retained CPU vertices',
            );
          r.source = c.device.createBuffer({
            size: p.vertex.size,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
          });
          if (!(p.vertex.usage & GPUBufferUsage.COPY_SRC))
            c.device.queue.writeBuffer(r.source, 0, vertices as Float32Array<ArrayBuffer>);
          source = r.source;
        }
        r.vertices = c.device.createBuffer({ size: p.vertex.size, usage: GPUBufferUsage.STORAGE });
        r.snapshot = c.device.createBindGroup({
          layout: this.snapshotPipeline!.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: source } },
            { binding: 1, resource: { buffer: r.vertices } },
          ],
        });
      }
      r.group = c.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          ...(pbr
            ? [
                { binding: 1, resource: { buffer: r.vertices! } },
                { binding: 2, resource: p.alphaTexture! },
                { binding: 3, resource: p.alphaSampler! },
              ]
            : []),
        ],
      });
    }
    r.values.set(c.camera.matrix);
    r.values.set(this.valid ? this.previous : c.camera.matrix, 16);
    toTarget(c, r.values, 16);
    r.values.set(p.node.matrix, 32);
    r.values.set(r.previous, 48);
    r.values.set(
      [
        c.width,
        c.height,
        +(this.valid && r.frame === this.frame - 1),
        0,
        p.alpha ?? 1,
        p.cutoff ?? 0,
        p.texCoord ?? 0,
        0,
      ],
      64,
    );
    if (transform) r.values.set(transform, 72);
    c.device.queue.writeBuffer(r.uniform, 0, r.values as Float32Array<ArrayBuffer>);
    if (r.source && p.vertex.usage & GPUBufferUsage.COPY_SRC)
      c.encoder.copyBufferToBuffer(p.vertex, 0, r.source, 0, p.vertex.size);
    const pass = c.encoder.beginRenderPass({
      colorAttachments: (this.motionViews.length ? this.motionViews : [this.velocityView!, this.expectedView!]).map(
        (view) => ({ view, loadOp: 'load', storeOp: 'store' }),
      ),
      depthStencilAttachment: {
        view: c.depth,
        depthReadOnly: true,
        ...(c.descriptor.depthStencil!.format.includes('stencil') ? { stencilReadOnly: true } : {}),
      },
    });
    applyView(pass, c);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, r.group);
    pass.setVertexBuffer(0, p.vertex);
    pass.setIndexBuffer(p.index, 'uint32');
    pass.drawIndexed(p.count);
    pass.end();
    r.previous.set(p.node.matrix);
    r.frame = this.frame;
    if (r.snapshot) {
      const copy = c.encoder.beginComputePass();
      copy.setPipeline(this.snapshotPipeline!);
      copy.setBindGroup(0, r.snapshot);
      copy.dispatchWorkgroups(Math.ceil(p.vertex.size / 16 / 256));
      copy.end();
    }
  }
  private finish(c: Context): void {
    try {
      this.captureTarget!.resolve(c.encoder, true);
      const compute = c.encoder.beginComputePass();
      compute.setPipeline(this.resolvePipeline!);
      compute.setBindGroup(0, this.resolveGroups[this.front]);
      compute.dispatchWorkgroups(Math.ceil(c.width / 8), Math.ceil(c.height / 8));
      compute.end();
      const next = 1 - this.front;
      const pass = c.encoder.beginRenderPass({
        colorAttachments: [{ view: this.original!, loadOp: viewLoadOp(c, 'clear'), storeOp: 'store' }],
      });
      applyView(pass, c);
      pass.setPipeline(this.presentPipeline!);
      pass.setBindGroup(0, this.presentGroups[next]);
      pass.draw(3);
      pass.end();
      this.front = next;
      this.previous.set(c.camera.matrix);
      this.lastOffset.set(this.offset);
      this.valid = true;
      this.frame++;
      this.captureTarget!.restore(c);
    } catch (error) {
      this.reset();
      throw error;
    } finally {
      this.restoreCamera(c);
    }
  }
  /** The velocity texture with its jitter offset and the resolved frame ({@link TAAVelocity}); undefined before the
   * first resolved frame and after disposal. One object, updated in place. */
  get velocity(): TAAVelocity | undefined {
    if (this.activeView) return this.activeView.velocity;
    if (!this.velocityTarget || !this.histories.length || !this.frame) return undefined;
    this.vectors.texture = this.velocityTarget;
    this.vectors.resolved = this.histories[this.front];
    return this.vectors;
  }
  get gpuState(): { velocity: GPUTexture; history: GPUTexture; depth: GPUTexture } {
    if (this.activeView) return this.activeView.gpuState;
    if (!this.velocityTarget || !this.histories.length)
      throw new MargoError('state', 'TAA is not rendered; render a frame first');
    return {
      velocity: this.velocityTarget,
      history: this.histories[this.front],
      depth: this.historyDepths[this.front],
    };
  }
  private release(): void {
    this.views.clear();
    this.activeView = undefined;
    this.captureReady = false;
    this.motionViews = [];
    this.motionResolve = undefined;
    this.motionGroup = undefined;
    this.motionDepth = undefined;
    this.captureTarget?.dispose();
    this.captureTarget = undefined;
    for (const t of this.textures) t.destroy();
    for (const records of this.draws.values())
      for (const r of records.values()) {
        r.uniform.destroy();
        r.vertices?.destroy();
        r.source?.destroy();
      }
    this.uniform?.destroy();
    this.textures = [];
    this.histories = [];
    this.historyDepths = [];
    this.draws.clear();
    this.objectPipelines.clear();
    this.scene = this.depth = this.velocityTarget = this.expected = undefined;
    this.uniform = undefined;
    this.cameraBinding = undefined;
    this.depthSource = undefined;
    this.cameraPipeline = this.presentPipeline = undefined;
    this.snapshotPipeline = this.resolvePipeline = undefined;
    this.cameraGroup = undefined;
    this.resolveGroups = [];
    this.presentGroups = [];
    this.colorView =
      this.depthView =
      this.sampledDepth =
      this.velocityView =
      this.expectedView =
      this.original =
        undefined;
    this.originalCamera = this.cameraView = undefined;
    this.format = undefined;
    this.frame = this.front = 0;
    this.reset();
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.removePlugin(this.name);
    this.release();
    this.sources.clear();
    this.engine = this.device = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  destroy(): void {
    this.dispose();
  }
}
