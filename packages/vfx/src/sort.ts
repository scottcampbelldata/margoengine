import {frame} from './shader.js';
import {extra} from './extra.js';
import type {VFXFeatures} from './base.js';
declare const GPUBufferUsage:{UNIFORM:number;COPY_DST:number};
const shader=frame+extra+/* wgsl */`
@group(0) @binding(1) var<storage,read> particles:array<Particle>;
@group(0) @binding(3) var<storage,read_write> alive:array<u32>;
@group(0) @binding(4) var<storage,read> indirect:array<u32,5>;
@group(0) @binding(7) var<uniform> stage:vec4u;
fn key(id:u32)->f32 {if(id==0xffffffffu){return -1e30;}return dot(particles[id].positionLife.xyz-extra.eye.xyz,extra.forward.xyz);}
// Slots past the live count hold stale ids; mark them so they sort last.
@compute @workgroup_size(256) fn clear(@builtin(global_invocation_id) id:vec3u){if(id.x>=indirect[1]&&id.x<stage.z){alive[id.x]=0xffffffffu;}}
// One bitonic compare-exchange step, far particles first.
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id:vec3u){
  let a=id.x;let b=a^stage.x;if(b<=a||b>=stage.z){return;}let ia=alive[a];let ib=alive[b];let ka=key(ia);let kb=key(ib);let descending=(a&stage.y)==0;
  if((descending&&ka<kb)||(!descending&&ka>kb)){alive[a]=ib;alive[b]=ia;}
}`;
/** `sort` option: back-to-front draw order, a bitonic sort of the live list (padded to a power of two) each frame. */
export const sort:NonNullable<VFXFeatures['sort']>={create(d,particles,alive,indirect,extra,size,owned){
 const module=d.createShaderModule({code:shader}),entry=(binding:number,buffer:GPUBuffer)=>({binding,resource:{buffer}}),stages:{buffer:GPUBuffer;group:GPUBindGroup}[]=[];
 const clearer=d.createComputePipeline({layout:'auto',compute:{module,entryPoint:'clear'}}),sorter=d.createComputePipeline({layout:'auto',compute:{module,entryPoint:'main'}});
 for(let k=2;k<=Math.max(2,size);k*=2)for(let j=k/2;j>=1;j/=2){const stage=d.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});owned.push(stage);stages.push({buffer:stage,group:d.createBindGroup({layout:sorter.getBindGroupLayout(0),entries:[entry(1,particles),entry(3,alive),entry(6,extra),entry(7,stage)]})});d.queue.writeBuffer(stage,0,new Uint32Array([j,k,size,0]));}
 const clearGroup=d.createBindGroup({layout:clearer.getBindGroupLayout(0),entries:[entry(3,alive),entry(4,indirect),entry(7,stages[0].buffer)]}),groups=Math.ceil(alive.size/1024);
 return {run(pass){pass.setPipeline(clearer);pass.setBindGroup(0,clearGroup);pass.dispatchWorkgroups(groups);pass.setPipeline(sorter);for(const stage of stages){pass.setBindGroup(0,stage.group);pass.dispatchWorkgroups(groups);}}};
}};
