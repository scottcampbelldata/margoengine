import type { Camera, EngineKernel } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { margoError } from '../../shared/errors.js';
declare const GPUTextureUsage: {
  RENDER_ATTACHMENT: number;
  TEXTURE_BINDING: number;
  STORAGE_BINDING: number;
  COPY_SRC: number;
};
declare const GPUBufferUsage: { MAP_READ: number; COPY_DST: number };
declare const GPUMapMode: { READ: number };

/** Options of {@link supersample}. */
export interface SupersampleOptions {
  /** Frames averaged into the picture, 1 to 1024. Each is one full render. Default 16. */
  samples?: number;
  /** Width of the picture in pixels. Default the canvas width. */
  width?: number;
  /** Height of the picture in pixels. Default the canvas height. */
  height?: number;
  /** Camera to shoot through. Default the engine's camera. */
  camera?: Camera;
  /** Stops between frames and while reading: the promise rejects with `signal.reason`. */
  signal?: AbortSignal;
}

/** A still from {@link supersample}: RGBA, 8 bits per channel, opaque, top row first, no padding. `new ImageData(data, width)` takes it. */
export interface SupersampledImage {
  width: number;
  height: number;
  data: Uint8ClampedArray<ArrayBuffer>;
}

/** Options of {@link supersampleBlob}. */
export interface SupersampleBlobOptions extends SupersampleOptions {
  /** Image type. Default 'image/png'. */
  type?: string;
  /** Encoder quality, 0 to 1, for lossy types. Default the browser's. */
  quality?: number;
}

const decode = `fn linear(c:vec3f)->vec3f {return select(c/12.92,pow((c+0.055)/1.055,vec3f(2.4)),c>vec3f(0.04045));}`,
  encode = `fn display(c:vec3f)->vec3f {return select(c*12.92,1.055*pow(c,vec3f(1.0/2.4))-0.055,c>vec3f(0.0031308));}`,
  // Running sums stay in linear light in 32-bit floats: an average of display codes would darken every edge.
  add = `${decode}
@group(0) @binding(0) var frame:texture_2d<f32>;
@group(0) @binding(1) var before:texture_2d<f32>;
@group(0) @binding(2) var after:texture_storage_2d<rgba32float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
 if(any(id.xy>=textureDimensions(after))){return;}
 let p=vec2i(id.xy);
 textureStore(after,p,vec4f(textureLoad(before,p,0).rgb+linear(textureLoad(frame,p,0).rgb),1));
}`,
  finish = `${encode}
override samples:f32=1;
@group(0) @binding(0) var sum:texture_2d<f32>;
@group(0) @binding(1) var image:texture_storage_2d<rgba8unorm,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
 if(any(id.xy>=textureDimensions(image))){return;}
 let p=vec2i(id.xy);
 textureStore(image,p,vec4f(display(textureLoad(sum,p,0).rgb/samples),1));
}`;
// Frames in flight before the page gets a turn, so a long still neither floods the queue nor freezes the page.
const BATCH = 4;

/** Element `index` (from 1) of the van der Corput sequence in `base`, in [0, 1). */
function radical(index: number, base: number): number {
  let value = 0,
    weight = 1 / base;
  for (let i = index; i > 0; i = Math.floor(i / base), weight /= base) value += (i % base) * weight;
  return value;
}

/** The sub-pixel offset of frame `index` of `samples`, each axis in [-0.5, 0.5): Halton (2, 3) points fill the pixel
 * evenly at any count, and the same call gives the same picture. A single frame is not moved. */
export function sampleOffset(index: number, samples: number): readonly [number, number] {
  return samples === 1 ? [0, 0] : [radical(index + 1, 2) - 0.5, radical(index + 1, 3) - 0.5];
}

/**
 * Renders a still with supersampling: `samples` whole frames, each moved by a fraction of a pixel, averaged in linear
 * light. Every edge, thin line, shadow boundary and shader highlight gets `samples` samples per pixel, on any tier,
 * and memory does not grow with the sample count. `width` and `height` can exceed the canvas, up to the device's
 * texture limit. Time stands still (delta 0). The canvas is left showing an ordinary frame, and frames from the
 * engine's own loop are untouched.
 * @throws RangeError for invalid options; MargoError `'unsupported'` without WebGPU.
 */
