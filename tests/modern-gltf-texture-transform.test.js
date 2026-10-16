import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Engine,TransformStore} from '../packages/core/dist/extension.js';
import {parseGLTF,textureCoordinates} from '../packages/gltf-pro/dist/index.js';
import {materialQuad} from './support/materials-fixture.js';
import {textureQuad} from './support/texture-fixture.js';
import {optionalGPU} from './support/optional-gpu.js';

const digest=value=>createHash('sha256').update(value).digest('hex');
const baselineShader='1920d3bb180dbf0fa32fe4d373a3c03bdfccbdc834fb02a26fcb1b8dfeeffa5b';
async function scene(fixture=materialQuad(),image=true) {
  const harness=optionalGPU(),store=await TransformStore.create(16),device=harness.engine.gpu;
  device.limits.maxTextureDimension2D=8192;device.limits.maxUniformBufferBindingSize=65536;
  device.queue.copyExternalImageToTexture=()=>{};
  const engine=new Engine({width:128,height:128,clientWidth:128,clientHeight:128},store,
    {backend:'webgpu',gpu:device,add(){},remove(){},render(){},dispose(){}},{position:[0,0,3],target:[0,0,0]},null);
  const imageValue={width:1,height:1,closed:false,close(){this.closed=true;}},draws=[];
  try{
    const model=parseGLTF(engine,fixture.doc,fixture.buffers,image&&fixture.doc.images?[imageValue]:[]);
    assert.ok(!(model instanceof Promise));engine.camera.update(1,true);store.tick(false);
    const context={...harness.context,camera:engine.camera,encoder:{beginRenderPass(){
      let pipeline;const groups=new Map();return {setPipeline(value){pipeline=value;groups.clear();},setBindGroup(index,value){groups.set(index,value);},
        setVertexBuffer(){},setIndexBuffer(){},drawIndexed(){draws.push({pipeline,groups:new Map(groups)});},end(){}};
    }}};
    return {...harness,device,engine,model,image:imageValue,draws,draw(){model.draw(context,'beauty',context.color,context.depth);}};
  }catch(error){engine.dispose();throw error;}
}

test('identity texture transforms keep the baseline shader, frame and two-bind-group path',async()=>{
  const baseline=await scene(textureQuad()),identity=await scene(textureQuad('base',{offset:[0,0],rotation:0,scale:[1,1]}));
  try{
    baseline.draw();identity.draw();const a=baseline.draws[0],b=identity.draws[0];
    assert.equal(digest(a.pipeline.vertex.module.code),baselineShader);assert.equal(digest(b.pipeline.vertex.module.code),baselineShader);
    assert.deepEqual([...a.groups.keys()],[0,1]);assert.deepEqual([...b.groups.keys()],[0,1]);
    assert.equal(digest(new Uint8Array(a.groups.get(0).entries[0].resource.buffer.data)),digest(new Uint8Array(b.groups.get(0).entries[0].resource.buffer.data)));
    assert.equal(identity.counts.buffers,baseline.counts.buffers);assert.equal(identity.counts.textures,baseline.counts.textures);
  }finally{baseline.engine.dispose();identity.engine.dispose();}
});

test('a glTF upper-left UV quarter turn has the independently known nonuniform scale result',()=>{
  const transform={offset:[0.25,0.125],rotation:Math.PI/2,scale:[2,3]};
  const fixture=textureQuad('base',transform,{bake:true}),uv=fixture.buffers[fixture.doc.meshes[0].primitives[0].attributes.TEXCOORD_0];
  // Original corners are (0,1), (1,1), (1,0), (0,0); these are known transformed coordinates.
  assert.deepEqual([...uv],[3.25,0.125,3.25,-1.875,0.25,-1.875,0.25,0.125]);
  const rows=textureCoordinates({extensions:{KHR_texture_transform:transform}}).transform;
  const apply=(u,v)=>[rows[0]*u+rows[1]*v+rows[2],rows[4]*u+rows[5]*v+rows[6]];
  const result=apply(0.25,0.75);
  assert.ok(Math.abs(result[0]-2.5)<1e-6);assert.ok(Math.abs(result[1]+0.375)<1e-6);
});

