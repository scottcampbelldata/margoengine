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
import { render, group, compute } from '../../shared/gpu.js';
import { orthographic } from '../../shared/projection.js';
import { OutputKey } from '../../shared/output-key.js';
import type { StackHost, StackStage, StageOutput } from '../../shared/stack.js';
import {
  cocShader,
  coarseShader,
  bokehShader,
  presentShader,
  groupMax,
  halveShader,
  joinShader,
  halfShaders,
  nearShader,
  nearDownShader,
  NEAR_LEVELS,
} from './shaders.js';
import { alphaShaders, type DOFAlphaShaders } from './alpha.js';
import { displayFor, premultipliedCanvas } from '../../shared/straight-display.js';
import { MargoError } from '@margoengine/math/errors';
import { applyView, viewLoadOp, viewSize } from '../../shared/view-rect.js';
import { coreShaderRequired, linearShader } from '../../shared/display.js';
import { loadCompatRoute, requireCompatTier, routeSettled } from '../../shared/compat.js';
import type { DOFLens, DOFLensShaders } from './lens.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: {
  RENDER_ATTACHMENT: number;
  TEXTURE_BINDING: number;
  STORAGE_BINDING: number;
  COPY_SRC: number;
};
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** The views among `views` that exist: the premultiplied kernels' extra bindings, none on an opaque canvas. */
const bound = (...views: (GPUTextureView | undefined)[]): GPUTextureView[] => views.filter((v) => v !== undefined);

/** Lens settings, read from `dof.options` every frame. */
export interface DOFOptions {
  /** Scene units, measured along the camera's viewing axis. Default 5. */
  focalDistance?: number;
  /** Same units as focalDistance; default 0.05 for a metre-based scene. Not used while `filmGauge` is set. */
  focalLength?: number;
  /**
   * Film or sensor size in millimetres along the side `sensorFit` names: 36 for full frame, 23.6 for APS-C, 17.3 for
   * Micro Four Thirds. When set, the focal length follows the camera's field of view every frame, as a real lens on
   * that sensor would have it, in metres; a zoom (a narrower `camera.fov`) lengthens it and deepens the blur. Default:
   * unset, `focalLength` is used.
   */
  filmGauge?: number;
  /** The side `filmGauge` spans: `'auto'` the longer side of the view, `'horizontal'` or `'vertical'`. Default `'auto'`. */
  sensorFit?: 'auto' | 'horizontal' | 'vertical';
  /** Lens f-number, default 2.8. */
  aperture?: number;
  /** Maximum disk radius in pixels, 1-32. Default 16. */
  maxRadius?: number;
  /** False skips the blur and presents the scene sharp. Default true; also settable as `dof.enabled`. */
  enabled?: boolean;
  /** Tilt-shift and polygon bokeh, from `@margoengine/dof/lens`. Read when the effect attaches. Default: none. */
  lens?: DOFLens;
  /**
   * Temporal DOF: the bokeh is gathered at half resolution, a quarter of the pixels, and its taps turn by the golden
   * angle every frame, so TAA attached after DOF averages the turns in its history into smooth bokeh. In-focus pixels
   * stay at full resolution. Native WebGPU and the full WebGL2 compatibility layer. Read when the effect attaches.
   * Default false.
   */
  temporal?: boolean;
}

/**
 * Depth of field: thin-lens circle of confusion from reversed-Z depth, near and far bokeh gathered separately; reads
 * `dof.options` each frame. `DOF.attach(engine, options)` alone, or inside a `PostStack` to combine it with SSAO,
 * Bloom, Tonemap or FXAA. Requires native WebGPU or at least the half-float WebGL2 compatibility tier.
 * @throws RangeError when an option is out of range or the lens scale overflows float32; TypeError when `enabled` is
 * not a boolean.
 * @throws MargoError `'unsupported'` on a WebGL engine or when another plugin replaced core's lighting shader,
 * `'disposed'` after `dispose()`, `'attached'` when attached twice, `'state'` when SSAO, Bloom or PostProcessing owns
 * the scene capture.
 */
