// Scatter's cull in candidate order, on WebGPU and on the WebGL2 layer alike. The distribute shader as written hands
// out ring slots with atomicAdd, so a ring holds this frame's instances in whichever order the threads ran: on an Apple
// M6 at 4x MSAA the edge pixels of an instance follow that order, and a still view drew other pixels every frame
// (docs/known-bugs.md, fixed table). Here every candidate stores its Instance and one flag per LOD ring at its own
// index, one prefix count over the three rings (shared/prefix.js) gives each flagged candidate its slot, and each ring
// is compacted: instance i keeps its candidate order, frame after frame, on every GPU. A ring keeps at most its
// buffer's instances (the first in candidate order), as ScatterTiles' rings sized from the held tiles need.
import { MargoError } from '@margoengine/math/errors';
import { PrefixCount } from '../../shared/prefix.js';

declare const GPUBufferUsage: { STORAGE: number; UNIFORM: number; COPY_DST: number };

const stale = () =>
  new MargoError(
    'unsupported',
    'Scatter culls in order only with the distribute shader its edits were written for; update the edits in scatter/src/order.ts',
  );
const once = (code: string, from: string, to: string): string => {
  if (code.split(from).length !== 2) throw stale();
  return code.replace(from, to);
};
/** The distribute shader's entry line, which the candidate kernel keeps. */
const cullEntry = '@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){';
/** Lanes uniform of the compaction: candidates in x, the three rings' capacities in y, z and w. */
const lanes = '@group(0) @binding(0) var<uniform> n:vec4u;\n';

/**
 * The candidate kernel from a cull text (`scatterCullShader`, any options): every test as written, then one flag per
 * ring and, for a candidate in a ring, the Instance at the candidate's own index (compaction reads no other); a fade
 * band's rotation.w holds its first ring plus 1 until compaction.
 * @throws MargoError `'unsupported'` when the text is not the one these edits were written for.
 */
export function candidateShader(cull: string): string {
  let code = cull;
  for (const [from, to] of [
    [
      '@group(0) @binding(2) var<storage,read_write> near:array<Instance>;\n',
      '@group(0) @binding(2) var<storage,read_write> candidates:array<Instance>;\n',
    ],
    [
      '@group(0) @binding(3) var<storage,read_write> middle:array<Instance>;\n',
      '@group(0) @binding(3) var<storage,read_write> marks:array<u32>;\n',
    ],
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
 if(mask!=0u){candidates[id.x]=placed;}
 let n=frame.ids.x;marks[id.x]=mask&1u;marks[n+id.x]=(mask>>1u)&1u;marks[2u*n+id.x]=mask>>2u;
}`;
}
/**
 * One LOD ring's compaction, up to the ring's capacity (`n[ring + 1]`); a fade band's copy takes the rotation.w of
 * that ring's half of the band (1 or 2).
 */
export const compactShader = (ring: number): string =>
  `struct Instance {position:vec4f,rotation:vec4f}
${lanes}@group(0) @binding(1) var<storage,read> candidates:array<Instance>;
@group(0) @binding(2) var<storage,read> marks:array<u32>;
@group(0) @binding(3) var<storage,read> slots:array<u32>;
@group(0) @binding(4) var<storage,read_write> rings:array<Instance>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
 let at=${ring}u*n.x+id.x;
 if(id.x>=n.x||marks[at]!=1u){return;}
 let slot=slots[at]-slots[${ring}u*n.x];if(slot>=n[${ring + 1}u]){return;}
 var c=candidates[id.x];
 if(c.rotation.w>0.0){c.rotation.w=select(2.0,1.0,u32(c.rotation.w)==${ring + 1}u);}
 rings[slot]=c;
}`;
/** One invocation: each ring's instance count, up to its capacity, into its indirect draw. */
const ringTotalsShader = `${lanes}@group(0) @binding(1) var<storage,read> slots:array<u32>;
@group(0) @binding(2) var<storage,read_write> commands:array<u32>;
@compute @workgroup_size(1) fn main(){
 for(var l=0u;l<3u;l++){commands[l*5u+1u]=min(slots[(l+1u)*n.x]-slots[l*n.x],n[l+1u]);}
}`;

type Kernel = [GPUComputePipeline, GPUBindGroup, number];
const kernel = (device: GPUDevice, code: string, buffers: GPUBuffer[], x: number): Kernel => {
  const p = device.createComputePipeline({
    layout: 'auto',
    compute: { module: device.createShaderModule({ code }), entryPoint: 'main' },
  });
  return [
    p,
    device.createBindGroup({
      layout: p.getBindGroupLayout(0),
      entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
    }),
    x,
  ];
};

/**
 * The GPU state of scatter's ordered cull for `n` candidates: the candidates, their flags and slots, and the kernels
 * that compact the rings. The candidate kernel (a pipeline of {@link candidateShader}) binds `candidates` and
 * `flags`; {@link OrderedCull#encode} then fills the rings and their indirect draw counts.
 */
export class OrderedCull {
  readonly candidates: GPUBuffer;
  readonly flags: GPUBuffer;
  private readonly owned: { destroy(): void }[] = [];
  private readonly prefix: PrefixCount;
  private readonly lanes: GPUBuffer;
  private readonly values: Uint32Array;
  private steps: Kernel[] = [];
  private bound: GPUBuffer[] = [];
  constructor(
    private readonly device: GPUDevice,
    readonly n: number,
  ) {
    const make = (size: number, usage: number) => {
      const b = device.createBuffer({ size, usage });
      this.owned.push(b);
      return b;
    };
    this.candidates = make(n * 32, GPUBufferUsage.STORAGE);
    this.prefix = new PrefixCount(device, n * 3, this.owned);
    this.flags = this.prefix.flags;
    this.lanes = make(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.values = new Uint32Array([n, 0, 0, 0]);
  }
  /** Records the count and the compaction into `rings` (32 bytes per instance) and the counts of `commands`. */
  encode(pass: GPUComputePassEncoder, rings: GPUBuffer[], commands: GPUBuffer): void {
    const d = this.device,
      v = this.values,
      fresh = [...rings, commands];
    if (fresh.some((b, k) => b !== this.bound[k])) {
      const groups = Math.ceil(this.n / 64);
      this.steps = rings.map((ring, r) =>
        kernel(d, compactShader(r), [this.lanes, this.candidates, this.flags, this.prefix.prefix, ring], groups),
      );
      this.steps.push(kernel(d, ringTotalsShader, [this.lanes, this.prefix.prefix, commands], 1));
      this.bound = fresh;
      for (let r = 0; r < 3; r++) v[r + 1] = rings[r].size / 32;
      d.queue.writeBuffer(this.lanes, 0, v as Uint32Array<ArrayBuffer>);
    }
    this.prefix.encode(pass);
    for (const [p, group, x] of this.steps) {
      pass.setPipeline(p);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(x);
    }
  }
  /** GPU bytes it holds: 32 per candidate, its flags and slots (12 bytes per candidate each, plus their levels). */
  get bytes(): number {
    let n = 0;
    for (const b of this.owned) n += (b as GPUBuffer).size;
    return n;
  }
  destroy(): void {
    for (const b of this.owned) b.destroy();
    this.owned.length = 0;
  }
}
