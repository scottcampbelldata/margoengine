// VFX's route on the WebGL2 compatibility layer, loaded by import() only there (the WebGL2 roadmap, "Package routes").
// The WebGPU simulation keeps blend order with workgroup memory (`prefix`) and counts with an atomic, which put its five
// dispatches on the layer's CPU tier: JavaScript, about 2.4 us a particle, 2.3 s a frame at a million. Here the same
// work runs as point draws on the GPU, each kernel storing at its own index:
// - dying slots flagged and counted (shared/prefix.js), so a slot's ticket is exactly the dying slots before it;
// - `update`, the same text with every feature's patch in it, reading its ticket instead of a workgroup scan;
// - each slot's live and on-screen flags from what `update` stored, with the same test;
// - `alive` compacted by the count of on-screen slots, in slot order, and the totals into `indirect` and `visible`.
// So births take the same lowest dead slots, the draw list has the same order and the same particles are drawn.
// A GPU-written indirect draw would stall the main thread on a read-back of its arguments (WebGL2 has no indirect
// draws), so the draw asks for every slot and its vertex shader drops those at or past the count in `visible`.
// The `sort` feature keeps its own kernels: it works on `alive` and `visible` as on WebGPU.
import { MargoError } from '@margoengine/math/errors';
import { PrefixCount } from '../../shared/prefix.js';
import { frame } from './frame.js';

type Kernel = [GPUComputePipeline, GPUBindGroup, number];

const stale = () =>
  new MargoError(
    'unsupported',
    'VFX on WebGL2 needs the shader its compatibility route was written for; update the edits in vfx/src/compat.ts',
  );
const once = (code: string, from: string, to: string): string => {
  if (code.split(from).length !== 2) throw stale();
  return code.replace(from, to);
};
const entry = '@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id:vec3u';
const liveCount = 'atomicAdd(&indirect.instanceCount,1u);';
const updateEnd = '  return 1u;\n}';
const particlesRead = '@group(0) @binding(1) var<storage,read> particles:array<vec4f>;\n';

/**
 * The kernels of a simulation text (`simulationShader` with its features' patches): `flags` flags the dying slots,
 * `update` runs each slot with its ticket, `marks` flags the live and the on-screen slots.
 * @throws MargoError `'unsupported'` when the text is not the one these edits were written for.
 */
