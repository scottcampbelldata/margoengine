// Scatter's route on the WebGL2 compatibility layer, loaded by import() only there (the WebGL2 roadmap, "Package
// routes"). The WebGPU cull and shadow-list kernels hand out list slots with atomics, which put them on the layer's CPU
// tier: JavaScript, a read-back of the heightmap per dispatch, 50 to 90 ms a frame for 110,000 blades. Here the same
// tests run as point draws on the GPU, each kernel storing at its own index or at an exact slot:
// - each candidate stores its Instance and one flag per LOD ring (a fade band flags two rings);
// - one prefix count over the three rings (shared/prefix.js) gives every instance its slot, then each ring is compacted;
// - the shadow lists do the same with one flag per cascade and ring.
// So the rings and lists hold the instances the WebGPU route's hold, in candidate order (WebGPU's order is whichever
// thread came first, and depth makes it not matter). A GPU-written indirect draw would stall the main thread on a
// read-back of its arguments (WebGL2 has no indirect draws), so a draw asks for every slot of its ring or list and its
// vertex shader drops those at or past the count, read from a small buffer of counts.
import { MargoError } from '@margoengine/math/errors';
import { PrefixCount } from '../../shared/prefix.js';

declare const GPUBufferUsage: { STORAGE: number; UNIFORM: number; COPY_DST: number };

const stale = () =>
  new MargoError(
    'unsupported',
    'Scatter on WebGL2 needs the shader its compatibility route was written for; update the edits in scatter/src/compat.ts',
  );
const once = (code: string, from: string, to: string): string => {
  if (code.split(from).length !== 2) throw stale();
  return code.replace(from, to);
};
const RINGS = 3;
/** Words between two counts in the counts buffer: each count is bound alone, at a 256-byte aligned offset. */
const COUNT_STRIDE = 64;
const cullEntry = '@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){';
const lanes = (n: string) => `@group(0) @binding(0) var<uniform> ${n}:vec4u;\n`;
const instance = 'struct Instance {position:vec4f,rotation:vec4f}\n';

/**
 * The candidate kernel from a cull text (`scatterCullShader`, any options): every test as written, then the Instance and
 * one flag per ring at the candidate's own index; a fade band's rotation.w holds its first ring plus 1 until compaction.
 * @throws MargoError `'unsupported'` when the text is not the one these edits were written for.
 */
