// Reading a GPU `Scatter`'s instances back to the CPU (`@margoengine/scatter/read`): the last frame's cull output, one
// list per LOD ring, turned into rigid world transforms by the same placement the vertex stage applies (pose.ts
// `scatterPose`: yaw about +Y, then the rotation taking +Y to the instance's up, Rodrigues about Y x up, times scale,
// plus position). For a path tracer (`@margoengine/voxel-pathtracer/from-engine` takes the result as a `scatter`
// source), picking or export.
//
// `pose: true` also poses every vertex on the GPU (FG-17-WIND): a compute kernel runs the scatter's own vertex pose,
// `scatterPose` with every patch the scatter applies to its vertex stages (grass blades, plant states, plant motion,
// trampling, terrain tint), once with this frame's wind and once with the wind of the frame before, and reads the
// world vertices back. That is the per-frame deformed mesh a ray tracer of animated geometry consumes: vertices posed
// each frame with the connectivity unchanged (Wald, Boulos and Shirley, "Ray Tracing Deformable Scenes Using Dynamic
// Bounding Volume Hierarchies", ACM TOG 26(1), 2007, https://doi.org/10.1145/1189762.1206075; Lauterbach, Yoon,
// Manocha and Tuft, "RT-DEFORM: Interactive Ray Tracing of Dynamic Scenes using BVHs", IEEE Symposium on Interactive
// Ray Tracing 2006, https://doi.org/10.1109/RT.2006.280217), and the per-plant deformed vertices that van Antwerpen,
// Gautron et al., "Real-time Path Tracing of Massive Dynamic Foliage" (HPG 2026, https://doi.org/10.1145/3820021)
// start from. The two poses are the ends of a shutter over which each vertex moves on a straight line (Cook, Porter
// and Carpenter, "Distributed Ray Tracing", SIGGRAPH 1984, https://doi.org/10.1145/964965.808590: each ray a time, the
// scene at that time), which `TraceTriangleMesh.previousPositions` takes as it is. The bend is the vertex stage's own
// (wind.ts `windBend`, after the procedural bend of Sousa, "Vegetation Procedural Animation and Shading in Crysis",
// GPU Gems 3 ch. 16, 2007), so a traced frame bends each plant exactly as the raster frame did.
import type { EngineKernel, Geometry } from '@margoengine/core';
import type { Scatter, ScatterVelocityParts } from './index.js';
import { margoError } from '../../shared/errors.js';
import { mapRead } from '../../shared/map-read.js';

declare const GPUBufferUsage: {
  COPY_DST: number;
  COPY_SRC: number;
  MAP_READ: number;
  STORAGE: number;
  UNIFORM: number;
};
declare const GPUMapMode: { READ: number };

/** One LOD ring's instances. */
export interface ScatterReadRing {
  /** The ring's mesh (positions and normals in `vertices`, as core `Geometry` holds them). */
  readonly geometry: Geometry;
  /** Column-major 4 x 4 world transforms, 16 floats per instance. */
  readonly transforms: Float32Array;
  /** The ring's instances posed vertex by vertex, with `pose: true`; undefined otherwise or for an empty ring. */
  readonly posed?: ScatterPosedRing;
}
/**
 * A ring's instances as one world-space triangle mesh (`readScatter` with `pose: true`): each instance's copy of the
 * ring mesh, in the order of `transforms`, posed as the vertex stage poses it.
 */
