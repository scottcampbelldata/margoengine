// The Sound tab's samples, read back from the GPU for `toy.sound()`: one 512 x 512 rgba32float block a frame, each
// texel one sample (red the left channel, green the right), copied into a mappable buffer in the frame's encoder and
// mapped on the next frame, once that encoder has been submitted (WebGPU, W3C, "Buffer Mapping"). Loaded by the
// first `toy.sound()` call only, so a toy without sound never fetches it.
import { MargoError } from '@margoengine/math/errors';
import type { PassContext } from '@margoengine/core/extension';
import type { StageOutput } from '../../../shared/stack.js';

type Context = Extract<PassContext, { backend: 'webgpu' }>;
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; COPY_SRC: number };
declare const GPUBufferUsage: { MAP_READ: number; COPY_DST: number };
declare const GPUMapMode: { READ: number };

/** What `toy.sound()` resolves to. */
export interface ShadertoySound {
  /** Samples per second: the toy's iSampleRate. */
  readonly sampleRate: number;
  /** Left and right, one value from -1 to 1 per sample. */
  readonly channels: readonly [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>];
  /** The samples as a two channel Web Audio buffer of `context`, ready for an `AudioBufferSourceNode`. */
  audioBuffer(context: BaseAudioContext): AudioBuffer;
}
/** Samples per block edge: a block is EDGE x EDGE samples, row by row from the first row. */
export const EDGE = 512;
const BLOCK = EDGE * EDGE;

/** @internal One render of the Sound tab, advanced by the toy's frame pass. */
export class SoundJob {
  readonly done: Promise<ShadertoySound>;
  private resolve!: (sound: ShadertoySound) => void;
  private reject!: (reason: unknown) => void;
  private readonly blocks: number;
  private readonly left: Float32Array<ArrayBuffer>;
  private readonly right: Float32Array<ArrayBuffer>;
  private next = 0;
  private read = 0;
  private over = false;
  private device?: GPUDevice;
  private texture?: GPUTexture;
  private readonly output: StageOutput = {
    view: undefined!,
    format: 'rgba32float',
    multisample: { count: 1 },
    hdr: false,
  };
  private frameContext?: { base: Context; context: Context };
  private readonly submitted: { buffer: GPUBuffer; block: number }[] = [];
  constructor(
    private readonly samples: number,
    private readonly sampleRate: number,
    /** Draws the block whose first sample is `base` into `output`. */
    private readonly draw: (c: Context, base: number, output: StageOutput) => void,
    signal?: AbortSignal,
  ) {
    this.done = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    this.blocks = Math.ceil(samples / BLOCK);
    this.left = new Float32Array(samples);
    this.right = new Float32Array(samples);
    // A signal that aborted while the module loaded never fires again.
    if (signal?.aborted) this.stop(signal.reason);
    else signal?.addEventListener('abort', () => this.stop(signal.reason), { once: true });
  }
  /** One frame: maps the block drawn last frame, then draws the next one. A new device starts the render again. */
  frame(c: Context): void {
    if (this.over) return;
    if (this.device !== c.device) {
      this.release();
      this.device = c.device;
      this.next = this.read = 0;
    }
    for (const s of this.submitted.splice(0)) this.map(s.buffer, s.block, c.device);
    if (this.next === this.blocks) return;
    const device = c.device;
    if (!this.texture) {
      this.texture = device.createTexture({
        label: 'shader:shadertoy:sound',
        size: [EDGE, EDGE],
        format: 'rgba32float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      this.output.view = this.texture.createView();
    }
    if (this.frameContext?.base !== c)
      this.frameContext = {
        base: c,
        context: Object.create(c, {
          width: { value: EDGE },
          height: { value: EDGE },
          view: { value: undefined },
        }) as Context,
      };
    this.draw(this.frameContext.context, this.next * BLOCK, this.output);
    const buffer = device.createBuffer({
      label: 'shader:shadertoy:sound',
      size: BLOCK * 16,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    c.encoder.copyTextureToBuffer({ texture: this.texture }, { buffer, bytesPerRow: EDGE * 16 }, [EDGE, EDGE]);
    this.submitted.push({ buffer, block: this.next++ });
  }
  private map(buffer: GPUBuffer, block: number, device: GPUDevice): void {
    buffer.mapAsync(GPUMapMode.READ).then(
      () => {
        if (!this.over && device === this.device) {
          const texels = new Float32Array(buffer.getMappedRange()),
            base = block * BLOCK,
            n = Math.min(BLOCK, this.samples - base);
          for (let i = 0; i < n; i++) {
            this.left[base + i] = texels[i * 4]!;
            this.right[base + i] = texels[i * 4 + 1]!;
          }
          if (++this.read === this.blocks) this.finish();
        }
        buffer.destroy();
      },
      (error: unknown) => {
        buffer.destroy();
        // A lost device rejects its maps; the next frame on the new device starts again.
        if (device === this.device && !this.over)
          this.stop(
            new MargoError('failed', `Shadertoy sound readback failed (${String(error)}); call toy.sound() again`),
          );
      },
    );
  }
  private finish(): void {
    const { left, right, sampleRate } = this;
    this.over = true;
    this.release();
    this.resolve({
      sampleRate,
      channels: [left, right],
      audioBuffer(context) {
        const out = context.createBuffer(2, left.length, sampleRate);
        out.copyToChannel(left, 0);
        out.copyToChannel(right, 1);
        return out;
      },
    });
  }
  /** Ends the render: the promise rejects with `reason`. */
  stop(reason: unknown): void {
    if (this.over) return;
    this.over = true;
    this.release();
    this.reject(reason);
  }
  private release(): void {
    this.texture?.destroy();
    this.texture = this.frameContext = undefined;
    for (const s of this.submitted.splice(0)) s.buffer.destroy();
  }
}
