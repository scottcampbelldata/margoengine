/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type FrameGraph } from '@margoengine/core/extension';
import { group, render } from '../../shared/gpu.js';
import { applyView } from '../../shared/view-rect.js';
import { linearHdr } from '../../shared/hdr-format.js';
import { MargoError } from '@margoengine/math/errors';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
/** Options for `Video`. */
export interface VideoOptions {
  /** Where the video is drawn, as `[x, y, width, height]` in 0 to 1 screen fractions. Default `[0, 0, 1, 1]` (full screen). */
  rect?: readonly [number, number, number, number];
  /**
   * The part of the picture drawn, as `[x, y, width, height]` in 0 to 1 fractions of the picture from its top left: a
   * crop. Default `[0, 0, 1, 1]` (the whole picture). `objectFit` gives the rect and source of a CSS-style fit.
   */
  source?: readonly [number, number, number, number];
  /** Routes a `<video>` element's sound through this context and enables `sampleFrequency()`. Default: no analysis. */
  audio?: AudioContext;
  /** Analyser size: a power of two from 32 to 32768; `frequencies` holds half as many bins. Default 2048. */
  fftSize?: number;
  /** Called with the bins each time `sampleFrequency()` runs. */
  onFrequency?: (bins: Uint8Array) => void;
}
const sources = new WeakMap<
  HTMLMediaElement,
  { context: AudioContext; node: MediaElementAudioSourceNode; users: number }
>();
// `hdr`: a linear HDR target (every float format, as under post-processing) holds light, not display values, so the
// frame's sRGB values are decoded there (IEC 61966-2-1 curve, as videoMaterial and HTMLTexture do). Before batch 132b
// (2026-11-13) they were written as linear light, so a mid-grey 0.5 drew as 0.5 instead of 0.214 and tone mapping
// washed the video out.
const shader = (hdr: boolean): string => `
const hdr=${hdr};
struct Vertex {@builtin(position) position:vec4f,@location(0) uv:vec2f}
@group(0) @binding(0) var video:texture_external;
@group(0) @binding(1) var linear:sampler;
struct Rects {screen:vec4f,crop:vec4f}
@group(0) @binding(2) var<uniform> rect:Rects;
@vertex fn vertex(@builtin(vertex_index) index:u32)->Vertex{
 let p=array<vec2f,6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1))[index];
 let screen=rect.screen.xy+p*rect.screen.zw;
 return Vertex(vec4f(screen.x*2.0-1.0,1.0-screen.y*2.0,0,1),rect.crop.xy+p*rect.crop.zw);
}
@fragment fn fragment(i:Vertex)->@location(0) vec4f{
 let c=textureSampleBaseClampToEdge(video,linear,i.uv);
 if(hdr){return vec4f(select(pow((max(c.rgb,vec3f(0))+.055)/1.055,vec3f(2.4)),c.rgb/12.92,c.rgb<=vec3f(.04045)),c.a);}
 return c;
}
`;
type Rect = readonly [number, number, number, number];
/** True for `[x, y, width, height]` of finite numbers inside 0 to 1 with a positive size. */
const inside = (r: unknown): r is Rect =>
  Array.isArray(r) &&
  r.length === 4 &&
  r.every((v) => Number.isFinite(v) && v >= 0 && v <= 1) &&
  r[2] > 0 &&
  r[3] > 0 &&
  r[0] + r[2] <= 1 + 1e-9 &&
  r[1] + r[3] <= 1 + 1e-9;
/** How `objectFit` fits a picture into a box, as CSS `object-fit` does (W3C CSS Images Module Level 3, section 5.5). */
export type ObjectFit = 'fill' | 'contain' | 'cover' | 'none' | 'scale-down';
/**
 * The `rect` and `source` that draw a `picture` (width, height in pixels) into `box` (`[x, y, width, height]` in 0 to 1
 * fractions of a `canvas` of width x height pixels) the way CSS `object-fit` does, centred (`object-position: 50% 50%`):
 * `'contain'` shrinks the rect to the picture's aspect, `'cover'` crops the source to the box's, `'fill'` stretches,
 * `'none'` draws pixels 1:1 (cropped where the box is smaller), `'scale-down'` is the smaller of `'none'` and
 * `'contain'`. Pass both to `new Video(source, {rect, source})` or `setRect` and `setSource`.
 */
