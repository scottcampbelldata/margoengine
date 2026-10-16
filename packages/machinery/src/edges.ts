/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import {
  PbrMaterial,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
  type Geometry,
} from '@margoengine/core/extension';
import { edgesGeometry } from '@margoengine/geometry';
import { declaration } from './section-uniform.js';
declare const GPUBufferUsage: { UNIFORM: number; STORAGE: number; COPY_DST: number; INDIRECT: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };
type GPUContext = Extract<PassContext, { backend: 'webgpu' }>;
const SECTION = /var<uniform> section:Section;/,
  SECTION_BINDING = /@group\(0\) @binding\((\d+)\) var<uniform> section:Section;/;
// edges: [0..3] the geometry bounding sphere, [4] segment count n, [5] list elements per tier, [8..8+n) segment lengths (longest
// first), then the n index pairs in that order. instances: core's per-geometry instance records (24 floats), or the culled
// records a GPU culler redirected the batch to.
const HEADER = 8,
  TIERS = 4;
const common = `struct Frame {camera:mat4x4f,viewport:vec4f,color:vec4f,lod:vec4f}
@group(0) @binding(0) var<uniform> frame:Frame;
@group(0) @binding(2) var<storage,read> edges:array<u32>;
@group(0) @binding(3) var<storage,read> instances:array<vec4f>;
fn model(n:u32)->mat4x4f {return mat4x4f(instances[n*6u],instances[n*6u+1u],instances[n*6u+2u],instances[n*6u+3u]);}
`;
// One thread per drawn part. Parts whose bounding sphere projects under lod.x pixels draw nothing; between lod.x and 2 lod.x their
// lines fade in. A part keeps only the segments long enough to reach lod.y pixels at its centre's depth, found by binary search
// in the length-sorted list, and goes to the smallest of 4 tiers (all, 1/4, 1/16, 1/64 of the segments, longest first) that
// holds them: one indirect draw per tier. ponytail: centre-depth estimate, so a segment just over lod.y pixels near a large
// part's front or a screen corner can be skipped (it would be a dash under a pixel long); a per-segment bound would fix that.
// args: 4 x [vertices, instances, 0, 0], then the part count.
const cull =
  common +
  `@group(0) @binding(5) var<storage,read_write> list:array<u32>;
@group(0) @binding(6) var<storage,read_write> args:array<atomic<u32>,17>;
@compute @workgroup_size(64) fn cull(@builtin(global_invocation_id) id:vec3u) {
 let n=id.x;if(n>=atomicLoad(&args[16])){return;}let m=model(n);let sphere=bitcast<vec4f>(vec4u(edges[0],edges[1],edges[2],edges[3]));let center=frame.camera*(m*vec4f(sphere.xyz,1));
 let scale=max(max(length(m[0].xyz),length(m[1].xyz)),length(m[2].xyz));var fade=1.0;
 if(center.w>0){let pixels=sphere.w*scale*frame.viewport.w/center.w;if(pixels<frame.lod.x){return;}if(frame.lod.x>0){fade=min(pixels/frame.lod.x-1.0,1.0);}}
 let count=edges[4];var need=count;
 if(frame.lod.y>0&&center.w>sphere.w*scale){
  // Segments whose length projects under lod.y pixels at the part's centre depth (the same estimate as the size test).
  let limit=frame.lod.y*center.w/(scale*frame.viewport.w);var lo=0u;var hi=count;
  while(lo<hi){let mid=(lo+hi)/2u;if(bitcast<f32>(edges[8u+mid])>=limit){lo=mid+1u;}else{hi=mid;}}need=lo;
 }
 if(need==0u){return;}var t=3u;while(t>0u&&((count+(1u<<(2u*t))-1u)>>(2u*t))<need){t--;}
 list[t*edges[5]+atomicAdd(&args[t*4u+1u],1u)]=n|(u32(round(fade*255.0))<<24u);
}`;
// Six vertices per segment; instance_index walks this tier's list (bound at the tier's offset), whose entries are the instance
// index and the fade in the top 8 bits. Segments under lod.y pixels on screen (sub-pixel hole rims) are dropped.
const shader = (section: boolean) =>
  (section ? declaration(4) : '') +
  common +
  `@group(0) @binding(1) var<storage,read> vertices:array<f32>;
@group(0) @binding(5) var<storage,read> list:array<u32>;
struct Output {@builtin(position) clip:vec4f,@location(0) position:vec3f,@location(1) edge:f32,@location(2) @interpolate(flat) fade:f32}
fn point(v:u32,model:mat4x4f)->vec4f {return model*vec4f(vertices[v*6u],vertices[v*6u+1u],vertices[v*6u+2u],1);}
@vertex fn vertex(@builtin(vertex_index) v:u32,@builtin(instance_index) i:u32)->Output {
 var o:Output;o.clip=vec4f(2,2,2,1);o.edge=0;let e=v/6u;let k=v%6u;let entry=list[i];let m=model(entry&0xffffffu);o.fade=f32(entry>>24u)/255.0;let pair=8u+edges[4]+e*2u;
 var wa=point(edges[pair],m);var wb=point(edges[pair+1u],m);var ca=frame.camera*wa;var cb=frame.camera*wb;
 let fa=ca.w-ca.z;let fb=cb.w-cb.z;if(fa<0&&fb<0){return o;}
 if(fa<0){let t=fa/(fa-fb);ca=mix(ca,cb,t);wa=mix(wa,wb,t);}else if(fb<0){let t=fb/(fb-fa);cb=mix(cb,ca,t);wb=mix(wb,wa,t);}
 let half=frame.viewport.xy*0.5;let sa=ca.xy/ca.w*half;let sb=cb.xy/cb.w*half;let d=sb-sa;let length=length(d);if(length<max(frame.lod.y,1e-5)){return o;}let dir=d/length;
 let atB=k==2u||k==4u||k==5u;let side=select(-1.0,1.0,k==1u||k==2u||k==4u);let w=frame.viewport.z+1;
 let c=select(ca,cb,atB);let offset=vec2f(-dir.y,dir.x)*side*w+dir*select(-w,w,atB)*0.5;
 o.clip=vec4f(c.xy+offset/half*c.w,c.z,c.w);o.position=select(wa,wb,atB).xyz;o.edge=side*w;return o;
}
@fragment fn fragment(i:Output)->@location(0) vec4f {
${section ? ' for(var p=0u;p<u32(section.settings.x);p++){if(dot(section.planes[p].xyz,i.position)+section.planes[p].w<0){discard;}}\n' : ''} let cover=clamp(frame.viewport.z+0.5-abs(i.edge),0.0,1.0);return vec4f(frame.color.rgb,frame.color.a*cover*i.fade);
}`;