export class DOF implements EnginePlugin {
  readonly name = 'dof';
  private engine?: Engine;
  private uniform?: GPUBuffer;
  private cocPipeline?: GPUComputePipeline;
  private bokehPipeline?: GPUComputePipeline;
  private coarsePipeline?: GPUComputePipeline;
  // The near gather's tap source: a mip chain (level 0 by nearShader, each level above by nearDownShader), its
  // trilinear sampler, the whole chain's views (read by the gather), level 0's views and the bind groups that build
  // levels 1 and up.
  private nearPipeline?: GPUComputePipeline;
  private nearDownPipeline?: GPUComputePipeline;
  private nearSampler?: GPUSampler;
  private nearTaps?: GPUTexture;
  private nearShapes?: GPUTexture;
  private nearScene?: GPUTexture;
  private nearViews: GPUTextureView[] = [];
  private nearBase: GPUTextureView[] = [];
  private nearLevels: GPUBindGroup[] = [];
  // The WebGL2 layer's route (./compat.js): the CoC kernel without tile maxima, which this pass computes instead.
  private tilesPipeline?: GPUComputePipeline;
  private tilesGroup?: GPUBindGroup;
  private waiting = false;
  private routeReady: Promise<void> = Promise.resolve();
  private presentPipeline?: GPURenderPipeline;
  private scene?: GPUTexture;
  private depth?: GPUTexture;
  private coc?: GPUTexture;
  private tiles?: GPUTexture;
  private coarse?: GPUTexture;
  private output?: GPUTexture;
  private sceneView?: GPUTextureView;
  private depthView?: GPUTextureView;
  private groups: GPUBindGroup[] = [];
  private originalColor?: GPUTextureView;
  private originalDepth?: GPUTextureView;
  private format?: GPUTextureFormat;
  private depthFormat?: GPUTextureFormat;
  private readonly values = new Float32Array(12);
  // Temporal: the half-resolution gather's own uniform (maxRadius halved, the frame's turn) and textures.
  private readonly halfValues = new Float32Array(12);
  private halfUniform?: GPUBuffer;
  private halvePipeline?: GPUComputePipeline;
  private joinPipeline?: GPUComputePipeline;
  private halfScene?: GPUTexture;
  private halfCoc?: GPUTexture;
  private halfTiles?: GPUTexture;
  private blurred?: GPUTexture;
  private turn = 0;
  // The kernels the pipelines are built from, for a premultiplied canvas with alpha (./alpha.ts), whose extra planes
  // are the 2x2 block gathers' alpha and, at half resolution, the blurred image's.
  private alpha = false;
  private kernels?: DOFLensShaders & DOFAlphaShaders;
  private compatPipelines?: typeof import('./compat.js').dofCompatPipelines;
  private coarseAlpha?: GPUTexture;
  private blurredAlpha?: GPUTexture;
  private coarseAlphaView?: GPUTextureView;
  private blurredAlphaView?: GPUTextureView;
  private readonly shaders = new Map<string, string>();
  private readonly attachment: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'clear', storeOp: 'store' };
  private readonly presentation: GPURenderPassDescriptor = { colorAttachments: [this.attachment] };
  private captureTarget?: SceneTarget;
  private disposed = false;
  private host?: StackHost;
  private input?: GPUTextureView;
  private sceneDepth?: GPUTexture;
  private cocView?: GPUTextureView;
  private tileView?: GPUTextureView;
  private coarseView?: GPUTextureView;
  private outputView?: GPUTextureView;
  private key = new OutputKey();

  constructor(readonly options: DOFOptions = {}) {
    this.validate();
  }
  static attach(instance: EngineKernel, options: DOFOptions = {}): DOF {
    const effect = new DOF(options);
    engineRuntime(instance).use(effect);
    return effect;
  }
  get depthTexture(): GPUTexture | undefined {
    return this.host ? this.host.depthTexture : this.depth;
  }
  /** The blurred linear HDR image; while DOF alone waits for its WebGL2 route, the sharp captured scene. */
  get outputTexture(): GPUTexture | undefined {
    return this.paused ? this.scene : this.output;
  }
  /**
   * The focal length of the last frame, in the units of `focalDistance`: `focalLength`, or with `filmGauge` the one
   * the camera's field of view gives on that sensor. Before the first frame, `focalLength` (default 0.05).
   */
  get focalLength(): number {
    return this.values[1] || (this.options.focalLength ?? 0.05);
  }
  get enabled(): boolean {
    return this.options.enabled ?? true;
  }
  set enabled(value: boolean) {
    if (typeof value !== 'boolean') throw new TypeError('DOF enabled must be boolean');
    this.options.enabled = value;
  }
  private joinStack(host: StackHost): StackStage {
    if (this.engine || this.host || this.disposed)
      throw new MargoError('attached', 'DOF is already attached; create a new DOF');
    this.host = host;
    return { kind: 'hdr', render: (c, input, output) => this.stage(c, input, output) };
  }
  private validate(): void {
    const o = this.options,
      g = o.filmGauge,
      f = g === undefined ? (o.focalLength ?? 0.05) : 0,
      d = o.focalDistance ?? 5,
      a = o.aperture ?? 2.8,
      r = o.maxRadius ?? 16;
    if (
      !Number.isFinite(Math.fround(f)) ||
      (g === undefined && Math.fround(f) <= 0) ||
      !Number.isFinite(Math.fround(d)) ||
      Math.fround(d) <= Math.fround(f) ||
      !Number.isFinite(Math.fround(a)) ||
      Math.fround(a) <= 0 ||
      !Number.isFinite(r) ||
      r < 1 ||
      r > 32 ||
      (o.enabled !== undefined && typeof o.enabled !== 'boolean') ||
      (o.temporal !== undefined && typeof o.temporal !== 'boolean')
    )
      throw new RangeError(
        'Invalid DOF options; use focalLength > 0, focalDistance > focalLength, aperture > 0, maxRadius from 1 to 32 and a boolean enabled and temporal',
      );
    if (
      (g !== undefined && !(Number.isFinite(g) && g > 0)) ||
      (o.sensorFit !== undefined && !['auto', 'horizontal', 'vertical'].includes(o.sensorFit))
    )
      throw new RangeError(
        "Invalid DOF filmGauge or sensorFit; use millimetres > 0 and 'auto', 'horizontal' or 'vertical'",
      );
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'DOF requires WebGPU and a live effect; attach a new DOF to a WebGPU engine; see https://margoengine.com/errors#webgpu',
      );
    requireCompatTier(engine.gpu, 'DOF HDR processing', 'half-float');
    if (
      !this.host &&
      (engine.hasPlugin('ssao') ||
        engine.hasPlugin('bloom') ||
        engine.hasPlugin('post-processing') ||
        (engine.hasPlugin('tonemap') && !engine.hasPlugin(this.name)))
    )
      throw new MargoError('state', 'DOF owns scene capture; attach it before Tonemap, without SSAO or PostProcessing');
    this.engine = engine;
    this.uniform = engine.gpu.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.build(premultipliedCanvas(engine));
    const uniform = this.uniform,
      route = loadCompatRoute(engine.gpu, () => import('./compat.js'));
    // Alone, DOF skips its CoC and blur until its WebGL2 route has loaded: its WebGPU route there takes the CPU tier,
    // about a second a frame at 720p on a fast CPU and several on a laptop's (bug 58), so the first frames show the
    // captured scene sharp, and effects reading outputTexture (Tonemap's source) get that scene.
    this.waiting = !!route;
    route?.then(
      ({ dofCompatPipelines }) => {
        if (this.uniform !== uniform) return;
        this.waiting = false;
        this.compatPipelines = dofCompatPipelines;
        this.useCompat();
        this.releaseTextures();
      },
      (error) => {
        // The WebGPU route still draws the same pixels: draw with it, and let the page hear why it is slow.
        this.waiting = false;
        throw error;
      },
    );
    // After the handlers above: by then the route (or, if it failed, the WebGPU route) draws every frame.
    this.routeReady = routeSettled(route);
  }
  /** The pipelines for an opaque canvas, or with `alpha` for a premultiplied one (./alpha.ts). */
  private build(alpha: boolean): void {
    const device = this.engine!.gpu!,
      source = { cocShader, coarseShader, bokehShader, groupMax },
      lensed = this.options.lens?.shaders(source) ?? source,
      temporal = this.options.temporal === true,
      plain = { ...(temporal ? halfShaders(lensed) : lensed), nearShader, joinShader },
      shaders = alpha ? alphaShaders(plain, temporal) : plain;
    this.alpha = alpha;
    this.kernels = shaders;
    if (temporal) {
      this.halfUniform ??= device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.halvePipeline = compute(device, halveShader);
      this.joinPipeline = compute(device, shaders.joinShader);
    }
    this.cocPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: shaders.cocShader }), entryPoint: 'main' },
    });
    this.bokehPipeline = compute(device, shaders.bokehShader);
    this.coarsePipeline = compute(device, shaders.coarseShader);
    this.nearPipeline = compute(device, shaders.nearShader);
    this.nearDownPipeline = compute(device, nearDownShader);
    this.nearSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
    this.tilesPipeline = undefined;
    this.useCompat();
  }
  /** Swaps in the WebGL2 route's pipelines once it has loaded. */
  private useCompat(): void {
    const make = this.compatPipelines;
    if (!make || !this.kernels) return;
    const temporal = !!this.halfUniform,
      pipelines = make(this.engine!.gpu!, this.kernels, temporal ? halveShader : undefined);
    ({ coc: this.cocPipeline, tiles: this.tilesPipeline, bokeh: this.bokehPipeline } = pipelines);
    if (temporal) this.halvePipeline = pipelines.halve;
  }
  /**
   * Settles once every frame draws the blur as it will from then on. On the WebGL2 compatibility layer DOF loads its
   * route (a dynamic import) when it attaches, and DOF used alone shows the captured scene sharp until it has loaded.
   * Resolved at once on WebGPU. Read it after attaching, and await it before a frame that must be exact: a film frame,
   * a pixel comparison (KB-COMPAT-READY1).
   *
   * @example
   * ```ts
   * const dof = DOF.attach(engine, { focalDistance: 5 });
   * await dof.ready;
   * engine.render();
   * ```
   */
  get ready(): Promise<void> {
    return this.routeReady;
  }
  /** True while DOF, used alone, waits for its WebGL2 route (it presents the captured scene unblurred then). */
  private get paused(): boolean {
    return this.waiting && !this.host;
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: 'dof:capture',
      order: -55,
      execute: (c) => {
        if (c.backend === 'webgpu') this.capture(c);
      },
    });
    if (this.host) return;
    // Just below 30, where post-processing composes: the blur reads every draw before it (Lines at 20, text at 22,
    // labels at 24), and the capture's final resolve in dof:coc keeps them at 4 samples (KB-POST-LATEDRAW1).
    graph.add({
      name: 'dof:coc',
      order: 29.8,
      execute: (c) => {
        if (c.backend === 'webgpu' && !this.paused) this.circles(c);
      },
    });
    graph.add({
      name: 'dof:bokeh',
      order: 29.9,
      execute: (c) => {
        if (c.backend === 'webgpu' && !this.paused) this.blur(c);
      },
    });
    graph.add({
      name: 'dof:present',
      order: 30,
      execute: (c) => {
        if (c.backend === 'webgpu') this.present(c);
      },
    });
  }
  // Inverse of a lens's field of view on its film: tan(fov / 2) = gauge / (2 f), over the side the gauge spans.
  private lens(gauge: number, fov: number, aspect: number): number {
    const fit = this.options.sensorFit ?? 'auto',
      half = Math.tan((fov * Math.PI) / 360);
    return gauge / (2000 * half * (fit === 'horizontal' || (fit === 'auto' && aspect >= 1) ? aspect : 1));
  }
  private capture(c: Context): void {
    this.validate();
    // A canvas made transparent (or opaque again) after DOF attached takes the other kernels.
    const alpha = premultipliedCanvas(this.engine);
    if (alpha !== this.alpha) {
      this.releaseTextures();
      this.build(alpha);
    }
    const o = this.options,
      v = this.values;
    const [viewWidth, viewHeight] = viewSize(c);
    v[0] = o.focalDistance ?? 5;
    v[1] =
      o.filmGauge === undefined
        ? (o.focalLength ?? 0.05)
        : this.lens(o.filmGauge, c.camera.fov, viewWidth / viewHeight);
    if (!(Math.fround(v[0]) > Math.fround(v[1])))
      throw new RangeError(`DOF focalDistance must lie beyond the focal length the camera gives, ${v[1]}`);
    v[2] = o.aperture ?? 2.8;
    v[3] = o.maxRadius ?? 16;
    v[4] = c.camera.near;
    v[5] = c.camera.far;
    v[6] = (v[1] * viewHeight) / (4 * v[2] * (v[0] - v[1]) * Math.tan((c.camera.fov * Math.PI) / 360));
    v[7] = +this.enabled;
    v[8] = 0;
    // The WebGL2 route's CoC takes the nearest depth of each pixel's neighbours when the capture is multisampled, as
    // the layer resolves multisampled depth to one sample (./compat.ts). It stays 0 on WebGPU, where the temporal
    // gathers turn their taps by this slot of their own uniform.
    v[11] = +(!!this.tilesPipeline && (c.descriptor.multisample?.count ?? 4) > 1);
    // Orthographic clip matrix (e.g. @margoengine/cameras): linear depth and a blur linear in defocus, scaled like a
    // perspective lens whose pixel size at the focal distance matches the orthographic zoom.
    const ortho = orthographic(c.camera.matrix, c.camera.position);
    if (ortho) {
      v[4] = ortho.near;
      v[5] = ortho.far;
      v[6] = (v[1] * viewHeight * ortho.sy * v[0]) / (4 * v[2] * (v[0] - v[1]));
      v[8] = 1;
    }
    o.lens?.write(v, c.camera, viewWidth / viewHeight);
    if (!Number.isFinite(v[6]))
      throw new RangeError(
        'DOF lens scale exceeds float32; use a larger aperture or a focalDistance further from focalLength',
      );
    if (!this.host) {
      if (
        this.engine!.hasPlugin('ssao') ||
        this.engine!.hasPlugin('post-processing') ||
        this.engine!.hasPlugin('bloom')
      )
        throw new MargoError(
          'state',
          'DOF cannot share scene capture with another post effect; put both effects in one PostStack',
        );
      this.resize(c);
      this.originalColor = c.color;
      this.originalDepth = c.depth;
      let shader = this.shaders.get(c.shader);
      if (shader === undefined) {
        shader = linearShader(c.shader);
        if (shader === c.shader) throw new MargoError('unsupported', coreShaderRequired('DOF'));
        this.shaders.set(c.shader, shader);
      }
      c.shader = shader;
      this.captureTarget!.begin(c);
    }
    c.device.queue.writeBuffer(this.uniform!, 0, v as Float32Array<ArrayBuffer>);
    if (this.halfUniform) {
      const h = this.halfValues;
      h.set(v);
      h[3] = v[3] / 2;
      h[11] = (this.turn++ * 2.39996323) % (2 * Math.PI);
      c.device.queue.writeBuffer(this.halfUniform, 0, h as Float32Array<ArrayBuffer>);
    }
  }
  private resize(c: Context): void {
    const depthFormat = c.descriptor.depthStencil!.format;
    if (
      this.presentPipeline &&
      this.scene?.width === c.width &&
      this.scene.height === c.height &&
      this.format === c.format &&
      this.depthFormat === depthFormat &&
      this.captureTarget?.samples === (c.descriptor.multisample?.count ?? 4)
    )
      return;
    this.releaseTextures();
    this.format = c.format;
    this.depthFormat = depthFormat;
    const sampled = GPUTextureUsage.TEXTURE_BINDING;
    this.scene = c.device.createTexture({
      size: [c.width, c.height],
      format: 'rgba16float',
      usage: sampled | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.depth = c.device.createTexture({
      size: [c.width, c.height],
      format: depthFormat,
      usage: sampled | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.targets(c.device, c.width, c.height);
    this.captureTarget = new SceneTarget(c.device, this.scene, this.depth, c.descriptor.multisample?.count ?? 4);
    this.sceneView = this.scene.createView();
    this.depthView = this.depth.createView();
    const cocView = this.cocView!,
      outputView = this.outputView!,
      tileView = this.tileView!,
      coarseView = this.coarseView!;
    const module = c.device.createShaderModule({ code: displayFor(this.engine, presentShader) });
    this.presentPipeline = c.device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vertex' },
      fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format }] },
      multisample: c.descriptor.multisample,
    });
    this.groups = [
      this.cocGroup(c.device, this.depth, true),
      this.halfUniform
        ? undefined!
        : c.device.createBindGroup({
            layout: this.bokehPipeline!.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: this.uniform! } },
              { binding: 1, resource: this.sceneView },
              { binding: 2, resource: cocView },
              { binding: 3, resource: outputView },
              { binding: 4, resource: tileView },
              { binding: 5, resource: coarseView },
              { binding: 6, resource: this.nearSampler! },
              ...this.nearViews.map((resource, i) => ({ binding: 7 + i, resource })),
              ...bound(this.coarseAlphaView, this.blurredAlphaView).map((resource, i) => ({
                binding: 10 + i,
                resource,
              })),
            ],
          }),
      c.device.createBindGroup({
        layout: this.presentPipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: outputView }],
      }),
      this.halfUniform
        ? undefined!
        : group(c.device, this.coarsePipeline!, [
            { buffer: this.uniform! },
            this.sceneView,
            cocView,
            coarseView,
            ...bound(this.coarseAlphaView),
          ]),
    ];
    if (!this.halfUniform)
      this.groups[8] = this.nearGroup(c.device, { buffer: this.uniform! }, this.sceneView, cocView);
    if (this.halfUniform) this.halfGroups(c.device, this.sceneView);
  }
  /** Temporal: the gather's groups over the half textures (1, 3) and the halve and join groups over `input` (5, 6). */
  private halfGroups(device: GPUDevice, input: GPUTextureView): void {
    const u = { buffer: this.halfUniform! },
      scene = this.halfScene!.createView(),
      coc = this.halfCoc!.createView(),
      tiles = this.halfTiles!.createView(),
      blurred = this.blurred!.createView();
    this.groups[1] = group(device, this.bokehPipeline!, [
      u,
      scene,
      coc,
      blurred,
      tiles,
      this.coarseView!,
      this.nearSampler!,
      ...this.nearViews,
      ...bound(this.coarseAlphaView, this.blurredAlphaView),
    ]);
    this.groups[3] = group(device, this.coarsePipeline!, [
      u,
      scene,
      coc,
      this.coarseView!,
      ...bound(this.coarseAlphaView),
    ]);
    this.groups[8] = this.nearGroup(device, u, scene, coc);
    this.groups[5] = group(device, this.halvePipeline!, [
      input,
      this.cocView!,
      scene,
      coc,
      ...(this.tilesPipeline ? [] : [tiles]),
    ]);
    this.groups[6] = group(device, this.joinPipeline!, [
      input,
      this.cocView!,
      blurred,
      this.outputView!,
      ...bound(this.blurredAlphaView),
    ]);
    if (this.tilesPipeline) this.groups[7] = group(device, this.tilesPipeline, [coc, tiles]);
  }
  /** The near chain's level 0 bind group over the gather's scene and CoC (full or, temporal, half size). */
  private nearGroup(device: GPUDevice, u: GPUBufferBinding, scene: GPUTextureView, coc: GPUTextureView): GPUBindGroup {
    return group(device, this.nearPipeline!, [u, scene, coc, ...this.nearBase]);
  }
  /** The CoC pass's bind group; on the WebGL2 route also the tile pass's (`tilesGroup`). */
  private cocGroup(device: GPUDevice, depth: GPUTexture, direct = false): GPUBindGroup {
    if (this.tilesPipeline) {
      this.tilesGroup = group(device, this.tilesPipeline, [this.cocView!, this.tileView!]);
      return group(device, this.cocPipeline!, [
        { buffer: this.uniform! },
        depth.createView({ aspect: 'depth-only' }),
        this.cocView!,
      ]);
    }
    // The WebGPU route keeps its calls in the order the proofs recorded (layout first when made directly).
    if (direct)
      return device.createBindGroup({
        layout: this.cocPipeline!.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniform! } },
          { binding: 1, resource: depth.createView({ aspect: 'depth-only' }) },
          { binding: 2, resource: this.cocView! },
          { binding: 3, resource: this.tileView! },
        ],
      });
    return group(device, this.cocPipeline!, [
      { buffer: this.uniform! },
      depth.createView({ aspect: 'depth-only' }),
      this.cocView!,
      this.tileView!,
    ]);
  }

  /** CoC and 8x8 tile maxima: one kernel on WebGPU, two on the WebGL2 route. */
  private circles(c: Context): void {
    this.dispatch(c, this.cocPipeline!, this.groups[0]);
    if (this.tilesPipeline && !this.halvePipeline) this.dispatch(c, this.tilesPipeline, this.tilesGroup!, 64);
    if (this.halvePipeline) this.dispatch(c, this.halvePipeline, this.groups[5], 16);
    if (this.tilesPipeline && this.halvePipeline) this.dispatch(c, this.tilesPipeline, this.groups[7], 128);
  }
  private blur(c: Context): void {
    // Temporal: the gather covers the half image (blocks twice as wide), then the join brings it back to full size.
    const half = this.halvePipeline ? 2 : 1;
    this.dispatch(c, this.nearPipeline!, this.groups[8], 8 * half);
    this.nearLevels.forEach((level, k) => this.dispatch(c, this.nearDownPipeline!, level, (16 * half) << k));
    this.dispatch(c, this.coarsePipeline!, this.groups[3], 16 * half);
    this.dispatch(c, this.bokehPipeline!, this.groups[1], 8 * half);
    if (this.joinPipeline) this.dispatch(c, this.joinPipeline, this.groups[6]);
  }
  private dispatch(c: Context, pipeline: GPUComputePipeline, group: GPUBindGroup, block = 8): void {
    if (pipeline === this.cocPipeline) this.captureTarget?.resolve(c.encoder, true);
    const pass = c.encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(c.width / block), Math.ceil(c.height / block));
    pass.end();
  }
  private present(c: Context): void {
    const paused = this.paused;
    if (paused) {
      // No CoC pass resolved the capture: resolve it here and show it sharp (made only on this path, so the WebGPU
      // route keeps the calls the proofs recorded).
      this.captureTarget!.resolve(c.encoder, true);
      this.groups[4] ??= group(c.device, this.presentPipeline!, [this.sceneView!]);
    }
    this.attachment.view = this.originalColor!;
    this.attachment.loadOp = viewLoadOp(c, 'clear');
    const pass = c.encoder.beginRenderPass(this.presentation);
    pass.setPipeline(this.presentPipeline!);
    pass.setBindGroup(0, this.groups[paused ? 4 : 2]);
    applyView(pass, c);
    pass.draw(3);
    pass.end();
    this.captureTarget!.restore(c);
  }
  /** Stacked: blur `input` by the shared depth into outputTexture, handed on as linear light or presented as the display output. */
  private stage(c: Context, input: GPUTextureView, output: StageOutput): GPUTextureView | void {
    const device = c.device,
      depth = this.host!.depthTexture!;
    if (this.coc?.width !== c.width || this.coc.height !== c.height) {
      this.releaseTextures();
      this.targets(device, c.width, c.height);
    }
    if (this.sceneDepth !== depth) {
      this.sceneDepth = depth;
      this.groups[0] = this.cocGroup(device, depth);
    }
    if (this.input !== input && this.halfUniform) {
      this.input = input;
      this.halfGroups(device, input);
    } else if (this.input !== input) {
      this.input = input;
      this.groups[1] = group(device, this.bokehPipeline!, [
        { buffer: this.uniform! },
        input,
        this.cocView!,
        this.outputView!,
        this.tileView!,
        this.coarseView!,
        this.nearSampler!,
        ...this.nearViews,
        ...bound(this.coarseAlphaView, this.blurredAlphaView),
      ]);
      this.groups[3] = group(device, this.coarsePipeline!, [
        { buffer: this.uniform! },
        input,
        this.cocView!,
        this.coarseView!,
        ...bound(this.coarseAlphaView),
      ]);
      this.groups[8] = this.nearGroup(device, { buffer: this.uniform! }, input, this.cocView!);
    }
    this.circles(c);
    this.blur(c);
    if (output.hdr) return this.outputView;
    if (this.key.changed(output, premultipliedCanvas(this.engine))) {
      const code = displayFor(this.engine, presentShader);
      this.presentPipeline = render(device, code, output.format, { multisample: output.multisample });
      this.groups[2] = group(device, this.presentPipeline, [this.outputView!]);
      this.key.done();
    }
    this.attachment.view = output.view;
    this.attachment.loadOp = viewLoadOp(c, 'clear');
    const pass = c.encoder.beginRenderPass(this.presentation);
    pass.setPipeline(this.presentPipeline!);
    pass.setBindGroup(0, this.groups[2]);
    applyView(pass, c);
    pass.draw(3);
    pass.end();
  }
  /** CoC (radius, view depth), the blurred output, 8x8-tile near-radius maxima and 2x2-block wide far gathers. */
  private targets(device: GPUDevice, width: number, height: number): void {
    const storage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING;
    this.coc = device.createTexture({ size: [width, height], format: 'rg32float', usage: storage });
    this.output = device.createTexture({
      size: [width, height],
      format: 'rgba16float',
      usage: storage | GPUTextureUsage.COPY_SRC,
    });
    this.tiles = device.createTexture({
      size: [Math.ceil(width / 8), Math.ceil(height / 8)],
      format: 'r32float',
      usage: storage,
    });
    // Temporal: the gather's own CoC, tiles and image at half size, and its 2x2 blocks over that half.
    const half = this.halfUniform ? 2 : 1,
      hw = Math.ceil(width / half),
      hh = Math.ceil(height / half);
    this.coarse = device.createTexture({
      size: [Math.ceil(hw / 2), Math.ceil(hh / 2)],
      format: 'rgba16float',
      usage: storage,
    });
    if (this.halfUniform) {
      this.halfScene = device.createTexture({ size: [hw, hh], format: 'rgba16float', usage: storage });
      this.halfCoc = device.createTexture({ size: [hw, hh], format: 'rg32float', usage: storage });
      this.halfTiles = device.createTexture({
        size: [Math.ceil(hw / 8), Math.ceil(hh / 8)],
        format: 'r32float',
        usage: storage,
      });
      this.blurred = device.createTexture({ size: [hw, hh], format: 'rgba16float', usage: storage });
    }
    if (this.alpha) {
      const plane = (size: [number, number]) => device.createTexture({ size, format: 'r32float', usage: storage });
      this.coarseAlpha = plane([Math.ceil(hw / 2), Math.ceil(hh / 2)]);
      this.coarseAlphaView = this.coarseAlpha.createView();
      if (this.halfUniform) {
        this.blurredAlpha = plane([hw, hh]);
        this.blurredAlphaView = this.blurredAlpha.createView();
      }
    }
    // The near tap source at the gather's size, NEAR_LEVELS levels (fewer for a frame under 8 px across).
    const levels = Math.min(NEAR_LEVELS, Math.floor(Math.log2(Math.max(hw, hh))) + 1),
      near = () =>
        device.createTexture({ size: [hw, hh], format: 'rgba16float', usage: storage, mipLevelCount: levels }),
      chain = [(this.nearTaps = near()), (this.nearShapes = near()), (this.nearScene = near())],
      level = (k: number) => chain.map((t) => t.createView({ baseMipLevel: k, mipLevelCount: 1 }));
    this.nearViews = chain.map((t) => t.createView());
    this.nearBase = level(0);
    let below = this.nearBase;
    this.nearLevels = [];
    for (let k = 1; k < levels; k++) {
      const above = level(k);
      this.nearLevels.push(group(device, this.nearDownPipeline!, [...below, ...above]));
      below = above;
    }
    this.cocView = this.coc.createView();
    this.outputView = this.output.createView();
    this.tileView = this.tiles.createView();
    this.coarseView = this.coarse.createView();
  }
  private releaseTextures(): void {
    this.captureTarget?.dispose();
    this.captureTarget = undefined;
    this.scene?.destroy();
    this.depth?.destroy();
    this.coc?.destroy();
    this.output?.destroy();
    this.tiles?.destroy();
    this.coarse?.destroy();
    this.halfScene?.destroy();
    this.halfCoc?.destroy();
    this.halfTiles?.destroy();
    this.blurred?.destroy();
    this.nearTaps?.destroy();
    this.nearShapes?.destroy();
    this.nearScene?.destroy();
    this.coarseAlpha?.destroy();
    this.blurredAlpha?.destroy();
    this.coarseAlpha = this.blurredAlpha = this.coarseAlphaView = this.blurredAlphaView = undefined;
    this.nearTaps = this.nearShapes = this.nearScene = undefined;
    this.nearViews = this.nearBase = [];
    this.nearLevels = [];
    this.scene = this.depth = this.coc = this.output = this.tiles = this.coarse = undefined;
    this.halfScene = this.halfCoc = this.halfTiles = this.blurred = undefined;
    this.sceneView = this.depthView = undefined;
    this.groups = [];
    this.presentPipeline = undefined;
    this.input = this.sceneDepth = this.cocView = this.outputView = this.tileView = this.coarseView = undefined;
    this.key.reset();
  }
  private release(): void {
    this.releaseTextures();
    this.uniform?.destroy();
    this.halfUniform?.destroy();
    this.uniform = this.halfUniform = undefined;
    this.halvePipeline = this.joinPipeline = undefined;
    this.cocPipeline = this.bokehPipeline = this.coarsePipeline = this.tilesPipeline = undefined;
    this.nearPipeline = this.nearDownPipeline = undefined;
    this.kernels = this.compatPipelines = undefined;
    this.nearSampler = undefined;
    this.originalColor = this.originalDepth = undefined;
    this.shaders.clear();
  }
  onDeviceRestored(engine: Engine): void {
    if (this.disposed) return;
    this.release();
    try {
      this.setup(engine);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.engine = undefined;
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
