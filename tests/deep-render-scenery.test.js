import test from 'node:test';
import assert from 'node:assert/strict';
import {SkyMoon} from '../packages/scenery/dist/index.js';
import {optionalGPU} from './support/optional-gpu.js';

test('SkyMoon follows depth/sample changes, reuses warmed pipelines and retries a failed variant',()=>{
 const h=optionalGPU(),d=h.engine.gpu;globalThis.GPUShaderStage={VERTEX:1,FRAGMENT:2};d.createBindGroupLayout=x=>x;d.createPipelineLayout=x=>x;
 const navigatorDescriptor=Object.getOwnPropertyDescriptor(globalThis,'navigator');Object.defineProperty(globalThis,'navigator',{configurable:true,value:{gpu:{getPreferredCanvasFormat:()=>h.context.format}}});
 let bound,ended=0;const begin=h.context.encoder.beginRenderPass;
 h.context.encoder.beginRenderPass=descriptor=>({...begin(descriptor),end(){ended++;},setPipeline(pipeline){bound=pipeline;assert.equal(pipeline.depthStencil.format,h.context.descriptor.depthStencil.format);assert.equal(pipeline.multisample?.count??1,h.context.descriptor.multisample?.count??1);}});
 const sky=new SkyMoon({moonPhase:0.7});
 try{
  h.engine.use(sky);h.frame();const desktop=bound,initial={...h.counts},pipelines=h.pipelines.length;
  for(let i=0;i<120;i++)h.frame();assert.equal(h.pipelines.length,pipelines);for(const key of ['buffers','textures','groups','views'])assert.equal(h.counts[key],initial[key]);
  h.context.descriptor={...h.context.descriptor,depthStencil:{format:'depth24plus'}};h.frame();const changed=bound;assert.notEqual(changed,desktop);
  h.context.descriptor={...h.context.descriptor,multisample:{count:1}};h.frame();const single=bound;assert.notEqual(single,changed);
  const create=d.createRenderPipeline,failure=new Error('Sky variant failed'),previousEnds=ended;h.context.descriptor={...h.context.descriptor,depthStencil:{format:'depth24plus-stencil8'}};d.createRenderPipeline=()=>{throw failure;};assert.throws(h.frame,error=>error===failure);d.createRenderPipeline=create;assert.equal(ended,previousEnds+1,'Failed variant must close the open pass');
  h.frame();assert.equal(bound.depthStencil.format,'depth24plus-stencil8');
  h.context.descriptor={...h.context.descriptor,depthStencil:{format:'depth24plus'}};h.frame();assert.equal(bound,single);
  h.context.descriptor={...h.context.descriptor,depthStencil:{format:'depth32float'},multisample:{count:4}};h.frame();assert.equal(bound,desktop);
  const warmed=h.pipelines.length;for(let i=0;i<120;i++)h.frame();assert.equal(h.pipelines.length,warmed);assert.equal(h.counts.buffers,initial.buffers);assert.equal(h.counts.groups,initial.groups);
  sky.onDeviceRestored(h.engine);h.frame();assert.notEqual(bound,desktop);
 }finally{sky.dispose();if(navigatorDescriptor)Object.defineProperty(globalThis,'navigator',navigatorDescriptor);else delete globalThis.navigator;assert.ok(h.resources.every(r=>r.destroyed));}
});
