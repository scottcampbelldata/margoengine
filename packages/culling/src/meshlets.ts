import type { EngineKernel } from '@margoengine/core';
import type { Geometry, PassContext } from '@margoengine/core/extension';
import { compatTier } from '../../shared/compat.js';
import type { CulledInstancesOptions } from './index.js';
import { CulledParts, type CulledPartsBatch } from './parts.js';

declare const GPUBufferUsage: {
  COPY_DST: number;
  COPY_SRC: number;
  INDEX: number;
  MAP_READ: number;
  STORAGE: number;
  UNIFORM: number;
};
declare const GPUMapMode: { READ: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** {@link buildMeshlets} settings. */
export interface MeshletOptions {
  /** Most distinct vertices in a cluster. Default: 64. */
  maxVertices?: number;
  /** Most triangles in a cluster. Default: 124. */
  maxTriangles?: number;
}
/** A mesh split into clusters. */
export interface Meshlets {
  /** Clusters. */
  count: number;
  /** The geometry's triangles, reordered so each cluster's are contiguous. */
  indices: Uint32Array;
  /** First index and index count of each cluster, two per cluster. */
  ranges: Uint32Array;
  /**
   * Eight floats per cluster, in the geometry's space: the bounding sphere (centre, radius), then the normal cone (axis, and
   * the sine of its half angle). A sine of -1 marks a cluster whose normals span a half space or more: no cone test.
   */
  bounds: Float32Array;
}

/**
 * Splits a geometry's triangles into clusters of neighbours, each with a bounding sphere and a cone holding its normals.
 * Grows each cluster breadth first from a free triangle over shared vertices.
 */
export function buildMeshlets(geometry: Geometry, { maxVertices = 64, maxTriangles = 124 }: MeshletOptions = {}): Meshlets {
  if (!Number.isInteger(maxVertices) || maxVertices < 3)
    throw new RangeError('Invalid maxVertices; pass a whole number of 3 or more');
  if (!Number.isInteger(maxTriangles) || maxTriangles < 1)
    throw new RangeError('Invalid maxTriangles; pass a whole number of 1 or more');
  const source = geometry.indices,
    vertices = geometry.vertices,
    triangles = Math.floor(source.length / 3),
    vertexCount = vertices.length / 6,
    // Each vertex's triangles, as offsets into one list.
    offsets = new Uint32Array(vertexCount + 1);
  for (let i = 0; i < triangles * 3; i++) offsets[source[i] + 1]++;
  for (let v = 0; v < vertexCount; v++) offsets[v + 1] += offsets[v];
  const fill = offsets.slice(),
    around = new Uint32Array(triangles * 3);
  for (let i = 0; i < triangles * 3; i++) around[fill[source[i]]++] = Math.floor(i / 3);
  const used = new Uint8Array(triangles),
    queued = new Uint32Array(triangles),
    seen = new Uint32Array(vertexCount),
    indices = new Uint32Array(triangles * 3),
    ranges: number[] = [],
    bounds: number[] = [];
  let written = 0,
    serial = 0;
  for (let seed = 0; seed < triangles; seed++) {
    if (used[seed]) continue;
    const first = written,
      queue = [seed];
    serial++;
    queued[seed] = serial;
    let distinct = 0,
      taken = 0;
    for (let head = 0; head < queue.length && taken < maxTriangles; head++) {
      const t = queue[head];
      if (used[t]) continue;
      let extra = 0;
      for (let k = 0; k < 3; k++) {
        const v = source[t * 3 + k];
        if (seen[v] !== serial && (k < 1 || v !== source[t * 3]) && (k < 2 || v !== source[t * 3 + 1])) extra++;
      }
      if (distinct + extra > maxVertices) continue;
      distinct += extra;
      used[t] = 1;
      taken++;
      for (let k = 0; k < 3; k++) {
        const v = source[t * 3 + k];
        seen[v] = serial;
        indices[written++] = v;
        for (let n = offsets[v]; n < offsets[v + 1]; n++) {
          const next = around[n];
          if (!used[next] && queued[next] !== serial) {
            queued[next] = serial;
            queue.push(next);
          }
        }
      }
    }
    ranges.push(first, written - first);
    clusterBounds(vertices, indices, first, written, bounds);
  }
  return {
    count: ranges.length / 2,
    indices,
    ranges: new Uint32Array(ranges),
    bounds: new Float32Array(bounds),
  };
}
function clusterBounds(vertices: Float32Array, indices: Uint32Array, from: number, to: number, out: number[]): void {
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (let i = from; i < to; i++)
    for (let k = 0; k < 3; k++) {
      const x = vertices[indices[i] * 6 + k];
      if (x < lo[k]) lo[k] = x;
      if (x > hi[k]) hi[k] = x;
    }
  const c = lo.map((x, k) => (x + hi[k]) / 2);
  let radius = 0;
  for (let i = from; i < to; i++) {
    const v = indices[i] * 6;
    radius = Math.max(radius, Math.hypot(vertices[v] - c[0], vertices[v + 1] - c[1], vertices[v + 2] - c[2]));
  }
  // Unit normals from the winding, the side the rasterizer culls by.
  const normals: number[][] = [],
    axis = [0, 0, 0];
  for (let i = from; i < to; i += 3) {
    const a = indices[i] * 6,
      b = indices[i + 1] * 6,
      d = indices[i + 2] * 6,
      u = [0, 1, 2].map((k) => vertices[b + k] - vertices[a + k]),
      w = [0, 1, 2].map((k) => vertices[d + k] - vertices[a + k]),
      n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]],
      length = Math.hypot(n[0], n[1], n[2]);
    if (!length) continue;
    const unit = n.map((x) => x / length);
    normals.push(unit);
    for (let k = 0; k < 3; k++) axis[k] += unit[k];
  }
  const size = Math.hypot(axis[0], axis[1], axis[2]);
  let cosine = size ? 1 : -1;
  if (size) {
    for (let k = 0; k < 3; k++) axis[k] /= size;
    for (const n of normals) cosine = Math.min(cosine, n[0] * axis[0] + n[1] * axis[1] + n[2] * axis[2]);
  }
  out.push(c[0], c[1], c[2], radius, axis[0], axis[1], axis[2], cosine > 0 ? Math.sqrt(1 - cosine * cosine) : -1);
}

