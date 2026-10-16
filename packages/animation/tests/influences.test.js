import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Animation,sampleTrack} from '../dist/index.js';
import {deformationShader,deformationShader8} from '../src/shader.ts';
import {GLTFAsset} from '../../gltf-pro/dist/index.js';
import {animatedTriangle} from '../../../tests/support/gltf-pro-fixture.js';
import {optionalGPU} from '../../../tests/support/optional-gpu.js';

const identity=new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
function append(fixture,data,type='VEC4',componentType=5126,normalized=false){
  const index=fixture.doc.accessors.length,buffer=fixture.buffers.length,view=fixture.doc.bufferViews.length;
  fixture.buffers.push(data);fixture.doc.buffers.push({byteLength:data.byteLength});fixture.doc.bufferViews.push({buffer,byteLength:data.byteLength});
  fixture.doc.accessors.push({bufferView:view,componentType,count:data.length/(type==='SCALAR'?1:4),type,...(normalized?{normalized:true}:{})});return index;
}
function fixture8(){
  const f=animatedTriangle(),attributes=f.doc.meshes[0].primitives[0].attributes;
  f.doc.nodes=[{mesh:0,skin:0,children:[1,2,3,4,5,6,7,8]},...Array.from({length:8},()=>({}))];f.doc.skins=[{joints:[1,2,3,4,5,6,7,8]}];
  f.buffers[attributes.JOINTS_0]=new Uint16Array([0,1,2,3,0,1,2,3,0,1,2,3]);
  f.buffers[attributes.WEIGHTS_0]=new Float32Array([1,2,3,4,1,2,3,4,1,2,3,4]);
  attributes.JOINTS_1=append(f,new Uint16Array([4,5,6,7,4,5,6,7,4,5,6,7]),'VEC4',5123);
  attributes.WEIGHTS_1=append(f,new Float32Array([5,6,7,8,5,6,7,8,5,6,7,8]));return f;
}
function harness(f=fixture8(),mixed=false){
  const h=optionalGPU(),count=f.doc.nodes.length;
  h.engine.store.transforms=Object.fromEntries(['x','y','z','qx','qy','qz','qw','sx','sy','sz'].map(name=>[name,new Float32Array(count).fill(['qw','sx','sy','sz'].includes(name)?1:0)]));
  const nodes=Array.from({length:count},(_,id)=>({id,engine:h.engine,matrix:identity.slice(),check(){},setPosition(value){this.matrix[12]=value[0];return this;},setScale(){return this;},setQuaternion(){return this;}}));
  const definition=f.doc.meshes[0].primitives[0],primitive={definition,nodeIndex:0,node:nodes[0],vertices:new Float32Array(60),weights:new Float32Array([0])};
  const primitives=[primitive];
  if(mixed){const definition=structuredClone(primitive.definition);delete definition.attributes.JOINTS_1;delete definition.attributes.WEIGHTS_1;primitives.push({...primitive,definition,vertices:primitive.vertices.slice(),weights:primitive.weights.slice()});}
  const model={name:'eight-influences',root:nodes[0],nodes,primitives,asset:new GLTFAsset(f.doc,f.buffers),onDispose(){return ()=>{};}};
  return {...h,model,attach(){const animation=new Animation(model);h.engine.use(animation);return animation;}};
}
function influenceBuffer(group){return group.entries.find(entry=>entry.binding===5).resource.buffer;}

