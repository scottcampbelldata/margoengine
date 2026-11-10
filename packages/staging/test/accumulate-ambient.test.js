import test from 'node:test';
import assert from 'node:assert/strict';
import { AmbientShadows } from '../dist/accumulate-ambient.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

test('cosine sky directions have the correct projected distribution and finite horizon projections',()=>{
 const shadow=new AmbientShadows({ambient:1,lights:[]}),s=shadow.settings();let mean=0;
 for(let i=0;i<1024;i++){
  shadow.count=i;const m=shadow.projection(s),h=m[15];
  assert(h>0);assert(m.every(Number.isFinite));assert.equal(m[7],0,'sky uses parallel rays');
  const x=-m[4]*s.width/(2*h),z=-m[5]*s.depth/(2*h);
  mean+=1/(1+x*x+z*z);
 }
 assert(Math.abs(mean/1024-.5)<.003,'mean squared sky cosine is 1/2');shadow.dispose();
});

test('multi-light weights, copy ownership, live history reset and convergence share one receiver',()=>{
 const h=optionalGPU(),lights=[{position:[-4,8,0],radius:0,intensity:1},{position:[4,8,0],radius:0,intensity:3}];
 const shadow=AmbientShadows.attach(h.engine,{lights,ambient:0,frames:4,resolution:16});
 lights[0].position[0]=100;
 assert.equal(shadow.options.lights[0].position[0],-4);
 const s=shadow.settings();let left=0,right=0;
 for(let i=0;i<1024;i++){shadow.count=i;const m=shadow.projection(s);if(m[4]>0)left++;else right++;}
 assert.equal(left,256);assert.equal(right,768);
 shadow.invalidate();h.context.camera.position=[0,5,4];
 try{
  for(let i=0;i<4;i++)h.engine.frameGraph.execute(h.context);
  assert.equal(shadow.samples,4);h.engine.frameGraph.execute(h.context);assert.equal(shadow.samples,4);
  shadow.options.lights[0].intensity=2;h.engine.frameGraph.execute(h.context);assert.equal(shadow.samples,1);
  shadow.options.ambient=.8;h.engine.frameGraph.execute(h.context);assert.equal(shadow.samples,1);
  shadow.onDeviceRestored(h.engine);h.engine.frameGraph.execute(h.context);assert.equal(shadow.samples,1);
 }finally{shadow.dispose();shadow.dispose();}
 assert(h.resources.every(r=>r.destroyed));
});

test('invalid distributions, sparse data and live edits reject without allocating',()=>{
 for(const o of [null,[],{ambient:-.1},{ambient:NaN},{ambient:1.1},{lights:[]},{lights:null},{lights:[,]},
  {lights:[{position:[0,1,0]}]},{lights:[{position:[0,8,0],radius:-1}]},{lights:[{position:[0,8,0],intensity:0}]},
  {lights:[{position:[0,8,NaN]}]},{lights:Array.from({length:65},()=>({position:[0,8,0]}))}])
   assert.throws(()=>new AmbientShadows(o),RangeError);
 const shadow=new AmbientShadows({ambient:1,lights:[],up:[0,0,1]});
 assert(shadow.projection(shadow.settings()).every(Number.isFinite));shadow.dispose();
});
