// Render to file. capture() renders one frame at an exact pixel size and returns its RGBA pixels; the encoders turn
// frames into PNG/JPG files, numbered image sequences, an animated GIF or a WebM video. Time is the caller's: every
// encoder asks frame(i) for frame i, so a deterministic timeline sets the scene state for i there and captures.
import type { Camera, EngineKernel, RenderView } from '@margoengine/core';
import { LinearToSRGB, parseColor, type ColorInput } from '@margoengine/math/color';
import { MargoError } from '@margoengine/math/errors';
export {
  encodeAtlasZIP,
  encodeSequenceZIP,
  encodeZIP,
  packSpriteAtlas,
  spriteAtlasLayout,
} from './archive.js';
export type {
  ArchiveProgress,
  AtlasFrame,
  AtlasLayout,
  AtlasManifest,
  SpriteAtlasOptions,
  AtlasZIPOptions,
  SequenceManifest,
  SequenceZIPOptions,
  SpriteAtlas,
  ZIPEntry,
  ZIPOptions,
} from './archive.js';

// The PNG encoder loads on first use, as in model.js, so no module of this package imports it both ways.
const png: typeof import('./png.js').png = async (...args) => (await import('./png.js')).png(...args);

/** RGBA8 pixels, 4 bytes per pixel, top row first, not premultiplied: an `ImageData` or a {@link capture} result. */
export interface Pixels {
  readonly data: Uint8Array | Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}
/** Produces frame `index` (0-based) for an encoder: set the scene state for that frame, then return a capture. */
export type FrameSource = (index: number) => Pixels | Promise<Pixels>;

/** Options for {@link capture}. */
export interface CaptureOptions {
  /**
   * Output width in pixels, a whole number >= 1, independent of the canvas size and device pixel ratio. Default with
   * `view`: the view rectangle's width in drawing-buffer pixels; required without.
   */
  width?: number;
  /** Output height in pixels, a whole number >= 1. Default with `view`: the view rectangle's height. */
  height?: number;
  /** Camera to render through (a selected scene camera). Default `engine.camera`. */
  camera?: Camera;
  /**
   * An engine view to capture: its camera, scene, layers and clear, cropped to its rectangle (fractions of the canvas
   * unless `pixels`) and rendered at `width` x `height`. Overrides `camera`.
   */
  view?: RenderView;
  /**
   * Colour under the scene: `'#rrggbb'`, `0xrrggbb` (sRGB) or linear `[r, g, b]`. It shows only where the canvas is
   * transparent (`TransparentCanvas` from @margoengine/environment, or a WebGL2 renderer made with
   * `transparent: true`); an opaque canvas keeps its own clear colour or skybox. Default: none.
   */
  background?: ColorInput;
  /** Opacity of `background`, 0 (fully transparent) to 1 (opaque), as Crocotile's Background Transparency. Default 1. */
  backgroundAlpha?: number;
}

// Engine.render caps the canvas backing size at 4096 pixels per side; larger captures render in tiles of at most this.
const LIMIT = 4096;

/**
 * Renders one frame through `camera` at exactly `width` x `height` pixels and returns its RGBA pixels, synchronously.
 * The canvas is hidden for the call (`display: none` makes the engine keep the backing size set here, whatever the
 * window size and device pixel ratio), read back in the same task, then restored and redrawn through the primary
 * camera, so the page never shows the capture. Sizes above 4096 render in tiles through a view offset on the camera
 * projection; screen-space passes that read neighbouring pixels (bloom, SSAO, outlines) may show seams there.
 * Pixel-sized lines, points and labels are sized as at a device pixel ratio of 1. Renders with `delta: 0`, so plugins
 * and camera fits do not advance. Toggle skyboxes or helpers in the scene before calling it. Not from a frame callback
 * (the engine rejects nested renders).
 * @throws RangeError for a size that is not a whole number >= 1, or a `backgroundAlpha` outside 0..1.
 */
