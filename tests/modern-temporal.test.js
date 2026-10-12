import test from 'node:test';
import assert from 'node:assert/strict';
import {TAA,halton,jitterProjection} from '../packages/taa/dist/index.js';
import {Splats,parseSplat,validateSplats} from '../packages/splats/dist/index.js';
import {Camera,Engine,TransformStore} from '../packages/core/dist/extension.js';

test('Halton jitter moves projected samples by subpixels and preserves reversed depth',()=>{
  assert.deepEqual([1,2,3,4].map(i=>halton(i,2)),[0.5,0.25,0.75,0.125]);
  const camera=new Camera();camera.update(2,true);const matrix=camera.matrix.slice(),out=new Float32Array(16),point=[1,1,0,1];
  const project=m=>[0,1,2,3].map(r=>point.reduce((sum,v,c)=>sum+v*m[c*4+r],0));
  for(let frame=0;frame<16;frame++){jitterProjection(out,matrix,frame,200,100);const p=project(out),before=project(matrix);assert.ok(Math.abs((p[0]/p[3]-before[0]/before[3])*100)<0.51);assert.ok(Math.abs((p[1]/p[3]-before[1]/before[3])*50)<0.51);assert.equal(p[2],before[2]);assert.equal(p[3],before[3]);}
  assert.deepEqual(camera.matrix,matrix);assert.throws(()=>halton(-1,2),/Halton/);assert.throws(()=>halton(1,1),/Halton/);assert.throws(()=>jitterProjection(out,matrix,0,0,100),/projection/);
});

test('binary splats honor view bounds, quaternion rotation, sRGB and covariance validation',()=>{
  const backing=new Uint8Array(40),bytes=backing.subarray(4,36),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  for(const [i,v] of [1,2,3,2,1,0.5].entries())view.setFloat32(i*4,v,true);bytes.set([255,128,0,128,218,128,128,218],24);
  const data=parseSplat(bytes);assert.deepEqual([...data.positions],[1,2,3]);assert.equal(validateSplats(data),1);assert.ok(Math.abs(data.covariances[0]-1)<1e-6&&Math.abs(data.covariances[3]-4)<1e-6,'90-degree rotation did not rotate covariance');assert.equal(data.colors[0],1);assert.ok(Math.abs(data.colors[1]-0.21586)<0.00001);assert.ok(Math.abs(data.colors[3]-128/255)<1e-7);
  assert.throws(()=>parseSplat(bytes.subarray(1)),/length/);bytes.fill(128,28);assert.throws(()=>parseSplat(bytes),/quaternion/);
  for(const change of [d=>d.positions[0]=NaN,d=>d.covariances[0]=-1,d=>d.covariances[1]=100,d=>d.colors[3]=2,d=>d.sphericalHarmonics=new Float32Array(5)]){const bad=structuredClone(data);change(bad);assert.throws(()=>new Splats(bad));}
  const degrees=[4,9,16];for(const n of degrees){const sh=structuredClone(data);sh.sphericalHarmonics=new Float32Array(n*3);assert.equal(validateSplats(sh),1);}
});

test('new optional renderers validate options and refuse WebGL without leaving a plugin',async()=>{
  for(const options of [{historyWeight:1},{historyWeight:NaN},{depthThreshold:-1},{depth:1}])assert.throws(()=>new TAA(options),/options/);
  const store=await TransformStore.create(2),engine=new Engine({width:64,height:64,clientWidth:64,clientHeight:64},store,{backend:'webgl2',add(){},remove(){},render(){},dispose(){}});
  const data={positions:new Float32Array([0,0,0]),covariances:new Float32Array([1,0,0,1,0,1]),colors:new Float32Array([1,1,1,1])};
  try{assert.throws(()=>TAA.attach(engine),/WebGPU/);assert.equal(engine.hasPlugin('taa'),false);assert.throws(()=>Splats.attach(engine,data),/WebGPU/);assert.equal(engine.hasPlugin('splats:0'),false);}finally{engine.dispose();}
});
