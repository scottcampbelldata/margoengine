// GGX prefiltering of a plain CubeTexture: resamples any cube (six images, an equirectangular image, a KTX2 cube, a
// float one) to linear float faces on the GPU, reads them back and hands them to @margoengine/environment, which does the
// GGX integration and the irradiance harmonics. The float faces stay on the CPU as the Environment's source, so it comes
// back after a lost device like any other. @margoengine/environment loads only when this runs.
import { MargoError } from '@margoengine/math/errors';
import type { Environment, EnvironmentOptions } from '@margoengine/environment';
import type { CubeTexture } from './built-material.js';
declare const GPUTextureUsage: { STORAGE_BINDING: number; COPY_SRC: number };
declare const GPUBufferUsage: { COPY_DST: number; MAP_READ: number };
declare const GPUMapMode: { READ: number };
declare const GPUShaderStage: { COMPUTE: number };

/** The engine or device a cube is prefiltered on. */
export type PrefilterTarget = GPUDevice | { readonly gpu?: GPUDevice | null };
/** Options of `prefilterCube`: `size` and the `Environment.create` options that apply to a cube. */
export interface PrefilterOptions
  extends Pick<EnvironmentOptions, 'specularSize' | 'specularMips' | 'samples' | 'rotation' | 'intensity' | 'keepSource'> {
  /** Edge of the float copy the filter reads, a power of two from 16 to 2048. Default: the cube's edge rounded up to one, at most 1024. */
  size?: number;
  /** Stops the work before the Environment is built. */
  signal?: AbortSignal;
}
const faceRay = /* wgsl */ `
@group(0) @binding(0) var source:texture_cube<f32>;
@group(0) @binding(1) var sourceSampler:sampler;
@group(0) @binding(2) var floatFaces:texture_storage_2d_array<rgba32float,write>;
// Direction of a texel: the cube map face layout of the WebGPU specification, u right and v down on each face.
fn faceRay(face:u32,u:f32,v:f32)->vec3f {
  switch face {
    case 0u {return vec3f(1,-v,-u);}
    case 1u {return vec3f(-1,-v,u);}
    case 2u {return vec3f(u,1,v);}
    case 3u {return vec3f(u,-1,-v);}
    case 4u {return vec3f(u,-v,1);}
    default {return vec3f(-u,-v,-1);}
  }
}
@compute @workgroup_size(8,8) fn resample(@builtin(global_invocation_id) id:vec3u) {
  let size=textureDimensions(floatFaces).x;
  if(id.x>=size||id.y>=size){return;}
  let uv=(vec2f(id.xy)+0.5)/f32(size)*2.0-1.0;
  textureStore(floatFaces,id.xy,id.z,textureSampleLevel(source,sourceSampler,faceRay(id.z,uv.x,uv.y),0.0));
}`;
const powerOfTwo = (n: number) => n > 0 && (n & (n - 1)) === 0;
/** The next power of two at or above `n`. */
const ceilPower = (n: number) => 2 ** Math.ceil(Math.log2(n));
/** The six faces of `cube` as linear float RGBA, +X, -X, +Y, -Y, +Z, -Z, each `size` x `size`. */
async function readFaces(device: GPUDevice, cube: CubeTexture, size: number): Promise<Float32Array[]> {
  const bound = cube.bind(device, true);
  if (!bound)
    throw new MargoError('state', 'prefilterCube needs a CubeTexture whose images have loaded; wait for them first');
  const float = cube.unfilterable && !device.features.has('float32-filterable'),
    layout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: float ? 'unfilterable-float' : 'float', viewDimension: 'cube' },
        },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, sampler: { type: float ? 'non-filtering' : 'filtering' } },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: 'write-only', format: 'rgba32float', viewDimension: '2d-array' },
        },
      ],
    }),
    pipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module: device.createShaderModule({ code: faceRay }), entryPoint: 'resample' },
    }),
    filter = float ? 'nearest' : 'linear',
    faces = device.createTexture({
      size: [size, size, 6],
      format: 'rgba32float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
    }),
    bytes = size * 16,
    buffer = device.createBuffer({ size: bytes * size * 6, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
    encoder = device.createCommandEncoder(),
    pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(
    0,
    device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: bound[0] },
        { binding: 1, resource: device.createSampler({ magFilter: filter, minFilter: filter }) },
        { binding: 2, resource: faces.createView({ dimension: '2d-array' }) },
      ],
    }),
  );
  pass.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(size / 8), 6);
  pass.end();
  encoder.copyTextureToBuffer(
    { texture: faces },
    { buffer, bytesPerRow: bytes, rowsPerImage: size },
    { width: size, height: size, depthOrArrayLayers: 6 },
  );
  device.queue.submit([encoder.finish()]);
  try {
    await buffer.mapAsync(GPUMapMode.READ);
    const all = new Float32Array(buffer.getMappedRange().slice(0)),
      count = size * size * 4;
    return Array.from({ length: 6 }, (_, face) => all.subarray(face * count, (face + 1) * count));
  } finally {
    buffer.destroy();
    faces.destroy();
  }
}
/**
 * Prefilters a plain `CubeTexture` by roughness: returns an `Environment` (GGX-filtered mips and irradiance harmonics)
 * to pass as `envMap`, so rough surfaces show a GGX blur where a CubeTexture's own mips show a per-face box blur. The
 * source cube is left as it is. Needs `@margoengine/environment` installed.
 * @throws TypeError without a CubeTexture; RangeError for a bad `size`; MargoError `'unsupported'` without a GPU,
 * `'state'` when the cube has no pixels yet; the signal's reason when it aborts.
 */
export async function prefilterCube(
  target: PrefilterTarget,
  cube: CubeTexture,
  { size, signal, ...options }: PrefilterOptions = {},
): Promise<Environment> {
  if (!cube || typeof cube.bind !== 'function' || cube.dimension !== 'cube')
    throw new TypeError('prefilterCube needs a CubeTexture; pass one');
  const edge = size ?? Math.min(1024, Math.max(16, ceilPower(cube.width)));
  if (!Number.isSafeInteger(edge) || !powerOfTwo(edge) || edge < 16 || edge > 2048)
    throw new RangeError('prefilterCube size must be a power of two from 16 to 2048; pass one such as 256');
  const device = 'createBuffer' in target ? target : target.gpu;
  if (!device) throw new MargoError('unsupported', 'prefilterCube needs WebGPU; pass a WebGPU engine or its device');
  signal?.throwIfAborted();
  const faces = await readFaces(device, cube, edge);
  signal?.throwIfAborted();
  const { Environment } = await import('@margoengine/environment');
  signal?.throwIfAborted();
  return Environment.create(device, { size: edge, faces }, options);
}
