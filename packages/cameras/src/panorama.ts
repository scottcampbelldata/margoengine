// Clean room: Bourke's spherical/cube projection and the W3C WebGPU texture and copy rules.
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Vec3 } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { fullscreen, group, render } from '../../shared/gpu.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; MAP_READ: number };
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; COPY_SRC: number };
declare const GPUMapMode: { READ: number };

/** A standard WebGPU cube source, such as an attached CubeCamera. The caller retains ownership. */
export interface PanoramaCube {
  /** Linear-light cube view. */
  readonly view: GPUTextureView;
  /** Refresh all six faces; return the number drawn. Omit for an already baked cube. */
  update?(faces?: number): number;
}
/** Options for a single, complete 360 by 180 degree capture. */
export interface PanoramaOptions {
  /** Use a caller-owned cube instead of making a temporary CubeCamera. */
  cube?: PanoramaCube;
  /** Temporary cube face edge, a power of two from 8 to 2048. Default 256. */
  size?: number;
  /** Capture point. Default the engine camera position. */
  position?: Vec3;
  /** Image width, an even positive integer. Height is width / 2. Default 4 * size. */
  width?: number;
  /** Longitude of the image centre, in radians. Zero looks along -Z; positive turns toward +X. Default 0. */
  yaw?: number;
  /** 'srgb' is RGBA8 for viewers and PNG; 'linear' is unclipped RGBA32F for baking. Default 'srgb'. */
  format?: 'srgb' | 'linear';
  /** Exposure in stops before the sRGB transfer function; ignored for linear output. Default 0. */
  exposure?: number;
  /** Abort the operation, including GPU readback and PNG encoding waits. */
  signal?: AbortSignal;
}
/** Top-to-bottom equirectangular pixels, with north (+Y) at the top and -Z at the centre. */
export type PanoramaImage =
  | { width: number; height: number; format: 'srgb'; data: Uint8ClampedArray }
  | { width: number; height: number; format: 'linear'; data: Float32Array };

/** Map normalised equirectangular coordinates to a world direction (u wraps, v is top to bottom). */
export function panoramaDirection(u: number, v: number, yaw = 0): Vec3 {
  if (![u, v, yaw].every(Number.isFinite) || v < 0 || v > 1)
    throw new RangeError('Invalid panorama coordinates; pass finite u, yaw and v in 0..1');
  const longitude = (u - 0.5) * 2 * Math.PI + yaw,
    latitude = (0.5 - v) * Math.PI,
    radius = Math.cos(latitude);
  return [radius * Math.sin(longitude), Math.sin(latitude), -radius * Math.cos(longitude)];
}

const SHADER = /* wgsl */ `
${fullscreen}
@group(0) @binding(0) var cube:texture_cube<f32>;
@group(0) @binding(1) var linearSampler:sampler;
@group(0) @binding(2) var<uniform> settings:vec4f;
fn srgb(c:vec3f)->vec3f {
  let x=max(c,vec3f(0));
  return select(1.055*pow(x,vec3f(1.0/2.4))-0.055,12.92*x,x<=vec3f(0.0031308));
}
@fragment fn fragment(i:Vertex)->@location(0) vec4f {
  let longitude=(i.uv.x-0.5)*6.28318530718+settings.x;
  let latitude=(0.5-i.uv.y)*3.14159265359;
  let d=vec3f(cos(latitude)*sin(longitude),sin(latitude),-cos(latitude)*cos(longitude));
  let c=textureSampleLevel(cube,linearSampler,d,0.0);
  return vec4f(select(c.rgb,srgb(c.rgb*exp2(settings.y)),settings.z>0.5),c.a);
}`;

// A cancelled readback also unmaps the buffer in the caller's finally block. The rejected map is observed here.
async function waiting<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  let stop: () => void;
  const result = new Promise<T>((resolve, reject) => {
    // Always observe the operation, even when cancellation preceded this call.
    pending.then(resolve, reject);
    stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
  });
  try {
    return await result;
  } finally {
    signal.removeEventListener('abort', stop!);
  }
}

