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
  VERTEX: number;
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

// Four kernels over every cluster and part. `test` writes each cluster's index count if it is kept, else 0, at its own word
// of `args` after the draw arguments. `scan`, one workgroup per part, turns those words into each kept cluster's place in
// the part's list (an inclusive scan by doubling in workgroup memory, Hillis and Steele 1986, chunk by chunk; 0xffffffff
// for a dropped cluster) and writes the part's index count. `place`, one workgroup, gives each part its list's start in
// one shared pool after the mesh's own indices, by an exclusive scan over the parts in slot order (Blelloch 1990); a part
// whose list would pass the pool's end draws the whole mesh from the indices at the buffer's start instead, so a small
// pool costs draws, never pixels. `copy`, one workgroup per cluster and part, copies a kept cluster's indices to its place.
// The kept clusters so sit in cluster order every frame: no atomic reservation, so the draw order and with it every depth
// tie is the same from frame to frame. Local-space tests hold under any affine matrix of positive determinant; a
// triangle's side of its plane does not change. `live` says which parts run: the camera's kernel reads the part cull's
// visible word of each slot, a shadow kernel the hidden words. Lists are kept per slot, so last frame's lists are the
// occluders of this frame's Hi-Z (two-pass occlusion: Haar and Aaltonen 2015, Wihlidal 2016, Karis et al. 2021).
const clusterShader = (shadow: boolean, occlusion: boolean): string => `
struct Frame {planes:array<vec4f,6>,eye:vec4f,size:vec4u,list:vec4u}
struct Record {m:mat4x4f,color:vec4f,factors:vec4f}
@group(0) @binding(0) var<uniform> f:Frame;
@group(0) @binding(1) var<storage,read> parts:array<Record>;
@group(0) @binding(2) var<storage,read> bounds:array<vec4f>;
@group(0) @binding(3) var<storage,read> ranges:array<vec2u>;
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
// A sum that stops at the largest word, so a pool of many large parts never wraps round.
fn add(a:u32,b:u32)->u32 {return select(a+b,0xffffffffu,b>0xffffffffu-a);}
@compute @workgroup_size(64) fn test(@builtin(workgroup_id) w:vec3u,@builtin(local_invocation_index) l:u32) {
  let n=(w.y*65535u+w.x)*64u+l;let j=w.z;
  if(n>=f.size.x){return;}
  var size=0u;
  if(${shadow ? 'live[j]==0u' : 'live[j]!=0u'}&&keep(n,parts[j].m)){size=ranges[n].y;}
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
@compute @workgroup_size(256) fn place(@builtin(local_invocation_index) l:u32) {
  let n=f.list.w;let per=(n+255u)/256u;let lo=min(l*per,n);let hi=min(lo+per,n);
  var sum=0u;
  for(var k=lo;k<hi;k++){sum=add(sum,args[(f.size.w+k)*5u]);}
  sums[l]=sum;
  for(var d=1u;d<256u;d<<=1u){
    workgroupBarrier();
    var t=sums[l];
    if(l>=d){t=add(t,sums[l-d]);}
    workgroupBarrier();
    sums[l]=t;
  }
  workgroupBarrier();
  var run=0u;
  if(l>0u){run=sums[l-1u];}
  for(var k=lo;k<hi;k++){
    let a=(f.size.w+k)*5u;let count=args[a];
    if(count!=0u&&add(run,count)>f.list.z){args[a]=f.size.y;args[a+2u]=0u;}else{args[a+2u]=f.list.y+min(run,f.list.z);}
    run=add(run,count);
  }
}
@compute @workgroup_size(64) fn copy(@builtin(workgroup_id) w:vec3u,@builtin(local_invocation_index) l:u32) {
  let n=w.y*65535u+w.x;
  if(n>=f.size.x){return;}
  let slot=f.size.w+w.z;let at=args[word(slot,n)];let first=args[slot*5u+2u];
  if(at==0xffffffffu||first<f.list.y){return;}
  let range=ranges[n];
  for(var k=l;k<range.y;k+=64u){kept[first+at+k]=kept[range.x+k];}
}
`;

/** Most parts of one {@link MeshletMesh}: one workgroup per part in a dispatch's dimension. */
const MAX_PARTS = 65535;
/** Default most kept triangles of one list set: 48 MiB of indices. */
const POOL = 4_194_304;

