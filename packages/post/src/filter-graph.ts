/// <reference lib="esnext.disposable" preserve="true" />
// The image filter graph runtime: a graph run on images, video or a camera on a bare GPUDevice, with no engine or scene.
// WebGPU, or the WebGL2 compatibility layer once it is installed.
import { copyExternal } from '../../shared/copy-external.js';
import { margoError } from '../../shared/errors.js';
import {
  filterValue,
  planFilterGraph,
  readFilterValue,
  type FilterBlock,
  type FilterCell,
  type FilterGraph,
  type FilterPass,
  type FilterPlan,
  type FilterValue,
} from './filter-graph-plan.js';

export { filterBlocks } from './filter-graph-blocks.js';
export {
  parseFilterBlock,
  parseFilterGraph,
  planFilterGraph,
  type FilterBlock,
  type FilterCell,
  type FilterConst,
  type FilterGraph,
  type FilterImageAccess,
  type FilterInput,
  type FilterNode,
  type FilterParam,
  type FilterParamType,
  type FilterPass,
  type FilterPlan,
  type FilterPlanOptions,
  type FilterValue,
} from './filter-graph-plan.js';

/** Options of {@link ImageFilterGraph.create}. */
export interface ImageFilterGraphOptions {
  /** Device to run on, such as `engine.gpu`. Default one the runtime requests, owns and restores after a loss. */
  device?: GPUDevice;
  /** Canvas shown on, configured with premultiplied alpha. Default none: the result is {@link ImageFilterGraph.output}. */
  canvas?: HTMLCanvasElement | OffscreenCanvas;
  /**
   * Caller's texture drawn into (straight alpha, `RENDER_ATTACHMENT` usage) instead of a canvas or own output. It belongs
   * to `device` and is never destroyed or moved to another device here: after a loss {@link ImageFilterGraph.restore}
   * takes the new device's texture as its `target`.
   */
  target?: GPUTexture;
  /** Output [width, height]. Default the target's, else the canvas's, else the first image input's size, each frame. */
  size?: readonly [number, number];
  /** Format of the runtime's own output texture. Default `'rgba8unorm'`. */
  format?: GPUTextureFormat;
  /** Fuse blocks into as few passes as possible. Default true. */
  optimize?: boolean;
  /** Custom block types beside the built-ins and the graph's own. */
  blocks?: readonly FilterBlock[];
  /** Cancels creation. */
  signal?: AbortSignal;
  /** Receives a failed automatic restore after a device loss. Default `reportError`. */
  onError?: (error: unknown) => void;
}
/** An in-memory image: anything `copyExternalImageToTexture` takes, or a filterable GPUTexture on the same device. */
export type FilterImage =
  | ImageBitmap
  | ImageData
  | HTMLImageElement
  | HTMLVideoElement
  | HTMLCanvasElement
  | OffscreenCanvas
  | VideoFrame
  | GPUTexture;
/** What {@link ImageFilterGraph.load} takes. */
export type FilterSource = string | URL | Blob | MediaStream | { camera: boolean | MediaTrackConstraints };
/** Options of {@link ImageFilterGraph.load}. */
export interface FilterLoadOptions {
  signal?: AbortSignal;
  /** How to read a URL. Default `'video'` for .mp4, .webm, .ogv, .mov and .m4v, else `'image'`. */
  kind?: 'image' | 'video';
  /** Media devices a camera is asked from. Default `navigator.mediaDevices`. */
  mediaDevices?: Pick<MediaDevices, 'getUserMedia'>;
}

const HELP = '; see https://margoengine.com/errors#filter-graph';
const fault = (code: Parameters<typeof margoError>[0], message: string) =>
  margoError(code, `ImageFilterGraph ${message}${HELP}`);

