import type { Camera } from './camera.js';
import type { Geometry } from './geometry.js';
import type { Scene } from './api.js';
import { wgsl } from './shaders.js';
import type { FrameGraph, PassContext, DrawOptions } from './plugin.js';
import { sceneSamples } from './quality.js';
import { defaultClear, clearColorValue, clearDraw } from '../../shared/clear-color.js';
import { fault, rangeError, typeError } from '../../shared/errors.js';
// TypeScript's DOM library omits WebGPU flag namespaces and the canvas overload.
declare const GPUBufferUsage: {
  COPY_DST: number;
  COPY_SRC: number;
  MAP_READ: number;
  INDEX: number;
  VERTEX: number;
  UNIFORM: number;
  INDIRECT: number;
  STORAGE: number;
};
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; COPY_SRC: number; TEXTURE_BINDING: number };
declare const GPUMapMode: { READ: number };

const defaultDraw: DrawOptions = {};

/** @internal How a view clears. A partial rectangle cannot use the attachment load operation: that clears the whole target. */
export function rectangleClear(
  rect: readonly number[] | undefined,
  width: number,
  height: number,
  clearColor: boolean,
  clearDepth: boolean,
  extraAttachments: number,
): 'draw' | 'attachment' | 'none' {
  if (!clearColor && !clearDepth) return 'none';
  const partial = !!rect && (rect[0] !== 0 || rect[1] !== 0 || rect[2] !== width || rect[3] !== height);
  if (!partial) return 'attachment';
  if (extraAttachments) throw typeError('Partial-view clear: draw extra attachments with clear: false', 'views');
  return 'draw';
}

/** @internal Checks a pixel rectangle [x, y, width, height] against a target of `width` x `height`. */
export function validateRectangle(rectangle: readonly number[] | undefined, width: number, height: number): void {
  if (rectangle === undefined) return;
  if (!Array.isArray(rectangle) || rectangle.length !== 4) throw rangeError('Invalid draw rectangle', 'views');
  for (let i = 0; i < 4; i++)
    if (!Number.isSafeInteger(rectangle[i]) || rectangle[i] < (i < 2 ? 0 : 1))
      throw rangeError('Invalid draw rectangle', 'views');
  if (rectangle[0] + rectangle[2] > width || rectangle[1] + rectangle[3] > height)
    throw rangeError('Draw rectangle exceeds target', 'views');
}

/** `start`/`end`: float range of `instances` changed since the WebGPU renderer last uploaded it (absent: upload all).
 * `mask`: nonzero when a drawn instance needs back faces (double-sided material or mirrored transform); 0 lets core's
 * own pass draw the batch with its back-culled pipeline (absent counts as 0).
 * `redirect`: set by a GPU-culling package for the frame (core never sets it): every core draw of the batch reads instances
 * from `instances` and its drawIndexedIndirect arguments from `args` (offset 0) instead of core's instance buffer and
 * `count`; core still uploads the batch into its own buffer, which stays the source the package reads.
 * `claimed`: set by a package that draws these instances itself (core never sets it, and it persists until the package
 * clears it): core's draws neither bind nor encode the batch and `engine.stats.drawCalls` leaves it out. Pick passes
 * still draw it. */
export interface Batch {
  geometry: Geometry;
  instances: Float32Array;
  count: number;
  start?: number;
  end?: number;
  mask?: number;
  redirect?: { instances: GPUBuffer; args: GPUBuffer };
  claimed?: boolean;
}
/**
 * The single directional light. `direction`: xyz toward the light (non-zero), w intensity (>= 0); default [3, 5, 4, 3].
 * `radiance`: linear rgb light color, w ambient strength, all >= 0; default [1, 1, 1, 0.15]. Invalid values throw
 * RangeError on the next frame.
 * `ambient`: three nonnegative finite linear RGB multipliers for core-mesh ambient; omitted means white.
 * Named setters with typed angles: `setSun` / `setAmbient` in `@margoengine/sky/sun`.
 */
export interface Lighting {
  direction: Float32Array;
  radiance: Float32Array;
  ambient?: Float32Array;
}
/** WebGPU buffers core keeps for one geometry: vertices (position + normal), uint32 indices, and per-instance data. */
export interface GeometryBuffers {
  readonly vertex: GPUBuffer;
  readonly index: GPUBuffer;
  readonly instance: GPUBuffer;
}
/**
 * One camera drawn into a rectangle of the canvas, or into a texture: split screen, a four-view CAD layout, a
 * minimap, a HUD overlay scene or an item preview. Pass views to `engine.render({views})` or set `engine.views`.
 */