// One workgroup per cluster: its first thread tests the cluster and reserves room, then all copy its indices. Local-space
// tests hold under any affine matrix of positive determinant; a triangle's side of its plane does not change.
const shader = `
struct Frame {planes:array<vec4f,6>,eye:vec4f,size:vec4u}
struct Record {m:mat4x4f,color:vec4f,factors:vec4f}
@group(0) @binding(0) var<uniform> f:Frame;
@group(0) @binding(1) var<storage,read> records:array<Record>;
@group(0) @binding(2) var<storage,read> bounds:array<vec4f>;
@group(0) @binding(3) var<storage,read> ranges:array<vec2u>;
@group(0) @binding(4) var<storage,read> indices:array<u32>;
@group(0) @binding(5) var<storage,read_write> kept:array<u32>;
@group(0) @binding(6) var<storage,read_write> args:array<atomic<u32>>;
var<workgroup> base:u32;
fn keep(n:u32)->bool {
  let m=records[0].m;let s=bounds[n*2u];let c=(m*vec4f(s.xyz,1.0)).xyz;
  var r=s.w*sqrt(max(dot(m[0].xyz,m[0].xyz),max(dot(m[1].xyz,m[1].xyz),dot(m[2].xyz,m[2].xyz))));
  r+=1e-5*(length(c)+r);
  for(var p=0u;p<6u;p++){if(dot(f.planes[p].xyz,c)+f.planes[p].w< -r){return false;}}
  let cone=bounds[n*2u+1u];
  if(f.eye.w==0.0||cone.w<0.0){return true;}
  // Every point of the sphere lies behind every plane of the cone's normals: all its triangles face away.
  let d=s.xyz-f.eye.xyz;let l=length(d);
  if(l<=s.w){return true;}
  let along=dot(d,cone.xyz);let aside=sqrt(max(l*l-along*along,0.0));
  let cosine=sqrt(1.0-cone.w*cone.w);
  return along*cosine-aside*cone.w<=s.w*(1.0+1e-4)+1e-5*l;
}
@compute @workgroup_size(64) fn cull(@builtin(workgroup_id) w:vec3u,@builtin(local_invocation_index) l:u32) {
  let n=w.y*65535u+w.x;
  if(n>=f.size.x){return;}
  let range=ranges[n];
  if(l==0u){base=0xffffffffu;if(keep(n)){base=atomicAdd(&args[0],range.y);}}
  let at=workgroupUniformLoad(&base);
  if(at==0xffffffffu){return;}
  for(var k=l;k<range.y;k+=64u){kept[at+k]=indices[range.x+k];}
}
`;

/** {@link MeshletMesh} settings. */
export interface MeshletMeshOptions extends CulledInstancesOptions, MeshletOptions {}

/**
 * One large mesh drawn cluster by cluster: each frame a compute pass tests every cluster against the frustum and, for
 * single-sided materials under a perspective camera, against a cone of its normals, then writes the kept clusters' indices
 * into an index buffer the main pass draws. A {@link CulledParts} of one part: picking, shadows and whole-part culling work
 * as they do there, and draw the whole mesh.
 */
export class MeshletMesh extends CulledParts {
  /** The clusters. */
  readonly meshlets: Meshlets;
  private clusters?: {
    frame: GPUBuffer;
    bounds: GPUBuffer;
    ranges: GPUBuffer;
    indices: GPUBuffer;
    kept: GPUBuffer;
    pipeline: GPUComputePipeline;
    group: GPUBindGroup;
  };
  private readonly clusterValues = new ArrayBuffer(144);
  private readonly clusterFloats = new Float32Array(this.clusterValues);
  private readonly clusterWords = new Uint32Array(this.clusterValues);