/** {@link MeshletMesh} settings. */
export interface MeshletMeshOptions extends CulledInstancesOptions, MeshletOptions {
  /**
   * Most kept triangles over all parts in one frame: the size of the shared pool their clusters are written to (each
   * shadow cascade has a pool of this size too). Parts are placed in slot order; one whose clusters do not fit draws its
   * whole mesh, so the image never changes. Lowered to fit the device's storage binding size. Default: every triangle of
   * every part, up to 4,194,304.
   */
  maxKeptTriangles?: number;
}

/** The kept clusters of every part, for the camera or for the cascades of a shadow pass. */
interface ClusterLists {
  /** The mesh's indices in cluster order, then a pool per list set. */
  kept: GPUBuffer;
  args: GPUBuffer;
  /** The word of `args` where the clusters' words start, after every list's draw arguments. */
  first: number;
  /** Indices in each list set's pool. */
  pool: number;
}
/** The four kernels of one cluster cull and the layout they share. */
interface Kernels {
  layout: GPUBindGroupLayout;
  test: GPUComputePipeline;
  scan: GPUComputePipeline;
  place: GPUComputePipeline;
  copy: GPUComputePipeline;
}

/**
 * The cluster test of the kernel on the CPU, in double precision, for the WebGL2 layer: whether cluster `n` of `bounds`
 * (eight floats per cluster) under the matrix at `at` of `m` is kept by the six `planes` and, with an `eye`, by the cone
 * of its normals. A padded sphere is conservative, so a cluster the GPU keeps and this drops lies outside.
 */
function keepCluster(
  bounds: Float32Array,
  n: number,
  m: Float32Array,
  at: number,
  planes: Float32Array,
  eye: Float32Array | undefined,
): boolean {
  const o = n * 8,
    sx = bounds[o],
    sy = bounds[o + 1],
    sz = bounds[o + 2],
    sr = bounds[o + 3],
    a0 = m[at],
    a1 = m[at + 1],
    a2 = m[at + 2],
    b0 = m[at + 4],
    b1 = m[at + 5],
    b2 = m[at + 6],
    e0 = m[at + 8],
    e1 = m[at + 9],
    e2 = m[at + 10],
    cx = a0 * sx + b0 * sy + e0 * sz + m[at + 12],
    cy = a1 * sx + b1 * sy + e1 * sz + m[at + 13],
    cz = a2 * sx + b2 * sy + e2 * sz + m[at + 14];
  let r =
    sr * Math.sqrt(Math.max(a0 * a0 + a1 * a1 + a2 * a2, b0 * b0 + b1 * b1 + b2 * b2, e0 * e0 + e1 * e1 + e2 * e2));
  r += 1e-5 * (Math.sqrt(cx * cx + cy * cy + cz * cz) + r);
  for (let p = 0; p < 24; p += 4)
    if (planes[p] * cx + planes[p + 1] * cy + planes[p + 2] * cz + planes[p + 3] < -r) return false;
  const sine = bounds[o + 7];
  if (!eye || sine < 0) return true;
  const x0 = b1 * e2 - b2 * e1,
    x1 = b2 * e0 - b0 * e2,
    x2 = b0 * e1 - b1 * e0,
    det = a0 * x0 + a1 * x1 + a2 * x2;
  if (det <= 0) return true;
  const q0 = eye[0] - m[at + 12],
    q1 = eye[1] - m[at + 13],
    q2 = eye[2] - m[at + 14],
    ex = (x0 * q0 + x1 * q1 + x2 * q2) / det,
    ey = ((e1 * a2 - e2 * a1) * q0 + (e2 * a0 - e0 * a2) * q1 + (e0 * a1 - e1 * a0) * q2) / det,
    ez = ((a1 * b2 - a2 * b1) * q0 + (a2 * b0 - a0 * b2) * q1 + (a0 * b1 - a1 * b0) * q2) / det,
    d0 = sx - ex,
    d1 = sy - ey,
    d2 = sz - ez,
    l = Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2);
  if (l <= sr) return true;
  const along = d0 * bounds[o + 4] + d1 * bounds[o + 5] + d2 * bounds[o + 6],
    aside = Math.sqrt(Math.max(l * l - along * along, 0));
  return along * Math.sqrt(1 - sine * sine) - aside * sine <= sr * (1 + 1e-4) + 1e-5 * l;
}