export interface ScatterPosedRing {
  /** World xyz per vertex: the ring mesh's vertices for the first instance, then the second's, and so on. */
  readonly positions: Float32Array;
  /** Unit world shading normals, one xyz per vertex. */
  readonly normals: Float32Array;
  /**
   * The same vertices posed with the wind of the last frame drawn on an earlier wind clock, so each moves on a
   * straight line from here to `positions` over a shutter. Equal to `positions` on a scatter's first frame and after
   * `resetTime`. Plant states, trampling and the eye stay at the last frame's.
   */
  readonly previousPositions: Float32Array;
  /** Three indices per triangle into `positions`: the ring mesh's triangles for each instance. */
  readonly indices: Uint32Array;
}
/** What {@link readScatter} returns: the rings, near to far, and the scatter's surface. */
export interface ScatterReadout {
  readonly rings: readonly ScatterReadRing[];
  /** Linear albedo the scatter draws with (its `material`'s colour when it has one, else `color`). */
  readonly color: readonly [number, number, number];
  /** Perceptual roughness and metalness (of `material`; 1 and 0 without one). */
  readonly roughness: number;
  readonly metalness: number;
}
/** Settings of {@link readScatter}. */
export interface ScatterReadOptions {
  /** Stops the wait for the GPU read; the promise then rejects with the signal's reason. */
  readonly signal?: AbortSignal;
  /**
   * Also pose every vertex of every instance on the GPU (default false): each ring gets `posed`, its instances as one
   * world mesh bent by the wind as drawn, with grass blades, plant states, plant motion and trampling, the blades at
   * their true width (the raster-only widening with distance and the pixel floor are left out, since a path tracer
   * resolves thin blades with its own samples). Costs one compute pass and a read of 36 bytes a vertex.
   */
  readonly pose?: boolean;
}

/**
 * Reads the instances a `Scatter` culled in its last frame: those the camera saw within the last LOD distance, after
 * height, slope, density, exclusion and path rules, before any occlusion pass. An instance cross-fading between two
 * rings is kept once, in the nearer ring. Transforms are rigid; with `pose: true` each ring also carries its posed
 * vertices (the wind's bend now and a frame before, blades, plant states). Render a frame first.
 *
 * ```ts
 * engine.render();
 * const { rings } = await readScatter(engine, scatter, { pose: true, signal: AbortSignal.timeout(10_000) });
 * console.log(rings.map((r) => r.transforms.length / 16), rings[0].posed?.positions.length);
 * ```
 * @throws MargoError `'state'` when the scatter has not drawn a frame on this engine's WebGPU device, or is disposed;
 * `'unsupported'` when one posed instance of a ring is larger than a storage binding; TypeError for a `pose` that is
 * not a boolean.
 */