export function objectFit(
  fit: ObjectFit,
  picture: readonly [number, number],
  canvas: readonly [number, number],
  box: Rect = [0, 0, 1, 1],
): { rect: [number, number, number, number]; source: [number, number, number, number] } {
  const [pw, ph] = picture,
    [cw, ch] = canvas;
  if (
    !['fill', 'contain', 'cover', 'none', 'scale-down'].includes(fit) ||
    ![pw, ph, cw, ch].every((v) => Number.isFinite(v) && v > 0) ||
    !inside(box)
  )
    throw new RangeError(
      "objectFit needs 'fill', 'contain', 'cover', 'none' or 'scale-down', positive picture and canvas sizes and a box inside 0 to 1",
    );
  const bw = box[2] * cw,
    bh = box[3] * ch;
  if (fit === 'fill') return { rect: [...box], source: [0, 0, 1, 1] };
  const contain = Math.min(bw / pw, bh / ph),
    scale =
      fit === 'contain' ? contain : fit === 'cover' ? Math.max(bw / pw, bh / ph) : fit === 'none' ? 1 : Math.min(1, contain);
  // The drawn picture's size in pixels, then the part of it inside the box (both centred).
  const dw = pw * scale,
    dh = ph * scale,
    vw = Math.min(dw, bw),
    vh = Math.min(dh, bh);
  return {
    rect: [box[0] + (bw - vw) / 2 / cw, box[1] + (bh - vh) / 2 / ch, vw / cw, vh / ch],
    source: [(dw - vw) / 2 / dw, (dh - vh) / 2 / dh, vw / dw, vh / dh],
  };
}
let serial = 0;
/** Caller owns playback, AudioContext and VideoFrame lifetime. No decoded-frame uploads. */
export class Video implements EnginePlugin {
  readonly name = 'video:' + ++serial;
  private engine?: Engine;
  private pipeline?: GPURenderPipeline;
  private sampler?: GPUSampler;
  private uniform?: GPUBuffer;
  private format = '';
  private disposed = false;
  private analyser?: AnalyserNode;
  private audioSource?: MediaElementAudioSourceNode;
  readonly frequencies: Uint8Array<ArrayBuffer>;
  // The screen rect (0 to 3) and the source crop (4 to 7), the uniform's two vec4f.
  private readonly rectangle: Float32Array;
  constructor(
    readonly source: HTMLVideoElement | VideoFrame,
    private readonly options: VideoOptions = {},
  ) {
    const isVideo = typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement,
      isFrame = typeof VideoFrame !== 'undefined' && source instanceof VideoFrame;
    const rect = options.rect ?? [0, 0, 1, 1],
      crop = options.source ?? [0, 0, 1, 1],
      fft = options.fftSize ?? 2048;
    if (
      (!isVideo && !isFrame) ||
      !inside(rect) ||
      !inside(crop) ||
      !Number.isInteger(fft) ||
      fft < 32 ||
      fft > 32768 ||
      fft & (fft - 1) ||
      (options.onFrequency !== undefined && typeof options.onFrequency !== 'function') ||
      (options.audio && !isVideo)
    )
      throw new RangeError(
        'Video needs an HTMLVideoElement or VideoFrame, a rect and source inside 0 to 1, a power of two fftSize from 32 to 32768 and audio only with a video element; check the options.',
      );
    this.rectangle = new Float32Array([...rect, ...crop]);
    this.frequencies = new Uint8Array(options.audio ? fft / 2 : 0);
    if (options.audio) {
      const element = source as HTMLVideoElement,
        existing = sources.get(element);
      if (existing && existing.context !== options.audio)
        throw new MargoError(
          'attached',
          'Video element is already connected to a different AudioContext; pass the same audio context for every Video of this element.',
        );
      const shared = existing ?? {
        context: options.audio,
        node: options.audio.createMediaElementSource(element),
        users: 0,
      };
      sources.set(element, shared);
      try {
        this.analyser = options.audio.createAnalyser();
        this.analyser.fftSize = fft;
        if (!shared.users) shared.node.connect(options.audio.destination);
        shared.node.connect(this.analyser);
        shared.users++;
        this.audioSource = shared.node;
      } catch (error) {
        if (this.analyser) {
          try {
            shared.node.disconnect(this.analyser);
          } catch {}
          this.analyser.disconnect();
        }
        if (!shared.users)
          try {
            shared.node.disconnect(options.audio.destination);
          } catch {}
        throw error;
      }
    }
  }
  static attach(engine: EngineKernel, source: HTMLVideoElement | VideoFrame, options: VideoOptions = {}): Video {
    const video = new Video(source, options);
    try {
      engineRuntime(engine).use(video);
      return video;
    } catch (error) {
      video.dispose();
      throw error;
    }
  }
  /** Where the video is drawn now, `[x, y, width, height]` in 0 to 1 screen fractions. */
  get rect(): [number, number, number, number] {
    return [...this.rectangle.subarray(0, 4)] as [number, number, number, number];
  }
  /** The part of the picture drawn now (the `source` option), `[x, y, width, height]` in 0 to 1 picture fractions. */
  get sourceRect(): [number, number, number, number] {
    return [...this.rectangle.subarray(4, 8)] as [number, number, number, number];
  }
  /** Moves the video to `rect` (0 to 1 screen fractions) from the next frame, so one overlay follows a moving layer. */
  setRect(rect: readonly [number, number, number, number]): void {
    this.place(rect, 0, 'setRect');
  }
  /** Draws the part `source` of the picture (0 to 1 fractions from its top left) from the next frame: a crop. */
  setSource(source: readonly [number, number, number, number]): void {
    this.place(source, 4, 'setSource');
  }
  private place(r: Rect, at: number, what: string): void {
    if (this.disposed) throw new MargoError('disposed', `Video is disposed; create a new Video before ${what}().`);
    if (!inside(r)) throw new RangeError(`Video ${what} needs [x, y, width, height] inside 0 to 1 with a positive size`);
    this.rectangle.set(r, at);
    if (this.uniform) this.engine?.gpu?.queue.writeBuffer(this.uniform, 0, this.rectangle as Float32Array<ArrayBuffer>);
  }
  import(device: GPUDevice): GPUExternalTexture | null {
    if (this.disposed) throw new MargoError('disposed', 'Video is disposed; create a new Video before import().');
    if ('readyState' in this.source && (!this.source.videoWidth || this.source.readyState < 2)) return null;
    if ('displayWidth' in this.source && !this.source.displayWidth) return null;
    return device.importExternalTexture({ source: this.source, colorSpace: 'srgb' });
  }
  sampleFrequency(): Uint8Array {
    if (this.disposed)
      throw new MargoError('disposed', 'Video is disposed; create a new Video before sampleFrequency().');
    this.analyser?.getByteFrequencyData(this.frequencies);
    this.options.onFrequency?.(this.frequencies);
    return this.frequencies;
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'Video requires WebGPU and a live effect; attach a new Video to a WebGPU engine.; see https://margoengine.com/errors#webgpu',
      );
    this.engine = engine;
    this.uniform = engine.gpu.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    engine.gpu.queue.writeBuffer(this.uniform, 0, this.rectangle as Float32Array<ArrayBuffer>);
    this.sampler = engine.gpu.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name + ':frame',
      order: 60,
      execute: (c) => {
        if (c.backend !== 'webgpu') return;
        const texture = this.import(c.device);
        this.sampleFrequency();
        if (!texture) return;
        const format = c.format + ':' + c.descriptor.multisample?.count;
        if (this.format !== format) {
          this.pipeline = render(c.device, shader(linearHdr(c.format)), c.format, {
            multisample: c.descriptor.multisample,
          });
          this.format = format;
        }
        const bind = group(c.device, this.pipeline!, [texture, this.sampler!, { buffer: this.uniform! }]);
        const pass = c.encoder.beginRenderPass({
          colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }],
        });
        applyView(pass, c);
        pass.setPipeline(this.pipeline!);
        pass.setBindGroup(0, bind);
        pass.draw(6);
        pass.end();
      },
    });
  }
  onDeviceRestored(engine: Engine): void {
    this.uniform?.destroy();
    this.uniform = undefined;
    this.pipeline = undefined;
    this.format = '';
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.uniform?.destroy();
    if (this.analyser) {
      this.audioSource?.disconnect(this.analyser);
      this.analyser.disconnect();
      const shared = sources.get(this.source as HTMLVideoElement)!;
      if (!--shared.users) shared.node.disconnect(shared.context.destination);
    }
    this.analyser = this.audioSource = undefined;
    this.pipeline = undefined;
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