/** Options for {@link FeatureEdges}. */
export interface FeatureEdgeOptions {
  /** Dihedral angle in degrees above which a shared edge is drawn; open (boundary) edges are always drawn. Default 30. */
  angle?: number;
  /** Line width in CSS pixels, constant on screen. Default 1.5. */
  width?: number;
  /** Line colour (CSS colour or linear RGBA). Default `'#14181d'`. */
  color?: string | readonly number[];
  /** Hardware depth bias (depth32float units) pulling lines toward the camera so they never z-fight their own faces. Default 256. */
  depthBias?: number;
  /**
   * Parts whose bounding sphere projects to a radius below this many CSS pixels draw no edges, and their lines fade in up to
   * twice that radius, keeping distant overviews clean and cheap; segments that cannot reach half a pixel on screen are skipped on
   * the GPU. Default 6; 0 draws every segment of every part at full strength.
   */
  minRadius?: number;
  /** Frame graph order: after the scene (0) and section caps (5). Default 6. */
  order?: number;
}
interface Shape {
  edges: Uint32Array;
  segments: number;
  count: number;
  stride: number;
  frame: number;
  buffer?: GPUBuffer;
  list?: GPUBuffer;
  args?: GPUBuffer;
  group?: GPUBindGroup;
  sectionGroup?: GPUBindGroup;
  cullGroup?: GPUBindGroup;
  instance?: GPUBuffer;
  section?: GPUBuffer;
}