export async function readScatter(
  engine: EngineKernel,
  scatter: Scatter,
  { signal, pose = false }: ScatterReadOptions = {},
): Promise<ScatterReadout> {
  signal?.throwIfAborted();
  if (typeof pose !== 'boolean') throw new TypeError('readScatter pose must be true or false');
  const device = (engine as { gpu?: GPUDevice })?.gpu,
    parts = typeof scatter?.velocityParts === 'function' ? scatter.velocityParts() : undefined;
  if (!device || !parts)
    throw margoError(
      'state',
      'readScatter needs a Scatter attached to this WebGPU engine that has drawn a frame; attach it and call engine.render() first',
    );
  // This frame's values, copied before the wait: a frame drawn meanwhile must not change the pose.
  const values = parts.values.slice(),
    windBefore = parts.windBefore.slice(),
    { instances, commands } = parts.cull,
    sizes = instances.map((b) => b.size),
    total = 64 + sizes.reduce((a, b) => a + b, 0),
    buffer = device.createBuffer({ size: total, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  let words: Uint32Array;
  try {
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(commands, 0, buffer, 0, 60);
    let at = 64;
    instances.forEach((b, i) => {
      encoder.copyBufferToBuffer(b, 0, buffer, at, sizes[i]);
      at += sizes[i];
    });
    device.queue.submit([encoder.finish()]);
    await mapRead(buffer, signal);
    words = new Uint32Array(buffer.getMappedRange().slice(0));
    buffer.unmap();
  } finally {
    buffer.destroy();
  }
  const floats = new Float32Array(words.buffer),
    align = values[72],
    kept: number[][] = [];
  let base = 16;
  const rings: ScatterReadRing[] = instances.map((_, ring) => {
    const count = Math.min(words[ring * 5 + 1], sizes[ring] / 32),
      out = new Float32Array(count * 16),
      slots: number[] = [];
    for (let k = 0; k < count; k++) {
      const f = base + k * 8;
      // Fade mode 2 is the far copy of an instance drawn in two rings; its near copy (mode 1) stands for it.
      if (floats[f + 7] === 2) continue;
      instanceMatrix(floats, f, align, out, slots.length * 16);
      slots.push(k);
    }
    base += sizes[ring] / 4;
    kept.push(slots);
    return {
      geometry: parts.geometries[ring],
      transforms: slots.length === count ? out : out.slice(0, slots.length * 16),
    };
  });
  if (pose)
    for (let ring = 0; ring < rings.length; ring++) {
      const slots = kept[ring],
        geometry = rings[ring].geometry;
      if (!slots.length || !geometry.indices.length) continue;
      const posed = await poseRing(device, parts, values, windBefore, ring, slots, geometry, signal);
      rings[ring] = { ...rings[ring], posed };
    }
  const material = scatter.options.material?.data;
  return {
    rings,
    color: material ? [material[0], material[1], material[2]] : [values[40], values[41], values[42]],
    roughness: material ? material[4] : 1,
    metalness: material ? material[5] : 0,
  };
}

/** Floats the pose kernel writes a vertex: world position, unit normal, the position a frame before. */
const POSED = 9;
/** Invocations a workgroup, and workgroups along x before a dispatch wraps to y. */
const GROUP = 64;
const ROW = 65535;
/**
 * WGSL of the pose kernel on `source`, the scatter's unpatched pose functions (`ScatterVelocityParts.poseSource`, so
 * this entry carries no copy of them), with its pose patches applied by `pose` (`ScatterVelocityParts.pose`, their
 * bindings from 2 in group 0, as in every posing stage). Each invocation poses one vertex: instance `counts.w + i /
 * counts.y` of `instances`, vertex `i % counts.y` of `readMesh` (`counts.z` floats a vertex), `counts.x` instances in
 * all, into 9 floats of `readPosed`: world position, unit normal, and the position under the wind before.
 */
export const poseKernel = (source: string, pose: (code: string, binding: number) => string): string =>
  pose(
    source +
      `
struct ReadFrame {eye:vec4f,wind:vec4f,windBefore:vec4f,ground:vec4f,blade:vec4f,counts:vec4u}
struct Instance {position:vec4f,rotation:vec4f}
@group(0) @binding(0) var<uniform> readFrame:ReadFrame;
@group(0) @binding(1) var<storage,read> instances:array<Instance>;
@group(1) @binding(0) var<storage,read> readMesh:array<f32>;
@group(1) @binding(1) var<storage,read_write> readPosed:array<f32>;
@compute @workgroup_size(${GROUP}) fn main(@builtin(global_invocation_id) id:vec3u){
 let f=readFrame;let vertices=f.counts.y;let i=id.x+id.y*${ROW * GROUP}u;if(i>=f.counts.x*vertices){return;}
 let data=instances[f.counts.w+i/vertices];let m=(i%vertices)*f.counts.z;
 let p=vec3f(readMesh[m],readMesh[m+1u],readMesh[m+2u]);let n=vec3f(readMesh[m+3u],readMesh[m+4u],readMesh[m+5u]);
 let now=scatterPose(p,n,data.position,data.rotation,f.ground,f.blade,f.eye.xyz,f.wind,f.eye.w);
 let then=scatterPose(p,n,data.position,data.rotation,f.ground,f.blade,f.eye.xyz,f.windBefore,f.eye.w).world;
 let normal=select(vec3f(0,1,0),normalize(now.normal),dot(now.normal,now.normal)>1e-30);let o=i*${POSED}u;
 readPosed[o]=now.world.x;readPosed[o+1u]=now.world.y;readPosed[o+2u]=now.world.z;
 readPosed[o+3u]=normal.x;readPosed[o+4u]=normal.y;readPosed[o+5u]=normal.z;
 readPosed[o+6u]=then.x;readPosed[o+7u]=then.y;readPosed[o+8u]=then.z;
}`,
    2,
  );

/**
 * The kernel's frame uniform (96 bytes): eye with no pixel floor, the wind now and before, the ground fit, the blades
 * with no widening, then the counts (instances, vertices, floats a vertex, first slot), from the colour pass's frame
 * values (eye 16-18, wind 68-71, ground fit 72-75, blades 76-79).
 */
export function poseFrame(values: ArrayLike<number>, windBefore: ArrayLike<number>, vertices: number): ArrayBuffer {
  const frame = new ArrayBuffer(96),
    f = new Float32Array(frame),
    u = new Uint32Array(frame);
  for (let i = 0; i < 3; i++) f[i] = values[16 + i];
  for (let i = 0; i < 4; i++) {
    f[4 + i] = values[68 + i];
    f[8 + i] = windBefore[i];
    f[12 + i] = values[72 + i];
    f[16 + i] = values[76 + i];
  }
  f[3] = 0; // the pixel footprint: no floor, blades at their true width
  f[17] = 0; // blade.y, widen / far: no widening with distance
  u[21] = vertices;
  u[22] = 6;
  return frame;
}

const pipelines = new WeakMap<GPUDevice, Map<string, GPUComputePipeline>>();

/** Poses the kept slots of one ring on the GPU, in chunks a storage binding holds, and reads them back. */
async function poseRing(
  device: GPUDevice,
  parts: ScatterVelocityParts,
  values: Float32Array,
  windBefore: Float32Array,
  ring: number,
  slots: readonly number[],
  geometry: Geometry,
  signal: AbortSignal | undefined,
): Promise<ScatterPosedRing> {
  const code = poseKernel(parts.poseSource, parts.pose);
  let cache = pipelines.get(device);
  if (!cache) pipelines.set(device, (cache = new Map()));
  let pipeline = cache.get(code);
  if (!pipeline) {
    pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code }), entryPoint: 'main' },
    });
    cache.set(code, pipeline);
  }
  const vertices = geometry.vertices.length / 6,
    triangles = geometry.indices,
    n = slots.length,
    last = slots[n - 1],
    bytesPerInstance = vertices * POSED * 4,
    limit = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
  if (bytesPerInstance > limit)
    throw margoError(
      'unsupported',
      'readScatter pose needs one posed instance of a ring mesh to fit a storage binding; use a ring mesh with fewer vertices',
    );
  // Slots are posed in runs from the first kept one; the far copies of fade-band instances among them are skipped below.
  const chunk = Math.max(
      1,
      Math.min(
        last - slots[0] + 1,
        Math.floor(limit / bytesPerInstance),
        Math.floor((ROW * GROUP * device.limits.maxComputeWorkgroupsPerDimension) / vertices),
      ),
    ),
    frame = poseFrame(values, windBefore, vertices),
    counts = new Uint32Array(frame),
    mesh = device.createBuffer({
      size: Math.max(16, geometry.vertices.byteLength),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    }),
    uniform = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    out = device.createBuffer({
      size: chunk * bytesPerInstance,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    }),
    read = device.createBuffer({
      size: chunk * bytesPerInstance,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    }),
    positions = new Float32Array(n * vertices * 3),
    normals = new Float32Array(n * vertices * 3),
    previousPositions = new Float32Array(n * vertices * 3),
    indices = new Uint32Array(n * triangles.length);
  try {
    device.queue.writeBuffer(mesh, 0, geometry.vertices as Float32Array<ArrayBuffer>);
    const own = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ buffer: uniform }, { buffer: parts.cull.instances[ring] }, ...parts.entries()].map(
          (resource, binding) => ({ binding, resource }),
        ),
      }),
      io = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(1),
        entries: [
          { binding: 0, resource: { buffer: mesh } },
          { binding: 1, resource: { buffer: out } },
        ],
      });
    let next = 0; // the next kept instance to write out
    for (let from = slots[0]; from <= last; from += chunk) {
      const count = Math.min(chunk, last + 1 - from),
        bytes = count * bytesPerInstance,
        workgroups = Math.ceil((count * vertices) / GROUP);
      counts[20] = count;
      counts[23] = from;
      device.queue.writeBuffer(uniform, 0, frame);
      const encoder = device.createCommandEncoder(),
        pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, own);
      pass.setBindGroup(1, io);
      pass.dispatchWorkgroups(Math.min(workgroups, ROW), Math.ceil(workgroups / ROW));
      pass.end();
      encoder.copyBufferToBuffer(out, 0, read, 0, bytes);
      device.queue.submit([encoder.finish()]);
      await mapRead(read, signal);
      const data = new Float32Array(read.getMappedRange(0, bytes).slice(0));
      read.unmap();
      for (; next < n && slots[next] < from + count; next++) {
        const src = (slots[next] - from) * vertices * POSED,
          dst = next * vertices * 3;
        for (let v = 0; v < vertices; v++) {
          const s = src + v * POSED,
            d = dst + v * 3;
          positions[d] = data[s];
          positions[d + 1] = data[s + 1];
          positions[d + 2] = data[s + 2];
          normals[d] = data[s + 3];
          normals[d + 1] = data[s + 4];
          normals[d + 2] = data[s + 5];
          previousPositions[d] = data[s + 6];
          previousPositions[d + 1] = data[s + 7];
          previousPositions[d + 2] = data[s + 8];
        }
        const offset = next * vertices,
          at = next * triangles.length;
        for (let t = 0; t < triangles.length; t++) indices[at + t] = triangles[t] + offset;
      }
    }
  } finally {
    mesh.destroy();
    uniform.destroy();
    out.destroy();
    read.destroy();
  }
  return { positions, normals, previousPositions, indices };
}

