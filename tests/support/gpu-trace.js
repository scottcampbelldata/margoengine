// Records everything a plugin asks of the mock GPU (resources, WGSL, pipelines, bind groups, uploads and encoded
// commands), so two builds can be compared for identical GPU work. Objects are named by content plus their index
// among same-content objects, so the order in which different kinds of objects are created does not matter.
import {createHash} from 'node:crypto';
import {optionalGPU} from './optional-gpu.js';
export const sha=data=>createHash('sha256').update(data).digest('hex').slice(0,16);
const bytes=v=>new Uint8Array(v.buffer??v,v.byteOffset??0,v.byteLength);
export function tracedGPU(){
 const h=optionalGPU(),d=h.engine.gpu,c=h.context,created=[],commands=[],shaders=new Map(),names=new Map(),counts=new Map();
 // `full` names pipelines by WGSL hash; `short` by entry point only, for builds whose WGSL is expected to differ.
 const name=(o,full,short=full)=>{const n=k=>{const i=counts.get(k)??0;counts.set(k,i+1);return k+'#'+i;};names.set(o,{full:n(full),short:n('~'+short).slice(1)});return o;};
 const of=(o,key='full')=>names.get(o)?.[key]??'?';
 const wrap=(target,method,describe)=>{const original=target[method];target[method]=function(x){const result=original.call(this,x),[full,short]=describe(x,result);name(result,full,short);created.push(full);return result;};};
 wrap(d,'createBuffer',x=>[`buffer(${x.size},${x.usage})`]);
 wrap(d,'createTexture',x=>[`texture(${x.size},${x.format},${x.sampleCount??1},${x.usage})`]);
 const stage=s=>s&&`${sha(s.module.code)}:${s.entryPoint}`;
 const shader=d.createShaderModule;d.createShaderModule=x=>{shaders.set(sha(x.code),x.code);return shader.call(d,x);};
 wrap(d,'createComputePipeline',x=>[`compute(${stage(x.compute)})`,`compute(${x.compute.entryPoint}:${sha(x.compute.module.code.slice(x.compute.module.code.lastIndexOf('@compute')))})`]);
 wrap(d,'createRenderPipeline',x=>{const state=JSON.stringify([x.fragment.targets,x.multisample,x.depthStencil]);return [`render(${stage(x.vertex)},${stage(x.fragment)},${state})`,`render(${x.fragment.entryPoint},${state})`];});
 const entries=(x,key)=>x.entries.map(e=>e.binding+'='+of(e.resource.buffer??e.resource.texture??e.resource,key)).join(',');
 wrap(d,'createBindGroup',x=>[`group(${entries(x)})`,`group(${entries(x,'short')})`]);
 const write=d.queue.writeBuffer;d.queue.writeBuffer=(b,offset,v)=>{commands.push(['write',b,offset,sha(bytes(v))]);write(b,offset,v);};
 d.queue.writeTexture=(t,data)=>commands.push(['writeTexture',t.texture,sha(bytes(data))]);
 const pass={setPipeline:p=>commands.push(['setPipeline',p]),setBindGroup:(i,g)=>commands.push(['setBindGroup',i,g]),setIndexBuffer:b=>commands.push(['setIndexBuffer',b]),
  dispatchWorkgroups:(...a)=>commands.push(['dispatch',...a]),draw:(...a)=>commands.push(['draw',...a]),drawIndexedIndirect:(b,o)=>commands.push(['drawIndexedIndirect',b,o]),drawIndirect:(b,o)=>commands.push(['drawIndirect',b,o]),end:()=>commands.push(['end'])};
 c.encoder.beginComputePass=()=>{commands.push(['computePass']);return pass;};
 c.encoder.beginRenderPass=x=>{commands.push(['renderPass',x.colorAttachments.map(a=>a.loadOp).join(),!!x.depthStencilAttachment]);return pass;};
 c.encoder.clearBuffer=(b,o,s)=>commands.push(['clearBuffer',b,o,s]);
 const list=(key='full')=>commands.map(command=>command.map(v=>v&&typeof v==='object'?of(v,key):v).join(' '));
 return {...h,shaders,created,
  /** Uploads and encoded commands, in order. `short` names pipelines by entry point rather than WGSL. */
  commands:list,
  /** One hash over every created object (any order) and every command (in order). */
  digest:()=>sha([...created].sort().join('\n')+'\n--\n'+list().join('\n'))};
}