/** Capture six scene faces and resample the whole sphere. No camera, canvas size or scene state is changed. */
export async function capturePanorama(engine: EngineKernel, options: PanoramaOptions = {}): Promise<PanoramaImage> {
  const { signal, yaw = 0, exposure = 0, format = 'srgb', size = 256 } = options;
  signal?.throwIfAborted();
  const width = options.width ?? size * 4,
    height = width / 2;
  if (!Number.isInteger(width) || width < 2 || width % 2 || ![yaw, exposure].every(Number.isFinite))
    throw new RangeError('Invalid panorama size or orientation; pass an even width >= 2 and finite yaw and exposure');
  if (format !== 'linear' && format !== 'srgb') throw new TypeError('Invalid panorama format; pass srgb or linear');
  const device = engineRuntime(engine).gpu;
  if (engine.backend !== 'webgpu' || !device)
    throw new MargoError('unsupported', 'Panorama capture needs WebGPU or the WebGL2 compatibility layer');
  if (width > device.limits.maxTextureDimension2D)
    throw new RangeError('Panorama exceeds the device texture limit; reduce width');
  const bytesPerPixel = format === 'linear' ? 16 : 4,
    rowBytes = width * bytesPerPixel,
    stride = Math.ceil(rowBytes / 256) * 256,
    bufferSize = stride * height;
  if (bufferSize > device.limits.maxBufferSize)
    throw new RangeError('Panorama exceeds the device buffer limit; reduce width');
  let owned: { dispose(): void } | undefined,
    texture: GPUTexture | undefined,
    uniform: GPUBuffer | undefined,
    buffer: GPUBuffer | undefined;
  try {
    let cube = options.cube;
    if (!cube) {
      const { CubeCamera } = await waiting(import('@margoengine/environment/cube-camera'), signal);
      const capture = CubeCamera.attach(engine, { size, position: options.position ?? engine.camera.position });
      cube = capture;
      owned = capture;
    }
    signal?.throwIfAborted();
    if (cube.update && cube.update(6) !== 6)
      throw new MargoError('state', 'Panorama did not capture all six faces; capture after device restoration');
    const targetFormat = format === 'linear' ? 'rgba32float' : 'rgba8unorm',
      pipeline = render(device, SHADER, targetFormat);
    uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(uniform, 0, new Float32Array([yaw, exposure, format === 'srgb' ? 1 : 0, 0]));
    texture = device.createTexture({
      size: [width, height],
      format: targetFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    buffer = device.createBuffer({ size: bufferSize, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const bindings = group(device, pipeline, [
        cube.view,
        device.createSampler({ minFilter: 'linear', magFilter: 'linear' }),
        { buffer: uniform },
      ]),
      encoder = device.createCommandEncoder();
    // view-state: a standalone full-image target, independent of engine views and canvas size.
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: texture.createView(), loadOp: 'clear', storeOp: 'store' }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindings);
    pass.draw(3);
    pass.end();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: stride }, [width, height]);
    device.queue.submit([encoder.finish()]);
    await waiting(buffer.mapAsync(GPUMapMode.READ), signal);
    const mapped = new Uint8Array(buffer.getMappedRange()),
      pixels = new Uint8Array(rowBytes * height);
    for (let y = 0; y < height; y++) pixels.set(mapped.subarray(y * stride, y * stride + rowBytes), y * rowBytes);
    return format === 'linear'
      ? { width, height, format, data: new Float32Array(pixels.buffer) }
      : { width, height, format, data: new Uint8ClampedArray(pixels.buffer) };
  } finally {
    buffer?.unmap();
    buffer?.destroy();
    texture?.destroy();
    uniform?.destroy();
    owned?.dispose();
  }
}

/** Encode viewer-ready sRGB pixels as a PNG Blob. Capture with format 'srgb' (the default) first. */
export async function panoramaPNG(image: PanoramaImage, signal?: AbortSignal): Promise<Blob> {
  signal?.throwIfAborted();
  if (image.format !== 'srgb') throw new TypeError('PNG needs sRGB pixels; capture with format srgb');
  if (
    !Number.isInteger(image.width) ||
    image.width < 2 ||
    image.width % 2 ||
    image.height !== image.width / 2 ||
    image.data.length !== image.width * image.height * 4
  )
    throw new RangeError('Invalid panorama pixels; pass a complete 2:1 RGBA8 image');
  const canvas = new OffscreenCanvas(image.width, image.height),
    context = canvas.getContext('2d');
  if (!context) throw new MargoError('unsupported', 'PNG needs a 2D canvas; enable canvas support');
  context.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
  return waiting(canvas.convertToBlob({ type: 'image/png' }), signal);
}