/**
 * Writes the world transform of the instance at `floats[f..f + 8)` (position xyz, scale, yaw, packed ground normal,
 * fade, fade mode) into `out` at `o`, with `align` the scatter's `alignToGround`.
 */
export function instanceMatrix(floats: ArrayLike<number>, f: number, align: number, out: Float32Array, o = 0): void {
  const scale = floats[f + 3],
    c = Math.cos(floats[f + 4]),
    s = Math.sin(floats[f + 4]),
    packed = floats[f + 5],
    gz = Math.floor(packed / 4096),
    gx = (packed - gz * 4096) / 2047.5 - 1,
    gzz = gz / 2047.5 - 1,
    gy = Math.sqrt(Math.max(0, 1 - gx * gx - gzz * gzz)),
    ux = gx * align,
    uy = 1 + (gy - 1) * align,
    uz = gzz * align,
    ul = Math.hypot(ux, uy, uz),
    x = ux / ul,
    y = uy / ul,
    z = uz / ul;
  // Columns: scatterTurn of the yawed basis vectors, k = (up.z, 0, -up.x).
  for (let a = 0; a < 3; a++) {
    const rx = a === 0 ? c : a === 2 ? s : 0,
      ry = a === 1 ? 1 : 0,
      rz = a === 0 ? -s : a === 2 ? c : 0,
      kx = z,
      kz = -x,
      kr = kx * rx + kz * rz,
      // cross(k, r) with k.y = 0.
      cx = -kz * ry,
      cy = kz * rx - kx * rz,
      cz = kx * ry;
    out[o + a * 4] = (rx * y + cx + (kx * kr) / (1 + y)) * scale;
    out[o + a * 4 + 1] = (ry * y + cy) * scale;
    out[o + a * 4 + 2] = (rz * y + cz + (kz * kr) / (1 + y)) * scale;
    out[o + a * 4 + 3] = 0;
  }
  out[o + 12] = floats[f];
  out[o + 13] = floats[f + 1];
  out[o + 14] = floats[f + 2];
  out[o + 15] = 1;
}