export function capture(
  engine: EngineKernel,
  options: CaptureOptions,
): { data: Uint8ClampedArray; width: number; height: number } {
  const { view, background, backgroundAlpha = 1 } = options,
    camera = view?.camera ?? options.camera ?? engine.camera,
    // With a view, its rectangle in drawing-buffer pixels gives the default size; the capture fills the output with it.
    scale = view?.pixels ? [1, 1] : [engine.canvas.width, engine.canvas.height],
    width = options.width ?? (view ? Math.max(1, Math.round(view.viewport[2] * scale[0])) : Number.NaN),
    height = options.height ?? (view ? Math.max(1, Math.round(view.viewport[3] * scale[1])) : Number.NaN);
  if (!(Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1))
    throw new RangeError(`Capture size ${width}x${height} is invalid; pass whole numbers of pixels >= 1`);
  if (!(backgroundAlpha >= 0 && backgroundAlpha <= 1))
    throw new RangeError(
      `Capture backgroundAlpha ${backgroundAlpha} is outside 0..1; pass 0 (transparent) to 1 (opaque)`,
    );
  let fill: string | undefined;
  if (background !== undefined) {
    const [r, g, b] = Array.from(parseColor(background), (v) => Math.round(Math.min(1, LinearToSRGB(v)) * 255));
    fill = `rgb(${r} ${g} ${b} / ${backgroundAlpha})`;
  }
  const canvas = engine.canvas,
    style = canvas.style,
    display = style.getPropertyValue('display'),
    priority = style.getPropertyPriority('display'),
    saved = [canvas.width, canvas.height],
    project = camera.project,
    columns = Math.ceil(width / LIMIT),
    rows = Math.ceil(height / LIMIT),
    tileWidth = Math.ceil(width / columns),
    tileHeight = Math.ceil(height / rows),
    out = new Uint8ClampedArray(width * height * 4),
    context = new OffscreenCanvas(tileWidth, tileHeight).getContext('2d', { willReadFrequently: true })!;
  try {
    style.setProperty('display', 'none', 'important');
    for (let y = 0; y < height; y += tileHeight)
      for (let x = 0; x < width; x += tileWidth) {
        const w = Math.min(tileWidth, width - x),
          h = Math.min(tileHeight, height - y);
        canvas.width = w;
        canvas.height = h;
        if (columns * rows > 1) camera.project = tile(camera, project, width, height, x, y, w, h);
        if (view)
          engine.render({
            views: [{ ...view, camera, viewport: [0, 0, 1, 1], pixels: false, scissor: undefined, target: undefined }],
            delta: 0,
          });
        else engine.render({ camera, delta: 0 });
        context.clearRect(0, 0, w, h);
        if (fill) {
          context.fillStyle = fill;
          context.fillRect(0, 0, w, h);
        }
        // Same task as the render: the WebGPU current texture (or WebGL drawing buffer) is still readable.
        context.drawImage(canvas, 0, 0);
        const data = context.getImageData(0, 0, w, h).data;
        for (let row = 0; row < h; row++)
          out.set(data.subarray(row * w * 4, (row + 1) * w * 4), ((y + row) * width + x) * 4);
      }
  } finally {
    camera.project = project;
    if (display) style.setProperty('display', display, priority);
    else style.removeProperty('display');
    [canvas.width, canvas.height] = saved;
  }
  // Draw the page's own frame again: its views when it has them.
  engine.render(engine.views?.length ? { views: engine.views } : {});
  return { data: out, width, height };
}

// The full image's projection, scaled and shifted in clip space so pixels [x, x + w) x [y, y + h) fill the viewport.
function tile(
  camera: Camera,
  project: Camera['project'],
  width: number,
  height: number,
  x: number,
  y: number,
  w: number,
  h: number,
): NonNullable<Camera['project']> {
  const aspect = width / height,
    sx = width / w,
    sy = height / h,
    cx = (2 * x + w) / width - 1,
    cy = 1 - (2 * y + h) / height;
  return (out, _tileAspect, webgpu) => {
    if (project) project(out, aspect, webgpu);
    else {
      // Camera.update's own perspective (core zeroes `out` first).
      const f = 1 / Math.tan((camera.fov * Math.PI) / 360),
        { near, far } = camera,
        d = near - far;
      out[0] = f / aspect;
      out[5] = f;
      out[10] = webgpu ? -near / d : (far + near) / d;
      out[11] = -1;
      out[14] = webgpu ? (-far * near) / d : (2 * far * near) / d;
    }
    for (let c = 0; c < 16; c += 4) {
      out[c] = sx * (out[c] - cx * out[c + 3]);
      out[c + 1] = sy * (out[c + 1] - cy * out[c + 3]);
    }
  };
}

