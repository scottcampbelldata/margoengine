import test from 'node:test';
import assert from 'node:assert/strict';
import {DOF} from '../dist/index.js';
import {gpuHarness} from '../../../tests/support/postfx-gpu.js';

test('DOF validates the thin lens at float32 precision and rejects WebGL',()=>{
  for(const options of [{focalDistance:0},{focalLength:0},{focalLength:1e-50},{aperture:0},{aperture:1e-50},{focalLength:5,focalDistance:5},{focalDistance:Infinity},{maxRadius:33},{maxRadius:0},{enabled:1}])assert.throws(()=>new DOF(options),/options/);
  assert.throws(()=>new DOF().setup({gpu:null}),/WebGPU/);
});

test('DOF runs two compute passes, restores attachments, and reuses all steady-state resources',()=>{
  const h=gpuHarness(),dof=DOF.attach(h.engine,{focalDistance:5,focalLength:0.05,aperture:2});h.frame();
  assert.equal(h.counts.compute,2);assert.equal(h.counts.render,4);assert.equal(h.context.color,h.originalColor);assert.equal(h.context.depth,h.originalDepth);assert.equal(h.context.format,'bgra8unorm');
  assert.equal(dof.outputTexture.format,'rgba16float');assert.equal(dof.depthTexture.format,'depth32float');
  const scale=0.05*96/(4*2*(5-0.05)*Math.tan(Math.PI/6));assert.ok(Math.abs(h.writes[6]-scale)<1e-6);
  assert.ok(scale*(1-5/3)<0);assert.equal(scale*(1-5/5),0);assert.ok(scale*(1-5/10)>0);
  const before={...h.counts},descriptor=h.context.presentation,output=dof.outputTexture,depth=dof.depthTexture;
  const F32=globalThis.Float32Array,U32=globalThis.Uint32Array;let allocations=0;
  globalThis.Float32Array=new Proxy(F32,{construct(target,args){allocations++;return Reflect.construct(target,args);}});
  globalThis.Uint32Array=new Proxy(U32,{construct(target,args){allocations++;return Reflect.construct(target,args);}});
  try{for(let i=0;i<120;i++)h.frame();}finally{globalThis.Float32Array=F32;globalThis.Uint32Array=U32;}
  assert.equal(allocations,0);for(const key of ['buffers','textures','views','groups'])assert.equal(h.counts[key],before[key]);
  assert.equal(h.context.presentation,descriptor);assert.equal(dof.outputTexture,output);
  dof.enabled=false;h.frame();assert.equal(h.writes[7],0);
  h.context.width=256;h.frame();assert.ok(output.destroyed&&depth.destroyed);assert.equal(dof.outputTexture.width,256);
  const resized=dof.outputTexture;dof.onDeviceRestored(h.engine);assert.ok(resized.destroyed);h.frame();
  dof.destroy();dof.destroy();assert.equal(h.engine.hasPlugin('dof'),false);assert.ok(h.resources.every(r=>r.destroyed));
  assert.equal(dof.outputTexture,undefined);const dispatches=h.counts.compute;h.frame();assert.equal(h.counts.compute,dispatches);
});

test('DOF rejects conflicting capture and validates edited controls before rendering',()=>{
  const h=gpuHarness();h.engine.use({name:'ssao',setup(){},registerPasses(){},dispose(){}});
  assert.throws(()=>DOF.attach(h.engine),/capture/);assert.equal(h.engine.hasPlugin('dof'),false);
  h.engine.removePlugin('ssao');const dof=DOF.attach(h.engine);dof.options.aperture=-1;assert.throws(h.frame,/options/);dof.destroy();
});