export function routeShaders(simulation: string): { flags: string; update: string; marks: string } {
  const dies = /fn dies\(i:u32\)->u32 \{[^\n]*\n/.exec(simulation)?.[0],
    wide = /var<workgroup> scratch[^\n]*\nfn prefix[^\n]*\n/.exec(simulation)?.[0],
    testStart = simulation.indexOf(liveCount),
    testEnd = simulation.indexOf(updateEnd, testStart),
    kernels = simulation.indexOf('@compute @workgroup_size(256) fn main(');
  if (!dies || !wide || testStart < 0 || testEnd < 0 || kernels < testEnd) throw stale();
  const test = simulation.slice(testStart + liveCount.length, testEnd);
  let update = simulation.slice(0, testStart) + simulation.slice(testEnd, kernels);
  for (const [from, to] of [
    [dies, ''],
    [wide, ''],
    ['@group(0) @binding(2) var<storage,read_write> groups:array<u32>;\n', ''],
    ['@group(0) @binding(3) var<storage,read_write> alive:array<u32>;\n', ''],
    ['struct Indirect {vertexCount:u32,instanceCount:atomic<u32>,rest:array<u32,3>}\n', ''],
    ['@group(0) @binding(4) var<storage,read_write> indirect:Indirect;\n', ''],
    ['@group(0) @binding(5) var<storage,read> births:array<u32>;', '@group(0) @binding(5) var<storage,read> tickets:array<u32>;'],
    ['@group(0) @binding(9) var<storage,read_write> listed:array<u32>;\n', ''],
    ['@group(0) @binding(10) var<storage,read_write> total:array<u32,5>;\n', ''],
  ])
    update = once(update, from, to);
  return {
    flags: `${frame}${particlesRead}@group(0) @binding(2) var<storage,read_write> flags:array<u32>;
${dies}${entry}){if(id.x<f.control.x){flags[id.x]=dies(id.x);}}`,
    update: `${update}${entry}){if(id.x<f.control.x){let drawn=update(id.x,tickets[id.x]);}}`,
    // Keep the patched simulation declarations with its cull expression: optional features can read their own
    // uniforms or helpers there. The entry only calls onScreen; update and its other helpers stay unreachable.
    marks: `${update}@group(0) @binding(2) var<storage,read_write> living:array<u32>;
@group(0) @binding(3) var<storage,read_write> shown:array<u32>;
fn onScreen(p:Particle)->u32 {${test}  return 1u;
}
${entry}){
  if(id.x>=f.control.x){return;}
  let p=Particle(particles[id.x*2],particles[id.x*2+1],vec4f(0),vec4f(0));
  var isLive=0u;var isShown=0u;if(p.positionLife.w>0){isLive=1u;isShown=onScreen(p);}
  living[id.x]=isLive;shown[id.x]=isShown;
}`,
  };
}
/** Lists each on-screen slot at its place in slot order. */
export const compactShader = `@group(0) @binding(0) var<uniform> n:vec4u;
@group(0) @binding(1) var<storage,read> shown:array<u32>;
@group(0) @binding(2) var<storage,read> places:array<u32>;
@group(0) @binding(3) var<storage,read_write> alive:array<u32>;
${entry}){if(id.x<n.x&&shown[id.x]==1u){alive[places[id.x]]=id.x;}}`;
/** One invocation: the frame's totals, as the WebGPU route leaves them in the two argument buffers. */
export const totalsShader = (living: number, shown: number): string =>
  `@group(0) @binding(0) var<storage,read> living:array<u32>;
@group(0) @binding(1) var<storage,read> shown:array<u32>;
@group(0) @binding(2) var<storage,read_write> indirect:array<u32,5>;
@group(0) @binding(3) var<storage,read_write> visible:array<u32,5>;
@compute @workgroup_size(1) fn main(){indirect[1]=living[${living}];visible[1]=shown[${shown}];}`;
const billboardEntry =
  '@vertex fn vertex(@builtin(vertex_index) vertex:u32,@builtin(instance_index) instance:u32)->Out {';
/** Binding of `visible` in the route's billboard; free in the billboard and in every feature's patch. */
export const COUNT_BINDING = 13;
/** A billboard that draws nothing for the slots at or past the frame's count, so a draw of every slot stands for it. */
export const countedBillboard = (billboard: string): string =>
  once(
    billboard,
    billboardEntry,
    `@group(0) @binding(${COUNT_BINDING}) var<storage,read> drawn:array<u32,5>;
${billboardEntry}
  if(instance>=drawn[1]){var none:Out;none.clip=vec4f(2,2,2,1);return none;}`,
  );

/** The route's GPU state for one effect: its kernels and prefix counts. Every buffer it makes goes to `owned`. */
export class SimulationRoute {
  private readonly deaths: PrefixCount;
  private readonly living: PrefixCount;
  private readonly shown: PrefixCount;
  private readonly flagging: Kernel;
  private readonly updating: Kernel;
  private readonly marking: Kernel;
  private readonly compacting: Kernel;
  private readonly totals: Kernel;
  constructor(
    device: GPUDevice,
    simulation: string,
    capacity: number,
    b: { uniform: GPUBuffer; particles: GPUBuffer; alive: GPUBuffer; indirect: GPUBuffer; visible: GPUBuffer },
    more: GPUBindGroupEntry[],
    owned: { destroy(): void }[],
  ) {
    const code = routeShaders(simulation),
      groups = Math.ceil(capacity / 256),
      kernel = (text: string, entries: GPUBindGroupEntry[], count: number): Kernel => {
        const pipeline = device.createComputePipeline({
          layout: 'auto',
          compute: { module: device.createShaderModule({ code: text }), entryPoint: 'main' },
        });
        return [pipeline, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }), count];
      },
      bind = (binding: number, buffer: GPUBuffer): GPUBindGroupEntry => ({ binding, resource: { buffer } });
    this.deaths = new PrefixCount(device, capacity, owned);
    this.living = new PrefixCount(device, capacity, owned, { totalOnly: true });
    this.shown = new PrefixCount(device, capacity, owned);
    this.flagging = kernel(code.flags, [bind(0, b.uniform), bind(1, b.particles), bind(2, this.deaths.flags)], groups);
    this.updating = kernel(
      code.update,
      [bind(0, b.uniform), bind(1, b.particles), bind(5, this.deaths.prefix), ...more],
      groups,
    );
    this.marking = kernel(
      code.marks,
      [
        bind(0, b.uniform),
        bind(1, b.particles),
        bind(2, this.living.flags),
        bind(3, this.shown.flags),
        bind(5, this.deaths.prefix),
        ...more,
      ],
      groups,
    );
    const size = device.createBuffer({ size: 16, usage: 0x48 }); // UNIFORM | COPY_DST
    owned.push(size);
    device.queue.writeBuffer(size, 0, new Uint32Array([capacity, 0, 0, 0]));
    this.compacting = kernel(
      compactShader,
      [bind(0, size), bind(1, this.shown.flags), bind(2, this.shown.prefix), bind(3, b.alive)],
      groups,
    );
    this.totals = kernel(
      totalsShader(this.living.totalWord, this.shown.totalWord),
      [bind(0, this.living.total), bind(1, this.shown.total), bind(2, b.indirect), bind(3, b.visible)],
      1,
    );
  }
  /** Records one frame of the simulation; a frame without births needs no tickets, as on WebGPU. */
  encode(pass: GPUComputePassEncoder, births: boolean): void {
    const step = ([pipeline, group, count]: Kernel) => {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(count);
    };
    if (births) {
      step(this.flagging);
      this.deaths.encode(pass);
    }
    step(this.updating);
    step(this.marking);
    this.living.encode(pass);
    this.shown.encode(pass);
    step(this.compacting);
    step(this.totals);
  }
}
