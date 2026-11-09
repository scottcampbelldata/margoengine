/// <reference lib="esnext.disposable" preserve="true" />
import type { AlphaMask, AlphaWrap, ModelAlphaMaskSource } from '@margoengine/bvh/alpha';
import type { AlphaWorldTriangles } from '@margoengine/bvh/alpha-triangles';
import type { MeshBVH } from '@margoengine/bvh';
import { fault } from '../../shared/errors.js';
import { rayTracedFilter, type RayTracedAlpha, type RayTracedFilterOptions, type RayTracingTarget } from './rt.js';

declare const GPUBufferUsage: { STORAGE: number; COPY_DST: number };
/** Explicit primitive lookup, or one or more modelAlphaMasks sources. Unmasked/unsupported materials stay opaque. */
export type RayTracedMaskSource =
  | ModelAlphaMaskSource
  | readonly ModelAlphaMaskSource[]
  | ((primitive: NonNullable<AlphaWorldTriangles['ranges'][number]['primitive']>) => AlphaMask | null | undefined);
/** Owned CPU storage image of candidate UVs and masks. Face numbers are original source face indices. */
export interface PackedRayTracedAlpha {
  readonly data: Uint32Array;
  readonly faceCount: number;
  readonly maskCount: number;
}
const fail = (message: string) =>
  fault('failed', `${message}; rebuild alphaWorldTriangles and provide valid RGBA8 masks`);
const wrapCode = (value: AlphaWrap): number => {
  const code = ['repeat', 'mirror', 'clamp'].indexOf(value);
  if (code < 0) throw fail('Invalid alpha wrap mode');
  return code;
};
const finite = (value: number): boolean => typeof value === 'number' && Number.isFinite(Math.fround(value));
/**
 * Snapshot per-face UVs, deduplicated material coverage and packed alpha bytes into one storage buffer image.
 * This is CPU-only; changes to UVs, masks or topology require repacking. Non-MASK and skipped masks stay opaque.
 */
export function packRayTracedAlpha(triangles: AlphaWorldTriangles, source: RayTracedMaskSource): PackedRayTracedAlpha {
  const faceCount = triangles.indices.length / 3;
  if (
    !Number.isInteger(faceCount) ||
    4 + faceCount * 8 > 0x3ffffff ||
    triangles.uv.length !== faceCount * 6 ||
    !triangles.uv.every(finite)
  )
    throw fail('Invalid face UV storage');
  const masks: AlphaMask[] = [],
    lookup = new Map<AlphaMask, number>(),
    faces = new Uint32Array(faceCount).fill(0xffffffff);
  const sources = Array.isArray(source) ? source : undefined;
  const read = (primitive: NonNullable<AlphaWorldTriangles['ranges'][number]['primitive']>) => {
    if (sources) {
      for (const s of sources) {
        const mask = s.forPrimitive(primitive);
        if (mask) return mask;
      }
      return null;
    }
    return 'forPrimitive' in source
      ? source.forPrimitive(primitive)
      : (source as (p: typeof primitive) => AlphaMask | null | undefined)(primitive);
  };
  let covered = 0,
    pixelWords = 0;
  for (const range of triangles.ranges) {
    if (
      !Number.isInteger(range.firstFace) ||
      range.firstFace !== covered ||
      !Number.isInteger(range.faceCount) ||
      range.faceCount < 0 ||
      covered + range.faceCount > faceCount
    )
      throw fail('Invalid primitive face ranges');
    covered += range.faceCount;
    const mask = range.primitive && read(range.primitive);
    if (!mask) continue;
    let index = lookup.get(mask);
    if (index === undefined) {
      const { width, height, data, cutoff = 0.5, factor = 1, transform, wrap = 'repeat' } = mask;
      if (
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width < 1 ||
        height < 1 ||
        width > 1048576 ||
        height > 1048576 ||
        data.length !== width * height * 4 ||
        !finite(cutoff) ||
        cutoff < 0 ||
        cutoff > 1 ||
        !finite(factor) ||
        factor < 0 ||
        factor > 1 ||
        (transform && (transform.length !== 6 || !transform.every(finite)))
      )
        throw fail('Invalid alpha mask');
      const wraps = typeof wrap === 'string' ? [wrap, wrap] : wrap;
      if (wraps.length !== 2) throw fail('Invalid alpha wrap pair');
      wraps.forEach(wrapCode);
      for (let i = 0; i < data.length; i++)
        if (!Number.isInteger(data[i]) || data[i] < 0 || data[i] > 255) throw fail('Invalid RGBA8 mask byte');
      index = masks.length;
      lookup.set(mask, index);
      masks.push(mask);
      pixelWords += Math.ceil((width * height) / 4);
    }
    faces.fill(index, range.firstFace, range.firstFace + range.faceCount);
  }
  if (covered !== faceCount) throw fail('Incomplete primitive face ranges');
  const materialAt = 4 + faceCount * 8,
    pixelsAt = materialAt + masks.length * 16,
    wordCount = pixelsAt + pixelWords;
  if (wordCount > 0x3ffffff) throw fail('Alpha storage exceeds the 256 MiB CPU packing limit');
  const data = new Uint32Array(wordCount),
    floats = new Float32Array(data.buffer);
  data.set([faceCount, materialAt, pixelsAt, masks.length]);
  for (let face = 0; face < faceCount; face++) {
    const at = 4 + face * 8;
    floats.set(triangles.uv.subarray(face * 6, face * 6 + 6), at);
    data[at + 6] = faces[face];
  }
  let pixelAt = pixelsAt;
  masks.forEach((mask, i) => {
    const at = materialAt + i * 16,
      wrap = mask.wrap ?? 'repeat',
      [u, v] = typeof wrap === 'string' ? [wrap, wrap] : wrap;
    data.set([mask.width, mask.height, pixelAt, wrapCode(u) | (wrapCode(v) << 2)], at);
    floats[at + 4] = mask.cutoff ?? 0.5;
    floats[at + 5] = mask.factor ?? 1;
    floats.set(mask.transform ?? [1, 0, 0, 0, 1, 0], at + 6);
    for (let p = 0; p < mask.width * mask.height; p++)
      data[pixelAt + (p >>> 2)] |= mask.data[p * 4 + 3] << ((p & 3) * 8);
    pixelAt += Math.ceil((mask.width * mask.height) / 4);
  });
  checkCoordinates(data);
  return { data, faceCount, maskCount: masks.length };
}