test('offset, rotation and scale use group 3 without widening PBR vertices or the packed frame',async()=>{
  const s=await scene(textureQuad('base',{offset:[0.13,0.21],rotation:0.37,scale:[0.59,0.73]},{required:true}));
  try{
    s.draw();const {pipeline,groups}=s.draws[0];
    assert.equal(s.model.primitives[0].vertices.length,4*20);assert.equal(pipeline.vertex.buffers[0].arrayStride,80);
    assert.equal(groups.get(0).entries[0].resource.buffer.size,400);assert.ok(groups.has(3));
    const factors=groups.get(3).entries.find(entry=>entry.binding===0).resource.buffer;
    assert.equal(factors.size,32);assert.ok([...new Float32Array(factors.data)].every(Number.isFinite));
    assert.match(pipeline.vertex.module.code,/@group\(3\)/);assert.notEqual(digest(pipeline.vertex.module.code),baselineShader);
    assert.equal(s.model.primitives[0].extension,undefined,'Texture transforms do not replace the caller extension slot');
  }finally{s.engine.dispose();}
  assert.ok(s.resources.every(resource=>resource.destroyed));assert.equal(s.image.closed,true);
});

test('texture transform texCoord overrides the texture-info UV set and validates the selected attribute',async()=>{
  const s=await scene(textureQuad('base',{texCoord:1},{texCoord:0,required:true}));
  try{
    s.draw();const draw=s.draws[0],frame=new Float32Array(draw.groups.get(0).entries[0].resource.buffer.data);
    assert.equal(frame[92],1,'Base texture samples the extension-selected UV1');
    assert.equal(s.model.primitives[0].vertices.length,80);assert.equal(digest(draw.pipeline.vertex.module.code),baselineShader);
    assert.deepEqual([...draw.groups.keys()],[0,1],'Selecting the existing UV1 requires no affine uniform block');
  }finally{s.engine.dispose();}
  const missing=textureQuad('base',{texCoord:1},{texCoord:0});delete missing.doc.meshes[0].primitives[0].attributes.TEXCOORD_1;
  await assert.rejects(()=>scene(missing),/UV|TEXCOORD|coordinate/i);
});

test('texture transforms compose with caller factors and preserve their uniform indices and ownership',async()=>{
  const s=await scene(textureQuad('base',{offset:[0.25,0.125],scale:[0.5,0.75]}));
  const original=new Float32Array([0.25,0.5,0.75,1]),extension={factors:original,wgsl:'s.base*=materialFactors[0];'};
  try{
    s.model.primitives[0].extension=extension;s.draw();const first=s.draws[0],buffer=first.groups.get(3).entries.find(entry=>entry.binding===0).resource.buffer;
    assert.equal(buffer.size,48);assert.deepEqual([...new Float32Array(buffer.data).slice(0,4)],[...original]);
    assert.equal(s.model.primitives[0].extension,extension);assert.equal(extension.factors,original);assert.equal(original.length,4);
    const count=s.pipelines.length;original[0]=0.75;s.draw();assert.equal(s.pipelines.length,count);
    assert.equal(new Float32Array(buffer.data)[0],0.75);assert.equal(buffer.destroyed,false);
    delete s.model.primitives[0].extension;s.draw();assert.ok(s.draws.at(-1).groups.has(3),'The texture transform survives removal of a caller extension');
  }finally{s.engine.dispose();}
  assert.ok(s.resources.every(resource=>resource.destroyed));
});

test('each PBR texture channel supports an independent texture transform',async()=>{
  for(const channel of ['base','metalRough','normal','occlusion','emissive']){
    const s=await scene(textureQuad(channel,{offset:[0.13,0.21],rotation:0.37,scale:[0.59,0.73]}));
    try{s.draw();assert.ok(s.draws[0].groups.has(3),channel);assert.equal(s.draws[0].groups.get(0).entries[0].resource.buffer.size,400);}
    finally{s.engine.dispose();}
  }
});

test('malformed texture transforms reject before leaving GPU resources or model meshes alive',async()=>{
  for(const transform of [null,[],{offset:[0]},{offset:[0,NaN]},{offset:Array(2)},{scale:[1,Infinity]},{scale:[1]},{scale:Array(2)},
    {rotation:NaN},{rotation:'1'},{rotation:null},{texCoord:2},{texCoord:-1},{texCoord:null}]){
    const fixture=textureQuad();fixture.doc.materials[0].pbrMetallicRoughness.baseColorTexture.extensions={KHR_texture_transform:transform};
    await assert.rejects(()=>scene(fixture),/texture|transform|coordinate|UV|finite|scale|offset|rotation/i,JSON.stringify(transform));
  }
});