export function candidateShader(cull: string): string {
  let code = cull;
  for (const [from, to] of [
    ['@group(0) @binding(2) var<storage,read_write> near:array<Instance>;\n', '@group(0) @binding(2) var<storage,read_write> candidates:array<Instance>;\n'],
    ['@group(0) @binding(3) var<storage,read_write> middle:array<Instance>;\n', '@group(0) @binding(3) var<storage,read_write> marks:array<u32>;\n'],
    ['@group(0) @binding(4) var<storage,read_write> far:array<Instance>;\n', ''],
    ['struct Command {indices:u32,count:atomic<u32>,first:u32,base:u32,instance:u32}\n', ''],
    ['@group(0) @binding(5) var<storage,read_write> commands:array<Command,3>;\n', ''],
    [
      `fn emit(ring:u32,instance:Instance){
 let slot=atomicAdd(&commands[ring].count,1u);
 if(ring==0u){near[slot]=instance;}else if(ring==1u){middle[slot]=instance;}else{far[slot]=instance;}
}
`,
      'var<private> placed:Instance;\n',
    ],
    [cullEntry, 'fn place(id:vec3u)->u32{'],
    [
      'instance.rotation.w=1.0;emit(ring,instance);\n   instance.rotation.w=2.0;emit(ring+1u,instance);return;',
      'instance.rotation.w=f32(ring)+1.0;placed=instance;return 3u<<ring;',
    ],
    [
      'emit(select(select(2u,1u,d<frame.lod.y),0u,d<frame.lod.x),instance);',
      'placed=instance;return 1u<<select(select(2u,1u,d<frame.lod.y),0u,d<frame.lod.x);',
    ],
  ])
    code = once(code, from, to);
  return `${code.replaceAll('return;', 'return 0u;')}
${cullEntry}
 if(id.x>=frame.ids.x){return;}
 let mask=place(id);
 candidates[id.x]=placed;
 let n=frame.ids.x;marks[id.x]=mask&1u;marks[n+id.x]=(mask>>1u)&1u;marks[2u*n+id.x]=mask>>2u;
}`;
}
/** One LOD ring's compaction; a fade band's copy takes the rotation.w the WebGPU route gives that ring (1 or 2). */
export const compactShader = (ring: number): string =>
  `${instance}${lanes('n')}@group(0) @binding(1) var<storage,read> candidates:array<Instance>;
@group(0) @binding(2) var<storage,read> marks:array<u32>;
@group(0) @binding(3) var<storage,read> slots:array<u32>;
@group(0) @binding(4) var<storage,read_write> rings:array<Instance>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
 let at=${ring}u*n.x+id.x;
 if(id.x>=n.x||marks[at]!=1u){return;}
 var c=candidates[id.x];
 if(c.rotation.w>0.0){c.rotation.w=select(2.0,1.0,u32(c.rotation.w)==${ring + 1}u);}
 rings[slots[at]-slots[${ring}u*n.x]]=c;
}`;
/** One invocation: each list's count, into the draw arguments (as WebGPU leaves them) and the counts the draws read. */
export const totalsShader = (first: number, lists: number): string =>
  `${lanes('n')}@group(0) @binding(1) var<storage,read> slots:array<u32>;
@group(0) @binding(2) var<storage,read_write> commands:array<u32>;
@group(0) @binding(3) var<storage,read_write> counts:array<u32>;
@compute @workgroup_size(1) fn main(){
 for(var l=0u;l<${lists}u;l++){
  let count=slots[(l+1u)*n.x]-slots[l*n.x];
  commands[l*5u+1u]=count;counts[(l+${first}u)*${COUNT_STRIDE}u]=count;
 }
}`;
/** The shadow lists' flags: one per cascade and ring, for each instance of each ring (`shadowCullCode`'s test). */
export const shadowMarksShader = `struct Cull {light:array<mat4x4f,4>,lists:vec4u,size:vec4f}
@group(0) @binding(0) var<uniform> u:Cull;
@group(0) @binding(1) var<storage,read> counts:array<u32,15>;
@group(0) @binding(2) var<storage,read> near:array<vec4f>;
@group(0) @binding(3) var<storage,read> middle:array<vec4f>;
@group(0) @binding(4) var<storage,read> far:array<vec4f>;
@group(0) @binding(5) var<storage,read_write> marks:array<u32>;
@group(0) @binding(6) var<uniform> n:vec4u;
fn reaches(c:u32,p:vec4f)->u32 {
 let r=u.size.y*p.w;let radius=r+1e-5*(length(p.xyz)+r);
 let m=transpose(u.light[c]);var planes=array(m[3]+m[0],m[3]-m[0],m[3]+m[1],m[3]-m[1],m[2],m[3]-m[2]);var k=0u;
 while(k<6u&&dot(planes[k].xyz,p.xyz)+planes[k].w>=-radius*length(planes[k].xyz)){k++;}
 return select(0u,1u,k==6u);
}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
 let ring=id.y;let i=id.x;if(i>=n.x){return;}
 let held=i<counts[ring*5u+1u];
 var p:vec4f;if(ring==0u){p=near[i*2u];}else if(ring==1u){p=middle[i*2u];}else{p=far[i*2u];}
 for(var c=0u;c<4u;c++){
  if(c<u32(u.size.x)){var flag=0u;if(held){flag=reaches(c,p);}marks[(c*3u+ring)*n.x+i]=flag;}
 }
}`;
/** Each flagged instance's index at its slot of its cascade's list for its ring. */
export const shadowCompactShader = `struct Cull {light:array<mat4x4f,4>,lists:vec4u,size:vec4f}
@group(0) @binding(0) var<uniform> u:Cull;
@group(0) @binding(1) var<storage,read> marks:array<u32>;
@group(0) @binding(2) var<storage,read> slots:array<u32>;
@group(0) @binding(3) var<storage,read_write> lists:array<u32>;
@group(0) @binding(4) var<uniform> n:vec4u;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
 let ring=id.y;let i=id.x;if(i>=n.x){return;}
 for(var c=0u;c<4u;c++){
  let lane=(c*3u+ring)*n.x;
  if(c<u32(u.size.x)&&marks[lane+i]==1u){lists[c*u.lists.w+u.lists[ring]+slots[lane+i]-slots[lane]]=i;}
 }
}`;
const counted = (group: number, binding: number) =>
  `@group(${group}) @binding(${binding}) var<storage,read> drawnCount:array<u32>;\n`;