/** CAD feature lines of one geometry: index pairs of the edges whose faces meet above `angle` degrees, plus open boundaries. */
export function featureEdges(geometry: Geometry, angle = 30): Uint32Array {
  if (!Number.isFinite(angle) || angle < 0 || angle > 180) throw new RangeError('Invalid feature angle');
  const v = geometry.vertices,
    positions = new Float32Array(v.length / 2);
  for (let i = 0, j = 0; i < v.length; i += 6, j += 3) {
    positions[j] = v[i];
    positions[j + 1] = v[i + 1];
    positions[j + 2] = v[i + 2];
  }
  return edgesGeometry({ positions, normals: positions, uvs: new Float32Array(0), indices: geometry.indices }, angle);
}
// The GPU record of one geometry's edges (layout above): segments sorted longest first, so a prefix holds every long segment.
function edgeRecord(geometry: Geometry, pairs: Uint32Array): Uint32Array {
  const v = geometry.vertices,
    n = pairs.length / 2,
    lengths = new Float32Array(n),
    order = new Uint32Array(n),
    out = new Uint32Array(HEADER + n * 3),
    floats = new Float32Array(out.buffer);
  for (let e = 0; e < n; e++) {
    const a = pairs[e * 2] * 6,
      b = pairs[e * 2 + 1] * 6;
    lengths[e] = Math.hypot(v[a] - v[b], v[a + 1] - v[b + 1], v[a + 2] - v[b + 2]);
    order[e] = e;
  }
  order.sort((a, b) => lengths[b] - lengths[a]);
  floats.set(geometry.bounds);
  out[4] = n;
  for (let i = 0; i < n; i++) {
    const e = order[i];
    floats[HEADER + i] = lengths[e];
    out[HEADER + n + i * 2] = pairs[e * 2];
    out[HEADER + n + i * 2 + 1] = pairs[e * 2 + 1];
  }
  return out;
}

/**
 * Draws crisp feature/crease edges for every core mesh. Edges are computed once per distinct geometry and drawn instanced per
 * geometry from the instance records core uploaded for this frame's batch (or the records a GPU culler such as
 * `@margoengine/culling`'s `CulledMeshes` redirected it to), so transforms, culling, hidden parts, added or re-geometried meshes
 * and exploded views need no per-part CPU work. A compute pass drops parts below `minRadius`, fades the next ones in and skips
 * segments too short to see. Works with orthographic cameras and clips against SectionPlanes.
 */
