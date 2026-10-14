import test from 'node:test';
import assert from 'node:assert/strict';
import {SkyMoon} from '../packages/scenery/dist/index.js';
import {Sky} from '../packages/sky/dist/base.js';
import {optionalGPU} from './support/optional-gpu.js';

test('SkyMoon is a midnight Sky (base entry, stylized night only) whose config is read every frame',()=>{
 const h=optionalGPU();globalThis.GPUTextureUsage??={STORAGE_BINDING:8,TEXTURE_BINDING:4};
 const sky=new SkyMoon({moonPhase:0.7,moonDirection:[0,2,0],moonSize:0.05});
 assert.ok(sky instanceof Sky);assert.equal(sky.name,'sky-moon');
 try{
  h.engine.use(sky);h.frame();
  const values=()=>new Float32Array(h.resources.find(r=>!r.destroyed&&r.size===256).data);let v=values();
  assert.equal(sky.nightFactor,1,'held at night');assert.equal(v[60],1,'stylized night enabled');
  assert.deepEqual([v[48],v[49],v[50]],[0,1,0],'moon direction normalized');assert.ok(Math.abs(v[51]-Math.cos(0.05))<1e-6&&Math.abs(v[55]-Math.sin(0.05))<1e-6);
  assert.ok(Math.abs(v[56]-0.7)<1e-6);const clock=v[59];assert.ok(clock>0,'twinkle clock follows frame time');
  sky.config.moonPhase=-3;h.frame();v=values();assert.equal(v[56],-1,'phase clamps');assert.ok(v[59]>clock);assert.equal(sky.options.hours,0);
  sky.config.moonSize=2;assert.throws(()=>sky.onPreUpdate(0),/Moon size/);sky.config.moonSize=0.05;
  sky.onDeviceRestored(h.engine);h.frame();
 }finally{sky.dispose();assert.ok(h.resources.every(r=>r.destroyed));}
});