// Bounding all three vertex UVs also bounds their barycentric interpolation. Leave room for float32 rounding
// before the affine rows: individually finite coefficients and UVs can otherwise overflow in their products/sum.
function checkCoordinates(data: Uint32Array): void {
  const values = new Float32Array(data.buffer, data.byteOffset, data.length);
  for (let face = 0; face < data[0]; face++) {
    const at = 4 + face * 8,
      mask = data[at + 6];
    if (mask === 0xffffffff) continue;
    const u = Math.max(Math.abs(values[at]), Math.abs(values[at + 2]), Math.abs(values[at + 4])),
      v = Math.max(Math.abs(values[at + 1]), Math.abs(values[at + 3]), Math.abs(values[at + 5])),
      row = data[1] + mask * 16 + 6;
    for (let axis = 0; axis < 2; axis++) {
      const r = row + axis * 3,
        bound = Math.abs(values[r]) * u + Math.abs(values[r + 1]) * v + Math.abs(values[r + 2]);
      if (!finite(4 * bound)) throw fail('Alpha UV arithmetic needs fourfold finite float32 headroom');
    }
  }
}

/** Upload an owned snapshot, preserving CPU data for device restore. Dispose releases only GPU objects. */
export function createRayTracedAlpha(packed: PackedRayTracedAlpha): RayTracedAlpha & Disposable {
  if (!(packed.data instanceof Uint32Array) || packed.data.length > 0x3ffffff)
    throw fail('Invalid packed alpha storage');
  const data = packed.data.slice();
  if (
    data.length < 4 ||
    data[0] !== packed.faceCount ||
    data[3] !== packed.maskCount ||
    data[1] !== 4 + data[0] * 8 ||
    data[2] !== data[1] + data[3] * 16 ||
    data[2] > data.length
  )
    throw fail('Invalid packed alpha header');
  const floats = new Float32Array(data.buffer);
  for (let face = 0; face < data[0]; face++) {
    const at = 4 + face * 8;
    if (floats.subarray(at, at + 6).some((v) => !finite(v)) || (data[at + 6] !== 0xffffffff && data[at + 6] >= data[3]))
      throw fail('Invalid packed face');
  }
  let next = data[2];
  for (let i = 0; i < data[3]; i++) {
    const at = data[1] + i * 16,
      width = data[at],
      height = data[at + 1],
      mode = data[at + 3];
    if (
      !width ||
      !height ||
      width > 1048576 ||
      height > 1048576 ||
      data[at + 2] !== next ||
      mode > 10 ||
      (mode & 3) > 2 ||
      ((mode >> 2) & 3) > 2 ||
      floats.subarray(at + 4, at + 12).some((v) => !finite(v)) ||
      floats[at + 4] < 0 ||
      floats[at + 4] > 1 ||
      floats[at + 5] < 0 ||
      floats[at + 5] > 1
    )
      throw fail('Invalid packed material');
    next += Math.ceil((width * height) / 4);
  }
  if (next !== data.length) throw fail('Invalid packed pixels');
  checkCoordinates(data);
  let buffer: GPUBuffer | undefined;
  const dispose = () => {
    buffer?.destroy();
    buffer = undefined;
  };
  return {
    wgsl: (group, binding) => alphaWGSL(group, binding),
    resources() {
      if (!buffer) throw fault('failed', 'Alpha resources need setup on the current device first');
      return [{ buffer }];
    },
    setup(device) {
      buffer?.destroy();
      buffer = undefined;
      if (data.byteLength > Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize))
        throw fault(
          'unsupported',
          'Alpha shadow data exceeds device buffer limits; use smaller scenes or the map fallback',
        );
      buffer = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      try {
        device.queue.writeBuffer(buffer, 0, data);
      } catch (error) {
        buffer.destroy();
        buffer = undefined;
        throw error;
      }
    },
    dispose,
    [Symbol.dispose]: dispose,
  };
}
/** Build the normal RT filter with candidate cutout coverage. Low fragment-storage tiers use its map fallback. */
export function alphaRayTracedFilter<Context extends { device: GPUDevice }>(
  target: RayTracingTarget,
  bvh: MeshBVH,
  packed: PackedRayTracedAlpha,
  options: Omit<RayTracedFilterOptions, 'alpha'> = {},
) {
  if (packed.faceCount !== bvh.triangleCount) throw fail('Alpha face count differs from its BVH');
  return rayTracedFilter<Context>(target, bvh, { ...options, alpha: createRayTracedAlpha(packed) });
}

