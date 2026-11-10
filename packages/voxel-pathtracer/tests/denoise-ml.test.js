import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {DenoiseML} from '../dist/denoise-ml.js';
import {DENOISE_ML} from '../src/denoise-ml-shader.ts';
import {WEIGHTS} from '../src/denoise-ml-weights.ts';
import {checkWGSL} from '@margoengine/webgl2-compat/wgsl';
import {runComputeOnCPU,planCompute} from '@margoengine/webgl2-compat/compute';
import {fakeEngine,fakeDevice} from './support.js';
const report=JSON.parse(readFileSync(new URL('./fixtures/denoise-ml-training.json',import.meta.url)));
function image(width=9,height=3){const count=width*height,color=new Float32Array(count*3),albedo=new Float32Array(count*3).fill(.5),normal=new Float32Array(count*3);for(let i=0;i<count;i++){color.set([4,2,1],i*3);normal[i*3+2]=1;}return {width,height,color,albedo,normal,alpha:new Float32Array(count).fill(.25),samples:4};}
function harness(){
 const device=fakeDevice(),h=fakeEngine(device);device.limits.maxComputeWorkgroupsPerDimension=65535;
 device.createComputePipelineAsync=async d=>({...d,getBindGroupLayout:()=>({entries:[]})});
 device.createCommandEncoder=()=>{
  const commands=[];let pipeline,group;
  return {beginComputePass:()=>({setPipeline:p=>{pipeline=p;},setBindGroup:(_,g)=>{group=g;},dispatchWorkgroups:(x,y)=>{commands.push(()=>runComputeOnCPU({source:pipeline.compute.module.code,entryPoint:pipeline.compute.entryPoint,workgroups:[x,y],workBudget:10_000_000,buffers:new Map(group.entries.map(e=>[`0:${e.binding}`,new Uint8Array(e.resource.buffer.data)]))}));},end(){}}),copyBufferToBuffer:(from,at,to,offset,n)=>commands.push(()=>new Uint8Array(to.data,offset,n).set(new Uint8Array(from.data,at,n))),finish:()=>({commands})};
 };
 device.queue.submit=items=>{device.submits++;for(const item of items)for(const command of item.commands)command();};return h;
}
test('trained model has complete reproducible weights, independent validation seeds and a GPU compute plan',()=>{
 const weights=new Float32Array(WEIGHTS);assert.equal(weights.length,321);assert.ok(weights.every(Number.isFinite));assert.equal(createHash('sha256').update(new Uint8Array(weights.buffer)).digest('hex'),report.weightSHA256);
 assert.notEqual(report.trainingSeed,report.validationSeed);assert.equal(report.validationPatches,4000);assert.ok(report.after.networkMSE<report.after.rawMSE);
 checkWGSL(DENOISE_ML);const plan=planCompute({source:DENOISE_ML,entryPoint:'denoiseML'});assert.equal(plan.tier,'scatter');assert.equal(plan.targets[0].stores,3);
});
test('owned constant HDR, guides, alpha and partial workgroups survive public compute reconstruction',async()=>{
 const h=harness(),d=await DenoiseML.create(h.engine),input=image(),before=structuredClone(input);
 try{const output=await d.denoise(input);for(let i=0;i<output.color.length;i++)assert.ok(Math.abs(output.color[i]-before.color[i])<1e-5);assert.deepEqual(output.alpha,before.alpha);assert.deepEqual(output.normal,before.normal);assert.deepEqual(input,before);assert.notEqual(output.color,input.color);assert.notEqual(output.albedo,input.albedo);}finally{d.dispose();}
 assert.ok(h.device.buffers.every(b=>b.destroyed));
});
test('independent noisy diffuse plane improves and very bright black-boundary neighbors stay finite',async()=>{
 const h=harness(),d=await DenoiseML.create(h.engine),input=image(12,12);let state=243099;const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/2**32;};for(let i=0;i<input.color.length;i++)input.color[i]=.5+random();
 try{
  const output=await d.denoise(input),mse=a=>a.reduce((sum,v)=>sum+(v-1)**2,0)/a.length;assert.ok(mse(output.color)<mse(input.color));assert.deepEqual(output.alpha,input.alpha);
  const hdr=image(2,1);hdr.color.set([0,0,0,1e16,1e16,1e16]);const bright=await d.denoise(hdr);assert.ok(bright.color.every(v=>Number.isFinite(v)&&v>=0&&v<=1e16*1.000001));
 }finally{d.dispose();}
});
test('bad guide dimensions, values and device limits refuse before reconstruction allocations',async()=>{
 const h=harness(),d=await DenoiseML.create(h.engine);try{
  for(const mutate of [s=>{s.albedo=undefined;},s=>{s.normal[0]=NaN;},s=>{s.alpha[0]=2;},s=>{s.color[0]=-1;},s=>{s.width=1.5;}]){const s=image();mutate(s);await assert.rejects(d.denoise(s));}
  h.device.limits.maxComputeWorkgroupsPerDimension=0;await assert.rejects(d.denoise(image()),e=>e.code==='unsupported');assert.equal(h.device.buffers.length,1);
 }finally{d.dispose();}
});
test('queued cancellation rejects promptly, snapshots input, and disposal settles active readback',async()=>{
 const h=harness(),d=await DenoiseML.create(h.engine);let release;h.device.mapGate=new Promise(resolve=>{release=resolve;});const first=d.denoise(image());
 // The first request submits synchronously after readiness microtasks; keep its map pending.
 for(let i=0;i<12;i++)await Promise.resolve();
 const c=new AbortController(),second=d.denoise(image(),{signal:c.signal});c.abort(new Error('cancel queued reconstruction'));await assert.rejects(second,/cancel queued/);
 const active=assert.rejects(first,e=>e.code==='disposed');d.dispose();await active;await d.whenIdle();release();
 await Promise.resolve();await assert.rejects(d.denoise(image()),e=>e.code==='disposed');assert.ok(h.device.buffers.every(b=>b.destroyed));
});
test('a changed device rebuilds weights and its pipeline and keeps output independent',async()=>{
 const h=harness(),d=await DenoiseML.create(h.engine),old=h.device;await d.denoise(image());
 const fresh=harness();h.engine.gpu=fresh.device;
 try{const output=await d.denoise(image());assert.ok(output.color.every(Number.isFinite));assert.ok(old.buffers.every(b=>b.destroyed));assert.ok(fresh.device.buffers.some(b=>!b.destroyed));}finally{d[Symbol.dispose]();}
 assert.ok(fresh.device.buffers.every(b=>b.destroyed));
});

test('pipeline and readback errors retain their cause under a coded failure, and invalid options allocate nothing',async()=>{
 const h=harness();for(const options of [null,false,[]])await assert.rejects(DenoiseML.create(h.engine,options),TypeError);assert.equal(h.device.buffers.length,0);
 const compilation=new Error('pipeline rejected');h.device.createComputePipelineAsync=async()=>{throw compilation;};await assert.rejects(DenoiseML.create(h.engine),error=>error.code==='failed'&&error.cause===compilation);
 const fresh=harness(),d=await DenoiseML.create(fresh.engine),readback=new Error('map rejected');fresh.device.mapGate=Promise.reject(readback);
 try{await assert.rejects(d.denoise(image()),error=>error.code==='failed'&&error.cause===readback);}finally{d.dispose();}assert.ok(fresh.device.buffers.every(b=>b.destroyed));
});