function checked(pixels: Pixels): Pixels {
  const { data, width, height } = pixels ?? {};
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray))
    throw new TypeError('Frame pixels need data as a Uint8Array or Uint8ClampedArray; pass an ImageData or a capture');
  if (!(Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1))
    throw new RangeError(`Frame size ${width}x${height} is invalid; pass whole numbers of pixels >= 1`);
  if (data.length !== width * height * 4)
    throw new RangeError(
      `Frame ${width}x${height} has ${data.length} bytes, not ${width * height * 4}; pass RGBA8 rows`,
    );
  return pixels;
}
function checkCount(count: number): void {
  if (!(Number.isInteger(count) && count >= 1))
    throw new RangeError(`Frame count ${count} is invalid; pass a whole number >= 1`);
}
const imageData = ({ data, width, height }: Pixels): ImageData =>
  new ImageData(
    new Uint8ClampedArray(data.buffer, data.byteOffset, data.length) as Uint8ClampedArray<ArrayBuffer>,
    width,
    height,
  );

/** Lossless RGBA PNG of `pixels` (CompressionStream zlib); runs anywhere, Node included. */
export function encodePNG(pixels: Pixels): Promise<Uint8Array> {
  return png(checked(pixels), Infinity, false);
}

/**
 * JPEG of `pixels` through the browser's encoder (`OffscreenCanvas.convertToBlob`). JPEG has no alpha: capture with
 * an opaque background (`backgroundAlpha: 1`), since transparent pixels encode as black.
 * @param quality 0 (smallest) to 1 (best). Default 0.92.
 * @throws MargoError `unsupported` without OffscreenCanvas (Node); use {@link encodePNG} there.
 */
export async function encodeJPEG(pixels: Pixels, quality = 0.92): Promise<Uint8Array> {
  checked(pixels);
  if (!(quality >= 0 && quality <= 1))
    throw new RangeError(`JPEG quality ${quality} is outside 0..1; pass 0 (smallest) to 1 (best)`);
  if (typeof OffscreenCanvas !== 'function')
    throw new MargoError('unsupported', 'encodeJPEG needs OffscreenCanvas (a browser or worker); use encodePNG here');
  const canvas = new OffscreenCanvas(pixels.width, pixels.height);
  canvas.getContext('2d')!.putImageData(imageData(pixels), 0, 0);
  return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality })).arrayBuffer());
}

/** Options for {@link encodeSequence}. */
export interface SequenceOptions {
  /** File name before the frame number. Default `'frame'`. */
  name?: string;
  /** `'png'` (lossless, anywhere) or `'jpg'` (browser, with `quality`). Default `'png'`. */
  format?: 'png' | 'jpg';
  /**
   * Minimum digits of the frame number, zero-padded. `String(count - 1).length` gives every name the same width
   * (Crocotile's Pad Number). Default 0 (no padding).
   */
  pad?: number;
  /** JPEG quality 0..1. Default 0.92. */
  quality?: number;
}
/** One numbered file of an image sequence. */
export interface SequenceFile {
  /** `${name}${number}.${format}`, for example `walk_007.png`. */
  name: string;
  /** The encoded image. */
  data: Uint8Array;
}

/**
 * Image sequence: for each index 0..count-1 in turn, awaits `frame(index)`, encodes it and yields the named file, so
 * each file can be written before the next frame renders. The number in the name is the frame index.
 * @throws RangeError for a count that is not a whole number >= 1 or a negative `pad`; TypeError for another format.
 */
export async function* encodeSequence(
  count: number,
  frame: FrameSource,
  { name = 'frame', format = 'png', pad = 0, quality }: SequenceOptions = {},
): AsyncGenerator<SequenceFile, void, undefined> {
  checkCount(count);
  if (format !== 'png' && format !== 'jpg')
    throw new TypeError(`Sequence format ${format} is unknown; pass png or jpg`);
  if (!(Number.isInteger(pad) && pad >= 0))
    throw new RangeError(`Sequence pad ${pad} is invalid; pass a whole number of digits >= 0`);
  for (let index = 0; index < count; index++) {
    const pixels = await frame(index);
    yield {
      name: `${name}${String(index).padStart(pad, '0')}.${format}`,
      data: format === 'png' ? await encodePNG(pixels) : await encodeJPEG(pixels, quality),
    };
  }
}