  static override attach(
    engine: EngineKernel,
    batches: readonly CulledPartsBatch[],
    options?: MeshletMeshOptions,
  ): MeshletMesh {
    const value = new MeshletMesh(batches, options);
    engine.use(value);
    return value;
  }
  /** @throws RangeError unless `batches` holds one batch of one part: clusters are kept for one matrix. */
  constructor(batches: readonly CulledPartsBatch[], { maxVertices, maxTriangles, ...options }: MeshletMeshOptions = {}) {
    if (batches?.length !== 1 || batches[0].transforms?.length !== 16)
      throw new RangeError('Invalid MeshletMesh; pass one batch of one part');
    super(batches, options);
    this.meshlets = buildMeshlets(batches[0].geometry, { maxVertices, maxTriangles });
  }
  /** Indices the last frame kept, as triangles. A GPU readback; for tests and tools. */
  async readTriangles(): Promise<number> {
    const d = this.device,
      args = this.buffers.args;
    if (!d || !args) return 0;
    const staging = d.createBuffer({ size: 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
      encoder = d.createCommandEncoder();
    encoder.copyBufferToBuffer(args, 0, staging, 0, 4);
    d.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const count = new Uint32Array(staging.getMappedRange())[0] / 3;
    staging.unmap();
    staging.destroy();
    return count;
  }
  private buildClusters(d: GPUDevice): NonNullable<MeshletMesh['clusters']> {
    const { bounds: b, ranges: r, indices: i } = this.meshlets,
      S = GPUBufferUsage.STORAGE,
      C = GPUBufferUsage.COPY_DST,
      data = (values: Float32Array | Uint32Array) => {
        const buffer = d.createBuffer({ size: Math.max(values.byteLength, 4), usage: S | C });
        d.queue.writeBuffer(buffer, 0, values as Uint32Array<ArrayBuffer>);
        return buffer;
      },
      frame = d.createBuffer({ size: 144, usage: GPUBufferUsage.UNIFORM | C }),
      bounds = data(b),
      ranges = data(r),
      indices = data(i),
      kept = d.createBuffer({ size: Math.max(i.byteLength, 4), usage: S | GPUBufferUsage.INDEX }),
      pipeline = d.createComputePipeline({
        layout: 'auto',
        compute: { module: d.createShaderModule({ code: shader }), entryPoint: 'cull' },
      }),
      entry = (binding: number, buffer: GPUBuffer) => ({ binding, resource: { buffer } }),
      group = d.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          entry(0, frame),
          entry(1, this.buffers.records),
          entry(2, bounds),
          entry(3, ranges),
          entry(4, indices),
          entry(5, kept),
          entry(6, this.buffers.args),
        ],
      });
    return { frame, bounds, ranges, indices, kept, pipeline, group };
  }
  /** The camera in the mesh's own space, or 0 in `w` when no cone test applies. */
  private eye(c: Context, out: Float32Array): void {
    const m = this.records,
      p = c.camera.position,
      x = p[0] - m[12],
      y = p[1] - m[13],
      z = p[2] - m[14],
      // Cofactors of the 3x3.
      a = m[5] * m[10] - m[9] * m[6],
      b = m[9] * m[2] - m[1] * m[10],
      e = m[1] * m[6] - m[5] * m[2],
      f = m[8] * m[6] - m[4] * m[10],
      g = m[0] * m[10] - m[8] * m[2],
      h = m[4] * m[2] - m[0] * m[6],
      i = m[4] * m[9] - m[8] * m[5],
      j = m[8] * m[1] - m[0] * m[9],
      k = m[0] * m[5] - m[4] * m[1],
      det = m[0] * a + m[4] * b + m[8] * e;
    out[0] = (a * x + f * y + i * z) / det;
    out[1] = (b * x + g * y + j * z) / det;
    out[2] = (e * x + h * y + k * z) / det;
    // Back faces are discarded only on a single-sided batch; an orthographic camera has no eye point.
    const v = c.camera.matrix;
    out[3] = det > 0 && !this.backFaces(0) && (v[3] || v[7] || v[11]) ? 1 : 0;
  }
  protected override refine(c: Context): void {
    if (compatTier(c.device) === 'webgl2') return;
    const d = c.device,
      s = (this.clusters ??= this.buildClusters(d)),
      f = this.clusterFloats,
      n = this.meshlets.count;
    f.set(c.camera.planes);
    this.eye(c, f.subarray(24, 28));
    this.clusterWords[28] = n;
    d.queue.writeBuffer(s.frame, 0, this.clusterValues);
    c.encoder.clearBuffer(this.buffers.args, 0, 4);
    const pass = c.encoder.beginComputePass();
    pass.setPipeline(s.pipeline);
    pass.setBindGroup(0, s.group);
    pass.dispatchWorkgroups(Math.min(n, 65535), Math.ceil(n / 65535));
    pass.end();
  }
  protected override mainIndex(batch: number, index: GPUBuffer): GPUBuffer {
    return this.clusters?.kept ?? index;
  }
  protected override release(): void {
    const s = this.clusters;
    if (s) for (const buffer of [s.frame, s.bounds, s.ranges, s.indices, s.kept]) buffer.destroy();
    this.clusters = undefined;
    super.release();
  }
}