interface Input {
  name: string;
  /** What is uploaded; absent for a borrowed texture or an empty input. */
  source?: Exclude<FilterImage, GPUTexture>;
  /** The runtime's upload of `source`, with the copy's arguments, kept so a live source allocates nothing. */
  texture?: GPUTexture;
  copy?: [GPUCopyExternalImageSourceInfo, GPUCopyExternalImageDestInfo, [number, number]];
  /** The caller's texture, read in place. */
  borrowed?: GPUTexture;
  view?: GPUTextureView;
  /** Re-uploaded every frame: video and canvas sources. */
  live: boolean;
  /** Frees what `load` made for the source. */
  release?: () => void;
  generation: number;
}
interface Draw {
  pass: FilterPass;
  pipeline: GPURenderPipeline;
  layout: GPUBindGroupLayout;
  buffer: GPUBuffer;
  data: Float32Array<ArrayBuffer>;
  dirty: boolean;
  group?: GPUBindGroup;
  version: number;
  attachment: GPURenderPassColorAttachment;
  descriptor: GPURenderPassDescriptor;
}

const dimension = (source: object, index: 0 | 1): number => {
  const s = source as Record<string, number | undefined>;
  return (
    (index
      ? (s.videoHeight ?? s.displayHeight ?? s.naturalHeight ?? s.height)
      : (s.videoWidth ?? s.displayWidth ?? s.naturalWidth ?? s.width)) ?? 0
  );
};
const isTexture = (source: object): source is GPUTexture => 'createView' in source;
/** `pending`, or the signal's reason if it aborts first. */
function abortable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

/** A muted, looping, playing video element on a URL or a stream, once it has a frame. */
async function playVideo(from: string | MediaStream, release: (() => void)[], signal?: AbortSignal) {
  if (typeof document === 'undefined')
    throw fault('unsupported', 'video needs a page; in a worker pass VideoFrames to setImage');
  const video = document.createElement('video');
  video.muted = video.loop = video.playsInline = true;
  release.push(() => {
    video.pause();
    video.srcObject = null;
    video.removeAttribute('src');
    video.load();
  });
  if (typeof from === 'string') {
    video.crossOrigin = 'anonymous';
    video.src = from;
  } else video.srcObject = from;
  const frame = new Promise<void>((resolve, reject) => {
    if (video.readyState >= 2) return resolve();
    video.addEventListener('loadeddata', () => resolve(), { once: true });
    video.addEventListener('error', () => reject(fault('failed', `video did not load (${video.error?.message})`)), {
      once: true,
    });
  });
  await abortable(Promise.all([video.play(), frame]), signal);
  return video;
}

/**
 * A running filter graph. Make one with {@link ImageFilterGraph.create}; give it images with `setImage` or `load`,
 * change values with `set`, draw with `render` or `start`, and `dispose` it.
 */
export class ImageFilterGraph {
  private gpu!: GPUDevice;
  private readonly plan: FilterPlan;
  private draws: Draw[] = [];
  private readonly inputs = new Map<string, Input>();
  /** Inputs the output depends on, in graph order. */
  private readonly used: Input[];
  private readonly targets = new Map<string, { draw: Draw; offset: number }[]>();
  private sampler?: GPUSampler;
  private context?: GPUCanvasContext;
  private textures: GPUTexture[] = [];
  private views: GPUTextureView[] = [];
  private result?: GPUTexture;
  private resultView?: GPUTextureView;
  private fixed?: readonly [number, number];
  private outWidth = 0;
  private outHeight = 0;
  private clock = 0;
  private version = 1;
  private epoch = 0;
  private built = false;
  private disposed = false;
  private handle = 0;
  private readonly scratch = new Float32Array(4);
  private readonly commands: GPUCommandBuffer[] = [];
  private readonly changed = new Set<string>();

