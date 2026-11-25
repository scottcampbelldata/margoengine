// Recorded footage on a mesh from plain RGBA pixels, for renders where no <video> element or VideoFrame exists (a
// headless film in Node, frames decoded by ffmpeg). The picture is a function of the film time alone: frame k shows for
// k / fps <= t - start < (k + 1) / fps, so a seek gives the same picture as playing there. The pixels reach the GPU
// through a materials Texture, which owns the per-device copies, the sRGB decoding, the mip chain and device restores.
import { Texture } from '@margoengine/materials/texture';
import { fault, rangeError, typeError } from '../../shared/errors.js';

/** One picture: `width * height * 4` bytes of straight-alpha sRGB RGBA, rows from the top. */
export type FramePixels = Uint8Array | Uint8ClampedArray;

/** Options of {@link FrameVideo}. */
export interface FrameVideoOptions {
  /** Picture width in pixels, 1 to 16384. Required. */
  width: number;
  /** Picture height in pixels, 1 to 16384. Required. */
  height: number;
  /** The clip's frames per second, above 0 (30000 / 1001 works). Required. */
  fps: number;
  /** How many frames the clip holds, a whole number from 1. Required. */
  frames: number;
  /**
   * Gives frame `frame` (from 0). May be async. The pixels are copied before `seek` resolves, so the same buffer may be
   * filled again. `signal` aborts when the seek's own signal does or the clip is disposed. Required.
   */
  read: (frame: number, signal: AbortSignal) => FramePixels | Promise<FramePixels>;
  /** Film time in seconds at which frame 0 starts; before it the clip shows frame 0. Default 0. */
  start?: number;
  /** Starts again after the last frame; otherwise the last frame stays. Default false. */
  loop?: boolean;
  /** The picture's top row at UV v = 1, as `videoMaterial` and image textures place it. Default true. */
  flipY?: boolean;
}

const wrong = (message: string): RangeError => rangeError(message, 'arguments');
const size = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 16384;

/**
 * A clip of RGBA frames as a texture. `await clip.seek(time)` loads the picture of a film time into `clip.texture`,
 * which any material slot takes: `map` for a screen that shows the footage, `emissiveMap` for one that glows. Works on
 * any engine, in the browser and in Node.
 */
export class FrameVideo {
  /** Picture width in pixels. */
  readonly width: number;
  /** Picture height in pixels. */
  readonly height: number;
  /** The clip's frames per second. */
  readonly fps: number;
  /** Frames in the clip. */
  readonly frames: number;
  /** Seconds the clip lasts: `frames / fps`. */
  readonly duration: number;
  /**
   * The picture, transparent black until the first `seek`. Mipmaps are on with anisotropy 8, so a small or slanted
   * screen does not shimmer (L. Williams, "Pyramidal Parametrics", SIGGRAPH 1983,
   * https://doi.org/10.1145/800059.801126); its sampler and `mipmaps` settings are live.
   */
  readonly texture: Texture;
  private readonly start: number;
  private readonly loop: boolean;
  private readonly flip: boolean;
  private readonly read: FrameVideoOptions['read'];
  private readonly abort = new AbortController();
  private readonly pixels: Uint8Array;
  private shown = -1;
  private ticket = 0;

  constructor(options: FrameVideoOptions) {
    const { width, height, fps, frames, read, start = 0, loop = false, flipY = true } = options ?? {};
    if (!size(width) || !size(height))
      throw wrong('FrameVideo width and height must be whole numbers of pixels from 1 to 16384.');
    if (!Number.isFinite(fps) || !(fps > 0)) throw wrong('FrameVideo fps must be a finite number above 0.');
    if (!Number.isInteger(frames) || frames < 1) throw wrong('FrameVideo frames must be a whole number from 1.');
    if (typeof read !== 'function')
      throw typeError('FrameVideo read must be a function that returns the pixels of a frame.', 'arguments');
    if (!Number.isFinite(start)) throw wrong('FrameVideo start must be a finite number of seconds.');
    if (typeof loop !== 'boolean' || typeof flipY !== 'boolean')
      throw typeError('FrameVideo loop and flipY must be true or false.', 'arguments');
    this.width = width;
    this.height = height;
    this.fps = fps;
    this.frames = frames;
    this.duration = frames / fps;
    this.read = read;
    this.start = start;
    this.loop = loop;
    this.flip = flipY;
    this.pixels = new Uint8Array(width * height * 4);
    this.texture = new Texture({ data: this.pixels, width, height }, { mipmaps: true, anisotropy: 8 });
  }

  /** The frame the texture holds now, or -1 before the first `seek`. */
  get frame(): number {
    return this.shown;
  }

  /** The frame that shows at `time` seconds of film. */
  frameAt(time: number): number {
    if (!Number.isFinite(time) || time < 0) throw wrong('FrameVideo time must be 0 or more.');
    // A millionth of a frame, so a film time such as 1 + 7 / 30 does not round down to frame 6.
    const index = Math.max(0, Math.floor((time - this.start) * this.fps + 1e-6));
    return this.loop ? index % this.frames : Math.min(index, this.frames - 1);
  }

  /**
   * Shows the frame of `time` seconds, reading it only when it is not the one shown. A later `seek` wins: an earlier
   * one still reading resolves without changing the picture. A failed or aborted read leaves the picture as it was.
   */
  async seek(time: number, options: { signal?: AbortSignal } = {}): Promise<void> {
    if (this.abort.signal.aborted)
      throw fault('disposed', 'FrameVideo is disposed; create a new FrameVideo before seek().');
    const index = this.frameAt(time),
      signal = options.signal ? AbortSignal.any([options.signal, this.abort.signal]) : this.abort.signal;
    signal.throwIfAborted();
    const ticket = ++this.ticket;
    if (index === this.shown) return;
    const data = await this.read(index, signal);
    signal.throwIfAborted();
    if (ticket !== this.ticket) return;
    const { pixels } = this;
    if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || data.length !== pixels.length)
      throw wrong(
        `FrameVideo frame ${index} must be a Uint8Array of ${pixels.length} bytes (width * height * 4 RGBA).`,
      );
    if (this.flip) {
      const row = this.width * 4;
      for (let y = 0, from = pixels.length - row; y < pixels.length; y += row, from -= row)
        pixels.set(data.subarray(from, from + row), y);
    } else pixels.set(data);
    this.shown = index;
    this.texture.update();
  }

  /** Frees the texture's GPU copies and aborts reads still running. Take it out of its materials first. */
  dispose(): void {
    if (this.abort.signal.aborted) return;
    this.abort.abort(fault('disposed', 'FrameVideo is disposed; create a new FrameVideo.'));
    this.texture.dispose();
    this.shown = -1;
  }

  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
