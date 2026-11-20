import test from 'node:test';
import assert from 'node:assert/strict';
import {Backdrop,backdropGeometry,stagingLights,stagingLighting} from '../dist/backdrop.js';
test('cyclorama has a tangent circular bend, unit analytic normals and front-facing triangles',()=>{
 const g=backdropGeometry(),v=g.vertices;
 assert.equal(v.length/6,70);assert.equal(g.indices.length,204);
 for(let i=0;i<v.length;i+=6)assert(Math.abs(Math.hypot(v[i+3],v[i+4],v[i+5])-1)<1e-6);
 for(let row=1;row<=33;row++){
  const i=row*12,y=v[i+1],z=v[i+2];assert(Math.abs((y-1)**2+(z+1.5)**2-1)<1e-6);
 }
 assert.deepEqual([...v.subarray(3,6)],[0,1,0]);assert.deepEqual([...v.subarray(v.length-3)],[0,0,1]);
 for(let i=0;i<g.indices.length;i+=3){
  const [a,b,c]=[0,1,2].map(k=>g.indices[i+k]*6),u=[0,1,2].map(k=>v[b+k]-v[a+k]),w=[0,1,2].map(k=>v[c+k]-v[a+k]);
  const cross=[u[1]*w[2]-u[2]*w[1],u[2]*w[0]-u[0]*w[2],u[0]*w[1]-u[1]*w[0]];
  assert(cross.reduce((s,x,k)=>s+x*v[a+3+k],0)>0);
 }
 const finest=backdropGeometry({segments:256});assert.equal(finest.indices.length,(256+2)*6);
 assert.throws(()=>backdropGeometry({radius:Number.MIN_VALUE}),error=>error instanceof RangeError&&/float32/.test(error.message),'a positive underflowing bend must not produce zero-area strips');
 for(const options of [null,[],{width:0},{radius:0},{radius:4},{radius:NaN},{height:Infinity},{segments:1},{segments:257},{depth:-1}])
  assert.throws(()=>backdropGeometry(options));
});
test('each named rig owns fresh lights and has distinct key/fill/softness; cancelled lighting never attaches',async()=>{
 const names=['portrait','rembrandt','upfront','soft'],keys=new Set();
 for(const name of names){const lights=stagingLights(name);assert.equal(lights.length,3);keys.add(JSON.stringify(lights));lights[0].direction[0]=100;assert.notEqual(stagingLights(name)[0].direction[0],100);}
 assert.equal(keys.size,4);assert(stagingLights('rembrandt')[0].intensity/stagingLights('rembrandt')[1].intensity>8);
 assert.equal(stagingLights('upfront')[0].direction[0],0);assert(stagingLights('soft')[0].width>stagingLights('portrait')[0].width);
 assert.throws(()=>stagingLights('__proto__'),RangeError);
 await assert.rejects(stagingLighting({},'portrait',{signal:AbortSignal.abort()}),{name:'AbortError'});
});
test('backdrop is an ordinary owned mesh and using cleanup is idempotent',()=>{
 const mesh={setGeometry(g){this.geometry=g;return this;},setMaterial(m){this.material=m;return this;},dispose(){this.disposed=(this.disposed??0)+1;}};
 const value=Backdrop.attach({createMesh:()=>mesh});assert.equal(value.mesh,mesh);assert.equal(mesh.geometry.indices.length,204);value.dispose();value[Symbol.dispose]();assert.equal(mesh.disposed,1);
});