  private constructor(
    private readonly graph: FilterGraph,
    plan: FilterPlan,
    private readonly options: ImageFilterGraphOptions,
    private readonly owned: boolean,
  ) {
    this.plan = plan;
    for (const [name, input] of Object.entries(graph.inputs ?? {}))
      if (input.type === 'image') this.inputs.set(name, { name, live: false, generation: 0 });
    this.used = plan.images.map((name) => this.inputs.get(name)!);
    this.fixed = options.size && this.checkSize(options.size);
  }
  /**
   * Compiles a filter graph and returns its runtime. No engine or scene is needed: without `device` it requests its own,
   * which on a page without WebGPU is the WebGL2 compatibility layer's once that is installed.
   * @throws TypeError or RangeError for a bad graph or option; MargoError `unsupported` or `failed` (a block's WGSL did
   * not compile); the signal's reason when aborted.
   */
  static async create(graph: FilterGraph, options: ImageFilterGraphOptions = {}): Promise<ImageFilterGraph> {
    const { canvas, target, signal, blocks, optimize } = options;
    signal?.throwIfAborted();
    if (target && (canvas || options.size))
      throw new TypeError(`ImageFilterGraph draws a target at its own size; pass no canvas or size with it${HELP}`);
    const plan = (maxTextures?: number) =>
      planFilterGraph(graph, { blocks, optimize, maxTextures, premultiply: !!canvas });
    // A bad graph is refused before a device is asked for.
    plan();
    const owned = !options.device,
      device = options.device ?? (await requestDevice(signal));
    let runtime: ImageFilterGraph | undefined;
    try {
      const compiled = plan(device.limits.maxSampledTexturesPerShaderStage);
      runtime = new ImageFilterGraph(JSON.parse(JSON.stringify(graph)), compiled, { ...options }, owned);
      await runtime.build(device, signal);
      signal?.throwIfAborted();
      runtime.watch();
      return runtime;
    } catch (error) {
      if (runtime) runtime.dispose();
      else if (owned) device.destroy();
      throw error;
    }
  }

  /** The device drawn on; a new one after a restore. */
  get device(): GPUDevice {
    return this.gpu;
  }
  /** The passes drawn each frame, in order: what the optimizer fused. */
  get passes(): readonly FilterPass[] {
    return this.plan.passes;
  }
  /** Intermediate textures the passes share. */
  get intermediates(): number {
    return this.plan.textures;
  }
  /** Names `set` and `get` take: value inputs, and `node.param` / `node.enabled` of nodes holding their own value. */
  get parameters(): string[] {
    return [...this.plan.cells.keys()].filter((name) => !/[/()]/.test(name));
  }
  /** Output width of the last frame; 0 before the first. */
  get width(): number {
    return this.outWidth;
  }
  /** Output height of the last frame; 0 before the first. */
  get height(): number {
    return this.outHeight;
  }
  /** The output texture when there is no canvas: yours (`target`) or the runtime's, made by the first frame. */
  get output(): GPUTexture | undefined {
    return this.options.target ?? this.result;
  }