/** Options for {@link encodeGIF}. */
export interface GIFOptions {
  /**
   * Frames per second, up to 50. GIF delays are whole 1/100 s, rounded cumulatively so the total stays exact
   * (30 fps: 3, 4, 3, 3, 4, 3 ...); viewers slow delays under 2/100 s, hence the limit. Default 30.
   */
  fps?: number;
  /** Ordered 4x4 Bayer dithering (+-15 levels) for frames that must be quantised. Default false. */
  dither?: boolean;
}

/**
 * Animated GIF89a that loops forever (NETSCAPE2.0): one frame per `frame(index)`, all the same size. A frame with at
 * most 256 colours (255 when it has transparent pixels) keeps them exactly; a frame with more is quantised by median
 * cut (Heckbert 1982) over a 5-bit-per-channel histogram: the box with the widest channel range splits at its
 * pixel-weighted median until there are 256 boxes, each pixel taking its box's mean colour. Pixels with alpha below
 * 128 are transparent (index 0 of the frame's colour table); each frame replaces the previous one.
 * @throws RangeError for fps outside (0, 50], frames of different sizes, or a side above 65535.
 */
export async function encodeGIF(
  count: number,
  frame: FrameSource,
  { fps = 30, dither = false }: GIFOptions = {},
): Promise<Uint8Array> {
  checkCount(count);
  if (!(fps >= 100 / 65535 && fps <= 50))
    throw new RangeError(`GIF fps ${fps} is outside 100/65535..50; delays are 1..65535 hundredths of a second`);
  let buffer = new Uint8Array(1 << 16),
    size = 0,
    width = 0,
    height = 0;
  const put = (...bytes: number[]): void => {
    for (const byte of bytes) {
      if (size === buffer.length) {
        const grown = new Uint8Array(size * 2);
        grown.set(buffer);
        buffer = grown;
      }
      buffer[size++] = byte;
    }
  };
  const short = (value: number): void => put(value & 255, value >> 8);
  for (let index = 0; index < count; index++) {
    const pixels = checked(await frame(index));
    if (!index) {
      ({ width, height } = pixels);
      if (width > 65535 || height > 65535)
        throw new RangeError(`GIF frame ${width}x${height} is too large; capture at most 65535 pixels per side`);
      put(...Array.from('GIF89a', (c) => c.charCodeAt(0)));
      short(width);
      short(height);
      put(0, 0, 0); // no global colour table: every frame has its own
      put(0x21, 0xff, 11, ...Array.from('NETSCAPE2.0', (c) => c.charCodeAt(0)), 3, 1, 0, 0, 0); // loop forever
    } else if (pixels.width !== width || pixels.height !== height)
      throw new RangeError(
        `GIF frame ${index} is ${pixels.width}x${pixels.height}, not ${width}x${height}; capture every frame at one size`,
      );
    const { palette, indices, transparent } = quantise(pixels, dither),
      bits = Math.max(1, Math.ceil(Math.log2(palette.length / 3))),
      delay = Math.round(((index + 1) * 100) / fps) - Math.round((index * 100) / fps);
    // Graphic control: dispose to background, delay, transparent index 0.
    put(0x21, 0xf9, 4, (2 << 2) | (transparent ? 1 : 0));
    short(delay);
    put(0, 0, 0x2c);
    short(0);
    short(0);
    short(width);
    short(height);
    put(0x80 | (bits - 1));
    for (let i = 0; i < 3 << bits; i++) put(palette[i] ?? 0);
    lzw(put, indices, Math.max(2, bits));
  }
  put(0x3b);
  return buffer.slice(0, size);
}

