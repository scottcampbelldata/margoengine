// Shadows by rays: each lit pixel asks a BVH of the scene whether the sun is in sight, so edges are exact where a map's are
// a texel, and a sun of some size gives the penumbra of the rays that reach it (Cook et al. 1984). WebGPU has no ray queries
// yet, so the rays walk the tree in the fragment shader; see `rayTracedFilter`.
import { GPUMeshBVH, bvhWGSL } from '@margoengine/bvh/gpu';
import type { MeshBVH } from '@margoengine/bvh';
import type { ShadowEffectFrame, ShadowFilter, ShadowFilterEffect } from './shader.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
/** {@link rayTracedFilter} settings. All but `fallback` are read every frame from the effect's `options`. */
export interface RayTracedFilterOptions {
  /** Rays per lit pixel, a whole number from 1 to 256. One is enough for a sun of no size. Default 16. */
  rays?: number;
  /** Tangent of the sun's angular radius, as `lightSize` of `Shadows`, 0 or more. Default 0: an exact hard edge. */
  lightSize?: number;
  /** World units a ray starts off its surface, along the normal, above 0. Default 0.001. */
  bias?: number;
  /** World units a ray goes towards the sun, above 0. Default 1e6. */
  far?: number;
  /** The map filter used where a fragment shader cannot read storage buffers. Default 'soft'. */
  fallback?: ShadowFilter;
}
/** The filter `rayTracedFilter` returns, with live `options`. */
export interface RayTracedFilter<Context = unknown> extends ShadowFilterEffect<Context> {
  readonly options: RayTracedFilterOptions;
  /** Sends the tree again after `bvh.refit()`. */
  refit(): void;
}
/** Anything that has a device, such as an `Engine` on WebGPU. */
export interface RayTracingTarget {
  readonly gpu: GPUDevice | null;
}
/** True where a fragment shader can walk a tree: four storage buffers there, which WebGPU's compatibility level may withhold. */
export const canTraceShadows = (target: RayTracingTarget): boolean => {
  const limits = target.gpu?.limits as (GPUSupportedLimits & { maxStorageBuffersInFragmentStage?: number }) | undefined;
  return !!limits && (limits.maxStorageBuffersInFragmentStage ?? limits.maxStorageBuffersPerShaderStage) >= 4;
};
/**
 * Exact shadows from rays against `bvh`, in place of a map filter: `Shadows.attach(engine, {filter: rayTracedFilter(engine, bvh,
 * {lightSize: 0.02, rays: 32})})`, with `bvh` from `MeshBVH.build(worldTriangles(engine, [model]))`. Only the tree casts, and
 * only inside the map's reach. Where the device cannot do this it answers `fallback`, a map filter, so the option stays valid.
 * WebGPU has no ray queries yet: the rays walk the tree in the fragment shader, on any GPU, and no hardware path is used.
 */
export function rayTracedFilter<Context extends { device: GPUDevice }>(
  target: RayTracingTarget,
  bvh: MeshBVH,
  options: RayTracedFilterOptions = {},
): RayTracedFilter<Context> | ShadowFilter {
  if (!canTraceShadows(target)) return options.fallback ?? 'soft';
  const values = new Float32Array(8);
  let tree: GPUMeshBVH | undefined, uniform: GPUBuffer | undefined;
  const free = () => {
    tree?.dispose();
    uniform?.destroy();
    tree = uniform = undefined;
  };
  return {
    options,
    // Read before `wgsl` runs, so its names carry no binding: a map has one filter. `position` and `normal` are the receiver's.
    body: /* wgsl */ `
  let ray=shadowFxRayData;let toLight=ray.light.xyz;let start=position+normalize(normal)*ray.settings.y;
  let side=normalize(cross(toLight,select(vec3f(1,0,0),vec3f(0,0,1),abs(toLight.x)>0.7)));let up=cross(toLight,side);
  let count=u32(ray.settings.x);let angle=shadowNoise(position).x*6.2831853;var seen=0u;
  for(var j=0u;j<count;j++){
    let spin=angle+f32(j)*2.39996323;let radius=sqrt((f32(j)+0.5)/f32(count))*ray.light.w;
    let direction=toLight+(side*cos(spin)+up*sin(spin))*radius;
    if(shadowFxBvhAny(start,direction,0.0,ray.settings.z,0u).face==BVH_MISS){seen++;}
  }
  return f32(seen)/f32(count);`,
    wgsl(group, at) {
      // moveEffects finds an effect's bindings by the shadowFx prefix.
      return `${bvhWGSL({ group, binding: at }).replace(/\bbvh([A-Z])/g, 'shadowFxBvh$1')}
struct ShadowFxRay {light:vec4f,settings:vec4f}
@group(${group}) @binding(${at + 5}) var<uniform> shadowFxRayData:ShadowFxRay;
`;
    },
    resources() {
      const t = tree!;
      return [t.nodes, t.index, t.faces, t.positions, t.params, uniform!].map((buffer) => ({ buffer }));
    },
    setup(device: GPUDevice) {
      free();
      tree = GPUMeshBVH.forShader(device, bvh);
      uniform = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    },
    update(frame: ShadowEffectFrame<Context>) {
      const { rays = 16, lightSize = 0, bias = 0.001, far = 1e6 } = options;
      if (!Number.isInteger(rays) || rays < 1 || rays > 256) throw new RangeError('Invalid ray count; use a whole number from 1 to 256');
      if (!(lightSize >= 0)) throw new RangeError('Invalid ray traced lightSize; use 0 or more');
      if (!(bias > 0) || !(far > 0)) throw new RangeError('Invalid ray traced bias or far; use numbers above 0');
      values.set(frame.light);
      values[3] = lightSize;
      values[4] = rays;
      values[5] = bias;
      values[6] = far;
      frame.context.device.queue.writeBuffer(uniform!, 0, values);
    },
    refit() {
      tree?.update();
    },
    dispose: free,
  };
}