/** A vertex stage that draws nothing for the slots at or past its list's count (the binding `counted` declares). */
export function countedVertex(
  code: string,
  list: string,
  group: number,
  binding: number,
  none: string,
): string {
  return once(once(code, '@vertex', counted(group, binding) + '@vertex'), list, `if(index>=drawnCount[0]){${none}}${list}`);
}
const noOutput = 'var none:Output;none.clip=vec4f(2,2,2,1);return none;';
const noPosition = 'return vec4f(2,2,2,1);';

/** What the route needs of its Scatter: its fixed buffers and meshes, and the shadow vertex texts of the root. */
export interface RouteHost {
  device: GPUDevice;
  cull: string;
  count: number;
  capacity: number;
  uniform: GPUBuffer;
  rings: GPUBuffer[];
  commands: GPUBuffer;
  exclusions: GPUBuffer;
  vertices: GPUBuffer[];
  indices: GPUBuffer[];
  indexCounts: number[];
  values: Float32Array;
  shadowCode: string;
  shadowListCode: string;
  shadowDepth(device: GPUDevice, code: string): GPURenderPipeline;
}
type Kernel = [GPUComputePipeline, GPUBindGroup, number, number];
const pipeline = (device: GPUDevice, code: string): GPUComputePipeline =>
  device.createComputePipeline({
    layout: 'auto',
    compute: { module: device.createShaderModule({ code }), entryPoint: 'main' },
  });
const entries = (list: (GPUBuffer | GPUBindingResource)[]): GPUBindGroupEntry[] =>
  list.map((resource, binding) => ({
    binding,
    resource: 'size' in resource && 'usage' in resource ? { buffer: resource } : (resource as GPUBindingResource),
  }));