export interface RenderView {
  camera: Camera;
  /**
   * [x, y, width, height] from the top left, in fractions of the canvas (or of `target`) by default:
   * `[0, 0, 0.5, 0.5]` is the top-left quarter. Camera aspect follows it.
   */
  viewport: readonly [number, number, number, number];
  /** `viewport` and `scissor` are drawing-buffer pixels instead of fractions. Default false. */
  pixels?: boolean;
  /** Clip rectangle inside the viewport, same units. Default the viewport. */
  scissor?: readonly [number, number, number, number];
  /**
   * `color`: a `#rrggbb` clear colour, or false to keep the colour below. `depth`: false keeps the depth. Default: the
   * first canvas view clears colour (the scene's `background`, else core's clear colour) and every view clears depth.
   */
  clear?: { color?: string | false; depth?: boolean };
  /**
   * Draw into these textures instead of the canvas; the caller owns them and recreates them after device loss.
   * `color`: 1 sample, any renderable colour format, RENDER_ATTACHMENT usage; with 4x MSAA core draws into its own 4x
   * texture of that format (kept per target size and format) and resolves into it, so edges are antialiased.
   * `depth` (optional): the size of `color`. With the scene's depth format and sample count core draws into it;
   * otherwise (a 1-sample depth under 4x MSAA, or another format) core draws into its own depth and then writes the
   * nearest sample of each pixel into it with a fullscreen pass. Other shapes throw TypeError. Several views may draw
   * into one target: they stack like canvas views (later ones keep the colour outside their rectangle).
   */
  target?: { color: GPUTexture; depth?: GPUTexture };
  /**
   * Layer mask: draw only meshes whose render layers (`setRenderLayers` in @margoengine/cameras/layers) share a bit
   * with it. Default the camera's mask (`setCameraLayers`), else every layer.
   */
  layers?: number;
  /** Stable id that effects key per-view history on (TAA, motion blur, water foam). Default the view's index. */
  id?: string;
  /** Scene to draw. Default `engine.scene`. */
  scene?: Scene;
}
/** What the engine passes to {@link Renderer.render} for one view: rectangles in pixels of the target. */
export interface ViewDraw {
  rect: readonly [number, number, number, number];
  scissor?: readonly [number, number, number, number];
  /** Layer mask in use; absent when every layer is drawn. */
  layers?: number;
  /** Position among the frame's views into the same destination (the canvas, or one target texture). */
  index: number;
  /** Number of the frame's views into that destination. */
  count: number;
  id: string;
  clear?: { color?: string | false; depth?: boolean };
  target?: { color: GPUTexture; depth?: GPUTexture };
}
/**
 * Backend contract the engine draws through: core's WebGPU renderer, or an `EngineOptions.fallback` such as WebGL2.
 * `add` sizes a geometry's instance storage (`capacity` instances), `render` draws one frame (`delta` in seconds), and
 * `onLost` reports device loss. `view` draws into that rectangle and keeps earlier views' color when `index` is not 0.
 */
export interface Renderer {
  readonly backend: 'webgpu' | 'webgl2';
  readonly gpu?: GPUDevice;
  onLost?: (error: Error) => void;
  add(geometry: Geometry, capacity: number): void;
  remove(geometry: Geometry): void;
  geometryBuffers?(geometry: Geometry): GeometryBuffers;
  render(
    camera: Camera,
    lighting: Lighting,
    batches: Iterable<Batch>,
    graph: FrameGraph,
    delta: number,
    view?: ViewDraw,
  ): void;
  dispose(unconfigure?: boolean): void;
}

