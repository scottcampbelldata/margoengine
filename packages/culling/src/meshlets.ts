import type { EngineKernel } from '@margoengine/core';
import type { Geometry, PassContext } from '@margoengine/core/extension';
import { compatTier } from '../../shared/compat.js';
import type { CulledInstancesOptions } from './index.js';
import { CulledParts, type CulledPartsBatch } from './parts.js';
import { exactShader } from './pyramid.js';
import { occlusionCode } from './shaders.js';

declare const GPUBufferUsage: {
  COPY_DST: number;
  COPY_SRC: number;
  INDEX: number;
  INDIRECT: number;
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
export function buildMeshlets(
  geometry: Geometry,
  { maxVertices = 64, maxTriangles = 124 }: MeshletOptions = {},
): Meshlets {
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

// Three kernels over every cluster and part. `test` writes each cluster's index count if it is kept, else 0, at its own word
// of `args` after the draw arguments. `scan`, one workgroup per part, turns those words into each kept cluster's place in
// the part's region (an inclusive scan by doubling in workgroup memory, Hillis and Steele 1986, chunk by chunk; 0xffffffff for a dropped cluster) and writes the
// part's index count. `copy`, one workgroup per cluster and part, copies a kept cluster's indices to its place. The kept
// clusters so sit in cluster order every frame: no atomic reservation, so the draw order and with it every depth tie is
// the same from frame to frame. Local-space tests hold under any affine matrix of positive determinant; a triangle's side
// of its plane does not change. `live` says which parts run: the camera's kernel reads the count of parts kept, a shadow
// kernel their hidden words. Each part's indices sit in a region of their own, so a part draws with one indirect call.
const clusterShader = (shadow: boolean, occlusion: boolean): string => `
struct Frame {planes:array<vec4f,6>,eye:vec4f,size:vec4u,list:vec4u}
struct Record {m:mat4x4f,color:vec4f,factors:vec4f}
@group(0) @binding(0) var<uniform> f:Frame;
@group(0) @binding(1) var<storage,read> parts:array<Record>;
@group(0) @binding(2) var<storage,read> bounds:array<vec4f>;
@group(0) @binding(3) var<storage,read> ranges:array<vec2u>;
@group(0) @binding(4) var<storage,read> indices:array<u32>;
@group(0) @binding(5) var<storage,read_write> kept:array<u32>;
@group(0) @binding(6) var<storage,read_write> args:array<u32>;
@group(0) @binding(7) var<storage,read> live:array<u32>;
${
  occlusion
    ? `struct Cull {camera:mat4x4f,planes:array<vec4f,6>,size:vec4u,mode:vec4u,levels:array<vec4u,16>}
@group(0) @binding(8) var<uniform> u:Cull;
@group(0) @binding(9) var<storage,read> hiz:array<f32>;
${occlusionCode}`
    : ''
}
var<workgroup> sums:array<u32,256>;
fn keep(n:u32,m:mat4x4f)->bool {
  let s=bounds[n*2u];let c=(m*vec4f(s.xyz,1.0)).xyz;
  var r=s.w*sqrt(max(dot(m[0].xyz,m[0].xyz),max(dot(m[1].xyz,m[1].xyz),dot(m[2].xyz,m[2].xyz))));
  r+=1e-5*(length(c)+r);
  for(var p=0u;p<6u;p++){if(dot(f.planes[p].xyz,c)+f.planes[p].w< -r){return false;}}
  ${occlusion ? 'if(f.size.z!=0u&&!unoccluded(vec4f(c,r))){return false;}' : ''}
  let cone=bounds[n*2u+1u];
  if(f.eye.w==0.0||cone.w<0.0){return true;}
  // The eye in the mesh's own space, by the cofactors of the matrix; a mirrored part has no cone test.
  let a=m[0].xyz;let b=m[1].xyz;let e=m[2].xyz;let x=cross(b,e);let det=dot(a,x);
  if(det<=0.0){return true;}
  let q=f.eye.xyz-m[3].xyz;let eye=vec3f(dot(x,q),dot(cross(e,a),q),dot(cross(a,b),q))/det;
  // Every point of the sphere lies behind every plane of the cone's normals: all its triangles face away.
  let d=s.xyz-eye;let l=length(d);
  if(l<=s.w){return true;}
  let along=dot(d,cone.xyz);let aside=sqrt(max(l*l-along*along,0.0));
  let cosine=sqrt(1.0-cone.w*cone.w);
  return along*cosine-aside*cone.w<=s.w*(1.0+1e-4)+1e-5*l;
}
// The word of cluster n in list slot s, after every list's draw arguments.
fn word(s:u32,n:u32)->u32 {return f.list.x+s*f.size.x+n;}
@compute @workgroup_size(64) fn test(@builtin(workgroup_id) w:vec3u,@builtin(local_invocation_index) l:u32) {
  let n=(w.y*65535u+w.x)*64u+l;let j=w.z;
  if(n>=f.size.x){return;}
  var size=0u;
  if(${shadow ? 'live[j]==0u' : 'j<live[1]'}&&keep(n,parts[j].m)){size=ranges[n].y;}
  args[word(f.size.w+j,n)]=size;
}
@compute @workgroup_size(256) fn scan(@builtin(workgroup_id) w:vec3u,@builtin(local_invocation_index) l:u32) {
  let slot=f.size.w+w.x;
  var carry=0u;
  for(var first=0u;first<f.size.x;first+=256u){
    let n=first+l;
    var v=0u;
    if(n<f.size.x){v=args[word(slot,n)];}
    sums[l]=v;
    for(var d=1u;d<256u;d<<=1u){
      workgroupBarrier();
      var t=sums[l];
      if(l>=d){t+=sums[l-d];}
      workgroupBarrier();
      sums[l]=t;
    }
    workgroupBarrier();
    if(n<f.size.x){args[word(slot,n)]=select(0xffffffffu,carry+sums[l]-v,v!=0u);}
    carry+=sums[255];
    workgroupBarrier();
  }
  if(l==0u){args[slot*5u]=carry;}
}
@compute @workgroup_size(64) fn copy(@builtin(workgroup_id) w:vec3u,@builtin(local_invocation_index) l:u32) {
  let n=w.y*65535u+w.x;
  if(n>=f.size.x){return;}
  let slot=f.size.w+w.z;let at=args[word(slot,n)];
  if(at==0xffffffffu){return;}
  let range=ranges[n];
  for(var k=l;k<range.y;k+=64u){kept[slot*f.size.y+at+k]=indices[range.x+k];}
}
`;

/** {@link MeshletMesh} settings. */
export interface MeshletMeshOptions extends CulledInstancesOptions, MeshletOptions {}

/** One list of kept clusters per part, for the camera or for the cascades of a shadow pass. */
interface ClusterLists {
  kept: GPUBuffer;
  args: GPUBuffer;
  /** What `args` starts each frame from: nothing kept, one instance, each part's region. */
  reset: GPUBuffer;
  /** The word of `args` where the clusters' words start, after every list's draw arguments. */
  first: number;
}
/** The three kernels of one cluster cull and the layout they share. */
interface Kernels {
  layout: GPUBindGroupLayout;
  test: GPUComputePipeline;
  scan: GPUComputePipeline;
  copy: GPUComputePipeline;
}

/**
 * One large mesh drawn cluster by cluster, one or many times: each frame a compute pass tests every cluster of every part
 * the part cull kept against the frustum, for `'occlusion'` culling against the Hi-Z pyramid, and for single-sided materials
 * under a perspective camera against a cone of its normals, then writes the kept clusters' indices into that part's
 * region of an index buffer the main pass draws, one indirect draw per part. Shadow cascades do the same against each
 * light box, so a shadow pass draws only the clusters in it. A {@link CulledParts} of one batch: picking and whole-part
 * culling work as they do there, and a pick draws the whole mesh. The regions hold the mesh's indices once per part.
 */
export class MeshletMesh extends CulledParts {
  /** The clusters. */
  readonly meshlets: Meshlets;
  private clusters?: ClusterLists & {
    frame: GPUBuffer;
    bounds: GPUBuffer;
    ranges: GPUBuffer;
    indices: GPUBuffer;
    kernels: Kernels;
    group?: GPUBindGroup;
    pyramid?: GPUBuffer;
  };
  private shadowClusters?: ClusterLists & {
    frames: GPUBuffer;
    kernels: Kernels;
    groups: GPUBindGroup[];
    /** Cascades whose lists this frame's `prepareShadow` wrote. */
    cascades: number;
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
  /** @throws RangeError unless `batches` holds one batch: one mesh, drawn once per part of it. */
  constructor(
    batches: readonly CulledPartsBatch[],
    { maxVertices, maxTriangles, ...options }: MeshletMeshOptions = {},
  ) {
    if (batches?.length !== 1) throw new RangeError('Invalid MeshletMesh; pass one batch, one mesh with its parts');
    super(batches, options);
    this.meshlets = buildMeshlets(batches[0].geometry, { maxVertices, maxTriangles });
  }
  /**
   * Indices the last frame kept over all parts, as triangles. A GPU readback; for tests and tools. On the WebGL2 layer,
   * which has no cluster kernel, the whole mesh of every part the part cull kept.
   */
  async readTriangles(): Promise<number> {
    if (!this.clusters && this.device && compatTier(this.device) === 'webgl2')
      return (await this.readCounts())[0] * this.triangles();
    return this.readKept(this.clusters?.args, 0, this.slots);
  }
  /** As {@link readTriangles}, for one cascade of the last shadow frame; on the WebGL2 layer every shown part whole. */
  async readShadowTriangles(cascade: number): Promise<number> {
    if (!this.shadowClusters && this.device && compatTier(this.device) === 'webgl2') {
      let shown = 0;
      for (let i = 0; i < this.slots; i++) if (this.hidden[i] === 0) shown++;
      return shown * this.triangles();
    }
    return this.readKept(this.shadowClusters?.args, cascade * this.slots, this.slots);
  }
  private triangles(): number {
    return this.batches[0].geometry.indices.length / 3;
  }
  private async readKept(args: GPUBuffer | undefined, first: number, count: number): Promise<number> {
    const d = this.device;
    if (!d || !args) return 0;
    const staging = d.createBuffer({ size: count * 20, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
      encoder = d.createCommandEncoder();
    encoder.copyBufferToBuffer(args, first * 20, staging, 0, count * 20);
    d.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const words = new Uint32Array(staging.getMappedRange());
    let indices = 0;
    for (let i = 0; i < count; i++) indices += words[i * 5];
    staging.unmap();
    staging.destroy();
    return indices / 3;
  }
  /** Regions and draw arguments for `lists` lists of every part. */
  private lists(d: GPUDevice, lists: number): ClusterLists {
    const region = this.meshlets.indices.length,
      parts = lists * this.slots,
      bytes = parts * region * 4;
    if (bytes > d.limits.maxStorageBufferBindingSize)
      throw new RangeError(
        `MeshletMesh needs ${bytes} bytes for its kept clusters, over this device's ${d.limits.maxStorageBufferBindingSize}; use fewer parts or split the mesh`,
      );
    const start = new Uint32Array(parts * 5);
    for (let i = 0; i < parts; i++) start.set([0, 1, i * region, 0, 0], i * 5);
    const reset = d.createBuffer({ size: start.byteLength, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(reset, 0, start);
    return {
      kept: d.createBuffer({ size: Math.max(bytes, 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDEX }),
      // The draw arguments, then one word per cluster and part: its index count, then its place in the region.
      args: d.createBuffer({
        size: start.byteLength + parts * this.meshlets.count * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      }),
      reset,
      first: parts * 5,
    };
  }
  private buildClusters(d: GPUDevice): NonNullable<MeshletMesh['clusters']> {
    const { bounds: b, ranges: r, indices: i } = this.meshlets,
      S = GPUBufferUsage.STORAGE,
      C = GPUBufferUsage.COPY_DST,
      data = (values: Float32Array | Uint32Array) => {
        const buffer = d.createBuffer({ size: Math.max(values.byteLength, 4), usage: S | C });
        d.queue.writeBuffer(buffer, 0, values as Uint32Array<ArrayBuffer>);
        return buffer;
      };
    return {
      ...this.lists(d, 1),
      frame: d.createBuffer({ size: 144, usage: GPUBufferUsage.UNIFORM | C }),
      bounds: data(b),
      ranges: data(r),
      indices: data(i),
      kernels: this.kernels(d, false, this.culling === 'occlusion'),
    };
  }
  /** The test, scan and copy kernels, with one layout for the three so they share a bind group. */
  private kernels(d: GPUDevice, shadow: boolean, occlusion: boolean): Kernels {
    const compute = 4, // GPUShaderStage.COMPUTE
      buffer = (binding: number, type: GPUBufferBindingType) => ({ binding, visibility: compute, buffer: { type } }),
      layout = d.createBindGroupLayout({
        entries: [
          buffer(0, 'uniform'),
          ...[1, 2, 3, 4].map((b) => buffer(b, 'read-only-storage')),
          buffer(5, 'storage'),
          buffer(6, 'storage'),
          buffer(7, 'read-only-storage'),
          ...(occlusion ? [buffer(8, 'uniform'), buffer(9, 'read-only-storage')] : []),
        ],
      }),
      module = d.createShaderModule({ code: clusterShader(shadow, occlusion) }),
      pipelineLayout = d.createPipelineLayout({ bindGroupLayouts: [layout] }),
      kernel = (entryPoint: string) =>
        d.createComputePipeline({ layout: pipelineLayout, compute: { module, entryPoint } });
    return { layout, test: kernel('test'), scan: kernel('scan'), copy: kernel('copy') };
  }
  /** The bindings both kernels share. */
  private entries(
    frame: GPUBindingResource,
    parts: GPUBuffer,
    live: GPUBuffer,
    { kept, args }: ClusterLists,
  ): GPUBindGroupEntry[] {
    const s = this.clusters!,
      entry = (binding: number, buffer: GPUBuffer) => ({ binding, resource: { buffer } });
    return [
      { binding: 0, resource: frame },
      entry(1, parts),
      entry(2, s.bounds),
      entry(3, s.ranges),
      entry(4, s.indices),
      entry(5, kept),
      entry(6, args),
      entry(7, live),
    ];
  }
  /** The camera's bind group, new when the Hi-Z pyramid has a new buffer. */
  private cameraGroup(d: GPUDevice): GPUBindGroup {
    const s = this.clusters!,
      pyramid = this.culling === 'occlusion' ? this.hiz!.buffer! : undefined;
    if (s.group && s.pyramid === pyramid) return s.group;
    s.pyramid = pyramid;
    return (s.group = d.createBindGroup({
      layout: s.kernels.layout,
      entries: [
        ...this.entries({ buffer: s.frame }, this.buffers.drawn, this.buffers.args, s),
        ...(pyramid
          ? [
              { binding: 8, resource: { buffer: this.buffers.uniform } },
              { binding: 9, resource: { buffer: pyramid } },
            ]
          : []),
      ],
    }));
  }
  private dispatch(c: GPUCommandEncoder, { test, scan, copy }: Kernels, group: GPUBindGroup): void {
    const n = this.meshlets.count,
      groups = Math.ceil(n / 64),
      pass = c.beginComputePass();
    pass.setBindGroup(0, group);
    pass.setPipeline(test);
    pass.dispatchWorkgroups(Math.min(groups, 65535), Math.ceil(groups / 65535), this.slots);
    pass.setPipeline(scan);
    pass.dispatchWorkgroups(this.slots);
    pass.setPipeline(copy);
    pass.dispatchWorkgroups(Math.min(n, 65535), Math.ceil(n / 65535), this.slots);
    pass.end();
  }
  protected override refine(c: Context): void {
    if (compatTier(c.device) === 'webgl2') return;
    const d = c.device,
      s = (this.clusters ??= this.buildClusters(d)),
      f = this.clusterFloats,
      w = this.clusterWords,
      v = c.camera.matrix;
    f.set(c.camera.planes);
    f.set(c.camera.position.slice(0, 3), 24);
    // Back faces are discarded only on a single-sided batch; an orthographic camera has no eye point.
    f[27] = !this.backFaces(0) && (v[3] || v[7] || v[11]) ? 1 : 0;
    w[28] = this.meshlets.count;
    w[29] = this.meshlets.indices.length;
    w[30] = this.culling === 'occlusion' && exactShader(c.shader) ? 1 : 0;
    w[31] = 0;
    w[32] = s.first;
    d.queue.writeBuffer(s.frame, 0, this.clusterValues);
    c.encoder.copyBufferToBuffer(s.reset, 0, s.args, 0, this.slots * 20);
    this.dispatch(c.encoder, s.kernels, this.cameraGroup(d));
  }
  protected override drawBatch(main: GPURenderPassEncoder, batch: number, index: GPUBuffer): void {
    const s = this.clusters;
    if (!s) {
      super.drawBatch(main, batch, index);
      return;
    }
    main.setIndexBuffer(s.kept, 'uint32');
    // An indirect draw's firstInstance needs a feature, so each part's record comes by the buffer's offset.
    for (let j = 0; j < this.slots; j++) {
      main.setVertexBuffer(1, this.buffers.drawn, j * 96);
      main.drawIndexedIndirect(s.args, j * 20);
    }
  }
  /** Keeps, per cascade and part, the clusters inside that cascade's light box. `shadows.add(mesh)` calls it. */
  prepareShadow({
    context,
    matrices,
    cascades,
  }: {
    context: { device: GPUDevice; encoder: GPUCommandEncoder };
    matrices: Float32Array;
    cascades: number;
  }): void {
    const d = context.device;
    if (!this.device || compatTier(d) === 'webgl2') return;
    this.clusters ??= this.buildClusters(d);
    let s = this.shadowClusters;
    if (!s) {
      const lists = this.lists(d, 4),
        kernels = this.kernels(d, true, false),
        frames = d.createBuffer({ size: 4 * 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
        groups = [0, 1, 2, 3].map((k) =>
          d.createBindGroup({
            layout: kernels.layout,
            entries: this.entries(
              { buffer: frames, offset: k * 256, size: 144 },
              this.buffers.records,
              this.buffers.hidden,
              lists,
            ),
          }),
        );
      s = this.shadowClusters = { ...lists, frames, kernels, groups, cascades: 0 };
    }
    this.flush(d);
    const f = this.clusterFloats,
      w = this.clusterWords;
    context.encoder.copyBufferToBuffer(s.reset, 0, s.args, 0, cascades * this.slots * 20);
    for (let k = 0; k < cascades; k++) {
      const m = matrices.subarray(k * 16, k * 16 + 16);
      // The six planes of a clip box with depth from 0 to 1, from the rows of the matrix.
      for (let p = 0; p < 6; p++) {
        const row = p >> 1,
          sign = p & 1 ? -1 : 1,
          plane = [0, 1, 2, 3].map((c) =>
            p === 4 ? m[c * 4 + 2] : m[c * 4 + 3] + sign * m[c * 4 + (row === 2 ? 2 : row)],
          ),
          size = Math.hypot(plane[0], plane[1], plane[2]) || 1;
        for (let c = 0; c < 4; c++) f[p * 4 + c] = plane[c] / size;
      }
      f.fill(0, 24, 28);
      w[28] = this.meshlets.count;
      w[29] = this.meshlets.indices.length;
      w[30] = 0;
      w[31] = k * this.slots;
      w[32] = s.first;
      d.queue.writeBuffer(s.frames, k * 256, this.clusterValues);
      this.dispatch(context.encoder, s.kernels, s.groups[k]);
    }
    s.cascades = cascades;
  }
  protected override drawParts(pass: GPURenderPassEncoder, cascade?: number): void {
    if (!this.batches[0].geometry.indices.length) return;
    const s = this.shadowClusters;
    if (cascade === undefined || !s || cascade >= s.cascades) {
      super.drawParts(pass);
      return;
    }
    pass.setVertexBuffer(0, this.geometryBuffers.get(this.batches[0].geometry)!.vertex);
    pass.setIndexBuffer(s.kept, 'uint32');
    for (let j = 0; j < this.slots; j++) {
      pass.setVertexBuffer(1, this.buffers.records, j * 96);
      pass.setVertexBuffer(2, this.buffers.hidden, j * 4);
      pass.drawIndexedIndirect(s.args, (cascade * this.slots + j) * 20);
    }
  }
  protected override release(): void {
    const s = this.clusters,
      h = this.shadowClusters;
    if (s) for (const buffer of [s.frame, s.bounds, s.ranges, s.indices, s.kept, s.args, s.reset]) buffer.destroy();
    if (h) for (const buffer of [h.frames, h.kept, h.args, h.reset]) buffer.destroy();
    this.clusters = this.shadowClusters = undefined;
    super.release();
  }
}