/** Scatter's GPU state on the layer: the kernels, the counts and the shadow draws. */
export class ScatterRoute {
  private readonly owned: { destroy(): void }[] = [];
  private readonly device: GPUDevice;
  private readonly candidates: GPUBuffer;
  private readonly slots: PrefixCount;
  private readonly lanes: GPUBuffer;
  private readonly placing: GPUComputePipeline;
  private placeGroup?: GPUBindGroup;
  private placedFrom: (GPUTexture | undefined)[] = [];
  private readonly finish: Kernel[];
  /** 3 ring counts, then one per cascade and ring, each bound alone. */
  private readonly counts: GPUBuffer;
  private shadow?: {
    cascades: number;
    sizes: number[];
    prefix: PrefixCount;
    lists: GPUBuffer;
    commands: GPUBuffer;
    uniform: GPUBuffer;
    values: Float32Array;
    steps: Kernel[];
    encoder?: GPUCommandEncoder;
  };
  private listPipeline?: GPURenderPipeline;
  private plainPipeline?: GPURenderPipeline;
  private readonly uniforms: GPUBuffer[] = [];
  private readonly groups = new Map<string, GPUBindGroup>();
  private readonly shadowValues = new Float32Array(32);
  constructor(private readonly host: RouteHost) {
    const d = (this.device = host.device),
      n = host.count,
      storage = (size: number) => this.make(size, GPUBufferUsage.STORAGE);
    this.candidates = storage(n * 32);
    this.slots = new PrefixCount(d, n * RINGS, this.owned);
    this.counts = storage((RINGS + 4 * RINGS) * COUNT_STRIDE * 4);
    this.lanes = this.make(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    d.queue.writeBuffer(this.lanes, 0, new Uint32Array([n, 0, 0, 0]));
    this.placing = pipeline(d, candidateShader(host.cull));
    const groups = Math.ceil(n / 64);
    this.finish = host.rings.map((ring, r) =>
      this.kernel(
        compactShader(r),
        [this.lanes, this.candidates, this.slots.flags, this.slots.prefix, ring],
        groups,
      ),
    );
    this.finish.push(
      this.kernel(totalsShader(0, RINGS), [this.lanes, this.slots.prefix, host.commands, this.counts], 1),
    );
  }
  private make(size: number, usage: number): GPUBuffer {
    const made = this.device.createBuffer({ size, usage });
    this.owned.push(made);
    return made;
  }
  private kernel(code: string, list: (GPUBuffer | GPUBindingResource)[], x: number, y = 1): Kernel {
    const p = pipeline(this.device, code);
    return [p, this.device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: entries(list) }), x, y];
  }
  private run(pass: GPUComputePassEncoder, [p, group, x, y]: Kernel): void {
    pass.setPipeline(p);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(x, y);
  }
  /** The frame's distribute pass: the rings and their counts, as `Scatter`'s cull leaves them. */
  cull(encoder: GPUCommandEncoder, terrain: GPUTexture, density: GPUTexture | undefined): void {
    const h = this.host;
    if (!this.placeGroup || this.placedFrom[0] !== terrain || this.placedFrom[1] !== density) {
      this.placeGroup = this.device.createBindGroup({
        layout: this.placing.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: h.uniform } },
          { binding: 1, resource: terrain.createView() },
          { binding: 2, resource: { buffer: this.candidates } },
          { binding: 3, resource: { buffer: this.slots.flags } },
          { binding: 6, resource: { buffer: h.exclusions } },
          ...(density ? [{ binding: 7, resource: density.createView() }] : []),
        ],
      });
      this.placedFrom = [terrain, density];
    }
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.placing);
    pass.setBindGroup(0, this.placeGroup);
    pass.dispatchWorkgroups(Math.ceil(h.count / 64));
    this.slots.encode(pass);
    for (const step of this.finish) this.run(pass, step);
    pass.end();
  }
  /** The colour pass's vertex stage (`lit`: core's, with the instances in group 1), counting its ring. */
  vertex(code: string, lit: boolean): string {
    return countedVertex(code, 'let data=instances[index];', lit ? 1 : 0, 2, noOutput);
  }
  /** The resource of a ring's count. */
  ringCount(ring: number): GPUBufferBinding {
    return { buffer: this.counts, offset: ring * COUNT_STRIDE * 4, size: 16 };
  }
  private buildShadow(cascades: number): void {
    const h = this.host,
      sizes = h.rings.map((b) => Math.ceil(b.size / 2048) * 64),
      threads = Math.max(...sizes),
      stride = sizes[0] + sizes[1] + sizes[2],
      lanes = cascades * RINGS;
    const prefix = new PrefixCount(this.device, threads * lanes, this.owned),
      lists = this.make(cascades * stride * 4, GPUBufferUsage.STORAGE),
      commands = this.make(lanes * 20, GPUBufferUsage.STORAGE),
      uniform = this.make(288, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
      size = this.make(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
      values = new Float32Array(72);
    this.device.queue.writeBuffer(size, 0, new Uint32Array([threads, 0, 0, 0]));
    new Uint32Array(values.buffer, 256, 4).set([0, sizes[0], sizes[0] + sizes[1], stride]);
    const groups = Math.ceil(threads / 64);
    this.shadow = {
      cascades,
      sizes,
      prefix,
      lists,
      commands,
      uniform,
      values,
      steps: [
        this.kernel(
          shadowMarksShader,
          [uniform, h.commands, h.rings[0], h.rings[1], h.rings[2], prefix.flags, size],
          groups,
          RINGS,
        ),
        this.kernel(shadowCompactShader, [uniform, prefix.flags, prefix.prefix, lists, size], groups, RINGS),
        this.kernel(totalsShader(RINGS, lanes), [size, prefix.prefix, commands, this.counts], 1),
      ],
    };
    for (const key of this.groups.keys()) this.groups.delete(key);
  }
  /** `Scatter.prepareShadow`: the lists of this frame's instances per cascade and ring. */
  prepareShadow(encoder: GPUCommandEncoder, matrices: Float32Array, cascades: number, radius: number): void {
    if (this.shadow?.cascades !== cascades) this.buildShadow(cascades);
    const s = this.shadow!;
    for (let i = 0; i < cascades * 16; i++) s.values[i] = matrices[i];
    s.values[68] = cascades;
    s.values[69] = radius;
    this.device.queue.writeBuffer(s.uniform, 0, s.values as Float32Array<ArrayBuffer>);
    const pass = encoder.beginComputePass();
    this.run(pass, s.steps[0]);
    s.prefix.encode(pass);
    this.run(pass, s.steps[1]);
    this.run(pass, s.steps[2]);
    pass.end();
    s.encoder = encoder;
  }
  /** `Scatter.drawShadow`: one cascade's rings, through its lists after `prepareShadow` in this frame. */
  drawShadow(encoder: GPUCommandEncoder, pass: GPURenderPassEncoder, matrix: Float32Array, cascade: number): void {
    const h = this.host,
      d = this.device,
      s = this.shadow,
      culled = !!s && s.encoder === encoder && cascade < s.cascades,
      p = culled
        ? (this.listPipeline ??= h.shadowDepth(
            d,
            countedVertex(h.shadowListCode, 'let data=instances[list[index]];', 0, 3, noPosition),
          ))
        : (this.plainPipeline ??= h.shadowDepth(
            d,
            countedVertex(h.shadowCode, 'let data=instances[index];', 0, 3, noPosition),
          ));
    const uniform = (this.uniforms[cascade] ??= this.make(128, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST));
    const v = this.shadowValues;
    v.set(matrix);
    v.set(h.values.subarray(16, 20), 16);
    v.set(h.values.subarray(68, 80), 20);
    d.queue.writeBuffer(uniform, 0, v as Float32Array<ArrayBuffer>);
    pass.setPipeline(p);
    for (let ring = 0; ring < RINGS; ring++) {
      const key = `${culled}:${cascade}:${ring}`;
      let group = this.groups.get(key);
      if (!group) {
        const o = s ? new Uint32Array(s.values.buffer, 256, 4) : undefined;
        group = d.createBindGroup({
          layout: p.getBindGroupLayout(0),
          entries: entries([
            uniform,
            h.rings[ring],
            ...(culled
              ? [
                  {
                    buffer: s.lists,
                    offset: (cascade * o![3] + o![ring]) * 4,
                    size: (o![ring + 1] - o![ring]) * 4,
                  },
                ]
              : []),
          ]).concat({
            binding: 3,
            resource: culled ? this.ringCount(RINGS + cascade * RINGS + ring) : this.ringCount(ring),
          }),
        });
        this.groups.set(key, group);
      }
      pass.setBindGroup(0, group);
      pass.setVertexBuffer(0, h.vertices[ring]);
      pass.setIndexBuffer(h.indices[ring], 'uint32');
      pass.drawIndexed(h.indexCounts[ring], culled ? s.sizes[ring] : h.capacity);
    }
  }
  destroy(): void {
    for (const b of this.owned) b.destroy();
    this.owned.length = 0;
  }
}