export class GPURenderer implements Renderer {
  onLost?: (error: Error) => void;
  get gpu(): GPUDevice {
    return this.device;
  }
  readonly backend = 'webgpu';
  private readonly frame = new Float32Array(32);
  /** MSAA colour (4x only) and depth attachments by size: slot 0 for the canvas, 1 for target views. */
  private attachments: {
    width: number;
    height: number;
    format: GPUTextureFormat;
    textures: GPUTexture[];
    views: GPUTextureView[];
    pipeline?: GPURenderPipeline;
    group?: GPUBindGroup;
  }[] = [];
  /** The current draw's MSAA colour, which resolves into `resolveTarget`. */
  private msaa?: GPUTextureView;
  private resolveTarget?: GPUTextureView;
  private preserveMSAA = false;
  private passDescriptor?: GPURenderPassDescriptor;
  private resolvePass?: GPURenderPassDescriptor;
  private readonly drawBatches: Batch[] = [];
  private readonly commands: GPUCommandBuffer[] = [];
  private passContext?: Extract<PassContext, { backend: 'webgpu' }>;
  private draw?: PassContext['draw'];
  /** Keep the multisample color for a later view instead of resolving it this submit. */
  private holdColor = false;
  private readonly clears = new Map<string, GPURenderPipeline>();
  private readonly bindings: GPUBindGroupEntry[] = [];
  private frameId = 0;
  private lost?: Error;
  private deviceLost = false;
  private readonly resources = new Map<
    Geometry,
    {
      vertex: GPUBuffer;
      index: GPUBuffer;
      instance: GPUBuffer;
      frame: number;
      indirect?: GPUBuffer;
      command?: Uint32Array;
    }
  >();
  private readonly variants: [string, string, GPURenderPipeline][] = [];
  private readonly groups = new WeakMap<GPURenderPipeline, { bindings: GPUBindGroupEntry[]; group: GPUBindGroup }>();
  private readonly uniform: GPUBuffer;
  private readonly bindGroup: GPUBindGroup;
  private readonly culledGroup: GPUBindGroup;
  private disposed = false;