const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
function quantise(
  { data, width }: Pixels,
  dither: boolean,
): { palette: number[]; indices: Uint8Array; transparent: boolean } {
  const n = data.length / 4,
    indices = new Uint8Array(n),
    exact = new Map<number, number>(),
    rgb = (i: number): number => (data[i * 4] << 16) | (data[i * 4 + 1] << 8) | data[i * 4 + 2];
  let transparent = false;
  for (let i = 0; i < n; i++)
    if (data[i * 4 + 3] < 128) transparent = true;
    else if (exact.size <= 256 && !exact.has(rgb(i))) exact.set(rgb(i), exact.size);
  const offset = transparent ? 1 : 0,
    palette = transparent ? [0, 0, 0] : [];
  if (exact.size + offset <= 256) {
    for (const c of exact.keys()) palette.push(c >> 16, (c >> 8) & 255, c & 255);
    for (let i = 0; i < n; i++) indices[i] = data[i * 4 + 3] < 128 ? 0 : exact.get(rgb(i))! + offset;
    return { palette, indices, transparent };
  }
  // Median cut over 5-bit bins (key r5 << 10 | g5 << 5 | b5).
  const key = (r: number, g: number, b: number): number => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3),
    counts = new Uint32Array(32768),
    sums = new Float64Array(32768 * 3);
  for (let i = 0; i < n; i++)
    if (data[i * 4 + 3] >= 128) {
      const k = key(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
      counts[k]++;
      for (let c = 0; c < 3; c++) sums[k * 3 + c] += data[i * 4 + c];
    }
  const boxes: number[][] = [[]];
  for (let k = 0; k < 32768; k++) if (counts[k]) boxes[0].push(k);
  while (boxes.length < 256 - offset) {
    let best = -1,
      widest = 0,
      shift = 0;
    boxes.forEach((box, b) => {
      for (let s = 0; s <= 10; s += 5) {
        let low = 31,
          high = 0;
        for (const k of box) {
          const v = (k >> s) & 31;
          low = Math.min(low, v);
          high = Math.max(high, v);
        }
        if (high - low > widest) [best, widest, shift] = [b, high - low, s];
      }
    });
    if (best < 0) break;
    const box = boxes[best].sort((p, q) => ((p >> shift) & 31) - ((q >> shift) & 31));
    let total = 0,
      half = 0,
      split = 0;
    for (const k of box) total += counts[k];
    while (split < box.length - 2 && (half += counts[box[split]]) < total / 2) split++;
    boxes.push(box.splice(split + 1));
  }
  const lookup = new Int16Array(32768).fill(-1);
  boxes.forEach((box, b) => {
    const mean = [0, 0, 0];
    let total = 0;
    for (const k of box) {
      total += counts[k];
      for (let c = 0; c < 3; c++) mean[c] += sums[k * 3 + c];
      lookup[k] = b + offset;
    }
    palette.push(...mean.map((v) => Math.round(v / total)));
  });
  for (let i = 0; i < n; i++) {
    if (data[i * 4 + 3] < 128) continue; // index 0
    const d = dither ? ((bayer[(((i / width) & 3) << 2) | ((i % width) & 3)] + 0.5) / 16 - 0.5) * 32 : 0,
      [r, g, b] = [0, 1, 2].map((c) => Math.max(0, Math.min(255, Math.round(data[i * 4 + c] + d)))),
      k = key(r, g, b);
    if (lookup[k] < 0) {
      // A dithered colour outside the histogram: the nearest palette entry to the bin centre.
      let nearest = Infinity;
      for (let p = offset; p < palette.length / 3; p++) {
        const e =
          (palette[p * 3] - ((r & 0xf8) | 4)) ** 2 +
          (palette[p * 3 + 1] - ((g & 0xf8) | 4)) ** 2 +
          (palette[p * 3 + 2] - ((b & 0xf8) | 4)) ** 2;
        if (e < nearest) [nearest, lookup[k]] = [e, p];
      }
    }
    indices[i] = lookup[k];
  }
  return { palette, indices, transparent };
}

// GIF LZW (GIF89a appendix F): variable-length codes packed LSB first into 255-byte sub-blocks, a clear code first and
// whenever the 4096-entry table fills, the end code last.
function lzw(put: (...bytes: number[]) => void, indices: Uint8Array, minimum: number): void {
  put(minimum);
  const block: number[] = [],
    clear = 1 << minimum,
    table = new Map<number, number>();
  let width = minimum + 1,
    next = clear + 2,
    bits = 0,
    pending = 0;
  const emit = (code: number): void => {
    pending |= code << bits;
    for (bits += width; bits >= 8; bits -= 8, pending >>= 8)
      if (block.push(pending & 255) === 255) put(255, ...block.splice(0));
  };
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const index = indices[i],
      code = table.get((prefix << 8) | index);
    if (code !== undefined) {
      prefix = code;
      continue;
    }
    emit(prefix);
    if (next < 4096) {
      table.set((prefix << 8) | index, next++);
      if (next > 1 << width) width++;
    } else {
      emit(clear);
      table.clear();
      width = minimum + 1;
      next = clear + 2;
    }
    prefix = index;
  }
  emit(prefix);
  // The decoder adds a table entry for that last code before it reads the end code, and may widen for it.
  if (next < 4096 && ++next > 1 << width) width++;
  emit(clear + 1);
  if (bits) block.push(pending & 255);
  if (block.length) put(block.length, ...block);
  put(0);
}