export class FeatureEdges implements EnginePlugin {
  readonly name = 'feature-edges';
  /** Latest frame. `segments` and `instances` count drawn parts before the on-screen size test; `drawCalls` is 4 indirect draws per geometry. */
  readonly stats = { geometries: 0, segments: 0, instances: 0, drawCalls: 0 };
  private engine?: Engine;
  private readonly shapes = new Map<Geometry, Shape>();
  private uniform?: GPUBuffer;
  private frameId = 0;
  private readonly frame = new Float32Array(28);
  private readonly minRadius: number;
  private readonly color: Float32Array;
  private readonly angle: number;
  private readonly width: number;
  private readonly bias: number;
  private readonly order: number;
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private cull?: GPUComputePipeline;
  private readonly drawn: [Shape, GPUBindGroup][] = [];
  private readonly argsData = new Uint32Array(17);
  private layouts?: { plain: GPUBindGroupLayout; section: GPUBindGroupLayout };
  private readonly colorAttachment: GPURenderPassColorAttachment = {
    view: undefined!,
    loadOp: 'load',
    storeOp: 'store',
  };
  private readonly descriptor: GPURenderPassDescriptor = {
    colorAttachments: [this.colorAttachment],
    depthStencilAttachment: { view: undefined!, depthReadOnly: true, stencilReadOnly: true },
  };
  /** Same as `engine.use(new FeatureEdges(...))`; returns the FeatureEdges. */
  static attach(engine: EngineKernel, options?: FeatureEdgeOptions): FeatureEdges {
    const value = new FeatureEdges(options);
    engine.use(value);
    return value;
  }
  constructor({
    angle = 30,
    width = 1.5,
    color = '#14181d',
    depthBias = 256,
    minRadius = 6,
    order = 6,
  }: FeatureEdgeOptions = {}) {
    if (
      !Number.isFinite(angle) ||
      angle < 0 ||
      angle > 180 ||
      !(width > 0 && width <= 64) ||
      !Number.isInteger(depthBias) ||
      depthBias < 0 ||
      !(minRadius >= 0 && minRadius < 1e6) ||
      !Number.isFinite(order)
    )
      throw new RangeError('Invalid feature edge options');
    this.angle = angle;
    this.width = width;
    this.bias = depthBias;
    this.order = order;
    this.minRadius = minRadius;
    this.color = new PbrMaterial({ color }).data.slice(0, 4);
  }
  setup(engine: Engine): void {
    if (!engine.gpu) throw new Error('FeatureEdges requires WebGPU');
    this.engine = engine;
    const device = engine.gpu,
      storage = (binding: number, hasDynamicOffset = false): GPUBindGroupLayoutEntry => ({
        binding,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: 'read-only-storage', hasDynamicOffset },
      }),
      entries = [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' as const },
        },
        storage(1),
        storage(2),
        storage(3),
        storage(5, true),
      ];
    this.layouts = {
      plain: device.createBindGroupLayout({ entries }),
      section: device.createBindGroupLayout({
        entries: [...entries, { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
      }),
    };
    this.uniform = device.createBuffer({ size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const module = device.createShaderModule({ code: cull });
    this.cull = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'cull' } });
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: 'feature-edges:draw',
      order: this.order,
      execute: (context) => {
        if (context.backend === 'webgpu') this.draw(context);
      },
    });
  }
  private draw(context: GPUContext): void {
    const engine = this.engine!,
      device = context.device,
      stats = this.stats,
      frameId = ++this.frameId;
    stats.segments = stats.instances = stats.drawCalls = 0;
    if (device !== engine.gpu) return;
    const section = SECTION.test(context.shader)
        ? (context.bindings.find((b) => b.binding === +SECTION_BINDING.exec(context.shader)![1])?.resource as
            | GPUBufferBinding
            | undefined)
        : undefined,
      drawn = this.drawn,
      args = this.argsData;
    drawn.length = 0;
    // Core's batches carry this frame's drawn count per geometry (pick passes have none and never run this pass).
    for (const batch of context.batches ?? []) {
      const geometry = batch.geometry;
      let shape = this.shapes.get(geometry);
      if (!shape) {
        const edges = edgeRecord(geometry, featureEdges(geometry, this.angle));
        shape = { edges, segments: edges[4], count: 0, stride: 0, frame: 0 };
        this.shapes.set(geometry, shape);
      }
      shape.frame = frameId;
      shape.count = batch.count;
      if (!shape.count || !shape.segments) continue;
      const buffers = engine.geometryBuffers(geometry)!,
        redirect = batch.redirect,
        instance = redirect?.instances ?? buffers.instance;
      if (!shape.buffer) {
        shape.buffer = device.createBuffer({
          size: shape.edges.byteLength,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        shape.args = device.createBuffer({
          size: 80,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
        });
      }
      if (shape.instance !== instance) {
        // One list region per tier, 256-byte aligned so each tier's draw binds it with a dynamic offset.
        shape.instance = instance;
        shape.stride = Math.ceil(instance.size / 96 / 64) * 64;
        shape.edges[5] = shape.stride;
        device.queue.writeBuffer(shape.buffer, 0, shape.edges as Uint32Array<ArrayBuffer>);
        shape.list?.destroy();
        shape.list = device.createBuffer({ size: shape.stride * 4 * TIERS, usage: GPUBufferUsage.STORAGE });
        shape.group = shape.sectionGroup = shape.cullGroup = undefined;
      }
      const entries = [
        { binding: 0, resource: { buffer: this.uniform! } },
        { binding: 1, resource: { buffer: buffers.vertex } },
        { binding: 2, resource: { buffer: shape.buffer } },
        { binding: 3, resource: { buffer: instance } },
        { binding: 5, resource: { buffer: shape.list!, size: shape.stride * 4 } },
      ];
      if (section && shape.section !== section.buffer) {
        shape.section = section.buffer;
        shape.sectionGroup = undefined;
      }
      const group = section
        ? (shape.sectionGroup ??= device.createBindGroup({
            layout: this.layouts!.section,
            entries: [...entries, { binding: 4, resource: section }],
          }))
        : (shape.group ??= device.createBindGroup({ layout: this.layouts!.plain, entries }));
      shape.cullGroup ??= device.createBindGroup({
        layout: this.cull!.getBindGroupLayout(0),
        entries: [
          entries[0],
          entries[2],
          entries[3],
          { binding: 5, resource: { buffer: shape.list! } },
          { binding: 6, resource: { buffer: shape.args! } },
        ],
      });
      for (let t = 0; t < TIERS; t++) {
        args[t * 4] = Math.ceil(shape.segments / 4 ** t) * 6;
        args[t * 4 + 1] = 0;
      }
      args[16] = shape.count;
      device.queue.writeBuffer(shape.args!, 0, args);
      // A redirected batch's kept count lives on the GPU: copy it over the CPU upper bound.
      if (redirect) context.encoder.copyBufferToBuffer(redirect.args, 4, shape.args!, 64, 4);
      drawn.push([shape, group]);
      stats.segments += shape.segments * shape.count;
      stats.instances += shape.count;
    }
    for (const [geometry, shape] of this.shapes)
      if (shape.frame !== frameId) {
        this.release(shape);
        this.shapes.delete(geometry);
      }
    stats.geometries = this.shapes.size;
    if (!drawn.length) return;
    this.upload(context);
    const compute = context.encoder.beginComputePass();
    compute.setPipeline(this.cull!);
    for (const [shape] of drawn) {
      compute.setBindGroup(0, shape.cullGroup!);
      compute.dispatchWorkgroups(Math.ceil(shape.count / 64));
    }
    compute.end();
    this.colorAttachment.view = context.color;
    this.descriptor.depthStencilAttachment!.view = context.depth;
    const pass = context.encoder.beginRenderPass(this.descriptor);
    pass.setPipeline(this.pipeline(context, !!section));
    for (const [shape, group] of drawn)
      for (let t = 0; t < TIERS; t++) {
        pass.setBindGroup(0, group, [t * shape.stride * 4]);
        pass.drawIndirect(shape.args!, t * 16);
        stats.drawCalls++;
      }
    pass.end();
    drawn.length = 0;
  }
  private release(shape: Shape): void {
    shape.buffer?.destroy();
    shape.list?.destroy();
    shape.args?.destroy();
    shape.buffer =
      shape.list =
      shape.args =
      shape.instance =
      shape.group =
      shape.sectionGroup =
      shape.cullGroup =
        undefined;
  }
  private upload(context: GPUContext): void {
    const f = this.frame,
      canvas = this.engine!.canvas,
      encode = !context.format.endsWith('-srgb') && !context.format.includes('float');
    f.set(context.camera.matrix);
    f[16] = context.width;
    f[17] = context.height;
    const ratio = canvas.clientWidth ? context.width / canvas.clientWidth : 1,
      m = context.camera.matrix;
    f[18] = (this.width * ratio) / 2;
    f[19] = (Math.hypot(m[1], m[5], m[9]) * context.height) / 2;
    f[24] = this.minRadius * ratio;
    f[25] = this.minRadius ? 0.5 : 0;
    for (let c = 0; c < 3; c++) {
      const v = Math.min(1, this.color[c]);
      f[20 + c] = encode ? (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) : v;
    }
    f[23] = this.color[3];
    context.device.queue.writeBuffer(this.uniform!, 0, f);
  }
  private pipeline(context: GPUContext, section: boolean): GPURenderPipeline {
    const device = context.device,
      depth = context.descriptor.depthStencil!.format,
      count = context.descriptor.multisample?.count ?? 1,
      key = (clip: boolean) => `${context.format}|${depth}|${count}|${clip}`;
    let pipeline = this.pipelines.get(key(section));
    const descriptor = (clip: boolean): GPURenderPipelineDescriptor => {
      const module = device.createShaderModule({ code: shader(clip) });
      return {
        layout: device.createPipelineLayout({ bindGroupLayouts: [clip ? this.layouts!.section : this.layouts!.plain] }),
        vertex: { module, entryPoint: 'vertex' },
        fragment: {
          module,
          entryPoint: 'fragment',
          targets: [
            {
              format: context.format,
              blend: {
                color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              },
            },
          ],
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        multisample: { count },
        depthStencil: {
          format: depth,
          depthWriteEnabled: false,
          depthCompare: 'greater-equal',
          depthBias: this.bias,
          depthBiasSlopeScale: 1,
        },
      };
    };
    if (!pipeline) {
      pipeline = device.createRenderPipeline(descriptor(section));
      this.pipelines.set(key(section), pipeline);
      // Compile the other variant in the background, so adding or removing SectionPlanes later does not stall (HANDOFF 1d'').
      const other = key(!section);
      if (!this.pipelines.has(other) && device.createRenderPipelineAsync)
        device.createRenderPipelineAsync(descriptor(!section)).then(
          (p) => {
            if (this.engine?.gpu === device && !this.pipelines.has(other)) this.pipelines.set(other, p);
          },
          () => {},
        );
    }
    return pipeline;
  }
  onDeviceRestored(engine: Engine): void {
    this.dispose();
    this.setup(engine);
  }
  dispose(): void {
    for (const shape of this.shapes.values()) this.release(shape);
    this.shapes.clear();
    this.uniform?.destroy();
    this.uniform = this.layouts = this.engine = this.cull = undefined;
    this.pipelines.clear();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