  static async create(
    canvas: HTMLCanvasElement,
    features: GPUFeatureName[] = [],
    samples: number = sceneSamples(),
  ): Promise<GPURenderer> {
    const adapter = await navigator.gpu?.requestAdapter(
      /Win/.test(navigator.userAgent) ? {} : { powerPreference: 'high-performance' },
    );
    if (!adapter) throw fault('unsupported', 'WebGPU adapter unavailable', 'webgpu');
    const device = await adapter.requestDevice({
      requiredLimits: { maxTextureArrayLayers: adapter.limits?.maxTextureArrayLayers },
      requiredFeatures: ['depth32float-stencil8' as GPUFeatureName, ...features].filter((feature) =>
        adapter.features.has(feature),
      ),
    });
    try {
      const format = navigator.gpu.getPreferredCanvasFormat();
      const module = device.createShaderModule({ code: wgsl });
      const descriptor: GPURenderPipelineDescriptor = {
        layout: 'auto',
        vertex: {
          module,
          entryPoint: 'vertex',
          buffers: [
            {
              arrayStride: 24,
              attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x3' },
                { shaderLocation: 1, offset: 12, format: 'float32x3' },
              ],
            },
            {
              arrayStride: 96,
              stepMode: 'instance',
              attributes: Array.from({ length: 6 }, (_, i) => ({
                shaderLocation: i + 2,
                offset: i * 16,
                format: 'float32x4' as const,
              })),
            },
          ],
        },
        fragment: { module, entryPoint: 'fragment', targets: [{ format }] },
        depthStencil: {
          format: device.features.has('depth32float-stencil8') ? 'depth32float-stencil8' : 'depth32float',
          depthWriteEnabled: true,
          depthCompare: 'greater-equal',
        },
        multisample: { count: samples },
      };
      const pipeline = await device.createRenderPipelineAsync(descriptor),
        culled = await device.createRenderPipelineAsync({
          ...descriptor,
          primitive: { cullMode: 'back' },
          fragment: { ...descriptor.fragment!, constants: { C: 1 } },
        });
      const context = canvas.getContext('webgpu') as GPUCanvasContext | null;
      if (!context) throw fault('unsupported', 'No WebGPU canvas', 'webgpu');
      return new GPURenderer(canvas, device, context, format, pipeline, descriptor, culled);
    } catch (error) {
      device.destroy();
      throw error;
    }
  }

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly device: GPUDevice,
    private readonly context: GPUCanvasContext,
    private readonly format: GPUTextureFormat,
    private readonly pipeline: GPURenderPipeline,
    private readonly descriptor: GPURenderPipelineDescriptor,
    private readonly culled: GPURenderPipeline,
  ) {
    this.uniform = device.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniform } }],
    });
    this.culledGroup = device.createBindGroup({
      layout: culled.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniform } }],
    });
    try {
      context.configure({ device, format });
    } catch (error) {
      this.uniform.destroy();
      throw error;
    }
    device.lost.then((info) => {
      this.deviceLost = true;
      if (!this.disposed) this.onLost?.(fault('failed', `GPU lost: ${info.message}`, 'gpu-lost'));
    });
    device.addEventListener('uncapturederror', (event) => {
      this.lost = fault('failed', event.error.message, 'gpu-lost');
    });
  }

  add(geometry: Geometry, capacity: number): void {
    const buffers: GPUBuffer[] = [];
    try {
      const upload = (data: Float32Array | Uint32Array, usage: number) => {
        if (data.byteLength > this.device.limits.maxBufferSize) throw rangeError('GPU buffer limit', 'limits');
        const buffer = this.device.createBuffer({ size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST });
        buffers.push(buffer);
        this.device.queue.writeBuffer(buffer, 0, data as Float32Array<ArrayBuffer>);
        return buffer;
      };
      const vertex = upload(geometry.vertices, GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE),
        index = upload(geometry.indices, GPUBufferUsage.INDEX | GPUBufferUsage.STORAGE);
      if (capacity * 96 > this.device.limits.maxBufferSize) throw rangeError('GPU buffer limit', 'limits');
      const instance = this.device.createBuffer({
        size: capacity * 96,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      buffers.push(instance);
      this.resources.set(geometry, { vertex, index, instance, frame: -1 });
    } catch (error) {
      for (const buffer of buffers) buffer.destroy();
      throw error;
    }
  }
  remove(geometry: Geometry): void {
    const resource = this.resources.get(geometry);
    if (!resource) return;
    resource.vertex.destroy();
    resource.index.destroy();
    resource.instance.destroy();
    resource.indirect?.destroy();
    this.resources.delete(geometry);
  }
  geometryBuffers(geometry: Geometry): GeometryBuffers {
    const resource = this.resources.get(geometry);
    if (this.disposed || this.deviceLost || !resource) throw fault('state', 'Geometry unavailable', 'device-restore');
    return resource;
  }
  render(
    camera: Camera,
    lighting: Lighting,
    batches: readonly Batch[],
    graph: FrameGraph,
    delta: number,
    view?: ViewDraw,
  ): void {
    if (this.deviceLost || this.disposed) return;
    try {
      this.renderFrame(camera, lighting, batches, graph, delta, view);
    } catch (error) {
      if (error instanceof DOMException && ['InvalidStateError', 'OperationError'].includes(error.name)) {
        this.deviceLost = true;
        this.onLost?.(error);
        return;
      }
      throw error;
    }
  }
  private renderFrame(
    camera: Camera,
    lighting: Lighting,
    batches: readonly Batch[],
    graph: FrameGraph,
    delta: number,
    view?: ViewDraw,
  ): void {
    if (this.lost) throw this.lost;
    const target = view?.target,
      { width, height } = target?.color ?? this.canvas,
      format = target?.color.format ?? this.format,
      views = this.attach(+!!target, width, height, format),
      samples = this.descriptor.multisample!.count!,
      caller = target?.depth,
      // A caller depth core can draw into directly; any other is written from core's own depth after the frame.
      direct = caller?.sampleCount === samples && caller.format === this.descriptor.depthStencil!.format;
    if (
      target &&
      (target.color.sampleCount > 1 ||
        (caller && (caller.width !== width || caller.height !== height || (!direct && caller.sampleCount > 1))))
    )
      throw typeError('Invalid view target: use 1-sample colour', 'views');
    this.frame.set(camera.matrix);
    this.frame.set(camera.position, 16);
    this.frame.set(lighting.direction, 20);
    this.frame.set(lighting.radiance, 24);
    this.frame.fill(1, 28, 31);
    if (lighting.ambient) this.frame.set(lighting.ambient, 28);
    this.device.queue.writeBuffer(this.uniform, 0, this.frame);
    const stacked = !!view && view.index + 1 !== view.count;
    // A canvas view before the last keeps its multisample colour for the next one instead of resolving it.
    this.holdColor = stacked;
    const encoder = this.device.createCommandEncoder();
    this.frameId++;
    const drawBatches = this.drawBatches;
    // By index: the engine passes an array, and an iterator over it would be garbage every frame.
    for (let i = 0; i < batches.length; i++) drawBatches[i] = batches[i];
    drawBatches.length = batches.length;
    this.resolveTarget = target?.color.createView() ?? this.context.getCurrentTexture().createView();
    this.msaa = views.length > 1 ? views[0] : undefined;
    const color = this.msaa ?? this.resolveTarget,
      depth = direct ? caller.createView() : views.at(-1)!,
      keepDepth = stacked || (!!caller && !direct);
    this.preserveMSAA = (graph.revision > 0 || keepDepth) && !!this.msaa;
    const context = (this.passContext ??= {
      backend: 'webgpu',
      draw: (options: DrawOptions = defaultDraw) => {
        const context = this.passContext!;
        const viewRect = context.view?.viewport,
          viewport = options.viewport === undefined ? viewRect : options.viewport,
          scissor =
            options.scissor === undefined
              ? options.viewport === undefined
                ? (context.view?.scissor ?? viewRect)
                : undefined
              : options.scissor;
        validateRectangle(viewport, context.width, context.height);
        validateRectangle(scissor, context.width, context.height);
        let pipeline = options.pipeline ?? this.pipeline;
        const bindings = options.bindings ?? context.bindings;
        if (
          !options.pipeline &&
          (context.shader !== wgsl || context.format !== this.format || context.descriptor !== this.descriptor)
        ) {
          const key = context.descriptor.multisample?.count + context.format + context.descriptor.depthStencil?.format;
          pipeline = this.variant(context.shader, key, (module) => ({
            ...context.descriptor,
            vertex: { ...this.descriptor.vertex, module },
            fragment: { ...this.descriptor.fragment!, module, targets: [{ format: context.format }] },
          }));
        }
        let group = this.bindGroup;
        if (pipeline !== this.pipeline || bindings.length) {
          let cached = this.groups.get(pipeline);
          // An index loop, not some(): a closure per draw would be garbage every frame.
          let stale = !cached || cached.bindings.length !== bindings.length;
          for (let i = 0; !stale && i < bindings.length; i++) {
            const entry = bindings[i],
              previous = cached!.bindings[i],
              resource = entry.resource as GPUBufferBinding,
              old = previous.resource as GPUBufferBinding;
            stale =
              entry.binding !== previous.binding ||
              (resource.buffer
                ? resource.buffer !== old.buffer || resource.offset !== old.offset || resource.size !== old.size
                : resource !== old);
          }
          if (stale || !cached) {
            const group = this.device.createBindGroup({
              layout: pipeline.getBindGroupLayout(0),
              entries: [{ binding: 0, resource: { buffer: this.uniform } }, ...bindings],
            });
            cached = {
              bindings: bindings.map(({ binding, resource }) => ({
                binding,
                resource: (resource as GPUBufferBinding).buffer ? { ...resource } : resource,
              })),
              group,
            };
            this.groups.set(pipeline, cached);
          }
          group = cached.group;
        }
        const named = context.view?.clear?.color;
        const explicit = typeof named === 'string';
        const clearColor = options.clear ?? (named === false ? false : explicit || !context.view?.index),
          clearDepth = options.clearDepth ?? context.view?.clear?.depth ?? options.clear ?? true,
          tint = clearColorValue(explicit ? named : undefined);
        const mode = rectangleClear(
          context.view ? (viewport ?? scissor) : undefined,
          context.width,
          context.height,
          !!clearColor,
          !!clearDepth,
          options.colorAttachments?.length ?? 0,
        );
        const descriptor = (this.passDescriptor ??= {
          colorAttachments: [{ view: context.color, clearValue: defaultClear, loadOp: 'clear', storeOp: 'store' }],
          depthStencilAttachment: {
            view: context.depth,
            depthClearValue: 0,
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
          },
        });
        const attachments = descriptor.colorAttachments as GPURenderPassColorAttachment[],
          attachment = attachments[0],
          depth = descriptor.depthStencilAttachment!;
        attachment.view = context.color;
        attachment.loadOp = mode === 'attachment' && clearColor ? 'clear' : 'load';
        if (mode === 'attachment' && clearColor) attachment.clearValue = tint as GPUColor;
        depth.view = context.depth;
        depth.depthLoadOp = mode === 'attachment' && clearDepth ? 'clear' : 'load';
        attachment.resolveTarget = context.color === this.msaa && !this.holdColor ? this.resolveTarget : undefined;
        // Later scene passes load MSAA color and depth until the final resolve.
        attachment.storeOp = depth.depthStoreOp = attachment.resolveTarget && !this.preserveMSAA ? 'discard' : 'store';
        attachments.length = 1;
        if (options.colorAttachments) attachments.push(...options.colorAttachments);
        const stencil = context.descriptor.depthStencil!.format.includes('stencil');
        depth.stencilClearValue = stencil ? (options.stencilClear ?? 0) : undefined;
        depth.stencilLoadOp = stencil
          ? mode === 'draw'
            ? 'load'
            : clearColor || options.stencilClear !== undefined
              ? 'clear'
              : 'load'
          : undefined;
        depth.stencilStoreOp = stencil ? depth.depthStoreOp : undefined;
        const pass = context.encoder.beginRenderPass(descriptor);
        if (viewport) pass.setViewport(...viewport, 0, 1);
        if (scissor) pass.setScissorRect(...scissor);
        if (mode === 'draw')
          clearDraw(this.device, this.clears, pass, {
            formats: [context.format],
            depthFormat: context.descriptor.depthStencil!.format,
            writeDepth: !!clearDepth,
            samples: context.descriptor.multisample?.count,
            writeColor: !!clearColor,
            tint,
          });
        let current: GPURenderPipeline | undefined;
        // By index: an array iterator would be garbage every draw.
        for (let i = 0; i < drawBatches.length; i++) {
          const batch = drawBatches[i];
          if (batch.count && !batch.claimed) {
            const p = pipeline === this.pipeline && !bindings.length && !batch.mask ? this.culled : pipeline;
            if (p !== current) {
              current = p;
              pass.setPipeline(p);
              pass.setBindGroup(0, p === pipeline ? group : this.culledGroup);
            }
            const resource = this.resources.get(batch.geometry)!;
            if (resource.frame !== this.frameId) this.upload(batch, resource, this.frameId);
            const redirect = batch.redirect;
            pass.setVertexBuffer(0, resource.vertex);
            pass.setVertexBuffer(1, redirect?.instances ?? resource.instance);
            pass.setIndexBuffer(resource.index, 'uint32');
            if (redirect) pass.drawIndexedIndirect(redirect.args, 0);
            else if (options.indirect ?? context.indirect) {
              resource.indirect ??= this.device.createBuffer({
                size: 20,
                usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
              });
              resource.command ??= new Uint32Array([batch.geometry.indices.length, 0, 0, 0, 0]);
              if (resource.command[1] !== batch.count) {
                resource.command[1] = batch.count;
                this.device.queue.writeBuffer(resource.indirect, 0, resource.command as Uint32Array<ArrayBuffer>);
              }
              pass.drawIndexedIndirect(resource.indirect, 0);
            } else pass.drawIndexed(batch.geometry.indices.length, batch.count);
          }
        }
        pass.end();
      },
    } as Extract<PassContext, { backend: 'webgpu' }>);
    // Field by field: an object literal to Object.assign from would be garbage every frame.
    context.batches = drawBatches;
    context.draw = this.draw ??= context.draw;
    context.descriptor = this.descriptor;
    context.device = this.device;
    context.encoder = encoder;
    context.color = color;
    context.depth = depth;
    context.camera = camera;
    context.view = view && {
      id: view.id,
      camera,
      viewport: view.rect,
      scissor: view.scissor,
      index: view.index,
      count: view.count,
      clear: view.clear,
      layers: view.layers,
      target: view.target,
    };
    context.width = width;
    context.height = height;
    context.delta = delta;
    context.format = format;
    context.shader = wgsl;
    context.bindings = this.bindings;
    context.indirect = false;
    // Emptied by pop, which keeps the array's storage: length = 0 drops it, so the plugins' pushes reallocate it.
    while (this.bindings.length) this.bindings.pop();
    graph.execute(context);
    if (!this.deviceLost && !this.disposed) {
      if (this.preserveMSAA && !this.holdColor) {
        // One descriptor, updated: a new one every frame would be garbage.
        const resolve = (this.resolvePass ??= {
            colorAttachments: [{ view: color, loadOp: 'load', storeOp: 'store' }],
            depthStencilAttachment: { view: depth, depthLoadOp: 'load', stencilReadOnly: true },
          }),
          attachment = (resolve.colorAttachments as GPURenderPassColorAttachment[])[0];
        attachment.view = color;
        attachment.resolveTarget = this.resolveTarget;
        attachment.storeOp = stacked ? 'store' : 'discard';
        resolve.depthStencilAttachment!.view = depth;
        resolve.depthStencilAttachment!.depthStoreOp = keepDepth ? 'store' : 'discard';
        encoder.beginRenderPass(resolve).end();
      }
      // Once the last view into this target is drawn.
      if (caller && !direct && !stacked) this.resolveDepth(encoder, caller, samples);
      this.commands[0] = encoder.finish();
      this.device.queue.submit(this.commands);
    }
  }
  /** Colour (4x only) and depth attachments of one size and colour format: slot 0 the canvas, 1 target views. */
  private attach(slot: number, width: number, height: number, format: GPUTextureFormat): GPUTextureView[] {
    let set = this.attachments[slot];
    if (!set || set.width !== width || set.height !== height || set.format !== format) {
      for (const texture of set?.textures ?? []) texture.destroy();
      set = this.attachments[slot] = { width, height, format, textures: [], views: [] };
      for (const each of [format, this.descriptor.depthStencil!.format].slice(
        this.descriptor.multisample!.count === 4 ? 0 : 1,
      )) {
        const texture = this.device.createTexture({
          size: [width, height],
          sampleCount: this.descriptor.multisample!.count,
          format: each,
          // A target view's depth is read to write the caller's own depth texture.
          usage: GPUTextureUsage.RENDER_ATTACHMENT | (slot ? GPUTextureUsage.TEXTURE_BINDING : 0),
        });
        set.textures.push(texture);
        set.views.push(texture.createView());
      }
    }
    return set.views;
  }
  /**
   * Writes a target view's depth into the caller's depth texture of another sample count or format: a fullscreen pass
   * writes each pixel's nearest sample (the largest reversed-Z value, so overlays test against the visible surface).
   */
  private resolveDepth(encoder: GPUCommandEncoder, caller: GPUTexture, samples: number): void {
    const key = 'depth' + caller.format + samples,
      set = this.attachments[1]!;
    let pipeline = this.clears.get(key);
    if (!pipeline) {
      const module = this.device.createShaderModule({
        code: `@group(0) @binding(0) var d:texture_depth${samples > 1 ? '_multisampled' : ''}_2d;
@vertex fn v(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{return vec4f(f32(i&1u)*4-1,f32(i>>1u)*4-1,0,1);}
@fragment fn f(@builtin(position) p:vec4f)->@builtin(frag_depth) f32{var z=0.0;for(var i=0;i<${samples};i++){z=max(z,textureLoad(d,vec2i(p.xy),i));}return z;}`,
      });
      pipeline = this.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'v' },
        fragment: { module, entryPoint: 'f', targets: [] },
        depthStencil: { format: caller.format, depthWriteEnabled: true, depthCompare: 'always' },
      });
      this.clears.set(key, pipeline);
    }
    if (set.pipeline !== pipeline) {
      set.pipeline = pipeline;
      set.group = this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: set.textures.at(-1)!.createView({ aspect: 'depth-only' }) }],
      });
    }
    const pass = encoder.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: caller.createView(),
        depthClearValue: 0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        ...(caller.format.includes('stencil') && { stencilLoadOp: 'clear', stencilStoreOp: 'store' }),
      },
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, set.group!);
    pass.draw(3);
    pass.end();
  }
  /** Uploads the batch's changed instance range (all of it into a buffer not yet written), marked as `frame`'s. */
  private upload(batch: Batch, resource: { instance: GPUBuffer; frame: number }, frame: number): void {
    const start = resource.frame < 0 ? 0 : (batch.start ?? 0),
      end = Math.min(resource.frame < 0 ? 1 / 0 : (batch.end ?? 1 / 0), batch.count * 24);
    if (end > start)
      this.device.queue.writeBuffer(
        resource.instance,
        start * 4,
        batch.instances as Float32Array<ArrayBuffer>,
        start,
        end - start,
      );
    batch.start = 1 / 0;
    batch.end = 0;
    resource.frame = frame;
  }
  /**
   * The cached pipeline for shader text and key (draw variants, and pick pipelines with key ''), made on first use.
   * Shader source stays a separate field: hashing a concatenated key would flatten the whole string on every draw.
   */
  private variant(
    code: string,
    key: string,
    descriptor: (module: GPUShaderModule) => GPURenderPipelineDescriptor,
  ): GPURenderPipeline {
    for (let i = 0; i < this.variants.length; i++)
      if (this.variants[i][0] === code && this.variants[i][1] === key) return this.variants[i][2];
    if (this.variants.length >= 64) throw rangeError('Shader limit: 64', 'limits');
    const pipeline = this.device.createRenderPipeline(descriptor(this.device.createShaderModule({ code })));
    this.variants.push([code, key, pipeline]);
    return pipeline;
  }
  async pick(
    camera: Camera,
    lighting: Lighting,
    batches: Iterable<Batch>,
    graph: FrameGraph,
    x: number,
    y: number,
    span?: readonly [number, number],
  ): Promise<number | null> {
    if (this.deviceLost || this.disposed) return null;
    let color: GPUTexture | undefined,
      depth: GPUTexture | undefined,
      read: GPUBuffer | undefined,
      uniform: GPUBuffer | undefined;
    try {
      const device = this.device;
      color = device.createTexture({
        size: [1, 1],
        format: 'r32uint',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      depth = device.createTexture({ size: [1, 1], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT });
      read = device.createBuffer({ size: 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const matrix = camera.matrix.slice(),
        sw = span?.[0] ?? this.canvas.width,
        sh = span?.[1] ?? this.canvas.height,
        nx = (2 * (Math.floor(x) + 0.5)) / sw - 1,
        ny = 1 - (2 * (Math.floor(y) + 0.5)) / sh;
      for (let c = 0; c < 4; c++) {
        matrix[c * 4] = (camera.matrix[c * 4] - nx * camera.matrix[c * 4 + 3]) * sw;
        matrix[c * 4 + 1] = (camera.matrix[c * 4 + 1] - ny * camera.matrix[c * 4 + 3]) * sh;
      }
      const frame = new Float32Array(32);
      frame.set(matrix);
      frame.set(camera.position, 16);
      frame.set(lighting.direction, 20);
      frame.set(lighting.radiance, 24);
      frame.fill(1, 28, 31);
      if (lighting.ambient) frame.set(lighting.ambient, 28);
      uniform = device.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(uniform, 0, frame);
      // Reuse shader pass hooks for fragment clipping; caps and FX draws are suppressed.
      const encoder = device.createCommandEncoder(),
        context: Extract<PassContext, { backend: 'webgpu' }> = {
          backend: 'webgpu',
          device,
          encoder,
          color: color.createView(),
          depth: depth.createView(),
          camera,
          width: this.canvas.width,
          height: this.canvas.height,
          delta: 0,
          format: this.format,
          shader: wgsl,
          bindings: [],
          indirect: false,
          descriptor: this.descriptor,
          draw: () => {},
        };
      graph.prepare(context);
      const code = context.shader
        .replace('@location(3) material:vec4f', '@location(3) material:vec4f,@location(4) @interpolate(flat) id:u32')
        .replace('o.color=i.color.rgb', 'o.id=u32(i.factors.w);o.color=i.color.rgb')
        .replace('->@location(0) vec4f {', '->@location(0) u32 {')
        .replace(/let n=normalize\(i.normal\)[\s\S]*$/, 'return i.id;\n}');
      // Cached like draw variants: compiling a pick pipeline every call cost about 3 ms a pick.
      const pipeline = this.variant(code, '', (module) => ({
          ...this.descriptor,
          multisample: { count: 1 },
          vertex: { ...this.descriptor.vertex, module },
          fragment: { module, entryPoint: 'fragment', targets: [{ format: 'r32uint' }] },
          depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater-equal' },
        })),
        group = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: uniform } }, ...context.bindings],
        });
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          { view: color.createView(), clearValue: [4294967295, 0, 0, 0], loadOp: 'clear', storeOp: 'store' },
        ],
        depthStencilAttachment: {
          view: depth.createView(),
          depthClearValue: 0,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      for (const batch of batches)
        if (batch.count) {
          const r = this.resources.get(batch.geometry)!;
          // Only the changed range, as a frame does (rewriting every instance cost each pick 960 KB for 10k meshes); the
          // next frame then has nothing left to upload. Before the first frame, frameId - 1 is -1: upload all again.
          this.upload(batch, r, this.frameId - 1);
          pass.setVertexBuffer(0, r.vertex);
          pass.setVertexBuffer(1, r.instance);
          pass.setIndexBuffer(r.index, 'uint32');
          pass.drawIndexed(batch.geometry.indices.length, batch.count);
        }
      pass.end();
      if (this.deviceLost || this.disposed) return null;
      encoder.copyTextureToBuffer({ texture: color }, { buffer: read }, [1, 1]);
      device.queue.submit([encoder.finish()]);
      // A device lost during the readback rejects the map: nothing was picked.
      if (
        !(await read.mapAsync(GPUMapMode.READ).then(
          () => 1,
          (error) => {
            if (this.deviceLost || this.disposed) return 0;
            throw error;
          },
        ))
      )
        return null;
      const id = new Uint32Array(read.getMappedRange())[0];
      read.unmap();
      return id === 4294967295 ? null : id;
    } finally {
      uniform?.destroy();
      color?.destroy();
      depth?.destroy();
      read?.destroy();
    }
  }
  dispose(unconfigure = true): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const geometry of this.resources.keys()) this.remove(geometry);
    for (const set of this.attachments) for (const texture of set?.textures ?? []) texture.destroy();
    this.uniform.destroy();
    if (unconfigure) this.context.unconfigure();
    this.device.destroy();
  }
}