function alphaWGSL(group: number, binding: number): string {
  return /* wgsl */ `
@group(${group}) @binding(${binding}) var<storage,read> shadowFxAlphaData:array<u32>;
fn shadowFxAlphaFloat(at:u32)->f32{return bitcast<f32>(shadowFxAlphaData[at]);}
fn shadowFxAlphaIndex(p:i32,size:i32,wrap:u32)->u32{
  if(wrap==2u){return u32(clamp(p,0,size-1));}
  let period=select(size,size*2,wrap==1u);let q=((p%period)+period)%period;
  return u32(select(q,period-1-q,q>=size));
}
fn shadowFxAlphaPixel(base:u32,width:u32,height:u32,p:vec2i,wrap:vec2u)->f32{
  let i=shadowFxAlphaIndex(p.y,i32(height),wrap.y)*width+shadowFxAlphaIndex(p.x,i32(width),wrap.x);
  let word=shadowFxAlphaData[base+i/4u];return f32((word>>((i%4u)*8u))&255u)/255.0;
}
fn shadowFxAlphaWrap(x:f32,mode:u32)->f32{
  if(mode==2u){return clamp(x,0.0,1.0);}
  if(mode==1u){return 1.0-abs(fract(x*0.5)*2.0-1.0);}
  return fract(x);
}
fn shadowFxAlphaAccept(face:u32,barycoord:vec3f)->bool{
  let f=4u+face*8u;let material=shadowFxAlphaData[f+6u];
  if(material==0xffffffffu){return true;}
  let uv=vec2f(shadowFxAlphaFloat(f),shadowFxAlphaFloat(f+1u))*barycoord.x+
    vec2f(shadowFxAlphaFloat(f+2u),shadowFxAlphaFloat(f+3u))*barycoord.y+
    vec2f(shadowFxAlphaFloat(f+4u),shadowFxAlphaFloat(f+5u))*barycoord.z;
  let m=shadowFxAlphaData[1]+material*16u;
  let width=shadowFxAlphaData[m];let height=shadowFxAlphaData[m+1u];let base=shadowFxAlphaData[m+2u];
  let modes=shadowFxAlphaData[m+3u];let wrap=vec2u(modes&3u,(modes>>2u)&3u);
  let transformed=vec2f(shadowFxAlphaFloat(m+6u)*uv.x+shadowFxAlphaFloat(m+7u)*uv.y+shadowFxAlphaFloat(m+8u),
    shadowFxAlphaFloat(m+9u)*uv.x+shadowFxAlphaFloat(m+10u)*uv.y+shadowFxAlphaFloat(m+11u));
  let xy=vec2f(shadowFxAlphaWrap(transformed.x,wrap.x),shadowFxAlphaWrap(transformed.y,wrap.y))*vec2f(f32(width),f32(height))-0.5;
  let low=vec2i(floor(xy));let t=fract(xy);
  let upper=mix(shadowFxAlphaPixel(base,width,height,low,wrap),shadowFxAlphaPixel(base,width,height,low+vec2i(1,0),wrap),t.x);
  let lower=mix(shadowFxAlphaPixel(base,width,height,low+vec2i(0,1),wrap),shadowFxAlphaPixel(base,width,height,low+vec2i(1,1),wrap),t.x);
  return mix(upper,lower,t.y)*shadowFxAlphaFloat(m+5u)>=shadowFxAlphaFloat(m+4u);
}
`;
}