/** Options for {@link encodeWEBM}. */
export interface WEBMOptions {
  /** Frames per second. Default 30. */
  fps?: number;
  /** Video bit rate passed to MediaRecorder (`videoBitsPerSecond`). Default: the browser's (often low). */
  bitsPerSecond?: number;
}

/**
 * WebM video through the browser's MediaRecorder on a `captureStream(0)` canvas: each frame is drawn, sent with
 * `requestFrame()`, recorded for 1/fps s of wall time, and the recorder is paused while the next frame is produced, so
 * slow frames do not stretch the video. Browser only, and the window should stay visible (hidden pages throttle the
 * timers that pace frames). Frame times follow those timers, so durations are close to, not exactly, 1/fps; the codec
 * (VP8 or VP9) and quality are the browser's.
 * @throws MargoError `unsupported` without MediaRecorder or WebM support; `failed` when the recorder produced no data.
 */
export async function encodeWEBM(
  count: number,
  frame: FrameSource,
  { fps = 30, bitsPerSecond }: WEBMOptions = {},
): Promise<Uint8Array> {
  checkCount(count);
  if (!(fps > 0 && fps <= 240)) throw new RangeError(`WebM fps ${fps} is outside (0, 240]; pass a frame rate`);
  if (typeof MediaRecorder !== 'function' || !MediaRecorder.isTypeSupported('video/webm'))
    throw new MargoError(
      'unsupported',
      'encodeWEBM needs MediaRecorder with WebM (a browser); export a GIF or PNG sequence instead',
    );
  // The first recording in a browser process starts about 1 s late and then keeps paused time in its timestamps
  // (measured in headless Edge 155); a throwaway one-frame recording first warms the media pipeline.
  const warm = document.createElement('canvas');
  warm.width = warm.height = 16;
  warm.getContext('2d')!.fillRect(0, 0, 16, 16);
  const prime = await record(warm);
  prime.track.requestFrame();
  await sleep(100);
  await prime.stop();
  const first = checked(await frame(0)),
    { width, height } = first,
    canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d')!;
  context.putImageData(imageData(first), 0, 0);
  const video = await record(canvas, bitsPerSecond);
  try {
    for (let index = 0; index < count; index++) {
      if (index) {
        const pixels = checked(await frame(index));
        if (pixels.width !== width || pixels.height !== height)
          throw new RangeError(
            `WebM frame ${index} is ${pixels.width}x${pixels.height}, not ${width}x${height}; capture every frame at one size`,
          );
        context.putImageData(imageData(pixels), 0, 0);
        video.recorder.resume();
      }
      video.track.requestFrame();
      await sleep(1000 / fps);
      video.recorder.pause();
    }
  } catch (error) {
    await video.stop();
    throw error;
  }
  const blob = await video.stop();
  if (!blob.size) throw new MargoError('failed', 'MediaRecorder produced no WebM data; record with the window visible');
  return new Uint8Array(await blob.arrayBuffer());
}
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
// A WebM MediaRecorder on a captureStream(0) canvas, resolved once it is recording.
async function record(canvas: HTMLCanvasElement, videoBitsPerSecond?: number) {
  const stream = canvas.captureStream(0),
    track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack,
    recorder = new MediaRecorder(stream, { mimeType: 'video/webm', videoBitsPerSecond }),
    chunks: Blob[] = [],
    stopped = new Promise((resolve) => (recorder.onstop = resolve));
  recorder.ondataavailable = (event) => chunks.push(event.data);
  await new Promise((resolve) => {
    recorder.onstart = resolve;
    recorder.start();
  });
  return {
    track,
    recorder,
    async stop(): Promise<Blob> {
      if (recorder.state !== 'inactive') recorder.stop();
      await stopped;
      track.stop();
      return new Blob(chunks, { type: 'video/webm' });
    },
  };
}