test('four-influence WGSL remains exact and eight influences use a separate lazy pipeline',()=>{
  assert.equal(createHash('sha256').update(deformationShader).digest('hex'),'4999897148b945ab319d961eeb44383ca5e80a9921806564dd315a5c0b9b85fc');
  assert.match(deformationShader8,/jointsExtra:vec4u,weightsExtra:vec4f/);
  const f=fixture8();delete f.doc.meshes[0].primitives[0].attributes.JOINTS_1;delete f.doc.meshes[0].primitives[0].attributes.WEIGHTS_1;
  const h=harness(f),animation=h.attach();
  try{assert.equal(h.pipelines.length,1);assert.equal(h.pipelines[0].compute.module.code,deformationShader);assert.equal(influenceBuffer(h.groups[0]).size,3*32);}
  finally{animation.dispose();}assert.ok(h.resources.every(resource=>resource.destroyed));
});
test('mixed four/eight primitives retain their own storage strides and compute pipelines',()=>{
  const h=harness(fixture8(),true),animation=h.attach();
  try{
    assert.equal(h.pipelines.length,2);assert.equal(h.pipelines[1].compute.module.code,deformationShader8);
    assert.equal(influenceBuffer(h.groups[0]).size,3*64);assert.equal(influenceBuffer(h.groups[1]).size,3*32);
    const selected=[];h.context.encoder.beginComputePass=()=>({setPipeline(value){selected.push(value);},setBindGroup(){},dispatchWorkgroups(){},end(){}});h.frame();
    assert.deepEqual(selected,[h.pipelines[1],h.pipelines[0]]);
    const old=h.resources.slice();animation.onDeviceRestored(h.engine);assert.ok(old.every(resource=>resource.destroyed));
    assert.equal(h.pipelines.length,4);assert.equal(influenceBuffer(h.groups[2]).size,3*64);assert.equal(influenceBuffer(h.groups[3]).size,3*32);
  }finally{animation.dispose();}assert.ok(h.model.primitives.every(p=>p.deformed===undefined));assert.ok(h.resources.every(resource=>resource.destroyed));
});
test('eight skin weights normalize across both sets and retain all eight palette indices',()=>{
  const h=harness(),animation=h.attach();
  try{
    const buffer=influenceBuffer(h.groups[0]),ids=new Uint32Array(buffer.data),weights=new Float32Array(buffer.data);
    for(let vertex=0;vertex<3;vertex++)for(let set=0;set<2;set++)for(let channel=0;channel<4;channel++){
      const at=vertex*16+set*8+channel,index=set*4+channel;assert.equal(ids[at],index);assert.equal(weights[at+4],Math.fround((index+1)/36));
    }
  }finally{animation.dispose();}
});
test('the secondary set alone can supply the complete positive skin weight',()=>{
  const f=fixture8(),a=f.doc.meshes[0].primitives[0].attributes;f.buffers[a.WEIGHTS_0].fill(0);f.buffers[a.WEIGHTS_1].fill(0);for(let i=0;i<3;i++)f.buffers[a.WEIGHTS_1][i*4+3]=1;
  const h=harness(f),animation=h.attach();try{const weights=new Float32Array(influenceBuffer(h.groups[0]).data);assert.equal(weights[4],0);assert.equal(weights[15],1);}finally{animation.dispose();}
});
for(const componentType of [5121,5123])test('both sets decode normalized '+componentType+' weights before joint normalization',()=>{
  const f=fixture8(),a=f.doc.meshes[0].primitives[0].attributes,Type=componentType===5121?Uint8Array:Uint16Array;
  a.WEIGHTS_0=append(f,new Type([1,2,3,4,1,2,3,4,1,2,3,4]),'VEC4',componentType,true);
  a.WEIGHTS_1=append(f,new Type([5,6,7,8,5,6,7,8,5,6,7,8]),'VEC4',componentType,true);
  const h=harness(f),animation=h.attach();try{const weights=new Float32Array(influenceBuffer(h.groups[0]).data);assert.ok(Math.abs(weights[4]-1/36)<1e-7);assert.ok(Math.abs(weights[15]-8/36)<1e-7);}finally{animation.dispose();}
});
test('secondary skin attributes reject malformed pairs, unsupported sets, and invalid values with cleanup',async t=>{
  const cases={
    'missing JOINTS_1':(f,a)=>delete a.JOINTS_1,
    'missing WEIGHTS_1':(f,a)=>delete a.WEIGHTS_1,
    'third set':(f,a)=>{a.JOINTS_2=a.JOINTS_1;a.WEIGHTS_2=a.WEIGHTS_1;},
    'float joint IDs':(f,a)=>a.JOINTS_1=append(f,new Float32Array(12)),
    'normalized joint IDs':(f,a)=>f.doc.accessors[a.JOINTS_1].normalized=true,
    'integer weights without normalization':(f,a)=>a.WEIGHTS_1=append(f,new Uint8Array(12),'VEC4',5121),
    'secondary count mismatch':(f,a)=>f.doc.accessors[a.WEIGHTS_1].count=2,
    'palette overrun':(f,a)=>f.buffers[a.JOINTS_1][0]=8,
    'negative weight':(f,a)=>f.buffers[a.WEIGHTS_1][0]=-1,
    'zero total weight':(f,a)=>{f.buffers[a.WEIGHTS_0].fill(0);f.buffers[a.WEIGHTS_1].fill(0);},
  };
  for(const [label,change] of Object.entries(cases))await t.test(label,()=>{
    const f=fixture8();change(f,f.doc.meshes[0].primitives[0].attributes);const h=harness(f);assert.throws(()=>h.attach(),/skin|eight|paired/i);assert.ok(h.resources.every(resource=>resource.destroyed));assert.equal(h.model.primitives[0].deformed,undefined);
  });
});
test('failed eight-influence pipeline allocation releases setup resources',()=>{
  const h=harness(),create=h.engine.gpu.createComputePipeline;let count=0;h.engine.gpu.createComputePipeline=descriptor=>{if(++count===2)throw new Error('Injected eight pipeline');return create(descriptor);};
  assert.throws(()=>h.attach(),/Injected eight pipeline/);assert.equal(h.model.primitives[0].deformed,undefined);assert.ok(h.resources.every(resource=>resource.destroyed));
});
test('sampleTrack reuses caller storage while its default return remains independently owned',()=>{
  const times=new Float32Array([0,1]),values=new Float32Array([0,2]),target=new Float32Array(1);
  assert.equal(sampleTrack(times,values,1,0.5,'LINEAR',false,target),target);assert.equal(target[0],1);
  const a=sampleTrack(times,values,1,0.25,'LINEAR'),b=sampleTrack(times,values,1,0.75,'LINEAR');assert.notEqual(a,b);assert.equal(a[0],0.5);assert.equal(b[0],1.5);
  assert.throws(()=>sampleTrack(times,values,1,0.5,'LINEAR',false,values.subarray(0,1)),/target/);assert.throws(()=>sampleTrack(times,values,1,0.5,'LINEAR',false,new Float32Array(2)),/target/);
});
test('single-clip eight-influence playback creates no typed arrays, quaternion copies, or GPU resources',()=>{
  const f=fixture8(),times=f.doc.animations[0].samplers[0].input,rotation=append(f,new Float32Array([0,0,0,1,0,0,1,0]));
  f.doc.animations[0].samplers.push({input:times,output:rotation});f.doc.animations[0].channels.push({sampler:1,target:{node:2,path:'rotation'}});
  const h=harness(f),animation=h.attach(),counts={...h.counts},arrays={Float32Array,Float64Array,Uint32Array},from=Array.from,subarray=Float32Array.prototype.subarray;
  const fail=()=>assert.fail('Playback allocated a typed array or copied a quaternion');
  try{
    for(const [name,Type] of Object.entries(arrays))globalThis[name]=new Proxy(Type,{construct:fail});Array.from=fail;arrays.Float32Array.prototype.subarray=fail;
    for(let i=0;i<120;i++)h.frame();
  }finally{for(const [name,Type] of Object.entries(arrays))globalThis[name]=Type;Array.from=from;Float32Array.prototype.subarray=subarray;animation.dispose();}
  for(const key of ['buffers','textures','views','groups'])assert.equal(h.counts[key],counts[key]);assert.equal(h.counts.compute,120);
});
