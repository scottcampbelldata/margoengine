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

// RandomizedLight's bias, near and far bound the casting slab; size and mapSize set the sample's shadow camera window.
test('a light bias, near and far move the clip planes; size and mapSize give its window',()=>{
 const light={position:[0,10,0],radius:0},shadow=new AmbientShadows({ambient:0,lights:[light],height:5}),s=shadow.settings();
 const depth=(y)=>{const m=shadow.projection(s),p=[0,y,0,1],c=[2,3].map(r=>p.reduce((sum,v,k)=>sum+v*m[k*4+r],0));return c[0]/c[1];};
 assert(Math.abs(depth(0))<1e-6&&Math.abs(depth(5)-1)<1e-6,'slab 0..5 by default');
 assert.equal(shadow.window,undefined);
 light.bias=0.5;Object.assign(shadow.options.lights[0],{bias:0.5});
 assert(Math.abs(depth(-0.5))<1e-6,'a positive bias lets casters 0.5 below the plane cast');
 Object.assign(shadow.options.lights[0],{bias:0,near:7,far:9});
 assert(Math.abs(depth(1))<1e-6&&Math.abs(depth(3)-1)<1e-6,'far 9 and near 7 from the light at 10 keep heights 1..3');
 Object.assign(shadow.options.lights[0],{bias:-1,near:9.5,far:Infinity,size:4,mapSize:8});
 const m=shadow.projection(s);assert(m.every(Number.isFinite));
 const p=[0,0.25,0,1],c=[2,3].map(r=>p.reduce((sum,v,k)=>sum+v*m[k*4+r],0));assert(c[0]/c[1]<0,'nothing between the planes casts');
 const w=shadow.window;assert.equal(w.size,4);assert.equal(w.map,8);
 const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
 for(const [a,b] of [[w.e1,w.e2],[w.e1,w.light],[w.e2,w.light]])assert(Math.abs(dot(a,b))<1e-9);
 assert(Math.abs(dot(w.e1,w.e1)-1)<1e-9&&Math.abs(dot(w.e2,w.e2)-1)<1e-9);
 for(const bad of [{size:0},{mapSize:8},{size:2,mapSize:0.5},{near:-1},{near:3,far:2},{bias:NaN}])
  assert.throws(()=>new AmbientShadows({ambient:0,lights:[{position:[0,10,0],...bad}]}),RangeError);
 shadow.dispose();
});

// A disk wider than its near plane's distance from the casters: every sample keeps the same slab. The near plane was
// taken from each disk point, so points nearer the plane than the near distance clipped every caster (React's
// AccumulativeShadows, whose lights stand 1000 times out, lost half its samples).
test('near and far stand at the light centre distance for every disk sample',()=>{
 const shadow=new AmbientShadows({ambient:0,lights:[{position:[700,700,0],radius:300,near:Math.hypot(700,700)-3}],height:5}),s=shadow.settings();
 for(let i=0;i<64;i++){
  shadow.count=i;const m=shadow.projection(s),p=[0,1,0,1],c=[2,3].map(r=>p.reduce((sum,v,k)=>sum+v*m[k*4+r],0)),z=c[0]/c[1];
  assert(z>0&&z<1,`sample ${i}: a caster 1 above the centre casts (depth ${z})`);
 }
 shadow.dispose();
});