/** The six planes of a clip box with depth from 0 to 1, from the rows of `m`, normalized, into `out` at `at`. */
function boxPlanes(m: Float32Array, out: Float32Array, at: number): void {
  for (let p = 0; p < 6; p++) {
    const row = p >> 1,
      sign = p & 1 ? -1 : 1,
      plane = [0, 1, 2, 3].map((c) =>
        p === 4 ? m[c * 4 + 2] : m[c * 4 + 3] + sign * m[c * 4 + (row === 2 ? 2 : row)],
      ),
      size = Math.hypot(plane[0], plane[1], plane[2]) || 1;
    for (let c = 0; c < 4; c++) out[at + p * 4 + c] = plane[c] / size;
  }
}

/**
 * One large mesh drawn cluster by cluster, once or as many instances as you like, each with its own matrix: each frame a
 * compute pass tests every cluster of every part the part cull kept against the frustum, for `'occlusion'` culling
 * against a Hi-Z pyramid built from the clusters each part drew last frame (two-pass occlusion: last frame's clusters are
 * drawn depth-only first, then every cluster is tested, so a cluster that comes into view is drawn that frame), and for
 * single-sided materials under a perspective camera against a cone of its normals. The kept clusters' indices go to one
 * pool shared by all parts, one indirect draw per part. Shadow cascades do the same against each light box. On the
 * WebGL2 layer the same frustum and cone tests run on the CPU and each run of kept clusters is one draw. A
 * {@link CulledParts} of one batch: picking and whole-part culling work as they do there, and a pick draws the whole mesh.
 */
