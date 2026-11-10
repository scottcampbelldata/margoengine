import test from 'node:test';
import assert from 'node:assert/strict';
import {MeshPathTracer,parseTraceIES} from '../dist/mesh.js';
import {ComposedVoxelPathTracer} from '../dist/compose.js';
import {meshPBR} from '../dist/mesh-pbr.js';
import {fakeEngine,simpleScene} from './support.js';
import {checkWGSL} from '@margoengine/webgl2-compat/wgsl';
import {runComputeOnCPU} from '@margoengine/webgl2-compat/compute';
const transform=(x,y,z)=>[x,0,0,0,0,y,0,0,0,0,z,0,0,0,0,1];
function scene(){return {...simpleScene(),models:[],instances:[],materials:[{id:1,type:'emit',color:[2,1,.5]}],
 meshes:[{id:'tri',material:1,positions:new Float32Array([0,0,0,1,0,0,0,1,0]),indices:new Uint32Array([0,1,2])}]};}
async function prepare(s,pbr=false){
 const h=fakeEngine(),codes=[],make=h.device.createShaderModule.bind(h.device);h.device.createShaderModule=d=>{codes.push(d.code);return make(d);};
 const t=pbr?await ComposedVoxelPathTracer.create(h.engine,{scene:s,features:[meshPBR()],denoise:false}):await MeshPathTracer.create(h.engine,{scene:s,denoise:false});
 await t.ready;h.frame();
 const packed=h.device.buffers.map(b=>new Uint32Array(b.data)).find(w=>w[2]>0&&w[w[2]+9]===0x4d494e53);
 return {h,t,codes,packed,words:packed?.slice(packed[2])};
}
function probe(ctx,body){
 const source=ctx.codes.find(s=>s.includes('fn meshLights()'));checkWGSL(source);
 const out=new Float32Array(32);
 runComputeOnCPU({source:source+`\n@group(3) @binding(0) var<storage,read_write> probe:array<vec4f>;
 @compute @workgroup_size(1) fn lights_probe(){${body}}`,entryPoint:'lights_probe',workgroups:[1],workBudget:1_000_000,
 buffers:new Map([['0:3',ctx.packed],['0:1',new Float32Array(8192)],['0:4',new Float32Array(4)],['3:0',out]])});return out;
}
const header='1 100 2 3 2 1 2 0 0 0 1 1 10\n0 45 90\n0 180\n1 2 3 4 5 6\n';
test('emissive geometry at the inclusive world limit keeps conservative acceleration bounds',async()=>{
 const s=scene();s.meshes[0].positions=new Float32Array([-1e8,-1e8,0,1e8,-1e8,0,0,1e8,0]);
 const c=await prepare(s);
 try{
  assert.equal(c.t.stats.meshTriangles,1);
  const w=c.words,f=new Float32Array(w.buffer),header=w[12],record=w[header+1];
  assert.equal(w[header],1);assert.equal(f[record+7],Math.fround(2e16));
  assert.ok(f[16]<-1e8&&f[20]>1e8,'published acceleration bounds retain their outward padding');
 }finally{c.t.dispose();}
});
test('runtime-bounded proposal schedule retains all legacy, emitter, spot and PBR families',async()=>{
 for(const mode of ['legacy','emitter','spot','pbr']){
  const s=scene();s.meshInstances=[{id:'instance',mesh:'tri'}];
  if(mode!=='emitter'){s.materials[0].type='diffuse';s.materials[0].color=[.5,.5,.5];}
  if(mode==='spot')s.spotLights=[{position:[0,0,2],direction:[0,0,-1]}];
  if(mode==='pbr')s.pbrMaterials=[{id:1,metallicFactor:0}];
  const c=await prepare(s,mode==='pbr');
  try{
   const expected=mode==='legacy'?5:7;
   const out=probe(c,'probe[0]=vec4f(f32(meshProposalCount()),0,0,0);');
   assert.equal(out[0],expected,mode);
   if(expected===7)assert.equal(c.words[c.words[12]+4],7,`${mode} packet carries all seven proposals`);
  }finally{c.t.dispose();}
 }
});
test('LM-63 uses declared counts, multiplier, plane order and owned tilt tables',()=>{
 const plain=parseTraceIES('IESNA:LM-63-2002\nTILT=NONE\n'+header);
 assert.deepEqual([...plain.candela],[2,4,6,8,10,12]);
 const tilt='1 3\n0 45 90\n1 .9 .8\n';
 assert.deepEqual(parseTraceIES('TILT=INCLUDE\n'+tilt+header),parseTraceIES('TILT=lamp.tlt\n'+header,{tilt}));
 for(const body of [header.slice(0,-4),header.replace('0 45 90','0 45 45'),header.replace('1 100 2 3 2','1 100 2 3 0'),header+'7'])assert.throws(()=>parseTraceIES('TILT=NONE\n'+body));
 assert.throws(()=>parseTraceIES('TILT=NONE\n'+header.replace('3 2 1 2','3 2 2 2')),{code:'unsupported'});
});
test('world-area emitter CDF follows nonuniform reflected instances and exact reciprocal path PDFs',async()=>{
 const s=scene();s.meshInstances=[{id:'small',mesh:'tri'},{id:'large',mesh:'tri',transform:transform(-2,3,1)}];
 const c=await prepare(s);
 try{
  const w=c.words,f=new Float32Array(w.buffer),h=w[12],records=w[h+1];assert.equal(w[h],2);
  assert.equal(f[records+7],.5);assert.equal(f[records+24+7],3);assert.equal(f[records+14],1);assert.equal(f[records+24+14],1);
  assert.ok(Math.abs(f[records+3]-1/7)<1e-7);assert.equal(f[records+24+3],1);
  assert.equal(f[records+20],f[records+3]);assert.equal(f[records+24+20],Math.fround(1-f[records+3]));
  const out=probe(c,`let l=meshLights();let r=scene[2]+scene[l+1u];var h:Hit;h.inst=TRIANGLE;h.mesh=scene[2]+scene[r+18u];h.meshHead=scene[2]+scene[r+17u];h.tri=scene[2]+scene[r+16u];h.t=2.0;
   probe[0]=vec4f(meshEmitterWeight(h,vec3f(0,0,-1),.25),fl(r+20u)/fl(r+7u),0,0);`);
  const lp=f[records+20]/.5*4;assert.ok(Math.abs(out[0]-(.25**2/(.25**2+lp**2)))<1e-6);assert.ok(Math.abs(out[1]-2/7)<1e-6);
 }finally{c.t.dispose();}
});
test('point spot has inverse-square falloff, smooth range and no delta-light MIS loss',async()=>{
 const s=scene();s.materials[0].type='diffuse';s.spotLights=[{position:[0,0,2],direction:[0,0,-1],color:[1,.5,.25],intensity:16,range:4}];
 const c=await prepare(s);
 try{
  const out=probe(c,'let s=sampleMeshSpot(vec3f(0.0));probe[0]=vec4f(s.radiance,s.dist);');
  const expected=16/4*(1-(2/4)**4)**2;for(let k=0;k<3;k++)assert.ok(Math.abs(out[k]-expected*[1,.5,.25][k])<1e-6);assert.equal(out[3],2);
  const dark=probe(c,'let s=sampleMeshSpot(vec3f(10,0,0));probe[0]=vec4f(s.radiance,s.dist);');assert.equal(dark[0],0);
 }finally{c.t.dispose();}
});
test('IES interpolates irregular vertical/azimuth tables, quadrant symmetry and absolute tilt intensity',async()=>{
 const s=scene();s.spotLights=[{position:[0,0,2],direction:[0,0,-1],up:[0,1,0],tiltDegrees:45,ies:{verticalAngles:new Float32Array([0,30,90,180]),horizontalAngles:new Float32Array([0,90]),candela:new Float32Array([10,20,40,80,30,40,60,100]),tiltAngles:new Float32Array([0,90]),tiltMultipliers:new Float32Array([1,.5])}}];
 const c=await prepare(s);
 try{
  const out=probe(c,`let h=meshLights();let r=scene[2]+scene[h+3u];let z=sqrt(.5);probe[0]=vec4f(iesCandela(r,vec3f(z,0,-z)),iesCandela(r,vec3f(-z,0,-z)),iesCandela(r,vec3f(0,z,-z)),iesCandela(r,vec3f(0,0,1)));`);
  const values=[25*.75,25*.75,45*.75,80*.75];for(let i=0;i<4;i++)assert.ok(Math.abs(out[i]-values[i])<2e-5,`${i}: ${out[i]} vs ${values[i]}`);
 }finally{c.t.dispose();}
});
test('spot and IES input is validated atomically and snapshotted before awaits',async()=>{
 const s=scene();s.spotLights=[{position:[0,0,2],ies:{verticalAngles:new Float32Array([0,180]),horizontalAngles:new Float32Array([0]),candela:new Float32Array([1,1])}}];
 const c=await prepare(s);
 try{
  const before=c.t.stats;const bad=structuredClone(s);bad.spotLights[0].ies.candela[1]=NaN;await assert.rejects(c.t.setScene(bad),/candela/);assert.deepEqual(c.t.stats,before);
  const pending=c.t.setScene(s);s.spotLights[0].ies.candela.fill(NaN);await pending;
 }finally{c.t.dispose();}
});
test('PBR emitter proposals retain textured emission, alpha holes and one-sided geometry',async()=>{
 const s=scene();s.meshes[0].uvs=new Float32Array([0,0,1,0,0,1]);s.pbrMaterials=[{id:1,emissiveFactor:[2,4,8],emissiveTexture:{width:1,height:1,data:new Uint8Array([255,128,0,255])},alphaMode:'MASK',baseColorFactor:[1,1,1,.25]}];
 const c=await prepare(s,true);
 try{
  const w=c.words,h=w[12],records=w[h+1];assert.equal(w[h],1);assert.equal(w[records+15],0);
  const out=probe(c,`let h=meshLights();let r=scene[2]+scene[h+1u];probe[0]=vec4f(meshSampleRadiance(vec3f(0),vec3f(0,0,1),r,vec2f(.2,.3)),1);`);assert.deepEqual([...out.slice(0,3)],[0,0,0]);
 }finally{c.t.dispose();}
});