export async function supersample(
  instance: EngineKernel,
  { samples = 16, width, height, camera, signal }: SupersampleOptions = {},
): Promise<SupersampledImage> {
  signal?.throwIfAborted();
  const engine = engineRuntime(instance),
    device = engine.gpu;
  if (!device) throw margoError('unsupported', 'supersample requires WebGPU; it does not run on the WebGL2 fallback');
  const w = width ?? engine.canvas.width,
    h = height ?? engine.canvas.height,
    top = device.limits.maxTextureDimension2D;
  if (!Number.isInteger(samples) || samples < 1 || samples > 1024)
    throw new RangeError('supersample samples must be an integer in 1..1024');
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > top || h > top)
    throw new RangeError(`supersample width and height must be integers in 1..${top}`);
  const shot = camera ?? engine.camera,
    update = shot.update,
    made: { destroy(): void }[] = [],
    texture = (format: GPUTextureFormat, usage: number) => {
      const t = device.createTexture({ size: [w, h], format, usage });
      made.push(t);
      return t;
    },
    pipeline = (code: string, constants?: Record<string, number>) =>
      device.createComputePipeline({
        layout: 'auto',
        compute: { module: device.createShaderModule({ code }), entryPoint: 'main', constants },
      }),
    rows = Math.ceil((w * 4) / 256) * 256,
    read = device.createBuffer({ size: rows * h, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  made.push(read);
  try {
    const frame = texture(
        navigator.gpu.getPreferredCanvasFormat(),
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      ),
      sums = [0, 1].map(() =>
        texture('rgba32float', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING),
      ),
      image = texture('rgba8unorm', GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC),
      adding = pipeline(add),
      finishing = pipeline(finish, { samples }),
      frameView = frame.createView(),
      sumViews = sums.map((sum) => sum.createView()),
      groups = [0, 1].map((i) =>
        device.createBindGroup({
          layout: adding.getBindGroupLayout(0),
          entries: [frameView, sumViews[i], sumViews[1 - i]].map((resource, binding) => ({ binding, resource })),
        }),
      ),
      dispatch = (encoder: GPUCommandEncoder, compute: GPUComputePipeline, group: GPUBindGroup) => {
        const pass = encoder.beginComputePass();
        pass.setPipeline(compute);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
        pass.end();
      },
      views = [{ camera: shot, viewport: [0, 0, 1, 1] as const, target: { color: frame }, id: 'supersample' }];
    for (let i = 0; i < samples; i++) {
      const [x, y] = sampleOffset(i, samples);
      // Only for this call: the engine's own loop runs between batches and must see the camera as it is. The offset is
      // in clip space, so any projection works, and the frustum planes stay the camera's own, so no sample culls
      // what the others draw.
      shot.update = function (this: Camera, aspect: number, webgpu: boolean): void {
        update.call(this, aspect, webgpu);
        const m = this.matrix;
        for (let c = 0; c < 4; c++) {
          m[c * 4] += ((2 * x) / w) * m[c * 4 + 3];
          m[c * 4 + 1] -= ((2 * y) / h) * m[c * 4 + 3];
        }
      };
      try {
        engine.render({ views });
      } finally {
        shot.update = update;
      }
      const encoder = device.createCommandEncoder();
      dispatch(encoder, adding, groups[i & 1]);
      device.queue.submit([encoder.finish()]);
      if (i % BATCH === BATCH - 1) {
        await device.queue.onSubmittedWorkDone();
        signal?.throwIfAborted();
      }
    }
    const encoder = device.createCommandEncoder();
    dispatch(
      encoder,
      finishing,
      device.createBindGroup({
        layout: finishing.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: sumViews[samples & 1] },
          { binding: 1, resource: image.createView() },
        ],
      }),
    );
    encoder.copyTextureToBuffer({ texture: image }, { buffer: read, bytesPerRow: rows, rowsPerImage: h }, [w, h]);
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    signal?.throwIfAborted();
    const mapped = new Uint8Array(read.getMappedRange()),
      data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) data.set(mapped.subarray(y * rows, y * rows + w * 4), y * w * 4);
    return { width: w, height: h, data };
  } finally {
    for (const item of made) item.destroy();
    // The camera's matrix still holds the last offset, and a frame into a texture leaves picking with no canvas view.
    engine.render(engine.views?.length ? { views: engine.views } : {});
  }
}

/** {@link supersample} as an encoded image file, ready for a download link or an upload. Browser only. */
export async function supersampleBlob(
  engine: EngineKernel,
  { type = 'image/png', quality, ...options }: SupersampleBlobOptions = {},
): Promise<Blob> {
  const { width, height, data } = await supersample(engine, options),
    canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d')!.putImageData(new ImageData(data, width, height), 0, 0);
  return canvas.convertToBlob({ type, quality });
}
