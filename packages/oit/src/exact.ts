// Exact order-independent transparency: every transparent fragment goes into a per-pixel linked list (Yang, Hensley,
// Grun and Thibieroz 2010, "Real-Time Concurrent Linked List Construction on the GPU"), a compute pass keeps the nearest
// layers of each pixel in depth order (a k-buffer, Bavoil et al. 2007), and they blend back to front.
//
// A fragment shader that writes storage runs before the depth test and the scene depth cannot be sampled, so fragments
// behind opaque surfaces reach the list too. The resolve draws layer after layer as a full-screen triangle whose
// frag_depth is the stored depth, so the hardware test against the scene decides, per sample, what the accumulate pass's
// test would have. The stored coverage mask leaves the same samples out, which keeps MSAA edges.
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type PassContext } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { applyView } from '../../shared/view-rect.js';
import { currentFrame, retire, writeUniform } from '../../shared/frame-resources.js';
import { alphaBlend, groupCode } from '../../shared/pass.js';
import { TransparentPass, pbrLayer } from './pass.js';

export type { TransparentPass };

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; COPY_SRC: number; STORAGE: number; MAP_READ: number };
declare const GPUMapMode: { READ: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** `ExactOIT` settings, fixed at construction. */
export interface ExactOITOptions {
  /** Frame graph order of the transparent passes, as in `OITOptions`. Default 8. */
  order?: number;
  /** Nearest layers kept per pixel, 1 to 32; farther ones are left out. Default 8. */
  layers?: number;
  /** Starting list size in fragments per screen pixel; the list grows by itself. Above 0. Default 2. */
  pool?: number;
}
/** What the last read-back frame stored, from `ExactOIT.stats`; it trails the picture by a few frames. */
export interface ExactOITStats {
  /** Transparent fragments of that frame, those behind opaque surfaces included; multisampled, a GPU that runs the list shader once per sample (Apple) counts each sample. */
  fragments: number;
  /** Fragments the list holds now. */
  capacity: number;
  /** Fragments of that frame that found no room; above 0 only for the frames before the list grows, or at `limit`. */
  dropped: number;
  /** The most the device can hold in one storage binding. */
  limit: number;
}

// Group-2 bindings, beside weighted OIT's uniform (120), clear of transmission (124).
const BINDING = 120;
const NODE_BYTES = 16;
// A node is colour and alpha as four halves, depth, then the next node with the coverage mask in the top 4 bits
// (WebGPU has 1 or 4 samples). Slot 0 means the end of a list, and the word after the last pixel counts fragments.
const LINK = 0x0fffffff;
const surface = (group: number) => /* wgsl */ `
struct MargoTransparent {@location(0) unused:vec4f}
@group(${group}) @binding(${BINDING}) var<uniform> margoOIT:vec4u;
@group(${group}) @binding(${BINDING + 1}) var<storage,read_write> margoHeads:array<atomic<u32>>;
@group(${group}) @binding(${BINDING + 2}) var<storage,read_write> margoNodes:array<vec4u>;
var<private> margoCoverage:u32;
fn margoTransparentAt(color:vec4f,clip:vec4f,depth:f32)->MargoTransparent {
  var o:MargoTransparent; let a=clamp(color.a,0.0,1.0);
  if(a>=1.0/1024.0){
    let slot=atomicAdd(&margoHeads[margoOIT.y],1u)+1u;
    if(slot<margoOIT.z){
      let p=vec2u(clip.xy); let next=atomicExchange(&margoHeads[p.y*margoOIT.x+p.x],slot); let c=min(color.rgb,vec3f(65504.0));
      margoNodes[slot]=vec4u(pack2x16float(c.rg),pack2x16float(vec2f(c.b,a)),bitcast<u32>(clip.z),next|(margoCoverage<<28u));
    }
  }
  return o;
}
`;
// Reversed depth: larger is nearer. Equal depths fall back to the colour bits, so coplanar layers keep one order
// however the list happened to fill.
//
// Multisampled, a GPU may run the list shader more than once for one fragment: WGSL fixes how often only for
// sample-frequency shaders (sample_index or sample interpolation). Apple GPUs under Metal run it up to once per sample,
// every copy at the pixel centre with a coverage mask that may be the whole fragment's or part of it, so one layer
// lands in the list several times. The copies agree in depth, colour and alpha, so a multisampled sort merges nodes
// equal in those into one whose coverage is the union. The parts of one surface that meet in a pixel merge the same
// way, which is right; two coplanar layers of one colour and alpha become one layer there.
const sort = (layers: number, unique: boolean) => /* wgsl */ `
@group(0) @binding(0) var<uniform> u:vec4u;
@group(0) @binding(1) var<storage,read> heads:array<u32>;
@group(0) @binding(2) var<storage,read_write> nodes:array<vec4u>;
fn nearer(a:vec4u,b:vec4u)->bool {
  let x=bitcast<f32>(a.z); let y=bitcast<f32>(b.z);
  if(x!=y){return x>y;}
  if(a.x!=b.x){return a.x>b.x;}
  if(a.y!=b.y){return a.y>b.y;}
  return ${unique ? 'false' : '(a.w>>28u)>(b.w>>28u)'};
}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) g:vec3u) {
  if(g.x>=u.x||g.y>=u.w){return;}
  let first=heads[g.y*u.x+g.x];
  if(first==0u){return;}
  var kept:array<vec4u,${layers}>; var count=0u; var slot=first;
  while(slot!=0u){
    let node=nodes[slot]; slot=node.w&${LINK}u;
    if(count==${layers}u&&${unique ? 'nearer(kept[count-1u],node)' : '!nearer(node,kept[count-1u])'}){continue;}
    var at=count;
    while(at>0u&&nearer(node,kept[at-1u])){at-=1u;}
    ${unique ? `if(at>0u&&all(node.xyz==kept[at-1u].xyz)){kept[at-1u].w|=node.w&~${LINK}u; continue;}\n    if(at==${layers}u){continue;}` : ''}
    var to=min(count,${layers - 1}u);
    while(to>at){kept[to]=kept[to-1u]; to-=1u;}
    kept[at]=node; count=min(count+1u,${layers}u);
  }
  // The nearest layers go back on the front of the same chain, which ends after them.
  slot=first;
  for(var k=0u;k<count;k+=1u){
    let next=nodes[slot].w&${LINK}u; let last=k+1u==count;
    nodes[slot]=vec4u(kept[k].xyz,(kept[k].w&~${LINK}u)|select(next,0u,last)); slot=next;
  }
}
`;
// Instance k draws layer layers-1-k: back to front. A shorter list discards the far instances.
const resolve = (layers: number) => /* wgsl */ `
@group(0) @binding(0) var<uniform> u:vec4u;
@group(0) @binding(1) var<storage,read> heads:array<u32>;
@group(0) @binding(2) var<storage,read> nodes:array<vec4u>;
struct Layer {@builtin(position) position:vec4f, @location(0) @interpolate(flat) index:u32}
struct Result {@location(0) color:vec4f, @builtin(frag_depth) depth:f32, @builtin(sample_mask) mask:u32}
@vertex fn vertex(@builtin(vertex_index) i:u32,@builtin(instance_index) k:u32)->Layer {
  return Layer(vec4f(f32(i&1u)*4-1,f32(i>>1u)*4-1,0,1),${layers - 1}u-k);
}
@fragment fn fragment(v:Layer)->Result {
  let p=vec2u(v.position.xy); var slot=heads[p.y*u.x+p.x];
  for(var k=0u;k<v.index&&slot!=0u;k+=1u){slot=nodes[slot].w&${LINK}u;}
  if(slot==0u){discard;}
  let n=nodes[slot];
  return Result(vec4f(unpack2x16float(n.x),unpack2x16float(n.y)),bitcast<f32>(n.z),n.w>>28u);
}
`;

/**
 * Exact order-independent transparency: `oit.add(model)` draws the model's BLEND primitives (gltf-pro) or a transparent
 * materials mesh into per-pixel lists, and the nearest `layers` of each pixel blend in true depth order, per fragment, so
 * parts that cut through each other come out as sorted blending would if every pixel were sorted. Heavier than `OIT` in
 * memory and time: use it where the result must be right, such as CAD glass. Models not added keep sorted blending.
 * WebGPU only; needs storage buffers in fragment shaders.
 * @throws RangeError from the constructor for an `order`, `layers` or `pool` out of range.
 * @throws MargoError `'unsupported'` on a WebGL engine or a device without fragment storage buffers, `'disposed'` after
 * `dispose()`, `'state'` from `add` before `attach`.
 */
export class ExactOIT extends TransparentPass {
  readonly targets: readonly GPUColorTargetState[] = [];
  readonly layers: number;
  readonly layout: readonly GPUBindGroupLayoutEntry[] = [
    { binding: BINDING, visibility: 2, buffer: {} },
    { binding: BINDING + 1, visibility: 2, buffer: { type: 'storage' } },
    { binding: BINDING + 2, visibility: 2, buffer: { type: 'storage' } },
  ];
  private readonly poolShare: number;
  private readonly code = new Map<number, string>();
  private readonly surfaceCode = new Map<number, string>();
  private readonly words = new Uint32Array(4);
  private readonly values = new Float32Array(this.words.buffer);
  private uniform?: GPUBuffer;
  /** This view's uniform binding while its models draw (a frame-arena slice for a second view). */
  private binding?: GPUBufferBinding;
  private heads?: GPUBuffer;
  private nodes?: GPUBuffer;
  private pixels = 0;
  private capacity = 0;
  private wanted = 0;
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly sorters = new Map<boolean, GPUComputePipeline>();
  private readback?: GPUBuffer;
  /** The fragment count was copied for the frame now being finished and waits to be mapped. */
  private copied = false;
  private mapping = false;
  private counted = { fragments: 0, dropped: 0 };

  static attach(engine: EngineKernel, options?: ExactOITOptions): ExactOIT {
    const value = new ExactOIT(options);
    engineRuntime(engine).use(value);
    return value;
  }
  constructor({ order = 8, layers = 8, pool = 2 }: ExactOITOptions = {}) {
    if (!Number.isInteger(layers) || layers < 1 || layers > 32)
      throw new RangeError('Invalid ExactOIT layers; use a whole number from 1 to 32');
    if (!(pool > 0 && Number.isFinite(pool))) throw new RangeError('Invalid ExactOIT pool; use a number above 0');
    super(order);
    this.layers = layers;
    this.poolShare = pool;
  }
  /** Fragment counts of a recent frame, and the list's size. */
  get stats(): ExactOITStats {
    return { ...this.counted, capacity: this.capacity, limit: this.limit };
  }
  private get limit(): number {
    const { maxStorageBufferBindingSize, maxBufferSize } = this.device?.limits ?? {};
    return Math.min(LINK, Math.floor(Math.min(maxStorageBufferBindingSize ?? 0, maxBufferSize ?? 0) / NODE_BYTES));
  }
  override setup(engine: Engine): void {
    super.setup(engine);
    const device = engine.gpu!,
      // A limit of compatibility devices; a core device has none and allows the normal count.
      storage = (device.limits as { maxStorageBuffersInFragmentStage?: number }).maxStorageBuffersInFragmentStage;
    if (storage !== undefined && storage < 2)
      throw new MargoError('unsupported', 'ExactOIT needs storage buffers in fragment shaders; use OIT on this device');
    this.uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.readback = device.createBuffer({ size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  }
  /** @internal gltf-pro transparency hook. */
  declarations(group: number): string {
    return groupCode(this.code, group, (g) => this.surface(g) + pbrLayer);
  }
  /** @internal Effect hook. */
  surface(group: number): string {
    return groupCode(this.surfaceCode, group, surface);
  }
  /** @internal gltf-pro transparency hook. */
  bindings(): GPUBindGroupEntry[] {
    return [
      { binding: BINDING, resource: this.binding ?? { buffer: this.uniform! } },
      { binding: BINDING + 1, resource: { buffer: this.heads! } },
      { binding: BINDING + 2, resource: { buffer: this.nodes! } },
    ];
  }
  /** @internal gltf-pro transparency hook: the list pass, begun on the first transparent draw of the frame. */
  begin(): GPURenderPassEncoder {
    if (this.pass) return this.pass;
    const c = this.context!;
    const pass = (this.pass = c.encoder.beginRenderPass({
      label: 'oit:list',
      colorAttachments: [],
      depthStencilAttachment: { view: c.depth, depthReadOnly: true, stencilReadOnly: true },
    }));
    applyView(pass, c);
    return pass;
  }
  /** Sizes the buffers for this view. Views of different sizes share the largest, so none is replaced mid-frame. */
  private prepare(c: Context): void {
    const pixels = c.width * c.height,
      limit = this.limit;
    const capacity = Math.min(limit, Math.max(this.wanted, Math.ceil(pixels * this.poolShare) + 1, this.capacity));
    if (pixels > this.pixels) {
      retire(this.device!, this.heads);
      this.pixels = pixels;
      this.heads = c.device.createBuffer({
        label: 'oit:heads',
        size: (pixels + 1) * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      });
    }
    if (capacity > this.capacity) {
      retire(this.device!, this.nodes);
      this.capacity = capacity;
      this.nodes = c.device.createBuffer({
        label: 'oit:nodes',
        size: capacity * NODE_BYTES,
        usage: GPUBufferUsage.STORAGE,
      });
    }
  }
  /** A map ends unread only when the device is lost or the pass disposed: the count of a gone buffer means nothing. */
  private readonly mapEnded = (): void => {
    this.mapping = false;
  };
  /** Reads the count copied on an earlier frame. The list grows on the next frame after a read that found it short. */
  private readCount(): void {
    if (!this.copied || this.mapping) return;
    const buffer = this.readback!;
    this.copied = false;
    this.mapping = true;
    buffer
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        if (this.readback !== buffer) return this.mapEnded();
        const fragments = new Uint32Array(buffer.getMappedRange())[0];
        buffer.unmap();
        const room = this.capacity - 1;
        this.counted = { fragments, dropped: Math.max(0, fragments - room) };
        if (fragments > room) this.wanted = Math.ceil(fragments * 1.25) + 1;
        this.mapping = false;
      }, this.mapEnded);
  }
  protected render(c: Context): void {
    // This view draws in the frame: what it releases waits while another view's commands still need it.
    currentFrame(c.device, c.view ?? c);
    if (this.disposed || this.empty) return;
    this.readCount();
    this.prepare(c);
    this.words.set([c.width, c.width * c.height, this.capacity, c.height]);
    // A second view in the same frame gets its own copy of the uniform.
    this.binding = writeUniform(c.device, this.uniform!, this.values, c.view ?? c);
    const uniform = this.binding ?? { buffer: this.uniform! },
      bytes = (c.width * c.height + 1) * 4,
      device = c.device;
    c.encoder.clearBuffer(this.heads!, 0, bytes);
    try {
      if (!this.drawModels(c)) return;
    } finally {
      this.binding = undefined;
    }
    if (!this.mapping && !this.copied) {
      c.encoder.copyBufferToBuffer(this.heads!, bytes - 4, this.readback!, 0, 4);
      this.copied = true;
    }
    const samples = c.descriptor.multisample?.count ?? 1,
      unique = samples > 1;
    let sorter = this.sorters.get(unique);
    if (!sorter)
      this.sorters.set(
        unique,
        (sorter = device.createComputePipeline({
          label: 'oit:sort',
          layout: 'auto',
          compute: { module: device.createShaderModule({ code: sort(this.layers, unique) }), entryPoint: 'main' },
        })),
      );
    const entries = [
      { binding: 0, resource: uniform },
      { binding: 1, resource: { buffer: this.heads! } },
      { binding: 2, resource: { buffer: this.nodes! } },
    ];
    const compute = c.encoder.beginComputePass({ label: 'oit:sort' });
    compute.setPipeline(sorter);
    compute.setBindGroup(0, device.createBindGroup({ layout: sorter.getBindGroupLayout(0), entries }));
    compute.dispatchWorkgroups(Math.ceil(c.width / 8), Math.ceil(c.height / 8));
    compute.end();
    const format = c.descriptor.depthStencil!.format,
      key = c.format + samples + format;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      const module = device.createShaderModule({ code: resolve(this.layers) });
      this.pipelines.set(
        key,
        (pipeline = device.createRenderPipeline({
          label: 'oit:resolve',
          layout: 'auto',
          vertex: { module, entryPoint: 'vertex' },
          fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format, blend: alphaBlend }] },
          depthStencil: { format, depthWriteEnabled: false, depthCompare: 'greater-equal' },
          multisample: { count: samples },
        })),
      );
    }
    const out = c.encoder.beginRenderPass({
      label: 'oit:resolve',
      colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: c.depth, depthReadOnly: true, stencilReadOnly: true },
    });
    applyView(out, c);
    out.setPipeline(pipeline);
    out.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }));
    out.draw(3, this.layers);
    out.end();
  }
  protected release(): void {
    retire(this.device!, this.heads);
    retire(this.device!, this.nodes);
    this.heads = this.nodes = undefined;
    this.pixels = this.capacity = 0;
  }
  protected freeDevice(): void {
    this.release();
    this.pipelines.clear();
    this.sorters.clear();
    retire(this.device!, this.uniform);
    retire(this.device!, this.readback);
    this.uniform = this.readback = undefined;
    this.copied = false;
  }
}