export class MeshletMesh extends CulledParts {
  /** The clusters. */
  readonly meshlets: Meshlets;
  /** See {@link MeshletMeshOptions.maxKeptTriangles}. */
  readonly maxKeptTriangles: number;
  private clusters?: ClusterLists & {
    frame: GPUBuffer;
    bounds: GPUBuffer;
    ranges: GPUBuffer;
    /** Each slot's own index, the instance data of the occluder draws. */
    ids: GPUBuffer;
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
  /** The whole mesh's sphere, as a cluster with no cone: the CPU route's part test. */
  private readonly whole = new Float32Array(8);
  /** The CPU route (WebGL2 layer): the mesh's indices in cluster order, the view's planes and eye, cascade planes. */
  private cpu?: {
    index: GPUBuffer;
    planes: Float32Array;
    eye: Float32Array;
    cone: boolean;
    shadows: Float32Array;
    cascades: number;
    triangles: number;
    shadowTriangles: Float64Array;
  };

  static override attach(
    engine: EngineKernel,
    batches: readonly CulledPartsBatch[],
    options?: MeshletMeshOptions,
  ): MeshletMesh {
    const value = new MeshletMesh(batches, options);
    engine.use(value);
    return value;
  }
  /** @throws RangeError unless `batches` holds one batch of at most 65,535 slots: one mesh, drawn once per part of it. */
  constructor(
    batches: readonly CulledPartsBatch[],
    { maxVertices, maxTriangles, maxKeptTriangles, ...options }: MeshletMeshOptions = {},
  ) {
    if (batches?.length !== 1) throw new RangeError('Invalid MeshletMesh; pass one batch, one mesh with its parts');
    if (maxKeptTriangles !== undefined && !(Number.isInteger(maxKeptTriangles) && maxKeptTriangles >= 0))
      throw new RangeError('Invalid maxKeptTriangles; pass a whole number of 0 or more');
    super(batches, options);
    if (this.slots > MAX_PARTS)
      throw new RangeError(`Invalid MeshletMesh; pass at most ${MAX_PARTS} parts, or split them over several meshes`);
    this.meshlets = buildMeshlets(batches[0].geometry, { maxVertices, maxTriangles });
    this.maxKeptTriangles = maxKeptTriangles ?? Math.min(POOL, this.slots * this.triangles());
    const { bounds, count } = this.meshlets,
      lo = [Infinity, Infinity, Infinity],
      hi = [-Infinity, -Infinity, -Infinity];
    for (let n = 0; n < count; n++)
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], bounds[n * 8 + k] - bounds[n * 8 + 3]);
        hi[k] = Math.max(hi[k], bounds[n * 8 + k] + bounds[n * 8 + 3]);
      }
    const c = count ? lo.map((x, k) => (x + hi[k]) / 2) : [0, 0, 0];
    let radius = 0;
    for (let n = 0; n < count; n++)
      radius = Math.max(
        radius,
        Math.hypot(bounds[n * 8] - c[0], bounds[n * 8 + 1] - c[1], bounds[n * 8 + 2] - c[2]) + bounds[n * 8 + 3],
      );
    this.whole.set([c[0], c[1], c[2], radius * (1 + 1e-6), 0, 0, 0, -1]);
  }
  /**
   * Triangles the last frame drew over all parts: the kept clusters, and the whole mesh of a part whose clusters did not
   * fit the pool. A GPU readback; for tests and tools. On the WebGL2 layer the CPU route's count, with no readback.
   */
  async readTriangles(): Promise<number> {
    if (this.cpu) return this.cpu.triangles;
    return this.readKept(this.clusters?.args, 0, this.slots);
  }
  /** As {@link readTriangles}, for one cascade of the last shadow frame. */
  async readShadowTriangles(cascade: number): Promise<number> {
    if (this.cpu) {
      if (cascade < this.cpu.cascades) return this.cpu.shadowTriangles[cascade];
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
  /** The kept-index buffer (the mesh's indices, then `sets` pools) and the draw arguments of `sets` lists per part. */
  private lists(d: GPUDevice, sets: number): ClusterLists {
    const base = this.meshlets.indices.length,
      limit = Math.floor(d.limits.maxStorageBufferBindingSize / 4) - base,
      parts = sets * this.slots;
    if (limit < 0)
      throw new RangeError(
        `MeshletMesh needs ${base * 4} bytes for its indices, over this device's ${d.limits.maxStorageBufferBindingSize}; split the mesh`,
      );
    const pool = Math.min(this.maxKeptTriangles * 3, Math.floor(limit / sets / 3) * 3),
      kept = d.createBuffer({
        size: Math.max((base + sets * pool) * 4, 4),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
    d.queue.writeBuffer(kept, 0, this.meshlets.indices as Uint32Array<ArrayBuffer>);
    // The draw arguments (each part's count and first index come from the kernels), then a word per cluster and part.
    const start = new Uint32Array(parts * 5);
    for (let i = 0; i < parts; i++) start[i * 5 + 1] = 1;
    const args = d.createBuffer({
      size: start.byteLength + parts * this.meshlets.count * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    d.queue.writeBuffer(args, 0, start);
    return { kept, args, first: parts * 5, pool };
  }
  private buildClusters(d: GPUDevice): NonNullable<MeshletMesh['clusters']> {
    const { bounds: b, ranges: r } = this.meshlets,
      S = GPUBufferUsage.STORAGE,
      C = GPUBufferUsage.COPY_DST,
      data = (values: Float32Array | Uint32Array, usage = S) => {
        const buffer = d.createBuffer({ size: Math.max(values.byteLength, 4), usage: usage | C });
        d.queue.writeBuffer(buffer, 0, values as Uint32Array<ArrayBuffer>);
        return buffer;
      };
    return {
      ...this.lists(d, 1),
      frame: d.createBuffer({ size: 144, usage: GPUBufferUsage.UNIFORM | C }),
      bounds: data(b),
      ranges: data(r),
      ids: data(
        Uint32Array.from({ length: this.slots }, (_, i) => i),
        GPUBufferUsage.VERTEX,
      ),
      kernels: this.kernels(d, false, this.culling === 'occlusion'),
    };
  }
  /** The test, scan, place and copy kernels, with one layout for the four so they share a bind group. */
  private kernels(d: GPUDevice, shadow: boolean, occlusion: boolean): Kernels {
    const compute = 4, // GPUShaderStage.COMPUTE
      buffer = (binding: number, type: GPUBufferBindingType) => ({ binding, visibility: compute, buffer: { type } }),
      layout = d.createBindGroupLayout({
        entries: [
          buffer(0, 'uniform'),
          ...[1, 2, 3].map((b) => buffer(b, 'read-only-storage')),
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
    return { layout, test: kernel('test'), scan: kernel('scan'), place: kernel('place'), copy: kernel('copy') };
  }
  /** The bindings the kernels share. */
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
        ...this.entries({ buffer: s.frame }, this.buffers.records, this.buffers.visible, s),
        ...(pyramid
          ? [
              { binding: 8, resource: { buffer: this.buffers.uniform } },
              { binding: 9, resource: { buffer: pyramid } },
            ]
          : []),
      ],
    }));
  }
  /** Writes the list words of the cluster uniform: the first list slot, where the clusters' words and the pool start. */
  private listValues(slot: number, lists: ClusterLists, set: number): void {
    const w = this.clusterWords,
      base = this.meshlets.indices.length;
    w[28] = this.meshlets.count;
    w[29] = base;
    w[31] = slot;
    w[32] = lists.first;
    w[33] = base + set * lists.pool;
    w[34] = lists.pool;
    w[35] = this.slots;
  }
  private dispatch(c: GPUCommandEncoder, { test, scan, place, copy }: Kernels, group: GPUBindGroup): void {
    const n = this.meshlets.count,
      groups = Math.ceil(n / 64),
      pass = c.beginComputePass();
    pass.setBindGroup(0, group);
    pass.setPipeline(test);
    pass.dispatchWorkgroups(Math.min(groups, 65535), Math.ceil(groups / 65535), this.slots);
    pass.setPipeline(scan);
    pass.dispatchWorkgroups(this.slots);
    pass.setPipeline(place);
    pass.dispatchWorkgroups(1);
    pass.setPipeline(copy);
    pass.dispatchWorkgroups(Math.min(n, 65535), Math.ceil(n / 65535), this.slots);
    pass.end();
  }
  /** The CPU route's state, made on the WebGL2 layer's first frame. */
  private cpuRoute(d: GPUDevice): NonNullable<MeshletMesh['cpu']> {
    if (this.cpu) return this.cpu;
    const indices = this.meshlets.indices,
      index = d.createBuffer({
        size: Math.max(indices.byteLength, 4),
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
    d.queue.writeBuffer(index, 0, indices as Uint32Array<ArrayBuffer>);
    return (this.cpu = {
      index,
      planes: new Float32Array(24),
      eye: new Float32Array(3),
      cone: false,
      shadows: new Float32Array(4 * 24),
      cascades: 0,
      triangles: 0,
      shadowTriangles: new Float64Array(4),
    });
  }
  /** The cone test applies: a single-sided batch under a perspective camera (an orthographic one has no eye). */
  private coneTest(v: Float32Array): boolean {
    return !this.backFaces(0) && !!(v[3] || v[7] || v[11]);
  }
  protected override refine(c: Context): void {
    const d = c.device,
      v = c.camera.matrix;
    if (compatTier(d) === 'webgl2') {
      const cpu = this.cpuRoute(d);
      cpu.planes.set(c.camera.planes);
      cpu.eye.set(c.camera.position.slice(0, 3));
      cpu.cone = this.coneTest(v);
      return;
    }
    const s = (this.clusters ??= this.buildClusters(d)),
      f = this.clusterFloats,
      w = this.clusterWords;
    f.set(c.camera.planes);
    f.set(c.camera.position.slice(0, 3), 24);
    // Back faces are discarded only on a single-sided batch; an orthographic camera has no eye point.
    f[27] = this.coneTest(v) ? 1 : 0;
    this.listValues(0, s, 0);
    w[30] = this.culling === 'occlusion' && exactShader(c.shader) ? 1 : 0;
    d.queue.writeBuffer(s.frame, 0, this.clusterValues);
    this.dispatch(c.encoder, s.kernels, this.cameraGroup(d));
  }
  /**
   * Draws the kept clusters of every shown part on the CPU route: each run of clusters next to each other in the index
   * buffer is one draw. `hidden` binds the hidden word too (a shadow pass's instance data). Returns the triangles drawn.
   */
  private drawRuns(
    pass: GPURenderPassEncoder,
    planes: Float32Array,
    eye: Float32Array | undefined,
    hidden: boolean,
  ): number {
    const { ranges, bounds, count } = this.meshlets,
      records = this.records;
    pass.setIndexBuffer(this.cpu!.index, 'uint32');
    let triangles = 0;
    for (let j = 0; j < this.slots; j++) {
      const at = j * 24;
      if (this.hidden[j] !== 0 || !keepCluster(this.whole, 0, records, at, planes, undefined)) continue;
      let first = 0,
        size = 0,
        bound = false;
      for (let n = 0; n <= count; n++) {
        const kept = n < count && keepCluster(bounds, n, records, at, planes, eye);
        if (kept && size && first + size === ranges[n * 2]) {
          size += ranges[n * 2 + 1];
          continue;
        }
        if (size) {
          if (!bound) {
            pass.setVertexBuffer(1, this.buffers.records, j * 96);
            if (hidden) pass.setVertexBuffer(2, this.buffers.hidden, j * 4);
            bound = true;
          }
          pass.drawIndexed(size, 1, first, 0, 0);
          triangles += size / 3;
        }
        first = kept ? ranges[n * 2] : 0;
        size = kept ? ranges[n * 2 + 1] : 0;
      }
    }
    return triangles;
  }
  protected override drawBatch(main: GPURenderPassEncoder, batch: number, index: GPUBuffer): void {
    const cpu = this.cpu;
    if (cpu) {
      cpu.triangles = this.drawRuns(main, cpu.planes, cpu.cone ? cpu.eye : undefined, false);
      return;
    }
    const s = this.clusters;
    if (!s) {
      super.drawBatch(main, batch, index);
      return;
    }
    main.setIndexBuffer(s.kept, 'uint32');
    // An indirect draw's firstInstance needs a feature, so each part's record comes by the buffer's offset. A part not
    // shown keeps no clusters, so its draw is left out.
    for (let j = 0; j < this.slots; j++) {
      if (this.hidden[j] !== 0) continue;
      main.setVertexBuffer(1, this.buffers.records, j * 96);
      main.drawIndexedIndirect(s.args, j * 20);
    }
  }
  /**
   * Two-pass occlusion: the clusters each shown part drew last frame, at this frame's matrices, are the Hi-Z occluders.
   * Any set of real geometry is a valid occluder set, so a moved part or camera only makes it hide less.
   */
  protected override drawOccluders(pass: GPURenderPassEncoder, batch: number, index: GPUBuffer): void {
    const s = this.clusters;
    if (!s) {
      super.drawOccluders(pass, batch, index);
      return;
    }
    pass.setIndexBuffer(s.kept, 'uint32');
    for (let j = 0; j < this.slots; j++) {
      if (this.hidden[j] !== 0) continue;
      pass.setVertexBuffer(1, s.ids, j * 4);
      pass.drawIndexedIndirect(s.args, j * 20);
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
    if (!this.device) return;
    if (compatTier(d) === 'webgl2') {
      const cpu = this.cpuRoute(d);
      for (let k = 0; k < cascades; k++) boxPlanes(matrices.subarray(k * 16, k * 16 + 16), cpu.shadows, k * 24);
      cpu.cascades = cascades;
      return;
    }
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
    for (let k = 0; k < cascades; k++) {
      boxPlanes(matrices.subarray(k * 16, k * 16 + 16), f, 0);
      f.fill(0, 24, 28);
      this.listValues(k * this.slots, s, k);
      w[30] = 0;
      d.queue.writeBuffer(s.frames, k * 256, this.clusterValues);
      this.dispatch(context.encoder, s.kernels, s.groups[k]);
    }
    s.cascades = cascades;
  }
  protected override drawParts(pass: GPURenderPassEncoder, cascade?: number): void {
    if (!this.batches[0].geometry.indices.length) return;
    const cpu = this.cpu,
      s = this.shadowClusters;
    if (cascade !== undefined && cpu && cascade < cpu.cascades) {
      pass.setVertexBuffer(0, this.geometryBuffers.get(this.batches[0].geometry)!.vertex);
      cpu.shadowTriangles[cascade] = this.drawRuns(
        pass,
        cpu.shadows.subarray(cascade * 24, cascade * 24 + 24),
        undefined,
        true,
      );
      return;
    }
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
    if (s) for (const buffer of [s.frame, s.bounds, s.ranges, s.ids, s.kept, s.args]) buffer.destroy();
    if (h) for (const buffer of [h.frames, h.kept, h.args]) buffer.destroy();
    this.cpu?.index.destroy();
    this.clusters = this.shadowClusters = this.cpu = undefined;
    super.release();
  }
}