  /** Makes every GPU object on `device`. */
  private async build(device: GPUDevice, signal?: AbortSignal): Promise<void> {
    this.gpu = device;
    const epoch = ++this.epoch,
      { canvas, target, format = 'rgba8unorm' } = this.options;
    let final: GPUTextureFormat = target?.format ?? format;
    if (canvas) {
      const context = canvas.getContext('webgpu') as GPUCanvasContext | null;
      if (!context) throw fault('unsupported', 'canvas gives no webgpu context (does it already have another?)');
      final = navigator.gpu.getPreferredCanvasFormat();
      context.configure({ device, format: final, alphaMode: 'premultiplied' });
      this.context = context;
    }
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    device.pushErrorScope('validation');
    const pending = this.plan.passes.map(async (pass, i) => {
      const layout = device.createBindGroupLayout({
          entries: [
            { binding: 0, visibility: 2, buffer: { type: 'uniform' } },
            { binding: 1, visibility: 2, sampler: {} },
            ...pass.reads.map((_, k) => ({ binding: k + 2, visibility: 2, texture: {} })),
          ],
        }),
        module = device.createShaderModule({ code: pass.shader });
      try {
        const pipeline = await device.createRenderPipelineAsync({
          layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
          vertex: { module, entryPoint: 'vertex' },
          fragment: {
            module,
            entryPoint: 'fragment',
            targets: [{ format: i === this.plan.passes.length - 1 ? final : 'rgba16float' }],
          },
        });
        return { layout, pipeline };
      } catch (error) {
        throw fault('failed', `blocks ${pass.blocks.join(', ')} did not compile: ${(error as Error).message}`);
      }
    });
    // Compile errors reach the pipeline promises; the scope keeps them off the device's uncaptured-error handler.
    const scope = device.popErrorScope();
    const made = await abortable(Promise.all(pending), signal);
    await scope;
    if (this.disposed || epoch !== this.epoch) return;
    this.targets.clear();
    this.draws = made.map(({ layout, pipeline }, i) => {
      const pass = this.plan.passes[i],
        data = new Float32Array(pass.vectors * 4),
        attachment: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'clear', storeOp: 'store' },
        draw: Draw = {
          pass,
          pipeline,
          layout,
          buffer: device.createBuffer({ size: data.byteLength, usage: 0x40 | 0x8 }),
          data,
          dirty: true,
          version: 0,
          attachment,
          descriptor: { colorAttachments: [attachment] },
        };
      for (const { name, vector } of pass.values) {
        data.set(this.plan.cells.get(name)!.value, vector * 4);
        let list = this.targets.get(name);
        if (!list) this.targets.set(name, (list = []));
        list.push({ draw, offset: vector * 4 });
      }
      return draw;
    });
    this.outWidth = this.outHeight = 0;
    this.built = true;
  }

  private alive(): void {
    if (this.disposed) throw fault('disposed', 'runtime is disposed; create another');
  }
  private checkSize(size: readonly [number, number]): readonly [number, number] {
    if (!Array.isArray(size) || size.length !== 2 || !size.every((v) => Number.isInteger(v) && v >= 1 && v <= 16384))
      throw new RangeError(`ImageFilterGraph size must be [width, height] in whole texels from 1 to 16384${HELP}`);
    return [size[0], size[1]];
  }
  private input(name: string): Input {
    const input = this.inputs.get(name);
    if (!input)
      throw new TypeError(
        `ImageFilterGraph has no image input ${name}; it has ${[...this.inputs.keys()].join(', ') || 'none'}${HELP}`,
      );
    return input;
  }
  private empty(input: Input): void {
    input.texture?.destroy();
    input.release?.();
    input.texture = input.view = input.source = input.release = input.copy = input.borrowed = undefined;
    input.live = false;
    this.version++;
  }
  private upload(input: Input): void {
    const source = input.source!;
    if ('readyState' in source && source.readyState < 2) return;
    const width = dimension(source, 0),
      height = dimension(source, 1);
    // An image not yet decoded, an unsized canvas or a closed VideoFrame has no pixels.
    if (!width || !height) return;
    if (input.texture?.width !== width || input.texture.height !== height) {
      const limit = this.gpu.limits.maxTextureDimension2D;
      if (width > limit || height > limit)
        throw new RangeError(`ImageFilterGraph image ${input.name} is above this device's ${limit} texel limit; reduce the image to fit${HELP}`);
      input.texture?.destroy();
      // COPY_DST, TEXTURE_BINDING and RENDER_ATTACHMENT, which an external image copy needs.
      input.texture = this.gpu.createTexture({ size: [width, height], format: 'rgba8unorm', usage: 0x2 | 0x4 | 0x10 });
      input.view = input.texture.createView();
      input.copy = [
        { source: source as GPUCopyExternalImageSource },
        { texture: input.texture, premultipliedAlpha: false },
        [width, height],
      ];
      this.version++;
    }
    const copy = input.copy!;
    copy[0].source = source as GPUCopyExternalImageSource;
    copyExternal(this.gpu, copy[0], copy[1], copy[2]);
  }
  private accept(input: Input, source: FilterImage): void {
    if (!source || typeof source !== 'object' || 'getVideoTracks' in source)
      throw new TypeError(
        `ImageFilterGraph image ${input.name} takes an image, video, canvas, frame or texture; use load${HELP}`,
      );
    if (isTexture(source)) {
      if (/32float|uint|sint|depth|stencil/.test(source.format))
        throw new TypeError(
          `ImageFilterGraph image ${input.name} needs a filterable colour texture, not ${source.format}${HELP}`,
        );
      input.borrowed = source;
      input.view = source.createView();
      this.version++;
      return;
    }
    input.source = source;
    input.live = 'readyState' in source || 'getContext' in source;
    try {
      this.upload(input);
    } catch (error) {
      this.empty(input);
      throw error;
    }
  }

  /**
   * Gives an image input its pixels now. Video and canvas sources are read again every frame; other images are copied
   * once (call again for new pixels) and must stay open for a device restore. A texture is read in place. `null`
   * empties the input; nothing is drawn while one the output needs is empty.
   */
  setImage(name: string, source: FilterImage | null): void {
    this.alive();
    const input = this.input(name);
    input.generation++;
    // A new picture of the same size (a VideoFrame each frame) goes into the same texture: nothing is remade.
    if (
      source &&
      input.source &&
      !input.release &&
      !isTexture(source) &&
      !('getVideoTracks' in source) &&
      dimension(source, 0) === input.texture?.width &&
      dimension(source, 1) === input.texture.height
    ) {
      input.source = source;
      input.live = 'readyState' in source || 'getContext' in source;
      this.upload(input);
      return;
    }
    this.empty(input);
    if (source !== null) this.accept(input, source);
  }
  /**
   * Gives an image input a URL, Blob, MediaStream or the camera, which the runtime opens and later releases (a stream you
   * pass stays yours). The input keeps its old image until the new one is ready; a later `load` or `setImage` on it wins.
   * @throws MargoError `unsupported`, `failed`, `disposed` or `state` (superseded); the signal's reason when aborted.
   */
  async load(name: string, source: FilterSource, options: FilterLoadOptions = {}): Promise<void> {
    this.alive();
    const input = this.input(name),
      generation = ++input.generation,
      { signal, kind, mediaDevices = globalThis.navigator?.mediaDevices } = options,
      release: (() => void)[] = [],
      free = () => {
        while (release.length) release.pop()!();
      };
    signal?.throwIfAborted();
    try {
      let image: ImageBitmap | HTMLVideoElement;
      if (typeof source === 'string' || source instanceof URL || source instanceof Blob) {
        const blob = source instanceof Blob ? source : undefined,
          url = blob ? undefined : String(source),
          video = kind
            ? kind === 'video'
            : blob
              ? blob.type.startsWith('video/')
              : /\.(mp4|webm|ogv|mov|m4v)([?#]|$)/i.test(url!);
        if (video) {
          let address = url;
          if (blob) {
            address = URL.createObjectURL(blob);
            release.push(() => URL.revokeObjectURL(address!));
          }
          image = await playVideo(address!, release, signal);
        } else {
          let data = blob;
          if (!data) {
            const response = await fetch(url!, { signal });
            if (!response.ok) throw fault('failed', `image request answered ${response.status}: ${url}`);
            data = await response.blob();
          }
          const bitmap = await createImageBitmap(data, { premultiplyAlpha: 'none' });
          release.push(() => bitmap.close());
          image = bitmap;
        }
      } else if ('camera' in source) {
        if (typeof mediaDevices?.getUserMedia !== 'function')
          throw fault('unsupported', 'camera needs getUserMedia; serve the page over https');
        const video = source.camera === true ? { facingMode: 'user' } : source.camera;
        const asked = mediaDevices.getUserMedia({ video, audio: false });
        const halt = (stream: MediaStream) => stream.getTracks().forEach((track) => track.stop());
        // A camera granted after an abort is closed at once.
        const stream = await abortable(asked, signal).catch((error) => {
          asked.then(halt, () => {});
          throw error;
        });
        release.push(() => halt(stream));
        image = await playVideo(stream, release, signal);
      } else image = await playVideo(source, release, signal);
      signal?.throwIfAborted();
      this.alive();
      if (generation !== input.generation) throw fault('state', `load of ${name} was superseded by a newer image`);
      this.empty(input);
      input.release = free;
      this.accept(input, image);
    } catch (error) {
      free();
      throw error;
    }
  }

  /**
   * Changes a live value (see {@link parameters}) with no rebuild and, for numbers and arrays, no allocation.
   * @throws TypeError or RangeError for an unknown name or a value of the wrong type or out of bounds.
   */
  set(name: string, value: FilterValue): void {
    this.alive();
    const cell = this.cell(name);
    filterValue(cell, value, this.scratch, name);
    cell.value.set(this.scratch);
    this.changed.add(name);
    const list = this.targets.get(name);
    if (list)
      for (let i = 0; i < list.length; i++) {
        list[i].draw.data.set(this.scratch, list[i].offset);
        list[i].draw.dirty = true;
      }
  }
  private cell(name: string): FilterCell {
    const cell = /[/()]/.test(name) ? undefined : this.plan.cells.get(name);
    if (!cell)
      throw new TypeError(`ImageFilterGraph has no value ${name}; it has ${this.parameters.join(', ')}${HELP}`);
    return cell;
  }
  /** A live value as it is now. */
  get(name: string): number | boolean | number[] {
    return readFilterValue(this.cell(name));
  }
  /** The graph with every value changed by `set` written into it: `JSON.stringify` it to save. */
  save(): FilterGraph {
    const graph = JSON.parse(JSON.stringify(this.graph)) as FilterGraph;
    for (const name of this.changed) {
      const value = this.get(name),
        dot = name.indexOf('.');
      if (dot < 0) (graph.inputs![name] as { default: FilterValue }).default = value;
      else {
        const node = graph.nodes!.find((n) => n.id === name.slice(0, dot))!,
          param = name.slice(dot + 1);
        if (param === 'enabled') node.enabled = value as boolean;
        else node.params = { ...node.params, [param]: value };
      }
    }
    return graph;
  }
  /** Fixes the output size, or with no argument follows the target, canvas or first image again. */
  resize(width?: number, height?: number): void {
    this.alive();
    if (this.options.target) throw fault('state', 'draws its target at that size; resize cannot change it');
    this.fixed = width === undefined ? undefined : this.checkSize([width, height!]);
    this.outWidth = this.outHeight = 0;
  }

  private allocate(width: number, height: number): void {
    const { canvas, target, format = 'rgba8unorm' } = this.options,
      limit = this.gpu.limits.maxTextureDimension2D;
    for (const texture of this.textures) texture.destroy();
    this.textures.length = this.views.length = 0;
    this.result?.destroy();
    this.result = this.resultView = undefined;
    for (const draw of this.draws) {
      const { scale, texture } = draw.pass,
        w = Math.max(1, Math.round(width * scale)),
        h = Math.max(1, Math.round(height * scale));
      if (w > limit || h > limit)
        throw new RangeError(`ImageFilterGraph pass of ${w} x ${h} is above this device's ${limit} texel limit${HELP}`);
      draw.data[0] = w;
      draw.data[1] = h;
      draw.data[4] = width;
      draw.data[5] = height;
      draw.dirty = true;
      if (texture >= 0 && !this.textures[texture]) {
        // TEXTURE_BINDING and RENDER_ATTACHMENT.
        this.textures[texture] = this.gpu.createTexture({ size: [w, h], format: 'rgba16float', usage: 0x4 | 0x10 });
        this.views[texture] = this.textures[texture].createView();
      }
    }
    if (canvas) {
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
    } else if (target) this.resultView = target.createView();
    else {
      // COPY_SRC, TEXTURE_BINDING and RENDER_ATTACHMENT.
      this.result = this.gpu.createTexture({ size: [width, height], format, usage: 0x1 | 0x4 | 0x10 });
      this.resultView = this.result.createView();
    }
    this.outWidth = width;
    this.outHeight = height;
    this.version++;
  }

  /**
   * Draws one frame. `time` (seconds) is what `'$time'` reads; it keeps its last value when left out (0 at first).
   * Returns false, drawing nothing, while an image the output needs is empty or not ready, or a restore is running.
   * @throws MargoError `state` when no size is known; RangeError for a bad time or an oversized output.
   */
  render(frame?: { time?: number }): boolean {
    this.alive();
    const time = frame?.time;
    if (time !== undefined && !Number.isFinite(time))
      throw new RangeError(`ImageFilterGraph time must be finite seconds${HELP}`);
    if (!this.built) return false;
    if (time !== undefined && time !== this.clock) {
      this.clock = time;
      for (let i = 0; i < this.draws.length; i++) this.draws[i].dirty = true;
    }
    for (let i = 0; i < this.used.length; i++) {
      const input = this.used[i];
      if (input.live) this.upload(input);
      if (!input.view) return false;
    }
    const { canvas, target } = this.options,
      first = this.fixed ? undefined : (target ?? canvas);
    let width: number, height: number;
    if (this.fixed) {
      width = this.fixed[0];
      height = this.fixed[1];
    } else if (first) {
      width = first.width;
      height = first.height;
    } else {
      if (!this.used.length) throw fault('state', 'has no image to take a size from; pass size');
      const sized = (this.used[0].texture ?? this.used[0].borrowed)!;
      width = sized.width;
      height = sized.height;
    }
    if (!width || !height) return false;
    if (width !== this.outWidth || height !== this.outHeight) this.allocate(width, height);
    const device = this.gpu,
      encoder = device.createCommandEncoder();
    for (let i = 0; i < this.draws.length; i++) {
      const draw = this.draws[i],
        { reads, texture } = draw.pass;
      if (draw.dirty) {
        draw.data[2] = this.clock;
        device.queue.writeBuffer(draw.buffer, 0, draw.data);
        draw.dirty = false;
      }
      if (draw.version !== this.version) {
        draw.group = device.createBindGroup({
          layout: draw.layout,
          entries: [
            { binding: 0, resource: { buffer: draw.buffer } },
            { binding: 1, resource: this.sampler! },
            ...reads.map((read, k) => ({
              binding: k + 2,
              resource:
                typeof read === 'string' ? this.inputs.get(read)!.view! : this.views[this.draws[read].pass.texture],
            })),
          ],
        });
        draw.version = this.version;
      }
      draw.attachment.view =
        texture >= 0 ? this.views[texture] : canvas ? this.context!.getCurrentTexture().createView() : this.resultView!;
      const pass = encoder.beginRenderPass(draw.descriptor);
      pass.setPipeline(draw.pipeline);
      pass.setBindGroup(0, draw.group!);
      pass.draw(3);
      pass.end();
    }
    this.commands[0] = encoder.finish();
    device.queue.submit(this.commands);
    return true;
  }
  /** Renders every animation frame, with `time` counting from this call, until `stop` or `dispose`. */
  start(): void {
    this.alive();
    if (this.handle) return;
    let from: number | undefined;
    const frame = { time: 0 };
    const tick = (now: number) => {
      from ??= now;
      frame.time = (now - from) / 1000;
      // Asked for first, so a render may call stop; a render that throws ends the loop.
      this.handle = requestAnimationFrame(tick);
      try {
        this.render(frame);
      } catch (error) {
        this.stop();
        throw error;
      }
    };
    this.handle = requestAnimationFrame(tick);
  }
  /** Stops the loop `start` runs. */
  stop(): void {
    if (this.handle) cancelAnimationFrame(this.handle);
    this.handle = 0;
  }
  /**
   * The runtime's output (or a `target` with `COPY_SRC`) as straight-alpha RGBA8 pixels of the last frame.
   * @throws MargoError `state` before a frame or on a canvas; `unsupported` for formats other than rgba8 and bgra8.
   */
  async read(
    options: { signal?: AbortSignal } = {},
  ): Promise<{ width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> }> {
    this.alive();
    options.signal?.throwIfAborted();
    const output = this.output;
    if (!output || !this.outWidth || !this.built) throw fault('state', 'read needs a rendered frame and no canvas');
    if (!/^(rgba|bgra)8unorm$/.test(output.format))
      throw fault('unsupported', `read takes rgba8unorm or bgra8unorm output, not ${output.format}`);
    const { width, height, format } = output,
      row = Math.ceil((width * 4) / 256) * 256,
      // COPY_DST and MAP_READ.
      buffer = this.gpu.createBuffer({ size: row * height, usage: 0x8 | 0x1 });
    try {
      const encoder = this.gpu.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: output }, { buffer, bytesPerRow: row }, [width, height]);
      this.gpu.queue.submit([encoder.finish()]);
      await abortable(buffer.mapAsync(1), options.signal);
      const mapped = new Uint8Array(buffer.getMappedRange()),
        data = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++) data.set(mapped.subarray(y * row, y * row + width * 4), y * width * 4);
      if (format === 'bgra8unorm')
        for (let i = 0; i < data.length; i += 4) {
          const blue = data[i];
          data[i] = data[i + 2];
          data[i + 2] = blue;
        }
      return { width, height, data };
    } finally {
      buffer.destroy();
    }
  }

  private release(): void {
    this.built = false;
    for (const draw of this.draws) draw.buffer.destroy();
    for (const texture of this.textures) texture.destroy();
    this.result?.destroy();
    this.draws = [];
    this.targets.clear();
    this.textures = [];
    this.views = [];
    this.result = this.resultView = this.sampler = undefined;
    this.version++;
  }
  /**
   * Rebuilds after a device loss: on `device` for a runtime that was given one, else on a freshly requested device (an
   * owned device does this by itself). Images are copied again; borrowed textures and closed frames belong to the old
   * device, so those inputs empty. A graph made with a `target` draws into `options.target` from then on: the old
   * one belonged to the lost device.
   * @throws MargoError `state` when `device` is given to an owner or left out otherwise, or when `options.target` is
   * missing for a graph that has a target or given to one that has none.
   */
  async restore(device?: GPUDevice, options: { signal?: AbortSignal; target?: GPUTexture } = {}): Promise<void> {
    this.alive();
    options.signal?.throwIfAborted();
    if (!device !== this.owned)
      throw fault('state', this.owned ? 'owns its device; call restore() with none' : 'restore needs the new device');
    if (!this.options.target !== !options.target)
      throw fault(
        'state',
        this.options.target
          ? "draws a target that belongs to the lost device; pass the new device's texture as restore(device, { target })"
          : 'has no target; restore it without one',
      );
    if (options.target) this.options.target = options.target;
    this.release();
    const epoch = ++this.epoch;
    if (this.owned) this.gpu.destroy();
    const next = device ?? (await requestDevice(options.signal));
    if (this.disposed || epoch !== this.epoch) {
      if (this.owned) next.destroy();
      return;
    }
    for (const input of this.inputs.values()) {
      input.texture?.destroy();
      input.texture = input.view = input.copy = input.borrowed = undefined;
    }
    await this.build(next, options.signal);
    if (this.disposed || this.gpu !== next || !this.built) return;
    for (const input of this.inputs.values()) if (input.source) this.upload(input);
    this.watch();
  }
  /** Restores an owned device when it is lost. */
  private watch(): void {
    if (!this.owned) return;
    const device = this.gpu;
    device.lost.then((info) => {
      if (this.disposed || this.gpu !== device || info.reason === 'destroyed') return;
      this.restore().catch(this.options.onError ?? ((error) => (globalThis.reportError ?? console.error)(error)));
    });
  }
  /** Stops, frees every GPU object and anything `load` opened, and destroys an owned device. Safe to repeat. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.release();
    for (const input of this.inputs.values()) this.empty(input);
    this.context?.unconfigure();
    this.context = undefined;
    if (this.owned) this.gpu?.destroy();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

async function newDevice(): Promise<GPUDevice> {
  const adapter = await globalThis.navigator?.gpu?.requestAdapter();
  if (!adapter)
    throw fault('unsupported', 'needs WebGPU, or install() from @margoengine/webgl2-compat before creating it');
  return adapter.requestDevice();
}
async function requestDevice(signal?: AbortSignal): Promise<GPUDevice> {
  const pending = newDevice();
  try {
    return await abortable(pending, signal);
  } catch (error) {
    // A device granted after an abort is destroyed at once.
    pending.then(
      (device) => device.destroy(),
      () => {},
    );
    throw error;
  }
}
